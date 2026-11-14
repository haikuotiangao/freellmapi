// ── Operator-defined model filter rules ("自定义过滤") ──────────────────────
//
// The fork has two built-in funnels: free-only (a settings flag) and the three
// routing tiers (a strategy). Neither lets the operator say "never route any
// *-preview model from provider X" or "only ever serve these four models".
// This module turns those sentences into persisted rules and applies them at
// the SAME place as the free-only filter — orderChain() — so every one of the
// nine chain-building SQL paths is covered, not just the main one.
//
// Rule semantics (kept deliberately simple so the UI can explain them in one
// line):
//   * conditions inside a rule are ANDed; an empty/NULL condition means "any";
//   * all enabled 'exclude' rules are applied first — any match drops the row;
//   * if at least one enabled 'include' rule exists, a row must ALSO match at
//     least one of them to survive (whitelist). With no includes, everything
//     not excluded survives.
//
// Rules are read once and cached in-process; every write invalidates the cache.
// A missing table (e.g. a hand-built test DB that skipped migrations) degrades
// to "no rules" instead of turning every request into a 500.

import { getDb } from '../db/index.js';
import type { Db } from '../db/types.js';

export type FilterAction = 'exclude' | 'include';
export type FilterEnabledState = 'enabled' | 'disabled';

export interface ModelFilterRule {
  id: number;
  name: string;
  action: FilterAction;
  platform: string | null;
  model_pattern: string | null;
  routing_tier: number | null;
  price_tier: string | null;
  capability_tier: number | null;
  enabled_state: FilterEnabledState | null;
  enabled: number;
  priority: number;
  created_at: string;
}

export interface FilterRuleInput {
  name: string;
  action: FilterAction;
  platform?: string | null;
  modelPattern?: string | null;
  routingTier?: number | null;
  priceTier?: string | null;
  capabilityTier?: number | null;
  enabledState?: FilterEnabledState | null;
  enabled?: boolean;
  priority?: number;
}

/** The subset of a chain/row the matcher needs. ChainRow and the models table
 *  both satisfy it, so the same code serves live routing and the UI preview. */
export interface FilterableModel {
  platform: string;
  model_id: string;
  routing_tier?: number | null;
  price_tier?: string | null;
  capability_tier?: number | null;
  enabled?: number | boolean | null;
}

const RULE_COLUMNS = 'id, name, action, platform, model_pattern, routing_tier, price_tier, capability_tier, enabled_state, enabled, priority, created_at';

let cache: ModelFilterRule[] | null = null;
let tableMissing = false;

export function invalidateFilterRulesCache(): void {
  cache = null;
  tableMissing = false;
}

/** Enabled rules only, in the operator's priority order. */
export function getActiveFilterRules(db: Db = getDb()): ModelFilterRule[] {
  if (tableMissing) return [];
  if (cache) return cache;
  try {
    cache = db.prepare(
      `SELECT ${RULE_COLUMNS} FROM model_filter_rules WHERE enabled = 1 ORDER BY priority ASC, id ASC`,
    ).all() as ModelFilterRule[];
    return cache;
  } catch (err) {
    if (String(err).includes('no such table')) {
      tableMissing = true;
      return [];
    }
    throw err;
  }
}

export function listFilterRules(db: Db = getDb()): ModelFilterRule[] {
  return db.prepare(
    `SELECT ${RULE_COLUMNS} FROM model_filter_rules ORDER BY priority ASC, id ASC`,
  ).all() as ModelFilterRule[];
}

