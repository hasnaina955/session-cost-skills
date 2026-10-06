/**
 * session-cost — Command Code adapter
 *
 * Ports the session-cost-skills reporting architecture (hasnaina955/session-cost-skills)
 * to Command Code's own session ledger: ~/.commandcode/projects/<slug>/<session>.jsonl
 *
 * Provenance of the ledger facts (verified 2026-10-04, recorded here because a guessed
 * storage schema is the one failure this project exists to prevent):
 *   - Transcript location and shape: vendor docs, "Sessions & Checkpoints"
 *     (https://commandcode.ai/docs/sessions): one append-only JSONL per session, first
 *     line a header (session id, creation time, working directory), replies carry
 *     "token usage and cost".
 *   - Record schema and token semantics: the record shape was corroborated
 *     against an independent parser (tokscale's commandcode.rs), and the
 *     bucket semantics were settled call-by-call against a live install's
 *     recorded costUsd (#107). The v3 transcript's message lines are
 *     {type:"message", timestamp, message:{role}, usage:{inputTokens, outputTokens,
 *     cacheReadTokens, cacheWriteTokens, costUsd}, model}. The buckets are
 *     INCLUSIVE: inputTokens is the total prompt and contains the cache
 *     buckets. inputTokens minus the cache buckets, priced at the mirrored
 *     rates, reproduces the recorded costUsd exactly on every priced call of
 *     the install checked; the raw inputTokens never does. (An earlier draft
 *     of this note claimed the buckets were disjoint, on the parser's
 *     corroboration; the live ledger overturned it, so the code deducts the
 *     cached portion and reports the fresh input.)
 *   - Mod API: vendor docs, "Mods" (https://commandcode.ai/docs/mods): one TypeScript
 *     file at ~/.commandcode/mods/<name>.ts, default-export factory(cmd: ModApi),
 *     addCommand / addTool registration.
 *   - Peak windows: vendor docs, "Pricing & Limits": 01–04 & 06–10 UTC, Mon–Fri, peak
 *     billed at twice the off-peak rate on the banded models.
 * The one unverified claim is the subagent <usage> block format; it only ever feeds an
 * informational token counter, never a cost, so a wrong guess there cannot misprice.
 *
 * Accounting semantics (shared with the upstream skill):
 *   - the reported input field is fresh input: the ledger's inputTokens minus
 *     the cache buckets, so the reported buckets are disjoint
 *   - total prompt = input + cacheRead + cacheWrite
 *   - unknown models report tokens without a guessed cost
 *   - free-tier models (…-free / …:free) bill at $0
 *   - the ledger's own recorded costUsd is reported as a separate, labelled domain and
 *     never merged into the estimate (accounting rule 3)
 */
import type {ModApi} from '@commandcode/harness';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline';

const MOD_VERSION = '0.6.0';
// The transcript schema this parser understands (see the provenance note above). A ledger
// written by a newer Command Code may have renamed or reshaped fields, and parsing it
// anyway is how a tool produces plausible, wrong numbers (the upstream project's
// schema-drift rule: a renamed column must fail by name, never read as zero). A session
// whose header declares any other version is reported unpriced with the drift named.
const TRANSCRIPT_VERSION = 3;
const RATE_TABLE_VERSION = '2026-09-25';
const CONTRACT_VERSION = '1.2.0';
const RATES_REFRESH_URL = 'https://raw.githubusercontent.com/hasnaina955/session-cost-skills/main/adapters/mcode/skill/references/provider-rates.json';
const RATES_SIDECAR = path.join(os.homedir(), '.commandcode', 'session-cost.rates.json');
const CONFIG_PATH = path.join(os.homedir(), '.commandcode', 'session-cost.json');
const DASHBOARD_DIR = path.join(os.homedir(), '.commandcode', 'reports', 'session-cost');

