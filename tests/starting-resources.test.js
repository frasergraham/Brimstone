// Tests for starting resources: factions define initial inventory,
// GameState populates them at construction, and state-sync round-trips them.

import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GameState } from '../src/game.js';
import { ResourceType } from '../src/tiles.js';
import { Faction, HeroFaction, WitchFaction, getFaction, STARTING_RESOURCE_LEVELS } from '../src/factions.js';
import { getItemCountOf } from '../src/entities.js';
import { serializeState, deserializeState } from '../server/state-sync.js';
import { createLobby, getRoom, getRooms } from '../server/lobby.js';

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

// ── "Starting Resources" config option (none/low/med/high) ────────────────────
//
// Grants each side a faction-tuned BONUS cache on top of its base resources.
// 'none' (the default for every existing call site) is a no-op so the balance
// baseline is unchanged. Applied in ONE place — the GameState constructor — so
// the offline (main.js) and online (lobby.js) paths stay in parity.

describe('STARTING_RESOURCE_LEVELS', () => {
  test('is exactly none/low/med/high', () => {
    assert.deepStrictEqual([...STARTING_RESOURCE_LEVELS], ['none', 'low', 'med', 'high']);
  });
});

describe('getStartingResourceBonus is faction-tuned and scales by level', () => {
  const hero  = getFaction('hero');
  const witch = getFaction('witch');

  test("'none' / unknown yields no bonus, and the base faction never grants one", () => {
    assert.deepStrictEqual(hero.getStartingResourceBonus('none'), {});
    assert.deepStrictEqual(witch.getStartingResourceBonus('none'), {});
    assert.deepStrictEqual(hero.getStartingResourceBonus('bogus'), {});
    assert.deepStrictEqual(new Faction().getStartingResourceBonus('high'), {});
  });

  test('hero cache favours sustain/economy; never the witch summon materials', () => {
    const low  = hero.getStartingResourceBonus('low');
    const high = hero.getStartingResourceBonus('high');
    assert.ok((low[ResourceType.HERBS] ?? 0) > 0 && (low[ResourceType.FOOD] ?? 0) > 0);
    assert.ok(high[ResourceType.HERBS] > low[ResourceType.HERBS]);
    assert.ok(high[ResourceType.SILVER] > 0 && high[ResourceType.SCRIPTURE] > 0);
    assert.equal(high[ResourceType.WOOD] ?? 0, 0);
    assert.equal(high[ResourceType.METAL] ?? 0, 0);
  });

  test('witch cache favours the summon economy; never hero-only resources', () => {
    const low  = witch.getStartingResourceBonus('low');
    const high = witch.getStartingResourceBonus('high');
    assert.ok((low[ResourceType.WOOD] ?? 0) > 0 && (low[ResourceType.METAL] ?? 0) > 0);
    assert.ok(high[ResourceType.WOOD] > low[ResourceType.WOOD]);
    assert.ok(high[ResourceType.METAL] > low[ResourceType.METAL]);
    assert.equal(high[ResourceType.FOOD] ?? 0, 0);
    assert.equal(high[ResourceType.SILVER] ?? 0, 0);
    assert.equal(high[ResourceType.SCRIPTURE] ?? 0, 0);
  });
});

describe('GameState bakes the bonus onto the base inventory', () => {
  test("default (no arg) and explicit 'none' both equal the legacy baseline", () => {
    for (const make of [() => new GameState(true, true),
                        () => new GameState(true, true, 'standard', 3, null, 'none')]) {
      const s = make();
      assert.equal(getItemCountOf(s.inventory.hero,  ResourceType.FOOD),  2);
      assert.equal(getItemCountOf(s.inventory.hero,  ResourceType.HERBS), 0);
      assert.equal(getItemCountOf(s.inventory.witch, ResourceType.WOOD),  2);
      assert.equal(getItemCountOf(s.inventory.witch, ResourceType.METAL), 2);
    }
  });

  test("'low' adds the per-faction bonus to the base counts", () => {
    const s = new GameState(true, true, 'standard', 3, null, 'low');
    const heroB  = getFaction('hero').getStartingResourceBonus('low');
    const witchB = getFaction('witch').getStartingResourceBonus('low');
    assert.equal(getItemCountOf(s.inventory.hero, ResourceType.FOOD),
      2 + (heroB[ResourceType.FOOD] ?? 0));
    assert.equal(getItemCountOf(s.inventory.hero, ResourceType.HERBS),
      heroB[ResourceType.HERBS] ?? 0);
    assert.equal(getItemCountOf(s.inventory.witch, ResourceType.WOOD),
      2 + (witchB[ResourceType.WOOD] ?? 0));
    assert.equal(getItemCountOf(s.inventory.witch, ResourceType.METAL),
      2 + (witchB[ResourceType.METAL] ?? 0));
  });

  test("'high' grants strictly more than 'low' for both sides", () => {
    const lo = new GameState(true, true, 'standard', 3, null, 'low');
    const hi = new GameState(true, true, 'standard', 3, null, 'high');
    assert.ok(getItemCountOf(hi.inventory.hero,  ResourceType.HERBS) >
              getItemCountOf(lo.inventory.hero,  ResourceType.HERBS));
    assert.ok(getItemCountOf(hi.inventory.witch, ResourceType.WOOD) >
              getItemCountOf(lo.inventory.witch, ResourceType.WOOD));
  });
});

describe('createLobby validates startingResources into room.config', () => {
  const mockWs = () => ({ readyState: 1, messages: [], send(d) { this.messages.push(JSON.parse(d)); } });
  afterEach(() => {
    for (const r of getRooms()) { const room = getRoom(r.id); if (room?.turnTimer) clearTimeout(room.turnTimer); }
  });

  test('a valid level is stored on the room config', () => {
    const id = createLobby('host-sr-1', 'Host', mockWs(), { startingResources: 'high' });
    assert.equal(getRoom(id).config.startingResources, 'high');
  });

  test('a missing level defaults to none (baseline preserved)', () => {
    const id = createLobby('host-sr-2', 'Host', mockWs(), {});
    assert.equal(getRoom(id).config.startingResources, 'none');
  });

  test('an invalid level is rejected and falls back to none', () => {
    const id = createLobby('host-sr-3', 'Host', mockWs(), { startingResources: 'infinite' });
    assert.equal(getRoom(id).config.startingResources, 'none');
  });
});
