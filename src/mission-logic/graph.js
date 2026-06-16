// ═══════════════════════════════════════════════════════════════════════════
// Mission Logic Graph — data model + structural validation
// ─────────────────────────────────────────────────────────────────────────────
// A mission owns ONE logic graph: a set of typed nodes wired by exec ("when this
// fires, run that next") and data ("pass this value") edges — the Blueprint-style
// event→action system described in docs/09-mission-logic-graph.md.
//
// This module is the pure shape + validation. It has NO runtime behaviour and NO
// DOM/Canvas dependency: the engine (engine.js) interprets a validated graph, and
// the editor authors one. Node behaviour lives in node-types.js.
//
// Graph shape (also the on-disk `logic` block in a mission JSON):
//   {
//     version: 1,
//     variables: [ { id, name, type, scope:'mission'|'campaign', initial } ],
//     nodes:     [ { id, type, params:{…}, x, y } ],
//     edges:     [ { from:{node,pin}, to:{node,pin}, kind:'exec'|'data' } ],
//   }
// `x`/`y` are editor layout only; the runtime ignores them.
// ═══════════════════════════════════════════════════════════════════════════

import { getNodeType, NodeKind, pinsOf } from './node-types.js';

export const EdgeKind = Object.freeze({ EXEC: 'exec', DATA: 'data' });

/** Structural validation failure, with a message the editor can surface. */
export class GraphValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GraphValidationError';
  }
}

const _fail = (msg) => { throw new GraphValidationError(msg); };

/** Build a `${nodeId}|${pin}` key for edge-endpoint indexing. */
export const endpointKey = (nodeId, pin) => `${nodeId}|${pin}`;

/**
 * Index a graph's edges for O(1) traversal, preserving authored order (which is
 * the deterministic exec fan-out order — see docs/09 §3.2).
 * @returns {{ execOut: Map<string, object[]>, dataIn: Map<string, object> }}
 *   execOut: source endpoint → exec edges out of it (ordered);
 *   dataIn:  sink endpoint   → the single data edge feeding it.
 */
export function indexEdges(graph) {
  const execOut = new Map();
  const dataIn = new Map();
  for (const e of graph.edges ?? []) {
    if (e.kind === EdgeKind.EXEC) {
      const k = endpointKey(e.from.node, e.from.pin);
      if (!execOut.has(k)) execOut.set(k, []);
      execOut.get(k).push(e);
    } else if (e.kind === EdgeKind.DATA) {
      // First data edge wins; validation rejects multiple drivers of one input.
      const k = endpointKey(e.to.node, e.to.pin);
      if (!dataIn.has(k)) dataIn.set(k, e);
    }
  }
  return { execOut, dataIn };
}

/** Map node id → node object. */
export function indexNodes(graph) {
  const byId = new Map();
  for (const n of graph.nodes ?? []) byId.set(n.id, n);
  return byId;
}

const _isEndpoint = (ep) => ep && typeof ep === 'object'
  && typeof ep.node === 'string' && typeof ep.pin === 'string';

/**
 * Validate a logic graph's structure. Throws {@link GraphValidationError} on the
 * first problem; returns the (unmodified) graph on success. Checks:
 *   • version is 1
 *   • node ids unique, types known
 *   • edges reference existing nodes + declared pins
 *   • exec edges go exec-out → exec-in; data edges go data-out → data-in
 *   • no two data edges drive the same input pin
 */
export function validateGraph(graph) {
  if (!graph || typeof graph !== 'object') _fail('expected a logic graph object');
  if (graph.version !== 1) _fail(`unsupported logic graph version "${graph.version}" (expected 1)`);
  if (!Array.isArray(graph.nodes)) _fail('logic graph requires a nodes[] array');
  if (!Array.isArray(graph.edges)) _fail('logic graph requires an edges[] array');

  const ids = new Set();
  const pins = new Map(); // nodeId → { execIn, execOut:Set, dataIn:Set, dataOut:Set }
  for (const n of graph.nodes) {
    if (typeof n.id !== 'string' || !n.id.trim()) _fail('every node needs a non-empty string id');
    if (ids.has(n.id)) _fail(`duplicate node id "${n.id}"`);
    ids.add(n.id);
    const def = getNodeType(n.type);
    if (!def) _fail(`node "${n.id}" has unknown type "${n.type}"`);
    const p = pinsOf(n);
    pins.set(n.id, {
      execIn: p.execIn,
      execOut: new Set(p.execOut),
      dataIn: new Set(p.dataIn.map((d) => d.name)),
      dataOut: new Set(p.dataOut.map((d) => d.name)),
    });
  }

  const seenDataSink = new Set();
  for (const e of graph.edges) {
    if (!_isEndpoint(e.from) || !_isEndpoint(e.to)) _fail('edge needs {from:{node,pin}, to:{node,pin}}');
    if (e.kind !== EdgeKind.EXEC && e.kind !== EdgeKind.DATA) {
      _fail(`edge ${e.from.node}→${e.to.node} has invalid kind "${e.kind}"`);
    }
    const fromP = pins.get(e.from.node);
    const toP = pins.get(e.to.node);
    if (!fromP) _fail(`edge references unknown source node "${e.from.node}"`);
    if (!toP) _fail(`edge references unknown target node "${e.to.node}"`);

    if (e.kind === EdgeKind.EXEC) {
      if (!fromP.execOut.has(e.from.pin)) {
        _fail(`node "${e.from.node}" has no exec-out pin "${e.from.pin}"`);
      }
      if (!toP.execIn) _fail(`node "${e.to.node}" has no exec-in pin (cannot be an exec target)`);
    } else {
      if (!fromP.dataOut.has(e.from.pin)) {
        _fail(`node "${e.from.node}" has no data-out pin "${e.from.pin}"`);
      }
      if (!toP.dataIn.has(e.to.pin)) {
        _fail(`node "${e.to.node}" has no data-in pin "${e.to.pin}"`);
      }
      const sinkKey = endpointKey(e.to.node, e.to.pin);
      if (seenDataSink.has(sinkKey)) {
        _fail(`data input "${e.to.node}.${e.to.pin}" is driven by more than one edge`);
      }
      seenDataSink.add(sinkKey);
    }
  }
  return graph;
}

/** Convenience: all event-kind nodes (graph entry points), in authored order. */
export function eventNodes(graph) {
  return (graph.nodes ?? []).filter((n) => {
    const def = getNodeType(n.type);
    return def && (def.kind === NodeKind.EVENT || def.kind === NodeKind.ACTOR);
  });
}

/** An empty, valid graph (editor "new mission" starting point). */
export function emptyGraph() {
  return { version: 1, variables: [], nodes: [], edges: [] };
}
