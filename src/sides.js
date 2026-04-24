// Side abstraction — the two opposing teams in a Brimstone game.
//
// Each Faction belongs to exactly one Side. Sides are the level at which
// the day/night phase cycle, scoring, and team allocation operate. Factions
// are the level at which stats, abilities, AI personalities, and unit
// rosters vary.
//
// This separation lets us add new factions per side (Paladin/Rogue/Captain
// on day; Witch/Necromancer/Brute on night) without growing the binary
// hero/witch shape baked into older parts of the codebase.

// Phase string literals are inlined here to keep `sides.js` foundational —
// importing `Phase` from `game.js` would create a circular dependency
// (game.js → factions.js → sides.js → game.js) that fires at module load.
// These strings must stay in sync with the `Phase` enum in `src/game.js`;
// `tests/sides.test.js` imports the real `Phase` and asserts the mapping.
const _PHASE_DAWN  = 'dawn';
const _PHASE_DAY   = 'day';
const _PHASE_NIGHT = 'night';

export const Side = Object.freeze({
  DAY:   'day',
  NIGHT: 'night',
});

/**
 * Per-side metadata. Phase favourability is the side-level default; an
 * individual Faction can still override `isFavorablePhase` for its own
 * tactical flavour.
 */
const SIDE_META = Object.freeze({
  [Side.DAY]: Object.freeze({
    id: Side.DAY,
    name: 'Day',
    favorablePhases: Object.freeze([_PHASE_DAWN, _PHASE_DAY]),
  }),
  [Side.NIGHT]: Object.freeze({
    id: Side.NIGHT,
    name: 'Night',
    favorablePhases: Object.freeze([_PHASE_NIGHT]),
  }),
});

/** Return all side ids in declaration order (day, night). */
export function allSides() {
  return [Side.DAY, Side.NIGHT];
}

/** Return the side metadata for an id, or null if unknown. */
export function getSideMeta(sideId) {
  return SIDE_META[sideId] ?? null;
}

/** Display name for a side, e.g. 'Day' / 'Night'. Falls back to the id. */
export function sideName(sideId) {
  return SIDE_META[sideId]?.name ?? sideId;
}

/**
 * Return the opposing side id. With only two sides today this is a flip;
 * a future N-side game would generalise this to a set.
 */
export function getOpposingSide(sideId) {
  if (sideId === Side.DAY) return Side.NIGHT;
  if (sideId === Side.NIGHT) return Side.DAY;
  throw new Error(`Unknown side: ${sideId}`);
}

/** True if the given phase grants this side a favourability bonus. */
export function isFavorablePhaseForSide(sideId, phase) {
  const meta = SIDE_META[sideId];
  if (!meta) return false;
  return meta.favorablePhases.includes(phase);
}
