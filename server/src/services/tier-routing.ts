import type { Db } from '../db/types.js';
import { getDb, getSetting, setSetting } from '../db/index.js';

// ── Operator routing tiers ("第一梯队 / 第二梯队 / 其他") ───────────────────
//
// `capability_tier` (services/capability-tier.ts) answers "how good is this
// model". This module answers the different question the operator actually
// routes on: "which string do I want serving requests, and how many passes do
// I give the top one before falling through?"
//
//   tier 1 = 第一梯队 — default. Every request walks it first, and re-walks it
//            up to TIER1_ROUNDS passes before tier 2 is consulted at all.
//   tier 2 = 第二梯队 — tried after tier 1's passes produce nothing.
//   tier 3 = 其他     — the long tail, tried last. The DEFAULT for every row,
//            so turning tiering on never promotes anything by accident.
//
// Settings (settings table, same pattern as routing_free_only):
//   tier_routing_enabled — '1' (default) | '0'
//   tier1_rounds         — integer ≥ 1, default 2. Capped at 10: each pass
//                          re-walks the whole tier, so an unbounded value
//                          turns a dead tier-1 into a request timeout.
//
// Rows carry routing_tier_source so the bulk "assign by ability" pass can tell
// a hand-placed model ('manual') from one it ranked itself ('auto'), and never
// overrides the former.

export type RoutingTier = 1 | 2 | 3;

export const TIER_ROUTING_ENABLED_KEY = 'tier_routing_enabled';
export const TIER1_ROUNDS_KEY = 'tier1_rounds';

export const DEFAULT_TIER1_ROUNDS = 2;
export const MAX_TIER1_ROUNDS = 10;

export const ROUTING_TIER_LABELS: Record<RoutingTier, string> = {
  1: 'first',
  2: 'second',
  3: 'other',
};

export function isTierRoutingEnabled(): boolean {
  return getSetting(TIER_ROUTING_ENABLED_KEY) !== '0';
}

export function setTierRoutingEnabled(enabled: boolean): void {
  setSetting(TIER_ROUTING_ENABLED_KEY, enabled ? '1' : '0');
}

export function getTier1Rounds(): number {
  const raw = getSetting(TIER1_ROUNDS_KEY);
  if (raw == null) return DEFAULT_TIER1_ROUNDS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_TIER1_ROUNDS;
  return Math.min(n, MAX_TIER1_ROUNDS);
}

export function setTier1Rounds(rounds: number): number {
  const clamped = Math.min(Math.max(Math.floor(rounds), 1), MAX_TIER1_ROUNDS);
  setSetting(TIER1_ROUNDS_KEY, String(clamped));
  return clamped;
}

/** Split an ordered chain into the three operator tiers, order preserved. */
export function partitionByRoutingTier<T extends { routing_tier?: number | null }>(
  chain: T[],
): { first: T[]; second: T[]; other: T[] } {
  const first: T[] = [];
  const second: T[] = [];
  const other: T[] = [];
  for (const row of chain) {
    const tier = row.routing_tier ?? 3;
    if (tier === 1) first.push(row);
    else if (tier === 2) second.push(row);
    else other.push(row);
  }
  return { first, second, other };
}

export interface TierRoutingPlan<T> {
  ordered: T[];
  /** The tier1_rounds actually in force for this walk. */
  rounds: number;
  counts: { first: number; second: number; other: number };
}

/**
 * Expand a strategy-ordered chain into the walk order tiering produces.
 *
 * Within each tier the incoming order (whatever the strategy scored) is kept.
 * Tier 1 is walked `rounds` times back to back — the second pass exists so a
 * model that 429'd once can be re-tried after its peers before we admit tier 2
 * is needed; the caller's skip bookkeeping makes re-visits cheap no-ops when a
 * row was ruled out, not re-dispatches.
 */
export function buildTierWalkOrder<T extends { routing_tier?: number | null }>(
  chain: T[],
  options: { enabled?: boolean; rounds?: number } = {},
): TierRoutingPlan<T> {
  const enabled = options.enabled ?? isTierRoutingEnabled();
  const rounds = Math.min(Math.max(options.rounds ?? getTier1Rounds(), 1), MAX_TIER1_ROUNDS);
  if (!enabled) {
    return {
      ordered: chain,
      rounds,
      counts: { first: 0, second: 0, other: chain.length },
    };
  }
  const { first, second, other } = partitionByRoutingTier(chain);
  const ordered: T[] = [];
  for (let pass = 0; pass < rounds; pass++) ordered.push(...first);
  ordered.push(...second, ...other);
  return { ordered, rounds, counts: { first: first.length, second: second.length, other: other.length } };
}

/**
 * Assign routing tiers from capability tiers — the "自动分组" button.
 *
 * capability_tier 1 → routing tier 1; 2 → 2; 3/4/0 → 3. Rows the operator
 * placed by hand (routing_tier_source = 'manual') are never touched; pass
 * `includeManual: true` to override everything anyway.
 */
export function assignRoutingTiersByAbility(
  db: Db = getDb(),
  includeManual = false,
): { changed: number; manual: number } {
  const manualRow = db.prepare(
    "SELECT COUNT(*) AS n FROM models WHERE routing_tier_source = 'manual'",
  ).get() as { n: number };
  const where = includeManual ? '' : " AND routing_tier_source != 'manual'";
  const info = db.prepare(`
    UPDATE models SET
      routing_tier = CASE
        WHEN capability_tier = 1 THEN 1
        WHEN capability_tier = 2 THEN 2
        ELSE 3
      END,
      routing_tier_source = 'auto'
     WHERE 1 = 1${where}
  `).run();
  return { changed: info.changes, manual: manualRow.n };
}

/** Count models per routing tier for the dashboard header. */
export function routingTierSummary(db: Db = getDb()): { tier: number; count: number }[] {
  return db.prepare(`
    SELECT routing_tier AS tier, COUNT(*) AS count
      FROM models GROUP BY routing_tier ORDER BY routing_tier
  `).all() as { tier: number; count: number }[];
}

/** Change one model's tier (and mark it operator-owned). */
export function setModelRoutingTier(
  modelDbId: number,
  tier: RoutingTier,
  db: Db = getDb(),
): void {
  db.prepare('UPDATE models SET routing_tier = ?, routing_tier_source = ? WHERE id = ?')
    .run(tier, 'manual', modelDbId);
}

/**
 * Boot / catalog / refresh hook: keep the three strings populated by default.
 *
 * The migration gives every row `routing_tier = 3` ("other"), so a fresh
 * install would otherwise have an EMPTY first string — walking tier 1 twice
 * would do nothing and the operator's "default to the first string" request
 * would be a no-op until someone pressed the auto-assign button. Call this
 * after `recomputeCapabilityTiers()` wherever new catalog rows can land.
 *
 * It is deliberately the non-destructive `assignRoutingTiersByAbility(...,
 * false)`: a row the operator placed by hand (`routing_tier_source =
 * 'manual'`) is left exactly where they put it, on every boot and every sync.
 * Re-running on rows still marked 'auto' is what keeps the strings aligned
 * with the catalog when ranks change.
 */
export function ensureDefaultRoutingTiers(db: Db = getDb()): void {
  assignRoutingTiersByAbility(db, false);
}
