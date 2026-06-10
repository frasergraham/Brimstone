// Tests for AI difficulty tiers:
//   - the difficulty budget delta flows from state.aiDifficulty into both
//     engines' planning budget (easy −1, normal 0, hard +1, floor 1)
//   - 'normal' (and absent/unknown values) leave the budget untouched —
//     the tuned balance baseline must not move
//   - aiDifficulty survives a state-sync round trip
//   - the lobby validates the configured difficulty

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { GameState } from '../src/game.js';
import { PlanSimState, AI_DIFFICULTIES, AI_DIFFICULTY_BUDGET_DELTA } from '../src/ai.js';
import { assessBoard } from '../src/ai-engine.js';
import { assessHeroBoard } from '../src/hero-ai-engine.js';
import { serializeState, deserializeState } from '../server/state-sync.js';

function freshState(difficulty = null) {
  const state = new GameState(true, true);
  if (difficulty !== null) state.aiDifficulty = difficulty;
  return state;
}

describe('AI difficulty budget delta', () => {
  test('constants cover all tiers', () => {
    for (const d of AI_DIFFICULTIES) {
      assert.ok(d in AI_DIFFICULTY_BUDGET_DELTA, `missing delta for '${d}'`);
    }
    assert.equal(AI_DIFFICULTY_BUDGET_DELTA.normal, 0, 'normal must be the unmodified baseline');
  });

  test('PlanSimState picks up the delta from state.aiDifficulty', () => {
    assert.equal(new PlanSimState(freshState('easy'),   'witch').aiDifficultyDelta, -1);
    assert.equal(new PlanSimState(freshState('normal'), 'witch').aiDifficultyDelta, 0);
    assert.equal(new PlanSimState(freshState('hard'),   'witch').aiDifficultyDelta, 1);
    // Unknown / legacy states (no field) default to baseline
    assert.equal(new PlanSimState(freshState('nightmare'), 'witch').aiDifficultyDelta, 0);
    const legacy = freshState();
    delete legacy.aiDifficulty;
    assert.equal(new PlanSimState(legacy, 'witch').aiDifficultyDelta, 0);
  });

  test('witch engine totalBudget shifts by the delta', () => {
    const budgets = {};
    for (const d of AI_DIFFICULTIES) {
      const sim = new PlanSimState(freshState(d), 'witch');
      budgets[d] = assessBoard(sim).totalBudget;
    }
    assert.equal(budgets.easy, Math.max(1, budgets.normal - 1));
    assert.equal(budgets.hard, budgets.normal + 1);
  });

  test('hero engine totalBudget shifts by the delta', () => {
    const budgets = {};
    for (const d of AI_DIFFICULTIES) {
      const sim = new PlanSimState(freshState(d), 'hero');
      budgets[d] = assessHeroBoard(sim).totalBudget;
    }
    assert.equal(budgets.easy, Math.max(1, budgets.normal - 1));
    assert.equal(budgets.hard, budgets.normal + 1);
  });

  test("'normal' totalBudget equals the raw sim budget (baseline unchanged)", () => {
    const state = freshState('normal');
    const witchSim = new PlanSimState(state, 'witch');
    assert.equal(assessBoard(witchSim).totalBudget, witchSim.actionsLeft);
    const heroSim = new PlanSimState(state, 'hero');
    assert.equal(assessHeroBoard(heroSim).totalBudget, heroSim.actionsLeft);
  });

  test('easy never floors below 1 planned action', () => {
    const state = freshState('easy');
    const sim = new PlanSimState(state, 'witch');
    sim.actionsLeft = 1;  // minimal budget round
    assert.equal(assessBoard(sim).totalBudget, 1);
  });
});

describe('AI difficulty persistence', () => {
  test('aiDifficulty survives serialize → deserialize', () => {
    const state = freshState('hard');
    const restored = deserializeState(serializeState(state));
    assert.equal(restored.aiDifficulty, 'hard');
  });

  test('legacy snapshots without the field default to normal', () => {
    const snap = serializeState(freshState('hard'));
    delete snap.aiDifficulty;
    assert.equal(deserializeState(snap).aiDifficulty, 'normal');
  });
});
