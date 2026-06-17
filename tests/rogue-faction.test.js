// Rogue faction — tests for the distinct mechanics implemented in
// RogueFaction (sight bonus, ranged crossbow attack, melee-weapon ban,
// agility-driven loot bonus, no Sound Horn, building survivor auto-detect).

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { GameState, Phase } from '../src/game.js';
import {
  ActionType, getValidActions, executeMove, executeExplore, executeUseItem,
  executeBattle,
} from '../src/actions.js';
import {
  EntityType, createMinion, createSurvivor,
} from '../src/entities.js';
import { TileType, ResourceType, BuildingType, decomposeTileType } from '../src/tiles.js';
import { hexKey } from '../src/hex.js';
import { getFaction, RogueFaction, HeroFaction } from '../src/factions.js';
import { ITEMS } from '../src/items.js';

function freshState() {
  return new GameState(true, true);
}

// Procedural maps can drop an impassable building footprint (cap-0) on any hex.
// Fixtures that move onto / build on a fixed coordinate must neutralize any
// footprint markers a random map happened to place there.
function clearFootprint(tile) {
  if (!tile) return tile;
  tile.buildingFootprintOf = null;
  tile.footprintHexes = [];
  return tile;
}

// Spawn a rogue leader at (col, row) by swapping the day-side default.
// Returns the state and the rogue entity.
function rogueState(col = 5, row = 5) {
  const state = freshState();
  state.swapLeaderToFaction('day', 'rogue');
  state.hero.col = col;
  state.hero.row = row;
  return { state, rogue: state.hero };
}

// ── Faction class & registry ────────────────────────────────────────────────

describe('RogueFaction — class & registry', () => {
  test('getFaction("rogue") returns a RogueFaction extending HeroFaction', () => {
    const f = getFaction('rogue');
    assert.ok(f instanceof RogueFaction);
    assert.ok(f instanceof HeroFaction);
    assert.equal(f.id, 'rogue');
    assert.equal(f.name, 'Rogue');
    assert.equal(f.leaderType, EntityType.ROGUE);
  });

  test('rogue is no longer a stub — it has its own behaviour', () => {
    assert.equal(getFaction('rogue').isStub(), false);
  });
});

// ── Sight range — paladin + 1 in every phase ────────────────────────────────

describe('RogueFaction — sight range', () => {
  test('rogue sees +1 hex over paladin in every phase', () => {
    const rogue   = getFaction('rogue');
    const paladin = getFaction('hero');
    for (const phase of [Phase.DAWN, Phase.DAY, Phase.DUSK, Phase.NIGHT]) {
      assert.equal(
        rogue.getSightRange(phase),
        paladin.getSightRange(phase) + 1,
        `phase ${phase}: rogue should see +1 over paladin`
      );
    }
  });

  test('scout bonus stacks on top of the +1', () => {
    const rogue = getFaction('rogue');
    assert.equal(rogue.getSightRange(Phase.DAY,   true),  8); // 6 + 1 + 1
    assert.equal(rogue.getSightRange(Phase.DAWN,  true),  6); // 4 + 1 + 1
    assert.equal(rogue.getSightRange(Phase.NIGHT, true),  5); // 3 + 1 + 1
  });
});

// ── Innate abilities — no Sound Horn ────────────────────────────────────────

describe('RogueFaction — innate abilities', () => {
  test('innateLeaderAbilities returns empty (no sound_horn)', () => {
    assert.deepEqual(getFaction('rogue').innateLeaderAbilities, []);
  });

  test('a freshly-created rogue leader has no sound_horn ability', () => {
    const r = getFaction('rogue').createLeader(0, 0, 'p1');
    assert.equal(r.hasAbility('sound_horn'), false);
    assert.equal(r.hasAbility('summon'),     false);
  });

  test('a freshly-created rogue leader is NOT issued a horn', () => {
    // Horn issuance tracks horn-training (sound_horn): the rogue strips the
    // ability, so it never gets the key item that gates the Sound Horn action.
    const r = getFaction('rogue').createLeader(0, 0, 'p1');
    assert.ok(!r.hasItem('horn'), 'rogue should not hold a horn');
  });

  test('SOUND_HORN action is NOT surfaced for the rogue', () => {
    const { state, rogue } = rogueState();
    state.inventory.hero.food = { count: 5 };
    const actions = getValidActions(state, rogue);
    assert.ok(
      !actions.some(a => a.type === ActionType.SOUND_HORN),
      'rogue should not have SOUND_HORN in valid actions'
    );
  });
});

// ── Stats — fragile + fast ──────────────────────────────────────────────────

