// Shared flavour words for "the attack didn't connect" outcomes, used by the
// combat floaters/readouts (renderer-3d.js) and the replay timeline cards
// (replay-timeline.js). Kept in its own tiny module so the pure digest can pull
// the word picker without importing the Babylon renderer.

export const BLOCK_WORD_VARIANTS = Object.freeze([
  'miss', 'dodged', 'blocked', 'parried', 'deflected',
]);

/**
 * Deterministic pick from BLOCK_WORD_VARIANTS so the same combat result always
 * renders the same flavour word (matches the cinematic readout). Falls back to
 * the first variant when rolls aren't finite.
 *
 * @param {number} attackRoll
 * @param {number} defenseRoll
 * @returns {string} the chosen word, upper-cased.
 */
export function pickBlockWord(attackRoll, defenseRoll) {
  const a = Number.isFinite(attackRoll)  ? attackRoll  : 0;
  const d = Number.isFinite(defenseRoll) ? defenseRoll : 0;
  const idx = Math.abs((a * 31 + d * 7)) % BLOCK_WORD_VARIANTS.length;
  return BLOCK_WORD_VARIANTS[idx].toUpperCase();
}
