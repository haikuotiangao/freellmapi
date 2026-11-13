import { Router } from 'express';
import { getDb } from '../db/index.js';
import {
  FREE_ONLY_KEY,
  isFreeOnlyRoutingEnabled,
  setFreeOnlyRoutingEnabled,
  disablePaidModels,
  enableFreeModels,
  priceTierSummary,
  reclassifyCatalogModelTiers,
} from '../services/cost-tier.js';
import {
  capabilitySummary,
  disableJunkModels,
  recomputeCapabilityTiers,
  resortChainByCapability,
  TIER_LABELS,
  type CapabilityTier,
} from '../services/capability-tier.js';
import {
  getProviderLimits,
  listProviderLimits,
  seedProviderLimits,
  setProviderLimits,
  type ProviderLimitPatch,
} from '../services/provider-limits.js';
import {
  providerLimitRoster,
} from '../services/provider-roster.js';
import {
  TIER_ROUTING_ENABLED_KEY,
  TIER1_ROUNDS_KEY,
  DEFAULT_TIER1_ROUNDS,
  MAX_TIER1_ROUNDS,
  isTierRoutingEnabled,
  setTierRoutingEnabled,
  getTier1Rounds,
  setTier1Rounds,
  assignRoutingTiersByAbility,
  routingTierSummary,
  setModelRoutingTier,
  type RoutingTier,
} from '../services/tier-routing.js';
import { refreshProviderModels } from '../services/model-refresh.js';

// ── Operator tuning surface ─────────────────────────────────────────────────
//
// One router for the things this fork adds that the stock dashboard has no
// place for: the free-only switch, the two bulk passes over the catalog
// (drop paid / drop junk), the "re-sort my chain by ability" rewrite, the
// per-provider rate-limit table, and the on-demand provider refresh.
//
// Everything here is idempotent and reports what it actually changed — the
// operator is expected to press these buttons blind and needs to be able to
// tell a no-op from a fix.

export const tuningRouter = Router();

/** GET /api/tuning/summary — tier counts + the free-only switch, for the header. */
tuningRouter.get('/summary', (_req, res) => {
  const db = getDb();
  const tiers = priceTierSummary(db);
  const capability = capabilitySummary(db);
  const enabled = db.prepare('SELECT COUNT(*) AS n FROM models WHERE enabled = 1').get() as { n: number };
  res.json({
    freeOnlyRouting: isFreeOnlyRoutingEnabled(),
    priceTiers: tiers,
    capabilityTiers: capability.map(row => ({
      tier: row.tier,
      label: TIER_LABELS[row.tier as CapabilityTier] ?? 'unranked',
      count: row.count,
    })),
    enabledModels: enabled.n,
    routingTiers: {
      enabled: isTierRoutingEnabled(),
      rounds: getTier1Rounds(),
      defaultRounds: DEFAULT_TIER1_ROUNDS,
      maxRounds: MAX_TIER1_ROUNDS,
      counts: routingTierSummary(db),
    },
  });
});

// ── Routing tiers (第一梯队 / 第二梯队 / 其他) ──────────────────────────────

/** GET /api/tuning/routing-tiers — the operator strings' current shape. */
tuningRouter.get('/routing-tiers', (_req, res) => {
  res.json({
    enabled: isTierRoutingEnabled(),
    rounds: getTier1Rounds(),
    defaultRounds: DEFAULT_TIER1_ROUNDS,
    maxRounds: MAX_TIER1_ROUNDS,
    counts: routingTierSummary(),
  });
});

/** PUT /api/tuning/routing-tiers { enabled?: boolean, rounds?: number } */
tuningRouter.put('/routing-tiers', (req, res) => {
  const body = (req.body ?? {}) as { enabled?: unknown; rounds?: unknown };
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      res.status(400).json({ error: { message: 'enabled must be a boolean' } });
      return;
    }
    setTierRoutingEnabled(body.enabled);
  }
  if (body.rounds !== undefined) {
    if (typeof body.rounds !== 'number' || !Number.isFinite(body.rounds)) {
      res.status(400).json({ error: { message: 'rounds must be a number' } });
      return;
    }
    setTier1Rounds(body.rounds);
  }
  res.json({
    enabled: isTierRoutingEnabled(),
    rounds: getTier1Rounds(),
    settingKeys: [TIER_ROUTING_ENABLED_KEY, TIER1_ROUNDS_KEY],
    counts: routingTierSummary(),
  });
});

