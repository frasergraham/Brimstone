// Regression test for the playback / resolution-animation path.
//
// During _animateResolutionSteps (src/main.js) and the full-game
// replay (src/playback.js), state.entities is swapped to plain-object
// snapshots produced by server/resolver.js:snapshotEntities and
// server/state-sync.js:serializeState. The renderer and UI call
// Entity methods (hasAbility / getAttack / getDefense / hasTag) on
// those entities — if the snapshots aren't re-parented to
// Entity.prototype, every frame throws during playback, wiping the
// canvas. This test locks the hydration contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patchAlive } from '../src/playback.js';
import { Entity, EntityType, SurvivorAbility } from '../src/entities.js';

test('patchAlive re-parents plain snapshots to Entity.prototype', () => {
  const snap = [
    {
      id: 'e1', type: EntityType.PALADIN, owner: 'hero',
      col: 0, row: 0, hp: 10, maxHp: 14, attack: 3, defense: 2,
      weapon: 'sword', ability: null, items: {},
    },
    {
      id: 'e2', type: EntityType.SURVIVOR, owner: 'hero',
      col: 1, row: 0, hp: 4, maxHp: 4, attack: 2, defense: 1,
      weapon: null, ability: SurvivorAbility.SCOUT, items: {},
    },
  ];
  patchAlive(snap);
  for (const e of snap) {
    assert.ok(e instanceof Entity, `entity ${e.id} not re-parented`);
    assert.equal(typeof e.hasAbility, 'function');
    assert.equal(typeof e.getAttack,  'function');
    assert.equal(typeof e.getDefense, 'function');
    assert.equal(typeof e.hasTag,     'function');
  }
});

test('patchAlive hydrates getAttack / getDefense correctly across weapon state', () => {
  const snap = [{
    id: 'e1', type: EntityType.PALADIN, owner: 'hero',
    col: 0, row: 0, hp: 10, maxHp: 14, attack: 3, defense: 2,
    weapon: 'sword', items: {},
  }];
  patchAlive(snap);
  const e = snap[0];
  // Phase 3: getAttack composes base + weapon mod at call time.
  assert.equal(e.getAttack(),  5, '3 base + 2 sword');
  assert.equal(e.getDefense(), 2, 'sword has no defense mod');
});

test('patchAlive does not choke on getter-only fields (alive, displayName)', () => {
  // serializeState omits alive, but resolver.snapshotEntities includes it
  // as an own property. Both flavours must hydrate cleanly.
  const withAlive = [{ id: 'a', type: EntityType.WITCH, hp: 5, alive: true, items: {} }];
  const noAlive   = [{ id: 'b', type: EntityType.WITCH, hp: 0, items: {} }];
  patchAlive(withAlive);
  patchAlive(noAlive);
  assert.equal(withAlive[0].alive, true);
  assert.equal(noAlive[0].alive,   false); // hp=0 ⇒ dead via own prop patched in
});

test('patchAlive is idempotent on already-prototyped entities', () => {
  const snap = [{
    id: 'e1', type: EntityType.PALADIN, owner: 'hero',
    col: 0, row: 0, hp: 10, maxHp: 14, attack: 3, defense: 2,
    weapon: null, items: {},
  }];
  patchAlive(snap);
  // Second pass must not throw.
  patchAlive(snap);
  assert.equal(snap[0].getAttack(), 3);
});

test('hasAbility works on re-parented snapshots', () => {
  const snap = [{
    id: 'scout', type: EntityType.SURVIVOR, owner: 'hero',
    col: 0, row: 0, hp: 4, maxHp: 4, attack: 2, defense: 2,
    abilities: [SurvivorAbility.SCOUT], items: {},
  }];
  patchAlive(snap);
  assert.equal(snap[0].hasAbility(SurvivorAbility.SCOUT), true);
  assert.equal(snap[0].hasAbility(SurvivorAbility.HEAL),  false);
});

// ── withPinnedPhase — re-watch under the round's own day-cycle phase ─────────
// A re-watch (end-of-round Replay, "Replay Last Turn") happens AFTER
// finalizeRound() advanced the phase. Replaying under the NEXT phase changes
// lighting AND sight ranges (the fog veil + the card/animation gates), so the
// re-watch wouldn't match the original. withPinnedPhase pins state.phase to
// the round's phase for the duration and restores the live phase after — even
// when the replay throws.

test('withPinnedPhase pins the phase during fn and restores it after', async () => {
  const { withPinnedPhase } = await import('../src/playback.js');
  const state = { phase: 'day' };
  let during = null;
  const out = await withPinnedPhase(state, 'dawn', async () => {
    during = state.phase;
    return 42;
  });
  assert.equal(during, 'dawn', 'phase pinned while the replay runs');
  assert.equal(state.phase, 'day', 'live phase restored after');
  assert.equal(out, 42, 'fn result passed through');
});

test('withPinnedPhase restores the live phase when fn throws', async () => {
  const { withPinnedPhase } = await import('../src/playback.js');
  const state = { phase: 'night' };
  await assert.rejects(
    () => withPinnedPhase(state, 'dusk', async () => { throw new Error('boom'); }),
    /boom/,
  );
  assert.equal(state.phase, 'night');
});

test('withPinnedPhase no-ops when the phase is missing or unchanged', async () => {
  const { withPinnedPhase } = await import('../src/playback.js');
  const state = { phase: 'day' };
  let ran = false;
  await withPinnedPhase(state, null, async () => { ran = true; assert.equal(state.phase, 'day'); });
  assert.equal(ran, true);
  await withPinnedPhase(state, 'day', async () => { assert.equal(state.phase, 'day'); });
  assert.equal(state.phase, 'day');
});
