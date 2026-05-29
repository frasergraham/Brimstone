// Pure, render-engine-agnostic helpers for the building-footprint rework (P4).
//
// A footprinted building is a 2-hex (schema: N-hex) compound: a passable
// ENTRANCE tile (the one carrying `building` + `footprintHexes`) plus its
// impassable FOOTPRINT hex(es). Visually the building MODEL/ARTWORK lives on
// the footprint hex, oriented so its front faces the entrance; the entrance
// hex shows only its base terrain (the path leads up to the door).
//
// These helpers carry that geometry without any Babylon / Canvas dependency,
// so both the 2D renderer and the 3D renderer import them, and they're
// unit-tested directly.

import { hexKey } from './hex.js';
import { isBuildingEntrance } from './tiles.js';

// odd-r offset neighbour deltas, dir index 0..5 (mirrors hex.js DIRS_*). We
// replicate them here rather than calling getNeighbors() because getNeighbors
// filters out negative-coord neighbours, which would shift the dir indices —
// `doorStubDirection` must return the stable odd-r direction.
const DIRS_EVEN = [[-1, 0], [-1, -1], [0, -1], [1, 0], [0, 1], [-1, 1]];
const DIRS_ODD  = [[-1, 0], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1]];

// P4a — how far (fraction of the footprint→entrance vector) to nudge a building
// MODEL/ARTWORK off its footprint-hex centre toward the entrance hex, so the
// building visibly leans toward its door rather than sitting dead-centre on the
// footprint. 0 = no shift (centred on footprint), 1 = sit on the entrance.
// Operator-dialable knob for the visual-iteration pass.
export const BUILDING_ENTRANCE_NUDGE = 0.15;

// Target ground span (world units) a building MODEL should fill in plan view.
// In the 3D renderer one hex has radius HEX_RADIUS_WORLD = 1; we uniform-scale
// a building so its larger XZ bbox axis lands at this span — filling roughly one
// hex of ground, with a little overhang allowed. Height is then DERIVED (the
// uniform scale preserves the model's natural aspect ratio) rather than capped.
// Operator-dialable: bump toward ~1.5 to fill more of the hex (a pointy-top hex
// is ≈√3≈1.73 world units across), lower it to leave a margin.
export const TARGET_BUILDING_GROUND_SPAN = 1.0;

/** Which hex should the building ARTWORK/MODEL be drawn on?
 *  - A footprinted building → its (first) footprint hex.
 *  - A legacy/orphan building with no footprint → its own entrance hex
 *    (fallback so old saves that couldn't claim a footprint still render).
 *  Returns a "col,row" hexKey string. */
export function buildingRenderHex(tile) {
  if (isBuildingEntrance(tile)) return tile.footprintHexes[0];
  return hexKey(tile?.col ?? 0, tile?.row ?? 0);
}

/** Yaw (radians, normalised to [0, 2π)) that orients a building so its local
 *  +Z axis points FROM the footprint hex TOWARD the entrance hex — i.e. the
 *  "front door" faces the path leading to the entrance.
 *
 *  Convention: in Babylon a mesh with rotation.y = θ maps its local +Z axis to
 *  world (sin θ, ·, cos θ). To aim +Z down the (entrance − footprint) vector
 *  we set θ = atan2(dx, dz). Inputs are {x, z} world positions; the y/up
 *  component is ignored. Returns 0 when the two positions coincide. */
export function buildingFacingYaw(entranceWorld, footprintWorld) {
  const dx = (entranceWorld?.x ?? 0) - (footprintWorld?.x ?? 0);
  const dz = (entranceWorld?.z ?? 0) - (footprintWorld?.z ?? 0);
  if (dx === 0 && dz === 0) return 0;
  const yaw = Math.atan2(dx, dz);
  return yaw < 0 ? yaw + Math.PI * 2 : yaw;
}

/** P4a — Lerp a building's draw position from its FOOTPRINT-hex centre toward
 *  its ENTRANCE-hex centre by `nudge` (0..1). Both inputs are world positions
 *  `{x, z}` (the y/up component is ignored). Returns `{x, z}`.
 *
 *  When `entranceWorld` is null/undefined the result is the footprint position
 *  unchanged — so an orphan building with no footprint (caller passes the
 *  entrance world for both, or null for the second arg) draws exactly where it
 *  did before, no shift. */
