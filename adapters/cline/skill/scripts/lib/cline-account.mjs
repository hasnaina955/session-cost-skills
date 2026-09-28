import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BASE_URL = 'https://api.cline.bot';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;
const AUTH_REFRESH_SKEW_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MICRO_USD = 1_000_000;
const REFERENCE_COST_USD_SCALE = 100_000_000;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function finiteNumberOrZero(value) {
  return finiteNumber(value) ?? 0;
}

function nonNegativeNumberOrZero(value) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= 0 ? parsed : 0;
}

function parseTimestamp(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const calendar = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value.trim());
  if (calendar) {
    const year = Number(calendar[1]);
    const month = Number(calendar[2]);
    const day = Number(calendar[3]);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoTimestamp(value) {
  const timestamp = parseTimestamp(value);
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function dateKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function dayStartUtc(timestamp) {
  const value = new Date(timestamp);
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function addUtcDays(timestamp, days) {
  return timestamp + days * DAY_MS;
}

function normalizeCursor(value, pageNumber) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Cline API returned an invalid pagination cursor on usage page ${pageNumber}`);
  return value;
}

function validateUsageRow(item, pageNumber, rowNumber) {
  for (const field of ['promptTokens', 'completionTokens', 'cachedTokens', 'totalTokens', 'costUsd', 'creditsUsed']) {
    if (!Object.prototype.hasOwnProperty.call(item, field) || item[field] === null || item[field] === undefined) continue;
    const value = finiteNumber(item[field]);
    if (value === null || value < 0) throw new Error(`Cline API returned a malformed usage row ${pageNumber}:${rowNumber} (${field})`);
  }
}

function validateUsagePage(page, pageNumber) {
  if (!page || typeof page !== 'object' || Array.isArray(page) || !Array.isArray(page.items)) {
    throw new Error(`Cline API returned a malformed usage page ${pageNumber}: expected an object with an items array`);
  }
  for (let index = 0; index < page.items.length; index++) {
    const item = page.items[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Cline API returned a malformed usage row ${pageNumber}:${index + 1}`);
    }
    validateUsageRow(item, pageNumber, index + 1);
  }
  if (Object.prototype.hasOwnProperty.call(page, 'nextToken')) normalizeCursor(page.nextToken, pageNumber);
  return page;
}

function apiErrorMessage(envelope, status) {
  const error = envelope?.error;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    const message = error.message ?? error.detail ?? error.description;
    if (typeof message === 'string' && message.trim()) return message;
    if (typeof error.code === 'string' && error.code.trim()) return error.code;
  }
  return `Cline API returned HTTP ${status}`;
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
  const retryCount = Number.isInteger(retries) && retries >= 0 ? retries : DEFAULT_RETRIES;
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      const response = await fetcher(url, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (isRetryableStatus(response.status) && attempt < retryCount) {
        await response.body?.cancel();
        await sleep(250 * 2 ** attempt);
        continue;
      }
      let envelope;
      try {
        envelope = await response.json();
      } catch (error) {
        const parseError = new Error(`Cline API returned HTTP ${response.status} without valid JSON`);
        parseError.status = response.status;
        parseError.retryable = isRetryableStatus(response.status);
        parseError.attempts = attempt + 1;
        parseError.cause = error;
        throw parseError;
      }
      if (!response.ok || !envelope || typeof envelope !== 'object' || envelope.success !== true) {
        const error = new Error(apiErrorMessage(envelope, response.status));
        error.status = response.status;
        error.code = typeof envelope?.error?.code === 'string' ? envelope.error.code : undefined;
        error.details = envelope?.error;
        error.retryable = isRetryableStatus(response.status);
        error.attempts = attempt + 1;
        throw error;
      }
      return envelope.data ?? null;
    } catch (error) {
      if (attempt < retryCount && (error instanceof TypeError || ['AbortError', 'TimeoutError'].includes(error?.name))) {
        await sleep(250 * 2 ** attempt);
        continue;
      }
      if (['AbortError', 'TimeoutError'].includes(error?.name)) {
        const timeoutError = new Error(`Cline API request timed out after ${timeoutMs}ms`);
        timeoutError.cause = error;
        timeoutError.attempts = attempt + 1;
        throw timeoutError;
      }
      throw error;
    }
  }
  throw new Error('Cline API request failed after retries');
}

