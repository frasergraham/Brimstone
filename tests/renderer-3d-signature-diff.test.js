// Worker `dee` — perf early-out for plan-arrow / battle-overlay / movement
// highlight rebuilds in the 3D renderer. The four sync helpers each dispose
// every mesh + material + DynamicTexture they own and rebuild from scratch on
// each draw(); since draw() fires per state change (selection, hover, drag),
// idle plan-editing periods drove a measurable amount of GC + GPU churn.
//
// The fix is a per-helper signature → cache → early-out gate. These tests pin:
//   • The signature is deterministic across two calls with identical inputs.
//   • The signature changes when any rebuild input changes (plan steps,
//     entity owner colour, target hex set, ...).
//   • The sync helpers do NOT dispose existing meshes when the signature is
//     unchanged (verified by counting dispose() calls on stubbed meshes).
//   • Changed inputs invalidate the cache so the rebuild path runs again.
//
// `_syncOverflowBadge` is deliberately NOT covered here — it already has its
// own per-hex idempotence (`existing.lastN === overflow`) and is invoked once
// per hex rather than over a snapshot, so the signature pattern doesn't apply.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Renderer3D,
  planArrowsSignature,
  planBattleOverlaySignature,
} from '../src/renderer-3d.js';

// ── Pure helpers: planArrowsSignature ─────────────────────────────────────────

describe('planArrowsSignature — deterministic across identical inputs', () => {
  const steps = [
    { arrow: { entityId: 7, fromCol: 1, fromRow: 1, toCol: 2, toRow: 1 }, stepNumber: 1 },
    { arrow: { entityId: 7, fromCol: 2, fromRow: 1, toCol: 3, toRow: 1 }, stepNumber: 2 },
  ];
  const entities = [{ id: 7, owner: 'hero', col: 1, row: 1 }];

  test('two calls with the same steps + entities produce the same signature', () => {
    const a = planArrowsSignature(steps, entities);
    const b = planArrowsSignature(steps, entities);
    assert.equal(a, b);
    assert.notEqual(a, '', 'non-empty steps should yield a non-empty signature');
  });

  test('empty / non-array steps → empty signature', () => {
    assert.equal(planArrowsSignature(null, entities), '');
    assert.equal(planArrowsSignature(undefined, entities), '');
    assert.equal(planArrowsSignature([], entities), '');
    assert.equal(planArrowsSignature('nope', entities), '');
  });

  test('steps with no `arrow` field (e.g. attack-only plan) → empty signature', () => {
    const attackOnly = [{ attackArrow: { fromCol: 0, fromRow: 0, toCol: 1, toRow: 0 } }];
    assert.equal(planArrowsSignature(attackOnly, entities), '');
  });
});

