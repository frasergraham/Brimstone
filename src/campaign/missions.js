// Shared objective type constants used by the victory delegate system.
// Campaign-specific mission definitions live in campaigns/*.js files.

/**
 * Objective type constants for win/lose conditions.
 */
/**
 * Check story triggers for the current round/state.
 * Returns array of triggered story events: [{title, text}]
 * Marks fired triggers in storyFlags so they don't fire again.
 */
export function processStoryTriggers(state, triggers, storyFlags) {
  if (!triggers) return [];
  const fired = [];
  for (const trigger of triggers) {
    if (trigger.flag && storyFlags[trigger.flag]) continue;

    // Optional `condition: (state) => bool` gates EVERY trigger type, not just
    // round triggers. The flag is not consumed when the predicate fails so the
    // same trigger can still fire on a later evaluation.
    if (typeof trigger.condition === 'function' && !trigger.condition(state)) continue;

    let shouldFire = false;
    if (trigger.type === 'round' && state.round === trigger.round) {
      shouldFire = true;
    } else if (trigger.type === 'area') {
      const hero = state.hero;
      if (hero && trigger.hexes?.some(h => h.col === hero.col && h.row === hero.row)) {
        shouldFire = true;
      }
    }
    if (shouldFire) {
      if (trigger.flag) storyFlags[trigger.flag] = true;
      fired.push({ title: trigger.title, text: trigger.text });
    }
  }
  return fired;
}

export const ObjectiveType = Object.freeze({
  ELIMINATE_ALL:   'eliminate_all',
  HERO_KILLED:     'hero_killed',
  SURVIVE_ROUNDS:  'survive_rounds',
  REACH_HEX:       'reach_hex',
  SLAY_WITCH:      'slay_witch',
  CONTROL_NODES:   'control_nodes',
  ROUNDS_EXCEEDED: 'rounds_exceeded',
});
