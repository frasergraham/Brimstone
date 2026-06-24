// ═══════════════════════════════════════════════════════════════════════════
// Mission data-integrity — every campaign mission must carry, in its data:
//
//   (A) a DISPLAYABLE objective list — at least one mission-logic `setObjective`
//       node so the live Mission Log (engine.objectives() → the Chronicle's
//       Mission Log panel) has something to show. Each objective must have a
//       non-empty, sane label and a sane target.
//   (B) accurate START + END messages — a non-empty `briefing` (the Mission Log
//       header / intro) and a non-empty `victoryText` (the end / debrief). A
//       loseable mission must also carry `defeatText`.
//
// These pin the two deliverables of feat/mission-log-and-messages so no mission
// can ship (or be authored later) without an objective list or its framing prose.
// The Mission Log RENDERING logic itself is covered by tests/mission-log.test.js
// (engine.objectives()) and tests/ui (buildMissionLogHtml); this file guards the
// DATA every mission must provide to feed that pipeline.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { MIGRATED_MISSIONS, missionFileName } from '../src/campaign/mission-catalog.js';
import {
  MissionLogicEngine, makeTestContext,
} from '../src/mission-logic/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MISSIONS_DIR = path.join(__dirname, '..', 'src', 'campaign', 'missions');
const readMission = (id) =>
  JSON.parse(readFileSync(path.join(MISSIONS_DIR, missionFileName(id)), 'utf8'));

// Pull the static `setObjective` nodes straight out of a mission's logic graph
// (the authoring-time source the live Mission Log derives its checklist from).
const setObjectiveNodes = (m) =>
  ((m.logic?.nodes) ?? []).filter((n) => n.type === 'setObjective' && n.params?.id);

describe('mission data-integrity — (B) start + end messages', () => {
  for (const { id } of MIGRATED_MISSIONS) {
    test(`"${id}" has a non-empty briefing (start) and victoryText (end)`, () => {
      const m = readMission(id);
      assert.ok(typeof m.briefing === 'string' && m.briefing.trim().length > 0,
        `${id} must have a start message (briefing)`);
      assert.ok(typeof m.victoryText === 'string' && m.victoryText.trim().length > 0,
        `${id} must have an end message (victoryText)`);
    });

    test(`"${id}" carries a defeatText whenever the mission can be lost`, () => {
      const m = readMission(id);
      // A mission is loseable if its legacy objectives declare a lose condition
      // OR its logic graph has a lose-side outcome / loseMission node.
      const legacyLose = m.objectives?.lose != null
        && !(Array.isArray(m.objectives.lose) && m.objectives.lose.length === 0);
      const graphLose = ((m.logic?.nodes) ?? []).some((n) =>
        n.type === 'loseMission' ||
        (n.type === 'objectiveOutcome' && n.params?.side === 'lose'));
      if (legacyLose || graphLose) {
        assert.ok(typeof m.defeatText === 'string' && m.defeatText.trim().length > 0,
          `${id} is loseable, so it must have a defeatText`);
      }
    });
  }
});

describe('mission data-integrity — (A) displayable objective list', () => {
  for (const { id } of MIGRATED_MISSIONS) {
    test(`"${id}" defines at least one displayable objective`, () => {
      const m = readMission(id);
      const objs = setObjectiveNodes(m);
      assert.ok(objs.length > 0,
        `${id} must push at least one objective onto the Mission Log (a setObjective node)`);
      for (const n of objs) {
        const label = n.params.label;
        assert.ok(typeof label === 'string' && label.trim().length > 0,
          `${id} objective "${n.params.id}" must have a non-empty label`);
        // Targets, when present, must be a positive integer (the n/m progress marker).
        if (n.params.target != null) {
          assert.ok(Number.isInteger(n.params.target) && n.params.target > 0,
            `${id} objective "${n.params.id}" target must be a positive integer`);
        }
      }
    });

    test(`"${id}" objective ids are unique`, () => {
      const ids = setObjectiveNodes(readMission(id)).map((n) => n.params.id);
      assert.equal(new Set(ids).size, ids.length, `${id} objective ids must be unique`);
    });
  }
});

describe('mission data-integrity — objectives flow through the live engine', () => {
  // The mission's own graph, run through a fresh engine, must surface at least one
  // objective on `missionStart` (so the Mission Log opens with a checklist), with
  // every live objective carrying the shape the Mission Log reads. (Some missions
  // — e.g. Ch1M1's "Defeat the Wood Golem" — stage later objectives in mid-play,
  // so not every declared objective is live at missionStart; that is by design.)
  for (const { id } of MIGRATED_MISSIONS) {
    test(`"${id}" surfaces objectives on missionStart via engine.objectives()`, () => {
      const m = readMission(id);
      const ctx = makeTestContext();
      const eng = new MissionLogicEngine(m.logic, ctx);
      eng.dispatch('missionStart');
      const live = eng.objectives();
      assert.ok(live.length > 0,
        `${id}: the Mission Log must have at least one objective after missionStart`);
      for (const o of live) {
        assert.ok(typeof o.label === 'string' && o.label.length > 0,
          `${id}: live objective "${o.id}" must have a label`);
        assert.equal(typeof o.completed, 'boolean',
          `${id}: live objective "${o.id}" must carry a completed flag`);
      }
    });
  }
});
