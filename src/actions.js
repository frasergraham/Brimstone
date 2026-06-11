// Action system: definitions, validation, and execution
import { getNeighbors, hexKey, hexDistance, hexRange, hexLine, offsetToAxial, axialToOffset } from './hex.js';
import {
  ResourceType, WEAPON_LABEL, BUILDING_LOOT, TERRAIN_LOOT, rollLoot,
  MAX_FORTIFY_LEVEL, getFortifyCombatBonus, isFortWall,
  FORT_IMPASSABLE_THRESHOLD,
  isRiver, isPathRoadLike, hasBuilding, isForestCover, baseOf,
  tileCapacityRemaining, isBuildingFootprint, blocksLineOfSight,
} from './tiles.js';
import { pickUnitSlot } from './hex-slots.js';
import { ITEMS, getWeaponDamage } from './items.js';
import { ABILITIES } from './abilities.js';
import { DAMAGE_SCALE } from './balance.js';
import { LOOT_TIER_GATE } from './loot.config.js';

// Phase 3: items in an actor's bag are keyed by their ITEMS id (e.g.
// 'sword') instead of the legacy 'weapon:sword' prefix. Weapon-vs-
// resource classification now comes from the ITEMS registry.
const isWeaponId = (id) => ITEMS[id]?.kind === 'weapon';
import {
  EntityType, SurvivorAbility, Entity,
  createZombie, createMinion, createSurvivor,
  createWoodGolem, createIronGolem,
  nextDie, ADVANTAGE_CAP, isLeaderType, abilityStatMod, rollDamage,
} from './entities.js';
import { Phase } from './game.js';
import { getFaction, concreteFactionOf, sightRangeForEntity } from './factions.js';
import { dispatchTrigger, applyEffect, effectStatMod } from './effects.js';
import { triggerSurvivorEncounter } from './survivor-discovery.js';

export const ActionType = Object.freeze({
  MOVE:         'move',
  EXPLORE:      'explore',
  BATTLE:       'battle',
  BATTLE_HEX:   'battle_hex',  // Blind attack on a hex — for use through fog of war
  FORTIFY:      'fortify',
  SUMMON:       'summon',
  HEAL:         'heal',
  USE_ITEM:     'use_item',
  EQUIP_WEAPON: 'equip_weapon',
  USE_ABILITY:  'use_ability',
  GUARD:        'guard',
  SOUND_HORN:   'sound_horn',
});

// ── Helpers ────────────────────────────────────────────────────────────────

function tile(state, col, row) {
  return state.tiles.get(hexKey(col, row));
}

// Resolve the hex an entity occupies for COMBAT ADJACENCY (gang-up) purposes.
// Within a TURN moves are simultaneous with battles, so the resolver publishes
// each acting unit's end-of-turn position in `state._turnEndPositions`; an ally
// that moves out of range this same turn must not flank. Falls back to the live
// position outside the resolver (AI expected-value sims, raw tests).
function combatHexKey(state, entity) {
  const p = state?._turnEndPositions?.get?.(entity.id);
  return p ? hexKey(p.col, p.row) : hexKey(entity.col, entity.row);
}

function hasEnemy(state, actor, col, row) {
  return state.entities.some(e => e.alive && e.owner !== actor.owner && e.col === col && e.row === row);
}

function hasVisibleEnemy(state, actor, col, row, visibleEnemyHexes) {
  if (!hasEnemy(state, actor, col, row)) return false;
  if (!visibleEnemyHexes) return true;
  return visibleEnemyHexes.has(hexKey(col, row));
}

// True if this tile is a wall strong enough to block `actor`'s movement.
// Combines terrain-level check with the actor's faction predicate.
export function isFortBlocking(tile, actorOwner) {
  return isFortWall(tile) && getFaction(actorOwner).isBlockedByWalls();
}

// Hex-capacity gate: is the target tile full (no slots remaining) for a
// move by `actor`? Capacity = TILE_CAPACITY - structures - other units on
// the tile (the moving actor itself is excluded so the destination check
// matches what the actor will look like once it has stepped in).
export function isTileFullForMove(state, actor, col, row) {
  const t = state.tiles.get(hexKey(col, row));
  if (!t) return false;
  const others = state.entities.filter(e =>
    e.alive && e.id !== actor.id && e.col === col && e.row === row
  ).length;
  return tileCapacityRemaining(t, others) <= 0;
}

