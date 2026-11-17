// Per-key model scope (#657). api_keys.model_scope_json is an optional JSON
// array of model_id strings: relay stations hand out keys that only serve one
// model group, so a scoped key must never be picked — or counted as a usable
// sibling — for a model outside its list. NULL means "unscoped": the key
// serves every model of its platform, which is the pre-#657 behavior.

import type { Db } from '../db/types.js';

/**
 * Parse a stored scope into a Set for O(1) membership tests, or null when the
 * key is unscoped. Called once per key ROW, never per comparison. An empty or
 * corrupt value degrades to unscoped rather than silently benching the key.
 */
export function parseModelScope(json: string | null | undefined): Set<string> | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json);
    if (!Array.isArray(raw)) return null;
    const ids = raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
    return ids.length > 0 ? new Set(ids) : null;
  } catch {
    return null;
  }
}

/** Whether a key with this parsed scope may serve the model. */
export function scopeAllows(scope: Set<string> | null, modelId: string): boolean {
  return scope === null || scope.has(modelId);
}

/**
 * One enabled key, reduced to what decides WHICH models it can serve.
 *
 * `endpointScope` is the normalized endpoint identity of a custom key (the
 * shared base URL): every credential of one endpoint pools its scope, because
 * the router lets any of them serve any model the endpoint carries (#619).
 */
export interface ScopedKeyRow {
  platform: string;
  /** Normalized endpoint identity; '' for built-in platforms. */
  endpointScope: string;
  modelScopeJson: string | null;
}

/**
 * The scopes of every enabled key, grouped by what they can serve:
 * built-in platforms by platform name, custom endpoints by endpoint scope.
 */
export interface EnabledKeyScopes {
  byPlatform: Map<string, (Set<string> | null)[]>;
  byEndpoint: Map<string, (Set<string> | null)[]>;
}

/** Group enabled keys by platform / endpoint so a lookup is a map hit. */
export function enabledKeyScopes(rows: ScopedKeyRow[]): EnabledKeyScopes {
  const byPlatform = new Map<string, (Set<string> | null)[]>();
  const byEndpoint = new Map<string, (Set<string> | null)[]>();
  for (const row of rows) {
    const scope = parseModelScope(row.modelScopeJson);
    const platformScopes = byPlatform.get(row.platform) ?? [];
    platformScopes.push(scope);
    byPlatform.set(row.platform, platformScopes);
    if (row.platform === 'custom') {
      const endpointScopes = byEndpoint.get(row.endpointScope) ?? [];
      endpointScopes.push(scope);
      byEndpoint.set(row.endpointScope, endpointScopes);
    }
  }
  return { byPlatform, byEndpoint };
}

/**
 * Whether any of these keys can serve the model. A NULL scope means the key
 * is unscoped and serves every model of its platform; a scoped key serves
 * only the ids it lists.
 *
 * This is the rule the dashboard's "what can I call" view follows: a scope is
 * a HARD routing restriction (the router skips a key whose scope does not
 * list the model), so a model outside every enabled key's scope can never
 * answer — listing it would offer a model the router will never pick.
 */
export function servableByScope(
  scopes: (Set<string> | null)[] | undefined,
  modelId: string,
): boolean {
  if (!scopes || scopes.length === 0) return false;
  return scopes.some(scope => scope === null || scope.has(modelId));
}

/**
 * Teach a SCOPED key about the models the operator just picked for it.
 *
 * A scope is the operator's statement of "these are the models this key
 * serves", and picking a model in "Fetch models" says exactly the same
 * thing. Without this the freshly registered model would stay outside the
 * scope: the router would skip it and the dashboard would not list it — the
 * opposite of what the pick meant.
 *
 * An UNSCOPED key (NULL scope) already serves every model of its platform, so
 * it stays NULL; "select all" must keep meaning "no restriction".
 *
 * Returns the ids that were added.
 */
export function extendKeyScope(db: Db, keyId: number, modelIds: string[]): string[] {
  if (modelIds.length === 0) return [];
  const row = db.prepare('SELECT model_scope_json FROM api_keys WHERE id = ?').get(keyId) as
    { model_scope_json: string | null } | undefined;
  if (!row || row.model_scope_json == null) return [];
  const scope = parseModelScope(row.model_scope_json);
  if (!scope) return [];
  const added = [...new Set(modelIds)].filter(id => id && !scope.has(id));
  if (added.length === 0) return [];
  db.prepare('UPDATE api_keys SET model_scope_json = ? WHERE id = ?')
    .run(JSON.stringify([...scope, ...added]), keyId);
  return added;
}
