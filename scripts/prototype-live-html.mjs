// PROTOTYPE — the live HTML view for scripts/prototype-watch.mjs.
//
// The production dashboard is deliberately CSP-locked with no scripting. This demo adds
// a self-refresh so the page visibly updates, which is exactly the tradeoff a real live
// dashboard would force on that design.
export function renderLiveHtml(history, { budget, runtime: rt, target: sessionId }) {
  const latest = history[history.length - 1];
  const cost = latest.billing?.amountUsd ?? null;
  const usage = latest.usage;
  const total = usage.totalTokens || 1;
  const max = Math.max(...history.map((f) => f.billing?.amountUsd ?? 0), cost ?? 0, 0.0001);
  const points = history.map((f, i) => {
    const x = history.length === 1 ? 0 : (i / (history.length - 1)) * 100;
    return `${x.toFixed(1)},${(100 - ((f.billing?.amountUsd ?? 0) / max) * 92).toFixed(1)}`;
  }).join(' ');
  const models = Object.values(latest.total?.models ?? {}).sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
  const modelTotal = models.reduce((sum, m) => sum + (m.cost ?? 0), 0) || 1;
  const bar = (p, color) => `<div class="bar"><i style="width:${Math.max(0, Math.min(100, p)).toFixed(1)}%;background:${color}"></i></div>`;
  const pct = cost == null || !budget ? 0 : Math.min(1, cost / budget);
  const money = (v) => (v == null ? 'n/a' : `$${Number(v).toFixed(4)}`);
  const millions = (v) => `${(Number(v) / 1e6).toFixed(2)} M`;
  const tokens = [
    ['Fresh input', usage.freshInputTokens, 'var(--warn)'],
    ['Cached read', usage.cacheReadTokens, 'var(--accent)'],
    ['Cache write', usage.cacheWriteTokens, 'var(--ok)'],
    ['Output', usage.outputTokens, 'var(--dim)'],
  ];
  const basis = latest.billing?.basis === 'provider-rate-estimate' ? ' (estimate)' : ' (runtime-recorded)';
  const delta = history.length > 1
    ? `+${(cost - (history[history.length - 2].billing?.amountUsd ?? 0)).toFixed(4)} since last poll`
    : 'first reading';
  const tree = latest.sessionGraph?.includedSessionIds ?? [];
  const asOf = new Date(latest.snapshot?.capturedAt ?? Date.now()).toISOString().slice(11, 19);
  const style = `
  :root { color-scheme: dark; --bg:#0d1117; --panel:#161b22; --line:#30363d; --fg:#e6edf3; --dim:#8b949e; --ok:#3fb950; --warn:#d29922; --hot:#f85149; --accent:#58a6ff; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:var(--bg); color:var(--fg); font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  .wrap { max-width:1000px; margin:0 auto; display:grid; gap:16px; }
  header { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
  h1 { font-size:16px; margin:0; letter-spacing:.04em; }
  .live { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--ok); }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--ok); animation:p 1.4s ease-in-out infinite; }
  @keyframes p { 0%,100%{opacity:1} 50%{opacity:.25} }
  .muted { color:var(--dim); font-size:12px; }
  .grid { display:grid; grid-template-columns:1.4fr 1fr; gap:16px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; }
  .cost { font-size:40px; font-weight:600; letter-spacing:-.02em; }
  .delta { color:var(--ok); font-size:13px; }
  .label { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.08em; margin-bottom:6px; }
  .bar { height:8px; background:#21262d; border-radius:4px; overflow:hidden; margin:4px 0 10px; }
  .bar i { display:block; height:100%; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  td { padding:3px 0; } td:last-child { text-align:right; }
  .spark { width:100%; height:74px; display:block; }
  .over { color:var(--hot); font-weight:600; }
  footer { color:var(--dim); font-size:11px; }
  code { color:var(--accent); }`;

  const budgetBlock = budget
    ? `<div style="margin-top:14px"><div class="label">Budget $${budget.toFixed(2)} ${cost > budget ? '<span class="over">· OVER</span>' : ''}</div>${bar(pct * 100, cost > budget ? 'var(--hot)' : 'var(--accent)')}</div>`
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="2">
<title>session-cost live</title>
<style>${style}</style></head>
<body><div class="wrap">
  <header>
    <h1>session-cost · live</h1>
    <span class="live"><span class="dot"></span>${latest.snapshot?.active ? 'RUNNING' : 'IDLE'}</span>
    <span class="muted">${rt} · <code>${sessionId}</code> · as of ${asOf} UTC</span>
  </header>
  <div class="grid">
    <div class="card">
      <div class="label">Total cost${basis}</div>
      <div class="cost">${money(cost)}</div>
      <div class="delta">${delta}</div>
      ${budgetBlock}
      <div style="margin-top:14px"><div class="label">Cost trend across polls</div>
        <svg class="spark" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="cost trend">
          <polyline fill="none" stroke="var(--accent)" stroke-width="1.5" points="${points}"/>
        </svg>
      </div>
    </div>
    <div class="card">
      <div class="label">Tokens · ${millions(usage.totalTokens)}</div>
      ${tokens.map(([label, value, color]) => `<div class="muted">${label} ${millions(value)} · ${(value / total * 100).toFixed(0)}%</div>${bar(value / total * 100, color)}`).join('')}
      <div class="label" style="margin-top:8px">Cache hit rate</div>
      <div>${(usage.cacheHitRate * 100).toFixed(1)}%</div>
    </div>
  </div>
  <div class="card">
    <div class="label">Models</div>
    <table>${models.map((m) => `<tr><td>${m.provider}/${m.model}</td><td style="width:34%">${bar((m.cost ?? 0) / modelTotal * 100, 'var(--accent)')}</td><td>${money(m.cost)}</td></tr>`).join('')}</table>
  </div>
  <div class="card">
    <div class="label">Session tree — ${tree.length} sessions</div>
    <table>${tree.map((id) => `<tr><td class="muted">${id}</td><td>${id === sessionId ? 'target' : 'subagent'}</td></tr>`).join('')}</table>
  </div>
  <footer>Prototype only. Self-refreshing every 2s so the page visibly updates. The production dashboard is intentionally CSP-locked with no scripting, so a real live view would rewrite the file and rely on reload rather than loosening that policy.</footer>
</div></body></html>`;
}
