import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb, getSetting, setSetting } from '../../db/index.js';
import {
  TIER_ROUTING_ENABLED_KEY,
  TIER1_ROUNDS_KEY,
  DEFAULT_TIER1_ROUNDS,
  MAX_TIER1_ROUNDS,
  isTierRoutingEnabled,
  setTierRoutingEnabled,
  getTier1Rounds,
  setTier1Rounds,
  buildTierWalkOrder,
  partitionByRoutingTier,
  assignRoutingTiersByAbility,
  setModelRoutingTier,
  routingTierSummary,
  ensureDefaultRoutingTiers,
} from '../../services/tier-routing.js';
import { recomputeCapabilityTiers } from '../../services/capability-tier.js';

interface Row { id: number; routing_tier: number }
const row = (id: number, routing_tier: number): Row => ({ id, routing_tier });

describe('tier-routing settings', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    setSetting(TIER_ROUTING_ENABLED_KEY, '1');
    setSetting(TIER1_ROUNDS_KEY, String(DEFAULT_TIER1_ROUNDS));
  });

  it('defaults to enabled with 2 rounds', () => {
    expect(isTierRoutingEnabled()).toBe(true);
    expect(getTier1Rounds()).toBe(DEFAULT_TIER1_ROUNDS);
  });

  it('persists the enable switch', () => {
    setTierRoutingEnabled(false);
    expect(getSetting(TIER_ROUTING_ENABLED_KEY)).toBe('0');
    expect(isTierRoutingEnabled()).toBe(false);
    setTierRoutingEnabled(true);
    expect(isTierRoutingEnabled()).toBe(true);
  });

  it('clamps rounds into [1, 10]', () => {
    expect(setTier1Rounds(0)).toBe(1);
    expect(setTier1Rounds(99)).toBe(MAX_TIER1_ROUNDS);
    expect(setTier1Rounds(4)).toBe(4);
    expect(getTier1Rounds()).toBe(4);
    // A garbage stored value falls back to the default rather than exploding.
    setSetting(TIER1_ROUNDS_KEY, 'not-a-number');
    expect(getTier1Rounds()).toBe(DEFAULT_TIER1_ROUNDS);
  });
});

describe('buildTierWalkOrder', () => {
  it('keeps the incoming order inside each tier', () => {
    const chain = [row(1, 2), row(2, 1), row(3, 3), row(4, 1)];
    const plan = buildTierWalkOrder(chain, { enabled: true, rounds: 2 });
    expect(plan.ordered.map(r => r.id)).toEqual([2, 4, 2, 4, 1, 3]);
    expect(plan.counts).toEqual({ first: 2, second: 1, other: 1 });
    expect(plan.rounds).toBe(2);
  });

  it('walks tier 1 N passes before tier 2', () => {
    const chain = [row(1, 1), row(2, 2), row(3, 3)];
    expect(buildTierWalkOrder(chain, { enabled: true, rounds: 1 }).ordered.map(r => r.id))
      .toEqual([1, 2, 3]);
    expect(buildTierWalkOrder(chain, { enabled: true, rounds: 3 }).ordered.map(r => r.id))
      .toEqual([1, 1, 1, 2, 3]);
  });

  it('is a passthrough when disabled or every row is unclassified', () => {
    const chain = [row(1, 3), row(2, 3)];
    expect(buildTierWalkOrder(chain, { enabled: false }).ordered.map(r => r.id)).toEqual([1, 2]);
    expect(buildTierWalkOrder(chain, { enabled: false }).counts.first).toBe(0);
    // routing_tier missing = 3.
    const legacy = [{ id: 9 }];
    expect(buildTierWalkOrder(legacy, { enabled: true }).ordered).toEqual(legacy);
  });
});

describe('partitionByRoutingTier', () => {
  it('splits into the three strings', () => {
    const { first, second, other } = partitionByRoutingTier([row(1, 1), row(2, 2), row(3, 3), row(4, 1)]);
    expect(first.map(r => r.id)).toEqual([1, 4]);
    expect(second.map(r => r.id)).toEqual([2]);
    expect(other.map(r => r.id)).toEqual([3]);
  });
});

