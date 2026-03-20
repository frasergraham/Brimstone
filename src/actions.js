// Action system: definitions, validation, and execution
import { getNeighbors, hexKey } from './hex.js';
import { TileType, ResourceType, WEAPON_LABEL, BUILDING_LOOT, rollLoot } from './tiles.js';
import {
  EntityType, SurvivorAbility, Entity,
  createZombie, createMinion, createSurvivor,
  createWoodGolem, createIronGolem,
} from './entities.js';
import { Phase } from './game.js';

export const ActionType = Object.freeze({
  MOVE:         'move',
  EXPLORE:      'explore',
  BATTLE:       'battle',
  FORTIFY:      'fortify',
  SUMMON:       'summon',
  USE_ITEM:     'use_item',
  EQUIP_WEAPON: 'equip_weapon',
  USE_ABILITY:  'use_ability',
  END_TURN:     'end_turn',
});

// ── Helpers ────────────────────────────────────────────────────────────────

function tile(state, col, row) {
  return state.tiles.get(hexKey(col, row));
}

function getReachableHexes(state, actor, range) {
  const visited = new Set([hexKey(actor.col, actor.row)]);
  const reachable = [];
  let frontier = [{ col: actor.col, row: actor.row }];
  for (let step = 0; step < range; step++) {
    const next = [];
    for (const pos of frontier) {
      for (const n of getNeighbors(pos.col, pos.row)) {
        const k = hexKey(n.col, n.row);
        if (visited.has(k)) continue;
        const nt = tile(state, n.col, n.row);
        if (!nt || nt.type === TileType.RIVER) continue;
        visited.add(k);
        reachable.push({ col: n.col, row: n.row });
        next.push({ col: n.col, row: n.row });
      }
    }
    frontier = next;
  }
  return reachable;
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

// ── Validation ─────────────────────────────────────────────────────────────

export function getValidActions(state, actor) {
  const actions = [];
  const t = tile(state, actor.col, actor.row);
  const actorIsHero = actor.owner === 'hero';

  // Move — range 2 if hero has a horse, otherwise 1
  const hasHorse = actorIsHero && (state.inventory.hero['horse'] || 0) > 0;
  const moveTargets = getReachableHexes(state, actor, hasHorse ? 2 : 1);
  if (moveTargets.length) actions.push({ type: ActionType.MOVE, targets: moveTargets });

  // Explore
  if (!t.explored) {
    actions.push({ type: ActionType.EXPLORE, targets: [{ col: actor.col, row: actor.row }] });
  }

  // Battle
  const battleTargets = [
    ...sameHexEnemies(state, actor),
    ...adjacentEnemies(state, actor),
  ];
  if (battleTargets.length) actions.push({ type: ActionType.BATTLE, targets: battleTargets });

  // Fortify — hero or survivor in a building with wood/metal
  if (t && t.type === TileType.BUILDING && t.fortifyLevel < 2 && actorIsHero) {
    const woodCount  = (state.inventory.hero[ResourceType.WOOD]  || 0);
    const metalCount = (state.inventory.hero[ResourceType.METAL] || 0);
    if (woodCount > 0 || metalCount > 0) {
      actions.push({ type: ActionType.FORTIFY, targets: [{ col: actor.col, row: actor.row }] });
    }
  }

  // Summon — witch only
  if (!actorIsHero) {
    const inv = state.inventory.witch;
    const totalRes = Object.values(inv).reduce((s, v) => s + v, 0);
    if (totalRes > 0) {
      const spawnTargets = getNeighbors(actor.col, actor.row).filter(n => {
        const nt = tile(state, n.col, n.row);
        return nt && nt.type !== TileType.RIVER && entitiesAt(state, n.col, n.row).length === 0;
      });
      if (spawnTargets.length) {
        const summonType = pickSummonType(inv);
        actions.push({ type: ActionType.SUMMON, targets: spawnTargets, summonType });
      }
    }
  }

  // Use item (hero-side)
  if (actorIsHero) {
    const usable = [];
    const inv = state.inventory.hero;

    if ((inv[ResourceType.HERBS] || 0) > 0 && actor.hp < actor.maxHp)
      usable.push({ item: ResourceType.HERBS, label: 'Use Herbs (heal 1 HP)' });
    if ((inv[ResourceType.FOOD] || 0) > 0)
      usable.push({ item: ResourceType.FOOD, label: 'Eat Food (+1 action)' });
    if ((inv[ResourceType.SILVER] || 0) > 0)
      usable.push({ item: ResourceType.SILVER, label: 'Silver (+1 ATK this battle)' });
    if ((inv[ResourceType.SCRIPTURE] || 0) > 0 && battleTargets.length)
      usable.push({ item: ResourceType.SCRIPTURE, label: 'Scripture (ward enemy)' });

    if (usable.length) actions.push({ type: ActionType.USE_ITEM, usable });

    // Equip weapon from inventory
    const weapons = Object.keys(inv)
      .filter(k => k.startsWith('weapon:') && (inv[k] || 0) > 0);
    if (weapons.length) {
      actions.push({
        type: ActionType.EQUIP_WEAPON,
        weapons: weapons.map(k => ({
          key: k,
          label: WEAPON_LABEL[k.replace('weapon:', '')] || k,
        })),
      });
    }

    // Survivor special abilities
    if (actor.type === EntityType.SURVIVOR && actor.ability) {
      const abilityAction = _buildAbilityAction(state, actor);
      if (abilityAction) actions.push(abilityAction);
    }
  }

  return actions;
}

function _buildAbilityAction(state, actor) {
  switch (actor.ability) {
    case SurvivorAbility.HEAL: {
      // Hero must be on same hex and not at full HP
      const heroHere = state.hero.alive &&
        state.hero.col === actor.col && state.hero.row === actor.row &&
        state.hero.hp < state.hero.maxHp;
      if (!heroHere) return null;
      return { type: ActionType.USE_ABILITY, ability: SurvivorAbility.HEAL };
    }
    case SurvivorAbility.INSPIRE:
      return { type: ActionType.USE_ABILITY, ability: SurvivorAbility.INSPIRE };
    case SurvivorAbility.RALLY:
      return { type: ActionType.USE_ABILITY, ability: SurvivorAbility.RALLY };
    default:
      return null;  // passive abilities have no button
  }
}

function pickSummonType(inv) {
  if ((inv[ResourceType.METAL] || 0) > 0) return EntityType.IRON_GOLEM;
  if ((inv[ResourceType.WOOD]  || 0) > 0) return EntityType.WOOD_GOLEM;
  return EntityType.MINION;
}

// ── Execution ──────────────────────────────────────────────────────────────

export function executeMove(state, actor, targetCol, targetRow) {
  const log = [];
  const t = tile(state, targetCol, targetRow);
  if (!t || t.type === TileType.RIVER)
    return { success: false, log: ['Cannot move there.'] };

  actor.col = targetCol;
  actor.row = targetRow;

  if (t.type === TileType.BUILDING) {
    log.push(`${actor.displayName} enters the ${t.building || 'building'}.`);
  } else {
    log.push(`${actor.displayName} moves to (${targetCol},${targetRow}).`);
  }

  return { success: true, log, cost: 1 };
}

export function executeExplore(state, actor) {
  const log = [];
  const t = tile(state, actor.col, actor.row);
  if (t.explored) return { success: false, log: ['Already explored.'] };

  t.explored = true;

  // HERBALIST ability: also yield 1 herbs on any explore
  const isHerbalist = actor.type === EntityType.SURVIVOR &&
    actor.ability === SurvivorAbility.HERBALIST;

  if (t.type === TileType.BUILDING && t.building && BUILDING_LOOT[t.building]) {
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
    log.push(`${actor.displayName} searches carefully… nothing useful found.`);
  }

  if (isHerbalist && actor.owner === 'hero') {
    state.inventory.hero[ResourceType.HERBS] =
      (state.inventory.hero[ResourceType.HERBS] || 0) + 1;
    log.push(`${actor.displayName}'s keen eye also finds Herbs!`);
  }

  return { success: true, log, cost: 1 };
}

function _applyLoot(state, actor, lootType, log) {
  if (lootType === 'nothing') {
    log.push(`${actor.displayName} searches carefully… nothing useful found.`);
    return;
  }

  if (lootType === 'horse') {
    if (actor.owner === 'hero') {
      state.inventory.hero['horse'] = 1;
      log.push(`Found a horse at the Stables! The hero's movement range increases to 2.`);
    }
    return;
  }

  if (lootType === 'survivor') {
    if (actor.owner === 'hero') {
      const s = createSurvivor(actor.col, actor.row);
      s.owner = 'hero';
      state.entities.push(s);
      log.push(`A survivor emerges — ${s.name}, the ${s.title}! They join the party.`);
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
      log.push(`The witch finds a weapon but has no use for it.`);
    }
    return;
  }

  // Resource
  if (actor.owner === 'hero') {
    state.inventory.hero[lootType] = (state.inventory.hero[lootType] || 0) + 1;
    log.push(`Found ${lootType}! Added to supplies.`);
  } else {
    state.inventory.witch[lootType] = (state.inventory.witch[lootType] || 0) + 1;
    log.push(`The witch secures ${lootType} for dark rituals.`);
  }
}

export function executeBattle(state, actor, target) {
  const log = [];

  // Phase combat bonus: +1 ATK for hero-side during DAY, witch-side during NIGHT
  let phaseBonus = 0;
  if (state.phase === Phase.DAY   && actor.owner === 'hero')  phaseBonus = 1;
  if (state.phase === Phase.NIGHT && actor.owner === 'witch') phaseBonus = 1;

  const { attackRoll, defenseRoll, hit } = Entity.resolveCombat(actor, target, phaseBonus);

  // Fortification bonus
  const defTile = tile(state, target.col, target.row);
  if (defTile?.fortifyLevel) target.defenseBonus += defTile.fortifyLevel;

  const phaseNote = phaseBonus > 0
    ? ` (${state.phase === Phase.DAY ? '☀ day bonus' : '🌙 night bonus'})`
    : '';

  log.push(
    `${actor.displayName} attacks ${target.displayName}! ` +
    `[${attackRoll} vs ${defenseRoll}]${phaseNote}`
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

  // FORTIFY_DOUBLE: this survivor's ability makes wood act like metal
  const hasDoubler = actor.type === EntityType.SURVIVOR &&
    actor.ability === SurvivorAbility.FORTIFY_DOUBLE;

  if (metalCount > 0) {
    inv[ResourceType.METAL]--;
    t.fortifyLevel = 2;
    return { success: true, log: [`${actor.displayName} reinforces the building with metal! (+2 DEF)`], cost: 1 };
  } else if (woodCount > 0) {
    inv[ResourceType.WOOD]--;
    if (hasDoubler) {
      t.fortifyLevel = 2;
      return { success: true, log: [`${actor.displayName} fortifies to full strength with wood! (+2 DEF)`], cost: 1 };
    } else {
      t.fortifyLevel = Math.min(t.fortifyLevel + 1, 1);
      return { success: true, log: [`${actor.displayName} fortifies the building with wood! (+1 DEF)`], cost: 1 };
    }
  }

  return { success: false, log: ['No wood or metal to fortify with.'] };
}

export function executeSummon(state, actor, targetCol, targetRow) {
  const inv = state.inventory.witch;
  let summonedUnit, res, unitName;

  if ((inv[ResourceType.METAL] || 0) > 0) {
    res = ResourceType.METAL;
    summonedUnit = createIronGolem(targetCol, targetRow);
    unitName = 'Iron Golem';
  } else if ((inv[ResourceType.WOOD] || 0) > 0) {
    res = ResourceType.WOOD;
    summonedUnit = createWoodGolem(targetCol, targetRow);
    unitName = 'Wood Golem';
  } else {
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
    return { success: true, log: [`${actor.displayName} equips ${label}!`], cost: 0 };
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
      log.push(`${actor.displayName} coats weapon in silver. +1 ATK this turn.`);
      break;
    case ResourceType.SCRIPTURE:
      log.push(`${actor.displayName} recites scripture. Ward placed.`);
      break;
  }
  return { success: true, log, cost: 0 };
}

export function executeUseAbility(state, actor) {
  const log = [];

  switch (actor.ability) {
    case SurvivorAbility.HEAL: {
      const hero = state.hero;
      if (!hero.alive || hero.col !== actor.col || hero.row !== actor.row)
        return { success: false, log: ['Hero must be on the same hex.'] };
      if (hero.hp >= hero.maxHp)
        return { success: false, log: ['Hero is already at full health.'] };
      hero.heal(1);
      log.push(`${actor.displayName} tends the hero's wounds. (+1 HP, now ${hero.hp}/${hero.maxHp})`);
      return { success: true, log, cost: 1 };
    }

    case SurvivorAbility.INSPIRE:
      state.hero.attackBonus += 1;
      log.push(`${actor.displayName} rallies the hero! (+1 ATK this battle)`);
      return { success: true, log, cost: 0 };

    case SurvivorAbility.RALLY:
      state.bonusActions += 1;
      log.push(`${actor.displayName}'s words fortify the hero's spirit! (+1 bonus action)`);
      return { success: true, log, cost: 0 };

    default:
      return { success: false, log: ['No active ability.'] };
  }
}
