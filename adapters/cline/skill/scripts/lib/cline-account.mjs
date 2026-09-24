const DEFAULT_BASE_URL = 'https://api.cline.bot';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function isRetryableStatus(status) { return status === 408 || status === 425 || status === 429 || status >= 500; }

export async function requestCline(pathname, { apiKey, baseUrl = DEFAULT_BASE_URL, fetcher = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES } = {}) {
  if (!apiKey) throw new Error('Cline API key is required for --account');
  const url = `${baseUrl.replace(/\/$/, '')}${pathname}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetcher(url, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (isRetryableStatus(response.status) && attempt < retries) {
        await response.body?.cancel();
        await sleep(250 * 2 ** attempt);
        continue;
      }
      let envelope;
      try { envelope = await response.json(); } catch { throw new Error(`Cline API returned HTTP ${response.status} without JSON`); }
      if (!response.ok || !envelope?.success) throw new Error(envelope?.error || `Cline API returned HTTP ${response.status}`);
      return envelope.data ?? null;
    } catch (error) {
      if (attempt < retries && (error instanceof TypeError || ['AbortError', 'TimeoutError'].includes(error?.name))) {
        await sleep(250 * 2 ** attempt);
        continue;
      }
      if (['AbortError', 'TimeoutError'].includes(error?.name)) throw new Error(`Cline API request timed out after ${timeoutMs}ms`);
      throw error;
    }
  }
  throw new Error('Cline API request failed after retries');
}

export async function fetchClineAccount({ apiKey, userId, baseUrl, fetcher, timeoutMs, retries, maxPages = 10_000 } = {}) {
  const profile = await requestCline('/api/v1/users/me', { apiKey, baseUrl, fetcher, timeoutMs, retries });
  if (!profile?.id) throw new Error('Cline profile response did not include a user id');
  const resolvedUserId = userId || profile.id;
  if (userId && userId !== profile.id) throw new Error(`Requested user ${userId} does not match authenticated account ${profile.id}`);

  const [balance, plan, usageLimits] = await Promise.all([
    requestCline(`/api/v1/users/${encodeURIComponent(resolvedUserId)}/balance`, { apiKey, baseUrl, fetcher, timeoutMs, retries }),
    requestCline('/api/v1/users/me/plan', { apiKey, baseUrl, fetcher, timeoutMs, retries }),
    requestCline('/api/v1/users/me/plan/usage-limits', { apiKey, baseUrl, fetcher, timeoutMs, retries }),
  ]);

  const items = [];
  const seen = new Set();
  let cursor = null;
  let pages = 0;
  do {
    const query = new URLSearchParams({ limit: '1000' });
    if (cursor) query.set('cursor', cursor);
    const page = await requestCline(`/api/v1/users/${encodeURIComponent(resolvedUserId)}/usages?${query}`, { apiKey, baseUrl, fetcher, timeoutMs, retries });
    items.push(...(Array.isArray(page?.items) ? page.items : []));
    cursor = page?.nextToken || null;
    pages++;
    if (cursor && seen.has(cursor)) throw new Error('Cline API returned a repeated pagination cursor');
    if (cursor) seen.add(cursor);
    if (pages >= maxPages) throw new Error(`Cline usage history exceeded ${maxPages} pages`);
  } while (cursor);

  return { profile, userId: resolvedUserId, balance, plan, usageLimits, usages: items, pages };
}

export function summarizeClineAccount(data) {
  const sum = (items, field) => items.reduce((total, item) => total + (Number(item?.[field]) || 0), 0);
  const promptTokens = sum(data.usages, 'promptTokens');
  const completionTokens = sum(data.usages, 'completionTokens');
  const cachedTokens = sum(data.usages, 'cachedTokens');
  const totalTokens = sum(data.usages, 'totalTokens') || promptTokens + completionTokens;
  const referenceCostUsd = sum(data.usages, 'costUsd') / 100_000_000;
  const creditsUsedUsd = sum(data.usages, 'creditsUsed') / 1_000_000;
  const balanceUsd = Number(data.balance?.balance) / 1_000_000;
  const clinePassRequests = data.usages.filter((item) => item?.aiModelTypeName === 'cline-pass').length;
  return {
    userId: data.userId,
    accountCreatedAt: data.profile?.createdAt ?? null,
    requests: data.usages.length,
    tokenTotals: { promptTokens, completionTokens, cachedTokens, totalTokens },
    billingTotals: { referenceCostUsd, creditsUsedUsd, balanceUsd },
    plan: data.plan?.plan ? { id: data.plan.plan.id, name: data.plan.plan.name, type: data.plan.plan.type, active: data.plan.plan.isActive, periodEnd: data.plan.currentPeriodEnd ?? null } : null,
    usageLimits: data.usageLimits?.limits ?? [],
    clinePassRequests,
    pages: data.pages,
  };
}
