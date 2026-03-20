// Action system: definitions, validation, and execution
import { getNeighbors, hexKey } from './hex.js';
import { TileType, ResourceType, WeaponType, WEAPON_LABEL, BUILDING_LOOT, rollLoot } from './tiles.js';
import {
  EntityType, Entity,
  createZombie, createMinion, createSurvivor,
  createWoodGolem, createIronGolem,
} from './entities.js';

export const ActionType = Object.freeze({
  MOVE:        'move',
  EXPLORE:     'explore',
  BATTLE:      'battle',
  FORTIFY:     'fortify',
  SUMMON:      'summon',
  USE_ITEM:    'use_item',
  EQUIP_WEAPON:'equip_weapon',
  END_TURN:    'end_turn',
});

// ── Helpers ────────────────────────────────────────────────────────────────

function tile(state, col, row) {
  return state.tiles.get(hexKey(col, row));
}

function entitiesAt(state, col, row) {
  return state.entities.filter(e => e.alive && e.col === col && e.row === row);
}

function adjacentEnemies(state, entity) {
  const playerOwner = entity.owner;
  return getNeighbors(entity.col, entity.row)
    .flatMap(n => entitiesAt(state, n.col, n.row))
    .filter(e => e.owner !== playerOwner && e.owner !== null && e.alive);
}

function sameHexEnemies(state, entity) {
  return entitiesAt(state, entity.col, entity.row)
    .filter(e => e.id !== entity.id && e.owner !== entity.owner && e.alive);
}

// ── Validation: can `actor` perform `action` with optional target? ─────────

export function getValidActions(state, actor) {
  const actions = [];
  const t = tile(state, actor.col, actor.row);
  const isHeroTurn  = state.activePlayer === 'hero';
  const actorIsHero = actor.owner === 'hero';

  // Move – any adjacent passable (non-river) hex
  const moveTargets = getNeighbors(actor.col, actor.row).filter(n => {
    const nt = tile(state, n.col, n.row);
    return nt && nt.type !== TileType.RIVER;
  });
  if (moveTargets.length) actions.push({ type: ActionType.MOVE, targets: moveTargets });

  // Explore – current hex not yet explored
  if (!t.explored) {
    actions.push({ type: ActionType.EXPLORE, targets: [{ col: actor.col, row: actor.row }] });
  }

  // Battle – enemies in same hex or adjacent
  const battleTargets = [
    ...sameHexEnemies(state, actor),
    ...adjacentEnemies(state, actor),
  ];
  if (battleTargets.length) actions.push({ type: ActionType.BATTLE, targets: battleTargets });

  // Fortify – hero inside a building with Wood or Metal (up to level 2)
  if (t && t.type === TileType.BUILDING && t.fortifyLevel < 2 && actorIsHero) {
    const woodCount  = (state.inventory.hero[ResourceType.WOOD]  || 0);
    const metalCount = (state.inventory.hero[ResourceType.METAL] || 0);
    if (woodCount > 0 || metalCount > 0) {
      actions.push({ type: ActionType.FORTIFY, targets: [{ col: actor.col, row: actor.row }] });
    }
  }

  // Summon – witch can summon a unit by spending a resource
  if (!actorIsHero) {
    const inv = state.inventory.witch;
    const totalRes = Object.values(inv).reduce((s, v) => s + v, 0);
    if (totalRes > 0) {
      const spawnTargets = getNeighbors(actor.col, actor.row).filter(n => {
        const nt = tile(state, n.col, n.row);
        return nt && nt.type !== TileType.RIVER && entitiesAt(state, n.col, n.row).length === 0;
      });
      if (spawnTargets.length) {
        // Determine what unit will be raised based on best available resource
        const summonType = pickSummonType(inv);
        actions.push({ type: ActionType.SUMMON, targets: spawnTargets, summonType });
      }
    }
  }

  // Use item – hero uses a held resource
  if (actorIsHero) {
    const usable = [];
    if ((state.inventory.hero[ResourceType.HERBS] || 0) > 0 && actor.hp < actor.maxHp) {
      usable.push({ item: ResourceType.HERBS, label: 'Use Herbs (heal 1 HP)' });
    }
    if ((state.inventory.hero[ResourceType.FOOD] || 0) > 0) {
      usable.push({ item: ResourceType.FOOD, label: 'Eat Food (+1 action)' });
    }
    if ((state.inventory.hero[ResourceType.SILVER] || 0) > 0) {
      usable.push({ item: ResourceType.SILVER, label: 'Silver (+1 attack)' });
    }
    if ((state.inventory.hero[ResourceType.SCRIPTURE] || 0) > 0 && battleTargets.length) {
      usable.push({ item: ResourceType.SCRIPTURE, label: 'Scripture (ward enemy)' });
    }
    if (usable.length) actions.push({ type: ActionType.USE_ITEM, usable });

    // Equip weapon from inventory
    const weapons = Object.keys(state.inventory.hero)
      .filter(k => k.startsWith('weapon:') && (state.inventory.hero[k] || 0) > 0);
    if (weapons.length) {
      actions.push({
        type: ActionType.EQUIP_WEAPON,
        weapons: weapons.map(k => ({ key: k, label: WEAPON_LABEL[k.replace('weapon:', '')] || k })),
      });
    }
  }

  return actions;
}

