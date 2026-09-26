// Show the arithmetic behind a cost, so a number can be checked by hand.
//
// The report already carries the rate record, its fingerprint, its effective window, and
// the context tier that were selected for every priced call. None of it reaches a human.
// A user who cannot reconcile the total against a provider bill has to choose between
// trusting the tool blindly and stopping trusting it, and the honest answer is to show
// the working.
//
// Two rules hold throughout. An unpriced model is a named line, never an absent one. And a
// recorded cost and an estimated cost are labelled differently, because they are different
// claims even when the digits agree.

const COMPONENTS = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite']);
const COMPONENT_LABEL = Object.freeze({
  input: 'input tokens',
  output: 'output tokens',
  cacheRead: 'cached read',
  cacheWrite: 'cache write',
});
const PER_MILLION = 1_000_000;

const isUsable = (value) => typeof value === 'number' && Number.isFinite(value);

function money(value) {
  return isUsable(value) ? `$${value.toFixed(6)}` : 'unavailable';
}

function tokens(value) {
  return isUsable(value) ? `${(value / PER_MILLION).toFixed(3)} M` : 'unavailable';
}

// Per-model detail lives in `report.models`, keyed by rate model. `report.total.models` is
// the flat aggregate and carries no rates, and `rateProvenance` deliberately carries no
// amount: the contract schema forbids extra properties there, so it cannot be the source.
function detailedModels(report) {
  return (report?.models ?? []).filter((model) => model && typeof model === 'object');
}

function tokensFor(model, component) {
  if (component === 'input') return Number(model.inputTokens) || 0;
  if (component === 'output') return Number(model.outputTokens) || 0;
  return Number(model[`${component}Tokens`]) || 0;
}

function recordedCost(model, component) {
  const value = Number(model[`cost${component[0].toUpperCase()}${component.slice(1)}`]);
  return Number.isFinite(value) ? value : null;
}

/**
 * Build the per-line arithmetic for a report.
 * @returns {{basis: string, lines: object[], unpriced: object[], total: object}}
 */
export function explainCost(report) {
  const basis = report?.billing?.basis ?? 'unknown';
  const lines = [];
  const unpriced = [];

  // A runtime-recorded report has no rate card at all: the cost is what the runtime
  // already charged. Showing a rate would invent one, so the explanation shows the
  // per-model recorded sums instead and says plainly why there is no rate to show.
  if (basis !== 'provider-rate-estimate') {
    return explainRecorded(report, basis);
  }

  for (const model of detailedModels(report)) {
    const perComponent = [];
    let modelCost = 0;
    let complete = model.rateKnown !== false && Array.isArray(model.rateRecords);

    for (const component of COMPONENTS) {
      const tokenCount = tokensFor(model, component);
      const record = (model.rateRecords ?? []).find((entry) => entry.component === component) ?? null;
      const rate = record?.amount ?? null;
      if (!isUsable(rate)) { complete = false; continue; }
      const amount = (tokenCount / PER_MILLION) * rate;
      modelCost += amount;
      perComponent.push({
        component,
        label: COMPONENT_LABEL[component],
        tokens: tokenCount,
        tokensFormatted: tokens(tokenCount),
        ratePerMillion: rate,
        amount,
        amountFormatted: money(amount),
        fingerprint: record.fingerprint,
        effectiveFrom: record.effectiveFrom,
        effectiveThrough: record.effectiveThrough,
        context: record.context,
        timeBand: record.timeBand,
        source: record.source ?? null,
      });
    }

    if (complete) {
      lines.push({
        modelId: model.rateKey ?? model.modelId,
        provider: model.providerKey ?? model.provider,
        components: perComponent,
        cost: modelCost,
        costFormatted: money(modelCost),
      });
    } else {
      unpriced.push({
        modelId: model.modelId,
        provider: model.providerKey ?? model.provider,
        reason: 'no applicable rate record for every component, so this model was not costed',
      });
    }
  }

  // Anything the report itself flagged as unpriced belongs in the explanation too.
  for (const model of detailedModels(report)) {
    if (model.rateKnown) continue;
    if (unpriced.some((entry) => entry.modelId === (model.rateKey ?? model.modelId))) continue;
    unpriced.push({
      modelId: model.rateKey ?? model.modelId,
      provider: model.providerKey ?? model.provider,
      reason: model.rateCoverage === 'no-calls'
        ? 'no calls, so there is nothing to price'
        : 'this model has no known rate, so its cost is unavailable rather than zero',
    });
  }

  const derived = lines.reduce((sum, line) => sum + line.cost, 0);
  const reported = report?.billing?.amountUsd ?? null;
  // A total that cannot be reconciled is a finding, not something to paper over.
  const reconciles = isUsable(reported) && isUsable(derived) && Math.abs(reported - derived) < 1e-6;

  return {
    basis,
    isEstimate: basis === 'provider-rate-estimate',
    lines,
    unpriced,
    total: {
      derivedFromLines: derived,
      derivedFormatted: money(derived),
      reported: reported,
      reportedFormatted: money(reported),
      reconciles,
      coverage: report?.billing?.coverage ?? 'unknown',
    },
  };
}

