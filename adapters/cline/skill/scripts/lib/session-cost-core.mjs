export const SCHEMA_VERSION = 1;

export function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function emptyMetrics() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    referenceCost: 0,
    calls: 0,
    pricedCalls: 0,
    unpricedCalls: 0,
    // A normal message ledger has an exact call count. Aggregate metadata often does not.
    callsKnown: true,
    callCountKnown: true,
    ledgerStatus: null,
    // `null` means that the source did not establish a cost, not that the cost was zero.
    aggregateCostUsd: null,
    lastTs: 0,
    models: new Map(),
  };
}

export function addUsage(target, metrics, modelInfo) {
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    target[field] = num(target[field]) + num(metrics[field]);
  }
  target.calls = num(target.calls) + 1;
  target.callsKnown = true;
  target.callCountKnown = true;
  target.ledgerStatus = 'messages';
  target.lastTs = Math.max(num(target.lastTs), num(metrics.ts));
  const hasCost = finiteNumber(metrics.cost) !== null;
  if (hasCost) {
    target.cost += finiteNumber(metrics.cost);
    target.pricedCalls = num(target.pricedCalls) + 1;
  } else {
    target.unpricedCalls = num(target.unpricedCalls) + 1;
  }

  const referenceCost = finiteNumber(metrics.referenceCostUsd ?? metrics.referenceCost);
  if (referenceCost !== null) target.referenceCost += referenceCost;

  const provider = modelInfo?.provider ?? 'unknown';
  const model = modelInfo?.id ?? 'unknown';
  const key = `${provider}|${model}`;
  const group = target.models.get(key) ?? { provider, model, ...emptyMetrics() };
  if (modelInfo?.billingMode !== undefined) group.billingMode = modelInfo.billingMode;
  if (modelInfo?.isClinePass !== undefined) group.isClinePass = modelInfo.isClinePass;
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) group[field] = num(group[field]) + num(metrics[field]);
  group.calls = num(group.calls) + 1;
  group.callsKnown = true;
  group.callCountKnown = true;
  group.ledgerStatus = 'messages';
  group.lastTs = Math.max(num(group.lastTs), num(metrics.ts));
  if (hasCost) {
    group.cost += finiteNumber(metrics.cost);
    group.pricedCalls = num(group.pricedCalls) + 1;
  } else {
    group.unpricedCalls = num(group.unpricedCalls) + 1;
  }
  if (referenceCost !== null) group.referenceCost += referenceCost;
  target.models.set(key, group);
  return target;
}

export function combineMetrics(target, source) {
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cost', 'referenceCost']) {
    target[field] = num(target[field]) + num(source[field]);
  }
  const callsKnown = target.callsKnown !== false && source.callsKnown !== false;
  target.calls = callsKnown ? num(target.calls) + num(source.calls) : null;
  target.lastTs = Math.max(num(target.lastTs), num(source.lastTs));
  target.callsKnown = callsKnown;
  target.callCountKnown = callsKnown;
  if (source.ledgerStatus === 'unavailable' || target.ledgerStatus === 'unavailable') target.ledgerStatus = 'unavailable';
  else if (source.ledgerStatus === 'aggregate' || target.ledgerStatus === 'aggregate') target.ledgerStatus = 'aggregate';
  else if (source.ledgerStatus === 'messages' || target.ledgerStatus === 'messages') target.ledgerStatus = 'messages';
  if (target.pricedCalls === null || source.pricedCalls === null) {
    target.pricedCalls = null;
    target.unpricedCalls = null;
  } else {
    target.pricedCalls = num(target.pricedCalls) + num(source.pricedCalls);
    target.unpricedCalls = num(target.unpricedCalls) + num(source.unpricedCalls);
  }
  if (source.aggregateCostUsd !== null && source.aggregateCostUsd !== undefined) {
    target.aggregateCostUsd = num(target.aggregateCostUsd) + num(source.aggregateCostUsd);
  }
  if (source.costSource) target.costSource = target.costSource ? (target.costSource === source.costSource ? target.costSource : 'mixed') : source.costSource;
  for (const [key, group] of source.models ?? new Map()) {
    const combined = target.models.get(key) ?? { provider: group.provider, model: group.model, ...emptyMetrics() };
    if (group.billingMode !== undefined) combined.billingMode = group.billingMode;
    if (group.isClinePass !== undefined) combined.isClinePass = group.isClinePass;
    for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cost', 'referenceCost']) {
      combined[field] = num(combined[field]) + num(group[field]);
    }
    const groupCallsKnown = combined.callsKnown !== false && group.callsKnown !== false;
    combined.calls = groupCallsKnown ? num(combined.calls) + num(group.calls) : null;
    combined.lastTs = Math.max(num(combined.lastTs), num(group.lastTs));
    combined.callsKnown = groupCallsKnown;
    combined.callCountKnown = groupCallsKnown;
    if (group.ledgerStatus === 'unavailable' || combined.ledgerStatus === 'unavailable') combined.ledgerStatus = 'unavailable';
    else if (group.ledgerStatus === 'aggregate' || combined.ledgerStatus === 'aggregate') combined.ledgerStatus = 'aggregate';
    else if (group.ledgerStatus === 'messages' || combined.ledgerStatus === 'messages') combined.ledgerStatus = 'messages';
    if (combined.pricedCalls === null || group.pricedCalls === null) {
      combined.pricedCalls = null;
      combined.unpricedCalls = null;
    } else {
      combined.pricedCalls = num(combined.pricedCalls) + num(group.pricedCalls);
      combined.unpricedCalls = num(combined.unpricedCalls) + num(group.unpricedCalls);
    }
    if (group.aggregateCostUsd !== null && group.aggregateCostUsd !== undefined) {
      combined.aggregateCostUsd = num(combined.aggregateCostUsd) + num(group.aggregateCostUsd);
    }
    if (group.costSource) combined.costSource = combined.costSource ? (combined.costSource === group.costSource ? combined.costSource : 'mixed') : group.costSource;
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

