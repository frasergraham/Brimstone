// Phase D — survivor spawn `level` on discoveries + permadeath verification.
//
// Two concerns:
//   1. An optional `level` flows end-to-end through the discovery/spawn pipeline
//      (createSurvivor → HeroFaction.createDiscoveryEntity → triggerSurvivorEncounter,
//      reading tile.hiddenSurvivorLevel), so future-chapter recruits can spawn
//      already scaled. Node-spawned survivors plumb the same field.
//   2. Permadeath via reconcileRosterAfterMission is correct: dead party members
//      never return; survivors carry their level/xp; discovered-and-alive join;
//      a discovered-and-dead survivor never joins; a mission LOSS preserves the
//      full roster (no permadeath, no stat changes).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { GameState, Phase } from '../src/game.js';
import {
  createSurvivor, applyLevel, awardXP, resetRoster,
  SURVIVOR_ROSTER, EntityType,
} from '../src/entities.js';
import { hpForLevel, atkBonusForLevel, defBonusForLevel } from '../src/balance.js';
import {
  snapshotSurvivor, reconcileRosterAfterMission, Campaign,
} from '../src/campaign/campaign.js';
import { getFaction } from '../src/factions.js';
import { triggerSurvivorEncounter } from '../src/survivor-discovery.js';
import { getCampaignById } from '../src/campaign/campaign-registry.js';
import { hexKey, getNeighbors } from '../src/hex.js';
import { serializeState, deserializeState } from '../server/state-sync.js';