function nullable(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function createFilterRule(input: FilterRuleInput, db: Db = getDb()): ModelFilterRule {
  const info = db.prepare(`
    INSERT INTO model_filter_rules
      (name, action, platform, model_pattern, routing_tier, price_tier,
       capability_tier, enabled_state, enabled, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.name.trim(),
    input.action,
    nullable(input.platform),
    nullable(input.modelPattern),
    input.routingTier ?? null,
    nullable(input.priceTier),
    input.capabilityTier ?? null,
    nullable(input.enabledState),
    input.enabled === false ? 0 : 1,
    input.priority ?? 0,
  );
  invalidateFilterRulesCache();
  return db.prepare(`SELECT ${RULE_COLUMNS} FROM model_filter_rules WHERE id = ?`)
    .get(Number(info.lastInsertRowid)) as ModelFilterRule;
}

export function updateFilterRule(
  id: number,
  patch: Partial<FilterRuleInput>,
  db: Db = getDb(),
): ModelFilterRule | null {
  const existing = db.prepare(`SELECT ${RULE_COLUMNS} FROM model_filter_rules WHERE id = ?`)
    .get(id) as ModelFilterRule | undefined;
  if (!existing) return null;
  db.prepare(`
    UPDATE model_filter_rules SET
      name = ?, action = ?, platform = ?, model_pattern = ?, routing_tier = ?,
      price_tier = ?, capability_tier = ?, enabled_state = ?, enabled = ?, priority = ?
    WHERE id = ?
  `).run(
    patch.name !== undefined ? patch.name.trim() : existing.name,
    patch.action ?? existing.action,
    patch.platform !== undefined ? nullable(patch.platform) : existing.platform,
    patch.modelPattern !== undefined ? nullable(patch.modelPattern) : existing.model_pattern,
    patch.routingTier !== undefined ? patch.routingTier : existing.routing_tier,
    patch.priceTier !== undefined ? nullable(patch.priceTier) : existing.price_tier,
    patch.capabilityTier !== undefined ? patch.capabilityTier : existing.capability_tier,
    patch.enabledState !== undefined ? nullable(patch.enabledState) : existing.enabled_state,
    patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled,
    patch.priority ?? existing.priority,
    id,
  );
  invalidateFilterRulesCache();
  return db.prepare(`SELECT ${RULE_COLUMNS} FROM model_filter_rules WHERE id = ?`)
    .get(id) as ModelFilterRule;
}

export function deleteFilterRule(id: number, db: Db = getDb()): boolean {
  const info = db.prepare('DELETE FROM model_filter_rules WHERE id = ?').run(id);
  invalidateFilterRulesCache();
  return info.changes > 0;
}

/** Glob-ish match: `*` is the only wildcard, matching is case-insensitive.
 *  A pattern containing `/` is matched against `platform/model_id`, otherwise
 *  against the bare model id — so "gpt-*" and "openai/gpt-*" both work. */
function matchesPattern(row: FilterableModel, pattern: string): boolean {
  const target = pattern.includes('/')
    ? `${row.platform}/${row.model_id}`
    : row.model_id;
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(target);
}

export function ruleMatches(rule: ModelFilterRule, row: FilterableModel): boolean {
  if (rule.platform && rule.platform.toLowerCase() !== row.platform.toLowerCase()) return false;
  if (rule.model_pattern && !matchesPattern(row, rule.model_pattern)) return false;
  if (rule.routing_tier != null && (row.routing_tier ?? 3) !== rule.routing_tier) return false;
  if (rule.price_tier && (row.price_tier ?? 'unknown') !== rule.price_tier) return false;
  if (rule.capability_tier != null && (row.capability_tier ?? 0) !== rule.capability_tier) return false;
  if (rule.enabled_state) {
    const on = row.enabled === 1 || row.enabled === true;
    if (rule.enabled_state === 'enabled' && !on) return false;
    if (rule.enabled_state === 'disabled' && on) return false;
  }
  return true;
}

export interface FilterResult<T> {
  kept: T[];
  excluded: T[];
  /** Number of models dropped, and whether a whitelist was in force. */
  dropped: number;
  whitelistActive: boolean;
}

/** Apply the persisted rules to a chain. Used by orderChain() — the single
 *  funnel every chain builder passes through. */
export function applyFilterRules<T extends FilterableModel>(
  rows: T[],
  rules: ModelFilterRule[] = getActiveFilterRules(),
): FilterResult<T> {
  if (rules.length === 0) return { kept: rows, excluded: [], dropped: 0, whitelistActive: false };
  const excludes = rules.filter(r => r.action === 'exclude');
  const includes = rules.filter(r => r.action === 'include');
  const whitelistActive = includes.length > 0;
  const kept: T[] = [];
  const excluded: T[] = [];
  for (const row of rows) {
    if (excludes.some(r => ruleMatches(r, row)) || (whitelistActive && !includes.some(r => ruleMatches(r, row)))) {
      excluded.push(row);
      continue;
    }
    kept.push(row);
  }
  return { kept, excluded, dropped: excluded.length, whitelistActive };
}

export interface FilterRulePreview {
  total: number;
  remaining: number;
  dropped: number;
  whitelistActive: boolean;
  perRule: { id: number; name: string; action: FilterAction; hits: number }[];
}

/** Hit counts against the whole catalog — what the tuning page shows before
 *  the operator saves a rule that would silently empty the pool. */
export function previewFilterRules(rules: ModelFilterRule[] = getActiveFilterRules(), db: Db = getDb()): FilterRulePreview {
  const rows = db.prepare(`
    SELECT platform, model_id, routing_tier, price_tier, capability_tier, enabled
      FROM models
  `).all() as FilterableModel[];
  const result = applyFilterRules(rows, rules);
  return {
    total: rows.length,
    remaining: result.kept.length,
    dropped: result.dropped,
    whitelistActive: result.whitelistActive,
    perRule: rules.map(r => ({
      id: r.id,
      name: r.name,
      action: r.action,
      hits: rows.filter(row => ruleMatches(r, row)).length,
    })),
  };
}
