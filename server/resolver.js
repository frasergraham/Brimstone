// Simultaneous-turn resolution engine.
// Receives both factions' submitted plans and executes them in paired steps,
// applying skip logic and budget enforcement.
//
// Imports only from src/ — no DOM, no WebSocket.

import {
  executeMove, executeExplore, executeBattle,
  executeFortify, executeSummon, executeUseItem, executeUseAbility,
} from '../src/actions.js';
import { hexDistance } from '../src/hex.js';
import { PlanActionType, snapEntity } from '../src/planner.js';
import { Phase } from '../src/game.js';
import { ResourceType } from '../src/tiles.js';

// ── Event types ──────────────────────────────────────────────────────────────

export const ResEventType = Object.freeze({
  ACTION_OK:   'action_ok',   // executed successfully; result payload attached
  ACTION_SKIP: 'action_skip', // battle target gone/dead — free skip, later steps run
  ACTION_FAIL: 'action_fail', // hard failure — plan halts for this faction
  BUDGET_CAP:  'budget_cap',  // budget exhausted; remaining plan ignored
});

// ── Budget calculation ───────────────────────────────────────────────────────
// Mirrors the computeActions logic in game.js without importing it, so the
// resolver stays portable and doesn't create circular dependencies.

function budgetFor(state, faction) {
  const isHero = faction === 'hero';
  const extras = state.entities.filter(
    e => e.alive && e.owner === faction && e.type !== faction
  ).length;

  if (isHero) {
    const timeBonus = (state.phase === Phase.DAY || state.phase === Phase.DAWN) ? 1 : 0;
    return 3 + timeBonus + Math.min(extras, 5);
  } else {
    const timeBonus = state.phase === Phase.NIGHT ? 1 : 0;
    const unitBonus = Math.min(Math.floor(extras / 2), 4);
    return 4 + timeBonus + unitBonus;
  }
}

// ── Single-action executor ───────────────────────────────────────────────────
//
// Returns one of:
//   { kind: 'ok',   result, battleSnaps? }   — action ran, consume budget
//   { kind: 'skip', reason }                  — battle target gone, free skip
//   { kind: 'fail', reason }                  — hard failure, halt faction plan

