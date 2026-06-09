// Regression test for the online-game-loading bug:
//
// After the Phase 2/3 entity refactor, the renderer and UI started calling
// Entity methods on every frame — getAttack(), getDefense(), hasAbility(),
// hasTag(), getMoveRange(), abilities getter — but MirrorEntity only defined
// a handful of stubs (alive, displayName, takeDamage, heal, resetTurn,
// equipWeapon). When the client received the initial `gameJoined` snapshot
// and started rendering, every frame threw "e.hasAbility is not a function"
// (fog-of-war), "entity.getAttack is not a function" (unit stats bar), etc.
// The canvas stayed blank — "online games won't start at all".
//
// The fix is to re-parent snapshot entities to Entity.prototype in
// MirrorState.fromSnapshot, matching the `patchAlive` contract used by
// the playback/resolution-animation path.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stub minimal browser globals so multiplayer.js (which imports platform.js)
// can be loaded in node.
globalThis.window   = globalThis.window   ?? { Capacitor: undefined, addEventListener: () => {} };
globalThis.document = globalThis.document ?? { addEventListener: () => {}, hidden: false };

const { MirrorState }          = await import('../src/multiplayer.js');
const { GameState }            = await import('../src/game.js');
const { serializeState }       = await import('../server/state-sync.js');
const { Entity, SurvivorAbility } = await import('../src/entities.js');
const { ITEMS }                   = await import('../src/items.js');

test('MirrorState.fromSnapshot yields entities with Entity methods', () => {
  const gs   = new GameState(true, true, 'standard', 3);
  const snap = serializeState(gs);
  const mirror = MirrorState.fromSnapshot(snap);

  for (const e of mirror.entities) {
    assert.equal(typeof e.getAttack,    'function', `entity ${e.id} missing getAttack`);
    assert.equal(typeof e.getDefense,   'function', `entity ${e.id} missing getDefense`);
    assert.equal(typeof e.getMoveRange, 'function', `entity ${e.id} missing getMoveRange`);
    assert.equal(typeof e.hasAbility,   'function', `entity ${e.id} missing hasAbility`);
    assert.equal(typeof e.hasTag,       'function', `entity ${e.id} missing hasTag`);
    // abilities is a getter — reading it must not throw.
    assert.doesNotThrow(() => e.abilities, `entity ${e.id} missing abilities getter`);
  }
});

test('MirrorState entities preserve numeric stats through method calls', () => {
  const gs   = new GameState(true, true, 'standard', 3);
  const snap = serializeState(gs);
  const mirror = MirrorState.fromSnapshot(snap);

  const hero = mirror.entities.find(e => e.id === mirror.hero?.id);
  assert.ok(hero, 'hero present in mirror state');
  assert.equal(typeof hero.getAttack(),  'number');
  assert.equal(typeof hero.getDefense(), 'number');
  // Weapon stats are no longer baked into base attack/defense — getAttack()/
  // getDefense() compose the equipped weapon's statMods at call time. The hero
  // leader starts with a sword, so the composed stat = base + weapon mod.
  const wmods = ITEMS[hero.weapon]?.statMods ?? {};
  assert.equal(hero.getAttack(),  hero.attack  + (wmods.attack  ?? 0));
  assert.equal(hero.getDefense(), hero.defense + (wmods.defense ?? 0));
});

test('MirrorState entities respond correctly to hasAbility/hasTag', () => {
  const gs   = new GameState(true, true, 'standard', 3);
  // Give a survivor a known ability so we can assert the method dispatch works.
  const survivor = gs.entities.find(e => e.type === 'survivor');
  if (survivor) survivor.ability = SurvivorAbility.SCOUT;

  const snap   = serializeState(gs);
  const mirror = MirrorState.fromSnapshot(snap);

  if (survivor) {
    const mirrored = mirror.entities.find(e => e.id === survivor.id);
    assert.equal(mirrored.hasAbility(SurvivorAbility.SCOUT), true);
    assert.equal(mirrored.hasAbility('bogus-ability'),        false);
  }

  // All entities should answer hasTag without throwing; tags come from UNIT_TYPES.
  for (const e of mirror.entities) {
    assert.doesNotThrow(() => e.hasTag('leader'));
  }
});

test('MirrorState entities are Entity-prototyped (matches playback patchAlive)', () => {
  const gs   = new GameState(true, true, 'standard', 3);
  const snap = serializeState(gs);
  const mirror = MirrorState.fromSnapshot(snap);

  for (const e of mirror.entities) {
    assert.ok(
      e instanceof Entity || Object.getPrototypeOf(Object.getPrototypeOf(e)) === Entity.prototype,
      `entity ${e.id} should resolve Entity methods via prototype chain`,
    );
  }
});