function normalizeWindow({ windowStart, windowEnd, since, until, now = Date.now() } = {}) {
  const start = parseTimestamp(windowStart ?? since);
  const explicitEnd = parseTimestamp(windowEnd ?? until);
  const end = explicitEnd ?? (start === null ? null : parseTimestamp(now));
  if (windowStart !== undefined && windowStart !== null && start === null) throw new Error('Cline account windowStart is not a valid timestamp');
  if (windowEnd !== undefined && windowEnd !== null && explicitEnd === null) throw new Error('Cline account windowEnd is not a valid timestamp');
  if (since !== undefined && since !== null && start === null) throw new Error('Cline account since is not a valid timestamp');
  if (until !== undefined && until !== null && explicitEnd === null) throw new Error('Cline account until is not a valid timestamp');
  if (start !== null && end !== null && start > end) throw new Error('Cline account windowStart must not be after windowEnd');
  return { start, end };
}

export function filterUsageWindow(items, { windowStart = null, windowEnd = null } = {}) {
  const start = parseTimestamp(windowStart);
  const end = parseTimestamp(windowEnd);
  if (windowStart !== null && windowStart !== undefined && start === null) throw new Error('Cline account windowStart is not a valid timestamp');
  if (windowEnd !== null && windowEnd !== undefined && end === null) throw new Error('Cline account windowEnd is not a valid timestamp');
  if (start !== null && end !== null && start > end) throw new Error('Cline account windowStart must not be after windowEnd');
  const bounded = start !== null || end !== null;
  let excludedBefore = 0;
  let excludedAfter = 0;
  let invalidTimestamps = 0;
  const filtered = [];
  for (const item of items ?? []) {
    const timestamp = parseTimestamp(item?.createdAt);
    if (timestamp === null) {
      invalidTimestamps++;
      // Preserve the old unconstrained helper behavior for callers that do not request a
      // window. A bounded account report must never silently count an undated row.
      if (!bounded) filtered.push(item);
      continue;
    }
    if (start !== null && timestamp < start) {
      excludedBefore++;
      continue;
    }
    if (end !== null && timestamp > end) {
      excludedAfter++;
      continue;
    }
    filtered.push(item);
  }
  return { items: filtered, excludedBefore, excludedAfter, invalidTimestamps };
}

export async function fetchClineAccount({ apiKey, userId, baseUrl, fetcher, timeoutMs, retries, maxPages = 100, since = null, until = null, windowStart = null, windowEnd = null, days = null, now = Date.now() } = {}) {
  const profile = await requestCline('/api/v1/users/me', { apiKey, baseUrl, fetcher, timeoutMs, retries });
  if (!profile?.id) throw new Error('Cline profile response did not include a user id');
  const resolvedUserId = userId || profile.id;
  if (userId && userId !== profile.id) throw new Error(`Requested user ${userId} does not match authenticated account ${profile.id}`);

  const [balance, plan, usageLimits] = await Promise.all([
    requestCline(`/api/v1/users/${encodeURIComponent(resolvedUserId)}/balance`, { apiKey, baseUrl, fetcher, timeoutMs, retries }),
    requestCline('/api/v1/users/me/plan', { apiKey, baseUrl, fetcher, timeoutMs, retries }),
    requestCline('/api/v1/users/me/plan/usage-limits', { apiKey, baseUrl, fetcher, timeoutMs, retries }),
  ]);

  const pageLimit = Number.isInteger(maxPages) && maxPages > 0 ? maxPages : 100;
  const window = normalizeWindow({ windowStart, windowEnd, since, until, now });
  if (window.start === null && Number.isFinite(Number(days)) && Number(days) > 0) {
    const end = window.end ?? parseTimestamp(now) ?? Date.now();
    window.start = end - Math.floor(Number(days)) * DAY_MS;
  }
  const items = [];
  const seen = new Set();
  let cursor = null;
  let pages = 0;
  do {
    const query = new URLSearchParams({ limit: '1000' });
    if (cursor) query.set('cursor', cursor);
    const page = await requestCline(`/api/v1/users/${encodeURIComponent(resolvedUserId)}/usages?${query}`, { apiKey, baseUrl, fetcher, timeoutMs, retries });
    validateUsagePage(page, pages + 1);
    items.push(...page.items);
    pages++;
    cursor = normalizeCursor(page.nextToken, pages);
    if (cursor && seen.has(cursor)) throw new Error('Cline API returned a repeated pagination cursor');
    if (cursor) seen.add(cursor);
    if (cursor && pages >= pageLimit) throw new Error(`Cline usage history exceeded ${pageLimit} pages`);
  } while (cursor);

  const filtered = filterUsageWindow(items, { windowStart: window.start, windowEnd: window.end });
  const windowStartIso = isoTimestamp(window.start);
  const windowEndIso = isoTimestamp(window.end);
  const history = {
    start: windowStartIso,
    end: windowEndIso,
    exact: true,
    complete: filtered.invalidTimestamps === 0,
    fetchedRows: items.length,
    returnedRows: filtered.items.length,
    excludedBeforeWindow: filtered.excludedBefore,
    excludedAfterWindow: filtered.excludedAfter,
    invalidTimestamps: filtered.invalidTimestamps,
    pages,
  };
  return {
    profile,
    userId: resolvedUserId,
    balance,
    plan,
    usageLimits,
    usages: filtered.items,
    pages,
    windowStart: windowStartIso,
    windowEnd: windowEndIso,
    window: { start: windowStartIso, end: windowEndIso, exact: true, timeZone: 'UTC', complete: history.complete },
    history,
  };
}