// The reported clock. The upstream skills take every timestamp from
// shared/clock.mjs; a Command Code mod must be self-contained, so the
// equivalent lives here. SESSION_COST_NOW pins it to an ISO-8601 instant
// for byte-identical output, and an invalid value fails loudly instead of
// silently falling back to the real clock.
function clockNow(): string {
  const pinned = process.env.SESSION_COST_NOW;
  if (pinned) {
    if (!Number.isFinite(Date.parse(pinned))) {
      throw new Error('invalid SESSION_COST_NOW "' + pinned + '" (expected ISO-8601)');
    }
    return new Date(pinned).toISOString();
  }
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Rate table (per 1M tokens, USD) — mirrored from
// hasnaina955/session-cost-skills adapters/mcode/skill/references/provider-rates.json
// i=input o=output cr=cacheRead cw=cacheWrite; peak/off only on banded models.
// ---------------------------------------------------------------------------
interface RateComponents { i: number; o: number; cr: number; cw: number }
interface RateCard extends RateComponents { peak?: RateComponents; off?: RateComponents }

const RATES: Record<string, RateCard> = {"tencent/hy4-preview":{"i":0.834,"o":2.501,"cr":0.042,"cw":0},"tencent/hy3-paid":{"i":0.14,"o":0.58,"cr":0.035,"cw":0},"kimi-k3":{"i":3,"o":15,"cr":0.3,"cw":0},"kimi-k2.7-code":{"i":0.95,"o":4,"cr":0.19,"cw":0},"kimi-k2.7-code-highspeed":{"i":1.9,"o":8,"cr":0.38,"cw":0},"kimi-k2.6":{"i":0.95,"o":4,"cr":0.16,"cw":0},"kimi-k2.5":{"i":0.6,"o":3,"cr":0.1,"cw":0},"glm-5.3-flash":{"i":0.15,"o":0.5,"cr":0.03,"cw":0},"glm-5.3-flashx":{"i":0.37,"o":1.25,"cr":0.075,"cw":0},"glm-5.3":{"i":1.4,"o":4.4,"cr":0.26,"cw":0},"glm-5.2":{"i":1.4,"o":4.4,"cr":0.26,"cw":0},"glm-5.2-fast":{"i":3,"o":10.25,"cr":0.5,"cw":0},"glm-5.1":{"i":1.4,"o":4.4,"cr":0.26,"cw":0.26},"glm-5":{"i":1,"o":3.2,"cr":0.2,"cw":0},"minimax-m3":{"i":0.3,"o":1.2,"cr":0.06,"cw":0},"minimax-m2.7":{"i":0.3,"o":1.2,"cr":0.06,"cw":0.06},"minimax-m2.5":{"i":0.3,"o":1.2,"cr":0.03,"cw":0},"deepseek-v4-pro":{"i":0.66,"o":1.98,"cr":0.022,"cw":0,"peak":{"i":1.32,"o":3.96,"cr":0.044,"cw":0},"off":{"i":0.66,"o":1.98,"cr":0.022,"cw":0}},"deepseek-v4-flash":{"i":0.15,"o":0.6,"cr":0.003,"cw":0,"peak":{"i":0.3,"o":1.2,"cr":0.006,"cw":0},"off":{"i":0.15,"o":0.6,"cr":0.003,"cw":0}},"deepseek-v4-flash-vision-exp":{"i":0.15,"o":0.6,"cr":0.003,"cw":0,"peak":{"i":0.3,"o":1.2,"cr":0.006,"cw":0},"off":{"i":0.15,"o":0.6,"cr":0.003,"cw":0}},"deepseek-v4-flash-fast":{"i":0.28,"o":0.56,"cr":0.07,"cw":0},"deepseek-v4.1-flash":{"i":0.15,"o":0.6,"cr":0.003,"cw":0,"peak":{"i":0.3,"o":1.2,"cr":0.006,"cw":0},"off":{"i":0.15,"o":0.6,"cr":0.003,"cw":0}},"qwen-3.8-omni-flash":{"i":0.15,"o":0.47,"cr":0.016,"cw":0},"qwen-3.8-max-0902":{"i":2,"o":6,"cr":0.25,"cw":0},"qwen-3.8-max":{"i":2,"o":6,"cr":0.25,"cw":2.5},"qwen-3.8-27b":{"i":0.4,"o":3,"cr":0.04,"cw":0},"qwen-3.6-max":{"i":1.3,"o":7.8,"cr":0.26,"cw":1.63},"qwen-3.7-max":{"i":2.5,"o":7.5,"cr":0.5,"cw":3.13},"qwen-3.7-plus":{"i":0.4,"o":1.6,"cr":0.08,"cw":0.5},"qwen-3.8-flash":{"i":0.16,"o":0.47,"cr":0.016,"cw":0},"qwen-3.7-flash":{"i":0.03,"o":0.13,"cr":0.006,"cw":0.038},"longcat-2.0":{"i":0.3,"o":1.2,"cr":0.006,"cw":0},"step-5-preview":{"i":1,"o":2.7,"cr":0.05,"cw":0},"step-3.7-flash":{"i":0.2,"o":1.15,"cr":0.04,"cw":0},"step-3.5-flash":{"i":0.09,"o":0.3,"cr":0.02,"cw":0},"mimo-v2.6-pro":{"i":0.435,"o":0.87,"cr":0.0036,"cw":0},"mimo-v2.6-pro-ultraspeed":{"i":4.35,"o":8.7,"cr":0.036,"cw":0},"mimo-v2.6-flash":{"i":0.14,"o":0.28,"cr":0.0028,"cw":0},"mimo-v2.5-pro":{"i":0.435,"o":0.87,"cr":0.0036,"cw":0},"mimo-v2.5":{"i":0.14,"o":0.28,"cr":0.0028,"cw":0},"nemotron-3-ultra":{"i":0.6,"o":2.4,"cr":0.12,"cw":0},"inkling":{"i":1,"o":4.05,"cr":0.17,"cw":0},"inkling-small":{"i":0.5,"o":1.2,"cr":0.1,"cw":0},"claude-fable-5-1":{"i":10,"o":50,"cr":0.25,"cw":12.5},"claude-fable-5":{"i":10,"o":50,"cr":1,"cw":12.5},"claude-opus-5-5":{"i":4,"o":20,"cr":0.2,"cw":5},"claude-opus-5":{"i":5,"o":25,"cr":0.5,"cw":6.25},"claude-opus-4-8":{"i":5,"o":25,"cr":0.5,"cw":6.25},"claude-opus-4-7":{"i":5,"o":25,"cr":0.5,"cw":6.25},"claude-opus-4-6":{"i":5,"o":25,"cr":0.5,"cw":6.25},"claude-sonnet-5":{"i":2,"o":10,"cr":0.2,"cw":2.5},"claude-sonnet-4-6":{"i":3,"o":15,"cr":0.3,"cw":3.75},"claude-haiku-4-5":{"i":1,"o":5,"cr":0.1,"cw":1.25},"gpt-5.6-sol":{"i":5,"o":30,"cr":0.5,"cw":6.25},"gpt-5.6-terra":{"i":2,"o":12,"cr":0.2,"cw":2.5},"gpt-5.6-luna":{"i":0.2,"o":1.2,"cr":0.02,"cw":0.25},"gpt-5.5":{"i":5,"o":30,"cr":0.5,"cw":0},"gpt-6-astra":{"i":10,"o":50,"cr":1,"cw":12.5},"gpt-6-sol":{"i":2,"o":10,"cr":0.2,"cw":2.5},"gpt-6-luna":{"i":0.1,"o":0.5,"cr":0.01,"cw":0.125},"gpt-5.4":{"i":2.5,"o":15,"cr":0.25,"cw":0},"gpt-5.4-mini":{"i":0.75,"o":4.5,"cr":0.075,"cw":0},"gpt-5.3-codex":{"i":2,"o":8,"cr":0.5,"cw":0},"gemini-3.8-flash":{"i":1.5,"o":7.5,"cr":0.15,"cw":0},"gemini-3.7-flash":{"i":1.5,"o":7.5,"cr":0.15,"cw":0.08334},"gemini-3.6-flash":{"i":1.5,"o":7.5,"cr":0.15,"cw":0},"gemini-3.5-flash":{"i":1.5,"o":9,"cr":0.15,"cw":0},"gemini-3.5-flash-lite":{"i":0.3,"o":2.5,"cr":0.03,"cw":0},"gemini-3.1-flash-lite":{"i":0.25,"o":1.5,"cr":0.03,"cw":0},"fugu-ultra":{"i":5,"o":30,"cr":0.5,"cw":0},"muse-spark-1.1":{"i":1.25,"o":4.25,"cr":0.15,"cw":0},"muse-spark-1.2":{"i":1.25,"o":4.25,"cr":0.15,"cw":0},"muse-spark-1.2-contributor":{"i":0.1,"o":0.2,"cr":0.002,"cw":0},"muse-spark-1.3":{"i":1.25,"o":4.25,"cr":0.15,"cw":0},"muse-spark-1.3-contributor":{"i":0.1,"o":0.2,"cr":0.002,"cw":0},"grok-4.5":{"i":2,"o":6,"cr":0.5,"cw":0},"grok-4.6":{"i":2,"o":6,"cr":0.5,"cw":0},"grok-4.7":{"i":1.2,"o":3.6,"cr":0.3,"cw":0}};

// ---------------------------------------------------------------------------
// Model matching
// ---------------------------------------------------------------------------
interface ModelIdentity { key: string; free: boolean }

function normalizeModel(raw: string): ModelIdentity {
  let m = raw.toLowerCase().trim();
  const free = m.includes(':free') || m.includes('-free');
  m = m.replace(/:free$/, '').replace(/-free$/, '');
  const slash = m.lastIndexOf('/');
  if (slash >= 0) m = m.slice(slash + 1);
  return {key: m, free};
}

// Fallback for prefix-less spellings like "qwen3.7-flash" → "qwen-3.7-flash"
function dashInsert(key: string): string {
  return key.replace(/([a-z])(\d)/g, '$1-$2');
}

// Provider label per model-id prefix (matches the upstream rate table's providers)
const PROVIDER_BY_PREFIX: Record<string, string> = {
  claude: 'Anthropic', gpt: 'OpenAI', gemini: 'Google', deepseek: 'DeepSeek',
  glm: 'Z.ai', kimi: 'Moonshot AI', mimo: 'Xiaomi', minimax: 'MiniMax',
  grok: 'xAI', muse: 'Meta', step: 'StepFun', qwen: 'Alibaba',
  longcat: 'Meituan', inkling: 'Thinking Machines', fugu: 'Sakana',
  nemotron: 'NVIDIA', tencent: 'Tencent',
};

function providerOf(modelId: string): string {
  for (const [prefix, label] of Object.entries(PROVIDER_BY_PREFIX)) {
    if (modelId.startsWith(prefix)) return label;
  }
  return 'Other';
}

// Active rate table: a refreshed sidecar (~/.commandcode/session-cost.rates.json)
// wins over the embedded snapshot, mirroring the upstream refresh model.
let cachedRates: {rates: Record<string, RateCard>; version: string; source: string} | null = null;

function getRates(): {rates: Record<string, RateCard>; version: string; source: string} {
  if (cachedRates) return cachedRates;
  try {
    const sidecar = JSON.parse(fs.readFileSync(RATES_SIDECAR, 'utf8'));
    if (sidecar && sidecar.models && Object.keys(sidecar.models).length > 0) {
      const version = String(sidecar.sourceRefreshedAt || sidecar.refreshedAt || '').slice(0, 10) || RATE_TABLE_VERSION;
      cachedRates = {rates: sidecar.models, version, source: 'refreshed ' + String(sidecar.refreshedAt || '')};
      return cachedRates;
    }
  } catch {
    // no sidecar — embedded table
  }
  cachedRates = {rates: RATES, version: RATE_TABLE_VERSION, source: 'embedded'};
  return cachedRates;
}

function matchRateCard(rawModel: string, aliases?: Map<string, string>): {card: RateCard | null; free: boolean; matchedKey: string | null; viaAlias: boolean} {
  const {key, free} = normalizeModel(rawModel);
  if (free) return {card: {i: 0, o: 0, cr: 0, cw: 0}, free: true, matchedKey: key, viaAlias: false};
  const aliasTarget = aliases?.get(key);
  if (aliasTarget) {
    const card = getRates().rates[aliasTarget];
    if (card) return {card, free: false, matchedKey: aliasTarget, viaAlias: true};
  }
  const rates = getRates().rates;
  if (rates[key]) return {card: rates[key], free: false, matchedKey: key, viaAlias: false};
  const dashed = dashInsert(key);
  if (dashed !== key && rates[dashed]) return {card: rates[dashed], free: false, matchedKey: dashed, viaAlias: false};
  return {card: null, free: false, matchedKey: null, viaAlias: false};
}

// CommandCode peak window: 01-04 & 06-10 UTC, Mon-Fri
function isPeakUtc(date: Date): boolean {
  const day = date.getUTCDay();
  const h = date.getUTCHours();
  const weekday = day >= 1 && day <= 5;
  return weekday && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
}

// ---------------------------------------------------------------------------
// Ledger reading
// ---------------------------------------------------------------------------
interface CallRecord {
  ts: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  band: 'peak' | 'off-peak' | 'flat' | 'free' | 'unknown';
  costUsd: number | null; // null = unpriced
  // Why a call is unpriced, when it is: the model has no rate card, or a banded call had no
  // usable timestamp. The reasons must not be conflated: only one of them means the rate
  // table lacks the model.
  unpricedReason: 'no-rate-card' | 'unknown-time' | null;
  // The ledger's own figure for this call, when the transcript carries one. A separate,
  // labelled domain from the estimate above (accounting rule 3); the two are never merged.
  recordedCostUsd: number | null;
}

interface ModelAggregate {
  model: string;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number | null;
}

interface SessionData {
  id: string;
  file: string;
  project: string;
  startedAt: string | null;
  endedAt: string | null;
  calls: CallRecord[];
  subagentTokens: number;
  subagentBlocks: number;
  schemaDrift: number | null;
}

interface SessionMeta {
  file: string;
  id: string;
  mtimeMs: number;
  startedAt: string | null;
  project: string;
  version: number | null;
}

function readSessionMeta(file: string): SessionMeta {
  const stat = fs.statSync(file);
  let startedAt: string | null = null;
  let project = '';
  let version: number | null = null;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const firstLine = buf.toString('utf8', 0, n).split('\n')[0] || '';
    try {
      const rec = JSON.parse(firstLine);
      if (rec && rec.type === 'session') {
        startedAt = typeof rec.timestamp === 'string' ? rec.timestamp : null;
        project = typeof rec.cwd === 'string' ? rec.cwd : '';
        version = typeof rec.version === 'number' && Number.isFinite(rec.version) ? rec.version : null;
      }
    } catch {
      // first line not a session record — fall back to mtime
    }
  } catch {
    // unreadable — caller skips
  }
  return {file, id: path.basename(file, '.jsonl'), mtimeMs: stat.mtimeMs, startedAt, project, version};
}

