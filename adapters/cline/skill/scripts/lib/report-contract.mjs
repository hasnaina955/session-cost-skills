export const REPORT_CONTRACT_VERSION = '1.0.0';

const unique = (values) => [...new Set((values ?? []).filter((value) => value != null).map(String))];
const finiteOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const isoNow = () => new Date().toISOString();

function normalizeSnapshot(report) {
  const capturedAt = report.snapshot?.capturedAt ?? report.generatedAt ?? isoNow();
  return {
    capturedAt,
    active: Boolean(report.snapshot?.active ?? report.sessionActive ?? false),
    state: report.snapshot?.state ?? (report.sessionActive ? 'snapshot' : 'final'),
    lastLedgerActivityAt: report.snapshot?.lastLedgerActivityAt ?? null,
  };
}

function normalizeSelection(report, selection) {
  const source = selection ?? report.selection ?? {};
  return {
    method: source.method ?? 'unspecified',
    requestedId: source.requestedId ?? null,
    candidateIds: unique(source.candidateIds ?? source.candidates ?? source.ambiguousCandidates),
    warning: source.warning ?? null,
  };
}

function normalizeUsage(usage, semantics) {
  const inputTokens = Number(usage?.inputTokens) || 0;
  const outputTokens = Number(usage?.outputTokens) || 0;
  const cacheReadTokens = Number(usage?.cacheReadTokens) || 0;
  const cacheWriteTokens = Number(usage?.cacheWriteTokens) || 0;
  const totalTokens = Number(usage?.totalTokens) || inputTokens + outputTokens;
  const freshInputTokens = Number(usage?.freshInputTokens)
    ?? (semantics.inputTokenMeaning === 'includes-cache'
      ? Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens)
      : inputTokens);
  return {
    totalTokens,
    inputTokens,
    freshInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    cacheHitRate: Number(usage?.cacheHitRate) || 0,
    semantics,
  };
}

function billingState(report, costBasis) {
  const source = report.billing ?? {};
  if (costBasis === 'runtime-recorded') {
    const amountUsd = finiteOrNull(source.recordedCostUsd)
      ?? finiteOrNull(report.total?.cost)
      ?? (Number(report.total?.calls) === 0 ? 0 : null);
    return {
      basis: costBasis,
      currency: source.currency ?? 'USD',
      amountUsd,
      recordedCostUsd: amountUsd,
      estimatedCostUsd: null,
      rateKnown: source.coverage !== 'unavailable',
      coverage: source.coverage ?? 'unknown',
      classification: source.classification ?? 'unknown',
      label: source.label ?? null,
      evidence: source.evidence ?? null,
    };
  }

  const models = report.models ?? [];
  const knownModels = models.filter((model) => model.rateKnown).length;
  const unknownModels = models.length - knownModels;
  const estimatedCostUsd = report.rateKnown === false ? null : finiteOrNull(report.totalCost);
  const coverage = Number(report.calls) === 0
    ? 'no-calls'
    : estimatedCostUsd === null
      ? knownModels > 0 ? 'partial' : 'unavailable'
      : unknownModels > 0 ? 'partial' : 'complete';
  return {
    basis: costBasis,
    currency: source.currency ?? 'USD',
    amountUsd: estimatedCostUsd,
    recordedCostUsd: null,
    estimatedCostUsd,
    rateKnown: report.rateKnown !== false,
    coverage,
    classification: source.classification ?? (estimatedCostUsd === null ? 'cost-unavailable' : 'rate-estimated'),
    label: source.label ?? null,
    evidence: source.evidence ?? null,
  };
}

function normalizeCoverage(report, billing, usage) {
  const calls = Number(report.total?.calls ?? report.calls) || 0;
  const reasons = [];
  if (billing.coverage === 'partial') reasons.push('some calls or models have no applicable cost');
  if (billing.coverage === 'unavailable') reasons.push('no applicable cost is available');
  if (report.inferredModelRows > 0) reasons.push(`${report.inferredModelRows} call model(s) were inferred`);
  return {
    status: calls === 0 ? 'no-calls' : billing.coverage,
    calls,
    totalTokens: usage.totalTokens,
    unknownReasons: reasons,
  };
}

function normalizeSessionGraph(report) {
  const rootSessionIds = unique(report.rootSessionIds ?? (report.session?.id ? [report.session.id] : []));
  return {
    rootSessionIds,
    includedSessionIds: unique(report.includedSessionIds ?? rootSessionIds),
    excludedSessionIds: unique(report.excludedSessionIds),
    duplicateSuppressedSessionIds: unique(report.duplicateSuppressedSessionIds),
  };
}

