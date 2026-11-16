import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import {
  FREE_ONLY_KEY,
  MANUAL_PRICE_NOTE,
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
import {
  createFilterRule,
  deleteFilterRule,
  getActiveFilterRules,
  invalidateFilterRulesCache,
  listFilterRules,
  previewFilterRules,
  updateFilterRule,
  type FilterRuleInput,
  type ModelFilterRule,
} from '../services/model-filter-rules.js';
import { getActiveProfileId } from '../services/profile-models.js';

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

// ── Custom model filters (自定义过滤) ────────────────────────────────────────
//
// Rules live in `model_filter_rules` and are applied inside orderChain(), i.e.
// at the ONE funnel every chain builder passes through. Everything here is a
// plain CRUD over that table; the preview endpoint runs the exact same matcher
// against the whole catalog so the operator can see the blast radius before
// saving a rule that would empty the pool.

const filterRuleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  action: z.enum(['exclude', 'include']),
  platform: z.string().trim().max(80).nullable().optional(),
  modelPattern: z.string().trim().max(200).nullable().optional(),
  routingTier: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable().optional(),
  priceTier: z.enum(['free', 'paid', 'unknown']).nullable().optional(),
  capabilityTier: z.number().int().min(0).max(4).nullable().optional(),
  enabledState: z.enum(['enabled', 'disabled']).nullable().optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
}).strict();

/** Turn validated input into a rule-shaped object for the preview matcher. */
function draftRule(input: FilterRuleInput): ModelFilterRule {
  return {
    id: -1,
    name: input.name,
    action: input.action,
    platform: input.platform?.trim() || null,
    model_pattern: input.modelPattern?.trim() || null,
    routing_tier: input.routingTier ?? null,
    price_tier: input.priceTier?.trim() || null,
    capability_tier: input.capabilityTier ?? null,
    enabled_state: input.enabledState?.trim() as ModelFilterRule['enabled_state'] ?? null,
    enabled: input.enabled === false ? 0 : 1,
    priority: input.priority ?? 0,
    created_at: '',
  };
}

function parseRuleBody(body: unknown, res: import('express').Response, partial = false): FilterRuleInput | null {
  const schema = partial ? filterRuleSchema.partial().refine(
    v => Object.keys(v).length > 0,
    { message: 'no filter fields provided' },
  ) : filterRuleSchema;
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues.map(e => e.message).join(', ') } });
    return null;
  }
  return parsed.data as FilterRuleInput;
}

/** GET /api/tuning/filters — all rules plus the live hit-count preview. */
tuningRouter.get('/filters', (_req, res) => {
  res.json({
    rules: listFilterRules(),
    preview: previewFilterRules(),
  });
});

/** POST /api/tuning/filters/preview — impact of the active rules + a draft. */
tuningRouter.post('/filters/preview', (req, res) => {
  const body = (req.body ?? {}) as { rule?: unknown };
  const active = getActiveFilterRules();
  if (body.rule === undefined) {
    res.json(previewFilterRules(active));
    return;
  }
  const draft = parseRuleBody(body.rule, res);
  if (!draft) return;
  const rules = draft.enabled === false ? active : [...active, draftRule(draft)];
  res.json(previewFilterRules(rules));
});

/** POST /api/tuning/filters — create a rule. */
tuningRouter.post('/filters', (req, res) => {
  const input = parseRuleBody(req.body, res);
  if (!input) return;
  res.status(201).json({ rule: createFilterRule(input), preview: previewFilterRules() });
});

/** PUT /api/tuning/filters/:id — edit a rule (partial patch). */
tuningRouter.put('/filters/:id', (req, res) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'invalid rule id' } });
    return;
  }
  const patch = parseRuleBody(req.body, res, true);
  if (!patch) return;
  const rule = updateFilterRule(id, patch);
  if (!rule) {
    res.status(404).json({ error: { message: 'no such filter rule' } });
    return;
  }
  res.json({ rule, preview: previewFilterRules() });
});

