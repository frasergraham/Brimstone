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
 * Within one resolution step, actions drain highest-Agility first
 * (resolver._sortCandidates). When an attacker out-speeds a FLEEING target, the
 * strike resolves while the target is still on its start hex, THEN the target
 * moves — so that battle's snapshot of the unit sits on its PRE-move hex. The
 * step animator otherwise plays all moves before all battles, which would warp
 * such a unit back to its start hex for the strike and then zip it forward.
 *
 * Returns the set of entity ids whose MOVE this step must be deferred until
 * after the battle pass: a unit that both MOVES and is snapped by a battle on
 * its pre-move (entitySnapshot) hex. Pure — exported for tests.
 *
 * @param {Array}  events          — this step's ACTION_OK events (move + battle)
 * @param {Array}  entitySnapshot  — pre-step entity snapshot (positions)
 * @param {object} PlanActionType  — enum (injected to avoid a circular import)
 * @returns {Set<number|string>}
 */
export function deferredMoveEntityIds(events, entitySnapshot, PlanActionType) {
  const out = new Set();
  if (!events?.length) return out;
  // The position a battle this step captured for `id` (as target or attacker),
  // or null if the unit didn't fight.
  const battleSnapPosOf = (id) => {
    for (const ev of events) {
      const t = ev.action?.type;
      if (t !== PlanActionType.BATTLE_UNIT && t !== PlanActionType.BATTLE_HEX) continue;
      const bs = ev.battleSnaps;
      if (!bs) continue;
      if (bs.targetSnap?.id === id) return bs.targetSnap;
      if (bs.actorSnap?.id  === id) return bs.actorSnap;
    }
    return null;
  };
  for (const ev of events) {
    if (ev.action?.type !== PlanActionType.MOVE) continue;
    const id = ev.action.entityId;
    const pre = entitySnapshot?.find(e => e.id === id);
    if (!pre) continue;
    const path = ev.result?.path?.length > 0
      ? ev.result.path
      : [{ col: ev.action.toCol, row: ev.action.toRow }];
    const dest = path[path.length - 1];
    // Only a real relocation can warp; a no-op / blocked-to-start move is fine.
    if (dest.col === pre.col && dest.row === pre.row) continue;
    const bpos = battleSnapPosOf(id);
    // Battle captured the unit on its start hex ⇒ the strike resolved before the
    // move ⇒ defer the move until after the battle.
    if (bpos && bpos.col === pre.col && bpos.row === pre.row) out.add(id);
  }
  return out;
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
      // killedIds: entity ids this pair's battle(s) actually KILLED (from
      // result.killed, which flags the target). Lets compileTurnBattlePairs
      // credit a death to the one fight that caused it, so a unit that fought
      // several opponents isn't shown dead in every pair (carry: double skull).
      pairMap.set(key, { key, snapA, snapB, hpLostByA: 0, hpLostByB: 0, killedIds: new Set() });
    }
    const pair = pairMap.get(key);
    if (actorSnap.id === idA) {
      pair.hpLostByB += result.damage     ?? 0;
      pair.hpLostByA += result.counterDmg ?? 0;
    } else {
      pair.hpLostByA += result.damage     ?? 0;
      pair.hpLostByB += result.counterDmg ?? 0;
    }
    if (result.killed) pair.killedIds.add(targetSnap.id);
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
  const pairs = _aggregateBattlePairs(steps, ResEventType, PlanActionType);

  // A unit that died this round must show its skull EXACTLY ONCE, even if it
  // fought several opponents — otherwise the wrap-up double-reports the death
  // (the bug). Credit the kill to the battle whose result.killed flagged it;
  // when no single result owns the death (counter-kill of an attacker, splash),
  // fall back to the first pair the unit appears in. `killPair` maps a dead
  // entity id → the pair that gets its skull.
  const killPair = new Map();
  for (const p of pairs) {
    for (const id of p.killedIds) {
      if (!killPair.has(id)) killPair.set(id, p);
    }
  }
  const shown = new Set(); // dead ids already given a skull

  const unit = (snap, hpLost, killed) => ({
    id: snap.id, type: snap.type, title: snap.title ?? null,
    name: snap.title ?? snap.displayName ?? 'Unit',
    color: snap.color ?? null,
    hpLost,
    killed,
  });

  const killedHere = (snap, pair) => {
    if (shown.has(snap.id) || !_wasKilled(snap, finalEntities)) return false;
    // Credited pair = the explicit kill pair, or (no explicit kill anywhere)
    // the first pair we meet the unit in.
    const credit = killPair.get(snap.id);
    if (credit ? credit === pair : true) { shown.add(snap.id); return true; }
    return false;
  };

  return pairs.map((p) => ({
    a: unit(p.snapA, p.hpLostByA, killedHere(p.snapA, p)),
    b: unit(p.snapB, p.hpLostByB, killedHere(p.snapB, p)),
  }));
}

/**
 * Collect a turn's survivor/zombie discoveries and explore-loot icons for the
 * end-of-turn wrap-up card.
 *
 * Both loot AND discoveries are the player's faction only. Each faction's
 * explore resources go to its own inventory, so counting the AI's loot here
 * double-shows shared icons (both sides finding wood reads as "🪵 ×2"); and a
 * survivor the opponent surfaced is information the player shouldn't get. We
 * gate both on `humanFaction` (`ev.faction === humanFaction`); null counts all.
 *
 * @param {Array}  steps        — StepRecord[] (heroEvents/witchEvents or playerEvents).
 * @param {string|null} humanFaction — 'hero' | 'witch' | null (null ⇒ count all).
 * @returns {{ discoveries: Array, loot: string[] }}
 */
export function collectTurnFinds(steps, humanFaction = null) {
  const discoveries = [];
  const loot = [];
  for (const step of steps ?? []) {
    const evs = [
      ...(step.heroEvents  ?? []),
      ...(step.witchEvents ?? []),
      ...(step.playerEvents ?? []).flatMap(pe =>
        (pe.events ?? []).map(e => (e.faction ? e : { ...e, faction: pe.faction }))),
    ];
    for (const ev of evs) {
      // Faction-filter both finds: only surface the player's own survivors + loot.
      if (humanFaction && ev.faction && ev.faction !== humanFaction) continue;
      const found = ev.result?.encounterSurvivors
        ?? (ev.result?.encounterSurvivor ? [ev.result.encounterSurvivor] : []);
      for (const f of found) discoveries.push(f);
      for (const item of (ev.result?.lootItems ?? [])) {
        if (item && item !== 'nothing') loot.push(item);
      }
    }
  }
  return { discoveries, loot };
}
