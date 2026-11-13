import type { Db } from '../types.js';

/**
 * Cost tiering + capability tiering for the local free-only fork.
 *
 * The stock catalog is a bag of "free-tier quota" endpoints, but individual
 * model ids inside a provider are not all free: OpenRouter's `/models` listing
 * mixes `:free` variants with paid ones, and a relay that changes its pricing
 * silently turns a free model into a billed one. The upstream app has no way to
 * express that, so the local build adds it here.
 *
 *  - `price_tier`      'free' | 'paid' | 'unknown'. Default 'free' is the
 *                      conservative choice for the bundled catalog rows (the
 *                      whole product premise is free quota, and defaulting to
 *                      'paid' would disable every existing install on upgrade).
 *                      Sync / discovery only ever writes 'paid' on POSITIVE
 *                      evidence (a non-zero price component, an explicit
 *                      paid marker). 'unknown' is never auto-disabled.
 *  - `capability_tier` 1 = frontier, 2 = strong, 3 = supplemental, 0 = unranked.
 *                      Used as the primary sort key under the manual strategy so
 *                      a caller's ordering can't put a 7B toy ahead of a
 *                      frontier model.
 *  - `price_note`      the upstream price string as observed, for the UI. Never
 *                      parsed for routing decisions (model-discovery has the
 *                      only parser, and it's the one that sets price_tier).
 *
 * `provider_limits` is a separate table rather than more env vars: the env-var
 * form (PROVIDER_*_CAP_*) only covers three numbers and cannot express
 * "NVIDIA meters 40 RPM per MODEL, not per account" or "AMD allows 8 concurrent".
 */
export function up(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(models)').all() as { name: string }[];
  const has = (name: string) => columns.some(c => c.name === name);

  // SQLite has no IF NOT EXISTS for ADD COLUMN, and this migration could be
  // re-run against a DB a partial write already touched.
  if (!has('price_tier')) {
    db.exec("ALTER TABLE models ADD COLUMN price_tier TEXT NOT NULL DEFAULT 'free'");
  }
  if (!has('capability_tier')) {
    db.exec('ALTER TABLE models ADD COLUMN capability_tier INTEGER NOT NULL DEFAULT 0');
  }
  if (!has('price_note')) {
    db.exec('ALTER TABLE models ADD COLUMN price_note TEXT');
  }
  if (!has('limit_scope')) {
    // 'model' = the provider meters this quota per model (NVIDIA NIM),
    // 'account' = one shared bucket for the whole key (OpenRouter free, AMD).
    // NULL falls back to the provider_limits default for the platform.
    db.exec('ALTER TABLE models ADD COLUMN limit_scope TEXT');
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_models_price_tier ON models(price_tier);
    CREATE INDEX IF NOT EXISTS idx_models_capability_tier ON models(capability_tier);

    CREATE TABLE IF NOT EXISTS provider_limits (
      platform TEXT PRIMARY KEY,
      rpm INTEGER,
      rpd INTEGER,
      tpm INTEGER,
      tpd INTEGER,
      max_concurrency INTEGER,
      -- 'model' (each model gets its own bucket) or 'account' (one shared bucket)
      scope TEXT NOT NULL DEFAULT 'account',
      -- Human-readable provenance for the dashboard: where these numbers came
      -- from and when they were last confirmed against the provider's docs.
      notes TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Model ids known to be junk: tiny parameter counts, toy/demo endpoints,
    -- or models the operator has explicitly blacklisted. Kept in its own table
    -- (not a models column) because it must survive catalog sync DELETING a
    -- model row — the id is remembered and re-applied when the model returns.
    CREATE TABLE IF NOT EXISTS model_denylist (
      platform TEXT NOT NULL,
      model_glob TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (platform, model_glob)
    );
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_models_price_tier;
    DROP INDEX IF EXISTS idx_models_capability_tier;
    DROP TABLE IF EXISTS provider_limits;
    DROP TABLE IF EXISTS model_denylist;
  `);
  // Columns are left in place: dropping them would need a table rebuild, and a
  // rollback that keeps harmless columns is safer than one that can lose rows.
}