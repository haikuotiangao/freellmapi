import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { recomputeCapabilityTiers, disableJunkModels, JUNK_TIER } from '../../services/capability-tier.js';
import { assignRoutingTiersByAbility } from '../../services/tier-routing.js';

// The operator's own endpoints (source = 'user') used to be forced to
// capability_tier 0. Because auto-assign maps 1 → routing tier 1 and everything
// else → "other", a database built from self-registered providers could never
// have a populated first string — tier 1 stayed empty forever while the
// best-ranked models sank to the bottom. These pin the corrected behaviour.

function insertModel(row: {
  platform: string; modelId: string; rank: number | null; source: string | null; enabled?: number;
}) {
  getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, source, enabled)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(row.platform, row.modelId, row.modelId, row.rank ?? 0, row.source, row.enabled ?? 1);
}

describe('recomputeCapabilityTiers — user-owned rows', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare("DELETE FROM models WHERE platform = 'userfx'").run();
  });

  it('ranks a self-registered endpoint by its rank like a catalog row', () => {
    insertModel({ platform: 'userfx', modelId: 'mine-top', rank: 5, source: 'user' });
    insertModel({ platform: 'userfx', modelId: 'mine-mid', rank: 40, source: 'user' });
    recomputeCapabilityTiers();
    const tiers = Object.fromEntries(
      (getDb().prepare("SELECT model_id, capability_tier FROM models WHERE platform = 'userfx'").all() as any[])
        .map(r => [r.model_id, r.capability_tier]),
    );
    expect(tiers['mine-top']).toBe(1);
    expect(tiers['mine-mid']).toBe(2);
  });

  it('never marks a self-registered endpoint as junk', () => {
    // A junk-looking id AND a terrible rank: still not tier 4, because the
    // operator registered it on purpose and disableJunkModels must not reach it.
    insertModel({ platform: 'userfx', modelId: 'mine-tiny-1b', rank: 900, source: 'user' });
    recomputeCapabilityTiers();
    const row = getDb().prepare("SELECT capability_tier FROM models WHERE model_id = 'mine-tiny-1b'")
      .get() as { capability_tier: number };
    expect(row.capability_tier).not.toBe(JUNK_TIER);
    // Other (seeded) catalog rows may legitimately get disabled; the assertion
    // that matters is that THIS row survives.
    disableJunkModels();
    const enabled = getDb().prepare("SELECT enabled FROM models WHERE model_id = 'mine-tiny-1b'")
      .get() as { enabled: number };
    expect(enabled.enabled).toBe(1);
  });

  it('still sends genuinely unranked user rows to 0', () => {
    insertModel({ platform: 'userfx', modelId: 'mine-unranked', rank: null, source: 'user' });
    recomputeCapabilityTiers();
    const row = getDb().prepare("SELECT capability_tier FROM models WHERE model_id = 'mine-unranked'")
      .get() as { capability_tier: number };
    expect(row.capability_tier).toBe(0);
  });

  it('lets a user-owned endpoint populate routing tier 1 via auto-assign', () => {
    insertModel({ platform: 'userfx', modelId: 'mine-best', rank: 3, source: 'user' });
    recomputeCapabilityTiers();
    assignRoutingTiersByAbility(getDb(), true);
    const row = getDb().prepare("SELECT routing_tier FROM models WHERE model_id = 'mine-best'")
      .get() as { routing_tier: number };
    expect(row.routing_tier).toBe(1);
  });
});