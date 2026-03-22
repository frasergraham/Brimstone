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

function hasEnemy(state, actor, col, row) {
  return state.entities.some(e => e.alive && e.owner !== actor.owner && e.col === col && e.row === row);
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
        if (hasEnemy(state, actor, n.col, n.row)) continue;
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

// Base sight range varies by phase: Day=3, Dawn/Dusk=2, Night=1.
// SCOUT survivors add +1 to their personal range.
export function sightRange(phase, isScout = false) {
  let base;
  switch (phase) {
    case Phase.DAY:   base = 3; break;
    case Phase.NIGHT: base = 1; break;
    default:          base = 2; break; // DAWN, DUSK
  }
  return base + (isScout ? 1 : 0);
}

// Returns a Set of hexKeys where witch-side entities are visible to hero units.
export function getVisibleEnemyHexes(state) {
  const revealed = new Set();
  for (const e of state.entities) {
    if (!e.alive || e.owner !== 'hero') continue;
    const range = sightRange(state.phase, e.ability === SurvivorAbility.SCOUT);
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
  const hasHorse = actor.owner === 'hero' && (actor.items?.['horse'] || 0) > 0;
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

  // Fortify — hero on any tile (not river), cap at 4, uses shared inventory
  if (t && t.type !== TileType.RIVER && t.fortifyLevel < 4 && actorIsHero) {
    const shared     = state.inventory.shared;
    const woodCount  = (shared[ResourceType.WOOD]  || 0);
    const metalCount = (shared[ResourceType.METAL] || 0);
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
    const shared  = state.inventory.shared;
    const myItems = actor.items || {};

    // Per-unit items: herbs, weapons
    if ((myItems[ResourceType.HERBS] || 0) > 0 && actor.hp < actor.maxHp)
      usable.push({ item: ResourceType.HERBS, label: '🌿 Herbs (heal 2)', source: 'items' });

    // Shared resources
    if ((shared[ResourceType.FOOD] || 0) > 0)
      usable.push({ item: ResourceType.FOOD, label: '🍞 Food (+1 action)', source: 'shared' });
    if ((shared[ResourceType.SILVER] || 0) > 0)
      usable.push({ item: ResourceType.SILVER, label: '🪙 Silver (+1 ATK)', source: 'shared' });
    if ((shared[ResourceType.SCRIPTURE] || 0) > 0 && battleTargets.length)
      usable.push({ item: ResourceType.SCRIPTURE, label: '📜 Scripture (ward)', source: 'shared' });

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
  if (hasEnemy(state, actor, targetCol, targetRow))
    return { success: false, log: ['An enemy blocks the way.'] };

  actor.col = targetCol;
  actor.row = targetRow;

  if (t.type === TileType.BUILDING) {
    log.push(`${actor.displayName} enters the ${t.building || 'building'}.`);
  } else {
    log.push(`${actor.displayName} moves to (${targetCol},${targetRow}).`);
  }

  // Hidden survivor encounter — triggers once per tile for any unit that steps on it
  const encounterLog = [];
  if (t.hiddenSurvivor) {
    t.hiddenSurvivor = false;
    if (actor.owner === 'hero') {
      const s = createSurvivor(targetCol, targetRow);
      s.owner = 'hero';
      state.entities.push(s);
      encounterLog.push(`A survivor steps out of hiding — ${s.name}, the ${s.title}! They join the party.`);
    } else {
      const z = createZombie(targetCol, targetRow);
      state.entities.push(z);
      encounterLog.push(`A cowering survivor is found… raised as a zombie by the witch!`);
    }
    log.push(...encounterLog);
  }

  return { success: true, log, cost: 1, encounterLog };
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
    const lootType = rollLoot(BUILDING_LOOT[t.building]);
    _applyLoot(state, actor, lootType, log);
  } else {
    const terrainTable = TERRAIN_LOOT[t.type] || TERRAIN_LOOT['grass'];
    const lootType = rollLoot(terrainTable);
    _applyLoot(state, actor, lootType, log);
  }

  if (isHerbalist && actor.owner === 'hero') {
    actor.items[ResourceType.HERBS] = (actor.items[ResourceType.HERBS] || 0) + 1;
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
      actor.items['horse'] = 1;
      log.push(`Found a horse! ${actor.displayName}'s movement range increases to 2.`);
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
      actor.items[lootType] = (actor.items[lootType] || 0) + 1;
      log.push(`Found Herbs! Added to ${actor.displayName}'s pack.`);
    }
    return;
  }

  // All other resources are shared
  if (actor.owner === 'hero') {
    state.inventory.shared[lootType] = (state.inventory.shared[lootType] || 0) + 1;
    log.push(`Found ${lootType}! Added to shared supplies.`);
  } else {
    state.inventory.witch[lootType] = (state.inventory.witch[lootType] || 0) + 1;
    log.push(`The witch secures ${lootType} for dark rituals.`);
  }
}

// Count how many allies (same owner, excluding self) are on the same or adjacent hexes
function allyCount(state, entity) {
  const neighbors = getNeighbors(entity.col, entity.row);
  const friendlyHexes = new Set([hexKey(entity.col, entity.row)]);
  for (const n of neighbors) friendlyHexes.add(hexKey(n.col, n.row));
  return state.entities.filter(e =>
    e.alive && e.id !== entity.id && e.owner === entity.owner &&
    friendlyHexes.has(hexKey(e.col, e.row))
  ).length;
}

export function executeBattle(state, actor, target) {
  const log = [];

  // Phase bonus
  let phaseBonus = 0;
  if (state.phase === Phase.DAY   && actor.owner === 'hero')  phaseBonus = 1;
  if (state.phase === Phase.NIGHT && actor.owner === 'witch') phaseBonus = 1;

  // Compute situational bonuses without touching entity fields
  const attackerAllies = allyCount(state, actor);
  const defenderAllies = allyCount(state, target);
  const defTile        = tile(state, target.col, target.row);
  const fortBonus      = defTile?.fortifyLevel || 0;

  const extraAtkBonus = attackerAllies >= 3 ? 1 : 0;
  const extraDefBonus = fortBonus + (defenderAllies > 0 ? 1 : 0);

  const { attackRoll, defenseRoll, hit, margin } =
    Entity.resolveCombat(actor, target, phaseBonus, extraAtkBonus, extraDefBonus);

  const phaseNote  = phaseBonus > 0
    ? ` (${state.phase === Phase.DAY ? '☀ day bonus' : '🌙 night bonus'})`
    : '';
  const gangNote   = attackerAllies >= 3 ? ' [gang-up +1]' : '';
  const allyDefNote = defenderAllies > 0 ? ' [allies +1]' : '';

  log.push(
    `${actor.displayName} attacks ${target.displayName}! ` +
    `[${attackRoll}${gangNote} vs ${defenseRoll}${allyDefNote}]${phaseNote}`
  );

  let killed     = false;
  let damage     = 0;          // damage dealt to target
  let counterDmg = 0;          // damage dealt to attacker (counter)
  let fortAbsorbed = 0;        // how many fortify levels were consumed

  if (hit) {
    // Great roll (margin >= 4) deals 2 damage instead of 1
    const totalDmg = margin >= 4 ? 2 : 1;

    for (let d = 0; d < totalDmg; d++) {
      if (defTile && defTile.fortifyLevel > 0) {
        // Fortification absorbs this point of damage
        defTile.fortifyLevel -= 1;
        fortAbsorbed += 1;
        log.push(`🏰 The fortifications take the blow! (now +${defTile.fortifyLevel} DEF)`);
      } else {
        // Damage goes to the entity
        damage += 1;
        const wasKilled = target.takeDamage(1);
        if (wasKilled) { killed = true; break; }
      }
    }

    if (killed) {
      log.push(`${target.displayName} is slain!`);
      state.entities = state.entities.filter(e => e.id !== target.id);
    } else if (damage > 0) {
      const label = damage >= 2 ? `${damage} damage (crushing blow!)` : `${damage} damage`;
      log.push(`${target.displayName} takes ${label}. (${target.hp}/${target.maxHp} HP)`);
    }
    if (margin >= 4) log.push(`💥 Crushing blow! (margin +${margin})`);
  } else {
    log.push(`${target.displayName} defends successfully.`);

    // Great defense (margin <= -4): defender counter-attacks the attacker
    if (margin <= -4 && actor.alive) {
      const counterKilled = actor.takeDamage(1);
      counterDmg = 1;
      log.push(`⚔ ${target.displayName} counter-attacks! ${actor.displayName} takes 1 damage.`);
      if (counterKilled) {
        log.push(`${actor.displayName} is slain by the counter!`);
        state.entities = state.entities.filter(e => e.id !== actor.id);
      } else {
        log.push(`${actor.displayName} is at ${actor.hp}/${actor.maxHp} HP.`);
      }
    }
  }

  return {
    success: true, log, cost: 1,
    attackRoll, defenseRoll, hit, killed,
    margin, damage, counterDmg, fortAbsorbed,
    attackerAllies, defenderAllies,
  };
}

export function executeFortify(state, actor) {
  const t = tile(state, actor.col, actor.row);
  if (!t || t.type === TileType.RIVER) return { success: false, log: ['Cannot fortify here.'] };
  if (t.fortifyLevel >= 4) return { success: false, log: ['Cannot fortify further.'] };

  const shared     = state.inventory.shared;
  const metalCount = (shared[ResourceType.METAL] || 0);
  const woodCount  = (shared[ResourceType.WOOD]  || 0);

  // FORTIFY_DOUBLE: this survivor's ability makes wood give +2
  const hasDoubler = actor.type === EntityType.SURVIVOR &&
    actor.ability === SurvivorAbility.FORTIFY_DOUBLE;

  if (metalCount > 0) {
    shared[ResourceType.METAL]--;
    t.fortifyLevel = Math.min(4, t.fortifyLevel + 2);
    return { success: true, log: [`${actor.displayName} reinforces with metal! (now +${t.fortifyLevel} DEF)`], cost: 1 };
  } else if (woodCount > 0) {
    shared[ResourceType.WOOD]--;
    const gain = hasDoubler ? 2 : 1;
    t.fortifyLevel = Math.min(4, t.fortifyLevel + gain);
    const star = hasDoubler ? ' ★' : '';
    return { success: true, log: [`${actor.displayName} fortifies with wood!${star} (now +${t.fortifyLevel} DEF)`], cost: 1 };
  }

  return { success: false, log: ['No wood or metal in shared supplies.'] };
}

export function executeSummon(state, actor, targetCol, targetRow) {
  if ((state.witchSummonsThisTurn || 0) >= 1) {
    return { success: false, log: ['The witch can only summon once per turn.'] };
  }
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
  state.witchSummonsThisTurn = (state.witchSummonsThisTurn || 0) + 1;
  return {
    success: true,
    log: [`The witch raises a ${unitName} from ${res}!`],
    cost: 1,
  };
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
    actor.heal(2);
    return { success: true, log: [`${actor.displayName} uses herbs. Healed to ${actor.hp}/${actor.maxHp} HP.`], cost: 0 };
  }

  // Shared resources
  const shared = state.inventory.shared;
  if ((shared[item] || 0) < 1) return { success: false, log: ['Item not available.'] };
  shared[item]--;
  const log = [];

  switch (item) {
    case ResourceType.FOOD:
      if (actor.type !== 'hero') return { success: false, log: ['Only the hero can eat food.'] };
      state.actionsLeft += 1;
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
      state.actionsLeft += 1;
      log.push(`${actor.displayName}'s words fortify the hero's spirit! (+1 action)`);
      return { success: true, log, cost: 0 };

    default:
      return { success: false, log: ['No active ability.'] };
  }
}
