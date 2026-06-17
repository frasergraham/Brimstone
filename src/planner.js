// Simultaneous-turn planning: action types, ghost-state projection, and entity snap.
import { hexKey, getNeighbors } from './hex.js';
import { getReachableHexes, getVisiblePositions } from './actions.js';
import { ResourceType, isRiver } from './tiles.js';
import { EntityType, normalizeItems, getItemCountOf, removeItemInItems } from './entities.js';
import { ITEMS } from './items.js';
import { effectsBlockActions } from './effects.js';

// ── Plan action types ────────────────────────────────────────────────────────
//
// Two attack variants:
//   BATTLE_UNIT — target a specific entity by ID.  Skipped at resolution if
//                 the entity is dead or out of range; later plan steps execute.
//   BATTLE_HEX  — target a map hex; attack whatever enemy is standing there.
//                 Skipped if the hex is empty at resolution time.

export const PlanActionType = Object.freeze({
  MOVE:         'move',
  BATTLE_UNIT:  'battle-unit',
  BATTLE_HEX:   'battle-hex',
  EXPLORE:      'explore',
  FORTIFY:      'fortify',
  SUMMON:       'summon',
  HEAL:         'heal',
  USE_ITEM:     'use-item',
  EQUIP_WEAPON: 'equip-weapon',
  USE_ABILITY:  'use-ability',
  GUARD:        'guard',
  SOUND_HORN:   'sound-horn',
  // Multiplayer-only free action: a leader transfers control of one of their
  // own survivors to another leader on the same faction. Cost: 0.
  // Plan-action shape: { type, entityId: leaderId, targetId: survivorId, destOwnerId: newLeaderOwnerId }
  SENT_TO:      'sent-to',
});

// Maximum number of steps a player may place in their plan.
// Steps beyond the actual action budget are lower priority and execute only if
// earlier steps are skipped (battle target gone/dead).
export const MAX_PLAN_LENGTH = 12;

// Returns true if an action type normally costs 1 action point.
export function actionCosts(type) {
  return type !== PlanActionType.USE_ITEM
      && type !== PlanActionType.EQUIP_WEAPON
      && type !== PlanActionType.SENT_TO;
}

/**
 * Auto-Guard queue builder (pure). Given the eligible units and the remaining
 * action budget, returns the ordered list of entity ids to receive a GUARD —
 * leader(s) first, then the rest in their given order, round-robin until the
 * budget is used up (guard charges stack, so leftover budget reinforces).
 *
 * @param {Array<{id:*, isLeader?:boolean}>} units
 * @param {number} remaining
 * @returns {Array<*>} entity ids, one per guard action to queue (length = max(0, remaining))
 */
export function buildAutoGuardQueue(units, remaining) {
  if (!Array.isArray(units) || units.length === 0 || remaining <= 0) return [];
  // Stable sort keeps non-leaders in their given (caller) order.
  const ordered = [...units].sort((a, b) => (b.isLeader ? 1 : 0) - (a.isLeader ? 1 : 0));
  const out = [];
  for (let i = 0; i < remaining; i++) out.push(ordered[i % ordered.length].id);
  return out;
}

// ── Entity snapshot ──────────────────────────────────────────────────────────
// Captures the fields needed by the battle dialog and resolution event stream.
// Moved here from server/lobby.js so both the resolver and client code share it.

export function snapEntity(entity) {
  const range = typeof entity.getRange === 'function' ? entity.getRange() : (entity.range ?? 1);
  return {
    id:          entity.id,
    type:        entity.type,
    owner:       entity.owner,
    ownerId:     entity.ownerId ?? null,
    col:         entity.col,
    row:         entity.row,
    hp:          entity.hp,
    maxHp:       entity.maxHp,
    // Effective character-sheet stats (base + equipped weapon). The
    // battle-dialog breakdown labels this row "base" but includes the
    // weapon bonus; transient combat modifiers (attackBonus /
    // defenseBonus) are added on top by the dialog.
    attack:      entity.getAttack(),
    defense:     entity.getDefense(),
    // Equipped weapon now lives inside `items` (tagged equipped). Deep-copy so
    // consumers (projectile FX, re-parented display clones) read the equipped
    // id without aliasing the live entity's backpack.
    items:       normalizeItems(entity.items),
    attackBonus: entity.attackBonus || 0,
    defenseBonus: entity.defenseBonus || 0,
    // Attack range in hexes — used by playback to decide whether to render
    // a melee lunge or a ranged projectile animation.
    range,
    name:        entity.displayName,
    title:       entity.title,
    displayName: entity.displayName,
  };
}

