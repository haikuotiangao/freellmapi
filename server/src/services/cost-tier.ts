import type { Db } from '../db/types.js';
import { getDb, getSetting, setSetting } from '../db/index.js';

// ── Cost tiering: keep paid models out of the routing pool ───────────────────
//
// The premise of this fork is "free quota only". The stock catalog cannot
// express that: OpenRouter publishes hundreds of models on one key and only the
// `:free` suffix ones cost nothing, while a few relays quietly flip a model to
// paid. The dashboard's per-model toggle works but is manual and is undone by
// every catalog re-apply that re-adds a row.
//
// So: a persisted `price_tier` per model, written only on POSITIVE evidence of
// a price, plus a router-level filter that skips 'paid' rows unless the
// operator opts out. 'unknown' is deliberately NOT filtered — refusing to route
// a model because nobody has confirmed its price would empty the catalog for
// every provider that publishes no pricing at all (Cloudflare, Cerebras, ...).

export type PriceTier = 'free' | 'paid' | 'unknown';

/** Setting key for the router-level paid-model filter. '1' (default) = on. */
export const FREE_ONLY_KEY = 'routing_free_only';

/** Whether the router should refuse to route models marked paid. Default ON. */
export function isFreeOnlyRoutingEnabled(): boolean {
  return getSetting(FREE_ONLY_KEY) !== '0';
}

export function setFreeOnlyRoutingEnabled(enabled: boolean): void {
  setSetting(FREE_ONLY_KEY, enabled ? '1' : '0');
}

// ── Paid-model detection ────────────────────────────────────────────────────
//
// Two independent signals, because neither alone is reliable:
//  1. The id itself. OpenRouter's convention is `vendor/model:free`, and this
//     is the single most reliable free/paid discriminator in the ecosystem.
//     Absence of the suffix is NOT proof of paid (most providers don't use it),
//     so it can only ever mark a model free.
//  2. The published price. `model-discovery.ts` already normalizes an upstream
//     pricing object into `isFree`; a non-zero component there is proof of paid.

/** Id spellings that assert a model is free. Only ever used to CONFIRM free. */
const FREE_ID_MARKERS = [':free', '-free', '/free', '_free', ':free:'] as const;

/** Id spellings that assert a model costs money. */
const PAID_ID_MARKERS = [':paid', '-paid', ':premium'] as const;

/** True when the model id carries an explicit "this one is free" marker. */
export function idSuggestsFree(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return FREE_ID_MARKERS.some(m => lower.includes(m));
}

/** True when the model id carries an explicit "this one costs money" marker. */
export function idSuggestsPaid(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return PAID_ID_MARKERS.some(m => lower.includes(m));
}

export interface PriceEvidence {
  /** From the upstream pricing block; `undefined` = the upstream said nothing. */
  isFree?: boolean;
  /** The normalized human-readable price note, stored for display only. */
  priceNote?: string;
}

/**
 * Decide the tier for one model from whatever evidence exists.
 *
 * Precedence is: an explicit paid id marker beats a price block (a relay that
 * labels a model `:paid` is telling us something the pricing blob may not), and
 * a price block beats an id marker that suggests free. `isFree === false` from a
 * real pricing object is the strongest "this costs money" signal we have.
 */
export function classifyPriceTier(modelId: string, evidence: PriceEvidence = {}): PriceTier {
  if (idSuggestsPaid(modelId)) return 'paid';
  if (evidence.isFree === false) return 'paid';
  if (evidence.isFree === true) return 'free';
  if (idSuggestsFree(modelId)) return 'free';
  return 'unknown';
}

/** Persist a tier for one (platform, model_id) row. No-op when absent. */
export function setModelPriceTier(
  platform: string,
  modelId: string,
  tier: PriceTier,
  priceNote?: string | null,
  db: Db = getDb(),
): void {
  if (priceNote !== undefined) {
    db.prepare('UPDATE models SET price_tier = ?, price_note = ? WHERE platform = ? AND model_id = ?')
      .run(tier, priceNote, platform, modelId);
  } else {
    db.prepare('UPDATE models SET price_tier = ? WHERE platform = ? AND model_id = ?')
      .run(tier, platform, modelId);
  }
}

/**
 * Re-derive `price_tier` for every catalog-owned model from its id alone.
 *
 * Run once at migration time and again after each catalog apply, so a model that
 * appears in a fresher catalog with a `:free` suffix is classified without a
 * manual pass. User-created rows (`source = 'user'`) are left untouched: their
 * price is whatever the operator said it was.
 */
export function reclassifyCatalogModelTiers(db: Db = getDb()): { free: number; paid: number; unknown: number } {
  const rows = db.prepare(`
    SELECT id, model_id, price_tier FROM models
     WHERE COALESCE(source, 'catalog') != 'user'
  `).all() as { id: number; model_id: string; price_tier: string }[];

  const update = db.prepare('UPDATE models SET price_tier = ? WHERE id = ?');
  const counts = { free: 0, paid: 0, unknown: 0 };
  db.transaction(() => {
    for (const row of rows) {
      const tier = classifyPriceTier(row.model_id);
      // A per-model override may already hold a stronger verdict than the id
      // carries (e.g. discovery proved a `:free`-looking id is actually billed).
      // Only overwrite when the id gives a definitive answer.
      const next = tier === 'unknown' ? (row.price_tier as PriceTier) : tier;
      if (next !== row.price_tier) update.run(next, row.id);
      counts[next as PriceTier]++;
    }
  })();
  return counts;
}

/** Counts per tier, for the dashboard summary. */
export function priceTierSummary(db: Db = getDb()): Record<PriceTier, number> {
  const rows = db.prepare('SELECT price_tier, COUNT(*) AS n FROM models GROUP BY price_tier')
    .all() as { price_tier: string; n: number }[];
  const out: Record<PriceTier, number> = { free: 0, paid: 0, unknown: 0 };
  for (const r of rows) {
    if (r.price_tier === 'free' || r.price_tier === 'paid' || r.price_tier === 'unknown') out[r.price_tier] = r.n;
  }
  return out;
}

/**
 * Disable every model currently marked paid.
 *
 * This is the "just make the paid ones go away" button: it writes `enabled = 0`
 * on paid rows and records no override, so a later catalog apply that flips one
 * back to free can re-enable it (see hiddenModelsForcedOff in catalog-sync).
 * Returns the number of rows actually changed.
 */
export function disablePaidModels(db: Db = getDb()): number {
  const info = db.prepare(`
    UPDATE models SET enabled = 0
     WHERE price_tier = 'paid' AND enabled = 1
       AND COALESCE(source, 'catalog') != 'user'
  `).run();
  return info.changes;
}

/** Re-enable every free model that is currently off. Mirrors disablePaidModels. */
export function enableFreeModels(db: Db = getDb()): number {
  const info = db.prepare(`
    UPDATE models SET enabled = 1
     WHERE price_tier = 'free' AND enabled = 0
       AND COALESCE(source, 'catalog') != 'user'
  `).run();
  return info.changes;
}