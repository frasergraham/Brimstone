// Tests for per-unit plan grouping and interleaving helpers in src/planner.js.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { groupPlanByEntity, interleavePlan, PlanActionType } from '../src/planner.js';

// ── groupPlanByEntity ────────────────────────────────────────────────────────

describe('groupPlanByEntity', () => {
  test('groups flat plan by entityId', () => {
    const plan = [
      { type: PlanActionType.MOVE, entityId: 'a', toCol: 1, toRow: 0 },
      { type: PlanActionType.MOVE, entityId: 'b', toCol: 2, toRow: 0 },
      { type: PlanActionType.MOVE, entityId: 'a', toCol: 3, toRow: 0 },
    ];
    const grouped = groupPlanByEntity(plan);
    assert.equal(grouped.size, 2);
    assert.equal(grouped.get('a').length, 2);
    assert.equal(grouped.get('b').length, 1);
  });

  test('preserves per-entity order', () => {
    const plan = [
      { type: PlanActionType.MOVE, entityId: 'a', toCol: 1, toRow: 0 },
      { type: PlanActionType.EXPLORE, entityId: 'a' },
      { type: PlanActionType.MOVE, entityId: 'a', toCol: 2, toRow: 0 },
    ];
    const grouped = groupPlanByEntity(plan);
    const aQueue = grouped.get('a');
    assert.equal(aQueue[0].type, PlanActionType.MOVE);
    assert.equal(aQueue[0].toCol, 1);
    assert.equal(aQueue[1].type, PlanActionType.EXPLORE);
    assert.equal(aQueue[2].type, PlanActionType.MOVE);
    assert.equal(aQueue[2].toCol, 2);
  });

  test('returns empty map for null/empty input', () => {
    assert.equal(groupPlanByEntity(null).size, 0);
    assert.equal(groupPlanByEntity([]).size, 0);
  });
});

// ── interleavePlan ───────────────────────────────────────────────────────────

describe('interleavePlan', () => {
  test('interleaves actions by step index', () => {
    const unitPlans = new Map([
      ['a', [
        { type: PlanActionType.MOVE, entityId: 'a', toCol: 1, toRow: 0 },
        { type: PlanActionType.MOVE, entityId: 'a', toCol: 2, toRow: 0 },
      ]],
      ['b', [
        { type: PlanActionType.EXPLORE, entityId: 'b' },
        { type: PlanActionType.EXPLORE, entityId: 'b' },
      ]],
    ]);
    const flat = interleavePlan(unitPlans);
    assert.equal(flat.length, 4);
    // Step 0: a's action 0, b's action 0
    assert.equal(flat[0].entityId, 'a');
    assert.equal(flat[1].entityId, 'b');
    // Step 1: a's action 1, b's action 1
    assert.equal(flat[2].entityId, 'a');
    assert.equal(flat[3].entityId, 'b');
  });

  test('handles unequal queue lengths', () => {
    const unitPlans = new Map([
      ['a', [
        { type: PlanActionType.MOVE, entityId: 'a', toCol: 1, toRow: 0 },
        { type: PlanActionType.MOVE, entityId: 'a', toCol: 2, toRow: 0 },
        { type: PlanActionType.MOVE, entityId: 'a', toCol: 3, toRow: 0 },
      ]],
      ['b', [
        { type: PlanActionType.EXPLORE, entityId: 'b' },
      ]],
    ]);
    const flat = interleavePlan(unitPlans);
    assert.equal(flat.length, 4);
    // Step 0: a[0], b[0]
    assert.equal(flat[0].entityId, 'a');
    assert.equal(flat[1].entityId, 'b');
    // Step 1: a[1] only (b is done)
    assert.equal(flat[2].entityId, 'a');
    // Step 2: a[2]
    assert.equal(flat[3].entityId, 'a');
  });

  test('returns empty array for empty map', () => {
    assert.deepEqual(interleavePlan(new Map()), []);
  });

  test('single unit is returned as-is', () => {
    const unitPlans = new Map([
      ['x', [
        { type: PlanActionType.MOVE, entityId: 'x', toCol: 1, toRow: 0 },
        { type: PlanActionType.EXPLORE, entityId: 'x' },
      ]],
    ]);
    const flat = interleavePlan(unitPlans);
    assert.equal(flat.length, 2);
    assert.equal(flat[0].type, PlanActionType.MOVE);
    assert.equal(flat[1].type, PlanActionType.EXPLORE);
  });

  test('roundtrip: group then interleave preserves all actions', () => {
    const original = [
      { type: PlanActionType.MOVE, entityId: 'a', toCol: 1, toRow: 0 },
      { type: PlanActionType.MOVE, entityId: 'b', toCol: 2, toRow: 0 },
      { type: PlanActionType.EXPLORE, entityId: 'a' },
    ];
    const grouped = groupPlanByEntity(original);
    const interleaved = interleavePlan(grouped);
    assert.equal(interleaved.length, 3, 'All actions preserved');
    // a's actions should maintain relative order
    const aActions = interleaved.filter(a => a.entityId === 'a');
    assert.equal(aActions[0].type, PlanActionType.MOVE);
    assert.equal(aActions[1].type, PlanActionType.EXPLORE);
  });
});
