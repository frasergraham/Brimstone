// Tests for compactUneventfulTurns in src/replay-timeline.js — the pure UX
// layer that folds adjacent quiet move/guard turns into one timeline card.
// The detector treats anything that produced a state-changing event (battle,
// summon, discovery, blocked move, story beat, conversation, …) as a HARD
// boundary that splits the run; faction changes break the run too.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { compactUneventfulTurns, MIN_COMPACT_RUN } from '../src/replay-timeline.js';
import { PlanActionType } from '../src/planner.js';

// ── Tiny entry / column builders (mirror buildStepDigest's output shape) ─────

function moveEntry(id, faction = 'hero') {
  return {
    entityId: id,
    actor: { entityId: id, type: 'survivor', name: id, owner: faction },
    target: null,
    actionType: PlanActionType.MOVE,
    label: 'MOVE',
    outcomeKind: null,
    targetDmg: 0,
    actorDmg: 0,
    killed: false,
    note: null,
    discovered: null,
  };
}

function guardEntry(id, faction = 'hero') {
  return { ...moveEntry(id, faction), actionType: PlanActionType.GUARD, label: 'GUARD' };
}

function battleEntry(id, faction = 'hero', { targetDmg = 1, killed = false } = {}) {
  return {
    entityId: id,
    actor: { entityId: id, type: 'survivor', name: id, owner: faction },
    target: { entityId: 't', type: 'zombie', name: 't', owner: 'witch' },
    actionType: PlanActionType.BATTLE_UNIT,
    label: 'ATTACK',
    outcomeKind: 'hit',
    atkRoll: 5, defRoll: 3, attackerWon: true,
    targetDmg, actorDmg: 0, killed,
    note: null, discovered: null,
  };
}

function exploreEntry(id, faction = 'hero', loot = []) {
  return {
    entityId: id,
    actor: { entityId: id, type: 'survivor', name: id, owner: faction },
    target: null,
    actionType: PlanActionType.EXPLORE,
    label: 'EXPLORE',
    outcomeKind: null,
    targetDmg: 0, actorDmg: 0, killed: false,
    note: loot.length ? { text: loot.join(' '), kind: 'gain loot' } : { text: 'EXPLORED', kind: 'info' },
    discovered: null,
  };
}

function blockedMoveEntry(id, faction = 'hero') {
  return {
    ...moveEntry(id, faction),
    note: { text: 'BLOCKED', kind: 'blocked' },
  };
}

function discoveryMoveEntry(id, faction = 'hero') {
  return {
    ...moveEntry(id, faction),
    note: { text: 'FOUND SURVIVOR', kind: 'gain' },
    discovered: [{ entityId: 's1', type: 'survivor', name: 'Found One', owner: null }],
  };
}

function col(idx, entries) { return { stepIndex: idx, entries }; }

function storyBeatCol(key) {
  return {
    stepIndex: `beat:${key}`,
    kind: 'storyBeat',
    title: 'A Whisper',
    text: 'The wind rises…',
    entries: [{ actionType: 'storyBeat', label: 'STORY' }],
  };
}

function convCol(id) {
  return {
    stepIndex: `conv:${id}`,
    kind: 'conversation',
    title: 'A Talk',
    entries: [{ actionType: 'conversation', label: 'TALK' }],
  };
}

// ── No-op / boundary cases ───────────────────────────────────────────────────

describe('compactUneventfulTurns — no-op cases', () => {
  test('empty / nullish input → empty array', () => {
    assert.deepEqual(compactUneventfulTurns([]), []);
    assert.deepEqual(compactUneventfulTurns(null), []);
    assert.deepEqual(compactUneventfulTurns(undefined), []);
  });

  test('a single uneventful turn is NEVER collapsed (run < MIN_COMPACT_RUN)', () => {
    const digest = [col(0, [moveEntry('h1')])];
    const out = compactUneventfulTurns(digest);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, undefined);
    assert.equal(out[0].stepIndex, 0);
    assert.equal(out[0].entries.length, 1);
  });

  test('two single uneventful turns separated by an eventful one stay as three cards', () => {
    const digest = [
      col(0, [moveEntry('h1')]),
      col(1, [battleEntry('h2')]),
      col(2, [moveEntry('h3')]),
    ];
    const out = compactUneventfulTurns(digest);
    assert.equal(out.length, 3);
    assert.equal(out[0].kind, undefined);
    assert.equal(out[1].kind, undefined);
    assert.equal(out[2].kind, undefined);
  });
});

// ── Happy path: N adjacent quiet turns collapse to one ───────────────────────

