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
  const wmods = ITEMS[hero.getEquippedWeaponId()]?.statMods ?? {};
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

// ── deathLocations parity (necromancer RAISE DEAD, online) ──────────────────
//
// Regression test: MirrorState.fromSnapshot never copied snap.deathLocations
// even though serializeState sends it. Online, hasRaisableCorpse() reads
// state.deathLocations on the client to grey/ungrey the necromancer's
// "Raise Dead" arc button — with the field dropped, the ledger was always
// empty and the button was permanently disabled in online necromancer games.

const { EntityType, isLeaderType } = await import('../src/entities.js');
const { hasRaisableCorpse }        = await import('../src/actions.js');
const { TileType, decomposeTileType } = await import('../src/tiles.js');
const { getNeighbors, hexKey }     = await import('../src/hex.js');

test('MirrorState.fromSnapshot copies deathLocations from the snapshot', () => {
  const gs = new GameState(true, true, 'standard', 3);
  // Record a grave the way every death site does (recordDeathLocation shape).
  gs.recordDeathLocation({
    id: 'corpse-1', type: EntityType.MINION, owner: 'witch', ownerId: null,
    col: gs.witch.col, row: gs.witch.row,
  });
  assert.equal(gs.deathLocations.length, 1, 'sanity: grave recorded');

  const snap   = serializeState(gs);
  const mirror = MirrorState.fromSnapshot(snap);

  assert.deepEqual(mirror.deathLocations, gs.deathLocations,
    'mirror must expose the same corpse ledger the server serialized');
});

test('deathLocations defaults to [] when absent from an (older) snapshot', () => {
  const gs   = new GameState(true, true, 'standard', 3);
  const snap = serializeState(gs);
  delete snap.deathLocations;
  const mirror = MirrorState.fromSnapshot(snap);
  assert.deepEqual(mirror.deathLocations, []);
});

test('online necromancer sees a raisable corpse through the MirrorState', () => {
  const gs = new GameState(true, true, 'standard', 3);
  gs.swapLeaderToFaction('night', 'necromancer');
  const necro = gs.witch;

  // Put the grave one hex away on a scrubbed, open grass tile so
  // isPlaceableTile() can't be tripped by procedural-map noise.
  const n = getNeighbors(necro.col, necro.row)
    .find(h => gs.tiles.has(hexKey(h.col, h.row)));
  assert.ok(n, 'necromancer has an on-map neighbor hex');
  const t = gs.tiles.get(hexKey(n.col, n.row));
  decomposeTileType(t, TileType.GRASS);
  t.building = null; t.structure = null; t.fortifyLevel = 0;
  t.hiddenSurvivor = false; t.buildingFootprintOf = null; t.footprintHexes = [];
  gs.entities = gs.entities.filter(e => !(e.col === n.col && e.row === n.row));

  gs.recordDeathLocation({
    id: 'corpse-2', type: EntityType.ZOMBIE, owner: 'witch', ownerId: null,
    col: n.col, row: n.row,
  });
  assert.ok(!isLeaderType(EntityType.ZOMBIE));
  assert.equal(hasRaisableCorpse(gs, necro), true,
    'sanity: corpse raisable on the authoritative state');

  const mirror      = MirrorState.fromSnapshot(serializeState(gs));
  const mirrorNecro = mirror.entities.find(e => e.id === necro.id);
  assert.equal(hasRaisableCorpse(mirror, mirrorNecro), true,
    'the Raise Dead arc-button gate must see the corpse on the online mirror');
});
