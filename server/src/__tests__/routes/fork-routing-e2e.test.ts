import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { listFilterRules, invalidateFilterRulesCache } from '../../services/model-filter-rules.js';
import { clearAllCooldowns } from '../../services/ratelimit.js';
import { clearAllPenalties } from '../../services/router.js';
import { resetModelRetirementObservations } from '../../services/model-retirement.js';

// ── Fork v0.16.31 end-to-end verification ──────────────────────────────────
//
// These are NOT unit tests with mocked routing: they start a real OpenAI-
// compatible upstream over loopback, register it as a real `custom` provider,
// then drive real POST /v1/chat/completions requests through the whole Express
// app (auth → resolveRoutingChain → orderChain → tier walk → provider HTTP →
// request log). What the operator asked for was "启用之后自己测一下能不能真的
// 调用", so the assertion is on the wire: which model the upstream actually
// saw, in which order, and what landed in `requests`.

interface Hit { model: string; path: string; at: number }

let app: Express;
let dashToken: string;
let unifiedKey: string;
let upstream: http.Server;
let upstreamPort = 0;
let hits: Hit[] = [];
const failModels = new Set<string>();
const modelIds: Record<string, number> = {};

async function callApi(method: string, path: string, body?: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${path.startsWith('/api/') ? dashToken : unifiedKey}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

/** A real gateway call. `model: 'auto'` walks the operator's chain. */
async function chat(label: string) {
  return callApi('POST', '/v1/chat/completions', {
    model: 'auto',
    messages: [{ role: 'user', content: `ping-${label}` }],
    max_tokens: 16,
  });
}

function servedModel(body: any): string | null {
  return body?.model ?? body?.served_model ?? null;
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  app = createApp();
  dashToken = mintDashboardToken();
  unifiedKey = getUnifiedApiKey();

  // Real upstream. A 404 is a MODEL-level failure (skipModels), not a provider
  // failure — that is what lets the tier walk fall through to the next string
  // instead of ruling out the whole `custom` platform (#788/#651).
  upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      let model = '';
      try { model = String(JSON.parse(raw || '{}').model ?? ''); } catch { /* ignore */ }
      hits.push({ model, path: req.url ?? '', at: Date.now() });
      if (failModels.has(model)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `model not found: ${model}`, type: 'invalid_request_error' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: `chatcmpl-e2e-${hits.length}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }));
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  upstreamPort = (upstream.address() as { port: number }).port;

  const db = getDb();
  db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();

  const reg = await callApi('POST', '/api/keys/custom', {
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    apiKey: 'e2e-local-key',
    label: 'E2E mock upstream',
    models: [
      { model: 'fork-tier-a', displayName: 'First string A' },
      { model: 'fork-tier-b', displayName: 'Second string B' },
      { model: 'fork-tier-c', displayName: 'Other C' },
    ],
  });
  expect(reg.status).toBe(201);

  for (const id of ['fork-tier-a', 'fork-tier-b', 'fork-tier-c']) {
    const row = db.prepare('SELECT id FROM models WHERE model_id = ?').get(id) as { id: number };
    modelIds[id] = row.id;
  }

  // Deliberately invert the manual order: under plain 'priority' the OTHER
  // string would serve first. If 'tier' is real, tier 1 must win anyway.
  const priority: Record<string, number> = { 'fork-tier-c': 1, 'fork-tier-b': 2, 'fork-tier-a': 3 };
  for (const [id, p] of Object.entries(priority)) {
    db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?').run(p, modelIds[id]);
  }

  // Place the three strings and enable the tier strategy + 2 rounds.
  for (const [id, tier] of Object.entries({ 'fork-tier-a': 1, 'fork-tier-b': 2, 'fork-tier-c': 3 })) {
    const r = await callApi('PUT', `/api/tuning/routing-tiers/models/${modelIds[id]}`, { tier });
    expect(r.status).toBe(200);
  }
  const rounds = await callApi('PUT', '/api/tuning/routing-tiers', { enabled: true, rounds: 2 });
  expect(rounds.status).toBe(200);
  expect(rounds.body.rounds).toBe(2);
});

beforeEach(async () => {
  hits = [];
  failModels.clear();
  const db = getDb();
  // A 404 in one test leaves a per-model cooldown and a router penalty behind;
  // without this reset the next test silently starts with a different pool
  // (and a 429 instead of a 200). Keep every case independent.
  db.prepare('DELETE FROM model_filter_rules').run();
  invalidateFilterRulesCache();
  db.prepare('DELETE FROM requests').run();
  db.prepare("UPDATE models SET enabled = 1 WHERE model_id LIKE 'fork-tier-%'").run();
  db.prepare("UPDATE fallback_config SET enabled = 1 WHERE model_db_id IN (SELECT id FROM models WHERE model_id LIKE 'fork-tier-%')").run();
  clearAllCooldowns();
  clearAllPenalties();
  resetModelRetirementObservations();
});

describe('fork routing: tier strategy + custom filters + model editing (E2E)', () => {
  it('accepts "tier" as a real routing strategy and reports it back', async () => {
    const put = await callApi('PUT', '/api/fallback/routing', { strategy: 'tier' });
    expect(put.status).toBe(200);
    const get = await callApi('GET', '/api/fallback/routing');
    expect(get.status).toBe(200);
    expect(get.body.strategy).toBe('tier');
    // No weight vector: tier is not a scored preset.
    expect(get.body.weights).toBeNull();
  });

  it('really calls the upstream, and tier 1 wins even when the manual order says otherwise', async () => {
    await callApi('PUT', '/api/fallback/routing', { strategy: 'tier' });
    const res = await chat('tier-first');
    expect(res.status).toBe(200);
    expect(res.body?.choices?.[0]?.message?.content).toBe('pong');
    expect(servedModel(res.body)).toBe('fork-tier-a');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].path).toBe('/v1/chat/completions');
    expect(hits[0].model).toBe('fork-tier-a');
    // Nothing beyond tier 1 was touched on a healthy first pass.
    expect(hits.some(h => h.model === 'fork-tier-b')).toBe(false);
    expect(hits.some(h => h.model === 'fork-tier-c')).toBe(false);
  });

  it('falls through to tier 2 when every tier-1 model is dead, and logs both attempts', async () => {
    await callApi('PUT', '/api/fallback/routing', { strategy: 'tier' });
    failModels.add('fork-tier-a');
    const res = await chat('tier-failover');
    expect(res.status).toBe(200);
    expect(servedModel(res.body)).toBe('fork-tier-b');
    expect(hits[0].model).toBe('fork-tier-a');
    expect(hits.some(h => h.model === 'fork-tier-b')).toBe(true);
    // The failed hop is recorded as a real request, with the concrete model.
    const rows = getDb().prepare('SELECT * FROM requests ORDER BY id DESC').all() as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // The failed hop is recorded as a real request, naming the concrete model.
    expect(JSON.stringify(rows)).toContain('fork-tier-a');
    expect(JSON.stringify(rows)).toContain('fork-tier-b');
  });

  it('an exclude rule removes a model from the LIVE routing chain', async () => {
    await callApi('PUT', '/api/fallback/routing', { strategy: 'tier' });
    // No failure injection: both healthy tier-1/tier-2 models are excluded,
    // so the only way tier 3 can serve is the filter really running in
    // orderChain. That isolates the rule from cooldown/failover behaviour.
    for (const id of ['fork-tier-a', 'fork-tier-b']) {
      const created = await callApi('POST', '/api/tuning/filters', {
        name: `skip-${id}`,
        action: 'exclude',
        platform: 'custom',
        modelPattern: id,
      });
      expect(created.status).toBe(201);
      expect(created.body.preview.perRule.some((r: { hits: number }) => r.hits === 1)).toBe(true);
    }

    const res = await chat('exclude-ab');
    expect(res.status).toBe(200);
    expect(servedModel(res.body)).toBe('fork-tier-c');
    expect(hits).toHaveLength(1);
    expect(hits[0].model).toBe('fork-tier-c');
    expect(hits.some(h => h.model === 'fork-tier-a')).toBe(false);
    expect(hits.some(h => h.model === 'fork-tier-b')).toBe(false);
  });

  it('an include rule turns the pool into a whitelist and the preview reports it', async () => {
    await callApi('PUT', '/api/fallback/routing', { strategy: 'tier' });
    const created = await callApi('POST', '/api/tuning/filters', {
      name: 'only-other',
      action: 'include',
      modelPattern: 'fork-tier-c',
    });
    expect(created.status).toBe(201);
    expect(created.body.preview.whitelistActive).toBe(true);

    const res = await chat('whitelist-c');
    expect(res.status).toBe(200);
    expect(servedModel(res.body)).toBe('fork-tier-c');
    expect(hits).toHaveLength(1);
    expect(hits[0].model).toBe('fork-tier-c');
  });

  it('previewing a draft rule does not persist it', async () => {
    const before = listFilterRules().length;
    const res = await callApi('POST', '/api/tuning/filters/preview', {
      rule: { name: 'draft', action: 'exclude', modelPattern: 'fork-tier-*' },
    });
    expect(res.status).toBe(200);
    expect(res.body.dropped).toBeGreaterThan(0);
    expect(listFilterRules().length).toBe(before);
  });

  it('edits a single model (tier + price + enabled) through PATCH /api/models/:id', async () => {
    const id = modelIds['fork-tier-c'];
    const res = await callApi('PATCH', `/api/models/${id}`, { routingTier: 1, priceTier: 'paid' });
    expect(res.status).toBe(200);
    const row = getDb().prepare(
      'SELECT routing_tier, routing_tier_source, price_tier, price_note FROM models WHERE id = ?',
    ).get(id) as Record<string, unknown>;
    expect(row.routing_tier).toBe(1);
    expect(row.routing_tier_source).toBe('manual');
    expect(row.price_tier).toBe('paid');
    expect(row.price_note).toBe('manual');

    // Restore so later tests keep their fixture shape.
    await callApi('PUT', `/api/tuning/routing-tiers/models/${id}`, { tier: 3 });
    await callApi('PATCH', `/api/models/${id}`, { priceTier: 'unknown' });
  });

  it('bulk-edits several models in one transaction and the change reaches routing', async () => {
    const ids = [modelIds['fork-tier-b'], modelIds['fork-tier-c']];
    const res = await callApi('POST', '/api/tuning/models/bulk', {
      ids,
      patch: { routingTier: 2, priceTier: 'free', enabled: true },
    });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
    const rows = getDb().prepare(`
      SELECT id, routing_tier, routing_tier_source, price_tier, price_note, enabled
        FROM models WHERE id IN (?, ?)
    `).all(...ids) as Record<string, unknown>[];
    for (const row of rows) {
      expect(row.routing_tier).toBe(2);
      expect(row.routing_tier_source).toBe('manual');
      expect(row.price_tier).toBe('free');
      expect(row.price_note).toBe('manual');
      expect(Number(row.enabled)).toBe(1);
    }

    // Real call: with tier 1 dead, both survivors are now tier 2 — the first
    // one in the walk order must be one of them, and tier 3 must be gone.
    await callApi('PUT', '/api/fallback/routing', { strategy: 'tier' });
    failModels.add('fork-tier-a');
    const chatRes = await chat('bulk');
    expect(chatRes.status).toBe(200);
    expect(['fork-tier-b', 'fork-tier-c']).toContain(servedModel(chatRes.body));

    // Restore fixtures.
    await callApi('PUT', `/api/tuning/routing-tiers/models/${modelIds['fork-tier-c']}`, { tier: 3 });
    await callApi('PATCH', `/api/models/${modelIds['fork-tier-b']}`, { priceTier: 'unknown' });
    await callApi('PATCH', `/api/models/${modelIds['fork-tier-c']}`, { priceTier: 'unknown' });
  });

  it('the recent-calls log records the concrete provider model and its status', async () => {
    await callApi('PUT', '/api/fallback/routing', { strategy: 'tier' });
    const res = await chat('audit');
    expect(res.status).toBe(200);
    const rows = getDb().prepare(
      'SELECT model_id, requested_model, served_model, status, platform FROM requests ORDER BY id DESC LIMIT 5',
    ).all() as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    // The row names the concrete provider model somewhere in its fields
    // (model_id / served_model / requested_model, depending on the build).
    expect(JSON.stringify(rows)).toContain('fork-tier-');
    // The exact endpoint the top-bar "recent calls" dialog reads.
    const recent = await callApi('GET', '/api/analytics/requests?range=24h&limit=100');
    expect(recent.status).toBe(200);
    expect(recent.body?.rows?.length ?? recent.body?.requests?.length ?? 0).toBeGreaterThan(0);
  });
});
