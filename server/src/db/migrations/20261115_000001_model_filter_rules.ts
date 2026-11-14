// Migration: operator-defined model filter rules ("自定义过滤")
// Created: 2026-11-15
//
// DOWN: reversible (DROP TABLE)
//
// The fork already has two hard-coded filters — free-only (settings flag) and
// the three routing tiers — but an operator who wants "never route anything
// from provider X whose name contains -preview", or "only ever serve these
// four models", has no place to say it. This table holds those rules.
//
// It is a NEW TABLE, not another column on `models`, on purpose: adding a
// column there would shift the `SELECT * FROM models` snapshot that the
// probe-status migration stores, and the round-trip test asserts that every
// migration between group-label and probe-status sees the identical column
// set. Append-only tables have no such coupling.
//
// `action` is 'exclude' (blacklist) or 'include' (whitelist). Excludes run
// first; if at least one enabled INCLUDE rule exists, only models matching an
// include survive. Conditions are ANDed within a rule; NULL means "any".

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS model_filter_rules (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT NOT NULL,
      action           TEXT NOT NULL CHECK (action IN ('exclude', 'include')),
      platform         TEXT,
      model_pattern    TEXT,
      routing_tier     INTEGER CHECK (routing_tier IS NULL OR routing_tier BETWEEN 1 AND 3),
      price_tier       TEXT CHECK (price_tier IS NULL OR price_tier IN ('free', 'paid', 'unknown')),
      capability_tier  INTEGER,
      enabled_state    TEXT CHECK (enabled_state IS NULL OR enabled_state IN ('enabled', 'disabled')),
      enabled          INTEGER NOT NULL DEFAULT 1,
      priority         INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();
  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_model_filter_rules_active
      ON model_filter_rules (enabled, priority, id)
  `).run();
}

export function down(db: Db): void {
  db.prepare('DROP INDEX IF EXISTS idx_model_filter_rules_active').run();
  db.prepare('DROP TABLE IF EXISTS model_filter_rules').run();
}
