// ═══════════════════════════════════════════════════════════════════════════
// Mission Logic Graph — runtime engine
// ─────────────────────────────────────────────────────────────────────────────
// A deterministic interpreter for a validated logic graph (graph.js), driven by
// the game's MissionEvents and operating through a WorldContext adapter
// (world-context.js). This is the authority-side runtime from docs/09 §3:
//
//   engine.dispatch(eventType, payload)
//     → finds matching EVENT/ACTOR nodes, walks exec flow from their fired pins,
//       pulls data inputs on demand, runs SIM nodes (mutating state via ctx) and
//       SHOW nodes (emitting presentation events via ctx.emit), and routes FLOW.
//
// INVARIANTS (docs/09 §1):
//   • Deterministic: exec fan-out follows authored edge order; no Date/Math.random
//     (randomness comes from ctx.random(), the seeded game RNG).
//   • Sealed: the engine only READS (state, plans, seed) via ctx and produces
//     (state mutations, presentation events). It never reads client/timing state.
//   • Serializable: all mutable runtime state lives in `this.state` (firedOnce /
//     counters / variables) and round-trips via serialize()/load() — required for
//     online parity + save/resume.
//
// The engine is generic: it knows the node CONTRACT (node-types.js), not any
// specific node type. DOM-free; shared by main.js (offline) and the server.
// ═══════════════════════════════════════════════════════════════════════════

import { validateGraph, indexEdges, indexNodes, endpointKey } from './graph.js';
import { getNodeType, NodeKind, locationHexes } from './node-types.js';

const MAX_NODE_RUNS_PER_DISPATCH = 10000; // runaway-loop backstop

export class MissionLogicEngine {
  /**
   * @param {object} graph - a logic graph (validated unless opts.skipValidate).
   * @param {object} ctx   - a WorldContext (world-context.js).
   * @param {object} [opts]
   */
  constructor(graph, ctx, opts = {}) {
    if (!opts.skipValidate) validateGraph(graph);
    this.graph = graph;
    this.ctx = ctx;
    this._byId = indexNodes(graph);
    const idx = indexEdges(graph);
    this._execOut = idx.execOut;
    this._dataIn = idx.dataIn;

    // Persistent, serializable runtime state (docs/09 §3.1).
    //
    // `objectives` is the authoritative Mission Log: an ORDERED list of
    //   { id, label, current, target, completed }
    // mutated only by SIM nodes (setObjective / updateObjective / completeObjective)
    // deterministically from (state, plans, seed). It is presentation-free — the
    // toast + Chronicle "Mission Log" panel are SHOW (they READ this list, never
    // write it). It round-trips through serialize()/load() so the live to-do list
    // survives online resync + save/resume (Guideline 5/6).
    this.state = { firedOnce: new Set(), counters: {}, variables: {}, objectives: [] };

    // Per-dispatch scratch (reset each traversal).
    this._outputs = null; // Map<nodeId, outputsObject>
    this._runs = 0;

    // Parked continuations for LATENT nodes (e.g. Start Conversation): their exec
    // outputs don't fire when the node runs — they fire when resumeLatent(nodeId)
    // is called (the conversation was actually dismissed). Transient: a latent
    // node is always resolved within the same planning flow, so this never spans
    // a save (saves happen at round boundaries).
    this._pending = [];
  }

  // ── public API ─────────────────────────────────────────────────────────────

  /**
   * Dispatch a game event into the graph. Fires every matching EVENT/ACTOR node
   * (in authored order), each as an independent traversal with its own payload.
   * @param {string} eventType - e.g. 'roundStart', 'areaEnter', 'killCount'
   * @param {object} [payload] - event data, exposed as the event node's data-outs
   */
  dispatch(eventType, payload = {}) {
    for (const node of this.graph.nodes) {
      const def = getNodeType(node.type);
      if (!def || (def.kind !== NodeKind.EVENT && def.kind !== NodeKind.ACTOR)) continue;
      // `this` is passed so an event matcher can resolve wired data statically
      // (e.g. an Area node reading a Location wired into its `area` input).
      const pin = def.eventMatch?.[eventType]?.(node, payload, this);
      if (pin) this._runTraversal(node, pin, payload);
    }
  }

