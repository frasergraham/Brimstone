// Simultaneous-turn resolution engine.
// Receives both factions' submitted plans and executes them in paired steps,
// applying skip logic and budget enforcement.
//
// Imports only from src/ — no DOM, no WebSocket.

import {
  executeMove, executeExplore, executeBattle,
  executeFortify, executeSummon, executeHeal, executeUseItem, executeUseAbility,
  executeGuard, executeSoundHorn, executeFortAssault,
  hasLineOfSight,
} from '../src/actions.js';
import { FORT_IMPASSABLE_THRESHOLD } from '../src/tiles.js';
import { EntityType, isLeaderType, normalizeItems, rangeOf, getItemCountOf, removeItemInItems } from '../src/entities.js';
import { hexDistance, hexKey } from '../src/hex.js';
import { PlanActionType, snapEntity, groupPlanByEntity } from '../src/planner.js';
import { Phase, countHeldNodes } from '../src/game.js';
import { ResourceType } from '../src/tiles.js';
import { getFaction, sightRangeForEntity } from '../src/factions.js';
import { effectsBlockActions } from '../src/effects.js';

// groupByEntity removed — now uses groupPlanByEntity from planner.js
const groupByEntity = groupPlanByEntity;

// Parse numeric id from "eN" so e2 < e10 (numeric, not lexicographic).
function _entityIdNum(id) {
  const n = parseInt(String(id ?? '').slice(1), 10);
  return Number.isNaN(n) ? 0 : n;
}

// Build & sort drain candidates for one step, highest agility first,
// ties broken by ascending numeric entity id. Dead/missing actors sort last.
function _sortCandidates(state, candidates) {
  for (const c of candidates) {
    const actor = state.entities.find(e => e.id === c.entityId && e.alive);
    // Use getAgility() so effects (slowed → -1) actually shift lockstep order.
    // Falls back to raw agility for plain-object fixtures missing the method.
    c.agility = actor
      ? (typeof actor.getAgility === 'function' ? actor.getAgility() : (actor.agility ?? 1))
      : -Infinity;
    c.idNum = _entityIdNum(c.entityId);
  }
  candidates.sort((a, b) => (b.agility - a.agility) || (a.idNum - b.idNum));
  return candidates;
}

// Project each acting unit's END-OF-TURN hex for this step: a unit whose next
// action is a MOVE will stand on its destination; everyone else stays put.
// executeBattle reads this (via `state._turnEndPositions`) so gang-up allies are
// counted by where they end the TURN, not where they start it — moves are
// simultaneous with battles, so an ally moving out of range this same turn no
// longer flanks (and one moving into range does).
function computeTurnEndPositions(candidates) {
  const map = new Map();
  for (const c of candidates) {
    const front = c.queue[0];
    if (front && front.type === PlanActionType.MOVE &&
        Number.isInteger(front.toCol) && Number.isInteger(front.toRow)) {
      map.set(c.entityId, { col: front.toCol, row: front.toRow });
    }
  }
  return map;
}

// ── Event types ──────────────────────────────────────────────────────────────

export const ResEventType = Object.freeze({
  ACTION_OK:      'action_ok',      // executed successfully; result payload attached
  ACTION_SKIP:    'action_skip',    // battle target gone/dead — free skip, later steps run
  ACTION_FAIL:    'action_fail',    // hard failure — plan halts for this faction
  BUDGET_CAP:     'budget_cap',     // budget exhausted; remaining plan ignored
  FOOD_CONSUMED:  'food_consumed',  // ration auto-consumed to fund one over-budget action
  GUARD_STRIKE:   'guard_strike',   // reactive attack from a guarding unit
  XP_AWARDED:     'xp_awarded',     // campaign veterancy — a unit earned XP (one event per logical award)
});