describe('ensureDefaultRoutingTiers (boot / catalog / refresh hook)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('seeds a non-empty first string and preserves manual rows on later syncs', () => {
    const db = getDb();
    // Simulate a fresh install: rows are 'auto' with routing_tier = 3 (the
    // migration default) and capability_tier not yet derived. Unique ids keep
    // this independent of the seeded rows (models is FK-referenced, so deleting
    // it is not an option).
    db.exec(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, capability_tier, routing_tier, routing_tier_source, enabled)
        VALUES ('groq', 'boot-frontier', 'Boot frontier', 3, 3, 0, 3, 'auto', 1);
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, capability_tier, routing_tier, routing_tier_source, enabled)
        VALUES ('groq', 'boot-strong', 'Boot strong', 45, 45, 0, 3, 'auto', 1);
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, capability_tier, routing_tier, routing_tier_source, enabled)
        VALUES ('groq', 'boot-longtail', 'Boot long tail', 400, 400, 0, 3, 'auto', 1);
    `);

    // Exactly the boot sequence in index.ts: recompute ability, then seed the
    // operator strings from it.
    recomputeCapabilityTiers(db);
    ensureDefaultRoutingTiers(db);

    const tiers = Object.fromEntries(
      (db.prepare("SELECT model_id, routing_tier FROM models WHERE model_id LIKE 'boot-%'").all() as any[])
        .map(r => [r.model_id, r.routing_tier]),
    );
    expect(tiers['boot-frontier']).toBe(1);
    expect(tiers['boot-strong']).toBe(2);
    expect(tiers['boot-longtail']).toBe(3);
    const summary = Object.fromEntries(routingTierSummary(db).map(r => [r.tier, r.count]));
    expect(summary[1]).toBeGreaterThan(0); // "default to tier 1" is real, not a no-op

    // The operator promotes a long-tail model, then a later boot / catalog
    // apply must NOT send it back to "other".
    const id = (db.prepare("SELECT id FROM models WHERE model_id = 'boot-longtail'").get() as any).id;
    setModelRoutingTier(id, 1, db);
    recomputeCapabilityTiers(db);
    ensureDefaultRoutingTiers(db);
    const row = db.prepare('SELECT routing_tier, routing_tier_source FROM models WHERE id = ?').get(id) as any;
    expect(row.routing_tier).toBe(1);
    expect(row.routing_tier_source).toBe('manual');
  });
});

describe('assignRoutingTiersByAbility', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('maps capability tiers onto routing tiers and respects manual rows', () => {
    const db = getDb();
    db.exec(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, capability_tier, routing_tier_source, enabled)
        VALUES ('groq', 'a', 'A', 1, 1, 1, 'auto', 1);
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, capability_tier, routing_tier_source, enabled)
        VALUES ('groq', 'b', 'B', 30, 30, 2, 'auto', 1);
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, capability_tier, routing_tier_source, enabled)
        VALUES ('groq', 'c', 'C', 200, 200, 3, 'auto', 1);
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, capability_tier, routing_tier_source, enabled)
        VALUES ('groq', 'd', 'D', 5, 5, 1, 'manual', 1);
    `);
    const out = assignRoutingTiersByAbility(db);
    expect(out.manual).toBe(1);
    const tiers = Object.fromEntries(
      (db.prepare('SELECT model_id, routing_tier FROM models').all() as any[]).map(r => [r.model_id, r.routing_tier]),
    );
    expect(tiers.a).toBe(1);
    expect(tiers.b).toBe(2);
    expect(tiers.c).toBe(3);
    // The hand-placed row keeps its tier AND its source.
    expect(tiers.d).toBe(3);
    expect(routingTierSummary(db).length).toBeGreaterThan(0);

    setModelRoutingTier((db.prepare("SELECT id FROM models WHERE model_id = 'c'").get() as any).id, 1, db);
    const c = db.prepare("SELECT routing_tier, routing_tier_source FROM models WHERE model_id = 'c'").get() as any;
    expect(c.routing_tier).toBe(1);
    expect(c.routing_tier_source).toBe('manual');
    // The bulk pass leaves it alone afterwards.
    assignRoutingTiersByAbility(db);
    expect((db.prepare("SELECT routing_tier FROM models WHERE model_id = 'c'").get() as any).routing_tier).toBe(1);
    // ...unless overridden explicitly.
    assignRoutingTiersByAbility(db, true);
    expect((db.prepare("SELECT routing_tier FROM models WHERE model_id = 'c'").get() as any).routing_tier).toBe(3);
  });
});
