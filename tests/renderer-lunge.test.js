// Tests for lunge animation and battle highlight methods on the Renderer.
// Uses a minimal stub that replicates just the data structures — the Renderer
// class itself requires a real canvas (DOM) and cannot be instantiated here.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

// ── Minimal renderer stub ──────────────────────────────────────────────────────
// Replicates only the fields and methods under test.

function makeRendererStub() {
  return {
    _lungeAnims:             [],
    _battleCombatantHexes:   [],
    _battleAllyHexes:        [],
    _startAnimLoopCalled:    false,

    // copied logic from Renderer
    addLungeAnim(entityId, fromCol, fromRow, toCol, toRow, entityType, owner, title = null) {
      // stub _toCanvas: just return {x: col*10, y: row*10}
      const from = { x: fromCol * 10, y: fromRow * 10 };
      const to   = { x: toCol   * 10, y: toRow   * 10 };
      const midX = (from.x + to.x) * 0.5;
      const midY = (from.y + to.y) * 0.5;
      this._lungeAnims = this._lungeAnims.filter(a => a.entityId !== entityId);
      this._lungeAnims.push({
        entityId,
        fromX: from.x, fromY: from.y,
        midX, midY,
        startTime: Date.now(),
        duration: 250,
        settled: false,
      });
      this._startAnimLoopCalled = true;
    },

    clearAllLungeAnims() {
      this._lungeAnims = [];
    },

    setBattleHighlights(combatantHexes, allyHexes) {
      this._battleCombatantHexes = combatantHexes ?? [];
      this._battleAllyHexes      = allyHexes ?? [];
    },

    clearBattleHighlights() {
      this._battleCombatantHexes = [];
      this._battleAllyHexes      = [];
    },
  };
}

// ── addLungeAnim ──────────────────────────────────────────────────────────────

describe('addLungeAnim', () => {
  test('adds a lunge entry with correct entity id', () => {
    const r = makeRendererStub();
    r.addLungeAnim('e1', 2, 3, 4, 5, 'hero', 'hero', null);
    assert.equal(r._lungeAnims.length, 1);
    assert.equal(r._lungeAnims[0].entityId, 'e1');
  });

  test('midpoint is halfway between from and to canvas positions', () => {
    const r = makeRendererStub();
    r.addLungeAnim('e1', 0, 0, 10, 0, 'hero', 'hero', null);
    const a = r._lungeAnims[0];
    assert.equal(a.midX, (a.fromX + 10 * 10) / 2);
  });

  test('replaces an existing lunge for the same entity', () => {
    const r = makeRendererStub();
    r.addLungeAnim('e1', 0, 0, 2, 0, 'hero', 'hero');
    r.addLungeAnim('e1', 1, 1, 3, 1, 'hero', 'hero');
    assert.equal(r._lungeAnims.length, 1, 'Should replace, not append');
    assert.equal(r._lungeAnims[0].fromX, 1 * 10);
  });

  test('two different entities can have simultaneous lunge anims', () => {
    const r = makeRendererStub();
    r.addLungeAnim('e1', 0, 0, 2, 0, 'hero',  'hero');
    r.addLungeAnim('e2', 5, 5, 3, 5, 'witch', 'witch');
    assert.equal(r._lungeAnims.length, 2);
  });

  test('starts the animation loop', () => {
    const r = makeRendererStub();
    r.addLungeAnim('e1', 0, 0, 2, 0, 'hero', 'hero');
    assert.equal(r._startAnimLoopCalled, true);
  });
});

describe('clearAllLungeAnims', () => {
  test('removes all lunge anims', () => {
    const r = makeRendererStub();
    r.addLungeAnim('e1', 0, 0, 1, 0, 'hero', 'hero');
    r.addLungeAnim('e2', 2, 0, 3, 0, 'witch', 'witch');
    r.clearAllLungeAnims();
    assert.equal(r._lungeAnims.length, 0);
  });

  test('is idempotent when called on empty array', () => {
    const r = makeRendererStub();
    r.clearAllLungeAnims();
    assert.equal(r._lungeAnims.length, 0);
  });
});

// ── setBattleHighlights / clearBattleHighlights ───────────────────────────────

describe('setBattleHighlights', () => {
  test('stores combatant and ally hex arrays', () => {
    const r = makeRendererStub();
    r.setBattleHighlights(
      [{ col: 3, row: 4 }, { col: 5, row: 6 }],
      [{ col: 2, row: 4 }],
    );
    assert.equal(r._battleCombatantHexes.length, 2);
    assert.equal(r._battleAllyHexes.length, 1);
    assert.equal(r._battleCombatantHexes[0].col, 3);
  });

  test('null arrays default to empty', () => {
    const r = makeRendererStub();
    r.setBattleHighlights(null, null);
    assert.equal(r._battleCombatantHexes.length, 0);
    assert.equal(r._battleAllyHexes.length, 0);
  });
});

describe('clearBattleHighlights', () => {
  test('empties both highlight arrays', () => {
    const r = makeRendererStub();
    r.setBattleHighlights([{ col: 1, row: 2 }], [{ col: 3, row: 4 }]);
    r.clearBattleHighlights();
    assert.equal(r._battleCombatantHexes.length, 0);
    assert.equal(r._battleAllyHexes.length, 0);
  });
});
