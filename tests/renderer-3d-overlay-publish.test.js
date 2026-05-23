// PR4 overlay migration: the power-node rings + plan move/battle arrows now
// publish into the unified overlay map. The mesh build still runs through the
// per-kind builders (exercised in-browser + by renderer-3d-signature-diff),
// so this file locks the *publish* contract — the descriptors that land in
// `renderer._overlays` for each subsystem. Pure: the publish helpers never
// touch Babylon, so no scene/engine stub is needed.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Renderer3D } from '../src/renderer-3d.js';

function makeRenderer() {
  const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
  return new Renderer3D(fakeCanvas, {});
}

describe('_publishPlanMoveOverlays — one plan-arrow overlay per MOVE step', () => {
  test('publishes a path-bearing overlay per move step, keyed by entity + step', () => {
    const r = makeRenderer();
    r.state = { entities: [{ id: 7, owner: 'hero' }] };
    r.planGhostSteps = [
      { arrow: { entityId: 7, fromCol: 1, fromRow: 1, toCol: 2, toRow: 1 }, stepNumber: 1 },
      { arrow: { entityId: 7, fromCol: 2, fromRow: 1, toCol: 2, toRow: 2 }, stepNumber: 2 },
    ];

    r._publishPlanMoveOverlays();

    const ov1 = r.getOverlay('plan-move-7-1');
    const ov2 = r.getOverlay('plan-move-7-2');
    assert.ok(ov1 && ov2, 'one overlay per move step');
    assert.equal(ov1.kind, 'plan-arrow');
    assert.equal(ov1.layer, 'plan-arrow');
    assert.deepEqual(ov1.path, ['1,1', '2,1'], 'path is [from, to] in order');
    assert.equal(ov1.meta.entityId, 7);
    assert.equal(ov1.meta.badge, '1');
    assert.deepEqual(ov2.path, ['2,1', '2,2']);
  });

  test('stale move overlays are cleared when the plan shrinks', () => {
    const r = makeRenderer();
    r.state = { entities: [{ id: 7, owner: 'hero' }] };
    r.planGhostSteps = [
      { arrow: { entityId: 7, fromCol: 1, fromRow: 1, toCol: 2, toRow: 1 }, stepNumber: 1 },
      { arrow: { entityId: 7, fromCol: 2, fromRow: 1, toCol: 2, toRow: 2 }, stepNumber: 2 },
    ];
    r._publishPlanMoveOverlays();
    assert.ok(r.getOverlay('plan-move-7-2'));

    // Plan now has only the first step — the second must be dropped.
    r.planGhostSteps = [
      { arrow: { entityId: 7, fromCol: 1, fromRow: 1, toCol: 2, toRow: 1 }, stepNumber: 1 },
    ];
    r._publishPlanMoveOverlays();
    assert.ok(r.getOverlay('plan-move-7-1'));
    assert.equal(r.getOverlay('plan-move-7-2'), null, 'stale step overlay cleared');
  });

  test('does not disturb other layers (selection / node) when publishing', () => {
    const r = makeRenderer();
    r.state = { entities: [{ id: 7, owner: 'hero' }] };
    r.setSelection({ entityId: 7, hex: { col: 4, row: 4 } });
    r.planGhostSteps = [
      { arrow: { entityId: 7, fromCol: 1, fromRow: 1, toCol: 2, toRow: 1 }, stepNumber: 1 },
    ];
    r._publishPlanMoveOverlays();
    assert.ok(r.getOverlay('selection'), 'selection overlay untouched by plan publish');
  });
});

describe('_publishPlanBattleOverlays — one battle plan-arrow per attack step', () => {
  test('publishes a battle-variant overlay carrying the ×N count', () => {
    const r = makeRenderer();
    r.planGhostSteps = [
      { attackArrow: { fromCol: 0, fromRow: 0, toCol: 1, toRow: 0 } },
      { attackArrow: { fromCol: 2, fromRow: 0, toCol: 1, toRow: 0 } }, // gang-up on (1,0)
    ];

    r._publishPlanBattleOverlays();

    const ov0 = r.getOverlay('plan-battle-0');
    const ov1 = r.getOverlay('plan-battle-1');
    assert.ok(ov0 && ov1);
    assert.equal(ov0.kind, 'plan-arrow');
    assert.equal(ov0.layer, 'plan-arrow');
    assert.equal(ov0.meta.variant, 'battle');
    assert.equal(ov0.meta.toHex, '1,0');
    assert.equal(ov0.meta.count, 2, 'two attacks land on the same target → ×2');
    assert.equal(ov1.meta.count, 2);
  });

  test('clears stale battle overlays when attacks are removed', () => {
    const r = makeRenderer();
    r.planGhostSteps = [
      { attackArrow: { fromCol: 0, fromRow: 0, toCol: 1, toRow: 0 } },
      { attackArrow: { fromCol: 2, fromRow: 0, toCol: 1, toRow: 0 } },
    ];
    r._publishPlanBattleOverlays();
    assert.ok(r.getOverlay('plan-battle-1'));

    r.planGhostSteps = [{ attackArrow: { fromCol: 0, fromRow: 0, toCol: 1, toRow: 0 } }];
    r._publishPlanBattleOverlays();
    assert.equal(r.getOverlay('plan-battle-1'), null, 'stale battle overlay cleared');
  });
});

describe('_publishObjectiveRingOverlays — controller + identifier ring per node hex', () => {
  test('publishes two ring-pulse overlays per node hex', () => {
    const r = makeRenderer();
    r.state = {
      entities: [],
      witchObjectives: [
        { label: 'Power Node 1', color: '#8800cc', hexes: [{ col: 3, row: 3 }] },
      ],
    };

    r._publishObjectiveRingOverlays();

    const ctrl = r.getOverlay('node-ctrl-3-3');
    const id   = r.getOverlay('node-id-3-3');
    assert.ok(ctrl && id, 'both controller and identifier rings published');
    assert.equal(ctrl.kind, 'ring-pulse');
    assert.equal(ctrl.layer, 'objective-ring');
    assert.equal(ctrl.meta.isController, true);
    assert.equal(id.meta.isController, false);
    assert.equal(ctrl.style.glow, true);
    assert.ok(typeof ctrl.style.color === 'string' && ctrl.style.color.length > 0);
  });

  test('publish is a no-op when there are no objectives (no crash)', () => {
    const r = makeRenderer();
    r.state = { entities: [] };
    assert.doesNotThrow(() => r._publishObjectiveRingOverlays());
  });
});
