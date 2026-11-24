import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrate/runner.js';
import { up as runLegacyBaseline } from '../../db/migrations/20260101_000000_legacy_baseline.js';
import type { Db } from '../../db/types.js';
import {
  getModelTestStats, successRate, retireModel, resetTestStreak,
  clearUnavailable, selectTestTargets,
} from '../../services/model-auto-test.js';
import { parseModelScope } from '../../lib/model-scope.js';

// Nightly model test: the state machine that must hold across a 5-strike
// retire, a force-add, and a later passing test.

describe('model-auto-test stats and retirement', () => {
  let db: Db;

  beforeEach(async () => {
    db = new Database(':memory:') as Db;
    (db as any).pragma('journal_mode = WAL');
    runLegacyBaseline(db);
    await runMigrations(db, 'up');
    // Seed a custom key + a model so retirement has something to act on.
    db.prepare(`INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url, model_scope_json)
      VALUES (9001, 'custom', 'relay', 'x', 'y', 'z', 'healthy', 1, 'https://relay.example.com/v1', ?)`)
      .run(JSON.stringify(['m-one', 'm-two']));
    db.prepare(`INSERT INTO models (id, platform, model_id, display_name, intelligence_rank, speed_rank, size_label, key_id, endpoint_scope, source, enabled)
      VALUES (9001, 'custom', 'm-one', 'M One', 1, 1, '', 9001, 'https://relay.example.com/v1', 'user', 1)`).run();
    db.prepare(`INSERT INTO models (id, platform, model_id, display_name, intelligence_rank, speed_rank, size_label, key_id, endpoint_scope, source, enabled)
      VALUES (9002, 'custom', 'm-two', 'M Two', 1, 1, '', 9001, 'https://relay.example.com/v1', 'user', 1)`).run();
  });

  const SCOPE = 'https://relay.example.com/v1';

  it('reports all-zero available stats for an untested model', () => {
    const s = getModelTestStats(db, 'custom', 'm-one', SCOPE);
    expect(s.successCount).toBe(0);
    expect(s.failureCount).toBe(0);
    expect(s.unavailable).toBe(false);
    expect(successRate(s)).toBeNull();
  });

  it('retireModel deletes the row, tombstones, clears scope, and marks unavailable', () => {
    expect(retireModel(db, 9001)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) c FROM models WHERE id = 9001').get()).toMatchObject({ c: 0 });
    // Scope no longer lists the retired model.
    const scope = parseModelScope(
      (db.prepare('SELECT model_scope_json s FROM api_keys WHERE id = 9001').get() as any).s,
    );
    expect(scope?.has('m-one')).toBe(false);
    expect(scope?.has('m-two')).toBe(true);
    // Tombstone prevents catalog/custom sync from resurrecting it.
    expect(db.prepare('SELECT COUNT(*) c FROM custom_model_tombstones WHERE model_id = ?').get('m-one') as any)
      .toMatchObject({ c: 1 });
    // The unavailable badge survives the row deletion.
    expect(getModelTestStats(db, 'custom', 'm-one', SCOPE).unavailable).toBe(true);
  });

  it('force-add (resetTestStreak) zeros counters but keeps the badge', () => {
    db.prepare(`INSERT INTO model_test_stats (platform, model_id, endpoint_scope, success_count, failure_count, consecutive_failures, unavailable)
      VALUES ('custom','m-one',?,2,3,3,1)`).run(SCOPE);
    resetTestStreak(db, 'custom', 'm-one', SCOPE);
    const s = getModelTestStats(db, 'custom', 'm-one', SCOPE);
    expect(s.successCount).toBe(0);
    expect(s.failureCount).toBe(0);
    expect(s.consecutiveFailures).toBe(0);
    expect(s.unavailable).toBe(true);
    expect(successRate(s)).toBeNull();
  });

  it('a passing test clears the badge', () => {
    db.prepare(`INSERT INTO model_test_stats (platform, model_id, endpoint_scope, failure_count, consecutive_failures, unavailable)
      VALUES ('custom','m-one',?,5,5,1)`).run(SCOPE);
    clearUnavailable(db, 'custom', 'm-one', SCOPE);
    const s = getModelTestStats(db, 'custom', 'm-one', SCOPE);
    expect(s.unavailable).toBe(false);
    expect(s.consecutiveFailures).toBe(0);
  });

  it('selectTestTargets dedupes to one key per logical model', () => {
    const targets = selectTestTargets(db);
    expect(targets.map(t => t.modelId).sort()).toEqual(['m-one', 'm-two']);
  });
});
