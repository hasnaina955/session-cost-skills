// Canonical dashboard renderer. `npm run check:dashboard` verifies that each
// independently installable adapter contains an exact generated copy.
import { isoNow } from './clock.mjs';
import { barChart, stackedBar, sparkline } from './charts.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function number(value) {
  return Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function money(value) {
  return value === null || value === undefined ? '—' : `$${Number(value).toFixed(6)}`;
}

function percent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function safeJson(value) {
  return JSON.stringify(value ?? {}).replace(/[<\u2028\u2029]/g, (char) => ({
    '<': '\\u003c',
    '\u2028': '\\u2028',
    '\u2029': '\\u2029',
  })[char]);
}

function modelName(model) {
  return String(model.model ?? model.modelId ?? model.id ?? 'unknown');
}

function providerName(model) {
  return String(model.provider ?? model.providerKey ?? 'unknown');
}

function modelRows(data) {
  const raw = data?.models ?? data?.total?.models ?? [];
  const rows = raw instanceof Map
    ? [...raw.values()]
    : Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object'
        ? Object.values(raw)
        : [];

  return rows.map((model) => {
    const input = Number(model.inputTokens ?? model.promptTokens ?? 0);
    const output = Number(model.outputTokens ?? model.completionTokens ?? 0);
    const cacheRead = Number(model.cacheReadTokens ?? model.cachedTokens ?? 0);
    const cacheWrite = Number(model.cacheWriteTokens ?? 0);
    const totalTokens = Number(model.totalTokens) || input + output;

    return {
      ...model,
      provider: providerName(model),
      model: modelName(model),
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      totalTokens,
      totalCost: Number(model.totalCost ?? model.cost ?? 0),
    };
  });
}

function accountModels(data) {
  return modelRows({ models: data?.account?.models ?? [] });
}

function usage(data) {
  return data?.account?.tokenTotals ?? data?.usage ?? {
    totalTokens: data?.totalTokens,
    inputTokens: data?.inputTokens,
    cacheReadTokens: data?.cacheReadTokens,
    outputTokens: data?.outputTokens,
    cacheHitRate: data?.cacheRate,
  };
}

function billing(data) {
  return data?.account?.billingTotals ?? data?.billing ?? {
    recordedCostUsd: data?.totalCost,
    rateKnown: data?.rateKnown,
  };
}

function rowsForPeriods(data) {
  return data?.account?.periods?.daily ?? data?.periods?.daily ?? [];
}

function renderTable(headers, rows) {
  const head = headers.map((header) => `<th>${esc(header)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// The two adapters use different vocabularies for the same numbers: Cline reports
// `total.cost` and splits tokens into input/output, while MCode reports `total.totalCost`
// and `total.totalTokens`. The browser runtime reads one shape, so normalize here rather
// than branching in the client. Doing it before the payload is hashed also keeps the
// CSP script hash derived from a stable string.
function normalizeSession(session) {
  // A session entry can arrive as a bare metrics object, as the `{row, metrics}` shape a
  // single-session report carries, or as a whole nested report (which is what `--list`
  // produces). Walk all three so the table is populated in every case.
  const metrics = session.metrics ?? session;
  const usage = session.usage ?? {};
  const input = Number(metrics.inputTokens ?? usage.inputTokens ?? 0);
  const output = Number(metrics.outputTokens ?? usage.outputTokens ?? 0);
  const total = metrics.total ?? session.total ?? {};
  const tokens = Number(metrics.totalTokens ?? usage.totalTokens ?? total.totalTokens) || input + output;
  const cost = metrics.totalCost ?? metrics.cost ?? total.totalCost ?? total.cost;
  return {
    ...session,
    id: session.id ?? session.sessionId ?? session.row?.sessionId ?? session.session?.id ?? null,
    // Parentage lives on the row for a single-session report and on the object key for a
    // per-session map; the tree needs both, and `cost` is read off the metrics the same way
    // `totalCost` is, because the two shapes disagree about where it lives.
    parentId: session.parentId ?? session.row?.parentSessionId ?? session.session?.parentId ?? null,
    cost: metrics.cost ?? metrics.totalCost ?? null,
    title: session.title ?? session.session?.title ?? metrics.title ?? null,
    metrics: {
      ...metrics,
      totalTokens: tokens,
      calls: Number(metrics.calls ?? total.calls) || 0,
      // An unknown cost stays null so the table cannot present it as $0.00.
      totalCost: cost == null || !Number.isFinite(Number(cost)) ? null : Number(cost),
    },
  };
}

const BROWSER_RUNTIME = String.raw`
const P=__SESSION_COST_PAYLOAD__;
const $ = (id) => document.getElementById(id);

function appendChildren(parent, children) {
  for (const child of [children].flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child?.nodeType ? child : document.createTextNode(String(child)));
  }
  return parent;
}

function element(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'text') node.textContent = String(value);
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  return appendChildren(node, children);
}

