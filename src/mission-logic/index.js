// ═══════════════════════════════════════════════════════════════════════════
// Mission Logic Graph — public API (docs/09-mission-logic-graph.md)
// ─────────────────────────────────────────────────────────────────────────────
// The Blueprint-style event→action system. One mission owns one graph; the engine
// evaluates it on the authority and emits presentation events the render/UI layer
// interprets. Shared, DOM-free; not yet wired into the live game loop.
// ═══════════════════════════════════════════════════════════════════════════

export { MissionLogicEngine } from './engine.js';
export {
  validateGraph, indexEdges, indexNodes, eventNodes, emptyGraph,
  endpointKey, EdgeKind, GraphValidationError,
} from './graph.js';
export {
  NodeKind, registerNodeType, getNodeType, allNodeTypes, pinsOf,
} from './node-types.js';
export { makeTestContext } from './world-context.js';
export { missionToGraph } from './migrate.js';
