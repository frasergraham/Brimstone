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
        owner,
        fromCol, fromRow, toCol, toRow,
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

    returnAllLungeAnims() {
      const returnDuration = 180;
      for (const a of this._lungeAnims) {
        if (!a.returning) {
          a.settled       = true;
          a.returning     = true;
          a.returnStartTime = Date.now();
          a.returnDuration  = returnDuration;
        }
      }
      this._startAnimLoopCalled = !!this._lungeAnims.length;
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

describe('returnAllLungeAnims', () => {
  test('marks existing lunges as returning', () => {
    const r = makeRendererStub();
    r.addLungeAnim('e1', 0, 0, 2, 0, 'hero', 'hero');
    r._lungeAnims[0].settled = true; // simulate settled state
    r.returnAllLungeAnims();
    assert.equal(r._lungeAnims[0].returning, true);
    assert.equal(typeof r._lungeAnims[0].returnStartTime, 'number');
    assert.equal(r._lungeAnims[0].returnDuration, 180);
  });

  test('does not double-mark already-returning lunges', () => {
    const r = makeRendererStub();
    r.addLungeAnim('e1', 0, 0, 2, 0, 'hero', 'hero');
    r._lungeAnims[0].settled = true;
    r.returnAllLungeAnims();
    const firstReturnStart = r._lungeAnims[0].returnStartTime;
    r.returnAllLungeAnims();
    assert.equal(r._lungeAnims[0].returnStartTime, firstReturnStart);
  });

  test('is a no-op on empty array', () => {
    const r = makeRendererStub();
    r.returnAllLungeAnims(); // should not throw
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

// ── waitForAnimations — pure-logic variant ────────────────────────────────────
// The real method uses requestAnimationFrame (DOM). Test the alive-check logic
// directly using the same predicate extracted to a helper, verifying the
// conditions under which it would resolve vs keep looping.

function isAlive(stub) {
  const now = Date.now();
  return stub._moveAnims.some(a => now < a.startTime + a.duration)
      || stub._flashes.some(f => now < f.endTime)
      || stub._deathAnims.some(a => now < a.startTime + a.duration)
      || stub._lungeAnims.some(a => !a.settled || a.returning);
}

function makeFullStub() {
  return {
    _moveAnims:  [],
    _flashes:    [],
    _deathAnims: [],
    _lungeAnims: [],
    ...makeRendererStub(),
  };
}

describe('waitForAnimations alive-check logic', () => {
  test('no animations → not alive (should resolve immediately)', () => {
    const r = makeFullStub();
    assert.equal(isAlive(r), false);
  });

  test('active flash → alive', () => {
    const r = makeFullStub();
    r._flashes.push({ endTime: Date.now() + 2000 });
    assert.equal(isAlive(r), true);
  });

  test('expired flash → not alive', () => {
    const r = makeFullStub();
    r._flashes.push({ endTime: Date.now() - 1 }); // already expired
    assert.equal(isAlive(r), false);
  });

  test('unsettled lunge → alive', () => {
    const r = makeFullStub();
    r._lungeAnims.push({ settled: false });
    assert.equal(isAlive(r), true);
  });

  test('settled lunge → not alive', () => {
    const r = makeFullStub();
    r._lungeAnims.push({ settled: true, returning: false });
    assert.equal(isAlive(r), false);
  });

  test('returning lunge → alive', () => {
    const r = makeFullStub();
    r._lungeAnims.push({ settled: true, returning: true, returnStartTime: Date.now(), returnDuration: 180 });
    assert.equal(isAlive(r), true);
  });

  test('active death anim → alive', () => {
    const r = makeFullStub();
    r._deathAnims.push({ startTime: Date.now(), duration: 600 });
    assert.equal(isAlive(r), true);
  });

  test('expired death anim → not alive', () => {
    const r = makeFullStub();
    r._deathAnims.push({ startTime: Date.now() - 700, duration: 600 });
    assert.equal(isAlive(r), false);
  });

  test('active move anim → alive', () => {
    const r = makeFullStub();
    r._moveAnims.push({ startTime: Date.now(), duration: 480 });
    assert.equal(isAlive(r), true);
  });
});
