import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BASE_URL = 'https://api.cline.bot';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;
const AUTH_REFRESH_SKEW_MS = 60_000;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

export function resolveClineCredential({ dataDir, environment = process.env, now = Date.now() } = {}) {
  if (environment.CLINE_API_KEY) return { apiKey: environment.CLINE_API_KEY, userId: environment.CLINE_USER_ID ?? null, source: 'environment' };

  const providersPath = path.join(dataDir, 'data', 'settings', 'providers.json');
  const providers = readJson(providersPath);
  for (const providerId of ['cline', 'cline-pass']) {
    const auth = providers?.providers?.[providerId]?.settings?.auth;
    if (!auth?.accessToken) continue;
    const expiresAt = Number(auth.expiresAt);
    const expired = Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now + AUTH_REFRESH_SKEW_MS;
    if (expired) continue;
    return {
      apiKey: auth.accessToken,
      userId: environment.CLINE_USER_ID ?? auth.accountId ?? auth.metadata?.userInfo?.clineUserId ?? null,
      source: `providers.json:${providerId}`,
      expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? new Date(expiresAt).toISOString() : null,
    };
  }

  const secrets = readJson(path.join(dataDir, 'data', 'secrets.json'));
  if (secrets?.apiKey) return { apiKey: secrets.apiKey, userId: environment.CLINE_USER_ID ?? null, source: 'secrets.json' };
  return null;
}


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
      if (!response.ok || !envelope?.success) {
        const detail = typeof envelope?.error === 'string'
          ? envelope.error
          : envelope?.error?.message ?? envelope?.message ?? `Cline API returned HTTP ${response.status}`;
        const error = new Error(detail);
        error.status = response.status;
        error.code = envelope?.error?.code ?? envelope?.code ?? null;
        error.attempts = attempt + 1;
        throw error;
      }
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

export async function fetchClineAccount({ apiKey, userId, baseUrl, fetcher, timeoutMs, retries, maxPages = 100, since = null, now = Date.now() } = {}) {
  const windowEnd = new Date(now).toISOString();
  const windowStartMs = since === null ? null : (typeof since === 'number' ? since : Date.parse(since));
  if (windowStartMs !== null && !Number.isFinite(windowStartMs)) throw new Error('Cline account history window start is invalid');
  const windowStart = windowStartMs === null ? null : new Date(windowStartMs).toISOString();

  const profile = await requestCline('/api/v1/users/me', { apiKey, baseUrl, fetcher, timeoutMs, retries });
  if (!profile?.id) throw new Error('Cline profile response did not include a user id');
  const resolvedUserId = userId || profile.id;
  if (userId && userId !== profile.id) throw new Error(`Requested user ${userId} does not match authenticated account ${profile.id}`);

  const [balance, plan, usageLimits] = await Promise.all([
    requestCline(`/api/v1/users/${encodeURIComponent(resolvedUserId)}/balance`, { apiKey, baseUrl, fetcher, timeoutMs, retries }),
    requestCline('/api/v1/users/me/plan', { apiKey, baseUrl, fetcher, timeoutMs, retries }),
    requestCline('/api/v1/users/me/plan/usage-limits', { apiKey, baseUrl, fetcher, timeoutMs, retries }),
  ]);

  const fetched = [];
  const seen = new Set();
  let cursor = null;
  let pages = 0;
  do {
    const query = new URLSearchParams({ limit: '1000' });
    if (cursor) query.set('cursor', cursor);
    const page = await requestCline(`/api/v1/users/${encodeURIComponent(resolvedUserId)}/usages?${query}`, { apiKey, baseUrl, fetcher, timeoutMs, retries });
    if (!page || !Array.isArray(page.items)) throw new Error(`Cline usage page ${pages + 1} did not include an items array`);
    for (const item of page.items) {
      if (!item || typeof item !== 'object' || !Number.isFinite(Date.parse(item.createdAt))) {
        throw new Error(`Cline usage page ${pages + 1} contained a row without a valid createdAt timestamp`);
      }
    }
    fetched.push(...page.items);
    cursor = typeof page.nextToken === 'string' && page.nextToken ? page.nextToken : null;
    pages++;
    const oldest = page.items.reduce((value, item) => Math.min(value, Date.parse(item.createdAt)), Number.POSITIVE_INFINITY);
    if (windowStartMs !== null && Number.isFinite(oldest) && oldest <= windowStartMs) cursor = null;
    if (cursor && seen.has(cursor)) throw new Error('Cline API returned a repeated pagination cursor');
    if (cursor) seen.add(cursor);
    if (pages >= maxPages && cursor) throw new Error(`Cline usage history exceeded ${maxPages} pages`);
  } while (cursor);

  const usages = fetched.filter((item) => {
    const timestamp = Date.parse(item.createdAt);
    return timestamp <= now && (windowStartMs === null || timestamp >= windowStartMs);
  });
  return {
    profile,
    userId: resolvedUserId,
    balance,
    plan,
    usageLimits,
    usages,
    pages,
    window: { start: windowStart, end: windowEnd },
    fetchedRows: fetched.length,
    excludedRows: fetched.length - usages.length,
  };
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
function periodSummary(items, label, from, to, window = {}, now = new Date()) {
  const periodStart = Date.parse(`${from}T00:00:00.000Z`);
  const periodEnd = Date.parse(`${to}T23:59:59.999Z`);
  const windowStart = window?.start ? Date.parse(window.start) : null;
  const windowEnd = window?.end ? Date.parse(window.end) : now.getTime();
  const coveredStart = windowStart === null || windowStart <= periodStart;
  const coveredEnd = Number.isFinite(windowEnd) && windowEnd >= periodEnd;
  return {
    label,
    from,
    to,
    complete: coveredStart && coveredEnd,
    coverage: windowStart === null ? 'unknown' : coveredStart && coveredEnd ? 'complete' : 'partial',
    completeThrough: new Date(Math.min(periodEnd, windowEnd, now.getTime())).toISOString(),
    windowStart: window?.start ?? null,
    windowEnd: window?.end ?? null,
    ...sumUsage(items),
  };
}
function buildPeriods(usages, now = new Date(), window = {}) {
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
    if (!Number.isFinite(timestamp) || timestamp > end) continue;
    const date = utcDateKey(item.createdAt);
    const week = utcWeekKey(item.createdAt);
    const month = utcMonthKey(item.createdAt);
    for (const [map, key] of [[dailyMap, date], [weeklyMap, week], [monthlyMap, month]]) {
      const rows = map.get(key) ?? [];
      rows.push(item);
      map.set(key, rows);
    }
  }
  const current = (items) => items.filter((item) => Date.parse(item.createdAt) <= end);
  const daily = [...dailyMap.entries()].sort(([a], [b]) => b.localeCompare(a)).slice(0, 14)
    .map(([date, rows]) => periodSummary(rows, 'day', date, date, window, now));
  const weekly = [...weeklyMap.entries()].sort(([a], [b]) => b.localeCompare(a)).slice(0, 8)
    .map(([week, rows]) => periodSummary(rows, 'week', week, weekEnd(week), window, now));
  const monthly = [...monthlyMap.entries()].sort(([a], [b]) => b.localeCompare(a)).slice(0, 12)
    .map(([month, rows]) => periodSummary(rows, 'month', `${month}-01`, monthEnd(month), window, now));
  return {
    today: periodSummary(current(usages).filter((item) => utcDateKey(item.createdAt) === todayKey), 'day', todayKey, todayKey, window, now),
    last7Days: periodSummary(current(usages).filter((item) => Date.parse(item.createdAt) >= weekStart.getTime()), 'rolling-7-days', weekStart.toISOString().slice(0, 10), todayKey, window, now),
    currentMonth: periodSummary(current(usages).filter((item) => Date.parse(item.createdAt) >= monthStart.getTime()), 'calendar-month', monthStart.toISOString().slice(0, 10), monthEnd(utcMonthKey(now)), window, now),
    daily,
    weekly,
    monthly,
  };
}

