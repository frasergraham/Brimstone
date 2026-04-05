// Tests for src/ai-debug.js — AI debugger visualization module
// Covers debug state management, hex goal mapping, node feasibility mapping,
// goal color coverage, and debug capture integration with AI engines.

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Phase } from '../src/game.js';
import { EntityType } from '../src/entities.js';
import { TileType, ResourceType } from '../src/tiles.js';
import { hexKey } from '../src/hex.js';
import { PlanActionType } from '../src/planner.js';
import {
  Goal, WitchAIEngine, EnginePlanSimState, assemblePlan, PERSONALITY_CONFIGS,
} from '../src/ai-engine.js';
import { HeroGoal, HeroAIEngine, HERO_PERSONALITY_CONFIGS } from '../src/hero-ai-engine.js';
import {
  setAIDebugActive, isAIDebugActive,
  setAIDebugData, getAIDebugData, clearAIDebugData,
  buildHexGoalMap, buildMoveArrows, buildIntentMarkers, buildNodeFeasibilityMap,
  GOAL_COLORS,
} from '../src/ai-debug.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeEntity(overrides) {
  return {
    id: 'e1', type: EntityType.WITCH, owner: 'witch',
    col: 0, row: 0, hp: 10, maxHp: 10, attack: 2, defense: 2,
    alive: true, displayName: 'Witch', ownerId: null,
    items: {}, ...overrides,
  };
}

function makeFakeState(overrides = {}) {
  const tiles = new Map();
  for (let c = 0; c < 7; c++) {
    for (let r = 0; r < 7; r++) {
      tiles.set(hexKey(c, r), {
        col: c, row: r, type: TileType.GRASS, explored: true,
        building: null, resource: null, fortifyLevel: 0,
      });
    }
  }

  const witch = makeEntity({ id: 'witch1', col: 0, row: 0 });
  const minion = makeEntity({
    id: 'm1', type: EntityType.MINION, owner: 'witch',
    col: 1, row: 0, hp: 2, maxHp: 2, attack: 1, defense: 0,
    displayName: 'Minion',
  });
  const hero = makeEntity({
    id: 'hero1', type: EntityType.HERO, owner: 'hero',
    col: 2, row: 0, hp: 8, maxHp: 8, attack: 3, defense: 2,  // within witch sight (2 hexes)
    displayName: 'Hero',
  });

  return {
    tiles,
    phase: overrides.phase ?? Phase.DAY,
    round: overrides.round ?? 6,
    witchObjectives: overrides.witchObjectives ?? [
      { col: 3, row: 3, hexes: [{ col: 3, row: 3 }], discovered: true },
    ],
    nodeScore: overrides.nodeScore ?? { hero: 0, witch: 0 },
    fogOfWar: 'none',
    inventory: overrides.inventory ?? {
      witch: { [ResourceType.HERBS]: 1, [ResourceType.WOOD]: 2, [ResourceType.METAL]: 2 },
      hero: { [ResourceType.HERBS]: 1, [ResourceType.WOOD]: 0, [ResourceType.METAL]: 0 },
    },
    entities: overrides.entities ?? [witch, minion, hero],
  };
}

// ── Debug state management ──────────────────────────────────────────────────

describe('AI Debug state management', () => {
  beforeEach(() => {
    setAIDebugActive(false);
    clearAIDebugData();
  });

  test('isAIDebugActive defaults to false', () => {
    assert.equal(isAIDebugActive(), false);
  });

  test('setAIDebugActive toggles on and off', () => {
    setAIDebugActive(true);
    assert.equal(isAIDebugActive(), true);
    setAIDebugActive(false);
    assert.equal(isAIDebugActive(), false);
  });

  test('setAIDebugData / getAIDebugData round-trip', () => {
    const data = { faction: 'witch', scores: { KILL_HERO: 0.5 } };
    setAIDebugData(data);
    assert.deepEqual(getAIDebugData(), data);
  });

  test('clearAIDebugData nulls the data', () => {
    setAIDebugData({ faction: 'hero' });
    clearAIDebugData();
    assert.equal(getAIDebugData(), null);
  });
});

// ── GOAL_COLORS coverage ────────────────────────────────────────────────────

