// Tests for src/ai-engine.js
// Covers EnginePlanSimState, assessBoard, scoreGoals, allocateBudget,
// tactic generators, estimateCombat, assemblePlan, and personality configs.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Phase } from '../src/game.js';
import { EntityType } from '../src/entities.js';
import { TileType, ResourceType } from '../src/tiles.js';
import { hexKey } from '../src/hex.js';
import { PlanSimState } from '../src/ai.js';
import {
  EnginePlanSimState,
  assessBoard,
  scoreGoals,
  allocateBudget,
  Goal,
  estimateCombat,
  genDefendWitch,
  genBuildArmy,
  genControlNodes,
  genKillHero,
  genGatherResources,
  assemblePlan,
  PERSONALITY_CONFIGS,
  WitchAIEngine,
  createWitchAI,
} from '../src/ai-engine.js';
import { PlanActionType, MAX_PLAN_LENGTH } from '../src/planner.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeEntity(overrides) {
  return {
    id: 'e1', type: EntityType.WITCH, owner: 'witch',
    col: 0, row: 0, hp: 10, maxHp: 10, attack: 2, defense: 2,
    alive: true, displayName: 'Witch', ownerId: null,
    items: {}, ...overrides,
  };
}

/** Build a minimal fake realState that PlanSimState's constructor can consume. */
function makeFakeState(overrides = {}) {
  const tiles = new Map();
  // 5x5 grass grid
  for (let c = 0; c < 5; c++) {
    for (let r = 0; r < 5; r++) {
      tiles.set(hexKey(c, r), {
        col: c, row: r, type: TileType.GRASS, explored: true,
        building: null, resource: null, fortifyLevel: 0,
      });
    }
  }
  if (overrides.tiles) {
    for (const [k, v] of overrides.tiles) tiles.set(k, v);
  }

  const witch = makeEntity({ id: 'witch1', col: 0, row: 0 });
  const hero = makeEntity({
    id: 'hero1', type: EntityType.HERO, owner: 'hero',
    col: 4, row: 4, hp: 8, maxHp: 8, attack: 3, defense: 2,
    displayName: 'Hero',
  });
  const entities = overrides.entities ?? [witch, hero];

  return {
    tiles,
    phase: overrides.phase ?? Phase.NIGHT,
    round: overrides.round ?? 6,
    witchObjectives: overrides.witchObjectives ?? [],
    nodeScore: overrides.nodeScore ?? { hero: 0, witch: 0 },
    fogOfWar: 'none',
    inventory: overrides.inventory ?? {
      witch: { [ResourceType.HERBS]: 1, [ResourceType.WOOD]: 2, [ResourceType.METAL]: 0 },
      hero: {},
    },
    entities,
  };
}

function makeSim(stateOverrides = {}) {
  return new EnginePlanSimState(makeFakeState(stateOverrides), 'witch');
}

// ── EnginePlanSimState ───────────────────────────────────────────────────────

describe('EnginePlanSimState', () => {
  test('is an instance of PlanSimState', () => {
    const sim = makeSim();
    assert.ok(sim instanceof PlanSimState);
    assert.ok(sim instanceof EnginePlanSimState);
  });

  test('departedHexes starts empty', () => {
    const sim = makeSim();
    assert.equal(sim.departedHexes.size, 0);
  });

  test('unitCommitments starts empty', () => {
    const sim = makeSim();
    assert.equal(sim.unitCommitments.size, 0);
  });

  test('applyMove records departed hex', () => {
    const sim = makeSim();
    const witch = sim.entities.find(e => e.type === EntityType.WITCH);
    const origKey = hexKey(witch.col, witch.row);
    sim.applyMove(witch.id, 1, 0);
    assert.ok(sim.departedHexes.has(witch.id));
    assert.ok(sim.departedHexes.get(witch.id).has(origKey));
    assert.equal(witch.col, 1);
    assert.equal(witch.row, 0);
  });

  test('applyMove accumulates multiple departed hexes', () => {
    const sim = makeSim();
    const witch = sim.entities.find(e => e.type === EntityType.WITCH);
    sim.applyMove(witch.id, 1, 0);
    sim.applyMove(witch.id, 2, 0);
    const departed = sim.departedHexes.get(witch.id);
    assert.equal(departed.size, 2);
    assert.ok(departed.has(hexKey(0, 0)));
    assert.ok(departed.has(hexKey(1, 0)));
  });

  test('resourceLedger is independent copy', () => {
    const sim = makeSim();
    sim.resourceLedger[ResourceType.WOOD] = 99;
    assert.equal(sim.inventory.witch[ResourceType.WOOD], 2);
  });
});

// ── assessBoard ──────────────────────────────────────────────────────────────

