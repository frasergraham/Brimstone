// Tests for the mission-editor TIMELINE chunk (EC, operator item 7): the main-
// area timeline tab's pure data layer + the controller authoring path.
//
//   • round→phase mapping from phaseCycle (loop wrap + non-loop tail clamp).
//   • timelineRoundSpan (floor, extends to phase length + highest event round).
//   • buildTimelineModel — round storyTriggers + round waves land on the right
//     rounds; area triggers + non-round waves stay OFF the round track.
//   • editor.editMeta — add / edit / remove a round event mutates
//     meta.storyTriggers / meta.waves correctly, each as one undo step.
//
// DOM-free per CLAUDE.md — exercises the pure functions + controller directly.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  timelinePhaseForRound, timelineRoundSpan, buildTimelineModel,
  createMissionEditor, createDefaultMeta,
  addStoryTrigger, removeStoryTrigger, addWave, removeWave,
} from '../src/tools/mission-editor.js';

// ── round → phase mapping ────────────────────────────────────────────────────
describe('timelinePhaseForRound', () => {
  test('walks the phases array for rounds within its length', () => {
    const pc = { phases: ['dawn', 'day', 'dusk', 'night'], loop: true };
    assert.equal(timelinePhaseForRound(pc, 1), 'dawn');
    assert.equal(timelinePhaseForRound(pc, 2), 'day');
    assert.equal(timelinePhaseForRound(pc, 3), 'dusk');
    assert.equal(timelinePhaseForRound(pc, 4), 'night');
  });

  test('loop=true wraps with modulo past the array end', () => {
    const pc = { phases: ['dawn', 'day', 'night'], loop: true };
    assert.equal(timelinePhaseForRound(pc, 4), 'dawn');  // (4-1)%3 = 0
    assert.equal(timelinePhaseForRound(pc, 5), 'day');   // (5-1)%3 = 1
    assert.equal(timelinePhaseForRound(pc, 6), 'night'); // (6-1)%3 = 2
    assert.equal(timelinePhaseForRound(pc, 7), 'dawn');  // wraps again
  });

  test('loop=false CLAMPS to the last phase past the array end', () => {
    const pc = { phases: ['dawn', 'day', 'night'], loop: false };
    assert.equal(timelinePhaseForRound(pc, 3), 'night');
    assert.equal(timelinePhaseForRound(pc, 4), 'night'); // clamped, not wrapped
    assert.equal(timelinePhaseForRound(pc, 99), 'night');
  });

  test('empty / absent cycle or non-positive round → null', () => {
    assert.equal(timelinePhaseForRound({ phases: [], loop: true }, 1), null);
    assert.equal(timelinePhaseForRound(null, 1), null);
    assert.equal(timelinePhaseForRound({ phases: ['day'], loop: true }, 0), null);
  });
});

// ── round span ────────────────────────────────────────────────────────────────
describe('timelineRoundSpan', () => {
  test('floors at minRounds when nothing else is bigger', () => {
    const meta = { phaseCycle: { phases: ['dawn', 'day'], loop: true }, storyTriggers: [], waves: [] };
    assert.equal(timelineRoundSpan(meta, 8), 8);
    assert.equal(timelineRoundSpan(meta, 4), 4);
  });

  test('extends to the phase-cycle length', () => {
    const phases = Array.from({ length: 12 }, () => 'day');
    const meta = { phaseCycle: { phases, loop: false }, storyTriggers: [], waves: [] };
    assert.equal(timelineRoundSpan(meta, 8), 12);
  });

  test('extends to the highest round-based event round', () => {
    const meta = {
      phaseCycle: { phases: ['dawn'], loop: true },
      storyTriggers: [{ type: 'round', round: 15 }, { type: 'area', hexes: ['9,9'] }],
      waves: [{ trigger: 'round', round: 20 }, { trigger: 'hero_kills', count: 1 }],
    };
    assert.equal(timelineRoundSpan(meta, 8), 20); // wave at 20 wins
  });
});

