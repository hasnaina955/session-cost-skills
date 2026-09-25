export const SCHEMA_VERSION = 1;

export function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function emptyMetrics() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    calls: 0,
    pricedCalls: 0,
    unpricedCalls: 0,
    lastTs: 0,
    models: new Map(),
  };
}

export function addUsage(target, metrics, modelInfo) {
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    target[field] += num(metrics[field]);
  }
  target.calls += 1;
  target.lastTs = Math.max(target.lastTs, num(metrics.ts));
  const hasCost = typeof metrics.cost === 'number' && Number.isFinite(metrics.cost);
  if (hasCost) {
    target.cost += metrics.cost;
    target.pricedCalls += 1;
  } else {
    target.unpricedCalls += 1;
  }

  const provider = modelInfo?.provider ?? 'unknown';
  const model = modelInfo?.id ?? 'unknown';
  const key = `${provider}|${model}`;
  const group = target.models.get(key) ?? { provider, model, ...emptyMetrics() };
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) group[field] += num(metrics[field]);
  group.calls += 1;
  if (hasCost) { group.cost += metrics.cost; group.pricedCalls += 1; }
  else group.unpricedCalls += 1;
  target.models.set(key, group);
  return target;
}

export function combineMetrics(target, source) {
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cost', 'calls', 'pricedCalls', 'unpricedCalls', 'lastTs']) {
    target[field] += num(source[field]);
  }
  for (const [key, group] of source.models ?? new Map()) {
    const combined = target.models.get(key) ?? { provider: group.provider, model: group.model, ...emptyMetrics() };
    for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cost', 'calls', 'pricedCalls', 'unpricedCalls', 'lastTs']) {
      combined[field] += num(group[field]);
    }
    target.models.set(key, combined);
  }
  return target;
}

export function usageSummary(metrics) {
  const freshInputTokens = Math.max(0, num(metrics.inputTokens) - num(metrics.cacheReadTokens) - num(metrics.cacheWriteTokens));
  const totalTokens = num(metrics.inputTokens) + num(metrics.outputTokens);
  return {
    totalTokens,
    inputTokens: num(metrics.inputTokens),
    freshInputTokens,
    cacheReadTokens: num(metrics.cacheReadTokens),
    cacheWriteTokens: num(metrics.cacheWriteTokens),
    outputTokens: num(metrics.outputTokens),
    cacheHitRate: num(metrics.inputTokens) ? num(metrics.cacheReadTokens) / num(metrics.inputTokens) : 0,
  };
}

function modelClass(model) {
  const id = String(model.model ?? model.id ?? '').toLowerCase();
  const provider = String(model.provider ?? '').toLowerCase();
  if (id.includes(':free') || id.startsWith('cline-free/') || id.endsWith('/free')) return 'free-model';
  if (provider === 'cline-pass' || id.startsWith('cline-pass/')) return 'cline-pass';
  return 'unknown';
}