/** Explanation for a runtime-recorded report: per-model sums, no invented rate. */
function explainRecorded(report, basis) {
  const models = Object.entries(report?.total?.models ?? {});
  const lines = [];
  const unpriced = [];
  for (const [key, model] of models) {
    // Number(null) is 0, so the raw value has to be checked before coercion or an
    // unpriced model would be presented as genuinely free.
    const cost = model?.cost == null || model.cost === '' ? null : Number(model.cost);
    if (!isUsable(cost)) {
      unpriced.push({ modelId: key, provider: model?.provider ?? null, reason: 'this model has no recorded cost for the calls it made' });
      continue;
    }
    lines.push({
      modelId: model.model ?? key,
      provider: model.provider ?? null,
      recorded: true,
      calls: Number(model.calls) || 0,
      components: [
        { component: 'input', label: 'input tokens', tokens: Number(model.inputTokens) || 0, tokensFormatted: tokens(Number(model.inputTokens) || 0) },
        { component: 'output', label: 'output tokens', tokens: Number(model.outputTokens) || 0, tokensFormatted: tokens(Number(model.outputTokens) || 0) },
        { component: 'cacheRead', label: 'cached read', tokens: Number(model.cacheReadTokens) || 0, tokensFormatted: tokens(Number(model.cacheReadTokens) || 0) },
        { component: 'cacheWrite', label: 'cache write', tokens: Number(model.cacheWriteTokens) || 0, tokensFormatted: tokens(Number(model.cacheWriteTokens) || 0) },
      ],
      cost,
      costFormatted: money(cost),
    });
  }
  const derived = lines.reduce((sum, line) => sum + line.cost, 0);
  const reported = report?.billing?.amountUsd ?? null;
  return {
    basis,
    isEstimate: false,
    lines,
    unpriced,
    total: {
      derivedFromLines: derived,
      derivedFormatted: money(derived),
      reported,
      reportedFormatted: money(reported),
      reconciles: isUsable(reported) && isUsable(derived) && Math.abs(reported - derived) < 1e-6,
      coverage: report?.billing?.coverage ?? 'unknown',
    },
  };
}

/** Render the explanation as plain text for a terminal. */
export function renderExplanation(report, explanation = explainCost(report)) {
  const out = [];
  const label = explanation.isEstimate ? 'provider-rate estimate' : 'runtime-recorded cost';
  out.push(`Cost explanation (${label})`);
  out.push('');

  if (!explanation.lines.length) {
    out.push('  No model in this report has a complete, applicable rate card.');
  }

  for (const line of explanation.lines) {
    out.push(`  ${line.provider ?? '?'}/${line.modelId}  ->  ${line.costFormatted}`);
    if (line.recorded) {
      out.push(`    ${String(line.calls).padStart(3)} recorded call(s); the runtime charged this, so there is no rate card to show.`);
      for (const component of line.components) {
        if (!component.tokens) continue;
        out.push(`    ${component.label.padEnd(14)} ${component.tokensFormatted.padStart(9)}`);
      }
      out.push('');
      continue;
    }
    for (const component of line.components) {
      out.push(`    ${component.label.padEnd(14)} ${component.tokensFormatted.padStart(9)}  x  $${component.ratePerMillion}/M  =  ${component.amountFormatted}`);
      const window = component.effectiveThrough
        ? `${component.effectiveFrom} .. ${component.effectiveThrough}`
        : `from ${component.effectiveFrom}`;
      const band = component.timeBand && component.timeBand !== 'flat' ? `, band ${component.timeBand}` : '';
      out.push(`      rate ${String(component.fingerprint).slice(0, 23)}...  effective ${window}${band}`);
    }
    out.push('');
  }

  for (const entry of explanation.unpriced) {
    out.push(`  ${entry.provider}/${entry.modelId}: NOT PRICED - ${entry.reason}`);
  }
  if (explanation.unpriced.length) out.push('');

  out.push(`  ${'TOTAL'.padEnd(52)}${explanation.total.reportedFormatted}`);
  out.push(`  ${'sum of the lines above'.padEnd(52)}${explanation.total.derivedFormatted}`);
  if (!explanation.total.reconciles) {
    out.push('  NOTE: the lines above do not reconcile to the reported total. Treat the total as authoritative.');
  }
  return out.join('\n');
}