/** DELETE /api/tuning/filters/:id */
tuningRouter.delete('/filters/:id', (req, res) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'invalid rule id' } });
    return;
  }
  if (!deleteFilterRule(id)) {
    res.status(404).json({ error: { message: 'no such filter rule' } });
    return;
  }
  res.json({ deleted: id, preview: previewFilterRules() });
});

// ── Model editing / bulk editing (编辑模型) ─────────────────────────────────

const MODEL_PAGE_COLUMNS = `
  id, platform, model_id, display_name, price_tier, price_note,
  capability_tier, routing_tier, routing_tier_source, enabled,
  supports_vision, supports_tools, context_window, key_id`;

/**
 * GET /api/tuning/models
 *   ?tier=&q=&platform=&enabled=&price=&configuredOnly=&limit=&offset=
 *
 * The editable catalog behind the bulk editor. Kept separate from
 * /routing-tiers/models so the two surfaces can paginate independently.
 *
 * Two things this endpoint gets right that the earlier version did not:
 *
 * 1. `ORDER BY` is the full tier walk — routing tier, then capability tier,
 *    then provider/id. Without the capability tiebreaker a page of 50 rows is
 *    ordered only by the three routing strings, so ~900 "other" models come
 *    back in provider order and the list looks arbitrary. Sorting 1 → 2 → 3
 *    is the operator's stated expectation; the stable secondary keys keep
 *    pagination honest (same row never appears on two pages).
 *
 * 2. `configuredOnly=1` narrows to rows the operator can actually call: a
 *    model whose platform has an enabled api_keys row, or one bound to a key
 *    by key_id. Catalog breadth is fine for browsing, but the free-model
 *    sweep the operator runs is about THEIR keys — 434 openrouter rows and
 *    469 kilo rows are noise when only a handful of endpoints are wired up.
 */
