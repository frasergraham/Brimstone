// Building-footprint eligibility helper (P2 of the building-footprint rework).
//
// A footprinted building is a compound object: a passable ENTRANCE tile (the
// one carrying `building`) plus one impassable FOOTPRINT hex adjacent to it.
// This module is the single source of truth for deciding WHICH adjacent hex a
// building may claim as its footprint. Both procedural map generation
// (`src/map.js`) and the legacy-save auto-migration (`server/state-sync.js`)
// call these helpers so the eligibility rules — including the road exclusion —
// stay identical across both paths.
import { getNeighbors, hexKey, hexRange } from './hex.js';
import { PathType, TileType, isRiver, isBuildingFootprint, hasBuilding, tileTotalCapacity } from './tiles.js';

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

// ── Footprint quality scoring ───────────────────────────────────────────────
// A footprint hex is fully impassable (capacity 0), so WHICH of the eligible
// directions we claim materially affects the map. A purely-random pick can drop
// a wall on a river bank (starving a future bridge crossing) or pinch a corridor
// between buildings. We score each eligible candidate (lower penalty = better)
// and prefer the best, keeping a seeded tie-break for variety.
//
// Weights are spaced an order of magnitude apart so ranking is effectively
// lexicographic: a river-bank candidate always loses to any non-bank one, a
// chokepoint always loses to a non-chokepoint, and clustering only breaks
// otherwise-equal ties. Tunable.
const W_RIVER_ADJ = 1000;  // sits on a river bank → would starve a bridge approach
const W_CHOKE     = 100;   // local cut-vertex → pinches a movement corridor
const W_CLUSTER   = 10;    // hugs another building/footprint → tends to form walls

// Does this tile block footprint-local movement? Off-map and river are
// impassable terrain; an existing footprint has capacity 0; and the candidate
// we're tentatively testing is treated as impassable. Buildings/roads/bridges
// stay passable — only IMPASSABLE hexes form the walls we care about. `key` is
// the candidate's own key; `tentativeKey` is the hex being pretend-blocked.
function _blocksLocalMove(tile, tentativeKey, key) {
  if (!tile) return true;                         // off-map
  if (key === tentativeKey) return true;          // pretend candidate is impassable
  if (isRiver(tile)) return true;                 // river is impassable (no bridge yet)
  if (tileTotalCapacity(tile) === 0) return true; // existing footprint
  return false;
}

// Local cut-vertex test. Tentatively treat `cand` as impassable, then check
// whether its passable direct neighbours stay mutually reachable within a
// radius-2 disc around it. Returns the count of passable neighbours that become
// unreachable (0 = fully connected; ≥1 = a local chokepoint). Bounded and cheap:
// a radius-2 disc is ≤19 hexes.
export function _localCutPenalty(tiles, cand, candKey) {
  // Passable direct neighbours — the hexes a wall here would separate.
  const seeds = [];
  for (const n of getNeighbors(cand.col, cand.row)) {
    const k = hexKey(n.col, n.row);
    if (!_blocksLocalMove(tiles.get(k), candKey, k)) seeds.push(k);
  }
  if (seeds.length <= 1) return 0;  // 0 or 1 neighbour can't be "disconnected"

  const seedSet = new Set(seeds);
  const region  = new Set(hexRange(cand.col, cand.row, 2).map(h => hexKey(h.col, h.row)));

  // Flood from the first seed through passable in-region hexes, skipping the
  // tentatively-impassable candidate. Count which seeds we reach.
  const visited = new Set([seeds[0]]);
  const queue   = [seeds[0]];
  let reached   = 1;
  while (queue.length) {
    const [cc, cr] = queue.shift().split(',').map(Number);
    for (const n of getNeighbors(cc, cr)) {
      const nk = hexKey(n.col, n.row);
      if (visited.has(nk) || !region.has(nk)) continue;
      if (_blocksLocalMove(tiles.get(nk), candKey, nk)) continue;
      visited.add(nk);
      queue.push(nk);
      if (seedSet.has(nk)) reached++;
    }
  }
  return seeds.length - reached;  // unreached seeds = extra components
}

// Placement penalty for claiming `cand` as `(entCol,entRow)`'s footprint hex.
// Lower is better. Pure given the tiles Map.
function _footprintPenalty(tiles, cand, candKey) {
  let p = 0;

  // (A) River-adjacency — never wall a river bank if avoidable (protects bridges).
  for (const n of getNeighbors(cand.col, cand.row)) {
    const t = tiles.get(hexKey(n.col, n.row));
    if (t && isRiver(t)) { p += W_RIVER_ADJ; break; }  // once, not per river-neighbour
  }

  // (B) Clustering — penalise per adjacent building entrance / existing footprint.
  let clusterN = 0;
  for (const n of getNeighbors(cand.col, cand.row)) {
    const t = tiles.get(hexKey(n.col, n.row));
    if (!t) continue;
    if (hasBuilding(t) || isBuildingFootprint(t)) clusterN++;
  }
  p += W_CLUSTER * clusterN;

  // (C) Local connectivity — avoid pinching a corridor.
  p += W_CHOKE * _localCutPenalty(tiles, cand, candKey);

  return p;
}

// Convenience picker. Returns one eligible footprint neighbour, or null when
// none are eligible. Among eligible candidates it prefers the lowest placement
// penalty (see scoring above), breaking ties to keep maps varied:
//   • no `rand`  → deterministic: the lowest-penalty neighbour in direction
//                  order 0..5 (first of the best bucket)
//   • with `rand`→ a random pick within the best (lowest-penalty) bucket
// `rand` is consumed exactly once when at least one neighbour is eligible — the
// same number of draws as the old uniform pick, so the RNG stream stays aligned.
export function pickFootprintNeighbor(state, col, row, rand, opts = {}) {
  const tiles = tilesOf(state);
  const eligible = eligibleFootprintNeighbors(state, col, row, opts);
  if (eligible.length === 0) return null;

  // Score in stable direction order; collect the lowest-penalty bucket. EPS only
  // buckets exact ties (weights are integers ≥10 apart), so a chokepoint never
  // shares a bucket with a clean candidate.
  const scored = eligible.map(c => ({ c, p: _footprintPenalty(tiles, c, hexKey(c.col, c.row)) }));
  const minP   = Math.min(...scored.map(s => s.p));
  const best   = scored.filter(s => s.p <= minP + 0.5).map(s => s.c);

  if (typeof rand === 'function') {
    const idx = Math.min(best.length - 1, Math.floor(rand() * best.length));
    return best[idx];
  }
  return best[0];
}
