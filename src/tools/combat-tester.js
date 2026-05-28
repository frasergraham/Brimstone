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
import { hexKey } from '../hex.js';
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

// Default clearing size. Centre at (3,3), defender one east at (4,3).
const DEFAULT_SIZE = 7;

// Ring of hexes around the centre/adjacent pair used for ally placement.
// Picked in odd-r offset coords so each ring slot is hex-adjacent to its
// own combatant — gang-up rules in executeBattle hinge on this.
//
// Centre is (3,3); defender is (4,3). On odd-r row 3 (odd), the neighbour
// deltas are [[-1,0],[0,-1],[1,-1],[1,0],[1,1],[0,1]]. We pick a few that
// don't collide with the other combatant.
function _ringHexes(center, exclude, size) {
  // odd-r neighbour deltas
  const dirs = center.row % 2 === 0
    ? [[-1,0],[-1,-1],[0,-1],[1,0],[0,1],[-1,1]]
    : [[-1,0],[0,-1],[1,-1],[1,0],[1,1],[0,1]];
  const out = [];
  for (const [dc, dr] of dirs) {
    const c = center.col + dc, r = center.row + dr;
    if (c < 0 || r < 0 || c >= size || r >= size) continue;
    if (c === exclude.col && r === exclude.row) continue;
    out.push({ col: c, row: r });
  }
  return out;
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

  const atkRing = _ringHexes(centre, adjacent, size);
  const defRing = _ringHexes(adjacent, centre, size);
  for (let i = 0; i < slots.atkAllies.length && i < atkRing.length; i++) {
    const slot = atkRing[i];
    atkAllyEntities.push(_placeUnit(state, slots.atkAllies[i], slot.col, slot.row, ATK_SIDE_ID));
  }
  for (let i = 0; i < slots.defAllies.length && i < defRing.length; i++) {
    const slot = defRing[i];
    defAllyEntities.push(_placeUnit(state, slots.defAllies[i], slot.col, slot.row, DEF_SIDE_ID));
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
    if (!unitType) return;
    const list = side === 'attacker' ? slots.atkAllies : slots.defAllies;
    list.push(unitType);
    _rebuild();
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