// Campaign veterancy: fan a result's per-award `xpAwards` (attached by the
// execute* functions in actions.js) out into discrete XP_AWARDED step events,
// tagged with the owning faction for fog filtering + bucket routing. Each event
// is one logical award (kill / combat hit / explore / fortify / gang-up share);
// the replay aggregates them into a single "+N XP" line per unit per turn. A
// no-op outside campaign (xpAwards is only attached when awardXP actually
// granted XP), so normal/online play carries no XP events.
function _emitXpEvents(result, faction, subEvents) {
  for (const a of (result?.xpAwards ?? [])) {
    subEvents.push({ type: ResEventType.XP_AWARDED, faction, ...a });
  }
}

// ── Budget calculation ───────────────────────────────────────────────────────
// Mirrors computeActions / computeActionsForPlayer in game.js without importing
// them directly (avoiding circular dependencies).

/** Faction-level budget — used by the legacy 2-player resolvePlans wrapper. */
function budgetFor(state, faction) {
  const factionObj = getFaction(faction);
  const extras = state.entities.filter(
    e => e.alive && e.owner === faction && e.type !== factionObj.leaderType
  ).length;
  const nodeBonus = countHeldNodes(faction, state.witchObjectives ?? [], state.entities);
  return factionObj.computeBudget(state.phase, extras, nodeBonus);
}

/** Per-player budget — used by resolvePlansMP. */
function budgetForPlayer(state, playerId, faction) {
  const factionObj = getFaction(faction);
  const extras = state.entities.filter(
    e => e.alive && e.ownerId === playerId && e.type !== factionObj.leaderType
  ).length;
  const nodeBonus = countHeldNodes(faction, state.witchObjectives ?? [], state.entities);
  return factionObj.computeBudget(state.phase, extras, nodeBonus);
}

// ── Leader-death scatter ─────────────────────────────────────────────────────
// When a HERO or WITCH leader entity is killed in battle, scatter their
// owned units back to the map as hidden survivors / remove summons.
// Delegates to state.scatterPlayerUnits() which is defined in game.js.

function _handleLeaderDeath(state, killedEntity) {
  if (!isLeaderType(killedEntity.type) || !killedEntity.ownerId) return;
  if (typeof state.scatterPlayerUnits === 'function') {
    state.scatterPlayerUnits(killedEntity.ownerId);
  }
}

// ── Single-action executor ───────────────────────────────────────────────────
//
// Returns one of:
//   { kind: 'ok',   result, battleSnaps? }   — action ran, consume budget
//   { kind: 'skip', reason }                  — battle target gone, free skip
//   { kind: 'fail', reason }                  — hard failure, halt faction plan

/**
 * @param {object} state
 * @param {object} action
 * @param {string} faction  - 'hero' | 'witch' (used for legacy 2-player path)
 * @param {string|null} playerId - null in legacy path; UUID in multiplayer
 */