export function normalizeSessionStatus(status) {
  const normalized = String(status ?? '').trim().toLowerCase();
  return normalized || 'unknown';
}

export function isActiveSessionStatus(status) {
  return new Set(['running', 'idle', 'pending']).has(normalizeSessionStatus(status));
}

export function isTerminalSessionStatus(status) {
  return !isActiveSessionStatus(status);
}

/**
 * Return a root and every reachable descendant exactly once. The explicit stack/visited set is
 * important for malformed databases containing a parent cycle.
 */
export function descendantIds(rows, rootId) {
  const children = new Map();
  for (const row of rows ?? []) {
    const parent = row?.parent_session_id;
    if (!parent) continue;
    const list = children.get(parent) ?? [];
    list.push(row?.session_id);
    children.set(parent, list);
  }

  const ids = [];
  const seen = new Set();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (id === null || id === undefined || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    const next = children.get(id) ?? [];
    for (let index = next.length - 1; index >= 0; index--) stack.push(next[index]);
  }
  return new Set(ids);
}

function hasSelectedAncestor(row, rowsById, selectedIds) {
  const visited = new Set();
  let parent = row?.parent_session_id;
  while (parent && parent !== row?.session_id && !visited.has(parent)) {
    if (selectedIds.has(parent)) return true;
    visited.add(parent);
    parent = rowsById.get(parent)?.parent_session_id;
  }
  return false;
}

/**
 * Pick task roots from a candidate set. A descendant is suppressed only when one of its ancestors
 * is also in that candidate set; this keeps a child-only date/filter match selectable without ever
 * billing it alongside its parent.
 */
export function topLevelRows(rows, candidates = rows) {
  const candidateRows = [...(candidates ?? [])];
  const selectedIds = new Set(candidateRows.map((row) => row?.session_id));
  const rowsById = new Map((rows ?? []).map((row) => [row?.session_id, row]));
  const roots = candidateRows.filter((row) => !hasSelectedAncestor(row, rowsById, selectedIds));
  // A malformed all-cycle graph still needs one deterministic task candidate rather than an
  // empty report. Normal parent/child graphs never take this fallback.
  return roots.length ? roots : candidateRows.slice(0, 1);
}

export function duplicateSuppressedSessionIds(rows, candidates = rows) {
  const roots = new Set(topLevelRows(rows, candidates).map((row) => row?.session_id));
  return [...new Set((candidates ?? []).map((row) => row?.session_id))].filter((id) => !roots.has(id));
}

function modelClass(model) {
  const id = String(model?.model ?? model?.id ?? '').toLowerCase();
  const provider = String(model?.provider ?? '').toLowerCase();
  const billingMode = String(model?.billingMode ?? model?.billingType ?? '').toLowerCase();
  if (provider === 'cline-pass' || id.startsWith('cline-pass/') || model?.isClinePass === true || billingMode.includes('cline-pass') || billingMode.includes('subscription')) return 'cline-pass';
  if (id.includes(':free') || id.startsWith('cline-free/') || id.endsWith('/free') || billingMode === 'free') return 'free-model';
  return 'unknown';
}