describe('RogueFaction — leader stats', () => {
  test('rogue is fragile (HP 70, DEF 1) and fast (agility 8)', () => {
    const r = getFaction('rogue').createLeader(0, 0, 'p1');
    assert.equal(r.maxHp,   70);
    assert.equal(r.attack,   3);
    assert.equal(r.defense,  1);
    assert.equal(r.agility,  8);
  });

  test('rogue has range 3 and projectileType "bolt"', () => {
    const r = getFaction('rogue').createLeader(0, 0, 'p1');
    assert.equal(r.getRange(), 3);
    assert.equal(ITEMS[r.getEquippedWeaponId()]?.projectileType, 'bolt');
  });
});

// ── Weapon category system ──────────────────────────────────────────────────

describe('Weapon categories', () => {
  test('all current weapons declare a category', () => {
    for (const id of Object.keys(ITEMS)) {
      if (ITEMS[id].kind !== 'weapon') continue;
      assert.ok(
        ITEMS[id].category === 'melee' || ITEMS[id].category === 'ranged',
        `${id} should declare a category`
      );
    }
  });

  test('crossbow exists and is ranged', () => {
    assert.ok(ITEMS.crossbow);
    assert.equal(ITEMS.crossbow.category, 'ranged');
    assert.equal(ITEMS.crossbow.kind,     'weapon');
  });

  test('crossbow appears in at least one building loot table', async () => {
    const { LOOT_CONFIG } = await import('../src/loot.config.js');
    let foundIn = [];
    for (const [building, table] of Object.entries(LOOT_CONFIG.buildings)) {
      if (table.some(e => e.type === 'crossbow' && e.weight > 0)) {
        foundIn.push(building);
      }
    }
    assert.ok(foundIn.length > 0,
      'crossbow must appear in some loot table; otherwise it is dead config');
  });

  test('bow is ranged; sword/axe/shield/staff/dagger are melee', () => {
    assert.equal(ITEMS.bow.category,    'ranged');
    assert.equal(ITEMS.sword.category,  'melee');
    assert.equal(ITEMS.axe.category,    'melee');
    assert.equal(ITEMS.shield.category, 'melee');
    assert.equal(ITEMS.staff.category,  'melee');
    assert.equal(ITEMS.dagger.category, 'melee');
  });
});

// ── canEquipWeaponItem gate ─────────────────────────────────────────────────

describe('RogueFaction — weapon restriction', () => {
  test('rogue refuses melee weapons', () => {
    const r = getFaction('rogue');
    assert.equal(r.canEquipWeaponItem('sword'),  false);
    assert.equal(r.canEquipWeaponItem('axe'),    false);
    assert.equal(r.canEquipWeaponItem('shield'), false);
    assert.equal(r.canEquipWeaponItem('staff'),  false);
    assert.equal(r.canEquipWeaponItem('dagger'), false);
  });

  test('rogue accepts ranged weapons', () => {
    const r = getFaction('rogue');
    assert.equal(r.canEquipWeaponItem('bow'),      true);
    assert.equal(r.canEquipWeaponItem('crossbow'), true);
  });

  test('paladin accepts every weapon', () => {
    const p = getFaction('hero');
    for (const id of Object.keys(ITEMS)) {
      if (ITEMS[id].kind !== 'weapon') continue;
      // Weapons restricted by wielderFactions (e.g. magic_bolt → witch/necromancer)
      // are NOT equippable by the paladin; skip them.
      const wf = ITEMS[id].wielderFactions;
      if (wf && !wf.includes('hero')) continue;
      assert.equal(p.canEquipWeaponItem(id), true,
        `paladin should equip ${id}`);
    }
  });

  test('executeUseItem refuses to equip a melee weapon onto the rogue', () => {
    const { state, rogue } = rogueState();
    rogue.addItem('sword'); // shouldn't normally happen, defensive check
    // The rogue starts with a bow equipped via the faction setup.
    assert.equal(rogue.getEquippedWeaponId(), 'bow', 'precondition: rogue starts holding a bow');
    const r = executeUseItem(state, rogue, 'sword');
    assert.equal(r.success, false);
    // Refusing the melee weapon must leave the existing bow equipped, unchanged.
    assert.equal(rogue.getEquippedWeaponId(), 'bow');
  });

  test('EQUIP_WEAPON action does NOT list a melee weapon in the rogue\'s pack', () => {
    const { state, rogue } = rogueState();
    // Unarmed with both weapons as spares so the equip menu (which excludes the
    // equipped weapon) surfaces the bow but filters the forbidden melee sword.
    rogue.items = { sword: { count: 1 }, bow: { count: 1 } };
    const actions = getValidActions(state, rogue);
    const equip = actions.find(a => a.type === ActionType.EQUIP_WEAPON);
    assert.ok(equip, 'rogue with a bow in pack should have EQUIP_WEAPON');
    const keys = equip.weapons.map(w => w.key);
    assert.ok(keys.includes('bow'),    'bow should be listed');
    assert.ok(!keys.includes('sword'), 'sword should NOT be listed');
  });
});

