// Tests for the runtime JSON-mission loader (src/campaign/json-mission.js) and
// the conductor-script registry (src/campaign/conductor-scripts.js).
//
// Covers: a small handmade-map mission fixture → loadMissionJSON → a runtime
// mission def with resolved condition fn, resolved conductor script, and a
// buildMissionMap-resolved map; validation rejections; conductor-script lookup;
// and a round-trip-ish assertion of the _initCampaignMission-consumable shape.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  loadMissionJSON, registerMissionJSON, KNOWN_OBJECTIVE_TYPES,
} from '../src/campaign/json-mission.js';
import {
  CONDUCTOR_SCRIPTS, resolveConductorScript,
} from '../src/campaign/conductor-scripts.js';
import { CONDITIONS } from '../src/campaign/condition-registry.js';
import { TileType, BuildingType } from '../src/tiles.js';
import { hexKey } from '../src/hex.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

// A minimal but representative handmade-map mission. Exercises every resolved
// field: a story trigger with a `condition` string, a conductor scriptKey, and a
// handmade map. Returns a fresh object each call so tests can mutate freely.
function handmadeFixture() {
  return {
    schema: 1,
    id: 'fixture',
    title: 'Fixture Mission',
    chapter: 1,
    campaignId: 'calebs_hollow_prologue',
    requires: null,
    briefing: 'A test briefing.',
    victoryText: 'You win.',
    defeatText: 'You lose.',
    phaseCycle: { phases: ['dawn', 'day', 'day', 'day'], loop: true },
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
      cols: 5,
      rows: 5,
      heroStart: { col: 1, row: 3 },
      witchStart: { col: 3, row: 1 },
      witchObjectives: [{ col: 2, row: 2, hexes: [{ col: 2, row: 2 }] }],
      tiles: [
        {
          col: 1, row: 3, type: 'BUILDING', building: 'INN', fortifyLevel: 1,
          resource: null, hiddenSurvivor: false, roadDirs: ['1,2'],
        },
      ],
    },
    enemyUnits: [{ type: 'zombie', col: 3, row: 2, overrides: { attack: 1 } }],
    waves: [{ trigger: 'hero_kills', count: 1, units: [{ type: 'minion', spawnAt: { col: 2, row: 2 } }] }],
    survivorStartPositions: [{ col: 1, row: 2 }],
    objectives: {
      win: { type: 'eliminate_all', reason: 'Cleared.' },
      lose: { type: 'hero_killed' },
    },
    storyTriggers: [
      { type: 'round', round: 1, title: 'Intro', text: 'It begins.', flag: 'intro' },
      { type: 'round', round: 4, condition: 'notHoldingAllNodes', title: 'Hold', text: 'Hold the line.' },
    ],
  };
}

// ── loadMissionJSON — happy path ─────────────────────────────────────────────

