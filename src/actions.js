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
  BATTLE_HEX:   'battle_hex',  // Blind attack on a hex — for use through fog of war
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

// Find the shortest path (road-preferring) from actor's position to (toCol, toRow).
// Returns an array of {col, row} steps NOT including the start, up to the destination,
// or null if no path exists within the movement budget.
// posOverride allows querying from a projected position rather than actor's current pos.
function findShortestPath(state, actor, toCol, toRow, posOverride = null) {
  const startCol = posOverride?.col ?? actor.col;
  const startRow = posOverride?.row ?? actor.row;
  const startK   = hexKey(startCol, startRow);
  const goalK    = hexKey(toCol, toRow);
  if (startK === goalK) return [];

  const dist   = new Map([[startK, 0]]);
  const parent = new Map([[startK, null]]);
  const queue  = [{ col: startCol, row: startRow, c: 0 }];

  while (queue.length) {
    queue.sort((a, b) => a.c - b.c);
    const { col, row, c } = queue.shift();
    const k = hexKey(col, row);
    if (c > (dist.get(k) ?? Infinity)) continue;
    if (k === goalK) break;

    for (const n of getNeighbors(col, row)) {
      const nk = hexKey(n.col, n.row);
      const nt = tile(state, n.col, n.row);
      if (!nt || nt.type === TileType.RIVER) continue;
      if (hasEnemy(state, actor, n.col, n.row) && nk !== goalK) continue;
      const isRoadLike = nt.type === TileType.ROAD || nt.type === TileType.BRIDGE ||
                         nt.type === TileType.BUILDING;
      const nc = c + (isRoadLike ? 1 : 2);
      if (nc < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, nc);
        parent.set(nk, { col, row });
        queue.push({ col: n.col, row: n.row, c: nc });
      }
    }
  }

  if (!parent.has(goalK)) return null;

  // Reconstruct path from goal back to start
  const path = [];
  let cur = goalK;
  while (cur !== startK) {
    const [c, r] = cur.split(',').map(Number);
    path.unshift({ col: c, row: r });
    const p = parent.get(cur);
    if (!p) return null;
    cur = hexKey(p.col, p.row);
  }
  return path;
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
// Witch sight is always 2 hexes regardless of day/night phase.
export function getVisibleHeroHexes(state) {
  const revealed = new Set();
  for (const we of state.entities) {
    if (!we.alive || we.owner !== 'witch') continue;
    const range = 2; // witch has fixed 2-hex sight in all phases
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

  // Battle — targets visible enemies (UI applies fog filter on highlights)
  const battleTargets = [
    ...sameHexEnemies(state, actor),
    ...adjacentEnemies(state, actor),
  ];
  if (battleTargets.length) actions.push({ type: ActionType.BATTLE, targets: battleTargets });

  // Battle Hex — blind attack on any adjacent non-river hex (for attacking through fog).
  // Distinct from BATTLE: no enemy must be known to be present.
  // At resolution: attacks a random enemy on the hex; skips if hex is empty.
  const battleHexTargets = [
    { col: actor.col, row: actor.row }, // same hex (co-located)
    ...getNeighbors(actor.col, actor.row),
  ].filter(n => {
    const nt = tile(state, n.col, n.row);
    return nt && nt.type !== TileType.RIVER;
  });
  if (battleHexTargets.length) {
    actions.push({ type: ActionType.BATTLE_HEX, targets: battleHexTargets });
  }

  // Fortify — hero on any tile (not river, not a power node hex), cap at 4, uses shared inventory.
  // Always included when contextually valid; affordable=false when no resources.
  if (t && t.type !== TileType.RIVER && t.fortifyLevel < 4 && actorIsHero) {
    const onNodeHex = state.witchObjectives.some(obj =>
      obj.hexes.some(h => h.col === actor.col && h.row === actor.row)
    );
    if (!onNodeHex) {
      const shared     = state.inventory.shared;
      const woodCount  = (shared[ResourceType.WOOD]  || 0);
      const metalCount = (shared[ResourceType.METAL] || 0);
      const affordable = woodCount > 0 || metalCount > 0;
      actions.push({ type: ActionType.FORTIFY, targets: [{ col: actor.col, row: actor.row }], affordable });
    }
  }

  // Summon — witch only; three separate entries (one per unit type), each with
  // affordable flag.  The popup always shows all three so the player can choose.
  // affordable is per-type: iron_golem needs 2 metal, wood_golem needs 2 wood,
  // minion needs any 2 resources.
  // Summoned units spawn on the witch's own tile (no target hex needed).
  if (!actorIsHero) {
    const inv   = state.inventory.witch;
    const metal = inv[ResourceType.METAL] || 0;
    const wood  = inv[ResourceType.WOOD]  || 0;
    const total = Object.values(inv).reduce((s, v) => s + (v || 0), 0);
    if (total >= 2) {
      actions.push({ type: ActionType.SUMMON, summonType: EntityType.IRON_GOLEM, affordable: metal >= 2 });
      actions.push({ type: ActionType.SUMMON, summonType: EntityType.WOOD_GOLEM, affordable: wood  >= 2 });
      actions.push({ type: ActionType.SUMMON, summonType: EntityType.MINION,     affordable: true });
    }
  }

  // Herbs — available to any unit that carries them
  {
    const myItems = actor.items || {};
    if ((myItems[ResourceType.HERBS] || 0) > 0 && actor.hp < actor.maxHp) {
      actions.push({ type: ActionType.USE_ITEM, usable: [{ item: ResourceType.HERBS, label: '🌿 Herbs (heal 2)', source: 'items' }] });
    }
  }

  // Use item (hero-side)
  if (actorIsHero) {
    const usable = [];
    const shared  = state.inventory.shared;
    const myItems = actor.items || {};

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
  if ((inv[ResourceType.METAL] || 0) >= 2) return EntityType.IRON_GOLEM;
  if ((inv[ResourceType.WOOD]  || 0) >= 2) return EntityType.WOOD_GOLEM;
  return EntityType.MINION;
}

// ── Execution ──────────────────────────────────────────────────────────────

// Probability of spotting a hidden survivor when moving through a tile, by phase.
// Keys are the Phase enum string values ('dawn', 'day', 'dusk', 'night').
// Exploring a tile always finds survivors regardless of this table.
const SURVIVOR_FIND_CHANCE = Object.freeze({
  day:   0.50,
  dawn:  0.35,
  dusk:  0.35,
  night: 0.25,
});

// Reveal and materialise a hidden survivor (or zombie for the witch) on a tile.
// Clears the hiddenSurvivor flag and returns { encounterLog, encounterSurvivor }.
function _triggerSurvivorEncounter(state, actor, col, row) {
  const st = tile(state, col, row);
  if (!st?.hiddenSurvivor) return null;
  st.hiddenSurvivor = false;

  const encounterLog = [];
  let encounterSurvivor = null;

  if (actor.owner === 'hero') {
    const s = createSurvivor(col, row, actor.ownerId);
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
    const z = createZombie(col, row, actor.ownerId);
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

  return { encounterLog, encounterSurvivor };
}

export function executeMove(state, actor, targetCol, targetRow) {
  const log = [];

  // Reachability check — road tiles cost half, so roads extend effective range.
  const hasHorse = actor.owner === 'hero' && (actor.items?.['horse'] || 0) > 0;
  const reachable = getReachableHexes(state, actor, hasHorse ? 2 : 1);
  if (!reachable.some(h => h.col === targetCol && h.row === targetRow))
    return { success: false, log: [`Cannot reach (${targetCol},${targetRow}) from current position.`] };

  // Find the road-preferring path from current position to destination.
  const fullPath = findShortestPath(state, actor, targetCol, targetRow) ?? [{ col: targetCol, row: targetRow }];

  // Walk the path step by step; stop if an enemy blocks a mid-path hex.
  const walkedPath = [];
  const encounterLog = [];
  let encounterSurvivor = null;

  for (const step of fullPath) {
    // Check if this hex is blocked by an enemy (could have moved here since plan was made)
    if (hasEnemy(state, actor, step.col, step.row)) break;
    const st = tile(state, step.col, step.row);
    if (!st || st.type === TileType.RIVER) break;

    actor.col = step.col;
    actor.row = step.row;
    walkedPath.push({ col: step.col, row: step.row });

    // Hidden survivor encounter — phase-based chance on movement
    if (st.hiddenSurvivor && Math.random() < (SURVIVOR_FIND_CHANCE[state.phase] ?? 0.5)) {
      const enc = _triggerSurvivorEncounter(state, actor, step.col, step.row);
      if (enc) { encounterLog.push(...enc.encounterLog); encounterSurvivor = enc.encounterSurvivor; }
    }
  }

  if (walkedPath.length === 0)
    return { success: false, log: ['The way is blocked.'] };

  const finalStep = walkedPath[walkedPath.length - 1];
  const ft = tile(state, finalStep.col, finalStep.row);
  if (ft?.type === TileType.BUILDING) {
    log.push(`${actor.displayName} enters the ${ft.building || 'building'}.`);
  } else {
    log.push(`${actor.displayName} moves to (${finalStep.col},${finalStep.row}).`);
  }
  if (encounterLog.length) log.push(...encounterLog);

  return { success: true, log, cost: 1, path: walkedPath, encounterLog, encounterSurvivor };
}

export function executeExplore(state, actor) {
  const log = [];
  const lootItems = [];
  const t = tile(state, actor.col, actor.row);
  if (t.explored) return { success: false, log: ['Already explored.'], lootItems };

  t.explored = true;

  // Exploring always reveals a hidden survivor, regardless of phase.
  let encounterLog = [];
  let encounterSurvivor = null;
  if (t.hiddenSurvivor) {
    const enc = _triggerSurvivorEncounter(state, actor, actor.col, actor.row);
    if (enc) { encounterLog = enc.encounterLog; encounterSurvivor = enc.encounterSurvivor; }
  }

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
    lootItems.push('+🌿');
  }

  if (encounterLog.length) log.push(...encounterLog);
  return { success: true, log, cost: 1, lootItems, encounterLog, encounterSurvivor };
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
      lootItems?.push('+🐴');
    }
    return;
  }

  if (lootType.startsWith('weapon:')) {
    if (actor.owner === 'hero') {
      const weaponKey = lootType.replace('weapon:', '');
      const label = WEAPON_LABEL[weaponKey] || weaponKey;
      if (!actor.weapon) {
        actor.equipWeapon(weaponKey);
        log.push(`Found a ${label}! ${actor.displayName} equips it immediately.`);
        lootItems?.push('+⚔');
      } else {
        actor.items[lootType] = (actor.items[lootType] || 0) + 1;
        log.push(`Found a ${label}! Added to ${actor.displayName}'s pack.`);
        lootItems?.push('+⚔');
      }
    } else {
      log.push(`The witch finds a weapon but has no use for it.`);
    }
    return;
  }

  if (lootType === ResourceType.HERBS) {
    // Herbs are per-unit (potions) — any faction can carry and use them
    actor.items[lootType] = (actor.items[lootType] || 0) + 1;
    log.push(`Found Herbs! Added to ${actor.displayName}'s pack.`);
    lootItems?.push('+🌿');
    return;
  }

  // All other resources are shared
  const resLabel = lootType.charAt(0).toUpperCase() + lootType.slice(1);
  const RES_ICON = { wood: '🪵', metal: '⚙', food: '🍞', silver: '🥈', scripture: '📜' };
  const resIcon = RES_ICON[lootType] || `+${resLabel}`;
  if (actor.owner === 'hero') {
    state.inventory.shared[lootType] = (state.inventory.shared[lootType] || 0) + 1;
    log.push(`Found ${lootType}! Added to shared supplies.`);
    lootItems?.push(`+${resIcon}`);
  } else {
    state.inventory.witch[lootType] = (state.inventory.witch[lootType] || 0) + 1;
    log.push(`The witch secures ${lootType} for dark rituals.`);
    lootItems?.push(`+${resIcon}`);
  }
}

