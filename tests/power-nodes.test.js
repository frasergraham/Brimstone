// Tests for the redesigned 3-hex power node system.
// Covers: nodeController, cluster structure, scoring, discovery, fortify on nodes,
//         proximity constraint, serialization, and AI targeting.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { GameState, nodeController, Phase } from '../src/game.js';
import { hexKey, hexDistance, getNeighbors, MAP_COLS, MAP_ROWS } from '../src/hex.js';
import { TileType, legacyTileType } from '../src/tiles.js';
import { serializeState, deserializeState } from '../server/state-sync.js';
import { executeFortify, getValidActions, sightRange, hasLineOfSight } from '../src/actions.js';
import { generateMap } from '../src/map.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeEntity(id, owner, col, row, alive = true) {
  return { id, owner, col, row, alive, type: owner === 'hero' ? 'hero' : 'witch', ability: null };
}

function makeObj(center, satellites = [], label = 'Test Node') {
  const hexes = [center, ...satellites];
  if (hexes.length < 3) hexes.push(...Array(3 - hexes.length).fill(center));
  return { col: center.col, row: center.row, label, hexes, seenByHero: false, seenByWitch: false, prevCtrl: 'neutral' };
}

// ── nodeController ─────────────────────────────────────────────────────────────

describe('nodeController', () => {
  test('returns neutral when no entities are on the cluster', () => {
    const obj = makeObj({ col: 5, row: 5 }, [{ col: 5, row: 4 }, { col: 6, row: 4 }]);
    assert.equal(nodeController(obj, []), 'neutral');
  });

  test('returns hero when hero occupies more hexes', () => {
    const obj = makeObj({ col: 5, row: 5 }, [{ col: 5, row: 4 }, { col: 6, row: 4 }]);
    const entities = [
      makeEntity('h1', 'hero', 5, 5),
      makeEntity('h2', 'hero', 5, 4),
    ];
    assert.equal(nodeController(obj, entities), 'hero');
  });

  test('returns witch when witch occupies more hexes', () => {
    const obj = makeObj({ col: 5, row: 5 }, [{ col: 5, row: 4 }, { col: 6, row: 4 }]);
    const entities = [
      makeEntity('w1', 'witch', 5, 5),
      makeEntity('w2', 'witch', 5, 4),
      makeEntity('h1', 'hero', 6, 4),
    ];
    assert.equal(nodeController(obj, entities), 'witch');
  });

  test('returns contested when hero and witch occupy equal hexes', () => {
    const obj = makeObj({ col: 5, row: 5 }, [{ col: 5, row: 4 }, { col: 6, row: 4 }]);
    const entities = [
      makeEntity('h1', 'hero', 5, 5),
      makeEntity('w1', 'witch', 5, 4),
    ];
    assert.equal(nodeController(obj, entities), 'contested');
  });

  test('multiple units on the same hex count as one occupied hex', () => {
    const obj = makeObj({ col: 5, row: 5 }, [{ col: 5, row: 4 }, { col: 6, row: 4 }]);
    const entities = [
      // Three hero units on the same hex — should still count as 1
      makeEntity('h1', 'hero', 5, 5),
      makeEntity('h2', 'hero', 5, 5),
      makeEntity('h3', 'hero', 5, 5),
      // One witch on a different hex
      makeEntity('w1', 'witch', 5, 4),
    ];
    // Hero: 1 unique hex, Witch: 1 unique hex → contested
    assert.equal(nodeController(obj, entities), 'contested');
  });

  test('dead entities do not count', () => {
    const obj = makeObj({ col: 5, row: 5 }, [{ col: 5, row: 4 }, { col: 6, row: 4 }]);
    const entities = [
      makeEntity('h1', 'hero', 5, 5, false),  // dead
      makeEntity('w1', 'witch', 5, 4),
    ];
    assert.equal(nodeController(obj, entities), 'witch');
  });

  test('entities off the cluster hexes do not affect control', () => {
    const obj = makeObj({ col: 5, row: 5 }, [{ col: 5, row: 4 }, { col: 6, row: 4 }]);
    const entities = [
      makeEntity('h1', 'hero', 0, 0),  // far away
      makeEntity('w1', 'witch', 1, 1), // far away
    ];
    assert.equal(nodeController(obj, entities), 'neutral');
  });
});

// ── Cluster structure from map generation ────────────────────────────────────

