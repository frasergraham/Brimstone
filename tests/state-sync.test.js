// Tests for server/state-sync.js — round-trip coverage for new entity fields.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeState, deserializeState } from '../server/state-sync.js';
import { GameState } from '../src/game.js';
import { BASE_AGILITY, EntityType, createMinion, createSurvivor, SurvivorAbility } from '../src/entities.js';

function freshState() { return new GameState(true, true); }

describe('state-sync — Agility round-trip', () => {
  test('per-type defaults are present on every entity after construction', () => {
    const state = freshState();
    for (const e of state.entities) {
      assert.equal(e.agility, BASE_AGILITY[e.type] ?? 1,
        `Entity ${e.id} (${e.type}) should have default agility ${BASE_AGILITY[e.type]}`);
    }
  });

  test('custom agility survives serialize → deserialize', () => {
    const state = freshState();
    // Add a minion to exercise more than just hero/witch defaults.
    const minion = createMinion(5, 5);
    minion.owner = 'witch';
    state.entities.push(minion);

    // Override one entity to a non-default value.
    state.hero.agility = 9;

    const snap = serializeState(state);
    const restored = deserializeState(snap);

    for (const orig of state.entities) {
      const copy = restored.entities.find(e => e.id === orig.id);
      assert.ok(copy, `restored entity ${orig.id} missing`);
      assert.equal(copy.agility, orig.agility,
        `Agility for ${orig.id} (${orig.type}) must survive round-trip`);
    }
    const restoredHero = restored.entities.find(e => e.id === state.hero.id);
    assert.equal(restoredHero.agility, 9, 'Explicit override must persist');
  });

  test('pre-002 saves (missing agility) hydrate from BASE_AGILITY on restore', () => {
    const state = freshState();
    const snap = serializeState(state);
    // Simulate a legacy snapshot where agility is absent from entity blobs.
    for (const e of snap.entities) delete e.agility;

    const restored = deserializeState(snap);
    for (const e of restored.entities) {
      assert.notEqual(e.agility, undefined, `Entity ${e.id} should have a hydrated agility`);
      assert.equal(e.agility, BASE_AGILITY[e.type] ?? 1,
        `Missing agility should hydrate to BASE_AGILITY[${e.type}]`);
    }
  });
});

describe('state-sync — abilities array round-trip (Phase 4)', () => {
  test('survivor abilities[] survives serialize → deserialize', () => {
    const state = freshState();
    const survivor = createSurvivor(5, 5, 'hero-player-1', state);
    survivor.abilities = [SurvivorAbility.HEAL, SurvivorAbility.SCOUT];
    state.entities.push(survivor);

    const snap = serializeState(state);
    const restored = deserializeState(snap);

    const copy = restored.entities.find(e => e.id === survivor.id);
    assert.ok(copy, 'restored survivor present');
    assert.deepEqual(copy.abilities, [SurvivorAbility.HEAL, SurvivorAbility.SCOUT]);
    assert.equal(copy.hasAbility(SurvivorAbility.HEAL),  true);
    assert.equal(copy.hasAbility(SurvivorAbility.SCOUT), true);
  });

  test('entities without abilities serialize to empty array', () => {
    const state = freshState();
    const snap = serializeState(state);
    for (const e of snap.entities) {
      assert.ok(Array.isArray(e.abilities), `Entity ${e.id} abilities must be an array`);
    }
  });
});

describe('state-sync — factionId round-trip (rogue)', () => {
  test('rogue leader\'s factionId survives serialize → deserialize', async () => {
    const { concreteFactionOf } = await import('../src/factions.js');
    const state = freshState();
    state.swapLeaderToFaction('day', 'rogue');
    const heroId = state.hero.id;
    assert.equal(state.hero.factionId, 'rogue',
      'precondition: rogue leader should carry factionId');

    const snap = serializeState(state);
    const restored = deserializeState(snap);

    const restoredHero = restored.entities.find(e => e.id === heroId);
    assert.ok(restoredHero, 'restored leader present');
    assert.equal(restoredHero.factionId, 'rogue',
      'factionId must round-trip — without it the rogue silently reverts to paladin');
    // Concrete-faction lookup should resolve to RogueFaction post-restore.
    const fac = concreteFactionOf(restoredHero);
    assert.equal(fac.id, 'rogue');
    assert.equal(fac.canEquipWeaponItem('sword'), false,
      'restored rogue still refuses melee — proves the override is wired');
  });

  test('pre-PR saves (missing factionId) hydrate to null on restore', () => {
    const state = freshState();
    const snap = serializeState(state);
    // Simulate a legacy snapshot where factionId is absent from every blob.
    for (const e of snap.entities) delete e.factionId;
    const restored = deserializeState(snap);
    // Default leaders had no factionId before this PR; restore preserves
    // that — concrete lookup falls back to owner (side default).
    const hero = restored.entities.find(e => e.id === state.hero.id);
    assert.equal(hero.factionId, null);
  });
});
