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
  rangeOf, getEquippedWeaponIdOf,
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
// Allow placing one MORE ally than ADVANTAGE_CAP=3 so the operator can
// visually verify the cap is working — 4 allies are physically around
// the combatant but only 3 contribute to the gang-up math.
export const MAX_ALLIES_PER_SIDE = 4;

// Attack modes. 'melee' places the defender adjacent (distance 1); 'ranged'
// places the defender at distance 3 (within the clearing's interior). In
// ranged mode the attacker's range is forced to RANGED_ATTACK_RANGE so
// executeBattle routes through its ranged branch regardless of which unit
// type the operator picked.
export const ATTACK_MODES = Object.freeze(['melee', 'ranged']);
export const RANGED_DEFENDER_OFFSET = 3;
export const RANGED_ATTACK_RANGE = 3;

// The defender's offset hex for a given attack mode. Centre is the
// attacker's hex; in melee the defender sits one hex east, in ranged
// three hexes east. Shared by _layoutCombatants and randomizeAllies so
// ally placement always lines up with the actual target hex.
function _defenderHexFor(size, attackMode) {
  const centre = { col: Math.floor(size / 2), row: Math.floor(size / 2) };
  const offset = attackMode === 'ranged' ? RANGED_DEFENDER_OFFSET : 1;
  return { col: centre.col + offset, row: centre.row };
}

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
function _layoutCombatants(state, slots, size, attackMode = 'melee') {
  const centre   = { col: Math.floor(size / 2), row: Math.floor(size / 2) };
  const adjacent = _defenderHexFor(size, attackMode);

  let attackerEntity = null;
  let defenderEntity = null;
  const atkAllyEntities = [];
  const defAllyEntities = [];

  if (slots.attacker) {
    attackerEntity = _placeUnit(state, slots.attacker, centre.col, centre.row, ATK_SIDE_ID);
    // In ranged mode, equip a bow so the attacker becomes ranged regardless
    // of the picked unit type. Units have no innate range — range is
    // weapon-derived (Entity.getRange() reads ITEMS[equippedWeapon].range, with
    // the bow at range 3 / projectileType 'bolt'), so equipping the bow makes
    // the strike a true ranged attack.
    if (attackMode === 'ranged') attackerEntity.equipWeapon('bow');
  }
  if (slots.defender) {
    defenderEntity = _placeUnit(state, slots.defender, adjacent.col, adjacent.row, DEF_SIDE_ID);
  }

  const { atkSlots, defSlots } = _allySlots(centre, adjacent, size);
  // Prefer side-natural slots, then overflow into the other half if the
  // operator has placed more allies than the front/back partition has room
  // for (MAX_ALLIES_PER_SIDE=4 vs typically 2 atkSlots + 3 defSlots). All
  // overflow slots are still adjacent to the defender, so executeBattle's
  // gang-up filter still counts them.
  const atkPool = [...atkSlots, ...defSlots];
  const defPool = [...defSlots, ...atkSlots];
  // Attacker / defender hexes are off-limits to allies regardless of pool.
  const usedKeys = new Set([
    hexKey(centre.col, centre.row),
    hexKey(adjacent.col, adjacent.row),
  ]);
  // Validate that an override falls inside the legal slot set (defender-
  // adjacent, not on attacker / defender). Anything else (off-map, on a
  // main combatant) is rejected so a stale override can never let an ally
  // land on top of another entity.
  const legalSlotKeys = new Set([...atkPool, ...defPool].map(s => hexKey(s.col, s.row)));
  const takeOverride = (pos) => {
    if (!pos) return null;
    const k = hexKey(pos.col, pos.row);
    if (usedKeys.has(k)) return null;
    if (!legalSlotKeys.has(k)) return null;
    usedKeys.add(k);
    return { col: pos.col, row: pos.row };
  };
  const takeNext = (pool) => {
    for (const s of pool) {
      const k = hexKey(s.col, s.row);
      if (usedKeys.has(k)) continue;
      usedKeys.add(k);
      return s;
    }
    return null;
  };
  for (let i = 0; i < slots.atkAllies.length; i++) {
    const slot = takeOverride(slots.atkAllyPositions?.[i]) ?? takeNext(atkPool);
    if (!slot) break;
    const ally = _placeUnit(state, slots.atkAllies[i], slot.col, slot.row, ATK_SIDE_ID);
    // Force the ally's faction to match the attacker so executeBattle's
    // gang-up filter (e.owner === actor.owner) actually counts them. The
    // factories set sensible defaults (hero/witch), but survivors spawn with
    // owner=null until recruited — in the tester there's no recruit step,
    // so we pin it here. Skips if there's no attacker (defensive).
    if (attackerEntity) ally.owner = attackerEntity.owner;
    atkAllyEntities.push(ally);
  }
  for (let i = 0; i < slots.defAllies.length; i++) {
    const slot = takeOverride(slots.defAllyPositions?.[i]) ?? takeNext(defPool);
    if (!slot) break;
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
/** Valid speed modes for the tester's "Run Battle" branch. The cinematic
 * mode runs the dice-card readout + Continue gate; fast/vfast skip the
 * readout entirely and just paint the floaters + miss flash. */
export const SPEED_MODES = Object.freeze(['cinematic', 'fast', 'vfast']);

export function createCombatTester(opts = {}) {
  const size = opts.size ?? DEFAULT_SIZE;
  const battleFn = opts.battleFn ?? executeBattle;

  // Slot model: which unit type sits at each role. Allies are an ordered
  // list; the i-th ally occupies the i-th ring slot on its side.
  // atkAllyPositions / defAllyPositions are optional per-ally position
  // overrides (one entry per ally, or undefined to use the default pool
  // order). Set by randomizeAllies() and cleared on any slot mutation so
  // the override is one-shot and doesn't leak across subsequent edits.
  const slots = {
    attacker: null,    // unitType string or null
    defender: null,
    atkAllies: [],
    defAllies: [],
    atkAllyPositions: [],
    defAllyPositions: [],
  };

  function _clearAllyPositionOverrides() {
    slots.atkAllyPositions = [];
    slots.defAllyPositions = [];
  }

  // Speed mode — controls which display the UI's Run Battle button picks.
  // Defaults to cinematic (matches the URL default and the prior behaviour).
  let speedMode = 'cinematic';

  // Attack mode — 'melee' (defender adjacent) or 'ranged' (defender at
  // distance 3, attacker forced to range 3). Defaults to melee.
  let attackMode = 'melee';

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
    layout = _layoutCombatants(state, slots, size, attackMode);
    _emit();
  }

  function setAttacker(unitType) {
    slots.attacker = unitType || null;
    _clearAllyPositionOverrides();
    _rebuild();
  }
  function setDefender(unitType) {
    slots.defender = unitType || null;
    _clearAllyPositionOverrides();
    _rebuild();
  }
  function addAlly(side, unitType) {
    if (!unitType) return false;
    const list = side === 'attacker' ? slots.atkAllies : slots.defAllies;
    // Hard-cap allies at MAX_ALLIES_PER_SIDE — matches ADVANTAGE_CAP=3 so the
    // tester can't stack allies beyond what the gang-up math actually counts.
    if (list.length >= MAX_ALLIES_PER_SIDE) return false;
    list.push(unitType);
    _clearAllyPositionOverrides();
    _rebuild();
    return true;
  }
  function removeAlly(side, idx) {
    const list = side === 'attacker' ? slots.atkAllies : slots.defAllies;
    if (idx < 0 || idx >= list.length) return;
    list.splice(idx, 1);
    _clearAllyPositionOverrides();
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
    _clearAllyPositionOverrides();
    _rebuild();
  }
  function reset() {
    slots.attacker = null;
    slots.defender = null;
    slots.atkAllies = [];
    slots.defAllies = [];
    _clearAllyPositionOverrides();
    _rebuild();
  }
  /**
   * Reshuffle currently-placed allies across the available adjacent-to-
   * defender hex slots. Doesn't change WHICH units are allies — only the
   * hex each one stands on. Returns true if a shuffle happened, false if
   * there are no allies to shuffle.
   *
   * The shuffled positions are persisted as per-ally overrides on
   * `slots.atkAllyPositions` / `slots.defAllyPositions` so the cinematic
   * rebuilds (triggered by every onChange) honour the new layout. Any
   * subsequent slot mutation (add/remove/swap/reset/setAttacker/setDefender)
   * clears the overrides — so randomization is one-shot per layout.
   *
   * @param {Function} [rng=Math.random] — injectable for deterministic tests.
   * @returns {boolean}
   */
  function randomizeAllies(rng = Math.random) {
    const totalAllies = slots.atkAllies.length + slots.defAllies.length;
    if (totalAllies === 0) return false;
    const centre   = { col: Math.floor(size / 2), row: Math.floor(size / 2) };
    const adjacent = _defenderHexFor(size, attackMode);
    const { atkSlots, defSlots } = _allySlots(centre, adjacent, size);
    // All defender-adjacent hexes (minus the attacker hex) form the legal
    // pool. There are typically 5 such hexes on a flat clearing.
    const pool = [...atkSlots, ...defSlots];
    if (pool.length === 0) return false;
    // Fisher-Yates shuffle on a copy.
    const shuffled = pool.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    // Assign in order: attacker-side allies first, then defender-side. The
    // operator asked for "shuffled across" all slots — side ordering inside
    // the shuffled stream still produces a uniformly-distributed assignment.
    const atkPos = [];
    const defPos = [];
    let idx = 0;
    for (let i = 0; i < slots.atkAllies.length && idx < shuffled.length; i++) {
      atkPos.push({ col: shuffled[idx].col, row: shuffled[idx].row });
      idx++;
    }
    for (let i = 0; i < slots.defAllies.length && idx < shuffled.length; i++) {
      defPos.push({ col: shuffled[idx].col, row: shuffled[idx].row });
      idx++;
    }
    slots.atkAllyPositions = atkPos;
    slots.defAllyPositions = defPos;
    _rebuild();
    return true;
  }
  function setAttackMode(mode) {
    // Unknown values fall back to melee so a stale URL never wedges the
    // tester into an undefined branch.
    const next = ATTACK_MODES.includes(mode) ? mode : 'melee';
    if (next === attackMode) return;
    attackMode = next;
    // Changing the mode shifts the defender hex, so cached per-ally
    // position overrides no longer correspond to legal slots — drop them.
    _clearAllyPositionOverrides();
    _rebuild();
  }
  function setSpeedMode(mode) {
    // Unknown values fall back to cinematic so a stale URL never wedges the
    // tester into an undefined branch.
    const next = SPEED_MODES.includes(mode) ? mode : 'cinematic';
    if (next === speedMode) return;
    speedMode = next;
    _emit();
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
      // result.killed only covers the defender; a counter-kill flips the
      // attacker's alive flag (and drops it from state.entities) instead.
      attackerKilled: !layout.attackerEntity.alive,
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
    get speedMode() { return speedMode; },
    get attackMode() { return attackMode; },
    setAttacker, setDefender,
    addAlly, removeAlly,
    swapRoles, reset, runBattle,
    randomizeAllies,
    setSpeedMode, setAttackMode,
    onChange,
  };
  return api;
}

/**
 * Shape one tester battle as a wrap-up combat pair — the { a, b } unit shape
 * compileTurnBattlePairs produces — so the UI can render the game's wrap-up
 * battle summary row for it. Attacker is `a`, defender `b`: the attacker's
 * HP loss is the counter damage, the defender's the strike damage.
 *
 * @param {object} out — runBattle() output ({ result, attackerSnap,
 *   defenderSnap, attackerKilled }).
 * @returns {{a: object, b: object}}
 */
export function battleWrapupPair(out) {
  const unit = (snap, hpLost, killed) => ({
    id: snap.id, type: snap.type, title: snap.title ?? null,
    name: snap.title ?? snap.type, color: null,
    hpLost, killed,
  });
  return {
    a: unit(out.attackerSnap, out.result.counterDmg ?? 0, !!out.attackerKilled),
    b: unit(out.defenderSnap, out.result.damage ?? 0, !!out.result.killed),
  };
}

// Snapshot the fields combat-cinematic needs to run. Kept tiny — the
// renderer doesn't need the full Entity, just identity, position, owner,
// type, and (optional) title.
function _snap(e) {
  return {
    id: e.id, col: e.col, row: e.row,
    owner: e.owner, type: e.type, title: e.title ?? null,
    range: rangeOf(e),
    weapon: getEquippedWeaponIdOf(e.items),
  };
}

// Hex-key helper re-exported so the UI can label the layout positions for
// debugging without re-importing hex.js.
export { hexKey };
