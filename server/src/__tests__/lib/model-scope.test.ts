import { describe, it, expect } from 'vitest';
import {
  enabledKeyScopes,
  parseModelScope,
  scopeAllows,
  servableByScope,
} from '../../lib/model-scope.js';

describe('model scope — servability rules', () => {
  it('parses a stored scope and answers membership', () => {
    const scope = parseModelScope('["a","b"]');
    expect(scopeAllows(scope, 'a')).toBe(true);
    expect(scopeAllows(scope, 'c')).toBe(false);
    expect(parseModelScope(null)).toBeNull();
    expect(scopeAllows(null, 'anything')).toBe(true);
  });

  it('a scoped key serves only the ids it lists', () => {
    const scopes = enabledKeyScopes([
      { platform: 'custom', endpointScope: 'https://a/v1', modelScopeJson: '["m1"]' },
      { platform: 'custom', endpointScope: 'https://b/v1', modelScopeJson: null },
    ]);
    // The endpoint of a: m1 is listed, m2 is not.
    expect(servableByScope(scopes.byEndpoint.get('https://a/v1'), 'm1')).toBe(true);
    expect(servableByScope(scopes.byEndpoint.get('https://a/v1'), 'm2')).toBe(false);
    // The endpoint of b is unscoped: every model of the endpoint is served.
    expect(servableByScope(scopes.byEndpoint.get('https://b/v1'), 'm1')).toBe(true);
    // No key of an endpoint = the endpoint serves nothing.
    expect(servableByScope(scopes.byEndpoint.get('https://c/v1'), 'm1')).toBe(false);
  });

  it('several credentials of one endpoint pool their scopes', () => {
    const scopes = enabledKeyScopes([
      { platform: 'custom', endpointScope: 'https://a/v1', modelScopeJson: '["m1"]' },
      { platform: 'custom', endpointScope: 'https://a/v1', modelScopeJson: '["m2"]' },
    ]);
    const endpoint = scopes.byEndpoint.get('https://a/v1')!;
    expect(servableByScope(endpoint, 'm1')).toBe(true);
    expect(servableByScope(endpoint, 'm2')).toBe(true);
    expect(servableByScope(endpoint, 'm3')).toBe(false);
  });

  it('one unscoped credential opens the whole platform', () => {
    const scopes = enabledKeyScopes([
      { platform: 'openrouter', endpointScope: '', modelScopeJson: '["gpt"]' },
      { platform: 'openrouter', endpointScope: '', modelScopeJson: null },
    ]);
    const platform = scopes.byPlatform.get('openrouter')!;
    expect(servableByScope(platform, 'gpt')).toBe(true);
    expect(servableByScope(platform, 'claude')).toBe(true);
  });
});
