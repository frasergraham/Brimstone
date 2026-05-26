// Tests for the mission-editor AUTHORING layer (P6): the meta-model form
// operations, assemble↔populate round-trip, and the shared JSON validator
// (src/campaign/json-mission.js) including the four validation-hardening checks.
//
// DOM-free per CLAUDE.md — everything here exercises pure functions, not the
// #e-forms DOM panels (those are thin wiring over these functions).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDefaultMeta,
  createDefaultMapDef,
  addStoryTrigger,
  removeStoryTrigger,
  moveStoryTrigger,
  addWave,
  removeWave,
  setObjective,
  assembleMission,
  populateFromMission,
  createMissionEditor,
  EditorTool,
} from '../src/tools/mission-editor.js';
import {
  loadMissionJSON,
  validateMissionJSON,
  MissionValidationError,
  KNOWN_OBJECTIVE_TYPES,
} from '../src/campaign/json-mission.js';

// ── A complete, valid handmade fixture mission ────────────────────────────────

function fixtureMission() {
  return {
    schema: 1,
    id: 'test_mission',
    title: 'Test Mission',
    chapter: 1,
    campaignId: 'calebs-hollow-prologue',
    requires: null,
    briefing: 'Brief.',
    victoryText: 'You win.',
    defeatText: 'You lose.',
    phaseCycle: { phases: ['dawn', 'day', 'day'], loop: true },
    mapSize: 'skirmish',
    hasWitch: false,
    disableScoring: true,
    aiPersonality: 'balanced',
    aiBudgetBonus: 0,
    maxSurvivorsFromRoster: 0,
    missionSurvivors: 1,
    maxDiscoverableSurvivors: 0,
    startingResources: { food: 1 },
    rewards: { herbs: 2 },
    healBonus: 2,
    lootOverrides: { remove: ['horse'] },
    map: {
      mode: 'handmade',
      cols: 9,
      rows: 9,
      roadSeed: 4242,
      heroStart: { col: 2, row: 7 },
      witchStart: null,
      witchObjectives: [],
      roadNodes: ['2,7', '4,5'],
      tiles: [
        {
          col: 2, row: 7, type: 'BUILDING', building: 'INN',
          resource: null, fortifyLevel: 1, hiddenSurvivor: false, roadDirs: ['3,6'],
        },
      ],
    },
    enemyUnits: [
      { type: 'zombie', col: 3, row: 2, overrides: { attack: 1 } },
    ],
    waves: [
      { trigger: 'hero_kills', count: 1, units: [{ type: 'wood_golem', col: 4, row: 4 }] },
    ],
    survivorStartPositions: [{ col: 2, row: 7 }],
    objectives: {
      win: { type: 'eliminate_all', reason: 'Cleared.' },
      lose: { type: 'hero_killed' },
    },
    storyTriggers: [
      { type: 'round', round: 1, title: 'Dawn', text: 'It begins.', flag: 'intro' },
      { type: 'round', round: 4, condition: 'notHoldingAllNodes', title: 'Reminder', text: 'Hold.' },
    ],
  };
}

// ── assemble → JSON shape ─────────────────────────────────────────────────────

describe('mission-editor forms — assembleMission', () => {
  test('emits a complete schema:1 mission with map + enemyUnits', () => {
    const meta = createDefaultMeta();
    meta.id = 'demo';
    const mapDef = createDefaultMapDef();
    const enemyUnits = [{ type: 'zombie', col: 1, row: 1, overrides: {} }];
    const json = assembleMission({ meta, mapDef, enemyUnits });

    assert.equal(json.schema, 1);
    assert.equal(json.id, 'demo');
    assert.equal(json.map, mapDef);
    assert.deepEqual(json.enemyUnits, enemyUnits);
    // Meta scalars + nested authoring blocks all present.
    for (const k of ['title', 'phaseCycle', 'objectives', 'storyTriggers', 'waves',
      'survivorStartPositions', 'startingResources', 'rewards']) {
      assert.ok(k in json, `assembled mission carries ${k}`);
    }
  });

  test('storyTrigger conditions stay STRING keys (not resolved fns)', () => {
    const { meta, mapDef, enemyUnits } = populateFromMission(fixtureMission());
    const json = assembleMission({ meta, mapDef, enemyUnits });
    const cond = json.storyTriggers.find(t => t.condition);
    assert.equal(typeof cond.condition, 'string');
    assert.equal(cond.condition, 'notHoldingAllNodes');
  });

  test('enemyUnits keep lowercase runtime type', () => {
    const { meta, mapDef, enemyUnits } = populateFromMission(fixtureMission());
    const json = assembleMission({ meta, mapDef, enemyUnits });
    assert.equal(json.enemyUnits[0].type, 'zombie');
  });
});

