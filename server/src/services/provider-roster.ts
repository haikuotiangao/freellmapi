import type { Db } from '../db/types.js';
import { getDb } from '../db/index.js';
import { getAllProviders } from '../providers/index.js';
import { getProviderLimits, listProviderLimits } from './provider-limits.js';

// ── Full provider limit roster ──────────────────────────────────────────────
//
// `provider_limits` (services/provider-limits.ts) only seeds providers whose
// published free-tier ceilings are BOTH documented AND load-bearing for
// routing. The operator asked for the complete picture: every provider the app
// can hold a key for, what is known about its limits (quota shape, reset
// window, verification gates), and a single place to set the values the
// router enforces.
//
// Quota facts below are quoted from the provider labels the Keys page already
// shows (client/src/components/keys/shared.tsx) and the provider registration
// notes (server/src/providers/index.ts) — the same provenance the seeds carry.
// Where a provider publishes nothing, the row says so instead of inventing a
// number; the catalog's per-model columns remain the source for those.

export interface ProviderLimitRosterRow {
  platform: string;
  /** Human provider name from the provider registration. */
  name: string;
  /** True when this platform serves web search / decisions only. */
  kind: 'chat' | 'search';
  /** No API key needed (Kilo, OVH, AI Horde…). */
  keyless: boolean;
  /** The live, editable profile; null columns = "nothing enforced". */
  limits: {
    rpm: number | null;
    rpd: number | null;
    tpm: number | null;
    tpd: number | null;
    maxConcurrency: number | null;
    scope: 'model' | 'account';
  };
  /** Provenance / caveats from the seeded profile, when one exists. */
  notes: string | null;
  /** Quota shape quoted from the provider's own documentation. */
  quotaFacts: string | null;
  /** Whether an editable profile row exists in provider_limits. */
  configured: boolean;
}

/**
 * Quota facts per platform, phrased for the operator table. `null` = nothing
 * published or nothing beyond the per-model catalog columns. Search-only and
 * decision-only adapters are included so the table is exhaustive.
 */
const QUOTA_FACTS: Record<string, string> = {
  aclide: 'Shared monthly credit pool across all routes (hidden provider; existing keys keep working).',
  speka: 'One shared $1 monthly allowance across chat and embeddings.',
  kenari: 'Named free chat/image routes share one renewable daily account allowance.',
  kiosapi: 'Shared daily free chat quota.',
  beatapi: 'Decision-only JEV adapter; temporary free offer, catalog-managed availability.',
  halx: 'Keyless decision endpoint; no published numeric quota.',
  aisense: 'Keyless decision endpoint; no published numeric quota.',
  apinex: 'Free-category chat and decisions share one weighted daily allowance; daily check-in required (the app surfaces the check-in banner).',
  onomeo: 'Free tier is 30 calls per 5 hours, account-wide, on top of a site-wide pool.',
  iteracompute: '30M free tokens per month, account-wide (resets monthly).',
  typhoon: 'Free research API; fair-use, no published numeric quota.',
  plugsky: 'Permanent free chat aliases; shared fair-use quota.',
  inferbase: 'Shared monthly AND daily allowance across the catalog.',
  simplellm: 'Shared hourly and daily free quota.',
  llmtr: 'Per-model daily free quotas; a disabled model re-enables once its daily window resets.',
  gizmo: 'Monthly free-model request quota, shared.',
  blockrun: 'Zero-priced models only; effectively unmetered per request.',
  moondream: '$5 shared monthly credits across vision routes.',
  jamai: 'Monthly ELLM allowance.',
  nabh: '50 shared monthly credits.',
  zro: 'Shared daily free usage (not cash credit).',
  novai: 'Daily free chat + video quota.',
  varosity: 'One-time $1.50 starter credit; no recurring free tier.',
  rime: 'Shared monthly TTS/transcription credits.',
  freetts: 'Personal-use TTS; shared monthly characters, watermarked audio.',
  freeinference: 'Research API; chat and embeddings share a daily quota, requests are logged.',
  freemodel: 'Monthly allowance; requires Telegram verification.',
  google: 'AI Studio free tier: per-model RPM/RPD published on the model card; the catalog carries the numbers.',
  groq: 'Per-model RPM/RPD/TPM/TPD published per model; the catalog rows carry them.',
  cerebras: 'Per-model rate limits published in their docs; catalog rows carry them.',
  sail: '$5 in free credits refreshes monthly with a payment method attached; beyond that pay-as-you-go.',
  electronhub: 'Shared weekly credit renewal across models.',
  experiential: 'Shared monthly credit renewal across models.',
  router9: 'Shared monthly credits.',
  septor: 'Daily free-model quota.',
  clod: 'Shared daily free requests.',
  speechify: 'Monthly free TTS characters.',
  freeai: 'Shared free speech/transcription quota.',
  blaze: 'Daily free token allowance; Discord verification required.',
  lucidity: 'Daily free-model requests.',
  airforce: 'Daily free requests, roughly 1 per minute.',
  dreamprompting: 'Rolling 24h free token and request windows.',
  waterfall: 'Community-provided free models (hidden provider).',
  logfare: 'Fair-use free models; no published numeric quota.',
  bai: 'Limited-time 0-credit promo model; commercial eligibility lives in the hosted catalog.',
  radeon: '20 RPM gateway + 30 RPM per key, 8 concurrent requests; long reasoning runs up to 10 minutes.',
  nvidia: '~40 RPM metered PER MODEL id (distinct models do not contend); catalog also carries per-model numbers.',
  mistral: 'Free tier: 1 request/second, 500k tokens/minute, 1B tokens/month (account-wide).',
  openrouter: ':free models: 20 RPM; 50 requests/day under $10 lifetime credit, 1000/day at >=$10 — the RPD pool is shared by ALL :free models on the key.',
  cohere: 'Trial keys: 20 RPM / 1k calls per month per model (shared trial pool).',
  cloudflare: 'Workers AI free allocation is 10k Neurons/day (account-wide), not tokens; tpd here is a proxy.',
  zhipu: 'Z.ai free glm-4.5-flash: no published RPM; concurrency-limited.',
  ollama: 'Cloud tier rate limits follow the plan; free tier is fair-use.',
  kilo: 'Keyless; server-side fair-use limits.',
  pollinations: 'Anonymous tier is aggressively throttled (1 concurrent request); token tier is higher.',
  ovh: 'Keyless endpoints; per-endpoint fair-use throttling.',
  llm7: 'Anonymous tier heavily rate-limited; free token via their site raises it.',
  huggingface: 'Router free tier has monthly credit + per-request throttles (published in their docs).',
  opencode: 'Paid models only; no free quota.',
  agnes: 'Free text tier: 10 RPM after the 2026-09 downgrade.',
  reka: 'Prepaid credits only; no free tier.',
  siliconflow: 'Image + TTS; free tier quotas published per model.',
  routeway: 'Free key; fair-use, no published numeric quota.',
  bazaarlink: 'Free key; fair-use, no published numeric quota.',
  ainative: 'Free key; fair-use, no published numeric quota.',
  aion: 'Free key; fair-use, no published numeric quota.',
  requesty: 'Free key; fair-use, no published numeric quota.',
  navy: 'Free key; account-wide RPM gate enforced upstream.',
  nara: 'Free key; fair-use, no published numeric quota.',
  sealion: 'Free key; fair-use, no published numeric quota.',
  orcarouter: 'Free key; fair-use, no published numeric quota.',
  unorouter: 'Free key; fair-use, no published numeric quota.',
  xkiro: 'Free key; fair-use, no published numeric quota.',
  anyapi: 'Advertises 100K tokens/day free, but live testing could not get a single free request served — no quota asserted.',
  powertokens: 'glm-4.7-flash is $0/1M in+out; RPM/RPD/TPD unpublished.',
  modelscope: '"Magic credit" pool: ~250 credits/day ≈ 125 requests, shared by all models.',
  aihorde: 'Community cluster; priority-based, slow, effectively kudos-budgeted.',
  qianfan: 'Free ERNIE routes; requires cn real-name verification.',
  volcengine: 'Free daily quota per model; requires cn real-name verification.',
  longcat: 'Free daily quota; overseas email signup works.',
  xfyun: 'Spark Lite free; requires cn real-name verification.',
  custom: 'Your own relay — set whatever the upstream actually enforces.',
};

