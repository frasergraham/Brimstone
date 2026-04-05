// Tests for the headless game-state renderer (scripts/game-render.js).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderGameState } from '../scripts/game-render.js';
import { GameState } from '../src/game.js';

describe('renderGameState', () => {
  test('returns a valid PNG buffer for a fresh game state', () => {
    const state = new GameState(true, true, 'skirmish');
    const buf = renderGameState(state);

    assert.ok(Buffer.isBuffer(buf), 'should return a Buffer');
    assert.ok(buf.length > 1000, 'PNG should have non-trivial size');
    // PNG magic bytes: 0x89 0x50 0x4E 0x47
    assert.equal(buf[0], 0x89, 'first byte should be PNG signature');
    assert.equal(buf[1], 0x50, 'second byte should be P');
    assert.equal(buf[2], 0x4E, 'third byte should be N');
    assert.equal(buf[3], 0x47, 'fourth byte should be G');
  });

  test('renders all map sizes without errors', () => {
    for (const size of ['skirmish', 'standard', 'regional']) {
      const state = new GameState(true, true, size);
      const buf = renderGameState(state);
      assert.ok(Buffer.isBuffer(buf), `${size} should produce a Buffer`);
      assert.ok(buf.length > 0, `${size} should produce non-empty output`);
    }
  });

  test('renders correctly after game progresses', async () => {
    const { HeroAIEngine } = await import('../src/hero-ai-engine.js');
    const { WitchAIEngine } = await import('../src/ai-engine.js');
    const { resolvePlans } = await import('../server/resolver.js');

    const state = new GameState(true, true, 'skirmish');
    const witchAI = new WitchAIEngine(state, () => {}, 0);
    const heroAI  = new HeroAIEngine(state, () => {}, 0);

    // Run a few rounds
    for (let i = 0; i < 3; i++) {
      state.startPlanning();
      const heroPlan  = heroAI.generatePlan();
      const witchPlan = witchAI.generatePlan();
      state.submitPlan('hero', heroPlan);
      state.submitPlan('witch', witchPlan);
      resolvePlans(state, state.heroPlan, state.witchPlan);
      state.endRound();
    }

    const buf = renderGameState(state);
    assert.ok(Buffer.isBuffer(buf), 'mid-game state should produce a Buffer');
    assert.ok(buf.length > 1000, 'mid-game PNG should have non-trivial size');
    // Verify PNG header
    assert.equal(buf[0], 0x89);
  });

  test('respects custom hexSize option', () => {
    const state = new GameState(true, true, 'skirmish');
    const small = renderGameState(state, { hexSize: 20 });
    const large = renderGameState(state, { hexSize: 50 });

    assert.ok(Buffer.isBuffer(small));
    assert.ok(Buffer.isBuffer(large));
    // Larger hex size should produce a larger image
    assert.ok(large.length > small.length,
      'larger hexSize should produce a larger PNG');
  });

  test('renders game-over state with winner banner', async () => {
    const { HeroAIEngine } = await import('../src/hero-ai-engine.js');
    const { WitchAIEngine } = await import('../src/ai-engine.js');
    const { resolvePlans } = await import('../server/resolver.js');

    const state = new GameState(true, true, 'skirmish');
    const witchAI = new WitchAIEngine(state, () => {}, 0);
    const heroAI  = new HeroAIEngine(state, () => {}, 0);

    // Run until game over or cap
    let rounds = 0;
    while (!state.gameOver && rounds < 50) {
      state.startPlanning();
      state.submitPlan('hero', heroAI.generatePlan());
      state.submitPlan('witch', witchAI.generatePlan());
      resolvePlans(state, state.heroPlan, state.witchPlan);
      state.endRound();
      rounds++;
    }

    const buf = renderGameState(state);
    assert.ok(Buffer.isBuffer(buf), 'game-over state should render');
    assert.ok(buf.length > 1000);
  });
});