describe('compactUneventfulTurns — collapses runs of uneventful turns', () => {
  test('4 consecutive guard-only turns collapse into ONE compacted card', () => {
    const digest = [
      col(0, [guardEntry('h1'), guardEntry('h2')]),
      col(1, [guardEntry('h1'), guardEntry('h2')]),
      col(2, [guardEntry('h1'), guardEntry('h2')]),
      col(3, [guardEntry('h1'), guardEntry('h2')]),
    ];
    const out = compactUneventfulTurns(digest);
    assert.equal(out.length, 1, 'four cards collapsed to one');
    const c = out[0];
    assert.equal(c.kind, 'compacted');
    assert.equal(c.count, 4);
    assert.deepEqual(c.memberStepIndices, [0, 1, 2, 3]);
    assert.equal(c.stepIndex, 0, 'leader stepIndex is the FIRST member');
    assert.equal(c.entries.length, 8, 'all constituent entries are visible inside');
  });

  test('3 mixed move/guard turns collapse (both are uneventful action types)', () => {
    const digest = [
      col(0, [moveEntry('h1')]),
      col(1, [guardEntry('h1')]),
      col(2, [moveEntry('h1'), guardEntry('h2')]),
    ];
    const out = compactUneventfulTurns(digest);
    assert.equal(out.length, 1);
    assert.equal(out[0].count, 3);
    assert.deepEqual(out[0].memberStepIndices, [0, 1, 2]);
  });

  test('exactly MIN_COMPACT_RUN consecutive quiet turns DO collapse', () => {
    assert.equal(MIN_COMPACT_RUN, 2);
    const digest = [col(0, [moveEntry('h1')]), col(1, [moveEntry('h1')])];
    const out = compactUneventfulTurns(digest);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'compacted');
    assert.equal(out[0].count, 2);
  });

  test('preserves order of trailing eventful turns', () => {
    const digest = [
      col(0, [moveEntry('h1')]),
      col(1, [moveEntry('h1')]),
      col(2, [moveEntry('h1')]),
      col(3, [battleEntry('h1')]),
      col(4, [moveEntry('h1')]),
    ];
    const out = compactUneventfulTurns(digest);
    assert.equal(out.length, 3);
    assert.equal(out[0].kind, 'compacted');
    assert.equal(out[0].count, 3);
    assert.equal(out[1].kind, undefined);          // battle
    assert.equal(out[1].entries[0].outcomeKind, 'hit');
    assert.equal(out[2].kind, undefined);          // single trailing move
    assert.equal(out[2].entries[0].actionType, PlanActionType.MOVE);
  });
});

// ── Eventful boundaries split runs ───────────────────────────────────────────