  /**
   * The union of all hex keys ("col,row") referenced by Area Trigger nodes —
   * lets the game compute enter/exit transitions without reaching into node
   * internals. Memoized (the graph is immutable at runtime).
   */
  areaHexKeys() {
    if (this._areaHexKeys) return this._areaHexKeys;
    const keys = new Set();
    for (const n of this.graph.nodes) {
      if (n.type !== 'onAreaEnter') continue;
      for (const h of this.resolveAreaHexes(n)) keys.add(`${h.col},${h.row}`);
    }
    this._areaHexKeys = keys;
    return keys;
  }

  /**
   * The effective trigger region for an Area node: a Location wired into its
   * `area` input replaces the node's own `params.hexes`. Location nodes are PURE
   * and param-driven, so this is a static graph resolution (safe to memoize) —
   * used by both areaHexKeys() and the node's eventMatch.
   */
  resolveAreaHexes(node) {
    const own = node?.params?.hexes ?? [];
    const edge = this._dataIn.get(endpointKey(node.id, 'area'));
    if (!edge) return own;
    const src = this._byId.get(edge.from.node);
    if (src?.type !== 'location') return own;
    const wired = locationHexes(src);
    return wired.length ? wired : own;
  }

  /**
   * The effective `ref` an Actor node binds to: a source node (e.g. a Survivor
   * node) wired into its `ref` input overrides the authored `params.ref`. Source
   * nodes are PURE + param-driven, so this is a static graph resolution — used by
   * both actorRefs() and the node's eventMatch.
   */
  resolveActorRef(node) {
    const own = node?.params?.ref;
    const edge = this._dataIn.get(endpointKey(node.id, 'ref'));
    if (!edge) return own;
    const src = this._byId.get(edge.from.node);
    const wired = src?.params?.ref ?? src?.params?.id;
    return (wired != null && wired !== '') ? wired : own;
  }

  /** The set of unit `ref`s referenced by Actor nodes — lets the game dispatch
   *  per-unit spawn/death events only for units the graph actually watches. */
  actorRefs() {
    if (this._actorRefs) return this._actorRefs;
    const refs = new Set();
    for (const n of this.graph.nodes) {
      if (n.type !== 'onActor') continue;
      const ref = this.resolveActorRef(n);
      if (ref != null && ref !== '') refs.add(ref);
    }
    this._actorRefs = refs;
    return refs;
  }

  /** Serialize runtime state for state-sync / saves. */
  serialize() {
    return {
      firedOnce: [...this.state.firedOnce],
      counters: { ...this.state.counters },
      variables: { ...this.state.variables },
      // Deep-copy each objective so the snapshot can't be mutated by later runs.
      objectives: (this.state.objectives ?? []).map((o) => ({ ...o })),
    };
  }

  /** Restore runtime state produced by serialize(). */
  load(snap) {
    if (!snap) return;
    this.state.firedOnce = new Set(snap.firedOnce ?? []);
    this.state.counters = { ...(snap.counters ?? {}) };
    this.state.variables = { ...(snap.variables ?? {}) };
    this.state.objectives = (snap.objectives ?? []).map((o) => ({ ...o }));
  }

  /** Read-only view of the Mission Log (authoritative objective list). The UI
   *  reads this to render the to-do panel; it never writes. Returns a shallow
   *  copy so callers can't mutate engine state. */
  objectives() {
    return (this.state.objectives ?? []).map((o) => ({ ...o }));
  }

  // ── traversal ──────────────────────────────────────────────────────────────

  _runTraversal(eventNode, pin, payload) {
    this._outputs = new Map();
    this._outputs.set(eventNode.id, payload); // event payload = its data outputs
    this._runs = 0;
    this._fireExec(eventNode, pin);
  }