export function buildingNudgedPosition(footprintWorld, entranceWorld, nudge = BUILDING_ENTRANCE_NUDGE) {
  const fx = footprintWorld?.x ?? 0;
  const fz = footprintWorld?.z ?? 0;
  if (!entranceWorld) return { x: fx, z: fz };
  const ex = entranceWorld.x ?? fx;
  const ez = entranceWorld.z ?? fz;
  return { x: fx + (ex - fx) * nudge, z: fz + (ez - fz) * nudge };
}

/** P4a — odd-r dir index (0..5) FROM a building entrance TOWARD its footprint
 *  hex — i.e. which hex edge the "door" stub crosses. `footprintHex` is a
 *  "col,row" hexKey; when omitted it falls back to the entrance's first
 *  footprint hex. Returns -1 when there's no footprint or it isn't an adjacent
 *  neighbour (defensive — a well-formed footprint is always adjacent). Both
 *  renderers use this to locate the implicit door-direction neighbour they add
 *  alongside the real `roadDirs` at render time (the data layer is untouched). */
export function doorStubDirection(entranceTile, footprintHex) {
  if (!entranceTile) return -1;
  const fp = footprintHex
    ?? (isBuildingEntrance(entranceTile) ? entranceTile.footprintHexes[0] : null);
  if (!fp) return -1;
  const col = entranceTile.col ?? 0;
  const row = entranceTile.row ?? 0;
  const dirs = (row & 1) ? DIRS_ODD : DIRS_EVEN;
  for (let i = 0; i < 6; i++) {
    if (hexKey(col + dirs[i][0], row + dirs[i][1]) === fp) return i;
  }
  return -1;
}

// ─── Building signpost (P4c — 3D) ───────────────────────────────────────────
// Each building is marked by a small wooden SIGNPOST at the "door side" of its
// footprint: a vertical POST (thin cylinder) topped by a billboarded PLANK that
// shows the building name. The post stays planted; the plank rotates around the
// vertical axis to face the camera. These dimensions are the operator-dialable
// knobs — the 3D renderer (`src/renderer-3d.js`) reads them when it builds the
// post + plank meshes. Tweak here in one place; nothing else hard-codes them.

/** Height (world units) of the signpost POST cylinder. Tall enough that the
 *  plank sits at a comfortable reading height ABOVE it (plank cap-style). */
export const SIGNPOST_POST_HEIGHT = 0.55;
/** Diameter (world units) of the signpost POST cylinder — a thin fencepost. */
export const SIGNPOST_POST_DIAMETER = 0.05;
/** Width (world units) of the signpost PLANK (the name board). */
export const SIGNPOST_PLANK_WIDTH = 0.90;
/** Height (world units) of the signpost PLANK. */
export const SIGNPOST_PLANK_HEIGHT = 0.32;
/** Depth (world units) of the signpost PLANK — gives the board real thickness
 *  when seen from any angle, so it reads as carved wood instead of a paper
 *  billboard sticker. */
export const SIGNPOST_PLANK_DEPTH = 0.06;
/** How far the signpost is pushed OFF the road centreline, perpendicular to
 *  the entrance→footprint axis. 0 = on the road; positive = side of the road.
 *  The "side" is biased deterministically (sin of the hex position) so a
 *  signpost picks the same side every frame and the row of buildings doesn't
 *  alternate-zigzag visually. */
export const SIGNPOST_ROAD_OFFSET = 0.38;

/** World-XZ position for a building signpost: the midpoint of the shared edge
 *  between the ENTRANCE hex and the building's FOOTPRINT hex, optionally
 *  pushed perpendicular to the road (entrance→footprint axis) by `offset`
 *  world units. Positive offset = right side of the road (looking from
 *  entrance toward footprint); negative = left. `sideBias` (default 1) flips
 *  the perpendicular direction so the caller can pick a deterministic side.
 *  Both inputs are world `{x, z}` (y is ignored).
 *
 *  Returns null when either world position is missing — an orphan/legacy
 *  building has no footprint and therefore no shared edge, so the caller falls
 *  back to the old centred-above-the-building floating label. */
export function signpostWorldPos(entranceWorld, footprintWorld, offset = 0, sideBias = 1) {
  if (!entranceWorld || !footprintWorld) return null;
  const ax = entranceWorld.x, az = entranceWorld.z;
  const fx = footprintWorld.x, fz = footprintWorld.z;
  if (ax == null || az == null || fx == null || fz == null) return null;
  const mx = (ax + fx) / 2;
  const mz = (az + fz) / 2;
  if (!(offset > 0) && !(offset < 0)) return { x: mx, z: mz };
  // Perpendicular to (footprint - entrance), normalised. Two 90° rotations of
  // the unit road direction (rx, rz) give (rz, -rx) and (-rz, rx) — sideBias
  // picks which.
  const rx = fx - ax;
  const rz = fz - az;
  const len = Math.hypot(rx, rz);
  if (!(len > 1e-9)) return { x: mx, z: mz };
  const ux = rx / len, uz = rz / len;
  const px = uz * sideBias;
  const pz = -ux * sideBias;
  return { x: mx + px * offset, z: mz + pz * offset };
}

