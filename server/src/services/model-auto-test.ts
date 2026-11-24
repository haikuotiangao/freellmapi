// model-auto-test — nightly full-catalog model test (#fork).
//
// Every day at 03:00 local time, test every registered chat model up to 5
// times. A model that succeeds at least once is healthy (its success rate is
// recorded for the dashboard); a model whose 5 attempts ALL fail is retired:
// its rows are deleted and a tombstone is written so catalog sync cannot
// resurrect it. The failure is remembered in model_test_stats so the model
// picker can show a red "unavailable" badge — the operator may still force-add
// it back, and a later passing test clears the badge.
//
// Unlike model-probe (30-min observation, off by default, never acts on the
// result), this job is ON by default and has teeth. It spends real free-tier
// quota, so each model gets at most 5 attempts per night and the pass is
// serial with a small delay between calls.

import type { Scheduler } from '../lib/scheduler.js';
import type { Db } from '../db/types.js';
import { getDb, getSetting, setSetting } from '../db/index.js';
import { resolveProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { decryptProxyUrl } from '../lib/key-proxy.js';
import { withKeyProxy } from '../lib/proxy.js';
import { inferQuotaPoolKey } from './provider-quota.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import { providerLog } from '../lib/server-logs.js';
import { isCatalogManagedModel } from './model-state.js';
import { recordCatalogModelTombstone } from './model-state.js';
import { recordCustomModelTombstone } from './custom-model-tombstone.js';
import { parseModelScope } from '../lib/model-scope.js';

/** Max attempts per model per night. */
export const MAX_TEST_ATTEMPTS = 5;
/** Delay between attempts, so a single provider is not hammered. */
const ATTEMPT_DELAY_MS = 1_500;
/** Wall-clock time of the nightly pass (local time, HH:MM). */
export const DEFAULT_TEST_TIME = '03:00';
/** settings key holding the last local day the pass ran. */
const LAST_RUN_SETTING = 'model_auto_test_last_run';
/** settings key holding the configured run time. */
const TIME_SETTING = 'model_auto_test_time';
/** settings key holding the on/off flag. */
const ENABLED_SETTING = 'model_auto_test_enabled';

const TEST_TIMEOUT_MS = 30_000;
const TEST_MAX_TOKENS = 64;

export interface ModelTestStats {
  platform: string;
  modelId: string;
  endpointScope: string;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  lastTestAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastLatencyMs: number | null;
  unavailable: boolean;
}

export interface TestRunSummary {
  tested: number;
  retired: number;
  failedButKept: number;
  passAt: string;
  durationMs: number;
  errors: string[];
}

function localDayKey(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export function readTestSchedule(): { enabled: boolean; time: string } {
  const enabled = getSetting(ENABLED_SETTING) !== '0'; // on by default for the fork
  const time = getSetting(TIME_SETTING) || DEFAULT_TEST_TIME;
  return { enabled, time };
}

export function setTestSchedule(enabled: boolean, time: string): void {
  setSetting(ENABLED_SETTING, enabled ? '1' : '0');
  setSetting(TIME_SETTING, time);
}

/** Read a model's persisted test stats; a missing row is all-zero/available. */
export function getModelTestStats(db: Db, platform: string, modelId: string, endpointScope = ''): ModelTestStats {
  const row = db.prepare(`
    SELECT platform, model_id AS modelId, endpoint_scope AS endpointScope,
           success_count AS successCount, failure_count AS failureCount,
           consecutive_failures AS consecutiveFailures, last_test_at AS lastTestAt,
           last_status AS lastStatus, last_error AS lastError,
           last_latency_ms AS lastLatencyMs, unavailable
      FROM model_test_stats WHERE platform = ? AND model_id = ? AND endpoint_scope = ?
  `).get(platform, modelId, endpointScope) as any;
  if (!row) {
    return { platform, modelId, endpointScope, successCount: 0, failureCount: 0,
      consecutiveFailures: 0, lastTestAt: null, lastStatus: null, lastError: null,
      lastLatencyMs: null, unavailable: false };
  }
  return { ...row, unavailable: Number(row.unavailable) === 1 };
}

/** Success rate 0..1, or null when the model has never been tested. */
export function successRate(stats: ModelTestStats): number | null {
  const total = stats.successCount + stats.failureCount;
  return total > 0 ? stats.successCount / total : null;
}

/** One model + one key it can be tested through. */
interface TestCandidate {
  modelDbId: number;
  platform: string;
  modelId: string;
  endpointScope: string;
  keyId: number;
}

/** Every enabled chat model with one usable key, deduped to logical models. */
export function selectTestTargets(db: Db): TestCandidate[] {
  const rows = db.prepare(`
    SELECT m.id AS modelDbId, m.platform, m.model_id AS modelId,
           m.endpoint_scope AS endpointScope, k.id AS keyId
      FROM models m
      JOIN api_keys k ON k.platform = m.platform AND k.enabled = 1
                     AND k.status IN ('healthy', 'unknown')
     WHERE m.enabled = 1
     ORDER BY m.id ASC, k.id ASC
  `).all() as TestCandidate[];
  // One key per logical model is enough — retries hit the same model through
  // that key. Keep the first (lowest key id) so the choice is stable.
  const seen = new Set<string>();
  const out: TestCandidate[] = [];
  for (const row of rows) {
    const identity = `${row.platform}\u0000${row.modelId}\u0000${row.endpointScope}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push(row);
  }
  return out;
}

/** A single real chat attempt. Reuses the same key/proxy posture as probes. */
async function attemptChat(candidate: TestCandidate): Promise<void> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ? AND enabled = 1').get(candidate.keyId) as any;
  if (!row) throw new Error('key not found or disabled');
  const provider = resolveProvider(candidate.platform as any, row.base_url);
  if (!provider) throw new Error(`no provider adapter for ${candidate.platform}`);
  const apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
  await withKeyProxy(decryptProxyUrl(row), () => provider.chatCompletion(apiKey, [
    { role: 'user', content: 'Reply with OK' },
  ], candidate.modelId, {
    max_tokens: TEST_MAX_TOKENS,
    timeoutMs: TEST_TIMEOUT_MS,
  } as any, {
    platform: candidate.platform as any,
    keyId: candidate.keyId,
    quotaPoolKey: inferQuotaPoolKey(candidate.platform as any, null),
    endpoint: 'chat',
    origin: 'model-test',
  } as any));
}

/** Record one attempt's outcome into model_test_stats. */
function recordAttempt(db: Db, candidate: TestCandidate, ok: boolean, latencyMs: number, error: string | null): void {
  const stats = getModelTestStats(db, candidate.platform, candidate.modelId, candidate.endpointScope);
  const successCount = stats.successCount + (ok ? 1 : 0);
  const failureCount = stats.failureCount + (ok ? 0 : 1);
  const consecutiveFailures = ok ? 0 : stats.consecutiveFailures + 1;
  db.prepare(`
    INSERT INTO model_test_stats
      (platform, model_id, endpoint_scope, success_count, failure_count,
       consecutive_failures, last_test_at, last_status, last_error, last_latency_ms, unavailable)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?)
    ON CONFLICT(platform, model_id, endpoint_scope) DO UPDATE SET
      success_count = excluded.success_count,
      failure_count = excluded.failure_count,
      consecutive_failures = excluded.consecutive_failures,
      last_test_at = excluded.last_test_at,
      last_status = excluded.last_status,
      last_error = excluded.last_error,
      last_latency_ms = excluded.last_latency_ms,
      unavailable = CASE WHEN excluded.last_status = 'ok' THEN 0 ELSE model_test_stats.unavailable END
  `).run(
    candidate.platform, candidate.modelId, candidate.endpointScope,
    successCount, failureCount, consecutiveFailures,
    ok ? 'ok' : 'fail', error, latencyMs, ok ? 0 : stats.unavailable ? 1 : 0,
  );
}

/** Delete a model row + tombstone + clear it from every key scope. Returns true
 *  if a row was actually removed. Mirrors DELETE /api/models/:id. */
export function retireModel(db: Db, modelDbId: number): boolean {
  const row = db.prepare('SELECT * FROM models WHERE id = ?').get(modelDbId) as any;
  if (!row) return false;
  db.transaction(() => {
    if (isCatalogManagedModel(row)) {
      recordCatalogModelTombstone(db, 'chat', row.platform, row.model_id);
    } else if (row.platform === 'custom') {
      recordCustomModelTombstone(db, row.endpoint_scope || '', row.model_id);
    }
    db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(modelDbId);
    db.prepare('DELETE FROM profile_models WHERE model_db_id = ?').run(modelDbId);
    db.prepare('DELETE FROM models WHERE id = ?').run(modelDbId);
    const scopeRows = db.prepare('SELECT id, model_scope_json FROM api_keys WHERE model_scope_json IS NOT NULL')
      .all() as { id: number; model_scope_json: string }[];
    for (const scoped of scopeRows) {
      const scope = parseModelScope(scoped.model_scope_json);
      if (!scope || !scope.has(row.model_id)) continue;
      const next = [...scope].filter(id => id !== row.model_id);
      db.prepare('UPDATE api_keys SET model_scope_json = ? WHERE id = ?')
        .run(next.length > 0 ? JSON.stringify(next) : null, scoped.id);
    }
    // Mark unavailable in stats so the picker can show the badge. Keep the
    // stats row even though the model row is gone.
    db.prepare(`
      INSERT INTO model_test_stats (platform, model_id, endpoint_scope, unavailable, last_status)
      VALUES (?, ?, ?, 1, 'fail')
      ON CONFLICT(platform, model_id, endpoint_scope) DO UPDATE SET unavailable = 1, last_status = 'fail'
    `).run(row.platform, row.model_id, row.endpoint_scope || '');
  })();
  return true;
}

/** Clear the unavailable badge for a model (called when a force-added model
 *  later passes a test). */
export function clearUnavailable(db: Db, platform: string, modelId: string, endpointScope = ''): void {
  db.prepare(`
    UPDATE model_test_stats SET unavailable = 0, consecutive_failures = 0
     WHERE platform = ? AND model_id = ? AND endpoint_scope = ?
  `).run(platform, modelId, endpointScope);
}

/** A model force-re-added from the picker starts a fresh test streak. Keep the
 *  `unavailable` badge (it clears only when a real test passes) but zero the
 *  consecutive-failure counter so one bad night does not immediately retire it
 *  again. Also resets the running success/failure window. */
export function resetTestStreak(db: Db, platform: string, modelId: string, endpointScope = ''): void {
  db.prepare(`
    UPDATE model_test_stats
       SET consecutive_failures = 0, success_count = 0, failure_count = 0,
           last_test_at = NULL, last_status = NULL, last_error = NULL
     WHERE platform = ? AND model_id = ? AND endpoint_scope = ?
  `).run(platform, modelId, endpointScope);
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Run one full nightly pass over every model. Safe to call manually too. */
export async function runModelAutoTest(db: Db = getDb(), opts: { attempts?: number } = {}): Promise<TestRunSummary> {
  const started = Date.now();
  const passAt = new Date().toISOString();
  const errors: string[] = [];
  const targets = selectTestTargets(db);
  let retired = 0;
  let failedButKept = 0;

  for (const candidate of targets) {
    let anySuccess = false;
    let lastError: string | null = null;
    for (let attempt = 0; attempt < (opts.attempts ?? MAX_TEST_ATTEMPTS); attempt++) {
      const t0 = Date.now();
      try {
        await attemptChat(candidate);
        anySuccess = true;
        recordAttempt(db, candidate, true, Date.now() - t0, null);
        break; // one success is enough; keep the success rate from the attempts used
      } catch (err: any) {
        lastError = sanitizeProviderErrorMessage(err?.message ?? err);
        recordAttempt(db, candidate, false, Date.now() - t0, lastError);
        if (attempt < (opts.attempts ?? MAX_TEST_ATTEMPTS) - 1) await sleep(ATTEMPT_DELAY_MS);
      }
    }
    if (!anySuccess) {
      // Re-read the stats written above to decide retirement.
      const stats = getModelTestStats(db, candidate.platform, candidate.modelId, candidate.endpointScope);
      if (stats.consecutiveFailures >= (opts.attempts ?? MAX_TEST_ATTEMPTS)) {
        if (retireModel(db, candidate.modelDbId)) retired++;
      } else {
        failedButKept++;
      }
      errors.push(`${candidate.platform}/${candidate.modelId}: ${lastError ?? 'all attempts failed'}`);
    }
  }

  providerLog('info', `[model-auto-test] pass ${passAt}: tested=${targets.length} retired=${retired} failedButKept=${failedButKept}`);
  return { tested: targets.length, retired, failedButKept, passAt, durationMs: Date.now() - started, errors };
}

// ── Scheduler: once per local day at the configured wall-clock time ─────────
let stopJob: (() => void) | null = null;
let passInFlight = false;

export function startModelAutoTest(scheduler: Scheduler): () => void {
  if (stopJob) return stopJob;
  let lastRunDay = getSetting(LAST_RUN_SETTING) ?? null;

  const tick = (): void => {
    if (passInFlight) return;
    const db = getDb();
    const schedule = readTestSchedule();
    if (!schedule.enabled) return;
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (hhmm < schedule.time) return;
    const today = localDayKey(now);
    if (lastRunDay === today) return;
    passInFlight = true;
    lastRunDay = today;
    setSetting(LAST_RUN_SETTING, today);
    void runModelAutoTest(db).catch(err => {
      providerLog('error', `[model-auto-test] pass failed: ${err?.message ?? err}`);
    }).finally(() => { passInFlight = false; });
  };

  stopJob = scheduler.every(60_000, tick, { name: 'model-auto-test' });
  return stopJob;
}

export function stopModelAutoTest(): void {
  stopJob?.();
  stopJob = null;
}