// ── Ghost-state projection ───────────────────────────────────────────────────
//
// Given the live game state and a faction's plan array, compute the projected
// position of every entity after each plan step.  Only move/summon actions
// change positions; all other action types are recorded as-is.
//
// Returns an array of step descriptors, one per plan action:
//   {
//     action,           // the PlanAction
//     positions,        // Map<entityId, {col,row}> after this step
//     arrow,            // {entityId, fromCol, fromRow, toCol, toRow} | null
//     stepNumber,       // 1-based index among MOVE steps only (for rendering)
//     attackArrow,      // {fromCol, fromRow, toCol, toRow} | null  (for BATTLE_* steps)
//     summonInfo,       // {col, row, type: EntityType} | null      (for SUMMON steps)
//   }

export function computeGhostState(state, plan) {
  // Seed projected positions from the current live state.
  const positions = new Map();
  for (const e of state.entities) {
    if (e.alive) positions.set(e.id, { col: e.col, row: e.row });
  }

  const steps = [];
  let moveStepNumber = 0;

  for (const action of plan) {
    let arrow = null;
    let stepNumber = null;
    let attackArrow = null;
    let summonInfo = null;

    if (action.type === PlanActionType.MOVE) {
      const pos = positions.get(action.entityId);
      if (pos) {
        moveStepNumber++;
        stepNumber = moveStepNumber;
        arrow = {
          entityId: action.entityId,
          fromCol:  pos.col,
          fromRow:  pos.row,
          toCol:    action.toCol,
          toRow:    action.toRow,
        };
        // Advance the projected position.
        positions.set(action.entityId, { col: action.toCol, row: action.toRow });
      }
    } else if (action.type === PlanActionType.BATTLE_UNIT) {
      const fromPos = positions.get(action.entityId);
      const toPos   = positions.get(action.targetId);
      if (fromPos && toPos) {
        attackArrow = { fromCol: fromPos.col, fromRow: fromPos.row, toCol: toPos.col, toRow: toPos.row };
      }
    } else if (action.type === PlanActionType.BATTLE_HEX) {
      const fromPos = positions.get(action.entityId);
      if (fromPos && action.targetCol != null) {
        attackArrow = { fromCol: fromPos.col, fromRow: fromPos.row, toCol: action.targetCol, toRow: action.targetRow };
      }
    } else if (action.type === PlanActionType.SUMMON) {
      // Use explicit summonType from the plan action when available (player's choice).
      // Fall back to auto-pick from current inventory for legacy/AI plans without a type.
      let summonType = action.summonType ?? null;
      if (!summonType) {
        const ownerFaction = (state.entities ?? []).find(e => e.id === action.entityId)?.owner ?? 'witch';
        const inv = state.inventory?.[ownerFaction] ?? {};
        summonType = getItemCountOf(inv, ResourceType.METAL) >= 2 ? EntityType.IRON_GOLEM
                   : getItemCountOf(inv, ResourceType.WOOD)  >= 2 ? EntityType.WOOD_GOLEM
                   : EntityType.MINION;
      }
      // Summoned unit appears on the witch's current projected position.
      const witchPos = positions.get(action.entityId);
      const spawnCol = witchPos?.col ?? 0;
      const spawnRow = witchPos?.row ?? 0;
      summonInfo = { col: spawnCol, row: spawnRow, type: summonType };
      // Give the new unit a temporary id for ghost rendering.
      const ghostId = `ghost-summon-${steps.length}`;
      positions.set(ghostId, { col: spawnCol, row: spawnRow });
    }

    steps.push({
      action,
      positions: new Map(positions),
      arrow,
      stepNumber,
      attackArrow,
      summonInfo,
    });
  }

  return steps;
}

// ── Projected inventory ──────────────────────────────────────────────────────
//
// Simulates resource consumption across a plan so the UI can show per-step costs
// and grey out actions the player will no longer be able to afford.
//
// Returns { hero, witch, entityItems } — plain objects (shallow clones of state
// inventory values keyed by faction id).  Does NOT mutate the real state.