describe('planArrowsSignature — changes when any input changes', () => {
  const base = [{
    arrow: { entityId: 7, fromCol: 1, fromRow: 1, toCol: 2, toRow: 1 },
    stepNumber: 1,
  }];
  const entities = [{ id: 7, owner: 'hero' }];
  const baseSig = planArrowsSignature(base, entities);

  test('different `toCol` → different signature', () => {
    const moved = [{ arrow: { ...base[0].arrow, toCol: 9 }, stepNumber: 1 }];
    assert.notEqual(planArrowsSignature(moved, entities), baseSig);
  });

  test('different `entityId` (different acting unit) → different signature', () => {
    const other = [{ arrow: { ...base[0].arrow, entityId: 99 }, stepNumber: 1 }];
    const otherEnts = [{ id: 99, owner: 'hero' }];
    assert.notEqual(planArrowsSignature(other, otherEnts), baseSig);
  });

  test('different `stepNumber` (badge label changes) → different signature', () => {
    const renumbered = [{ arrow: { ...base[0].arrow }, stepNumber: 2 }];
    assert.notEqual(planArrowsSignature(renumbered, entities), baseSig);
  });

  test('entity owner colour change (faction flip) → different signature', () => {
    const witchOwned = [{ id: 7, owner: 'witch' }];
    assert.notEqual(planArrowsSignature(base, witchOwned), baseSig);
  });

  test('explicit per-entity colour override → different signature', () => {
    const coloured = [{ id: 7, owner: 'hero', color: '#abcdef' }];
    assert.notEqual(planArrowsSignature(base, coloured), baseSig);
  });

  test('adding another move step → different signature', () => {
    const extended = [
      base[0],
      { arrow: { entityId: 7, fromCol: 2, fromRow: 1, toCol: 2, toRow: 2 }, stepNumber: 2 },
    ];
    assert.notEqual(planArrowsSignature(extended, entities), baseSig);
  });

  test('MARCH passenger arrows (marchArrows) feed the signature too', () => {
    const soldier = { id: 8, owner: 'hero', slot: 3 };
    const marched = [{
      arrow: { ...base[0].arrow },
      marchArrows: [{ entityId: 8, fromCol: 1, fromRow: 1, toCol: 2, toRow: 1 }],
      stepNumber: 1,
    }];
    const withSoldier = [...entities, soldier];
    const sig = planArrowsSignature(marched, withSoldier);
    assert.notEqual(sig, planArrowsSignature(base, withSoldier),
      'adding a passenger arrow must trigger a rebuild');
    // A passenger slot change moves its arrow lane → different signature.
    const resloted = [...entities, { ...soldier, slot: 5 }];
    assert.notEqual(planArrowsSignature(marched, resloted), sig);
  });
});

// ── Pure helpers: planBattleOverlaySignature ─────────────────────────────────

describe('planBattleOverlaySignature — deterministic across identical inputs', () => {
  const steps = [
    { attackArrow: { fromCol: 0, fromRow: 0, toCol: 1, toRow: 0 } },
    { attackArrow: { fromCol: 2, fromRow: 0, toCol: 1, toRow: 0 } },
  ];

  test('two calls with the same steps produce the same signature', () => {
    const a = planBattleOverlaySignature(steps);
    const b = planBattleOverlaySignature(steps);
    assert.equal(a, b);
    assert.notEqual(a, '', 'non-empty attack steps yield a non-empty signature');
  });

  test('empty / non-array / no-attack inputs → empty signature', () => {
    assert.equal(planBattleOverlaySignature(null), '');
    assert.equal(planBattleOverlaySignature(undefined), '');
    assert.equal(planBattleOverlaySignature([]), '');
    assert.equal(planBattleOverlaySignature('nope'), '');
    assert.equal(planBattleOverlaySignature([{ arrow: {} }, { stepNumber: 1 }]), '');
  });
});

describe('planBattleOverlaySignature — changes when any input changes', () => {
  const base = [{ attackArrow: { fromCol: 0, fromRow: 0, toCol: 1, toRow: 0 } }];
  const baseSig = planBattleOverlaySignature(base);

  test('different attacker hex → different signature', () => {
    const moved = [{ attackArrow: { fromCol: 4, fromRow: 4, toCol: 1, toRow: 0 } }];
    assert.notEqual(planBattleOverlaySignature(moved), baseSig);
  });

  test('different target hex → different signature', () => {
    const retargeted = [{ attackArrow: { fromCol: 0, fromRow: 0, toCol: 5, toRow: 5 } }];
    assert.notEqual(planBattleOverlaySignature(retargeted), baseSig);
  });

  test('adding a second attack against the same target (×N changes) → different signature', () => {
    const ganged = [
      base[0],
      { attackArrow: { fromCol: 2, fromRow: 0, toCol: 1, toRow: 0 } },
    ];
    assert.notEqual(planBattleOverlaySignature(ganged), baseSig);
  });
});

// ── Sync helpers: early-out skips dispose when inputs are unchanged ───────────

