// ═══════════════════════════════════════════════════════════════════════════
// Mission Logic Graph — node-type registry + implemented node catalog
// ─────────────────────────────────────────────────────────────────────────────
// Each node TYPE declares its kind, its pins, and a handler. The engine
// (engine.js) is generic — it knows nothing about specific node types; it only
// knows the contract below. Add a node type by registering one entry here.
//
// CONTRACT
//   kind:        one of NodeKind (EVENT/ACTOR/FLOW/PURE/SIM/SHOW/OUT).
//   exec:        { in: bool, out: [pinName, …] }  — static exec pins.
//   data:        { in: [{name,type}], out: [{name,type}] } — static data pins.
//   pins(node):  (optional) compute pins dynamically from node.params (Sequence).
//   eventMatch:  (EVENT/ACTOR only) { [eventType]: (node, payload) => outPin|null }
//                — the engine dispatches an event type + payload; the matcher
//                  decides whether THIS node fires and from which exec-out pin.
//   compute(api):(PURE only) returns a data-outputs object — pulled on demand.
//   run(api):    (FLOW/SIM/SHOW/OUT) performs side-effects, returns
//                  { fire?: [execOutPin…], data?: {outPin: value}, loop?: {…} }.
//
// `api` (built by the engine):
//   api.node                      the node instance
//   api.ctx                       the WorldContext (world reads + sim mutations +
//                                 emit + seeded random) — see world-context.js
//   api.engineState               persistent { firedOnce:Set, counters, variables }
//   api.param(name, fallback?)    node.params[name]
//   api.input(pinName)            resolved DATA input (wired); undefined if unwired
//   api.payload                   (EVENT nodes) the dispatched event payload
//
// INVARIANT (docs/09 §1): SIM/PURE handlers may READ only (state, plans, seed)
// via api.ctx and produce (state mutations, presentation events via ctx.emit).
// They must never read wall-clock, animation progress, or client-local state.
// ═══════════════════════════════════════════════════════════════════════════

import { resolveCondition } from '../campaign/condition-registry.js';

// (comment node registered at the bottom — annotation only, no behaviour)

export const NodeKind = Object.freeze({
  EVENT: 'event',
  ACTOR: 'actor',
  FLOW: 'flow',
  PURE: 'pure',
  SIM: 'sim',
  SHOW: 'show',
  OUT: 'out',
  COMMENT: 'comment', // pure annotation — no pins, ignored by the engine
});

const NODE_TYPES = new Map();

/** Register a node type. Throws on duplicate ids (catches copy-paste bugs). */
export function registerNodeType(def) {
  if (!def || typeof def.type !== 'string') throw new Error('node type needs a string "type"');
  if (NODE_TYPES.has(def.type)) throw new Error(`node type "${def.type}" already registered`);
  NODE_TYPES.set(def.type, def);
  return def;
}

export function getNodeType(type) {
  return NODE_TYPES.get(type) ?? null;
}

export function allNodeTypes() {
  return [...NODE_TYPES.values()];
}

/**
 * Resolve a node instance's pins (static, or dynamic via def.pins(node)).
 * @returns {{ execIn: boolean, execOut: string[], dataIn: {name,type}[], dataOut: {name,type}[] }}
 */
