// Unit tests for the admin Combat tester.
//
// Covers the DOM-free controller in src/tools/combat-tester.js and the
// structural wiring in admin-tools.html (tab button, panel, KNOWN_TOOLS).
// The full cinematic and the renderer mount are exercised in the browser;
// here we pin the contract — placement, swap behaviour, real executeBattle
// delegation — that the UI relies on.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildClearingMap, newClearingState, createCombatTester,
  ATK_SIDE_ID, DEF_SIDE_ID, UNIT_FACTORIES,
} from '../src/tools/combat-tester.js';
import { hexKey, hexDistance } from '../src/hex.js';
import { KNOWN_TOOLS } from '../src/tools/url-state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMIN_TOOLS_HTML = resolve(__dirname, '..', 'admin-tools.html');

describe('combat-tester — buildClearingMap', () => {
  test('produces a handmade map of the requested side length', () => {
    const m = buildClearingMap(9);
    assert.equal(m.mode, 'handmade');
    assert.equal(m.cols, 9);
    assert.equal(m.rows, 9);
    assert.equal(m.tiles.length, 81);
  });

  test('border tiles are FOREST, interior is GRASS', () => {
    const m = buildClearingMap(9);
    const at = (col, row) => m.tiles.find(t => t.col === col && t.row === row);
    assert.equal(at(0, 0).base, 'FOREST');
    assert.equal(at(8, 8).base, 'FOREST');
    assert.equal(at(0, 4).base, 'FOREST');
    assert.equal(at(4, 4).base, 'GRASS');
    assert.equal(at(5, 4).base, 'GRASS');
  });

  test('heroStart sits at the centre hex', () => {
    const m = buildClearingMap(9);
    assert.deepEqual(m.heroStart, { col: 4, row: 4 });
  });

  test('clearing GameState boots with no entities and no fog', () => {
    const s = newClearingState();
    assert.equal(s.entities.length, 0);
    assert.equal(s.hero, null);
    assert.equal(s.witch, null);
    assert.equal(s.fogOfWar, 'none');
    // Tile map is the full 9×9 grid keyed by hexKey.
    assert.ok(s.tiles.get(hexKey(0, 0)));
    assert.ok(s.tiles.get(hexKey(8, 8)));
  });
});

describe('combat-tester — controller placement', () => {
  test('setAttacker places the unit at the centre with attacker side id', () => {
    const t = createCombatTester();
    t.setAttacker('paladin');
    const e = t.layout.attackerEntity;
    assert.ok(e, 'attacker entity should exist');
    assert.equal(e.col, 4);
    assert.equal(e.row, 4);
    assert.equal(e.ownerId, ATK_SIDE_ID);
    assert.equal(e.type, 'paladin');
    // The state's entity list now holds exactly this combatant.
    assert.equal(t.state.entities.length, 1);
  });

  test('setDefender places the unit on the adjacent hex (5,4)', () => {
    const t = createCombatTester();
    t.setAttacker('paladin');
    t.setDefender('witch');
    const def = t.layout.defenderEntity;
    assert.equal(def.col, 5);
    assert.equal(def.row, 4);
    assert.equal(def.ownerId, DEF_SIDE_ID);
    // Centre and adjacent are hex-distance 1 — gang-up math depends on it.
    assert.equal(hexDistance(4, 4, 5, 4), 1);
  });

  test('ATTACKER ally is placed hex-adjacent to the DEFENDER (so gang-up applies)', () => {
    // The gang-up rule in executeBattle requires attacker-side allies to be
    // adjacent to the TARGET hex. Placing them next to the attacker hex
    // (the previous behaviour) silently skipped them. We now park atk allies
    // on hexes that are adjacent to BOTH attacker and defender — they
    // contribute their d6 to the attacker's pool.
    const t = createCombatTester();
    t.setAttacker('paladin');
    t.setDefender('witch');
    t.addAlly('attacker', 'survivor');
    const ally = t.layout.atkAllyEntities[0];
    assert.ok(ally);
    assert.equal(ally.ownerId, ATK_SIDE_ID);
    const def = t.layout.defenderEntity;
    assert.equal(hexDistance(def.col, def.row, ally.col, ally.row), 1,
      'attacker ally must be hex-adjacent to DEFENDER for gang-up math');
    // Also still hex-adjacent to the attacker — keeps the visual posse read.
    const atk = t.layout.attackerEntity;
    assert.equal(hexDistance(atk.col, atk.row, ally.col, ally.row), 1,
      'attacker ally sits on a hex shared between the attacker and defender rings');
  });

  test('DEFENDER ally is placed hex-adjacent to the defender (gang-up against the incoming attack)', () => {
    const t = createCombatTester();
    t.setAttacker('paladin');
    t.setDefender('witch');
    t.addAlly('defender', 'minion');
    const ally = t.layout.defAllyEntities[0];
    assert.ok(ally);
    assert.equal(ally.ownerId, DEF_SIDE_ID);
    const def = t.layout.defenderEntity;
    assert.equal(hexDistance(def.col, def.row, ally.col, ally.row), 1);
  });

  test('removeAlly clears the slot and shifts later allies down', () => {
    const t = createCombatTester();
    t.setAttacker('paladin');
    t.addAlly('attacker', 'survivor');
    t.addAlly('attacker', 'soldier');
    assert.equal(t.slots.atkAllies.length, 2);
    t.removeAlly('attacker', 0);
    assert.deepEqual(t.slots.atkAllies, ['soldier']);
  });
});

