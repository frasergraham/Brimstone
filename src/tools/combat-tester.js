// Combat-tester controller — drives the admin "Combat" tab.
//
// DOM-free: holds the picker state (attacker, defender, allies per side) and
// exposes mutator methods. The UI layer (combat-tester-ui.js) renders the
// state and forwards user actions; tests verify the controller directly.
//
// Design principle (mandatory): combat is resolved by the REAL game code —
// `executeBattle` from src/actions.js. The tester only places combatants on
// a clearing map and observes the result. No parallel combat math.

import { GameState } from '../game.js';
import { hexKey, getNeighbors } from '../hex.js';
import { buildMissionMap } from '../campaign/mission-map.js';
import { executeBattle } from '../actions.js';
import {
  createHero, createSurvivor, createWitch, createMinion,
  createWoodGolem, createIronGolem, createZombie, createSoldier,
  createRogue, createCaptain, createBrute, createNecromancer,
} from '../entities.js';

// Two stable side ids — placed on the entity's `ownerId` field so allied
// placement / swap logic can group combatants without relying on the
// faction string (paladin and witch can coexist on the same side here).
export const ATK_SIDE_ID = 'tester-atk-side';
export const DEF_SIDE_ID = 'tester-def-side';

// Factory lookup keyed by EntityType value (matches UNIT_TYPES keys).
export const UNIT_FACTORIES = Object.freeze({
  paladin:     createHero,
  rogue:       createRogue,
  captain:     createCaptain,
  witch:       createWitch,
  necromancer: createNecromancer,
  brute:       createBrute,
  survivor:    createSurvivor,
  soldier:     createSoldier,
  zombie:      createZombie,
  minion:      createMinion,
  wood_golem:  createWoodGolem,
  iron_golem:  createIronGolem,
});

// Default clearing size. Grown from 7→9 so allies + main combatants don't
// crowd the centre. Centre at (4,4), defender one east at (5,4).
const DEFAULT_SIZE = 9;

// Cap allies per side. Matches src/entities.js ADVANTAGE_CAP=3: adding a 4th
// ally would only crowd the ring without growing the dice pool.
export const MAX_ALLIES_PER_SIDE = 3;

// Ally placement: BOTH sides must be hex-adjacent to the defender (the TARGET
// hex) — that's the gang-up rule in executeBattle (`atkAllies` and `defAllies`
// are both filtered by `targetHexes`). Visually we split the defender's
// neighbour ring into two groups:
//   - "atkSlots" = hexes adjacent to BOTH attacker and defender. These sit
//     alongside the attacker, which reads visually as "the attacker's posse"
//     while still satisfying the adjacent-to-target requirement.
//   - "defSlots" = hexes adjacent ONLY to defender (the back half of the
//     ring). These read as defenders bracing behind the target.
// Both groups exclude the attacker hex itself.
function _allySlots(centre, adjacent, size) {
  const centreNbrSet = new Set(
    getNeighbors(centre.col, centre.row).map(n => hexKey(n.col, n.row))
  );
  const atkSlots = [];
  const defSlots = [];
  for (const n of getNeighbors(adjacent.col, adjacent.row)) {
    if (n.col === centre.col && n.row === centre.row) continue;
    if (n.col < 0 || n.row < 0 || n.col >= size || n.row >= size) continue;
    if (centreNbrSet.has(hexKey(n.col, n.row))) atkSlots.push(n);
    else defSlots.push(n);
  }
  return { atkSlots, defSlots };
}

/**
 * Build a small clearing — open grass with a forest border. Returns a
 * `map` sub-object in the shape expected by `buildMissionMap` (handmade
 * mode). Used by the tester to give the cinematic renderer something to
 * draw without a full procedural map.
 */