/** Adapters that only ever answer search/decisions (no chat chain role). */
const SEARCH_ONLY = new Set(['tavily', 'exa', 'firecrawl', 'linkup', 'parallel', 'serpsearch', 'brave', 'outcrawl', 'halx', 'aisense']);

export function providerLimitRoster(db: Db = getDb()): ProviderLimitRosterRow[] {
  const configured = new Map(listProviderLimits(db).map(r => [r.platform, r]));
  const rows: ProviderLimitRosterRow[] = [];
  const seen = new Set<string>();

  for (const provider of getAllProviders()) {
    if (provider.platform === 'custom') continue; // handled below, per-endpoint note
    seen.add(provider.platform);
    const profile = configured.get(provider.platform) ?? null;
    rows.push({
      platform: provider.platform,
      name: provider.name,
      kind: SEARCH_ONLY.has(provider.platform) ? 'search' : 'chat',
      keyless: provider.keyless === true,
      limits: profile
        ? {
            rpm: profile.rpm, rpd: profile.rpd, tpm: profile.tpm,
            tpd: profile.tpd, maxConcurrency: profile.maxConcurrency, scope: profile.scope,
          }
        : { rpm: null, rpd: null, tpm: null, tpd: null, maxConcurrency: null, scope: 'account' },
      notes: profile?.notes ?? null,
      quotaFacts: QUOTA_FACTS[provider.platform] ?? null,
      configured: profile != null,
    });
  }

  // Custom endpoints are operator-defined; still list the bucket so the table
  // has a row for "my own relay" with its editable fields.
  if (!seen.has('custom') && configured.has('custom')) {
    const profile = configured.get('custom')!;
    rows.push({
      platform: 'custom',
      name: 'Custom (OpenAI-compatible)',
      kind: 'chat',
      keyless: false,
      limits: {
        rpm: profile.rpm, rpd: profile.rpd, tpm: profile.tpm,
        tpd: profile.tpd, maxConcurrency: profile.maxConcurrency, scope: profile.scope,
      },
      notes: profile.notes,
      quotaFacts: QUOTA_FACTS.custom!,
      configured: true,
    });
  }

  rows.sort((a, b) => {
    // Configured (enforced) profiles first, then alphabetical by provider name.
    if (a.configured !== b.configured) return a.configured ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return rows;
}

/** Convenience wrapper so routes can 404 on an unknown platform. */
export function rosterEntryFor(platform: string, db: Db = getDb()): ProviderLimitRosterRow | undefined {
  return providerLimitRoster(db).find(r => r.platform === platform);
}

/** Re-exported for the route's PUT handler. */
export { getProviderLimits };
