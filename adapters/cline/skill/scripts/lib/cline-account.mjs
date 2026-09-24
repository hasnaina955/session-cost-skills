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

const DAY_MS = 24 * 60 * 60 * 1000;
const MICRO_USD = 1_000_000;
const REFERENCE_COST_USD_SCALE = 100_000_000;

function finiteNumberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
function utcDateKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}
function utcWeekKey(value) {
  const date = new Date(value);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return `${date.toISOString().slice(0, 10)}`;
}
function utcMonthKey(value) {
  return new Date(value).toISOString().slice(0, 7);
}
function sumUsage(items) {
  return items.reduce((total, item) => {
    const promptTokens = finiteNumberOrZero(item.promptTokens);
    const completionTokens = finiteNumberOrZero(item.completionTokens);
    const cachedTokens = finiteNumberOrZero(item.cachedTokens);
    const totalTokens = finiteNumberOrZero(item.totalTokens) || promptTokens + completionTokens;
    const clinePass = item.aiModelTypeName === 'cline-pass';
    return {
      requests: total.requests + 1,
      promptTokens: total.promptTokens + promptTokens,
      completionTokens: total.completionTokens + completionTokens,
      cachedTokens: total.cachedTokens + cachedTokens,
      totalTokens: total.totalTokens + totalTokens,
      referenceCostUsd: total.referenceCostUsd + finiteNumberOrZero(item.costUsd) / REFERENCE_COST_USD_SCALE,
      creditsUsedUsd: total.creditsUsedUsd + finiteNumberOrZero(item.creditsUsed) / MICRO_USD,
      clinePassRequests: total.clinePassRequests + (clinePass ? 1 : 0),
      usageBillingRequests: total.usageBillingRequests + (clinePass ? 0 : 1),
    };
  }, {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    referenceCostUsd: 0,
    creditsUsedUsd: 0,
    clinePassRequests: 0,
    usageBillingRequests: 0,
  });
}
function periodSummary(items, label, from, to) {
  return { label, from, to, ...sumUsage(items) };
}
function buildPeriods(usages, now = new Date()) {
  const end = now.getTime();
  const todayKey = utcDateKey(now);
  const weekStart = new Date(now);
  weekStart.setUTCDate(weekStart.getUTCDate() - 6);
  weekStart.setUTCHours(0, 0, 0, 0);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const dailyMap = new Map();
  const weeklyMap = new Map();
  const monthlyMap = new Map();
  for (const item of usages) {
    const timestamp = Date.parse(item.createdAt);
    if (!Number.isFinite(timestamp) || timestamp > end + DAY_MS) continue;
    const date = utcDateKey(item.createdAt);
    const week = utcWeekKey(item.createdAt);
    const month = utcMonthKey(item.createdAt);
    for (const [map, key] of [[dailyMap, date], [weeklyMap, week], [monthlyMap, month]]) {
      const rows = map.get(key) ?? [];
      rows.push(item);
      map.set(key, rows);
    }
  }
  const current = (items) => items.filter((item) => {
    const timestamp = Date.parse(item.createdAt);
    return Number.isFinite(timestamp) && timestamp <= end;
  });
  const daily = [...dailyMap.entries()].sort(([a], [b]) => b.localeCompare(a)).slice(0, 14).map(([date, rows]) => periodSummary(rows, 'day', date, date));
  const weekly = [...weeklyMap.entries()].sort(([a], [b]) => b.localeCompare(a)).slice(0, 8).map(([week, rows]) => periodSummary(rows, 'week', week, week));
  function monthEnd(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}
const monthly = [...monthlyMap.entries()].sort(([a], [b]) => b.localeCompare(a)).slice(0, 12).map(([month, rows]) => periodSummary(rows, 'month', `${month}-01`, monthEnd(month)));
  return {
    today: periodSummary(current(usages).filter((item) => utcDateKey(item.createdAt) === todayKey), 'day', todayKey, todayKey),
    last7Days: periodSummary(current(usages).filter((item) => Date.parse(item.createdAt) >= weekStart.getTime()), 'rolling-7-days', weekStart.toISOString().slice(0, 10), todayKey),
    currentMonth: periodSummary(current(usages).filter((item) => Date.parse(item.createdAt) >= monthStart.getTime()), 'calendar-month', monthStart.toISOString().slice(0, 10), todayKey),
    daily,
    weekly,
    monthly,
  };
}

export function summarizeClineAccount(data, now = new Date()) {
  const summary = sumUsage(data.usages);
  const balanceUsd = finiteNumberOrZero(data.balance?.balance) / MICRO_USD;
  return {
    userId: data.userId,
    accountCreatedAt: data.profile?.createdAt ?? null,
    requests: summary.requests,
    tokenTotals: { promptTokens: summary.promptTokens, completionTokens: summary.completionTokens, cachedTokens: summary.cachedTokens, totalTokens: summary.totalTokens },
    billingTotals: { referenceCostUsd: summary.referenceCostUsd, creditsUsedUsd: summary.creditsUsedUsd, balanceUsd },
    plan: data.plan?.plan ? { id: data.plan.plan.id, name: data.plan.plan.name, type: data.plan.plan.type, active: data.plan.plan.isActive, periodEnd: data.plan.currentPeriodEnd ?? null } : null,
    usageLimits: data.usageLimits?.limits ?? [],
    clinePassRequests: summary.clinePassRequests,
    usageBillingRequests: summary.usageBillingRequests,
    periods: buildPeriods(data.usages, now),
    pages: data.pages,
  };
}
