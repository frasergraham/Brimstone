// ═══════════════════════════════════════════════════════════════════════════
// Campaign condition registry
// ─────────────────────────────────────────────────────────────────────────────
// Story triggers may carry a `condition` predicate `(state) => boolean` that
// gates whether the trigger fires. In the original JS missions these were
// inline closures (e.g. `notHoldingAllNodes` in calebs-hollow-prologue.js).
// For the data-driven JSON mission format a trigger can only reference a
// condition by string key, so the named predicates live here and the loader
// resolves `condition: "notHoldingAllNodes"` → the function below.
//
// To add a new condition: append a named entry to `CONDITIONS`. Each entry is a
// pure `(state) => boolean`; it must not mutate state.
// ═══════════════════════════════════════════════════════════════════════════

import { countHeldNodes } from '../game.js';

// True when at least one Power Node is not currently hero-controlled.
// Used by The Long Watch's reminder story triggers — they should fire only
// while the hero hasn't yet completed the watch.
// (Moved verbatim from calebs-hollow-prologue.js.)
const notHoldingAllNodes = (state) =>
  countHeldNodes('hero', state.witchObjectives, state.entities)
    !== state.witchObjectives.length;

/**
 * Registry of named story-trigger conditions, keyed by the string used in
 * mission JSON.
 * @type {Record<string, (state: object) => boolean>}
 */
export const CONDITIONS = Object.freeze({
  notHoldingAllNodes,
});

/**
 * Resolve a condition by name.
 * @param {string} name
 * @returns {((state: object) => boolean) | null} the predicate, or null if unknown.
 */
export function resolveCondition(name) {
  if (!name) return null;
  return CONDITIONS[name] ?? null;
}