// We construct a real Renderer3D and stub out `_babylon` + `_scene` so the
// helpers see "Babylon is loaded" and reach the signature gate. Pre-seed
// `_planArrowMeshes` / `_planBattleMeshes` with spy meshes whose dispose
// methods bump a counter — if the early-out works, that counter stays at 0
// across calls with identical inputs.

function makeRenderer() {
  const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
  const r = new Renderer3D(fakeCanvas, {});
  // Pretend Babylon is loaded. The helpers only check truthiness up front.
  r._babylon = { dummy: true };
  r._scene   = { dummy: true };
  // Suppress any code paths that would touch real Babylon by clearing the
  // builder-touching post-signature work; we rely on the early-out skipping
  // that work entirely.
  return r;
}

function spyMesh() {
  const m = { disposed: 0, dispose() { m.disposed++; } };
  return m;
}

describe('_buildPlanArrows — early-out leaves existing meshes alone', () => {
  test('unchanged steps + entities → no dispose() calls', () => {
    const r = makeRenderer();
    r.state = { entities: [{ id: 7, owner: 'hero' }] };
    r.planGhostSteps = [
      { arrow: { entityId: 7, fromCol: 1, fromRow: 1, toCol: 2, toRow: 1 }, stepNumber: 1 },
    ];

    // Seed the signature so the first call is the "no change" case.
    r._planArrowSig = planArrowsSignature(r.planGhostSteps, r.state.entities);

    const fake = {
      disc: spyMesh(), discMat: spyMesh(),
      badge: spyMesh(), badgeMat: spyMesh(), badgeTex: spyMesh(),
      dashes: [spyMesh(), spyMesh()], dashMat: spyMesh(),
    };
    r._planArrowMeshes = [fake];

    r._buildPlanArrows();

    assert.equal(fake.disc.disposed,    0, 'disc was disposed despite unchanged plan');
    assert.equal(fake.discMat.disposed, 0);
    assert.equal(fake.badge.disposed,   0);
    assert.equal(fake.badgeMat.disposed, 0);
    assert.equal(fake.badgeTex.disposed, 0);
    assert.equal(fake.dashMat.disposed, 0);
    for (const d of fake.dashes) assert.equal(d.disposed, 0);
    // Pre-existing mesh entry is left in place — early-out never touched it.
    assert.equal(r._planArrowMeshes.length, 1);
  });

  test('changed step → existing meshes are disposed (rebuild path runs)', () => {
    const r = makeRenderer();
    r.state = { entities: [{ id: 7, owner: 'hero' }] };
    const initialSteps = [
      { arrow: { entityId: 7, fromCol: 1, fromRow: 1, toCol: 2, toRow: 1 }, stepNumber: 1 },
    ];
    r._planArrowSig = planArrowsSignature(initialSteps, r.state.entities);

    // Now the plan changes (destination moved). The signature no longer matches.
    r.planGhostSteps = [
      { arrow: { entityId: 7, fromCol: 1, fromRow: 1, toCol: 3, toRow: 1 }, stepNumber: 1 },
    ];

    const fake = { disc: spyMesh(), discMat: spyMesh() };
    r._planArrowMeshes = [fake];

    // Re-route the build phase to no-op so we don't poke real Babylon. After
    // the dispose loop the function reads `this.planGhostSteps`; we replace it
    // with an empty array via a getter-free assignment — easier to drop steps
    // *after* the dispose runs. Trick: set planGhostSteps to a value that
    // produces a different signature but lets the build code path fall through
    // by exposing only `arrow` shapes the builder skips on.
    // (Actually simpler: just let the builder run with our stub _babylon —
    //  the code path will throw on the first BABYLON.MeshBuilder call.
    //  Catch it.)
    let threw = false;
    try { r._buildPlanArrows(); } catch (_) { threw = true; }

    assert.equal(fake.disc.disposed,    1, 'dispose must run when signature changes');
    assert.equal(fake.discMat.disposed, 1);
    // After dispose loop the array is reset to []. Builder either throws or
    // skips — either way, the old fake must have been cleared out.
    assert.ok(threw || r._planArrowMeshes.length === 0,
      'rebuild path either ran (and threw on stub Babylon) or completed with empty mesh list');
  });
});

