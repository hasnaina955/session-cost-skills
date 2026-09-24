import fs from 'node:fs';
import path from 'node:path';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function number(value) { return Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
function money(value) { return value === null || value === undefined ? '—' : `$${Number(value).toFixed(6)}`; }
function percent(value) { return `${(Number(value || 0) * 100).toFixed(1)}%`; }
function modelRows(data) {
  const raw = data?.models ?? data?.total?.models ?? [];
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return Object.values(raw);
  return [];
}
function usage(data) {
  const account = data?.account;
  return account?.tokenTotals ?? data?.usage ?? {
    totalTokens: data?.totalTokens,
    inputTokens: data?.inputTokens,
    cacheReadTokens: data?.cacheReadTokens,
    outputTokens: data?.outputTokens,
    cacheHitRate: data?.cacheRate,
  };
}
function billing(data) {
  return data?.account?.billingTotals ?? data?.billing ?? { recordedCostUsd: data?.totalCost, rateKnown: data?.rateKnown };
}
function rowsForPeriods(data) {
  return data?.account?.periods?.daily ?? data?.periods?.daily ?? [];
}
function renderTable(headers, rows) {
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
export function renderDashboard(data, { title = 'Session Cost Dashboard' } = {}) {
  const account = data?.account;
  const u = usage(data);
  const b = billing(data);
  const periods = rowsForPeriods(data);
  const models = modelRows(data);
  const modelTable = models.length ? renderTable(['Provider / Model', 'Calls', 'Tokens', 'Cost'], models.slice(0, 50).map((m) => [esc(`${m.provider ?? m.providerKey ?? '—'} / ${m.model ?? m.modelId ?? '—'}`), number(m.calls), number(m.totalTokens), money(m.rateKnown === false ? null : (m.totalCost ?? m.recordedCostUsd))])) : '';
  const periodTable = periods.length ? renderTable(['Period', 'Requests', 'Reference / Cost', 'Credits', 'Tokens'], periods.map((p) => [esc(p.from ?? p.label), number(p.requests), money(p.referenceCostUsd ?? p.totalCost), money(p.creditsUsedUsd), number(p.totalTokens)])) : '';
  const titleValue = account ? `Account ${account.userId}` : (data?.session?.id ?? data?.sessionId ?? 'Session report');
  const snapshot = data?.snapshot ?? {};
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
:root{color-scheme:dark;--bg:#0b1020;--panel:#121a2d;--muted:#8ea0bd;--text:#eaf0ff;--line:#27334b;--accent:#65d6ad;--warn:#ffbd6b}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:1200px;margin:auto;padding:32px}h1{font-size:28px;margin:0 0 6px}h2{margin:28px 0 10px;font-size:17px}.sub{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:24px 0}.card,.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px}.label{color:var(--muted);font-size:12px}.value{font-size:22px;font-weight:700;margin-top:5px}.good{color:var(--accent)}.warn{color:var(--warn)}table{width:100%;border-collapse:collapse;background:var(--panel);border-radius:10px;overflow:hidden}th,td{text-align:left;padding:10px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.05em}tr:last-child td{border-bottom:0}pre{white-space:pre-wrap;word-break:break-word;background:#090d18;border:1px solid var(--line);padding:14px;border-radius:10px;max-height:460px;overflow:auto;color:#b8c7e3}footer{color:var(--muted);margin-top:26px;font-size:12px}
</style></head><body><main><h1>${esc(title)}</h1><div class="sub">${esc(titleValue)} · generated ${esc(data?.generatedAt ?? new Date().toISOString())} · ${esc(snapshot.active ? 'snapshot' : 'final')}</div><section class="grid"><div class="card"><div class="label">Total tokens</div><div class="value">${number(u.totalTokens)}</div></div><div class="card"><div class="label">Cache-hit rate</div><div class="value good">${percent(u.cacheHitRate)}</div></div><div class="card"><div class="label">Recorded / reference cost</div><div class="value">${money(b.recordedCostUsd ?? b.referenceCostUsd)}</div></div><div class="card"><div class="label">Credits used</div><div class="value">${money(b.creditsUsedUsd)}</div></div></section>${periodTable ? `<h2>Period summary</h2>${periodTable}` : ''}${modelTable ? `<h2>Models</h2>${modelTable}` : ''}<h2>Normalized report data</h2><pre>${esc(JSON.stringify(data, null, 2))}</pre><footer>Generated locally by session-cost. No external assets or network requests.</footer></main></body></html>`;
  return html;
}
export function writeDashboard(data, { outPath, title } = {}) {
  const output = path.resolve(outPath ?? 'session-cost-dashboard.html');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, renderDashboard(data, { title }), 'utf8');
  return output;
}
