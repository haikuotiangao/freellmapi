import type { Db } from '../db/types.js';
import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { getProvider } from '../providers/index.js';
import type { Platform } from '@freellmapi/shared/types.js';
import { discoverEndpointModels, type DiscoveredModel } from './model-discovery.js';
import { classifyPriceTier, type PriceTier } from './cost-tier.js';
import { idLooksLikeJunk, recomputeCapabilityTiers } from './capability-tier.js';

// ── Operator-triggered catalog refresh ──────────────────────────────────────
//
// The signed catalog only carries models the *catalog authors* chose to list.
// A relay that added a model yesterday, or one that quietly moved a `:free`
// model onto a paid plan, is invisible until someone regenerates that catalog —
// which the fork cannot do. But every OpenAI-compatible provider answers
// `GET <base>/models` with exactly what the key can reach right now, so the
// operator can refresh from the horse's mouth.
//
// What this deliberately does NOT do: delete rows. A model missing from the
// upstream listing is reported, not removed — a provider whose `/models` is
// paginated or transiently broken would otherwise wipe the chain. Missing rows
// keep their enabled flag and simply stop being routable once `enabled` is
// turned off by the operator (or by the junk pass).

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
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  base_url: string | null;
}

interface ExistingRow {
  id: number;
  model_id: string;
  price_tier: string;
}

/** First usable credential for a platform, decrypted. null when none works. */
function firstCredential(db: Db, platform: string): { key: string; baseUrl: string | null } | null {
  const rows = db.prepare(`
    SELECT id, encrypted_key, iv, auth_tag, base_url FROM api_keys
     WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown')
     ORDER BY id ASC LIMIT 5
  `).all(platform) as KeyRow[];
  for (const row of rows) {
    try {
      return {
        key: decrypt(row.encrypted_key, row.iv, row.auth_tag),
        baseUrl: row.base_url?.trim().replace(/\/+$/, '') || null,
      };
    } catch {
      // Undecryptable row (rotated key, corrupted blob): try the next one.
      continue;
    }
  }
  return null;
}

/** The `<base>/models` URL to probe for a platform, or null when it has none. */
function resolveCatalogBaseUrl(platform: string, credentialBaseUrl: string | null): string | null {
  if (credentialBaseUrl) return credentialBaseUrl;
  const provider = getProvider(platform as Platform);
  return provider?.catalogBaseUrl ?? null;
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
  const existing = db.prepare('SELECT id, model_id, price_tier FROM models WHERE platform = ?')
    .all(platform) as ExistingRow[];
  const byId = new Map(existing.map(r => [r.model_id, r]));

  const insert = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                        rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
                        enabled, supports_vision, supports_tools, source, price_tier, price_note)
    VALUES (@platform, @modelId, @displayName, 9999, 9999, 'Unknown',
            NULL, NULL, NULL, NULL, '', @contextWindow,
            @enabled, @supportsVision, 0, 'catalog', @priceTier, @priceNote)
    ON CONFLICT(platform, model_id) DO NOTHING
  `);
  const retier = db.prepare('UPDATE models SET price_tier = ?, price_note = ? WHERE id = ?');

  let added = 0;
  let addedDisabled = 0;
  let retiered = 0;
  let paidNow = 0;
  const seen = new Set<string>();

  db.transaction(() => {
    for (const model of upstream) {
      // `kind` is only ever set when the upstream model is discernibly NOT a
      // chat model, so its presence means "don't put this in the router's pool".
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
        displayName: model.id,
        contextWindow: model.contextWindow ?? null,
        enabled,
        supportsVision: model.vision ? 1 : 0,
        priceTier: tier,
        priceNote: note,
      });
      if (info.changes > 0) {
        added++;
        if (enabled === 0) addedDisabled++;
        if (tier === 'paid') paidNow++;
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
     WHERE enabled = 1 AND status IN ('healthy', 'unknown')
     ORDER BY platform
  `).all() as { platform: string }[];

  const wanted = options.platforms?.length
    ? configured.filter(p => options.platforms!.includes(p.platform))
    : configured;

  const platforms: RefreshPlatformResult[] = [];
  let tiersTouched = false;

  for (const { platform } of wanted) {
    const credential = firstCredential(db, platform);
    if (!credential) {
      platforms.push({
        platform, ok: false, reason: 'no usable key',
        added: 0, addedDisabled: 0, missing: 0, retiered: 0, upstreamCount: 0, paidNow: 0,
      });
      continue;
    }

    const baseUrl = resolveCatalogBaseUrl(platform, credential.baseUrl);
    if (!baseUrl) {
      platforms.push({
        platform, ok: false, reason: 'provider exposes no /models endpoint',
        added: 0, addedDisabled: 0, missing: 0, retiered: 0, upstreamCount: 0, paidNow: 0,
      });
      continue;
    }

    try {
      const upstream = await discoverEndpointModels(baseUrl, credential.key);
      const merged = mergePlatform(db, platform, upstream);
      platforms.push({ platform, ok: true, ...merged });
      tiersTouched = tiersTouched || merged.added > 0;
    } catch (err) {
      platforms.push({
        platform, ok: false,
        reason: (err as Error)?.message ?? 'refresh failed',
        added: 0, addedDisabled: 0, missing: 0, retiered: 0, upstreamCount: 0, paidNow: 0,
      });
    }
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