function runAction(state, action, faction, playerId = null) {
  const entity = state.entities.find(e => e.id === action.entityId && e.alive);
  if (!entity) return { kind: 'skip', reason: 'Entity no longer exists.' };
  // Multiplayer: validate by ownerId. Offline fallback: validate by faction.
  if (playerId !== null) {
    if (entity.ownerId !== playerId) return { kind: 'fail', reason: 'Entity belongs to another player.' };
  } else {
    if (entity.owner !== faction) return { kind: 'fail', reason: 'Wrong faction.' };
  }

  // Stunned (and any future blocking effect): silently skip the action so
  // later steps in the same plan still run. The effect itself decrements at
  // round-end via post-round-effects, so a 1-round stun blocks exactly the
  // round it was applied in.
  if (effectsBlockActions(entity)) {
    return { kind: 'skip', reason: `${entity.displayName} is stunned and cannot act.` };
  }

  switch (action.type) {

    case PlanActionType.MOVE: {
      const r = executeMove(state, entity, action.toCol, action.toRow);
      if (!r.success) return {
        kind: 'fail', reason: r.log[0],
        blockedBy: r.blockedBy ?? null,
        blockedByFort: r.blockedByFort ?? null,
      };
      return { kind: 'ok', result: r };
    }

    case PlanActionType.EXPLORE: {
      const r = executeExplore(state, entity);
      if (!r.success) return { kind: 'fail', reason: r.log[0] };
      return { kind: 'ok', result: r };
    }

    case PlanActionType.BATTLE_UNIT: {
      // Ranged units (range > 1) can strike any enemy within their attack
      // range; melee units remain adjacency-only. Fort assault is melee-only
      // and still capped at range 1 below (ranged units can't batter walls).
      const attackerRange = typeof entity.getRange === 'function' ? entity.getRange() : (entity.range ?? 1);
      let target = state.entities.find(e => e.id === action.targetId && e.alive);

      let fledTarget = null; // alive but out of reach — distinct from dead/gone
      if (target) {
        const dist = hexDistance(entity.col, entity.row, target.col, target.row);
        if (dist > attackerRange) { fledTarget = target; target = null; }
      }

      // Fallback: original target gone/moved — attack another enemy on the planned hex
      if (!target && action.targetCol != null && action.targetRow != null) {
        const dist = hexDistance(entity.col, entity.row, action.targetCol, action.targetRow);
        if (dist <= attackerRange) {
          const enemies = state.entities.filter(
            e => e.alive && e.owner !== faction &&
                 e.col === action.targetCol && e.row === action.targetRow
          );
          if (enemies.length > 0) {
            target = enemies[Math.floor(Math.random() * enemies.length)];
          }
        }
      }

      if (!target) {
        // Target is alive but moved out of reach this turn — surface a
        // distinct "fled" skip so the replay/animation layer can show the
        // attacker swinging at the planned hex instead of a generic skip.
        if (fledTarget) {
          const name = fledTarget.displayName ?? fledTarget.name ?? 'Target';
          const inReach = Number.isInteger(action.targetCol) && Number.isInteger(action.targetRow) &&
            hexDistance(entity.col, entity.row, action.targetCol, action.targetRow) <= attackerRange;
          return {
            kind: 'skip',
            reason: `${name} slipped away — out of reach.`,
            targetFled: true,
            battleSnaps: inReach ? { actorSnap: snapEntity(entity), ranged: attackerRange > 1 } : null,
            whiffTarget: inReach ? { col: action.targetCol, row: action.targetRow } : null,
          };
        }
        return { kind: 'skip', reason: 'Target is dead or gone.' };
      }

      const actorSnap  = snapEntity(entity);
      const targetSnap = snapEntity(target);
      const r = executeBattle(state, entity, target);
      if (!r.success) return { kind: 'fail', reason: r.log[0] };
      // Scatter units when a leader is slain (by hit, counter-attack, or splash)
      if (r.killed)  _handleLeaderDeath(state, target);
      if (r.counterDmg > 0 && !state.entities.some(e => e.id === entity.id))
        _handleLeaderDeath(state, entity);
      for (const sk of r.splashKills ?? []) _handleLeaderDeath(state, sk);
      return {
        kind: 'ok',
        result: r,
        battleSnaps: { actorSnap, targetSnap, ranged: !!r.ranged },
      };
    }

    case PlanActionType.BATTLE_HEX: {
      const attackerRange = typeof entity.getRange === 'function' ? entity.getRange() : (entity.range ?? 1);
      const dist = hexDistance(entity.col, entity.row, action.targetCol, action.targetRow);
      if (dist > attackerRange) return { kind: 'skip', reason: 'Target hex out of range.' };

      const enemies = state.entities.filter(
        e => e.alive && e.owner !== faction &&
             e.col === action.targetCol && e.row === action.targetRow
      );
      if (enemies.length === 0) {
        const actorSnap = snapEntity(entity);
        // Witch siege: if no enemy is on the hex but a wall (fort >= threshold)
        // stands there, battering it reduces its level. Otherwise whiff. Fort
        // assault is melee-only — ranged attackers cannot batter walls at a
        // distance. The dist <= 1 gate below keeps this constraint.
        const targetTile = state.tiles.get(hexKey(action.targetCol, action.targetRow));
        if (dist <= 1 && getFaction(entity.owner).canAssaultFortifications() && targetTile &&
            (targetTile.fortifyLevel || 0) >= FORT_IMPASSABLE_THRESHOLD) {
          const r = executeFortAssault(state, entity, action.targetCol, action.targetRow);
          if (!r.success) return { kind: 'fail', reason: r.log[0] };
          return { kind: 'ok', result: r, battleSnaps: { actorSnap } };
        }
        return {
          kind: 'skip',
          reason: 'No enemy on target hex.',
          battleSnaps: { actorSnap, ranged: attackerRange > 1 },
          whiffTarget: { col: action.targetCol, row: action.targetRow },
        };
      }

      // Pick a random enemy when multiple units occupy the hex
      const target     = enemies[Math.floor(Math.random() * enemies.length)];
      const actorSnap  = snapEntity(entity);
      const targetSnap = snapEntity(target);
      const r = executeBattle(state, entity, target);
      if (!r.success) return { kind: 'fail', reason: r.log[0] };
      if (r.killed)  _handleLeaderDeath(state, target);
      if (r.counterDmg > 0 && !state.entities.some(e => e.id === entity.id))
        _handleLeaderDeath(state, entity);
      for (const sk of r.splashKills ?? []) _handleLeaderDeath(state, sk);
      return {
        kind: 'ok',
        result: r,
        battleSnaps: { actorSnap, targetSnap, ranged: !!r.ranged },
      };
    }

    case PlanActionType.FORTIFY: {
      const r = executeFortify(state, entity);
      if (!r.success) return { kind: 'fail', reason: r.log[0] };
      return { kind: 'ok', result: r };
    }

    case PlanActionType.GUARD: {
      const r = executeGuard(state, entity);
      if (!r.success) return { kind: 'fail', reason: r.log[0] };
      return { kind: 'ok', result: r };
    }

    case PlanActionType.SOUND_HORN: {
      const r = executeSoundHorn(state, entity);
      if (!r.success) return { kind: 'fail', reason: r.log[0] };
      return { kind: 'ok', result: r };
    }

    case PlanActionType.SUMMON: {
      const r = executeSummon(state, entity, action.summonType ?? null);
      if (!r.success) return { kind: 'fail', reason: r.log[0] };
      return { kind: 'ok', result: r };
    }

    case PlanActionType.HEAL: {
      const r = executeHeal(state, entity);
      if (!r.success) return { kind: 'fail', reason: r.log[0] };
      return { kind: 'ok', result: r };
    }

    case PlanActionType.USE_ITEM: {
      const r = executeUseItem(state, entity, action.item);
      if (!r.success) return { kind: 'fail', reason: r.log[0] };
      // budgetBonus is now returned directly by executeUseItem (e.g. Food → +1)
      return { kind: 'ok', result: r, budgetBonus: r.budgetBonus ?? 0 };
    }

    case PlanActionType.EQUIP_WEAPON: {
      // Equip is free and always succeeds if the weapon is present.
      const r = executeUseItem(state, entity, action.weapon);
      if (!r.success) return { kind: 'fail', reason: r.log[0] };
      return { kind: 'ok', result: r };
    }

    case PlanActionType.USE_ABILITY: {
      const r = executeUseAbility(state, entity, action.ability);
      if (!r.success) return { kind: 'fail', reason: r.log[0] };
      // budgetBonus returned directly by executeUseAbility (e.g. Rally → +1)
      return { kind: 'ok', result: r, budgetBonus: r.budgetBonus ?? 0 };
    }

    default:
      return { kind: 'fail', reason: `Unknown plan action type: ${action.type}` };
  }
}

