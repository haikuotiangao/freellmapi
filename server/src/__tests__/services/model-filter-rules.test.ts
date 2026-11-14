import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  applyFilterRules,
  createFilterRule,
  deleteFilterRule,
  getActiveFilterRules,
  invalidateFilterRulesCache,
  previewFilterRules,
  ruleMatches,
  updateFilterRule,
  type ModelFilterRule,
  type FilterableModel,
} from '../../services/model-filter-rules.js';

function rule(overrides: Partial<ModelFilterRule> = {}): ModelFilterRule {
  return {
    id: 1, name: 'r', action: 'exclude', platform: null, model_pattern: null,
    routing_tier: null, price_tier: null, capability_tier: null,
    enabled_state: null, enabled: 1, priority: 0, created_at: '',
    ...overrides,
  };
}

const rows: FilterableModel[] = [
  { platform: 'custom', model_id: 'gpt-4o-preview', routing_tier: 1, price_tier: 'paid', capability_tier: 1, enabled: 1 },
  { platform: 'custom', model_id: 'gpt-4o-mini', routing_tier: 2, price_tier: 'free', capability_tier: 2, enabled: 1 },
  { platform: 'groq', model_id: 'llama-3.1-8b', routing_tier: 3, price_tier: 'unknown', capability_tier: 3, enabled: 0 },
];

describe('model-filter-rules service', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM model_filter_rules').run();
    invalidateFilterRulesCache();
  });

  it('matches a bare glob against the model id, case-insensitively', () => {
    expect(ruleMatches(rule({ model_pattern: '*-preview' }), rows[0])).toBe(true);
    expect(ruleMatches(rule({ model_pattern: 'GPT-4O-*' }), rows[1])).toBe(true);
    expect(ruleMatches(rule({ model_pattern: '*-preview' }), rows[1])).toBe(false);
  });

  it('matches a qualified pattern against platform/model_id', () => {
    expect(ruleMatches(rule({ model_pattern: 'groq/llama-*' }), rows[2])).toBe(true);
    expect(ruleMatches(rule({ model_pattern: 'custom/llama-*' }), rows[2])).toBe(false);
  });

  it('ANDs every condition inside one rule', () => {
    const r = rule({ platform: 'custom', routing_tier: 1, price_tier: 'paid', enabled_state: 'enabled' });
    expect(ruleMatches(r, rows[0])).toBe(true);
    expect(ruleMatches(r, rows[1])).toBe(false);
    expect(ruleMatches(r, rows[2])).toBe(false);
  });

  it('excludes are absolute and includes become a whitelist', () => {
    const excl = rule({ id: 1, model_pattern: '*-preview' });
    const out = applyFilterRules(rows, [excl]);
    expect(out.kept.map(r => r.model_id)).toEqual(['gpt-4o-mini', 'llama-3.1-8b']);
    expect(out.dropped).toBe(1);
    expect(out.whitelistActive).toBe(false);

    const incl = rule({ id: 2, name: 'only-mini', action: 'include', model_pattern: 'gpt-4o-mini' });
    const white = applyFilterRules(rows, [excl, incl]);
    expect(white.kept.map(r => r.model_id)).toEqual(['gpt-4o-mini']);
    expect(white.whitelistActive).toBe(true);
  });

  it('an empty rule set is a no-op', () => {
    const out = applyFilterRules(rows, []);
    expect(out.kept).toEqual(rows);
    expect(out.dropped).toBe(0);
  });

  it('CRUD persists, invalidates the cache, and disabled rules are ignored', () => {
    const created = createFilterRule({ name: 'drop-preview', action: 'exclude', modelPattern: '*-preview' });
    expect(created.id).toBeGreaterThan(0);
    expect(getActiveFilterRules()).toHaveLength(1);

    updateFilterRule(created.id, { enabled: false });
    expect(getActiveFilterRules()).toHaveLength(0);
    expect(previewFilterRules().dropped).toBe(0);

    updateFilterRule(created.id, { enabled: true, action: 'include', modelPattern: 'llama-*' });
    const active = getActiveFilterRules();
    expect(active).toHaveLength(1);
    expect(active[0].action).toBe('include');
    expect(previewFilterRules().whitelistActive).toBe(true);

    expect(deleteFilterRule(created.id)).toBe(true);
    expect(deleteFilterRule(created.id)).toBe(false);
    expect(getActiveFilterRules()).toHaveLength(0);
  });

  it('preview counts hits for each rule against the whole catalog', () => {
    createFilterRule({ name: 'paid', action: 'exclude', priceTier: 'paid' });
    createFilterRule({ name: 'free', action: 'include', priceTier: 'free' });
    const p = previewFilterRules();
    expect(p.total).toBeGreaterThan(0);
    expect(p.whitelistActive).toBe(true);
    expect(p.perRule).toHaveLength(2);
    expect(p.perRule.every(r => typeof r.hits === 'number')).toBe(true);
    expect(p.remaining + p.dropped).toBe(p.total);
  });
});
