// Pure helpers for battle classification — no DOM, no state dependencies.
import { EntityType } from './entities.js';

// Returns true when a battle warrants the full cinematic dialog rather than a toast.
// Significant = Hero/Witch involved, a kill occurred, or the human's side is under attack.
export function isBattleSignificant(actorSnap, targetSnap, result, humanFaction) {
  if (actorSnap.type === EntityType.HERO  || actorSnap.type === EntityType.WITCH)  return true;
  if (targetSnap.type === EntityType.HERO || targetSnap.type === EntityType.WITCH) return true;
  if (result?.killed) return true;
  if (humanFaction && targetSnap.owner === humanFaction) return true;
  return false;
}