function utcDateKey(value) {
  const timestamp = parseTimestamp(value);
  return timestamp === null ? null : dateKey(timestamp);
}

function utcWeekKey(value) {
  const timestamp = parseTimestamp(value);
  if (timestamp === null) return null;
  const date = new Date(timestamp);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function utcMonthKey(value) {
  const timestamp = parseTimestamp(value);
  return timestamp === null ? null : new Date(timestamp).toISOString().slice(0, 7);
}

function accountModelInfo(item) {
  const provider = String(item.aiInferenceProviderName ?? item.provider ?? 'unknown');
  const model = String(item.aiModelName ?? item.aiModelTypeName ?? item.operation ?? 'unknown');
  const searchable = [item.aiModelTypeName, item.aiModelName, item.aiInferenceProviderName, item.billingType, item.billingMode, item.planType, item.subscription]
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value).toLowerCase())
    .join('|');
  const isClinePass = item.isClinePass === true || item.subscription === true || String(item.planType ?? '').toLowerCase() === 'pass' || /cline[-_ ]?pass|clinepass|subscription/.test(searchable);
  const isFree = !isClinePass && /(^|[:/_-])free($|[:/_-])|free[-_ ]model/.test(searchable);
  const classification = isClinePass ? 'cline-pass' : isFree ? 'free-model' : 'usage-billed';
  return { provider, model, isClinePass, isFree, classification, billingMode: isClinePass ? 'subscription' : isFree ? 'free' : 'recorded-charge' };
}