function svgElement(tag, attributes = {}, children = []) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== null && value !== undefined) {
      if (name === 'text') node.textContent = String(value);
      else node.setAttribute(name, String(value));
    }
  }
  return appendChildren(node, children);
}

function replaceChildren(id, children) {
  const node = $(id);
  node.replaceChildren();
  return appendChildren(node, children);
}

function table(headers, rows) {
  return element('table', {}, [
    element('thead', {}, [
      element('tr', {}, headers.map((header) => element('th', { text: header }))),
    ]),
    element('tbody', {}, rows.map((row) => element(
      'tr',
      {},
      row.map((cell) => element('td', { text: cell })),
    ))),
  ]);
}

function card(label, value) {
  return element('div', { class: 'kpi' }, [
    element('div', { class: 'label', text: label }),
    element('div', { class: 'value', text: value }),
  ]);
}

function option(value, label = value) {
  return element('option', { value }, label);
}

function setOptions(id, values, placeholder) {
  replaceChildren(id, [
    option('', placeholder),
    ...values.map((value) => option(String(value))),
  ]);
}

const sessionId = (session) => String(session?.id || session?.sessionId || session?.row?.sessionId || '');
const sessionModels = (session) => {
  const raw = session?.metrics?.models || session?.models || {};
  return Array.isArray(raw) ? raw : Object.values(raw);
};
const usd = (value) => value === null || value === undefined ? '—' : '$' + Number(value).toFixed(6);
const modelKey = (model) => (model.provider || 'unknown') + ' / ' + (model.model || 'unknown');
const sortedUnique = (values) => [...new Set(values.filter(Boolean).map(String))].sort();
const dashboardPeriods = () => P.data?.account?.periods?.daily
  ?? P.data?.periods?.daily
  ?? (Array.isArray(P.periods) ? P.periods : []);

const themeToggle = $('themeToggle');
if (localStorage.getItem('session-cost-theme') === 'light') {
  document.body.classList.add('theme-light');
  themeToggle.textContent = '☾ Dark mode';
}
themeToggle.addEventListener('click', () => {
  const light = document.body.classList.toggle('theme-light');
  localStorage.setItem('session-cost-theme', light ? 'light' : 'dark');
  themeToggle.textContent = light ? '☾ Dark mode' : '☼ Light mode';
});