describe('combat-tester — swap roles', () => {
  test('swap inverts attacker/defender, keeping allies with their units', () => {
    const t = createCombatTester();
    t.setAttacker('paladin');
    t.setDefender('witch');
    t.addAlly('attacker', 'survivor');
    t.addAlly('defender', 'minion');
    t.addAlly('defender', 'zombie');
    t.swapRoles();
    assert.equal(t.slots.attacker, 'witch');
    assert.equal(t.slots.defender, 'paladin');
    // Defender's two allies are now on the attacker side; survivor flipped.
    assert.deepEqual(t.slots.atkAllies, ['minion', 'zombie']);
    assert.deepEqual(t.slots.defAllies, ['survivor']);
    // Layout reflects the swap — witch is now at centre.
    assert.equal(t.layout.attackerEntity.type, 'witch');
    assert.equal(t.layout.attackerEntity.col, 4);
    assert.equal(t.layout.attackerEntity.row, 4);
    assert.equal(t.layout.defenderEntity.type, 'paladin');
    assert.equal(t.layout.defenderEntity.col, 5);
  });
});

describe('combat-tester — runBattle', () => {
  test('returns null when either combatant is missing', () => {
    const t = createCombatTester();
    assert.equal(t.runBattle(), null);
    t.setAttacker('paladin');
    assert.equal(t.runBattle(), null);
  });

  test('delegates to executeBattle with the live attacker and defender', () => {
    const calls = [];
    const battleFn = (state, atk, def) => {
      calls.push({ state, atk, def });
      return { success: true, log: ['stub'], hit: true, damage: 1,
               attackRoll: 6, defenseRoll: 3, breakdown: {} };
    };
    const t = createCombatTester({ battleFn });
    t.setAttacker('paladin');
    t.setDefender('witch');
    const out = t.runBattle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].atk, t.layout.attackerEntity);
    assert.equal(calls[0].def, t.layout.defenderEntity);
    assert.equal(calls[0].state, t.state);
    assert.deepEqual(out.result.log, ['stub']);
    // Snapshots carry the identity the cinematic needs.
    assert.equal(out.attackerSnap.id, t.layout.attackerEntity.id);
    assert.equal(out.defenderSnap.col, 5);
  });

  test('runs the REAL executeBattle end-to-end (paladin vs zombie)', () => {
    // No injected battleFn — exercises src/actions.js executeBattle on the
    // live GameState. The exact outcome depends on dice; we only assert
    // that the call produced a structured result.
    const t = createCombatTester();
    t.setAttacker('paladin');
    t.setDefender('zombie');
    const out = t.runBattle();
    assert.ok(out, 'runBattle returned null');
    assert.equal(typeof out.result.attackRoll, 'number');
    assert.equal(typeof out.result.defenseRoll, 'number');
    assert.ok(Array.isArray(out.result.log));
  });
});

