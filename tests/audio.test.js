// Tests for the synthesized SFX module:
//   - combat sound selection follows the outcome priority
//     (death > crush > counter > hit > miss)
//   - mute state toggles and reads back
//   - every public entry point is a safe no-op without an AudioContext
//     (this whole suite runs in node, which has none)

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import * as audio from '../src/audio.js';

describe('pickCombatSound outcome priority', () => {
  test('kill wins over everything', () => {
    assert.equal(audio.pickCombatSound({ hit: true, killed: true, damage: 2 }), 'death');
  });
  test('crush on 2+ damage hits', () => {
    assert.equal(audio.pickCombatSound({ hit: true, killed: false, damage: 2 }), 'crush');
  });
  test('plain hit on 1 damage', () => {
    assert.equal(audio.pickCombatSound({ hit: true, killed: false, damage: 1 }), 'hit');
  });
  test('counter on miss with counter damage', () => {
    assert.equal(audio.pickCombatSound({ hit: false, counterDmg: 1 }), 'counter');
  });
  test('miss otherwise', () => {
    assert.equal(audio.pickCombatSound({ hit: false, counterDmg: 0 }), 'miss');
  });
  test('null result is silent', () => {
    assert.equal(audio.pickCombatSound(null), null);
  });
  test('every pickable sound exists in the registry', () => {
    const results = [
      { hit: true, killed: true }, { hit: true, damage: 2 }, { hit: true, damage: 1 },
      { hit: false, counterDmg: 1 }, { hit: false },
    ];
    for (const r of results) {
      assert.ok(audio.SOUND_NAMES.includes(audio.pickCombatSound(r)));
    }
  });
});

describe('mute state', () => {
  test('toggle flips and reads back', () => {
    const start = audio.isMuted();
    assert.equal(audio.toggleMuted(), !start);
    assert.equal(audio.isMuted(), !start);
    audio.setMuted(start);
    assert.equal(audio.isMuted(), start);
  });
});

describe('headless safety', () => {
  test('init/play/playCombat are no-ops without an AudioContext', () => {
    assert.doesNotThrow(() => {
      audio.init();
      audio.play('hit');
      audio.play('nonexistent-sound');
      audio.playCombat({ hit: true, killed: true });
      audio.setMuted(false);
      audio.play('victory');
      audio.setMuted(true);
      audio.setMuted(false);
    });
  });
});
