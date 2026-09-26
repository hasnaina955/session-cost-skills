// Guided setup for a custom provider endpoint.
//
// `doctor` diagnoses a configuration; this builds one. It works out what is missing, validates
// each field as it goes, and ends by printing the exact command that checks the result.
//
// The constraint that shapes everything: a setup flow may only ever write the NAME of an
// environment variable, never a value. The loader already rejects a literal secret, and this
// must not become a way around that rejection.

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/;
const COMPONENTS = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite']);

// The driver ids a custom endpoint can be built on. Taken from the contract's vocabulary
// rather than hard-coded prose, so a driver added later is a one-line change here.
export const SETUP_DRIVERS = Object.freeze([
  { id: 'openai-compatible', label: 'OpenAI-compatible endpoint', protocol: 'openai' },
  { id: 'anthropic-compatible', label: 'Anthropic-compatible endpoint', protocol: 'anthropic' },
]);

function isEnvName(value) {
  return typeof value === 'string' && ENV_NAME.test(value);
}

/**
 * Validate a set of answers and return a ready-to-write provider profile, or the reasons it
 * cannot be built. Never throws: this is a guidance flow, and a list of problems is more
 * useful than a stack trace.
 */
export function buildProviderProfile(answers = {}) {
  const problems = [];
  const profile = {};

  const id = String(answers.id ?? '').trim();
  if (!id) problems.push('an id is required, for example "my-endpoint"');
  else if (!PROVIDER_ID.test(id)) problems.push(`"${id}" is not a usable id; use lowercase letters, digits, dot, dash or underscore`);
  else profile.id = id;

  const driverId = String(answers.driverId ?? '').trim();
  if (!driverId) problems.push('a driver is required');
  else if (!SETUP_DRIVERS.some((driver) => driver.id === driverId)) {
    problems.push(`"${driverId}" is not a driver a custom endpoint can use; choose one of ${SETUP_DRIVERS.map((d) => d.id).join(', ')}`);
  } else profile.driverId = driverId;

  if (!answers.baseUrlEnv && !answers.endpointEnv) {
    problems.push('an endpoint is required: give the NAME of an environment variable holding the base URL');
  }
  for (const [key, label] of [['baseUrlEnv', 'base URL'], ['endpointEnv', 'endpoint'], ['credentialEnv', 'credential']]) {
    const value = answers[key];
    if (value === undefined || value === null || value === '') continue;
    if (!isEnvName(value)) {
      // This is the rule that matters: a value here would be a secret in a config file.
      problems.push(`${label} must be an environment variable NAME like OPENAI_API_KEY, not a value`);
      continue;
    }
    profile[key] = value;
  }

  if (answers.region !== undefined && answers.region !== null && answers.region !== '') profile.region = String(answers.region);
  const currency = String(answers.currency ?? 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) problems.push(`"${currency}" is not a three-letter currency code`);
  else profile.currency = currency;

  const runtimes = answers.runtimes ?? ['cline', 'mcode'];
  if (!Array.isArray(runtimes) || !runtimes.length) problems.push('at least one runtime must be selected');
  else if (runtimes.some((runtime) => !['cline', 'mcode', 'opencode'].includes(runtime))) problems.push('runtimes must be cline, mcode, or opencode');

  const cards = validateRateCards(answers.rateCards);
  problems.push(...cards.problems);
  if (!cards.cards.length) {
    // A provider with no rates prices nothing, so say so now rather than letting the first
    // report come back unavailable.
    problems.push('no rate card was given, so sessions on this provider would report an unavailable cost');
  }

  const result = { id, driverId };
  if (!problems.length) {
    result.profile = {
      id: profile.id,
      driverId: profile.driverId,
      match: { providerIds: [profile.id], runtimes },
      ...(profile.baseUrlEnv ? { baseUrlEnv: profile.baseUrlEnv } : {}),
      ...(profile.endpointEnv ? { endpointEnv: profile.endpointEnv } : {}),
      ...(profile.credentialEnv ? { credentialEnv: profile.credentialEnv } : {}),
      ...(profile.region ? { region: profile.region } : {}),
      currency: profile.currency,
      pricingMode: 'manual',
      rateCards: cards.cards,
    };
  }
  return { ok: problems.length === 0, problems, profile: result.profile ?? null };
}

function validateRateCards(cards) {
  const problems = [];
  if (cards === undefined || cards === null) return { cards: [], problems };
  if (!Array.isArray(cards)) return { cards: [], problems: ['rate cards must be a list'] };
  const clean = [];
  cards.forEach((card, index) => {
    const label = `rate card ${index + 1}`;
    if (!card?.model) { problems.push(`${label} needs a model`); return; }
    if (!/^\d{4}-\d{2}-\d{2}T/.test(String(card.effectiveFrom ?? ''))) {
      problems.push(`${label} needs effectiveFrom as an ISO timestamp, for example 2026-01-01T00:00:00.000Z`);
      return;
    }
    const amounts = {};
    let complete = true;
    for (const component of COMPONENTS) {
      const value = Number(card[component]);
      // An incomplete card must be refused, not partially applied: a half-priced model is
      // the same failure as an unpriced one, only harder to notice.
      if (!Number.isFinite(value) || value < 0) {
        problems.push(`${label} needs a non-negative ${component} rate`);
        complete = false;
        break;
      }
      amounts[component] = value;
    }
    if (!complete) return;
    clean.push({
      model: String(card.model),
      effectiveFrom: String(card.effectiveFrom),
      ...(card.effectiveThrough ? { effectiveThrough: String(card.effectiveThrough) } : {}),
      ...(card.timeBand ? { timeBand: card.timeBand } : {}),
      ...amounts,
    });
  });
  return { cards: clean, problems };
}

/** The command that proves the finished configuration works. */
export function validationCommand(configPath) {
  return `node session-cost.mjs --validate-config --session-config ${configPath}`;
}

/** Render the guided flow: what is needed, what was built, and how to check it. */
export function renderSetupText({ result, configPath, runtimeId }) {
  const out = [];
  out.push(`Custom provider setup (${runtimeId})`);
  out.push('');

  if (!result.ok) {
    out.push('  This configuration is not ready yet:');
    for (const problem of result.problems) out.push(`    - ${problem}`);
    out.push('');
    out.push('  Nothing was written. Fix the items above and run this again.');
    return out.join('\n');
  }

  const profile = result.profile;
  out.push('  Configuration looks complete:');
  out.push(`    provider id      ${profile.id}`);
  out.push(`    driver           ${profile.driverId}`);
  out.push(`    base URL env     ${profile.baseUrlEnv ?? profile.endpointEnv ?? '(none)'}`);
  out.push(`    credential env   ${profile.credentialEnv ?? '(none - the endpoint needs no credential)'}`);
  out.push(`    currency         ${profile.currency}`);
  out.push(`    runtimes         ${profile.match.runtimes.join(', ')}`);
  out.push(`    rate cards       ${profile.rateCards.length}`);
  out.push('');
  out.push('  Only environment variable NAMES are stored. Set each one before reporting:');
  for (const key of ['baseUrlEnv', 'endpointEnv', 'credentialEnv']) {
    if (profile[key]) out.push(`    $env:${profile[key]} = "<your value>"`);
  }
  out.push('');
  out.push('  Validate it with:');
  out.push(`    ${validationCommand(configPath)}`);
  out.push('');
  out.push('  Then confirm it prices:');
  out.push('    node session-cost.mjs doctor');
  return out.join('\n');
}
