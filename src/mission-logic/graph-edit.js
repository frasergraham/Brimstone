// ═══════════════════════════════════════════════════════════════════════════
// Mission Logic Graph — editor model operations (pure, DOM-free)
// ─────────────────────────────────────────────────────────────────────────────
// The node-graph editor's data layer: add/remove nodes + edges, auto-layout, and
// the palette. Kept separate from the DOM/SVG editor (src/tools/logic-graph-
// editor.js) so the model is unit-testable. Every operation keeps the graph in a
// shape that validateGraph() accepts (graph.js).
// ═══════════════════════════════════════════════════════════════════════════

import { allNodeTypes, getNodeType, pinsOf, NodeKind } from './node-types.js';
import { GraphValidationError, EdgeKind, emptyGraph } from './graph.js';

/** Friendly display label for a node type: 'onAreaEnter' → 'On Area Enter'. */
export function nodeLabel(type) {
  return String(type)
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

const KIND_LABELS = Object.freeze({
  [NodeKind.EVENT]: 'Events',
  [NodeKind.ACTOR]: 'Actors',
  [NodeKind.FLOW]: 'Flow',
  [NodeKind.PURE]: 'Logic / Data',
  [NodeKind.SIM]: 'Actions',
  [NodeKind.SHOW]: 'Presentation',
  [NodeKind.OUT]: 'Outcomes',
  [NodeKind.COMMENT]: 'Annotation',
});
const KIND_ORDER = [NodeKind.EVENT, NodeKind.ACTOR, NodeKind.FLOW, NodeKind.PURE,
  NodeKind.SIM, NodeKind.SHOW, NodeKind.OUT, NodeKind.COMMENT];

/** Palette grouped by kind, in display order: [{ kind, label, types:[{type,label}] }]. */
export function paletteGroups() {
  const byKind = new Map();
  for (const def of allNodeTypes()) {
    if (!byKind.has(def.kind)) byKind.set(def.kind, []);
    byKind.get(def.kind).push({ type: def.type, label: nodeLabel(def.type) });
  }
  return KIND_ORDER
    .filter((k) => byKind.has(k))
    .map((k) => ({ kind: k, label: KIND_LABELS[k] ?? k, types: byKind.get(k) }));
}

/** Next free node id ('n<max+1>'). */
export function nextNodeId(graph) {
  let max = -1;
  for (const n of graph.nodes ?? []) {
    const m = /^n(\d+)$/.exec(n.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `n${max + 1}`;
}

/** Add a node of `type` at (x,y). Returns the new node. */
export function addNode(graph, type, x = 40, y = 40) {
  if (!getNodeType(type)) throw new GraphValidationError(`unknown node type "${type}"`);
  const node = { id: nextNodeId(graph), type, params: {}, x, y };
  graph.nodes.push(node);
  return node;
}

/** Remove a node and every edge incident to it. Returns the graph. */
export function removeNode(graph, nodeId) {
  graph.nodes = graph.nodes.filter((n) => n.id !== nodeId);
  graph.edges = graph.edges.filter((e) => e.from.node !== nodeId && e.to.node !== nodeId);
  return graph;
}

const kindOf = (graph, nodeId) => {
  const n = graph.nodes.find((x) => x.id === nodeId);
  return n ? getNodeType(n.type)?.kind : null;
};

/**
 * Connect two pins. Validates pin existence + direction; for data edges enforces
 * the single-driver rule by REPLACING any existing edge into the sink (so the UI
 * "rewires" naturally). Returns the new edge. Throws GraphValidationError if the
 * endpoints are incompatible.
 */
export function connect(graph, from, to, kind) {
  const fromNode = graph.nodes.find((n) => n.id === from.node);
  const toNode = graph.nodes.find((n) => n.id === to.node);
  if (!fromNode || !toNode) throw new GraphValidationError('connect: unknown endpoint node');
  if (from.node === to.node) throw new GraphValidationError('connect: cannot wire a node to itself');

  const fp = pinsOf(fromNode);
  const tp = pinsOf(toNode);
  if (kind === EdgeKind.EXEC) {
    if (!fp.execOut.includes(from.pin)) throw new GraphValidationError(`no exec-out pin "${from.pin}"`);
    if (!tp.execIn) throw new GraphValidationError(`"${to.node}" has no exec-in`);
  } else if (kind === EdgeKind.DATA) {
    if (!fp.dataOut.some((d) => d.name === from.pin)) throw new GraphValidationError(`no data-out pin "${from.pin}"`);
    if (!tp.dataIn.some((d) => d.name === to.pin)) throw new GraphValidationError(`no data-in pin "${to.pin}"`);
    // Single driver: drop any existing edge into this data sink.
    graph.edges = graph.edges.filter(
      (e) => !(e.kind === EdgeKind.DATA && e.to.node === to.node && e.to.pin === to.pin));
  } else {
    throw new GraphValidationError(`connect: invalid kind "${kind}"`);
  }

  const edge = { from: { ...from }, to: { ...to }, kind };
  // De-dupe identical exec edges.
  const dup = graph.edges.some((e) =>
    e.kind === kind && e.from.node === from.node && e.from.pin === from.pin
    && e.to.node === to.node && e.to.pin === to.pin);
  if (!dup) graph.edges.push(edge);
  return edge;
}

/** Remove every edge matching the predicate. Returns the count removed. */
export function removeEdges(graph, predicate) {
  const before = graph.edges.length;
  graph.edges = graph.edges.filter((e) => !predicate(e));
  return before - graph.edges.length;
}

/**
 * Simple layered auto-layout: event/actor nodes form column 0; each node's column
 * is 1 + the max column of its exec predecessors (BFS), rows stack within a
 * column. Mutates node x/y. Deterministic.
 */
export function autoLayout(graph, { colGap = 240, rowGap = 110, x0 = 40, y0 = 40 } = {}) {
  const col = new Map();
  const isEntry = (n) => { const k = getNodeType(n.type)?.kind; return k === NodeKind.EVENT || k === NodeKind.ACTOR; };
  for (const n of graph.nodes) col.set(n.id, isEntry(n) ? 0 : -1);

  // Relax columns over exec edges until stable (graph is small; bounded passes).
  for (let pass = 0; pass < graph.nodes.length + 1; pass++) {
    let changed = false;
    for (const e of graph.edges) {
      if (e.kind !== EdgeKind.EXEC) continue;
      const want = (col.get(e.from.node) ?? 0) + 1;
      if (want > (col.get(e.to.node) ?? -1)) { col.set(e.to.node, want); changed = true; }
    }
    if (!changed) break;
  }
  for (const n of graph.nodes) if ((col.get(n.id) ?? -1) < 0) col.set(n.id, 0);

  const rowByCol = new Map();
  // Stable order: by column then existing y then id.
  const ordered = [...graph.nodes].sort((a, b) =>
    (col.get(a.id) - col.get(b.id)) || ((a.y ?? 0) - (b.y ?? 0)) || a.id.localeCompare(b.id));
  for (const n of ordered) {
    const c = col.get(n.id);
    const r = rowByCol.get(c) ?? 0;
    rowByCol.set(c, r + 1);
    n.x = x0 + c * colGap;
    n.y = y0 + r * rowGap;
  }
  return graph;
}

export { emptyGraph };
