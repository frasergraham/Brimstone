/**
 * App Mode State Machine — single source of truth for what the app is doing.
 *
 * Replaces scattered boolean flags (_inGame, _resolving, _replayActive,
 * _planMode, _planSubmitted) with a centralized mode that every module
 * can query.
 *
 * Modes:
 *   MENU       — browsing menus/lobby. Game callbacks are no-ops.
 *   PLANNING   — in a game, building a plan (not yet submitted).
 *   SUBMITTED  — plan locked, waiting for opponents.
 *   RESOLVING  — watching turn resolution animation (current round).
 *   SUMMARY    — post-resolution summary dialog.
 *   PLAYBACK   — full-game replay viewer (completed games only, own HUD).
 *   SPECTATING — read-only live game view.
 *
 * RESOLVING vs PLAYBACK:
 *   RESOLVING is the current round's animation — happens live, on reconnect,
 *   or when the player taps "replay last turn". Uses the normal game UI.
 *   PLAYBACK is the full-game replay from round 1, only available after
 *   game-over. Has its own play/pause/ff/back controls. Exits to MENU.
 */

export const AppMode = Object.freeze({
  MENU:       'MENU',
  PLANNING:   'PLANNING',
  SUBMITTED:  'SUBMITTED',
  RESOLVING:  'RESOLVING',
  SUMMARY:    'SUMMARY',
  PLAYBACK:   'PLAYBACK',
  SPECTATING: 'SPECTATING',
});

let _current = AppMode.MENU;
let _previous = AppMode.MENU;
const _listeners = [];

/** Get the current app mode. */
export function getMode() { return _current; }

/** Get the previous app mode (useful for restoring after inline replay). */
export function getPreviousMode() { return _previous; }

/** Transition to a new app mode. */
export function setMode(newMode) {
  if (newMode === _current) return;
  _previous = _current;
  _current = newMode;
  for (const fn of _listeners) fn(newMode, _previous);
}

/** Register a callback for mode transitions: fn(newMode, oldMode). */
export function onModeChange(fn) { _listeners.push(fn); }

// ── Convenience predicates ──────────────────────────────────────────────────

/** True when the player is actively in a game (not in menus or spectating). */
export function isInGame() {
  return _current !== AppMode.MENU && _current !== AppMode.SPECTATING;
}

/** True when an animation is playing (resolution or full-game playback). */
export function isAnimating() {
  return _current === AppMode.RESOLVING || _current === AppMode.PLAYBACK;
}

/** True when incoming server messages should be buffered, not applied. */
export function shouldBufferMessages() {
  return _current === AppMode.RESOLVING
      || _current === AppMode.SUMMARY
      || _current === AppMode.PLAYBACK;
}