export function executeBattle(state, actor, target) {
  const log = [];

  // Phase bonus — only witch gets a night bonus (+2 ATK for all witch units)
  let phaseBonus = 0;
  if (state.phase === Phase.NIGHT && actor.owner === 'witch') phaseBonus = 2;

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

  // Fatigue: hero-side defenders lose -1 DEF for every 2 times they've defended this round
  const fatiguePenalty = target.owner === 'hero'
    ? Math.floor((target.defendCount || 0) / 2)
    : 0;

  const { attackRoll, defenseRoll, hit, margin,
          atkBaseDie, defBaseDie, atkExtraDice, defExtraDice, atkStaffBonus } =
    Entity.resolveCombat(actor, target, phaseBonus, 0, fortBonus, extraAtkDice, extraDefDice,
                         fatiguePenalty);

  // Increment the defender's defend count for fatigue tracking
  if (target.defendCount === undefined) target.defendCount = 0;
  target.defendCount += 1;

  const phaseNote  = phaseBonus > 0 ? ' (🌙 night bonus)' : '';
  const gangNote    = attackerAllies >= 1 ? ' [gang-up +d3]' : '';
  const allyDefNote = defenderAllies >= 1 ? ' [allies +d3]'  : '';

  log.push(
    `${actor.displayName} attacks ${target.displayName}! ` +
    `[${attackRoll}${gangNote} vs ${defenseRoll}${allyDefNote}]${phaseNote}`
  );

  let killed     = false;
  let damage     = 0;          // damage dealt to target
  let counterDmg = 0;          // damage dealt to attacker (counter)
  let fortDamaged = 0;         // fort levels lost this combat (1 if defender took any damage)

  if (hit) {
    // Crushing blow: attacker's roll is at least double the defender's roll
    const totalDmg = attackRoll >= 2 * defenseRoll ? 2 : 1;

    // All damage goes directly to the defender
    for (let d = 0; d < totalDmg; d++) {
      damage += 1;
      const wasKilled = target.takeDamage(1);
      if (wasKilled) { killed = true; break; }
    }

    // Fort takes -1 if the defender took any damage
    if (damage > 0 && defTile && defTile.fortifyLevel > 0) {
      defTile.fortifyLevel -= 1;
      fortDamaged = 1;
      log.push(`🏰 The fortifications are damaged! (now +${defTile.fortifyLevel} DEF)`);
    }

    if (killed) {
      log.push(`${target.displayName} is slain!`);
      if (actor.owner === 'hero') state.heroKills++;
      else if (actor.owner === 'witch') state.witchKills++;
      state.entities = state.entities.filter(e => e.id !== target.id);
    } else if (damage > 0) {
      const label = damage >= 2 ? `${damage} damage (crushing blow!)` : `${damage} damage`;
      log.push(`${target.displayName} takes ${label}. (${target.hp}/${target.maxHp} HP)`);
    }
    if (attackRoll >= 2 * defenseRoll) log.push(`💥 Crushing blow! (${attackRoll} vs ${defenseRoll})`);
  } else {
    log.push(`${target.displayName} defends successfully.`);

    // Counter-attack: defender's roll is at least double the attacker's roll
    if (defenseRoll >= 2 * attackRoll && actor.alive) {
      const counterKilled = actor.takeDamage(1);
      counterDmg = 1;
      log.push(`⚔ ${target.displayName} counter-attacks! ${actor.displayName} takes 1 damage.`);
      if (counterKilled) {
        log.push(`${actor.displayName} is slain by the counter!`);
        if (target.owner === 'hero') state.heroKills++;
        else if (target.owner === 'witch') state.witchKills++;
        state.entities = state.entities.filter(e => e.id !== actor.id);
      } else {
        log.push(`${actor.displayName} is at ${actor.hp}/${actor.maxHp} HP.`);
      }
    }
  }

  return {
    success: true, log, cost: 1,
    attackRoll, defenseRoll, hit, killed,
    margin, damage, counterDmg, fortDamaged,
    attackerAllies, defenderAllies,
    breakdown: {
      atkBaseDie, defBaseDie,
      atkExtraDice, defExtraDice,
      atkStaffBonus,
      phaseBonus, fortBonus, fatiguePenalty,
      atkAllyNames: atkAllies.map(e => e.displayName),
      defAllyNames: defAllies.map(e => e.displayName),
    },
  };
}