// ── Drain one faction's queue for a single logical step ─────────────────────
//
// A "step" consumes at most one action-point from the faction's budget.
// Free-skips (battle target gone) consume no budget and allow the next queued
// action to try immediately within the same step.
//
// Returns an array of sub-events for this step (could be multiple if skips
// chain before a hit or hard failure), plus any budget adjustment.

function drainOneStep(state, queue, budget) {
  const subEvents = [];

  // If budget is exhausted but actions remain, try to spend a food ration to
  // fund one more action.  Emit FOOD_CONSUMED in the SAME step as the
  // food-powered action so the animation layer can show the floater at the
  // right moment.
  if (budget.remaining <= 0 && queue.length > 0) {
    const heroInv = state.inventory?.hero ?? {};
    if (getItemCountOf(heroInv, ResourceType.FOOD) > 0) {
      removeItemInItems(heroInv, ResourceType.FOOD, 1);
      budget.remaining += 1;
      state.addLog(`🍞 Rations consumed — pressing on beyond the action limit.`, budget.faction);
      subEvents.push({ type: ResEventType.FOOD_CONSUMED, faction: budget.faction });
    } else {
      subEvents.push({ type: ResEventType.BUDGET_CAP, faction: budget.faction, action: queue[0] });
      queue.length = 0;
      return subEvents;
    }
  }

  let resolvedAction = null;   // track for guard-strike check
  let resolvedEntity = null;

  while (queue.length > 0 && budget.remaining > 0) {
    const action = queue[0];
    const out = runAction(state, action, budget.faction, budget.playerId ?? null);

    if (out.kind === 'ok') {
      const cost = out.result.cost ?? 1;
      budget.remaining -= cost;
      budget.remaining += out.budgetBonus ?? 0;  // Food / Rally bonus
      queue.shift();

      const actingEntity = state.entities.find(e => e.id === action.entityId);
      const pColor = (typeof state.playerColorFor === 'function')
        ? state.playerColorFor(actingEntity)
        : null;
      for (const msg of out.result.log ?? []) state.addLog(msg, budget.faction, pColor);

      subEvents.push({
        type:        ResEventType.ACTION_OK,
        faction:     budget.faction,
        action,
        result:      out.result,
        battleSnaps: out.battleSnaps ?? null,
      });
      // Campaign veterancy: surface any XP this action granted as its own
      // XP_AWARDED step events (right after the action that earned them).
      _emitXpEvents(out.result, budget.faction, subEvents);

      resolvedAction = action;
      resolvedEntity = actingEntity?.alive ? actingEntity : null;
      break; // consumed one slot — done with this step

    } else if (out.kind === 'skip') {
      queue.shift(); // free skip — advance pointer without charging budget
      subEvents.push({
        type:        ResEventType.ACTION_SKIP,
        faction:     budget.faction,
        action,
        reason:      out.reason,
        targetFled:  out.targetFled ?? false,
        battleSnaps: out.battleSnaps ?? null,
        whiffTarget: out.whiffTarget ?? null,
      });
      // Loop: try the next action in the same step

    } else {
      // Hard failure — skip this action but let remaining plan continue
      queue.shift();
      subEvents.push({
        type:          ResEventType.ACTION_FAIL,
        faction:       budget.faction,
        action,
        reason:        out.reason,
        blockedBy:     out.blockedBy ?? null,
        blockedByFort: out.blockedByFort ?? null,
      });
      // Loop: try the next action in the same step
    }
  }

  // ── Guard strike check ──────────────────────────────────────────────────
  // After a successful action, check if any enemy guards are adjacent to the
  // action's target hex.  Each guarding enemy gets a free reactive attack.
  if (resolvedAction && resolvedEntity) {
    _checkGuardStrikes(state, resolvedAction, resolvedEntity, budget.faction, subEvents);
  }

  return subEvents;
}

