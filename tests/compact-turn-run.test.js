// Tests for the replay turn-card compaction helpers in src/ui-render.js.
// Pure logic — no DOM, no browser globals required.
//
// compactTurnRun collapses adjacent runs of identical uneventful actions
// ("guard ×N" / "move ×N"); buildTurnCards derives those cards from resolver
// step records without ever touching the resolver.
//
// Lives in tests/ (not tests/ui/) so it runs under the CI-gated `npm test`.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { compactTurnRun, buildTurnCards } from '../src/ui-render.js';
import { PlanActionType } from '../src/planner.js';
import { ResEventType } from '../server/resolver.js';

// ── Card builders for compactTurnRun ──────────────────────────────────────────

const guard = (faction = 'hero') =>
  ({ type: PlanActionType.GUARD, verb: 'guard', faction, compactable: true, eventful: false, count: 1 });
const move = (faction = 'hero') =>
  ({ type: PlanActionType.MOVE, verb: 'move', faction, compactable: true, eventful: false, count: 1 });
const battle = (faction = 'hero') =>
  ({ type: PlanActionType.BATTLE_UNIT, verb: 'battle-unit', faction, compactable: false, eventful: true, count: 1 });

// ── compactTurnRun ────────────────────────────────────────────────────────────

describe('compactTurnRun', () => {
  test('4 guards collapse into a single "guard ×4" card', () => {
    const out = compactTurnRun([guard(), guard(), guard(), guard()]);
    assert.equal(out.length, 1);
    assert.equal(out[0].count, 4);
    assert.equal(out[0].label, 'guard ×4');
    assert.equal(out[0].collapsed, true);
    assert.equal(out[0].faction, 'hero');
  });

  test('2 guards + battle + 2 guards → 3 cards (guard ×2, battle, guard ×2)', () => {
    const out = compactTurnRun([guard(), guard(), battle(), guard(), guard()]);
    assert.equal(out.length, 3);
    assert.equal(out[0].label, 'guard ×2');
    assert.equal(out[0].count, 2);
    // The battle is an eventful boundary — passed through untouched.
    assert.equal(out[1].type, PlanActionType.BATTLE_UNIT);
    assert.equal(out[1].collapsed, undefined);
    assert.equal(out[2].label, 'guard ×2');
    assert.equal(out[2].count, 2);
  });

  test('no-op when nothing to compact (all eventful)', () => {
    const input = [battle(), battle('witch'), battle()];
    const out = compactTurnRun(input);
    assert.equal(out.length, 3);
    assert.deepEqual(out, input); // unchanged, same references pass through
  });

  test('lone uneventful actions are not collapsed', () => {
    // guard, battle, guard — each guard run has length 1.
    const out = compactTurnRun([guard(), battle(), guard()]);
    assert.equal(out.length, 3);
    assert.ok(!out[0].collapsed);
    assert.ok(!out[2].collapsed);
  });

  test('move runs collapse into "move ×N"', () => {
    const out = compactTurnRun([move(), move(), move()]);
    assert.equal(out.length, 1);
    assert.equal(out[0].label, 'move ×3');
  });

  test('different action types do NOT merge (guard run then move run)', () => {
    const out = compactTurnRun([guard(), guard(), move(), move()]);
    assert.equal(out.length, 2);
    assert.equal(out[0].label, 'guard ×2');
    assert.equal(out[1].label, 'move ×2');
  });

  test('never collapses across faction boundaries', () => {
    const out = compactTurnRun([guard('hero'), guard('witch'), guard('witch')]);
    assert.equal(out.length, 2);
    assert.ok(!out[0].collapsed);          // lone hero guard
    assert.equal(out[1].label, 'guard ×2'); // two witch guards merge
    assert.equal(out[1].faction, 'witch');
  });

  test('empty / non-array input returns []', () => {
    assert.deepEqual(compactTurnRun([]), []);
    assert.deepEqual(compactTurnRun(undefined), []);
    assert.deepEqual(compactTurnRun(null), []);
  });

  test('does not mutate the input array or its cards', () => {
    const input = [guard(), guard()];
    const snapshot = input.map(c => ({ ...c }));
    compactTurnRun(input);
    assert.equal(input.length, 2);
    input.forEach((c, i) => assert.deepEqual(c, snapshot[i]));
  });
});

// ── buildTurnCards (steps → ordered turn cards) ───────────────────────────────

const okEvent = (action, result = { success: true }) =>
  ({ type: ResEventType.ACTION_OK, action, result });