describe('assessBoard', () => {
  test('returns all required field groups', () => {
    const sim = makeSim();
    const board = assessBoard(sim);

    // Phase
    assert.equal(board.phase, Phase.NIGHT);
    assert.equal(board.isNight, true);
    assert.equal(board.isDay, false);
    assert.equal(board.isDawnOrDusk, false);

    // Witch
    assert.ok(board.witch);
    assert.equal(board.witchHp, 10);
    assert.equal(board.witchHpRatio, 1.0);

    // Army
    assert.equal(typeof board.minionCount, 'number');
    assert.ok(Array.isArray(board.minions));

    // Heroes
    assert.ok(Array.isArray(board.visibleHeroes));
    assert.equal(typeof board.heroDistance, 'number');

    // Nodes
    assert.ok(Array.isArray(board.nodes));

    // Scores
    assert.equal(typeof board.witchScore, 'number');
    assert.equal(typeof board.heroScore, 'number');

    // Resources
    assert.equal(typeof board.totalResources, 'number');
    assert.equal(typeof board.canAffordSummon, 'boolean');

    // Budget
    assert.equal(typeof board.totalBudget, 'number');
  });

  test('minionCount excludes witch leader', () => {
    const minion = makeEntity({ id: 'm1', type: EntityType.MINION, col: 1, row: 0, hp: 2, maxHp: 2 });
    const sim = makeSim({ entities: [
      makeEntity({ id: 'witch1' }),
      minion,
      makeEntity({ id: 'hero1', type: EntityType.HERO, owner: 'hero', col: 4, row: 4, hp: 8, maxHp: 8 }),
    ]});
    const board = assessBoard(sim);
    assert.equal(board.minionCount, 1);
    assert.equal(board.minions[0].id, 'm1');
  });

  test('heroDistance is Infinity when no heroes', () => {
    const sim = makeSim({ entities: [makeEntity({ id: 'witch1' })] });
    const board = assessBoard(sim);
    assert.equal(board.heroDistance, Infinity);
  });

  test('canAffordSummon false when resources < 2', () => {
    const sim = makeSim({ inventory: {
      witch: { [ResourceType.HERBS]: 1 },
      hero: {},
    }});
    const board = assessBoard(sim);
    assert.equal(board.canAffordSummon, false);
    assert.equal(board.bestSummonType, null);
  });

  test('bestSummonType picks iron golem when metal >= 2', () => {
    const sim = makeSim({ inventory: {
      witch: { [ResourceType.METAL]: 3, [ResourceType.WOOD]: 2 },
      hero: {},
    }});
    const board = assessBoard(sim);
    assert.equal(board.bestSummonType, EntityType.IRON_GOLEM);
  });

  test('bestSummonType picks wood golem when no metal but wood >= 2', () => {
    const sim = makeSim({ inventory: {
      witch: { [ResourceType.METAL]: 0, [ResourceType.WOOD]: 2 },
      hero: {},
    }});
    const board = assessBoard(sim);
    assert.equal(board.bestSummonType, EntityType.WOOD_GOLEM);
  });

  test('bestSummonType picks minion as fallback', () => {
    const sim = makeSim({ inventory: {
      witch: { [ResourceType.HERBS]: 2 },
      hero: {},
    }});
    const board = assessBoard(sim);
    assert.equal(board.bestSummonType, EntityType.MINION);
  });

  test('unexploredBuildings only includes unexplored BUILDING tiles', () => {
    const tiles = new Map();
    tiles.set(hexKey(0, 0), { col: 0, row: 0, type: TileType.GRASS, explored: true });
    tiles.set(hexKey(1, 0), { col: 1, row: 0, type: TileType.BUILDING, explored: false });
    tiles.set(hexKey(2, 0), { col: 2, row: 0, type: TileType.BUILDING, explored: true });
    tiles.set(hexKey(3, 0), { col: 3, row: 0, type: TileType.GRASS, explored: false });
    const sim = makeSim({ tiles });
    const board = assessBoard(sim);
    assert.equal(board.unexploredBuildings.length, 1);
    assert.equal(board.unexploredBuildings[0].col, 1);
  });

  test('phase flags for DAY', () => {
    const sim = makeSim({ phase: Phase.DAY });
    const board = assessBoard(sim);
    assert.equal(board.isDay, true);
    assert.equal(board.isNight, false);
    assert.equal(board.isDawnOrDusk, false);
  });

  test('phase flags for DAWN', () => {
    const sim = makeSim({ phase: Phase.DAWN });
    const board = assessBoard(sim);
    assert.equal(board.isDawnOrDusk, true);
  });

  test('node state includes controller and presence', () => {
    const node = {
      col: 2, row: 2, label: 'Node A',
      hexes: [{ col: 2, row: 2 }],
    };
    const witch = makeEntity({ id: 'witch1', col: 2, row: 2 });
    const hero = makeEntity({ id: 'hero1', type: EntityType.HERO, owner: 'hero', col: 4, row: 4, hp: 8, maxHp: 8 });
    const sim = makeSim({ entities: [witch, hero], witchObjectives: [node] });
    const board = assessBoard(sim);
    assert.equal(board.nodes.length, 1);
    assert.equal(board.nodes[0].witchPresent, true);
    assert.equal(board.nodes[0].heroPresent, false);
  });
});

// ── scoreGoals ───────────────────────────────────────────────────────────────

function makeBoard(overrides = {}) {
  return {
    phase: Phase.NIGHT, isNight: true, isDay: false, isDawnOrDusk: false,
    witch: {}, witchHp: 10, witchMaxHp: 10, witchHpRatio: 1.0,
    minions: [], minionCount: 0, armyStrength: 0,
    visibleHeroes: [{}], heroDistance: 5, heroHpRatio: 1.0,
    nodes: [], witchHeldCount: 0, heroHeldCount: 0,
    witchScore: 0, heroScore: 0,
    totalResources: 4, metalCount: 0, woodCount: 2, canAffordSummon: true, bestSummonType: EntityType.WOOD_GOLEM,
    unexploredBuildings: [],
    totalBudget: 4,
    ...overrides,
  };
}

