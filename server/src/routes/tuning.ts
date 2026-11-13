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
  });
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
    const body = (req.body ?? {}) as { platforms?: string[]; recomputeTiers?: boolean };
    const platforms = Array.isArray(body.platforms)
      ? body.platforms.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : undefined;
    const report = await refreshProviderModels(getDb(), {
      platforms: platforms?.length ? platforms : undefined,
      recomputeTiers: body.recomputeTiers !== false,
    });
    res.json(report);
  } catch (err) {
    next(err);
  }
});
