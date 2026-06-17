// Tests for starting resources: factions define initial inventory,
// GameState populates them at construction, and state-sync round-trips them.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GameState } from '../src/game.js';
import { ResourceType } from '../src/tiles.js';
import { Faction, HeroFaction, WitchFaction, getFaction } from '../src/factions.js';
import { serializeState, deserializeState } from '../server/state-sync.js';

function freshState() {
  return new GameState(true, true);
}

describe('Faction starting resources', () => {
  test('Base Faction returns empty starting resources', () => {
    const base = new Faction();
    assert.deepStrictEqual(base.getStartingResources(), {});
  });

  test('HeroFaction starts with 2 food', () => {
    const hero = getFaction('hero');
    const res = hero.getStartingResources();
    assert.equal(res[ResourceType.FOOD], 2);
    assert.equal(Object.keys(res).length, 1);
  });

  test('WitchFaction starts with 2 wood and 2 metal', () => {
    const witch = getFaction('witch');
    const res = witch.getStartingResources();
    assert.equal(res[ResourceType.WOOD], 2);
    assert.equal(res[ResourceType.METAL], 2);
    assert.equal(Object.keys(res).length, 2);
  });
});

describe('GameState starting inventory', () => {
  test('Fresh game state has hero food in shared inventory', () => {
    const state = freshState();
    assert.equal((state.inventory.hero[ResourceType.FOOD]?.count ?? 0), 2);
  });

  test('Fresh game state has witch wood and metal', () => {
    const state = freshState();
    assert.equal((state.inventory.witch[ResourceType.WOOD]?.count ?? 0), 2);
    assert.equal((state.inventory.witch[ResourceType.METAL]?.count ?? 0), 2);
  });

  test('Starting resources survive serialize/deserialize round-trip', () => {
    const state = freshState();
    const snap = serializeState(state);
    const restored = deserializeState(snap);
    assert.equal((restored.inventory.hero[ResourceType.FOOD]?.count ?? 0), 2);
    assert.equal((restored.inventory.witch[ResourceType.WOOD]?.count ?? 0), 2);
    assert.equal((restored.inventory.witch[ResourceType.METAL]?.count ?? 0), 2);
  });
});