export function withNormalizedContract(report, {
  runtime,
  selection = null,
} = {}) {
  if (!runtime?.id || !runtime?.costBasis || !runtime?.storageSource) {
    throw new Error('normalized report runtime metadata is required');
  }
  const snapshot = normalizeSnapshot(report);
  const normalizedSelection = normalizeSelection(report, selection);
  const semantics = {
    inputTokenMeaning: runtime.inputTokenMeaning,
    cacheReadTokensSeparate: true,
    cacheWriteTokensSeparate: true,
    reasoningIncludedInOutput: runtime.reasoningIncludedInOutput,
  };
  const usage = normalizeUsage(report.usage, semantics);
  const billing = billingState(report, runtime.costBasis);
  const coverage = normalizeCoverage(report, billing, usage);
  const sessionGraph = normalizeSessionGraph(report);
  const warnings = unique([
    ...(report.warnings ?? []),
    snapshot.warning ?? null,
    normalizedSelection.warning,
    ...(sessionGraph.excludedSessionIds.length ? [`${sessionGraph.excludedSessionIds.length} descendant session(s) were excluded`] : []),
    ...(sessionGraph.duplicateSuppressedSessionIds.length ? [`${sessionGraph.duplicateSuppressedSessionIds.length} child session selection(s) were duplicate-suppressed`] : []),
    ...coverage.unknownReasons,
  ]);
  const provenance = {
    kind: runtime.provenanceKind,
    source: runtime.provenanceSource,
    rateSources: unique(runtime.rateSources),
  };
  const normalized = {
    ...report,
    schemaVersion: 1,
    contractVersion: REPORT_CONTRACT_VERSION,
    generatedAt: report.generatedAt ?? snapshot.capturedAt,
    runtime: {
      id: runtime.id,
      costBasis: runtime.costBasis,
      storageSource: runtime.storageSource,
    },
    snapshot,
    selection: normalizedSelection,
    usage,
    billing,
    coverage,
    sessionGraph,
    provenance,
    warnings,
  };
  return assertNormalizedReport(normalized);
}

export function assertNormalizedReport(report) {
  const fail = (message) => { throw new Error(`normalized report contract violation: ${message}`); };
  if (report?.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (report?.contractVersion !== REPORT_CONTRACT_VERSION) fail(`contractVersion must be ${REPORT_CONTRACT_VERSION}`);
  if (!Number.isFinite(Date.parse(report?.generatedAt))) fail('generatedAt must be an ISO timestamp');
  if (!['cline', 'mcode'].includes(report?.runtime?.id)) fail('runtime.id is unsupported');
  if (!['runtime-recorded', 'provider-rate-estimate'].includes(report?.runtime?.costBasis)) fail('runtime.costBasis is unsupported');
  if (!report.runtime.storageSource) fail('runtime.storageSource is required');
  if (!Number.isFinite(Date.parse(report?.snapshot?.capturedAt))) fail('snapshot.capturedAt must be an ISO timestamp');
  if (!report.selection?.method) fail('selection.method is required');
  if (!Array.isArray(report.selection.candidateIds)) fail('selection.candidateIds must be an array');
  for (const token of ['totalTokens', 'inputTokens', 'freshInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']) {
    if (!Number.isFinite(report?.usage?.[token]) || report.usage[token] < 0) fail(`usage.${token} must be a nonnegative number`);
  }
  if (!Number.isFinite(report.usage.cacheHitRate) || report.usage.cacheHitRate < 0 || report.usage.cacheHitRate > 1) fail('usage.cacheHitRate must be between 0 and 1');
  if (!report.usage.semantics || !['includes-cache', 'excludes-cache'].includes(report.usage.semantics.inputTokenMeaning)) fail('usage token semantics are required');
  if (!['runtime-recorded', 'provider-rate-estimate'].includes(report?.billing?.basis)) fail('billing.basis is unsupported');
  if (report.billing.amountUsd !== null && (!Number.isFinite(report.billing.amountUsd) || report.billing.amountUsd < 0)) fail('billing.amountUsd must be null or nonnegative');
  if (report.billing.basis === 'runtime-recorded' && report.billing.estimatedCostUsd !== null) fail('recorded reports cannot contain estimatedCostUsd');
  if (report.billing.basis === 'provider-rate-estimate' && report.billing.recordedCostUsd !== null) fail('estimated reports cannot contain recordedCostUsd');
  if (!report.coverage?.status || !Array.isArray(report.coverage.unknownReasons)) fail('coverage is incomplete');
  if (!report.provenance?.kind || !report.provenance?.source) fail('provenance is required');
  if (!Array.isArray(report.warnings)) fail('warnings must be an array');
  const graph = report.sessionGraph;
  for (const key of ['rootSessionIds', 'includedSessionIds', 'excludedSessionIds', 'duplicateSuppressedSessionIds']) {
    if (!Array.isArray(graph?.[key]) || new Set(graph[key]).size !== graph[key].length) fail(`sessionGraph.${key} must be a unique array`);
  }
  const included = new Set(graph.includedSessionIds);
  if (graph.excludedSessionIds.some((id) => included.has(id))) {
    fail('included session IDs overlap excluded IDs');
  }
  return report;
}
