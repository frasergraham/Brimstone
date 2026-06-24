// Pure helpers for presenting combat in the resolution animation.
//
// Phase 1 of the 3D combat-presentation overhaul: cluster a step's battles by
// map proximity so the cinematic camera can frame each cluster ONCE and HOLD
// across the chain of consecutive battles that share it (instead of re-framing
// — and jolting — on every individual battle).
//
// This module owns NO rendering and NO state: it only reads the ordered battle
// events of a single resolution step and returns a framing plan. The renderer
// hook (src/main.js) decides when to issue the camera move.

import { hexDistance } from './hex.js';

/**
 * Resolve the world anchor a melee lunge should aim at — the defender's live
 * standee slot, so the attacker meets the defender where it stands rather than
 * snapping to the hex centre. Render-only; never mutates state.
 *
 * Returns null (→ the lunge falls back to the hex centre `toCol/toRow`) when
 * there is no defender to aim at:
 *   • `targetSnap` is null/undefined — a WHIFF has no defender. The resolver
 *     emits an ACTION_SKIP with `battleSnaps: { actorSnap, ranged }` and a
 *     `whiffTarget` hex but NO `targetSnap` for the `targetFled` (live target
 *     moved out of reach) and empty-hex BATTLE_HEX cases (see
 *     server/resolver.js). A dead attacker never reaches here at all — the
 *     resolver skips a dead actor's queued action before any animation.
 *   • the renderer exposes no `entityWorldPos` (e.g. the 2D editor renderer), or
 *     the standee/entity for that id is gone.
 *
 * Reading `targetSnap.id` without this null guard threw
 * `Cannot read properties of null (reading 'id')` on every whiff replay once
 * the combat-defender-slot change started dereferencing it.
 *
 * @param {object|null} renderer - the active renderer (may lack entityWorldPos).
 * @param {object|null} targetSnap - the defender snapshot, or null for a whiff.
 * @returns {{x:number,z:number}|null}
 */
export function resolveLungeTargetWorld(renderer, targetSnap) {
  if (!targetSnap || targetSnap.id == null) return null;
  if (typeof renderer?.entityWorldPos !== 'function') return null;
  return renderer.entityWorldPos(targetSnap.id) ?? null;
}

// Battles whose participant hexes are within this many hexes of one another are
// considered part of the same on-screen skirmish and share a single camera
// frame. ~4 hexes keeps a tight melee + its gang-up allies in one shot while
// still splitting genuinely distant fights into separate sub-frames.
export const DEFAULT_CLUSTER_RADIUS = 4;

/**
 * Cluster a step's battle events by map proximity into camera frames.
 *
 * Each returned frame is the set of participant entity ids that should be
 * framed together. A single battle yields one frame containing both
 * combatants. Battles sharing a combatant — or whose nearest participant hexes
 * are within `clusterRadius` — merge into one union frame. Battles in distant
 * corners of the map yield separate sub-frames.
 *
 * The result is ordered by first appearance, and each frame records the
 * indices (into the input array) of the battles it covers, so the caller can
 * map a given battle back to its frame and only re-issue the camera move when
 * crossing into a NEW frame.
 *
 * @param {Array} battleEvents - ordered battle events; each is read for
 *   `battleSnaps.actorSnap` / `battleSnaps.targetSnap` ({ id, col, row }).
 * @param {object} [opts]
 * @param {number} [opts.clusterRadius=DEFAULT_CLUSTER_RADIUS] - merge distance in hexes.
 * @returns {Array<{ ids: Array, eventIndices: number[] }>}
 */
export function planCombatFrames(battleEvents, opts = {}) {
  const clusterRadius = Number.isFinite(opts.clusterRadius)
    ? opts.clusterRadius
    : DEFAULT_CLUSTER_RADIUS;

  // Normalize each battle to its participant ids + hexes, dropping any event
  // that lacks both combatant snapshots (nothing to frame).
  const battles = [];
  const list = Array.isArray(battleEvents) ? battleEvents : [];
  for (let i = 0; i < list.length; i++) {
    const snaps = list[i]?.battleSnaps;
    const a = snaps?.actorSnap;
    const t = snaps?.targetSnap;
    if (!a || !t) continue;
    const ids = [];
    if (a.id != null) ids.push(a.id);
    if (t.id != null) ids.push(t.id);
    battles.push({
      eventIndex: i,
      ids,
      hexes: [
        { col: a.col, row: a.row },
        { col: t.col, row: t.row },
      ],
    });
  }

  if (battles.length === 0) return [];

  // Disjoint-set union: merge any two battles whose participant hexes are
  // within clusterRadius of each other (covers shared-combatant battles too,
  // since a shared hex has distance 0).
  const parent = battles.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let a = 0; a < battles.length; a++) {
    for (let b = a + 1; b < battles.length; b++) {
      if (_battlesWithin(battles[a], battles[b], clusterRadius)) union(a, b);
    }
  }

  // Group by cluster root, preserving first-appearance order. Within each
  // frame, dedupe participant ids while keeping their first-seen order.
  const order = [];
  const groups = new Map();
  for (let i = 0; i < battles.length; i++) {
    const root = find(i);
    if (!groups.has(root)) {
      groups.set(root, []);
      order.push(root);
    }
    groups.get(root).push(battles[i]);
  }

  return order.map((root) => {
    const group = groups.get(root);
    const ids = [];
    const seen = new Set();
    const eventIndices = [];
    for (const b of group) {
      eventIndices.push(b.eventIndex);
      for (const id of b.ids) {
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }
    return { ids, eventIndices };
  });
}

/** True when any participant hex of b1 is within `radius` hexes of any of b2's. */
function _battlesWithin(b1, b2, radius) {
  for (const h1 of b1.hexes) {
    for (const h2 of b2.hexes) {
      if (hexDistance(h1.col, h1.row, h2.col, h2.row) <= radius) return true;
    }
  }
  return false;
}
