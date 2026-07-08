// Plan-panel summon cost projection — faction-aware spending (regression).
//
// The plan panel walks a projected copy of the shared pool step by step
// (ui-render.js `_advanceProjectedInventory`). That walker used to hard-code
// the witch's summon economics (2 metal → 2 wood → 2 any), so each queued
// NECROMANCER summon (getMinionCost() = 1) over-deducted the projected pool
// by 1. All three projections now route through the single faction-aware
// helper `projectSummonSpend` (src/planner.js).
//
// The test pins the walker through its public entry point, buildPlanStepsHtml:
// a necromancer summon must deduct exactly 1, leaving the pool rich enough
// that a following witch summon still shows its concrete "−2 <metal>" badge.
// (Two night leaders in one plan can't happen in a real game — it's just the
// cheapest observable probe of the walker's running pool.)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPlanStepsHtml } from '../src/ui-render.js';
import { PlanActionType } from '../src/planner.js';

const necro = { id: 'n1', displayName: 'Hexekiel', factionId: 'necromancer', owner: 'witch' };
const witch = { id: 'w1', displayName: 'Griselda', factionId: 'witch',       owner: 'witch' };

test('queued necromancer summon deducts exactly 1 from the projected pool', () => {
  const initialInv = { hero: {}, witch: { metal: { count: 3 } }, entityItems: {} };
  const plan = [
    { type: PlanActionType.SUMMON, entityId: 'n1' },
    { type: PlanActionType.SUMMON, entityId: 'w1' },
  ];
  const html = buildPlanStepsHtml(plan, 4, 0, false, [necro, witch], initialInv);

  // Necromancer badge: 1 of any resource.
  assert.ok(html.includes('−1 res'), 'necromancer summon badge shows −1 res');
  // After the necromancer's spend the pool must still hold 2 metal, so the
  // witch's badge resolves to the concrete metal label. The old walker
  // deducted 2, leaving 1 metal, which downgraded this badge to "−2 res".
  assert.ok(!html.includes('−2 res'),
    'witch summon badge must not degrade to "−2 res" — the pool was over-drained');
});
