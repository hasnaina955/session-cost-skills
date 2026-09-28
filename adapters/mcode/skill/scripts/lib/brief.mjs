/**
 * A short answer, for the agent that asked.
 *
 * The full report is thorough because a person auditing a bill needs it to be. But the common
 * case is an agent answering "what did this cost?", and it does not need rate fingerprints,
 * provenance, or a model breakdown to say so. It needs the number, and the one caveat that changes
 * how the number should be read.
 *
 * So `--brief` says, in order:
 *
 *   - the cost, with its coverage state - because a partial total and a complete one are not the
 *     same statement and must not read alike;
 *   - the tokens and the cache rate, because those are the two levers;
 *   - the top model, because that is where most of it usually goes;
 *   - whether subagents are in the total, because "this session" and "this task end to end" are
 *     different answers to the same question;
 *   - one warning, if there is a single thing worth knowing, because a short report that hides a
 *     caveat is worse than a long one.
 *
 * The rules are the same ones the rest of the tool keeps. Unknown cost is `unavailable`, never
 * `$0.00`. Coverage is stated beside the figure, not implied by it. And nothing here is rounded
 * differently from the full report - a short report must not become a less accurate one.
 */

/** One compact cost line, with coverage beside it. */
export function briefCost(report) {
  const billing = report?.billing ?? {};
  const amount = billing.amountUsd;
  const coverage = billing.coverage;
  if (!Number.isFinite(amount)) return { cost: 'unavailable', coverage, note: 'no priced cost' };
  const formatted = amount === 0 ? '$0.00' : amount < 0.01 ? `$${amount.toFixed(4)}` : `$${amount.toFixed(2)}`;
  return {
    cost: formatted,
    coverage,
    note: coverage === 'complete' ? null : coverage === 'partial' ? 'partial coverage' : 'no priced cost',
  };
}

/** The dominant model, for "where did most of it go". */
export function briefTopModel(report) {
  const models = Array.isArray(report?.models) ? report.models : [];
  const priced = models.filter((model) => model.rateKnown !== false && Number.isFinite(Number(model.totalCost)));
  if (priced.length === 0) return null;
  const top = priced.sort((a, b) => b.totalCost - a.totalCost)[0];
  return { model: top.modelId ?? top.model ?? '(unknown)', provider: top.providerKey ?? top.provider ?? null, cost: Number(top.totalCost) };
}

/** Render the brief text. Returns a string with at most five content lines. */
export function renderBriefText(report) {
  const billing = report?.billing ?? {};
  const usage = report?.usage ?? {};
  const { cost, note } = briefCost(report);
  const top = briefTopModel(report);
  const tokens = Number.isFinite(usage.totalTokens) ? usage.totalTokens : null;
  const cacheRate = Number.isFinite(usage.cacheHitRate) ? usage.cacheHitRate : null;

  const lines = [];
  lines.push(`${cost}${note ? ` (${note})` : ''}`);
  const parts = [];
  if (tokens !== null) parts.push(`${tokens.toLocaleString('en-US')} tokens`);
  if (cacheRate !== null) parts.push(`${Math.round(cacheRate * 100)}% cache hit`);
  if (Number.isFinite(report?.calls)) parts.push(`${report.calls} calls`);
  if (parts.length) lines.push(parts.join('  ·  '));

  if (top) lines.push(`top: ${top.model}${top.provider ? ` (${top.provider})` : ''} $${top.cost < 0.01 ? top.cost.toFixed(4) : top.cost.toFixed(2)}`);

  const included = report?.sessionGraph?.includedSessionIds ?? report?.includedSessionIds ?? [];
  const excluded = report?.sessionGraph?.excludedSessionIds ?? report?.excludedSessionIds ?? [];
  if (excluded.length > 0) lines.push(`${excluded.length} sub-agent session(s) not billed; add --include-children for the task total`);
  else if (included.length > 1) lines.push(`includes ${included.length - 1} sub-agent session(s)`);

  const warning = briefWarning(report);
  if (warning) lines.push(`note: ${warning}`);
  return lines.join('\n');
}

/** The single most useful caveat, if there is one. */
function briefWarning(report) {
  const billing = report?.billing ?? {};
  const usage = report?.usage ?? {};
  if (billing.coverage === 'partial') return 'some calls could not be priced, so this is a lower bound';
  if (!Number.isFinite(billing.amountUsd)) return 'nothing in this session could be priced';
  if (Number.isFinite(usage.cacheHitRate) && usage.cacheHitRate < 0.5 && Number.isFinite(report?.calls) && report.calls > 0) {
    return 'cache hit rate is low; a lot of the prompt is being re-read';
  }
  if (Number.isFinite(report?.snapshot?.capturedAtMs) && Number.isFinite(report?.sessionActive ? 1 : 0)) {
    // left as a real-time detail; a short report does not need a staleness warning
  }
  return null;
}

/**
 * The stable JSON shape for `--brief --json`.
 *
 * Kept deliberately small and documented here rather than derived from the report, because a
 * consumer reading this field should not have to re-derive the contract from the full envelope.
 * Adding a field is a minor bump of the contract; the field names below are the public surface.
 */
export function briefJson(report) {
  const billing = report?.billing ?? {};
  const usage = report?.usage ?? {};
  const top = briefTopModel(report);
  return {
    kind: 'session-brief',
    costUsd: Number.isFinite(billing.amountUsd) ? billing.amountUsd : null,
    coverage: billing.coverage ?? 'unknown',
    basis: billing.basis ?? null,
    tokens: Number.isFinite(usage.totalTokens) ? usage.totalTokens : null,
    cacheHitRate: Number.isFinite(usage.cacheHitRate) ? usage.cacheHitRate : null,
    calls: Number.isFinite(report?.calls) ? report.calls : null,
    topModel: top ? { model: top.model, provider: top.provider, costUsd: top.cost } : null,
    includedSubagents: (report?.sessionGraph?.includedSessionIds ?? report?.includedSessionIds ?? []).length - 1,
    excludedSubagents: (report?.sessionGraph?.excludedSessionIds ?? report?.excludedSessionIds ?? []).length,
  };
}