/**
 * POST /api/tuning/routing-tiers/assign { includeManual?: boolean }
 *
 * The bulk "assign strings by ability" pass: capability tier 1 → routing tier
 * 1, 2 → 2, the rest → 3. Hand-placed rows (routing_tier_source='manual') are
 * left alone unless includeManual is true.
 */
tuningRouter.post('/routing-tiers/assign', (req, res) => {
  const body = (req.body ?? {}) as { includeManual?: boolean };
  const out = assignRoutingTiersByAbility(getDb(), body.includeManual === true);
  res.json({ ...out, counts: routingTierSummary() });
});

/**
 * GET /api/tuning/routing-tiers/models?tier=1&q=foo&limit=200
 *
 * The editable membership list behind the three strings. Returns the columns
 * the dashboard needs to justify a placement (price tier, ability tier, source)
 * rather than just ids, so a hand-placed row is visibly different from an
 * auto-assigned one.
 */
tuningRouter.get('/routing-tiers/models', (req, res) => {
  const db = getDb();
  const tierRaw = typeof req.query.tier === 'string' ? Number.parseInt(req.query.tier, 10) : NaN;
  const tier = tierRaw === 1 || tierRaw === 2 || tierRaw === 3 ? tierRaw : null;
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 120) : '';
  const limitRaw = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 200;
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 1000) : 200;

  const clauses = ['1 = 1'];
  const args: (string | number)[] = [];
  if (tier) { clauses.push('routing_tier = ?'); args.push(tier); }
  if (q) { clauses.push('(model_id LIKE ? OR display_name LIKE ? OR platform LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  args.push(limit);
  const models = db.prepare(`
    SELECT id, platform, model_id, display_name, price_tier, capability_tier,
           routing_tier, routing_tier_source, enabled
      FROM models
     WHERE ${clauses.join(' AND ')}
     ORDER BY routing_tier ASC, capability_tier ASC, platform ASC, model_id ASC
     LIMIT ?
  `).all(...args);
  res.json({ models, counts: routingTierSummary(db), limit });
});

/** PUT /api/tuning/routing-tiers/models/:id { tier: 1 | 2 | 3 } — one model. */
tuningRouter.put('/routing-tiers/models/:id', (req, res) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'invalid model id' } });
    return;
  }
  const tier = (req.body ?? {}).tier;
  if (tier !== 1 && tier !== 2 && tier !== 3) {
    res.status(400).json({ error: { message: 'tier must be 1, 2 or 3' } });
    return;
  }
  setModelRoutingTier(id, tier as RoutingTier);
  const row = getDb().prepare('SELECT id, routing_tier, routing_tier_source FROM models WHERE id = ?').get(id);
  if (!row) {
    res.status(404).json({ error: { message: 'no such model' } });
    return;
  }
  res.json({ model: row });
});

/** PUT /api/tuning/free-only  { enabled: boolean } */
tuningRouter.put('/free-only', (req, res) => {
  const enabled = (req.body ?? {}).enabled;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: { message: 'enabled must be a boolean' } });
    return;
  }
  setFreeOnlyRoutingEnabled(enabled);
  res.json({ freeOnlyRouting: isFreeOnlyRoutingEnabled(), setting: FREE_ONLY_KEY });
});

/**
 * POST /api/tuning/disable-paid — turn off every model currently marked paid.
 * POST with `{ reclassify: true }` first re-derives the tiers from model ids, so
 * a catalog apply that introduced `:free` variants is accounted for.
 */
tuningRouter.post('/disable-paid', (req, res) => {
  const db = getDb();
  const body = (req.body ?? {}) as { reclassify?: boolean };
  const reclassified = body.reclassify ? reclassifyCatalogModelTiers(db) : null;
  const disabled = disablePaidModels(db);
  res.json({ disabled, reclassified, priceTiers: priceTierSummary(db) });
});

