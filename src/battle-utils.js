// Pure helpers for battle classification — no DOM, no state dependencies.
import { EntityType } from './entities.js';

// Returns true when a battle warrants the full cinematic dialog rather than a toast.
// Hero/Witch fights only qualify if HP actually moved — a clean miss between major
// units is narrated fine as a toast.
export function isBattleSignificant(actorSnap, targetSnap, result, humanFaction) {
  // A kill always warrants the full dialog
  if (result?.killed) return true;
  // The human player's units being attacked is always shown in full
  if (humanFaction && targetSnap.owner === humanFaction) return true;
  // Hero/Witch involvement only matters when damage was dealt
  const anyDamage = (result?.damage ?? 0) > 0 || (result?.counterDmg ?? 0) > 0;
  if (anyDamage) {
    if (actorSnap.type === EntityType.HERO  || actorSnap.type === EntityType.WITCH)  return true;
    if (targetSnap.type === EntityType.HERO || targetSnap.type === EntityType.WITCH) return true;
  }
  return false;
}