describe('loadMissionJSON — resolution', () => {
  test('passes scalar/array fields through verbatim', () => {
    const def = loadMissionJSON(handmadeFixture());
    assert.equal(def.id, 'fixture');
    assert.equal(def.title, 'Fixture Mission');
    assert.equal(def.chapter, 1);
    assert.equal(def.campaignId, 'calebs_hollow_prologue');
    assert.equal(def.briefing, 'A test briefing.');
    assert.equal(def.victoryText, 'You win.');
    assert.equal(def.defeatText, 'You lose.');
    assert.deepEqual(def.phaseCycle, { phases: ['dawn', 'day', 'day', 'day'], loop: true });
    assert.equal(def.mapSize, 'skirmish');
    assert.equal(def.hasWitch, false);
    assert.equal(def.disableScoring, true);
    assert.equal(def.aiPersonality, 'balanced');
    assert.equal(def.maxDiscoverableSurvivors, 0);
    assert.deepEqual(def.startingResources, { food: 1 });
    assert.deepEqual(def.rewards, { herbs: 2 });
    assert.equal(def.healBonus, 2);
    assert.deepEqual(def.lootOverrides, { remove: ['horse'] });
    assert.deepEqual(def.enemyUnits, [{ type: 'zombie', col: 3, row: 2, overrides: { attack: 1 } }]);
    assert.deepEqual(def.waves, [{ trigger: 'hero_kills', count: 1, units: [{ type: 'minion', spawnAt: { col: 2, row: 2 } }] }]);
    assert.deepEqual(def.survivorStartPositions, [{ col: 1, row: 2 }]);
    assert.deepEqual(def.objectives, {
      win: { type: 'eliminate_all', reason: 'Cleared.' },
      lose: { type: 'hero_killed' },
    });
  });

  test('strips the transform-only fields (schema, conductor)', () => {
    const def = loadMissionJSON(handmadeFixture());
    assert.equal('schema' in def, false);
    assert.equal('conductor' in def, false);
  });

  test('resolves story-trigger condition strings to predicate fns', () => {
    const def = loadMissionJSON(handmadeFixture());
    const plain = def.storyTriggers[0];
    const conditional = def.storyTriggers[1];
    // Trigger without a condition is untouched.
    assert.equal('condition' in plain, false);
    // Conditional trigger's string is now the registered fn.
    assert.equal(typeof conditional.condition, 'function');
    assert.equal(conditional.condition, CONDITIONS.notHoldingAllNodes);
    // Other trigger fields survive.
    assert.equal(conditional.round, 4);
    assert.equal(conditional.title, 'Hold');
  });

  test('attaches a mapBuilderFn that builds the handmade map via buildMissionMap', () => {
    const def = loadMissionJSON(handmadeFixture());
    assert.equal(typeof def.mapBuilderFn, 'function');
    const map = def.mapBuilderFn();
    // Same shape buildXMap()/generateMap() return.
    assert.equal(map.cols, 5);
    assert.equal(map.rows, 5);
    assert.equal(map.tiles.size, 25);
    assert.deepEqual(map.heroStart, { col: 1, row: 3 });
    assert.deepEqual(map.witchStart, { col: 3, row: 1 });
    const inn = map.tiles.get(hexKey(1, 3));
    assert.equal(inn.type, TileType.BUILDING);
    assert.equal(inn.building, BuildingType.INN);
    assert.equal(inn.fortifyLevel, 1);
    assert.ok(inn.roadDirs instanceof Set);
    assert.ok(inn.roadDirs.has('1,2'));
  });

  test('builds a handmade map from the layered tile shape (base/structure/path)', () => {
    const parsed = handmadeFixture();
    parsed.map.tiles = [
      {
        col: 1, row: 3, base: 'DIRT', structure: 'BUILDING', path: null,
        building: 'INN', fortifyLevel: 1, resource: null, hiddenSurvivor: false, roadDirs: ['1,2'],
      },
    ];
    const def = loadMissionJSON(parsed);
    const map = def.mapBuilderFn();
    const inn = map.tiles.get(hexKey(1, 3));
    assert.equal(inn.type, TileType.BUILDING);
    assert.equal(inn.base, TileType.DIRT);
    assert.equal(inn.building, BuildingType.INN);
    assert.equal(inn.fortifyLevel, 1);
    assert.ok(inn.roadDirs.has('1,2'));
  });

  test('keeps the raw mapDef on the def so main.js can distinguish JSON missions', () => {
    const def = loadMissionJSON(handmadeFixture());
    assert.ok(def.map, 'mapDef preserved');
    assert.equal(def.map.mode, 'handmade');
  });

  test('resolves conductor.scriptKey to conductorSteps / conductorConfig', () => {
    const parsed = handmadeFixture();
    parsed.conductor = { scriptKey: 'tutorial' };
    const def = loadMissionJSON(parsed);
    assert.equal(def.conductorSteps, CONDUCTOR_SCRIPTS.tutorial.steps);
    assert.equal(def.conductorConfig, CONDUCTOR_SCRIPTS.tutorial.config);
    assert.ok(Array.isArray(def.conductorSteps));
  });

  test('a mission without a conductor has no conductorSteps', () => {
    const def = loadMissionJSON(handmadeFixture());
    assert.equal('conductorSteps' in def, false);
  });

  test('builds a procedural map via overlay', () => {
    const parsed = handmadeFixture();
    parsed.map = {
      mode: 'procedural',
      seed: 12345,
      mapSize: 'standard',
      nodeCount: 3,
      overlay: { tiles: [{ col: 4, row: 5, type: 'BUILDING', building: 'CHURCH' }] },
    };
    const def = loadMissionJSON(parsed);
    const map = def.mapBuilderFn();
    assert.ok(map.tiles.size > 0);
    const church = map.tiles.get(hexKey(4, 5));
    assert.equal(church.type, TileType.BUILDING);
    assert.equal(church.building, BuildingType.CHURCH);
  });
});