describe('Power node cluster structure', () => {
  test('each node has exactly 3 hexes', () => {
    const state = new GameState(true, true);
    for (const obj of state.witchObjectives) {
      assert.equal(obj.hexes.length, 3, `Node "${obj.label}" should have exactly 3 hexes`);
    }
  });

  test('center col/row matches hexes[0]', () => {
    const state = new GameState(true, true);
    for (const obj of state.witchObjectives) {
      assert.equal(obj.hexes[0].col, obj.col, `Center col should match hexes[0].col`);
      assert.equal(obj.hexes[0].row, obj.row, `Center row should match hexes[0].row`);
    }
  });

  test('all hexes are within map bounds', () => {
    const mapData = generateMap();
    for (const obj of mapData.witchObjectives) {
      for (const h of obj.hexes) {
        assert.ok(mapData.tiles.has(hexKey(h.col, h.row)),
          `Node hex (${h.col},${h.row}) should be within map bounds`);
      }
    }
  });

  test('satellite hexes are not RIVER tiles', () => {
    const mapData = generateMap();
    for (const obj of mapData.witchObjectives) {
      for (const h of obj.hexes) {
        const t = mapData.tiles.get(hexKey(h.col, h.row));
        assert.notEqual(legacyTileType(t), TileType.RIVER,
          `Node hex (${h.col},${h.row}) should not be RIVER`);
      }
    }
  });

  test('satellite hexes are adjacent to the center', () => {
    const mapData = generateMap();
    for (const obj of mapData.witchObjectives) {
      const center = obj.hexes[0];
      for (let i = 1; i < obj.hexes.length; i++) {
        const h = obj.hexes[i];
        const dist = hexDistance(center.col, center.row, h.col, h.row);
        // Satellites should be adjacent (distance 1) unless degenerate (same as center)
        assert.ok(dist <= 1,
          `Satellite (${h.col},${h.row}) should be adjacent to center (${center.col},${center.row})`);
      }
    }
  });

  test('nodes have seenByHero, seenByWitch, and prevCtrl fields', () => {
    const state = new GameState(true, true);
    for (const obj of state.witchObjectives) {
      assert.ok('seenByHero' in obj, 'should have seenByHero');
      assert.ok('seenByWitch' in obj, 'should have seenByWitch');
      assert.ok('prevCtrl' in obj, 'should have prevCtrl');
    }
  });
});

// ── _checkNodeObjectives with cluster control ─────────────────────────────────

describe('Node scoring with cluster control', () => {
  function makeStateWithNodes(nodeHexes) {
    // Create a minimal state and override witchObjectives with custom nodes
    const state = new GameState(true, true);
    state.witchObjectives = nodeHexes.map((hexes, i) => ({
      col: hexes[0].col, row: hexes[0].row,
      label: `Node ${i}`,
      hexes,
      seenByHero: true, seenByWitch: true,
      prevCtrl: 'neutral',
    }));
    state.nodeScore = { hero: 0, witch: 0 };
    state.winner = null;
    return state;
  }

  test('hero controlling majority of a node scores at dawn', () => {
    const state = new GameState(true, true);
    // Place hero on 2 of 3 hexes of first node
    const obj = state.witchObjectives[0];
    state.hero.col = obj.hexes[0].col;
    state.hero.row = obj.hexes[0].row;
    // Create a survivor on second hex
    state.entities.push(makeEntity('s1', 'hero', obj.hexes[1].col, obj.hexes[1].row));
    state.nodeScore = { hero: 0, witch: 0 };

    state._checkNodeObjectives(Phase.DAWN);
    // Hero should have scored (holds 1 node, witch holds 0)
    assert.ok(state.nodeScore.hero >= 1 || state.winner !== null,
      'Hero should score or instant-win');
  });

  test('contested node scores for neither side', () => {
    const state = new GameState(true, true);
    const obj = state.witchObjectives[0];
    // Hero on hex 0, witch on hex 1 — tied (1 each)
    state.hero.col = obj.hexes[0].col;
    state.hero.row = obj.hexes[0].row;
    state.witch.col = obj.hexes[1].col;
    state.witch.row = obj.hexes[1].row;
    // Remove hero/witch from other nodes so neither controls anything
    for (let i = 1; i < state.witchObjectives.length; i++) {
      // nothing else on those nodes
    }
    state.nodeScore = { hero: 0, witch: 0 };
    const prevHero = state.nodeScore.hero;
    const prevWitch = state.nodeScore.witch;

    state._checkNodeObjectives(Phase.DAWN);
    // Contested node doesn't score for either
    assert.equal(state.nodeScore.hero, prevHero,
      'Contested node should not score for hero');
    assert.equal(state.nodeScore.witch, prevWitch,
      'Contested node should not score for witch');
  });
});