function weekEnd(weekKey) {
  const date = new Date(`${weekKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 6);
  return date.toISOString().slice(0, 10);
}

function monthEnd(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function modelSummaries(usages) {
  const grouped = new Map();
  for (const item of usages) {
    const provider = item.aiInferenceProviderName || 'unknown';
    const model = item.aiModelName || item.aiModelTypeName || item.operation || 'unknown';
    const key = `${provider}|${model}`;
    const row = grouped.get(key) ?? { provider, model, calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, referenceCostUsd: 0, creditsUsedUsd: 0, rateKnown: true };
    const promptTokens = finiteNumberOrZero(item.promptTokens);
    const completionTokens = finiteNumberOrZero(item.completionTokens);
    const totalTokens = finiteNumberOrZero(item.totalTokens) || promptTokens + completionTokens;
    row.calls += 1;
    row.promptTokens += promptTokens;
    row.completionTokens += completionTokens;
    row.cachedTokens += finiteNumberOrZero(item.cachedTokens);
    row.totalTokens += totalTokens;
    row.referenceCostUsd += finiteNumberOrZero(item.costUsd) / REFERENCE_COST_USD_SCALE;
    row.creditsUsedUsd += finiteNumberOrZero(item.creditsUsed) / MICRO_USD;
    grouped.set(key, row);
  }
  return [...grouped.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

export function summarizeClineAccount(data, now = new Date()) {
  const window = data.window ?? {};
  const windowStart = window.start ? Date.parse(window.start) : null;
  const windowEnd = window.end ? Date.parse(window.end) : now.getTime();
  const usages = (data.usages ?? []).filter((item) => {
    const timestamp = Date.parse(item.createdAt);
    return Number.isFinite(timestamp)
      && timestamp <= now.getTime()
      && (windowStart === null || timestamp >= windowStart)
      && (!Number.isFinite(windowEnd) || timestamp <= windowEnd);
  });
  const summary = sumUsage(usages);
  const balanceUsd = finiteNumberOrZero(data.balance?.balance) / MICRO_USD;
  return {
    userId: data.userId,
    accountCreatedAt: data.profile?.createdAt ?? null,
    window: { start: window.start ?? null, end: window.end ?? now.toISOString() },
    requests: summary.requests,
    tokenTotals: { promptTokens: summary.promptTokens, completionTokens: summary.completionTokens, cachedTokens: summary.cachedTokens, totalTokens: summary.totalTokens },
    billingTotals: { referenceCostUsd: summary.referenceCostUsd, creditsUsedUsd: summary.creditsUsedUsd, balanceUsd },
    plan: data.plan?.plan ? { id: data.plan.plan.id, name: data.plan.plan.name, type: data.plan.plan.type, active: data.plan.plan.isActive, periodEnd: data.plan.currentPeriodEnd ?? null } : null,
    usageLimits: data.usageLimits?.limits ?? [],
    clinePassRequests: summary.clinePassRequests,
    usageBillingRequests: summary.usageBillingRequests,
    models: modelSummaries(usages),
    periods: buildPeriods(usages, now, window),
    pages: data.pages ?? 0,
    fetchedRows: data.fetchedRows ?? usages.length,
    excludedRows: data.excludedRows ?? 0,
  };
}
