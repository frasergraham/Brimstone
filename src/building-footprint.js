// Building-footprint eligibility helper (P2 of the building-footprint rework).
//
// A footprinted building is a compound object: a passable ENTRANCE tile (the
// one carrying `building`) plus one impassable FOOTPRINT hex adjacent to it.
// This module is the single source of truth for deciding WHICH adjacent hex a
// building may claim as its footprint. Both procedural map generation
// (`src/map.js`) and the legacy-save auto-migration (`server/state-sync.js`)
// call these helpers so the eligibility rules — including the road exclusion —
// stay identical across both paths.
import { getNeighbors, hexKey } from './hex.js';
import { PathType, TileType }   from './tiles.js';

// Resolve the tiles Map from a flexible `state` argument. Accepts a live
// GameState (has `.tiles`), a plain `{ tiles }` object, or a raw Map (used by
// map-gen / migration which operate on a bare tile map before a GameState
// exists).
function tilesOf(state) {
  if (state instanceof Map) return state;
  if (state && state.tiles instanceof Map) return state.tiles;
  return null;
}

// Resolve the set of power-node hex keys to exclude as footprint candidates.
// Prefer an explicit `opts.nodeKeySet`; otherwise derive from
// `state.witchObjectives` when present (each objective may carry a `hexes`
// cluster, falling back to its own col/row).
function nodeKeySetOf(state, opts) {
  if (opts && opts.nodeKeySet instanceof Set) return opts.nodeKeySet;
  const set = new Set();
  const objs = state && !(state instanceof Map) ? state.witchObjectives : null;
  for (const o of objs ?? []) {
    for (const h of o.hexes ?? [{ col: o.col, row: o.row }]) {
      set.add(hexKey(h.col, h.row));
    }
  }
  return set;
}

// Adjacent hexes (in odd-r direction order 0..5) that are eligible to become a
// building's impassable footprint. Eligibility:
//   • the tile exists in the map (in-bounds)
//   • base   !== 'river'  (defensive — base should never be river)
//   • path   !== 'river' AND path !== 'bridge' AND path !== 'road'
//        (the road exclusion: turning a road into an impassable footprint would
//         sever the MST road network — Reviewer Otis nit)
//   • building == null    (not another building's entrance)
//   • buildingFootprintOf == null  (not already claimed by another building)
//   • not a power-node hex (from opts.nodeKeySet or state.witchObjectives)
//
// `state` may be a GameState, a `{ tiles }` object, or a raw tiles Map.
// `opts.nodeKeySet` optionally supplies the node-hex exclusion set directly.
export function eligibleFootprintNeighbors(state, col, row, opts = {}) {
  const tiles = tilesOf(state);
  if (!tiles) return [];
  const nodeKeys = nodeKeySetOf(state, opts);

  const out = [];
  // getNeighbors yields odd-r neighbours in direction order 0..5 (edge tiles
  // drop off-map directions but never reorder the survivors).
  for (const { col: nc, row: nr } of getNeighbors(col, row)) {
    const nk = hexKey(nc, nr);
    const n = tiles.get(nk);
    if (!n) continue;                              // off-map / no tile
    if (n.base === TileType.RIVER) continue;       // defensive
    if (n.path === PathType.RIVER) continue;
    if (n.path === PathType.BRIDGE) continue;
    if (n.path === PathType.ROAD) continue;        // road exclusion
    if (n.building != null) continue;              // another building's entrance
    if (n.buildingFootprintOf != null) continue;   // already a footprint
    if (nodeKeys.has(nk)) continue;                // power node
    out.push({ col: nc, row: nr });
  }
  return out;
}

// Convenience picker. Returns one eligible footprint neighbour, or null when
// none are eligible.
//   • no `rand`  → deterministic: the FIRST eligible neighbour (direction 0..5)
//   • with `rand`→ a random eligible neighbour (uses `rand()` to pick an index)
// `rand` is only consumed when at least one neighbour is eligible.
export function pickFootprintNeighbor(state, col, row, rand, opts = {}) {
  const eligible = eligibleFootprintNeighbors(state, col, row, opts);
  if (eligible.length === 0) return null;
  if (typeof rand === 'function') {
    const idx = Math.min(eligible.length - 1, Math.floor(rand() * eligible.length));
    return eligible[idx];
  }
  return eligible[0];
}