function discoverSessions(dataDir: string): SessionMeta[] {
  const out: SessionMeta[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, {withFileTypes: true});
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.name.endsWith('.jsonl') && !e.name.includes('checkpoints')) {
        try {
          out.push(readSessionMeta(p));
        } catch {
          // skip unreadable
        }
      }
    }
  };
  walk(dataDir);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function parseSession(meta: SessionMeta, aliases?: Map<string, string>): Promise<SessionData> {
  const calls: CallRecord[] = [];
  // A ledger whose header declares a schema this mod does not understand is not parsed:
  // reading renamed fields as zeros is how a cost tool lies. The session is reported
  // unpriced with the drift named, never guessed.
  if (meta.version !== null && meta.version !== TRANSCRIPT_VERSION) {
    return {
      id: meta.id,
      file: meta.file,
      project: meta.project,
      startedAt: meta.startedAt,
      endedAt: meta.startedAt,
      calls,
      subagentTokens: 0,
      subagentBlocks: 0,
      schemaDrift: meta.version,
    };
  }
  let subagentTokens = 0;
  let subagentBlocks = 0;
  let endedAt: string | null = null;

  const stream = fs.createReadStream(meta.file);
  const rl = readline.createInterface({input: stream, crlfDelay: Infinity});
  for await (const line of rl) {
    // cheap pre-filter: assistant usage records carry "usage", subagent blocks carry <usage>
    if (!line.includes('"usage"') && !line.includes('<usage>')) continue;

    const subagentMatch = line.match(/<usage>total_tokens:\s*(\d+)/);
    if (subagentMatch) {
      subagentBlocks++;
      subagentTokens += Number(subagentMatch[1]);
    }

    if (!line.includes('"usage"')) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec?.type !== 'message' || rec?.message?.role !== 'assistant' || !rec.usage) continue;
    const u = rec.usage;
    const model = typeof rec.model === 'string' ? rec.model : 'unknown';
    // The line's own timestamp is the only one pricing may use. Falling back to the session's
    // start for display is fine, but pricing a banded call at a time it did not happen is the
    // silent-cheapest-band failure (upstream #100): new Date('') is an invalid date whose
    // getters are NaN, and NaN fails every peak comparison, so the call would price off-peak -
    // the cheaper band - while saying nothing.
    const ownTs = typeof rec.timestamp === 'string' ? rec.timestamp : '';
    const ts = ownTs || meta.startedAt || '';
    if (ts) endedAt = ts;
    const tsUsable = ownTs !== '' && Number.isFinite(Date.parse(ownTs));

    // The v3 ledger's inputTokens is the TOTAL prompt tokens: the cache buckets are
    // included in it, not disjoint from it. A live install settles this call by call
    // (#107): inputTokens minus cacheReadTokens minus cacheWriteTokens, priced at the
    // mirrored rates, reproduces the ledger's recorded costUsd exactly on every priced
    // call, while the raw figure never does. Pricing the raw inputTokens would
    // double-count every cached token at the input rate, so the fresh input is what
    // the CallRecord carries; the reported buckets stay disjoint and
    // inputTokenMeaning 'excludes-cache' stays truthful. The clamp guards a malformed
    // usage block whose cache buckets exceed its total, which would otherwise price a
    // negative input.
    const output = Number(u.outputTokens || 0);
    const cacheRead = Number(u.cacheReadTokens || 0);
    const cacheWrite = Number(u.cacheWriteTokens || 0);
    const input = Math.max(0, Number(u.inputTokens || 0) - cacheRead - cacheWrite);
    const recordedCostUsd = typeof u.costUsd === 'number' && Number.isFinite(u.costUsd) ? u.costUsd : null;

    const {card, free, matchedKey} = matchRateCard(model, aliases);
    let band: CallRecord['band'];
    let costUsd: number | null = null;
    let unpricedReason: CallRecord['unpricedReason'] = null;
    if (free) {
      band = 'free';
      costUsd = 0;
    } else if (!card) {
      band = 'unknown';
      unpricedReason = 'no-rate-card';
    } else if (card.peak && card.off && !tsUsable) {
      // A banded call whose time is unknown is unpriced, never priced at the cheaper band.
      band = 'unknown';
      unpricedReason = 'unknown-time';
    } else {
      let components = card;
      if (card.peak && card.off) {
        const peak = isPeakUtc(new Date(ownTs));
        band = peak ? 'peak' : 'off-peak';
        components = peak ? card.peak : card.off;
      } else {
        band = 'flat';
      }
      costUsd =
        (input / 1e6) * components.i +
        (output / 1e6) * components.o +
        (cacheRead / 1e6) * components.cr +
        (cacheWrite / 1e6) * components.cw;
    }
    void matchedKey;
    calls.push({ts, model, input, output, cacheRead, cacheWrite, band, costUsd, recordedCostUsd, unpricedReason});
  }

  return {
    id: meta.id,
    file: meta.file,
    project: meta.project,
    startedAt: meta.startedAt,
    endedAt,
    calls,
    subagentTokens,
    subagentBlocks,
    schemaDrift: null,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------
interface SessionSummary {
  id: string;
  file: string;
  project: string;
  startedAt: string | null;
  endedAt: string | null;
  callCount: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number | null; // null when any call was unpriced
  pricedCostUsd: number;
  // Call-level verdicts: a session whose calls share one model can still be a mix of priced
  // and unpriced, and only the counts say so honestly (upstream #103).
  pricedCallCount: number;
  unpricedCallCount: number;
  timelessBandedCalls: number;
  // The ledger's own total for the calls that carried one; null when no call did. A
  // separate domain from costUsd/pricedCostUsd, never merged into either.
  recordedCostUsd: number | null;
  // The transcript version a drifted session declared, or null when the schema matched.
  schemaDrift: number | null;
  models: ModelAggregate[];
  unpricedModels: string[];
  peakCostUsd: number;
  offPeakCostUsd: number;
  subagentTokens: number;
  subagentBlocks: number;
}

function summarize(data: SessionData): SessionSummary {
  const byModel = new Map<string, ModelAggregate>();
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let pricedCostUsd = 0;
  let hasUnpriced = false;
  let peakCostUsd = 0;
  let offPeakCostUsd = 0;
  const unpricedSet = new Set<string>();

  let recordedCostUsd = 0;
  let recordedCalls = 0;
  let pricedCalls = 0;
  let unpricedCalls = 0;
  let timelessBandedCalls = 0;
  for (const c of data.calls) {
    input += c.input;
    output += c.output;
    cacheRead += c.cacheRead;
    cacheWrite += c.cacheWrite;
    if (c.recordedCostUsd !== null) {
      recordedCostUsd += c.recordedCostUsd;
      recordedCalls++;
    }
    let agg = byModel.get(c.model);
    if (!agg) {
      agg = {model: c.model, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0};
      byModel.set(c.model, agg);
    }
    agg.calls++;
    agg.input += c.input;
    agg.output += c.output;
    agg.cacheRead += c.cacheRead;
    agg.cacheWrite += c.cacheWrite;
    if (c.costUsd === null) {
      hasUnpriced = true;
      unpricedCalls++;
      if (c.unpricedReason === 'unknown-time') timelessBandedCalls++;
      else unpricedSet.add(c.model);
      agg.costUsd = null;
    } else {
      pricedCalls++;
      pricedCostUsd += c.costUsd;
      if (agg.costUsd !== null) agg.costUsd += c.costUsd;
      if (c.band === 'peak') peakCostUsd += c.costUsd;
      else if (c.band === 'off-peak') offPeakCostUsd += c.costUsd;
    }
  }

  const models = [...byModel.values()].sort((a, b) => b.calls - a.calls);
  return {
    id: data.id,
    file: data.file,
    project: data.project,
    startedAt: data.startedAt,
    endedAt: data.endedAt,
    callCount: data.calls.length,
    input,
    output,
    cacheRead,
    cacheWrite,
    // A drifted transcript was not parsed at all: its cost is unknown, not the $0 an empty
    // call list would produce (rule 1).
    costUsd: data.schemaDrift !== null ? null : (hasUnpriced ? null : pricedCostUsd),
    pricedCostUsd,
    pricedCallCount: pricedCalls,
    unpricedCallCount: unpricedCalls,
    timelessBandedCalls,
    recordedCostUsd: recordedCalls > 0 ? recordedCostUsd : null,
    schemaDrift: data.schemaDrift,
    models,
    unpricedModels: [...unpricedSet].sort(),
    peakCostUsd,
    offPeakCostUsd,
    subagentTokens: data.subagentTokens,
    subagentBlocks: data.subagentBlocks,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtCost(n: number | null): string {
  if (n === null) return 'unpriced';
  return '$' + n.toFixed(4);
}

function fmtDay(iso: string | null): string {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function sessionCard(s: SessionSummary, includeChildren: boolean, cacheThreshold?: number): string[] {
  const lines: string[] = [];
  lines.push('session-cost · commandcode adapter v' + MOD_VERSION);
  lines.push('session  ' + s.id);
  if (s.project) lines.push('project  ' + s.project);
  lines.push('window   ' + fmtDay(s.startedAt) + ' → ' + fmtDay(s.endedAt));
  lines.push('calls    ' + s.callCount);
  const prompt = s.input + s.cacheRead + s.cacheWrite;
  lines.push('tokens   ' + fmtTokens(prompt) + ' prompt (' + fmtTokens(s.input) + ' in + ' +
    fmtTokens(s.cacheRead) + ' cache read + ' + fmtTokens(s.cacheWrite) + ' cache write) · ' +
    fmtTokens(s.output) + ' out');
  if (cacheThreshold !== undefined && prompt > 0 && s.cacheRead / prompt < cacheThreshold) {
    lines.push('cache    cache-read share ' + ((s.cacheRead / prompt) * 100).toFixed(1) +
      '% is below the ' + (cacheThreshold * 100).toFixed(0) + '% threshold (warnOnCacheRateBelow)');
  }
  lines.push('cost     ' + fmtCost(s.costUsd) +
    (s.pricedCostUsd > 0 ? '  (priced ' + fmtCost(s.pricedCostUsd) + ' · peak ' + fmtCost(s.peakCostUsd) +
      ' · off-peak ' + fmtCost(s.offPeakCostUsd) + ')' : ''));
  for (const m of s.models.slice(0, 8)) {
    lines.push('  ' + m.model + ' — ' + m.calls + ' calls · ' +
      fmtTokens(m.input + m.output + m.cacheRead + m.cacheWrite) + ' tok · ' + fmtCost(m.costUsd));
  }
  if (s.models.length > 8) lines.push('  … +' + (s.models.length - 8) + ' more models');
  if (s.unpricedModels.length > 0) {
    lines.push('unpriced ' + s.unpricedModels.join(', '));
  }
  if (s.subagentBlocks > 0) {
    lines.push('subagent ' + s.subagentBlocks + ' blocks · ' + fmtTokens(s.subagentTokens) +
      ' tokens' + (includeChildren ? ' (included in tokens above, model not recorded — unpriced)' : ' (unpriced — model not recorded; use --include-children to fold into totals)'));
  }
  return lines;
}

function totalsSummary(summaries: SessionSummary[]): SessionSummary {
  const t: SessionSummary = {
    id: summaries.length + ' session(s)',
    file: '',
    project: '',
    startedAt: summaries.map((s) => s.startedAt).filter(Boolean).sort()[0] || null,
    endedAt: summaries.map((s) => s.endedAt).filter(Boolean).sort().pop() || null,
    callCount: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
    pricedCostUsd: 0,
    pricedCallCount: 0,
    unpricedCallCount: 0,
    timelessBandedCalls: 0,
    recordedCostUsd: null,
    schemaDrift: null,
    models: [],
    unpricedModels: [],
    peakCostUsd: 0,
    offPeakCostUsd: 0,
    subagentTokens: 0,
    subagentBlocks: 0,
  };
  const byModel = new Map<string, ModelAggregate>();
  let hasUnpriced = false;
  let recordedTotal = 0;
  let recordedSessions = 0;
  const unpricedSet = new Set<string>();
  for (const s of summaries) {
    t.callCount += s.callCount;
    t.input += s.input;
    t.output += s.output;
    t.cacheRead += s.cacheRead;
    t.cacheWrite += s.cacheWrite;
    t.pricedCostUsd += s.pricedCostUsd;
    t.peakCostUsd += s.peakCostUsd;
    t.offPeakCostUsd += s.offPeakCostUsd;
    if (s.recordedCostUsd !== null) {
      recordedTotal += s.recordedCostUsd;
      recordedSessions++;
    }
    t.pricedCallCount += s.pricedCallCount;
    t.unpricedCallCount += s.unpricedCallCount;
    t.timelessBandedCalls += s.timelessBandedCalls;
    t.subagentTokens += s.subagentTokens;
    t.subagentBlocks += s.subagentBlocks;
    if (s.costUsd === null) hasUnpriced = true;
    for (const m of s.unpricedModels) unpricedSet.add(m);
    for (const m of s.models) {
      const agg = byModel.get(m.model) || {model: m.model, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0};
      agg.calls += m.calls;
      agg.input += m.input;
      agg.output += m.output;
      agg.cacheRead += m.cacheRead;
      agg.cacheWrite += m.cacheWrite;
      if (m.costUsd === null) agg.costUsd = null;
      else if (agg.costUsd !== null) agg.costUsd += m.costUsd;
      byModel.set(m.model, agg);
    }
  }
  t.costUsd = hasUnpriced ? null : t.pricedCostUsd;
  t.recordedCostUsd = recordedSessions > 0 ? recordedTotal : null;
  t.models = [...byModel.values()].sort((a, b) => b.calls - a.calls);
  t.unpricedModels = [...unpricedSet].sort();
  return t;
}

// ---------------------------------------------------------------------------
// JSON contract
// ---------------------------------------------------------------------------
function toJson(summaries: SessionSummary[], mode: string, selection: {method: string; requestedId: string | null; candidateIds: string[]}): string {
  const totals = totalsSummary(summaries);
  const calls = summaries.reduce((n, s) => n + s.callCount, 0);
  const totalTokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  // The verdict reads CALLS, not models: a single model can mix priced calls with unpriced
  // ones (a torn timestamp, a model the mirror lacks), and the model-level figure alone cannot
  // say so (upstream #103). The estimate is the priced sum whenever at least one call priced -
  // a disclosed lower bound - and null only when nothing priced at all, because the sum of
  // zero priced calls is the absence of a figure, not $0 (rule 1).
  const estimatedCostUsd = totals.pricedCallCount > 0 ? totals.pricedCostUsd : null;
  const coverageStatus = calls === 0
    ? 'no-calls'
    : estimatedCostUsd === null
      ? 'unavailable'
      : totals.unpricedCallCount > 0 ? 'partial' : 'complete';
  // Models with no rate card at all, for the coverage reason below. A banded call with a
  // missing timestamp is unpriced for a different reason and is named separately.
  const unknownModels = totals.models.filter((m) => totals.unpricedModels.includes(m.model));
  const promptTokens = totals.input + totals.cacheRead + totals.cacheWrite;
  const cacheHitRate = promptTokens > 0 ? totals.cacheRead / promptTokens : 0;
  const sessionOut = summaries.map((s) => ({
    id: s.id,
    project: s.project || undefined,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    calls: s.callCount,
    tokens: {
      input: s.input,
      output: s.output,
      cacheRead: s.cacheRead,
      cacheWrite: s.cacheWrite,
      subagent: s.subagentTokens,
    },
    costUsd: s.costUsd,
    pricedCostUsd: s.pricedCostUsd,
    // The ledger's own figure, a separate labelled domain (rule 3): present when the
    // transcript carried per-call costUsd, null when it did not.
    recordedCostUsd: s.recordedCostUsd,
    peakCostUsd: s.peakCostUsd,
    offPeakCostUsd: s.offPeakCostUsd,
    schemaDrift: s.schemaDrift,
    models: s.models.map((m) => ({
      model: m.model,
      calls: m.calls,
      tokens: {input: m.input, output: m.output, cacheRead: m.cacheRead, cacheWrite: m.cacheWrite},
      costUsd: m.costUsd,
      rateKnown: m.costUsd !== null,
    })),
    unpricedModels: s.unpricedModels,
    subagent: {blocks: s.subagentBlocks, tokens: s.subagentTokens},
  }));
  const warnings: string[] = [];
  const drifted = summaries.filter((s) => s.schemaDrift !== null);
  for (const s of drifted) {
    warnings.push(
      `session ${s.id} uses transcript version ${s.schemaDrift}, which this mod does not understand ` +
      `(expected ${TRANSCRIPT_VERSION}); it is reported unpriced rather than guessed`,
    );
  }
  if (totals.unpricedModels.length > 0) {
    warnings.push('unpriced models reported without a guessed cost: ' + totals.unpricedModels.join(', '));
  }
  if (totals.subagentTokens > 0) {
    warnings.push('subagent usage blocks are tracked separately; pass --include-children to fold them into totals');
  }
  // The drift tripwire. The vendor's own arithmetic reproduces the ledger's recorded costUsd
  // from the mirrored rates exactly (see the provenance note), so the two domains should agree
  // almost to the digit. A material disagreement means the mirror is stale or the vendor
  // changed pricing - the estimate is the figure at risk, and the warning says so rather than
  // letting two plausible totals coexist silently.
  const estimated = totals.pricedCostUsd;
  if (totals.recordedCostUsd !== null && estimated > 0) {
    const gap = Math.abs(totals.recordedCostUsd - estimated);
    if (gap > Math.max(1e-6, totals.recordedCostUsd * 0.01)) {
      warnings.push(
        `the ledger-recorded cost ($${totals.recordedCostUsd.toFixed(6)}) and the mirrored-rate estimate ` +
        `($${estimated.toFixed(6)}) disagree; the mirrored rate table may be stale (run --refresh-rates)`,
      );
    }
  }
  return JSON.stringify({
    schemaVersion: 1,
    contractVersion: CONTRACT_VERSION,
    generatedAt: clockNow(),
    runtime: {
      id: 'commandcode',
      costBasis: 'provider-rate-estimate',
      storageSource: '~/.commandcode/projects',
    },
    snapshot: {
      capturedAt: clockNow(),
      active: mode === 'current',
      state: mode === 'current' ? 'snapshot' : 'final',
      lastLedgerActivityAt: summaries.length > 0 ? (summaries[summaries.length - 1].endedAt ?? null) : null,
    },
    selection: {
      method: selection.method,
      requestedId: selection.requestedId,
      candidateIds: selection.candidateIds,
      warning: null,
    },
    usage: {
      totalTokens,
      inputTokens: totals.input,
      freshInputTokens: totals.input,
      cacheReadTokens: totals.cacheRead,
      cacheWriteTokens: totals.cacheWrite,
      outputTokens: totals.output,
      cacheHitRate,
      semantics: {
        inputTokenMeaning: 'excludes-cache',
        cacheReadTokensSeparate: true,
        cacheWriteTokensSeparate: true,
        reasoningIncludedInOutput: 'not-reported',
      },
    },
    billing: {
      basis: 'provider-rate-estimate',
      currency: 'USD',
      amountUsd: estimatedCostUsd,
      recordedCostUsd: null,
      estimatedCostUsd,
      rateKnown: totals.unpricedCallCount === 0,
      coverage: coverageStatus,
      classification: estimatedCostUsd === null ? 'cost-unavailable' : 'rate-estimated',
      label: null,
      evidence: null,
    },
    coverage: {
      status: coverageStatus,
      calls,
      totalTokens,
      unknownReasons: [
        ...(unknownModels.length > 0
          ? ['no applicable rate card: ' + unknownModels.map((m) => m.model).join(', ')]
          : []),
        ...(totals.timelessBandedCalls > 0
          ? [totals.timelessBandedCalls + ' banded call(s) had no usable timestamp and were not priced']
          : []),
      ],
    },
    sessionGraph: {
      rootSessionIds: summaries.map((s) => s.id),
      includedSessionIds: summaries.map((s) => s.id),
      excludedSessionIds: [],
      duplicateSuppressedSessionIds: [],
    },
    provenance: {
      kind: 'mirrored-provider-rate-table',
      source: RATES_REFRESH_URL,
      rateSources: ['rate-table:' + getRates().version],
      callCountKnown: true,
    },
    warnings,
    // Command Code extensions (the contract permits additional properties)
    mode,
    rateTable: getRates().version,
    models: totals.models.map((m) => ({
      model: m.model,
      calls: m.calls,
      tokens: {input: m.input, output: m.output, cacheRead: m.cacheRead, cacheWrite: m.cacheWrite},
      costUsd: m.costUsd,
      rateKnown: m.costUsd !== null,
    })),
    sessions: sessionOut,
    totals: {
      sessions: summaries.length,
      calls,
      tokens: {input: totals.input, output: totals.output, cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite, subagent: totals.subagentTokens},
      costUsd: totals.costUsd,
      pricedCostUsd: totals.pricedCostUsd,
      recordedCostUsd: totals.recordedCostUsd,
      peakCostUsd: totals.peakCostUsd,
      offPeakCostUsd: totals.offPeakCostUsd,
      unpricedModels: totals.unpricedModels,
    },
  }, null, 2);
}

// ---------------------------------------------------------------------------
// Config (~/.commandcode/session-cost.json)
// ---------------------------------------------------------------------------
interface SessionCostConfig {
  standingSummary?: boolean;
  includeChildren?: boolean;
  defaultFormat?: 'compact' | 'json';
  warnOnCacheRateBelow?: number;
  liveStatus?: boolean;
  models?: {runtimeModel?: string; rateModel?: string}[];
}

function loadConfig(configPath?: string): {config: SessionCostConfig; file: string; exists: boolean; errors: string[]} {
  const file = configPath || CONFIG_PATH;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const {valid, errors} = validateConfig(raw);
    return {config: raw, file, exists: true, errors: valid ? [] : errors};
  } catch {
    return {config: {}, file, exists: false, errors: []};
  }
}

function validateConfig(c: any): {valid: boolean; errors: string[]} {
  const errors: string[] = [];
  if (c == null || typeof c !== 'object') return {valid: false, errors: ['config must be a JSON object']};
  if (c.standingSummary !== undefined && typeof c.standingSummary !== 'boolean') errors.push('standingSummary must be a boolean');
  if (c.includeChildren !== undefined && typeof c.includeChildren !== 'boolean') errors.push('includeChildren must be a boolean');
  if (c.defaultFormat !== undefined && !['compact', 'json'].includes(c.defaultFormat)) errors.push('defaultFormat must be "compact" or "json"');
  if (c.warnOnCacheRateBelow !== undefined && (typeof c.warnOnCacheRateBelow !== 'number' || c.warnOnCacheRateBelow < 0 || c.warnOnCacheRateBelow > 1)) errors.push('warnOnCacheRateBelow must be a number between 0 and 1');
  if (c.liveStatus !== undefined && typeof c.liveStatus !== 'boolean') errors.push('liveStatus must be a boolean');
  if (c.models !== undefined) {
    if (!Array.isArray(c.models)) errors.push('models must be an array');
    else for (const m of c.models) {
      if (!m || typeof m.runtimeModel !== 'string' || typeof m.rateModel !== 'string') {
        errors.push('each models entry needs string runtimeModel and rateModel');
        break;
      }
    }
  }
  return {valid: errors.length === 0, errors};
}

function configAliases(config: SessionCostConfig): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of config.models || []) {
    if (m.runtimeModel && m.rateModel) {
      map.set(normalizeModel(m.runtimeModel).key, normalizeModel(m.rateModel).key);
    }
  }
  return map;
}

const CONFIG_TEMPLATE: SessionCostConfig = {
  standingSummary: false,
  includeChildren: false,
  defaultFormat: 'compact',
  warnOnCacheRateBelow: 0.6,
  liveStatus: true,
  models: [{runtimeModel: 'my-custom-model', rateModel: 'deepseek-v4.1-flash'}],
};

// ---------------------------------------------------------------------------
// Rate refresh (mirrors the upstream --refresh-rates)
// ---------------------------------------------------------------------------
async function refreshRates(): Promise<string> {
  const res = await fetch(RATES_REFRESH_URL);
  if (!res.ok) return 'session-cost: rate refresh failed — HTTP ' + res.status + ' from ' + RATES_REFRESH_URL;
  let data: any;
  try {
    data = await res.json();
  } catch {
    return 'session-cost: rate refresh failed — unparseable response from ' + RATES_REFRESH_URL;
  }
  const models = data?.providers?.commandcode?.models;
  if (!models || typeof models !== 'object') {
    return 'session-cost: rate refresh failed — no commandcode models in response';
  }
  const compact: Record<string, RateCard> = {};
  for (const [id, m] of Object.entries<any>(models)) {
    const card: RateCard = {i: m.input, o: m.output, cr: m.cacheRead, cw: m.cacheWrite};
    if (m.timeOfDay?.peak && m.timeOfDay?.offPeak) {
      card.peak = {i: m.timeOfDay.peak.input, o: m.timeOfDay.peak.output, cr: m.timeOfDay.peak.cacheRead, cw: m.timeOfDay.peak.cacheWrite};
      card.off = {i: m.timeOfDay.offPeak.input, o: m.timeOfDay.offPeak.output, cr: m.timeOfDay.offPeak.cacheRead, cw: m.timeOfDay.offPeak.cacheWrite};
    }
    compact[id] = card;
  }
  const sidecar = {
    refreshedAt: clockNow(),
    source: RATES_REFRESH_URL,
    sourceRefreshedAt: data?._meta?.refreshedAt,
    models: compact,
  };
  const tmp = RATES_SIDECAR + '.tmp';
  fs.mkdirSync(path.dirname(RATES_SIDECAR), {recursive: true});
  fs.writeFileSync(tmp, JSON.stringify(sidecar, null, 2));
  fs.renameSync(tmp, RATES_SIDECAR);
  cachedRates = null; // force reload from sidecar
  const fresh = getRates();
  return 'session-cost: rates refreshed — ' + Object.keys(compact).length + ' models (source table ' +
    String(data?._meta?.refreshedAt || 'unknown').slice(0, 10) + ') → ' + RATES_SIDECAR +
    '\nactive table now: ' + fresh.version + ' (' + fresh.source + ')';
}

// ---------------------------------------------------------------------------
// doctor / providers / models / config explain / version
// ---------------------------------------------------------------------------
async function doctorReport(opts: ReportOptions): Promise<string> {
  const {config, file, exists, errors} = loadConfig(opts.configPath);
  const fresh = getRates();
  const dataDir = opts.dataDir || defaultDataDir();
  const sessions = fs.existsSync(dataDir) ? discoverSessions(dataDir) : [];
  let bytes = 0;
  for (const m of sessions) {
    try { bytes += fs.statSync(m.file).size; } catch { /* gone */ }
  }
  const aliases = configAliases(config);
  let calls = 0;
  let prompt = 0;
  let cacheRead = 0;
  for (const meta of sessions) {
    const s = summarize(await parseSession(meta, aliases));
    calls += s.callCount;
    prompt += s.input + s.cacheRead + s.cacheWrite;
    cacheRead += s.cacheRead;
  }
  const cacheShare = prompt > 0 ? cacheRead / prompt : 0;
  const threshold = typeof config.warnOnCacheRateBelow === 'number' ? config.warnOnCacheRateBelow : 0.6;
  const lines = [
    'session-cost doctor · commandcode adapter',
    'mod        v' + MOD_VERSION + ' (contract ' + CONTRACT_VERSION + ')',
    'rates      ' + Object.keys(fresh.rates).length + ' models · ' + fresh.version + ' · ' + fresh.source,
    'ledger     ' + dataDir,
    '           ' + sessions.length + ' sessions · ' + fmtTokens(bytes) + ' on disk · ' + calls + ' calls',
    'config     ' + (exists ? file : 'not found (' + file + ') — defaults active'),
  ];
  if (errors.length > 0) lines.push('           INVALID: ' + errors.join('; '));
  lines.push(
    'cache      cache-read share ' + (cacheShare * 100).toFixed(1) + '% of prompt tokens' +
    (cacheShare < threshold ? ' — BELOW ' + (threshold * 100).toFixed(0) + '% threshold (warnOnCacheRateBelow)' : ' — OK (threshold ' + (threshold * 100).toFixed(0) + '%)'),
  );
  lines.push('node       ' + process.version);
  return lines.join('\n');
}

function providersReport(): string {
  const {rates, version, source} = getRates();
  const byProvider = new Map<string, {models: number; minIn: number; maxIn: number; banded: number}>();
  for (const [id, card] of Object.entries(rates)) {
    const p = providerOf(id);
    const agg = byProvider.get(p) || {models: 0, minIn: Infinity, maxIn: 0, banded: 0};
    agg.models++;
    agg.minIn = Math.min(agg.minIn, card.i);
    agg.maxIn = Math.max(agg.maxIn, card.i);
    if (card.peak) agg.banded++;
    byProvider.set(p, agg);
  }
  const rows = [...byProvider.entries()].sort((a, b) => b[1].models - a[1].models)
    .map(([p, a]) => p.padEnd(20) + String(a.models).padStart(3) + ' models  input $' +
      a.minIn + '–$' + a.maxIn + '/1M' + (a.banded > 0 ? '  (' + a.banded + ' peak-banded)' : ''));
  return [
    'session-cost · provider drivers (rate table ' + version + ', ' + source + ')',
    ...rows,
    '',
    'driver: commandcode (mirrored provider rates, per 1M tokens, USD)',
  ].join('\n');
}

function modelsReport(): string {
  const {rates, version, source} = getRates();
  const rows = Object.entries(rates)
    .sort(([a], [b]) => providerOf(a).localeCompare(providerOf(b)) || a.localeCompare(b))
    .map(([id, c]) =>
      providerOf(id).padEnd(19) + id.padEnd(28) +
      'in $' + String(c.i).padEnd(7) + 'out $' + String(c.o).padEnd(7) +
      'cr $' + String(c.cr).padEnd(7) + 'cw $' + c.cw +
      (c.peak ? '  [peak/off-peak]' : ''));
  return [
    'session-cost · model discovery (' + Object.keys(rates).length + ' models · table ' + version + ' · ' + source + ')',
    'provider          model                       input      output     cacheRead  cacheWrite',
    ...rows,
  ].join('\n');
}

function configExplain(opts: ReportOptions): string {
  const rawModel = opts.model || '';
  if (!rawModel) return 'session-cost: config explain needs --model <m> (and optionally --provider)';
  const {key, free} = normalizeModel(rawModel);
  const fresh = getRates();
  const {config} = loadConfig(opts.configPath);
  const aliases = configAliases(config);
  const lines = [
    'session-cost · config explain',
    'input      ' + rawModel,
    'normalized ' + key + (free ? '  (free-tier → $0)' : ''),
  ];
  if (free) {
    lines.push('match      free-tier model — bills $0, no rate card needed');
    return lines.join('\n');
  }
  const aliasTarget = aliases.get(key);
  if (aliasTarget && fresh.rates[aliasTarget]) {
    const c = fresh.rates[aliasTarget];
    lines.push('match      config alias "' + key + '" → rate card "' + aliasTarget + '"');
    lines.push('rates      input $' + c.i + ' · output $' + c.o + ' · cacheRead $' + c.cr + ' · cacheWrite $' + c.cw + ' per 1M');
    return lines.join('\n');
  }
  if (fresh.rates[key]) {
    const c = fresh.rates[key];
    lines.push('match      exact rate card "' + key + '"');
    lines.push('rates      input $' + c.i + ' · output $' + c.o + ' · cacheRead $' + c.cr + ' · cacheWrite $' + c.cw + ' per 1M');
    if (c.peak) lines.push('bands      peak ' + (c.peak.i) + '/' + c.peak.o + '/' + c.peak.cr + ' vs off-peak ' + c.i + '/' + c.o + '/' + c.cr + ' (01-04 & 06-10 UTC, Mon-Fri)');
  } else {
    const dashed = dashInsert(key);
    if (dashed !== key && fresh.rates[dashed]) {
      lines.push('match      dash-inserted "' + dashed + '" (alias of "' + key + '")');
    } else {
      const close = Object.keys(fresh.rates).filter((k) => k.includes(key.split('-')[0] || key)).slice(0, 5);
      lines.push('match      UNKNOWN — tokens reported without a guessed cost');
      if (close.length > 0) lines.push('did you mean ' + close.join(', ') + '?');
      lines.push('fix        add a models alias in ' + CONFIG_PATH + ' or run --refresh-rates');
    }
  }
  return lines.join('\n');
}

function configCommand(opts: ReportOptions): string {
  const action = opts.configAction || 'validate';
  switch (action) {
    case 'init': {
      if (fs.existsSync(CONFIG_PATH)) {
        return 'session-cost: config already exists at ' + CONFIG_PATH + ' — edit it in place or remove it first';
      }
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG_TEMPLATE, null, 2));
      return 'session-cost: wrote config template to ' + CONFIG_PATH + '\nedit it, then run "config validate"';
    }
    case 'export': {
      const {config, exists} = loadConfig(opts.configPath);
      return JSON.stringify(exists ? config : {}, null, 2);
    }
    case 'import': {
      const src = opts.importPath;
      if (!src) return 'session-cost: config import needs a source path';
      let incoming: any;
      try {
        incoming = JSON.parse(fs.readFileSync(src, 'utf8'));
      } catch {
        return 'session-cost: import failed — cannot read or parse ' + src;
      }
      const {valid, errors} = validateConfig(incoming);
      if (!valid) return 'session-cost: import rejected — ' + errors.join('; ');
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(incoming, null, 2));
      return 'session-cost: imported validated config from ' + src + ' → ' + CONFIG_PATH;
    }
    case 'explain':
      return configExplain(opts);
    case 'validate':
    default: {
      const {file, exists, errors} = loadConfig(opts.configPath);
      if (!exists) return 'session-cost: no config at ' + file + ' — run "config init" to create one';
      if (errors.length > 0) {
        return 'session-cost: config INVALID at ' + file + '\n' + errors.map((e) => '  - ' + e).join('\n');
      }
      return 'session-cost: config valid (' + file + ')';
    }
  }
}