function sumUsage(items) {
  return items.reduce((total, item) => {
    const info = accountModelInfo(item);
    const promptTokens = nonNegativeNumberOrZero(item.promptTokens);
    const completionTokens = nonNegativeNumberOrZero(item.completionTokens);
    const cachedTokens = nonNegativeNumberOrZero(item.cachedTokens);
    const totalTokens = nonNegativeNumberOrZero(item.totalTokens) || promptTokens + completionTokens;
    const referenceCostValue = finiteNumber(item.costUsd);
    const referenceCostKnown = referenceCostValue !== null && referenceCostValue >= 0;
    const referenceCostUsd = (referenceCostKnown ? referenceCostValue : 0) / REFERENCE_COST_USD_SCALE;
    const creditsUsed = finiteNumber(item.creditsUsed);
    const creditsUsedKnown = creditsUsed !== null && creditsUsed >= 0;
    const creditsUsedUsd = (creditsUsedKnown ? creditsUsed : 0) / MICRO_USD;
    return {
      requests: total.requests + 1,
      promptTokens: total.promptTokens + promptTokens,
      completionTokens: total.completionTokens + completionTokens,
      cachedTokens: total.cachedTokens + cachedTokens,
      totalTokens: total.totalTokens + totalTokens,
      referenceCostUsd: total.referenceCostUsd + referenceCostUsd,
      creditsUsedUsd: total.creditsUsedUsd + creditsUsedUsd,
      clinePassRequests: total.clinePassRequests + (info.isClinePass ? 1 : 0),
      usageBillingRequests: total.usageBillingRequests + (info.classification === 'usage-billed' ? 1 : 0),
      freeRequests: total.freeRequests + (info.isFree ? 1 : 0),
      clinePassReferenceCostUsd: total.clinePassReferenceCostUsd + (info.isClinePass ? referenceCostUsd : 0),
      usageBillingReferenceCostUsd: total.usageBillingReferenceCostUsd + (info.classification === 'usage-billed' ? referenceCostUsd : 0),
      clinePassCreditsUsedUsd: total.clinePassCreditsUsedUsd + (info.isClinePass ? creditsUsedUsd : 0),
      usageBillingCreditsUsedUsd: total.usageBillingCreditsUsedUsd + (info.classification === 'usage-billed' ? creditsUsedUsd : 0),
      referenceCostKnownCalls: total.referenceCostKnownCalls + (referenceCostKnown ? 1 : 0),
      referenceCostMissingCalls: total.referenceCostMissingCalls + (referenceCostKnown ? 0 : 1),
      // The usage endpoint reports reference cost and credits, not a settlement/charge receipt.
      // Keep this null rather than turning a positive ClinePass reference value into a charge.
      actualChargeUsd: null,
      chargeCoverage: 'not-provided',
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
    freeRequests: 0,
    clinePassReferenceCostUsd: 0,
    usageBillingReferenceCostUsd: 0,
    clinePassCreditsUsedUsd: 0,
    usageBillingCreditsUsedUsd: 0,
    referenceCostKnownCalls: 0,
    referenceCostMissingCalls: 0,
    actualChargeUsd: null,
    chargeCoverage: 'not-provided',
  });
}

function periodCompleteness(periodStart, periodEnd, windowStart, windowEnd, currentPeriod = false) {
  if (windowStart === null) return { complete: null, completeness: 'unknown' };
  const coveredStart = windowStart === null || periodStart >= windowStart;
  const coveredEnd = windowEnd === null || periodEnd <= windowEnd;
  const complete = coveredStart && coveredEnd && !currentPeriod;
  return { complete, completeness: complete ? 'complete' : 'incomplete' };
}

function periodSummary(items, label, from, to, periodStart, periodEnd, windowStart, windowEnd, currentPeriod = false) {
  return {
    label,
    from,
    to,
    periodStart: periodStart === null ? null : new Date(periodStart).toISOString(),
    periodEnd: periodEnd === null ? null : new Date(periodEnd).toISOString(),
    windowStart: windowStart === null ? null : new Date(windowStart).toISOString(),
    windowEnd: windowEnd === null ? null : new Date(windowEnd).toISOString(),
    ...periodCompleteness(periodStart, periodEnd, windowStart, windowEnd, currentPeriod),
    ...sumUsage(items),
  };
}

function weekRange(weekKey) {
  const start = Date.parse(`${weekKey}T00:00:00.000Z`);
  return { start, end: addUtcDays(start, 7) - 1 };
}

function monthRange(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  const start = Date.UTC(year, month - 1, 1);
  const end = Date.UTC(year, month, 1) - 1;
  return { start, end };
}

export function buildPeriods(usages, now = new Date(), { windowStart = null, windowEnd = null } = {}) {
  const nowTimestamp = parseTimestamp(now);
  const nowDate = nowTimestamp === null ? new Date() : new Date(nowTimestamp);
  const end = parseTimestamp(windowEnd) ?? nowDate.getTime();
  const start = parseTimestamp(windowStart);
  const referenceDate = new Date(end);
  const todayKey = dateKey(end);
  const rollingStart = end - 7 * DAY_MS;
  const monthStart = Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), 1);
  const dailyMap = new Map();
  const weeklyMap = new Map();
  const monthlyMap = new Map();
  const valid = [];
  for (const item of usages ?? []) {
    const timestamp = parseTimestamp(item?.createdAt);
    if (timestamp === null || timestamp > end || (start !== null && timestamp < start)) continue;
    valid.push(item);
    const date = utcDateKey(item.createdAt);
    const week = utcWeekKey(item.createdAt);
    const month = utcMonthKey(item.createdAt);
    for (const [map, key] of [[dailyMap, date], [weeklyMap, week], [monthlyMap, month]]) {
      if (!key) continue;
      const rows = map.get(key) ?? [];
      rows.push(item);
      map.set(key, rows);
    }
  }
  const current = (items) => items.filter((item) => {
    const timestamp = parseTimestamp(item.createdAt);
    return timestamp !== null && timestamp <= end;
  });
  const todayStart = dayStartUtc(end);
  const todayEnd = addUtcDays(todayStart, 1) - 1;
  const daily = [...dailyMap.entries()].sort(([a], [b]) => b.localeCompare(a)).slice(0, 14).map(([date, rows]) => {
    const periodStart = Date.parse(`${date}T00:00:00.000Z`);
    const periodEnd = addUtcDays(periodStart, DAY_MS) - 1;
    return periodSummary(rows, 'day', date, date, periodStart, periodEnd, start, end, periodStart === todayStart);
  });
  const weekly = [...weeklyMap.entries()].sort(([a], [b]) => b.localeCompare(a)).slice(0, 8).map(([week, rows]) => {
    const range = weekRange(week);
    const weekEndKey = dateKey(range.end);
    return periodSummary(rows, 'week', week, weekEndKey, range.start, range.end, start, end, range.end >= end);
  });
  const monthly = [...monthlyMap.entries()].sort(([a], [b]) => b.localeCompare(a)).slice(0, 12).map(([month, rows]) => {
    const range = monthRange(month);
    return periodSummary(rows, 'month', `${month}-01`, dateKey(range.end), range.start, range.end, start, end, range.end >= end);
  });
  return {
    today: periodSummary(current(valid).filter((item) => utcDateKey(item.createdAt) === todayKey), 'day', todayKey, todayKey, todayStart, todayEnd, start, end, true),
    last7Days: periodSummary(current(valid).filter((item) => parseTimestamp(item.createdAt) >= rollingStart), 'rolling-7-days', dateKey(rollingStart), todayKey, rollingStart, end, start, end, true),
    currentMonth: periodSummary(current(valid).filter((item) => parseTimestamp(item.createdAt) >= monthStart), 'calendar-month', dateKey(monthStart), todayKey, monthStart, end, start, end, true),
    daily,
    weekly,
    monthly,
  };
}