export function computeProjectedInventory(state, plan) {
  // Deep-clone the dict-of-objects resource maps (normalizeItems) so projected
  // spending never mutates the real state.inventory entries.
  const hero   = normalizeItems(state.inventory?.hero);
  const witch  = normalizeItems(state.inventory?.witch);
  // Per-entity personal items (herbs, weapons)
  const entityItems = {};
  for (const e of (state.entities ?? [])) {
    if (e.items) entityItems[e.id] = { ...e.items };
  }

  for (const action of plan) {
    switch (action.type) {
      case PlanActionType.SUMMON: {
        // Mirrors pickSummonType + executeSummon spending
        if (getItemCountOf(witch, ResourceType.METAL) >= 2) {
          removeItemInItems(witch, ResourceType.METAL, 2);
        } else if (getItemCountOf(witch, ResourceType.WOOD) >= 2) {
          removeItemInItems(witch, ResourceType.WOOD, 2);
        } else {
          let rem = 2;
          for (const k of Object.keys(witch).sort((a, b) => getItemCountOf(witch, b) - getItemCountOf(witch, a))) {
            const spend = Math.min(getItemCountOf(witch, k), rem);
            removeItemInItems(witch, k, spend);
            rem -= spend;
            if (rem === 0) break;
          }
        }
        break;
      }
      case PlanActionType.FORTIFY:
        // Metal preferred, then wood — mirrors executeFortify
        if (getItemCountOf(hero, ResourceType.METAL) > 0) removeItemInItems(hero, ResourceType.METAL, 1);
        else if (getItemCountOf(hero, ResourceType.WOOD) > 0) removeItemInItems(hero, ResourceType.WOOD, 1);
        break;
      case PlanActionType.HEAL: {
        const healEntity = (state.entities ?? []).find(e => e.id === action.entityId);
        const pool = healEntity?.owner === 'witch' ? witch : hero;
        if (getItemCountOf(pool, ResourceType.HERBS) > 0) removeItemInItems(pool, ResourceType.HERBS, 1);
        break;
      }
      case PlanActionType.USE_ITEM: {
        const item = action.item;
        if (!item || ITEMS[item]?.kind === 'weapon') break;
        if (getItemCountOf(hero, item) > 0) removeItemInItems(hero, item, 1);
        break;
      }
      case PlanActionType.SOUND_HORN:
        if (getItemCountOf(hero, ResourceType.FOOD) >= 1) removeItemInItems(hero, ResourceType.FOOD, 1);
        break;
    }
  }

  return { hero, witch, entityItems };
}

// ── Per-unit plan grouping and interleaving ─────────────────────────────────
//
// groupPlanByEntity: flat PlanAction[] → Map<entityId, PlanAction[]>
// interleavePlan:    Map<entityId, PlanAction[]> → flat PlanAction[]
//                    ordered by step (all units' action 0 first, then action 1, etc.)

/** Group a flat plan array into per-entity queues. */
export function groupPlanByEntity(plan) {
  const map = new Map();
  for (const action of (plan ?? [])) {
    if (!map.has(action.entityId)) map.set(action.entityId, []);
    map.get(action.entityId).push(action);
  }
  return map;
}

/** Interleave per-entity queues into a flat plan ordered by step index. */
export function interleavePlan(unitPlans) {
  const queues = [...unitPlans.values()];
  const result = [];
  let step = 0;
  while (true) {
    let added = false;
    for (const q of queues) {
      if (step < q.length) {
        result.push(q[step]);
        added = true;
      }
    }
    if (!added) break;
    step++;
  }
  return result;
}

// ── Plan validation (client-side, fast) ─────────────────────────────────────
//
// Validates a candidate plan action against a projected state.
// This is a loose check to prevent obviously invalid entries from being added
// to the plan.  The resolver performs authoritative validation at execution time.
//
// projectedPositions: Map<entityId, {col,row}> from computeGhostState output,
//   or null to use current live positions.
//
// Returns { valid: boolean, reason?: string }

