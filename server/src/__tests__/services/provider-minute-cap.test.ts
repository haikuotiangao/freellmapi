import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  canUseProviderMinute,
  providerMinuteRequestCount,
  getProviderMinuteRequestCap,
} from '../../services/ratelimit.js';

/**
 * Account-wide per-minute caps. The per-model rpm_limit cannot express these:
 * a provider that meters one bucket for the whole key (Agnes free text tier at
 * 10 RPM, AMD's gateway) needs an account-wide gate, otherwise the router keeps
 * dispatching and eats real 429s.
 *
 * NVIDIA is deliberately NOT one of them: its ~40 RPM is metered per model id,
 * which a per-model rpm_limit already models correctly. This fork seeds it into
 * `provider_limits` with scope='model' and these functions ignore that row —
 * treating it as an account ceiling is what the old hard-coded default did, and
 * it cost real throughput.
 */
function seedRequests(platform: string, modelId: string, keyId: number, count: number, atMs: number) {
  const ins = getDb().prepare(`
    INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms)
    VALUES (?, ?, ?, 'request', 0, ?)
  `);
  for (let i = 0; i < count; i++) ins.run(platform, modelId, keyId, atMs);
}

describe('provider-wide per-minute request cap', () => {
  let keyId: number;

  beforeEach(() => {
    initDb(':memory:');
    keyId = Math.floor(Math.random() * 1_000_000);
  });

  afterEach(() => {
    delete process.env.PROVIDER_MINUTE_REQUEST_CAP_NVIDIA;
    delete process.env.PROVIDER_MINUTE_REQUEST_CAP_GROQ;
  });

  it('has no account-wide default for nvidia — its 40 RPM is per model', () => {
    // This fork moved NVIDIA from an account-wide 40 RPM gate to a
    // scope='model' profile in provider_limits. Metering it account-wide threw
    // away throughput: distinct model ids each get their own 40, so the old
    // gate serialized models that never contended.
    expect(getProviderMinuteRequestCap('nvidia')).toBeNull();
    expect(getProviderMinuteRequestCap('groq')).toBeNull();
  });

  it('honours an account-scoped provider_limits row but ignores a model-scoped one', () => {
    getDb().prepare(`
      INSERT INTO provider_limits (platform, rpm, scope) VALUES ('agnes', 10, 'account')
    `).run();
    expect(getProviderMinuteRequestCap('agnes')).toBe(10);

    getDb().prepare(`
      INSERT INTO provider_limits (platform, rpm, scope) VALUES ('nvidia', 40, 'model')
    `).run();
    // Never read as an account ceiling: that is the bug the old hard-coded
    // DEFAULT_PROVIDER_MINUTE_REQUEST_CAPS['nvidia'] entry caused.
    expect(getProviderMinuteRequestCap('nvidia')).toBeNull();
  });

  it('honours an env override and treats 0 as disabled', () => {
    process.env.PROVIDER_MINUTE_REQUEST_CAP_NVIDIA = '5';
    expect(getProviderMinuteRequestCap('nvidia')).toBe(5);
    process.env.PROVIDER_MINUTE_REQUEST_CAP_NVIDIA = '0';
    expect(getProviderMinuteRequestCap('nvidia')).toBeNull();
  });

  it('sums usage across every model on the same account+key', () => {
    const now = Date.now();
    // The whole point: three different models, one shared budget.
    seedRequests('nvidia', 'glm-4.7', keyId, 10, now - 5_000);
    seedRequests('nvidia', 'minimax-m3', keyId, 10, now - 4_000);
    seedRequests('nvidia', 'deepseek-v4', keyId, 10, now - 3_000);

    expect(providerMinuteRequestCount('nvidia', keyId, now)).toBe(30);
  });

  it('blocks once the shared budget is spent, even for an untouched model', () => {
    process.env.PROVIDER_MINUTE_REQUEST_CAP_NVIDIA = '40';
    const now = Date.now();
    seedRequests('nvidia', 'glm-4.7', keyId, 40, now - 10_000);

    // deepseek-v4 has made zero requests of its own and may well have a NULL
    // rpm_limit, but the account budget is gone.
    expect(canUseProviderMinute('nvidia', keyId, now)).toBe(false);
  });

  it('allows again once the minute window rolls past', () => {
    process.env.PROVIDER_MINUTE_REQUEST_CAP_NVIDIA = '40';
    const now = Date.now();
    seedRequests('nvidia', 'glm-4.7', keyId, 40, now - 61_000);

    expect(providerMinuteRequestCount('nvidia', keyId, now)).toBe(0);
    expect(canUseProviderMinute('nvidia', keyId, now)).toBe(true);
  });

  it('does not gate a provider with no configured cap', () => {
    const now = Date.now();
    seedRequests('groq', 'llama-3.3-70b', keyId, 500, now - 1_000);
    expect(canUseProviderMinute('groq', keyId, now)).toBe(true);
  });

  it('keeps separate budgets per key on the same platform', () => {
    process.env.PROVIDER_MINUTE_REQUEST_CAP_NVIDIA = '40';
    const now = Date.now();
    const other = keyId + 1;
    seedRequests('nvidia', 'glm-4.7', keyId, 40, now - 5_000);

    expect(canUseProviderMinute('nvidia', keyId, now)).toBe(false);
    expect(canUseProviderMinute('nvidia', other, now)).toBe(true);
  });
});