tuningRouter.get('/models', (req, res) => {
  const db = getDb();
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 120) : '';
  const platform = typeof req.query.platform === 'string' ? req.query.platform.trim().slice(0, 80) : '';
  const tierRaw = typeof req.query.tier === 'string' ? Number.parseInt(req.query.tier, 10) : NaN;
  const tier = tierRaw === 1 || tierRaw === 2 || tierRaw === 3 ? tierRaw : null;
  const enabledRaw = typeof req.query.enabled === 'string' ? req.query.enabled : '';
  const priceRaw = typeof req.query.price === 'string' ? req.query.price : '';
  // 'routable' = what the router actually keeps when free-only is on: everything
  // that is not proven paid. Filtering `price_tier = 'free'` instead would hide
  // every unpriced row, which is most user-created endpoints (their pricing is
  // simply not published) — precisely the models the operator is looking for.
  const price = priceRaw === 'routable' || priceRaw === 'free' || priceRaw === 'paid' || priceRaw === 'unknown'
    ? priceRaw
    : null;
  const configuredOnly = req.query.configuredOnly === '1';
  const limitRaw = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 100;
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 1000) : 100;
  const offsetRaw = typeof req.query.offset === 'string' ? Number.parseInt(req.query.offset, 10) : 0;
  const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;

  const clauses = ['1 = 1'];
  const args: (string | number)[] = [];
  if (q) { clauses.push('(model_id LIKE ? OR display_name LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  if (platform) { clauses.push('platform = ?'); args.push(platform); }
  if (tier) { clauses.push('routing_tier = ?'); args.push(tier); }
  if (price === 'routable') { clauses.push("price_tier != 'paid'"); }
  else if (price) { clauses.push('price_tier = ?'); args.push(price); }
  if (enabledRaw === '1' || enabledRaw === '0') { clauses.push('enabled = ?'); args.push(Number(enabledRaw)); }
  if (configuredOnly) {
    // A model is "callable" when it is bound to a key (custom endpoints do
    // this) or when its platform has at least one enabled key row. The
    // platform test is what catches openrouter: hundreds of catalog rows share
    // one key and none of them carry key_id.
    clauses.push(`(
      key_id IN (SELECT id FROM api_keys WHERE enabled = 1)
      OR (key_id IS NULL AND platform IN (SELECT platform FROM api_keys WHERE enabled = 1))
    )`);
  }
  const where = clauses.join(' AND ');
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM models WHERE ${where}`).get(...args) as { n: number }).n;
  const models = db.prepare(`
    SELECT ${MODEL_PAGE_COLUMNS}
      FROM models
     WHERE ${where}
     ORDER BY routing_tier ASC,
              -- capability_tier 0 means "unranked": user-created endpoints and
              -- catalog rows with no intelligence_rank. Sorting them last would
              -- bury exactly the models the operator wired up themselves, so
              -- they lead their tier instead (the UI shows the tier header
              -- anyway, so this reads as "my own stuff first").
              CASE WHEN capability_tier = 0 THEN -1 ELSE capability_tier END ASC,
              platform ASC, model_id ASC
     LIMIT ? OFFSET ?
  `).all(...args, limit, offset);
  const platforms = db.prepare('SELECT DISTINCT platform FROM models ORDER BY platform').all() as { platform: string }[];
  const configuredPlatforms = db.prepare(
    'SELECT DISTINCT platform FROM api_keys WHERE enabled = 1 ORDER BY platform',
  ).all() as { platform: string }[];
  res.json({
    models,
    total,
    limit,
    offset,
    platforms: platforms.map(p => p.platform),
    configuredPlatforms: configuredPlatforms.map(p => p.platform),
  });
});

const bulkPatchSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(1000),
  patch: z.object({
    routingTier: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    priceTier: z.enum(['free', 'paid', 'unknown']).optional(),
    enabled: z.boolean().optional(),
  }).strict().refine(
    v => v.routingTier !== undefined || v.priceTier !== undefined || v.enabled !== undefined,
    { message: 'no model fields provided' },
  ),
}).strict();

/**
 * POST /api/tuning/models/bulk { ids: number[], patch: {...} }
 *
 * One transaction over the selected rows. Mirrors PATCH /api/models/:id's
 * side effects (provenance markers, chain/profile enabled state) so a bulk
 * edit is not a weaker, divergent version of the single-row edit.
 */
tuningRouter.post('/models/bulk', (req, res) => {
  const parsed = bulkPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues.map(e => e.message).join(', ') } });
    return;
  }
  const { ids, patch } = parsed.data;
  const db = getDb();
  const uniqueIds = [...new Set(ids)];
  const placeholders = uniqueIds.map(() => '?').join(',');
  const existing = db.prepare(`SELECT id FROM models WHERE id IN (${placeholders})`).all(...uniqueIds) as { id: number }[];
  const found = existing.map(r => r.id);
  if (found.length === 0) {
    res.status(404).json({ error: { message: 'no matching models' } });
    return;
  }
  const foundPlaceholders = found.map(() => '?').join(',');
  const apply = db.transaction(() => {
    if (patch.routingTier !== undefined) {
      db.prepare(`UPDATE models SET routing_tier = ?, routing_tier_source = 'manual' WHERE id IN (${foundPlaceholders})`)
        .run(patch.routingTier, ...found);
    }
    if (patch.priceTier !== undefined) {
      db.prepare(`UPDATE models SET price_tier = ?, price_note = ? WHERE id IN (${foundPlaceholders})`)
        .run(patch.priceTier, MANUAL_PRICE_NOTE, ...found);
    }
    if (patch.enabled !== undefined) {
      const on = patch.enabled ? 1 : 0;
      db.prepare(`UPDATE models SET enabled = ? WHERE id IN (${foundPlaceholders})`).run(on, ...found);
      db.prepare(`UPDATE fallback_config SET enabled = ? WHERE model_db_id IN (${foundPlaceholders})`).run(on, ...found);
      const activeProfileId = getActiveProfileId(db);
      if (activeProfileId != null) {
        db.prepare(`UPDATE profile_models SET enabled = ? WHERE profile_id = ? AND model_db_id IN (${foundPlaceholders})`)
          .run(on, activeProfileId, ...found);
      }
    }
  });
  apply();
  invalidateFilterRulesCache();
  res.json({ updated: found.length, requested: uniqueIds.length, missing: uniqueIds.length - found.length, patch });
});
