// One option schema and one parser for both adapters.
//
// The two CLIs used to hand-roll `if (arg === '--x')` chains, which meant a missing
// value silently consumed the next flag, `--list --json` ate `--json` as a count, and
// `--last --today` silently discarded a mode. Parsing happens here, before any storage
// is opened, so a bad invocation fails immediately and says what to do instead.
//
// This module is deliberately dependency-free so it can be copied verbatim into each
// adapter and stay independently installable.
export class CliUsageError extends Error {
  constructor(message, { usage } = {}) {
    super(message);
    this.name = 'CliUsageError';
    this.exitCode = 2;
    this.usage = usage ?? null;
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function looksLikeFlag(token) {
  return typeof token === 'string' && token.startsWith('-') && token !== '-';
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined) throw new CliUsageError(`${flag} requires a value`);
  if (looksLikeFlag(value)) throw new CliUsageError(`${flag} requires a value, but got the flag ${value}`);
  return value;
}

function requireInteger(argv, index, flag, { min, max }) {
  const raw = requireValue(argv, index, flag);
  if (!/^\d+$/.test(raw)) throw new CliUsageError(`${flag} expects a whole number, but got "${raw}"`);
  const value = Number(raw);
  if (value < min || (max !== undefined && value > max)) {
    throw new CliUsageError(`${flag} must be between ${min} and ${max ?? 'unbounded'}, but got ${value}`);
  }
  return value;
}

// A budget may legitimately be 0, meaning block any spend, so this is the one numeric
// option that accepts zero and rejects negatives and non-numbers.
function requireNonNegativeNumber(argv, index, flag) {
  const raw = requireValue(argv, index, flag);
  if (!/^\d+(?:\.\d+)?$/.test(raw)) throw new CliUsageError(`${flag} expects an amount like 5 or 5.50, but got "${raw}"`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new CliUsageError(`${flag} must not be negative, but got ${raw}`);
  return value;
}

function requireDate(argv, index, flag) {
  const raw = requireValue(argv, index, flag);
  if (!DATE.test(raw)) throw new CliUsageError(`${flag} expects YYYY-MM-DD, but got "${raw}"`);
  const parsed = Date.parse(`${raw}T00:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== raw) {
    throw new CliUsageError(`${flag} is not a real calendar date: ${raw}`);
  }
  return raw;
}

// `--list` takes an optional count. A following token is only consumed when it is
// actually a number, so `--list --json` stays `--list` plus `--json`. A non-flag
// token that is not a number is a mistyped value rather than a new argument.
function optionalCount(argv, index, flag, bounds) {
  const next = argv[index + 1];
  if (next === undefined || looksLikeFlag(next)) return { value: null, consumed: 0 };
  if (!/^\d+$/.test(next)) throw new CliUsageError(`${flag} expects a whole number, but got "${next}"`);
  return { value: requireInteger(argv, index, flag, bounds), consumed: 1 };
}

const COMMON_FLAGS = Object.freeze({
  session: { key: 'session', value: (argv, i) => requireValue(argv, i, '--session') },
  last: { key: 'mode', value: 'last' },
  today: { key: 'mode', value: 'today' },
  compare: { key: 'mode', value: 'compare' },
  from: { key: 'from', value: (argv, i) => requireDate(argv, i, '--from') },
  to: { key: 'to', value: (argv, i) => requireDate(argv, i, '--to') },
  provider: { key: 'provider', value: (argv, i) => requireValue(argv, i, '--provider') },
  model: { key: 'model', value: (argv, i) => requireValue(argv, i, '--model') },
  dashboard: { key: 'dashboard', value: true },
  out: { key: 'out', value: (argv, i) => requireValue(argv, i, '--out') },
  includeChildren: { key: 'includeChildren', value: true },
  json: { key: 'json', value: true },
  dataDir: { key: 'dataDir', value: (argv, i) => requireValue(argv, i, '--data-dir') },
  config: { key: 'configPath', value: (argv, i) => requireValue(argv, i, '--config') },
  sessionConfig: { key: 'sessionConfigPath', value: (argv, i) => requireValue(argv, i, '--session-config') },
  initConfig: { key: 'configAction', value: 'init' },
  validateConfig: { key: 'configAction', value: 'validate' },
  exportConfig: { key: 'configAction', value: 'export' },
  // Sets configAction to a constant but still consumes a path argument.
  importConfig: { key: 'configAction', value: 'import', takesValue: true, alsoSet: 'configImportPath' },
  doctor: { key: 'diagnostic', value: 'doctor' },
  providers: { key: 'diagnostic', value: 'providers' },
  modelsDiscover: { key: 'diagnostic', value: 'models' },
  configExplain: { key: 'diagnostic', value: 'config-explain' },
  list: { key: 'list', optionalCount: true, fallback: 10, bounds: { min: 1, max: 1000 } },
  help: { key: 'help', value: true },
  version: { key: 'version', value: true },
  // Tier 1 cost-insight flags. A flag is only added here once it is documented in the
  // adapter help text and actually does something: a flag that parses and is then ignored
  // is worse than a flag that does not exist.
  explain: { key: 'explain', value: true },
  csv: { key: 'csv', value: true },
  rollup: {
    key: 'rollup',
    value: (argv, i) => {
      const raw = requireValue(argv, i, '--rollup');
      if (!['daily', 'weekly'].includes(raw)) {
        throw new CliUsageError(`--rollup expects daily or weekly, but got "${raw}"`);
      }
      return raw;
    },
  },
  top: { key: 'top', value: (argv, i) => requireInteger(argv, i, '--top', { min: 1, max: 1000 }) },
  budget: { key: 'budget', value: (argv, i) => requireNonNegativeNumber(argv, i, '--budget') },
  // Opt-in and inert unless a model is named: a counterfactual must never appear in a
  // default report, and it must never be inferred.
  counterfactual: { key: 'counterfactual', value: (argv, i) => requireValue(argv, i, '--counterfactual') },
  // Foreground only. There is deliberately no background daemon: it would need service
  // registration and a lifecycle, and would leave orphan processes with no clear stop.
  watch: { key: 'watch', value: true },
  watchInterval: { key: 'watchInterval', value: (argv, i) => requireInteger(argv, i, '--watch-interval', { min: 100, max: 60_000 }) },
  // Tier 3. --setup diagnoses what is missing for a custom provider and emits a validated
  // starter config; it never writes a secret, only an environment-variable name.
  setup: { key: 'setup', value: true },
  insights: { key: 'insights', value: true },
});

export const RUNTIME_FLAGS = Object.freeze({
  cline: Object.freeze({
    ...COMMON_FLAGS,
    account: { key: 'account', value: true },
    accountUserId: { key: 'accountUserId', value: (argv, i) => requireValue(argv, i, '--account-user-id') },
    accountDays: { key: 'accountDays', value: (argv, i) => requireInteger(argv, i, '--account-days', { min: 1, max: 365 }) },
  }),
  mcode: Object.freeze({
    ...COMMON_FLAGS,
    rates: { key: 'rates', value: true },
    refreshRates: { key: 'refreshRates', value: true },
  }),
});

// Groups where picking more than one is a user error rather than a silent override.
const EXCLUSIVE_GROUPS = Object.freeze([
  { name: 'session mode', keys: ['mode'], labels: ['--last', '--today', '--compare'] },
  { name: 'config action', keys: ['configAction'], labels: ['--init-config', '--validate-config', '--export-config', '--import-config'] },
  { name: 'diagnostic', keys: ['diagnostic'], labels: ['doctor', 'providers', 'models discover', 'config explain'] },
]);

// Two-word subcommands, e.g. `models discover`.
const SUBCOMMANDS = Object.freeze({
  models: { flag: 'modelsDiscover', word: 'discover' },
  config: { flag: 'configExplain', word: 'explain' },
});

// Diagnostics that are also accepted as bare words: `doctor`, `providers`.
const BARE_COMMANDS = Object.freeze({ doctor: 'doctor', providers: 'providers' });

function toCamel(flag) {
  return flag.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function toKebab(flag) {
  return flag.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * Parse an argument vector into validated options.
 * Throws CliUsageError before any storage is opened.
 */
export function parseCliArgs(argv, { runtimeId, defaults = {} } = {}) {
  const flags = RUNTIME_FLAGS[runtimeId];
  if (!flags) throw new CliUsageError(`unknown runtime: ${runtimeId}`);

  const options = { mode: 'current', ...defaults };
  const seenByKey = new Map();

  // `--help` and `--version` answer immediately, even alongside nonsense, because a
  // user who asked for help should get help rather than a complaint about other flags.
  for (const token of argv) {
    if (token === '--help' || token === '-h') return { ...options, help: true };
    if (token === '--version' || token === '-v') return { ...options, version: true };
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== 'string') throw new CliUsageError(`unexpected argument: ${String(token)}`);

    let flag = null;
    let consumed = 0;

    if (!token.startsWith('-')) {
      if (token in BARE_COMMANDS) {
        flag = BARE_COMMANDS[token];
      } else {
        const subcommand = SUBCOMMANDS[token];
        if (!subcommand || argv[index + 1] !== subcommand.word) throw new CliUsageError(`unexpected argument: ${token}`);
        flag = subcommand.flag;
        consumed = 1;
      }
    } else if (token === '-h') {
      flag = 'help';
    } else if (token === '-v') {
      flag = 'version';
    } else {
      const candidate = toCamel(token.replace(/^--?/, ''));
      if (!(candidate in flags)) throw new CliUsageError(`unknown argument: ${token}`);
      flag = candidate;
    }

    const spec = flags[flag];
    if (!seenByKey.has(spec.key)) seenByKey.set(spec.key, { flags: new Set(), count: 0 });
    const entry = seenByKey.get(spec.key);
    entry.flags.add(flag);
    entry.count += 1;

    if (spec.optionalCount) {
      const { value, consumed: used } = optionalCount(argv, index, `--${toKebab(flag)}`, spec.bounds);
      options[spec.key] = value ?? spec.fallback;
      consumed += used;
    } else if (typeof spec.value === 'function') {
      const value = spec.value(argv, index);
      options[spec.key] = value;
      if (spec.alsoSet) options[spec.alsoSet] = value;
      consumed = 1;
    } else if (spec.takesValue) {
      const value = requireValue(argv, index, `--${toKebab(flag)}`);
      options[spec.key] = spec.value;
      if (spec.alsoSet) options[spec.alsoSet] = value;
      consumed = 1;
    } else {
      options[spec.key] = spec.value;
    }
    index += consumed;
  }

  for (const group of EXCLUSIVE_GROUPS) {
    const chosen = group.keys.flatMap((key) => [...(seenByKey.get(key)?.flags ?? [])].map((flag) => `--${toKebab(flag)}`));
    if (chosen.length > 1) {
      throw new CliUsageError(`${group.name} flags are mutually exclusive: ${chosen.join(', ')} (choose one of ${group.labels.join(', ')})`);
    }
  }
  for (const [key, entry] of seenByKey) {
    // Repeating a boolean switch is harmless and lets callers compose flags freely
    // (a --json helper may append --json to an argv that already has it). Repeating a
    // value-taking flag is genuinely ambiguous, so that is the case worth rejecting.
    const spec = RUNTIME_FLAGS[runtimeId][entry.flags.values().next().value];
    const takesValue = typeof spec?.value === 'function' || spec?.optionalCount || spec?.takesValue;
    if (entry.count > 1 && takesValue) throw new CliUsageError(`--${toKebab([...entry.flags][0])} was given more than once`);
  }

  if (options.configAction === 'import' && !options.configImportPath) {
    throw new CliUsageError('--import-config requires a path');
  }
  if (options.list > 0 && options.session) {
    throw new CliUsageError('--list and --session cannot be combined; list recent sessions or report one session');
  }
  return options;
}

/** Flags that take a value, for help-text and contract tests. */
export function valueFlagsFor(runtimeId) {
  return Object.entries(RUNTIME_FLAGS[runtimeId])
    .filter(([, spec]) => typeof spec.value === 'function' || spec.optionalCount)
    .map(([flag]) => `--${toKebab(flag)}`);
}
