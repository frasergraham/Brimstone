// Sub-hex slot model — the canonical intra-hex placement scheme.
//
// A hex has 7 placement slots:
//   0       — centre
//   1..6    — the spot adjacent to each of the 6 hex faces
//
// Slot ids 1..6 are aligned to the `getNeighbors` direction order from hex.js
// (0=W, 1=NW, 2=NE, 3=E, 4=SE, 5=SW). The mapping preserves the historical
// TILE_SLOTS labelling (1=NE, 2=NW, 3=W, 4=SW, 5=SE, 6=E) so the building
// anchor and existing prop layout stay put while the geometry sits on the true
// face normals (see TILE_SLOTS in renderer-3d.js).
//
// This module is PURE (only imports hex coordinate math). It is the single
// source of truth shared by the capacity gate (tiles.js), the slot-assignment
// seam (actions.js), serialization (state-sync.js), and both renderers.

import { neighborDirIndex } from './hex.js';

export const SLOT_CENTER  = 0;
export const SLOT_COUNT   = 7;
export const OUTER_SLOTS  = Object.freeze([1, 2, 3, 4, 5, 6]);

// The slot a building always occupies (NE), mirrored by BUILDING_SLOT_INDEX in
// renderer-3d.js. A unit is never assigned the centre overflow case until all
// outer slots are taken.
export const BUILDING_SLOT_INDEX = 1;

// slot id (1..6) → getNeighbors direction index (0..5). Index 0 (centre) has no
// face direction (-1). Preserves the NE/NW/W/SW/SE/E labelling of TILE_SLOTS.
const SLOT_TO_DIR = Object.freeze([-1, 2, 1, 0, 5, 4, 3]);
// getNeighbors direction index (0..5) → slot id (1..6). Inverse of SLOT_TO_DIR.
const DIR_TO_SLOT = Object.freeze([3, 2, 1, 6, 5, 4]);

// Direction index (0..5) a slot faces, or -1 for the centre / invalid slot.
export function slotToDir(slot) {
  return (slot >= 1 && slot <= 6) ? SLOT_TO_DIR[slot] : -1;
}

// Slot id (1..6) adjacent to the given face direction (0..5), or -1 if invalid.
export function dirToSlot(dir) {
  return (dir >= 0 && dir <= 5) ? DIR_TO_SLOT[dir] : -1;
}

// The set of outer slot ids that a tile's road enters/exits through. Reads
// `tile.roadDirs` (a Set or array of neighbour "col,row" hexKeys) and maps each
// to the slot adjacent to that face. Used to keep trees off the road and to
// know which bridge slots stay usable. Returns a Set of slot ids (1..6).
export function roadFaceSlots(tile) {
  const out = new Set();
  const dirs = tile?.roadDirs;
  if (!dirs) return out;
  for (const key of dirs) {
    const [nCol, nRow] = String(key).split(',').map(Number);
    const dir = neighborDirIndex(tile.col, tile.row, nCol, nRow);
    const slot = dirToSlot(dir);
    if (slot >= 1) out.add(slot);
  }
  return out;
}

// Pick the slot a unit should occupy when it arrives on a tile: the lowest-id
// free, non-blocked slot, preferring the centre. `blockedSlots` is the tile's
// blocked outer slots (trees/bridge); `occupiedSlots` are slots already held by
// other units on the tile. Falls back to the centre when everything is taken
// (defensive overflow — the movement capacity gate should prevent this).
export function pickUnitSlot(blockedSlots = [], occupiedSlots = []) {
  const blocked  = new Set(blockedSlots);
  const occupied = new Set(occupiedSlots);
  for (let s = 0; s < SLOT_COUNT; s++) {
    if (blocked.has(s) || occupied.has(s)) continue;
    return s;
  }
  return SLOT_CENTER;
}