// Decide which unit the witch raises based on resource priority
function pickSummonType(inv) {
  if ((inv[ResourceType.METAL] || 0) > 0) return EntityType.IRON_GOLEM;
  if ((inv[ResourceType.WOOD]  || 0) > 0) return EntityType.WOOD_GOLEM;
  return EntityType.MINION;
}

// ── Execution ──────────────────────────────────────────────────────────────

export function executeMove(state, actor, targetCol, targetRow) {
  const log = [];
  const t = tile(state, targetCol, targetRow);
  if (!t || t.type === TileType.RIVER) {
    return { success: false, log: ['Cannot move there.'] };
  }
  actor.col = targetCol;
  actor.row = targetRow;
  log.push(`${actor.displayName} moves to (${targetCol},${targetRow}).`);

  // Auto-explore if building
  if (t.type === TileType.BUILDING && !t.explored) {
    t.explored = true;
    log.push(`${actor.displayName} enters the ${t.building}.`);
  }

  return { success: true, log, cost: 1 };
}

export function executeExplore(state, actor) {
  const log = [];
  const t = tile(state, actor.col, actor.row);
  if (t.explored) return { success: false, log: ['Already explored.'] };

  t.explored = true;

  if (t.type === TileType.BUILDING && t.building && BUILDING_LOOT[t.building]) {
    // Roll building loot
    const lootType = rollLoot(BUILDING_LOOT[t.building]);
    _applyLoot(state, actor, lootType, log);
  } else if (t.hasSurvivor) {
    t.hasSurvivor = false;
    _applyLoot(state, actor, 'survivor', log);
  } else if (t.resource) {
    const res = t.resource;
    t.resource = null;
    _applyLoot(state, actor, res, log);
  } else {
    log.push(`${actor.displayName} explores the area. Nothing of note.`);
  }

  return { success: true, log, cost: 1 };
}

function _applyLoot(state, actor, lootType, log) {
  if (lootType === 'nothing') {
    log.push(`${actor.displayName} searches carefully… nothing useful found.`);
    return;
  }

  if (lootType === 'survivor') {
    if (actor.owner === 'hero') {
      const s = createSurvivor(actor.col, actor.row);
      s.owner = 'hero';
      state.entities.push(s);
      log.push(`A survivor is found! They join the hero's party.`);
    } else {
      const z = createZombie(actor.col, actor.row);
      state.entities.push(z);
      log.push(`The witch finds a cowering survivor… and raises them as a zombie!`);
    }
    return;
  }

  if (lootType.startsWith('weapon:')) {
    const weaponKey = lootType.replace('weapon:', '');
    if (actor.owner === 'hero') {
      state.inventory.hero[lootType] = (state.inventory.hero[lootType] || 0) + 1;
      log.push(`Found a ${WEAPON_LABEL[weaponKey] || weaponKey}! Added to inventory.`);
    } else {
      // Witch doesn't use weapons; treat as a minor resource bonus
      log.push(`The witch finds a weapon but has no use for it.`);
    }
    return;
  }

  // It's a resource
  const res = lootType;
  if (actor.owner === 'hero') {
    state.inventory.hero[res] = (state.inventory.hero[res] || 0) + 1;
    log.push(`Found ${res}! Added to supplies.`);
  } else {
    state.inventory.witch[res] = (state.inventory.witch[res] || 0) + 1;
    log.push(`The witch secures ${res} for dark rituals.`);
  }
}