// ── localStorage mock (Campaign.save() touches it) ──────────────────────────
const _store = {};
globalThis.localStorage = globalThis.localStorage ?? {
  getItem: (k) => _store[k] ?? null,
  setItem: (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
  clear: () => { for (const k of Object.keys(_store)) delete _store[k]; },
};

const hollowDef = getCampaignById('calebs_hollow_prologue');
const campaignCtx = () => ({ isCampaign: true });

// ── createSurvivor — spawn level ────────────────────────────────────────────

describe('createSurvivor — optional spawn level', () => {
  test('defaults to level 1 with unchanged base stats', () => {
    resetRoster();
    const name = SURVIVOR_ROSTER[0].name;
    const s = createSurvivor(0, 0, 'hero', null, name);
    assert.equal(s.level, 1);
    assert.equal(s.maxHp, SURVIVOR_ROSTER[0].maxHp, 'L1 maxHp == roster base');
    assert.equal(s.hp, s.maxHp, 'spawns at full HP');
    // applyLevel(_,1) snapshots the L1 base — equal to the roster base.
    assert.equal(s._baseMaxHp, SURVIVOR_ROSTER[0].maxHp);
  });

  test('spawns at an explicit level with scaled HP/ATK/DEF', () => {
    resetRoster();
    const name = SURVIVOR_ROSTER[0].name;
    const ref = createSurvivor(0, 0, 'hero', null, name);        // L1 reference
    const lvl3 = createSurvivor(0, 0, 'hero', null, name, 3);    // same char, L3

    assert.equal(lvl3.level, 3);
    assert.equal(lvl3.maxHp, hpForLevel(ref.maxHp, 3), 'maxHp scaled off the L1 base');
    assert.equal(lvl3.hp, lvl3.maxHp, 'spawns at full (leveled) HP');
    // ATK/DEF level bonus composes live via the getters — base fields untouched.
    assert.equal(lvl3.attack, ref.attack, 'stored base attack is unchanged');
    assert.equal(lvl3.getAttack(), ref.getAttack() + atkBonusForLevel(3));
    assert.equal(lvl3.getDefense(), ref.getDefense() + defBonusForLevel(3));
    // _baseMaxHp is the L1 base, NOT the scaled value — guards against double-boost.
    assert.equal(lvl3._baseMaxHp, ref.maxHp);
  });

  test('level 0 / null coerces to 1 (no scaling)', () => {
    resetRoster();
    const name = SURVIVOR_ROSTER[1].name;
    assert.equal(createSurvivor(0, 0, 'hero', null, name, 0).level, 1);
    assert.equal(createSurvivor(0, 0, 'hero', null, name, null).level, 1);
  });

  test('a leveled survivor re-levels off the true base (idempotent _baseMaxHp)', () => {
    resetRoster();
    const name = SURVIVOR_ROSTER[0].name;
    const base = SURVIVOR_ROSTER[0].maxHp;
    const s = createSurvivor(0, 0, 'hero', null, name, 3);
    applyLevel(s, 5); // re-level — must NOT compound off the already-scaled maxHp
    assert.equal(s._baseMaxHp, base);
    assert.equal(s.maxHp, hpForLevel(base, 5));
  });
});

// ── Discovery pipeline — hiddenSurvivorLevel end-to-end ──────────────────────

describe('hidden-survivor discovery — level plumbing', () => {
  test('hiddenSurvivorLevel spawns the discovered survivor at that level', () => {
    const state = new GameState(true, false); // witch AI, hero human
    const hero = state.hero;
    const key = hexKey(hero.col, hero.row);
    const tile = state.tiles.get(key);

    // Pin a specific roster character so we can build a comparable L1 reference.
    const name = SURVIVOR_ROSTER[0].name;
    const ref = createSurvivor(0, 0, 'hero', null, name); // L1, separate scratch

    tile.hiddenSurvivor = true;
    tile.hiddenSurvivorId = name;
    tile.hiddenSurvivorLevel = 3;

    const before = state.entities.length;
    const enc = triggerSurvivorEncounter(state, hero, hero.col, hero.row);

    assert.ok(enc, 'discovery returns an encounter');
    assert.equal(state.entities.length, before + 1, 'one survivor added');
    const surv = state.entities.find(
      e => e.type === EntityType.SURVIVOR && e.name === name
    );
    assert.ok(surv, 'the pinned survivor was spawned');
    assert.equal(surv.level, 3, 'spawned at the authored level');
    assert.equal(surv.maxHp, hpForLevel(ref.maxHp, 3));
    assert.equal(surv.getAttack(), ref.getAttack() + atkBonusForLevel(3));
    assert.equal(surv.getDefense(), ref.getDefense() + defBonusForLevel(3));

    // Tile flags cleared so re-stepping never re-spawns.
    assert.equal(tile.hiddenSurvivor, false);
    assert.equal(tile.hiddenSurvivorId, null);
    assert.equal(tile.hiddenSurvivorLevel, null);

    // The discovery RESULT descriptor reports the level (for UI / round-trip).
    assert.equal(enc.encounterSurvivor.level, 3);
  });

  test('absent hiddenSurvivorLevel defaults to level 1', () => {
    const state = new GameState(true, false);
    const hero = state.hero;
    const tile = state.tiles.get(hexKey(hero.col, hero.row));
    tile.hiddenSurvivor = true;
    tile.hiddenSurvivorId = null; // random pick
    // hiddenSurvivorLevel intentionally unset

    const enc = triggerSurvivorEncounter(state, hero, hero.col, hero.row);
    assert.ok(enc);
    const surv = state.entities.find(
      e => e.type === EntityType.SURVIVOR && e.id === enc.encounterSurvivor.id
    );
    assert.equal(surv.level, 1);
    assert.equal(enc.encounterSurvivor.level, 1);
  });

  test('witch discovery ignores level — raises a level-1 zombie', () => {
    const state = new GameState(false, true); // hero AI, witch human
    const witch = state.witch;
    const tile = state.tiles.get(hexKey(witch.col, witch.row));
    tile.hiddenSurvivor = true;
    tile.hiddenSurvivorLevel = 5; // must NOT scale the zombie

    const enc = triggerSurvivorEncounter(state, witch, witch.col, witch.row);
    assert.ok(enc);
    const z = state.entities.find(e => e.type === EntityType.ZOMBIE);
    assert.ok(z, 'a zombie was raised');
    assert.equal(z.level, 1, 'zombie discovery does not carry the survivor level');
  });
});

// ── Node-spawned survivor descriptor carries the level ──────────────────────

describe('node-spawned survivors — level field', () => {
  test('descriptor with a level survives the state-sync round-trip', () => {
    const state = new GameState(true, false);
    state.nodeSpawnedSurvivors = [{
      id: 'x1', type: 'survivor', name: 'Test', title: 'Scout',
      hp: 3, maxHp: 3, attack: 1, defense: 1, level: 2,
      abilityLabel: null, color: '#aaa',
    }];
    const restored = deserializeState(serializeState(state));
    assert.equal(restored.nodeSpawnedSurvivors.length, 1);
    assert.equal(restored.nodeSpawnedSurvivors[0].level, 2,
      'level field round-trips via the whole-array spread');
  });

  test('_applyNodeSurvivorSpawning emits a level on the descriptor', () => {
    const state = new GameState(true, false);
    state.phase = Phase.NIGHT;
    const hero = state.hero;

    // Single objective whose cluster includes the hero's tile (so the hero is
    // "on a node" at night, triggering the 33% spawn roll).
    state.witchObjectives = [{
      col: hero.col, row: hero.row, label: 'N',
      hexes: [{ col: hero.col, row: hero.row }],
      seenByHero: false, seenByWitch: false, prevCtrl: 'neutral',
    }];

    // Guarantee freeHex() finds a spot: make every existing neighbour passable
    // (no river/structure) and clear any entities sitting on them.
    const neighbours = getNeighbors(hero.col, hero.row)
      .filter(n => state.tiles.get(hexKey(n.col, n.row)));
    assert.ok(neighbours.length > 0, 'hero has at least one on-map neighbour');
    for (const n of neighbours) {
      const t = state.tiles.get(hexKey(n.col, n.row));
      t.path = null;          // clear any river
      t.structure = null;     // clear any building
      t.building = null;
      state.entities = state.entities.filter(e => !(e.col === n.col && e.row === n.row));
    }

    const orig = Math.random;
    Math.random = () => 0.1; // < 0.33 spawn roll, < 0.5 horse roll (deterministic)
    try {
      getFaction('hero')._applyNodeSurvivorSpawning(state);
    } finally {
      Math.random = orig;
    }

    assert.equal(state.nodeSpawnedSurvivors.length, 1, 'a survivor spawned at the node');
    assert.equal(state.nodeSpawnedSurvivors[0].level, 1, 'descriptor carries the (plumbed) level');
    const ent = state.entities.find(e => e.id === state.nodeSpawnedSurvivors[0].id);
    assert.ok(ent, 'the descriptor maps to a real spawned entity');
    assert.equal(ent.level, 1, 'spawned entity has its level applied');
  });
});

// ── Permadeath / reconcileRosterAfterMission ────────────────────────────────

describe('reconcileRosterAfterMission — permadeath', () => {
  // A real (createSurvivor-built) entity, so level/stats are exercised end-to-end.
  function liveSurvivor(name, level = 1) {
    resetRoster();
    const s = createSurvivor(0, 0, 'hero', null, name, level);
    s.owner = 'hero';
    return s;
  }

  test('a dead deployed roster member is permanently removed', () => {
    const roster = [{ name: 'Vet', level: 3, hp: 9, maxHp: 9 }];
    const dead = liveSurvivor(SURVIVOR_ROSTER[0].name, 3);
    dead.name = 'Vet';
    dead.hp = 0; // killed this mission
    assert.equal(dead.alive, false);

    const result = reconcileRosterAfterMission(roster, [dead]);
    assert.equal(result.length, 0, 'dead deployed member is gone — never resurrected');
  });

  test('an alive deployed member is updated with current HP / level / xp', () => {
    const roster = [{ name: 'Vet', level: 1, hp: 5, maxHp: 5 }];
    const surv = liveSurvivor(SURVIVOR_ROSTER[0].name, 3);
    surv.name = 'Vet';
    surv.xp = 700;
    surv.hp = 4; // wounded but alive

    const result = reconcileRosterAfterMission(roster, [surv]);
    assert.equal(result.length, 1);
    assert.equal(result[0].level, 3, 'updated level snapshotted');
    assert.equal(result[0].xp, 700, 'accumulated xp snapshotted');
    assert.equal(result[0].hp, 4, 'current (wounded) HP snapshotted');
  });

  test('a discovered live survivor (not in pre-mission roster) JOINS', () => {
    const roster = [{ name: 'Alice', level: 1, hp: 3, maxHp: 3 }];
    const aliceEnt = liveSurvivor(SURVIVOR_ROSTER[0].name, 1);
    aliceEnt.name = 'Alice';
    const newcomer = liveSurvivor(SURVIVOR_ROSTER[1].name, 1);
    newcomer.name = 'Newcomer';

    const result = reconcileRosterAfterMission(roster, [aliceEnt, newcomer]);
    const names = result.map(s => s.name).sort();
    assert.deepEqual(names, ['Alice', 'Newcomer'], 'discovered survivor added to roster');
  });

  test('a discovered survivor carries its spawn LEVEL into the roster', () => {
    const roster = [];
    const recruit = liveSurvivor(SURVIVOR_ROSTER[0].name, 3); // discovered at L3
    recruit.name = 'Champion';
    const base = SURVIVOR_ROSTER[0].maxHp;

    const result = reconcileRosterAfterMission(roster, [recruit]);
    assert.equal(result.length, 1);
    assert.equal(result[0].level, 3, 'discovered level persists into the snapshot');
    assert.equal(result[0].maxHp, hpForLevel(base, 3));
  });

  test('a discovered survivor who DIES the same mission never joins', () => {
    const roster = [{ name: 'Alice', level: 1, hp: 3, maxHp: 3 }];
    const aliceEnt = liveSurvivor(SURVIVOR_ROSTER[0].name, 1);
    aliceEnt.name = 'Alice';
    const doomed = liveSurvivor(SURVIVOR_ROSTER[1].name, 1);
    doomed.name = 'Doomed';
    doomed.hp = 0; // discovered, then killed — same mission

    const result = reconcileRosterAfterMission(roster, [aliceEnt, doomed]);
    const names = result.map(s => s.name).sort();
    // Documented behaviour: a discovered-then-dead survivor is NEVER added (it
    // isn't in the pre-mission roster, and dead entities aren't snapshotted).
    assert.deepEqual(names, ['Alice']);
  });

  test('no deaths → every deployed member is preserved (with updated stats)', () => {
    const roster = [
      { name: 'A', level: 1, hp: 3, maxHp: 3 },
      { name: 'B', level: 1, hp: 3, maxHp: 3 },
    ];
    const a = liveSurvivor(SURVIVOR_ROSTER[0].name, 1); a.name = 'A'; a.hp = 2;
    const b = liveSurvivor(SURVIVOR_ROSTER[1].name, 1); b.name = 'B'; b.hp = 3;

    const result = reconcileRosterAfterMission(roster, [a, b]);
    assert.equal(result.length, 2, 'both survivors kept');
    assert.equal(result.find(s => s.name === 'A').hp, 2, 'updated HP carried');
  });
});

describe('mission LOSS preserves the roster (no permadeath)', () => {
  test('a failed mission leaves the campaign roster untouched', () => {
    const c = new Campaign(hollowDef);
    c.roster = [
      { name: 'Alice', title: 'Scout', bio: '', abilities: [], abilityLabel: null,
        color: '#fff', hp: 3, maxHp: 5, attack: 1, defense: 1, level: 2, xp: 250, weapon: null, items: {} },
      { name: 'Bob', title: 'Guard', bio: '', abilities: [], abilityLabel: null,
        color: '#aaa', hp: 4, maxHp: 4, attack: 1, defense: 1, level: 1, xp: 0, weapon: null, items: {} },
    ];
    const before = JSON.parse(JSON.stringify(c.roster));

    // Defeat: applyMissionResult is a no-op for the roster (it early-returns).
    c.applyMissionResult('prologue', {
      won: false,
      survivors: [], // even an empty survivor list must NOT wipe the roster
      resources: {},
      heroStats: { hp: 0, maxHp: 98, attack: 2, defense: 2, level: 1, xp: 0, weapon: null, items: {} },
    });

    assert.equal(c.roster.length, 2, 'both members still present after a loss');
    assert.deepEqual(c.roster, before, 'roster is unchanged (pre-mission state restored)');
  });
});

// ── Level-up persistence (data-model integration) ───────────────────────────

describe('level-up persistence through a mission', () => {
  // Mirror the campaign deploy path in main.js (spawn the SAME char, then
  // re-level off its true L1 base so maxHp isn't double-boosted).
  function deployFromSnapshot(snap) {
    resetRoster();
    const s = createSurvivor(0, 0, 'hero', null, snap.name);
    s.attack = snap.attack;
    s.defense = snap.defense;
    s.xp = snap.xp || 0;
    applyLevel(s, snap.level || 1);
    if (typeof snap.hp === 'number') s.hp = Math.min(snap.hp, s.maxHp);
    return s;
  }

  test('enter L2 → award XP to L3 → snapshot → redeploy returns at L3', () => {
    resetRoster();
    const name = SURVIVOR_ROSTER[0].name;
    const charBase = SURVIVOR_ROSTER[0].maxHp;
    const refL1 = createSurvivor(0, 0, 'hero', null, name); // L1 baseline

    // Deploy at static level 2, 0 xp.
    const s = createSurvivor(0, 0, 'hero', null, name, 2);
    assert.equal(s.level, 2);
    assert.equal(s.xp, 0);

    // Award enough XP to cross the L3 threshold (xpForLevel(3) === 600).
    const res = awardXP(s, 600, campaignCtx());
    assert.equal(res.leveledUp, true);
    assert.equal(s.level, 3);
    assert.equal(s.xp, 600);

    // Mission end — snapshot captures the new level + xp.
    const snap = snapshotSurvivor(s);
    assert.equal(snap.level, 3);
    assert.equal(snap.xp, 600);

    // Next mission — redeploy returns at L3 with level-3 stats (no double-boost).
    const redeployed = deployFromSnapshot(snap);
    assert.equal(redeployed.level, 3);
    assert.equal(redeployed.xp, 600);
    assert.equal(redeployed.maxHp, hpForLevel(charBase, 3), 'maxHp from the true base');
    assert.equal(redeployed._baseMaxHp, charBase);
    assert.equal(redeployed.getAttack(), refL1.getAttack() + atkBonusForLevel(3));
  });
});
