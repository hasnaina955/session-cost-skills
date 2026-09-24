import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchClineAccount, requestCline, summarizeClineAccount } from '../scripts/lib/cline-account.mjs';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify({ success: status < 400, data, error: status >= 400 ? 'failure' : undefined }), { status, headers: { 'content-type': 'application/json' } });
}

test('account summary preserves Cline money units and token totals', () => {
  const summary = summarizeClineAccount({
    userId: 'usr-test', profile: { createdAt: '2026-01-01T00:00:00Z' },
    balance: { balance: 2_500_000 }, plan: { plan: { id: 'pass', name: 'ClinePass', type: 'subscription', isActive: true } },
    usageLimits: { limits: [{ type: 'weekly', percentUsed: 42 }] }, pages: 2,
    usages: [
      { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedTokens: 80, costUsd: 200_000_000, creditsUsed: 1_000_000, aiModelTypeName: 'cline-pass' },
      { promptTokens: 50, completionTokens: 10, totalTokens: 60, cachedTokens: 0, costUsd: 50_000_000, creditsUsed: 0, aiModelTypeName: 'other' },
    ],
  });
  assert.equal(summary.billingTotals.balanceUsd, 2.5);
  assert.equal(summary.billingTotals.referenceCostUsd, 2.5);
  assert.equal(summary.billingTotals.creditsUsedUsd, 1);
  assert.equal(summary.tokenTotals.totalTokens, 180);
  assert.equal(summary.clinePassRequests, 1);
  assert.equal(summary.usageLimits[0].percentUsed, 42);
});

test('account client paginates, validates identity, and redacts credentials', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url.endsWith('/users/me')) return jsonResponse({ id: 'usr-real', createdAt: '2026-01-01T00:00:00Z' });
    if (url.includes('/balance')) return jsonResponse({ balance: 0 });
    if (url.endsWith('/plan')) return jsonResponse(null);
    if (url.endsWith('/usage-limits')) return jsonResponse(null);
    if (url.includes('/usages?')) {
      return calls.filter((item) => item.includes('/usages?')).length === 1
        ? jsonResponse({ items: [{ promptTokens: 1 }], nextToken: 'next' })
        : jsonResponse({ items: [{ promptTokens: 2 }], nextToken: '' });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const data = await fetchClineAccount({ apiKey: 'secret-token', fetcher, retries: 0 });
  assert.equal(data.userId, 'usr-real');
  assert.equal(data.usages.length, 2);
  assert.equal(data.pages, 2);
  assert.equal(calls.some((url) => url.includes('secret-token')), false);
  await assert.rejects(() => fetchClineAccount({ apiKey: 'secret-token', userId: 'usr-wrong', fetcher, retries: 0 }), /does not match/);
});

test('account request reports missing credentials without making a request', async () => {
  await assert.rejects(() => requestCline('/api/v1/users/me', { apiKey: '', fetcher: async () => { throw new Error('should not run'); } }), /API key is required/);
});