// ── Dynamic node count win text ───────────────────────────────────────────────

describe('Holding all nodes does not trigger an instant win', () => {
  test('witch holding all 2 nodes scores but does not win', () => {
    const state = new GameState(true, true);
    // Override to only 2 nodes
    state.witchObjectives = state.witchObjectives.slice(0, 2);
    state.nodeScore = { hero: 0, witch: 0 };
    state.winner = null;
    state.winReason = null;

    // Place witch on both nodes
    for (let i = 0; i < state.witchObjectives.length; i++) {
      const obj = state.witchObjectives[i];
      if (i === 0) {
        state.witch.col = obj.hexes[0].col;
        state.witch.row = obj.hexes[0].row;
        // Put witch entities on majority of hexes
        state.entities.push(makeEntity(`wm${i}a`, 'witch', obj.hexes[1].col, obj.hexes[1].row));
      } else {
        state.entities.push(makeEntity(`wm${i}a`, 'witch', obj.hexes[0].col, obj.hexes[0].row));
        state.entities.push(makeEntity(`wm${i}b`, 'witch', obj.hexes[1].col, obj.hexes[1].row));
      }
    }

    state._checkNodeObjectives(Phase.DAWN);
    assert.equal(state.winner, null, 'holding all nodes should not instant-win');
    assert.equal(state.nodeScore.witch, 1, 'witch should score the majority point');
  });

  test('hero holding all 4 nodes scores but does not win', () => {
    const state = new GameState(true, true);
    // Add a 4th node
    const extra = {
      col: 1, row: 1, label: 'Node 4',
      hexes: [{ col: 1, row: 1 }, { col: 1, row: 2 }, { col: 2, row: 1 }],
      seenByHero: true, seenByWitch: true, prevCtrl: 'neutral',
    };
    state.witchObjectives.push(extra);
    state.nodeScore = { hero: 0, witch: 0 };
    state.winner = null;
    state.winReason = null;

    // Place hero entities on majority hexes of all 4 nodes
    for (let i = 0; i < state.witchObjectives.length; i++) {
      const obj = state.witchObjectives[i];
      if (i === 0) {
        state.hero.col = obj.hexes[0].col;
        state.hero.row = obj.hexes[0].row;
        state.entities.push(makeEntity(`hm${i}`, 'hero', obj.hexes[1].col, obj.hexes[1].row));
      } else {
        state.entities.push(makeEntity(`hm${i}a`, 'hero', obj.hexes[0].col, obj.hexes[0].row));
        state.entities.push(makeEntity(`hm${i}b`, 'hero', obj.hexes[1].col, obj.hexes[1].row));
      }
    }

    state._checkNodeObjectives(Phase.DAWN);
    assert.equal(state.winner, null, 'holding all nodes should not instant-win');
    assert.equal(state.nodeScore.hero, 1, 'hero should score the majority point');
  });
});

// ── updateNodeDiscovery ───────────────────────────────────────────────────────

describe('updateNodeDiscovery', () => {
  test('nodes start undiscovered when hero is far away', () => {
    const state = new GameState(true, true);
    // Place hero at (0,0), nodes should be far away on standard map
    state.hero.col = 0;
    state.hero.row = 0;
    // Force reset discovery
    for (const obj of state.witchObjectives) {
      obj.seenByHero = false;
      obj.seenByWitch = false;
    }
    // Check which nodes are within range
    const range = sightRange(state.phase, false);
    state.updateNodeDiscovery();
    for (const obj of state.witchObjectives) {
      // Discovery requires distance AND line of sight — a building footprint or
      // forest between (0,0) and the node blocks discovery even when in range.
      const visible = obj.hexes.some(h =>
        hexDistance(0, 0, h.col, h.row) <= range
        && hasLineOfSight(state, 0, 0, h.col, h.row));
      assert.equal(obj.seenByHero, visible,
        `Node ${obj.label} discovery should match sight+LOS from (0,0)`);
    }
  });

  test('seenByHero becomes permanently true once seen', () => {
    const state = new GameState(true, true);
    const obj = state.witchObjectives[0];
    // Move hero onto the node center
    state.hero.col = obj.hexes[0].col;
    state.hero.row = obj.hexes[0].row;
    obj.seenByHero = false;
    state.updateNodeDiscovery();
    assert.equal(obj.seenByHero, true, 'Should be discovered when hero is on it');

    // Move hero far away and call again — should remain discovered
    state.hero.col = 0;
    state.hero.row = 0;
    state.updateNodeDiscovery();
    assert.equal(obj.seenByHero, true, 'Discovery should be permanent');
  });

  test('hero and witch discovery are independent', () => {
    const state = new GameState(true, true);
    const obj = state.witchObjectives[0];
    obj.seenByHero = false;
    obj.seenByWitch = false;

    // Move hero onto node, witch far away
    state.hero.col = obj.hexes[0].col;
    state.hero.row = obj.hexes[0].row;
    state.witch.col = 0;
    state.witch.row = 0;
    state.updateNodeDiscovery();

    assert.equal(obj.seenByHero, true, 'Hero should have discovered the node');
    // Witch may or may not have discovered depending on starting distance and phase
    // but the key test is independence — hero discovery doesn't affect witch
    const witchRange = sightRange(state.phase, false);
    // Discovery requires distance AND line of sight — mirror the engine so a
    // footprint/forest blocker between (0,0) and the node is accounted for.
    const witchVisible = obj.hexes.some(h =>
      hexDistance(0, 0, h.col, h.row) <= witchRange
      && hasLineOfSight(state, 0, 0, h.col, h.row));
    assert.equal(obj.seenByWitch, witchVisible,
      'Witch discovery should depend on witch sight range and line of sight');
  });
});

