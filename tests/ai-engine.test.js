// Tests for src/ai-engine.js — Phase 1: Foundation
// Covers EnginePlanSimState, assessBoard, scoreGoals, allocateBudget.

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
} from '../src/ai-engine.js';
import { PlanActionType } from '../src/planner.js';

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
    const nightScores = scoreGoals(makeBoard({ isNight: true, isDay: false }));
    const dayScores = scoreGoals(makeBoard({ isNight: false, isDay: true }));
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

  test('each qualifying goal gets >= 1 AP', () => {
    const scores = {
      [Goal.KILL_HERO]: 0.9,
      [Goal.CONTROL_NODES]: 0.06,
      [Goal.BUILD_ARMY]: 0.06,
      [Goal.GATHER_RESOURCES]: 0.06,
      [Goal.DEFEND_WITCH]: 0.06,
    };
    const result = allocateBudget(scores, 5);
    for (const g of Object.values(Goal)) {
      assert.ok(result[g] >= 1, `${g} should get >= 1 AP, got ${result[g]}`);
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

  test('no qualifying goals gives all to DEFEND_WITCH', () => {
    const scores = {
      [Goal.KILL_HERO]: 0.01,
      [Goal.CONTROL_NODES]: 0.0,
      [Goal.BUILD_ARMY]: 0.0,
      [Goal.GATHER_RESOURCES]: 0.0,
      [Goal.DEFEND_WITCH]: 0.0,
    };
    const result = allocateBudget(scores, 4);
    assert.equal(result[Goal.DEFEND_WITCH], 4);
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

  test('guards if on node with nearby threat', () => {
    const node = { col: 1, row: 0, label: 'Node A', hexes: [{ col: 1, row: 0 }] };
    const minion = makeEntity({ id: 'm1', type: EntityType.MINION, owner: 'witch', col: 1, row: 0, hp: 2, maxHp: 2 });
    const witch = makeEntity({ id: 'witch1', col: 0, row: 0 });
    const hero = makeEntity({ id: 'hero1', type: EntityType.HERO, owner: 'hero', col: 2, row: 0, hp: 8, maxHp: 8 });
    const sim = makeSim({ entities: [witch, minion, hero], witchObjectives: [node] });
    const board = assessBoard(sim);
    const actions = genControlNodes(sim, board, 2);
    const guardAction = actions.find(a => a.type === PlanActionType.GUARD && a.entityId === 'm1');
    assert.ok(guardAction, 'should guard on node when hero is nearby');
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

  test('moves toward hero when not adjacent', () => {
    const witch = makeEntity({ id: 'witch1', col: 0, row: 0 });
    const hero = makeEntity({ id: 'hero1', type: EntityType.HERO, owner: 'hero', col: 4, row: 4, hp: 8, maxHp: 8, attack: 3, defense: 2 });
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

// ── WitchAIEngine.generatePlan (Phase 2 integration) ───────────────────────

describe('WitchAIEngine.generatePlan (Phase 2)', () => {
  test('produces non-empty plan with valid action types', async () => {
    // Set up a state where the engine should produce actions
    const { WitchAIEngine } = await import('../src/ai-engine.js');
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

  test('plan length does not exceed MAX_PLAN_LENGTH', async () => {
    const { WitchAIEngine } = await import('../src/ai-engine.js');
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
    assert.ok(plan.length <= 12, `plan length ${plan.length} exceeds MAX_PLAN_LENGTH (12)`);
  });
});