function classificationResult({ classification, label, evidence, recordedCostUsd, coverage, billingMode = 'unknown', referenceCostUsd = null, actualChargeUsd = null, costSource = null }) {
  const aggregate = /aggregate|end-to-end|root-only|usage\.totalcost/i.test(String(costSource ?? '')) || /aggregate/i.test(String(coverage ?? ''));
  return {
    classification,
    label,
    evidence,
    currency: 'USD',
    recordedCostUsd,
    actualChargeUsd,
    referenceCostUsd,
    billingMode,
    chargeClassification: billingMode,
    costSource,
    recordedCostSource: costSource,
    recordedCostCoverage: coverage,
    costBasis: aggregate ? 'cline-aggregate' : costSource ? 'cline-message-ledger' : 'unavailable',
    aggregate,
    callCountKnown: !aggregate && coverage !== 'unavailable',
    rateCalculatedCostUsd: null,
    apiEquivalentEstimateUsd: null,
    subscriptionCashSpendUsd: null,
    creditsConsumed: null,
    coverage,
  };
}

export function classifyBilling(metrics) {
  const callsKnown = metrics.callsKnown !== false && metrics.callCountKnown !== false;
  const calls = callsKnown ? num(metrics.calls) : null;
  const cost = finiteNumber(metrics.cost) ?? 0;
  const aggregateCost = finiteNumber(metrics.aggregateCostUsd);
  const referenceCostUsd = finiteNumber(metrics.referenceCost) ?? (finiteNumber(metrics.referenceCostUsd) ?? null);
  const models = [...(metrics.models?.values?.() ?? [])];
  const modelClasses = new Set(models.map(modelClass));
  const hasPositiveRecordedCost = cost > 0 || (aggregateCost !== null && aggregateCost > 0);
  const allCallsHaveCost = callsKnown && metrics.unpricedCalls === 0;
  const hasUnknownModel = modelClasses.has('unknown');
  const allPass = modelClasses.size > 0 && !hasUnknownModel && [...modelClasses].every((item) => item === 'cline-pass');
  const allFree = modelClasses.size > 0 && !hasUnknownModel && [...modelClasses].every((item) => item === 'free-model');
  const includedAndFree = modelClasses.size > 0 && !hasUnknownModel && [...modelClasses].every((item) => item === 'free-model' || item === 'cline-pass');

  if (!callsKnown && metrics.ledgerStatus === 'unavailable' && aggregateCost === null) {
    return classificationResult({
      classification: 'ledger-unavailable',
      label: 'Ledger unavailable',
      evidence: 'At least one selected session has no readable ledger or aggregate usage, so its calls and cost cannot be established.',
      recordedCostUsd: num(cost) > 0 ? cost : null,
      actualChargeUsd: null,
      referenceCostUsd,
      billingMode: 'unknown',
      costSource: null,
      coverage: num(cost) > 0 ? 'partial; ledger unavailable' : 'unavailable',
    });
  }
  if (!callsKnown) {
    if (allPass) {
      return classificationResult({
        classification: 'cline-pass-included',
        label: 'ClinePass included',
        evidence: 'ClinePass aggregate usage is recorded, but the aggregate source does not expose an exact call count or a separate charge.',
        recordedCostUsd: aggregateCost ?? cost ?? null,
        actualChargeUsd: null,
        referenceCostUsd,
        billingMode: 'subscription',
        costSource: metrics.costSource ?? 'aggregate',
        coverage: 'aggregate; call count unavailable',
      });
    }
    if (allFree) {
      return classificationResult({
        classification: 'free-model',
        label: 'Free model',
        evidence: 'Aggregate usage identifies free models; the aggregate source does not expose an exact call count.',
        recordedCostUsd: aggregateCost ?? cost ?? null,
        actualChargeUsd: null,
        referenceCostUsd,
        billingMode: 'free',
        costSource: metrics.costSource ?? 'aggregate',
        coverage: 'aggregate; call count unavailable',
      });
    }
    if (hasPositiveRecordedCost) {
      return classificationResult({
        classification: 'usage-billed',
        label: 'Usage billed',
        evidence: 'A positive aggregate cost is recorded; the aggregate source does not expose an exact call count.',
        recordedCostUsd: aggregateCost ?? cost,
        actualChargeUsd: aggregateCost ?? cost,
        referenceCostUsd,
        billingMode: 'recorded-charge',
        costSource: metrics.costSource ?? 'aggregate',
        coverage: 'aggregate; call count unavailable',
      });
    }
    return classificationResult({
      classification: 'cost-unavailable',
      label: 'Cost unavailable',
      evidence: 'Aggregate usage has no reliable call count or billing evidence; zero aggregate cost is not treated as included.',
      recordedCostUsd: aggregateCost ?? null,
      actualChargeUsd: null,
      referenceCostUsd,
      billingMode: 'unknown',
      costSource: metrics.costSource ?? 'aggregate',
      coverage: 'aggregate; call count unavailable',
    });
  }

  if (!calls) {
    if (metrics.ledgerStatus === 'unavailable' || metrics.knownZeroCall === false) {
      return classificationResult({
        classification: 'ledger-unavailable',
        label: 'Ledger unavailable',
        evidence: 'The session exists, but no readable message ledger or aggregate usage establishes its calls or cost.',
        recordedCostUsd: null,
        actualChargeUsd: null,
        referenceCostUsd,
        billingMode: 'unknown',
        costSource: null,
        coverage: 'unavailable',
      });
    }
    return classificationResult({
      classification: 'no-calls',
      label: 'No calls',
      evidence: 'The session contains no recorded LLM calls.',
      recordedCostUsd: aggregateCost ?? 0,
      actualChargeUsd: 0,
      referenceCostUsd,
      billingMode: 'none',
      costSource: metrics.costSource ?? null,
      coverage: 'no-calls',
    });
  }

  if (allPass) {
    return classificationResult({
      classification: 'cline-pass-included',
      label: 'ClinePass included',
      evidence: hasPositiveRecordedCost
        ? 'ClinePass is a subscription mode; any positive value is retained as recorded/reference cost and is not labeled an extra usage charge.'
        : 'All calls used a ClinePass model; no separate usage charge is evidenced.',
      recordedCostUsd: aggregateCost ?? (allCallsHaveCost || metrics.pricedCalls > 0 ? cost : null),
      actualChargeUsd: null,
      referenceCostUsd,
      billingMode: 'subscription',
      costSource: metrics.costSource ?? (allCallsHaveCost ? 'messages' : null),
      coverage: allCallsHaveCost ? 'complete' : metrics.pricedCalls > 0 ? `partial (${metrics.unpricedCalls}/${calls} calls lack cost)` : 'not-recorded',
    });
  }
  if (allFree) {
    return classificationResult({
      classification: 'free-model',
      label: 'Free model',
      evidence: 'All calls used a model identified as free; no separate usage charge is evidenced.',
      recordedCostUsd: aggregateCost ?? (allCallsHaveCost ? cost : null),
      actualChargeUsd: allCallsHaveCost ? cost : null,
      referenceCostUsd,
      billingMode: 'free',
      costSource: metrics.costSource ?? (allCallsHaveCost ? 'messages' : null),
      coverage: allCallsHaveCost ? 'complete' : metrics.unpricedCalls ? `partial (${metrics.unpricedCalls}/${calls} lack cost)` : 'not-recorded',
    });
  }
  if (includedAndFree || (modelClasses.size > 1 && (modelClasses.has('cline-pass') || modelClasses.has('free-model')))) {
    return classificationResult({
      classification: 'mixed-billing',
      label: 'Mixed included/free',
      evidence: 'The session used a mix of ClinePass, free, and/or unknown models; reference or subscription value is not an extra usage charge.',
      recordedCostUsd: allCallsHaveCost ? cost : (metrics.pricedCalls > 0 ? cost : null),
      actualChargeUsd: null,
      referenceCostUsd,
      billingMode: 'mixed-included',
      costSource: metrics.costSource ?? (allCallsHaveCost ? 'messages' : null),
      coverage: allCallsHaveCost ? 'complete' : metrics.pricedCalls > 0 ? `partial (${metrics.unpricedCalls}/${calls} lack cost)` : 'not-recorded',
    });
  }
  if (hasPositiveRecordedCost && (allCallsHaveCost || metrics.pricedCalls > 0)) {
    return classificationResult({
      classification: metrics.unpricedCalls > 0 ? 'partial-cost' : 'usage-billed',
      label: metrics.unpricedCalls > 0 ? 'Partial cost' : 'Usage billed',
      evidence: metrics.unpricedCalls > 0
        ? `${metrics.pricedCalls}/${calls} calls contain a positive recorded cost; ${metrics.unpricedCalls} do not.`
        : `${metrics.pricedCalls}/${calls} calls contain a positive recorded cost.`,
      recordedCostUsd: cost,
      actualChargeUsd: cost,
      referenceCostUsd,
      billingMode: 'recorded-charge',
      costSource: metrics.costSource ?? 'messages',
      coverage: metrics.unpricedCalls > 0 ? 'partial' : 'complete',
    });
  }
  if (metrics.pricedCalls > 0 && metrics.unpricedCalls > 0) {
    return classificationResult({
      classification: 'partial-cost',
      label: 'Partial cost',
      evidence: `${metrics.pricedCalls}/${calls} calls contain cost; ${metrics.unpricedCalls} do not.`,
      recordedCostUsd: cost,
      actualChargeUsd: cost,
      referenceCostUsd,
      billingMode: 'recorded-charge',
      costSource: metrics.costSource ?? 'messages',
      coverage: 'partial',
    });
  }
  if (allCallsHaveCost && !hasPositiveRecordedCost) {
    // Numeric zero is evidence of a recorded zero only. It is not evidence that an unknown
    // provider/model is free or covered by a subscription.
    if (hasUnknownModel) {
      return classificationResult({
        classification: 'cost-unavailable',
        label: 'Cost unavailable',
        evidence: 'All calls contain numeric zero, but the provider/model is unknown; inclusion cannot be inferred from zero.',
        recordedCostUsd: 0,
        actualChargeUsd: null,
        referenceCostUsd,
        billingMode: 'unknown',
        costSource: metrics.costSource ?? 'messages',
        coverage: 'complete',
      });
    }
    return classificationResult({
      classification: 'cost-unavailable',
      label: 'Cost unavailable',
      evidence: 'All calls contain numeric zero, but no reliable provider billing mode is available.',
      recordedCostUsd: 0,
      actualChargeUsd: null,
      referenceCostUsd,
      billingMode: 'unknown',
      costSource: metrics.costSource ?? 'messages',
      coverage: 'complete-but-unclassified',
    });
  }
  return classificationResult({
    classification: 'cost-unavailable',
    label: 'Cost unavailable',
    evidence: 'Billing classification is incomplete; zero is not used to guess inclusion.',
    recordedCostUsd: null,
    actualChargeUsd: null,
    referenceCostUsd,
    billingMode: 'unknown',
    costSource: metrics.costSource ?? null,
    coverage: metrics.pricedCalls === 0 ? 'not-recorded' : 'unavailable',
  });
}

