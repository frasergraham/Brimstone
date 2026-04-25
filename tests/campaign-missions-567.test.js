// Tests for the new generic mechanisms used by Caleb's Hollow missions 5–7:
//   - cycleConfig.extraScoringPhases (score on additional phases)
//   - cycleConfig.extendOnWitchScore (prolong the night when she scores)
//   - hero_holds_all_nodes win condition
//   - witch_score_threshold lose condition
//   - conditional story triggers (predicate-gated round triggers)
//   - 'evasive' personality registration
//   - mission registry sanity (M5/M6/M7 wired correctly)

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { GameState, Phase, nodeController } from '../src/game.js';
import { hexDistance } from '../src/hex.js';
import { createMinion } from '../src/entities.js';
import { buildVictoryDelegate, _migrate } from '../src/campaign/campaign.js';
import { processStoryTriggers } from '../src/campaign/missions.js';
import { WITCH_PERSONALITIES } from '../src/ai.js';
import { PERSONALITY_CONFIGS } from '../src/ai-engine.js';
import { getCampaignById } from '../src/campaign/campaign-registry.js';
import { serializeState, deserializeState } from '../server/state-sync.js';

// localStorage shim — campaign code touches it on import side-effects.
const _store = {};
globalThis.localStorage = {
  getItem: (k) => _store[k] ?? null,
  setItem: (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
  clear: () => { for (const k of Object.keys(_store)) delete _store[k]; },
};

const hollow = getCampaignById('calebs_hollow_prologue');

function buildLongWatchState() {
  const map = hollow.mapBuilders.long_watch();
  return new GameState(true, false, 'standard', null, map);
}

function buildWitchsTrailState() {
  const map = hollow.mapBuilders.witchs_trail();
  return new GameState(true, false, 'standard', null, map);
}

// ── extraScoringPhases ─────────────────────────────────────────────────────
describe('cycleConfig.extraScoringPhases', () => {
  test('scores on a NIGHT phase when listed', () => {
    const state = buildWitchsTrailState();
    state.cycleConfig = {
      phases: ['day','dusk','night','night','night'],
      loop: false,
      extraScoringPhases: ['night'],
    };
    state.disableScoring = false;
    state.phase = Phase.NIGHT;
    state.round = 3;
    // Witch occupies majority of nodes (2 of 3 in mission 7's map)
    const objs = state.witchObjectives;
    state.entities.push(createMinion(objs[0].col, objs[0].row, 'witch', state));
    state.entities.push(createMinion(objs[1].col, objs[1].row, 'witch', state));
    const before = state.nodeScore.witch;
    state.endRound();
    assert.ok(state.nodeScore.witch > before, 'witch should have scored on NIGHT phase');
  });

  test('does NOT score on NIGHT when extraScoringPhases is unset', () => {
    const state = buildWitchsTrailState();
    state.cycleConfig = {
      phases: ['day','dusk','night','night','night'],
      loop: false,
      // no extraScoringPhases
    };
    state.disableScoring = false;
    state.phase = Phase.NIGHT;
    state.round = 3;
    const objs = state.witchObjectives;
    state.entities.push(createMinion(objs[0].col, objs[0].row, 'witch', state));
    state.entities.push(createMinion(objs[1].col, objs[1].row, 'witch', state));
    const before = state.nodeScore.witch;
    state.endRound();
    assert.equal(state.nodeScore.witch, before, 'witch should not score without extra config');
  });
});

// ── extendOnWitchScore ─────────────────────────────────────────────────────
describe('cycleConfig.extendOnWitchScore', () => {
  test('appends one phase per witch-score event', () => {
    const state = buildWitchsTrailState();
    state.cycleConfig = {
      phases: ['day','dusk','night','night','night'],
      loop: false,
      extraScoringPhases: ['night'],
      extendOnWitchScore: ['night'],
    };
    state.disableScoring = false;
    state.phase = Phase.NIGHT;
    state.round = 3;
    const objs = state.witchObjectives;
    state.entities.push(createMinion(objs[0].col, objs[0].row, 'witch', state));
    state.entities.push(createMinion(objs[1].col, objs[1].row, 'witch', state));

    const startLen = state.cycleConfig.phases.length;
    state.endRound();
    assert.equal(state.cycleConfig.phases.length, startLen + 1, 'cycle should grow by 1');
    assert.equal(state.cycleConfig.phases[state.cycleConfig.phases.length - 1], 'night');
  });

  test('does not append when witch fails to score', () => {
    const state = buildWitchsTrailState();
    state.cycleConfig = {
      phases: ['day','dusk','night','night','night'],
      loop: false,
      extraScoringPhases: ['night'],
      extendOnWitchScore: ['night'],
    };
    state.disableScoring = false;
    state.phase = Phase.NIGHT;
    state.round = 3;
    // No units on nodes — neutral, no score.
    const startLen = state.cycleConfig.phases.length;
    state.endRound();
    assert.equal(state.cycleConfig.phases.length, startLen, 'cycle should not grow');
  });
});

// ── hero_holds_all_nodes ───────────────────────────────────────────────────
describe('hero_holds_all_nodes win condition', () => {
  test('returns null when one node is not hero-controlled', () => {
    const state = buildLongWatchState();
    state.phase = Phase.DAWN;
    // Hero on first 2 nodes only — third is neutral
    const e1 = createMinion(state.witchObjectives[0].col, state.witchObjectives[0].row, null, state); e1.owner = 'hero';
    const e2 = createMinion(state.witchObjectives[1].col, state.witchObjectives[1].row, null, state); e2.owner = 'hero';
    state.entities.push(e1, e2);
    const delegate = buildVictoryDelegate({
      win: { type: 'hero_holds_all_nodes', phase: 'dawn' },
    });
    assert.equal(delegate(state), null);
  });

  test('returns hero victory when all nodes are hero-controlled at dawn', () => {
    const state = buildLongWatchState();
    state.phase = Phase.DAWN;
    for (const obj of state.witchObjectives) {
      const e = createMinion(obj.col, obj.row, null, state);
      e.owner = 'hero';
      state.entities.push(e);
    }
    const delegate = buildVictoryDelegate({
      win: { type: 'hero_holds_all_nodes', phase: 'dawn' },
    });
    const r = delegate(state);
    assert.ok(r, 'expected victory');
    assert.equal(r.winner, 'hero');
  });

  test('does not fire on the wrong phase', () => {
    const state = buildLongWatchState();
    state.phase = Phase.NIGHT;
    for (const obj of state.witchObjectives) {
      const e = createMinion(obj.col, obj.row, null, state);
      e.owner = 'hero';
      state.entities.push(e);
    }
    const delegate = buildVictoryDelegate({
      win: { type: 'hero_holds_all_nodes', phase: 'dawn' },
    });
    assert.equal(delegate(state), null);
  });
});

// ── witch_score_threshold ──────────────────────────────────────────────────
describe('witch_score_threshold lose condition', () => {
  test('returns null below threshold', () => {
    const state = buildWitchsTrailState();
    state.nodeScore = { hero: 0, witch: 3 };
    const delegate = buildVictoryDelegate({
      win: { type: 'slay_witch' },
      lose: { type: 'witch_score_threshold', points: 4 },
    });
    assert.equal(delegate(state), null);
  });

  test('returns witch victory at threshold', () => {
    const state = buildWitchsTrailState();
    state.nodeScore = { hero: 0, witch: 4 };
    const delegate = buildVictoryDelegate({
      win: { type: 'slay_witch' },
      lose: { type: 'witch_score_threshold', points: 4 },
    });
    const r = delegate(state);
    assert.ok(r, 'expected loss verdict');
    assert.equal(r.winner, 'witch');
  });
});

// ── Conditional story triggers ─────────────────────────────────────────────
describe('processStoryTriggers — round trigger condition predicate', () => {
  test('does not fire and does not consume flag when condition is false', () => {
    const state = buildLongWatchState();
    state.round = 4;
    const flags = {};
    const triggers = [{
      type: 'round', round: 4,
      condition: () => false,
      title: 'X', text: 'Y', flag: 'remind',
    }];
    const fired = processStoryTriggers(state, triggers, flags);
    assert.equal(fired.length, 0);
    assert.equal(flags.remind, undefined, 'flag should remain unset');
  });

  test('fires and consumes flag when condition is true', () => {
    const state = buildLongWatchState();
    state.round = 4;
    const flags = {};
    const triggers = [{
      type: 'round', round: 4,
      condition: () => true,
      title: 'X', text: 'Y', flag: 'remind',
    }];
    const fired = processStoryTriggers(state, triggers, flags);
    assert.equal(fired.length, 1);
    assert.equal(flags.remind, true);
  });

  test('round trigger without condition fires (back-compat)', () => {
    const state = buildLongWatchState();
    state.round = 1;
    const flags = {};
    const triggers = [{ type: 'round', round: 1, title: 'X', text: 'Y', flag: 'intro' }];
    const fired = processStoryTriggers(state, triggers, flags);
    assert.equal(fired.length, 1);
  });
});

// ── Evasive personality ────────────────────────────────────────────────────
describe('evasive AI personality', () => {
  test('is registered in PERSONALITY_CONFIGS', () => {
    assert.ok(PERSONALITY_CONFIGS.evasive);
  });

  test('is registered in WITCH_PERSONALITIES', () => {
    assert.ok(WITCH_PERSONALITIES.evasive);
  });
});

// ── State-sync round-trip ──────────────────────────────────────────────────
describe('state-sync — cycleConfig with new fields', () => {
  test('extraScoringPhases and extendOnWitchScore survive serialize/deserialize', () => {
    const state = buildWitchsTrailState();
    state.cycleConfig = {
      phases: ['day','dusk','night','night','night'],
      loop: false,
      extraScoringPhases: ['night'],
      extendOnWitchScore: ['night'],
    };
    const restored = deserializeState(serializeState(state));
    assert.deepEqual(restored.cycleConfig.extraScoringPhases, ['night']);
    assert.deepEqual(restored.cycleConfig.extendOnWitchScore, ['night']);
    // Critical: in-place push survives — appended phases must come back.
    state.cycleConfig.phases.push('night');
    const restored2 = deserializeState(serializeState(state));
    assert.equal(restored2.cycleConfig.phases.length, 6);
  });
});

// ── Save migration v2 → v3 ────────────────────────────────────────────────
// PR-299 inserts long_watch between dark_ritual and witchs_trail and changes
// witchs_trail.requires from ['dark_ritual'] to ['long_watch']. A v2 save with
// currentMission='witchs_trail' would otherwise fail the new prereq and the
// UI would show no launchable mission.
describe('Save migration — v2 → v3 long_watch backfill', () => {
  test('backfills long_watch when player was at witchs_trail', () => {
    const v2 = {
      version: 2,
      currentMission: 'witchs_trail',
      completedMissions: ['prologue', 'gathering_survivors', 'first_night', 'river_crossing', 'dark_ritual'],
      roster: [], resources: {}, heroStats: { hp: 14 }, storyFlags: {},
    };
    const v3 = _migrate(v2, 2);
    assert.equal(v3.version, 3);
    assert.ok(v3.completedMissions.includes('long_watch'),
      'long_watch should be backfilled so witchs_trail prereq is satisfied');
    // Original progress preserved
    assert.ok(v3.completedMissions.includes('dark_ritual'));
  });

  test('does NOT backfill long_watch for players not yet at witchs_trail', () => {
    const v2 = {
      version: 2,
      currentMission: 'dark_ritual',
      completedMissions: ['prologue', 'gathering_survivors', 'first_night', 'river_crossing'],
      roster: [], resources: {}, heroStats: { hp: 14 }, storyFlags: {},
    };
    const v3 = _migrate(v2, 2);
    assert.equal(v3.version, 3);
    assert.ok(!v3.completedMissions.includes('long_watch'),
      'long_watch should not be skipped for a player still on dark_ritual');
  });

  test('passes through v3+ saves unchanged version-wise', () => {
    const v3 = { version: 3, currentMission: 'long_watch', completedMissions: [] };
    const out = _migrate(v3, 3);
    assert.equal(out.version, 3);
  });
});

// ── Power node clusters must be triangles ─────────────────────────────────
// A "triangle" is 3 hexes that are pairwise adjacent (every pair at
// hexDistance 1). Linear (collinear) clusters look broken visually and
// don't behave naturally for the contest mechanic.
describe('Power node clusters are triangles', () => {
  for (const [builderKey, builder] of Object.entries(hollow.mapBuilders)) {
    test(`every node cluster on map "${builderKey}" is a triangle`, () => {
      const map = builder();
      for (const obj of map.witchObjectives) {
        assert.equal(obj.hexes.length, 3, `${builderKey} ${obj.label}: not 3 hexes`);
        for (let i = 0; i < 3; i++) {
          for (let j = i + 1; j < 3; j++) {
            const d = hexDistance(
              obj.hexes[i].col, obj.hexes[i].row,
              obj.hexes[j].col, obj.hexes[j].row
            );
            assert.equal(d, 1,
              `${builderKey} ${obj.label}: ` +
              `(${obj.hexes[i].col},${obj.hexes[i].row}) and ` +
              `(${obj.hexes[j].col},${obj.hexes[j].row}) ` +
              `are distance ${d}, expected 1 (cluster is linear, not triangular)`);
          }
        }
      }
    });
  }
});

// ── disableCycleBar is independent of disableScoring ──────────────────────
describe('disableCycleBar / disableScoring decoupling', () => {
  test('GameState defaults disableCycleBar to false', () => {
    const map = hollow.mapBuilders.long_watch();
    const state = new GameState(true, false, 'standard', null, map);
    assert.equal(state.disableCycleBar, false);
  });

  test('mapData.disableCycleBar is honored by the GameState constructor', () => {
    const map = hollow.mapBuilders.long_watch();
    map.disableCycleBar = true;
    const state = new GameState(true, false, 'standard', null, map);
    assert.equal(state.disableCycleBar, true);
  });

  test('disableCycleBar survives serialize/deserialize', () => {
    const map = hollow.mapBuilders.long_watch();
    map.disableCycleBar = true;
    const state = new GameState(true, false, 'standard', null, map);
    const restored = deserializeState(serializeState(state));
    assert.equal(restored.disableCycleBar, true);
  });

  test('new campaign missions (M5/M6/M7) do not set disableCycleBar', () => {
    for (const id of ['dark_ritual', 'long_watch', 'witchs_trail']) {
      const m = hollow.missions.find(x => x.id === id);
      assert.ok(!m.disableCycleBar, `${id} should keep cycle bar visible`);
    }
  });
});

// ── Mission registry sanity ────────────────────────────────────────────────
describe('Mission registry — M5/M6/M7 wiring', () => {
  const missions = Object.fromEntries(hollow.missions.map(m => [m.id, m]));

  test('dark_ritual now has witch and 11-round cycle', () => {
    const m = missions.dark_ritual;
    assert.ok(m, 'dark_ritual missing');
    assert.equal(m.hasWitch, true);
    assert.equal(m.aiPersonality, 'evasive');
    assert.equal(m.phaseCycle.phases.length, 11);
    assert.equal(m.phaseCycle.phases[m.phaseCycle.phases.length - 1], 'dawn');
  });

  test('long_watch is registered between dark_ritual and witchs_trail', () => {
    const m = missions.long_watch;
    assert.ok(m, 'long_watch mission missing');
    assert.equal(m.aiPersonality, 'evasive');
    assert.deepEqual(m.requires, ['dark_ritual']);
    assert.equal(m.objectives.win.type, 'hero_holds_all_nodes');
    // Map builder must exist.
    assert.equal(typeof hollow.mapBuilders.long_watch, 'function');
    // Map should produce 3 nodes.
    const map = hollow.mapBuilders.long_watch();
    assert.equal(map.witchObjectives.length, 3);
  });

  test('witchs_trail uses night-extension scoring and witch_score_threshold loss', () => {
    const m = missions.witchs_trail;
    assert.deepEqual(m.requires, ['long_watch']);
    assert.equal(m.disableScoring, false);
    assert.deepEqual(m.phaseCycle.extraScoringPhases, ['night']);
    assert.deepEqual(m.phaseCycle.extendOnWitchScore, ['night']);
    const losses = Array.isArray(m.objectives.lose) ? m.objectives.lose : [m.objectives.lose];
    assert.ok(losses.some(c => c.type === 'witch_score_threshold' && c.points === 5));
    // 3-node map for meaningful "majority"
    const map = hollow.mapBuilders.witchs_trail();
    assert.equal(map.witchObjectives.length, 3);
  });
});