// ── Loot bonus — generic agility-driven extra roll ─────────────────────────

describe('Faction.applyExploreLootBonus — generic agility bonus', () => {
  let originalRandom;
  beforeEach(() => { originalRandom = Math.random; });
  afterEach(()  => { Math.random = originalRandom; });

  test('rogue (agility 8) gets a 30% double-roll chance', () => {
    const rogue = getFaction('rogue');
    const actor = { agility: 8, getAgility() { return 8; } };
    let extras = 0;
    Math.random = () => 0.25;  // < 0.30 → bonus fires
    rogue.applyExploreLootBonus({}, actor, 'wood', () => extras++);
    assert.equal(extras, 1);
    Math.random = () => 0.31;  // >= 0.30 → bonus skipped
    rogue.applyExploreLootBonus({}, actor, 'wood', () => extras++);
    assert.equal(extras, 1);
  });

  test('paladin (agility 6) gets NO bonus — gated above standard leader agility', () => {
    const paladin = getFaction('hero');
    const actor = { agility: 6, getAgility() { return 6; } };
    let extras = 0;
    Math.random = () => 0.001;  // would fire if any chance > 0
    paladin.applyExploreLootBonus({}, actor, 'wood', () => extras++);
    assert.equal(extras, 0);
  });

  test('low-agility units (≤6) never get the bonus', () => {
    const paladin = getFaction('hero');
    let extras = 0;
    Math.random = () => 0.001;
    for (const agi of [2, 3, 4, 5, 6]) {
      const actor = { agility: agi, getAgility() { return agi; } };
      paladin.applyExploreLootBonus({}, actor, 'wood', () => extras++);
    }
    assert.equal(extras, 0);
  });

  test('bonus does NOT fire on horses or weapons', () => {
    const rogue = getFaction('rogue');
    const actor = { agility: 8, getAgility() { return 8; } };
    let extras = 0;
    Math.random = () => 0;
    rogue.applyExploreLootBonus({}, actor, 'horse', () => extras++);
    rogue.applyExploreLootBonus({}, actor, 'sword', () => extras++, { isWeapon: true });
    rogue.applyExploreLootBonus({}, actor, 'nothing', () => extras++);
    assert.equal(extras, 0);
  });
});

// ── Loot — never empty ──────────────────────────────────────────────────────

describe('RogueFaction — exploration never turns up empty', () => {
  test('modifyLootRoll re-rolls "nothing" until it finds a real type', () => {
    const rogue = getFaction('rogue');
    const table = [
      { type: 'wood', weight: 1 },
      { type: 'food', weight: 1 },
      { type: 'nothing', weight: 1 },
    ];
    // Force the first roll to land on 'nothing'; second roll lands on
    // a real type. We mock Math.random sparingly — modifyLootRoll calls
    // rollLoot once for the re-roll attempt, and possibly once more on
    // the filtered table. In all cases, the result must NOT be 'nothing'.
    let result;
    for (let trial = 0; trial < 50; trial++) {
      result = rogue.modifyLootRoll({}, {}, table, 'nothing');
      assert.notEqual(result, 'nothing',
        'rogue.modifyLootRoll must never return "nothing"');
    }
  });

  test('modifyLootRoll passes real types through unchanged', () => {
    const rogue = getFaction('rogue');
    const table = [{ type: 'wood', weight: 1 }];
    assert.equal(rogue.modifyLootRoll({}, {}, table, 'wood'),   'wood');
    assert.equal(rogue.modifyLootRoll({}, {}, table, 'food'),   'food');
    assert.equal(rogue.modifyLootRoll({}, {}, table, 'silver'), 'silver');
  });
});

// ── Survivor auto-detect on movement ────────────────────────────────────────

