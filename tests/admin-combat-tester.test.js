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
  ATK_SIDE_ID, DEF_SIDE_ID, UNIT_FACTORIES, MAX_ALLIES_PER_SIDE, SPEED_MODES,
} from '../src/tools/combat-tester.js';
import { ADVANTAGE_CAP } from '../src/entities.js';
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

describe('combat-tester — ally cap', () => {
  test('MAX_ALLIES_PER_SIDE is ADVANTAGE_CAP+1 so the cap is visually demonstrable', () => {
    // The tester intentionally allows one MORE ally than the game's gang-up
    // cap so the operator can place a 4th ally and verify the cap is
    // enforced (4 standees on screen, but only 3 contribute to the dice).
    assert.equal(MAX_ALLIES_PER_SIDE, ADVANTAGE_CAP + 1);
    assert.equal(MAX_ALLIES_PER_SIDE, 4);
  });

  test('addAlly refuses to push beyond MAX_ALLIES_PER_SIDE on each side', () => {
    const t = createCombatTester();
    t.setAttacker('paladin');
    t.setDefender('witch');
    for (let i = 0; i < MAX_ALLIES_PER_SIDE; i++) {
      assert.equal(t.addAlly('attacker', 'survivor'), true,
        `ally ${i + 1} should be accepted`);
      assert.equal(t.addAlly('defender', 'minion'), true,
        `ally ${i + 1} should be accepted`);
    }
    assert.equal(t.slots.atkAllies.length, MAX_ALLIES_PER_SIDE);
    assert.equal(t.slots.defAllies.length, MAX_ALLIES_PER_SIDE);
    // The (MAX+1)-th add must be rejected and leave the list unchanged.
    assert.equal(t.addAlly('attacker', 'survivor'), false);
    assert.equal(t.addAlly('defender', 'minion'), false);
    assert.equal(t.slots.atkAllies.length, MAX_ALLIES_PER_SIDE);
    assert.equal(t.slots.defAllies.length, MAX_ALLIES_PER_SIDE);
  });

  test('removeAlly re-opens a slot so a subsequent addAlly succeeds', () => {
    const t = createCombatTester();
    t.setAttacker('paladin');
    t.setDefender('witch');
    for (let i = 0; i < MAX_ALLIES_PER_SIDE; i++) t.addAlly('attacker', 'survivor');
    assert.equal(t.addAlly('attacker', 'soldier'), false, 'cap reached');
    t.removeAlly('attacker', 0);
    assert.equal(t.addAlly('attacker', 'soldier'), true,
      'slot re-opened by removeAlly');
    assert.equal(t.slots.atkAllies.length, MAX_ALLIES_PER_SIDE);
  });
});

describe('combat-tester — no stacked entities (defensive invariant)', () => {
  test('every placed entity sits on a unique (col,row), even with 4+4 allies', () => {
    // The pool of defender-adjacent slots is ~5 hexes on the clearing — short
    // of the 4+4=8 the caps allow — so some allies will silently fail to
    // place (takeNext returns null and the loop breaks). The invariant we
    // care about is that NOTHING that DOES get placed shares a hex.
    const t = createCombatTester();
    t.setAttacker('paladin');
    t.setDefender('witch');
    for (let i = 0; i < MAX_ALLIES_PER_SIDE; i++) {
      t.addAlly('attacker', 'survivor');
      t.addAlly('defender', 'minion');
    }
    const seen = new Set();
    for (const e of t.state.entities) {
      const key = hexKey(e.col, e.row);
      assert.ok(!seen.has(key),
        `duplicate hex ${key} — two entities are stacked on the same tile`);
      seen.add(key);
    }
    assert.equal(seen.size, t.state.entities.length);
  });
});