export function pinsOf(node) {
  const def = getNodeType(node.type);
  if (!def) return { execIn: false, execOut: [], dataIn: [], dataOut: [] };
  if (typeof def.pins === 'function') return def.pins(node);
  return {
    execIn: !!def.exec?.in,
    execOut: def.exec?.out ?? [],
    dataIn: def.data?.in ?? [],
    dataOut: def.data?.out ?? [],
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

const factionOf = (e) => (e == null ? undefined : (e.faction ?? e.owner));
const sameHex = (a, b) => a && b && a.col === b.col && a.row === b.row;
const hexInList = (hex, list) => Array.isArray(list) && list.some((h) => sameHex(h, hex));

/**
 * The hex region a Location node represents. Canonical shape is `params.hexes`
 * (a list of {col,row}); legacy nodes carry a single `params.col/row`, kept as a
 * fallback so old missions/saves still resolve. Returns a clean {col,row}[] copy.
 */
export function locationHexes(node) {
  const p = node?.params ?? {};
  const list = Array.isArray(p.hexes) ? p.hexes : null;
  if (list && list.length) {
    return list
      .filter((h) => h && Number.isFinite(h.col) && Number.isFinite(h.row))
      .map((h) => ({ col: h.col, row: h.row }));
  }
  if (Number.isFinite(p.col) && Number.isFinite(p.row)) return [{ col: p.col, row: p.row }];
  return [];
}

/**
 * The effective trigger region for an Area node: a wired Location overrides the
 * node's own `params.hexes`. `engine` (passed by the engine to eventMatch) does
 * the static wire resolution; without it we fall back to the authored hexes.
 */
const areaRegion = (node, engine) =>
  (engine && typeof engine.resolveAreaHexes === 'function')
    ? engine.resolveAreaHexes(node)
    : (node?.params?.hexes ?? []);

// The effective `ref` an Actor node binds to (a wired source node overrides the
// authored param). `engine` does the static wire resolution; falls back otherwise.
const actorRef = (node, engine) =>
  (engine && typeof engine.resolveActorRef === 'function')
    ? engine.resolveActorRef(node)
    : node?.params?.ref;

// ════════════════════════════ EVENT nodes ═══════════════════════════════════

registerNodeType({
  type: 'onMissionStart',
  kind: NodeKind.EVENT,
  exec: { in: false, out: ['out'] },
  eventMatch: { missionStart: () => 'out' },
});

registerNodeType({
  type: 'onRoundStart',
  kind: NodeKind.EVENT,
  exec: { in: false, out: ['out'] },
  data: { out: [{ name: 'round', type: 'int' }, { name: 'phase', type: 'string' }] },
  // params.round: a specific round number, or null/'any' for every round.
  eventMatch: {
    roundStart: (node, p) => {
      const want = node.params?.round;
      return (want == null || want === 'any' || want === p.round) ? 'out' : null;
    },
  },
});

registerNodeType({
  type: 'onPhase',
  kind: NodeKind.EVENT,
  exec: { in: false, out: ['out'] },
  data: { out: [{ name: 'phase', type: 'string' }] },
  // params.phase: 'dawn' | 'day' | 'dusk' | 'night'
  eventMatch: {
    phase: (node, p) => (node.params?.phase == null || node.params.phase === p.phase) ? 'out' : null,
  },
});

registerNodeType({
  type: 'onKillCount',
  kind: NodeKind.EVENT,
  exec: { in: false, out: ['out'] },
  data: { out: [{ name: 'killer', type: 'entity' }] },
  // params: { faction:'hero'|'witch', count:int } — fires once count is reached
  // (per-fire; use a Do Once downstream to dedup, matching wave semantics).
  eventMatch: {
    killCount: (node, p) => {
      const f = node.params?.faction;
      const need = node.params?.count ?? 1;
      return (p.faction === f && p.count >= need) ? 'out' : null;
    },
  },
});

// Area trigger — an ACTOR node bound (by params.hexes) to a hex region selected
// in the world editor. Fires onEnter/onExit for the unit crossing the boundary.
registerNodeType({
  type: 'onAreaEnter',
  kind: NodeKind.ACTOR,
  exec: { in: false, out: ['onEnter', 'onExit'] },
  // `area` (in): wire a Location node to define the region instead of authoring
  // `params.hexes` here. When wired, the param field greys out (connectedInputs).
  data: {
    in: [{ name: 'area', type: 'list' }],
    out: [{ name: 'unit', type: 'entity' }, { name: 'hex', type: 'hex' }],
  },
  eventMatch: {
    areaEnter: (node, p, engine) => hexInList(p.hex, areaRegion(node, engine)) ? 'onEnter' : null,
    areaExit: (node, p, engine) => hexInList(p.hex, areaRegion(node, engine)) ? 'onExit' : null,
  },
});

// Faction node — whole-side lifecycle events (replaces eliminate_all/hero_killed).
registerNodeType({
  type: 'factionEvent',
  kind: NodeKind.ACTOR,
  exec: { in: false, out: ['onAllUnitsDead', 'onLeaderDead', 'onUnitCountBelow'] },
  // params: { faction:'hero'|'witch', threshold?:int }
  eventMatch: {
    factionAllDead: (node, p) => (p.faction === node.params?.faction) ? 'onAllUnitsDead' : null,
    factionLeaderDead: (node, p) => (p.faction === node.params?.faction) ? 'onLeaderDead' : null,
    factionUnitCount: (node, p) =>
      (p.faction === node.params?.faction && p.count < (node.params?.threshold ?? 1))
        ? 'onUnitCountBelow' : null,
  },
});

// Actor — a specific placed unit, bound by `ref` (created from the world editor's
// "Add unit to graph"). Fires lifecycle events; outputs the live entity as data.
// The unit's `ref` is matched against entity.ref (enemyUnits) or entity.npcId (npcs).
registerNodeType({
  type: 'onActor',
  kind: NodeKind.ACTOR,
  exec: { in: false, out: ['onSpawn', 'onDeath'] },
  // `ref` (in): wire a Survivor / unit source node here to bind by its id instead
  // of typing `params.ref` (the field greys out when wired).
  data: {
    in: [{ name: 'ref', type: 'string' }],
    out: [{ name: 'entity', type: 'entity' }, { name: 'hex', type: 'hex' }],
  },
  eventMatch: {
    actorSpawn: (node, p, engine) => (p.ref === actorRef(node, engine)) ? 'onSpawn' : null,
    actorDeath: (node, p, engine) => (p.ref === actorRef(node, engine)) ? 'onDeath' : null,
  },
});

// Conversation End — fires when a named conversation finishes (dismissed). Lets
// post-conversation choreography (NPC walk-off / despawn) live in the graph
// instead of conversations[].onComplete.
registerNodeType({
  type: 'onConversationEnd',
  kind: NodeKind.EVENT,
  exec: { in: false, out: ['done'] },
  // params: { conversationId }
  eventMatch: {
    conversationEnd: (node, p) => (node.params?.conversationId == null || node.params.conversationId === p.id) ? 'done' : null,
  },
});

// ════════════════════════════ FLOW nodes ════════════════════════════════════

registerNodeType({
  type: 'sequence',
  kind: NodeKind.FLOW,
  // Dynamic exec-out pins then0..then(N-1) where N = params.outputs (default 2).
  pins: (node) => {
    const n = Math.max(1, node.params?.outputs ?? 2);
    return {
      execIn: true,
      execOut: Array.from({ length: n }, (_, i) => `then${i}`),
      dataIn: [], dataOut: [],
    };
  },
  run: (api) => {
    const n = Math.max(1, api.param('outputs', 2));
    return { fire: Array.from({ length: n }, (_, i) => `then${i}`) };
  },
});

registerNodeType({
  type: 'branch',
  kind: NodeKind.FLOW,
  exec: { in: true, out: ['true', 'false'] },
  data: { in: [{ name: 'cond', type: 'bool' }] },
  run: (api) => ({ fire: [api.input('cond') ? 'true' : 'false'] }),
});

// Filter — exec-gated predicate on a wired entity (the sketch's "Is Hero").
registerNodeType({
  type: 'filterIsFaction',
  kind: NodeKind.FLOW,
  exec: { in: true, out: ['pass'] },
  data: { in: [{ name: 'entity', type: 'entity' }] },
  // params.faction: 'hero' | 'witch'
  run: (api) => {
    const ent = api.input('entity');
    return { fire: factionOf(ent) === api.param('faction') ? ['pass'] : [] };
  },
});

// Do Once — fires the first time only (replaces the implicit _fired*/flag dedup).
registerNodeType({
  type: 'doOnce',
  kind: NodeKind.FLOW,
  exec: { in: true, out: ['out'] },
  run: (api) => {
    const id = api.node.id;
    if (api.engineState.firedOnce.has(id)) return { fire: [] };
    api.engineState.firedOnce.add(id);
    return { fire: ['out'] };
  },
});

// Counter — increments per pulse, fires 'reached' once threshold is hit.
registerNodeType({
  type: 'counter',
  kind: NodeKind.FLOW,
  exec: { in: true, out: ['reached'] },
  data: { out: [{ name: 'count', type: 'int' }] },
  run: (api) => {
    const id = api.node.id;
    const next = (api.engineState.counters[id] ?? 0) + 1;
    api.engineState.counters[id] = next;
    return { data: { count: next }, fire: next >= api.param('threshold', 1) ? ['reached'] : [] };
  },
});

// For Each — iterate a wired list, firing 'body' per item then 'done'.
registerNodeType({
  type: 'forEach',
  kind: NodeKind.FLOW,
  exec: { in: true, out: ['body', 'done'] },
  data: { in: [{ name: 'items', type: 'list' }], out: [{ name: 'item', type: 'any' }] },
  run: (api) => ({
    loop: { items: api.input('items') ?? [], itemPin: 'item', bodyPin: 'body', donePin: 'done' },
  }),
});

// ════════════════════════════ PURE nodes ════════════════════════════════════

registerNodeType({
  type: 'compare',
  kind: NodeKind.PURE,
  data: { in: [{ name: 'a', type: 'number' }, { name: 'b', type: 'number' }], out: [{ name: 'result', type: 'bool' }] },
  // params.op: '>=' | '<=' | '==' | '>' | '<' | '!='
  compute: (api) => {
    const a = api.input('a'); const b = api.input('b');
    const op = api.param('op', '==');
    const r = op === '>=' ? a >= b : op === '<=' ? a <= b : op === '>' ? a > b
      : op === '<' ? a < b : op === '!=' ? a !== b : a === b;
    return { result: r };
  },
});

registerNodeType({
  type: 'logicGate',
  kind: NodeKind.PURE,
  data: { in: [{ name: 'a', type: 'bool' }, { name: 'b', type: 'bool' }], out: [{ name: 'result', type: 'bool' }] },
  // params.op: 'and' | 'or' | 'not' (not uses 'a' only)
  compute: (api) => {
    const a = !!api.input('a'); const b = !!api.input('b');
    const op = api.param('op', 'and');
    return { result: op === 'or' ? (a || b) : op === 'not' ? !a : (a && b) };
  },
});

registerNodeType({
  type: 'getGameState',
  kind: NodeKind.PURE,
  data: { out: [{ name: 'value', type: 'any' }] },
  // params.field: 'round' | 'phase' | 'heroKills' | 'witchKills' | …
  compute: (api) => ({ value: api.ctx.getState()?.[api.param('field')] }),
});

registerNodeType({
  type: 'getEntityProperty',
  kind: NodeKind.PURE,
  data: { in: [{ name: 'entity', type: 'entity' }], out: [{ name: 'value', type: 'any' }] },
  // params.prop: 'hp' | 'faction' | 'type' | 'alive' | …
  compute: (api) => {
    const e = api.input('entity');
    const prop = api.param('prop');
    return { value: prop === 'faction' ? factionOf(e) : e?.[prop] };
  },
});

registerNodeType({
  type: 'conditionNamed',
  kind: NodeKind.PURE,
  data: { out: [{ name: 'result', type: 'bool' }] },
  // params.name: a key in condition-registry.js (reuses the existing predicates)
  compute: (api) => {
    const fn = resolveCondition(api.param('name'));
    return { result: fn ? !!fn(api.ctx.getState()) : false };
  },
});

// Completion Count — read how many campaign missions are completed, as data.
// PURE (no exec, no mutation): a deterministic read of the authority's campaign
// progress through ctx.getCompletedMissions(), pulled when a downstream consumer
// reads it. Use case: scale the final mission's enemy strength by how many
// optional sidequests the player finished — wire `count` into a Compare/Branch
// that gates a bigger Spawn Units wave (see docs/09 §3 Sim/Show split — this is on
// the logic side, like Get Game State / Condition).
registerNodeType({
  type: 'completionCount',
  kind: NodeKind.PURE,
  // `count`: how many of the listed missions are completed.
  // `total`: how many distinct missions were considered (the denominator for
  //          percent-style scaling downstream).
  data: { out: [{ name: 'count', type: 'int' }, { name: 'total', type: 'int' }] },
  // params.missions: string[] of campaign mission ids to count over. A non-empty
  // list counts how many of THOSE are completed (ids not in the campaign simply
  // aren't completed → they contribute 0). An empty/missing list counts ALL
  // completed missions (count === total in that mode).
  compute: (api) => {
    const completed = api.ctx.getCompletedMissions?.() ?? [];
    const completedSet = completed instanceof Set ? completed : new Set(completed);
    // Dedupe + drop blank entries so duplicates can't inflate count/total.
    const listed = new Set(
      (api.param('missions', []) ?? []).filter((id) => typeof id === 'string' && id !== ''));
    if (listed.size > 0) {
      let count = 0;
      for (const id of listed) if (completedSet.has(id)) count++;
      return { count, total: listed.size };
    }
    // No explicit list → count every completed mission.
    return { count: completedSet.size, total: completedSet.size };
  },
});

// ════════════════════════════ SIM nodes ═════════════════════════════════════

registerNodeType({
  type: 'spawnUnits',
  kind: NodeKind.SIM,
  exec: { in: true, out: ['done'] },
  // `at` (optional, wired) is a hex {col,row} — e.g. from a Location node — that
  // overrides each unit's spawnAt so a map location can drive the spawn position.
  data: { in: [{ name: 'at', type: 'hex' }], out: [{ name: 'spawned', type: 'list' }, { name: 'first', type: 'entity' }] },
  // params.units: [{ type, spawnAt, overrides?, level?, spawnLog? }]
  run: (api) => {
    const specs = api.param('units', []);
    const at = api.input('at'); // wired hex overrides spawnAt
    const spawned = [];
    for (const spec of specs) {
      const resolved = at ? { ...spec, spawnAt: { col: at.col, row: at.row } } : spec;
      const ent = api.ctx.spawnUnit(resolved);
      if (ent) spawned.push(ent);
      api.emit({ kind: 'spawn', spec: resolved, entity: ent, log: spec.spawnLog });
    }
    return { data: { spawned, first: spawned[0] }, fire: ['done'] };
  },
});

// Survivor — a placed hidden survivor as a pure data SOURCE (created when one is
// placed on the map). Its `id` binds an On Actor node (wire id → On Actor's ref)
// so finding THIS survivor fires the node; `hex` feeds location/spawn inputs.
registerNodeType({
  type: 'survivor',
  kind: NodeKind.PURE,
  // params: { ref, label?, col?, row? } — ref is the survivor's stable id (its
  // pinned roster name, or an auto-assigned per-hex id for a random survivor).
  data: { out: [{ name: 'id', type: 'string' }, { name: 'hex', type: 'hex' }] },
  compute: (api) => ({
    id: api.param('ref', ''),
    hex: { col: api.param('col', 0), row: api.param('row', 0) },
  }),
});

// Location — a map hex as a pure data source (created from the world editor's
// "Add location to graph"). Feed its `hex` output into Spawn Units' `at`, etc.
registerNodeType({
  type: 'location',
  kind: NodeKind.PURE,
  // `hex` = the first cell (feed into single-hex inputs like Spawn Units' `at`);
  // `hexes` = the whole region (feed into an Area node's `area`).
  data: { out: [{ name: 'hex', type: 'hex' }, { name: 'hexes', type: 'list' }] },
  // params: { label?, hexes?: [{col,row}], col?, row? (legacy single hex) }
  compute: (api) => {
    const list = locationHexes(api.node);
    return { hex: list[0] ?? { col: 0, row: 0 }, hexes: list };
  },
});

registerNodeType({
  type: 'despawnUnit',
  kind: NodeKind.SIM,
  exec: { in: true, out: ['done'] },
  data: { in: [{ name: 'target', type: 'entity' }] },
  // params.npc (an npc id) → routed through runScriptedActions for correct ordering
  // after a conversation walk-off; otherwise removes a wired/`id` entity immediately.
  run: (api) => {
    const npc = api.param('npc');
    if (npc) { api.emit({ kind: 'scriptedAction', action: { action: 'despawn', npc } }); return { fire: ['done'] }; }
    const target = api.input('target');
    const id = target?.id ?? api.param('id');
    if (id != null) { api.ctx.despawnUnit(id); api.emit({ kind: 'despawn', id }); }
    return { fire: ['done'] };
  },
});

// Move Unit — walk an NPC along a path. Routed through the same runScriptedActions
// choreography the conversation onComplete used, so it animates + orders correctly
// at conversation-end. Presentation-only (the move is cosmetic for NPCs).
registerNodeType({
  type: 'moveUnit',
  kind: NodeKind.SHOW,
  exec: { in: true, out: ['done'] },
  data: { in: [{ name: 'target', type: 'entity' }] },
  // params: { npc, path: [{col,row}, …] }
  run: (api) => {
    const npc = api.param('npc') ?? api.input('target')?.npcId ?? api.input('target')?.id;
    api.emit({ kind: 'scriptedAction', action: { action: 'move', npc, path: api.param('path', []) } });
    return { fire: ['done'] };
  },
});

registerNodeType({
  type: 'setFlag',
  kind: NodeKind.SIM,
  exec: { in: true, out: ['done'] },
  data: { in: [{ name: 'value', type: 'any' }] },
  // params: { key, value? } — wired 'value' overrides params.value
  run: (api) => {
    const key = api.param('key');
    const value = api.input('value') ?? api.param('value', true);
    api.engineState.variables[key] = value;
    api.ctx.setFlag?.(key, value);
    return { fire: ['done'] };
  },
});

// ════════════════════════════ SHOW nodes ════════════════════════════════════

// Latent: emits the conversation presentation event and continues down 'done'
// immediately in LOGIC terms (fire-and-animate). The client plays the dialogue
// then animates the downstream events — docs/09 §2.3.
registerNodeType({
  type: 'startConversation',
  kind: NodeKind.SHOW,
  // LATENT: the `done` pin fires when the player DISMISSES the conversation (the
  // host calls engine.resumeLatent), not when the node runs — so downstream
  // choreography (NPC walk-off, spawns) happens AFTER the dialogue, as expected.
  latent: true,
  exec: { in: true, out: ['done'] },
  // roles: data-in pins are dynamic by params.roleInputs (role names wired to
  // live entities, e.g. an NPC freshly returned from a Spawn node).
  pins: (node) => ({
    execIn: true,
    execOut: ['done'],
    dataIn: (node.params?.roleInputs ?? []).map((name) => ({ name, type: 'entity' })),
    dataOut: [],
  }),
  run: (api) => {
    const roleInputs = api.param('roleInputs', []);
    const wired = {};
    for (const name of roleInputs) wired[name] = api.input(name);
    api.emit({
      kind: 'conversation',
      id: api.param('conversationId'),
      nodeId: api.node.id, // host resumes this node's Done after the dialogue is dismissed
      roles: { ...(api.param('roles') ?? {}), ...wired },
    });
    return { fire: ['done'] };
  },
});

registerNodeType({
  type: 'storyBeat',
  kind: NodeKind.SHOW,
  exec: { in: true, out: ['done'] },
  // params: { title, text }
  run: (api) => {
    api.emit({ kind: 'storyBeat', title: api.param('title'), text: api.param('text') });
    return { fire: ['done'] };
  },
});

// ════════════════════════════ OUT nodes ═════════════════════════════════════

registerNodeType({
  type: 'winMission',
  kind: NodeKind.OUT,
  exec: { in: true, out: [] },
  run: (api) => {
    const winner = api.param('winner', 'hero');
    const reason = api.param('reason');
    api.ctx.setOutcome(winner, reason);
    api.emit({ kind: 'win', winner, reason });
    return { fire: [] };
  },
});

registerNodeType({
  type: 'loseMission',
  kind: NodeKind.OUT,
  exec: { in: true, out: [] },
  run: (api) => {
    const winner = api.param('winner', 'witch'); // the side that beats the player
    const reason = api.param('reason');
    api.ctx.setOutcome(winner, reason);
    api.emit({ kind: 'lose', winner, reason });
    return { fire: [] };
  },
});

// Objective poll — wraps an EXISTING objective spec ({type,…}) verbatim and
// delegates to the current victory logic via ctx.evaluateObjective. Lossless
// migration target for the 13 KNOWN_OBJECTIVE_TYPES (docs/09 §4).
registerNodeType({
  type: 'objectiveOutcome',
  kind: NodeKind.OUT,
  exec: { in: true, out: ['met', 'unmet'] },
  // params: { side:'win'|'lose', spec:{type,…}, winner?, reason? }
  run: (api) => {
    const spec = api.param('spec');
    const side = api.param('side', 'win');
    if (!api.ctx.evaluateObjective?.(spec, side)) return { fire: ['unmet'] };
    const winner = api.param('winner', side === 'win' ? 'hero' : 'witch');
    const reason = api.param('reason') ?? spec?.reason;
    api.ctx.setOutcome(winner, reason);
    api.emit({ kind: side, winner, reason });
    return { fire: ['met'] };
  },
});

// ════════════════════════════ COMMENT ═══════════════════════════════════════
// A free-text annotation box. No pins, no behaviour — the engine never runs it;
// it exists purely to document sections of the graph (params.text/w/h).
registerNodeType({ type: 'comment', kind: NodeKind.COMMENT });
