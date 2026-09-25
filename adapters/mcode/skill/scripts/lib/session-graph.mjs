export function createSessionGraph(rows, { idKey = 'session_id', parentKey = 'parent_session_id' } = {}) {
  const byId = new Map();
  for (const row of rows ?? []) {
    const id = String(row?.[idKey] ?? '');
    if (!id) throw new Error('session graph contains an empty session id');
    if (byId.has(id)) throw new Error(`session graph contains duplicate session id ${id}`);
    byId.set(id, { id, parentId: row[parentKey] == null ? null : String(row[parentKey]) });
  }

  const children = new Map([...byId.keys()].map((id) => [id, []]));
  for (const node of byId.values()) {
    if (node.parentId === null) continue;
    if (!byId.has(node.parentId)) {
      node.parentId = null;
      continue;
    }
    children.get(node.parentId).push(node.id);
  }

  const state = new Map();
  const ancestors = (id) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') throw new Error(`session graph contains a cycle at ${id}`);
    state.set(id, 'visiting');
    for (const child of children.get(id) ?? []) ancestors(child);
    state.set(id, 'done');
  };
  for (const id of byId.keys()) ancestors(id);

  const descendants = (rootId, includeSelf = true) => {
    const root = String(rootId);
    if (!byId.has(root)) return new Set();
    const result = new Set();
    const visit = (id) => {
      if (result.has(id)) return;
      result.add(id);
      for (const child of children.get(id) ?? []) visit(child);
    };
    visit(root);
    if (!includeSelf) result.delete(root);
    return result;
  };

  const isDescendant = (sessionId, ancestorId) => (
    sessionId !== ancestorId && descendants(ancestorId).has(sessionId)
  );

  return { byId, children, descendants, isDescendant };
}

export function selectTopLevelCandidates(candidateIds, graph) {
  const candidates = [...new Set((candidateIds ?? []).map(String))].filter((id) => graph.byId.has(id));
  const includedRootIds = candidates.filter((candidate) => (
    !candidates.some((other) => other !== candidate && graph.isDescendant(candidate, other))
  ));
  const included = new Set(includedRootIds);
  return {
    includedRootIds,
    duplicateSuppressedSessionIds: candidates.filter((id) => !included.has(id)),
  };
}

export function collectSessionIds(rootIds, graph, { includeChildren = true } = {}) {
  const included = new Set();
  for (const rootId of rootIds ?? []) {
    const ids = graph.descendants(rootId, true);
    for (const id of ids) {
      if (includeChildren || id === String(rootId)) included.add(id);
    }
  }
  return included;
}
