// Tests for survivor roster size, color count, and placement distance constraints.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SURVIVOR_ROSTER, resetRoster } from '../src/entities.js';
import { GameState } from '../src/game.js';
import { hexDistance } from '../src/hex.js';

describe('SURVIVOR_ROSTER size', () => {
  test('roster has exactly 20 entries', () => {
    assert.equal(SURVIVOR_ROSTER.length, 20);
  });

  test('all roster entries have required fields', () => {
    for (const entry of SURVIVOR_ROSTER) {
      assert.ok(entry.name, `missing name`);
      assert.ok(entry.title, `missing title for ${entry.name}`);
      assert.ok(entry.bio, `missing bio for ${entry.name}`);
      assert.ok(entry.ability, `missing ability for ${entry.name}`);
      assert.ok(entry.abilityLabel, `missing abilityLabel for ${entry.name}`);
      assert.ok(entry.maxHp >= 1, `invalid maxHp for ${entry.name}`);
      assert.ok(entry.attack >= 1, `invalid attack for ${entry.name}`);
      assert.ok(entry.defense >= 1, `invalid defense for ${entry.name}`);
    }
  });

  test('all roster names are unique', () => {
    const names = SURVIVOR_ROSTER.map(r => r.name);
    assert.equal(new Set(names).size, names.length, 'duplicate survivor names found');
  });
});

describe('Hidden survivor placement distance', () => {
  test('no hidden survivor within 3 hexes of hero start (standard map)', () => {
    resetRoster();
    const state = new GameState(true, true, 'standard');
    const heroStart = state._heroStart;
    assert.ok(heroStart, 'heroStart should be stored');

    for (const t of state.tiles.values()) {
      if (!t.hiddenSurvivor) continue;
      const dist = hexDistance(t.col, t.row, heroStart.col, heroStart.row);
      assert.ok(dist >= 3,
        `hidden survivor at (${t.col},${t.row}) is only ${dist} hexes from hero start (${heroStart.col},${heroStart.row})`);
    }
  });

  test('no hidden survivor within 3 hexes of witch start (standard map)', () => {
    resetRoster();
    const state = new GameState(true, true, 'standard');
    const witchStart = state._witchStart;
    assert.ok(witchStart, 'witchStart should be stored');

    for (const t of state.tiles.values()) {
      if (!t.hiddenSurvivor) continue;
      const dist = hexDistance(t.col, t.row, witchStart.col, witchStart.row);
      assert.ok(dist >= 3,
        `hidden survivor at (${t.col},${t.row}) is only ${dist} hexes from witch start (${witchStart.col},${witchStart.row})`);
    }
  });

  test('correct number of hidden survivors placed for standard map', () => {
    resetRoster();
    const state = new GameState(true, true, 'standard');
    let count = 0;
    for (const t of state.tiles.values()) {
      if (t.hiddenSurvivor) count++;
    }
    // standard: buildings=7 + terrain=1 = 8
    assert.equal(count, 8, `expected 8 hidden survivors on standard map, got ${count}`);
  });

  test('correct number of hidden survivors placed for skirmish map', () => {
    resetRoster();
    const state = new GameState(true, true, 'skirmish');
    let count = 0;
    for (const t of state.tiles.values()) {
      if (t.hiddenSurvivor) count++;
    }
    // skirmish: buildings=4 + terrain=1 = 5
    assert.equal(count, 5, `expected 5 hidden survivors on skirmish map, got ${count}`);
  });
});
