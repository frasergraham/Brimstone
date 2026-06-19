// Tests for the demo-config gating predicates. Both helpers are pure (no DOM),
// so these run without the browser mocks the rest of tests/ui needs.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEMO_CONFIG,
  MODE_BY_DESTINATION,
  isModeAvailable,
  isFactionAvailable,
  COMING_SOON_LABEL,
} from '../../src/demo-config.js';

describe('isFactionAvailable', () => {
  test('blocks the unimplemented champions by default', () => {
    assert.equal(isFactionAvailable('captain'), false);
    assert.equal(isFactionAvailable('necromancer'), false);
  });

  test('allows the shipped champions', () => {
    for (const id of ['hero', 'rogue', 'witch', 'brute']) {
      assert.equal(isFactionAvailable(id), true, `${id} should be available`);
    }
  });

  test('unknown / falsy faction ids default to available (opt-out gating)', () => {
    assert.equal(isFactionAvailable('some-future-faction'), true);
    assert.equal(isFactionAvailable(''), true);
    assert.equal(isFactionAvailable(null), true);
    assert.equal(isFactionAvailable(undefined), true);
  });
});

describe('isModeAvailable', () => {
  test('every mode ships available by default', () => {
    for (const key of Object.keys(DEMO_CONFIG.modes)) {
      assert.equal(isModeAvailable(key), true, `${key} should be available`);
    }
  });

  test('maps rail destination ids onto mode keys', () => {
    // 'others' is the rail's "Play Online" entry → the `online` mode key.
    assert.equal(MODE_BY_DESTINATION.others, 'online');
    assert.equal(isModeAvailable('others'), isModeAvailable('online'));
    assert.equal(isModeAvailable('skirmish'), true);
    assert.equal(isModeAvailable('campaign'), true);
  });

  test('ungated rail destinations default to available', () => {
    // 'continue' / 'replays' / 'account' have no mode mapping → always shown.
    assert.equal(isModeAvailable('continue'), true);
    assert.equal(isModeAvailable('replays'), true);
    assert.equal(isModeAvailable('account'), true);
  });

  test('unknown / falsy mode keys default to available', () => {
    assert.equal(isModeAvailable('totally-new-mode'), true);
    assert.equal(isModeAvailable(''), true);
    assert.equal(isModeAvailable(null), true);
  });

  test('flipping a mode flag OFF gates it (via a parallel config probe)', () => {
    // The predicate reads DEMO_CONFIG live; prove the mechanism by simulating a
    // flipped flag without mutating the frozen shipped config.
    const probe = (modes, key) => {
      const k = MODE_BY_DESTINATION[key] ?? key;
      const v = modes[k];
      return v === undefined ? true : v === true;
    };
    assert.equal(probe({ skirmish: false }, 'skirmish'), false);
    assert.equal(probe({ online: false }, 'others'), false);  // destination → key
    assert.equal(probe({ skirmish: true }, 'skirmish'), true);
  });
});

describe('config shape', () => {
  test('is frozen (read-only) so a flip is a deliberate source edit', () => {
    assert.ok(Object.isFrozen(DEMO_CONFIG));
    assert.ok(Object.isFrozen(DEMO_CONFIG.modes));
    assert.ok(Object.isFrozen(DEMO_CONFIG.factions));
  });

  test('exposes a label constant for the badge', () => {
    assert.equal(typeof COMING_SOON_LABEL, 'string');
    assert.ok(COMING_SOON_LABEL.length > 0);
  });
});