// ── loadMissionJSON — validation ─────────────────────────────────────────────

describe('loadMissionJSON — validation', () => {
  test('rejects a non-object', () => {
    assert.throws(() => loadMissionJSON(null), /parsed mission object/);
    assert.throws(() => loadMissionJSON([]), /parsed mission object/);
  });

  test('rejects a bad schema version', () => {
    const parsed = handmadeFixture();
    parsed.schema = 2;
    assert.throws(() => loadMissionJSON(parsed), /unsupported schema version/);
  });

  test('rejects a missing id', () => {
    const parsed = handmadeFixture();
    delete parsed.id;
    assert.throws(() => loadMissionJSON(parsed), /required field "id"/);
  });

  test('rejects a missing map', () => {
    const parsed = handmadeFixture();
    delete parsed.map;
    assert.throws(() => loadMissionJSON(parsed), /required field "map"/);
  });

  test('rejects an invalid map.mode', () => {
    const parsed = handmadeFixture();
    parsed.map.mode = 'bogus';
    assert.throws(() => loadMissionJSON(parsed), /invalid map\.mode/);
  });

  test('rejects a handmade map without cols/rows', () => {
    const parsed = handmadeFixture();
    delete parsed.map.cols;
    assert.throws(() => loadMissionJSON(parsed), /positive integer "cols"/);
  });

  test('rejects an unknown story-trigger condition key', () => {
    const parsed = handmadeFixture();
    parsed.storyTriggers[1].condition = 'noSuchCondition';
    assert.throws(() => loadMissionJSON(parsed), /unknown story-trigger condition "noSuchCondition"/);
  });

  test('rejects an unknown conductor.scriptKey', () => {
    const parsed = handmadeFixture();
    parsed.conductor = { scriptKey: 'nope' };
    assert.throws(() => loadMissionJSON(parsed), /unknown conductor\.scriptKey "nope"/);
  });
});

// ── conductor-script registry ────────────────────────────────────────────────

describe('resolveConductorScript', () => {
  test('returns the tutorial script (moved out of prologue scripting)', () => {
    const script = resolveConductorScript('tutorial');
    assert.ok(script);
    assert.ok(Array.isArray(script.steps));
    assert.ok(script.steps.length > 0);
    assert.ok(script.config);
    // The conductor config still carries its scripted machinery.
    assert.equal(typeof script.config.witchPlanProvider, 'function');
    assert.ok(Array.isArray(script.config.forcedDice));
    assert.ok(script.config.roundStepMap);
  });

  test('returns null for an unknown key', () => {
    assert.equal(resolveConductorScript('does-not-exist'), null);
    assert.equal(resolveConductorScript(''), null);
    assert.equal(resolveConductorScript(undefined), null);
  });
});

// ── registration + _initCampaignMission-consumable shape ─────────────────────

