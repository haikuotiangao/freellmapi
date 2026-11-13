import type { Db } from '../db/types.js';
import { getDb } from '../db/index.js';
import { getProvider } from '../providers/index.js';
import { OpenAICompatProvider } from '../providers/openai-compat.js';
import type { Platform } from '@freellmapi/shared/types.js';
import { discoverBuiltinModels } from './builtin-model-discovery.js';
import type { DiscoveredModel } from './model-discovery.js';
import { classifyPriceTier, type PriceTier } from './cost-tier.js';
import { idLooksLikeJunk, recomputeCapabilityTiers } from './capability-tier.js';
import { ensureModelInProfiles } from './profile-models.js';

// ── Operator-triggered catalog refresh ──────────────────────────────────────
//
// The signed catalog only carries models its authors chose to list. A relay that
// added a model yesterday, or one that quietly moved a `:free` model onto a paid
// plan, is invisible until that catalog is regenerated — which a free install
// cannot do. Every OpenAI-compatible provider, however, answers `GET /models`
// with exactly what the key can reach right now.
//
// Upstream already has that plumbing (#1348: builtin-model-discovery, and the
// proxy handling in discoverBuiltinModels), but only for an allowlist of
// platforms and only on a schedule. This exposes it as one button over every
// configured platform, and adds the two things the fork cares about: price
// verdicts on what comes back, and the ability tier it lands in.
//
// What this deliberately does NOT do: delete rows. A model missing from the
// upstream listing is reported, not removed — a provider whose /models is
// paginated or transiently broken would otherwise wipe the chain.

export interface RefreshPlatformResult {
  platform: string;
  /** False when the platform was skipped or the call failed; see `reason`. */
  ok: boolean;
  /** Why the platform was skipped or failed. `undefined` when ok. */
  reason?: string;
  /** Models the upstream serves that the local catalog did not have. */
  added: number;
  /** Of those added, how many were kept disabled (paid or junk). */
  addedDisabled: number;
  /** Local rows the upstream no longer advertises. Reported, never deleted. */
  missing: number;
  /** Rows whose price tier changed as a result of this refresh. */
  retiered: number;
  /** Total models the upstream returned. */
  upstreamCount: number;
  /** Upstream models newly classified as paid (the interesting number). */
  paidNow: number;
}

export interface RefreshReport {
  startedAt: string;
  finishedAt: string;
  platforms: RefreshPlatformResult[];
  totals: {
    platformsQueried: number;
    platformsFailed: number;
    added: number;
    missing: number;
    retiered: number;
    paidNow: number;
  };
  /** Capability tiers were recomputed after the merge, so new rows sort sanely. */
  capabilityTiersRecomputed: boolean;
}

interface KeyRow {
  id: number;
  platform: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  proxy_encrypted?: string | null;
  proxy_iv?: string | null;
  proxy_auth_tag?: string | null;
}

interface ExistingRow {
  id: number;
  model_id: string;
  price_tier: string;
}

/** Same ordering the built-in discovery uses: healthy keys first, never invalid. */
function usableKeys(db: Db, platform: string): KeyRow[] {
  return db.prepare(`
    SELECT id, platform, encrypted_key, iv, auth_tag, proxy_encrypted, proxy_iv, proxy_auth_tag
      FROM api_keys
     WHERE platform = ? AND enabled = 1 AND status != 'invalid'
     ORDER BY CASE status WHEN 'healthy' THEN 0 ELSE 1 END, id
  `).all(platform) as KeyRow[];
}

/**
 * Merge one platform's upstream listing into the local `models` table.
 *
 * Existing rows only have their price columns touched — display name, ranks,
 * enable flag and per-model overrides all belong to the catalog or the
 * operator, and a refresh must not silently reshuffle a hand-tuned chain.
 */