// Cost-based movement: road/bridge/building tiles cost 1, all other passable
// tiles cost 2.  Budget = range * 2, so:
//   range 1 (no horse) → 1 off-road tile  OR  2 road tiles per action
//   range 2 (horse)    → 2 off-road tiles OR  4 road tiles per action
// posOverride lets the planner query reachability from a projected position
// rather than the entity's current position.
export function getReachableHexes(state, actor, range, posOverride = null, visibleEnemyHexes = null) {
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
      if (!nt || isRiver(nt)) continue;
      if (hasVisibleEnemy(state, actor, n.col, n.row, visibleEnemyHexes)) continue;
      if (isFortBlocking(nt, actor.owner)) continue;
      // Hex-capacity gate — a full hex (no slots remaining) blocks movement
      // into it AND through it, just like an enemy-occupied hex.
      if (isTileFullForMove(state, actor, n.col, n.row)) continue;
      const isRoadLike = isPathRoadLike(nt);
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
export function findShortestPath(state, actor, toCol, toRow, posOverride = null) {
  const startCol = posOverride?.col ?? actor.col;
  const startRow = posOverride?.row ?? actor.row;
  const startK   = hexKey(startCol, startRow);
  const goalK    = hexKey(toCol, toRow);
  if (startK === goalK) return [];

  // A building-footprint hex is fully impassable — never a valid goal. The
  // capacity gate below exempts the goal hex (so executeMove can report a
  // partial walk), so we must reject footprint goals explicitly up front.
  if (isBuildingFootprint(tile(state, toCol, toRow))) return null;

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
      if (!nt || isRiver(nt)) continue;
      if (hasEnemy(state, actor, n.col, n.row) && nk !== goalK) continue;
      if (isFortBlocking(nt, actor.owner) && nk !== goalK) continue;
      // Hex-capacity gate — full mid-path hexes block traversal. The goal
      // hex itself is allowed through here so executeMove can report the
      // partial walk + the blocking reason at the step boundary.
      if (isTileFullForMove(state, actor, n.col, n.row) && nk !== goalK) continue;
      const isRoadLike = isPathRoadLike(nt);
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

// Assign `entity` a sub-hex slot on its current tile: the lowest free,
// non-blocked slot (centre preferred). Other alive units already on the tile
// hold their slots; the arriving unit picks around them and around the tile's
// blocked (tree/bridge) slots. Called at every placement seam — move, summon,
// survivor spawn — so online (resolver) and offline (main) stay in parity.
export function assignSlotOnTile(state, entity) {
  const t = state.tiles.get(hexKey(entity.col, entity.row));
  const occupied = state.entities
    .filter(e => e.alive && e.id !== entity.id && e.col === entity.col && e.row === entity.row)
    .map(e => e.slot ?? 0);
  entity.slot = pickUnitSlot(t?.blockedSlots ?? [], occupied);
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

// ── Fog-of-war movement reachability ──────────────────────────────────────
// Like getReachableHexes but ignores enemies — used to compute the "dimmed"
// zone in full fog mode (theoretical movement, not actual legal moves).

export function getFogReachableHexes(state, actor, posOverride = null) {
  const hasHorse = getFaction(actor.owner).hasHorse(actor);
  const range    = hasHorse ? 2 : 1;
  const budget   = range * 2;
  const startCol = posOverride?.col ?? actor.col;
  const startRow = posOverride?.row ?? actor.row;
  const startK   = hexKey(startCol, startRow);
  const dist     = new Map([[startK, 0]]);
  const queue    = [{ col: startCol, row: startRow, c: 0 }];

  while (queue.length) {
    queue.sort((a, b) => a.c - b.c);
    const { col, row, c } = queue.shift();
    if (c > (dist.get(hexKey(col, row)) ?? Infinity)) continue;
    for (const n of getNeighbors(col, row)) {
      const nk = hexKey(n.col, n.row);
      const nt = tile(state, n.col, n.row);
      if (!nt || isRiver(nt)) continue;
      // No enemy blocking — this is theoretical reachability for fog visibility
      if (isFortBlocking(nt, actor.owner)) continue;
      // Full hexes (terrain capacity exhausted) are also unreachable.
      if (isTileFullForMove(state, actor, n.col, n.row)) continue;
      const isRoadLike = isPathRoadLike(nt);
      const nc = c + (isRoadLike ? 1 : 2);
      if (nc <= budget && nc < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, nc);
        queue.push({ col: n.col, row: n.row, c: nc });
      }
    }
  }

  const reachable = new Set();
  for (const [k, d] of dist) {
    if (d <= budget) reachable.add(k);  // include start hex
  }
  return reachable;
}

// Union of all movement-reachable hexes for a faction's alive entities.
// projectedPositions: optional Map<entityId, {col,row}> for plan-mode ghost positions.
export function buildFogMovementHexes(state, observerOwner, projectedPositions = null) {
  const union = new Set();
  for (const e of state.entities) {
    if (!e.alive || e.owner !== observerOwner) continue;
    const pos = projectedPositions?.get(e.id) ?? null;
    const reachable = getFogReachableHexes(state, e, pos);
    for (const k of reachable) union.add(k);
  }
  return union;
}

// ── Visibility ─────────────────────────────────────────────────────────────

// Base sight range varies by phase: Day=6, Dawn/Dusk=4, Night=3.
// Building footprint (wall) and forest tiles BLOCK line of sight beyond them
// (building entrances do NOT — see computeLineOfSight). SCOUT survivors add +1
// to their personal range.
export function sightRange(phase, isScout = false) {
  let base;
  switch (phase) {
    case Phase.DAY:   base = 6; break;
    case Phase.NIGHT: base = 3; break;
    default:          base = 4; break; // DAWN, DUSK
  }
  return base + (isScout ? 1 : 0);
}

// ── Line of sight ──────────────────────────────────────────────────────────
//
// Vision is blocked by a building's WALL (its impassable FOOTPRINT hex) and by
// forest cover (`isForestCover` — base material is forest, regardless of any
// path/structure on top). A building's ENTRANCE hex is TRANSPARENT — it is just
// the threshold, so a unit on or behind it is visible (P3a). The blocking tile
// itself is visible to the observer; tiles BEYOND it on the ray are not. The
// observer's own hex is always visible.
//
// The blocker predicate lives in tiles.js (`blocksLineOfSight`) so every LOS
// consumer — 2D/3D renderers, fog, AI sight — shares one rule.

function _isLosBlocker(tile) {
  return blocksLineOfSight(tile);
}

/**
 * Returns true if `(fromCol,fromRow)` has clear line of sight to
 * `(toCol,toRow)`. Endpoints are NEVER themselves blockers — only
 * intermediate hexes can block.
 */
export function hasLineOfSight(state, fromCol, fromRow, toCol, toRow) {
  if (fromCol === toCol && fromRow === toRow) return true;
  if (!state?.tiles) return true;
  const line = hexLine(fromCol, fromRow, toCol, toRow);
  for (let i = 1; i < line.length - 1; i++) {
    const t = state.tiles.get(hexKey(line[i].col, line[i].row));
    if (_isLosBlocker(t)) return false;
  }
  return true;
}

/**
 * Compute the set of hex keys visible to all alive units owned by
 * `observerOwner`. Each unit's range is `sightRangeForEntity(e, phase)`
 * (phase-dependent for hero, fixed for witch, +1 if the unit carries SCOUT).
 * Line of sight is blocked by building footprint (wall) and forest tiles —
 * building entrances are transparent; the blocker itself is visible, tiles
 * beyond it are not.
 *
 * `entities` defaults to `state.entities` but can be overridden with a
 * snapshot (used during resolution animation where positions differ from
 * the live state).
 *
 * @param {object} state
 * @param {string} observerOwner   - 'hero' | 'witch' (faction id)
 * @param {object[]} [entities]
 * @returns {Set<string>}
 */
export function computeLineOfSight(state, observerOwner, entities = state?.entities) {
  const visible = new Set();
  if (!state?.tiles || !observerOwner || !entities) return visible;
  for (const e of entities) {
    if (!e || !e.alive || e.owner !== observerOwner) continue;
    const range = sightRangeForEntity(e, state.phase);
    // The unit's own hex is always visible.
    visible.add(hexKey(e.col, e.row));
    // Enumerate candidate offsets directly via cube coordinates so the
    // global MAP_COLS/MAP_ROWS guard inside `hexRange` doesn't silently
    // clip discs on test/scratch maps with non-default dimensions.
    const origin = offsetToAxial(e.col, e.row);
    for (let dq = -range; dq <= range; dq++) {
      const drMin = Math.max(-range, -dq - range);
      const drMax = Math.min(range, -dq + range);
      for (let dr = drMin; dr <= drMax; dr++) {
        const off = axialToOffset(origin.q + dq, origin.r + dr);
        const k = hexKey(off.col, off.row);
        if (visible.has(k)) continue;
        if (!state.tiles.has(k)) continue;
        if (hasLineOfSight(state, e.col, e.row, off.col, off.row)) {
          visible.add(k);
        }
      }
    }
  }
  return visible;
}

/**
 * Returns a Set of hexKeys where opposing entities are visible to the given faction.
 * Uses line of sight (see {@link computeLineOfSight}).
 * @param {object} state - GameState
 * @param {string} viewerFactionId - 'hero' or 'witch'
 * @returns {Set<string>}
 */
export function getVisiblePositions(state, viewerFactionId) {
  const revealed = new Set();
  const viewerFaction = getFaction(viewerFactionId);
  const opponentId = viewerFaction.getOpponentId();

  // Sound Horn: hero revealed to all opponents for the rest of this round
  if (state.heroRevealedByHorn && opponentId === 'hero') {
    for (const e of state.entities) {
      if (e.alive && e.owner === 'hero') {
        revealed.add(hexKey(e.col, e.row));
      }
    }
  }

  const losSet = computeLineOfSight(state, viewerFactionId);
  for (const target of state.entities) {
    if (!target.alive || target.owner !== opponentId) continue;
    const k = hexKey(target.col, target.row);
    if (losSet.has(k)) revealed.add(k);
  }
  return revealed;
}

// ── Validation ─────────────────────────────────────────────────────────────

export function getValidActions(state, actor) {
  const actions = [];
  const t = tile(state, actor.col, actor.row);
  const faction = getFaction(actor.owner);

  // Move — range 2 if actor has a horse in personal items, otherwise 1
  const hasHorse = faction.hasHorse(actor);
  const visibleHexes = state.fogOfWar !== 'none'
    ? getVisiblePositions(state, actor.owner)
    : null;
  const moveTargets = getReachableHexes(state, actor, hasHorse ? 2 : 1, null, visibleHexes);
  if (moveTargets.length) actions.push({ type: ActionType.MOVE, targets: moveTargets });

  // Explore — available on any unexplored tile; faction determines eligibility.
  // Building-footprint hexes are impassable (no entity can stand on one) and
  // hold no building of their own — exploration belongs to the entrance.
  if (t && !t.explored && !isBuildingFootprint(t) && faction.canExplore(actor)) {
    actions.push({ type: ActionType.EXPLORE, targets: [{ col: actor.col, row: actor.row }] });
  }

  // Battle — targets visible enemies only. Under fog of war, enemies the
  // actor's faction cannot currently see are filtered out so plan mode never
  // generates an attack against a hidden target. Players can still strike at
  // fogged hexes via the explicit BATTLE_HEX action below.
  // visibleHexes is already computed above (reused from move-reachability) and
  // is non-null iff fog is active.
  // Ranged units (range > 1) extend target enumeration to any enemy within
  // their attack range rather than just the adjacent hexes.
  const actorRange = typeof actor.getRange === 'function' ? actor.getRange() : (actor.range ?? 1);
  let battleTargets;
  if (actorRange > 1) {
    battleTargets = state.entities.filter(e =>
      e.alive && e.owner !== actor.owner && e.owner !== null && e.id !== actor.id &&
      hexDistance(actor.col, actor.row, e.col, e.row) <= actorRange
    );
  } else {
    battleTargets = [
      ...sameHexEnemies(state, actor),
      ...adjacentEnemies(state, actor),
    ];
  }
  if (visibleHexes) {
    battleTargets = battleTargets.filter(e => visibleHexes.has(hexKey(e.col, e.row)));
  }
  if (battleTargets.length) actions.push({ type: ActionType.BATTLE, targets: battleTargets });

  // Battle Hex — blind attack on any non-river hex within range (for
  // attacking through fog). Distinct from BATTLE: no enemy must be known to
  // be present. At resolution: attacks a random enemy on the hex; skips if
  // the hex is empty. Ranged units (range > 1) target any hex within their
  // range; ranged attacks don't worry about line-of-sight.
  const battleHexCandidates = actorRange > 1
    ? hexRange(actor.col, actor.row, actorRange)
    : [
        { col: actor.col, row: actor.row }, // same hex (co-located)
        ...getNeighbors(actor.col, actor.row),
      ];
  const battleHexTargets = battleHexCandidates.filter(n => {
    const nt = tile(state, n.col, n.row);
    if (!nt) return false;
    // Melee: exclude rivers (can't wade/attack into one). Ranged: rivers are
    // fine as targets (you can shoot over water).
    if (actorRange <= 1 && isRiver(nt)) return false;
    // A building-footprint hex can never hold an entity — no point offering a
    // blind attack against it.
    if (isBuildingFootprint(nt)) return false;
    return true;
  });
  if (battleHexTargets.length) {
    actions.push({ type: ActionType.BATTLE_HEX, targets: battleHexTargets });
  }

  // Fortify — faction-gated; cap at MAX_FORTIFY_LEVEL, uses shared inventory.
  // Always included when contextually valid; affordable=false when no resources.
  if (t && !isRiver(t) && !isBuildingFootprint(t) && t.fortifyLevel < MAX_FORTIFY_LEVEL && faction.canFortify()) {
    const inv        = faction.getInventory(state);
    const woodCount  = (inv[ResourceType.WOOD]  || 0);
    const metalCount = (inv[ResourceType.METAL] || 0);
    const affordable = woodCount > 0 || metalCount > 0;
    actions.push({ type: ActionType.FORTIFY, targets: [{ col: actor.col, row: actor.row }], affordable });
  }

  // Summon — Phase 5 gate: any unit whose innate abilities include 'summon'.
  // Pushed onto night-side leaders by Faction.createLeader(); minions, golems,
  // and zombies never carry it, so this is equivalent to the old
  // `canSummon() && isLeaderType + owner === 'witch'` combination.
  if (actor.hasAbility('summon')) {
    // Concrete faction governs which summon types this leader actually has —
    // the brute's options are restricted to MINION while inheriting the
    // shared night-side inventory from the side-level WitchFaction.
    const summonOpts = concreteFactionOf(actor).getSummonOptions(faction.getInventory(state));
    for (const opt of summonOpts) {
      actions.push({ type: ActionType.SUMMON, summonType: opt.summonType, affordable: opt.affordable });
    }
  }

  // Guard — any unit can take a guard stance (stacks: each use adds 1 charge)
  actions.push({ type: ActionType.GUARD, currentCharges: actor.guarding || 0 });

  // Sound Horn — Phase 5 gate: any unit whose innate abilities include
  // 'sound_horn'. Pushed onto day-side leaders by Faction.createLeader().
  if (actor.hasAbility('sound_horn')) {
    const food = (faction.getInventory(state)['food'] || 0);
    actions.push({ type: ActionType.SOUND_HORN, affordable: food >= 1 });
  }

  // Heal — available to any unit whose faction has herbs (shown even at full HP
  // so players know herbs exist; disabled at full HP during execution)
  {
    const healInv = faction.getInventory(state);
    if ((healInv[ResourceType.HERBS] || 0) > 0) {
      actions.push({ type: ActionType.HEAL, atFullHp: actor.hp >= actor.maxHp });
    }
  }

  // Use item (faction-gated shared items)
  if (faction.canUseItems()) {
    const usable = [];
    const shared  = state.inventory.hero;
    const myItems = actor.items || {};

    // Shared resources
    if ((shared[ResourceType.FOOD] || 0) > 0)
      usable.push({ item: ResourceType.FOOD, label: '🍞 Food (+1 action)', source: 'shared' });
    if ((shared[ResourceType.SILVER] || 0) > 0)
      usable.push({ item: ResourceType.SILVER, label: '🪙 Silver (+1 ATK)', source: 'shared' });
    if ((shared[ResourceType.SCRIPTURE] || 0) > 0 && battleTargets.length)
      usable.push({ item: ResourceType.SCRIPTURE, label: '📜 Scripture (ward)', source: 'shared' });

    if (usable.length) actions.push({ type: ActionType.USE_ITEM, usable });

    // Equip weapon from actor's personal items. Filter by per-item gate
    // so factions with category restrictions (e.g. rogue: ranged-only)
    // don't surface a forbidden weapon in the equip menu.
    const concrete = concreteFactionOf(actor);
    const weapons = Object.keys(myItems)
      .filter(k => isWeaponId(k) && (myItems[k] || 0) > 0 && concrete.canEquipWeaponItem(k));
    if (weapons.length) {
      actions.push({
        type: ActionType.EQUIP_WEAPON,
        weapons: weapons.map(k => ({
          key: k,
          label: WEAPON_LABEL[k] || k,
        })),
      });
    }

    // Survivor special abilities
    if (actor.type === EntityType.SURVIVOR && actor.abilities?.length > 0) {
      for (const abilityAction of _buildAbilityActions(state, actor)) {
        actions.push(abilityAction);
      }
    }
  }

  return actions;
}

// Iterate the actor's abilities and emit a plan-action entry for each
// active ability whose registry validate() passes. Passive abilities
// return no action (nothing to click).
function _buildAbilityActions(state, actor) {
  const out = [];
  for (const id of actor.abilities) {
    const ab = ABILITIES[id];
    if (!ab || ab.kind !== 'active') continue;
    if (typeof ab.validate === 'function' && !ab.validate(state, actor)) continue;
    out.push({ type: ActionType.USE_ABILITY, ability: id });
  }
  return out;
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

// Diminishing returns: each active survivor on the map reduces find chance by 10%.
// At 10+ survivors the chance drops to zero.
export function survivorFindMultiplier(state) {
  const active = state.entities.filter(
    e => e.alive && e.owner === 'hero' && e.type === EntityType.SURVIVOR
  ).length;
  return Math.max(0, 1 - 0.10 * active);
}

// Survivor encounter logic moved to src/survivor-discovery.js so faction
// overrides (e.g. RogueFaction.onAfterMoveStep) can share the implementation
// without a circular import. Local alias keeps existing call sites readable.
const _triggerSurvivorEncounter = triggerSurvivorEncounter;

export function executeMove(state, actor, targetCol, targetRow) {
  actor.guarding = 0;  // Moving breaks guard stance
  const log = [];

  // Reachability check — road tiles cost half, so roads extend effective range.
  const hasHorse = getFaction(actor.owner).hasHorse(actor);
  const maxSteps = hasHorse ? 4 : 2;
  const reachable = getReachableHexes(state, actor, hasHorse ? 2 : 1);
  if (!reachable.some(h => h.col === targetCol && h.row === targetRow)) {
    // When an enemy occupies the target (e.g. hidden by fog during planning),
    // allow the move to proceed if the target is within step range so the unit
    // walks as far as it can and stops before the enemy.  The same applies
    // when the target itself is a fort-blocked hex for the actor's faction —
    // the unit should walk up to it and then surface blockedByFort rather
    // than silently returning "Cannot reach".
    const enemyOnTarget = hasEnemy(state, actor, targetCol, targetRow);
    const targetTile = tile(state, targetCol, targetRow);
    const fortOnTarget = isFortBlocking(targetTile, actor.owner);
    const dist = hexDistance(actor.col, actor.row, targetCol, targetRow);
    if ((!enemyOnTarget && !fortOnTarget) || dist > maxSteps) {
      return { success: false, log: [`Cannot reach (${targetCol},${targetRow}) from current position.`] };
    }
  }

  // Find the road-preferring path from current position to destination.
  const fullPath = findShortestPath(state, actor, targetCol, targetRow) ?? [{ col: targetCol, row: targetRow }];

  // Walk the path step by step; stop if an enemy or fort-wall blocks a mid-path hex.
  // Cap the number of hex steps to prevent long road-chain traversals when a
  // prior move in the plan failed and the entity is further away than expected.
  const walkedPath = [];
  const encounterLog = [];
  let encounterSurvivor = null;

  for (const step of fullPath) {
    if (walkedPath.length >= maxSteps) break;
    // Check if this hex is blocked by an enemy (could have moved here since plan was made)
    if (hasEnemy(state, actor, step.col, step.row)) break;
    const st = tile(state, step.col, step.row);
    if (!st || isRiver(st)) break;
    if (isFortBlocking(st, actor.owner)) break;
    // Full hex (capacity exhausted) — refuse to enter, same as enemy blocking.
    if (isTileFullForMove(state, actor, step.col, step.row)) break;

    actor.col = step.col;
    actor.row = step.row;
    walkedPath.push({ col: step.col, row: step.row });

    // Hidden survivor encounter — phase-based chance on movement, reduced by active survivors
    if (st.hiddenSurvivor && Math.random() < (SURVIVOR_FIND_CHANCE[state.phase] ?? 0.5) * survivorFindMultiplier(state)) {
      const enc = _triggerSurvivorEncounter(state, actor, step.col, step.row);
      if (enc) { encounterLog.push(...enc.encounterLog); encounterSurvivor = enc.encounterSurvivor; }
    }

    // Faction-specific post-move trigger (e.g. rogue auto-detects survivors
    // in adjacent buildings). Default no-op for other factions.
    const hookResult = concreteFactionOf(actor).onAfterMoveStep(state, actor, step.col, step.row);
    if (hookResult) {
      if (hookResult.encounterLog?.length) encounterLog.push(...hookResult.encounterLog);
      if (hookResult.encounterSurvivor) encounterSurvivor = hookResult.encounterSurvivor;
    }
  }

  if (walkedPath.length === 0) {
    const firstStep = fullPath[0];
    const firstTile = firstStep ? tile(state, firstStep.col, firstStep.row) : null;
    if (firstTile && isFortBlocking(firstTile, actor.owner)) {
      return {
        success: false,
        log: [`${actor.displayName}'s path is blocked by fortifications at (${firstStep.col},${firstStep.row}).`],
        blockedByFort: { col: firstStep.col, row: firstStep.row, fortLevel: firstTile.fortifyLevel },
      };
    }
    const blocker = fullPath.length > 0
      ? state.entities.find(e =>
          e.alive && e.owner !== actor.owner && e.col === fullPath[0].col && e.row === fullPath[0].row
        ) ?? null
      : null;
    if (blocker) {
      return { success: false, log: [`${actor.displayName} movement blocked by ${blocker.displayName}.`], blockedBy: blocker };
    }
    return { success: false, log: ['The way is blocked.'] };
  }

  // Detect partial move blocked by enemy or fortification
  let blockedBy = null;
  let blockedByFort = null;
  if (walkedPath.length < fullPath.length) {
    const nextStep = fullPath[walkedPath.length];
    const nextTile = tile(state, nextStep.col, nextStep.row);
    if (hasEnemy(state, actor, nextStep.col, nextStep.row)) {
      blockedBy = state.entities.find(e =>
        e.alive && e.owner !== actor.owner && e.col === nextStep.col && e.row === nextStep.row
      ) ?? null;
    } else if (nextTile && isFortBlocking(nextTile, actor.owner)) {
      blockedByFort = { col: nextStep.col, row: nextStep.row, fortLevel: nextTile.fortifyLevel };
    }
  }

  if (blockedBy) {
    log.push(`${actor.displayName} movement blocked by ${blockedBy.displayName}.`);
  } else if (blockedByFort) {
    log.push(`${actor.displayName}'s path is blocked by fortifications at (${blockedByFort.col},${blockedByFort.row}).`);
  }
  if (encounterLog.length) log.push(...encounterLog);

  // The actor arrived on a new tile — pick its sub-hex slot around the units and
  // blocked slots already there. (walkedPath is non-empty here.) `slot` is
  // surfaced on the result so the renderer can animate from the source slot to
  // this destination slot instead of snapping through the hex centre.
  assignSlotOnTile(state, actor);

  return { success: true, log, cost: 1, path: walkedPath, slot: actor.slot, blockedBy, blockedByFort, encounterLog, encounterSurvivor };
}

export function executeExplore(state, actor) {
  const log = [];
  const lootItems = [];
  const t = tile(state, actor.col, actor.row);
  // Footprint hexes are impassable and carry no building of their own — they
  // are never explorable (the entrance holds the building/loot).
  if (isBuildingFootprint(t)) return { success: false, log: ['Nothing to explore here.'], lootItems };
  if (t.explored) return { success: false, log: ['Already explored.'], lootItems };

  t.explored = true;

  // Exploring reveals a hidden survivor — chance reduced by active survivors on the map.
  let encounterLog = [];
  let encounterSurvivor = null;
  if (t.hiddenSurvivor && Math.random() < survivorFindMultiplier(state)) {
    const enc = _triggerSurvivorEncounter(state, actor, actor.col, actor.row);
    if (enc) { encounterLog = enc.encounterLog; encounterSurvivor = enc.encounterSurvivor; }
  }

  // HERBALIST ability: also yield 1 herbs on any explore (goes to actor's items)
  const isHerbalist = actor.type === EntityType.SURVIVOR &&
    actor.hasAbility(SurvivorAbility.HERBALIST);

  const concreteFaction = concreteFactionOf(actor);

  const runLoot = () => {
    let table;
    if (hasBuilding(t) && t.building && BUILDING_LOOT[t.building]) {
      table = _effectiveLoot(state, 'buildings', t.building, BUILDING_LOOT[t.building]);
    } else {
      // Terrain loot rolls off the BASE material — a road-over-forest rolls
      // forest loot, not road/grass loot.
      const base = baseOf(t);
      const baseTable = TERRAIN_LOOT[base] || TERRAIN_LOOT['grass'];
      table = _effectiveLoot(state, 'terrain', base, baseTable);
    }
    const raw = rollLoot(table);
    const lootType = concreteFaction.modifyLootRoll(state, actor, table, raw);
    _applyLoot(state, actor, lootType, log, lootItems);
    concreteFaction.applyExploreLootBonus(
      state, actor, lootType,
      () => runBonusLoot(table),
      { isWeapon: isWeaponId(lootType) },
    );
  };
  // Bonus rolls don't recursively trigger further bonuses — keeps the
  // multiplier bounded to ~2x per primary roll.
  const runBonusLoot = (table) => {
    const raw = rollLoot(table);
    const lootType = concreteFaction.modifyLootRoll(state, actor, table, raw);
    _applyLoot(state, actor, lootType, log, lootItems);
  };
  // Editor-authored fixed-explore result (offline/campaign only): short-circuit
  // the random roll (and NvN bonus rolls) and yield exactly the authored loot.
  // `kind:'nothing'` or a null id finds nothing; resources apply `amount` (≥1)
  // times. No override (procedural / unauthored hex) → unchanged random roll.
  const ov = t.exploreOverride;
  if (ov != null) {
    if (ov.kind === 'nothing' || ov.id == null) {
      _applyLoot(state, actor, 'nothing', log, lootItems);
    } else {
      const count = ov.kind === 'resource' ? Math.max(1, ov.amount ?? 1) : 1;
      for (let i = 0; i < count; i++) _applyLoot(state, actor, ov.id, log, lootItems);
    }
  } else {
    runLoot();

    // NvN bonus rolls: larger teams field more units and need more resources.
    // 1v1 → 1 roll; 2v2+ → one extra roll per additional player per side, with a
    // half-step 30% bonus roll between integer steps. Skipped entirely in 1v1 so
    // tests that mock Math.random() with fixed sequences aren't perturbed.
    const sidePlayers = Math.max(1, Math.floor((state.players?.length || 2) / 2));
    if (sidePlayers > 1) {
      const extraRolls = Math.floor((sidePlayers - 1) / 2);
      for (let i = 0; i < extraRolls; i++) runLoot();
      const bonusProb = 0.3 * ((sidePlayers - 1) % 2);
      if (bonusProb > 0 && Math.random() < bonusProb) runLoot();
    }
  }

  if (isHerbalist && getFaction(actor.owner).canDiscoverNPCs()) {
    const herbInv = getFaction(actor.owner).getInventory(state);
    herbInv[ResourceType.HERBS] = (herbInv[ResourceType.HERBS] || 0) + 1;
    log.push(`${actor.displayName}'s keen eye also finds Herbs!`);
    lootItems.push('+🌿');
  }

  if (encounterLog.length) log.push(...encounterLog);
  return { success: true, log, cost: 1, lootItems, encounterLog, encounterSurvivor };
}

/** Resolve the effective loot table, applying per-mission overrides if present. */
function _effectiveLoot(state, category, key, defaultTable) {
  const ov = state.lootOverrides;
  // Full table override for this specific building/terrain type — used verbatim,
  // so a mission can deliberately force a premium weapon in early (author opt-in,
  // bypasses the tier gate below).
  if (ov?.[category]?.[key]) return ov[category][key];
  let table = defaultTable;
  // Item removal filter
  if (ov?.remove) table = table.filter(e => !ov.remove.includes(e.type));
  // Premium-weapon progression gate: drop entries whose unlock round is in the
  // future so they simply can't roll yet (see LOOT_TIER_GATE in loot.config.js).
  const round = state.round ?? 1;
  if (table.some(e => LOOT_TIER_GATE[e.type] != null)) {
    table = table.filter(e => (LOOT_TIER_GATE[e.type] ?? 0) <= round);
  }
  return table;
}

function _applyLoot(state, actor, lootType, log, lootItems) {
  if (lootType === 'nothing') {
    log.push(`${actor.displayName} searches carefully… nothing useful found.`);
    return;
  }

  const faction = getFaction(actor.owner);

  if (lootType === 'horse') {
    if (faction.canEquipHorse()) {
      actor.items['horse'] = 1;
      log.push(`Found a horse! ${actor.displayName}'s movement range increases to 2.`);
      lootItems?.push('+🐴');
    }
    return;
  }

  if (isWeaponId(lootType)) {
    const concrete = concreteFactionOf(actor);
    if (concrete.canEquipWeaponItem(lootType)) {
      const label = WEAPON_LABEL[lootType] || lootType;
      if (!actor.weapon) {
        actor.equipWeapon(lootType);
        log.push(`Found a ${label}! ${actor.displayName} equips it immediately.`);
        lootItems?.push('+⚔');
      } else {
        actor.items[lootType] = (actor.items[lootType] || 0) + 1;
        log.push(`Found a ${label}! Added to ${actor.displayName}'s pack.`);
        lootItems?.push('+⚔');
      }
    } else if (faction.canEquipWeapon()) {
      // The side can use weapons in general, but this faction rejects this
      // category (e.g. rogue refuses melee weapons).
      const label = WEAPON_LABEL[lootType] || lootType;
      log.push(`Found a ${label}! ${actor.displayName} cannot wield it.`);
    } else {
      log.push(`${actor.displayName} finds a weapon but has no use for it.`);
    }
    return;
  }

  if (lootType === ResourceType.HERBS) {
    // Herbs go to faction shared inventory — any allied unit can use them
    const inv = faction.getInventory(state);
    inv[lootType] = (inv[lootType] || 0) + 1;
    log.push(`${actor.displayName} found Herbs! Added to supplies.`);
    lootItems?.push('+🌿');
    return;
  }

  // All other resources go to faction inventory
  const resLabel = lootType.charAt(0).toUpperCase() + lootType.slice(1);
  const RES_ICON = { wood: '🪵', metal: '⚙', food: '🍞', silver: '🥈', scripture: '📜' };
  const resIcon = RES_ICON[lootType] || `+${resLabel}`;
  const inv = faction.getInventory(state);
  inv[lootType] = (inv[lootType] || 0) + 1;
  log.push(faction.getResourceFoundLog(actor, lootType));
  lootItems?.push(`+${resIcon}`);
}

// Splash damage: when an attack triggers splash, every other unit on the
// affected hexes takes `damage` HP. Does NOT chain — splash kills do not
// trigger further splashes.
//
// Options:
//   extraRadius   — extends the blast outward by N hex steps (1 = the 6
//                   neighbours around (col,row) are also splashed).
//   damage        — base damage per splashed bystander (default 1).
//   sparesOwner   — owner string ('hero' / 'witch'); units of that owner
//                   are skipped (no damage, no knockback). Friendly-fire
//                   toggle.
//   knockback     — when true, surviving bystanders are pushed 1 hex
//                   outward from (col,row) if the destination is open.
//                   Killed bystanders stay where they fell.
//
// Returns { splashKills, splashHits, splashHexes }. splashHits records
// the FINAL position of each hit (post-knockback) plus a `from` field
// holding the pre-knockback hex for animation.
function _applySplashDamage(state, col, row, excludeIds, log, opts = {}) {
  const {
    extraRadius = 0,
    damage      = 1,
    sparesOwner = null,
    knockback   = false,
  } = opts;
  const excludeSet = new Set(excludeIds);
  const splashHexes = [{ col, row }];
  if (extraRadius > 0) {
    for (const n of getNeighbors(col, row)) splashHexes.push({ col: n.col, row: n.row });
  }
  const hexKeys = new Set(splashHexes.map(h => hexKey(h.col, h.row)));
  const bystanders = state.entities.filter(
    e => e.alive && hexKeys.has(hexKey(e.col, e.row)) && !excludeSet.has(e.id) &&
         (sparesOwner == null || e.owner !== sparesOwner)
  );
  const splashKills = [];
  const splashHits  = [];
  for (const b of bystanders) {
    const fromCol = b.col, fromRow = b.row;
    const dmg = b.applyIncomingDamage(damage);
    const wasKilled = b.takeDamage(dmg);
    log.push(`💢 ${b.displayName} caught in the blast — takes ${dmg} splash damage! (${b.hp}/${b.maxHp} HP)`);
    let pushedTo = null;
    if (knockback && !wasKilled && (fromCol !== col || fromRow !== row)) {
      pushedTo = _knockbackDestination(state, b, col, row);
      if (pushedTo) {
        b.col = pushedTo.col;
        b.row = pushedTo.row;
        log.push(`💨 ${b.displayName} is hurled to (${pushedTo.col},${pushedTo.row}).`);
      }
    }
    splashHits.push({
      id: b.id, name: b.displayName, owner: b.owner, type: b.type,
      ownerId: b.ownerId, killed: !!wasKilled, damage: dmg,
      col: b.col, row: b.row,
      fromCol, fromRow,
      knockedBack: !!pushedTo,
    });
    if (wasKilled) {
      log.push(`${b.displayName} is slain by splash damage!`);
      splashKills.push({ id: b.id, owner: b.owner, type: b.type, ownerId: b.ownerId });
      state.entities = state.entities.filter(e => e.id !== b.id);
    }
  }
  return { splashKills, splashHits, splashHexes };
}

// Compute the hex one step outward from `centerCol/centerRow` in the
// direction of `entity`, in axial space (handles odd-r stagger). Returns
// null if the destination is off-map, a river, a fortified wall the
// entity can't enter, or already occupied by another live unit.
function _knockbackDestination(state, entity, centerCol, centerRow) {
  const center = offsetToAxial(centerCol, centerRow);
  const here   = offsetToAxial(entity.col, entity.row);
  const dq = here.q - center.q;
  const dr = here.r - center.r;
  const push = axialToOffset(here.q + dq, here.r + dr);
  const t = state.tiles.get(hexKey(push.col, push.row));
  if (!t || isRiver(t)) return null;
  if (isFortBlocking(t, entity.owner)) return null;
  if (state.entities.some(e => e.alive && e.id !== entity.id && e.col === push.col && e.row === push.row)) return null;
  return push;
}

/**
 * Situational combat context shared by executeBattle and computeCombatOdds —
 * everything about an attack that is known BEFORE the dice are rolled.
 * Pure: touches no entity or tile fields.
 *
 * Ranged attacks have a different rule set than melee:
 *   - No gang-up advantage on either side (the attacker is firing from
 *     afar, and allies don't flank a shot).
 *   - No crushing blows; damage is always 1 per hit.
 *   - No splash on kill (clean single-target).
 *   - No counter-attack (defender can't reach the ranged attacker to
 *     strike back — see the `!isRanged` guard on the counter branch).
 *   - Defender in forest gets +1 DEF (cover).
 *   - Attacker at close range (dist == 1) fires at disadvantage (1 die).
 * Phase bonus, fortification, and weapon triggers still apply.
 */
export function computeBattleContext(state, actor, target) {
  const atkRange = (typeof actor.getRange === 'function' ? actor.getRange() : (actor.range ?? 1));
  const distToTarget = hexDistance(actor.col, actor.row, target.col, target.row);
  const isRanged = atkRange > 1;
  const isCloseRanged = isRanged && distToTarget <= 1;
  // Distance falloff for ranged shots — floor((dist-1)/2) attack penalty.
  // dist 1–2: 0, 3–4: -1, 5–6: -2. Melee unaffected. Composes with the
  // point-blank disadvantage die below (penalty is 0 at dist 1, no double-dip).
  const rangeDistancePenalty = isRanged ? Math.floor((distToTarget - 1) / 2) : 0;

  // Phase bonus — faction-specific (e.g. witch gets +2 ATK at night)
  const attackerFaction = getFaction(actor.owner);
  const phaseBonus = attackerFaction.getPhaseCombatBonus(state.phase);

  // Compute situational bonuses without touching entity fields
  // Gang-up: attacker allies adjacent to the TARGET (flanking/surrounding them)
  // Ally-def: defender allies adjacent to the TARGET (defending their position)
  const targetHexes = new Set([hexKey(target.col, target.row)]);
  for (const n of getNeighbors(target.col, target.row)) targetHexes.add(hexKey(n.col, n.row));

  const atkAllies = state.entities.filter(e =>
    e.alive && e.owner === actor.owner && e.id !== actor.id && targetHexes.has(combatHexKey(state, e))
  );
  const defAllies = state.entities.filter(e =>
    e.alive && e.owner === target.owner && e.id !== target.id && targetHexes.has(combatHexKey(state, e))
  );
  const attackerAllies = atkAllies.length;
  const defenderAllies = defAllies.length;
  const atkTile        = tile(state, actor.col, actor.row);
  const defTile        = tile(state, target.col, target.row);
  // Witch units gain nothing from fortifications — only hero-side units do.
  const atkFortRaw     = getFortifyCombatBonus(atkTile?.fortifyLevel || 0);
  const defFortRaw     = getFortifyCombatBonus(defTile?.fortifyLevel || 0);
  const atkFortAtkBonus = actor.owner === 'witch'  ? 0 : atkFortRaw.attack;
  const fortBonus       = target.owner === 'witch' ? 0 : defFortRaw.defense;

  // Forest-cover bonus — ranged-only. The defender blends into the trees
  // and gains +1 DEF against incoming projectiles. Melee attackers are
  // already in the same thicket, so cover does not apply.
  const forestCoverBonus = (isRanged && isForestCover(defTile)) ? 1 : 0;

  // Gang-up: melee only. Ranged attacks explicitly ignore ally adjacency
  // for both attacker and defender.
  const atkAdvantageDice = isRanged ? 0 : Math.min(attackerAllies, ADVANTAGE_CAP);
  const defAdvantageDice = isRanged ? 0 : Math.min(defenderAllies, ADVANTAGE_CAP);
  const atkGangupFlat    = isRanged ? 0 : Math.min(attackerAllies, ADVANTAGE_CAP);
  const defGangupFlat    = isRanged ? 0 : Math.min(defenderAllies, ADVANTAGE_CAP);
  // Close-range disadvantage — ranged unit shooting at an adjacent target
  // rolls its attack pool with 1 disadvantage die (best-of-K math handles it).
  const atkDisadvantageDice = isCloseRanged ? 1 : 0;

  // Fatigue: faction-specific defense penalty based on defend count this round
  const defenderFaction = getFaction(target.owner);
  const fatiguePenalty = defenderFaction.getDefenseFatigue(target.defendCount || 0);

  return {
    isRanged, isCloseRanged, rangeDistancePenalty, phaseBonus,
    atkAllies, defAllies, attackerAllies, defenderAllies,
    atkTile, defTile, atkFortAtkBonus, fortBonus, forestCoverBonus,
    atkAdvantageDice, defAdvantageDice, atkGangupFlat, defGangupFlat,
    atkDisadvantageDice, fatiguePenalty,
    // Assembled resolveCombat options — the single source of truth for both
    // the live roll (executeBattle) and the odds preview (computeCombatOdds).
    // Phase stays flat here — converting to advantage turned out too steep a
    // nerf to witch's night window; see CLAUDE.md §Tuning for the sweep.
    combatOptions: {
      extraAtkBonus: atkFortAtkBonus + phaseBonus + atkGangupFlat - rangeDistancePenalty,
      atkAdvantageDice,
      atkDisadvantageDice,
      defAdvantageDice,
      extraDefBonus: fortBonus + defGangupFlat + forestCoverBonus,
      fatiguePenalty,
    },
  };
}

/**
 * Exact hit/crush/counter probabilities for attacking `target` from the
 * actor's CURRENT position — the planning-time odds preview shown in the UI.
 * Pure (no state mutation, no dice). Returns { hit, crush, counter, miss }.
 */
export function computeCombatOdds(state, actor, target) {
  const ctx = computeBattleContext(state, actor, target);
  return Entity.computeCombatOdds(actor, target, {
    ...ctx.combatOptions,
    ranged: ctx.isRanged,
  });
}

export function executeBattle(state, actor, target, opts = {}) {
  actor.guarding = 0;  // Attacking breaks guard stance
  const log = [];
  // Guard reactions (resolver inserts these inline) are normal attacks EXCEPT for
  // these opt-out flags: no counter-attack, no crush, and no gang-up (neither
  // side). They DO keep silver/phase/fort/weapon bonuses. This matches the
  // pre-refactor guard strike so balance stays neutral; planned attacks pass none
  // of these flags.
  const noCounter = !!opts.noCounter;
  const noCrush   = !!opts.noCrush;
  const noAlly    = !!opts.noAlly;

  const ctx = computeBattleContext(state, actor, target);
  if (noAlly) {
    // Guard reactions get NO gang-up (either side): the numerically-superior
    // swarm shouldn't be able to stack a reactive attack. Strip both sides' ally
    // advantage dice + flat so the reaction matches the pre-refactor guard strike
    // and keeps overall balance neutral.
    ctx.combatOptions.extraAtkBonus -= ctx.atkGangupFlat;
    ctx.combatOptions.extraDefBonus -= ctx.defGangupFlat;
    ctx.combatOptions.atkAdvantageDice = 0;
    ctx.combatOptions.defAdvantageDice = 0;
    ctx.atkAdvantageDice = 0; ctx.defAdvantageDice = 0;
    ctx.atkGangupFlat = 0;    ctx.defGangupFlat = 0;
    ctx.attackerAllies = 0;   ctx.defenderAllies = 0;
    ctx.atkAllies = [];       ctx.defAllies = [];
  }
  const {
    isRanged, isCloseRanged, rangeDistancePenalty, phaseBonus,
    atkAllies, defAllies, attackerAllies, defenderAllies, defTile,
    atkFortAtkBonus, fortBonus, forestCoverBonus,
    atkAdvantageDice, defAdvantageDice, atkGangupFlat, defGangupFlat,
    atkDisadvantageDice, fatiguePenalty, combatOptions,
  } = ctx;

  const { attackRoll, defenseRoll, hit, margin,
          atkBaseDie, defBaseDie, atkExtraDice, defExtraDice,
          atkPool, defPool, atkStaffBonus } =
    Entity.resolveCombat(actor, target, { ...combatOptions, state });

  // Increment the defender's defend count for fatigue tracking
  if (target.defendCount === undefined) target.defendCount = 0;
  target.defendCount += 1;

  const phaseNote  = phaseBonus > 0 ? ' (🌙 night bonus)' : '';
  const rangeFalloffNote = rangeDistancePenalty > 0 ? ` (−${rangeDistancePenalty} range)` : '';
  const rangedNote   = isRanged
    ? (isCloseRanged ? ' 🎯 (point-blank, disadvantage)' : ` 🏹 (ranged)${rangeFalloffNote}`)
    : '';
  const coverNote    = forestCoverBonus > 0 ? ' 🌲 (forest cover +1 DEF)' : '';
  const gangNote    = !isRanged && attackerAllies >= 1
    ? ` [advantage ${atkAdvantageDice}, flat +${atkGangupFlat}]` : '';
  const allyDefNote = !isRanged && defenderAllies >= 1
    ? ` [advantage ${defAdvantageDice}, flat +${defGangupFlat}]` : '';

  log.push(
    `${actor.displayName} attacks ${target.displayName}!${rangedNote} ` +
    `[${attackRoll}${gangNote} vs ${defenseRoll}${allyDefNote}${coverNote}]${phaseNote}`
  );

  let killed     = false;
  let damage     = 0;          // damage dealt to target
  let dmgRoll    = 0;          // pre-tier weapon damage roll (for the breakdown popup)
  let dmgTier    = 0;          // crush multiplier applied (1 hit / 2 crush / 3 great crush)
  let counterDmg = 0;          // damage dealt to attacker (counter)
  let fortDamaged = 0;         // fort levels lost this combat (1 if defender took any damage)
  let splashKills = [];         // entities killed by splash damage
  let splashHits  = [];         // all entities that took splash damage (killed or not)
  let splashHexes = [];         // hexes covered by the splash blast (for VFX)
  // Concrete-faction splash config — brute's blast extends 1 hex outward,
  // fires on every melee hit, scales with margin, knocks bystanders back,
  // and skips friendly units.
  const attackerConcrete = concreteFactionOf(actor);
  const splashRadius     = attackerConcrete.crushSplashRadius();
  const splashEveryHit   = attackerConcrete.splashesOnEveryHit();
  const splashSpareSide  = attackerConcrete.splashSparesAllies() ? actor.owner : null;
  const splashKnockback  = attackerConcrete.splashKnockback();
  // Ranged attacks cannot crush — the rule set explicitly forbids it.
  // Damage tiers by roll ratio multiply the rolled weapon damage: great crush
  // (≥3× defense roll) = 3×, crush (≥2×) = 2×, ordinary hit = 1×. isGreatCrush
  // implies isCrush. The weapon's damage spec is rolled through state.nextDie
  // (after resolveCombat's advantage pools) so it stays deterministic under
  // forced dice / replay; unarmed falls back to 2D6 (see getWeaponDamage).
  const isCrush      = !noCrush && !isRanged && hit && attackRoll >= 2 * defenseRoll;
  const isGreatCrush = !noCrush && !isRanged && hit && attackRoll >= 3 * defenseRoll;

  if (hit) {
    const tier    = isGreatCrush ? 3 : isCrush ? 2 : 1;
    dmgRoll       = rollDamage(getWeaponDamage(actor.weapon), s => state.nextDie(s));
    dmgTier       = tier;
    const baseDmg = dmgRoll * tier;

    // Applied as a single blow so a defender's wounded (+DAMAGE_SCALE damage
    // taken) lifts the whole strike once — not once per point — keeping the
    // wounded surcharge proportional to the scaled HP pools.
    {
      const inc = target.applyIncomingDamage(baseDmg);
      damage += inc;
      const wasKilled = target.takeDamage(inc);
      dispatchTrigger('damaged', target, { state, amount: inc, source: actor });
      if (wasKilled) killed = true;
    }

    // Fort takes -1 if the defender took any damage
    if (damage > 0 && defTile && defTile.fortifyLevel > 0) {
      defTile.fortifyLevel -= 1;
      fortDamaged = 1;
      log.push(`🏰 The fortifications are damaged! (now +${defTile.fortifyLevel} DEF)`);
    }

    if (killed) {
      log.push(`${target.displayName} is slain!`);
      getFaction(actor.owner).trackKill(state);
      actor.killsThisRound = (actor.killsThisRound ?? 0) + 1;
      // TODO(veterancy): regular-mode level-up could hook here — award kill XP to
      // `summoned`-tagged units + survivors (not leaders) and call applyLevel from
      // a captured L1 base. Out of scope now (campaign sets levels at spawn).
      dispatchTrigger('damaged-fatal', target, { state, source: actor });
      dispatchTrigger('kill', actor, { state, target });
      state.entities = state.entities.filter(e => e.id !== target.id);
    } else if (damage > 0) {
      const label = isCrush ? `${damage} damage (crushing blow!)` : `${damage} damage`;
      log.push(`${target.displayName} takes ${label}. (${target.hp}/${target.maxHp} HP)`);
    }
    if (isGreatCrush) log.push(`💥💥 Great crushing blow! (${attackRoll} vs ${defenseRoll})`);
    else if (isCrush) log.push(`💥 Crushing blow! (${attackRoll} vs ${defenseRoll})`);

    // Crushing blows leave a wound on the target — +1 damage taken from
    // any source for the next 3 rounds. Universal (applies to all
    // attackers, not just the brute) so any big swing has a follow-up
    // tax. Skipped on a kill (no point wounding a corpse).
    if (isCrush && !killed) {
      applyEffect(target, 'wounded');
      log.push(`🩸 ${target.displayName} is wounded by the brutal blow.`);
    }

    // Splash damage: vanilla rule splashes only on crush / kill. The
    // brute's `splashesOnEveryHit()` lets the blast fire on any hit.
    // Splash damage scales with the attacker's roll margin —
    // `max(1, floor(margin / 3))`, capped at 3 — so big swings turn
    // into bigger blasts. Bystanders may be knocked one hex outward
    // and friendly units may be spared, both per concrete faction.
    // Ranged attacks never splash (no crush, no AOE).
    if (!isRanged && (isCrush || killed || splashEveryHit)) {
      // Splash level (1–3) scales with the roll margin, then ×DAMAGE_SCALE so a
      // blast stays proportional to a normal hit against the scaled HP pools.
      const splashBaseDamage = Math.max(1, Math.min(3, Math.floor(margin / 3))) * DAMAGE_SCALE;
      const splash = _applySplashDamage(
        state, target.col, target.row, [actor.id, target.id], log,
        {
          extraRadius: splashRadius,
          damage:      splashBaseDamage,
          sparesOwner: splashSpareSide,
          knockback:   splashKnockback,
        }
      );
      splashKills = splash.splashKills;
      splashHits  = splash.splashHits;
      splashHexes = splash.splashHexes;
      for (const sk of splashKills) {
        if (sk.owner !== actor.owner) {
          getFaction(actor.owner).trackKill(state);
          actor.killsThisRound = (actor.killsThisRound ?? 0) + 1;
          dispatchTrigger('kill', actor, { state, target: sk });
        }
      }
    }
  } else {
    log.push(`${target.displayName} defends successfully.`);

    // Counter-attack: defender's roll is at least double the attacker's roll.
    // Ranged attacks don't trigger counters — the defender can't reach the
    // attacker to strike back (narratively nonsensical, and the operator
    // explicitly removed this rule).
    if (defenseRoll >= 2 * attackRoll && actor.alive && !isRanged && !noCounter) {
      // A counter lands as one ordinary (1×) hit with the defender's weapon —
      // matching the pre-dice rule where a counter dealt the same as a hit.
      counterDmg = actor.applyIncomingDamage(
        rollDamage(getWeaponDamage(target.weapon), s => state.nextDie(s))
      );
      const counterKilled = actor.takeDamage(counterDmg);
      log.push(`⚔ ${target.displayName} counter-attacks! ${actor.displayName} takes ${counterDmg} damage.`);
      dispatchTrigger('damaged', actor, { state, amount: counterDmg, source: target });
      if (counterKilled) {
        log.push(`${actor.displayName} is slain by the counter!`);
        getFaction(target.owner).trackKill(state);
        target.killsThisRound = (target.killsThisRound ?? 0) + 1;
        dispatchTrigger('damaged-fatal', actor, { state, source: target });
        dispatchTrigger('kill', target, { state, target: actor });
        state.entities = state.entities.filter(e => e.id !== actor.id);

        // Counter-kill splashes other units on the attacker's tile.
        // The defender's concrete-faction config applies — a brute
        // defender's counter-kill blasts neighbours, knocks them back,
        // and spares its own minions just like an offensive splash.
        const defenderConcrete = concreteFactionOf(target);
        const counterSplash = _applySplashDamage(
          state, actor.col, actor.row, [target.id, actor.id], log,
          {
            extraRadius: defenderConcrete.crushSplashRadius(),
            damage:      DAMAGE_SCALE, // counter-splash = one scaled point (no margin to scale on)
            sparesOwner: defenderConcrete.splashSparesAllies() ? target.owner : null,
            knockback:   defenderConcrete.splashKnockback(),
          }
        );
        splashKills.push(...counterSplash.splashKills);
        splashHits.push(...counterSplash.splashHits);
        if (counterSplash.splashHexes.length > splashHexes.length) {
          splashHexes = counterSplash.splashHexes;
        }
        for (const sk of counterSplash.splashKills) {
          if (sk.owner !== target.owner) {
            getFaction(target.owner).trackKill(state);
            target.killsThisRound = (target.killsThisRound ?? 0) + 1;
            dispatchTrigger('kill', target, { state, target: sk });
          }
        }
      } else {
        log.push(`${actor.displayName} is at ${actor.hp}/${actor.maxHp} HP.`);
      }
    }
  }

  // Decomposed intrinsic stat contributions — surfaced as discrete floaters
  // in the 3D combat readout (so the player sees their weapon / silver /
  // ability bonuses, not just one opaque sum). The sum below MUST equal
  // attackOf(actor) + actor.attackBonus, which is exactly what
  // Entity.resolveCombat folds into attackRoll. Same for defender. Tests
  // assert picked + Σ(all flat breakdown bonuses) ≡ attackRoll/defenseRoll.
  const atkBaseStat    = actor.attack || 0;
  const atkWeaponMod   = actor.weapon ? (ITEMS[actor.weapon]?.statMods?.attack ?? 0) : 0;
  const atkAbilityMod  = abilityStatMod(actor.abilities, 'attack');
  const atkEffectMod   = effectStatMod(actor, 'attack');
  const atkAttackBonus = actor.attackBonus || 0;
  const defBaseStat     = target.defense || 0;
  const defWeaponMod    = target.weapon ? (ITEMS[target.weapon]?.statMods?.defense ?? 0) : 0;
  const defAbilityMod   = abilityStatMod(target.abilities, 'defense');
  const defEffectMod    = effectStatMod(target, 'defense');
  const defDefenseBonus = target.defenseBonus || 0;

  return {
    success: true, log, cost: 1,
    attackRoll, defenseRoll, hit, killed,
    margin, damage, counterDmg, fortDamaged,
    attackerAllies, defenderAllies, splashKills, splashHits,
    splashHexes, splashRadius,
    ranged: isRanged, closeRanged: isCloseRanged,
    breakdown: {
      atkBaseDie, defBaseDie,
      atkExtraDice, defExtraDice,
      atkPool, defPool,
      atkStaffBonus,
      // Weapon damage roll → explains the damage in the breakdown popup:
      // final damage = dmgRoll × dmgTier (+ wounded surcharge if any).
      atkWeapon: actor.weapon ?? null, dmgRoll, dmgTier,
      phaseBonus, fortBonus, atkFortAtkBonus, fatiguePenalty,
      atkGangupFlat, defGangupFlat,
      atkAdvantageDice, defAdvantageDice, atkDisadvantageDice,
      forestCoverBonus, rangeDistancePenalty,
      atkBaseStat, atkWeaponMod, atkAbilityMod, atkEffectMod, atkAttackBonus,
      defBaseStat, defWeaponMod, defAbilityMod, defEffectMod, defDefenseBonus,
      // Weapon ids so the roll-breakdown tooltip can name the weapon behind
      // each side's modifier ("sword +2" rather than an opaque stat sum).
      atkWeaponId: actor.weapon ?? null,
      defWeaponId: target.weapon ?? null,
      ranged: isRanged, closeRanged: isCloseRanged,
      atkAllyNames: isRanged ? [] : atkAllies.map(e => e.displayName),
      defAllyNames: isRanged ? [] : defAllies.map(e => e.displayName),
      // Ally IDs — the 3D combat renderer uses these to lunge gang-up
      // participants half-distance toward the target alongside the attacker.
      // Ranged battles don't get gang-up so these stay empty.
      atkAllyIds: isRanged ? [] : atkAllies.map(e => e.id),
      defAllyIds: isRanged ? [] : defAllies.map(e => e.id),
      // Per-ally advantage dice. Each gang-up ally adds 1 die to its side's
      // pool; pool[0] is the combatant's own die, pool[1..N] are the ally
      // dice in the same order as atkAllies/defAllies. Capped at the number
      // of advantage dice actually granted (gang-up flat caps at ADVANTAGE_CAP).
      // The 3D readout paints each ally's icon with its assigned face value,
      // and pulses the ally whose die became the picked (best) die.
      atkAllyDice: isRanged ? [] : atkAllies.slice(0, atkAdvantageDice).map((e, i) => ({
        allyId: e.id, die: atkPool[1 + i],
      })),
      defAllyDice: isRanged ? [] : defAllies.slice(0, defAdvantageDice).map((e, i) => ({
        allyId: e.id, die: defPool[1 + i],
      })),
    },
  };
}

// Siege an impassable fortification from an adjacent hex.
// Witch-side only. The fort defends itself with a fixed defense of fortLevel+1
// (no phase / fatigue / ally modifiers) against the attacker's normal attack
// roll. Hit drops the fort by 1 level; crush (attack ≥ 2× defense) drops it by 2.
// No counter-attack. The fort is only attackable at level ≥ FORT_IMPASSABLE_THRESHOLD.
export function executeFortAssault(state, actor, targetCol, targetRow) {
  if (!getFaction(actor.owner).canAssaultFortifications()) {
    return { success: false, log: ['Only witch-side units can assault fortifications.'] };
  }
  const t = tile(state, targetCol, targetRow);
  if (!t) return { success: false, log: ['Invalid target.'] };
  if ((t.fortifyLevel || 0) < FORT_IMPASSABLE_THRESHOLD) {
    return { success: false, log: ['No wall to assault here.'] };
  }
  if (hexDistance(actor.col, actor.row, targetCol, targetRow) > 1) {
    return { success: false, log: ['Target wall is out of range.'] };
  }

  actor.guarding = 0;  // assaulting breaks guard
  const log = [];

  const attackerFaction = getFaction(actor.owner);
  const phaseBonus = attackerFaction.getPhaseCombatBonus(state.phase);

  // Attacker gang-up: witch allies adjacent to the target hex add advantage dice.
  const targetHexes = new Set([hexKey(targetCol, targetRow)]);
  for (const n of getNeighbors(targetCol, targetRow)) targetHexes.add(hexKey(n.col, n.row));
  const atkAllies = state.entities.filter(e =>
    e.alive && e.owner === actor.owner && e.id !== actor.id && targetHexes.has(combatHexKey(state, e))
  );
  const atkAdvantage = Math.min(atkAllies.length, ADVANTAGE_CAP);

  // Base attack roll: take best of 1 + atkAdvantage d6, then add flat stats.
  // Witch units never gain fortification attack bonus from their own hex.
  const atkPool = new Array(1 + atkAdvantage);
  for (let i = 0; i < atkPool.length; i++) atkPool[i] = nextDie(6);
  let atkBaseDie = atkPool[0];
  for (let i = 1; i < atkPool.length; i++) if (atkPool[i] > atkBaseDie) atkBaseDie = atkPool[i];
  const atkExtraDice = atkPool.slice(1);
  const attackRoll = atkBaseDie + actor.attack + (actor.attackBonus || 0) + phaseBonus;

  // Fortification "defense": flat value of fortLevel + 1. No modifiers.
  const defenseRoll = t.fortifyLevel + 1;

  const fortLevelBefore = t.fortifyLevel;
  const hit   = attackRoll > defenseRoll;
  const crush = hit && attackRoll >= 2 * defenseRoll;

  const phaseNote = phaseBonus > 0 ? ' (🌙 night bonus)' : '';
  const gangNote  = atkAllies.length >= 1 ? ` [advantage ${atkAdvantage}]` : '';
  log.push(
    `${actor.displayName} assaults the fortifications at (${targetCol},${targetRow})! ` +
    `[${attackRoll}${gangNote} vs ${defenseRoll}]${phaseNote}`
  );

  let damage = 0;
  if (hit) {
    damage = crush ? 2 : 1;
    t.fortifyLevel = Math.max(0, t.fortifyLevel - damage);
    if (crush) {
      log.push(`💥 The wall buckles under a crushing blow! (fort level ${fortLevelBefore} → ${t.fortifyLevel})`);
    } else {
      log.push(`🏰 The fortifications crack under the assault. (fort level ${fortLevelBefore} → ${t.fortifyLevel})`);
    }
    if (t.fortifyLevel === 0) {
      log.push(`The fortifications crumble away.`);
    } else if (t.fortifyLevel < FORT_IMPASSABLE_THRESHOLD) {
      log.push(`The wall is breached — the path is open.`);
    }
  } else {
    log.push(`The stone holds fast.`);
  }

  return {
    success: true, log, cost: 1,
    fortAssault: true,
    targetCol, targetRow,
    attackRoll, defenseRoll,
    hit, crush, damage,
    fortLevelBefore, fortLevelAfter: t.fortifyLevel,
    breakdown: {
      atkBaseDie, atkExtraDice, atkPool, phaseBonus,
      atkAdvantageDice: atkAdvantage,
      atkAllyNames: atkAllies.map(e => e.displayName),
    },
  };
}

export function executeFortify(state, actor) {
  const t = tile(state, actor.col, actor.row);
  if (!t || isRiver(t) || isBuildingFootprint(t)) return { success: false, log: ['Cannot fortify here.'] };
  if (t.fortifyLevel >= MAX_FORTIFY_LEVEL) return { success: false, log: ['Cannot fortify further.'] };
  const shared     = state.inventory.hero;
  const metalCount = (shared[ResourceType.METAL] || 0);
  const woodCount  = (shared[ResourceType.WOOD]  || 0);

  // FORTIFY_DOUBLE: this survivor's ability makes wood give +2
  const hasDoubler = actor.type === EntityType.SURVIVOR &&
    actor.hasAbility(SurvivorAbility.FORTIFY_DOUBLE);

  if (metalCount > 0) {
    shared[ResourceType.METAL]--;
    const prev = t.fortifyLevel;
    t.fortifyLevel = Math.min(MAX_FORTIFY_LEVEL, prev + 2);
    const defGain = t.fortifyLevel - prev;
    return { success: true, log: [`${actor.displayName} reinforces with metal! (fort level ${t.fortifyLevel})`], cost: 1, defGain };
  } else if (woodCount > 0) {
    shared[ResourceType.WOOD]--;
    const gain = hasDoubler ? 2 : 1;
    const prev = t.fortifyLevel;
    t.fortifyLevel = Math.min(MAX_FORTIFY_LEVEL, prev + gain);
    const defGain = t.fortifyLevel - prev;
    const star = hasDoubler ? ' ★' : '';
    return { success: true, log: [`${actor.displayName} fortifies with wood!${star} (fort level ${t.fortifyLevel})`], cost: 1, defGain };
  }

  return { success: false, log: ['No wood or metal in shared supplies.'] };
}

// requestedType: optional EntityType (IRON_GOLEM / WOOD_GOLEM / MINION).
// When provided the summon respects the player's explicit choice; falls back to
// auto-pick if the requested type is no longer affordable (e.g. plan mis-ordering).
// The summoned unit always spawns on the actor's own tile.
//
// Concrete faction restricts the summonable set — the brute, for instance,
// only summons minions. A request for a forbidden type falls back to the
// auto-pick path constrained to the allowed list.
export function executeSummon(state, actor, requestedType = null) {
  const faction         = getFaction(actor.owner);
  const concreteFaction = concreteFactionOf(actor);
  const inv     = faction.getInventory(state);
  const ownerId = actor.ownerId;
  let summonedUnit, res, unitName;

  const metal = inv[ResourceType.METAL] || 0;
  const wood  = inv[ResourceType.WOOD]  || 0;
  const total = Object.values(inv).reduce((s, v) => s + (v || 0), 0);

  // Per-faction minion cost — witch pays 2 of any, brute pays 1.
  const minionCost = concreteFaction.getMinionCost();

  // Allowed-summon set comes from the concrete faction so brute-style
  // restrictions take effect for the AI's auto-pick path too (the AI
  // submits SUMMON with summonType=null and lets the resolver choose).
  const allowedTypes = new Set(
    concreteFaction.getSummonOptions(inv).map(o => o.summonType)
  );

  // Resolve final type: honour request if affordable AND allowed, else
  // fall back to auto-pick.
  let resolvedType = requestedType;
  if (resolvedType && !allowedTypes.has(resolvedType)) resolvedType = null;
  if (resolvedType === EntityType.IRON_GOLEM && metal < 2)          resolvedType = null;
  if (resolvedType === EntityType.WOOD_GOLEM && wood  < 2)          resolvedType = null;
  if (resolvedType === EntityType.MINION      && total < minionCost) resolvedType = null;
  if (!resolvedType) {
    // Auto-pick priority: iron > wood > minion, restricted to allowed types
    if      (allowedTypes.has(EntityType.IRON_GOLEM) && metal >= 2)          resolvedType = EntityType.IRON_GOLEM;
    else if (allowedTypes.has(EntityType.WOOD_GOLEM) && wood  >= 2)          resolvedType = EntityType.WOOD_GOLEM;
    else if (allowedTypes.has(EntityType.MINION)     && total >= minionCost) resolvedType = EntityType.MINION;
    else return { success: false, log: [`Need at least ${minionCost} resource${minionCost === 1 ? '' : 's'} to summon.`] };
  }

  if (resolvedType === EntityType.IRON_GOLEM) {
    res = ResourceType.METAL; inv[res] -= 2;
    summonedUnit = createIronGolem(actor.col, actor.row, ownerId, state);
    unitName = 'Iron Golem';
  } else if (resolvedType === EntityType.WOOD_GOLEM) {
    res = ResourceType.WOOD; inv[res] -= 2;
    summonedUnit = createWoodGolem(actor.col, actor.row, ownerId, state);
    unitName = 'Wood Golem';
  } else {
    // Minion: spend `minionCost` from any resources, largest stacks first
    const keys = Object.keys(inv).filter(k => inv[k] > 0).sort((a, b) => inv[b] - inv[a]);
    let remaining = minionCost;
    const spentMap = {};
    for (const k of keys) {
      const spend = Math.min(inv[k], remaining); inv[k] -= spend; remaining -= spend;
      spentMap[k] = (spentMap[k] || 0) + spend;
      if (remaining === 0) break;
    }
    summonedUnit = createMinion(actor.col, actor.row, ownerId, state);
    unitName = 'Minion';
    state.entities.push(summonedUnit);
    assignSlotOnTile(state, summonedUnit);
    faction.trackSummon(state);
    return {
      success: true,
      log: [`${actor.displayName} raises a ${unitName}!`],
      cost: 1,
      spent: Object.entries(spentMap).map(([type, amount]) => ({ type, amount })),
    };
  }

  state.entities.push(summonedUnit);
  assignSlotOnTile(state, summonedUnit);
  faction.trackSummon(state);
  return { success: true, log: [`The witch raises a ${unitName}!`], cost: 1, spent: [{ type: res, amount: 2 }] };
}

export function executeHeal(state, actor) {
  const inv = getFaction(actor.owner).getInventory(state);
  if ((inv[ResourceType.HERBS] || 0) < 1)
    return { success: false, log: ['No herbs.'] };
  if (actor.hp >= actor.maxHp)
    return { success: false, log: [`${actor.displayName} is already at full health.`] };
  inv[ResourceType.HERBS]--;
  const healed = 2 * DAMAGE_SCALE;
  actor.heal(healed);
  return { success: true, log: [`${actor.displayName} uses herbs. (+${healed} HP, now ${actor.hp}/${actor.maxHp})`], cost: 1 };
}

export function executeUseItem(state, actor, item) {
  // Weapon equip — from actor's personal items
  if (isWeaponId(item)) {
    if (!concreteFactionOf(actor).canEquipWeaponItem(item)) {
      const label = WEAPON_LABEL[item] || item;
      return { success: false, log: [`${actor.displayName} cannot wield ${label}.`] };
    }
    // Free action, but only once per round per unit. A second equip queued
    // in the same plan no-ops here (authoritative guard).
    if (actor.equippedThisRound) {
      return { success: false, log: [`${actor.displayName} already equipped a weapon this round.`] };
    }
    const myItems = actor.items || {};
    if ((myItems[item] || 0) < 1) return { success: false, log: ['Item not available.'] };
    myItems[item]--;
    actor.equipWeapon(item);
    actor.equippedThisRound = true;
    const label = WEAPON_LABEL[item] || item;
    return { success: true, log: [`${actor.displayName} equips ${label}!`], cost: 0 };
  }

  // Shared resources
  const shared = state.inventory.hero;
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

// Thin dispatcher — heavy lifting for each ability lives in
// ABILITIES[id].execute(state, actor). The PlanAction carries `ability: id`
// (stamped by `_buildAbilityActions`), and the resolver threads it through
// so multi-ability survivors disambiguate correctly. Callers without a
// specific id get an explicit error rather than silent fallback behaviour.
export function executeUseAbility(state, actor, abilityId) {
  const ab = abilityId ? ABILITIES[abilityId] : null;
  if (!ab || typeof ab.execute !== 'function') {
    return { success: false, log: ['No active ability.'] };
  }
  return ab.execute(state, actor);
}

export function executeGuard(state, actor) {
  actor.guarding = (actor.guarding || 0) + 1;
  const charges = actor.guarding;
  const label = charges > 1 ? ` (${charges} charges)` : '';
  return {
    success: true,
    log: [`${actor.displayName} takes a guard stance.${label}`],
    cost: 1,
  };
}

// ── Sound Horn ──────────────────────────────────────────────────────────────
// Hero-only ranged exploration: 30% chance to discover a hidden survivor
// within 4 hexes. Costs 2 food. Reveals hero position for the rest of the round.

export function executeSoundHorn(state, actor) {
  const log = [];
  if (!actor.hasAbility('sound_horn')) {
    return { success: false, log: ['Only a day-side leader can sound the horn.'] };
  }

  const inv = getFaction('hero').getInventory(state);
  const food = inv['food'] || 0;
  if (food < 1) {
    return { success: false, log: ['Not enough food (need 1).'] };
  }

  // Deduct 1 food
  inv['food'] -= 1;

  // Reveal hero to all opponents for the rest of this round
  state.heroRevealedByHorn = true;

  log.push(`📯 ${actor.displayName} sounds the horn! The call echoes across the land.`);

  // Witch-side log so the opponent sees it in summary
  state.addLog('📯 A horn sounds in the distance — the Hero reveals their position!', 'witch');

  // Find hidden survivors within 4 hexes
  const candidates = [];
  for (const [key, t] of state.tiles) {
    if (!t.hiddenSurvivor) continue;
    const [c, r] = key.split(',').map(Number);
    if (hexDistance(c, r, actor.col, actor.row) <= 4) {
      candidates.push({ col: c, row: r });
    }
  }

  const encounterLog = [];
  const encounterSurvivors = [];

  if (candidates.length > 0) {
    // First survivor: guaranteed if any are within earshot
    const idx1 = Math.floor(Math.random() * candidates.length);
    const target1 = candidates[idx1];
    const enc1 = _triggerSurvivorEncounter(state, actor, target1.col, target1.row);
    if (enc1) {
      encounterLog.push(...enc1.encounterLog);
      if (enc1.encounterSurvivor) encounterSurvivors.push(enc1.encounterSurvivor);
    }

    // Second survivor: 30% chance if more hidden survivors remain
    const remaining = candidates.filter((_, i) => i !== idx1)
      .filter(c => state.tiles.get(`${c.col},${c.row}`)?.hiddenSurvivor);
    if (remaining.length > 0 && Math.random() < 0.30) {
      const target2 = remaining[Math.floor(Math.random() * remaining.length)];
      const enc2 = _triggerSurvivorEncounter(state, actor, target2.col, target2.row);
      if (enc2) {
        encounterLog.push(...enc2.encounterLog);
        if (enc2.encounterSurvivor) encounterSurvivors.push(enc2.encounterSurvivor);
      }
    }
  } else {
    log.push('No hidden souls stir within earshot.');
  }

  if (encounterLog.length) log.push(...encounterLog);

  // Return first survivor for backward compat, plus full list
  const encounterSurvivor = encounterSurvivors[0] || null;
  return { success: true, log, cost: 1, encounterLog, encounterSurvivor, encounterSurvivors };
}