// Determine the hex that triggered guard reactions and run guard strikes.
function _checkGuardStrikes(state, action, actor, faction, subEvents) {
  // Determine the "trigger hex" — where the acting entity performed its action
  let triggerCol, triggerRow;
  if (action.type === PlanActionType.MOVE) {
    triggerCol = action.toCol;
    triggerRow = action.toRow;
  } else {
    // For all other actions, the actor's current position is the trigger
    triggerCol = actor.col;
    triggerRow = actor.row;
  }

  // Find enemy guarding entities within reach of the trigger hex (charges > 0).
  // Melee guards (range 1) react to adjacent hexes only. Ranged guards
  // (getRange() > 1) react out to their attack range, but a guard strike is a
  // DIRECT attack: a unit can only strike a hex it can actually SEE. So the
  // reach is capped by the guard's own (phase-dependent) sight distance AND a
  // clear line of sight — never fire into fog. (Blind BATTLE_HEX fire is the
  // separate exception that ignores LOS but still respects range.) The
  // guard-area highlight in the renderer mirrors this same capped reach.
  const guardians = state.entities.filter(e => {
    if (!(e.alive && (e.guarding > 0) && e.owner !== faction)) return false;
    const gRange = (typeof e.getRange === 'function' ? e.getRange() : (e.range ?? 1));
    const dist = hexDistance(e.col, e.row, triggerCol, triggerRow);
    if (gRange > 1) {
      const reach = Math.min(gRange, sightRangeForEntity(e, state.phase));
      return dist <= reach &&
        hasLineOfSight(state, e.col, e.row, triggerCol, triggerRow);
    }
    return dist <= 1;
  });

  for (const guardian of guardians) {
    if (!actor.alive) break;  // stop if target was killed by a prior guard strike
    if (guardian.guarding <= 0) continue;  // charges exhausted by prior strike this step

    // A guard reaction is just a regular attack the resolver inserts inline —
    // NOT a special-cased "guard strike". It runs through executeBattle and is
    // emitted as a normal ACTION_OK BATTLE_UNIT event, so it serializes, replays,
    // and animates identically to a planned attack. Guard reactions take NO
    // counter, NEVER crush, and get NO gang-up (noCounter/noCrush/noAlly) —
    // matching the pre-refactor guard strike so balance stays neutral (a
    // full-attack guard counter-killed the hero leader, and gang-up let the
    // swarm stack reactions, both spiking witch win rate). `guardReaction` is a
    // cosmetic label marker.
    const chargesBefore = guardian.guarding;
    const actorSnap  = snapEntity(guardian);
    const targetSnap = snapEntity(actor);
    const r = executeBattle(state, guardian, actor, { noCounter: true, noCrush: true, noAlly: true });
    if (!r.success) continue;

    // executeBattle zeroes the attacker's guard stance (attacking breaks guard);
    // restore the guardian's REMAINING charges (minus this one) so a multi-charge
    // guard can still react to other movers this round.
    guardian.guarding = Math.max(0, chargesBefore - 1);

    const gColor = (typeof state.playerColorFor === 'function')
      ? state.playerColorFor(guardian)
      : null;
    for (const msg of r.log ?? []) state.addLog(msg, guardian.owner, gColor);

    subEvents.push({
      type:         ResEventType.ACTION_OK,
      faction:      guardian.owner,
      guardReaction: true,
      action:       { type: PlanActionType.BATTLE_UNIT, entityId: guardian.id, targetId: actor.id },
      result:       r,
      battleSnaps:  { actorSnap, targetSnap, ranged: !!r.ranged },
    });
    // Campaign veterancy: a guard reaction is a real attack — credit any XP it
    // earned the guardian to the same step stream.
    _emitXpEvents(r, guardian.owner, subEvents);

    if (r.killed) _handleLeaderDeath(state, actor);
    for (const sk of r.splashKills ?? []) _handleLeaderDeath(state, sk);
  }
}