function ratesDashboardHtml(): string {
  const {rates, version, source} = getRates();
  const rows = Object.entries(rates)
    .sort(([a], [b]) => providerOf(a).localeCompare(providerOf(b)) || a.localeCompare(b))
    .map(([id, c]) =>
      '<tr><td>' + escHtml(providerOf(id)) + '</td><td class="m">' + escHtml(id) + '</td>' +
      '<td class="n">$' + c.i + '</td><td class="n">$' + c.o + '</td>' +
      '<td class="n">$' + c.cr + '</td><td class="n">$' + c.cw + '</td>' +
      '<td>' + (c.peak ? 'peak/off-peak' : 'flat') + '</td></tr>').join('\n');
  return '<!doctype html><html><head><meta charset="utf-8"><title>session-cost rates</title>' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">' +
    '<style>body{font:14px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:60rem}' +
    'table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:.3rem .5rem;text-align:left}' +
    '.n{text-align:right;font-variant-numeric:tabular-nums}.m{font-family:ui-monospace,monospace;font-size:.85rem}</style>' +
    '</head><body><h1>session-cost · rate table</h1>' +
    '<p>' + Object.keys(rates).length + ' models · table ' + escHtml(version) + ' · ' + escHtml(source) +
    ' · per 1M tokens, USD · peak window 01-04 &amp; 06-10 UTC Mon-Fri</p>' +
    '<table><tr><th>provider</th><th>model</th><th class="n">input</th><th class="n">output</th>' +
    '<th class="n">cacheRead</th><th class="n">cacheWrite</th><th>bands</th></tr>' + rows + '</table></body></html>';
}

