// Tests for map-size-scaled Power Node count selection.
//
// The Skirmish (local quick-game) and Online setup screens expose a Power Node
// count selector whose min/max are driven by the chosen map size's
// nodeCountMin/nodeCountMax (larger maps reach up to 7; small maps stay narrow).
// Changing the map size re-clamps the chosen count into the new range, and the
// chosen value flows through generateMap()'s clamp in BOTH offline and online.
//
// Covered:
//   - MAP_SIZES range invariant (bounds scale with size; biggest reach 7)
//   - _nodeCountOpts: option list spans exactly [min..max] for each size
//   - _clampNodeCount: clamps into the selected size's band (e.g. 7 → skirmish max)
//   - generateMap(seed, size, override): produces exactly the clamped node count

import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { MAP_SIZES, generateMap } from '../src/map.js';
import { _nodeCountOpts, _clampNodeCount } from '../src/menu/ledger.js';
import { createLobby, getRoom, getRooms } from '../server/lobby.js';

const SIZES = ['skirmish', 'standard', 'regional', 'campaign', 'battle'];

describe('MAP_SIZES node-count range invariant', () => {
  test('every size declares a coherent min ≤ default ≤ max', () => {
    for (const size of SIZES) {
      const cfg = MAP_SIZES[size];
      assert.ok(cfg.nodeCountMin >= 1, `${size} min ≥ 1`);
      assert.ok(cfg.nodeCountMin <= cfg.nodeCount, `${size} min ≤ default`);
      assert.ok(cfg.nodeCount <= cfg.nodeCountMax, `${size} default ≤ max`);
    }
  });

  test('the upper bound scales up with map size, reaching 7 on the larger maps', () => {
    // Small maps cap low; campaign/battle allow up to seven.
    assert.equal(MAP_SIZES.skirmish.nodeCountMax, 3);
    assert.ok(MAP_SIZES.standard.nodeCountMax <= 5);
    assert.ok(MAP_SIZES.regional.nodeCountMax >= MAP_SIZES.standard.nodeCountMax);
    assert.equal(MAP_SIZES.campaign.nodeCountMax, 7);
    assert.equal(MAP_SIZES.battle.nodeCountMax, 7);
    // Monotonic non-decreasing across the ordered sizes.
    let prev = 0;
    for (const size of SIZES) {
      assert.ok(MAP_SIZES[size].nodeCountMax >= prev, `${size} max non-decreasing`);
      prev = MAP_SIZES[size].nodeCountMax;
    }
  });

  test('the lower bound never drops below the previous (smaller) size', () => {
    let prev = 0;
    for (const size of SIZES) {
      assert.ok(MAP_SIZES[size].nodeCountMin >= prev, `${size} min non-decreasing`);
      prev = MAP_SIZES[size].nodeCountMin;
    }
    // The smallest map can be as low as a single node; the biggest never below 3.
    assert.equal(MAP_SIZES.skirmish.nodeCountMin, 1);
    assert.ok(MAP_SIZES.battle.nodeCountMin >= 3);
  });

  test('label/color palettes cover the maximum reachable node count (7)', () => {
    // 7 nodes must have distinct labels + colors so the renderer/score tracker
    // never index out of range. (Both arrays live in map.js.)
    const maxNodes = Math.max(...SIZES.map((s) => MAP_SIZES[s].nodeCountMax));
    assert.equal(maxNodes, 7);
  });
});

describe('_nodeCountOpts — selector options follow the map size', () => {
  test('option list spans exactly [min..max] for each size', () => {
    for (const size of SIZES) {
      const cfg = MAP_SIZES[size];
      const opts = _nodeCountOpts(size);
      const values = opts.map((o) => parseInt(o.value, 10));
      const expected = [];
      for (let i = cfg.nodeCountMin; i <= cfg.nodeCountMax; i++) expected.push(i);
      assert.deepEqual(values, expected, `${size} options span [min..max]`);
    }
  });

  test('skirmish offers a narrow range; campaign offers up to 7', () => {
    assert.deepEqual(_nodeCountOpts('skirmish').map((o) => o.value), ['1', '2', '3']);
    assert.deepEqual(
      _nodeCountOpts('campaign').map((o) => o.value),
      ['2', '3', '4', '5', '6', '7'],
    );
  });

  test('the size default is tagged so the picker shows a sensible start', () => {
    for (const size of SIZES) {
      const def = MAP_SIZES[size].nodeCount;
      const opt = _nodeCountOpts(size).find((o) => parseInt(o.value, 10) === def);
      assert.ok(opt, `${size} default ${def} is in the option list`);
      assert.equal(opt.sub, 'default');
    }
  });

  test('an unknown map size falls back to the standard range', () => {
    assert.deepEqual(_nodeCountOpts('nonsense'), _nodeCountOpts('standard'));
  });
});

describe('_clampNodeCount — re-clamp on map-size change', () => {
  test('selecting 7 on skirmish clamps down to the skirmish max (3)', () => {
    assert.equal(_clampNodeCount('skirmish', 7), 3);
  });

  test('selecting 1 on a large map clamps up to that size min', () => {
    assert.equal(_clampNodeCount('campaign', 1), MAP_SIZES.campaign.nodeCountMin);
    assert.equal(_clampNodeCount('battle', 1), MAP_SIZES.battle.nodeCountMin);
  });

  test('an in-range value is preserved unchanged', () => {
    assert.equal(_clampNodeCount('campaign', 7), 7);
    assert.equal(_clampNodeCount('standard', 4), 4);
    assert.equal(_clampNodeCount('regional', 6), 6);
  });

  test('non-finite input falls back to the size default', () => {
    assert.equal(_clampNodeCount('standard', NaN), MAP_SIZES.standard.nodeCount);
    assert.equal(_clampNodeCount('skirmish', undefined), MAP_SIZES.skirmish.nodeCount);
  });

  test('clamp result always lands within the selected size band', () => {
    for (const size of SIZES) {
      const cfg = MAP_SIZES[size];
      for (const n of [-5, 0, 1, 3, 7, 99]) {
        const v = _clampNodeCount(size, n);
        assert.ok(v >= cfg.nodeCountMin && v <= cfg.nodeCountMax,
          `${size}(${n}) → ${v} within [${cfg.nodeCountMin},${cfg.nodeCountMax}]`);
      }
    }
  });
});

