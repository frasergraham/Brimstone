// Tests for UI map controls optimizations:
// - Chronicle default mode on small screens
// - Diamond budget capping in turn info
// - Zoom-to-fit behavior with selected entity

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { headerTitleState } from '../src/ui.js';

// ── Header title: exactly three canonical states ────────────────────────────

describe('headerTitleState — the top bar shows one of three titles', () => {
  test('building a plan → PLANNING', () => {
    assert.equal(headerTitleState({ planMode: true, planSubmitted: false }), 'PLANNING');
  });

  test('plan locked, awaiting opponents → WAITING', () => {
    assert.equal(headerTitleState({ planMode: true, planSubmitted: true }), 'WAITING');
  });

  test('not planning (resolving / replay / summary) → RESOLUTION', () => {
    assert.equal(headerTitleState({ planMode: false, planSubmitted: false }), 'RESOLUTION');
    // planSubmitted is stale-sticky across rounds; without planMode it's still RESOLUTION.
    assert.equal(headerTitleState({ planMode: false, planSubmitted: true }), 'RESOLUTION');
  });

  test('defaults to RESOLUTION with no args', () => {
    assert.equal(headerTitleState(), 'RESOLUTION');
    assert.equal(headerTitleState({}), 'RESOLUTION');
  });
});

// ── Chronicle default mode based on screen width ────────────────────────────

function defaultChronicleMode(screenWidth) {
  return screenWidth <= 768 ? 'none' : 'mini';
}

describe('chronicle default mode by screen width', () => {
  test('small screen (320px) starts hidden', () => {
    assert.equal(defaultChronicleMode(320), 'none');
  });

  test('medium-small screen (768px) starts hidden', () => {
    assert.equal(defaultChronicleMode(768), 'none');
  });

  test('standard screen (1024px) starts with mini', () => {
    assert.equal(defaultChronicleMode(1024), 'mini');
  });

  test('large screen (1920px) starts with mini', () => {
    assert.equal(defaultChronicleMode(1920), 'mini');
  });
});

// ── Diamond budget capping ──────────────────────────────────────────────────

// Mirrors the logic in _renderTurnInfo for planning-phase diamonds
function computeDiamonds(budget, used) {
  const capped   = Math.min(used, budget);
  const filled   = Math.max(0, budget - capped);
  const empty    = capped;
  return { filled, empty, total: filled + empty };
}

describe('action diamonds never exceed budget', () => {
  test('used within budget: shows correct split', () => {
    const d = computeDiamonds(4, 2);
    assert.equal(d.filled, 2);
    assert.equal(d.empty, 2);
    assert.equal(d.total, 4);
  });

  test('all budget used: all diamonds empty', () => {
    const d = computeDiamonds(3, 3);
    assert.equal(d.filled, 0);
    assert.equal(d.empty, 3);
    assert.equal(d.total, 3);
  });

  test('no actions used: all diamonds filled', () => {
    const d = computeDiamonds(5, 0);
    assert.equal(d.filled, 5);
    assert.equal(d.empty, 0);
    assert.equal(d.total, 5);
  });

  test('used exceeds budget: total still equals budget', () => {
    const d = computeDiamonds(3, 5);
    assert.equal(d.total, 3, 'total diamonds must not exceed budget');
    assert.equal(d.filled, 0);
    assert.equal(d.empty, 3);
  });

  test('used exceeds budget by 1: total still equals budget', () => {
    const d = computeDiamonds(4, 5);
    assert.equal(d.total, 4);
    assert.equal(d.filled, 0);
    assert.equal(d.empty, 4);
  });

  test('zero budget: no diamonds shown', () => {
    const d = computeDiamonds(0, 0);
    assert.equal(d.total, 0);
  });
});

// ── Zoom-me (⊙) target selection ────────────────────────────────────────────

// Mirrors the decision logic in the zoom-me click handler:
// - selected alive entity → zoom to that unit
// - otherwise → frame all player's units
function zoomMeTarget(selectedEntity) {
  if (selectedEntity && selectedEntity.alive) {
    return 'selected-unit';
  }
  return 'all-units';
}

describe('zoom-me (⊙) target selection', () => {
  test('no selected entity: frames all player units', () => {
    assert.equal(zoomMeTarget(null), 'all-units');
  });

  test('selected alive entity: zooms to that unit', () => {
    assert.equal(zoomMeTarget({ alive: true, col: 5, row: 3 }), 'selected-unit');
  });

  test('selected dead entity: frames all player units', () => {
    assert.equal(zoomMeTarget({ alive: false, col: 5, row: 3 }), 'all-units');
  });

  test('undefined entity: frames all player units', () => {
    assert.equal(zoomMeTarget(undefined), 'all-units');
  });
});
