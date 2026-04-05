// Simultaneous-turn resolution engine.
// Receives both factions' submitted plans and executes them in paired steps,
// applying skip logic and budget enforcement.
//
// Imports only from src/ — no DOM, no WebSocket.

import {
  executeMove, executeExplore, executeBattle,
  executeFortify, executeSummon, executeUseItem, executeUseAbility,
  executeGuard, executeGuardStrike, executeSoundHorn,
} from '../src/actions.js';
import { EntityType } from '../src/entities.js';
import { hexDistance, getNeighbors, hexKey } from '../src/hex.js';
import { PlanActionType, snapEntity } from '../src/planner.js';
import { Phase, countHeldNodes } from '../src/game.js';
import { ResourceType } from '../src/tiles.js';
import { getFaction } from '../src/factions.js';

// ── Per-unit queue grouping ──────────────────────────────────────────────────
// Groups a flat PlanAction[] into per-entity queues for simultaneous execution.

function groupByEntity(plan) {
  const map = new Map();
  for (const action of (plan ?? [])) {
    if (!map.has(action.entityId)) map.set(action.entityId, []);
    map.get(action.entityId).push(action);
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
});

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
  const isLeader = killedEntity.type === EntityType.HERO ||
                   killedEntity.type === EntityType.WITCH;
  if (!isLeader || !killedEntity.ownerId) return;
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

  switch (action.type) {

    case PlanActionType.MOVE: {
      const r = executeMove(state, entity, action.toCol, action.toRow);
      if (!r.success) return { kind: 'fail', reason: r.log[0] };
      return { kind: 'ok', result: r };
    }

    case PlanActionType.EXPLORE: {
      const r = executeExplore(state, entity);
      if (!r.success) return { kind: 'fail', reason: r.log[0] };
      return { kind: 'ok', result: r };
    }

    case PlanActionType.BATTLE_UNIT: {
      let target = state.entities.find(e => e.id === action.targetId && e.alive);

      if (target) {
        const dist = hexDistance(entity.col, entity.row, target.col, target.row);
        if (dist > 1) target = null; // target moved out of range
      }

      // Fallback: original target gone/moved — attack another enemy on the planned hex
      if (!target && action.targetCol != null && action.targetRow != null) {
        const dist = hexDistance(entity.col, entity.row, action.targetCol, action.targetRow);
        if (dist <= 1) {
          const enemies = state.entities.filter(
            e => e.alive && e.owner !== faction &&
                 e.col === action.targetCol && e.row === action.targetRow
          );
          if (enemies.length > 0) {
            target = enemies[Math.floor(Math.random() * enemies.length)];
          }
        }
      }

      if (!target) return { kind: 'skip', reason: 'Target is dead or gone.' };

      const actorSnap  = snapEntity(entity);
      const targetSnap = snapEntity(target);
      const r = executeBattle(state, entity, target);
      if (!r.success) return { kind: 'fail', reason: r.log[0] };
      // Scatter units when a leader is slain (by hit, counter-attack, or splash)
      if (r.killed)  _handleLeaderDeath(state, target);
      if (r.counterDmg > 0 && !state.entities.some(e => e.id === entity.id))
        _handleLeaderDeath(state, entity);
      for (const sk of r.splashKills ?? []) _handleLeaderDeath(state, sk);
      return { kind: 'ok', result: r, battleSnaps: { actorSnap, targetSnap } };
    }

    case PlanActionType.BATTLE_HEX: {
      const dist = hexDistance(entity.col, entity.row, action.targetCol, action.targetRow);
      if (dist > 1) return { kind: 'skip', reason: 'Target hex out of range.' };

      const enemies = state.entities.filter(
        e => e.alive && e.owner !== faction &&
             e.col === action.targetCol && e.row === action.targetRow
      );
      if (enemies.length === 0) {
        const actorSnap = snapEntity(entity);
        return {
          kind: 'skip',
          reason: 'No enemy on target hex.',
          battleSnaps: { actorSnap },
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
      return { kind: 'ok', result: r, battleSnaps: { actorSnap, targetSnap } };
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
      const r = executeUseAbility(state, entity);
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
    const shared = state.inventory?.shared ?? {};
    if ((shared[ResourceType.FOOD] || 0) > 0) {
      shared[ResourceType.FOOD]--;
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
        battleSnaps: out.battleSnaps ?? null,
        whiffTarget: out.whiffTarget ?? null,
      });
      // Loop: try the next action in the same step

    } else {
      // Hard failure — skip this action but let remaining plan continue
      queue.shift();
      subEvents.push({
        type:   ResEventType.ACTION_FAIL,
        faction: budget.faction,
        action,
        reason: out.reason,
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

  // Find all adjacent hexes (including the trigger hex itself for co-located guards)
  const adjKeys = new Set();
  adjKeys.add(hexKey(triggerCol, triggerRow));
  for (const n of getNeighbors(triggerCol, triggerRow)) adjKeys.add(hexKey(n.col, n.row));

  // Find enemy guarding entities adjacent to the trigger hex (with charges > 0)
  const guardians = state.entities.filter(e =>
    e.alive && (e.guarding > 0) && e.owner !== faction &&
    adjKeys.has(hexKey(e.col, e.row)) &&
    hexDistance(e.col, e.row, triggerCol, triggerRow) <= 1
  );

  for (const guardian of guardians) {
    if (!actor.alive) break;  // stop if target was killed by a prior guard strike
    if (guardian.guarding <= 0) continue;  // charges exhausted by prior strike this step

    guardian.guarding--;  // consume one guard charge

    const guardSnap  = snapEntity(guardian);
    const targetSnap = snapEntity(actor);
    const r = executeGuardStrike(state, guardian, actor);

    const gColor = (typeof state.playerColorFor === 'function')
      ? state.playerColorFor(guardian)
      : null;
    for (const msg of r.log ?? []) state.addLog(msg, guardian.owner, gColor);

    subEvents.push({
      type:        ResEventType.GUARD_STRIKE,
      faction:     guardian.owner,
      guardianId:  guardian.id,
      targetId:    actor.id,
      result:      r,
      battleSnaps: { actorSnap: guardSnap, targetSnap },
    });

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
    hp:            e.hp,
    maxHp:         e.maxHp,
    alive:         e.alive,
    owner:         e.owner,
    ownerId:       e.ownerId ?? null,
    type:          e.type,
    weapon:        e.weapon,
    ability:       e.ability,
    attack:        e.attack,
    defense:       e.defense,
    fortification: e.fortification,
    guarding:      e.guarding ?? 0,
    displayName:   e.displayName,
    title:         e.title,
    color:         e.color ?? null,
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
    const stepEvents = [];
    let anyAction = false;

    for (const player of players) {
      const playerEvents = [];
      for (const [, queue] of player.unitQueues) {
        if (queue.length === 0) continue;
        const events = drainOneStep(state, queue, player.budget);
        playerEvents.push(...events);
      }
      if (playerEvents.length > 0) {
        stepEvents.push({ playerId: player.playerId, faction: player.faction, events: playerEvents });
        anyAction = true;
      }
    }

    if (!anyAction) break;
    steps.push({ stepIndex, playerEvents: stepEvents, entitySnapshot });
    stepIndex++;
  }

  return steps;
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

    // Drain one action from each hero unit that has actions queued.
    const heroEvents = [];
    for (const [, queue] of heroUnitQueues) {
      if (queue.length === 0) continue;
      const events = drainOneStep(state, queue, heroBudget);
      heroEvents.push(...events);
    }

    // Drain one action from each witch unit.
    const witchEvents = [];
    for (const [, queue] of witchUnitQueues) {
      if (queue.length === 0) continue;
      const events = drainOneStep(state, queue, witchBudget);
      witchEvents.push(...events);
    }

    if (heroEvents.length === 0 && witchEvents.length === 0) break;

    steps.push({ stepIndex, heroEvents, witchEvents, entitySnapshot });
    stepIndex++;
  }

  return steps;
}