const step = ({ hero = [], witch = [] } = {}) =>
  ({ stepIndex: 0, heroEvents: hero, witchEvents: witch, entitySnapshot: [] });

describe('buildTurnCards', () => {
  test('guard actions become compactable cards tagged by faction', () => {
    const steps = [
      step({ hero: [okEvent({ type: PlanActionType.GUARD, entityId: 'h1' })] }),
      step({ hero: [okEvent({ type: PlanActionType.GUARD, entityId: 'h2' })] }),
    ];
    const cards = buildTurnCards(steps, { ResEventType });
    assert.equal(cards.length, 2);
    assert.ok(cards.every(c => c.compactable && c.verb === 'guard' && c.faction === 'hero'));
    // …and they compact together.
    assert.equal(compactTurnRun(cards)[0].label, 'guard ×2');
  });

  test('a plain move is uneventful; a move that hit a block/encounter is not', () => {
    const steps = [
      step({ hero: [
        okEvent({ type: PlanActionType.MOVE, entityId: 'h1', toCol: 1, toRow: 1 }),
        okEvent({ type: PlanActionType.MOVE, entityId: 'h2' }, { success: true, blockedBy: { displayName: 'Zombie' } }),
      ] }),
    ];
    const cards = buildTurnCards(steps, { ResEventType });
    assert.equal(cards.length, 2);
    assert.equal(cards[0].compactable, true);   // plain repositioning
    assert.equal(cards[1].compactable, false);  // blocked → eventful boundary
  });

  test('battles split quiet runs (2 guards + battle + 2 guards → 3 cards)', () => {
    const steps = [
      step({ hero: [
        okEvent({ type: PlanActionType.GUARD, entityId: 'h1' }),
        okEvent({ type: PlanActionType.GUARD, entityId: 'h2' }),
        okEvent({ type: PlanActionType.BATTLE_UNIT, entityId: 'h1', targetId: 'z1' }, { success: true, damage: 1 }),
        okEvent({ type: PlanActionType.GUARD, entityId: 'h1' }),
        okEvent({ type: PlanActionType.GUARD, entityId: 'h2' }),
      ] }),
    ];
    const out = compactTurnRun(buildTurnCards(steps, { ResEventType }));
    assert.equal(out.length, 3);
    assert.equal(out[0].label, 'guard ×2');
    assert.equal(out[2].label, 'guard ×2');
  });

  test('a reactive guard strike is an eventful boundary', () => {
    const steps = [
      step({ hero: [okEvent({ type: PlanActionType.GUARD, entityId: 'h1' })] }),
      { stepIndex: 1, heroEvents: [{ type: ResEventType.GUARD_STRIKE, guardianId: 'h1', targetId: 'z1', result: {} }], witchEvents: [], entitySnapshot: [] },
      step({ hero: [okEvent({ type: PlanActionType.GUARD, entityId: 'h1' })] }),
    ];
    const out = compactTurnRun(buildTurnCards(steps, { ResEventType }));
    // guard, guard-strike (eventful), guard — the strike prevents a merge.
    assert.equal(out.length, 3);
    assert.ok(out.every(c => !c.collapsed));
  });

  test('fog hides opponent activity from a human under fog', () => {
    const steps = [
      step({
        hero:  [okEvent({ type: PlanActionType.GUARD, entityId: 'h1' })],
        witch: [okEvent({ type: PlanActionType.GUARD, entityId: 'w1' })],
      }),
    ];
    const noFog = buildTurnCards(steps, { ResEventType, humanFaction: 'hero', fogOfWar: 'none' });
    assert.equal(noFog.length, 2);
    const fogged = buildTurnCards(steps, { ResEventType, humanFaction: 'hero', fogOfWar: 'phase' });
    assert.equal(fogged.length, 1);
    assert.equal(fogged[0].faction, 'hero');
  });

  test('player-events (N-player MP shape) are tagged by their faction', () => {
    const steps = [{
      stepIndex: 0,
      playerEvents: [
        { playerId: 'p1', faction: 'hero',  events: [okEvent({ type: PlanActionType.GUARD, entityId: 'h1' })] },
        { playerId: 'p2', faction: 'witch', events: [okEvent({ type: PlanActionType.GUARD, entityId: 'w1' })] },
      ],
    }];
    const cards = buildTurnCards(steps, { ResEventType });
    assert.equal(cards.length, 2);
    assert.equal(cards[0].faction, 'hero');
    assert.equal(cards[1].faction, 'witch');
  });
});
