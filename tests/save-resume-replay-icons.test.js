// Regression: resuming a game must replay the just-resumed round with full
// turn-card icons (not the icon-less legacy summary).
//
// Bug: launching into a game from a save replayed the last turn with turn cards
// missing their icons. The turn-card timeline (buildStepDigest) draws every
// NON-battle action card (MOVE / EXPLORE / SUMMON / …) from the step's
// `entitySnapshot` — `ents.find(e => e.id === a.entityId)` — so if a resumed
// round's serialized steps lose their per-step entitySnapshot, those cards (and
// their icons) vanish entirely. This test pins the invariant that a round
// serialized through the ONLINE wire path (the shape stored in saves and replayed
// on resume) still carries the entitySnapshot the turn cards need.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ResEventType } from '../server/resolver.js';
import { serializeEventsForTest } from '../server/lobby.js';
import { PlanActionType } from '../src/planner.js';
import { buildStepDigest } from '../src/replay-timeline.js';

// A deterministic one-step round: the hero paladin (entity 'h1') makes a
// successful MOVE. Built by hand (no map RNG) so the step shape is stable —
// crucially it carries `entitySnapshot`, the source the MOVE turn card needs.
function moveRoundSteps() {
  const paladin = {
    id: 'h1', type: 'paladin', owner: 'hero', col: 5, row: 5, slot: 0,
    displayName: 'Sir Caleb', title: 'Paladin', color: '#6cf', alive: true,
  };
  const moveEvent = {
    type: ResEventType.ACTION_OK,
    faction: 'hero',
    action: { type: PlanActionType.MOVE, entityId: 'h1', toCol: 6, toRow: 5 },
    result: { success: true, path: [{ col: 6, row: 5 }] },
  };
  return [{
    stepIndex: 0,
    heroEvents: [moveEvent],
    witchEvents: [],
    entitySnapshot: [paladin],
  }];
}

// Serialize steps exactly as the online resolution does (server/lobby.js
// `serializedSteps`) and round-trip through JSON — i.e. the persisted save shape
// a resumed game replays.
function serializeForResume(steps) {
  const serialized = steps.map(step => ({
    stepIndex: step.stepIndex,
    playerEvents: [
      { playerId: 'p-hero', faction: 'hero', events: serializeEventsForTest(step.heroEvents ?? []) },
      { playerId: 'p-witch', faction: 'witch', events: serializeEventsForTest(step.witchEvents ?? []) },
    ],
    entitySnapshot: step.entitySnapshot ?? [],
  }));
  return JSON.parse(JSON.stringify(serialized)); // DB persist + reload
}

function moveEntries(steps) {
  const digest = buildStepDigest(steps, [], { PlanActionType, ResEventType });
  return digest.flatMap(col => col.entries).filter(e => e.actionType === PlanActionType.MOVE);
}

describe('save-resume replay — turn-card icons', () => {
  test('a resumed round (online-wire serialized) keeps its MOVE card with icon fields', () => {
    const resumed = serializeForResume(moveRoundSteps());
    const moves = moveEntries(resumed);

    assert.equal(moves.length, 1, 'the resumed round still renders the MOVE turn card');
    const actor = moves[0].actor;
    assert.ok(actor, 'MOVE card has an actor (icon source)');
    // unitRef fields the icon renderer (_replayRowHtml) reads: type/title pick
    // the portrait, glyph + color are the fallback chip.
    assert.equal(actor.type, 'paladin', 'actor carries a type for the portrait/icon');
    assert.ok(actor.glyph, 'actor carries a fallback glyph');
    assert.ok(actor.color, 'actor carries a fallback colour');
  });

  test('control: dropping the entitySnapshot is exactly what loses the MOVE card', () => {
    const resumed = serializeForResume(moveRoundSteps());

    // With the snapshot the move card renders…
    assert.equal(moveEntries(resumed).length, 1);

    // …without it (the bug shape) the card — and its icon — disappears entirely.
    const stripped = resumed.map(s => ({ ...s, entitySnapshot: [] }));
    assert.equal(moveEntries(stripped).length, 0,
      'an empty entitySnapshot drops the non-battle turn card (the icon-loss mechanism)');
  });
});
