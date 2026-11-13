import type { Db } from '../types.js';

// ── Migration: operator-visible routing tiers ───────────────────────────────
//
// `capability_tier` answers "how good is this model" and is derived from the
// catalog. That is not the same question as "how much do I want to lean on it":
// a strong model behind a 20-requests-per-day key is a worse first choice than
// a merely good one behind an unmetered key, and the operator is the only one
// who knows which is which.
//
// `routing_tier` is that separate, operator-owned axis:
//
//   1 = first string   — tried first, and re-tried for `rounds` passes
//   2 = second string  — tried only after tier 1 is exhausted
//   3 = the rest       — tried last (the default for every existing row)
//
// The walk order itself lives in services/tier-routing.ts and is applied by the
// router; this migration only adds the storage. `routing_tier_source` records
// whether a row's tier came from the bulk "assign by ability" pass ('auto') or
// from a deliberate edit ('manual'), so re-running the bulk pass never silently
// undoes a hand-placed model.
//
// Dated 2026-10-02 for the same reason as the cost-tier migration: it touches
// `models`, and every later migration that snapshots `SELECT * FROM models`
// into settings has to see an identical column set on every replay (see the
// round-trip regression test).

export const name = 'model_routing_tier';

export function up(db: Db): void {
  // Idempotent for the same reason the cost-tier migration is: the round-trip
  // test rolls back to the baseline and replays every migration, and the
  // custom-endpoint-identity rebuild carries these columns forward when it
  // recreates `models`. A blind ALTER would then fail with "duplicate column".
  const columns = db.prepare('PRAGMA table_info(models)').all() as { name: string }[];
  const has = (name: string) => columns.some(c => c.name === name);
  if (!has('routing_tier')) {
    db.exec('ALTER TABLE models ADD COLUMN routing_tier INTEGER NOT NULL DEFAULT 3');
  }
  if (!has('routing_tier_source')) {
    db.exec("ALTER TABLE models ADD COLUMN routing_tier_source TEXT NOT NULL DEFAULT 'auto'");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_models_routing_tier
      ON models(routing_tier, enabled);
  `);
}

export function down(db: Db): void {
  db.exec('DROP INDEX IF EXISTS idx_models_routing_tier');
  // SQLite cannot drop a column in place before 3.35, and the app only ever
  // moves forward; keep `down` honest by leaving the columns and dropping the
  // index that the rest of the schema does not know about.
}