export function buildClearingMap(size = DEFAULT_SIZE) {
  const tiles = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const onBorder =
        row === 0 || row === size - 1 || col === 0 || col === size - 1;
      tiles.push({ col, row, base: onBorder ? 'FOREST' : 'GRASS' });
    }
  }
  const centre = { col: Math.floor(size / 2), row: Math.floor(size / 2) };
  return {
    mode: 'handmade',
    cols: size,
    rows: size,
    heroStart: centre,
    witchStart: null,
    witchObjectives: [],
    mapSize: 'skirmish',
    survivorCounts: { buildings: 0, terrain: 0 },
    tiles,
  };
}

/**
 * Build a blank GameState wrapping a clearing map. The GameState ctor
 * auto-creates a hero (and witch unless noWitch); we wipe the entity list
 * after construction so the tester drives placement.
 */
export function newClearingState(size = DEFAULT_SIZE) {
  const mapDef = buildClearingMap(size);
  const mapData = buildMissionMap(mapDef);
  // Force noWitch so the hero placeholder is the only auto-entity. Clear it
  // immediately — the tester places its own combatants.
  const state = new GameState(true, false, 'skirmish', null, {
    ...mapData,
    noWitch: true,
    disableScoring: true,
    disableCycleBar: true,
  });
  state.entities.length = 0;
  state.hero = null;
  state.witch = null;
  state.fogOfWar = 'none';
  return state;
}

/**
 * Place a fresh entity at (col, row) on the given side. Returns the entity.
 * Throws on unknown unitType. The factory determines `owner` (faction);
 * the side id is written to `ownerId` so the tester can re-group on swap.
 */
function _placeUnit(state, unitType, col, row, sideId) {
  const factory = UNIT_FACTORIES[unitType];
  if (!factory) throw new Error(`combat-tester: unknown unitType "${unitType}"`);
  const e = factory(col, row, sideId, state);
  state.entities.push(e);
  return e;
}

// Place the attacker / defender at the canonical positions and the allies
// at the ring slots. Mutates the entity list in-place — callers clear it
// first if they want a fresh layout.
function _layoutCombatants(state, slots, size) {
  const centre   = { col: Math.floor(size / 2), row: Math.floor(size / 2) };
  const adjacent = { col: centre.col + 1, row: centre.row };

  let attackerEntity = null;
  let defenderEntity = null;
  const atkAllyEntities = [];
  const defAllyEntities = [];

  if (slots.attacker) {
    attackerEntity = _placeUnit(state, slots.attacker, centre.col, centre.row, ATK_SIDE_ID);
  }
  if (slots.defender) {
    defenderEntity = _placeUnit(state, slots.defender, adjacent.col, adjacent.row, DEF_SIDE_ID);
  }

  const { atkSlots, defSlots } = _allySlots(centre, adjacent, size);
  for (let i = 0; i < slots.atkAllies.length && i < atkSlots.length; i++) {
    const slot = atkSlots[i];
    const ally = _placeUnit(state, slots.atkAllies[i], slot.col, slot.row, ATK_SIDE_ID);
    // Force the ally's faction to match the attacker so executeBattle's
    // gang-up filter (e.owner === actor.owner) actually counts them. The
    // factories set sensible defaults (hero/witch), but survivors spawn with
    // owner=null until recruited — in the tester there's no recruit step,
    // so we pin it here. Skips if there's no attacker (defensive).
    if (attackerEntity) ally.owner = attackerEntity.owner;
    atkAllyEntities.push(ally);
  }
  for (let i = 0; i < slots.defAllies.length && i < defSlots.length; i++) {
    const slot = defSlots[i];
    const ally = _placeUnit(state, slots.defAllies[i], slot.col, slot.row, DEF_SIDE_ID);
    if (defenderEntity) ally.owner = defenderEntity.owner;
    defAllyEntities.push(ally);
  }
  return { attackerEntity, defenderEntity, atkAllyEntities, defAllyEntities, centre, adjacent };
}

/**
 * Create a Combat-tester controller. Pure data — DOM-free. The UI layer
 * subscribes via `onChange(listener)` to redraw when slots mutate.
 *
 * @param {object} [opts]
 * @param {number} [opts.size=7]   Side length of the clearing map.
 * @param {Function} [opts.battleFn=executeBattle]  Injectable for tests.
 */