describe('GOAL_COLORS', () => {
  test('has entries for all witch goals', () => {
    for (const goal of Object.values(Goal)) {
      assert.ok(GOAL_COLORS[goal], `Missing color for witch goal: ${goal}`);
    }
  });

  test('has entries for all hero goals', () => {
    for (const goal of Object.values(HeroGoal)) {
      assert.ok(GOAL_COLORS[goal], `Missing color for hero goal: ${goal}`);
    }
  });

  test('has gap-fill entry', () => {
    assert.ok(GOAL_COLORS['gap-fill']);
  });

  test('all colors are hex strings', () => {
    for (const [key, color] of Object.entries(GOAL_COLORS)) {
      assert.match(color, /^#[0-9a-fA-F]{6}$/, `Invalid color for ${key}: ${color}`);
    }
  });
});

// ── buildHexGoalMap ─────────────────────────────────────────────────────────

describe('buildHexGoalMap', () => {
  test('maps MOVE actions by toCol/toRow', () => {
    const actions = [
      { type: PlanActionType.MOVE, entityId: 'w1', toCol: 2, toRow: 3, _goal: 'KILL_HERO', _priority: 5 },
    ];
    const map = buildHexGoalMap(actions);
    assert.equal(map.size, 1);
    assert.ok(map.has(hexKey(2, 3)));
    const entries = map.get(hexKey(2, 3));
    assert.equal(entries[0].goal, 'KILL_HERO');
    assert.equal(entries[0].priority, 5);
  });

  test('maps EXPLORE actions by col/row', () => {
    const actions = [
      { type: PlanActionType.EXPLORE, entityId: 'w1', col: 1, row: 1, _goal: 'GATHER_RESOURCES', _priority: 6 },
    ];
    const map = buildHexGoalMap(actions);
    assert.ok(map.has(hexKey(1, 1)));
  });

  test('skips BATTLE_UNIT actions with no hex target', () => {
    const actions = [
      { type: PlanActionType.BATTLE_UNIT, entityId: 'w1', targetId: 'h1', _goal: 'KILL_HERO', _priority: 3 },
    ];
    const map = buildHexGoalMap(actions);
    assert.equal(map.size, 0);
  });

  test('multiple actions on same hex stack in array', () => {
    const actions = [
      { type: PlanActionType.MOVE, entityId: 'w1', toCol: 3, toRow: 3, _goal: 'CONTROL_NODES', _priority: 4 },
      { type: PlanActionType.MOVE, entityId: 'w2', toCol: 3, toRow: 3, _goal: 'KILL_HERO', _priority: 5 },
    ];
    const map = buildHexGoalMap(actions);
    assert.equal(map.get(hexKey(3, 3)).length, 2);
  });

  test('actions without _goal default to gap-fill', () => {
    const actions = [
      { type: PlanActionType.MOVE, entityId: 'w1', toCol: 1, toRow: 1, _priority: 7 },
    ];
    const map = buildHexGoalMap(actions);
    assert.equal(map.get(hexKey(1, 1))[0].goal, 'gap-fill');
  });
});

// ── buildMoveArrows ─────────────────────────────────────────────────────────

describe('buildMoveArrows', () => {
  test('builds arrows from MOVE actions with correct from/to', () => {
    const entities = [
      { id: 'w1', col: 0, row: 0, alive: true },
    ];
    const actions = [
      { type: 'move', entityId: 'w1', toCol: 1, toRow: 0, _goal: 'KILL_HERO', _priority: 5 },
      { type: 'move', entityId: 'w1', toCol: 2, toRow: 0, _goal: 'KILL_HERO', _priority: 5 },
    ];
    const arrows = buildMoveArrows(actions, entities);
    assert.equal(arrows.length, 2);
    // First arrow: from entity start to first move
    assert.equal(arrows[0].fromCol, 0);
    assert.equal(arrows[0].fromRow, 0);
    assert.equal(arrows[0].toCol, 1);
    assert.equal(arrows[0].toRow, 0);
    // Second arrow: chained from first destination
    assert.equal(arrows[1].fromCol, 1);
    assert.equal(arrows[1].fromRow, 0);
    assert.equal(arrows[1].toCol, 2);
    assert.equal(arrows[1].toRow, 0);
  });

  test('assigns sequential step numbers', () => {
    const entities = [{ id: 'w1', col: 0, row: 0, alive: true }];
    const actions = [
      { type: 'move', entityId: 'w1', toCol: 1, toRow: 0 },
      { type: 'move', entityId: 'w1', toCol: 2, toRow: 0 },
    ];
    const arrows = buildMoveArrows(actions, entities);
    assert.equal(arrows[0].stepNumber, 1);
    assert.equal(arrows[1].stepNumber, 2);
  });

  test('skips non-MOVE actions', () => {
    const entities = [{ id: 'w1', col: 0, row: 0, alive: true }];
    const actions = [
      { type: 'EXPLORE', entityId: 'w1', col: 0, row: 0 },
      { type: 'move', entityId: 'w1', toCol: 1, toRow: 0 },
    ];
    const arrows = buildMoveArrows(actions, entities);
    assert.equal(arrows.length, 1);
  });

  test('preserves goal from action metadata', () => {
    const entities = [{ id: 'w1', col: 0, row: 0, alive: true }];
    const actions = [
      { type: 'move', entityId: 'w1', toCol: 1, toRow: 0, _goal: 'CONTROL_NODES' },
    ];
    const arrows = buildMoveArrows(actions, entities);
    assert.equal(arrows[0].goal, 'CONTROL_NODES');
  });
});

// ── buildIntentMarkers ──────────────────────────────────────────────────────

describe('buildIntentMarkers', () => {
  test('creates node intent marker for CONTROL_NODES unit', () => {
    const actions = [
      { type: 'move', entityId: 'w1', toCol: 2, toRow: 2, _goal: 'CONTROL_NODES' },
    ];
    const board = {
      nodes: [{ obj: { col: 4, row: 4 } }],
      visibleHeroes: [],
      unexploredBuildings: [],
    };
    const commitments = new Map([['w1', 'CONTROL_NODES']]);
    const markers = buildIntentMarkers(actions, board, commitments, 'witch');
    assert.equal(markers.length, 1);
    assert.equal(markers[0].col, 4);
    assert.equal(markers[0].row, 4);
    assert.equal(markers[0].label, 'Node');
  });

  test('creates enemy intent marker for KILL_HERO unit', () => {
    const actions = [
      { type: 'move', entityId: 'w1', toCol: 3, toRow: 3, _goal: 'KILL_HERO' },
    ];
    const board = {
      nodes: [],
      visibleHeroes: [{ col: 5, row: 5, alive: true }],
      unexploredBuildings: [],
    };
    const commitments = new Map([['w1', 'KILL_HERO']]);
    const markers = buildIntentMarkers(actions, board, commitments, 'witch');
    assert.equal(markers.length, 1);
    assert.equal(markers[0].col, 5);
    assert.equal(markers[0].row, 5);
    assert.equal(markers[0].label, 'Hero');
  });

  test('skips units with no planned moves', () => {
    const actions = [
      { type: 'guard', entityId: 'w1', _goal: 'CONTROL_NODES' },
    ];
    const board = { nodes: [{ obj: { col: 3, row: 3 } }], visibleHeroes: [], unexploredBuildings: [] };
    const commitments = new Map([['w1', 'CONTROL_NODES']]);
    const markers = buildIntentMarkers(actions, board, commitments, 'witch');
    assert.equal(markers.length, 0);
  });

  test('skips when unit has already reached target', () => {
    const actions = [
      { type: 'move', entityId: 'w1', toCol: 3, toRow: 3, _goal: 'CONTROL_NODES' },
    ];
    const board = {
      nodes: [{ obj: { col: 3, row: 3 } }],
      visibleHeroes: [],
      unexploredBuildings: [],
    };
    const commitments = new Map([['w1', 'CONTROL_NODES']]);
    const markers = buildIntentMarkers(actions, board, commitments, 'witch');
    assert.equal(markers.length, 0); // already at the node
  });
});

// ── buildNodeFeasibilityMap ─────────────────────────────────────────────────

describe('buildNodeFeasibilityMap', () => {
  test('extracts node data from board', () => {
    const board = {
      nodes: [
        { obj: { col: 3, row: 3 }, feasibility: 0.65, controller: 'hero', witchPresent: false, heroPresent: true },
        { obj: { col: 5, row: 1 }, feasibility: 0.3, controller: null, witchPresent: false, heroPresent: false },
      ],
    };
    const result = buildNodeFeasibilityMap(board);
    assert.equal(result.length, 2);
    assert.equal(result[0].col, 3);
    assert.equal(result[0].feasibility, 0.65);
    assert.equal(result[1].controller, null);
  });

  test('returns empty array for null board', () => {
    assert.deepEqual(buildNodeFeasibilityMap(null), []);
    assert.deepEqual(buildNodeFeasibilityMap({}), []);
  });
});

// ── Debug capture in WitchAIEngine ──────────────────────────────────────────

describe('WitchAIEngine debug capture', () => {
  test('lastDebugData is null when debugCapture is false', () => {
    const fakeState = makeFakeState();
    const engine = new WitchAIEngine(fakeState, () => {}, 0);
    engine.debugCapture = false;
    engine.generatePlan();
    assert.equal(engine.lastDebugData, null);
  });

  test('lastDebugData is populated when debugCapture is true', () => {
    const fakeState = makeFakeState();
    const engine = new WitchAIEngine(fakeState, () => {}, 0);
    engine.debugCapture = true;
    engine.generatePlan();

    const dbg = engine.lastDebugData;
    assert.ok(dbg, 'lastDebugData should be set');
    assert.equal(dbg.faction, 'witch');
    assert.ok(dbg.board, 'should have board assessment');
    assert.ok(dbg.scores, 'should have goal scores');
    assert.ok(dbg.budget, 'should have budget allocation');
    assert.ok(Array.isArray(dbg.actions), 'should have actions array');
    assert.ok(dbg.config, 'should have personality config');
    assert.ok(dbg.unitCommitments instanceof Map, 'should have unitCommitments map');
  });

  test('debug actions preserve _goal and _priority metadata', () => {
    const fakeState = makeFakeState();
    const engine = new WitchAIEngine(fakeState, () => {}, 0);
    engine.debugCapture = true;
    engine.generatePlan();

    const dbg = engine.lastDebugData;
    // At least some actions should have _goal set
    const withGoal = dbg.actions.filter(a => a._goal);
    assert.ok(withGoal.length > 0, 'some actions should have _goal');
    for (const a of withGoal) {
      assert.ok(typeof a._priority === 'number', 'actions should have numeric _priority');
      assert.ok(Object.values(Goal).includes(a._goal), `_goal should be a valid Goal: ${a._goal}`);
    }
  });

  test('personality name is resolved', () => {
    const fakeState = makeFakeState();
    const engine = new WitchAIEngine(fakeState, () => {}, 0, null, PERSONALITY_CONFIGS.aggressive);
    engine.debugCapture = true;
    engine.generatePlan();
    assert.equal(engine.lastDebugData.personality, 'aggressive');
  });

  test('goal scores are all between 0 and 1', () => {
    const fakeState = makeFakeState();
    const engine = new WitchAIEngine(fakeState, () => {}, 0);
    engine.debugCapture = true;
    engine.generatePlan();

    for (const [goal, score] of Object.entries(engine.lastDebugData.scores)) {
      assert.ok(score >= 0 && score <= 1, `Score for ${goal} should be 0-1, got ${score}`);
    }
  });
});

// ── Debug capture in HeroAIEngine ───────────────────────────────────────────

describe('HeroAIEngine debug capture', () => {
  test('lastDebugData is null when debugCapture is false', () => {
    const fakeState = makeFakeState();
    const engine = new HeroAIEngine(fakeState, () => {}, 0);
    engine.debugCapture = false;
    engine.generatePlan();
    assert.equal(engine.lastDebugData, null);
  });

  test('lastDebugData is populated when debugCapture is true', () => {
    const fakeState = makeFakeState();
    const engine = new HeroAIEngine(fakeState, () => {}, 0);
    engine.debugCapture = true;
    engine.generatePlan();

    const dbg = engine.lastDebugData;
    assert.ok(dbg, 'lastDebugData should be set');
    assert.equal(dbg.faction, 'hero');
    assert.ok(dbg.board, 'should have board assessment');
    assert.ok(dbg.scores, 'should have goal scores');
    assert.ok(dbg.budget, 'should have budget allocation');
    assert.ok(Array.isArray(dbg.actions), 'should have actions array');
  });

  test('debug actions preserve _goal metadata for hero goals', () => {
    const fakeState = makeFakeState();
    const engine = new HeroAIEngine(fakeState, () => {}, 0);
    engine.debugCapture = true;
    engine.generatePlan();

    const dbg = engine.lastDebugData;
    const withGoal = dbg.actions.filter(a => a._goal);
    assert.ok(withGoal.length > 0, 'some actions should have _goal');
    for (const a of withGoal) {
      assert.ok(Object.values(HeroGoal).includes(a._goal), `_goal should be a valid HeroGoal: ${a._goal}`);
    }
  });

  test('personality name is resolved for hero', () => {
    const fakeState = makeFakeState();
    const engine = new HeroAIEngine(fakeState, () => {}, 0, null, HERO_PERSONALITY_CONFIGS.aggressive);
    engine.debugCapture = true;
    engine.generatePlan();
    assert.equal(engine.lastDebugData.personality, 'aggressive');
  });
});

// ── assemblePlan still strips metadata in normal mode ───────────────────────

describe('assemblePlan metadata stripping', () => {
  test('strips _goal and _priority from returned plan', () => {
    const fakeState = makeFakeState();
    const sim = new EnginePlanSimState(fakeState, 'witch');
    const witchEntity = sim.entities.find(e => e.owner === 'witch');
    const board = {
      totalBudget: 5,
      nodes: [],
      witch: witchEntity,
      minions: [],
      visibleHeroes: [],
      unexploredBuildings: [],
    };
    const actions = [
      { type: PlanActionType.MOVE, entityId: 'witch1', toCol: 1, toRow: 0, _goal: Goal.KILL_HERO, _priority: 5 },
    ];
    const plan = assemblePlan(actions, sim, board, new Map());
    for (const a of plan) {
      assert.equal(a._goal, undefined, 'plan actions should not have _goal');
      assert.equal(a._priority, undefined, 'plan actions should not have _priority');
    }
  });
});
