// Skirmish opponent randomization: picking a Day champion should face a random
// Night leader (and vice-versa). This covers the two load-bearing facts — the
// side rosters are disjoint + non-empty (so a random opposite-side pick is
// always a valid enemy) and swapLeaderToFaction re-leaders the AI side.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

let GameState, getFactionsForSide, getFaction;
before(async () => {
  await import('../src/ai-engine.js');            // registers factions
  ({ GameState } = await import('../src/game.js'));
  ({ getFactionsForSide, getFaction } = await import('../src/factions.js'));
});

describe('skirmish opponent selection', () => {
  test('day and night rosters are non-empty and disjoint', () => {
    const day = getFactionsForSide('day').map(f => f.id);
    const night = getFactionsForSide('night').map(f => f.id);
    assert.ok(day.length >= 1, 'day roster non-empty');
    assert.ok(night.length >= 1, 'night roster non-empty');
    assert.ok(day.every(id => !night.includes(id)), 'no faction is on both sides');
    // The opponent of a Day pick is drawn from `night`, so every night faction's
    // side really is 'night' (and vice-versa).
    assert.ok(night.every(id => getFaction(id)?.side === 'night'));
    assert.ok(day.every(id => getFaction(id)?.side === 'day'));
  });

  test('swapLeaderToFaction re-leaders the AI (night) side to each night faction', () => {
    for (const id of getFactionsForSide('night').map(f => f.id)) {
      const state = new GameState(true, true);
      if (!state.witch) continue;                 // rare fenced map — skip
      state.swapLeaderToFaction('night', id);
      // The default leader carries no explicit factionId (only an actual swap
      // sets it), so identify the faction by the leader's entity type.
      assert.equal(state.witch.type, getFaction(id).leaderType, `night leader is ${id}`);
    }
  });
});
