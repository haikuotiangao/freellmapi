import type { Db } from '../types.js';

/**
 * Per-model automated test statistics.
 *
 * A nightly job tests every registered model up to 5 times, records how many
 * of those attempts succeeded, and retires a model whose 5 attempts all fail
 * (deleting its rows + tombstoning it so catalog sync cannot resurrect it).
 * `unavailable` survives the deletion so the model picker can show a red badge
 * and let the operator force-add it back; a later passing test clears it.
 *
 * One row per LOGICAL model (platform + model_id + endpoint_scope), not per
 * key — the success rate shown in the models table is a property of the model,
 * and the nightly job retries the same model up to 5 times through its pool.
 */
export function up(db: Db): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS model_test_stats (
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      endpoint_scope TEXT NOT NULL DEFAULT '',
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_test_at TEXT,
      last_status TEXT,
      last_error TEXT,
      last_latency_ms INTEGER,
      unavailable INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (platform, model_id, endpoint_scope)
    )
  `).run();
}

export function down(db: Db): void {
  db.prepare('DROP TABLE IF EXISTS model_test_stats').run();
}