describe('compactUneventfulTurns — eventful boundaries split the run', () => {
  test('a battle column in the middle of quiet turns prevents the run from spanning it', () => {
    const digest = [
      col(0, [moveEntry('h1')]),
      col(1, [moveEntry('h1')]),
      col(2, [battleEntry('h1')]),                   // HARD boundary
      col(3, [moveEntry('h1')]),
      col(4, [moveEntry('h1')]),
    ];
    const out = compactUneventfulTurns(digest);
    assert.equal(out.length, 3);
    assert.equal(out[0].kind, 'compacted');
    assert.equal(out[0].count, 2);
    assert.equal(out[1].kind, undefined);
    assert.equal(out[2].kind, 'compacted');
    assert.equal(out[2].count, 2);
  });

  test('an eventful entry MIXED INTO an otherwise quiet column breaks the run at that column', () => {
    // Even one battle entry alongside two guards makes the column eventful.
    const digest = [
      col(0, [guardEntry('h1')]),
      col(1, [guardEntry('h1'), battleEntry('h2')]),  // mixed → eventful column
      col(2, [guardEntry('h1')]),
    ];
    const out = compactUneventfulTurns(digest);
    assert.equal(out.length, 3);
    assert.ok(out.every(c => c.kind !== 'compacted'));
  });

  test('a blocked move (note=BLOCKED) breaks the run', () => {
    const digest = [
      col(0, [moveEntry('h1')]),
      col(1, [blockedMoveEntry('h1')]),
      col(2, [moveEntry('h1')]),
    ];
    const out = compactUneventfulTurns(digest);
    assert.equal(out.length, 3);
    assert.ok(out.every(c => c.kind !== 'compacted'));
  });

  test('a discovery (FOUND SURVIVOR on a move) breaks the run', () => {
    const digest = [
      col(0, [moveEntry('h1')]),
      col(1, [discoveryMoveEntry('h1')]),
      col(2, [moveEntry('h1')]),
    ];
    const out = compactUneventfulTurns(digest);
    assert.equal(out.length, 3);
    assert.ok(out.every(c => c.kind !== 'compacted'));
  });

  test('an EXPLORE entry (note=EXPLORED or loot) is eventful and breaks the run', () => {
    const digest = [
      col(0, [moveEntry('h1')]),
      col(1, [exploreEntry('h1', 'hero', ['🪵'])]),
      col(2, [moveEntry('h1')]),
    ];
    const out = compactUneventfulTurns(digest);
    assert.equal(out.length, 3);
    assert.ok(out.every(c => c.kind !== 'compacted'));
  });

  test('a story-beat card breaks the run', () => {
    const digest = [
      col(0, [moveEntry('h1')]),
      col(1, [moveEntry('h1')]),
      storyBeatCol('intro'),
      col(2, [moveEntry('h1')]),
      col(3, [moveEntry('h1')]),
    ];
    const out = compactUneventfulTurns(digest);
    // Pre-beat 2-run collapses; beat untouched; post-beat 2-run collapses.
    assert.equal(out.length, 3);
    assert.equal(out[0].kind, 'compacted');
    assert.equal(out[0].count, 2);
    assert.equal(out[1].kind, 'storyBeat');
    assert.equal(out[2].kind, 'compacted');
    assert.equal(out[2].count, 2);
  });

  test('a conversation card breaks the run', () => {
    const digest = [
      col(0, [moveEntry('h1')]),
      col(1, [moveEntry('h1')]),
      convCol('reunion'),
      col(2, [moveEntry('h1')]),
      col(3, [moveEntry('h1')]),
    ];
    const out = compactUneventfulTurns(digest);
    assert.equal(out.length, 3);
    assert.equal(out[0].kind, 'compacted');
    assert.equal(out[1].kind, 'conversation');
    assert.equal(out[2].kind, 'compacted');
  });

  test('a kill (killed=true, no other outcome flags) is eventful', () => {
    // Synthetic: a guard with `killed` flag set; the detector should still
    // refuse to compact it even though actionType=guard.
    const killGuard = { ...guardEntry('h1'), killed: true };
    const digest = [
      col(0, [guardEntry('h1')]),
      col(1, [killGuard]),
      col(2, [guardEntry('h1')]),
    ];
    const out = compactUneventfulTurns(digest);
    assert.equal(out.length, 3);
    assert.ok(out.every(c => c.kind !== 'compacted'));
  });
});

// ── Faction-change boundary ──────────────────────────────────────────────────

describe('compactUneventfulTurns — faction changes break the run', () => {
  test('a hero quiet run does NOT extend into a witch quiet run', () => {
    const digest = [
      col(0, [moveEntry('h1', 'hero')]),
      col(1, [moveEntry('h2', 'hero')]),
      col(2, [moveEntry('w1', 'witch')]),
      col(3, [moveEntry('w2', 'witch')]),
    ];
    const out = compactUneventfulTurns(digest);
    assert.equal(out.length, 2);
    assert.equal(out[0].kind, 'compacted');
    assert.equal(out[0].count, 2);
    assert.equal(out[1].kind, 'compacted');
    assert.equal(out[1].count, 2);
    assert.deepEqual(out[0].memberStepIndices, [0, 1]);
    assert.deepEqual(out[1].memberStepIndices, [2, 3]);
  });

  test('a SINGLE witch turn between hero quiet turns breaks the run (no collapse)', () => {
    const digest = [
      col(0, [moveEntry('h1', 'hero')]),
      col(1, [moveEntry('w1', 'witch')]),
      col(2, [moveEntry('h1', 'hero')]),
    ];
    const out = compactUneventfulTurns(digest);
    // Three single-faction uneventful turns, but each faction switch is just
    // one turn; no run reaches MIN_COMPACT_RUN.
    assert.equal(out.length, 3);
    assert.ok(out.every(c => c.kind !== 'compacted'));
  });
});

// ── Input integrity ──────────────────────────────────────────────────────────

describe('compactUneventfulTurns — does not mutate input', () => {
  test('input digest array & its column objects are untouched', () => {
    const c0 = col(0, [moveEntry('h1')]);
    const c1 = col(1, [moveEntry('h1')]);
    const c2 = col(2, [moveEntry('h1')]);
    const digest = [c0, c1, c2];
    const snapshot = JSON.stringify(digest);
    compactUneventfulTurns(digest);
    assert.equal(JSON.stringify(digest), snapshot, 'input digest unchanged');
    assert.equal(digest[0], c0);
    assert.equal(digest[1], c1);
    assert.equal(digest[2], c2);
  });
});
