// Tests for the 5-mode speed decision logic used in _animateResolutionSteps.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

// Mirrors the speed decision logic from src/main.js
function getSpeedDecision(speed, result, significant, humanFaction, eventFaction) {
  const isKill = !!result?.killed;
  const showFullDialog = speed === 'full'
    ? (result?.damage > 0 || result?.counterDmg > 0 || isKill)
    : speed === 'basic'
      ? (significant && eventFaction === humanFaction)
      : speed === 'cinematic'
        ? significant
        : speed === 'fast'
          ? isKill
          : false; // instant: never

  const shouldZoom = speed === 'full'
    ? true
    : (speed === 'basic' || speed === 'cinematic') && significant;

  return { showFullDialog, shouldZoom };
}

describe('speed mode: full', () => {
  test('any damage → show dialog', () => {
    const { showFullDialog } = getSpeedDecision('full', { damage: 1 }, false, 'hero', 'witch');
    assert.equal(showFullDialog, true);
  });

  test('counter damage alone → show dialog', () => {
    const { showFullDialog } = getSpeedDecision('full', { damage: 0, counterDmg: 1 }, false, 'hero', 'hero');
    assert.equal(showFullDialog, true);
  });

  test('kill → show dialog', () => {
    const { showFullDialog } = getSpeedDecision('full', { killed: true, damage: 0 }, false, null, 'hero');
    assert.equal(showFullDialog, true);
  });

  test('no damage, no kill → no dialog', () => {
    const { showFullDialog } = getSpeedDecision('full', { damage: 0, counterDmg: 0 }, false, 'hero', 'hero');
    assert.equal(showFullDialog, false);
  });

  test('always zooms regardless of significance', () => {
    const { shouldZoom } = getSpeedDecision('full', { damage: 1 }, false, null, 'witch');
    assert.equal(shouldZoom, true);
  });

  test('no damage → still zooms', () => {
    const { shouldZoom } = getSpeedDecision('full', { damage: 0 }, false, null, 'hero');
    assert.equal(shouldZoom, true);
  });
});

describe('speed mode: basic', () => {
  test('significant + same faction → dialog', () => {
    const { showFullDialog } = getSpeedDecision('basic', { damage: 1 }, true, 'hero', 'hero');
    assert.equal(showFullDialog, true);
  });

  test('significant + opponent faction → no dialog', () => {
    const { showFullDialog } = getSpeedDecision('basic', { damage: 1 }, true, 'hero', 'witch');
    assert.equal(showFullDialog, false);
  });

  test('not significant → no dialog even for own faction', () => {
    const { showFullDialog } = getSpeedDecision('basic', { damage: 0 }, false, 'hero', 'hero');
    assert.equal(showFullDialog, false);
  });

  test('significant → zooms', () => {
    const { shouldZoom } = getSpeedDecision('basic', {}, true, 'hero', 'witch');
    assert.equal(shouldZoom, true);
  });

  test('not significant → no zoom', () => {
    const { shouldZoom } = getSpeedDecision('basic', {}, false, 'hero', 'hero');
    assert.equal(shouldZoom, false);
  });
});

describe('speed mode: cinematic', () => {
  test('significant → dialog', () => {
    const { showFullDialog } = getSpeedDecision('cinematic', { damage: 1 }, true, 'hero', 'witch');
    assert.equal(showFullDialog, true);
  });

  test('not significant → no dialog', () => {
    const { showFullDialog } = getSpeedDecision('cinematic', { damage: 0 }, false, 'hero', 'hero');
    assert.equal(showFullDialog, false);
  });

  test('significant → zooms', () => {
    const { shouldZoom } = getSpeedDecision('cinematic', {}, true, null, null);
    assert.equal(shouldZoom, true);
  });
});

describe('speed mode: fast', () => {
  test('kill → dialog', () => {
    const { showFullDialog } = getSpeedDecision('fast', { killed: true, damage: 2 }, true, 'hero', 'hero');
    assert.equal(showFullDialog, true);
  });

  test('no kill → no dialog (even if significant)', () => {
    const { showFullDialog } = getSpeedDecision('fast', { killed: false, damage: 2 }, true, 'hero', 'hero');
    assert.equal(showFullDialog, false);
  });

  test('never zooms', () => {
    const { shouldZoom } = getSpeedDecision('fast', { damage: 1 }, true, 'hero', 'hero');
    assert.equal(shouldZoom, false);
  });
});

describe('speed mode: instant', () => {
  test('never shows dialog — kill', () => {
    const { showFullDialog } = getSpeedDecision('instant', { killed: true, damage: 5 }, true, 'hero', 'hero');
    assert.equal(showFullDialog, false);
  });

  test('never shows dialog — hero hit', () => {
    const { showFullDialog } = getSpeedDecision('instant', { damage: 3 }, true, 'hero', 'hero');
    assert.equal(showFullDialog, false);
  });

  test('never zooms', () => {
    const { shouldZoom } = getSpeedDecision('instant', { damage: 10 }, true, 'hero', 'hero');
    assert.equal(shouldZoom, false);
  });
});