function mergePlatform(
  db: Db,
  platform: string,
  upstream: DiscoveredModel[],
): Omit<RefreshPlatformResult, 'platform' | 'ok'> {
  const existing = db.prepare('SELECT id, model_id, price_tier FROM models WHERE platform = ? AND endpoint_scope = \'\'')
    .all(platform) as ExistingRow[];
  const byId = new Map(existing.map(r => [r.model_id, r]));

  const insert = db.prepare(`
    INSERT INTO models
      (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
       rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
       enabled, key_id, supports_tools, supports_vision, source, endpoint_scope,
       price_tier, price_note, capability_tier)
    VALUES (@platform, @modelId, @modelId, 9999, 9999, 'Unknown',
       NULL, NULL, NULL, NULL, '', @contextWindow,
       @enabled, NULL, 0, @supportsVision, 'discovered', '',
       @priceTier, @priceNote, @capabilityTier)
    ON CONFLICT(platform, model_id, endpoint_scope) DO NOTHING
  `);
  const selectId = db.prepare("SELECT id FROM models WHERE platform = ? AND model_id = ? AND endpoint_scope = ''");
  const retier = db.prepare('UPDATE models SET price_tier = ?, price_note = ? WHERE id = ?');

  let added = 0;
  let addedDisabled = 0;
  let retiered = 0;
  let paidNow = 0;
  const seen = new Set<string>();

  db.transaction(() => {
    for (const model of upstream) {
      // `kind` is only set when the upstream model is discernibly NOT a chat
      // model, so its presence means "don't put this in the router's pool".
      if (model.kind) continue;
      seen.add(model.id);

      const tier: PriceTier = classifyPriceTier(model.id, {
        isFree: model.isFree,
        priceNote: model.priceNote,
      });
      const note = model.priceNote ?? null;
      const current = byId.get(model.id);

      if (current) {
        if (current.price_tier !== tier) {
          retier.run(tier, note, current.id);
          retiered++;
          if (tier === 'paid') paidNow++;
        }
        continue;
      }

      const junk = idLooksLikeJunk(model.id);
      const enabled = tier === 'paid' || junk ? 0 : 1;
      const info = insert.run({
        platform,
        modelId: model.id,
        contextWindow: model.contextWindow ?? null,
        enabled,
        supportsVision: model.vision ? 1 : 0,
        priceTier: tier,
        priceNote: note,
        capabilityTier: junk ? 4 : 0,
      });
      if (info.changes > 0) {
        added++;
        if (enabled === 0) addedDisabled++;
        if (tier === 'paid') paidNow++;
        // A model that is in no profile can never be routed, so a refresh that
        // only inserts rows would look like it did nothing on the dashboard.
        // Enable-flagged rows get a profile entry; the disabled ones wait.
        const row = selectId.get(platform, model.id) as { id: number } | undefined;
        if (row && enabled === 1) ensureModelInProfiles(db, row.id);
      }
    }
  })();

  const missing = existing.filter(r => !seen.has(r.model_id)).length;
  return { added, addedDisabled, missing, retiered, upstreamCount: upstream.length, paidNow };
}

export interface RefreshOptions {
  /** Limit the refresh to these platforms. Omit for every configured one. */
  platforms?: string[];
  /** Recompute capability tiers after the merge (default true). */
  recomputeTiers?: boolean;
}

/**
 * Ask every configured OpenAI-compatible provider what it serves, merge the
 * answer, and recompute capability tiers.
 *
 * Runs sequentially on purpose: a burst of parallel `/models` calls from one
 * account is the fastest way to trip a provider's own rate limiter, and the
 * per-platform numbers here are what the operator reads afterwards.
 */
export async function refreshProviderModels(
  db: Db = getDb(),
  options: RefreshOptions = {},
): Promise<RefreshReport> {
  const startedAt = new Date().toISOString();

  const configured = db.prepare(`
    SELECT DISTINCT platform FROM api_keys
     WHERE enabled = 1 AND status != 'invalid'
     ORDER BY platform
  `).all() as { platform: string }[];

  const wanted = options.platforms?.length
    ? configured.filter(p => options.platforms!.includes(p.platform))
    : configured;

  const platforms: RefreshPlatformResult[] = [];
  let tiersTouched = false;

  for (const { platform } of wanted) {
    const keys = usableKeys(db, platform);
    if (keys.length === 0) {
      platforms.push({
        platform, ok: false, reason: 'no usable key',
        added: 0, addedDisabled: 0, missing: 0, retiered: 0, upstreamCount: 0, paidNow: 0,
      });
      continue;
    }

    // Only OpenAI-compatible adapters expose /models. Google, Cohere, the media
    // adapters and the search/decision integrations all fall outside this and
    // are reported as skipped rather than guessed at.
    const provider = getProvider(platform as Platform);
    if (!(provider instanceof OpenAICompatProvider)) {
      platforms.push({
        platform, ok: false, reason: 'adapter has no /models endpoint',
        added: 0, addedDisabled: 0, missing: 0, retiered: 0, upstreamCount: 0, paidNow: 0,
      });
      continue;
    }

    let lastError: string | undefined;
    let merged: Omit<RefreshPlatformResult, 'platform' | 'ok'> | null = null;
    for (const key of keys) {
      try {
        const upstream = await discoverBuiltinModels(provider, key);
        merged = mergePlatform(db, platform, upstream);
        break;
      } catch (err) {
        // Try the next key: one expired credential should not fail the platform.
        lastError = (err as Error)?.message ?? 'refresh failed';
      }
    }

    if (!merged) {
      platforms.push({
        platform, ok: false, reason: lastError ?? 'refresh failed',
        added: 0, addedDisabled: 0, missing: 0, retiered: 0, upstreamCount: 0, paidNow: 0,
      });
      continue;
    }
    platforms.push({ platform, ok: true, ...merged });
    tiersTouched = tiersTouched || merged.added > 0;
  }

  const recompute = options.recomputeTiers !== false && tiersTouched;
  if (recompute) recomputeCapabilityTiers(db);

  const sum = (pick: (r: RefreshPlatformResult) => number) => platforms.reduce((acc, r) => acc + pick(r), 0);

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    platforms,
    totals: {
      platformsQueried: platforms.length,
      platformsFailed: platforms.filter(p => !p.ok).length,
      added: sum(r => r.added),
      missing: sum(r => r.missing),
      retiered: sum(r => r.retiered),
      paidNow: sum(r => r.paidNow),
    },
    capabilityTiersRecomputed: recompute,
  };
}
