// Pure helpers for battle classification — no DOM, no state dependencies.
import { EntityType, isLeaderType } from './entities.js';

// Returns true when a battle warrants the full cinematic dialog rather than a toast.
// Leader fights only qualify if HP actually moved — a clean miss between major
// units is narrated fine as a toast.
export function isBattleSignificant(actorSnap, targetSnap, result, humanFaction) {
  // A kill always warrants the full dialog
  if (result?.killed) return true;
  // The human player's units being attacked is always shown in full
  if (humanFaction && targetSnap.owner === humanFaction) return true;
  // Leader involvement only matters when damage was dealt. Covers all six
  // faction leader types — stubs as well as side primaries.
  const anyDamage = (result?.damage ?? 0) > 0 || (result?.counterDmg ?? 0) > 0;
  if (anyDamage) {
    if (isLeaderType(actorSnap.type))  return true;
    if (isLeaderType(targetSnap.type)) return true;
  }
  return false;
}

/**
 * Aggregate all battle events across a resolved turn into per-pair damage reports.
 *
 * steps         — StepRecord[] from resolvePlans / resolvePlansMP
 * finalEntities — post-resolution entity array (used to detect kills)
 * ResEventType  — the ResEventType enum (passed in to avoid circular deps)
 * PlanActionType— the PlanActionType enum (passed in to avoid circular deps)
 *
 * Returns an array of log strings, e.g.:
 *   "⚔ Hero vs Witch: Hero −2HP, Witch −4HP 💀"
 * Only pairs that actually dealt damage are included.
 */
// Shared aggregation: collect every battle/guard event and merge by entity pair
// (A-attacks-B and B-attacks-A merge), summing HP lost by each side. Returns the
// pairMap values: { snapA, snapB, hpLostByA, hpLostByB }.
function _aggregateBattlePairs(steps, ResEventType, PlanActionType) {
  const battleEvents = [];
  for (const step of steps) {
    const allEvents = [
      ...(step.heroEvents  ?? []),
      ...(step.witchEvents ?? []),
      ...(step.playerEvents ?? []).flatMap(pe => pe.events ?? []),
    ];
    for (const ev of allEvents) {
      if (ev.type === ResEventType.ACTION_OK &&
          (ev.action.type === PlanActionType.BATTLE_UNIT || ev.action.type === PlanActionType.BATTLE_HEX) &&
          ev.battleSnaps) {
        battleEvents.push({ actorSnap: ev.battleSnaps.actorSnap, targetSnap: ev.battleSnaps.targetSnap, result: ev.result });
      }
      if (ev.type === ResEventType.GUARD_STRIKE && ev.battleSnaps) {
        battleEvents.push({ actorSnap: ev.battleSnaps.actorSnap, targetSnap: ev.battleSnaps.targetSnap, result: ev.result });
      }
    }
  }

  const pairMap = new Map();
  for (const { actorSnap, targetSnap, result } of battleEvents) {
    const [idA, idB] = actorSnap.id < targetSnap.id
      ? [actorSnap.id, targetSnap.id]
      : [targetSnap.id, actorSnap.id];
    const key = `${idA}:${idB}`;
    if (!pairMap.has(key)) {
      const [snapA, snapB] = actorSnap.id === idA
        ? [actorSnap, targetSnap]
        : [targetSnap, actorSnap];
      pairMap.set(key, { snapA, snapB, hpLostByA: 0, hpLostByB: 0 });
    }
    const pair = pairMap.get(key);
    if (actorSnap.id === idA) {
      pair.hpLostByB += result.damage     ?? 0;
      pair.hpLostByA += result.counterDmg ?? 0;
    } else {
      pair.hpLostByA += result.damage     ?? 0;
      pair.hpLostByB += result.counterDmg ?? 0;
    }
  }
  return [...pairMap.values()];
}

const _wasKilled = (snap, finalEntities) =>
  !finalEntities.find(e => e.id === snap.id) || !!finalEntities.find(e => e.id === snap.id && !e.alive);

export function compileTurnBattleSummary(steps, finalEntities, ResEventType, PlanActionType) {
  const lines = [];
  for (const { snapA, snapB, hpLostByA, hpLostByB } of _aggregateBattlePairs(steps, ResEventType, PlanActionType)) {
    if (hpLostByA === 0 && hpLostByB === 0) continue;
    const nameA  = snapA.title ?? snapA.displayName ?? 'Unit';
    const nameB  = snapB.title ?? snapB.displayName ?? 'Unit';
    const aKilled = _wasKilled(snapA, finalEntities);
    const bKilled = _wasKilled(snapB, finalEntities);
    const parts = [];
    if (hpLostByA > 0) parts.push(`${nameA} \u2212${hpLostByA}HP${aKilled ? ' \u{1F480}' : ''}`);
    if (hpLostByB > 0) parts.push(`${nameB} \u2212${hpLostByB}HP${bKilled ? ' \u{1F480}' : ''}`);
    lines.push(`\u2694 ${nameA} vs ${nameB}: ${parts.join(', ')}`);
  }
  return lines;
}

/**
 * Structured per-pair combat report for the end-of-turn wrap-up card: each pair
 * as { a, b } where a/b = { id, type, title, name, color, hpLost, killed }.
 * EVERY pair that fought is included — even clean misses with no damage (so the
 * card shows the combat happened rather than calling it a "quiet turn"); the
 * card renders "—" under a unit that took no damage.
 */
export function compileTurnBattlePairs(steps, finalEntities, ResEventType, PlanActionType) {
  const unit = (snap, hpLost) => ({
    id: snap.id, type: snap.type, title: snap.title ?? null,
    name: snap.title ?? snap.displayName ?? 'Unit',
    color: snap.color ?? null,
    hpLost,
    killed: _wasKilled(snap, finalEntities),
  });
  return _aggregateBattlePairs(steps, ResEventType, PlanActionType)
    .map(({ snapA, snapB, hpLostByA, hpLostByB }) => ({
      a: unit(snapA, hpLostByA), b: unit(snapB, hpLostByB),
    }));
}
