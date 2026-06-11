// Shared objective type constants used by the victory delegate system.
// Campaign-specific mission definitions live in campaigns/*.js files.

/**
 * Objective type constants for win/lose conditions.
 */
/**
 * Does a single story trigger match the current state? Shared by the
 * round-boundary pass below and the mid-replay conversation interleaver in
 * main.js (which probes area triggers against live entity positions between
 * resolution steps).
 */
export function storyTriggerMatches(state, trigger) {
  // Optional `condition: (state) => bool` gates EVERY trigger type, not just
  // round triggers. The flag is not consumed when the predicate fails so the
  // same trigger can still fire on a later evaluation.
  if (typeof trigger.condition === 'function' && !trigger.condition(state)) return false;

  if (trigger.type === 'round') return state.round === trigger.round;
  if (trigger.type === 'area') {
    const hero = state.hero;
    return !!(hero && trigger.hexes?.some(h => h.col === hero.col && h.row === hero.row));
  }
  return false;
}

/**
 * Dedup gate shared by both trigger passes. Text triggers dedupe via the
 * persistent campaign `storyFlags` (require a `flag`). Conversation triggers
 * without a `flag` dedupe per mission attempt via `state._firedConversations`
 * — so e.g. a mission-intro conversation replays on every retry.
 */
function _alreadyFired(state, trigger, storyFlags) {
  if (trigger.flag) return !!storyFlags[trigger.flag];
  if (trigger.conversation) return !!state._firedConversations?.has(trigger.conversation);
  return false;
}

function _markFired(state, trigger, storyFlags) {
  if (trigger.flag) storyFlags[trigger.flag] = true;
  if (trigger.conversation) {
    (state._firedConversations ??= new Set()).add(trigger.conversation);
  }
}

/**
 * Check story triggers for the current round/state.
 * Returns array of triggered story events: [{title, text, conversation}]
 * (`conversation` is a mission `conversations[]` id; text fields are absent on
 * conversation triggers and vice versa).
 * Marks fired triggers in storyFlags / state._firedConversations so they
 * don't fire again.
 */
export function processStoryTriggers(state, triggers, storyFlags, { only = null } = {}) {
  if (!triggers) return [];
  const fired = [];
  for (const trigger of triggers) {
    if (only === 'conversation' && !trigger.conversation) continue;
    if (_alreadyFired(state, trigger, storyFlags)) continue;
    if (!storyTriggerMatches(state, trigger)) continue;
    _markFired(state, trigger, storyFlags);
    fired.push({ title: trigger.title, text: trigger.text, conversation: trigger.conversation });
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
