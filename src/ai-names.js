/**
 * Name banks for AI players in multiplayer games.
 * 17th-century New England themed names for heroes and witches.
 */

import { getFaction } from './factions.js';

export const AI_HERO_NAMES = Object.freeze([
  'Ezekiel Thorne',
  'Josiah Blackwood',
  'Obadiah Marsh',
  'Temperance Ironside',
  'Increase Hale',
  'Cotton Ward',
  'Abigail Steele',
  'Silence Graves',
]);

export const AI_WITCH_NAMES = Object.freeze([
  'Keziah Mason',
  'Tituba Hollow',
  'Agnes Nightshade',
  'Morwenna Blackthorn',
  'Elspeth Ravenscar',
  'Thomasin Darke',
  'Goody Hemlock',
  'Bathsheba Crowe',
]);

/**
 * Pick a random AI name not already in usedNames.
 * Falls back to "AI Hero #N" / "AI Witch #N" if pool exhausted.
 * @param {'hero'|'witch'} faction
 * @param {Set<string>} usedNames  names already taken in this room
 * @returns {string}
 */
export function pickAIName(faction, usedNames) {
  const def = getFaction(faction);
  const pool = def.getAINamePool();
  const available = pool.filter(n => !usedNames.has(n));

  if (available.length > 0) {
    const name = available[Math.floor(Math.random() * available.length)];
    usedNames.add(name);
    return name;
  }

  // Fallback: generate a numbered name
  const label = `AI ${def.name}`;
  let i = 1;
  while (usedNames.has(`${label} #${i}`)) i++;
  const fallback = `${label} #${i}`;
  usedNames.add(fallback);
  return fallback;
}