// ── Lossless round-trip ───────────────────────────────────────────────────────

describe('mission-editor forms — round-trip (populate → assemble)', () => {
  test('a fixture mission survives split + recombine byte-for-byte', () => {
    const original = fixtureMission();
    const split = populateFromMission(original);
    const rebuilt = assembleMission(split);
    assert.deepEqual(rebuilt, original);
  });

  test('roadSeed survives the round-trip (regen determinism, hardening #4)', () => {
    const original = fixtureMission();
    const rebuilt = assembleMission(populateFromMission(original));
    assert.equal(rebuilt.map.roadSeed, 4242);
  });
});

// ── Form-model operations ─────────────────────────────────────────────────────

describe('mission-editor forms — storyTrigger ops', () => {
  test('add / remove / reorder', () => {
    const meta = createDefaultMeta();
    addStoryTrigger(meta, { title: 'A' });
    addStoryTrigger(meta, { title: 'B' });
    assert.equal(meta.storyTriggers.length, 2);
    assert.equal(meta.storyTriggers[0].title, 'A');

    moveStoryTrigger(meta, 0, 1); // A down past B
    assert.equal(meta.storyTriggers[0].title, 'B');
    assert.equal(meta.storyTriggers[1].title, 'A');

    moveStoryTrigger(meta, 0, -1); // B can't move above index 0
    assert.equal(meta.storyTriggers[0].title, 'B'); // unchanged

    removeStoryTrigger(meta, 0);
    assert.equal(meta.storyTriggers.length, 1);
    assert.equal(meta.storyTriggers[0].title, 'A');
  });

  test('new trigger defaults to a round trigger', () => {
    const meta = createDefaultMeta();
    addStoryTrigger(meta);
    assert.equal(meta.storyTriggers[0].type, 'round');
    assert.equal(meta.storyTriggers[0].round, 1);
  });
});

describe('mission-editor forms — wave ops', () => {
  test('add / remove', () => {
    const meta = createDefaultMeta();
    addWave(meta, { trigger: 'round', round: 3 });
    addWave(meta);
    assert.equal(meta.waves.length, 2);
    assert.equal(meta.waves[0].round, 3);
    removeWave(meta, 0);
    assert.equal(meta.waves.length, 1);
    assert.equal(meta.waves[0].trigger, 'round');
  });
});

describe('mission-editor forms — objective ops', () => {
  test('setObjective replaces win / lose; ignores bad side', () => {
    const meta = createDefaultMeta();
    setObjective(meta, 'win', { type: 'slay_witch', reason: 'done' });
    assert.deepEqual(meta.objectives.win, { type: 'slay_witch', reason: 'done' });
    setObjective(meta, 'lose', { type: 'rounds_exceeded', rounds: 20 });
    assert.equal(meta.objectives.lose.type, 'rounds_exceeded');
    const before = JSON.stringify(meta.objectives);
    setObjective(meta, 'bogus', { type: 'x' });
    assert.equal(JSON.stringify(meta.objectives), before); // unchanged
  });
});

// ── Controller integration ─────────────────────────────────────────────────────

describe('mission-editor forms — controller assemble / applyMission', () => {
  test('applyMission loads a parsed mission and assemble reproduces it', () => {
    const ed = createMissionEditor();
    ed.applyMission(populateFromMission(fixtureMission()));
    assert.equal(ed.getMeta().id, 'test_mission');
    assert.equal(ed.getMapDef().mode, 'handmade');
    assert.equal(ed.getEnemyUnits()[0].type, 'zombie');
    assert.deepEqual(ed.assemble(), fixtureMission());
  });

  test('applyMission is a single undo step', () => {
    const ed = createMissionEditor();
    ed.applyMission(populateFromMission(fixtureMission()));
    assert.equal(ed.getMeta().id, 'test_mission');
    ed.undo();
    assert.equal(ed.getMeta().id, 'new_mission'); // back to default meta
  });

  test('a fresh editor assembles a mission that passes validation', () => {
    // The "new mission → download" path: default meta + default handmade map +
    // no enemies must validate (heroStart present, known objective types).
    const ed = createMissionEditor();
    assert.doesNotThrow(() => loadMissionJSON(ed.assemble()));
  });

  test('map edits and meta survive together through undo', () => {
    const ed = createMissionEditor();
    ed.setActiveTool(EditorTool.HIDDEN_SURVIVOR);
    ed.applyAt({ col: 3, row: 3 });
    assert.equal(ed.getMapDef().tiles.find(t => t.col === 3 && t.row === 3).hiddenSurvivor, true);
    ed.undo();
    assert.ok(!ed.getMapDef().tiles.some(t => t.col === 3 && t.row === 3));
  });
});