describe('registerMissionJSON + consumable shape', () => {
  test('appends a resolved mission to a campaign def and wires the map builder', () => {
    const campaignDef = { id: 'test_campaign', missions: [], mapBuilders: {} };
    const def = registerMissionJSON(campaignDef, handmadeFixture());
    assert.equal(campaignDef.missions.length, 1);
    assert.equal(campaignDef.missions[0], def);
    // mapBuilder string key + matching registry entry, like a JS mission.
    assert.equal(typeof def.mapBuilder, 'string');
    assert.equal(campaignDef.mapBuilders[def.mapBuilder], def.mapBuilderFn);
    // getMapBuilder(mapBuilder)() resolves the same handmade map.
    const map = campaignDef.mapBuilders[def.mapBuilder]();
    assert.equal(map.cols, 5);
  });

  test('a loaded mission exposes the fields _initCampaignMission reads', () => {
    const def = loadMissionJSON(handmadeFixture());
    // Map build path
    assert.equal(typeof def.mapBuilderFn, 'function');
    // Witch / scoring flags
    assert.equal(def.hasWitch, false);
    assert.equal(def.disableScoring, true);
    // Phase cycle, objectives, waves, enemies, survivors
    assert.ok(def.phaseCycle);
    assert.ok(def.objectives.win);
    assert.ok(Array.isArray(def.waves));
    assert.ok(Array.isArray(def.enemyUnits));
    assert.ok(Array.isArray(def.survivorStartPositions));
    // Resolved story triggers are processStoryTriggers-ready (fn conditions).
    for (const t of def.storyTriggers) {
      if ('condition' in t) assert.equal(typeof t.condition, 'function');
    }
  });
});

// ── KNOWN_OBJECTIVE_TYPES ↔ campaign.js switch guard ─────────────────────────
// KNOWN_OBJECTIVE_TYPES (json-mission.js) and the objective-type switch in
// buildVictoryDelegate (campaign.js) live in different files but MUST stay in
// lockstep: the validator rejects any type not in the set, and the runtime can
// only handle the types in the switch. This guard parses the switch's `case`
// labels out of campaign.js source and asserts the two sets are identical, so
// future drift (a new objective handled in one file but not the other) fails CI.

const _here = dirname(fileURLToPath(import.meta.url));

describe('KNOWN_OBJECTIVE_TYPES stays in sync with campaign.js', () => {
  test('matches the buildVictoryDelegate switch cases exactly', () => {
    const src = readFileSync(join(_here, '../src/campaign/campaign.js'), 'utf8');
    // Scope to the two switch bodies (_checkLoseCondition + _checkWinCondition)
    // by reading every `case '<type>':` label in the file. These functions own
    // the only objective-type switches in campaign.js.
    const caseTypes = new Set();
    for (const m of src.matchAll(/case\s+'([a-z_]+)'\s*:/g)) {
      caseTypes.add(m[1]);
    }
    assert.ok(caseTypes.size > 0, 'expected to parse objective case labels from campaign.js');

    const known = KNOWN_OBJECTIVE_TYPES;
    // Every type the runtime switch handles must be accepted by the validator…
    const missingFromKnown = [...caseTypes].filter(t => !known.has(t));
    assert.deepEqual(missingFromKnown, [],
      `objective types handled in campaign.js but missing from KNOWN_OBJECTIVE_TYPES: ${missingFromKnown.join(', ')}`);
    // …and the validator must not accept any type the runtime can't handle.
    const extraInKnown = [...known].filter(t => !caseTypes.has(t));
    assert.deepEqual(extraInKnown, [],
      `objective types in KNOWN_OBJECTIVE_TYPES but not handled by campaign.js: ${extraInKnown.join(', ')}`);
  });

  test('every objective type used by the shipped missions is known', () => {
    const dir = join(_here, '../src/campaign/missions');
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    assert.ok(files.length >= 8, `expected the shipped mission JSONs, found ${files.length}`);
    const asArray = (side) => (Array.isArray(side) ? side : side ? [side] : []);
    for (const f of files) {
      const m = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      for (const o of [...asArray(m.objectives?.win), ...asArray(m.objectives?.lose)]) {
        assert.ok(KNOWN_OBJECTIVE_TYPES.has(o.type),
          `${f}: objective type "${o.type}" is not in KNOWN_OBJECTIVE_TYPES`);
      }
    }
  });
});
