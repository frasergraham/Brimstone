// Tests for the campaign condition registry (src/campaign/condition-registry.js).
// Verifies that `notHoldingAllNodes` resolves by name and behaves identically to
// the original inline closure from calebs-hollow-prologue.js.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { CONDITIONS, resolveCondition } from '../src/campaign/condition-registry.js';
import { countHeldNodes } from '../src/game.js';

// Two single-hex node objectives at fixed positions. `heroAt`/`witchAt` list
// the node hexes that faction currently occupies.
function makeState(heroAt, witchAt) {
  const witchObjectives = [
    { col: 2, row: 2, hexes: [{ col: 2, row: 2 }] },
    { col: 6, row: 6, hexes: [{ col: 6, row: 6 }] },
  ];
  const entities = [];
  for (const { col, row } of heroAt) {
    entities.push({ owner: 'hero', col, row, alive: true });
  }
  for (const { col, row } of witchAt) {
    entities.push({ owner: 'witch', col, row, alive: true });
  }
  return { witchObjectives, entities };
}

describe('condition-registry', () => {
  test('CONDITIONS exposes notHoldingAllNodes', () => {
    assert.equal(typeof CONDITIONS.notHoldingAllNodes, 'function');
  });

  test('resolveCondition returns the predicate by name', () => {
    assert.equal(resolveCondition('notHoldingAllNodes'), CONDITIONS.notHoldingAllNodes);
  });

  test('resolveCondition returns null for unknown / empty names', () => {
    assert.equal(resolveCondition('doesNotExist'), null);
    assert.equal(resolveCondition(''), null);
    assert.equal(resolveCondition(null), null);
    assert.equal(resolveCondition(undefined), null);
  });

  test('notHoldingAllNodes — true when not every node is hero-held', () => {
    // Hero on node A only; node B uncontrolled.
    const state = makeState([{ col: 2, row: 2 }], []);
    assert.equal(CONDITIONS.notHoldingAllNodes(state), true);
  });

  test('notHoldingAllNodes — false when hero holds all nodes', () => {
    const state = makeState([{ col: 2, row: 2 }, { col: 6, row: 6 }], []);
    assert.equal(CONDITIONS.notHoldingAllNodes(state), false);
  });

  test('notHoldingAllNodes matches the original inline closure exactly', () => {
    // Replicate the original closure and compare across several boards.
    const original = (state) =>
      countHeldNodes('hero', state.witchObjectives, state.entities)
        !== state.witchObjectives.length;

    const boards = [
      makeState([], []),
      makeState([{ col: 2, row: 2 }], []),
      makeState([{ col: 2, row: 2 }, { col: 6, row: 6 }], []),
      makeState([{ col: 6, row: 6 }], [{ col: 2, row: 2 }]),
    ];
    for (const state of boards) {
      assert.equal(
        CONDITIONS.notHoldingAllNodes(state),
        original(state),
        `mismatch for ${JSON.stringify(state.entities)}`,
      );
    }
  });
});
