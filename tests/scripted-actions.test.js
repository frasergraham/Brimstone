// Tests for scripted NPC actions (src/campaign/scripted-actions.js):
// validation rejections plus the executor's spawn/move/despawn/wait behavior
// against a stub state and a stub renderer.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateScriptedActions, runScriptedActions, spawnNpcEntity,
} from '../src/campaign/scripted-actions.js';

function stubState() {
  let nextId = 1;
  return {
    entities: [],
    usedRosterIndices: new Set(),
    allocateEntityId: () => nextId++,
    markRosterUsedByName() {},
  };
}

function stubRenderer() {
  const calls = [];
  return {
    calls,
    is3D: true,
    addMoveAnim(...args) { calls.push(['addMoveAnim', args]); },
    async waitForAnimations() { calls.push(['waitForAnimations']); },
  };
}

const NPC = { id: 'john', survivorName: "John O'Connor", col: 3, row: 6, displayTitle: 'Innkeeper' };

describe('validateScriptedActions', () => {
  const ext = { cols: 10, rows: 10 };

  test('accepts a well-formed list', () => {
    validateScriptedActions([
      { action: 'spawn', npc: 'john', col: 3, row: 6 },
      { action: 'wait', ms: 200 },
      { action: 'move', npc: 'john', path: [{ col: 3, row: 5 }, { col: 2, row: 5 }] },
      { action: 'despawn', npc: 'john' },
    ], { ext, npcIds: ['john'] });
  });

  test('rejects unknown action, unknown npc, missing npc', () => {
    assert.throws(() => validateScriptedActions([{ action: 'dance', npc: 'john' }]), /unknown action/);
    assert.throws(
      () => validateScriptedActions([{ action: 'despawn', npc: 'ghost' }], { npcIds: ['john'] }),
      /unknown npc/,
    );
    assert.throws(() => validateScriptedActions([{ action: 'move', path: [{ col: 1, row: 1 }] }]), /needs an npc/);
  });

  test('rejects out-of-bounds hexes and empty paths', () => {
    assert.throws(
      () => validateScriptedActions([{ action: 'spawn', npc: 'j', col: 99, row: 1 }], { ext }),
      /out of bounds/,
    );
    assert.throws(
      () => validateScriptedActions([{ action: 'move', npc: 'j', path: [{ col: 1, row: -1 }] }], { ext }),
      /out of bounds/,
    );
    assert.throws(() => validateScriptedActions([{ action: 'move', npc: 'j', path: [] }]), /non-empty path/);
  });

  test('rejects bad wait and non-array input', () => {
    assert.throws(() => validateScriptedActions([{ action: 'wait' }]), /ms >= 0/);
    assert.throws(() => validateScriptedActions({}), /must be an array/);
  });
});

describe('spawnNpcEntity', () => {
  test('creates a tagged hero-owned survivor with the forced roster name', () => {
    const state = stubState();
    const e = spawnNpcEntity(NPC, state);
    assert.equal(e.isNpc, true);
    assert.equal(e.npcId, 'john');
    assert.equal(e.owner, 'hero');
    assert.equal(e.name, "John O'Connor");
    assert.equal(e.title, 'Innkeeper');
    assert.deepEqual([e.col, e.row], [3, 6]);
    assert.ok(state.entities.includes(e));
  });
});

describe('runScriptedActions', () => {
  test('spawn → move → despawn sequence mutates state and animates', async () => {
    const state = stubState();
    const renderer = stubRenderer();
    await runScriptedActions([
      { action: 'spawn', npc: 'john', col: 3, row: 6 },
      { action: 'move', npc: 'john', path: [{ col: 3, row: 5 }, { col: 2, row: 5 }] },
      { action: 'despawn', npc: 'john' },
    ], { state, renderer, npcDefs: [NPC], instant: false });

    assert.equal(state.entities.length, 0); // despawned at the end
    const move = renderer.calls.find(c => c[0] === 'addMoveAnim');
    assert.ok(move, 'addMoveAnim called');
    // 11-arg shape: id, fromCol, fromRow, toCol, toRow, type, owner, title, path, fromSlot, toSlot
    assert.equal(move[1].length, 11);
    assert.deepEqual(move[1].slice(1, 5), [3, 6, 2, 5]);
    assert.ok(renderer.calls.some(c => c[0] === 'waitForAnimations'));
  });

  test('move updates entity position to path end', async () => {
    const state = stubState();
    spawnNpcEntity(NPC, state);
    await runScriptedActions(
      [{ action: 'move', npc: 'john', path: [{ col: 4, row: 4 }] }],
      { state, renderer: null, instant: true },
    );
    assert.deepEqual([state.entities[0].col, state.entities[0].row], [4, 4]);
  });

  test('instant mode skips animations and waits', async () => {
    const state = stubState();
    const renderer = stubRenderer();
    spawnNpcEntity(NPC, state);
    await runScriptedActions([
      { action: 'wait', ms: 60000 }, // would hang the test if not skipped
      { action: 'move', npc: 'john', path: [{ col: 4, row: 4 }] },
      { action: 'despawn', npc: 'john' },
    ], { state, renderer, instant: true });
    assert.equal(renderer.calls.length, 0);
    assert.equal(state.entities.length, 0);
  });

  test('missing actor is skipped without crashing; spawn dedupes', async () => {
    const state = stubState();
    await runScriptedActions(
      [{ action: 'move', npc: 'ghost', path: [{ col: 1, row: 1 }] }],
      { state, instant: true },
    );
    spawnNpcEntity(NPC, state);
    await runScriptedActions(
      [{ action: 'spawn', npc: 'john', col: 0, row: 0 }],
      { state, npcDefs: [NPC], instant: true },
    );
    assert.equal(state.entities.filter(e => e.npcId === 'john').length, 1);
  });
});
