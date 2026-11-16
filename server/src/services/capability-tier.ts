import type { Db } from '../db/types.js';
import { getDb } from '../db/index.js';

// ── Capability tiering ──────────────────────────────────────────────────────
//
// The catalog already carries `intelligence_rank` (lower = smarter) and
// `size_label` ('Frontier' / 'Large' / 'Medium' / 'Small'). Neither is usable as
// a hard filter: the ranks are dense (1..N across 493 models, so rank 41 is
// "quite good" but looks far from rank 2), and `size_label` describes parameter
// count, not ability — a 30B model with reasoning training routinely beats a
// 120B one without.
//
// So this derives a coarse 4-level tier ONCE per model and stores it. The point
// is not to be clever: it is to let "disable the junk" and "sort by ability" be
// single operations the operator can run and then override, rather than 493
// judgement calls.
//
// Boundaries come from the catalog's own rank distribution and were checked
// against the model ids actually present (see the tests). Tier 0 means
// "unranked" — every user-created row, and any catalog row whose rank is
// missing — and is deliberately NEVER auto-disabled.

export type CapabilityTier = 1 | 2 | 3 | 4;

/** Rank cut-offs: `intelligence_rank <= N` places a model in that tier. */
export const TIER_RANK_CUTOFFS: ReadonlyArray<{ tier: CapabilityTier; maxRank: number }> = [
  { tier: 1, maxRank: 20 },
  { tier: 2, maxRank: 60 },
  { tier: 3, maxRank: 150 },
];
/** Anything ranked worse than the last cut-off is tier 4 (junk / toy). */
export const JUNK_TIER: CapabilityTier = 4;

export const TIER_LABELS: Record<CapabilityTier, string> = {
  1: 'frontier',
  2: 'strong',
  3: 'supplemental',
  4: 'junk',
};

/** Derive a tier from a catalog intelligence rank (lower rank = smarter). */
export function tierFromRank(rank: number | null | undefined): 0 | CapabilityTier {
  if (rank == null || !Number.isFinite(rank) || rank <= 0) return 0;
  for (const cut of TIER_RANK_CUTOFFS) {
    if (rank <= cut.maxRank) return cut.tier;
  }
  return JUNK_TIER;
}

/**
 * Model-id patterns that mark a model as junk regardless of its catalog rank.
 *
 * These are families that exist to demo a pipeline, not to answer questions:
 * sub-1B toys, embedding/rerankers exposed on a chat endpoint, and a handful of
 * clearly-labelled previews. Matching is on the lowercased id, substring, so
 * `meta-llama/llama-3.2-1b-instruct` and `llama3.2-1b` both hit.
 *
 * Deliberately conservative: a false positive silently removes a usable model
 * from the pool, and the operator cannot tell why. Anything merely "small but
 * good" (Gemma 4 26B/31B, Qwen3-27B, Nemotron Nano) is NOT listed here — the
 * rank cut-off already puts those in tier 3 where they belong.
 */
export const JUNK_ID_PATTERNS: readonly string[] = [
  // Sub-1B demonstration models.
  '-0.5b', '-360m', '-135m', '-0.3b', '-1b', '-1.1b', '-1.5b', '-2b', '-2.6b',
  'tinyllama', 'smollm', 'qwen2.5-0.5b', 'phi-2',
  // Non-generative or retrieval models on a chat surface.
  'embed', 'rerank', 'bge-', 'e5-', 'gte-',
  // Guardrail / moderation endpoints, not chat models.
  'guard', 'moderation', 'safety-',
  // Image/audio models that sometimes leak into chat listings.
  'stable-diffusion', 'flux-', 'whisper', 'tts-', 'voice-',
];

/** True when the id looks like a toy/non-chat model. */
export function idLooksLikeJunk(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return JUNK_ID_PATTERNS.some(p => lower.includes(p));
}

