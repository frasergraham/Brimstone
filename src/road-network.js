// Shared MST road-network builder for the Caleb's Hollow hex map.
//
// The road logic used to be duplicated in two places:
//   • src/map.js — the procedural generator's two-tier road network.
//   • src/campaign/campaigns/calebs-hollow-prologue.js — the hand-rolled
//     `buildRoadNetwork` used by the bespoke mission maps.
//
// This module extracts the genuinely shared primitives:
//   • buildMST       — Kruskal's minimum spanning tree over a node list.
//   • placeRoadPath  — lay a single BFS path onto the tile map, converting
//                      eligible tiles to ROAD, recording symmetric roadDirs,
//                      and handling bridges per the supplied mode.
//
// and exposes `buildRoadNetwork`, the simple MST-over-buildings composition the
// campaign missions rely on (Kruskal MST → BFS per edge → convert RIVER tiles
// to BRIDGE inline up to `maxBridges`). The procedural generator (map.js) keeps
// its own bespoke orchestration (two-tier spokes/trunk, pre-selected river
// crossings, redundant-edge skipping, stub/bridge audit) but now composes it
// from these same primitives.
//
// NOTE on the two original copies: they were materially different algorithms.
// map.js routes with blockRiver=true and pre-places bridges at chosen crossings;
// the campaign builder routes with blockRiver=false and converts whatever RIVER
// tiles the path happens to cross into bridges (up to a cap). To keep map output
// byte-for-byte identical for both call sites, this module preserves BOTH
// behaviours rather than unifying them into one road layout. See the worker
// report for the full discrepancy notes.

import { hexKey, hexDistance } from './hex.js';
import { TileType } from './tiles.js';
// bfsPath lives in map.js (the road/Dijkstra path finder). The resulting
// import cycle (map.js ↔ road-network.js) is benign: both sides export hoisted
// function declarations and only reference each other at call time.
import { bfsPath } from './map.js';

/**
 * Kruskal's minimum spanning tree over a list of {col,row} nodes, weighted by
 * hex distance. Returns the spanning-tree edges as `{ from, to }` pairs where
 * `from`/`to` are (references to) entries of `nodes`.
 *
 * With fewer than 2 nodes the tree is empty.
 *
 * @param {{col:number,row:number}[]} nodes
 * @returns {{from:{col:number,row:number}, to:{col:number,row:number}}[]}
 */
export function buildMST(nodes) {
  const n = nodes.length;
  const edges = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      edges.push({ i, j, d: hexDistance(nodes[i].col, nodes[i].row, nodes[j].col, nodes[j].row) });
    }
  }
  edges.sort((a, b) => a.d - b.d);

  const parent = Array.from({ length: n }, (_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };

  const mst = [];
  for (const { i, j } of edges) {
    if (find(i) !== find(j)) {
      parent[find(i)] = find(j);
      mst.push({ from: nodes[i], to: nodes[j] });
      if (mst.length === n - 1) break;
    }
  }
  return mst;
}

/**
 * Lay a single BFS path onto the tile map.
 *
 * For each tile on the path:
 *   • GRASS / DIRT / FOREST → ROAD (and added to `roadTiles`).
 *   • RIVER → BRIDGE, if `convertRiverToBridge` is set and the bridge budget
 *     (`maxBridges`) has not been exhausted.
 *   • BRIDGE → left as-is but added to `roadTiles` (pre-placed-bridge mode).
 * Consecutive path tiles get symmetric `roadDirs` links so the renderer and
 * connectivity checks can read exact topology.
 *
 * @param {Map<string,import('./tiles.js').Tile>} tiles
 * @param {{col:number,row:number}[]} path
 * @param {Set<string>} roadTiles  mutated: keys of tiles now part of the road grid
 * @param {object} [opts]
 * @param {boolean} [opts.convertRiverToBridge=false]  convert crossed RIVER tiles to BRIDGE
 * @param {number}  [opts.maxBridges=0]      bridge budget when converting
 * @param {number}  [opts.bridgesPlaced=0]   bridges already placed (running total)
 * @returns {number} updated bridges-placed total
 */
export function placeRoadPath(tiles, path, roadTiles, opts = {}) {
  const { convertRiverToBridge = false, maxBridges = 0, bridgesPlaced = 0 } = opts;
  let placed = bridgesPlaced;

  for (let i = 0; i < path.length; i++) {
    const { col, row } = path[i];
    const k = hexKey(col, row);
    const t = tiles.get(k);
    if (!t) continue;

    if (t.type === TileType.GRASS || t.type === TileType.DIRT || t.type === TileType.FOREST) {
      t.type = TileType.ROAD;
      roadTiles.add(k);
    } else if (convertRiverToBridge && t.type === TileType.RIVER && placed < maxBridges) {
      t.type = TileType.BRIDGE;
      placed++;
      roadTiles.add(k);
    } else if (!convertRiverToBridge && t.type === TileType.BRIDGE) {
      roadTiles.add(k);
    }

    // Record bidirectional connectivity so the renderer and floodConnected
    // can use exact road topology rather than inferring from tile types.
    if (i > 0) {
      const prev = path[i - 1];
      const prevKey = hexKey(prev.col, prev.row);
      const prevTile = tiles.get(prevKey);
      if (prevTile) {
        t.roadDirs.add(prevKey);
        prevTile.roadDirs.add(k);
      }
    }
  }

  return placed;
}

/**
 * Build a simple MST road network between a set of {col,row} nodes — the
 * composition used by the bespoke campaign mission maps.
 *
 * Kruskal MST over the nodes, BFS path per edge (rivers are not blocked), and
 * RIVER tiles crossed by a path are converted to BRIDGE up to `maxBridges`.
 *
 * @param {Map<string,import('./tiles.js').Tile>} tiles
 * @param {{col:number,row:number}[]} nodes
 * @param {() => number} rand  seeded RNG (shared with the map's generator)
 * @param {number} [maxBridges=2]
 * @returns {number} number of bridges placed
 */
export function buildRoadNetwork(tiles, nodes, rand, maxBridges = 2) {
  if (nodes.length < 2) return 0;

  const mstEdges = buildMST(nodes);

  let bridgesPlaced = 0;
  const roadTiles = new Set();

  for (const { from, to } of mstEdges) {
    const path = bfsPath(tiles, from.col, from.row, to.col, to.row, rand, roadTiles);
    bridgesPlaced = placeRoadPath(tiles, path, roadTiles, {
      convertRiverToBridge: true,
      maxBridges,
      bridgesPlaced,
    });
  }

  return bridgesPlaced;
}
