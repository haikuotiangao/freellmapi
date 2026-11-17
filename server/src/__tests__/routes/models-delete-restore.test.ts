import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { endpointScopeForBaseUrl } from '../../lib/endpoint-scope.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// The delete → re-enable round trip (#user request 3).
//
// Deleting a model from the dashboard must also take it out of every key's
// saved scope, and re-ticking it in the model editor must bring the ROW back.
// Without both halves the operator ends up with a ticked box and no model —
// or with a model that still looks enabled while the dashboard hides it.
describe('Models API — delete clears scope, re-tick restores the row', () => {
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

  function insertCustomKey(modelScope: string[] | null): number {
    const { encrypted, iv, authTag } = encrypt('sk-test');
    const result = getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url, model_scope_json)
      VALUES ('custom', 'relay', ?, ?, ?, 'healthy', 1, ?, ?)
    `).run(encrypted, iv, authTag, BASE_URL, modelScope ? JSON.stringify(modelScope) : null);
    return Number(result.lastInsertRowid);
  }

  function insertCustomModel(modelId: string, keyId: number): number {
    const result = getDb().prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, key_id, endpoint_scope, source, enabled)
      VALUES ('custom', ?, ?, 50, 50, ?, ?, 'user', 1)
    `).run(modelId, modelId, keyId, SCOPE);
    return Number(result.lastInsertRowid);
  }

  function scopeOf(keyId: number): string[] | null {
    const row = getDb().prepare('SELECT model_scope_json FROM api_keys WHERE id = ?').get(keyId) as
      { model_scope_json: string | null } | undefined;
    return row?.model_scope_json == null ? null : JSON.parse(row.model_scope_json);
  }

  function modelExists(modelId: string): boolean {
    return getDb()
      .prepare("SELECT 1 FROM models WHERE platform = 'custom' AND model_id = ? AND endpoint_scope = ?")
      .get(modelId, SCOPE) !== undefined;
  }

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    const db = getDb();
    // Children first: models is referenced by the chain and profile tables.
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare('DELETE FROM profile_models').run();
    db.prepare('DELETE FROM models').run();
    db.prepare('DELETE FROM api_keys').run();
  });

  it('takes the deleted model out of the key scope and keeps the others', async () => {
    const keyId = insertCustomKey(['model-a', 'model-b']);
    const modelDbId = insertCustomModel('model-a', keyId);
    insertCustomModel('model-b', keyId);

    const del = await request(app, 'DELETE', `/api/models/${modelDbId}`);
    expect(del.status).toBe(200);
    expect(modelExists('model-a')).toBe(false);

    // The scope must not keep pointing at a model that no longer exists:
    // the editor would show it ticked while the dashboard hides it.
    expect(scopeOf(keyId)).toEqual(['model-b']);
  });

  it('brings the model row back when the editor re-ticks it', async () => {
    const keyId = insertCustomKey(['model-a', 'model-b']);
    const modelDbId = insertCustomModel('model-a', keyId);
    insertCustomModel('model-b', keyId);

    await request(app, 'DELETE', `/api/models/${modelDbId}`);
    expect(modelExists('model-a')).toBe(false);

    const patch = await request(app, 'PATCH', `/api/keys/${keyId}`, { modelScope: ['model-a', 'model-b'] });
    expect(patch.status).toBe(200);
    expect(scopeOf(keyId)).toEqual(['model-a', 'model-b']);

    // The row itself has to come back — the dashboard lists the models table,
    // so a scope-only save would show a ticked box and an empty list.
    expect(modelExists('model-a')).toBe(true);
  });

  it('stores NULL rather than an empty scope once the last model is dropped', async () => {
    const keyId = insertCustomKey(['model-a', 'model-b']);
    const modelDbId = insertCustomModel('model-a', keyId);
    insertCustomModel('model-b', keyId);

    await request(app, 'DELETE', `/api/models/${modelDbId}`);
    expect(scopeOf(keyId)).toEqual(['model-b']);

    const patch = await request(app, 'PATCH', `/api/keys/${keyId}`, { modelScope: [] });
    expect(patch.status).toBe(200);
    // An empty array is stored as NULL: the router reads NULL as "unscoped".
    expect(scopeOf(keyId)).toBeNull();
  });
});
