// Shared objective type constants used by the victory delegate system.
// Campaign-specific mission definitions live in campaigns/*.js files.

/**
 * Objective type constants for win/lose conditions.
 */
export const ObjectiveType = Object.freeze({
  ELIMINATE_ALL:   'eliminate_all',
  HERO_KILLED:     'hero_killed',
  SURVIVE_ROUNDS:  'survive_rounds',
  REACH_HEX:       'reach_hex',
  SLAY_WITCH:      'slay_witch',
  CONTROL_NODES:   'control_nodes',
  ROUNDS_EXCEEDED: 'rounds_exceeded',
});
