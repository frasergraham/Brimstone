// Tests for replay bugs: getter-only properties on MirrorState/Entity causing
// "Attempted to assign to readonly property" during Object.assign.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GameState } from '../src/game.js';
import { Entity } from '../src/entities.js';
import { serializeState, deserializeState } from '../server/state-sync.js';

// ── MirrorState getter-only conflict ─────────────────────────────────────────

describe('replay state swap — MirrorState readonly properties', () => {
  // Simulates the online mode scenario where the module-level `state` is a
  // MirrorState (with getter-only `winner`, `gameOver`, `actionsAvailable`)
  // and _replayFullGame restores a deserialized GameState.

  test('Object.assign from GameState to MirrorState throws on getter-only props', () => {
    // MirrorState-like object with getter-only `winner`
    class FakeMirror {
      constructor() { this._winner = 'hero'; }
      get winner() { return this._winner; }
      get gameOver() { return this._winner !== null; }
    }
    const mirror = new FakeMirror();
    const gs = new GameState(true, true);
    gs.winner = 'witch';

    // Object.assign tries to set mirror.winner = gs.winner → throws
    assert.throws(() => {
      Object.assign(mirror, gs);
    }, TypeError, 'assigning to getter-only winner should throw');
  });

  test('replacing state avoids getter-only conflict', () => {
    // This mirrors the fix: _swapState(preState) instead of Object.assign
    const gs = new GameState(true, true);
    const snap = serializeState(gs);
    const restored = deserializeState(snap);

    // Simulates _swapState: just replace the reference
    let state = restored;
    assert.ok(state.tiles instanceof Map, 'tiles should be a Map');
    assert.ok(state.entities.length > 0, 'entities should be restored');
    assert.equal(state.winner, null, 'winner should be null for fresh game');
    state.fogOfWar = 'none'; // should not throw
    assert.equal(state.fogOfWar, 'none');
  });
});

// ── Entity getter-only conflict (JSON-parsed finalEntities) ──────────────────

describe('replay finalEntities — Entity getter-only properties', () => {
  test('Object.assign from plain object with alive/displayName to Entity throws', () => {
    const entity = Object.create(Entity.prototype);
    Object.assign(entity, {
      id: 'e1', type: 'hero', owner: 'hero', col: 0, row: 0,
      hp: 10, maxHp: 10, attack: 3, defense: 2, items: {},
    });

    // Plain object from JSON.parse (like serialized finalEntities)
    const plainObj = { id: 'e1', hp: 5, alive: false, displayName: 'Test Hero' };

    // Object.assign tries to set entity.alive = false → throws
    assert.throws(() => {
      Object.assign(entity, plainObj);
    }, TypeError, 'assigning to getter-only alive should throw');
  });

  test('stripping getter-derived props before Object.assign succeeds', () => {
    const entity = Object.create(Entity.prototype);
    Object.assign(entity, {
      id: 'e1', type: 'hero', owner: 'hero', col: 0, row: 0,
      hp: 10, maxHp: 10, attack: 3, defense: 2, items: {},
    });

    const plainObj = { id: 'e1', hp: 5, alive: false, displayName: 'Test Hero' };
    delete plainObj.alive;
    delete plainObj.displayName;

    // Should not throw
    Object.assign(entity, plainObj);
    assert.equal(entity.hp, 5, 'hp should be updated');
    assert.equal(entity.alive, true, 'alive getter derives from hp (5 > 0)');
  });
});
