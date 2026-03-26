// Tests for personality label rendering in player status panels.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

// Mirrors the PERSONALITY_LABELS map used in ui.js and spectate.html
const PERSONALITY_LABELS = {
  balanced:  'Balanced',
  berserker: 'Berserker',
  sentinel:  'Sentinel',
  scavenger: 'Scavenger',
  hoarder:   'Hoarder',
  swarm:     'Swarm',
};

function playerDisplayName(player) {
  if (!player.isAI) return player.name;
  const label = PERSONALITY_LABELS[player.personality] ?? player.personality ?? 'AI';
  return `${player.name} (${label})`;
}

describe('playerDisplayName — human players', () => {
  test('human player: name only', () => {
    assert.equal(playerDisplayName({ name: 'Alice', isAI: false }), 'Alice');
  });

  test('human player with personality field: personality ignored', () => {
    assert.equal(
      playerDisplayName({ name: 'Bob', isAI: false, personality: 'berserker' }),
      'Bob',
    );
  });
});

describe('playerDisplayName — AI players', () => {
  test('AI balanced → name (Balanced)', () => {
    assert.equal(
      playerDisplayName({ name: 'Alicia', isAI: true, personality: 'balanced' }),
      'Alicia (Balanced)',
    );
  });

  test('AI berserker → name (Berserker)', () => {
    assert.equal(
      playerDisplayName({ name: 'Samuel', isAI: true, personality: 'berserker' }),
      'Samuel (Berserker)',
    );
  });

  test('AI hoarder → name (Hoarder)', () => {
    assert.equal(
      playerDisplayName({ name: 'Witch', isAI: true, personality: 'hoarder' }),
      'Witch (Hoarder)',
    );
  });

  test('AI with unknown personality: uses raw value', () => {
    assert.equal(
      playerDisplayName({ name: 'Golem', isAI: true, personality: 'unknown_type' }),
      'Golem (unknown_type)',
    );
  });

  test('AI with null personality: falls back to "AI"', () => {
    assert.equal(
      playerDisplayName({ name: 'Bot', isAI: true, personality: null }),
      'Bot (AI)',
    );
  });

  test('AI with no personality field: falls back to "AI"', () => {
    assert.equal(
      playerDisplayName({ name: 'Bot', isAI: true }),
      'Bot (AI)',
    );
  });

  test('all known personalities resolve to their display label', () => {
    for (const [key, label] of Object.entries(PERSONALITY_LABELS)) {
      const result = playerDisplayName({ name: 'X', isAI: true, personality: key });
      assert.equal(result, `X (${label})`, `personality '${key}' should map to '${label}'`);
    }
  });
});