describe('generateMap — the chosen count flows through (offline + online share this)', () => {
  test('an in-range override produces exactly that many power nodes', () => {
    const map = generateMap(12345, 'campaign', 7);
    assert.equal(map.witchObjectives.length, 7);
    const map2 = generateMap(12345, 'standard', 4);
    assert.equal(map2.witchObjectives.length, 4);
  });

  test('an out-of-range override is clamped to the size band, not honored raw', () => {
    // 7 on skirmish → skirmish max (3); 1 on battle → battle min.
    assert.equal(generateMap(777, 'skirmish', 7).witchObjectives.length,
      MAP_SIZES.skirmish.nodeCountMax);
    assert.equal(generateMap(777, 'battle', 1).witchObjectives.length,
      MAP_SIZES.battle.nodeCountMin);
  });

  test('a null override falls back to the size default', () => {
    for (const size of SIZES) {
      const map = generateMap(2024, size, null);
      assert.equal(map.witchObjectives.length, MAP_SIZES[size].nodeCount,
        `${size} null → default ${MAP_SIZES[size].nodeCount}`);
    }
  });

  test('every generated node has a distinct label and color (up to 7)', () => {
    const map = generateMap(99, 'campaign', 7);
    const labels = new Set(map.witchObjectives.map((o) => o.label));
    const colors = new Set(map.witchObjectives.map((o) => o.color));
    assert.equal(labels.size, 7, 'distinct labels');
    assert.equal(colors.size, 7, 'distinct colors');
  });

  // Hardening: a non-numeric override (NaN / "banana" / {} — only reachable from a
  // hostile client) must NOT slip through generateMap's clamp as NaN. NaN bypasses
  // _pickNodesAcrossRiver's `count >= 2` and `placed.length >= count` guards, which
  // would fill ALL candidate tiles (a max-out, capped at 7). The defensive clamp
  // must treat any non-finite override as "no override" → the size default.
  test('a non-numeric override falls back to the size default, never NaN/max-out', () => {
    // standard's default (3) is strictly below its max (5), so "equals default"
    // also proves "not maxed out" (the NaN-clamp failure mode fills up to 7).
    assert.ok(MAP_SIZES.standard.nodeCount < MAP_SIZES.standard.nodeCountMax,
      'precondition: standard default below its max so the assertion is meaningful');
    for (const garbage of [NaN, 'banana', {}, [], Infinity, -Infinity, undefined]) {
      const map = generateMap(4242, 'standard', garbage);
      assert.equal(map.witchObjectives.length, MAP_SIZES.standard.nodeCount,
        `standard override ${String(garbage)} → default ${MAP_SIZES.standard.nodeCount}, not NaN/max-out`);
    }
  });

  test('a numeric-string override (legit-shaped) is still honored and clamped', () => {
    // The real client sends a parsed int, but a stringified finite number should
    // coerce cleanly rather than fall back to the default.
    assert.equal(generateMap(4242, 'campaign', '7').witchObjectives.length, 7);
    assert.equal(generateMap(4242, 'standard', '4').witchObjectives.length, 4);
    // A fractional value floors into a valid count.
    assert.equal(generateMap(4242, 'standard', 4.9).witchObjectives.length, 4);
  });
});

describe('createLobby — server boundary coerces a hostile nodeCount (Guideline 5 authority path)', () => {
  function mockWs() {
    const ws = {
      readyState: 1,
      messages: [],
      send(data) { ws.messages.push(JSON.parse(data)); },
      findMsg(type) { return ws.messages.find((m) => m.type === type); },
    };
    return ws;
  }

  function makeLobby(nodeCount) {
    const ws = mockWs();
    const roomId = createLobby('host-nodecount', 'Host', ws, {
      mapSize: 'standard', fog: 'none', playersPerSide: 1, nodeCount,
    });
    return getRoom(roomId);
  }

  afterEach(() => {
    for (const r of getRooms()) {
      const room = getRoom(r.id);
      if (room?.turnTimer) clearTimeout(room.turnTimer);
    }
  });

  test('a non-numeric nodeCount is stored as null (falls through to the map default)', () => {
    for (const garbage of ['banana', {}, [], NaN, Infinity, true]) {
      const room = makeLobby(garbage);
      assert.equal(room.config.nodeCount, null,
        `nodeCount ${String(garbage)} → null, not stored raw`);
    }
  });

  test('a finite nodeCount is stored as a floored integer', () => {
    assert.equal(makeLobby(4).config.nodeCount, 4);
    assert.equal(makeLobby('5').config.nodeCount, 5);   // numeric string coerces
    assert.equal(makeLobby(4.9).config.nodeCount, 4);   // floored
  });

  test('a missing nodeCount stays null (size default)', () => {
    const ws = mockWs();
    const roomId = createLobby('host-nodecount', 'Host', ws, {
      mapSize: 'standard', fog: 'none', playersPerSide: 1,
    });
    assert.equal(getRoom(roomId).config.nodeCount, null);
  });
});
