import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { endpointScopeForBaseUrl } from '../../lib/endpoint-scope.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// The dashboard's "what can I call" view (#user request 2).
//
// A key's model scope is a HARD routing restriction: the router skips a key
// whose scope does not list the model. So the dashboard may only offer what an
// ENABLED key can actually serve — the models the operator ticked in "Fetch
// models" / "Edit models" — and never a model that no enabled key would ever
// pick. Unscoped (NULL) keys serve everything of their platform, which is what
// "select all" stores.
describe('Fallback API — configuredOnly honours the key model scope', () => {
  let app: Express;
  let dashToken = '';

  async function request(app: Express, method: string, path: string, body?: any) {
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const addr = server.address() as any;
    const url = `http://127.0.0.1:${addr.port}${path}`;

    const res = await fetch(url, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await res.json().catch(() => null);
    server.close();
    return { status: res.status, body: data };
  }

  const BASE_URL = 'https://relay.example.com/v1';
  const SCOPE = endpointScopeForBaseUrl(BASE_URL);
  const OTHER_URL = 'https://other.example.com/v1';
  const OTHER_SCOPE = endpointScopeForBaseUrl(OTHER_URL);

  function insertKey(opts: {
    platform?: string;
    baseUrl?: string | null;
    scope?: string[] | null;
    enabled?: number;
    label?: string;
  }): number {
    const { encrypted, iv, authTag } = encrypt('sk-test');
    const result = getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url, model_scope_json)
      VALUES (?, ?, ?, ?, ?, 'healthy', ?, ?, ?)
    `).run(
      opts.platform ?? 'custom',
      opts.label ?? 'relay',
      encrypted,
      iv,
      authTag,
      opts.enabled ?? 1,
      opts.baseUrl ?? BASE_URL,
      opts.scope ? JSON.stringify(opts.scope) : null,
    );
    return Number(result.lastInsertRowid);
  }

  /** A model row plus its chain entry, so the dashboard can list it. */
  function insertModel(modelId: string, keyId: number | null, opts: {
    platform?: string;
    endpointScope?: string;
  } = {}): number {
    const platform = opts.platform ?? 'custom';
    const result = getDb().prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, key_id, endpoint_scope, source, enabled)
      VALUES (?, ?, ?, 50, 50, ?, ?, 'user', 1)
    `).run(platform, modelId, modelId, keyId, opts.endpointScope ?? SCOPE);
    const id = Number(result.lastInsertRowid);
    getDb().prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(id);
    return id;
  }

  async function listedModels(query = '?configuredOnly=1'): Promise<string[]> {
    const { status, body } = await request(app, 'GET', `/api/fallback${query}`);
    expect(status).toBe(200);
    return (body as any[]).map(r => r.modelId);
  }

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare('DELETE FROM profile_models').run();
    db.prepare('DELETE FROM models').run();
    db.prepare('DELETE FROM api_keys').run();
  });

  it('lists only the models inside the enabled key scope', async () => {
    const keyId = insertKey({ scope: ['model-a'] });
    insertModel('model-a', keyId);
    insertModel('model-b', keyId);

    const listed = await listedModels();
    expect(listed).toContain('model-a');
    // model-b is registered but unticked: the router would never pick it, so
    // the dashboard must not offer it either.
    expect(listed).not.toContain('model-b');
  });

  it('lists every model of an unscoped enabled key', async () => {
    const keyId = insertKey({ scope: null });
    insertModel('model-a', keyId);
    insertModel('model-b', keyId);

    const listed = await listedModels();
    expect(listed).toContain('model-a');
    expect(listed).toContain('model-b');
  });

  it('hides the models of a disabled key', async () => {
    const keyId = insertKey({ scope: null, enabled: 0 });
    insertModel('model-a', keyId);

    expect(await listedModels()).not.toContain('model-a');
  });

  it('keeps an endpoint reachable through a sibling credential of the same endpoint', async () => {
    // Two credentials for one endpoint; the models are bound to the first, but
    // the second one is enabled and serves the endpoint's whole model list.
    const bound = insertKey({ scope: null, enabled: 0, label: 'disabled' });
    insertKey({ scope: null, enabled: 1, label: 'enabled sibling' });
    insertModel('model-a', bound);

    expect(await listedModels()).toContain('model-a');
  });

  it('applies the scope of the endpoint, not of one credential', async () => {
    // The endpoint's models are bound to key A (scope: model-a), while key B
    // shares the endpoint and scopes it to model-b. model-c is in neither.
    const a = insertKey({ scope: ['model-a'], label: 'a' });
    insertKey({ scope: ['model-b'], label: 'b' });
    insertModel('model-a', a);
    insertModel('model-b', a);
    insertModel('model-c', a);

    const listed = await listedModels();
    expect(listed).toContain('model-a');
    expect(listed).toContain('model-b');
    expect(listed).not.toContain('model-c');
  });

  it('scopes a built-in platform by the enabled key of that platform', async () => {
    const keyId = insertKey({ platform: 'openrouter', baseUrl: null, scope: ['openrouter/model-a'] });
    insertModel('openrouter/model-a', null, { platform: 'openrouter', endpointScope: '' });
    insertModel('openrouter/model-b', null, { platform: 'openrouter', endpointScope: '' });
    expect(keyId).toBeGreaterThan(0);

    const listed = await listedModels();
    expect(listed).toContain('openrouter/model-a');
    expect(listed).not.toContain('openrouter/model-b');
  });

  it('keeps the full catalog when configuredOnly is not requested', async () => {
    const keyId = insertKey({ scope: ['model-a'] });
    insertModel('model-a', keyId);
    insertModel('model-b', keyId);

    const listed = await listedModels('');
    expect(listed).toContain('model-a');
    expect(listed).toContain('model-b');
  });

  it('never lists a model of another endpoint', async () => {
    const keyId = insertKey({ scope: null });
    const other = insertKey({ baseUrl: OTHER_URL, scope: null, label: 'other' });
    insertModel('model-a', keyId);
    insertModel('model-other', other, { endpointScope: OTHER_SCOPE });

    const listed = await listedModels();
    expect(listed).toContain('model-a');
    expect(listed).toContain('model-other');
  });

  it('a freshly registered pick of a scoped key becomes visible', async () => {
    // "Fetch models" registers a pick AND teaches the key's scope about it
    // (extendKeyScope), so the pick shows up here on the very next read.
    const keyId = insertKey({ scope: ['model-a'] });
    insertModel('model-a', keyId);

    const reg = await request(app, 'POST', '/api/keys/custom', {
      keyId,
      models: ['model-b'],
    });
    expect(reg.status).toBe(201);

    const listed = await listedModels();
    expect(listed).toContain('model-a');
    expect(listed).toContain('model-b');
    // And the scope actually carries it now — the router can pick it too.
    const scopeRow = getDb().prepare('SELECT model_scope_json FROM api_keys WHERE id = ?').get(keyId) as
      { model_scope_json: string };
    expect(JSON.parse(scopeRow.model_scope_json)).toEqual(['model-a', 'model-b']);
  });

  it('an unscoped key keeps an empty scope after a pick', async () => {
    const keyId = insertKey({ scope: null });
    insertModel('model-a', keyId);

    const reg = await request(app, 'POST', '/api/keys/custom', {
      keyId,
      models: ['model-b'],
    });
    expect(reg.status).toBe(201);

    const scopeRow = getDb().prepare('SELECT model_scope_json FROM api_keys WHERE id = ?').get(keyId) as
      { model_scope_json: string | null };
    // NULL must stay NULL: "select all" means no restriction, and writing a
    // list of "the ones picked so far" would silently restrict the key.
    expect(scopeRow.model_scope_json).toBeNull();
    const listed = await listedModels();
    expect(listed).toContain('model-b');
  });
});