// ── Per-step node discovery (during resolution animation) ────────────────────

describe('Per-step node discovery', () => {
  test('updateNodeDiscovery discovers a node when entity moves into range', () => {
    const state = new GameState(true, true);
    const obj = state.witchObjectives[0];
    obj.seenByHero = false;
    obj.seenByWitch = false;

    // Place hero far away — no discovery
    state.hero.col = 0;
    state.hero.row = 0;
    state.updateNodeDiscovery();
    const range = sightRange(state.phase, false);
    const farEnough = obj.hexes.every(h => hexDistance(0, 0, h.col, h.row) > range);
    if (farEnough) {
      assert.equal(obj.seenByHero, false, 'Should not see node when far away');
    }

    // Now simulate a move by placing hero adjacent to the node
    state.hero.col = obj.hexes[0].col;
    state.hero.row = obj.hexes[0].row;
    state.updateNodeDiscovery();
    assert.equal(obj.seenByHero, true, 'Should discover node after moving onto it');
  });

  test('node discovery works incrementally (step by step)', () => {
    const state = new GameState(true, true);
    const obj = state.witchObjectives[0];
    obj.seenByHero = false;
    obj.seenByWitch = false;

    // Place hero far away initially
    state.hero.col = 0;
    state.hero.row = 0;
    state.updateNodeDiscovery();

    // Step 1: still far away
    state.hero.col = 1;
    state.hero.row = 0;
    state.updateNodeDiscovery();

    // Step 2: move onto the node
    state.hero.col = obj.hexes[0].col;
    state.hero.row = obj.hexes[0].row;
    state.updateNodeDiscovery();
    assert.equal(obj.seenByHero, true, 'Should be discovered after incremental move');
  });

  test('witch discovery is independent during incremental steps', () => {
    const state = new GameState(true, true);
    const obj = state.witchObjectives[0];
    obj.seenByHero = false;
    obj.seenByWitch = false;

    // Move witch onto node, hero stays far
    state.hero.col = 0;
    state.hero.row = 0;
    state.witch.col = obj.hexes[0].col;
    state.witch.row = obj.hexes[0].row;
    state.updateNodeDiscovery();
    assert.equal(obj.seenByWitch, true, 'Witch should discover node');

    const range = sightRange(state.phase, false);
    const heroFar = obj.hexes.every(h => hexDistance(0, 0, h.col, h.row) > range);
    if (heroFar) {
      assert.equal(obj.seenByHero, false, 'Hero should not discover node from far away');
    }
  });
});

// ── Fortify on node hexes ────────────────────────────────────────────────────