export function executeBattle(state, actor, target) {
  const log = [];
  const { attackRoll, defenseRoll, hit } = Entity.resolveCombat(actor, target);

  // Fortification bonus for defenders inside a building
  const defTile = tile(state, target.col, target.row);
  if (defTile?.fortifyLevel) target.defenseBonus += defTile.fortifyLevel;

  log.push(
    `${actor.displayName} attacks ${target.displayName}! ` +
    `[${attackRoll} vs ${defenseRoll}]`
  );

  if (hit) {
    const killed = target.takeDamage(1);
    if (killed) {
      log.push(`${target.displayName} is slain!`);
      state.entities = state.entities.filter(e => e.id !== target.id);
    } else {
      log.push(`${target.displayName} takes 1 damage. (${target.hp}/${target.maxHp} HP)`);
    }
  } else {
    log.push(`${target.displayName} defends successfully.`);
  }

  return { success: true, log, cost: 1 };
}

export function executeFortify(state, actor) {
  const t = tile(state, actor.col, actor.row);
  if (!t || t.type !== TileType.BUILDING) return { success: false, log: ['Not in a building.'] };
  if (t.fortifyLevel >= 2) return { success: false, log: ['Already fully reinforced.'] };

  const inv = state.inventory.hero;
  const metalCount = (inv[ResourceType.METAL] || 0);
  const woodCount  = (inv[ResourceType.WOOD]  || 0);

  if (metalCount > 0 && t.fortifyLevel < 2) {
    inv[ResourceType.METAL]--;
    t.fortifyLevel = 2;
    return {
      success: true,
      log: [`${actor.displayName} reinforces the ${t.building} with metal! (+2 DEF)`],
      cost: 1,
    };
  } else if (woodCount > 0) {
    inv[ResourceType.WOOD]--;
    t.fortifyLevel = Math.min(t.fortifyLevel + 1, 1);
    return {
      success: true,
      log: [`${actor.displayName} fortifies the ${t.building} with wood! (+1 DEF)`],
      cost: 1,
    };
  }

  return { success: false, log: ['No wood or metal to fortify with.'] };
}

export function executeSummon(state, actor, targetCol, targetRow) {
  const inv = state.inventory.witch;

  let summonedUnit;
  let res;
  let unitName;

  if ((inv[ResourceType.METAL] || 0) > 0) {
    res = ResourceType.METAL;
    summonedUnit = createIronGolem(targetCol, targetRow);
    unitName = 'Iron Golem';
  } else if ((inv[ResourceType.WOOD] || 0) > 0) {
    res = ResourceType.WOOD;
    summonedUnit = createWoodGolem(targetCol, targetRow);
    unitName = 'Wood Golem';
  } else {
    // Use any remaining resource for a generic minion
    res = Object.keys(inv).find(k => inv[k] > 0);
    if (!res) return { success: false, log: ['No resources to summon.'] };
    summonedUnit = createMinion(targetCol, targetRow);
    unitName = 'Minion';
  }

  inv[res]--;
  state.entities.push(summonedUnit);
  return {
    success: true,
    log: [`The witch raises a ${unitName} from ${res}!`],
    cost: 1,
  };
}

export function executeUseItem(state, actor, item) {
  const inv = state.inventory.hero;

  // Weapon equip
  if (item.startsWith('weapon:')) {
    if ((inv[item] || 0) < 1) return { success: false, log: ['Item not available.'] };
    inv[item]--;
    const weaponType = item.replace('weapon:', '');
    actor.equipWeapon(weaponType);
    const label = WEAPON_LABEL[weaponType] || weaponType;
    return {
      success: true,
      log: [`${actor.displayName} equips ${label}!`],
      cost: 0,
    };
  }

  if ((inv[item] || 0) < 1) return { success: false, log: ['Item not available.'] };
  inv[item]--;
  const log = [];

  switch (item) {
    case ResourceType.HERBS:
      actor.heal(1);
      log.push(`${actor.displayName} uses herbs. Healed to ${actor.hp}/${actor.maxHp} HP.`);
      break;
    case ResourceType.FOOD:
      state.bonusActions += 1;
      log.push(`${actor.displayName} eats food. Gains 1 extra action!`);
      break;
    case ResourceType.SILVER:
      actor.attackBonus += 1;
      log.push(`${actor.displayName} coats weapon in silver. +1 attack this turn.`);
      break;
    case ResourceType.SCRIPTURE:
      log.push(`${actor.displayName} recites scripture. Ward placed.`);
      break;
  }
  return { success: true, log, cost: 0 };  // items don't cost an action
}
