// endRound()-spawned entities must claim a free sub-hex slot.
//
// Discovered survivors and moved/summoned units pick a sub-hex slot via the
// canonical "lowest free, non-blocked slot (centre preferred)" rule
// (actions.js `assignSlotOnTile` / survivor-discovery.js). Entities spawned
// inside endRound() — node-spawned survivors (HeroFaction._applyNodeSurvivorSpawning)
// and graveyard zombies (WitchFaction._applyGraveyardSpawns) — used to skip
// that step and default to slot 0 (hex centre). When such a spawn co-occupies a
// hex with another unit, two units would collide on the centre slot.
//
// The graveyard test below is a true red→green guard: a friendly occupant sits
// on the graveyard entrance at slot 0, so the rising zombie lands on the SAME
// hex (only an enemy relocates the spawn) and must pick a free slot AROUND the
// occupant — slot 1, not 0. The node-survivor path always targets an EMPTY hex
// by design (freeHex skips occupied neighbours), so its spawn is the sole
// occupant and the helper correctly returns slot 0; that test pins the assigned
// slot to the shared helper's output so the wiring can't silently regress.
//
// Slot is the only thing asserted — spawn counts and locations are unchanged.

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { GameState, Phase } from '../src/game.js';
import { EntityType, createMinion } from '../src/entities.js';
import { BuildingType } from '../src/tiles.js';
import { GRAVEYARD_SPAWN_INTERVAL } from '../src/factions.js';
import { hexKey } from '../src/hex.js';
import { pickUnitSlot } from '../src/hex-slots.js';

function newGame() {
  // Standard maps always place exactly one graveyard and three power nodes.
  const state = new GameState(true, true, 'standard');
  state.disableScoring = true;  // keep endRound side effects minimal
  return state;
}

function graveyardTile(state) {
  for (const [, t] of state.tiles) {
    if (t.building === BuildingType.GRAVEYARD) return t;
  }
  return null;
}

function witchZombies(state) {
  return state.entities.filter(e => e.alive && e.owner === 'witch' && e.type === EntityType.ZOMBIE);
}

function heroSurvivors(state) {
  return state.entities.filter(e => e.alive && e.owner === 'hero' && e.type === EntityType.SURVIVOR);
}

describe('graveyard zombie spawn slot', () => {
  test('a graveyard zombie co-occupying the entrance picks a free slot, not centre 0', () => {
    const state = newGame();
    const grave = graveyardTile(state);
    assert.ok(grave, 'standard map must have a graveyard');

    // A FRIENDLY (witch-side) minion already stands on the graveyard entrance at
    // the centre slot. A friendly unit does not relocate the spawn (only an
    // ENEMY does — see _graveyardSpawnHex), so the rising zombie lands on the
    // very same hex and must pick a free slot AROUND the minion.
    const occupant = createMinion(grave.col, grave.row, state.witch?.ownerId, state);
    occupant.slot = 0;
    state.entities.push(occupant);

    state.round = GRAVEYARD_SPAWN_INTERVAL;  // end of the first full cycle
    const before = witchZombies(state).length;
    state.endRound();

    const after = witchZombies(state);
    assert.equal(after.length, before + 1, 'exactly one zombie should rise (count unchanged by the fix)');
    const zombie = after.at(-1);
    assert.equal(zombie.col, grave.col, 'zombie should rise on the graveyard entrance hex (location unchanged)');
    assert.equal(zombie.row, grave.row, 'zombie should rise on the graveyard entrance hex (location unchanged)');
    assert.notEqual(zombie.slot, occupant.slot,
      'the spawned zombie must not collide on the same sub-hex slot as the occupant');
    assert.equal(zombie.slot, 1, 'lowest free non-blocked slot around a centre-slot occupant is 1');
  });
});

describe('node-spawned survivor slot', () => {
  let realRandom;
  beforeEach(() => { realRandom = Math.random; });
  afterEach(() => { Math.random = realRandom; });

  test('a node survivor lands on the slot the shared slot helper assigns', () => {
    const state = newGame();
    const obj = state.witchObjectives[0];
    assert.ok(obj, 'standard map must have at least one power node');

    // Stand the hero leader on the node centre so the "node calls to the living"
    // branch fires this round.
    const hero = state.hero;
    assert.ok(hero, 'standard game must have a hero');
    hero.col = obj.col;
    hero.row = obj.row;

    state.phase = Phase.NIGHT;             // node survivor spawning is night-only
    state.disableNodeSurvivorSpawn = false;
    // Force the 0.33 spawn gate to pass (and the 0.5 horse roll to fail).
    Math.random = () => 0.1;

    const before = heroSurvivors(state).length;
    state.endRound();
    const survivors = heroSurvivors(state);
    assert.equal(survivors.length, before + 1, 'exactly one node survivor should spawn (count unchanged)');

    const spawned = survivors.at(-1);
    // The survivor went through the same slot-assignment helper as every other
    // spawn. Pin its slot to what that helper would compute for its tile and the
    // units sharing the hex — proving the wiring, not the hard-coded 0 default.
    const t = state.tiles.get(hexKey(spawned.col, spawned.row));
    const occupied = state.entities
      .filter(e => e.alive && e.id !== spawned.id && e.col === spawned.col && e.row === spawned.row)
      .map(e => e.slot ?? 0);
    const expected = pickUnitSlot(t?.blockedSlots ?? [], occupied);
    assert.equal(spawned.slot, expected,
      'node survivor slot must equal the shared helper output for its tile');
  });
});
