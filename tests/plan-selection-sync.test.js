// Tests the single-subscriber plan-panel selection highlight (PR 3).
//
// The renderer's `onSelectionChange` hook (fired by every setSelection) drives
// UIController._syncPlanSelectionClass, which is the ONE place that toggles the
// `.plan-unit-selected` class on plan-panel unit blocks. This verifies the
// wiring end-to-end with a stub plan-steps element.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  installGlobalMocks,
  createElementsBag,
  makeFakeRenderer,
  makeState,
} from './ui/setup.js';

const { fakeCanvas } = installGlobalMocks();

let UIController;

before(async () => {
  ({ UIController } = await import('../src/ui.js'));
});

// A fake `.plan-unit-block` that records its class set.
function makeBlock(entityId) {
  const cls = new Set();
  return {
    dataset: { entityId },
    classList: {
      toggle(c, force) {
        if (force === true) cls.add(c);
        else if (force === false) cls.delete(c);
        else cls.has(c) ? cls.delete(c) : cls.add(c);
        return cls.has(c);
      },
      contains(c) { return cls.has(c); },
    },
    isSelected() { return cls.has('plan-unit-selected'); },
  };
}

// A fake plan-steps element exposing querySelectorAll('.plan-unit-block').
function makePlanSteps(blocks) {
  return {
    querySelectorAll(sel) { return sel === '.plan-unit-block' ? blocks : []; },
  };
}

function makeUI(blocks) {
  const els = createElementsBag({ 'plan-steps': makePlanSteps(blocks) });
  const renderer = makeFakeRenderer();
  // els is the 8th constructor arg — wire it so _el('plan-steps') hits our stub.
  const ui = new UIController(fakeCanvas, makeState(), renderer, null, () => {}, null, false, els);
  return { ui, renderer };
}

describe('plan-panel selection highlight (single subscriber)', () => {
  test('UIController wires renderer.onSelectionChange in its constructor', () => {
    const { renderer } = makeUI([]);
    assert.equal(typeof renderer.onSelectionChange, 'function');
  });

  test('selection change toggles .plan-unit-selected on exactly the matching block', () => {
    const blocks = [makeBlock('u1'), makeBlock('u2'), makeBlock('u3')];
    const { ui, renderer } = makeUI(blocks);

    // Simulate selecting unit u2. _selectedEntity is set by ui flow before
    // setSelection fires; the subscriber reads it.
    ui._selectedEntity = { id: 'u2' };
    renderer.setSelection({ entityId: 'u2', hex: { col: 1, row: 1 } });

    assert.equal(blocks[0].isSelected(), false, 'u1 not selected');
    assert.equal(blocks[1].isSelected(), true,  'u2 selected');
    assert.equal(blocks[2].isSelected(), false, 'u3 not selected');
  });

  test('switching selection moves the class to the new block and clears the old', () => {
    const blocks = [makeBlock('u1'), makeBlock('u2')];
    const { ui, renderer } = makeUI(blocks);

    ui._selectedEntity = { id: 'u1' };
    renderer.setSelection({ entityId: 'u1', hex: { col: 1, row: 1 } });
    assert.equal(blocks[0].isSelected(), true);
    assert.equal(blocks[1].isSelected(), false);

    ui._selectedEntity = { id: 'u2' };
    renderer.setSelection({ entityId: 'u2', hex: { col: 2, row: 2 } });
    assert.equal(blocks[0].isSelected(), false, 'old block cleared');
    assert.equal(blocks[1].isSelected(), true,  'new block set');
  });

  test('clearing selection removes the class from all blocks', () => {
    const blocks = [makeBlock('u1'), makeBlock('u2')];
    const { ui, renderer } = makeUI(blocks);

    ui._selectedEntity = { id: 'u1' };
    renderer.setSelection({ entityId: 'u1', hex: { col: 1, row: 1 } });
    assert.equal(blocks[0].isSelected(), true);

    ui._selectedEntity = null;
    renderer.setSelection({ entityId: null, hex: null });
    assert.equal(blocks[0].isSelected(), false);
    assert.equal(blocks[1].isSelected(), false);
  });

  test('selecting a non-plan entity (enemy/tile) clears all plan blocks', () => {
    const blocks = [makeBlock('u1'), makeBlock('u2')];
    const { ui, renderer } = makeUI(blocks);

    ui._selectedEntity = { id: 'u1' };
    renderer.setSelection({ entityId: 'u1', hex: { col: 1, row: 1 } });
    assert.equal(blocks[0].isSelected(), true);

    // Enemy id has no matching plan block → all clear.
    ui._selectedEntity = { id: 'enemy-7' };
    renderer.setSelection({ entityId: 'enemy-7', hex: { col: 3, row: 3 } });
    assert.equal(blocks[0].isSelected(), false);
    assert.equal(blocks[1].isSelected(), false);
  });
});
