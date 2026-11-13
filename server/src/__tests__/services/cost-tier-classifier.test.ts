import { describe, it, expect } from 'vitest';
import { classifyPriceTier, idSuggestsFree, idSuggestsPaid } from '../../services/cost-tier.js';
import { tierFromRank, idLooksLikeJunk, JUNK_TIER } from '../../services/capability-tier.js';

// Pure classifier tests. The DB-backed passes (reclassifyCatalogModelTiers,
// recomputeCapabilityTiers, resortChainByCapability) are exercised through the
// migration and route tests; what matters here is the decision table itself,
// because a wrong verdict silently removes a model from the routing pool.

describe('classifyPriceTier', () => {
  it('trusts an explicit paid id marker above everything else', () => {
    expect(classifyPriceTier('vendor/model:paid', { isFree: true })).toBe('paid');
  });

  it('treats a non-zero published price as proof of paid', () => {
    expect(classifyPriceTier('vendor/model', { isFree: false })).toBe('paid');
  });

  it('treats a zero published price as proof of free', () => {
    expect(classifyPriceTier('vendor/model', { isFree: true })).toBe('free');
  });

  it("reads OpenRouter's :free convention", () => {
    expect(idSuggestsFree('deepseek/deepseek-chat-v3:free')).toBe(true);
    expect(classifyPriceTier('deepseek/deepseek-chat-v3:free')).toBe('free');
  });

  it('never guesses paid from a missing :free suffix', () => {
    // The whole bundled catalog looks like this. Calling it paid would disable
    // ~480 of 493 models on the next sync.
    expect(classifyPriceTier('meta-llama/llama-3.3-70b-instruct')).toBe('unknown');
    expect(idSuggestsPaid('meta-llama/llama-3.3-70b-instruct')).toBe(false);
  });
});

describe('tierFromRank', () => {
  it('maps catalog ranks onto the four ability tiers', () => {
    expect(tierFromRank(1)).toBe(1);
    expect(tierFromRank(20)).toBe(1);
    expect(tierFromRank(21)).toBe(2);
    expect(tierFromRank(60)).toBe(2);
    expect(tierFromRank(61)).toBe(3);
    expect(tierFromRank(150)).toBe(3);
    expect(tierFromRank(151)).toBe(JUNK_TIER);
  });

  it('leaves unranked rows at 0 so they are never auto-disabled', () => {
    expect(tierFromRank(null)).toBe(0);
    expect(tierFromRank(undefined)).toBe(0);
    expect(tierFromRank(0)).toBe(0);
    expect(tierFromRank(Number.NaN)).toBe(0);
  });
});

describe('idLooksLikeJunk', () => {
  it('matches sub-2B toys, embedders and non-chat endpoints', () => {
    expect(idLooksLikeJunk('meta-llama/llama-3.2-1b-instruct')).toBe(true);
    expect(idLooksLikeJunk('nomic-embed-text')).toBe(true);
    expect(idLooksLikeJunk('bge-reranker-v2')).toBe(true);
    expect(idLooksLikeJunk('whisper-large-v3')).toBe(true);
  });

  it('does not touch small-but-capable models', () => {
    expect(idLooksLikeJunk('gemma-4-26b-it')).toBe(false);
    expect(idLooksLikeJunk('qwen3-27b-instruct')).toBe(false);
    expect(idLooksLikeJunk('deepseek-v3.2')).toBe(false);
  });
});
