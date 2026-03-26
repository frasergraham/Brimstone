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

// Cost-based movement: road/bridge/building tiles cost 1, all other passable
// tiles cost 2.  Budget = range * 2, so:
//   range 1 (no horse) → 1 off-road tile  OR  2 road tiles per action
//   range 2 (horse)    → 2 off-road tiles OR  4 road tiles per action
// posOverride lets the planner query reachability from a projected position
// rather than the entity's current position.
export function getReachableHexes(state, actor, range, posOverride = null) {
  const budget   = range * 2;
  const startCol = posOverride?.col ?? actor.col;
  const startRow = posOverride?.row ?? actor.row;
  const startK   = hexKey(startCol, startRow);
  const dist     = new Map([[startK, 0]]);
  // Sorted-array Dijkstra — grid is tiny (≤143 tiles).
  const queue    = [{ col: startCol, row: startRow, c: 0 }];

  while (queue.length) {
    queue.sort((a, b) => a.c - b.c);
    const { col, row, c } = queue.shift();
    if (c > (dist.get(hexKey(col, row)) ?? Infinity)) continue;
    for (const n of getNeighbors(col, row)) {
      const nk = hexKey(n.col, n.row);
      const nt = tile(state, n.col, n.row);
      if (!nt || nt.type === TileType.RIVER) continue;
      if (hasEnemy(state, actor, n.col, n.row)) continue;
      if (nt.fortifyLevel > 0 && state.entities.some(
        e => e.alive && e.owner !== actor.owner && e.col === n.col && e.row === n.row
      )) continue;
      const isRoadLike = nt.type === TileType.ROAD || nt.type === TileType.BRIDGE ||
                         nt.type === TileType.BUILDING;
      const nc = c + (isRoadLike ? 1 : 2);
      if (nc <= budget && nc < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, nc);
        queue.push({ col: n.col, row: n.row, c: nc });
      }
    }
  }

  const reachable = [];
  for (const [k, d] of dist) {
    if (k === startK || d > budget) continue;
    const [col, row] = k.split(',').map(Number);
    reachable.push({ col, row });
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

// Returns a Set of hexKeys where hero-side entities are visible to witch units.
export function getVisibleHeroHexes(state) {
  const revealed = new Set();
  for (const we of state.entities) {
    if (!we.alive || we.owner !== 'witch') continue;
    const range = sightRange(state.phase, false);
    for (const he of state.entities) {
      if (!he.alive || he.owner !== 'hero') continue;
      if (hexDistance(we.col, we.row, he.col, he.row) <= range) {
        revealed.add(hexKey(he.col, he.row));
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
      // Check for a co-located hero owned by the same player (or any hero-faction leader)
      const heroHere = state.entities.find(e =>
        e.alive && e.type === EntityType.HERO &&
        e.col === actor.col && e.row === actor.row &&
        (e.ownerId === actor.ownerId || e.owner === 'hero') &&
        e.hp < e.maxHp
      );
      if (!heroHere) return null;
      return { type: ActionType.USE_ABILITY, ability: SurvivorAbility.HEAL };
    }
    case SurvivorAbility.INSPIRE: {
      // Only available when a hero is on the same hex
      const heroHere = state.entities.some(e =>
        e.alive && e.type === EntityType.HERO &&
        e.col === actor.col && e.row === actor.row &&
        (e.ownerId === actor.ownerId || e.owner === 'hero')
      );
      if (!heroHere) return null;
      return { type: ActionType.USE_ABILITY, ability: SurvivorAbility.INSPIRE };
    }
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

  // Reachability check — road tiles cost half, so roads extend effective range.
  const hasHorse = actor.owner === 'hero' && (actor.items?.['horse'] || 0) > 0;
  const reachable = getReachableHexes(state, actor, hasHorse ? 2 : 1);
  if (!reachable.some(h => h.col === targetCol && h.row === targetRow))
    return { success: false, log: [`Cannot reach (${targetCol},${targetRow}) from current position.`] };

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
  let encounterSurvivor = null;
  if (t.hiddenSurvivor) {
    t.hiddenSurvivor = false;
    if (actor.owner === 'hero') {
      const s = createSurvivor(targetCol, targetRow, actor.ownerId);
      s.owner = 'hero';
      state.entities.push(s);
      const abilityNote = s.abilityLabel ? ` · ${s.abilityLabel}` : '';
      encounterLog.push(`☺ ${s.name} the ${s.title} steps out of hiding and joins the party! (HP ${s.hp}/${s.maxHp} · ATK ${s.attack} · DEF ${s.defense}${abilityNote})`);
      encounterSurvivor = {
        type: 'survivor',
        name: s.name, title: s.title,
        hp: s.hp, maxHp: s.maxHp,
        attack: s.attack, defense: s.defense,
        abilityLabel: s.abilityLabel,
        color: s.color,
      };
    } else {
      const z = createZombie(targetCol, targetRow, actor.ownerId);
      state.entities.push(z);
      encounterLog.push(`† A cowering survivor is found… raised as a zombie! (HP ${z.hp}/${z.maxHp} · ATK ${z.attack} · DEF ${z.defense})`);
      encounterSurvivor = {
        type: 'zombie',
        name: 'Zombie',
        hp: z.hp, maxHp: z.maxHp,
        attack: z.attack, defense: z.defense,
        color: z.color,
      };
    }
    log.push(...encounterLog);
  }

  return { success: true, log, cost: 1, encounterLog, encounterSurvivor };
}

export function executeExplore(state, actor) {
  const log = [];
  const lootItems = [];
  const t = tile(state, actor.col, actor.row);
  if (t.explored) return { success: false, log: ['Already explored.'], lootItems };

  t.explored = true;

  // HERBALIST ability: also yield 1 herbs on any explore (goes to actor's items)
  const isHerbalist = actor.type === EntityType.SURVIVOR &&
    actor.ability === SurvivorAbility.HERBALIST;

  if (t.type === TileType.BUILDING && t.building && BUILDING_LOOT[t.building]) {
    _applyLoot(state, actor, rollLoot(BUILDING_LOOT[t.building]), log, lootItems);
    _applyLoot(state, actor, rollLoot(BUILDING_LOOT[t.building]), log, lootItems);
  } else {
    const terrainTable = TERRAIN_LOOT[t.type] || TERRAIN_LOOT['grass'];
    _applyLoot(state, actor, rollLoot(terrainTable), log, lootItems);
    _applyLoot(state, actor, rollLoot(terrainTable), log, lootItems);
  }

  if (isHerbalist && actor.owner === 'hero') {
    actor.items[ResourceType.HERBS] = (actor.items[ResourceType.HERBS] || 0) + 1;
    log.push(`${actor.displayName}'s keen eye also finds Herbs!`);
    lootItems.push('+Herbs');
  }

  return { success: true, log, cost: 1, lootItems };
}

function _applyLoot(state, actor, lootType, log, lootItems) {
  if (lootType === 'nothing') {
    log.push(`${actor.displayName} searches carefully… nothing useful found.`);
    return;
  }

  if (lootType === 'horse') {
    if (actor.owner === 'hero') {
      actor.items['horse'] = 1;
      log.push(`Found a horse! ${actor.displayName}'s movement range increases to 2.`);
      lootItems?.push('+Horse');
    }
    return;
  }

  if (lootType.startsWith('weapon:')) {
    if (actor.owner === 'hero') {
      actor.items[lootType] = (actor.items[lootType] || 0) + 1;
      const weaponKey = lootType.replace('weapon:', '');
      const label = WEAPON_LABEL[weaponKey] || weaponKey;
      log.push(`Found a ${label}! Added to ${actor.displayName}'s pack.`);
      lootItems?.push(`+${label}`);
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
      lootItems?.push('+Herbs');
    }
    return;
  }

  // All other resources are shared
  const resLabel = lootType.charAt(0).toUpperCase() + lootType.slice(1);
  if (actor.owner === 'hero') {
    state.inventory.shared[lootType] = (state.inventory.shared[lootType] || 0) + 1;
    log.push(`Found ${lootType}! Added to shared supplies.`);
    lootItems?.push(`+${resLabel}`);
  } else {
    state.inventory.witch[lootType] = (state.inventory.witch[lootType] || 0) + 1;
    log.push(`The witch secures ${lootType} for dark rituals.`);
    lootItems?.push(`+${resLabel}`);
  }
}

export function executeBattle(state, actor, target) {
  const log = [];

  // Phase bonus
  let phaseBonus = 0;
  if (state.phase === Phase.DAY   && actor.owner === 'hero')  phaseBonus = 1;
  if (state.phase === Phase.NIGHT && actor.owner === 'witch') phaseBonus = 1;

  // Compute situational bonuses without touching entity fields
  // Gang-up: attacker allies adjacent to the TARGET (flanking/surrounding them)
  // Ally-def: defender allies adjacent to the TARGET (defending their position)
  const targetHexes = new Set([hexKey(target.col, target.row)]);
  for (const n of getNeighbors(target.col, target.row)) targetHexes.add(hexKey(n.col, n.row));

  const atkAllies = state.entities.filter(e =>
    e.alive && e.owner === actor.owner && e.id !== actor.id && targetHexes.has(hexKey(e.col, e.row))
  );
  const defAllies = state.entities.filter(e =>
    e.alive && e.owner === target.owner && e.id !== target.id && targetHexes.has(hexKey(e.col, e.row))
  );
  const attackerAllies = atkAllies.length;
  const defenderAllies = defAllies.length;
  const defTile        = tile(state, target.col, target.row);
  const fortBonus      = defTile?.fortifyLevel || 0;

  // Allies give an extra d3 rather than a flat +1 — more variance, bigger swings
  const extraAtkDice = attackerAllies >= 1 ? 1 : 0;  // 2+ combatants on attacker side
  const extraDefDice = defenderAllies >= 1 ? 1 : 0;  // 2+ combatants on defender side

  const { attackRoll, defenseRoll, hit, margin,
          atkBaseDie, defBaseDie, atkExtraDice, defExtraDice, atkStaffBonus } =
    Entity.resolveCombat(actor, target, phaseBonus, 0, fortBonus, extraAtkDice, extraDefDice);

  const phaseNote  = phaseBonus > 0
    ? ` (${state.phase === Phase.DAY ? '☀ day bonus' : '🌙 night bonus'})`
    : '';
  const gangNote    = attackerAllies >= 1 ? ' [gang-up +d3]' : '';
  const allyDefNote = defenderAllies >= 1 ? ' [allies +d3]'  : '';

  log.push(
    `${actor.displayName} attacks ${target.displayName}! ` +
    `[${attackRoll}${gangNote} vs ${defenseRoll}${allyDefNote}]${phaseNote}`
  );

  let killed     = false;
  let damage     = 0;          // damage dealt to target
  let counterDmg = 0;          // damage dealt to attacker (counter)
  let fortAbsorbed = 0;        // how many fortify levels were consumed

  if (hit) {
    // Crushing blow: attacker's roll is at least double the defender's roll
    const totalDmg = attackRoll >= 2 * defenseRoll ? 2 : 1;

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
    if (attackRoll >= 2 * defenseRoll) log.push(`💥 Crushing blow! (${attackRoll} vs ${defenseRoll})`);
  } else {
    log.push(`${target.displayName} defends successfully.`);

    // Tie (margin === 0) chips fortification by 1 — close call, cracks the walls
    if (margin === 0 && defTile && defTile.fortifyLevel > 0) {
      defTile.fortifyLevel -= 1;
      fortAbsorbed += 1;
      log.push(`🏰 The blow chips the fortifications! (now +${defTile.fortifyLevel} DEF)`);
    }

    // Counter-attack: defender's roll is at least double the attacker's roll
    if (defenseRoll >= 2 * attackRoll && actor.alive) {
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
    breakdown: {
      atkBaseDie, defBaseDie,
      atkExtraDice, defExtraDice,
      atkStaffBonus,
      phaseBonus, fortBonus,
      atkAllyNames: atkAllies.map(e => e.displayName),
      defAllyNames: defAllies.map(e => e.displayName),
    },
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

  const ownerId = actor.ownerId;
  if ((inv[ResourceType.METAL] || 0) > 0) {
    res = ResourceType.METAL;
    summonedUnit = createIronGolem(targetCol, targetRow, ownerId);
    unitName = 'Iron Golem';
  } else if ((inv[ResourceType.WOOD] || 0) > 0) {
    res = ResourceType.WOOD;
    summonedUnit = createWoodGolem(targetCol, targetRow, ownerId);
    unitName = 'Wood Golem';
  } else {
    res = Object.keys(inv).find(k => inv[k] > 0);
    if (!res) return { success: false, log: ['No resources to summon.'] };
    summonedUnit = createMinion(targetCol, targetRow, ownerId);
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
      // Return budgetBonus instead of mutating state.actionsLeft so both the
      // offline resolver and the multiplayer resolver can apply it per-player.
      log.push(`${actor.displayName} eats food. Gains 1 extra action!`);
      return { success: true, log, cost: 0, budgetBonus: 1 };
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
      // Heal the hero-type entity owned by the same player on the same hex.
      // Falls back to any hero-faction leader co-located (covers 1v1 offline).
      const hero = state.entities.find(e =>
        e.alive && e.type === EntityType.HERO &&
        e.col === actor.col && e.row === actor.row &&
        (e.ownerId === actor.ownerId || e.owner === 'hero')
      );
      if (!hero)
        return { success: false, log: ['A hero must be on the same hex.'] };
      if (hero.hp >= hero.maxHp)
        return { success: false, log: ['Hero is already at full health.'] };
      hero.heal(1);
      log.push(`${actor.displayName} tends ${hero.displayName}'s wounds. (+1 HP, now ${hero.hp}/${hero.maxHp})`);
      return { success: true, log, cost: 1 };
    }

    case SurvivorAbility.INSPIRE: {
      // Inspire the hero-type entity owned by the same player on the same hex.
      const hero = state.entities.find(e =>
        e.alive && e.type === EntityType.HERO &&
        e.col === actor.col && e.row === actor.row &&
        (e.ownerId === actor.ownerId || e.owner === 'hero')
      );
      if (!hero)
        return { success: false, log: ['A hero must be on the same hex.'] };
      hero.attackBonus += 1;
      log.push(`${actor.displayName} rallies ${hero.displayName}! (+1 ATK this battle)`);
      return { success: true, log, cost: 0 };
    }

    case SurvivorAbility.RALLY:
      // Return budgetBonus so both offline and multiplayer resolvers can apply it
      // per-player without touching the shared state.actionsLeft.
      log.push(`${actor.displayName}'s words fortify the hero's spirit! (+1 action)`);
      return { success: true, log, cost: 0, budgetBonus: 1 };

    default:
      return { success: false, log: ['No active ability.'] };
  }
}