/**
 * Recompute `capability_tier` for every row.
 *
 * Id patterns win over the catalog rank because the rank was assigned by
 * whatever generated the catalog and is not a quality judgement for these
 * families at all.
 *
 * User-created rows (`source = 'user'`, i.e. endpoints the operator registered
 * themselves) ARE ranked now. They used to be forced to tier 0, which had two
 * bad consequences: the auto-assign pass maps 1 → routing tier 1 and
 * everything else → "other", so a catalog of self-registered endpoints could
 * never populate the first string at all (0 models in tier 1, forever), while
 * the best-ranked models in the whole database — the ones the operator
 * deliberately wired up — sank to "other". Ranking them is what makes
 * "my own endpoints come first" true instead of aspirational.
 *
 * `disableJunkModels()` still excludes `source = 'user'`, so ranking a
 * self-registered endpoint as tier 4 can never get it switched off behind the
 * operator's back. The junk id patterns are also skipped for those rows: an
 * operator who registered `something-1b` wants that model, not a lecture.
 */
export function recomputeCapabilityTiers(db: Db = getDb()): Record<string, number> {
  const rows = db.prepare(`
    SELECT id, model_id, intelligence_rank, source FROM models
  `).all() as { id: number; model_id: string; intelligence_rank: number | null; source: string | null }[];

  const update = db.prepare('UPDATE models SET capability_tier = ? WHERE id = ?');
  const counts: Record<string, number> = { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0 };

  db.transaction(() => {
    for (const row of rows) {
      let tier: number;
      if (row.source === 'user') {
        // Rank it like anything else, but never drag it to junk: the operator
        // put it there on purpose.
        const ranked = tierFromRank(row.intelligence_rank);
        tier = ranked === JUNK_TIER ? 0 : ranked;
      } else if (idLooksLikeJunk(row.model_id)) {
        tier = JUNK_TIER;
      } else {
        tier = tierFromRank(row.intelligence_rank);
      }
      update.run(tier, row.id);
      counts[String(tier)] = (counts[String(tier)] ?? 0) + 1;
    }
  })();

  return counts;
}

/** Ordered tier summary for the dashboard. */
export function capabilitySummary(db: Db = getDb()): { tier: number; count: number }[] {
  return db.prepare(`
    SELECT capability_tier AS tier, COUNT(*) AS count
      FROM models GROUP BY capability_tier ORDER BY capability_tier
  `).all() as { tier: number; count: number }[];
}

/**
 * Disable every junk-tier model that is still enabled.
 *
 * Writes `enabled = 0` and NOTHING else — no override blob, no tombstone — so
 * re-enabling a model is a plain toggle and a later catalog apply can bring one
 * back if its rank improves (see the enabled-recompute in catalog-sync).
 * Returns the number of rows changed.
 */
export function disableJunkModels(db: Db = getDb()): number {
  const info = db.prepare(`
    UPDATE models SET enabled = 0
     WHERE capability_tier = ? AND enabled = 1
       AND COALESCE(source, 'catalog') != 'user'
  `).run(JUNK_TIER);
  return info.changes;
}

/**
 * Re-seed `fallback_config.priority` for the whole enabled catalog, ordered by
 * capability tier then catalog rank.
 *
 * This is the "sort by ability" button. It rewrites the manual chain order —
 * which is the only ordering that matters under the Manual strategy — into
 * "best ability first, platform diversity as a tiebreaker". It touches
 * `priority` only: enable flags, profiles' own orders and per-model overrides
 * are left alone.
 *
 * Returns the number of rows whose priority actually changed.
 */
export function resortChainByCapability(db: Db = getDb()): number {
  const rows = db.prepare(`
    SELECT m.id, m.platform, m.intelligence_rank, m.capability_tier,
           COALESCE(fc.priority, 0) AS old_priority
      FROM models m
      LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
     WHERE m.enabled = 1
     ORDER BY
       CASE WHEN m.capability_tier > 0 THEN m.capability_tier ELSE 1 END ASC,
       COALESCE(m.intelligence_rank, 9999) ASC,
       m.platform ASC,
       m.id ASC
  `).all() as { id: number; platform: string; intelligence_rank: number | null; capability_tier: number; old_priority: number }[];

  const upsert = db.prepare(`
    INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)
    ON CONFLICT(model_db_id) DO UPDATE SET priority = excluded.priority
  `);

  let changed = 0;
  db.transaction(() => {
    rows.forEach((row, index) => {
      const next = index + 1;
      upsert.run(row.id, next);
      if (row.old_priority !== next) changed++;
    });
  })();
  return changed;
}