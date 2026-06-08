// Tests for the 2D renderer's per-frame _playerColorMap cache invalidation key.
//
// draw() rebuilds the ownerId→colour map only when _leaderColorVersion()
// changes, since draw() fires on every hover/selection during planning. This
// pins the helper's contract: stable across entity reordering and unrelated
// (non-leader) entities, but sensitive to any leader ownerId/colour change.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Renderer } from '../src/renderer.js';
import { EntityType } from '../src/entities.js';

const version = (entities) => Renderer.prototype._leaderColorVersion.call(null, entities);

function leader(ownerId, color, type = EntityType.WITCH) {
  return { ownerId, color, type, alive: true };
}

describe('_leaderColorVersion', () => {
  test('two leaders → key encodes both (ownerId=colour) pairs', () => {
    const v = version([leader('p1', '#ff0000'), leader('p2', '#00ff00', EntityType.PALADIN)]);
    assert.match(v, /p1=#ff0000/);
    assert.match(v, /p2=#00ff00/);
  });

  test('order-independent — reordering leaders yields the same key', () => {
    const a = version([leader('p1', '#ff0000'), leader('p2', '#00ff00')]);
    const b = version([leader('p2', '#00ff00'), leader('p1', '#ff0000')]);
    assert.equal(a, b);
  });

  test('changing a leader colour changes the key', () => {
    const a = version([leader('p1', '#ff0000')]);
    const b = version([leader('p1', '#0000ff')]);
    assert.notEqual(a, b);
  });

  test('changing a leader ownerId changes the key', () => {
    const a = version([leader('p1', '#ff0000')]);
    const b = version([leader('p2', '#ff0000')]);
    assert.notEqual(a, b);
  });

  test('non-leader entities are ignored (minion does not perturb the key)', () => {
    const withMinion = version([
      leader('p1', '#ff0000'),
      { ownerId: 'p1', color: '#123456', type: EntityType.MINION, alive: true },
    ]);
    const without = version([leader('p1', '#ff0000')]);
    assert.equal(withMinion, without);
  });

  test('entities lacking colour or ownerId are skipped', () => {
    const v = version([
      leader('p1', '#ff0000'),
      { ownerId: null, color: '#abcdef', type: EntityType.WITCH, alive: true },
      { ownerId: 'p9', color: null, type: EntityType.WITCH, alive: true },
    ]);
    assert.equal(v, 'p1=#ff0000');
  });

  test('empty entity list → empty-string key', () => {
    assert.equal(version([]), '');
  });
});