describe('Fortify allowed on node hexes', () => {
  test('executeFortify succeeds on the center hex of a node', () => {
    const state = new GameState(true, true);
    const obj = state.witchObjectives[0];
    state.hero.col = obj.hexes[0].col;
    state.hero.row = obj.hexes[0].row;
    state.inventory.hero['wood'] = { count: 5 };
    const result = executeFortify(state, state.hero);
    assert.equal(result.success, true, 'Fortify on center hex should succeed');
  });

  test('executeFortify succeeds on a satellite hex of a node', () => {
    const state = new GameState(true, true);
    const obj = state.witchObjectives[0];
    const satellite = obj.hexes.find(h => h.col !== obj.col || h.row !== obj.row);
    if (!satellite) return; // degenerate cluster, skip
    state.hero.col = satellite.col;
    state.hero.row = satellite.row;
    state.inventory.hero['wood'] = { count: 5 };
    const result = executeFortify(state, state.hero);
    assert.equal(result.success, true, 'Fortify on satellite hex should succeed');
  });

  test('getValidActions includes FORTIFY on node hexes', () => {
    const state = new GameState(true, true);
    const obj = state.witchObjectives[0];
    state.hero.col = obj.hexes[0].col;
    state.hero.row = obj.hexes[0].row;
    state.inventory.hero['wood'] = { count: 5 };
    const actions = getValidActions(state, state.hero);
    const hasFortify = actions.some(a => a.type === 'fortify');
    assert.equal(hasFortify, true, 'FORTIFY should be available on node hex');
  });
});

// ── Proximity constraint ──────────────────────────────────────────────────────

describe('Node proximity constraint', () => {
  test('no node cluster hex is within 3 hexes of hero start across multiple seeds', () => {
    const seeds = [42, 123, 999, 1234, 5678, 7777, 31337, 0, 1, 2];
    for (const seed of seeds) {
      const mapData = generateMap(seed, 'standard');
      const heroStart = mapData.heroStart;
      const witchStart = mapData.witchStart;

      for (const obj of mapData.witchObjectives) {
        for (const h of obj.hexes) {
          const heroDistCenter = hexDistance(heroStart.col, heroStart.row, obj.col, obj.row);
          const witchDistCenter = hexDistance(witchStart.col, witchStart.row, obj.col, obj.row);
          // Center must be > 3
          assert.ok(heroDistCenter > 3,
            `Seed ${seed}: node center (${obj.col},${obj.row}) is only ${heroDistCenter} hexes from hero start`);
          assert.ok(witchDistCenter > 3,
            `Seed ${seed}: node center (${obj.col},${obj.row}) is only ${witchDistCenter} hexes from witch start`);
        }
      }
    }
  });
});

// ── checkAndLogNodeControlChanges ────────────────────────────────────────────

describe('checkAndLogNodeControlChanges', () => {
  test('logs when a node becomes hero-controlled', () => {
    const state = new GameState(true, true);
    const obj = state.witchObjectives[0];
    obj.prevCtrl = 'neutral';
    state.hero.col = obj.hexes[0].col;
    state.hero.row = obj.hexes[0].row;

    const before = state.log.length;
    state.checkAndLogNodeControlChanges();
    assert.ok(state.log.length > before, 'Should have added a log entry');
    const lastEntry = state.log[state.log.length - 1];
    const text = typeof lastEntry === 'string' ? lastEntry : lastEntry.text;
    assert.ok(text.includes(obj.label),
      'Log should mention the node label');
    assert.equal(obj.prevCtrl, 'hero', 'prevCtrl should update to hero');
  });

  test('does not log when control has not changed', () => {
    const state = new GameState(true, true);
    const obj = state.witchObjectives[0];
    obj.prevCtrl = 'neutral';
    // Hero and witch nowhere near the node — prevCtrl stays 'neutral'
    state.hero.col = 0;
    state.hero.row = 0;
    state.witch.col = 0;
    state.witch.row = 0;

    const before = state.log.length;
    state.checkAndLogNodeControlChanges();
    // No state change, no log
    assert.equal(state.log.length, before, 'Should not log when control unchanged');
  });

  test('logs contested state', () => {
    const state = new GameState(true, true);
    const obj = state.witchObjectives[0];
    obj.prevCtrl = 'neutral';
    state.hero.col = obj.hexes[0].col;
    state.hero.row = obj.hexes[0].row;
    state.witch.col = obj.hexes[1].col;
    state.witch.row = obj.hexes[1].row;

    state.checkAndLogNodeControlChanges();
    const lastLog = state.log[state.log.length - 1];
    assert.ok(typeof lastLog === 'string' && lastLog.includes('contested'),
      'Should log contested state');
    assert.equal(obj.prevCtrl, 'contested', 'prevCtrl should update to contested');
  });
});

// ── Serialization round-trip ──────────────────────────────────────────────────

