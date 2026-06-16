// ═══════════════════════════════════════════════════════════════════════════
// Mission Logic Graph — legacy → graph migration
// ─────────────────────────────────────────────────────────────────────────────
// `missionToGraph(mission)` converts a mission def's LEGACY scripted fields into
// a logic graph so no content is hand-rewritten when we adopt the node system:
//   • storyTriggers (round / area)            → event → [filter] → [doOnce] → show
//   • waves (round / hero_kills / area)        → event → [filter] → [doOnce] → spawn
//   • objectives.win / .lose                   → onRoundStart(any) → objectiveOutcome
//                                                (wraps the existing spec verbatim)
//
// We KEEP the old fields live (docs/09 §7); this converter exists so the editor
// can render/round-trip a graph and so we can diff graph-driven behaviour against
// the legacy runtime before flipping a mission over. The produced graph is
// validate-clean (validateGraph passes).
//
// NOTE: area storyTriggers/waves are HERO-position triggered today, so the
// migration inserts a `filterIsFaction: hero` to preserve that semantics.
// ═══════════════════════════════════════════════════════════════════════════

import { validateGraph } from './graph.js';

/** Convert a mission def (or parsed JSON) into a logic graph. */
export function missionToGraph(mission, { validate = true } = {}) {
  const b = new GraphBuilder();

  for (const tr of mission.storyTriggers ?? []) migrateStoryTrigger(b, tr);
  for (const w of mission.waves ?? []) migrateWave(b, w);
  migrateObjectives(b, mission.objectives);

  const graph = b.graph();
  if (validate) validateGraph(graph);
  return graph;
}

// ── per-feature migrations ───────────────────────────────────────────────────

function migrateStoryTrigger(b, tr) {
  const action = tr.conversation
    ? b.node('startConversation', { conversationId: tr.conversation })
    : b.node('storyBeat', { title: tr.title ?? null, text: tr.text ?? null });

  let src;
  if (tr.type === 'area') {
    const area = b.node('onAreaEnter', { hexes: tr.hexes ?? [] });
    const filter = b.node('filterIsFaction', { faction: 'hero' });
    b.exec(area, 'onEnter', filter);
    b.data(area, 'unit', filter, 'entity');
    src = { node: filter, pin: 'pass' };
  } else { // 'round'
    const ev = b.node('onRoundStart', { round: tr.round ?? null });
    src = { node: ev, pin: 'out' };
  }

  // A named condition (condition-registry) gates the trigger → Condition + Branch.
  // (tr.condition may be a string key on raw JSON, or a resolved fn at runtime.)
  const condName = typeof tr.condition === 'string' ? tr.condition : null;
  if (condName) {
    const cond = b.node('conditionNamed', { name: condName });
    const branch = b.node('branch', {});
    b.execPin(src.node, src.pin, branch);
    b.data(cond, 'result', branch, 'cond');
    src = { node: branch, pin: 'true' };
  }

  // A flag-gated trigger dedups for the whole campaign → Do Once.
  if (tr.flag) {
    const once = b.node('doOnce', {});
    b.execPin(src.node, src.pin, once);
    b.exec(once, 'out', action);
  } else {
    b.execPin(src.node, src.pin, action);
  }
}

function migrateWave(b, w) {
  const spawn = b.node('spawnUnits', { units: w.units ?? [] });
  const trigger = w.trigger ?? (w.round != null ? 'round' : null);

  if (trigger === 'hero_kills') {
    const ev = b.node('onKillCount', { faction: 'hero', count: w.count ?? 1 });
    const once = b.node('doOnce', {});
    b.exec(ev, 'out', once);
    b.exec(once, 'out', spawn);
  } else if (trigger === 'area') {
    const area = b.node('onAreaEnter', { hexes: w.hexes ?? [] });
    const filter = b.node('filterIsFaction', { faction: 'hero' });
    const once = b.node('doOnce', {});
    b.exec(area, 'onEnter', filter);
    b.data(area, 'unit', filter, 'entity');
    b.exec(filter, 'pass', once);
    b.exec(once, 'out', spawn);
  } else { // round
    const ev = b.node('onRoundStart', { round: w.round ?? null });
    b.exec(ev, 'out', spawn);
  }
}

function migrateObjectives(b, objectives) {
  if (!objectives) return;
  addObjective(b, objectives.win, 'win');
  const lose = Array.isArray(objectives.lose) ? objectives.lose : (objectives.lose ? [objectives.lose] : []);
  for (const l of lose) {
    if (l?.type === 'hero_killed') continue; // hero death = loss is inherent in checkVictory
    addObjective(b, l, 'lose');
  }
}

function addObjective(b, spec, side) {
  if (!spec || !spec.type) return;
  // Common WIN types become event-driven (fire at resolution time, no 1-round lag).
  if (side === 'win' && spec.type === 'eliminate_all') {
    const fe = b.node('factionEvent', { faction: spec.targetFaction || 'witch' });
    b.exec(fe, 'onAllUnitsDead', b.node('winMission', { winner: 'hero', reason: spec.reason ?? null }));
    return;
  }
  if (side === 'win' && spec.type === 'slay_witch') {
    const fe = b.node('factionEvent', { faction: 'witch' });
    b.exec(fe, 'onLeaderDead', b.node('winMission', { winner: 'hero', reason: spec.reason ?? null }));
    return;
  }
  // Everything else: poll each round, delegating to the existing victory logic
  // (phase/survive/score conditions; DEFERRED types like control_nodes are still
  // resolved by the built-in node scoring, so this node is just a no-op for them).
  const ev = b.node('onRoundStart', { round: 'any' });
  b.exec(ev, 'out', b.node('objectiveOutcome', { side, spec, reason: spec.reason ?? null }));
}

// ── tiny builder (stable ids + simple column layout) ──────────────────────────

class GraphBuilder {
  constructor() { this._nodes = []; this._edges = []; this._seq = 0; this._col = 0; }

  node(type, params) {
    const id = `n${this._seq++}`;
    // Lay each migrated chain out on its own row; columns advance per node added.
    this._nodes.push({ id, type, params, x: 40 + (this._col % 6) * 220, y: 40 + this._nodes.length * 90 });
    this._col++;
    return id;
  }

  exec(from, pin, to) { this._edges.push({ from: { node: from, pin }, to: { node: to, pin: 'in' }, kind: 'exec' }); }
  execPin(from, pin, to) { this.exec(from, pin, to); }
  data(from, pin, to, toPin) { this._edges.push({ from: { node: from, pin }, to: { node: to, pin: toPin }, kind: 'data' }); }

  graph() { return { version: 1, variables: [], nodes: this._nodes, edges: this._edges }; }
}
