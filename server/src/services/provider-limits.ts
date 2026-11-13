import type { Db } from '../db/types.js';
import { getDb } from '../db/index.js';

// ── Per-provider rate limit profiles ────────────────────────────────────────
//
// The stock app hard-codes three caps (openrouter/modelscope/navy) in
// ratelimit.ts and lets env vars override them. That covers the "one daily
// request pool per account" case, but not what actually bites on free tiers:
//
//   - NVIDIA NIM meters ~40 RPM per MODEL, not per account. Two different model
//     ids each get their own 40, so an account-wide 40 gate throws away half the
//     available throughput (and, worse, serializes models that never contended).
//   - AMD Radeon Token Factory is 20 RPM at the gateway AND 8 concurrent
//     requests; the concurrency ceiling has no representation at all upstream.
//   - Agnes AI's free text models are 10 RPM — low enough that the router must
//     stop picking them rather than discover it via 429s.
//   - OpenRouter `:free` is 20 RPM and 50 RPD (or 1000 RPD with >=$10 credit),
//     and the RPD is shared across every `:free` model on the account.
//
// `scope` is the part that cannot be expressed per model: 'model' means each
// model has its own bucket, 'account' means every model on the key draws from
// one. The router consults this instead of assuming account-wide everywhere.
//
// Numbers are seeded from the provider documentation at the time of writing.
// They are DEFAULTS, not truth: free tiers move, and a wrong ceiling that is too
// low silently costs throughput. `provider_limits` is a real table (not env
// vars) so the dashboard can show and edit them, and `notes` records provenance.

export type LimitScope = 'model' | 'account';

export interface ProviderLimits {
  platform: string;
  rpm: number | null;
  rpd: number | null;
  tpm: number | null;
  tpd: number | null;
  maxConcurrency: number | null;
  scope: LimitScope;
  notes: string | null;
  updatedAt: string;
}

/**
 * Seeded profiles. Only providers where the published free-tier limits are
 * documented AND differ from the app's assumption are listed; everything else
 * falls through to the catalog's per-model rpm/rpd/tpm/tpd columns, which is
 * what the stock app already does correctly.
 */
export const SEEDED_PROVIDER_LIMITS: ReadonlyArray<Omit<ProviderLimits, 'updatedAt'>> = [
  {
    platform: 'nvidia',
    rpm: 40, rpd: null, tpm: null, tpd: null, maxConcurrency: null,
    scope: 'model',
    notes: 'NVIDIA NIM: ~40 RPM metered per model id, so distinct models do not contend. Source: build.nvidia.com model cards.',
  },
  {
    platform: 'openrouter',
    rpm: 20, rpd: 50, tpm: null, tpd: null, maxConcurrency: null,
    scope: 'account',
    notes: ':free models. 20 RPM; RPD is 50/day with <$10 lifetime credit, 1000/day at >=$10. RPD pool is shared by ALL :free models on the key.',
  },
  {
    platform: 'amd',
    rpm: 20, rpd: null, tpm: null, tpd: null, maxConcurrency: 8,
    scope: 'account',
    notes: 'AMD Radeon Token Factory: 20 RPM gateway + 30 RPM per key, 8 concurrent requests. Slow first token; 429 on either ceiling.',
  },
  {
    platform: 'agnes',
    rpm: 10, rpd: null, tpm: null, tpd: null, maxConcurrency: null,
    scope: 'account',
    notes: 'Agnes AI free text tier: 10 RPM after the 2026-09 downgrade. Suitable as a low-frequency fallback only.',
  },
  {
    platform: 'modelscope',
    rpm: null, rpd: 125, tpm: null, tpd: null, maxConcurrency: null,
    scope: 'account',
    notes: 'ModelScope free tier moved to a "magic credit" pool: ~250 credits/day, roughly 125 requests. Shared by all models.',
  },
  {
    platform: 'sensenova',
    rpm: null, rpd: 300, tpm: null, tpd: null, maxConcurrency: null,
    scope: 'account',
    notes: 'SenseNova public beta: 1500 requests per 5-hour window (~300/day equivalent). No published per-minute figure.',
  },
  {
    platform: 'cloudflare',
    rpm: null, rpd: null, tpm: null, tpd: 10_000, maxConcurrency: null,
    scope: 'account',
    notes: 'Workers AI free allocation is metered in neurons (10K/day), not tokens; tpd here is a request-count proxy only.',
  },
];

/** Read one provider's limits, or null when nothing is known about it. */
export function getProviderLimits(platform: string, db: Db = getDb()): ProviderLimits | null {
  const row = db.prepare(`
    SELECT platform, rpm, rpd, tpm, tpd, max_concurrency, scope, notes, updated_at
      FROM provider_limits WHERE platform = ?
  `).get(platform) as {
    platform: string; rpm: number | null; rpd: number | null; tpm: number | null;
    tpd: number | null; max_concurrency: number | null; scope: string;
    notes: string | null; updated_at: string;
  } | undefined;
  if (!row) return null;
  return {
    platform: row.platform,
    rpm: row.rpm,
    rpd: row.rpd,
    tpm: row.tpm,
    tpd: row.tpd,
    maxConcurrency: row.max_concurrency,
    scope: (row.scope === 'model' ? 'model' : 'account'),
    notes: row.notes,
    updatedAt: row.updated_at,
  };
}