function runAction(state, action, faction) {
  const entity = state.entities.find(e => e.id === action.entityId && e.alive);
  if (!entity) return { kind: 'skip', reason: 'Entity no longer exists.' };
  if (entity.owner !== faction) return { kind: 'fail', reason: 'Wrong faction.' };

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
      const target = state.entities.find(e => e.id === action.targetId && e.alive);
      if (!target) return { kind: 'skip', reason: 'Target is dead or gone.' };

      const dist = hexDistance(entity.col, entity.row, target.col, target.row);
      if (dist > 1) return { kind: 'skip', reason: 'Target moved out of range.' };

      const actorSnap  = snapEntity(entity);
      const targetSnap = snapEntity(target);
      const r = executeBattle(state, entity, target);
      if (!r.success) return { kind: 'fail', reason: r.log[0] };
      return { kind: 'ok', result: r, battleSnaps: { actorSnap, targetSnap } };
    }

    case PlanActionType.BATTLE_HEX: {
      const dist = hexDistance(entity.col, entity.row, action.targetCol, action.targetRow);
      if (dist > 1) return { kind: 'skip', reason: 'Target hex out of range.' };

      const enemies = state.entities.filter(
        e => e.alive && e.owner !== faction &&
             e.col === action.targetCol && e.row === action.targetRow
      );
      if (enemies.length === 0) return { kind: 'skip', reason: 'No enemy on target hex.' };

      const target     = enemies[0];
      const actorSnap  = snapEntity(entity);
      const targetSnap = snapEntity(target);
      const r = executeBattle(state, entity, target);
      if (!r.success) return { kind: 'fail', reason: r.log[0] };
      return { kind: 'ok', result: r, battleSnaps: { actorSnap, targetSnap } };
    }

    case PlanActionType.FORTIFY: {
      const r = executeFortify(state, entity);
      if (!r.success) return { kind: 'fail', reason: r.log[0] };
      return { kind: 'ok', result: r };
    }

    case PlanActionType.SUMMON: {
      const r = executeSummon(state, entity, action.toCol, action.toRow);
      if (!r.success) return { kind: 'fail', reason: r.log[0] };
      return { kind: 'ok', result: r };
    }

    case PlanActionType.USE_ITEM: {
      // Snapshot actionsLeft so we can detect Food/Scripture bonus actions.
      const before = state.actionsLeft;
      const r = executeUseItem(state, entity, action.item);
      if (!r.success) return { kind: 'fail', reason: r.log[0] };
      // Carry any action bonus granted (Food gives +1 via state.actionsLeft).
      const bonus = state.actionsLeft - before;
      return { kind: 'ok', result: r, budgetBonus: bonus };
    }

    case PlanActionType.EQUIP_WEAPON: {
      // Equip is free and always succeeds if the weapon is present.
      const r = executeUseItem(state, entity, action.weapon);
      if (!r.success) return { kind: 'fail', reason: r.log[0] };
      return { kind: 'ok', result: r };
    }

    case PlanActionType.USE_ABILITY: {
      // Snapshot for Rally bonus detection.
      const before = state.actionsLeft;
      const r = executeUseAbility(state, entity);
      if (!r.success) return { kind: 'fail', reason: r.log[0] };
      const bonus = state.actionsLeft - before;
      return { kind: 'ok', result: r, budgetBonus: bonus };
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
  let budgetConsumed = 0;

  while (queue.length > 0 && budget.remaining > 0) {
    const action = queue[0];
    const out = runAction(state, action, budget.faction);

    if (out.kind === 'ok') {
      const cost = out.result.cost ?? 1;
      budget.remaining -= cost;
      budget.remaining += out.budgetBonus ?? 0;  // Food / Rally bonus
      queue.shift();

      for (const msg of out.result.log ?? []) state.addLog(msg);

      subEvents.push({
        type:        ResEventType.ACTION_OK,
        faction:     budget.faction,
        action,
        result:      out.result,
        battleSnaps: out.battleSnaps ?? null,
      });
      break; // consumed one slot — done with this step

    } else if (out.kind === 'skip') {
      queue.shift(); // free skip — advance pointer without charging budget
      subEvents.push({
        type:    ResEventType.ACTION_SKIP,
        faction: budget.faction,
        action,
        reason:  out.reason,
      });
      // Loop: try the next action in the same step

    } else {
      // Hard failure — halt this faction's remaining plan
      queue.shift();
      queue.length = 0;
      subEvents.push({
        type:   ResEventType.ACTION_FAIL,
        faction: budget.faction,
        action,
        reason: out.reason,
      });
      break;
    }
  }

  // If the budget is exhausted but the queue is not empty, try to spend food
  // from shared inventory to fund one more action before capping.
  if (budget.remaining <= 0 && queue.length > 0) {
    const shared = state.inventory?.shared ?? {};
    if ((shared[ResourceType.FOOD] || 0) > 0) {
      shared[ResourceType.FOOD]--;
      budget.remaining += 1;
      state.addLog(`🍞 Rations consumed — pressing on beyond the action limit.`);
      // Don't push BUDGET_CAP; the outer loop will call drainOneStep again.
    } else {
      subEvents.push({
        type:    ResEventType.BUDGET_CAP,
        faction: budget.faction,
        action:  queue[0],
      });
      queue.length = 0;
    }
  }

  return subEvents;
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
    type:          e.type,
    weapon:        e.weapon,
    ability:       e.ability,
    attack:        e.attack,
    defense:       e.defense,
    fortification: e.fortification,
    displayName:   e.displayName,
    title:         e.title,
  }));
}

// ── Main entry point ─────────────────────────────────────────────────────────
//
// Executes both plans in paired steps.  Returns an ordered array of step
// records for the server to stream to clients:
//
//   [{
//     stepIndex: number,
//     heroEvents:  SubEvent[],   // sub-events for hero this step (0–N)
//     witchEvents: SubEvent[],   // sub-events for witch this step (0–N)
//   }, ...]
//
// The state object is mutated in-place.  Call state.endRound() afterwards
// to apply phase transitions, hazards, and node scoring.

export function resolvePlans(state, heroPlan, witchPlan) {
  const heroQ  = [...(heroPlan  ?? [])];
  const witchQ = [...(witchPlan ?? [])];

  const heroBudget  = { faction: 'hero',  remaining: budgetFor(state, 'hero')  };
  const witchBudget = { faction: 'witch', remaining: budgetFor(state, 'witch') };

  const steps = [];
  let stepIndex = 0;

  while (
    (heroQ.length > 0 && heroBudget.remaining  > 0) ||
    (witchQ.length > 0 && witchBudget.remaining > 0)
  ) {
    // Snapshot entity state *before* this step executes so the animator can
    // display the world as it looked going into each step.
    const entitySnapshot = snapshotEntities(state.entities);

    const heroEvents  = heroQ.length  > 0 && heroBudget.remaining  > 0
      ? drainOneStep(state, heroQ,  heroBudget)
      : [];
    const witchEvents = witchQ.length > 0 && witchBudget.remaining > 0
      ? drainOneStep(state, witchQ, witchBudget)
      : [];

    if (heroEvents.length === 0 && witchEvents.length === 0) break;

    steps.push({ stepIndex, heroEvents, witchEvents, entitySnapshot });
    stepIndex++;
  }

  return steps;
}