export function classifyBilling(metrics) {
  if (!metrics.calls) {
    return { classification: 'no-calls', label: 'No calls', evidence: 'The session contains no recorded LLM calls.', currency: 'USD', recordedCostUsd: 0, coverage: 'no-calls' };
  }

  const models = [...(metrics.models?.values?.() ?? [])];
  const modelClasses = new Set(models.map(modelClass));
  const hasPositiveRecordedCost = num(metrics.cost) > 0;
  const allCallsHaveCost = metrics.unpricedCalls === 0;
  const noCallsHaveCost = metrics.pricedCalls === 0;

  if (allCallsHaveCost && hasPositiveRecordedCost) {
    return { classification: 'usage-billed', label: 'Usage billed', evidence: `${metrics.pricedCalls}/${metrics.calls} calls contain a positive recorded cost.`, currency: 'USD', recordedCostUsd: num(metrics.cost), coverage: 'complete' };
  }
  if (noCallsHaveCost && modelClasses.size === 1 && modelClasses.has('free-model')) {
    return { classification: 'free-model', label: 'Free model', evidence: `All ${metrics.calls} calls used a model identified as free and no call has a recorded charge.`, currency: 'USD', recordedCostUsd: 0, coverage: 'not-recorded' };
  }
  if (noCallsHaveCost && modelClasses.size === 1 && modelClasses.has('cline-pass')) {
    return { classification: 'cline-pass-included', label: 'ClinePass included', evidence: `All ${metrics.calls} calls used a ClinePass model and no call has a separately recorded charge.`, currency: 'USD', recordedCostUsd: 0, coverage: 'not-recorded' };
  }
  if (noCallsHaveCost && modelClasses.size === 1 && modelClasses.has('unknown')) {
    return { classification: 'cost-unavailable', label: 'Cost unavailable', evidence: 'Cline did not record per-call cost and the provider/model cannot be classified as included or free.', currency: 'USD', recordedCostUsd: null, coverage: 'not-recorded' };
  }
  if (noCallsHaveCost && modelClasses.size > 1 && [...modelClasses].every((item) => item === 'free-model' || item === 'cline-pass')) {
    return { classification: 'mixed-billing', label: 'Mixed included/free', evidence: 'The session used a mix of ClinePass and/or free models with no separately recorded charge.', currency: 'USD', recordedCostUsd: 0, coverage: 'not-recorded' };
  }
  if (metrics.pricedCalls > 0 && metrics.unpricedCalls > 0) {
    return { classification: 'partial-cost', label: 'Partial cost', evidence: `${metrics.pricedCalls}/${metrics.calls} calls contain cost; ${metrics.unpricedCalls} do not.`, currency: 'USD', recordedCostUsd: num(metrics.cost), coverage: 'partial' };
  }
  if (allCallsHaveCost && !hasPositiveRecordedCost) {
    const className = modelClasses.size === 1 ? [...modelClasses][0] : 'unknown';
    const classification = className === 'free-model' ? 'free-model' : className === 'cline-pass' ? 'cline-pass-included' : 'included-or-free';
    return { classification, label: classification === 'free-model' ? 'Free model' : classification === 'cline-pass-included' ? 'ClinePass included' : 'Included/free', evidence: `All calls have a numeric recorded cost of zero across classification "${className}".`, currency: 'USD', recordedCostUsd: 0, coverage: 'complete' };
  }
  return { classification: 'cost-unavailable', label: 'Cost unavailable', evidence: 'Billing classification is incomplete.', currency: 'USD', recordedCostUsd: null, coverage: 'unavailable' };
}

const ACTIVE_CLINE_STATES = new Set(['idle', 'running', 'pending']);

export function resolveSession(rows, { explicitId, environment = {}, ancestorPids = [], logSessionId = null } = {}) {
  const byId = new Map(rows.map((row) => [row.session_id, row]));
  const explicit = explicitId ?? environment.CLINE_SESSION_ID ?? environment.CLINE_SESSION_ULID ?? environment.CLINE_ULID ?? null;
  if (explicit) {
    if (!byId.has(explicit)) {
      return { row: null, method: 'explicit', requestedId: explicit, ambiguousCandidates: [], error: `unknown session id: ${explicit}` };
    }
    return { row: byId.get(explicit), method: explicitId ? 'explicit' : 'environment', requestedId: explicit, ambiguousCandidates: [] };
  }

  if (logSessionId && byId.has(logSessionId)) {
    return { row: byId.get(logSessionId), method: 'runtime-context', requestedId: logSessionId, ambiguousCandidates: [] };
  }

  const roots = rows.filter((row) => !row.parent_session_id);
  const activeRoots = roots
    .filter((row) => ACTIVE_CLINE_STATES.has(String(row.status ?? '').toLowerCase()))
    .sort((left, right) => Date.parse(right.started_at) - Date.parse(left.started_at));
  if (activeRoots.length === 1) {
    return { row: activeRoots[0], method: 'unique-active-root', requestedId: null, ambiguousCandidates: [] };
  }
  const pids = new Set(ancestorPids.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0));
  const pidMatches = activeRoots.filter((row) => pids.has(Number(row.pid)));
  if (pidMatches.length === 1) {
    return { row: pidMatches[0], method: 'process-ancestry', requestedId: null, ambiguousCandidates: [] };
  }
  if (activeRoots.length > 1) {
    return {
      row: null,
      method: 'ambiguous-active-root',
      requestedId: null,
      ambiguousCandidates: activeRoots.map((row) => row.session_id),
      error: `multiple active Cline root sessions exist (${activeRoots.map((row) => `${row.session_id}:${row.status}`).join(', ')}); pass --session to select one`,
    };
  }

  const recent = [...roots].sort((left, right) => Date.parse(right.started_at) - Date.parse(left.started_at));
  const latest = recent[0] ?? null;
  return {
    row: latest,
    method: 'latest-root-fallback',
    requestedId: null,
    ambiguousCandidates: recent.slice(0, 2).map((row) => row.session_id),
    warning: 'no active root session was discoverable; selected the latest root session',
  };
}

export function coverage(metrics) {
  if (!metrics.calls) return 'no calls';
  if (metrics.unpricedCalls === 0) return 'complete';
  if (metrics.pricedCalls === 0) return 'not recorded';
  return `partial (${metrics.unpricedCalls}/${metrics.calls} calls lack cost)`;
}