// ── Validator: happy path + the four hardening checks ──────────────────────────

describe('json-mission — validateMissionJSON happy path', () => {
  test('a complete valid mission passes and loadMissionJSON resolves conditions', () => {
    const m = fixtureMission();
    assert.doesNotThrow(() => validateMissionJSON(m));
    const runtime = loadMissionJSON(m);
    const cond = runtime.storyTriggers.find(t => t.title === 'Reminder');
    assert.equal(typeof cond.condition, 'function'); // string key resolved → fn
    // The plain trigger's (absent) condition stays absent.
    const plain = runtime.storyTriggers.find(t => t.title === 'Dawn');
    assert.equal(plain.condition, undefined);
  });

  test('KNOWN_OBJECTIVE_TYPES covers both the public enum and runtime-only types', () => {
    assert.ok(KNOWN_OBJECTIVE_TYPES.has('eliminate_all'));   // public enum
    assert.ok(KNOWN_OBJECTIVE_TYPES.has('gather_and_survive')); // runtime-only
    assert.ok(KNOWN_OBJECTIVE_TYPES.has('survive_with_party'));
  });
});

describe('json-mission — validation hardening', () => {
  test('#1 rejects a tile outside the handmade extent', () => {
    const m = fixtureMission();
    m.map.tiles.push({ col: 99, row: 0, type: 'GRASS', building: null, resource: null,
      fortifyLevel: 0, hiddenSurvivor: false, roadDirs: [] });
    assert.throws(() => validateMissionJSON(m), MissionValidationError);
  });

  test('#1 rejects an overlay tile outside the procedural extent', () => {
    const m = fixtureMission();
    m.map = {
      mode: 'procedural', seed: 1, mapSize: 'skirmish', nodeCount: 1,
      overlay: { tiles: [{ col: 50, row: 0, type: 'GRASS' }] },
    };
    assert.throws(() => validateMissionJSON(m), /outside the 9×9 map extent/);
  });

  test('#2 rejects an unknown win objective type', () => {
    const m = fixtureMission();
    m.objectives.win = { type: 'not_a_real_objective' };
    assert.throws(() => validateMissionJSON(m), /unknown objective type/);
  });

  test('#2 rejects an unknown lose objective type (array form)', () => {
    const m = fixtureMission();
    m.objectives.lose = [{ type: 'hero_killed' }, { type: 'bogus_lose' }];
    assert.throws(() => validateMissionJSON(m), /unknown objective type/);
  });

  test('#3 rejects a handmade map missing heroStart', () => {
    const m = fixtureMission();
    m.map.heroStart = null;
    assert.throws(() => validateMissionJSON(m), /must define a heroStart/);
  });

  test('#3 rejects hasWitch handmade map missing witchStart', () => {
    const m = fixtureMission();
    m.hasWitch = true;
    m.map.witchStart = null;
    assert.throws(() => validateMissionJSON(m), /must define a witchStart/);
  });

  test('rejects unknown story condition keys', () => {
    const m = fixtureMission();
    m.storyTriggers.push({ type: 'round', round: 2, condition: 'noSuchCondition', title: 'x', text: 'y' });
    assert.throws(() => validateMissionJSON(m), /unknown story-trigger condition/);
  });

  test('rejects a missing/wrong schema and a blank id', () => {
    assert.throws(() => validateMissionJSON({ ...fixtureMission(), schema: 2 }), /unsupported schema/);
    assert.throws(() => validateMissionJSON({ ...fixtureMission(), id: '  ' }), /non-empty string/);
  });

  test('rejects an enemyUnit placed off the map', () => {
    const m = fixtureMission();
    m.enemyUnits.push({ type: 'zombie', col: 40, row: 1 });
    assert.throws(() => validateMissionJSON(m), /outside the .* map extent/);
  });
});
