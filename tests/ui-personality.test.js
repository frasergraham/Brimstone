// Tests for player display name rendering in player status panels.
// AI players no longer show personality labels — names are always just p.name.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

function playerDisplayName(player, isMe = false) {
  return isMe ? `${player.name} (you)` : player.name;
}

describe('playerDisplayName — human players', () => {
  test('human player: name only', () => {
    assert.equal(playerDisplayName({ name: 'Alice', isAI: false }), 'Alice');
  });

  test('human player (me): shows (you) suffix', () => {
    assert.equal(playerDisplayName({ name: 'Alice', isAI: false }, true), 'Alice (you)');
  });

  test('human player with personality field: personality ignored', () => {
    assert.equal(
      playerDisplayName({ name: 'Bob', isAI: false, personality: 'berserker' }),
      'Bob',
    );
  });
});

describe('playerDisplayName — AI players', () => {
  test('AI player: name only (no personality suffix)', () => {
    assert.equal(
      playerDisplayName({ name: 'Alicia', isAI: true, personality: 'balanced' }),
      'Alicia',
    );
  });

  test('AI berserker: name only', () => {
    assert.equal(
      playerDisplayName({ name: 'Samuel', isAI: true, personality: 'berserker' }),
      'Samuel',
    );
  });

  test('AI hoarder: name only', () => {
    assert.equal(
      playerDisplayName({ name: 'Witch', isAI: true, personality: 'hoarder' }),
      'Witch',
    );
  });

  test('AI with null personality: name only', () => {
    assert.equal(
      playerDisplayName({ name: 'Bot', isAI: true, personality: null }),
      'Bot',
    );
  });

  test('AI with no personality field: name only', () => {
    assert.equal(
      playerDisplayName({ name: 'Bot', isAI: true }),
      'Bot',
    );
  });
});