function topLevelForResolution(rows, candidates) {
  const byId = new Map(rows.map((row) => [row.session_id, row]));
  const candidateIds = new Set(candidates.map((row) => row.session_id));
  return candidates.filter((row) => {
    const parent = row.parent_session_id;
    if (!parent || parent === row.session_id) return true;
    if (candidateIds.has(parent)) return false;
    let cursor = byId.get(parent)?.parent_session_id;
    const seen = new Set();
    while (cursor && !seen.has(cursor)) {
      if (candidateIds.has(cursor)) return false;
      seen.add(cursor);
      cursor = byId.get(cursor)?.parent_session_id;
    }
    return true;
  });
}

function activeTaskRoot(row, rows) {
  const byId = new Map(rows.map((item) => [item.session_id, item]));
  const visited = new Set();
  let current = row;
  let root = row;
  while (current && !visited.has(current.session_id)) {
    visited.add(current.session_id);
    const parent = current.parent_session_id ? byId.get(current.parent_session_id) : null;
    if (!parent) break;
    if (isActiveSessionStatus(parent.status)) root = parent;
    current = parent;
  }
  return root;
}

function activeRows(rows) {
  return rows.filter((row) => isActiveSessionStatus(row.status));
}

export function resolveSession(rows = [], { explicitId, environment = {}, ancestorPids = [], logSessionId = null } = {}) {
  const sourceRows = [...rows];
  const byId = new Map(sourceRows.map((row) => [row.session_id, row]));
  const explicitValue = explicitId ?? environment.CLINE_SESSION_ID ?? environment.CLINE_SESSION_ULID ?? environment.CLINE_ULID ?? null;
  const explicit = explicitValue === null || explicitValue === undefined ? null : String(explicitValue).trim();
  if (explicit) {
    if (!byId.has(explicit)) {
      return { row: null, method: explicitId ? 'explicit' : 'environment', requestedId: explicit, known: false, ambiguousCandidates: [], error: `unknown session id: ${explicit}`, warning: null };
    }
    return { row: byId.get(explicit), method: explicitId ? 'explicit' : 'environment', requestedId: explicit, known: true, ambiguousCandidates: [], warning: null };
  }

  const pids = new Set(ancestorPids.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0));
  const pidRows = sourceRows.filter((row) => pids.has(Number(row.pid)));
  const activePidRows = activeRows(pidRows);
  const pidCandidates = [...new Map(activePidRows.map((row) => [activeTaskRoot(row, sourceRows).session_id, activeTaskRoot(row, sourceRows)])).values()];
  if (pidCandidates.length === 1) {
    const selected = pidCandidates[0];
    const promoted = !activePidRows.some((row) => row.session_id === selected.session_id);
    return { row: selected, method: promoted ? 'process-ancestry-root' : 'process-ancestry', requestedId: null, known: true, ambiguousCandidates: [], warning: promoted ? 'the process matched a child session; selected its active task root' : null };
  }
  if (pidCandidates.length > 1) {
    return { row: null, method: 'process-ancestry', requestedId: null, known: null, ambiguousCandidates: pidCandidates.map((row) => row.session_id), error: 'multiple active session rows match the Cline process ancestry', warning: 'multiple active process matches; pass --session to select one' };
  }

  const normalizedLogId = logSessionId === null || logSessionId === undefined ? null : String(logSessionId);
  if (normalizedLogId && byId.has(normalizedLogId)) {
    const logRow = byId.get(normalizedLogId);
    if (isActiveSessionStatus(logRow.status)) {
      const logRoot = activeTaskRoot(logRow, sourceRows);
      const activeRoots = topLevelForResolution(sourceRows, activeRows(sourceRows));
      const ambiguous = activeRoots.length > 1;
      return {
        row: logRoot,
        method: 'log-context',
        requestedId: normalizedLogId,
        known: true,
        ambiguousCandidates: ambiguous ? activeRoots.map((row) => row.session_id) : [],
        warning: [logRoot.session_id !== normalizedLogId ? 'the log matched a child session; selected its active task root' : null, ambiguous ? 'multiple active sessions exist; log context selected one—use --session to choose explicitly' : null].filter(Boolean).join('; ') || null,
      };
    }
  }

  const active = topLevelForResolution(sourceRows, activeRows(sourceRows));
  const sortedActive = [...active].sort((a, b) => (Date.parse(b.started_at) || 0) - (Date.parse(a.started_at) || 0));
  if (sortedActive.length === 1) {
    const only = sortedActive[0];
    return { row: only, method: normalizeSessionStatus(only.status) === 'running' ? 'latest-running' : 'unique-active', requestedId: null, known: true, ambiguousCandidates: [], warning: null };
  }

  const recent = [...sourceRows].sort((a, b) => (Date.parse(b.started_at) || 0) - (Date.parse(a.started_at) || 0));
  const latestActive = sortedActive[0] ?? null;
  const latest = latestActive ?? recent[0] ?? null;
  if (sortedActive.length > 1) {
    const allRunning = sortedActive.every((row) => normalizeSessionStatus(row.status) === 'running');
    return { row: latest, method: allRunning ? 'ambiguous-running' : 'ambiguous-active', requestedId: null, known: true, ambiguousCandidates: sortedActive.map((row) => row.session_id), warning: `${allRunning ? 'multiple running' : 'multiple active'} sessions exist; selected the newest task root—use --session to choose explicitly` };
  }
  const plausible = recent;
  return { row: latest, method: 'latest-started', requestedId: null, known: true, ambiguousCandidates: plausible.map((row) => row.session_id), warning: plausible.length > 1 ? 'multiple sessions are plausible; selected the newest—use --session to choose explicitly' : null };
}

export function coverage(metrics) {
  if (metrics.callsKnown === false || metrics.callCountKnown === false) return 'aggregate (call count unavailable)';
  if (!metrics.calls) return 'no calls';
  if (metrics.unpricedCalls === 0) return 'complete';
  if (metrics.pricedCalls === 0) return 'not recorded';
  return `partial (${metrics.unpricedCalls}/${metrics.calls} calls lack cost)`;
}
