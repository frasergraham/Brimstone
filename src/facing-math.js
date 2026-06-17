// Pure, DOM-free facing math for the 3D renderer's presentation-time turn
// pivots — conversation participants turning to the active speaker, and
// combatants meeting each other before the strike.
//
// Babylon's left-handed Y-up convention: a mesh whose local +Z is its forward
// vector points at world-XZ direction (dx, dz) when its `rotation.y` equals
// `Math.atan2(dx, dz)`. Everything in this module assumes that convention.
//
// Kept out of `renderer-3d.js` so unit tests can verify the math without
// dragging Babylon (a heavy WebGL/UMD dep) into the Node test process.

/** Duration (ms) of a "turn to face" yaw slerp used at presentation gates —
 *  conversation participants turning to the active speaker, and combatants
 *  meeting each other before the strike. Short and ease-in-out so it reads as
 *  a deliberate look, not a movement. Render-only; scaled by playback speed.
 *  Re-exported by `renderer-3d.js` so legacy import paths keep working. */
export const FACE_TURN_MS = 260;

/** "Already facing" threshold (radians, ≈4.6°). A requested turn smaller than
 *  this is treated as a no-op so we never fire a one-frame animation for a unit
 *  that is effectively already on-target. */
export const FACING_EPSILON = 0.08;

/** Minimum |dx|/|dz| (world units) for a direction to count as resolvable.
 *  When the source point coincides with the target the bearing is undefined —
 *  the caller treats this as a no-op (don't rotate). */
export const POSITION_EPSILON = 1e-4;

/**
 * Bearing (radians) from a source XZ point toward a target XZ point under the
 * Babylon left-handed Y-up convention: result is the `rotation.y` that aligns
 * a mesh's local +Z axis with the (dx, dz) direction.
 *
 * Returns `null` when the source and target coincide (within
 * `POSITION_EPSILON`) — the direction is degenerate and the caller must NOT
 * rotate the mesh (avoids snapping to `atan2(0, 0) = 0`).
 *
 * @param {number} fromX
 * @param {number} fromZ
 * @param {number} toX
 * @param {number} toZ
 * @returns {number | null}
 */
export function bearingTo(fromX, fromZ, toX, toZ) {
  const dx = toX - fromX;
  const dz = toZ - fromZ;
  if (Math.abs(dx) < POSITION_EPSILON && Math.abs(dz) < POSITION_EPSILON) return null;
  return Math.atan2(dx, dz);
}

/**
 * Shortest signed yaw delta from `from` to `desired`, wrapped into (-π, π].
 * Used so a 359°→1° turn pivots +2° rather than spinning the long way round.
 *
 * @param {number} from
 * @param {number} desired
 * @returns {number}
 */
export function shortestYawDelta(from, desired) {
  return Math.atan2(Math.sin(desired - from), Math.cos(desired - from));
}

/**
 * True when `delta` (radians) is small enough that we should treat the model
 * as already facing the target (and skip the one-frame animation).
 */
export function isWithinFacingEpsilon(delta, epsilon = FACING_EPSILON) {
  return Math.abs(delta) < epsilon;
}

/**
 * Plan a "face toward point" yaw: given the model's current yaw and source
 * position, return the desired yaw + delta to apply. Returns `null` when the
 * turn should be skipped entirely (degenerate direction OR already facing
 * within `FACING_EPSILON`).
 *
 * Pure: takes scalars in, returns scalars out — no DOM, no Babylon.
 *
 * @param {{ x:number, z:number }} from
 * @param {number} currentYaw
 * @param {{ x:number, z:number }} target
 * @param {number} [epsilon=FACING_EPSILON]
 * @returns {{ desired:number, delta:number } | null}
 */
export function planFacingTurn(from, currentYaw, target, epsilon = FACING_EPSILON) {
  const desired = bearingTo(from.x, from.z, target.x, target.z);
  if (desired === null) return null;
  const delta = shortestYawDelta(currentYaw, desired);
  if (isWithinFacingEpsilon(delta, epsilon)) return null;
  return { desired, delta };
}

/**
 * Compute the centroid `{ x, z }` of a list of `{ x, z }` points. Returns
 * `null` for an empty list. Used to point a speaker at the middle of the rest
 * of a multi-participant conversation group.
 *
 * @param {Array<{ x:number, z:number }>} points
 * @returns {{ x:number, z:number } | null}
 */
export function centroidXZ(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  let sx = 0, sz = 0;
  for (const p of points) { sx += p.x; sz += p.z; }
  return { x: sx / points.length, z: sz / points.length };
}

/**
 * Plan an orient-conversation pass: returns one `{ id, desired }` entry per
 * participant whose facing needs to change. The speaker is pointed at the
 * centroid of the other participants; each other participant is pointed at the
 * speaker. Entries where the bearing is degenerate or the current yaw is
 * already within `epsilon` of the desired yaw are omitted.
 *
 * Pure — works off plain `{ id, pos:{x,z}, currentYaw }` participant records
 * so tests can verify the math without standing up Babylon.
 *
 * @param {string|number} speakerId
 * @param {Array<{ id, pos:{x:number,z:number}, currentYaw:number }>} participants
 * @param {number} [epsilon=FACING_EPSILON]
 * @returns {Array<{ id, desired:number, delta:number }>}
 */
export function planConversationOrientation(speakerId, participants, epsilon = FACING_EPSILON) {
  if (speakerId == null || !Array.isArray(participants)) return [];
  const out = [];
  const speaker = participants.find(p => p?.id === speakerId);
  const others  = participants.filter(p => p?.id != null && p.id !== speakerId);
  if (others.length === 0) return out;  // lone speaker / narration beat
  if (speaker?.pos) {
    const c = centroidXZ(others.map(o => o.pos).filter(Boolean));
    if (c) {
      const turn = planFacingTurn(speaker.pos, speaker.currentYaw ?? 0, c, epsilon);
      if (turn) out.push({ id: speaker.id, desired: turn.desired, delta: turn.delta });
    }
  }
  for (const o of others) {
    if (!o.pos || !speaker?.pos) continue;
    const turn = planFacingTurn(o.pos, o.currentYaw ?? 0, speaker.pos, epsilon);
    if (turn) out.push({ id: o.id, desired: turn.desired, delta: turn.delta });
  }
  return out;
}