describe('scoreGoals', () => {
  test('all scores between 0 and 1', () => {
    const scores = scoreGoals(makeBoard());
    for (const g of Object.values(Goal)) {
      assert.ok(scores[g] >= 0, `${g} should be >= 0, got ${scores[g]}`);
      assert.ok(scores[g] <= 1, `${g} should be <= 1, got ${scores[g]}`);
    }
  });

  test('night boosts KILL_HERO vs day', () => {
    const nightScores = scoreGoals(makeBoard({ isNight: true, isDay: false, heroDistance: 2 }));
    const dayScores = scoreGoals(makeBoard({ isNight: false, isDay: true, heroDistance: 2 }));
    assert.ok(nightScores[Goal.KILL_HERO] > dayScores[Goal.KILL_HERO],
      `night KILL_HERO (${nightScores[Goal.KILL_HERO]}) should exceed day (${dayScores[Goal.KILL_HERO]})`);
  });

  test('day boosts GATHER_RESOURCES vs night', () => {
    const dayScores = scoreGoals(makeBoard({ isNight: false, isDay: true }));
    const nightScores = scoreGoals(makeBoard({ isNight: true, isDay: false }));
    assert.ok(dayScores[Goal.GATHER_RESOURCES] > nightScores[Goal.GATHER_RESOURCES],
      `day GATHER (${dayScores[Goal.GATHER_RESOURCES]}) should exceed night (${nightScores[Goal.GATHER_RESOURCES]})`);
  });

  test('dawn/dusk boosts CONTROL_NODES', () => {
    const scoringScores = scoreGoals(makeBoard({ isDawnOrDusk: true, isNight: false, isDay: false }));
    const normalScores = scoreGoals(makeBoard({ isDawnOrDusk: false }));
    assert.ok(scoringScores[Goal.CONTROL_NODES] > normalScores[Goal.CONTROL_NODES],
      `dawn/dusk CONTROL (${scoringScores[Goal.CONTROL_NODES]}) should exceed normal (${normalScores[Goal.CONTROL_NODES]})`);
  });

  test('witch HP < 30% sets DEFEND_WITCH to 1.0', () => {
    const scores = scoreGoals(makeBoard({ witchHpRatio: 0.2 }));
    assert.equal(scores[Goal.DEFEND_WITCH], 1.0);
  });

  test('no resources sets BUILD_ARMY to 0', () => {
    const scores = scoreGoals(makeBoard({ canAffordSummon: false }));
    assert.equal(scores[Goal.BUILD_ARMY], 0);
  });

  test('hero adjacent (dist 1) yields high KILL_HERO', () => {
    const scores = scoreGoals(makeBoard({ heroDistance: 1 }));
    assert.ok(scores[Goal.KILL_HERO] >= 0.7, `adjacent hero KILL_HERO should be high, got ${scores[Goal.KILL_HERO]}`);
  });

  test('wounded hero boosts KILL_HERO', () => {
    const healthy = scoreGoals(makeBoard({ heroHpRatio: 1.0, heroDistance: 3 }));
    const wounded = scoreGoals(makeBoard({ heroHpRatio: 0.3, heroDistance: 3 }));
    assert.ok(wounded[Goal.KILL_HERO] > healthy[Goal.KILL_HERO]);
  });

  test('hero score >= 3 boosts CONTROL_NODES', () => {
    const low = scoreGoals(makeBoard({ heroScore: 0 }));
    const high = scoreGoals(makeBoard({ heroScore: 3 }));
    assert.ok(high[Goal.CONTROL_NODES] > low[Goal.CONTROL_NODES]);
  });

  test('healthy witch with distant hero gives low DEFEND_WITCH', () => {
    const scores = scoreGoals(makeBoard({ witchHpRatio: 1.0, heroDistance: 10 }));
    assert.equal(scores[Goal.DEFEND_WITCH], 0);
  });

  test('hero holding nodes boosts CONTROL_NODES', () => {
    const noHeld = scoreGoals(makeBoard({ heroHeldCount: 0, witchHeldCount: 0 }));
    const heroHeld = scoreGoals(makeBoard({ heroHeldCount: 1, witchHeldCount: 0 }));
    assert.ok(heroHeld[Goal.CONTROL_NODES] > noHeld[Goal.CONTROL_NODES],
      `hero-held CONTROL (${heroHeld[Goal.CONTROL_NODES]}) should exceed no-held (${noHeld[Goal.CONTROL_NODES]})`);
  });

  test('hero holding more nodes than witch gives extra CONTROL_NODES boost', () => {
    const tied = scoreGoals(makeBoard({ heroHeldCount: 1, witchHeldCount: 1 }));
    const behind = scoreGoals(makeBoard({ heroHeldCount: 2, witchHeldCount: 1 }));
    assert.ok(behind[Goal.CONTROL_NODES] > tied[Goal.CONTROL_NODES],
      `behind CONTROL (${behind[Goal.CONTROL_NODES]}) should exceed tied (${tied[Goal.CONTROL_NODES]})`);
  });

  test('early-game focus: distant hero + unexplored buildings boosts GATHER_RESOURCES', () => {
    const noBuildings = scoreGoals(makeBoard({ heroDistance: 8, unexploredBuildings: [] }));
    const withBuildings = scoreGoals(makeBoard({ heroDistance: 8, unexploredBuildings: [{}] }));
    assert.ok(withBuildings[Goal.GATHER_RESOURCES] > noBuildings[Goal.GATHER_RESOURCES],
      `early-game GATHER (${withBuildings[Goal.GATHER_RESOURCES]}) should exceed baseline (${noBuildings[Goal.GATHER_RESOURCES]})`);
  });

  test('early-game focus: caps DEFEND_WITCH when no enemies visible and buildings remain', () => {
    const scores = scoreGoals(makeBoard({
      visibleHeroes: [], heroDistance: Infinity, unexploredBuildings: [{}],
      witchHpRatio: 0.45, // would normally trigger some DEFEND
    }));
    assert.ok(scores[Goal.DEFEND_WITCH] <= 0.1,
      `early-game DEFEND should be capped at 0.1, got ${scores[Goal.DEFEND_WITCH]}`);
  });

  test('early-game focus: does not activate when hero is close', () => {
    const scores = scoreGoals(makeBoard({ heroDistance: 3, unexploredBuildings: [{}] }));
    // GATHER should not get the +0.4 early-game bonus when hero is close
    const noBonus = scoreGoals(makeBoard({ heroDistance: 3, unexploredBuildings: [] }));
    // Scores should be similar (only the normal +0.1 for unexplored buildings)
    const diff = scores[Goal.GATHER_RESOURCES] - noBonus[Goal.GATHER_RESOURCES];
    assert.ok(diff < 0.3, `nearby hero should not trigger early-game bonus, diff was ${diff}`);
  });
});

// ── allocateBudget ───────────────────────────────────────────────────────────

