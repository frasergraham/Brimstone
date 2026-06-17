// Module-level debug toggles for purely-presentational behaviour.
//
// These flags are **Show-side only** (see the Sim/Show split in CLAUDE.md):
// they may gate animation/presentation but MUST NOT influence combat logic,
// damage, resolution, or any authoritative GameState mutation. The renderer-
// agnostic combat helpers (combat-cinematic.js / combat-fast.js) read these to
// decide whether to play an animation; the debug console (keybindings.js) flips
// them.
//
// DOM-free and import-light so the no-import combat helpers can depend on it.

// Ally "gang-up" lunge — during a battle replay, the first ADVANTAGE_CAP allied
// units per side slide to the defender's shared edge. Found too noisy, so it is
// disabled by default; the primary attacker's lunge and the defender re-centring
// are untouched (allies just stay on their own hexes). Re-enable with `/lunge`.
// Default OFF.
let _allyLungeEnabled = false;

/** @returns {boolean} whether ally gang-up lunge animations play. */
export function isAllyLungeEnabled() {
  return _allyLungeEnabled;
}

/**
 * Set the ally-lunge flag.
 * @param {boolean} on
 * @returns {boolean} the new state.
 */
export function setAllyLungeEnabled(on) {
  _allyLungeEnabled = !!on;
  return _allyLungeEnabled;
}

/**
 * Flip the ally-lunge flag.
 * @returns {boolean} the new state.
 */
export function toggleAllyLunge() {
  _allyLungeEnabled = !_allyLungeEnabled;
  return _allyLungeEnabled;
}
