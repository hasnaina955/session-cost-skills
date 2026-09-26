// Attribute session spend to named cost centres.
//
// A cost centre is a name attached to a set of session ids, so "the auth refactor"
// can be totalled rather than just measured. Two properties matter more than the feature.
//
// A session in no cost centre is reported as untagged rather than being merged into a
// named one, because silently absorbing unattributed spend into whichever tag happens
// to be listed first is how a number stops meaning anything. And a session listed in
// two cost centres is reported as a conflict rather than double-counted, because a
// duplicated total is worse than an unassignable one.
//
// A tag covers a session's descendants automatically: the subagent graph already
// attributes every child to its root, so naming the root names the whole task.

/** Build an id -> parent map from the report's own session rows. */
export function parentMapFrom(sessions) {
  const parents = new Map();
  for (const entry of sessions ?? []) {
    const id = entry?.row?.sessionId ?? entry?.id;
    if (id) parents.set(id, entry?.row?.parentSessionId ?? null);
  }
  return parents;
}

// Walk the real parent chain. A cycle is possible in a hand-edited ledger, so the walk
// is bounded by the number of known sessions and stops when it revisits a node.
function isDescendantOf(candidate, ancestor, parents) {
  let current = candidate;
  for (let steps = 0; steps <= parents.size; steps += 1) {
    if (current === ancestor) return true;
    const parent = parents.get(current);
    if (parent == null || parent === current) return false;
    current = parent;
  }
  return false;
}

/** Expand cost-centre session ids to include every descendant in the graph. */
export function expandCostCentres(costCentres, { sessions = [] } = {}) {
  const parents = parentMapFrom(sessions);
  const ids = [...parents.keys()];
  return (costCentres ?? []).map((centre) => {
    const seeds = new Set(centre.sessionIds ?? []);
    const members = ids.filter((id) => seeds.has(id) || [...seeds].some((seed) => isDescendantOf(id, seed, parents)));
    return { name: centre.name, seedSessionIds: [...seeds], memberSessionIds: members };
  });
}

/**
 * Group session rows into cost centres.
 * @param {{sessions: object[]}} combined a report (or merged set) carrying session rows
 * @param {Array<{name: string, sessionIds: string[]}>} costCentres
 */
export function attributeCostCentres(combined, costCentres) {
  const rows = combined?.sessions ?? [];
  const expanded = expandCostCentres(costCentres, { sessions: rows });

  const owner = new Map();
  const conflicts = [];
  for (const centre of expanded) {
    for (const id of centre.memberSessionIds) {
      if (owner.has(id)) {
        conflicts.push({ sessionId: id, centres: [owner.get(id), centre.name].sort() });
        continue;
      }
      owner.set(id, centre.name);
    }
  }

  const groups = new Map();
  for (const centre of expanded) groups.set(centre.name, { name: centre.name, sessions: [], ...emptyTotals() });
  const untagged = { name: null, sessions: [], ...emptyTotals() };

  for (const row of rows) {
    const id = row?.row?.sessionId ?? row?.id;
    const target = owner.has(id) ? groups.get(owner.get(id)) : untagged;
    target.sessions.push(id ?? null);
    addToTotals(target, row);
  }

  // finishTotals must be applied here, not only in the renderer: otherwise the returned
  // object carries the emptyTotals default of 0 for a centre whose spend is unknown, and
  // a caller reading the API rather than the text would see a confident $0.00.
  const centres = [...groups.values()]
    .filter((group) => group.sessions.length > 0 || group.sessionCount > 0)
    .map(finishTotals);
  centres.sort((left, right) => (right.costUsd ?? -1) - (left.costUsd ?? -1));
  return {
    centres,
    untagged: untagged.sessionCount > 0 ? finishTotals(untagged) : null,
    conflicts: conflicts.map((conflict) => ({ ...conflict, counted: false })),
  };
}

function emptyTotals() {
  return { sessionCount: 0, totalTokens: 0, calls: 0, unpricedCalls: 0, knownCostUsd: 0, hasUnknownCost: false, costUsd: 0 };
}

function addToTotals(target, row) {
  const metrics = row?.metrics ?? row ?? {};
  const input = Number(metrics.inputTokens) || 0;
  const output = Number(metrics.outputTokens) || 0;
  const calls = Number(metrics.calls) || 0;
  const unpriced = Number(metrics.unpricedCalls) || 0;
  const cost = metrics.cost ?? metrics.totalCost;

  target.sessionCount += 1;
  target.totalTokens += Number(metrics.totalTokens) || input + output;
  target.calls += calls;
  target.unpricedCalls += unpriced;
  if (cost == null || !Number.isFinite(Number(cost)) || unpriced > 0) {
    target.hasUnknownCost = true;
  } else {
    target.knownCostUsd += Number(cost);
  }
}

function finishTotals(target) {
  return {
    ...target,
    // Null whenever anything in the group was unpriced, so a partial sum is never
    // presented as a real total.
    costUsd: target.hasUnknownCost ? null : target.knownCostUsd,
  };
}

export function renderCostCentresText(result) {
  if (!result.centres.length && !result.untagged) {
    return 'No sessions could be attributed: this report carries no per-session data.';
  }
  const out = ['Spend by cost centre', ''];
  out.push(`  ${'cost centre'.padEnd(24)}${'$'.padStart(3)}${'cost'.padStart(14)}${'tokens'.padStart(11)}${'sessions'.padStart(10)}  coverage`);
  const rows = [...result.centres];
  for (const centre of rows) {
    const done = finishTotals(centre);
    out.push(`  ${String(centre.name).slice(0, 24).padEnd(24)}   ${(done.costUsd == null ? 'unavailable' : `$${done.costUsd.toFixed(6)}`).padStart(13)}${((done.totalTokens / 1e6).toFixed(2) + ' M').padStart(11)}${String(done.sessionCount).padStart(10)}  ${done.costUsd == null ? 'partial' : 'complete'}`);
  }
  if (result.untagged) {
    const done = finishTotals(result.untagged);
    out.push(`  ${'(untagged)'.padEnd(24)}   ${(done.costUsd == null ? 'unavailable' : `$${done.costUsd.toFixed(6)}`).padStart(13)}${((done.totalTokens / 1e6).toFixed(2) + ' M').padStart(11)}${String(done.sessionCount).padStart(10)}  ${done.costUsd == null ? 'partial' : 'complete'}`);
  }
  if (result.conflicts.length) {
    out.push('');
    for (const conflict of result.conflicts) {
      out.push(`  ${conflict.sessionId} is listed under both "${conflict.centres[0]}" and "${conflict.centres[1]}".`);
    }
    out.push('  Conflicting sessions are counted once, under the first centre listed, and are not double-counted.');
  }
  return out.join('\n');
}
