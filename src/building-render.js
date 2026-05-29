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