/** POST /api/tuning/enable-free — reverse of disable-paid, for free rows only. */
tuningRouter.post('/enable-free', (_req, res) => {
  const db = getDb();
  const enabled = enableFreeModels(db);
  res.json({ enabled, priceTiers: priceTierSummary(db) });
});

/**
 * POST /api/tuning/junk
 *   { action: 'recompute' | 'disable' | 'resort' | 'all', confirm?: true }
 *
 * `disable` and `all` are destructive to the enabled set (though reversible with
 * a plain toggle), so they require `confirm: true`. `recompute` and `resort`
 * only rewrite derived columns and are safe.
 */
tuningRouter.post('/junk', (req, res) => {
  const db = getDb();
  const body = (req.body ?? {}) as { action?: string; confirm?: boolean };
  const action = body.action ?? 'recompute';

  if (!['recompute', 'disable', 'resort', 'all'].includes(action)) {
    res.status(400).json({ error: { message: `unknown action '${action}'` } });
    return;
  }
  if ((action === 'disable' || action === 'all') && body.confirm !== true) {
    res.status(400).json({
      error: { message: 'disabling models requires confirm: true' },
      hint: 'POST { "action": "recompute" } first to see the tier counts',
      capabilityTiers: capabilitySummary(db),
    });
    return;
  }

  const out: Record<string, unknown> = { action };
  if (action === 'recompute' || action === 'all') {
    out.capabilityTiers = recomputeCapabilityTiers(db);
  }
  if (action === 'disable' || action === 'all') {
    out.disabled = disableJunkModels(db);
  }
  if (action === 'resort' || action === 'all') {
    out.reprioritized = resortChainByCapability(db);
  }
  res.json({ ...out, summary: capabilitySummary(db) });
});

/** GET /api/tuning/limits — every seeded/edited provider profile. */
tuningRouter.get('/limits', (_req, res) => {
  res.json({ limits: listProviderLimits() });
});

/**
 * GET /api/tuning/limits/roster — EVERY registered provider with its editable
 * profile and the quota facts quoted from the provider's own documentation.
 * This is the single-page "全部厂商限制" table: configured rows first, and a
 * row exists even when nothing is enforced yet (its fields are just empty).
 */
tuningRouter.get('/limits/roster', (_req, res) => {
  res.json({ roster: providerLimitRoster() });
});

/** PUT /api/tuning/limits/:platform — partial update, undefined fields untouched. */
tuningRouter.put('/limits/:platform', (req, res) => {
  const platform = req.params.platform;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const num = (v: unknown) =>
    v === null ? null : typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
  const patch: ProviderLimitPatch = {
    rpm: num(body.rpm),
    rpd: num(body.rpd),
    tpm: num(body.tpm),
    tpd: num(body.tpd),
    maxConcurrency: num(body.maxConcurrency),
    scope: body.scope === 'model' || body.scope === 'account' ? body.scope : undefined,
    notes: typeof body.notes === 'string' ? body.notes : body.notes === null ? null : undefined,
  };
  setProviderLimits(platform, patch);
  res.json({ limits: getProviderLimits(platform) });
});

/** POST /api/tuning/limits/seed — re-seed the built-in profiles (non-destructive). */
tuningRouter.post('/limits/seed', (_req, res) => {
  res.json({ inserted: seedProviderLimits(), limits: listProviderLimits() });
});

/**
 * POST /api/tuning/refresh  { platforms?: string[], recomputeTiers?: boolean }
 *
 * Asks each configured provider's own `/models` what it serves and merges the
 * answer. Slow (one round trip per platform, sequential), so the dashboard
 * should show a spinner rather than block on it.
 */
tuningRouter.post('/refresh', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as { platforms?: string[]; recomputeTiers?: boolean; skipKeyless?: boolean };
    const platforms = Array.isArray(body.platforms)
      ? body.platforms.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : undefined;
    const report = await refreshProviderModels(getDb(), {
      platforms: platforms?.length ? platforms : undefined,
      recomputeTiers: body.recomputeTiers !== false,
      skipKeyless: body.skipKeyless === true,
    });
    res.json(report);
  } catch (err) {
    next(err);
  }
});