  _fireExec(node, outPin) {
    const edges = this._execOut.get(endpointKey(node.id, outPin));
    if (!edges) return;
    for (const e of edges) {
      const target = this._byId.get(e.to.node);
      if (target) this._runNode(target);
    }
  }

  _runNode(node) {
    if (++this._runs > MAX_NODE_RUNS_PER_DISPATCH) {
      throw new Error(`mission-logic: exceeded ${MAX_NODE_RUNS_PER_DISPATCH} node runs — cycle?`);
    }
    const def = getNodeType(node.type);
    if (!def || def.kind === NodeKind.PURE || def.kind === NodeKind.EVENT
        || def.kind === NodeKind.ACTOR || def.kind === NodeKind.COMMENT) {
      return; // pure nodes are pulled; event/actor are entry-only; comments inert
    }
    const res = def.run(this._api(node)) ?? {};

    if (res.data) {
      const prev = this._outputs.get(node.id) ?? {};
      this._outputs.set(node.id, { ...prev, ...res.data });
    }

    if (res.loop) { this._runLoop(node, res.loop); return; }

    // Latent node (Start Conversation): park its Done branch — it fires only when
    // the host resumes it (resumeLatent) after the conversation is dismissed.
    if (def.latent) {
      this._pending.push({ nodeId: node.id, pins: res.fire ?? [], outputs: new Map(this._outputs) });
      return;
    }

    for (const p of res.fire ?? []) this._fireExec(node, p);
  }

  /**
   * Resume a parked latent node's exec outputs (its "Done" branch). Called by the
   * host once the latent action (e.g. a conversation) has actually completed.
   * @returns {boolean} whether a pending continuation was found and fired.
   */
  resumeLatent(nodeId) {
    const idx = this._pending.findIndex((p) => p.nodeId === nodeId);
    if (idx < 0) return false;
    const entry = this._pending.splice(idx, 1)[0];
    const node = this._byId.get(nodeId);
    if (!node) return false;
    this._outputs = entry.outputs ?? new Map(); // restore the parked data context
    this._runs = 0;
    for (const p of entry.pins) this._fireExec(node, p);
    return true;
  }

  _runLoop(node, loop) {
    const prev = this._outputs.get(node.id) ?? {};
    for (const item of loop.items) {
      this._outputs.set(node.id, { ...prev, [loop.itemPin]: item });
      this._fireExec(node, loop.bodyPin);
    }
    this._fireExec(node, loop.donePin);
  }

  // ── data resolution ──────────────────────────────────────────────────────────

  _api(node) {
    return {
      node,
      ctx: this.ctx,
      engineState: this.state,
      payload: this._outputs.get(node.id),
      param: (name, fallback) => {
        const v = node.params?.[name];
        return v === undefined ? fallback : v;
      },
      input: (pinName) => this._readInput(node, pinName),
      emit: (event) => this.ctx.emit?.(event),
    };
  }

  /** Resolve a wired DATA input to its value (undefined if unwired). */
  _readInput(node, pinName) {
    const edge = this._dataIn.get(endpointKey(node.id, pinName));
    if (!edge) return undefined;
    return this._readOutput(edge.from.node, edge.from.pin);
  }

  /**
   * Read a producer node's data output, computing PURE nodes lazily (memoized
   * per traversal). Action/event outputs are read from the cache populated when
   * they ran / fired — so a data producer must be upstream in exec order of its
   * consumer (the natural authoring order; Sequence makes it explicit).
   */
  _readOutput(nodeId, pin) {
    const cached = this._outputs.get(nodeId);
    if (cached && pin in cached) return cached[pin];

    const node = this._byId.get(nodeId);
    const def = node && getNodeType(node.type);
    if (def?.kind === NodeKind.PURE && typeof def.compute === 'function') {
      const out = def.compute(this._api(node)) ?? {};
      this._outputs.set(nodeId, out);
      return out[pin];
    }
    return cached ? cached[pin] : undefined;
  }
}