describe('allocateBudget', () => {
  test('allocations sum to totalBudget', () => {
    const scores = {
      [Goal.KILL_HERO]: 0.7,
      [Goal.CONTROL_NODES]: 0.4,
      [Goal.BUILD_ARMY]: 0.3,
      [Goal.GATHER_RESOURCES]: 0.2,
      [Goal.DEFEND_WITCH]: 0.1,
    };
    const result = allocateBudget(scores, 6);
    const total = Object.values(result).reduce((s, v) => s + v, 0);
    assert.equal(total, 6);
  });

  test('goals below threshold get 0 AP', () => {
    const scores = {
      [Goal.KILL_HERO]: 0.8,
      [Goal.CONTROL_NODES]: 0.01,  // below 0.05
      [Goal.BUILD_ARMY]: 0.5,
      [Goal.GATHER_RESOURCES]: 0.03,  // below 0.05
      [Goal.DEFEND_WITCH]: 0.0,
    };
    const result = allocateBudget(scores, 6);
    assert.equal(result[Goal.CONTROL_NODES], 0);
    assert.equal(result[Goal.GATHER_RESOURCES], 0);
    assert.equal(result[Goal.DEFEND_WITCH], 0);
  });

  test('active goals get at least 2 AP (no thin allocations)', () => {
    const scores = {
      [Goal.KILL_HERO]: 0.9,
      [Goal.CONTROL_NODES]: 0.5,
      [Goal.BUILD_ARMY]: 0.3,
      [Goal.GATHER_RESOURCES]: 0.2,
      [Goal.DEFEND_WITCH]: 0.1,
    };
    const result = allocateBudget(scores, 9);
    for (const g of Object.values(Goal)) {
      assert.ok(result[g] === 0 || result[g] >= 2,
        `${g} should be 0 or >= 2 AP, got ${result[g]}`);
    }
  });

  test('single qualifying goal gets full budget', () => {
    const scores = {
      [Goal.KILL_HERO]: 0.9,
      [Goal.CONTROL_NODES]: 0.0,
      [Goal.BUILD_ARMY]: 0.0,
      [Goal.GATHER_RESOURCES]: 0.0,
      [Goal.DEFEND_WITCH]: 0.0,
    };
    const result = allocateBudget(scores, 5);
    assert.equal(result[Goal.KILL_HERO], 5);
  });

  test('no qualifying goals gives all to first goal', () => {
    const scores = {
      [Goal.KILL_HERO]: 0.01,
      [Goal.CONTROL_NODES]: 0.0,
      [Goal.BUILD_ARMY]: 0.0,
      [Goal.GATHER_RESOURCES]: 0.0,
      [Goal.DEFEND_WITCH]: 0.0,
    };
    const result = allocateBudget(scores, 4);
    assert.equal(result[Goal.KILL_HERO], 4);
  });

  test('zero budget gives all zeros', () => {
    const scores = {
      [Goal.KILL_HERO]: 0.8,
      [Goal.CONTROL_NODES]: 0.5,
      [Goal.BUILD_ARMY]: 0.3,
      [Goal.GATHER_RESOURCES]: 0.2,
      [Goal.DEFEND_WITCH]: 0.1,
    };
    const result = allocateBudget(scores, 0);
    for (const g of Object.values(Goal)) {
      assert.equal(result[g], 0);
    }
  });

  test('higher urgency gets more AP', () => {
    const scores = {
      [Goal.KILL_HERO]: 0.9,
      [Goal.CONTROL_NODES]: 0.1,
      [Goal.BUILD_ARMY]: 0.0,
      [Goal.GATHER_RESOURCES]: 0.0,
      [Goal.DEFEND_WITCH]: 0.0,
    };
    const result = allocateBudget(scores, 10);
    assert.ok(result[Goal.KILL_HERO] > result[Goal.CONTROL_NODES],
      `KILL_HERO (${result[Goal.KILL_HERO]}) should get more than CONTROL_NODES (${result[Goal.CONTROL_NODES]})`);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Phase 2: Tactic Generators
// ══════════════════════════════════════════════════════════════════════════════

// ── estimateCombat ──────────────────────────────────────────────────────────

describe('estimateCombat', () => {
  test('returns favorability and classification', () => {
    const attacker = makeEntity({ id: 'w1', attack: 2, defense: 2, owner: 'witch' });
    const defender = makeEntity({ id: 'h1', attack: 3, defense: 2, owner: 'hero', col: 1, row: 0 });
    const board = makeBoard({ minions: [], visibleHeroes: [] });
    const result = estimateCombat(attacker, defender, board);
    assert.equal(typeof result.favorability, 'number');
    assert.ok(['overwhelming', 'favorable', 'unfavorable', 'suicidal'].includes(result.classification));
  });

  test('night bonus improves witch attacker favorability', () => {
    const attacker = makeEntity({ id: 'w1', attack: 2, owner: 'witch' });
    const defender = makeEntity({ id: 'h1', defense: 2, owner: 'hero', col: 1, row: 0 });
    const dayResult = estimateCombat(attacker, defender, makeBoard({ isNight: false, minions: [], visibleHeroes: [] }));
    const nightResult = estimateCombat(attacker, defender, makeBoard({ isNight: true, minions: [], visibleHeroes: [] }));
    assert.ok(nightResult.favorability > dayResult.favorability);
  });

  test('gang-up allies improve favorability', () => {
    const attacker = makeEntity({ id: 'w1', attack: 2, owner: 'witch', col: 0, row: 0 });
    const defender = makeEntity({ id: 'h1', defense: 2, owner: 'hero', col: 1, row: 0 });
    const ally = makeEntity({ id: 'm1', type: EntityType.MINION, attack: 1, owner: 'witch', col: 1, row: 1 });
    const noAllies = estimateCombat(attacker, defender, makeBoard({ minions: [], visibleHeroes: [] }));
    const withAllies = estimateCombat(attacker, defender, makeBoard({ minions: [ally], visibleHeroes: [] }));
    assert.ok(withAllies.favorability > noAllies.favorability);
  });

  test('suicidal classification for very unfavorable fights', () => {
    const attacker = makeEntity({ id: 'w1', attack: 0, defense: 0, owner: 'witch' });
    const defender = makeEntity({ id: 'h1', attack: 5, defense: 5, owner: 'hero', col: 1, row: 0 });
    const result = estimateCombat(attacker, defender, makeBoard({ minions: [], visibleHeroes: [] }));
    assert.equal(result.classification, 'suicidal');
  });
});

// ── genDefendWitch ──────────────────────────────────────────────────────────

describe('genDefendWitch', () => {
  test('produces USE_ITEM herbs when witch is injured', () => {
    const witch = makeEntity({ id: 'witch1', hp: 5, maxHp: 10, items: { [ResourceType.HERBS]: 1 } });
    const hero = makeEntity({ id: 'hero1', type: EntityType.HERO, owner: 'hero', col: 4, row: 4, hp: 8, maxHp: 8 });
    const sim = makeSim({ entities: [witch, hero] });
    const board = assessBoard(sim);
    const actions = genDefendWitch(sim, board, 2);
    const herbAction = actions.find(a => a.type === PlanActionType.USE_ITEM);
    assert.ok(herbAction, 'should emit USE_ITEM for herbs');
    assert.equal(herbAction.item, ResourceType.HERBS);
  });

  test('flees when witch HP critical', () => {
    const witch = makeEntity({ id: 'witch1', hp: 2, maxHp: 10, col: 2, row: 2 });
    const hero = makeEntity({ id: 'hero1', type: EntityType.HERO, owner: 'hero', col: 3, row: 2, hp: 8, maxHp: 8 });
    const sim = makeSim({ entities: [witch, hero] });
    const board = assessBoard(sim);
    const actions = genDefendWitch(sim, board, 2);
    const fleeAction = actions.find(a => a.type === PlanActionType.MOVE && a.entityId === 'witch1');
    assert.ok(fleeAction, 'should emit flee MOVE');
    // Should move away from hero (hero at col 3, witch at col 2, so flee toward lower col)
    assert.ok(fleeAction.toCol <= 2 || fleeAction.toRow !== 2,
      'flee should move away from hero');
  });

  test('returns empty actions with 0 budget', () => {
    const sim = makeSim();
    const board = assessBoard(sim);
    const actions = genDefendWitch(sim, board, 0);
    assert.equal(actions.length, 0);
  });

  test('interposes minion when hero is close', () => {
    const witch = makeEntity({ id: 'witch1', hp: 8, maxHp: 10, col: 0, row: 0 });
    const minion = makeEntity({ id: 'm1', type: EntityType.MINION, owner: 'witch', col: 3, row: 3, hp: 2, maxHp: 2 });
    const hero = makeEntity({ id: 'hero1', type: EntityType.HERO, owner: 'hero', col: 1, row: 1, hp: 8, maxHp: 8 });
    const sim = makeSim({ entities: [witch, minion, hero] });
    const board = assessBoard(sim);
    const actions = genDefendWitch(sim, board, 2);
    const minionMove = actions.find(a => a.type === PlanActionType.MOVE && a.entityId === 'm1');
    assert.ok(minionMove, 'should move minion toward witch to interpose');
  });
});

// ── genBuildArmy ────────────────────────────────────────────────────────────

describe('genBuildArmy', () => {
  test('produces SUMMON actions when resources available', () => {
    const sim = makeSim({ inventory: {
      witch: { [ResourceType.METAL]: 2, [ResourceType.WOOD]: 2 },
      hero: {},
    }});
    const board = assessBoard(sim);
    const actions = genBuildArmy(sim, board, 2);
    assert.ok(actions.length > 0, 'should produce at least one summon');
    assert.ok(actions.every(a => a.type === PlanActionType.SUMMON), 'all actions should be SUMMON');
  });

  test('respects resource constraints (no overdraw)', () => {
    const sim = makeSim({ inventory: {
      witch: { [ResourceType.WOOD]: 2 },
      hero: {},
    }});
    const board = assessBoard(sim);
    const actions = genBuildArmy(sim, board, 5);
    // Only 2 wood = only 1 summon possible
    assert.equal(actions.length, 1);
  });

  test('returns empty when cannot afford summon', () => {
    const sim = makeSim({ inventory: {
      witch: { [ResourceType.HERBS]: 1 },
      hero: {},
    }});
    const board = assessBoard(sim);
    const actions = genBuildArmy(sim, board, 3);
    assert.equal(actions.length, 0);
  });

  test('respects army cap', () => {
    // Day phase has cap of 5, create 5 existing minions
    const entities = [
      makeEntity({ id: 'witch1', col: 0, row: 0 }),
      ...Array.from({ length: 5 }, (_, i) =>
        makeEntity({ id: `m${i}`, type: EntityType.MINION, owner: 'witch', col: i + 1, row: 0, hp: 2, maxHp: 2 })
      ),
      makeEntity({ id: 'hero1', type: EntityType.HERO, owner: 'hero', col: 4, row: 4, hp: 8, maxHp: 8 }),
    ];
    const sim = makeSim({
      entities,
      phase: Phase.DAY,
      inventory: { witch: { [ResourceType.WOOD]: 4 }, hero: {} },
    });
    const board = assessBoard(sim);
    const actions = genBuildArmy(sim, board, 3);
    assert.equal(actions.length, 0, 'should not summon when at day army cap (5)');
  });

  test('deducts from resource ledger correctly', () => {
    const sim = makeSim({ inventory: {
      witch: { [ResourceType.METAL]: 4 },
      hero: {},
    }});
    const board = assessBoard(sim);
    genBuildArmy(sim, board, 3);
    assert.equal(sim.resourceLedger[ResourceType.METAL], 0, 'should have spent 4 metal on 2 iron golems');
  });
});

// ── genControlNodes ─────────────────────────────────────────────────────────

describe('genControlNodes', () => {
  test('assigns units to uncovered nodes', () => {
    const node = { col: 3, row: 0, label: 'Node A', hexes: [{ col: 3, row: 0 }] };
    const witch = makeEntity({ id: 'witch1', col: 0, row: 0 });
    const minion = makeEntity({ id: 'm1', type: EntityType.MINION, owner: 'witch', col: 1, row: 0, hp: 2, maxHp: 2 });
    const hero = makeEntity({ id: 'hero1', type: EntityType.HERO, owner: 'hero', col: 4, row: 4, hp: 8, maxHp: 8 });
    const sim = makeSim({ entities: [witch, minion, hero], witchObjectives: [node] });
    const board = assessBoard(sim);
    const actions = genControlNodes(sim, board, 3);
    assert.ok(actions.length > 0, 'should produce move actions toward node');
    assert.ok(actions.every(a => a.type === PlanActionType.MOVE || a.type === PlanActionType.GUARD));
  });

  test('assigns different units to different nodes', () => {
    const nodeA = { col: 3, row: 0, label: 'Node A', hexes: [{ col: 3, row: 0 }] };
    const nodeB = { col: 0, row: 3, label: 'Node B', hexes: [{ col: 0, row: 3 }] };
    const witch = makeEntity({ id: 'witch1', col: 0, row: 0 });
    const m1 = makeEntity({ id: 'm1', type: EntityType.MINION, owner: 'witch', col: 1, row: 0, hp: 2, maxHp: 2 });
    const m2 = makeEntity({ id: 'm2', type: EntityType.MINION, owner: 'witch', col: 0, row: 1, hp: 2, maxHp: 2 });
    const hero = makeEntity({ id: 'hero1', type: EntityType.HERO, owner: 'hero', col: 4, row: 4, hp: 8, maxHp: 8 });
    const sim = makeSim({ entities: [witch, m1, m2, hero], witchObjectives: [nodeA, nodeB] });
    const board = assessBoard(sim);
    const actions = genControlNodes(sim, board, 6);
    // Check that at least 2 different entities are being moved
    const movedEntities = new Set(actions.map(a => a.entityId));
    assert.ok(movedEntities.size >= 2, `should assign different units, got ${movedEntities.size}`);
  });

  test('battles enemy adjacent to unit on node', () => {
    const node = { col: 1, row: 0, label: 'Node A', hexes: [{ col: 1, row: 0 }] };
    const minion = makeEntity({ id: 'm1', type: EntityType.MINION, owner: 'witch', col: 1, row: 0, hp: 2, maxHp: 2 });
    const witch = makeEntity({ id: 'witch1', col: 0, row: 0 });
    // Hero adjacent (distance 1) to minion on node — should battle
    const hero = makeEntity({ id: 'hero1', type: EntityType.HERO, owner: 'hero', col: 2, row: 0, hp: 8, maxHp: 8 });
    const sim = makeSim({ entities: [witch, minion, hero], witchObjectives: [node] });
    const board = assessBoard(sim);
    const actions = genControlNodes(sim, board, 2);
    const battleAction = actions.find(a => a.type === PlanActionType.BATTLE_UNIT && a.entityId === 'm1');
    assert.ok(battleAction, 'should battle adjacent enemy on node');
  });

  test('returns empty with 0 budget', () => {
    const sim = makeSim();
    const board = assessBoard(sim);
    const actions = genControlNodes(sim, board, 0);
    assert.equal(actions.length, 0);
  });
});

// ── genKillHero ─────────────────────────────────────────────────────────────

describe('genKillHero', () => {
  test('battles adjacent hero', () => {
    const witch = makeEntity({ id: 'witch1', col: 1, row: 0 });
    const hero = makeEntity({ id: 'hero1', type: EntityType.HERO, owner: 'hero', col: 1, row: 1, hp: 8, maxHp: 8, attack: 3, defense: 2 });
    const sim = makeSim({ entities: [witch, hero] });
    const board = assessBoard(sim);
    const actions = genKillHero(sim, board, 2);
    const battleAction = actions.find(a => a.type === PlanActionType.BATTLE_UNIT);
    assert.ok(battleAction, 'should emit BATTLE_UNIT for adjacent hero');
    assert.equal(battleAction.targetId, 'hero1');
  });

  test('skips suicidal engagements', () => {
    // Minion (atk 1, def 0) vs Iron Golem stats hero (atk 5, def 5) — should be suicidal
    const minion = makeEntity({ id: 'm1', type: EntityType.MINION, owner: 'witch', col: 1, row: 0, hp: 2, maxHp: 2, attack: 1, defense: 0 });
    const witch = makeEntity({ id: 'witch1', col: 0, row: 0 });
    const hero = makeEntity({ id: 'hero1', type: EntityType.HERO, owner: 'hero', col: 1, row: 1, hp: 14, maxHp: 14, attack: 5, defense: 5 });
    const sim = makeSim({ entities: [witch, minion, hero], phase: Phase.DAY });
    const board = assessBoard(sim);
    const actions = genKillHero(sim, board, 2);
    const minionBattle = actions.find(a => a.type === PlanActionType.BATTLE_UNIT && a.entityId === 'm1');
    assert.ok(!minionBattle, 'should skip suicidal minion battle');
  });

  test('moves toward hero when not adjacent but within sight', () => {
    const witch = makeEntity({ id: 'witch1', col: 0, row: 0 });
    // Hero at distance 2 — within witch sight range
    const hero = makeEntity({ id: 'hero1', type: EntityType.HERO, owner: 'hero', col: 2, row: 0, hp: 8, maxHp: 8, attack: 3, defense: 2 });
    const sim = makeSim({ entities: [witch, hero] });
    const board = assessBoard(sim);
    const actions = genKillHero(sim, board, 2);
    const moveAction = actions.find(a => a.type === PlanActionType.MOVE);
    assert.ok(moveAction, 'should emit MOVE toward hero');
  });

  test('returns empty with no heroes', () => {
    const sim = makeSim({ entities: [makeEntity({ id: 'witch1' })] });
    const board = assessBoard(sim);
    const actions = genKillHero(sim, board, 3);
    assert.equal(actions.length, 0);
  });
});

// ── genGatherResources ──────────────────────────────────────────────────────

describe('genGatherResources', () => {
  test('explores current tile if unexplored', () => {
    const tiles = new Map();
    for (let c = 0; c < 5; c++) {
      for (let r = 0; r < 5; r++) {
        tiles.set(hexKey(c, r), {
          col: c, row: r, type: TileType.GRASS, explored: c !== 0 || r !== 0,
          building: null, resource: null, fortifyLevel: 0,
        });
      }
    }
    const witch = makeEntity({ id: 'witch1', col: 0, row: 0 });
    const hero = makeEntity({ id: 'hero1', type: EntityType.HERO, owner: 'hero', col: 4, row: 4, hp: 8, maxHp: 8 });
    const sim = makeSim({ entities: [witch, hero], tiles });
    const board = assessBoard(sim);
    const actions = genGatherResources(sim, board, 2);
    const exploreAction = actions.find(a => a.type === PlanActionType.EXPLORE);
    assert.ok(exploreAction, 'should explore current unexplored tile');
    assert.equal(exploreAction.entityId, 'witch1');
  });

  test('moves toward unexplored building then explores', () => {
    const tiles = new Map();
    for (let c = 0; c < 5; c++) {
      for (let r = 0; r < 5; r++) {
        tiles.set(hexKey(c, r), {
          col: c, row: r, type: TileType.GRASS, explored: true,
          building: null, resource: null, fortifyLevel: 0,
        });
      }
    }
    // Place an unexplored building at (1, 0)
    tiles.set(hexKey(1, 0), {
      col: 1, row: 0, type: TileType.BUILDING, explored: false,
      building: 'inn', resource: null, fortifyLevel: 0,
    });
    const witch = makeEntity({ id: 'witch1', col: 0, row: 0 });
    const hero = makeEntity({ id: 'hero1', type: EntityType.HERO, owner: 'hero', col: 4, row: 4, hp: 8, maxHp: 8 });
    const sim = makeSim({ entities: [witch, hero], tiles });
    const board = assessBoard(sim);
    const actions = genGatherResources(sim, board, 3);
    // Should move to (1,0) then explore
    const moveAction = actions.find(a => a.type === PlanActionType.MOVE);
    const exploreAction = actions.find(a => a.type === PlanActionType.EXPLORE);
    assert.ok(moveAction, 'should move toward building');
    assert.ok(exploreAction, 'should explore after arriving');
  });

  test('returns empty with 0 budget', () => {
    const sim = makeSim();
    const board = assessBoard(sim);
    const actions = genGatherResources(sim, board, 0);
    assert.equal(actions.length, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Phase 3: Plan Assembly
// ══════════════════════════════════════════════════════════════════════════════

describe('assemblePlan', () => {
  test('sorts actions by priority', () => {
    const sim = makeSim();
    const board = assessBoard(sim);
    const actions = [
      { type: PlanActionType.MOVE, entityId: 'witch1', toCol: 1, toRow: 0, _priority: 5, _goal: Goal.KILL_HERO },
      { type: PlanActionType.SUMMON, entityId: 'witch1', _priority: 2, _goal: Goal.BUILD_ARMY },
      { type: PlanActionType.USE_ITEM, entityId: 'witch1', item: ResourceType.HERBS, _priority: 0, _goal: Goal.DEFEND_WITCH },
    ];
    const plan = assemblePlan(actions, sim, board, new Map());
    assert.equal(plan[0].type, PlanActionType.USE_ITEM);
    assert.equal(plan[1].type, PlanActionType.SUMMON);
    assert.equal(plan[2].type, PlanActionType.MOVE);
  });

  test('strips internal _priority and _goal metadata', () => {
    const sim = makeSim();
    const board = assessBoard(sim);
    const actions = [
      { type: PlanActionType.SUMMON, entityId: 'witch1', _priority: 2, _goal: Goal.BUILD_ARMY },
    ];
    const plan = assemblePlan(actions, sim, board, new Map());
    assert.equal(plan[0]._priority, undefined);
    assert.equal(plan[0]._goal, undefined);
  });

  test('filters cross-turn oscillation (returning to previous position)', () => {
    const sim = makeSim();
    const board = assessBoard(sim);
    const prevPositions = new Map([['witch1', { col: 1, row: 0 }]]);
    const actions = [
      { type: PlanActionType.MOVE, entityId: 'witch1', toCol: 1, toRow: 0, _priority: 5, _goal: Goal.KILL_HERO },
    ];
    const plan = assemblePlan(actions, sim, board, prevPositions);
    const oscillating = plan.find(a => a.type === PlanActionType.MOVE && a.toCol === 1 && a.toRow === 0);
    assert.ok(!oscillating, 'should filter out move returning to previous-turn position');
  });

  test('filters intra-plan oscillation (returning to departed hex)', () => {
    const sim = makeSim();
    // Simulate that witch1 departed (0,0) during this plan
    sim.departedHexes.set('witch1', new Set([hexKey(0, 0)]));
    const board = assessBoard(sim);
    const actions = [
      { type: PlanActionType.MOVE, entityId: 'witch1', toCol: 0, toRow: 0, _priority: 5, _goal: Goal.KILL_HERO },
    ];
    const plan = assemblePlan(actions, sim, board, new Map());
    const oscillating = plan.find(a => a.type === PlanActionType.MOVE && a.toCol === 0 && a.toRow === 0);
    assert.ok(!oscillating, 'should filter out move returning to departed hex');
  });

  test('deduplicates identical moves', () => {
    const sim = makeSim();
    const board = assessBoard(sim);
    const actions = [
      { type: PlanActionType.MOVE, entityId: 'witch1', toCol: 1, toRow: 0, _priority: 3, _goal: Goal.KILL_HERO },
      { type: PlanActionType.MOVE, entityId: 'witch1', toCol: 1, toRow: 0, _priority: 5, _goal: Goal.CONTROL_NODES },
    ];
    const plan = assemblePlan(actions, sim, board, new Map());
    const moves = plan.filter(a => a.type === PlanActionType.MOVE && a.toCol === 1 && a.toRow === 0);
    assert.equal(moves.length, 1);
  });

  test('enforces budget (AP-costing actions capped)', () => {
    const sim = makeSim();
    const board = assessBoard(sim);
    // Budget is sim.actionsLeft (typically 4 for witch at night)
    const manyActions = Array.from({ length: 20 }, (_, i) => ({
      type: PlanActionType.MOVE, entityId: `unit${i}`, toCol: i % 5, toRow: 0,
      _priority: 3, _goal: Goal.CONTROL_NODES,
    }));
    const plan = assemblePlan(manyActions, sim, board, new Map());
    // AP-costing actions should not exceed budget
    const apActions = plan.filter(a => a.type !== PlanActionType.USE_ITEM && a.type !== PlanActionType.EQUIP_WEAPON);
    assert.ok(apActions.length <= board.totalBudget + 2, // +2 for gap-fill
      `AP actions (${apActions.length}) should be near budget (${board.totalBudget})`);
  });

  test('free actions (USE_ITEM) not counted against budget', () => {
    const sim = makeSim();
    const board = assessBoard(sim);
    const actions = [
      { type: PlanActionType.USE_ITEM, entityId: 'witch1', item: ResourceType.HERBS, _priority: 0, _goal: Goal.DEFEND_WITCH },
      { type: PlanActionType.SUMMON, entityId: 'witch1', _priority: 2, _goal: Goal.BUILD_ARMY },
    ];
    const plan = assemblePlan(actions, sim, board, new Map());
    assert.ok(plan.some(a => a.type === PlanActionType.USE_ITEM), 'USE_ITEM should be included');
    assert.ok(plan.some(a => a.type === PlanActionType.SUMMON), 'SUMMON should be included');
  });

  test('gap-fill adds guard when visible enemy nearby', () => {
    // Place hero within witch sight range (2 hexes) so guard triggers
    const witch = makeEntity({ id: 'witch1', col: 0, row: 0 });
    const hero = makeEntity({ id: 'hero1', type: EntityType.HERO, owner: 'hero', col: 1, row: 0, hp: 8, maxHp: 8 });
    const sim = makeSim({ entities: [witch, hero] });
    const board = assessBoard(sim);
    // Empty actions = all budget is remaining → gap-fill should add guard
    const plan = assemblePlan([], sim, board, new Map());
    assert.ok(plan.length > 0, 'gap-fill should add fallback actions');
    const guardAction = plan.find(a => a.type === PlanActionType.GUARD);
    assert.ok(guardAction, 'should include GUARD when enemy is nearby');
  });

  test('truncates to MAX_PLAN_LENGTH', () => {
    const sim = makeSim();
    // Give a large budget
    sim.actionsLeft = 20;
    const board = assessBoard(sim);
    const manyActions = Array.from({ length: 20 }, (_, i) => ({
      type: PlanActionType.MOVE, entityId: `unit${i}`, toCol: i % 5, toRow: Math.floor(i / 5),
      _priority: 3, _goal: Goal.CONTROL_NODES,
    }));
    const plan = assemblePlan(manyActions, sim, board, new Map());
    assert.ok(plan.length <= MAX_PLAN_LENGTH, `plan length ${plan.length} exceeds MAX_PLAN_LENGTH`);
  });

  test('non-move actions pass through anti-oscillation filter', () => {
    const sim = makeSim();
    const board = assessBoard(sim);
    const prevPositions = new Map([['witch1', { col: 0, row: 0 }]]);
    const actions = [
      { type: PlanActionType.SUMMON, entityId: 'witch1', _priority: 2, _goal: Goal.BUILD_ARMY },
      { type: PlanActionType.GUARD, entityId: 'witch1', _priority: 4, _goal: Goal.CONTROL_NODES },
    ];
    const plan = assemblePlan(actions, sim, board, prevPositions);
    assert.ok(plan.some(a => a.type === PlanActionType.SUMMON), 'SUMMON should not be filtered');
    assert.ok(plan.some(a => a.type === PlanActionType.GUARD), 'GUARD should not be filtered');
  });
});

// ── WitchAIEngine.generatePlan (integration) ───────────────────────────────

describe('WitchAIEngine.generatePlan (integration)', () => {
  test('produces non-empty plan with valid action types', () => {
    const state = makeFakeState({
      inventory: { witch: { [ResourceType.WOOD]: 4, [ResourceType.METAL]: 2 }, hero: {} },
      witchObjectives: [
        { col: 3, row: 0, label: 'Node A', hexes: [{ col: 3, row: 0 }] },
      ],
    });
    const engine = new WitchAIEngine(state, () => {}, 0);
    const plan = engine.generatePlan();
    assert.ok(plan.length > 0, 'plan should not be empty');
    const validTypes = new Set(Object.values(PlanActionType));
    for (const action of plan) {
      assert.ok(validTypes.has(action.type), `invalid action type: ${action.type}`);
    }
  });

  test('plan has no internal metadata (_priority, _goal)', () => {
    const state = makeFakeState({
      inventory: { witch: { [ResourceType.WOOD]: 4 }, hero: {} },
      witchObjectives: [
        { col: 3, row: 0, label: 'Node A', hexes: [{ col: 3, row: 0 }] },
      ],
    });
    const engine = new WitchAIEngine(state, () => {}, 0);
    const plan = engine.generatePlan();
    for (const action of plan) {
      assert.equal(action._priority, undefined, 'should strip _priority');
      assert.equal(action._goal, undefined, 'should strip _goal');
    }
  });

  test('plan length does not exceed MAX_PLAN_LENGTH', () => {
    const state = makeFakeState({
      inventory: { witch: { [ResourceType.WOOD]: 10, [ResourceType.METAL]: 10 }, hero: {} },
      witchObjectives: [
        { col: 3, row: 0, label: 'Node A', hexes: [{ col: 3, row: 0 }] },
        { col: 0, row: 3, label: 'Node B', hexes: [{ col: 0, row: 3 }] },
        { col: 4, row: 4, label: 'Node C', hexes: [{ col: 4, row: 4 }] },
      ],
    });
    const engine = new WitchAIEngine(state, () => {}, 0);
    const plan = engine.generatePlan();
    assert.ok(plan.length <= MAX_PLAN_LENGTH, `plan length ${plan.length} exceeds MAX_PLAN_LENGTH`);
  });

  test('cross-turn memory prevents oscillation', () => {
    const state = makeFakeState({
      inventory: { witch: { [ResourceType.WOOD]: 2 }, hero: {} },
    });
    const engine = new WitchAIEngine(state, () => {}, 0);

    // First plan: witch starts at (0,0), may move to (1,0)
    const plan1 = engine.generatePlan();
    const firstMove = plan1.find(a => a.type === PlanActionType.MOVE && a.entityId === 'witch1');

    if (firstMove) {
      // Manually place witch at the moved-to position for next turn
      state.entities = state.entities.map(e => {
        if (e.id === 'witch1') return { ...e, col: firstMove.toCol, row: firstMove.toRow };
        return e;
      });
      const plan2 = engine.generatePlan();
      // Should not have a move back to (0,0) for witch1
      const backMove = plan2.find(a =>
        a.type === PlanActionType.MOVE && a.entityId === 'witch1' &&
        a.toCol === 0 && a.toRow === 0
      );
      assert.ok(!backMove, 'cross-turn memory should prevent returning to (0,0)');
    }
  });
});

// ── PERSONALITY_CONFIGS ─────────────────────────────────────────────────────

describe('PERSONALITY_CONFIGS', () => {
  test('all three presets exist with required fields', () => {
    for (const name of ['balanced', 'aggressive', 'swarm']) {
      const cfg = PERSONALITY_CONFIGS[name];
      assert.ok(cfg, `${name} config exists`);
      assert.ok(cfg.goalWeights, `${name} has goalWeights`);
      assert.equal(typeof cfg.fleeThreshold, 'number');
      assert.equal(typeof cfg.engageFloor, 'string');
      // All 5 goals have weights
      for (const g of Object.values(Goal)) {
        assert.equal(typeof cfg.goalWeights[g], 'number', `${name} has weight for ${g}`);
      }
    }
  });

  test('goalWeights affect scoreGoals output', () => {
    const board = makeBoard({ heroDistance: 2, isNight: true, witchHpRatio: 0.8 });
    const baseScores = scoreGoals(board);
    const aggroScores = scoreGoals(board, PERSONALITY_CONFIGS.aggressive.goalWeights);
    // Aggressive boosts KILL_HERO (x1.8) and reduces GATHER (x0.4)
    assert.ok(aggroScores[Goal.KILL_HERO] >= baseScores[Goal.KILL_HERO],
      'aggressive should boost KILL_HERO');
    assert.ok(aggroScores[Goal.GATHER_RESOURCES] <= baseScores[Goal.GATHER_RESOURCES],
      'aggressive should reduce GATHER_RESOURCES');
  });

  test('createWitchAI creates engine with named config', () => {
    const state = makeFakeState();
    const ai = createWitchAI('aggressive', state, () => {});
    assert.ok(ai instanceof WitchAIEngine);
    assert.deepEqual(ai.config, PERSONALITY_CONFIGS.aggressive);
  });

  test('createWitchAI defaults to balanced for unknown personality', () => {
    const state = makeFakeState();
    const ai = createWitchAI('nonexistent', state, () => {});
    assert.deepEqual(ai.config, PERSONALITY_CONFIGS.balanced);
  });
});

// ── Personality-varied behavior ─────────────────────────────────────────────

describe('personality-varied behavior', () => {
  test('aggressive flees at lower HP threshold than balanced', () => {
    const sim = makeSim({ witchHp: 2, witchMaxHp: 10 }); // 20% HP
    const board = makeBoard({
      witch: sim.entities.find(e => e.type === EntityType.WITCH),
      witchHpRatio: 0.2,
      visibleHeroes: [makeEntity({ id: 'h1', type: EntityType.HERO, owner: 'hero', col: 2, row: 0 })],
      heroDistance: 2,
      minions: [],
    });

    // Balanced flees at 0.3 → 0.2 < 0.3 → should flee
    const balancedActions = genDefendWitch(sim, board, 3, PERSONALITY_CONFIGS.balanced);
    const fleeBalanced = balancedActions.some(a => a.type === PlanActionType.MOVE && a._goal === Goal.DEFEND_WITCH);
    assert.ok(fleeBalanced, 'balanced should flee at 20% HP');

    // Reset sim state for aggressive test
    const sim2 = makeSim({ witchHp: 2, witchMaxHp: 10 });
    // Aggressive flees at 0.15 → 0.2 > 0.15 → should NOT flee
    const aggroActions = genDefendWitch(sim2, board, 3, PERSONALITY_CONFIGS.aggressive);
    const fleeAggro = aggroActions.some(a => a.type === PlanActionType.MOVE && a._goal === Goal.DEFEND_WITCH);
    assert.ok(!fleeAggro, 'aggressive should not flee at 20% HP (threshold is 15%)');
  });
});

// ── WITCH_PERSONALITIES registry ────────────────────────────────────────────

describe('WITCH_PERSONALITIES registry', () => {
  test('all personality configs are registered', async () => {
    const { WITCH_PERSONALITIES } = await import('../src/ai.js');
    // Import ai-engine.js to trigger registration
    await import('../src/ai-engine.js');
    for (const name of Object.keys(PERSONALITY_CONFIGS)) {
      assert.ok(WITCH_PERSONALITIES[name], `${name} registered in WITCH_PERSONALITIES`);
    }
  });

  test('registered personalities create working AI instances', async () => {
    const { WITCH_PERSONALITIES } = await import('../src/ai.js');
    await import('../src/ai-engine.js');
    const state = makeFakeState();
    for (const [name, Cls] of Object.entries(WITCH_PERSONALITIES)) {
      const ai = new Cls(state, () => {}, 0);
      assert.ok(ai instanceof WitchAIEngine, `${name} is a WitchAIEngine`);
      const plan = ai.generatePlan();
      assert.ok(Array.isArray(plan), `${name} generates an array plan`);
    }
  });
});

// ── Leaderless mode (campaign missions without a witch) ─────────────────────

describe('leaderless mode (no witch entity)', () => {
  test('generates a non-empty plan with minions only', () => {
    const state = makeFakeState({
      entities: [
        // No witch entity — only minions and a hero
        makeEntity({ id: 'hero1', type: EntityType.HERO, owner: 'hero', col: 3, row: 0, hp: 14, maxHp: 14, attack: 3, defense: 2 }),
        makeEntity({ id: 'z1', type: EntityType.MINION, owner: 'witch', col: 1, row: 0, hp: 2, maxHp: 2, attack: 1, defense: 0 }),
        makeEntity({ id: 'z2', type: EntityType.MINION, owner: 'witch', col: 0, row: 1, hp: 2, maxHp: 2, attack: 1, defense: 0 }),
      ],
    });
    const engine = new WitchAIEngine(state, () => {}, 0);
    const plan = engine.generatePlan();
    assert.ok(plan.length > 0, 'leaderless plan should not be empty');
    // Should have MOVE actions chasing the hero
    const moves = plan.filter(a => a.type === PlanActionType.MOVE);
    assert.ok(moves.length > 0, 'minions should move toward hero');
  });

  test('minions attack adjacent hero units', () => {
    const state = makeFakeState({
      entities: [
        makeEntity({ id: 'hero1', type: EntityType.HERO, owner: 'hero', col: 1, row: 0, hp: 14, maxHp: 14, attack: 3, defense: 2 }),
        makeEntity({ id: 'z1', type: EntityType.MINION, owner: 'witch', col: 1, row: 0, hp: 2, maxHp: 2, attack: 1, defense: 0 }),
      ],
    });
    const engine = new WitchAIEngine(state, () => {}, 0);
    const plan = engine.generatePlan();
    const battles = plan.filter(a => a.type === PlanActionType.BATTLE_UNIT);
    assert.ok(battles.length > 0, 'minion should attack co-located hero');
    assert.equal(battles[0].entityId, 'z1');
    assert.equal(battles[0].targetId, 'hero1');
  });

  test('returns empty plan when no minions exist', () => {
    const state = makeFakeState({
      entities: [
        makeEntity({ id: 'hero1', type: EntityType.HERO, owner: 'hero', col: 1, row: 0, hp: 14, maxHp: 14, attack: 3, defense: 2 }),
      ],
    });
    const engine = new WitchAIEngine(state, () => {}, 0);
    const plan = engine.generatePlan();
    assert.equal(plan.length, 0, 'no minions means empty plan');
  });
});