export function validatePlanAction(state, action, projectedPositions = null) {
  const entity = state.entities.find(e => e.id === action.entityId && e.alive);
  if (!entity) return { valid: false, reason: 'Entity not found.' };

  // Stunned (and any future action-blocking effect): reject at planning time
  // so the player isn't silently spending a planning slot on a unit that
  // will skip every step at resolution.
  if (effectsBlockActions(entity)) {
    return { valid: false, reason: `${entity.displayName ?? 'Unit'} is stunned and cannot act this round.` };
  }

  const pos = projectedPositions?.get(action.entityId)
    ?? { col: entity.col, row: entity.row };

  switch (action.type) {
    case PlanActionType.MOVE: {
      const t = state.tiles.get(hexKey(action.toCol, action.toRow));
      if (!t || isRiver(t))
        return { valid: false, reason: 'Cannot move there.' };
      // Range check against projected position — road tiles cost half movement.
      const hasHorse = entity.owner === 'hero' && (entity.items?.['horse']?.count ?? 0) > 0;
      const visibleHexes = state.fogOfWar !== 'none'
        ? getVisiblePositions(state, entity.owner)
        : null;
      const reachable = getReachableHexes(state, entity, hasHorse ? 2 : 1, pos, visibleHexes);
      if (!reachable.some(h => h.col === action.toCol && h.row === action.toRow))
        return { valid: false, reason: 'Destination out of move range.' };
      return { valid: true };
    }

    case PlanActionType.BATTLE_UNIT: {
      if (!action.targetId) return { valid: false, reason: 'No target specified.' };
      const target = state.entities.find(e => e.id === action.targetId && e.alive);
      if (!target) return { valid: false, reason: 'Target not found (may be dead at resolution).' };
      return { valid: true };
    }

    case PlanActionType.BATTLE_HEX: {
      if (action.targetCol == null || action.targetRow == null)
        return { valid: false, reason: 'No target hex specified.' };
      return { valid: true };
    }

    case PlanActionType.EXPLORE:
    case PlanActionType.FORTIFY:
    case PlanActionType.GUARD:
    case PlanActionType.HEAL:
    case PlanActionType.USE_ABILITY:
    case PlanActionType.SOUND_HORN:
      return { valid: true };

    case PlanActionType.SUMMON:
      return { valid: true };

    case PlanActionType.USE_ITEM: {
      if (!action.item) return { valid: false, reason: 'No item specified.' };
      return { valid: true };
    }

    case PlanActionType.EQUIP_WEAPON: {
      if (!action.weapon) return { valid: false, reason: 'No weapon specified.' };
      // Equipping is a free action capped at once per round per unit.
      if (entity.equippedThisRound) {
        return { valid: false, reason: `${entity.displayName ?? 'Unit'} already equipped a weapon this round.` };
      }
      return { valid: true };
    }

    case PlanActionType.SENT_TO: {
      // Free action: transfer control of a survivor to another leader on the
      // same faction. Authoritative checks (faction has >1 leader, target owned
      // by actor, destination is a live leader on the same faction) live in
      // executeSentTo — this client-side gate catches obvious shape errors.
      if (!action.targetId) return { valid: false, reason: 'No survivor specified.' };
      if (!action.destOwnerId) return { valid: false, reason: 'No destination leader specified.' };
      if (action.destOwnerId === entity.ownerId) {
        return { valid: false, reason: 'Cannot send a survivor to yourself.' };
      }
      const target = state.entities.find(e => e.id === action.targetId && e.alive);
      if (!target) return { valid: false, reason: 'Survivor not found.' };
      if (target.ownerId !== entity.ownerId) {
        return { valid: false, reason: 'You do not control that survivor.' };
      }
      return { valid: true };
    }

    default:
      return { valid: false, reason: `Unknown action type: ${action.type}` };
  }
}

// ── Whole-plan validation (server-authoritative, structural) ─────────────────
//
// Validates a full submitted plan's structure: array shape, length cap, known
// action types, and entity existence/ownership.  Deliberately does NOT check
// per-action legality (move range, target validity, …) — that is the
// resolver's job at execution time, where skips/fails are handled gracefully.
// Checking legality here against the live state would falsely reject legal
// chained plans (e.g. moving into a hex an ally vacates in the same round).
//
// playerId: owning player UUID for ownership checks, or null to skip them
//   (offline mode validates by faction at resolution instead).
//
// Returns { valid: true } or { valid: false, index, reason }.

const PLAN_ACTION_TYPES = new Set(Object.values(PlanActionType));

export function validatePlan(state, playerId, plan) {
  if (!Array.isArray(plan))
    return { valid: false, index: -1, reason: 'Plan must be an array.' };
  if (plan.length > MAX_PLAN_LENGTH)
    return { valid: false, index: -1, reason: `Plan exceeds maximum length of ${MAX_PLAN_LENGTH}.` };

  for (let i = 0; i < plan.length; i++) {
    const action = plan[i];
    if (action === null || typeof action !== 'object' || Array.isArray(action))
      return { valid: false, index: i, reason: 'Plan action must be an object.' };
    if (typeof action.entityId !== 'string')
      return { valid: false, index: i, reason: 'Plan action is missing an entity id.' };
    if (!PLAN_ACTION_TYPES.has(action.type))
      return { valid: false, index: i, reason: `Unknown action type: ${action.type}` };

    if (playerId !== null) {
      const entity = state.entities.find(e => e.id === action.entityId && e.alive);
      if (!entity)
        return { valid: false, index: i, reason: 'Entity not found.' };
      if (entity.ownerId !== playerId)
        return { valid: false, index: i, reason: 'Entity belongs to another player.' };
    }
  }

  return { valid: true };
}
