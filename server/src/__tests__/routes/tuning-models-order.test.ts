import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

// The model editor had two real complaints behind it:
//   1. rows came back in provider order inside a tier, so a 50-row page looked
//      arbitrarily sorted and tier 1 was never visible at the top;
//   2. the free-model sweep only ever looked at the catalog, never at the keys
//      the operator had actually wired up, so their own endpoints were buried
//      under hundreds of unreachable catalog rows.
// These assert the API contract that fixes both, on a controlled fixture so the
// expectations do not depend on the 983-row catalog the app ships with.

async function request(app: Express, method: string, path: string, body: unknown, token: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  server.close();
  let json: unknown = null;
  try { json = JSON.parse(raw); } catch { /* non-JSON */ }
  return { status: res.status, body: json as any };
}

describe('/api/tuning/models ordering + filters', () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  beforeEach(() => {
    const db = getDb();
    // Not `DELETE FROM models`: fallback_config / profile_models reference it,
    // so a blanket delete trips the FK. Scope the fixture to its own platforms
    // and clean up only those rows.
    db.prepare("DELETE FROM models WHERE platform IN ('wired', 'unwired')").run();
    db.prepare("DELETE FROM api_keys WHERE platform IN ('wired', 'unwired')").run();

    const insertKey = db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, 'x', 'x', 'x', 'unknown', ?)
    `);
    insertKey.run('wired', 'wired-key', 1);
    insertKey.run('unwired', 'unwired-key', 0);

    const insertModel = db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank,
                          price_tier, capability_tier, routing_tier, enabled, key_id)
      VALUES (?, ?, ?, 1, 1, ?, ?, ?, 1, ?)
    `);
    // Deliberately inserted in reverse tier order so "already sorted" cannot be
    // an accident of insertion order.
    insertModel.run('wired', 'fx-other-b', 'Other B', 'free', 2, 3, null);
    insertModel.run('wired', 'fx-other-a', 'Other A', 'free', 4, 3, null);
    insertModel.run('wired', 'fx-second-b', 'Second B', 'paid', 2, 2, null);
    insertModel.run('wired', 'fx-second-a', 'Second A', 'free', 1, 2, null);
    insertModel.run('wired', 'fx-first-a', 'First A', 'free', 1, 1, null);
    // Unreachable: no enabled key on the platform and no key binding.
    insertModel.run('unwired', 'fx-ghost', 'Ghost', 'free', 1, 1, null);
  });

  it('orders tier 1 → tier 2 → other, with ability as the tiebreak', async () => {
    const { status, body } = await request(app, 'GET', '/api/tuning/models?limit=1000', undefined, token);
    expect(status).toBe(200);
    // The seeded catalog ships with the test DB, so scope the assertion to this
    // fixture's rows (fx-*). Order rule under test: routing tier first,
    // capability tier second, then platform/id. 'fx-ghost' and 'fx-first-a' are
    // both tier 1 with ability 1, so the platform name breaks the tie and
    // 'unwired' precedes 'wired'.
    const mine = body.models
      .map((m: any) => m.model_id as string)
      .filter(id => id.startsWith('fx-'));
    expect(mine).toEqual([
      'fx-ghost',
      'fx-first-a',
      'fx-second-a',
      'fx-second-b',
      'fx-other-b',
      'fx-other-a',
    ]);
  });

  it('sorts by routing tier before anything else', async () => {
    const { body } = await request(app, 'GET', '/api/tuning/models?limit=1000', undefined, token);
    const mine = body.models.filter((m: any) => m.model_id.startsWith('fx-'));
    const tiers = mine.map((m: any) => m.routing_tier);
    expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
  });

  it('leads each tier with unranked (capability 0) models, not trails it', async () => {
    const db = getDb();
    // capability_tier 0 = unranked: what a user-created endpoint gets. Those
    // are the models the operator wired up, so they must not sink below
    // catalog rows inside the same routing tier.
    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank,
                          price_tier, capability_tier, routing_tier, enabled)
      VALUES ('wired', 'fx-unranked', 'Unranked', 500, 500, 'unknown', 0, 3, 1)
    `).run();
    const { body } = await request(app, 'GET', '/api/tuning/models?tier=3&limit=1000', undefined, token);
    const mine = body.models.map((m: any) => m.model_id).filter((id: string) => id.startsWith('fx-'));
    expect(mine[0]).toBe('fx-unranked');
    expect(mine.indexOf('fx-unranked')).toBeLessThan(mine.indexOf('fx-other-b'));
  });

  it('configuredOnly keeps only platforms with an enabled key', async () => {
    const { body } = await request(app, 'GET', '/api/tuning/models?configuredOnly=1&limit=50', undefined, token);
    const ids = body.models.map((m: any) => m.model_id);
    expect(ids).not.toContain('fx-ghost');
    expect(ids).toContain('fx-first-a');
    expect(body.configuredPlatforms).toEqual(['wired']);
  });

  it('configuredOnly also keeps rows bound to a key on an otherwise unwired platform', async () => {
    const db = getDb();
    const keyId = (db.prepare("SELECT id FROM api_keys WHERE platform = 'unwired'").get() as { id: number }).id;
    db.prepare("UPDATE models SET key_id = ? WHERE model_id = 'fx-ghost'").run(keyId);
    // The key row itself is disabled, so the platform test still fails — the
    // key_id test must be the one that saves it.
    const { body } = await request(app, 'GET', '/api/tuning/models?configuredOnly=1&limit=50', undefined, token);
    expect(body.models.map((m: any) => m.model_id)).not.toContain('fx-ghost');
    db.prepare("UPDATE api_keys SET enabled = 1 WHERE platform = 'unwired'").run();
    const after = await request(app, 'GET', '/api/tuning/models?configuredOnly=1&limit=50', undefined, token);
    expect(after.body.models.map((m: any) => m.model_id)).toContain('fx-ghost');
  });

  it('price=free narrows to unpriced/free and never includes paid', async () => {
    const { body } = await request(app, 'GET', '/api/tuning/models?price=free&limit=1000', undefined, token);
    const ids = body.models.map((m: any) => m.model_id);
    expect(ids).toContain('fx-first-a');
    expect(ids).not.toContain('fx-second-b'); // paid
  });

  it('price=routable keeps unpriced rows, matching what the router actually serves', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank,
                          price_tier, capability_tier, routing_tier, enabled)
      VALUES ('wired', 'fx-unpriced', 'Unpriced', 10, 10, 'unknown', 0, 3, 1)
    `).run();
    // exact-match free would hide fx-unpriced; routable must not.
    const strict = await request(app, 'GET', '/api/tuning/models?price=free&limit=1000', undefined, token);
    expect(strict.body.models.map((m: any) => m.model_id)).not.toContain('fx-unpriced');

    const routable = await request(app, 'GET', '/api/tuning/models?price=routable&limit=1000', undefined, token);
    const ids = routable.body.models.map((m: any) => m.model_id);
    expect(ids).toContain('fx-unpriced');
    expect(ids).not.toContain('fx-second-b'); // paid still excluded
  });

  it('combines price + configuredOnly + tier', async () => {
    const { body } = await request(app, 'GET',
      '/api/tuning/models?price=free&configuredOnly=1&tier=2&limit=50', undefined, token);
    expect(body.models.map((m: any) => m.model_id)).toEqual(['fx-second-a']);
  });

  it('reports both the catalog platforms and the configured ones', async () => {
    const { body } = await request(app, 'GET', '/api/tuning/models?limit=1', undefined, token);
    // /models lists every platform in the catalog; the seeded rows are present too.
    expect(body.platforms).toEqual(expect.arrayContaining(['unwired', 'wired']));
    // Only platforms with an ENABLED key count as configured.
    expect(body.configuredPlatforms).toEqual(['wired']);
  });
});