describe('combat-tester — randomizeAllies', () => {
  test('returns false (no-op) when no allies are placed', () => {
    const t = createCombatTester();
    t.setAttacker('paladin');
    t.setDefender('witch');
    assert.equal(t.randomizeAllies(), false);
  });

  test('returns true and reshuffles positions when allies are placed', () => {
    const t = createCombatTester();
    t.setAttacker('paladin');
    t.setDefender('witch');
    t.addAlly('attacker', 'survivor');
    t.addAlly('attacker', 'soldier');
    t.addAlly('defender', 'minion');
    // Capture baseline positions.
    const before = t.state.entities.map(e => `${e.type}@${e.col},${e.row}`);
    // Force a deterministic non-identity permutation so the test never flakes
    // on the (tiny) chance that Math.random produced the identity shuffle.
    // Sequence reversed: each step picks index 0, which Fisher-Yates uses to
    // swap the tail with element 0 — reverses the pool order.
    let reverseCalls = 0;
    t.randomizeAllies(() => {
      // Returning 0 makes (i+1)*rng() === 0 → j=0 → swap shuffled[i] with [0].
      // For a 5-element pool this produces [4,1,2,3,0] etc. — guaranteed
      // distinct from the side-natural pool order.
      reverseCalls++;
      return 0;
    });
    assert.ok(reverseCalls > 0, 'rng should have been called');
    const after = t.state.entities.map(e => `${e.type}@${e.col},${e.row}`);
    assert.notDeepEqual(after, before,
      'positions should change after randomizeAllies with a non-identity rng');
  });

  test('after randomize, every entity still sits on a unique hex', () => {
    const t = createCombatTester();
    t.setAttacker('paladin');
    t.setDefender('witch');
    for (let i = 0; i < MAX_ALLIES_PER_SIDE; i++) {
      t.addAlly('attacker', 'survivor');
      t.addAlly('defender', 'minion');
    }
    t.randomizeAllies();
    const seen = new Set();
    for (const e of t.state.entities) {
      const key = hexKey(e.col, e.row);
      assert.ok(!seen.has(key),
        `duplicate hex ${key} after randomize — entities are stacked`);
      seen.add(key);
    }
  });

  test('does not change WHICH units are allies — only their hex positions', () => {
    const t = createCombatTester();
    t.setAttacker('paladin');
    t.setDefender('witch');
    t.addAlly('attacker', 'survivor');
    t.addAlly('attacker', 'soldier');
    t.addAlly('defender', 'minion');
    const atkBefore = t.slots.atkAllies.slice();
    const defBefore = t.slots.defAllies.slice();
    t.randomizeAllies();
    assert.deepEqual(t.slots.atkAllies, atkBefore);
    assert.deepEqual(t.slots.defAllies, defBefore);
  });

  test('all randomized allies sit hex-adjacent to the defender (gang-up legal)', () => {
    const t = createCombatTester();
    t.setAttacker('paladin');
    t.setDefender('witch');
    t.addAlly('attacker', 'survivor');
    t.addAlly('defender', 'minion');
    t.addAlly('defender', 'zombie');
    t.randomizeAllies();
    const def = t.layout.defenderEntity;
    const allies = [...t.layout.atkAllyEntities, ...t.layout.defAllyEntities];
    for (const a of allies) {
      assert.equal(hexDistance(def.col, def.row, a.col, a.row), 1,
        `ally at (${a.col},${a.row}) must be adjacent to defender for gang-up`);
    }
  });

  test('adding an ally after randomize clears the override (new ally takes default slot)', () => {
    // Sticky override would leave the new ally without a position; clearing
    // on mutate falls back to default pool placement.
    const t = createCombatTester();
    t.setAttacker('paladin');
    t.setDefender('witch');
    t.addAlly('attacker', 'survivor');
    t.randomizeAllies();
    assert.equal(t.slots.atkAllyPositions.length, 1, 'override persisted');
    t.addAlly('attacker', 'soldier');
    assert.equal(t.slots.atkAllyPositions.length, 0,
      'addAlly should clear position overrides so default placement kicks in');
    // Both allies still placed without stacking.
    const allies = t.layout.atkAllyEntities;
    assert.equal(allies.length, 2);
    assert.notEqual(hexKey(allies[0].col, allies[0].row),
                    hexKey(allies[1].col, allies[1].row));
  });

  test('randomized ally count never exceeds available slot pool', () => {
    // The legal pool is ~5 hexes; the test asserts we can't place more
    // allies than slots and don't crash.
    const t = createCombatTester();
    t.setAttacker('paladin');
    t.setDefender('witch');
    for (let i = 0; i < MAX_ALLIES_PER_SIDE; i++) {
      t.addAlly('attacker', 'survivor');
      t.addAlly('defender', 'minion');
    }
    t.randomizeAllies();
    const placed = t.layout.atkAllyEntities.length + t.layout.defAllyEntities.length;
    assert.ok(placed >= 1 && placed <= 8);
    // Every placed ally is unique and adjacent to defender.
    const def = t.layout.defenderEntity;
    const positions = new Set();
    for (const a of [...t.layout.atkAllyEntities, ...t.layout.defAllyEntities]) {
      const k = hexKey(a.col, a.row);
      assert.ok(!positions.has(k));
      positions.add(k);
      assert.equal(hexDistance(def.col, def.row, a.col, a.row), 1);
    }
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

describe('combat-tester — speed mode', () => {
  test('SPEED_MODES lists exactly cinematic, fast, vfast in that order', () => {
    assert.deepEqual([...SPEED_MODES], ['cinematic', 'fast', 'vfast']);
  });

  test('default is cinematic', () => {
    const t = createCombatTester();
    assert.equal(t.speedMode, 'cinematic');
  });

  test('setSpeedMode flips the mode and notifies listeners', () => {
    const t = createCombatTester();
    let fires = 0;
    t.onChange(() => { fires++; });
    const baseline = fires;
    t.setSpeedMode('fast');
    assert.equal(t.speedMode, 'fast');
    assert.ok(fires > baseline, 'setSpeedMode should fire onChange');
    t.setSpeedMode('vfast');
    assert.equal(t.speedMode, 'vfast');
  });

  test('setSpeedMode rejects unknown modes (falls back to cinematic)', () => {
    const t = createCombatTester();
    t.setSpeedMode('ludicrous');
    assert.equal(t.speedMode, 'cinematic');
    t.setSpeedMode(null);
    assert.equal(t.speedMode, 'cinematic');
    t.setSpeedMode(undefined);
    assert.equal(t.speedMode, 'cinematic');
  });

  test('setSpeedMode with the same value is a no-op (no onChange)', () => {
    const t = createCombatTester();
    t.setSpeedMode('fast');
    let fires = 0;
    t.onChange(() => { fires++; });
    t.setSpeedMode('fast');
    assert.equal(fires, 0, 'idempotent set should not fire onChange');
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

// ─── Tester despawn protection — pass entityId to addHpChangeFlash ────────
//
// The renderer's `addHpChangeFlash` accepts `{ entityId }` which activates
// the protectEntityId path: the matching standee is flagged
// `_pendingDespawn=true` for the floater's lifetime, the next
// _syncEntityStandees pass skips its dispose, and the floater's completion
// callback disposes the standee once the "-N" finishes. Without entityId,
// the dying standee vanishes mid-rise and the floater orphans in air.
//
// Source-level pin: the tester's _playBattleResultAnims MUST pass entityId
// for both the damage and counter-damage floaters.

describe('combat-tester — damage floater protects the dying standee', () => {
  const TESTER_UI_SRC = readFileSync(
    resolve(__dirname, '..', 'src', 'tools', 'combat-tester-ui.js'), 'utf8',
  );

  test('addHpChangeFlash(target) is called with { entityId: targetSnap.id }', () => {
    // The damage floater for the defender must protect the defender's standee
    // so it survives until the "-N" finishes rising/fading.
    assert.match(
      TESTER_UI_SRC,
      /addHpChangeFlash\(\s*targetSnap\.col,\s*targetSnap\.row,\s*-\(result\.damage\),\s*\{\s*entityId:\s*targetSnap\.id\s*\}\s*\)/,
      'damage floater on the defender must pass { entityId: targetSnap.id }',
    );
  });

  test('addHpChangeFlash(actor) for counter-damage is called with { entityId: actorSnap.id }', () => {
    // Counter-damage floaters live above the attacker — if the attacker
    // died to a counter, its standee must also stay through the floater.
    assert.match(
      TESTER_UI_SRC,
      /addHpChangeFlash\(\s*actorSnap\.col,\s*actorSnap\.row,\s*-\(result\.counterDmg\),\s*\{\s*entityId:\s*actorSnap\.id\s*\}\s*\)/,
      'counter-damage floater on the attacker must pass { entityId: actorSnap.id }',
    );
  });
});

// ─── Run Battle branches on speed ─────────────────────────────────────────
//
// The UI's runBattle() picks playFastCombatDisplay for fast / vfast and
// run3DCombatCardHold for cinematic. Both paths share the live game's
// extracted helpers — pin the imports and the branch shape at the source
// level so a refactor that loses either path is caught here.

describe('combat-tester-ui — runBattle branches on tester.speedMode', () => {
  const TESTER_UI_SRC = readFileSync(
    resolve(__dirname, '..', 'src', 'tools', 'combat-tester-ui.js'), 'utf8',
  );

  test('imports the shared fast helper from src/combat-fast.js', () => {
    assert.match(
      TESTER_UI_SRC,
      /import\s*\{\s*playFastCombatDisplay\s*\}\s*from\s*['"]\.\.\/combat-fast\.js['"]/,
      'fast helper must come from the shared module the live game uses',
    );
  });

  test('imports BLOCK_WORD_VARIANTS so the tester picks the same miss word set', () => {
    assert.match(
      TESTER_UI_SRC,
      /BLOCK_WORD_VARIANTS/,
      'tester needs the shared miss-word list to match the live game',
    );
  });

  test('branches on speedMode === fast | vfast vs cinematic', () => {
    // Single-pin regex: the runBattle function reads tester.speedMode and
    // branches into the fast helper for fast/vfast and the cinematic
    // helper otherwise. A refactor that loses either branch breaks here.
    assert.match(TESTER_UI_SRC, /tester\.speedMode/);
    assert.match(TESTER_UI_SRC, /speed\s*===\s*['"]fast['"]\s*\|\|\s*speed\s*===\s*['"]vfast['"]/);
    assert.match(TESTER_UI_SRC, /playFastCombatDisplay\s*\(/);
    assert.match(TESTER_UI_SRC, /run3DCombatCardHold\s*\(/);
  });
});
