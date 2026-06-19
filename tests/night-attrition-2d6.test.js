// Night attrition now rolls 2d6 per exposed survivor (replacing the old fixed
// -7 = 1 × DAMAGE_SCALE base). The roll uses the game's deterministic die
// stream (state.nextDie / forced dice) so resolution stays a pure function of
// (state, plans, seed). Tier scaling (attritionLevel) still multiplies the roll
// so later cycles escalate.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { GameState, Phase } from '../src/game.js';
import { EntityType, createSurvivor } from '../src/entities.js';
import { hexKey } from '../src/hex.js';
import { applyPostRoundEffects, PostRoundEventType } from '../src/post-round-effects.js';

// Place a survivor on an open (non-building, non-fort) grass-ish tile so the
// night-attrition path actually bites it. Returns the survivor.
function placeExposedSurvivor(state) {
  // Find a tile with no building and fortifyLevel 0.
  let target = null;
  for (const [, t] of state.tiles) {
    if (!t.building && (t.fortifyLevel ?? 0) === 0) { target = t; break; }
  }
  assert.ok(target, 'need an open tile for an exposed survivor');
  const s = createSurvivor(target.col, target.row, 'hero', state);
  s.owner = 'hero';
  // Big HP pool so a single night never kills it (keeps the DAMAGE event).
  s.maxHp = 9999;
  s.hp = 9999;
  state.entities.push(s);
  return s;
}

function newNightGame() {
  const state = new GameState(true, true, 'standard');
  state.disableScoring = true;
  state.phase = Phase.NIGHT;
  state.attritionLevel = 1; // tier 1 — old fixed value was 1 × 7 = 7
  // Remove any pre-placed survivors so we measure only ours.
  state.entities = state.entities.filter(e => e.type !== EntityType.SURVIVOR);
  return state;
}

function nightDamageDealt(state) {
  const events = applyPostRoundEffects(state);
  const dmg = events.find(e =>
    e.type === PostRoundEventType.DAMAGE || e.type === PostRoundEventType.KILL
  );
  return dmg ? dmg.amount : 0;
}

describe('night attrition rolls 2d6 (not a fixed 7)', () => {
  test('tier-1 damage stays within the 2d6 range [2, 12] (forced extremes + samples)', () => {
    // Deterministic extremes: 2d6 min and max.
    const lo = newNightGame(); placeExposedSurvivor(lo); lo.setForcedDice(1, 1);
    assert.equal(nightDamageDealt(lo), 2, 'forced 1+1 ⇒ 2 (2d6 min)');
    const hi = newNightGame(); placeExposedSurvivor(hi); hi.setForcedDice(6, 6);
    assert.equal(nightDamageDealt(hi), 12, 'forced 6+6 ⇒ 12 (2d6 max)');
    // Random samples must also stay in range.
    for (let i = 0; i < 60; i++) {
      const state = newNightGame();
      placeExposedSurvivor(state);
      const amt = nightDamageDealt(state);
      assert.ok(amt >= 2 && amt <= 12, `night damage ${amt} out of 2d6 range [2,12]`);
    }
  });

  test('damage is not constant — it varies across rolls', () => {
    const seen = new Set();
    for (let i = 0; i < 60; i++) {
      const state = newNightGame();
      placeExposedSurvivor(state);
      seen.add(nightDamageDealt(state));
    }
    assert.ok(seen.size > 1, `expected varied night damage, only saw ${[...seen]}`);
    assert.ok(!(seen.size === 1 && seen.has(7)), 'must not be the old fixed 7');
  });

  test('uses the deterministic die stream (forced dice ⇒ exact 2d6 sum)', () => {
    const state = newNightGame();
    placeExposedSurvivor(state);
    // Force the two attrition d6 to 3 and 5 ⇒ sum 8 at tier 1.
    state.setForcedDice(3, 5);
    const amt = nightDamageDealt(state);
    assert.equal(amt, 8, 'forced 3+5 must yield exactly 8 HP at tier 1');
  });

  test('two identical seeds (same forced dice) deal identical damage', () => {
    const a = newNightGame();
    placeExposedSurvivor(a);
    a.setForcedDice(6, 6);
    const b = newNightGame();
    placeExposedSurvivor(b);
    b.setForcedDice(6, 6);
    const dmgA = nightDamageDealt(a); // consumes the forced dice once
    const dmgB = nightDamageDealt(b);
    assert.equal(dmgA, dmgB, 'deterministic for fixed dice');
    assert.equal(dmgA, 12, 'forced 6+6 at tier 1 ⇒ 12'); // 2d6 max
  });

  test('attrition tier scales the 2d6 roll (tier 2 ⇒ 2× the sum)', () => {
    const state = newNightGame();
    state.attritionLevel = 2;
    placeExposedSurvivor(state);
    state.setForcedDice(2, 4); // sum 6, × tier 2 ⇒ 12
    const amt = nightDamageDealt(state);
    assert.equal(amt, 12, 'tier-2 night damage = (2d6 sum) × 2');
  });
});