export function createCombatTester(opts = {}) {
  const size = opts.size ?? DEFAULT_SIZE;
  const battleFn = opts.battleFn ?? executeBattle;

  // Slot model: which unit type sits at each role. Allies are an ordered
  // list; the i-th ally occupies the i-th ring slot on its side.
  const slots = {
    attacker: null,    // unitType string or null
    defender: null,
    atkAllies: [],
    defAllies: [],
  };

  // Build a single GameState up front; rebuilds clear and re-place
  // entities in-place so the renderer keeps the same state reference and
  // doesn't have to be torn down between layouts.
  const state = newClearingState(size);
  // Track the entities currently materialised for the slots; refreshed on
  // every slot change. Useful for the UI's "current battle" hook.
  let layout = null;
  const listeners = new Set();

  function _emit() { for (const l of listeners) l(api); }

  function _rebuild() {
    state.entities.length = 0;
    layout = _layoutCombatants(state, slots, size);
    _emit();
  }

  function setAttacker(unitType) {
    slots.attacker = unitType || null;
    _rebuild();
  }
  function setDefender(unitType) {
    slots.defender = unitType || null;
    _rebuild();
  }
  function addAlly(side, unitType) {
    if (!unitType) return false;
    const list = side === 'attacker' ? slots.atkAllies : slots.defAllies;
    // Hard-cap allies at MAX_ALLIES_PER_SIDE — matches ADVANTAGE_CAP=3 so the
    // tester can't stack allies beyond what the gang-up math actually counts.
    if (list.length >= MAX_ALLIES_PER_SIDE) return false;
    list.push(unitType);
    _rebuild();
    return true;
  }
  function removeAlly(side, idx) {
    const list = side === 'attacker' ? slots.atkAllies : slots.defAllies;
    if (idx < 0 || idx >= list.length) return;
    list.splice(idx, 1);
    _rebuild();
  }
  function swapRoles() {
    // Attacker ↔ defender; allies follow their UNITS, so the previous
    // attacker-side allies are now defender-side.
    const prevAtk = slots.attacker;
    const prevDef = slots.defender;
    const prevAtkAllies = slots.atkAllies.slice();
    const prevDefAllies = slots.defAllies.slice();
    slots.attacker  = prevDef;
    slots.defender  = prevAtk;
    slots.atkAllies = prevDefAllies;
    slots.defAllies = prevAtkAllies;
    _rebuild();
  }
  function reset() {
    slots.attacker = null;
    slots.defender = null;
    slots.atkAllies = [];
    slots.defAllies = [];
    _rebuild();
  }
  /**
   * Run the real combat through executeBattle and return its result.
   * No-op (returns null) if either main combatant is missing.
   */
  function runBattle() {
    if (!layout?.attackerEntity || !layout?.defenderEntity) return null;
    const result = battleFn(state, layout.attackerEntity, layout.defenderEntity);
    _emit();
    return {
      result,
      attackerSnap: _snap(layout.attackerEntity),
      defenderSnap: _snap(layout.defenderEntity),
    };
  }
  function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // Initial blank layout so the renderer has something to draw on mount.
  _rebuild();

  const api = {
    get state() { return state; },
    get slots() { return slots; },
    get layout() { return layout; },
    get size() { return size; },
    setAttacker, setDefender,
    addAlly, removeAlly,
    swapRoles, reset, runBattle,
    onChange,
  };
  return api;
}

// Snapshot the fields combat-cinematic needs to run. Kept tiny — the
// renderer doesn't need the full Entity, just identity, position, owner,
// type, and (optional) title.
function _snap(e) {
  return {
    id: e.id, col: e.col, row: e.row,
    owner: e.owner, type: e.type, title: e.title ?? null,
    range: e.range ?? 1,
  };
}

// Hex-key helper re-exported so the UI can label the layout positions for
// debugging without re-importing hex.js.
export { hexKey };
