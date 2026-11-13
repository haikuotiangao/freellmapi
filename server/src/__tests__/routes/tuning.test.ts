import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

// End-to-end checks for the fork's /api/tuning surface. The unit behaviour of
// each service is covered in services/cost-tier-classifier.test.ts and the
// migration suites; what these assert is that the routes are wired, that the
// destructive actions really require `confirm`, and that the free-only switch
// round-trips through the settings table (the router reads it on every request).

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

describe('/api/tuning', () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  it('reports the free-only switch and the tier split', async () => {
    const { status, body } = await request(app, 'GET', '/api/tuning/summary', undefined, token);
    expect(status).toBe(200);
    // On by default: the whole point of the fork.
    expect(body.freeOnlyRouting).toBe(true);
    expect(body.priceTiers).toHaveProperty('paid');
    expect(Array.isArray(body.capabilityTiers)).toBe(true);
    expect(typeof body.enabledModels).toBe('number');
  });

  it('round-trips the free-only switch through settings', async () => {
    const off = await request(app, 'PUT', '/api/tuning/free-only', { enabled: false }, token);
    expect(off.status).toBe(200);
    expect(off.body.freeOnlyRouting).toBe(false);

    const on = await request(app, 'PUT', '/api/tuning/free-only', { enabled: true }, token);
    expect(on.body.freeOnlyRouting).toBe(true);
  });

  it('rejects a non-boolean switch', async () => {
    const { status } = await request(app, 'PUT', '/api/tuning/free-only', { enabled: 'yes' }, token);
    expect(status).toBe(400);
  });

  it('marks paid rows and turns them off on demand', async () => {
    const db = getDb();
    db.prepare(`
      UPDATE models SET price_tier = 'paid', enabled = 1 WHERE id = (SELECT MIN(id) FROM models)
    `).run();
    const paidId = (db.prepare('SELECT MIN(id) AS id FROM models').get() as { id: number }).id;

    const res = await request(app, 'POST', '/api/tuning/disable-paid', {}, token);
    expect(res.status).toBe(200);
    expect(res.body.disabled).toBeGreaterThan(0);

    const row = db.prepare('SELECT enabled FROM models WHERE id = ?').get(paidId) as { enabled: number };
    expect(row.enabled).toBe(0);
  });

  it('refuses to bulk-disable junk models without confirm', async () => {
    const denied = await request(app, 'POST', '/api/tuning/junk', { action: 'disable' }, token);
    expect(denied.status).toBe(400);

    const allowed = await request(app, 'POST', '/api/tuning/junk', { action: 'disable', confirm: true }, token);
    expect(allowed.status).toBe(200);
    expect(typeof allowed.body.disabled).toBe('number');
  });

  it('reports and updates per-provider rate limits', async () => {
    const list = await request(app, 'GET', '/api/tuning/limits', undefined, token);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.limits)).toBe(true);

    const put = await request(app, 'PUT', '/api/tuning/limits/nvidia', { rpm: 45 }, token);
    expect(put.status).toBe(200);
    expect(put.body.limits.rpm).toBe(45);

    // A partial update must leave the untouched fields alone.
    const again = await request(app, 'PUT', '/api/tuning/limits/nvidia', { rpd: 200 }, token);
    expect(again.body.limits.rpm).toBe(45);
    expect(again.body.limits.rpd).toBe(200);
  });

  it('lists EVERY registered provider with its quota facts, configured or not', async () => {
    const { status, body } = await request(app, 'GET', '/api/tuning/limits/roster', undefined, token);
    expect(status).toBe(200);
    expect(body.roster.length).toBeGreaterThan(40);
    // The whole point of this endpoint: an unconfigured provider still has a
    // row, with the published quota explained and its enforced values blank.
    const nvidia = body.roster.find((r: any) => r.platform === 'nvidia');
    expect(nvidia).toBeTruthy();
    expect(nvidia.quotaFacts).toContain('PER MODEL');
    expect(nvidia.configured).toBe(true);
    const unconfigured = body.roster.filter((r: any) => !r.configured);
    expect(unconfigured.length).toBeGreaterThan(0);
    expect(unconfigured[0].limits.rpm).toBeNull();
    expect(typeof unconfigured[0].name).toBe('string');
  });

  it('round-trips the tier switch and the configurable pass count', async () => {
    const initial = await request(app, 'GET', '/api/tuning/routing-tiers', undefined, token);
    expect(initial.status).toBe(200);
    expect(initial.body.enabled).toBe(true);
    expect(initial.body.defaultRounds).toBe(2);
    expect(Array.isArray(initial.body.counts)).toBe(true);

    const changed = await request(app, 'PUT', '/api/tuning/routing-tiers', { rounds: 3, enabled: false }, token);
    expect(changed.status).toBe(200);
    expect(changed.body.rounds).toBe(3);
    expect(changed.body.enabled).toBe(false);

    // Clamped to the documented ceiling, never an unbounded re-walk.
    const clamped = await request(app, 'PUT', '/api/tuning/routing-tiers', { rounds: 999 }, token);
    expect(clamped.body.rounds).toBe(clamped.body.maxRounds ?? 10);

    // Restore the defaults the rest of the suite (and the router) expects.
    const restored = await request(app, 'PUT', '/api/tuning/routing-tiers', { rounds: 2, enabled: true }, token);
    expect(restored.body.rounds).toBe(2);
    expect(restored.body.enabled).toBe(true);
  });

  it('assigns tiers by ability and lets the operator move one model by hand', async () => {
    const assigned = await request(app, 'POST', '/api/tuning/routing-tiers/assign', {}, token);
    expect(assigned.status).toBe(200);
    expect(typeof assigned.body.changed).toBe('number');
    expect(Array.isArray(assigned.body.counts)).toBe(true);

    const db = getDb();
    const id = (db.prepare('SELECT MIN(id) AS id FROM models').get() as { id: number }).id;
    const moved = await request(app, 'PUT', `/api/tuning/routing-tiers/models/${id}`, { tier: 1 }, token);
    expect(moved.status).toBe(200);
    expect(moved.body.model.routing_tier).toBe(1);
    expect(moved.body.model.routing_tier_source).toBe('manual');

    // A bulk re-assign must NOT undo that manual placement.
    await request(app, 'POST', '/api/tuning/routing-tiers/assign', {}, token);
    const row = db.prepare('SELECT routing_tier, routing_tier_source FROM models WHERE id = ?').get(id) as any;
    expect(row.routing_tier).toBe(1);
    expect(row.routing_tier_source).toBe('manual');

    const listed = await request(app, 'GET', '/api/tuning/routing-tiers/models?tier=1&limit=5', undefined, token);
    expect(listed.status).toBe(200);
    expect(Array.isArray(listed.body.models)).toBe(true);
    expect(listed.body.models.every((m: any) => m.routing_tier === 1)).toBe(true);
  });

  it('rejects an unknown junk action', async () => {
    const { status } = await request(app, 'POST', '/api/tuning/junk', { action: 'explode' }, token);
    expect(status).toBe(400);
  });
});