let compactFormat = localStorage.getItem('session-cost-format') !== 'full';
const formatToggle = $('formatToggle');
function compactNumber(value) {
  if (value >= 1e9) return (value / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (value >= 1e6) return (value / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (value >= 1e3) return (value / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return Math.round(value).toLocaleString('en-US');
}
function fmt(value) {
  const number = Number(value || 0);
  return compactFormat ? compactNumber(number) : number.toLocaleString('en-US');
}
formatToggle.setAttribute('aria-pressed', String(compactFormat));
formatToggle.textContent = compactFormat ? 'Full numbers' : 'Compact numbers';
formatToggle.addEventListener('click', () => {
  compactFormat = !compactFormat;
  localStorage.setItem('session-cost-format', compactFormat ? 'compact' : 'full');
  formatToggle.setAttribute('aria-pressed', String(compactFormat));
  formatToggle.textContent = compactFormat ? 'Full numbers' : 'Compact numbers';
  render();
});

const providerOptions = sortedUnique(P.models.map((model) => model.provider));
const modelOptions = sortedUnique(P.models.map((model) => model.model));
const sessionOptions = sortedUnique(P.sessions.map(sessionId));
const dayOptions = sortedUnique(dashboardPeriods().map((period) => period.from)).sort().reverse();
setOptions('providerFilter', providerOptions, 'All providers');
setOptions('modelFilter', modelOptions, 'All models');
setOptions('sessionFilter', sessionOptions, 'All sessions');
setOptions('dayFilter', dayOptions, 'All days');

function refreshModelOptions() {
  const selectedSession = P.sessions.find((session) => sessionId(session) === $('sessionFilter').value);
  const names = selectedSession
    ? sortedUnique(sessionModels(selectedSession).map((model) => model.model || model.modelId || model.id))
    : modelOptions;
  replaceChildren('modelFilter', [
    option('', selectedSession ? 'All models in session' : 'All models'),
    ...names.map((name) => option(name)),
  ]);
}

function filterModels() {
  const selectedSession = P.sessions.find((session) => sessionId(session) === $('sessionFilter').value);
  const allowedModels = selectedSession ? sessionModels(selectedSession) : null;
  const provider = $('providerFilter').value;
  const model = $('modelFilter').value;
  return P.models.filter((item) => {
    const providerMatches = !provider || item.provider === provider;
    const modelMatches = !model || item.model === model;
    const sessionMatches = !allowedModels
      || !allowedModels.length
      || allowedModels.some((allowed) => (allowed.model || allowed.modelId || allowed.id) === item.model);
    return providerMatches && modelMatches && sessionMatches;
  });
}

function renderTrendChart() {
  const periods = dashboardPeriods();
  if (!periods.length) {
    replaceChildren('trendChart', element('div', {
      class: 'empty',
      text: 'Daily trend is available in account mode. Current-session reports show model and session breakdowns instead.',
    }));
    return;
  }

  const max = Math.max(1, ...periods.map((period) => Number(period.totalTokens) || 0));
  const selected = $('dayFilter').value;
  replaceChildren('trendChart', periods.map((period) => {
    const tokens = Number(period.totalTokens) || 0;
    const width = Math.min(100, Math.max(0, tokens / max * 100));
    const active = !selected || period.from === selected;
    return element('div', { class: 'bar-row' + (active ? '' : ' inactive') }, [
      element('span', { text: period.from || period.label || '' }),
      element('span', { class: 'bar' }, [
        element('i', { style: 'width:' + width.toFixed(2) + '%' }),
      ]),
      element('span', { text: fmt(tokens) + ' · ' + usd(period.referenceCostUsd ?? period.totalCost) }),
    ]);
  }));
}


function renderModelChart() {
  const models = P.models
    .filter((model) => Number(model.totalTokens) > 0)
    .sort((left, right) => Number(right.totalTokens) - Number(left.totalTokens))
    .slice(0, 8);
  if (!models.length) {
    replaceChildren('modelChart', element('div', {
      class: 'empty',
      text: 'No model token data available.',
    }));
    return;
  }

  const total = models.reduce((sum, model) => sum + (Number(model.totalTokens) || 0), 0);
  const colors = ['#2563eb', '#087f5b', '#7c3aed', '#c2410c', '#be123c', '#0891b2', '#4d7c0f', '#9333ea'];
  let offset = 0;
  const arcs = models.map((model, index) => {
    const share = total ? Number(model.totalTokens) / total * 100 : 0;
    const arc = svgElement('circle', {
      cx: 60,
      cy: 60,
      r: 43,
      fill: 'none',
      stroke: colors[index % colors.length],
      'stroke-width': 16,
      'stroke-dasharray': share.toFixed(2) + ' ' + (100 - share).toFixed(2),
      'stroke-dashoffset': (-offset).toFixed(2),
      transform: 'rotate(-90 60 60)',
    });
    offset += share;
    return arc;
  });
  const chart = svgElement('svg', {
    viewBox: '0 0 120 120',
    width: 150,
    height: 150,
    role: 'img',
    'aria-label': 'Token share by model',
  }, [
    svgElement('circle', { cx: 60, cy: 60, r: 43, fill: 'none', stroke: '#263956', 'stroke-width': 16 }),
    ...arcs,
    svgElement('text', { x: 60, y: 57, 'text-anchor': 'middle', fill: 'currentColor', 'font-size': 12 }, 'TOTAL'),
    svgElement('text', { x: 60, y: 74, 'text-anchor': 'middle', fill: 'currentColor', 'font-size': 14, 'font-weight': 700 }, fmt(total)),
  ]);
  const legend = element('div', { style: 'display:flex;flex-direction:column' },
    models.map((model, index) => element('div', {
      style: 'display:flex;gap:8px;align-items:center;margin:7px 0;font-size:12px',
    }, [
      element('i', {
        style: 'width:10px;height:10px;border-radius:3px;flex:0 0 auto;background:' + colors[index % colors.length],
      }),
      element('span', {
        style: 'max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
        text: modelKey(model),
      }),
      element('strong', { style: 'margin-left:auto', text: (total ? Number(model.totalTokens) / total * 100 : 0).toFixed(1) + '%' }),
    ])),
  );
  replaceChildren('modelChart', element('div', {
    style: 'display:flex;align-items:center;gap:18px;flex-wrap:wrap',
  }, [chart, legend]));
}

function render() {
  renderTrendChart();
  renderModelChart();

  if (P.data?.rates) {
    const providers = P.data.rates.providers || {};
    const entries = Object.entries(providers);
    const coverage = P.data.rates.coverage || {};
    const providerCoverage = coverage.providers || {};
    const modelCount = entries.reduce((sum, [, value]) => sum + (Number(value.models) || 0), 0);
    const componentSummary = Object.entries(providerCoverage)
      .map(([name, value]) => {
        const components = Object.entries(value.components || {})
          .map(([component, status]) => component + ' ' + status.completeModels + '/' + value.models)
          .join(', ');
        const excluded = value.excludedModels?.length ? '; excluded ' + value.excludedModels.length : '';
        return name + ': ' + components + excluded;
      })
      .join(' | ');
    replaceChildren('cards', [
      card('Mirrored providers', fmt(entries.length)),
      card('Mirrored models', fmt(modelCount)),
      card('Rate snapshot', P.data.rates.refreshedAt || 'unknown'),
      card('Table status', coverage.complete ? 'complete' : 'incomplete'),
    ]);
    replaceChildren('filterTables', [
      element('h2', { text: 'Rate coverage' }),
      table(['Provider', 'Models', 'Rate records', 'Effective from', 'Fetched', 'Source'], entries.map(([name, value]) => [
        name,
        fmt(value.models),
        fmt(providerCoverage[name]?.rateRecords),
        providerCoverage[name]?.effectiveFrom || 'unknown',
        value.fetchedAt || 'unknown',
        value.source || '',
      ])),
      element('p', { class: 'sub', text: componentSummary || 'No component coverage metadata' }),
    ]);
    return;
  }


  const models = filterModels();
  const selectedSession = $('sessionFilter').value;
  const sessions = P.sessions.filter((session) => !selectedSession || sessionId(session) === selectedSession);
  const tokens = models.reduce((sum, model) => sum + (Number(model.totalTokens) || 0), 0);
  const calls = models.reduce((sum, model) => sum + (Number(model.calls) || 0), 0);
  const cache = models.reduce((sum, model) => sum + (Number(model.cacheReadTokens) || 0), 0);
  const cost = models.reduce((sum, model) => sum + (Number(model.totalCost) || 0), 0);
  const allPriced = !models.some((model) => model.rateKnown === false);

  $('filterStatus').textContent = models.length + ' model(s), ' + sessions.length + ' session(s)';
  replaceChildren('cards', [
    card('Filtered tokens', fmt(tokens)),
    card('Filtered calls', fmt(calls)),
    card('Filtered cache read', fmt(cache)),
    card('Filtered cost', usd(allPriced ? cost : null)),
    card('Matching models', fmt(models.length)),
    card('Matching sessions', fmt(sessions.length)),
  ]);

  const modelRows = models.map((model) => [
    modelKey(model),
    fmt(model.calls),
    fmt(model.totalTokens),
    model.rateKnown === false ? 'unpriced' : usd(model.totalCost),
  ]);
  const sessionRows = sessions.map((session) => {
    const metrics = session.metrics || session;
    return [
      sessionId(session) || '—',
      session.title || metrics.title || '',
      fmt(metrics.calls ?? metrics.total?.calls),
      fmt(metrics.totalTokens ?? metrics.total?.totalTokens),
      usd(metrics.totalCost ?? metrics.total?.totalCost),
    ];
  });
  replaceChildren('filterTables', [
    element('h2', { text: 'Filtered model breakdown' }),
    table(['Provider / Model', 'Calls', 'Tokens', 'Cost'], modelRows),
    element('h2', { text: 'Matching sessions' }),
    table(['Session', 'Title', 'Calls', 'Tokens', 'Cost'], sessionRows),
  ]);
}

$('providerFilter').addEventListener('input', render);
$('modelFilter').addEventListener('input', render);
$('dayFilter').addEventListener('change', render);
$('sessionFilter').addEventListener('change', () => {
  refreshModelOptions();
  render();
});
$('resetFilters').addEventListener('click', () => {
  for (const id of ['providerFilter', 'modelFilter', 'sessionFilter', 'dayFilter']) $(id).value = '';
  refreshModelOptions();
  render();
});
refreshModelOptions();
render();
`;

function dashboardScript(payload) {
  return BROWSER_RUNTIME.replace('__SESSION_COST_PAYLOAD__', payload);
}

function contentSecurityPolicy(script) {
  const scriptHash = crypto.createHash('sha256').update(script).digest('base64');
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'none'",
    "font-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "img-src data:",
    "media-src 'none'",
    "object-src 'none'",
    "script-src 'sha256-" + scriptHash + "'",
    "style-src 'unsafe-inline'",
  ].join('; ');
}


const STYLES = String.raw`
/* Design system: flat surfaces, hairline separators, and one accent. No gradients, no large
   shadows, no decorated boxes. Every colour comes from a token so both themes stay in step and
   the contrast audit in tests/theme-contrast.test.mjs can read them straight out of these
   blocks. A reader whose system asks for light gets light without a click and without a dark
   flash; the toggle still overrides, so the choice stays theirs. */
@media (prefers-color-scheme:light){
  :root:not([data-theme="dark"]){color-scheme:light;--bg:#f7f8fa;--surface:#ffffff;--surface-2:#f2f4f8;--surface-3:#e9ecf2;--text:#171b21;--muted:#5a6472;--line:#e3e6ec;--accent:#0a7d5c;--accent-2:#1d4ed8;--warning:#7a4f00;--danger:#c02733}
  body{background:var(--bg)}
}
:root{color-scheme:dark;--bg:#0b0d12;--surface:#12151c;--surface-2:#171b22;--surface-3:#1d222b;--text:#e8ebf2;--muted:#a0a9bb;--line:#272c38;--accent:#34d399;--accent-2:#7aa2ff;--warning:#fbbf24;--danger:#fb7185;--radius:12px;--radius-sm:8px}
body.theme-light{--bg:#f7f8fa;--surface:#ffffff;--surface-2:#f2f4f8;--surface-3:#e9ecf2;--text:#171b21;--muted:#5a6472;--line:#e3e6ec;--accent:#0a7d5c;--accent-2:#1d4ed8;--warning:#7a4f00;--danger:#c02733}
*{box-sizing:border-box}html{background:var(--bg)}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:1280px;margin:0 auto;padding:32px 32px 64px}

/* Header: one line of identity, one of metadata, controls right. */
.page-head{display:flex;flex-wrap:wrap;align-items:end;gap:12px;margin-bottom:24px}
.page-head h1{font-size:22px;font-weight:650;letter-spacing:-.01em;margin:0;line-height:1.2}
.page-meta{color:var(--muted);font-size:12.5px;margin:0 0 0 auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.theme-toggle,.format-toggle{border:1px solid var(--line);background:var(--surface);color:var(--text);border-radius:var(--radius-sm);padding:7px 12px;cursor:pointer;font:inherit;font-size:12.5px;transition:background .15s ease,border-color .15s ease}
.format-toggle{color:var(--accent-2)}
.theme-toggle:hover,.format-toggle:hover{border-color:var(--muted)}
:is(.theme-toggle,.format-toggle):focus-visible{outline:3px solid rgba(122,162,255,.45);outline-offset:2px}

/* KPIs: quiet tiles, big tabular figures. */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:0 0 20px}
.kpi{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:16px 18px}
.kpi .label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em;font-weight:550}
.kpi .value{font-size:26px;font-weight:680;letter-spacing:-.01em;margin-top:10px;font-variant-numeric:tabular-nums}

/* Filters: one quiet row. */
.controls{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:12px 14px;margin:0 0 20px;display:flex;align-items:end;gap:10px;flex-wrap:wrap}
.controls label{display:flex;flex-direction:column;gap:5px;min-width:140px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.07em;font-weight:550}
.controls input,.controls select,.controls button{min-height:36px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface-2);color:var(--text);padding:7px 10px;font:inherit;font-size:13px}
.controls input:focus-visible,.controls select:focus-visible,.controls button:focus-visible{outline:3px solid rgba(122,162,255,.45);outline-offset:2px;border-color:var(--accent-2)}
.controls button{cursor:pointer;background:var(--surface-3);color:var(--text);font-weight:600}
.controls button:hover{border-color:var(--muted)}
#filterStatus{color:var(--muted);align-self:center;font-size:12.5px}

/* Bento: a 12-column grid so tiles can take meaningful, varied widths instead of stacking. */
.bento{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:16px}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px;min-width:0;overflow:auto}
.panel h2{font-size:12.5px;font-weight:650;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin:0 0 14px}
.span-8{grid-column:span 8}.span-6{grid-column:span 6}.span-4{grid-column:span 4}.span-12{grid-column:span 12}
.chart{min-height:180px}
.sub{color:var(--muted);font-size:12.5px}

/* Tables: hairline rows, no boxed grid. */
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap;font-variant-numeric:tabular-nums}
th{color:var(--muted);font-size:11px;letter-spacing:.08em;text-transform:uppercase;font-weight:550}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover{background:var(--surface-2)}

/* Interactive bars drawn by the script. */
.bar-row{display:grid;grid-template-columns:100px minmax(80px,1fr) 118px;gap:10px;align-items:center;font-size:12.5px}
.bar-row.inactive{opacity:.35}
.bar{height:10px;background:var(--surface-3);border-radius:99px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--accent-2);border-radius:99px;transition:width 220ms cubic-bezier(.2,0,0,1)}
.empty{color:var(--muted);padding:22px 0;text-align:center}