describe('RogueFaction — onAfterMoveStep auto-detects survivors in buildings', () => {
  test('moving onto a building tile with a hidden survivor auto-triggers encounter', () => {
    const { state, rogue } = rogueState(3, 3);
    // Place a building tile at (4, 3) with a hidden survivor.
    const t = state.tiles.get(hexKey(4, 3));
    decomposeTileType(t, TileType.BUILDING);
    t.building = BuildingType.INN;
    t.hiddenSurvivor = true;
    t.explored = false;
    clearFootprint(t);

    const result = executeMove(state, rogue, 4, 3);
    assert.equal(result.success, true);
    assert.ok(result.encounterSurvivor, 'survivor should be auto-discovered');
    assert.equal(t.hiddenSurvivor, false, 'hidden flag should be cleared');
  });

  test('moving adjacent to a building with a hidden survivor auto-triggers', () => {
    const { state, rogue } = rogueState(3, 3);
    // Place a building with a hidden survivor at (5, 3) — neighbour of (4, 3).
    const adj = state.tiles.get(hexKey(5, 3));
    decomposeTileType(adj, TileType.BUILDING);
    adj.building = BuildingType.CHURCH;
    adj.hiddenSurvivor = true;
    adj.explored = false;
    clearFootprint(adj);
    // Make sure the rogue's destination tile (4, 3) is empty terrain.
    const dest = state.tiles.get(hexKey(4, 3));
    decomposeTileType(dest, TileType.GRASS);
    dest.building = null;
    dest.hiddenSurvivor = false;
    clearFootprint(dest);

    const result = executeMove(state, rogue, 4, 3);
    assert.equal(result.success, true);
    assert.ok(result.encounterSurvivor, 'survivor should be auto-discovered from adjacent building');
    assert.equal(adj.hiddenSurvivor, false);
  });

  test('does NOT auto-trigger for non-building tiles, even adjacent', () => {
    const { state, rogue } = rogueState(3, 3);
    // Hidden survivor on a grass tile next to the destination.
    const adj = state.tiles.get(hexKey(5, 3));
    decomposeTileType(adj, TileType.GRASS);
    adj.building = null;
    adj.hiddenSurvivor = true;
    // Clear hidden-survivor flags from every tile on the rogue's path
    // so the existing phase-random reveal can't accidentally fire on a
    // different tile and confuse the assertion.
    for (const t of state.tiles.values()) {
      if (t.col === 5 && t.row === 3) continue;  // keep our adjacent grass
      t.hiddenSurvivor = false;
    }

    const result = executeMove(state, rogue, 4, 3);
    // Survivor stays hidden — auto-detect is buildings-only.
    assert.equal(adj.hiddenSurvivor, true);
    // Use a falsy check — encounterSurvivor may be null or undefined
    // depending on whether the move loop ran the existing reveal path.
    assert.ok(!result.encounterSurvivor,
      `expected no encounter, got: ${JSON.stringify(result.encounterSurvivor)}`);
  });

  test('paladin (default day faction) does NOT get the auto-detect', () => {
    const state = freshState();
    state.hero.col = 3;
    state.hero.row = 3;
    // Hidden survivor in adjacent building.
    const adj = state.tiles.get(hexKey(5, 3));
    decomposeTileType(adj, TileType.BUILDING);
    adj.building = BuildingType.INN;
    adj.hiddenSurvivor = true;
    adj.explored = false;
    clearFootprint(adj);
    // Make sure the destination tile is plain grass (no random reveal).
    const dest = state.tiles.get(hexKey(4, 3));
    decomposeTileType(dest, TileType.GRASS);
    dest.building = null;
    dest.hiddenSurvivor = false;
    clearFootprint(dest);

    executeMove(state, state.hero, 4, 3);
    // The paladin's only chance to find the survivor is the existing
    // phase-random roll on the destination tile, which we just cleared.
    // The neighbouring INN's hidden survivor must remain hidden.
    assert.equal(adj.hiddenSurvivor, true);
  });
});

// ── Ranged combat — rogue at range 3 ────────────────────────────────────────

describe('RogueFaction — ranged crossbow attack', () => {
  test('rogue can attack a target 3 hexes away (BATTLE targets list includes it)', () => {
    const { state, rogue } = rogueState(5, 5);
    state.fogOfWar = 'none'; // isolate from LOS gating — this tests range, not visibility
    const target = createMinion(8, 5);  // distance 3 along a row
    target.owner = 'witch';
    state.entities.push(target);
    const actions = getValidActions(state, rogue);
    const battle = actions.find(a => a.type === ActionType.BATTLE);
    assert.ok(battle, 'rogue should have a BATTLE action');
    assert.ok(battle.targets.some(t => t.id === target.id),
      'BATTLE targets should include the minion at distance 3');
  });

  test('rogue cannot attack a target beyond range 3', () => {
    const { state, rogue } = rogueState(5, 5);
    const target = createMinion(9, 5);  // distance 4
    target.owner = 'witch';
    state.entities.push(target);
    const actions = getValidActions(state, rogue);
    const battle = actions.find(a => a.type === ActionType.BATTLE);
    if (battle) {
      assert.ok(!battle.targets.some(t => t.id === target.id),
        'BATTLE targets should NOT include a target at distance 4');
    }
  });

  test('executeBattle at range 3 succeeds and applies ranged combat rules', () => {
    const { state, rogue } = rogueState(5, 5);
    const target = createMinion(8, 5);  // distance 3
    target.owner = 'witch';
    state.entities.push(target);
    state.setForcedDice(3, 3);
    const r = executeBattle(state, rogue, target);
    assert.equal(r.success, true);
    // The fact that this resolves at all proves the ranged path was taken
    // (a melee attack at distance 3 would fail with "target out of range").
  });
});