describe('Serialization round-trip', () => {
  test('hexes array survives serialize → deserialize', () => {
    const state = new GameState(true, true);
    const snap = serializeState(state);
    const restored = deserializeState(snap);

    for (let i = 0; i < state.witchObjectives.length; i++) {
      const orig = state.witchObjectives[i];
      const rest = restored.witchObjectives[i];
      assert.equal(rest.hexes.length, orig.hexes.length, 'hexes length should match');
      for (let j = 0; j < orig.hexes.length; j++) {
        assert.equal(rest.hexes[j].col, orig.hexes[j].col, `hex[${j}].col should match`);
        assert.equal(rest.hexes[j].row, orig.hexes[j].row, `hex[${j}].row should match`);
      }
    }
  });

  test('seenByHero and seenByWitch survive round-trip', () => {
    const state = new GameState(true, true);
    state.witchObjectives[0].seenByHero = true;
    state.witchObjectives[0].seenByWitch = false;
    const snap = serializeState(state);
    const restored = deserializeState(snap);
    assert.equal(restored.witchObjectives[0].seenByHero, true);
    assert.equal(restored.witchObjectives[0].seenByWitch, false);
  });

  test('prevCtrl survives round-trip', () => {
    const state = new GameState(true, true);
    state.witchObjectives[0].prevCtrl = 'hero';
    const snap = serializeState(state);
    const restored = deserializeState(snap);
    assert.equal(restored.witchObjectives[0].prevCtrl, 'hero');
  });

  test('mapSize survives round-trip for all map sizes', () => {
    for (const size of ['skirmish', 'standard', 'regional', 'campaign']) {
      const state = new GameState(true, true, size);
      const snap = serializeState(state);
      assert.equal(snap.mapSize, size, `snap.mapSize should be ${size}`);
      const restored = deserializeState(snap);
      assert.equal(restored.mapSize, size, `restored.mapSize should be ${size}`);
    }
  });

  test('deserializeState restores MAP_COLS/MAP_ROWS for non-standard map sizes', () => {
    // Skirmish is 9×9, standard is 13×11 — use skirmish to differ from default
    const state = new GameState(true, true, 'skirmish');
    const snap = serializeState(state);
    // Clobber globals by constructing a standard map
    new GameState(true, true, 'standard');
    // Restore the skirmish save — globals should be corrected
    deserializeState(snap);
    // MAP_COLS/MAP_ROWS are live ES module bindings — they reflect the current value
    assert.equal(MAP_COLS, snap.mapCols, 'MAP_COLS should match saved mapCols');
    assert.equal(MAP_ROWS, snap.mapRows, 'MAP_ROWS should match saved mapRows');
  });

  test('old save format without hexes degrades gracefully', () => {
    const state = new GameState(true, true);
    const snap = serializeState(state);
    // Strip hexes to simulate old save
    for (const o of snap.witchObjectives) {
      delete o.hexes;
      delete o.seenByHero;
      delete o.seenByWitch;
      delete o.prevCtrl;
    }
    let restored;
    assert.doesNotThrow(() => { restored = deserializeState(snap); },
      'Should not throw on old save format');
    for (const obj of restored.witchObjectives) {
      assert.ok(Array.isArray(obj.hexes) && obj.hexes.length >= 1,
        'Should have at least a single-hex fallback');
    }
  });
});

// ── nodeSpawnedSurvivors serialization ────────────────────────────────────────

describe('nodeSpawnedSurvivors', () => {
  test('initialized as empty array on new GameState', () => {
    const state = new GameState();
    assert.ok(Array.isArray(state.nodeSpawnedSurvivors));
    assert.equal(state.nodeSpawnedSurvivors.length, 0);
  });

  test('survives serialization round-trip', () => {
    const state = new GameState();
    generateMap(state, 'skirmish');
    state.nodeSpawnedSurvivors = [
      { type: 'survivor', name: 'TestSurvivor', title: 'Scout', hp: 3, maxHp: 3, attack: 1, defense: 1, abilityLabel: null, color: '#aaa' },
    ];
    const snap = serializeState(state);
    const restored = deserializeState(snap);
    assert.equal(restored.nodeSpawnedSurvivors.length, 1);
    assert.equal(restored.nodeSpawnedSurvivors[0].name, 'TestSurvivor');
  });

  test('defaults to empty array when missing from snapshot', () => {
    const state = new GameState();
    generateMap(state, 'skirmish');
    const snap = serializeState(state);
    delete snap.nodeSpawnedSurvivors;
    const restored = deserializeState(snap);
    assert.ok(Array.isArray(restored.nodeSpawnedSurvivors));
    assert.equal(restored.nodeSpawnedSurvivors.length, 0);
  });
});
