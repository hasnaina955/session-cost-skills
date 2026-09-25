// Canonical dashboard renderer. `npm run check:dashboard` verifies that each
// independently installable adapter contains an exact generated copy.
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

function normalizeSession(session) {
  const metrics = session.metrics ?? session;
  const input = Number(metrics.inputTokens ?? 0);
  const output = Number(metrics.outputTokens ?? 0);
  return {
    ...session,
    metrics: {
      ...metrics,
      totalTokens: Number(metrics.totalTokens) || input + output,
      totalCost: Number(metrics.totalCost ?? metrics.cost ?? 0),
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
  return element('div', { class: 'card' }, [
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
:root{color-scheme:dark;--bg:#08101d;--surface:#101a2b;--surface-2:#14233a;--surface-3:#1a2c47;--text:#eef4ff;--muted:#91a3bf;--line:#263956;--accent:#6ee7b7;--accent-2:#79a9ff;--warning:#f5c56b;--danger:#ff8198;--radius:18px;--radius-sm:11px;--shadow:0 18px 50px rgba(0,0,0,.22)}
*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;background:radial-gradient(ellipse 70% 40% at 15% -5%,#1d3962 0,transparent 65%),var(--bg);color:var(--text);font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:.005em}main{max-width:1500px;margin:0 auto;padding:38px 40px 60px}.top-actions{display:flex;align-items:center;flex-wrap:wrap}.theme-toggle,.format-toggle{border:1px solid var(--line);background:var(--surface-3);color:var(--text);border-radius:999px;padding:7px 11px;cursor:pointer;font:inherit;margin-left:8px}.format-toggle{color:var(--accent-2)}.theme-toggle:hover,.format-toggle:hover{background:#24405f}.theme-toggle:focus-visible,.format-toggle:focus-visible{outline:3px solid rgba(121,169,255,.32);outline-offset:2px}h1{font-size:clamp(26px,3vw,38px);line-height:1.1;letter-spacing:0;margin:0 0 8px}h2{font-size:18px;letter-spacing:0;margin:30px 0 12px}.sub{color:var(--muted);font-size:13px}
.controls,.card,.panel{background:linear-gradient(145deg,rgba(20,35,58,.94),rgba(13,23,39,.96));border:1px solid var(--line);box-shadow:var(--shadow);border-radius:var(--radius)}.controls{padding:16px;margin:26px 0 18px;display:flex;align-items:end;gap:12px;flex-wrap:wrap}.controls label{display:flex;flex-direction:column;gap:6px;min-width:150px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.09em}.controls input,.controls select,.controls button{min-height:40px;border:1px solid #314a6c;border-radius:var(--radius-sm);background:#0b1527;color:var(--text);padding:8px 11px;font:inherit}.controls input:focus-visible,.controls select:focus-visible,.controls button:focus-visible{outline:3px solid rgba(121,169,255,.32);outline-offset:2px;border-color:var(--accent-2)}.controls button{min-height:40px;cursor:pointer;background:var(--surface-3);color:var(--accent);font-weight:700;transition:transform 150ms cubic-bezier(.2,0,0,1),background 150ms ease}.controls button:hover{background:#24405f}.controls button:active{transform:scale(.96)}#filterStatus{color:var(--muted);align-self:center}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin:18px 0 26px}.card{padding:17px 18px;min-height:100px;position:relative;overflow:hidden}.card::after{content:"";position:absolute;inset:0 0 auto;height:2px;background:linear-gradient(90deg,var(--accent-2),transparent);opacity:.7}.label{color:var(--muted);font-size:12px;letter-spacing:.02em}.value{font-size:25px;font-weight:760;letter-spacing:0;margin-top:8px;font-variant-numeric:tabular-nums}.columns{display:grid;grid-template-columns:minmax(0,1.12fr) minmax(0,1fr);gap:16px}.panel{padding:19px;min-width:0;overflow:auto}.panel h2{margin-top:0}
table{width:100%;border-collapse:collapse;border-radius:12px;overflow:hidden}th,td{text-align:left;padding:11px 12px;border-bottom:1px solid rgba(55,76,108,.58);white-space:nowrap;font-variant-numeric:tabular-nums}th{color:var(--muted);font-size:10px;letter-spacing:.1em;text-transform:uppercase;background:rgba(10,18,32,.35);position:sticky;top:0;backdrop-filter:blur(8px)}tr:last-child td{border-bottom:0}tbody tr{transition:background 150ms ease}tbody tr:hover{background:rgba(81,129,190,.12)}.chart{display:flex;flex-direction:column;gap:12px;padding-top:5px}.bar-row{display:grid;grid-template-columns:100px minmax(80px,1fr) 118px;gap:10px;align-items:center;font-size:12px}.bar-row.inactive{opacity:.35}.bar{height:11px;background:#1a2a43;border-radius:99px;overflow:hidden}.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--accent-2),var(--accent));border-radius:99px;transition:width 220ms cubic-bezier(.2,0,0,1)}.empty{color:var(--muted);padding:22px 0;text-align:center}

pre{white-space:pre-wrap;word-break:break-word;background:#070d19;border:1px solid var(--line);padding:16px;border-radius:var(--radius-sm);max-height:560px;overflow:auto;color:#b6c8e5;font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}footer{color:var(--muted);margin-top:30px;font-size:12px}
body.theme-light{--bg:#f4f7fb;--surface:#fff;--surface-2:#edf3fa;--surface-3:#fff;--text:#142033;--muted:#4b5b73;--line:#d7e1ef;--accent:#087f5b;--accent-2:#1d4ed8;--warning:#805400;background:radial-gradient(ellipse 70% 40% at 15% -5%,#dbeafe 0,transparent 65%),var(--bg);color:var(--text)}body.theme-light .controls,body.theme-light .card,body.theme-light .panel{background:rgba(255,255,255,.96);box-shadow:0 12px 35px rgba(20,40,70,.08)}body.theme-light .controls input,body.theme-light .controls select,body.theme-light .controls button{background:#fff;border-color:#9fb4cf;color:var(--text)}body.theme-light .controls select option{background:#fff;color:var(--text)}body.theme-light .controls button{background:#e8f1ff;color:var(--accent-2)}body.theme-light table,body.theme-light tbody,body.theme-light tbody tr,body.theme-light tr{background:#fff;color:var(--text)}body.theme-light th{background:#eaf1fb;color:#34445c;border-color:var(--line)}body.theme-light td{border-color:var(--line);color:var(--text)}body.theme-light tbody tr:hover{background:#eef5ff}body.theme-light pre{background:#0b1527;color:#c4d5ee}body.theme-light :focus-visible{outline-color:#1d4ed8}
@media(max-width:900px){main{padding:26px 16px 44px}.columns{grid-template-columns:1fr}.controls label{flex:1 1 140px}.value{font-size:22px}.bar-row{grid-template-columns:80px minmax(60px,1fr) 105px}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{transition-duration:.01ms!important;animation-duration:.01ms!important;scroll-behavior:auto!important}}
`;


export function renderDashboard(data, { title = 'Session Cost Dashboard' } = {}) {
  const account = data?.account;
  const totals = usage(data);
  const billingTotals = billing(data);
  const periods = rowsForPeriods(data);
  const models = [...modelRows(data), ...accountModels(data)]
    .filter((model, index, all) => all.findIndex((item) => (
      item.provider === model.provider && item.model === model.model
    )) === index);
  const rawSessions = data?.sessions ?? data?.perSession ?? [];
  const sessions = (Array.isArray(rawSessions)
    ? rawSessions
    : Object.entries(rawSessions).map(([id, value]) => ({ id, ...value })))
    .map(normalizeSession);
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
  const generatedAt = data?.generatedAt ?? new Date().toISOString();


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
<h1>${esc(title)}</h1>
<div class="sub">${esc(titleValue)} · generated ${esc(generatedAt)} · ${esc(snapshot.active ? 'snapshot' : 'final')}</div>
<div class="top-actions"><button id="themeToggle" class="theme-toggle" type="button" aria-label="Toggle light and dark mode">☼ Light mode</button><button id="formatToggle" class="format-toggle" type="button" aria-pressed="true">Full numbers</button></div>
<section class="grid"><div class="card"><div class="label">Total tokens</div><div class="value">${number(totals.totalTokens)}</div></div><div class="card"><div class="label">Cache-hit rate</div><div class="value">${percent(totals.cacheHitRate)}</div></div><div class="card"><div class="label">Recorded / reference cost</div><div class="value">${money(billingTotals.recordedCostUsd ?? billingTotals.referenceCostUsd)}</div></div><div class="card"><div class="label">Credits used</div><div class="value">${money(billingTotals.creditsUsedUsd)}</div></div></section>
<section class="controls" id="filters"><label>Provider <select id="providerFilter"><option value="">All providers</option></select></label><label>Model <select id="modelFilter"><option value="">All models</option></select></label><label>Session <select id="sessionFilter"><option value="">All sessions</option></select></label><label>Day <select id="dayFilter"><option value="">All days</option></select></label><button id="resetFilters" type="button">Reset</button><small id="filterStatus"></small></section>
<section class="grid" id="cards"></section>
<div class="columns"><section class="panel"><h2>Usage trend</h2><div id="trendChart" class="chart" aria-label="Daily token and cost trend"></div></section><section class="panel"><h2>Model share</h2><div id="modelChart" aria-label="Token share by model"></div></section></div>
${periodTable ? `<h2>Period summary</h2>${periodTable}` : ''}
${modelTable ? `<h2>Models</h2>${modelTable}` : ''}
<div id="filterTables"></div>
<h2>Normalized report data</h2><pre>${esc(JSON.stringify(data, null, 2))}</pre>
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