describe('_buildPlanBattleArrows — early-out leaves existing meshes alone', () => {
  test('unchanged attack steps → no dispose() calls', () => {
    const r = makeRenderer();
    r.planGhostSteps = [
      { attackArrow: { fromCol: 0, fromRow: 0, toCol: 1, toRow: 0 } },
    ];
    r._planBattleSig = planBattleOverlaySignature(r.planGhostSteps);

    const fake = {
      shaft: spyMesh(), head1: spyMesh(), head2: spyMesh(),
      badge: spyMesh(), badgeMat: spyMesh(), badgeTex: spyMesh(),
    };
    r._planBattleMeshes = [fake];

    r._buildPlanBattleArrows();

    assert.equal(fake.shaft.disposed,    0);
    assert.equal(fake.head1.disposed,    0);
    assert.equal(fake.head2.disposed,    0);
    assert.equal(fake.badge.disposed,    0);
    assert.equal(fake.badgeMat.disposed, 0);
    assert.equal(fake.badgeTex.disposed, 0);
    assert.equal(r._planBattleMeshes.length, 1);
  });

  test('changed attack target → existing meshes are disposed', () => {
    const r = makeRenderer();
    const initial = [{ attackArrow: { fromCol: 0, fromRow: 0, toCol: 1, toRow: 0 } }];
    r._planBattleSig = planBattleOverlaySignature(initial);

    r.planGhostSteps = [{ attackArrow: { fromCol: 0, fromRow: 0, toCol: 5, toRow: 5 } }];

    const fake = { shaft: spyMesh(), head1: spyMesh(), head2: spyMesh() };
    r._planBattleMeshes = [fake];

    let threw = false;
    try { r._buildPlanBattleArrows(); } catch (_) { threw = true; }

    assert.equal(fake.shaft.disposed, 1, 'dispose must run when target hex changes');
    assert.equal(fake.head1.disposed, 1);
    assert.equal(fake.head2.disposed, 1);
    assert.ok(threw || r._planBattleMeshes.length === 0);
  });
});

// ── Babylon-not-loaded guard: signature cache is NOT stamped pre-init ─────────
//
// Important edge case: draw() can fire before Babylon finishes loading. If the
// signature gate ran before the babylon-loaded check, the first lazy-loaded
// frame would see a "matching" cached signature and skip the build entirely,
// leaving the player with a blank overlay.

describe('_buildPlanArrows — pre-Babylon draw does not poison the signature cache', () => {
  test('with _babylon unset, signature stays empty so a later draw still builds', () => {
    const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
    const r = new Renderer3D(fakeCanvas, {});
    // Pre-init: _babylon / _scene null.
    r.state = { entities: [{ id: 7, owner: 'hero' }] };
    r.planGhostSteps = [
      { arrow: { entityId: 7, fromCol: 1, fromRow: 1, toCol: 2, toRow: 1 }, stepNumber: 1 },
    ];

    r._buildPlanArrows();

    assert.equal(r._planArrowSig, '',
      'signature must remain unstamped until Babylon is loaded — otherwise the first post-init draw skips the build');
  });
});

describe('_buildPlanBattleArrows — pre-Babylon draw does not poison the signature cache', () => {
  test('with _babylon unset, signature stays empty so a later draw still builds', () => {
    const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
    const r = new Renderer3D(fakeCanvas, {});
    r.planGhostSteps = [{ attackArrow: { fromCol: 0, fromRow: 0, toCol: 1, toRow: 0 } }];

    r._buildPlanBattleArrows();

    assert.equal(r._planBattleSig, '');
  });
});