// ── timeline model ──────────────────────────────────────────────────────────
describe('buildTimelineModel', () => {
  test('places round storyTriggers + round waves on their rounds with source index', () => {
    const meta = {
      phaseCycle: { phases: ['dawn', 'day', 'dusk', 'night'], loop: true },
      storyTriggers: [
        { type: 'round', round: 2, title: 'Beat A' },
        { type: 'round', round: 5, title: 'Beat B' },
      ],
      waves: [{ trigger: 'round', round: 2, count: 3 }],
    };
    const model = buildTimelineModel(meta, 8);
    assert.equal(model.rounds.length, 8);

    const r2 = model.rounds[1]; // round 2
    assert.equal(r2.round, 2);
    assert.equal(r2.phase, 'day');
    assert.equal(r2.story.length, 1);
    assert.equal(r2.story[0].index, 0);          // first storyTrigger
    assert.equal(r2.story[0].trigger.title, 'Beat A');
    assert.equal(r2.waves.length, 1);
    assert.equal(r2.waves[0].index, 0);          // first wave
    assert.equal(r2.waves[0].wave.count, 3);

    const r5 = model.rounds[4];
    assert.equal(r5.story.length, 1);
    assert.equal(r5.story[0].index, 1);          // second storyTrigger
  });

  test('area triggers + non-round waves stay OFF the round track', () => {
    const meta = {
      phaseCycle: { phases: ['day'], loop: true },
      storyTriggers: [
        { type: 'area', hexes: ['3,3'], title: 'Ambush zone' },
        { type: 'round', round: 1, title: 'Opening' },
      ],
      waves: [
        { trigger: 'hero_kills', count: 5 },
        { trigger: 'round', round: 1, count: 2 },
      ],
    };
    const model = buildTimelineModel(meta, 8);

    // No area trigger or kill-wave snuck onto any round.
    const onTrack = model.rounds.flatMap(r => [...r.story, ...r.waves]);
    assert.equal(onTrack.filter(e => e.trigger?.type === 'area').length, 0);
    assert.equal(onTrack.filter(e => e.wave?.trigger === 'hero_kills').length, 0);

    // They surface in the dedicated lanes, with correct source indices.
    assert.equal(model.areaTriggers.length, 1);
    assert.equal(model.areaTriggers[0].index, 0);
    assert.equal(model.areaTriggers[0].trigger.title, 'Ambush zone');
    assert.equal(model.offRoundWaves.length, 1);
    assert.equal(model.offRoundWaves[0].index, 0);
    assert.equal(model.offRoundWaves[0].wave.trigger, 'hero_kills');

    // The round-based ones DID land on round 1.
    assert.equal(model.rounds[0].story.length, 1);
    assert.equal(model.rounds[0].waves.length, 1);
  });

  test('round events beyond minRounds are still placed (span extended)', () => {
    const meta = {
      phaseCycle: { phases: ['dawn', 'day'], loop: true },
      storyTriggers: [{ type: 'round', round: 12, title: 'Late beat' }],
      waves: [],
    };
    const model = buildTimelineModel(meta, 8);
    assert.equal(model.span, 12);
    assert.equal(model.rounds[11].story[0].trigger.title, 'Late beat');
  });
});

// ── controller authoring path (editMeta) ──────────────────────────────────────
describe('editor.editMeta — timeline authoring', () => {
  test('adds a round storyTrigger as one undo step', () => {
    const editor = createMissionEditor();
    assert.equal(editor.canUndo(), false);
    editor.editMeta(m => addStoryTrigger(m, { type: 'round', round: 4, title: 'Reinforce' }));

    const meta = editor.getMeta();
    assert.equal(meta.storyTriggers.length, 1);
    assert.equal(meta.storyTriggers[0].round, 4);
    assert.equal(meta.storyTriggers[0].title, 'Reinforce');
    assert.equal(editor.canUndo(), true);

    editor.undo();
    assert.equal(editor.getMeta().storyTriggers.length, 0); // undo removed it
  });

  test('adds a round wave as one undo step', () => {
    const editor = createMissionEditor();
    editor.editMeta(m => addWave(m, { trigger: 'round', round: 3, count: 2 }));
    assert.equal(editor.getMeta().waves.length, 1);
    assert.equal(editor.getMeta().waves[0].round, 3);
    editor.undo();
    assert.equal(editor.getMeta().waves.length, 0);
  });

  test('edits an existing round event field as one undo step', () => {
    const editor = createMissionEditor();
    editor.editMeta(m => addStoryTrigger(m, { type: 'round', round: 2, title: 'Old' }));
    editor.editMeta(m => { m.storyTriggers[0].round = 7; m.storyTriggers[0].title = 'New'; });

    assert.equal(editor.getMeta().storyTriggers[0].round, 7);
    assert.equal(editor.getMeta().storyTriggers[0].title, 'New');

    editor.undo(); // revert the edit only
    assert.equal(editor.getMeta().storyTriggers[0].round, 2);
    assert.equal(editor.getMeta().storyTriggers[0].title, 'Old');
  });

  test('removes a round event by source index as one undo step', () => {
    const editor = createMissionEditor();
    editor.editMeta(m => addStoryTrigger(m, { type: 'round', round: 1, title: 'A' }));
    editor.editMeta(m => addStoryTrigger(m, { type: 'round', round: 2, title: 'B' }));
    editor.editMeta(m => removeStoryTrigger(m, 0)); // remove 'A'

    assert.equal(editor.getMeta().storyTriggers.length, 1);
    assert.equal(editor.getMeta().storyTriggers[0].title, 'B');

    editor.undo(); // restore 'A'
    assert.equal(editor.getMeta().storyTriggers.length, 2);
    assert.equal(editor.getMeta().storyTriggers[0].title, 'A');
  });

  test('default meta builds an 8-round timeline (one cycle floor)', () => {
    const model = buildTimelineModel(createDefaultMeta());
    assert.equal(model.span, 8);
    assert.equal(model.rounds[0].phase, 'dawn'); // default cycle = dawn,day,day,day
    assert.equal(model.rounds[1].phase, 'day');
    assert.equal(model.rounds[4].phase, 'dawn'); // wraps (loop=true)
  });
});