function versionLine(): string {
  const fresh = getRates();
  return [
    'session-cost ' + MOD_VERSION + ' (commandcode adapter)',
    'report contract ' + CONTRACT_VERSION,
    'rate table ' + fresh.version + ' — ' + Object.keys(fresh.rates).length + ' models (' + fresh.source + ')',
    'node ' + process.version,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// HTML dashboard (self-contained, no external assets)
// ---------------------------------------------------------------------------
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function dashboardHtml(summaries: SessionSummary[], title: string): string {
  const t = totalsSummary(summaries);
  const prompt = t.input + t.cacheRead + t.cacheWrite;
  const cacheShare = prompt > 0 ? (t.cacheRead / prompt) * 100 : 0;
  const peakTotal = t.peakCostUsd + t.offPeakCostUsd;
  const peakPct = peakTotal > 0 ? (t.peakCostUsd / peakTotal) * 100 : 0;
  const maxCost = Math.max(1e-9, ...t.models.map((m) => m.costUsd || 0));
  const maxTok = Math.max(1, ...t.models.map((m) => m.input + m.output + m.cacheRead + m.cacheWrite));

  const modelRows = t.models.map((m) => {
    const tok = m.input + m.output + m.cacheRead + m.cacheWrite;
    const cost = m.costUsd || 0;
    const w = Math.max(2, (cost / maxCost) * 100);
    const tw = Math.max(2, (tok / maxTok) * 100);
    return '<tr><td class="m">' + escHtml(m.model) + '</td><td class="n">' + m.calls + '</td>' +
      '<td class="n">' + fmtTokens(tok) + '</td><td class="n">' + fmtCost(m.costUsd) + '</td>' +
      '<td class="bar"><div class="fill" style="width:' + w.toFixed(1) + '%"></div></td>' +
      '<td class="bar"><div class="fill dim" style="width:' + tw.toFixed(1) + '%"></div></td></tr>';
  }).join('\n');

  const sessionRows = summaries.map((s) =>
    '<tr><td>' + escHtml((s.startedAt || '').slice(0, 10)) + '</td><td class="m">' + escHtml(s.id) + '</td>' +
    '<td class="m">' + escHtml(s.project || '') + '</td><td class="n">' + s.callCount + '</td>' +
    '<td class="n">' + fmtTokens(s.input + s.output + s.cacheRead + s.cacheWrite) + '</td>' +
    '<td class="n">' + fmtCost(s.costUsd) + '</td></tr>').join('\n');

  return '<!doctype html><html><head><meta charset="utf-8"><title>' + escHtml(title) + '</title>' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">' +
    '<style>body{font:14px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:60rem;color:#111}' +
    'h1{font-size:1.3rem}h2{font-size:1rem;margin-top:2rem}.card{display:flex;gap:2rem;flex-wrap:wrap}' +
    '.stat b{display:block;font-size:1.4rem}.n{text-align:right;font-variant-numeric:tabular-nums}' +
    'table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:.3rem .5rem;text-align:left}' +
    '.m{font-family:ui-monospace,monospace;font-size:.85rem}.bar{width:8rem;background:#f0f0f0}' +
    '.fill{height:.8rem;background:#2563eb}.dim{background:#93c5fd}.split{display:flex;height:1rem;border-radius:.25rem;overflow:hidden}' +
    '.peak{background:#dc2626}.off{background:#16a34a}.warn{color:#b45309}</style></head><body>' +
    '<h1>' + escHtml(title) + '</h1>' +
    '<p>generated ' + escHtml(clockNow()) + ' · rate table ' + escHtml(getRates().version) +
    ' (' + escHtml(getRates().source) + ')</p>' +
    '<div class="card">' +
    '<div class="stat"><b>' + summaries.length + '</b>sessions</div>' +
    '<div class="stat"><b>' + t.callCount + '</b>calls</div>' +
    '<div class="stat"><b>' + fmtTokens(prompt) + '</b>prompt tokens</div>' +
    '<div class="stat"><b>' + fmtTokens(t.output) + '</b>output tokens</div>' +
    '<div class="stat"><b>' + fmtCost(t.costUsd) + '</b>estimated cost</div>' +
    '<div class="stat"><b>' + fmtTokens(t.subagentTokens) + '</b>subagent tokens</div>' +
    '</div>' +
    '<h2>Cost by model</h2><table><tr><th>model</th><th class="n">calls</th><th class="n">tokens</th><th class="n">cost</th><th>cost share</th><th>token share</th></tr>' + modelRows + '</table>' +
    '<h2>Sessions</h2><table><tr><th>date</th><th>session</th><th>project</th><th class="n">calls</th><th class="n">tokens</th><th class="n">cost</th></tr>' + sessionRows + '</table>' +
    '<h2>Peak vs off-peak spend</h2><div class="split"><div class="peak" style="width:' + peakPct.toFixed(1) + '%"></div><div class="off" style="width:' + (100 - peakPct).toFixed(1) + '%"></div></div>' +
    '<p>' + peakPct.toFixed(1) + '% peak ($' + t.peakCostUsd.toFixed(4) + ') · ' + (100 - peakPct).toFixed(1) + '% off-peak ($' + t.offPeakCostUsd.toFixed(4) + ')</p>' +
    '<h2>Cache health</h2><p' + (cacheShare < 60 ? ' class="warn"' : '') + '>cache reads are ' + cacheShare.toFixed(1) + '% of prompt tokens' +
    (cacheShare < 60 ? ' — below the 60% heuristic; prompts may not be cached' : '') + '</p>' +
    (t.unpricedModels.length > 0 ? '<h2>Unpriced models</h2><p class="warn">' + t.unpricedModels.map(escHtml).join(', ') + ' — tokens reported without a guessed cost</p>' : '') +
    '</body></html>';
}

async function dashboardReport(opts: ReportOptions, summaries: SessionSummary[]): Promise<string> {
  const outPath = opts.out || path.join(DASHBOARD_DIR, 'session-dashboard.html');
  fs.mkdirSync(path.dirname(outPath), {recursive: true});
  const html = dashboardHtml(summaries, 'session-cost · Command Code');
  fs.writeFileSync(outPath, html);
  return 'session-cost: dashboard written to ' + outPath + ' (' + summaries.length + ' sessions, ' +
    fmtTokens(totalsSummary(summaries).input + totalsSummary(summaries).output + totalsSummary(summaries).cacheRead + totalsSummary(summaries).cacheWrite) + ' tokens)';
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------
interface ReportOptions {
  mode: 'current' | 'last' | 'today' | 'list' | 'compare' | 'rates' | 'range' | 'session'
    | 'dashboard' | 'doctor' | 'providers' | 'models' | 'config' | 'refresh' | 'version';
  configAction?: 'explain' | 'init' | 'validate' | 'export' | 'import';
  importPath?: string;
  sessionId?: string;
  from?: string;
  to?: string;
  provider?: string;
  model?: string;
  includeChildren: boolean;
  limit: number;
  json: boolean;
  dataDir?: string;
  configPath?: string;
  out?: string;
  dashboard?: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): ReportOptions {
  const opts: ReportOptions = {mode: 'current', includeChildren: false, limit: 10};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--last': opts.mode = 'last'; break;
      case '--today': opts.mode = 'today'; break;
      case '--list': opts.mode = 'list'; break;
      case '--compare': opts.mode = 'compare'; break;
      case '--rates': opts.mode = 'rates'; break;
      case '--refresh-rates': opts.mode = 'refresh'; break;
      case '--version': case '-v': opts.mode = 'version'; break;
      case '--json': opts.json = true; break;
      case '--include-children': opts.includeChildren = true; break;
      case '--dashboard': opts.dashboard = true; break;
      case '--session': opts.mode = 'session'; opts.sessionId = argv[++i]; break;
      case '--from': opts.from = argv[++i]; if (opts.from) opts.mode = 'range'; break;
      case '--to': opts.to = argv[++i]; if (opts.to) opts.mode = 'range'; break;
      case '--provider': opts.provider = argv[++i]?.toLowerCase(); break;
      case '--model': opts.model = argv[++i]?.toLowerCase(); break;
      case '--limit': opts.limit = Math.max(1, Number(argv[++i]) || 10); break;
      case '--data-dir': opts.dataDir = argv[++i]; break;
      case '--config': case '--session-config': opts.configPath = argv[++i]; break;
      case '--out': opts.out = argv[++i]; break;
      case '--init-config': opts.mode = 'config'; opts.configAction = 'init'; break;
      case '--validate-config': opts.mode = 'config'; opts.configAction = 'validate'; break;
      case '--export-config': opts.mode = 'config'; opts.configAction = 'export'; break;
      case '--import-config':
        opts.mode = 'config'; opts.configAction = 'import'; opts.importPath = argv[++i]; break;
      case '--help': case '-h': opts.help = true; break;
      default:
        if (/^\d+$/.test(a) && opts.mode === 'list') {
          opts.limit = Math.max(1, Number(a));
        } else if (!a.startsWith('-')) {
          if (a === 'doctor') opts.mode = 'doctor';
          else if (a === 'providers') opts.mode = 'providers';
          else if (a === 'models') opts.mode = 'models';
          else if (a === 'version') opts.mode = 'version';
          else if (a === 'discover' && opts.mode === 'models') {
            // "models discover" — discover is the only action
          } else if (a === 'config') {
            opts.mode = 'config';
            const next = argv[i + 1];
            if (next === 'explain' || next === 'init' || next === 'validate' || next === 'export' || next === 'import') {
              opts.configAction = next;
              i++;
              if (next === 'import') {
                const p = argv[i + 1];
                if (p && !p.startsWith('-')) { opts.importPath = p; i++; }
              }
            }
          }
        }
    }
  }
  return opts;
}

const HELP = [
  'session-cost · commandcode adapter v' + MOD_VERSION + ' (rate table ' + RATE_TABLE_VERSION + ')',
  '',
  'usage: /session-cost [mode] [filters]    ·    /session-cost <subcommand>',
  '',
  'modes:',
  '  (none)          current (most recent) session report',
  '  --last          latest completed session',
  '  --today         sessions started today (UTC), with totals',
  '  --list [n]      recent sessions, default 10',
  '  --compare       compare the latest two sessions',
  '  --session <id>  specific session (id substring)',
  '  --from <date> / --to <date>   UTC date-range filter (YYYY-MM-DD)',
  '',
  'filters:',
  '  --provider <substr>   provider substring filter',
  '  --model <substr>      model substring filter',
  '  --include-children    fold subagent tokens into totals',
  '  --data-dir <path>     override the projects directory',
  '',
  'output:',
  '  --json             normalized JSON report',
  '  --dashboard        self-contained HTML session dashboard',
  '  --out <path>       dashboard output path',
  '  --rates            rate coverage (add --dashboard for a rates dashboard)',
  '  --version          mod, contract, and rate-table versions',
  '',
  'subcommands:',
  '  doctor            config, ledger, rate table, and cache health',
  '  providers         provider drivers with price ranges',
  '  models discover   every priced model with per-component rates',
  '  config explain --model <m>   how a model string matches a rate card',
  '  config init | validate | export | import <path>',
  '',
  'live:',
  '  a running cost line renders under the input bar (footer segment) and as an',
  '  above-editor widget; set "liveStatus": false in the config to turn it off',
  '',
  'rates & config:',
  '  --refresh-rates    re-fetch the mirrored CommandCode rate table',
  '  --config <path>    alternate config file (default ~/.commandcode/session-cost.json)',
  '  --init-config / --validate-config / --export-config / --import-config <path>',
  '',
  'config keys: standingSummary · includeChildren · defaultFormat · warnOnCacheRateBelow · liveStatus · models (aliases)',
].join('\n');

// ---------------------------------------------------------------------------
// Report engine
// ---------------------------------------------------------------------------
function defaultDataDir(): string {
  return path.join(os.homedir(), '.commandcode', 'projects');
}

function filterByModel(s: SessionSummary, opts: ReportOptions): boolean {
  if (!opts.provider && !opts.model) return true;
  const hay = s.models.map((m) => m.model.toLowerCase()).join(' ');
  if (opts.provider && !hay.includes(opts.provider)) return false;
  if (opts.model && !hay.includes(opts.model)) return false;
  return true;
}

function inDateRange(s: SessionSummary, opts: ReportOptions): boolean {
  if (!opts.from && !opts.to) return true;
  const day = (s.startedAt || s.endedAt || '').slice(0, 10);
  if (!day) return false;
  if (opts.from && day < opts.from) return false;
  if (opts.to && day > opts.to) return false;
  return true;
}

async function runReport(argv: string[]): Promise<string> {
  const opts = parseArgs(argv);

  if (opts.help) return HELP;
  if (opts.mode === 'version') return versionLine();
  if (opts.mode === 'refresh') return await refreshRates();
  if (opts.mode === 'doctor') return await doctorReport(opts);
  if (opts.mode === 'providers') return providersReport();
  if (opts.mode === 'models') return modelsReport();
  if (opts.mode === 'config') return configCommand(opts);

  if (opts.mode === 'rates') {
    const {rates, version, source} = getRates();
    if (opts.dashboard) {
      const outPath = opts.out || path.join(DASHBOARD_DIR, 'rates-dashboard.html');
      fs.mkdirSync(path.dirname(outPath), {recursive: true});
      fs.writeFileSync(outPath, ratesDashboardHtml());
      return 'session-cost: rates dashboard written to ' + outPath + ' (' +
        Object.keys(rates).length + ' models, table ' + version + ')';
    }
    const keys = Object.keys(rates);
    const banded = keys.filter((k) => rates[k].peak);
    const lines = [
      'session-cost · rate coverage (commandcode adapter)',
      'models   ' + keys.length + ' priced models',
      'banded   ' + banded.length + ' peak/off-peak: ' + banded.join(', '),
      'window   peak = 01-04 & 06-10 UTC, Mon-Fri (CommandCode published windows)',
      'table    ' + version + ' (' + source + ')',
      'source   https://commandcode.ai/docs/resources/pricing-limits',
      'note     unknown models report tokens without a guessed cost; free-tier models bill $0',
    ];
    return lines.join('\n');
  }

  // ledger modes — config defaults apply (includeChildren, defaultFormat, aliases)
  const {config} = loadConfig(opts.configPath);
  const aliases = configAliases(config);
  if (config.includeChildren === true) opts.includeChildren = true;
  if (config.defaultFormat === 'json' && !opts.json) opts.json = true;
  const cacheThreshold = typeof config.warnOnCacheRateBelow === 'number' ? config.warnOnCacheRateBelow : undefined;

  const dataDir = opts.dataDir || defaultDataDir();
  if (!fs.existsSync(dataDir)) {
    return 'session-cost: no Command Code ledger found at ' + dataDir + ' (override with --data-dir)';
  }

  const sessions = discoverSessions(dataDir);
  if (sessions.length === 0) return 'session-cost: no sessions found under ' + dataDir;

  if (opts.mode === 'list') {
    const selected: SessionSummary[] = [];
    for (const meta of sessions.slice(0, opts.limit)) {
      const s = summarize(await parseSession(meta, aliases));
      if (!filterByModel(s, opts) || !inDateRange(s, opts)) continue;
      selected.push(s);
    }
    if (opts.dashboard) return await dashboardReport(opts, selected);
    if (opts.json) return toJson(selected, 'list', {method: 'recent-list', requestedId: null, candidateIds: selected.map((s) => s.id)});
    const lines = ['session-cost · recent sessions (' + selected.length + ' of ' + sessions.length + ')'];
    for (const s of selected) {
      const day = (s.startedAt || '').slice(0, 10) || 'unknown';
      const top = s.models[0];
      const costCell = s.costUsd === null
        ? 'unpriced (' + (s.unpricedModels[0] || '?') + (s.unpricedModels.length > 1 ? ' +' + (s.unpricedModels.length - 1) : '') + ')'
        : fmtCost(s.costUsd).padStart(10);
      lines.push(
        day + '  ' + s.id.slice(0, 8) + '…  ' + String(s.callCount).padStart(5) + ' calls  ' +
        fmtTokens(s.input + s.output + s.cacheRead + s.cacheWrite).padStart(8) + ' tok  ' +
        costCell + '  ' + (top ? top.model : 'no usage'),
      );
    }
    return lines.join('\n');
  }

  let candidates = sessions;
  if (opts.mode === 'today') {
    const today = clockNow().slice(0, 10);
    candidates = sessions.filter((m) => (m.startedAt || '').slice(0, 10) === today);
  }
  if (opts.mode === 'session') {
    const needle = (opts.sessionId || '').toLowerCase();
    candidates = sessions.filter((m) => m.id.toLowerCase().includes(needle));
    if (candidates.length === 0) {
      return 'session-cost: no session matching "' + opts.sessionId + '"';
    }
  }
  if (opts.mode === 'compare') {
    candidates = sessions.slice(0, 2);
  }
  if (opts.mode === 'current' || opts.mode === 'last') {
    candidates = sessions.slice(0, 1);
  }
  if (opts.mode === 'range') {
    // cheap pre-filter on the session record's start date before any full parse
    candidates = sessions.filter((m) => {
      const day = (m.startedAt || '').slice(0, 10);
      if (!day) return true; // keep undated sessions; inDateRange decides after parse
      if (opts.from && day < opts.from) return false;
      if (opts.to && day > opts.to) return false;
      return true;
    });
  }

  const selected: SessionSummary[] = [];
  for (const meta of candidates) {
    const s = summarize(await parseSession(meta, aliases));
    if (!filterByModel(s, opts) || !inDateRange(s, opts)) continue;
    selected.push(s);
  }

  if (selected.length === 0) {
    return 'session-cost: no sessions match the given filters';
  }

  if (opts.dashboard) return await dashboardReport(opts, selected);
  if (opts.json) {
    const method = opts.mode === 'session' ? 'id'
      : opts.mode === 'range' ? 'date-range'
      : opts.mode === 'today' ? 'today'
      : opts.mode === 'compare' ? 'compare-latest-two'
      : opts.mode === 'last' ? 'last-completed'
      : 'latest';
    return toJson(selected, opts.mode, {method, requestedId: opts.sessionId ?? null, candidateIds: candidates.map((m) => m.id)});
  }

  const blocks: string[] = [];
  for (const s of selected) {
    let card = sessionCard(s, opts.includeChildren, cacheThreshold);
    if (opts.includeChildren && s.subagentTokens > 0) {
      const prompt = s.input + s.cacheRead + s.cacheWrite + s.subagentTokens;
      card = card.map((line) =>
        line.startsWith('tokens   ')
          ? 'tokens   ' + fmtTokens(prompt) + ' prompt (' + fmtTokens(s.input) + ' in + ' +
            fmtTokens(s.cacheRead) + ' cache read + ' + fmtTokens(s.cacheWrite) + ' cache write + ' +
            fmtTokens(s.subagentTokens) + ' subagent) · ' + fmtTokens(s.output) + ' out'
          : line,
      );
    }
    blocks.push(card.join('\n'));
  }

  if (opts.mode === 'compare' && selected.length === 2) {
    const [a, b] = selected; // a = newer, b = older
    const delta = b.pricedCostUsd - a.pricedCostUsd;
    blocks.push('compare  latest ' + fmtCost(a.pricedCostUsd) + ' vs previous ' + fmtCost(b.pricedCostUsd) +
      ' → ' + (delta >= 0 ? '+' : '−') + '$' + Math.abs(delta).toFixed(4));
  }

  if (opts.mode === 'today' && selected.length > 1) {
    const t = totalsSummary(selected);
    blocks.push('today    ' + selected.length + ' sessions · ' + t.callCount + ' calls · ' +
      fmtTokens(t.input + t.output + t.cacheRead + t.cacheWrite) + ' tok · ' + fmtCost(t.pricedCostUsd));
  }

  if (config.standingSummary && (opts.mode === 'current' || opts.mode === 'last')) {
    const today = clockNow().slice(0, 10);
    const todaySummaries: SessionSummary[] = [];
    for (const meta of sessions) {
      if ((meta.startedAt || '').slice(0, 10) !== today) continue;
      todaySummaries.push(summarize(await parseSession(meta, aliases)));
    }
    if (todaySummaries.length > 0) {
      const t = totalsSummary(todaySummaries);
      blocks.push('today    ' + todaySummaries.length + ' sessions · ' + t.callCount + ' calls · ' +
        fmtTokens(t.input + t.output + t.cacheRead + t.cacheWrite) + ' tok · ' + fmtCost(t.pricedCostUsd));
    }
  }

  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Live status — a running cost line around the input bar
// ---------------------------------------------------------------------------
// Tails the active session ledger incrementally (byte-offset reads, so each
// refresh only parses what the last commit appended) and paints the running
// estimate via cmd.ui.setStatus (footer segment under the input panel —
// wired today) plus an above-editor widget (renders once the TUI wires
// placement). Pricing follows the report engine's rules: a transcript whose
// version the mod does not understand is not parsed at all, and a banded
// call without a usable timestamp is unpriced, never priced at the cheaper
// band (upstream #100).
interface LiveState {
  file: string;
  startedAt: string;
  schemaDrift: number | null;
  offset: number;
  pending: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  calls: number;
  costUsd: number;
  hasUnpriced: boolean;
  lastModel: string;
}

const live: LiveState = {
  file: '',
  startedAt: '',
  schemaDrift: null,
  offset: 0,
  pending: '',
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  calls: 0,
  costUsd: 0,
  hasUnpriced: false,
  lastModel: '',
};

// The TUI prints footer status text verbatim, so the line carries its own
// ansi styling: a dim brand and separators, a bold cost figure colored by
// magnitude, and a magenta marker when unpriced calls are folded in.
const ANSI_DIM = '\x1b[2m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_RESET = '\x1b[0m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_RED = '\x1b[31m';
const ANSI_MAGENTA = '\x1b[35m';

function liveCostColor(cost: number): string {
  if (cost >= 10) return ANSI_RED;
  if (cost >= 1) return ANSI_YELLOW;
  return ANSI_GREEN;
}

// The footer line, styled. One line by contract: the TUI collapses
// newlines and tabs to spaces, so every cell sits on the same row.
function liveLineText(): string {
  if (live.schemaDrift !== null) {
    return ANSI_DIM + 'session-cost' + ANSI_RESET + ' ' +
      ANSI_BOLD + ANSI_RED + 'unpriced' + ANSI_RESET +
      ANSI_DIM + ' · transcript v' + live.schemaDrift + ', expected v' + TRANSCRIPT_VERSION + ANSI_RESET;
  }
  const marker = live.hasUnpriced ? ANSI_MAGENTA + '+' + ANSI_RESET : '';
  return ANSI_DIM + 'session-cost' + ANSI_RESET + ' ' +
    ANSI_BOLD + liveCostColor(live.costUsd) + fmtCost(live.costUsd) + ANSI_RESET + marker +
    ANSI_DIM + ' · ' + ANSI_RESET + live.calls + ' calls' +
    ANSI_DIM + ' · ' + ANSI_RESET + fmtTokens(live.input + live.output + live.cacheRead + live.cacheWrite) + ' tok' +
    ANSI_DIM + ' · ' + ANSI_RESET + ANSI_DIM + (live.lastModel || 'no usage yet') + ANSI_RESET;
}

let liveText = 'session-cost';
let lastRefreshAt = 0;
const LIVE_REFRESH_MS = 800;

function liveReset(meta: SessionMeta): void {
  live.file = meta.file;
  live.startedAt = meta.startedAt || '';
  live.schemaDrift = meta.version !== null && meta.version !== TRANSCRIPT_VERSION ? meta.version : null;
  live.offset = 0;
  live.pending = '';
  live.input = 0;
  live.output = 0;
  live.cacheRead = 0;
  live.cacheWrite = 0;
  live.calls = 0;
  live.costUsd = 0;
  live.hasUnpriced = false;
  live.lastModel = '';
}

function liveParseLine(line: string, aliases: Map<string, string>): void {
  if (!line.includes('"usage"')) return;
  let rec: any;
  try {
    rec = JSON.parse(line);
  } catch {
    return;
  }
  if (rec?.type !== 'message' || rec?.message?.role !== 'assistant' || !rec.usage) return;
  const u = rec.usage;
  const output = Number(u.outputTokens || 0);
  const cacheRead = Number(u.cacheReadTokens || 0);
  const cacheWrite = Number(u.cacheWriteTokens || 0);
  // #107: the v3 ledger's inputTokens is the total prompt and contains the
  // cache buckets; the fresh input is what pricing may carry, clamped at 0.
  const input = Math.max(0, Number(u.inputTokens || 0) - cacheRead - cacheWrite);
  const model = typeof rec.model === 'string' ? rec.model : 'unknown';
  // The line's own timestamp is the only one pricing may use: a banded call
  // without a usable time is unpriced, never priced at the cheaper off-peak band.
  const ownTs = typeof rec.timestamp === 'string' ? rec.timestamp : '';
  const tsUsable = ownTs !== '' && Number.isFinite(Date.parse(ownTs));
  const {card, free} = matchRateCard(model, aliases);
  let cost = 0;
  if (free) {
    cost = 0; // free-tier models bill $0
  } else if (!card) {
    live.hasUnpriced = true;
  } else if (card.peak && card.off && !tsUsable) {
    live.hasUnpriced = true;
  } else {
    const components = card.peak && card.off
      ? (isPeakUtc(new Date(ownTs)) ? card.peak : card.off)
      : card;
    cost =
      (input / 1e6) * components.i +
      (output / 1e6) * components.o +
      (cacheRead / 1e6) * components.cr +
      (cacheWrite / 1e6) * components.cw;
  }
  live.calls++;
  live.input += input;
  live.output += output;
  live.cacheRead += cacheRead;
  live.cacheWrite += cacheWrite;
  live.costUsd += cost;
  live.lastModel = model;
}

// Parse only the bytes appended since the last refresh.
function liveTail(aliases: Map<string, string>): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(live.file);
  } catch {
    return; // file gone — the next refresh re-discovers the newest session
  }
  if (stat.size <= live.offset) return;
  const len = stat.size - live.offset;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(live.file, 'r');
  try {
    let read = 0;
    while (read < len) {
      const n = fs.readSync(fd, buf, read, len - read, live.offset + read);
      if (n === 0) break;
      read += n;
    }
    live.offset = stat.size;
    const text = live.pending + buf.toString('utf8', 0, read);
    const lines = text.split('\n');
    live.pending = lines.pop() || '';
    if (live.schemaDrift === null) {
      for (const line of lines) liveParseLine(line, aliases);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function refreshLive(cmd: ModApi, aliases: Map<string, string>, force = false): void {
  const now = Date.now();
  if (!force && now - lastRefreshAt < LIVE_REFRESH_MS) return;
  lastRefreshAt = now;
  let newest: SessionMeta | undefined;
  const dataDir = defaultDataDir();
  if (fs.existsSync(dataDir)) newest = discoverSessions(dataDir)[0];
  if (!newest) return;
  if (live.file !== newest.file) liveReset(newest);
  liveTail(aliases);
  liveText = liveLineText();
  cmd.ui.setStatus(liveText);
  cmd.ui.refreshWidgets();
}

// ---------------------------------------------------------------------------
// Mod registration
// ---------------------------------------------------------------------------
export default function (cmd: ModApi): void {
  cmd.addCommand({
    name: 'session-cost',
    description: 'Token usage and estimated cost report for Command Code sessions',
    argumentHint: '[--last|--today|--list|--compare|--rates|--dashboard|--session <id>|--from <date> --to <date>] [--model <substr>] [--json] · doctor | providers | models discover | config explain --model <m>',
    handler: async ({args}) => {
      try {
        const argv = (args || '').split(/\s+/).filter(Boolean);
        return {message: await runReport(argv)};
      } catch (error) {
        return {message: 'session-cost: ' + (error instanceof Error ? error.message : String(error))};
      }
    },
  });

  cmd.addTool({
    schema: {
      name: 'session_cost',
      description: 'Report token usage and estimated cost for Command Code sessions. Reads the local session ledger (~/.commandcode/projects) and prices calls with mirrored CommandCode provider rates, including peak/off-peak bands. Also supports HTML dashboards, rate refresh, config management, and diagnostics (doctor, providers, models, config explain). Unknown models report tokens without a guessed cost.',
      input_schema: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['current', 'last', 'today', 'list', 'compare', 'session', 'range', 'rates', 'dashboard', 'doctor', 'providers', 'models', 'config', 'refresh', 'version'],
            description: 'Report mode. Default "current" = most recent session.',
          },
          sessionId: {type: 'string', description: 'Session id or substring (mode=session).'},
          from: {type: 'string', description: 'Range start, YYYY-MM-DD (UTC).'},
          to: {type: 'string', description: 'Range end, YYYY-MM-DD (UTC).'},
          provider: {type: 'string', description: 'Provider substring filter.'},
          model: {type: 'string', description: 'Model substring filter (also used by config explain).'},
          includeChildren: {type: 'boolean', description: 'Fold subagent tokens into totals.'},
          limit: {type: 'number', description: 'Session count for list mode (default 10).'},
          format: {type: 'string', enum: ['text', 'json'], description: 'Output format.'},
          dataDir: {type: 'string', description: 'Override the projects directory (defaults to ~/.commandcode/projects).'},
          configPath: {type: 'string', description: 'Alternate config file path.'},
          out: {type: 'string', description: 'Dashboard output path.'},
          dashboard: {type: 'boolean', description: 'Write a self-contained HTML dashboard instead of text.'},
        },
        required: [],
      },
    },
    readOnly: true,
    run: async ({input}) => {
      const argv: string[] = [];
      const mode = (input.mode || 'current') as string;
      if (mode === 'session' && input.sessionId) {
        argv.push('--session', input.sessionId);
      } else if (mode === 'doctor') {
        argv.push('doctor');
      } else if (mode === 'providers') {
        argv.push('providers');
      } else if (mode === 'models') {
        argv.push('models', 'discover');
      } else if (mode === 'config') {
        argv.push('config', input.model ? 'explain' : 'validate');
      } else if (mode === 'refresh') {
        argv.push('--refresh-rates');
      } else if (mode === 'version') {
        argv.push('--version');
      } else if (mode === 'dashboard') {
        argv.push('--dashboard');
      } else if (mode !== 'current' && mode !== 'range') {
        const flag = {last: '--last', today: '--today', list: '--list', compare: '--compare', rates: '--rates'}[mode];
        if (flag) argv.push(flag);
      }
      if (input.from) argv.push('--from', String(input.from));
      if (input.to) argv.push('--to', String(input.to));
      if (input.provider) argv.push('--provider', String(input.provider));
      if (input.model) argv.push('--model', String(input.model));
      if (input.includeChildren) argv.push('--include-children');
      if (typeof input.limit === 'number') argv.push('--limit', String(input.limit));
      if (input.format === 'json') argv.push('--json');
      if (input.dataDir) argv.push('--data-dir', String(input.dataDir));
      if (input.configPath) argv.push('--config', String(input.configPath));
      if (input.out) argv.push('--out', String(input.out));
      if (input.dashboard) argv.push('--dashboard');
      try {
        return {ok: true, content: [{type: 'text', text: await runReport(argv)}]};
      } catch (error) {
        return {ok: true, content: [{type: 'text', text: 'session-cost: ' + (error instanceof Error ? error.message : String(error))}]};
      }
    },
  });

  // Live status: a running cost line around the input bar (config: liveStatus).
  // Every surface is probed before registration: a mod factory must never
  // throw (a throwing factory fails the whole mod load), and minimal
  // harness bindings — the behavioral-test harness — provide only
  // addCommand and addTool.
  const {config} = loadConfig();
  const aliases = configAliases(config);
  if (
    config.liveStatus !== false &&
    cmd.ui && typeof cmd.ui.setStatus === 'function' &&
    typeof cmd.on === 'function' &&
    typeof cmd.hooks === 'function'
  ) {
    refreshLive(cmd, aliases, true);
    // above/below the editor — renders once the TUI wires widget placement;
    // the footer segment under the input is live today.
    cmd.ui.widget({placement: 'above-editor', render: () => [liveText]});
    cmd.on('run_start', () => refreshLive(cmd, aliases));
    cmd.on('message_end', () => refreshLive(cmd, aliases));
    cmd.on('tool_completed', () => refreshLive(cmd, aliases));
    cmd.hooks({
      onRunEnd: async () => refreshLive(cmd, aliases, true),
    });
  }
}