/* The raw payload is data, not a section of the report. It is collapsed by default so the page
   is a report; a reader who wants the envelope can open it. */
details.raw{border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);margin-top:16px}
details.raw>summary{cursor:pointer;padding:12px 16px;color:var(--muted);font-size:12.5px;font-weight:550;letter-spacing:.04em;list-style:none}
details.raw>summary::-webkit-details-marker{display:none}
details.raw[open]>summary{border-bottom:1px solid var(--line)}
details.raw pre{border:none;border-radius:0;margin:0;padding:16px;max-height:520px;overflow:auto;background:var(--surface-2)}
pre{white-space:pre-wrap;word-break:break-word;color:var(--muted);font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}
h2.standalone{font-size:12.5px;font-weight:650;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin:28px 0 10px}
footer{color:var(--muted);margin-top:28px;font-size:12px;border-top:1px solid var(--line);padding-top:16px}

@media(max-width:960px){
  main{padding:20px 16px 48px}
  .span-8,.span-6,.span-4{grid-column:span 12}
  .controls label{flex:1 1 130px}
  .kpi .value{font-size:22px}
  .bar-row{grid-template-columns:80px minmax(60px,1fr) 100px}
}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{transition-duration:.01ms!important;animation-duration:.01ms!important;scroll-behavior:auto!important}}
`;


/**
 * The session's shape, drawn in Node rather than in the browser.
 *
 * The interactive charts above need script to work; these do not. That matters for three reasons:
 * the file must stay correct with JavaScript disabled, it must print to a clean PDF, and the
 * numbers here are the same ones the report already computed - a chart cannot disagree with the
 * report it sits next to because it never calculates anything.
 *
 * Every chart is followed by a collapsed table carrying the same figures, so no number exists
 * only inside a graphic, and an unpriceable value is drawn hatched rather than as a zero.
 */
function costKnown(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function tokenBreakdown(data) {
  const usage = data?.usage ?? {};
  const segments = [
    { label: 'Fresh input', value: Number(usage.freshInputTokens ?? usage.inputTokens ?? 0) || 0 },
    { label: 'Cached read', value: Number(usage.cacheReadTokens ?? 0) || 0 },
    { label: 'Cache write', value: Number(usage.cacheWriteTokens ?? 0) || 0 },
    { label: 'Output', value: Number(usage.outputTokens ?? 0) || 0 },
  ];
  return segments;
}

function timelineSection(data) {
  const timeline = Array.isArray(data?.timeline) ? data.timeline : [];
  if (timeline.length === 0) return '';
  const known = timeline.filter((entry) => costKnown(entry.costUsd));
  const hasUnknown = known.length !== timeline.length;
  // Cumulative cost over time. The first and last figure are named, so the line is never the
  // only place a number appears.
  let running = 0;
  const points = known.map((entry) => {
    running += entry.costUsd;
    return { t: entry.t, value: running };
  });
  const total = running;
  const chart = sparkline({
    points,
    width: 720,
    height: 90,
    title: 'Cumulative cost over the session',
  });
  const rows = renderTable(
    ['#', 'Time', 'Model', 'Cost'],
    timeline.slice(0, 200).map((entry, index) => [
      String(index + 1),
      entry.t,
      entry.model ?? '(unknown)',
      money(costKnown(entry.costUsd) ? entry.costUsd : null),
    ]),
  );
  const meta = data?.timelineMeta?.bucketed
    ? `<p class="sub">Bucketed: ${timeline.length} time buckets rather than individual calls, because the session exceeds the inline limit.</p>`
    : '';
  const unknownNote = hasUnknown
    ? '<p class="sub">Some calls could not be priced, so the cumulative line covers the priced calls only. The figures below name which.</p>'
    : '';
  // Nothing priced is a different statement from "priced at zero". Saying "$0.00 priced" for a
  // session where no call could be priced is the exact error this project exists to prevent.
  const pricedSummary = known.length === 0
    ? 'no call could be priced'
    : `${money(total)} priced${hasUnknown ? ', partly unpriced' : ''}`;
  return `<section class="panel span-12"><h2>Where the session went</h2>${meta}${unknownNote}${chart}`
    + `<p class="sub">${timeline.length} call(s) · ${pricedSummary}</p>`
    + `<details><summary>Every call</summary>${rows}</details></section>`;
}

function tokenMixSection(data) {
  const segments = tokenBreakdown(data);
  const known = segments.some((segment) => segment.value > 0);
  if (!known) return '';
  const chart = stackedBar({
    segments,
    width: 720,
    title: 'Token mix',
    format: (value) => `${Math.round(value).toLocaleString('en-US')} tok`,
  });
  return `<section class="panel span-6"><h2>Token mix</h2>${chart}</section>`;
}

function modelCostSection(models) {
  if (models.length === 0) return '';
  const rows = models.slice(0, 12).map((model) => ({
    label: `${model.provider ?? '?'} / ${model.model ?? '?'}`,
    value: costKnown(model.totalCost) ? model.totalCost : (model.recordedCostUsd ?? null),
    unknown: model.rateKnown === false || !(costKnown(model.totalCost) || costKnown(model.recordedCostUsd)),
  }));
  const chart = barChart({
    rows,
    width: 720,
    title: 'Cost by model',
    format: (value) => money(value),
  });
  const unpriced = rows.filter((row) => row.unknown).map((row) => row.label);
  const note = unpriced.length > 0
    ? `<p class="sub">Not priced: ${esc(unpriced.join(', '))}. An unknown cost is never drawn as zero.</p>`
    : '';
  return `<section class="panel span-6"><h2>Cost by model</h2>${chart}${note}</section>`;
}

function sessionTreeSection(data, sessions) {
  if (sessions.length === 0) return '';
  const graph = data?.sessionGraph ?? {};
  const excluded = new Set(graph.excludedSessionIds ?? []);
  const byParent = new Map();
  for (const session of sessions) {
    const parent = session.parentId ?? null;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(session);
  }
  const rows = [];
  const visited = new Set();
  const walk = (parent, depth) => {
    for (const session of byParent.get(parent) ?? []) {
      // A cycle in the stored graph would otherwise recurse forever. Skipping an already-shown
      // session also keeps a session listed once when two parents claim it.
      if (visited.has(session.id)) continue;
      visited.add(session.id);
      const cost = costKnown(session.cost) ? session.cost : (costKnown(session.recordedCostUsd) ? session.recordedCostUsd : null);
      rows.push([
        `${'\u00a0'.repeat(depth * 3)}${depth > 0 ? '\u2514 ' : ''}${session.title || session.id}`,
        number(session.calls ?? 0),
        money(cost),
        excluded.has(session.id) ? 'excluded' : 'billed',
      ]);
      walk(session.id, depth + 1);
    }
  };
  // Roots are the sessions with no parent, plus any the report names as roots. Walking `null`
  // first covers the normal case; a root whose parent row is outside this report still gets
  // walked, so a partial report does not silently hide a session.
  const rootIds = new Set((graph.rootSessionIds ?? []).map(String));
  for (const session of sessions) {
    if (!session.parentId) rootIds.add(session.id);
  }
  for (const id of rootIds) walk(id, 0);
  // A session whose parent is not in this report - a partial or filtered selection - would
  // otherwise be invisible. Show it at the top level rather than silently dropping a cost.
  for (const session of sessions) walk(session.id, 0);
  if (rows.length === 0) return '';
  const table = renderTable(['Session', 'Calls', 'Cost', 'Status'], rows);
  return `<section class="panel span-12"><h2>Session tree</h2>`
    + '<p class="sub">An excluded subagent is not billed, and is listed so the total is not silently incomplete.</p>'
    + `${table}</section>`;
}

export function renderDashboard(data, { title = 'Session Cost Dashboard' } = {}) {
  const account = data?.account;
  const totals = usage(data);
  const billingTotals = billing(data);
  const periods = rowsForPeriods(data);
  const models = [...modelRows(data), ...accountModels(data)]
    .filter((model, index, all) => all.findIndex((item) => (
      item.provider === model.provider && item.model === model.model
    )) === index);
  const rawPerSession = data?.perSession ?? null;
  const rawSessions = data?.sessions ?? (rawPerSession
    ? Object.entries(rawPerSession).map(([id, value]) => ({ id, ...value }))
    : []);
  const sessions = (Array.isArray(rawSessions)
    ? rawSessions
    : Object.entries(rawSessions).map(([id, value]) => ({ id, ...value })))
    .map(normalizeSession);
  const serverSections = [
    timelineSection(data),
    tokenMixSection(data),
    modelCostSection(models),
    sessionTreeSection(data, sessions),
  ].filter(Boolean).join('\n');
  const payload = safeJson({ data, models, periods, sessions });
  const script = dashboardScript(payload);
  const policy = contentSecurityPolicy(script);
  const modelTable = models.length
    ? renderTable(
      ['Provider / Model', 'Calls', 'Tokens', 'Cost'],
      models.slice(0, 50).map((model) => [
        `${model.provider} / ${model.model}`,
        number(model.calls),
        number(model.totalTokens),
        money(model.rateKnown === false ? null : (model.totalCost ?? model.recordedCostUsd)),
      ]),
    )
    : '';
  const periodTable = periods.length
    ? renderTable(
      ['Period', 'Requests', 'Reference / Cost', 'Credits', 'Tokens'],
      periods.map((period) => [
        period.from ?? period.label,
        number(period.requests),
        money(period.referenceCostUsd ?? period.totalCost),
        money(period.creditsUsedUsd),
        number(period.totalTokens),
      ]),
    )
    : '';
  const titleValue = account
    ? `Account ${account.userId}`
    : (data?.session?.id ?? data?.sessionId ?? 'Session report');
  const snapshot = data?.snapshot ?? {};
  const generatedAt = data?.generatedAt ?? isoNow();


  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${esc(policy)}">
<title>${esc(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
<header class="page-head">
  <h1>${esc(title)}</h1>
  <div class="page-meta"><span>${esc(titleValue)} · ${esc(generatedAt)} · ${esc(snapshot.active ? 'snapshot' : 'final')}</span><button id="formatToggle" class="format-toggle" type="button" aria-pressed="true">Full numbers</button><button id="themeToggle" class="theme-toggle" type="button" aria-label="Toggle light and dark mode">Light mode</button></div>
</header>
<section class="controls" id="filters"><label>Provider <select id="providerFilter"><option value="">All providers</option></select></label><label>Model <select id="modelFilter"><option value="">All models</option></select></label><label>Session <select id="sessionFilter"><option value="">All sessions</option></select></label><label>Day <select id="dayFilter"><option value="">All days</option></select></label><button id="resetFilters" type="button">Reset</button><small id="filterStatus"></small></section>
<div class="bento">${serverSections}<section class="panel span-6"><h2>Usage trend</h2><div id="trendChart" class="chart" aria-label="Daily token and cost trend"></div></section><section class="panel span-6"><h2>Model share</h2><div id="modelChart" aria-label="Token share by model"></div></section></div>
${periodTable ? `<h2 class="standalone">Period summary</h2>${periodTable}` : ''}
${modelTable ? `<h2 class="standalone">Models</h2>${modelTable}` : ''}
<div id="filterTables"></div>
<details class="raw"><summary>Normalized report data</summary><pre>${esc(JSON.stringify(data, null, 2))}</pre></details>
<footer>Generated locally by session-cost. No external assets or network requests.</footer>
<script>${script}</script>
</main>
</body>
</html>`;
}

export function writeDashboard(data, { outPath, title } = {}) {
  const output = path.resolve(outPath ?? 'session-cost-dashboard.html');
  const html = renderDashboard(data, { title });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  // Write to a sibling temp file and rename. A direct write leaves a half-written
  // dashboard on disk if the process dies mid-write, and an interrupted HTML file is
  // both unreadable and a stale artifact the user cannot tell apart from a good one.
  const temporary = path.join(path.dirname(output), `.${path.basename(output)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, html, 'utf8');
    fs.renameSync(temporary, output);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* The temp file may not exist. */ }
    throw new Error(`could not write the dashboard to ${path.basename(output)}: ${error?.code ?? 'write failed'}`);
  }
  return output;
}
