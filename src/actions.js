// Action system: definitions, validation, and execution
import { getNeighbors, hexKey, hexDistance } from './hex.js';
import { TileType, ResourceType, WEAPON_LABEL, BUILDING_LOOT, TERRAIN_LOOT, rollLoot } from './tiles.js';
import {
  EntityType, SurvivorAbility, Entity,
  createZombie, createMinion, createSurvivor,
  createWoodGolem, createIronGolem,
} from './entities.js';
import { Phase } from './game.js';

export const ActionType = Object.freeze({
  MOVE:                 'move',
  EXPLORE:              'explore',
  BATTLE:               'battle',
  FORTIFY:              'fortify',
  SUMMON:               'summon',
  USE_ITEM:             'use_item',
  EQUIP_WEAPON:         'equip_weapon',
  USE_ABILITY:          'use_ability',
  GIVE_WEAPON:          'give_weapon',
  ATTACK_FORTIFICATION: 'attack_fortification',
  PLACE_TRAP:           'place_trap',
  END_TURN:             'end_turn',
});

// ── Helpers ────────────────────────────────────────────────────────────────

function tile(state, col, row) {
  return state.tiles.get(hexKey(col, row));
}

function getReachableHexes(state, actor, range) {
  const isWitch = actor.owner === 'witch';
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
        // Witch units cannot enter fortified tiles
        if (isWitch && nt.fortifyLevel > 0) continue;
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

// ── Visibility ─────────────────────────────────────────────────────────────

// Returns a Set of hexKeys where witch-side entities are visible to hero units.
// Baseline: any hero-side unit reveals enemies within 2 hexes.
// SCOUT survivors extend their personal range to 3 hexes.
export function getVisibleEnemyHexes(state) {
  const revealed = new Set();
  for (const e of state.entities) {
    if (!e.alive || e.owner !== 'hero') continue;
    const range = e.ability === SurvivorAbility.SCOUT ? 3 : 2;
    for (const we of state.entities) {
      if (!we.alive || we.owner !== 'witch') continue;
      if (hexDistance(e.col, e.row, we.col, we.row) <= range) {
        revealed.add(hexKey(we.col, we.row));
      }
    }
  }
  return revealed;
}

// ── Validation ─────────────────────────────────────────────────────────────

export function getValidActions(state, actor) {
  const actions = [];
  const t = tile(state, actor.col, actor.row);
  const actorIsHero = actor.owner === 'hero';

  // Move — range 2 if actor has a horse in personal items, otherwise 1
  const hasHorse = actorIsHero && (actor.items?.['horse'] || 0) > 0;
  const moveTargets = getReachableHexes(state, actor, hasHorse ? 2 : 1);
  if (moveTargets.length) actions.push({ type: ActionType.MOVE, targets: moveTargets });

  // Explore — available on any unexplored tile
  if (t && !t.explored) {
    actions.push({ type: ActionType.EXPLORE, targets: [{ col: actor.col, row: actor.row }] });
  }

  // Battle
  const battleTargets = [
    ...sameHexEnemies(state, actor),
    ...adjacentEnemies(state, actor),
  ];
  if (battleTargets.length) actions.push({ type: ActionType.BATTLE, targets: battleTargets });

  // Fortify — hero-side on any tile, cap depends on tile type
  if (t && actorIsHero) {
    const maxFortify = t.type === TileType.BUILDING ? 8 : 4;
    if (t.fortifyLevel < maxFortify) {
      const shared     = state.inventory.shared;
      const woodCount  = (shared[ResourceType.WOOD]  || 0);
      const metalCount = (shared[ResourceType.METAL] || 0);
      if (woodCount > 0 || metalCount > 0) {
        actions.push({ type: ActionType.FORTIFY, targets: [{ col: actor.col, row: actor.row }] });
      }
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

  // Attack fortification — witch-side, adjacent to any tile with fortifyLevel > 0
  if (!actorIsHero) {
    const fortTargets = getNeighbors(actor.col, actor.row).filter(n => {
      const nt = tile(state, n.col, n.row);
      return nt && nt.fortifyLevel > 0;
    });
    if (fortTargets.length) {
      actions.push({ type: ActionType.ATTACK_FORTIFICATION, targets: fortTargets });
    }
  }

  // Use item (hero-side)
  if (actorIsHero) {
    const usable = [];
    const shared  = state.inventory.shared;
    const myItems = actor.items || {};

    // Per-unit items: herbs, weapons
    if ((myItems[ResourceType.HERBS] || 0) > 0 && actor.hp < actor.maxHp)
      usable.push({ item: ResourceType.HERBS, label: 'Use Herbs (heal 1 HP)', source: 'items' });

    // Shared resources
    if ((shared[ResourceType.FOOD] || 0) > 0)
      usable.push({ item: ResourceType.FOOD, label: 'Eat Food (+1 action)', source: 'shared' });
    if ((shared[ResourceType.SILVER] || 0) > 0)
      usable.push({ item: ResourceType.SILVER, label: 'Silver (+1 ATK this battle)', source: 'shared' });
    if ((shared[ResourceType.SCRIPTURE] || 0) > 0 && battleTargets.length)
      usable.push({ item: ResourceType.SCRIPTURE, label: 'Scripture (ward enemy)', source: 'shared' });

    if (usable.length) actions.push({ type: ActionType.USE_ITEM, usable });

    // Equip weapon from actor's personal items
    const weapons = Object.keys(myItems)
      .filter(k => k.startsWith('weapon:') && (myItems[k] || 0) > 0);
    if (weapons.length) {
      actions.push({
        type: ActionType.EQUIP_WEAPON,
        weapons: weapons.map(k => ({
          key: k,
          label: WEAPON_LABEL[k.replace('weapon:', '')] || k,
        })),
      });
    }

    // Give weapon to survivor on same hex (hero only)
    if (actor.type === EntityType.HERO) {
      const survivorsHere = entitiesAt(state, actor.col, actor.row)
        .filter(e => e.owner === 'hero' && e.type === EntityType.SURVIVOR);
      const myWeapons = Object.keys(myItems)
        .filter(k => k.startsWith('weapon:') && (myItems[k] || 0) > 0);
      if (survivorsHere.length > 0 && myWeapons.length > 0) {
        const gifts = [];
        for (const wKey of myWeapons) {
          for (const s of survivorsHere) {
            gifts.push({ weaponKey: wKey, survivorId: s.id, survivorName: s.displayName });
          }
        }
        actions.push({ type: ActionType.GIVE_WEAPON, gifts });
      }
    }

    // Place trap — costs 2 Wood + 1 Metal, no existing trap on this tile
    if (t && !t.hasTrap) {
      const shared = state.inventory.shared;
      if ((shared[ResourceType.WOOD] || 0) >= 2 && (shared[ResourceType.METAL] || 0) >= 1) {
        actions.push({ type: ActionType.PLACE_TRAP, targets: [{ col: actor.col, row: actor.row }] });
      }
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

  // Witch units blocked by fortified tiles
  if (actor.owner === 'witch' && t.fortifyLevel > 0)
    return { success: false, log: ['That position is fortified. Destroy the fortification first.'] };

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

  // HERBALIST ability: also yield 1 herbs on any explore (goes to actor's items)
  const isHerbalist = actor.type === EntityType.SURVIVOR &&
    actor.ability === SurvivorAbility.HERBALIST;

  if (t.type === TileType.BUILDING && t.building && BUILDING_LOOT[t.building]) {
    const loot = rollLoot(BUILDING_LOOT[t.building]);
    _applyLoot(state, actor, loot.type, log, loot.qty);
  } else {
    const terrainTable = TERRAIN_LOOT[t.type] || TERRAIN_LOOT['grass'];
    const loot = rollLoot(terrainTable);
    _applyLoot(state, actor, loot.type, log, loot.qty);
  }

  if (isHerbalist && actor.owner === 'hero') {
    actor.items[ResourceType.HERBS] = (actor.items[ResourceType.HERBS] || 0) + 1;
    log.push(`${actor.displayName}'s keen eye also finds Herbs!`);
  }

  return { success: true, log, cost: 1 };
}

function _applyLoot(state, actor, lootType, log, qty = 1) {
  if (lootType === 'nothing') {
    log.push(`${actor.displayName} searches carefully… nothing useful found.`);
    return;
  }

  if (lootType === 'horse') {
    if (actor.owner === 'hero') {
      actor.items['horse'] = 1;
      log.push(`Found a horse! ${actor.displayName}'s movement range increases to 2.`);
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
    if (actor.owner === 'hero') {
      actor.items[lootType] = (actor.items[lootType] || 0) + 1;
      const weaponKey = lootType.replace('weapon:', '');
      log.push(`Found a ${WEAPON_LABEL[weaponKey] || weaponKey}! Added to ${actor.displayName}'s pack.`);
    } else {
      log.push(`The witch finds a weapon but has no use for it.`);
    }
    return;
  }

  if (lootType === ResourceType.HERBS) {
    // Herbs are per-unit (potions)
    if (actor.owner === 'hero') {
      actor.items[lootType] = (actor.items[lootType] || 0) + qty;
      const qtyStr = qty > 1 ? ` ×${qty}` : '';
      log.push(`Found Herbs${qtyStr}! Added to ${actor.displayName}'s pack.`);
    }
    return;
  }

  // All other resources are shared
  if (actor.owner === 'hero') {
    state.inventory.shared[lootType] = (state.inventory.shared[lootType] || 0) + qty;
    const qtyStr = qty > 1 ? ` ×${qty}` : '';
    log.push(`Found ${lootType}${qtyStr}! Added to shared supplies.`);
  } else {
    state.inventory.witch[lootType] = (state.inventory.witch[lootType] || 0) + qty;
    const qtyStr = qty > 1 ? ` ×${qty}` : '';
    log.push(`The witch secures ${qtyStr}${lootType} for dark rituals.`);
  }
}

export function executeBattle(state, actor, target) {
  const log = [];

  let phaseBonus = 0;
  if (state.phase === Phase.DAY   && actor.owner === 'hero')  phaseBonus = 1;
  if (state.phase === Phase.NIGHT && actor.owner === 'witch') phaseBonus = 1;

  const defTile = tile(state, target.col, target.row);
  if (defTile?.fortifyLevel) target.defenseBonus += defTile.fortifyLevel;

  const { attackRoll, defenseRoll, hit } = Entity.resolveCombat(actor, target, phaseBonus);

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
      // When the witch kills a survivor, raise them as a zombie
      if (actor.owner === 'witch' && target.type === EntityType.SURVIVOR) {
        const z = createZombie(target.col, target.row);
        state.entities.push(z);
        log.push(`${target.displayName} rises from the dead as a zombie!`);
      }
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
  if (!t) return { success: false, log: ['No tile here.'] };

  const maxFortify = t.type === TileType.BUILDING ? 8 : 4;
  if (t.fortifyLevel >= maxFortify) return { success: false, log: ['Cannot fortify further.'] };

  const shared     = state.inventory.shared;
  const metalCount = (shared[ResourceType.METAL] || 0);
  const woodCount  = (shared[ResourceType.WOOD]  || 0);

  // FORTIFY_DOUBLE: this survivor's ability makes wood give +2
  const hasDoubler = actor.type === EntityType.SURVIVOR &&
    actor.ability === SurvivorAbility.FORTIFY_DOUBLE;

  if (metalCount > 0) {
    shared[ResourceType.METAL]--;
    t.fortifyLevel = Math.min(maxFortify, t.fortifyLevel + 2);
    return { success: true, log: [`${actor.displayName} reinforces with metal! (now +${t.fortifyLevel} DEF)`], cost: 1 };
  } else if (woodCount > 0) {
    shared[ResourceType.WOOD]--;
    const gain = hasDoubler ? 2 : 1;
    t.fortifyLevel = Math.min(maxFortify, t.fortifyLevel + gain);
    const star = hasDoubler ? ' ★' : '';
    return { success: true, log: [`${actor.displayName} fortifies with wood!${star} (now +${t.fortifyLevel} DEF)`], cost: 1 };
  }

  return { success: false, log: ['No wood or metal in shared supplies.'] };
}

export function executeSummon(state, actor, targetCol, targetRow) {
  const inv = state.inventory.witch;
  let primaryUnit, extraUnit, res, unitName;

  if ((inv[ResourceType.METAL] || 0) > 0) {
    res = ResourceType.METAL;
    primaryUnit = createIronGolem(targetCol, targetRow);
    unitName = 'Iron Golem';
  } else if ((inv[ResourceType.WOOD] || 0) > 0) {
    res = ResourceType.WOOD;
    primaryUnit = createWoodGolem(targetCol, targetRow);
    unitName = 'Wood Golem';
  } else {
    res = Object.keys(inv).find(k => inv[k] > 0);
    if (!res) return { success: false, log: ['No resources to summon.'] };
    primaryUnit = createMinion(targetCol, targetRow);
    unitName = 'Minion';
  }

  inv[res]--;
  state.entities.push(primaryUnit);

  const log = [`The witch raises a ${unitName} from ${res}!`];

  // Horde: always summon an extra minion on another adjacent empty hex
  const extraHex = getNeighbors(actor.col, actor.row).find(n => {
    const nt = tile(state, n.col, n.row);
    return nt && nt.type !== TileType.RIVER && entitiesAt(state, n.col, n.row).length === 0;
  });
  if (extraHex) {
    extraUnit = createMinion(extraHex.col, extraHex.row);
    state.entities.push(extraUnit);
    log.push(`The horde swells — a Minion surges forth alongside!`);
  }

  return { success: true, log, cost: 1 };
}

export function executeUseItem(state, actor, item) {
  // Weapon equip — from actor's personal items
  if (item.startsWith('weapon:')) {
    const myItems = actor.items || {};
    if ((myItems[item] || 0) < 1) return { success: false, log: ['Item not available.'] };
    myItems[item]--;
    const weaponType = item.replace('weapon:', '');
    actor.equipWeapon(weaponType);
    const label = WEAPON_LABEL[weaponType] || weaponType;
    return { success: true, log: [`${actor.displayName} equips ${label}!`], cost: 0 };
  }

  // Herbs — from actor's personal items
  if (item === ResourceType.HERBS) {
    const myItems = actor.items || {};
    if ((myItems[item] || 0) < 1) return { success: false, log: ['No herbs.'] };
    myItems[item]--;
    actor.heal(1);
    return { success: true, log: [`${actor.displayName} uses herbs. Healed to ${actor.hp}/${actor.maxHp} HP.`], cost: 0 };
  }

  // Shared resources
  const shared = state.inventory.shared;
  if ((shared[item] || 0) < 1) return { success: false, log: ['Item not available.'] };
  shared[item]--;
  const log = [];

  switch (item) {
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

export function executeGiveWeapon(state, actor, survivorId, weaponKey) {
  const survivor = state.entities.find(e => e.id === survivorId && e.alive);
  if (!survivor) return { success: false, log: ['Survivor not found.'] };
  const myItems = actor.items || {};
  if ((myItems[weaponKey] || 0) < 1) return { success: false, log: ['Weapon not available.'] };

  myItems[weaponKey]--;
  const weaponType = weaponKey.replace('weapon:', '');
  survivor.equipWeapon(weaponType);
  const label = WEAPON_LABEL[weaponType] || weaponType;
  return {
    success: true,
    log: [`${actor.displayName} gives ${label} to ${survivor.displayName}! They arm themselves immediately.`],
    cost: 1,
  };
}

export function executeAttackFortification(state, actor, targetCol, targetRow) {
  const t = tile(state, targetCol, targetRow);
  if (!t || t.fortifyLevel <= 0) return { success: false, log: ['No fortification to attack.'] };

  const log = [];
  t.fortifyLevel--;
  log.push(`${actor.displayName} tears at the fortification at (${targetCol},${targetRow})! (now +${t.fortifyLevel} DEF)`);

  // Trap triggers on attack
  if (t.hasTrap) {
    const dmg = t.trapDamage || 2;
    t.hasTrap    = false;
    t.trapDamage = 0;
    const killed = actor.takeDamage(dmg);
    log.push(`⚠ A trap springs! ${actor.displayName} takes ${dmg} damage!`);
    if (killed) {
      state.entities = state.entities.filter(e => e.id !== actor.id);
      log.push(`${actor.displayName} is destroyed by the trap!`);
    }
  }

  if (t.fortifyLevel === 0) {
    log.push(`The fortification crumbles! The path is open.`);
  }

  return { success: true, log, cost: 1 };
}

export function executePlaceTrap(state, actor) {
  const t = tile(state, actor.col, actor.row);
  if (!t) return { success: false, log: ['No tile here.'] };
  if (t.hasTrap) return { success: false, log: ['A trap is already set here.'] };

  const shared = state.inventory.shared;
  if ((shared[ResourceType.WOOD] || 0) < 2 || (shared[ResourceType.METAL] || 0) < 1) {
    return { success: false, log: ['Requires 2 Wood and 1 Metal.'] };
  }

  shared[ResourceType.WOOD]  -= 2;
  shared[ResourceType.METAL] -= 1;
  t.hasTrap    = true;
  t.trapDamage = 2;

  return {
    success: true,
    log: [`${actor.displayName} sets a hidden trap! Any witch unit that attacks this position will suffer for it.`],
    cost: 1,
  };
}