// ── Entity snapshot ──────────────────────────────────────────────────────────
// Captures a lightweight copy of every entity's renderable + mutable fields.
// Used so the animation layer can display the world state at each resolution
// step without holding back the actual state mutation.

function snapshotEntities(entities) {
  return entities.map(e => ({
    id:            e.id,
    col:           e.col,
    row:           e.row,
    slot:          e.slot ?? 0,
    hp:            e.hp,
    maxHp:         e.maxHp,
    alive:         e.alive,
    owner:         e.owner,
    ownerId:       e.ownerId ?? null,
    type:          e.type,
    // Equipped weapon rides inside `items` (tagged equipped); deep-copy so the
    // re-parented display clones (main.js) render the right weapon/mount. Range
    // is weapon-derived via getRange()/rangeOf().
    items:         normalizeItems(e.items),
    abilities:     Array.isArray(e.abilities) ? [...e.abilities] : [],
    attack:        e.attack,
    defense:       e.defense,
    agility:       e.agility,
    range:         rangeOf(e),
    fortification: e.fortification,
    guarding:      e.guarding ?? 0,
    displayName:   e.displayName,
    title:         e.title,
    color:         e.color ?? null,
    // Mid-resolution status data — without these, the renderer's status
    // pips and any client-side berserker math lag a full state delivery
    // behind reality during the turn animation.
    effects:       Array.isArray(e.effects) ? e.effects.map(r => ({ ...r })) : [],
    killsThisRound: e.killsThisRound ?? 0,
  }));
}