/** Every configured provider's limits, for the dashboard table. */
export function listProviderLimits(db: Db = getDb()): ProviderLimits[] {
  const rows = db.prepare(`
    SELECT platform, rpm, rpd, tpm, tpd, max_concurrency, scope, notes, updated_at
      FROM provider_limits ORDER BY platform
  `).all() as {
    platform: string; rpm: number | null; rpd: number | null; tpm: number | null;
    tpd: number | null; max_concurrency: number | null; scope: string;
    notes: string | null; updated_at: string;
  }[];
  return rows.map(row => ({
    platform: row.platform,
    rpm: row.rpm,
    rpd: row.rpd,
    tpm: row.tpm,
    tpd: row.tpd,
    maxConcurrency: row.max_concurrency,
    scope: (row.scope === 'model' ? 'model' : 'account') as LimitScope,
    notes: row.notes,
    updatedAt: row.updated_at,
  }));
}

export interface ProviderLimitPatch {
  rpm?: number | null;
  rpd?: number | null;
  tpm?: number | null;
  tpd?: number | null;
  maxConcurrency?: number | null;
  scope?: LimitScope;
  notes?: string | null;
}

/** Upsert one provider's limits. `undefined` fields leave the column alone. */
export function setProviderLimits(platform: string, patch: ProviderLimitPatch, db: Db = getDb()): void {
  const existing = getProviderLimits(platform, db);
  const merged = {
    platform,
    rpm: patch.rpm !== undefined ? patch.rpm : existing?.rpm ?? null,
    rpd: patch.rpd !== undefined ? patch.rpd : existing?.rpd ?? null,
    tpm: patch.tpm !== undefined ? patch.tpm : existing?.tpm ?? null,
    tpd: patch.tpd !== undefined ? patch.tpd : existing?.tpd ?? null,
    maxConcurrency: patch.maxConcurrency !== undefined ? patch.maxConcurrency : existing?.maxConcurrency ?? null,
    scope: patch.scope !== undefined ? patch.scope : existing?.scope ?? 'account',
    notes: patch.notes !== undefined ? patch.notes : existing?.notes ?? null,
  };
  db.prepare(`
    INSERT INTO provider_limits (platform, rpm, rpd, tpm, tpd, max_concurrency, scope, notes, updated_at)
    VALUES (@platform, @rpm, @rpd, @tpm, @tpd, @maxConcurrency, @scope, @notes, datetime('now'))
    ON CONFLICT(platform) DO UPDATE SET
      rpm = @rpm, rpd = @rpd, tpm = @tpm, tpd = @tpd,
      max_concurrency = @maxConcurrency, scope = @scope, notes = @notes,
      updated_at = datetime('now')
  `).run(merged);
}

/**
 * Seed the profiles above. Idempotent and non-destructive: a platform already in
 * the table is left exactly as the operator configured it, so re-running after
 * an app upgrade never overwrites a hand-tuned ceiling.
 */
export function seedProviderLimits(db: Db = getDb()): number {
  const insert = db.prepare(`
    INSERT INTO provider_limits (platform, rpm, rpd, tpm, tpd, max_concurrency, scope, notes)
    VALUES (@platform, @rpm, @rpd, @tpm, @tpd, @maxConcurrency, @scope, @notes)
    ON CONFLICT(platform) DO NOTHING
  `);
  let inserted = 0;
  db.transaction(() => {
    for (const p of SEEDED_PROVIDER_LIMITS) {
      const info = insert.run(p);
      inserted += info.changes;
    }
  })();
  return inserted;
}

/**
 * The effective per-model limits for routing decisions.
 *
 * Resolution order: an explicit per-model column wins, then the provider
 * profile (only when its scope is 'model'), then null. Account-scoped caps are
 * applied separately and account-wide by ratelimit.ts — a caller must not
 * treat them as a per-model ceiling, which is exactly the bug the stock
 * DEFAULT_PROVIDER_MINUTE_REQUEST_CAPS table causes for NVIDIA.
 */
export function effectiveModelLimits(
  platform: string,
  modelRow: { rpm_limit: number | null; rpd_limit: number | null; tpm_limit: number | null; tpd_limit: number | null },
  db: Db = getDb(),
): { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null } {
  const profile = getProviderLimits(platform, db);
  const modelScoped = profile && profile.scope === 'model' ? profile : null;
  return {
    rpm: modelRow.rpm_limit ?? modelScoped?.rpm ?? null,
    rpd: modelRow.rpd_limit ?? modelScoped?.rpd ?? null,
    tpm: modelRow.tpm_limit ?? modelScoped?.tpm ?? null,
    tpd: modelRow.tpd_limit ?? modelScoped?.tpd ?? null,
  };
}