/** Uniform scale factor to fit a building's XZ footprint into ~1 hex of ground.
 *  `bboxXZ` is the model's natural {x, z} extent (world units, pre-scale); the
 *  larger of the two axes is scaled to `target`. Returns null when the extent
 *  is unmeasurable (≈0) so the caller can keep its own fallback scale. */
export function buildingFitScale(bboxXZ, target = TARGET_BUILDING_GROUND_SPAN) {
  const x = Math.abs(bboxXZ?.x ?? 0);
  const z = Math.abs(bboxXZ?.z ?? 0);
  const span = Math.max(x, z);
  if (!(span > 1e-6)) return null;
  return target / span;
}

/** P4b — fortification edge masks for a building COMPOUND, treating the
 *  passable ENTRANCE hex and its impassable FOOTPRINT hex as ONE walled
 *  enclosure. Returns `{ entrance, footprint }`, each an array of edge-direction
 *  indices (0..5, odd-r W/NW/NE/E/SE/SW order — the SAME convention as
 *  renderer-3d's `fortNeighborOffset`) that should carry a wall segment.
 *
 *  Rule (per hex): an edge gets a wall iff the neighbour ACROSS it is NOT part
 *  of any fortified compound. `isFortifiedCompoundAt(col, row)` is the caller-
 *  supplied predicate — true when that hex is a fortified entrance OR a footprint
 *  hex of a fortified entrance. Because the partner hex of THIS compound is
 *  itself "in the compound", the SHARED edge between entrance and footprint comes
 *  back bare automatically (no special-casing). Adjacent fortified compounds
 *  merge the same way — their touching edges stay bare. Off-map / unfortified
 *  neighbours → wall.
 *
 *  `footprintTile` may be null — a fortified hex with no footprint (open ground
 *  the hero fortified, or a legacy orphan building). Then `footprint` is `[]`
 *  and `entrance` degenerates to the plain per-hex perimeter rule. Pure. */
export function compoundFortifyEdges(entranceTile, footprintTile, isFortifiedCompoundAt) {
  const edgesFor = (col, row) => {
    const dirs = (row & 1) ? DIRS_ODD : DIRS_EVEN;
    const out = [];
    for (let d = 0; d < 6; d++) {
      if (!isFortifiedCompoundAt(col + dirs[d][0], row + dirs[d][1])) out.push(d);
    }
    return out;
  };
  return {
    entrance: entranceTile ? edgesFor(entranceTile.col ?? 0, entranceTile.row ?? 0) : [],
    footprint: footprintTile ? edgesFor(footprintTile.col ?? 0, footprintTile.row ?? 0) : [],
  };
}

/** P4b — continue the door-stub road INTO the footprint hex so the ribbon meets
 *  the building's door. `strokes` are the world-XZ polylines that
 *  `networkStrokesForTile` returned for a building entrance; the synthetic
 *  footprint neighbour gives one stroke whose far end sits at the shared-edge
 *  midpoint `edgeMid`. We extend THAT stroke past the edge to `buildingWorld`
 *  (the nudged position the GLB/artwork is drawn at), so the road visibly enters
 *  the footprint hex.
 *
 *  Matches the stroke whose START or END coincides with `edgeMid` and pushes /
 *  unshifts `buildingWorld` onto the matching end (preserving travel order, so
 *  the road runs entrance-centre → edge → into the footprint). Mutates and
 *  returns `strokes`; no-op when no endpoint matches. Pure (no Babylon). */
export function extendDoorStub(strokes, edgeMid, buildingWorld, eps = 1e-6) {
  if (!Array.isArray(strokes) || !edgeMid || !buildingWorld) return strokes;
  const near = (p) => p && Math.abs(p.x - edgeMid.x) < eps && Math.abs(p.z - edgeMid.z) < eps;
  const end = { x: buildingWorld.x, z: buildingWorld.z };
  for (const s of strokes) {
    if (!Array.isArray(s) || s.length < 2) continue;
    if (near(s[s.length - 1])) { s.push(end); return strokes; }
    if (near(s[0]))            { s.unshift(end); return strokes; }
  }
  return strokes;
}