function modelSummaries(usages) {
  const grouped = new Map();
  for (const item of usages) {
    const info = accountModelInfo(item);
    const key = `${info.provider}|${info.model}`;
    const row = grouped.get(key) ?? {
      provider: info.provider,
      model: info.model,
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      referenceCostUsd: 0,
      creditsUsedUsd: 0,
      rateKnown: true,
      billingMode: info.billingMode,
      classification: info.classification,
      clinePassReferenceCostUsd: 0,
      usageBillingReferenceCostUsd: 0,
      referenceCostKnownCalls: 0,
      referenceCostMissingCalls: 0,
      actualChargeUsd: null,
    };
    const promptTokens = nonNegativeNumberOrZero(item.promptTokens);
    const completionTokens = nonNegativeNumberOrZero(item.completionTokens);
    const totalTokens = nonNegativeNumberOrZero(item.totalTokens) || promptTokens + completionTokens;
    const referenceCostValue = finiteNumber(item.costUsd);
    const referenceCostKnown = referenceCostValue !== null && referenceCostValue >= 0;
    const referenceCostUsd = (referenceCostKnown ? referenceCostValue : 0) / REFERENCE_COST_USD_SCALE;
    const creditsUsed = finiteNumber(item.creditsUsed);
    const creditsUsedKnown = creditsUsed !== null && creditsUsed >= 0;
    const creditsUsedUsd = (creditsUsedKnown ? creditsUsed : 0) / MICRO_USD;
    row.calls += 1;
    row.promptTokens += promptTokens;
    row.completionTokens += completionTokens;
    row.cachedTokens += nonNegativeNumberOrZero(item.cachedTokens);
    row.totalTokens += totalTokens;
    row.referenceCostUsd += referenceCostUsd;
    row.creditsUsedUsd += creditsUsedUsd;
    row.clinePassReferenceCostUsd += info.isClinePass ? referenceCostUsd : 0;
    row.usageBillingReferenceCostUsd += info.classification === 'usage-billed' ? referenceCostUsd : 0;
    row.referenceCostKnownCalls += referenceCostKnown ? 1 : 0;
    row.referenceCostMissingCalls += referenceCostKnown ? 0 : 1;
    if (row.billingMode !== info.billingMode) row.billingMode = 'mixed';
    if (row.classification !== info.classification) row.classification = 'mixed';
    grouped.set(key, row);
  }
  return [...grouped.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

export function summarizeClineAccount(data, now = new Date(), options = {}) {
  const windowStart = options.windowStart ?? data.windowStart ?? data.window?.start ?? null;
  const windowEnd = options.windowEnd ?? data.windowEnd ?? data.window?.end ?? null;
  let start = parseTimestamp(windowStart);
  const requestedEnd = parseTimestamp(windowEnd);
  const referenceNow = parseTimestamp(now) ?? Date.now();
  // Even an unbounded fetch is a point-in-time account view: rows after `now` are never
  // part of the total. The CLI normally supplies an explicit end as well.
  const end = requestedEnd ?? referenceNow;
  if (start === null && Number.isFinite(Number(options.days)) && Number(options.days) > 0) start = end - Math.floor(Number(options.days)) * DAY_MS;
  const filtered = filterUsageWindow(data.usages ?? [], { windowStart: start, windowEnd: end });
  const usages = filtered.items;
  const summary = sumUsage(usages);
  const balanceUsd = finiteNumberOrZero(data.balance?.balance) / MICRO_USD;
  const windowDays = start !== null && end !== null ? Math.max(0, (end - start) / DAY_MS) : null;
  const history = data.history ?? {};
  return {
    userId: data.userId,
    accountCreatedAt: data.profile?.createdAt ?? null,
    windowStart: isoTimestamp(start),
    windowEnd: isoTimestamp(end),
    windowDays,
    historyDays: windowDays,
    window: { start: isoTimestamp(start), end: isoTimestamp(end), days: windowDays, timeZone: 'UTC', exact: true, complete: history.complete !== false && filtered.invalidTimestamps === 0 },
    history: {
      ...history,
      start: isoTimestamp(start),
      end: isoTimestamp(end),
      exact: true,
      complete: history.complete !== false && filtered.invalidTimestamps === 0,
      returnedRows: usages.length,
      invalidTimestamps: filtered.invalidTimestamps,
      excludedBeforeWindow: filtered.excludedBefore,
      excludedAfterWindow: filtered.excludedAfter,
    },
    requests: summary.requests,
    tokenTotals: { promptTokens: summary.promptTokens, completionTokens: summary.completionTokens, cachedTokens: summary.cachedTokens, totalTokens: summary.totalTokens },
    billingTotals: {
      referenceCostUsd: summary.referenceCostUsd,
      creditsUsedUsd: summary.creditsUsedUsd,
      balanceUsd,
      costBasis: 'api-reference-cost-and-credits',
      rateCalculatedCostUsd: null,
      apiEquivalentEstimateUsd: null,
      subscriptionCashSpendUsd: null,
      creditsConsumed: null,
      actualChargeUsd: null,
      actualChargeCoverage: 'not-provided',
      clinePassReferenceCostUsd: summary.clinePassReferenceCostUsd,
      usageBillingReferenceCostUsd: summary.usageBillingReferenceCostUsd,
      clinePassCreditsUsedUsd: summary.clinePassCreditsUsedUsd,
      usageBillingCreditsUsedUsd: summary.usageBillingCreditsUsedUsd,
      referenceCostCoverage: summary.referenceCostMissingCalls === 0 ? 'complete' : 'partial',
      referenceCostKnownCalls: summary.referenceCostKnownCalls,
      referenceCostMissingCalls: summary.referenceCostMissingCalls,
    },
    plan: data.plan?.plan ? { id: data.plan.plan.id, name: data.plan.plan.name, type: data.plan.plan.type, active: data.plan.plan.isActive, periodEnd: data.plan.currentPeriodEnd ?? null } : null,
    usageLimits: Array.isArray(data.usageLimits?.limits) ? data.usageLimits.limits : [],
    clinePassRequests: summary.clinePassRequests,
    usageBillingRequests: summary.usageBillingRequests,
    freeRequests: summary.freeRequests,
    clinePassReferenceCostUsd: summary.clinePassReferenceCostUsd,
    usageBillingReferenceCostUsd: summary.usageBillingReferenceCostUsd,
    actualChargeUsd: null,
    models: modelSummaries(usages),
    periods: buildPeriods(usages, now, { windowStart: start, windowEnd: end }),
    pages: data.pages,
    completeness: {
      history: history.complete !== false && filtered.invalidTimestamps === 0,
      windowExact: true,
      invalidTimestamps: filtered.invalidTimestamps,
      futureRowsExcluded: filtered.excludedAfter,
    },
  };
}