// ── Main entry point (N-player) ───────────────────────────────────────────────
//
// Executes plans from all players in paired lockstep steps.
// Player order within each step: hero players first (by array order), then witch players.
//
// Input: playerEntries — array of { playerId, faction, plan: PlanAction[] }
//        Built by the lobby from state.playerPlans.
//
// Returns StepRecord[]:
//   [{
//     stepIndex: number,
//     playerEvents: { playerId, faction, events: SubEvent[] }[],
//     entitySnapshot: EntitySnap[],
//   }, ...]
//
// The state object is mutated in-place. Call state.endRound() afterwards.

export function resolvePlansMP(state, playerEntries) {
  // Build per-player structures with per-entity queues for simultaneous execution.
  // Order: hero players first, then witch players (preserves join order within faction).
  const heroEntries  = playerEntries.filter(e => e.faction === 'hero');
  const witchEntries = playerEntries.filter(e => e.faction === 'witch');
  const ordered      = [...heroEntries, ...witchEntries];

  const players = ordered.map(entry => ({
    playerId:   entry.playerId,
    faction:    entry.faction,
    unitQueues: groupByEntity(entry.plan),
    budget: {
      playerId:  entry.playerId,
      faction:   entry.faction,
      remaining: budgetForPlayer(state, entry.playerId, entry.faction),
    },
  }));

  const steps = [];
  let stepIndex = 0;

  while (true) {
    const entitySnapshot = snapshotEntities(state.entities);

    // Flatten all players' per-entity queues into a single candidate list
    // and sort by actor Agility (desc), tie-break numeric entity id (asc).
    const candidates = [];
    for (const player of players) {
      for (const [entityId, queue] of player.unitQueues) {
        if (queue.length === 0) continue;
        candidates.push({ player, entityId, queue });
      }
    }
    _sortCandidates(state, candidates);
    state._turnEndPositions = computeTurnEndPositions(candidates);

    const eventsByPlayer = new Map();
    let anyAction = false;

    for (const c of candidates) {
      const events = drainOneStep(state, c.queue, c.player.budget);
      if (events.length === 0) continue;
      anyAction = true;
      let bucket = eventsByPlayer.get(c.player.playerId);
      if (!bucket) {
        bucket = { playerId: c.player.playerId, faction: c.player.faction, events: [] };
        eventsByPlayer.set(c.player.playerId, bucket);
      }
      bucket.events.push(...events);
    }

    if (!anyAction) break;

    // Preserve original player ordering in the output step record.
    const stepEvents = [];
    for (const player of players) {
      const bucket = eventsByPlayer.get(player.playerId);
      if (bucket) stepEvents.push(bucket);
    }

    const logicEvents = captureTurnStoryEvents(state);
    steps.push({ stepIndex, playerEvents: stepEvents, entitySnapshot, ...(logicEvents ? { logicEvents } : {}) });
    stepIndex++;
  }

  state._turnEndPositions = null;
  return steps;
}

