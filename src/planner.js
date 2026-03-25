// Simultaneous-turn planning: action types, ghost-state projection, and entity snap.
import { hexKey, getNeighbors } from './hex.js';
import { getReachableHexes } from './actions.js';
import { TileType, ResourceType } from './tiles.js';
import { EntityType } from './entities.js';

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
  USE_ITEM:     'use-item',
  EQUIP_WEAPON: 'equip-weapon',
  USE_ABILITY:  'use-ability',
});

// Maximum number of steps a player may place in their plan.
// Steps beyond the actual action budget are lower priority and execute only if
// earlier steps are skipped (battle target gone/dead).
export const MAX_PLAN_LENGTH = 12;

// Returns true if an action type normally costs 1 action point.
export function actionCosts(type) {
  return type !== PlanActionType.USE_ITEM && type !== PlanActionType.EQUIP_WEAPON;
}

// ── Entity snapshot ──────────────────────────────────────────────────────────
// Captures the fields needed by the battle dialog and resolution event stream.
// Moved here from server/lobby.js so both the resolver and client code share it.

export function snapEntity(entity) {
  return {
    id:          entity.id,
    type:        entity.type,
    owner:       entity.owner,
    ownerId:     entity.ownerId ?? null,
    col:         entity.col,
    row:         entity.row,
    hp:          entity.hp,
    maxHp:       entity.maxHp,
    attack:      entity.attack,
    defense:     entity.defense,
    weapon:      entity.weapon,
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
      // Determine summon type from witch inventory.
      const inv = state.inventory?.witch ?? {};
      const summonType = (inv[ResourceType.METAL] || 0) > 0 ? EntityType.IRON_GOLEM
                       : (inv[ResourceType.WOOD]  || 0) > 0 ? EntityType.WOOD_GOLEM
                       : EntityType.MINION;
      summonInfo = { col: action.toCol, row: action.toRow, type: summonType };
      // Give the new unit a temporary id for ghost rendering.
      const ghostId = `ghost-summon-${steps.length}`;
      positions.set(ghostId, { col: action.toCol, row: action.toRow });
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

  const pos = projectedPositions?.get(action.entityId)
    ?? { col: entity.col, row: entity.row };

  switch (action.type) {
    case PlanActionType.MOVE: {
      const t = state.tiles.get(hexKey(action.toCol, action.toRow));
      if (!t || t.type === TileType.RIVER)
        return { valid: false, reason: 'Cannot move there.' };
      // Range check against projected position — road tiles cost half movement.
      const hasHorse = entity.owner === 'hero' && (entity.items?.['horse'] || 0) > 0;
      const reachable = getReachableHexes(state, entity, hasHorse ? 2 : 1, pos);
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
    case PlanActionType.USE_ABILITY:
      return { valid: true };

    case PlanActionType.SUMMON: {
      if (action.toCol == null || action.toRow == null)
        return { valid: false, reason: 'No summon target.' };
      return { valid: true };
    }

    case PlanActionType.USE_ITEM: {
      if (!action.item) return { valid: false, reason: 'No item specified.' };
      return { valid: true };
    }

    case PlanActionType.EQUIP_WEAPON: {
      if (!action.weapon) return { valid: false, reason: 'No weapon specified.' };
      return { valid: true };
    }

    default:
      return { valid: false, reason: `Unknown action type: ${action.type}` };
  }
}
