// Re-price a real session against a different model, as a clearly labelled estimate.
//
// This is the issue most likely to erode the project's own rules, so the constraints are
// explicit rather than implied:
//
//   * The reported cost is never mutated. A counterfactual is a separate object with its own
//     provenance, its own coverage, and its own label.
//   * The substitute rate must come from a real, effective-dated, fingerprinted record. If
//     the model has no such record the answer is `unavailable`, never an extrapolation.
//   * Token counts are not adjusted. A different model may tokenize differently, so the
//     result is an estimate of the same tokens at a different price, and says so.

const PER_MILLION = 1_000_000;
const COMPONENTS = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite']);

const isUsable = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Re-price a report's token counts against an alternative model's rate records.
 *
 * @param {object} report a normalized report carrying `models[].rateRecords`
 * @param {object} options
 * @param {string} options.model the alternative rate model id
 * @param {Array}  options.rateRecords effective rate records for that model
 * @param {number} [options.contextTokens] context tier to select, when the model is tiered
 */
export function counterfactualCost(report, { model, rateRecords = [], contextTokens = null, at = null } = {}) {
  const records = (rateRecords ?? []).filter((record) => record.model === model);
  if (!model || !records.length) {
    return unavailable(`no effective rate record exists for "${model ?? 'the requested model'}"`);
  }

  // Only records effective at the call time, and matching the context tier, may be used.
  const timestamp = at == null ? null : (typeof at === 'string' ? Date.parse(at) : Number(at));
  const applicable = records.filter((record) => {
    if (!Number.isFinite(Date.parse(record.effectiveFrom))) return false;
    const through = record.effectiveThrough ? Date.parse(record.effectiveThrough) : Infinity;
    if (timestamp != null && (timestamp < Date.parse(record.effectiveFrom) || timestamp >= through)) return false;
    if (contextTokens != null) {
      const min = record.context?.minTokens ?? 0;
      const max = record.context?.maxTokens;
      if (contextTokens < min) return false;
      if (max != null && contextTokens > max) return false;
    }
    return true;
  });
  if (!applicable.length) {
    return unavailable(`no rate record for "${model}" is effective at that time and context`);
  }

  const lines = [];
  const missing = [];
  for (const component of COMPONENTS) {
    const record = pick(applicable, component);
    if (!record || !isUsable(record.amount)) { missing.push(component); continue; }
    lines.push({
      component,
      tokens: componentTokens(report, component),
      ratePerMillion: record.amount,
      amount: (componentTokens(report, component) / PER_MILLION) * record.amount,
      fingerprint: record.fingerprint,
      effectiveFrom: record.effectiveFrom,
      effectiveThrough: record.effectiveThrough,
      context: record.context ?? null,
      timeBand: record.timeBand ?? 'flat',
    });
  }

  if (missing.length) {
    return {
      ...unavailable(`no rate for ${missing.join(', ')} on "${model}", so it cannot be re-priced`),
      model,
      missingComponents: missing,
    };
  }

  const cost = lines.reduce((sum, line) => sum + line.amount, 0);
  const actual = report?.billing?.amountUsd ?? null;
  return {
    status: 'available',
    model,
    costUsd: cost,
    basis: 'counterfactual-estimate',
    isEstimate: true,
    coverage: 'complete',
    lines,
    missingComponents: [],
    actualCostUsd: actual,
    deltaUsd: isUsable(actual) ? cost - actual : null,
    reason: null,
  };
}

function unavailable(reason) {
  return {
    status: 'unavailable',
    model: null,
    costUsd: null,
    basis: 'counterfactual-estimate',
    isEstimate: true,
    coverage: 'unknown',
    lines: [],
    missingComponents: COMPONENTS.slice(),
    actualCostUsd: null,
    deltaUsd: null,
    reason,
  };
}

// The newest record that applies wins, so a refresh cannot be silently ignored.
function pick(records, component) {
  return records
    .filter((record) => record.component === component)
    .sort((left, right) => Date.parse(right.effectiveFrom) - Date.parse(left.effectiveFrom))[0] ?? null;
}

function componentTokens(report, component) {
  const model = (report?.models ?? []).find((entry) => entry?.rateKnown)
    ?? (report?.models ?? [])[0]
    ?? null;
  if (!model) return 0;
  const field = component === 'input' ? 'inputTokens' : `${component}Tokens`;
  return Number(model[field]) || 0;
}

export function renderCounterfactualText(report, result) {
  const out = ['Counterfactual estimate: what this session would cost on another model', ''];
  out.push('  This is an ESTIMATE of the same tokens at a different price. It does not');
  out.push('  change the reported cost, and a different model may tokenize differently.');
  out.push('');

  if (result.status !== 'available') {
    out.push(`  ${result.model ?? 'requested model'}: UNAVAILABLE - ${result.reason}`);
    out.push('');
    out.push(`  Reported cost stays authoritative: ${formatUsd(report?.billing?.amountUsd ?? null)}`);
    return out.join('\n');
  }

  out.push(`  ${result.model}`);
  for (const line of result.lines) {
    out.push(`    ${line.component.padEnd(12)} ${((line.tokens / PER_MILLION).toFixed(3) + ' M').padStart(9)}  x  $${line.ratePerMillion}/M  =  $${line.amount.toFixed(6)}`);
    out.push(`      rate ${String(line.fingerprint).slice(0, 23)}...  effective from ${line.effectiveFrom}`);
  }
  out.push('');
  out.push(`  counterfactual total   ${formatUsd(result.costUsd)}`);
  out.push(`  reported cost          ${formatUsd(result.actualCostUsd)}`);
  if (result.deltaUsd != null) {
    const sign = result.deltaUsd >= 0 ? '+' : '-';
    out.push(`  difference             ${sign}$${Math.abs(result.deltaUsd).toFixed(6)}`);
  }
  return out.join('\n');
}

function formatUsd(value) {
  return isUsable(value) ? `$${value.toFixed(6)}` : 'unavailable';
}