// Mission-logic (docs/09): after a TURN's moves apply, fire the events that a
// unit's movement/discovery this turn can trigger — Area enter/exit (so triggers
// fire on pass-through, not only when a unit stops on the hex at a round boundary)
// and Actor spawn/death (so finding a pinned survivor fires its On Actor node
// right here). Returns the SHOW (story beat / conversation) events to play at this
// point in the replay; Sim-side presentation (spawn / flags / NPC choreography)
// stays queued for the existing post-round handling. Sealed: reads only `state`.
// No-op without an attached engine, so normal/online games are byte-identical.
function captureTurnStoryEvents(state) {
  if (!state?.logicEngine || !Array.isArray(state.logicPresentation)) return null;
  const before = state.logicPresentation.length;
  state._dispatchAreaTransitions();
  state._dispatchActorTransitions();
  if (state.logicPresentation.length === before) return null;
  const captured = [];
  const rest = [];
  for (let k = before; k < state.logicPresentation.length; k++) {
    const e = state.logicPresentation[k];
    (e.kind === 'storyBeat' || e.kind === 'conversation' ? captured : rest).push(e);
  }
  state.logicPresentation.length = before;
  state.logicPresentation.push(...rest);
  return captured.length ? captured : null;
}

// ── Legacy 2-player entry point ───────────────────────────────────────────────
//
// Backward-compatible wrapper used by the offline mode (src/main.js) and any
// code that hasn't migrated to resolvePlansMP yet.  Returns the old-style
// step records with heroEvents / witchEvents arrays.

export function resolvePlans(state, heroPlan, witchPlan) {
  // Group each faction's flat plan into per-entity queues for simultaneous execution.
  const heroUnitQueues  = groupByEntity(heroPlan);
  const witchUnitQueues = groupByEntity(witchPlan);

  const heroBudget  = { faction: 'hero',  remaining: budgetFor(state, 'hero')  };
  const witchBudget = { faction: 'witch', remaining: budgetFor(state, 'witch') };

  const steps = [];
  let stepIndex = 0;

  while (true) {
    const heroHasActions  = [...heroUnitQueues.values()].some(q => q.length > 0);
    const witchHasActions = [...witchUnitQueues.values()].some(q => q.length > 0);
    if (!heroHasActions && !witchHasActions) break;

    const entitySnapshot = snapshotEntities(state.entities);

    // Flatten both factions' per-entity queues into one list, sort by Agility,
    // drain each, then split events back into per-faction buckets.
    const heroEvents = [];
    const witchEvents = [];
    const candidates = [];
    for (const [entityId, queue] of heroUnitQueues) {
      if (queue.length === 0) continue;
      candidates.push({ budget: heroBudget, sink: heroEvents, entityId, queue });
    }
    for (const [entityId, queue] of witchUnitQueues) {
      if (queue.length === 0) continue;
      candidates.push({ budget: witchBudget, sink: witchEvents, entityId, queue });
    }
    _sortCandidates(state, candidates);
    state._turnEndPositions = computeTurnEndPositions(candidates);

    for (const c of candidates) {
      const events = drainOneStep(state, c.queue, c.budget);
      if (events.length > 0) c.sink.push(...events);
    }

    if (heroEvents.length === 0 && witchEvents.length === 0) break;

    const logicEvents = captureTurnStoryEvents(state);
    steps.push({ stepIndex, heroEvents, witchEvents, entitySnapshot, ...(logicEvents ? { logicEvents } : {}) });
    stepIndex++;
  }

  state._turnEndPositions = null;
  return steps;
}