export function executeFortify(state, actor) {
  const t = tile(state, actor.col, actor.row);
  if (!t || t.type === TileType.RIVER) return { success: false, log: ['Cannot fortify here.'] };
  if (t.fortifyLevel >= 4) return { success: false, log: ['Cannot fortify further.'] };
  const onNodeHex = state.witchObjectives?.some(obj =>
    obj.hexes?.some(h => h.col === actor.col && h.row === actor.row)
  );
  if (onNodeHex) return { success: false, log: ['Cannot fortify a Power Node hex.'] };

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

// requestedType: optional EntityType (IRON_GOLEM / WOOD_GOLEM / MINION).
// When provided the summon respects the player's explicit choice; falls back to
// auto-pick if the requested type is no longer affordable (e.g. plan mis-ordering).
// The summoned unit always spawns on the actor's own tile.
export function executeSummon(state, actor, requestedType = null) {
  const inv     = state.inventory.witch;
  const ownerId = actor.ownerId;
  let summonedUnit, res, unitName;

  const metal = inv[ResourceType.METAL] || 0;
  const wood  = inv[ResourceType.WOOD]  || 0;
  const total = Object.values(inv).reduce((s, v) => s + (v || 0), 0);

  // Resolve final type: honour request if affordable, else fall back to auto-pick
  let resolvedType = requestedType;
  if (resolvedType === EntityType.IRON_GOLEM && metal < 2) resolvedType = null;
  if (resolvedType === EntityType.WOOD_GOLEM && wood  < 2) resolvedType = null;
  if (resolvedType === EntityType.MINION      && total < 2) resolvedType = null;
  if (!resolvedType) {
    // Auto-pick priority: iron > wood > minion
    if      (metal >= 2) resolvedType = EntityType.IRON_GOLEM;
    else if (wood  >= 2) resolvedType = EntityType.WOOD_GOLEM;
    else if (total >= 2) resolvedType = EntityType.MINION;
    else return { success: false, log: ['Need at least 2 resources to summon.'] };
  }

  if (resolvedType === EntityType.IRON_GOLEM) {
    res = ResourceType.METAL; inv[res] -= 2;
    summonedUnit = createIronGolem(actor.col, actor.row, ownerId);
    unitName = 'Iron Golem';
  } else if (resolvedType === EntityType.WOOD_GOLEM) {
    res = ResourceType.WOOD; inv[res] -= 2;
    summonedUnit = createWoodGolem(actor.col, actor.row, ownerId);
    unitName = 'Wood Golem';
  } else {
    // Minion: spend 2 from any resources, largest stacks first; track what was spent
    const keys = Object.keys(inv).filter(k => inv[k] > 0).sort((a, b) => inv[b] - inv[a]);
    let remaining = 2;
    const spentMap = {};
    for (const k of keys) {
      const spend = Math.min(inv[k], remaining); inv[k] -= spend; remaining -= spend;
      spentMap[k] = (spentMap[k] || 0) + spend;
      if (remaining === 0) break;
    }
    summonedUnit = createMinion(actor.col, actor.row, ownerId);
    unitName = 'Minion';
    state.entities.push(summonedUnit);
    state.witchSummonCount++;
    return {
      success: true,
      log: [`The witch raises a ${unitName}!`],
      cost: 1,
      spent: Object.entries(spentMap).map(([type, amount]) => ({ type, amount })),
    };
  }

  state.entities.push(summonedUnit);
  state.witchSummonCount++;
  return { success: true, log: [`The witch raises a ${unitName}!`], cost: 1, spent: [{ type: res, amount: 2 }] };
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