describe('combat-tester — ally placement triggers REAL gang-up code path', () => {
  test('an attacker ally bumps attackerAllies on the executeBattle result', () => {
    // The old layout placed atk allies next to the ATTACKER hex, which is
    // not where gang-up math reads from (executeBattle filters by hexes
    // adjacent to the TARGET). The result: tester allies were visually
    // present but contributed 0 dice. The fix is verified end-to-end here.
    const t = createCombatTester();
    t.setAttacker('paladin');
    t.setDefender('zombie');
    const baseline = t.runBattle();
    assert.equal(baseline.result.attackerAllies, 0,
      'baseline: no allies → attackerAllies=0');
    t.addAlly('attacker', 'survivor');
    const withAlly = t.runBattle();
    assert.equal(withAlly.result.attackerAllies, 1,
      'placing one attacker ally bumps attackerAllies to 1 (the real gang-up code path)');
  });

  test('a defender ally bumps defenderAllies on the executeBattle result', () => {
    const t = createCombatTester();
    t.setAttacker('paladin');
    t.setDefender('zombie');
    t.addAlly('defender', 'minion');
    const out = t.runBattle();
    assert.equal(out.result.defenderAllies, 1);
  });
});

describe('combat-tester — reset', () => {
  test('clears slots and entity list back to a blank stage', () => {
    const t = createCombatTester();
    t.setAttacker('paladin');
    t.setDefender('witch');
    t.addAlly('attacker', 'survivor');
    t.reset();
    assert.equal(t.slots.attacker, null);
    assert.equal(t.slots.defender, null);
    assert.deepEqual(t.slots.atkAllies, []);
    assert.deepEqual(t.slots.defAllies, []);
    assert.equal(t.state.entities.length, 0);
  });
});

describe('combat-tester — onChange notifications', () => {
  test('fires after every mutator', () => {
    const t = createCombatTester();
    let count = 0;
    t.onChange(() => { count++; });
    const before = count;
    t.setAttacker('paladin');
    t.setDefender('witch');
    t.addAlly('attacker', 'survivor');
    t.swapRoles();
    t.reset();
    assert.ok(count - before >= 5, `expected ≥5 onChange fires, got ${count - before}`);
  });
});

describe('combat-tester — UNIT_FACTORIES coverage', () => {
  test('exposes a factory per UNIT_TYPES leader / minion / golem entry', () => {
    const expected = ['paladin', 'rogue', 'captain', 'witch', 'necromancer',
                      'brute', 'survivor', 'soldier', 'zombie', 'minion',
                      'wood_golem', 'iron_golem'];
    for (const key of expected) {
      assert.equal(typeof UNIT_FACTORIES[key], 'function', `missing factory: ${key}`);
    }
  });
});

describe('admin-tools.html — Combat tab wiring', () => {
  test('KNOWN_TOOLS includes "combat"', () => {
    assert.ok(KNOWN_TOOLS.includes('combat'));
  });

  test('admin-tools.html has the Combat tab button and panel', () => {
    assert.ok(existsSync(ADMIN_TOOLS_HTML));
    const html = readFileSync(ADMIN_TOOLS_HTML, 'utf8');
    assert.match(html, /data-tab="combat"/, 'expected the Combat tab button');
    assert.match(html, /id="combat-panel"/, 'expected the Combat panel section');
  });
});
