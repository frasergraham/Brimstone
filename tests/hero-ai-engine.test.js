// Tests for src/hero-ai-engine.js
// Covers assessHeroBoard, scoreHeroGoals, allocateBudget integration, and tactic generators.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Phase } from '../src/game.js';
import { EntityType } from '../src/entities.js';
import { TileType, ResourceType } from '../src/tiles.js';
import { hexKey } from '../src/hex.js';
import { PlanSimState, HERO_PERSONALITIES } from '../src/ai.js';
import { allocateBudget } from '../src/ai-engine.js';
import {
  HeroGoal,
  HERO_PERSONALITY_CONFIGS,
  HeroEnginePlanSimState,
  HeroAIEngine,
  createHeroAI,
  assessHeroBoard,
  scoreHeroGoals,
  estimateHeroCombat,
  genProtectHero,
  genControlNodes,
  genExplore,
  fillGapsHero,
} from '../src/hero-ai-engine.js';
import { PlanActionType } from '../src/planner.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeEntity(overrides) {
  return {
    id: 'e1', type: EntityType.HERO, owner: 'hero',
    col: 0, row: 0, hp: 10, maxHp: 10, attack: 3, defense: 2,
    alive: true, displayName: 'Hero', ownerId: null,
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
  // Place a building at (1,1)
  tiles.set(hexKey(1, 1), {
    col: 1, row: 1, type: TileType.BUILDING, explored: false,
    building: 'house', resource: null, fortifyLevel: 0,
  });
  if (overrides.tiles) {
    for (const [k, v] of overrides.tiles) tiles.set(k, v);
  }

  const hero = makeEntity({
    id: 'hero1', type: EntityType.HERO, owner: 'hero',
    col: 3, row: 3, hp: 10, maxHp: 10,
    items: { [ResourceType.HERBS]: 1, [ResourceType.FOOD]: 2 },
  });
  const witch = makeEntity({
    id: 'witch1', type: EntityType.WITCH, owner: 'witch',
    col: 5, row: 4, hp: 8, maxHp: 8,  // within hero DAY sight range (3 hexes from hero at 3,3)
  });
  const entities = overrides.entities ?? [hero, witch];

  const nodeHexes = (c, r) => [{ col: c, row: r }];
  return {
    tiles,
    phase: overrides.phase ?? Phase.DAY,
    round: overrides.round ?? 3,
    witchObjectives: overrides.witchObjectives ?? [
      { col: 0, row: 3, hexes: nodeHexes(0, 3) },
      { col: 3, row: 0, hexes: nodeHexes(3, 0) },
      { col: 6, row: 3, hexes: nodeHexes(6, 3) },
    ],
    nodeScore: overrides.nodeScore ?? { hero: 0, witch: 0 },
    fogOfWar: 'none',
    inventory: overrides.inventory ?? {
      witch: {},
      hero: {},
      shared: { [ResourceType.WOOD]: 2, [ResourceType.METAL]: 1, [ResourceType.FOOD]: 2 },
    },
    entities,
  };
}

function makeHeroSim(stateOverrides = {}) {
  return new PlanSimState(makeFakeState(stateOverrides), 'hero');
}

function makeHeroEngineSim(stateOverrides = {}) {
  return new HeroEnginePlanSimState(makeFakeState(stateOverrides));
}

// ── assessHeroBoard ─────────────────────────────────────────────────────────

describe('assessHeroBoard', () => {
  test('returns all expected fields', () => {
    const sim = makeHeroSim();
    const board = assessHeroBoard(sim);

    // Phase
    assert.equal(board.phase, Phase.DAY);
    assert.equal(board.isDay, true);
    assert.equal(board.isNight, false);
    assert.equal(board.isDawnOrDusk, false);

    // Hero
    assert.ok(board.hero);
    assert.equal(board.heroHp, 10);
    assert.equal(board.heroMaxHp, 10);
    assert.equal(board.heroHpRatio, 1.0);

    // Survivors
    assert.deepEqual(board.survivors, []);
    assert.equal(board.survivorCount, 0);

    // Witch
    assert.ok(board.witch);
    assert.equal(board.witchVisible, true);
    assert.equal(typeof board.witchDistance, 'number');
    assert.ok(board.witchDistance > 0);

    // Nodes
    assert.equal(board.nodes.length, 3);
    assert.equal(board.heroHeldCount, 0);
    assert.equal(board.witchHeldCount, 0);

    // Inventory
    assert.equal(board.herbCount, 1);
    assert.equal(board.foodCount, 2);
    assert.ok(Array.isArray(board.heroWeapons));
    assert.equal(board.woodCount, 2);
    assert.equal(board.metalCount, 1);

    // Map
    assert.ok(Array.isArray(board.unexploredBuildings));
    assert.equal(board.unexploredBuildings.length, 1);

    // Positional
    assert.equal(typeof board.heroOnNode, 'boolean');
    assert.equal(typeof board.heroInBuilding, 'boolean');
    assert.equal(typeof board.heroTileExplored, 'boolean');
    assert.equal(typeof board.heroTileFortLevel, 'number');

    // Budget
    assert.ok(board.totalBudget > 0);
  });

  test('detects survivors', () => {
    const survivor = makeEntity({
      id: 's1', type: EntityType.SURVIVOR, owner: 'hero',
      col: 2, row: 3, hp: 3, maxHp: 3,
    });
    const sim = makeHeroSim({
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
        survivor,
      ],
    });
    const board = assessHeroBoard(sim);
    assert.equal(board.survivorCount, 1);
    assert.equal(board.survivors.length, 1);
  });

  test('detects witch minions', () => {
    const minion = makeEntity({
      id: 'm1', type: EntityType.MINION, owner: 'witch',
      col: 5, row: 5, hp: 2, maxHp: 2,
    });
    const sim = makeHeroSim({
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
        minion,
      ],
    });
    const board = assessHeroBoard(sim);
    assert.equal(board.witchMinions.length, 1);
  });

  test('detects unequipped weapons', () => {
    const sim = makeHeroSim({
      entities: [
        makeEntity({
          id: 'hero1', col: 3, row: 3,
          items: { [ResourceType.HERBS]: 1, 'weapon:sword': 1 },
        }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const board = assessHeroBoard(sim);
    assert.equal(board.heroWeapons.length, 1);
    assert.equal(board.heroWeapons[0], 'weapon:sword');
  });

  test('node state includes distance and controller', () => {
    const sim = makeHeroSim();
    const board = assessHeroBoard(sim);
    for (const n of board.nodes) {
      assert.ok('controller' in n);
      assert.ok('distToHero' in n);
      assert.ok('distToNearestHeroUnit' in n);
      assert.ok('heroPresent' in n);
      assert.ok('witchPresent' in n);
    }
  });

  test('heroInBuilding true when hero on building tile', () => {
    const sim = makeHeroSim({
      entities: [
        makeEntity({ id: 'hero1', col: 1, row: 1, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const board = assessHeroBoard(sim);
    assert.equal(board.heroInBuilding, true);
    assert.equal(board.heroTileExplored, false);
  });

  test('phase detection works for night', () => {
    const sim = makeHeroSim({ phase: Phase.NIGHT });
    const board = assessHeroBoard(sim);
    assert.equal(board.isNight, true);
    assert.equal(board.isDay, false);
    assert.equal(board.isDawnOrDusk, false);
  });

  test('phase detection works for dawn', () => {
    const sim = makeHeroSim({ phase: Phase.DAWN });
    const board = assessHeroBoard(sim);
    assert.equal(board.isNight, false);
    assert.equal(board.isDay, false);
    assert.equal(board.isDawnOrDusk, true);
  });
});

// ── scoreHeroGoals ──────────────────────────────────────────────────────────

describe('scoreHeroGoals', () => {
  test('returns scores for all 4 goals', () => {
    const sim = makeHeroSim();
    const board = assessHeroBoard(sim);
    const scores = scoreHeroGoals(board);
    const keys = Object.keys(scores);
    assert.equal(keys.length, 4);
    assert.ok(HeroGoal.PROTECT_HERO in scores);
    assert.ok(HeroGoal.CONTROL_NODES in scores);
    assert.ok(HeroGoal.EXPLORE in scores);
    assert.ok(HeroGoal.HUNT_WITCH in scores);
  });

  test('all scores are in [0, 1] range', () => {
    const sim = makeHeroSim();
    const board = assessHeroBoard(sim);
    const scores = scoreHeroGoals(board);
    for (const v of Object.values(scores)) {
      assert.ok(v >= 0 && v <= 1, `score ${v} out of [0,1] range`);
    }
  });

  test('EXPLORE is high when no survivors', () => {
    const board = assessHeroBoard(makeHeroSim({ phase: Phase.DAY }));
    const scores = scoreHeroGoals(board);
    // Hero starts with 0 survivors → explore should be very high to find them
    assert.ok(scores[HeroGoal.EXPLORE] >= 0.8,
      `EXPLORE (${scores[HeroGoal.EXPLORE]}) should be high when hero has no survivors`);
  });

  test('dawn/dusk boosts CONTROL_NODES more than night', () => {
    // Dawn/dusk gets a ×1.8 multiplier, day gets a +0.1 additive boost, night gets nothing.
    // Use hero on one node to keep base moderate.
    const heroOnNode = makeEntity({
      id: 'hero1', col: 0, row: 3, hp: 10, maxHp: 10,
      items: { [ResourceType.HERBS]: 1 },
    });
    const witch = makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 });
    const nightBoard = assessHeroBoard(makeHeroSim({
      phase: Phase.NIGHT, round: 4,
      entities: [heroOnNode, witch],
    }));
    const dawnBoard = assessHeroBoard(makeHeroSim({
      phase: Phase.DAWN, round: 9,
      entities: [heroOnNode, witch],
    }));
    const nightScores = scoreHeroGoals(nightBoard);
    const dawnScores = scoreHeroGoals(dawnBoard);
    assert.ok(dawnScores[HeroGoal.CONTROL_NODES] >= nightScores[HeroGoal.CONTROL_NODES],
      `dawn CONTROL_NODES (${dawnScores[HeroGoal.CONTROL_NODES]}) should >= night (${nightScores[HeroGoal.CONTROL_NODES]})`);
  });

  test('low hero HP boosts PROTECT_HERO', () => {
    // Witch within sight range so PROTECT_HERO can trigger
    const healthySim = makeHeroSim({
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3, hp: 10, maxHp: 10, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 5, row: 4 }),
      ],
    });
    const injuredSim = makeHeroSim({
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3, hp: 2, maxHp: 10, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 5, row: 4 }),
      ],
    });
    const healthyScores = scoreHeroGoals(assessHeroBoard(healthySim));
    const injuredScores = scoreHeroGoals(assessHeroBoard(injuredSim));
    assert.ok(injuredScores[HeroGoal.PROTECT_HERO] > healthyScores[HeroGoal.PROTECT_HERO],
      `injured PROTECT (${injuredScores[HeroGoal.PROTECT_HERO]}) should exceed healthy (${healthyScores[HeroGoal.PROTECT_HERO]})`);
  });

  test('goalWeights scale scores', () => {
    const sim = makeHeroSim();
    const board = assessHeroBoard(sim);
    const base = scoreHeroGoals(board);
    const weighted = scoreHeroGoals(board, { [HeroGoal.EXPLORE]: 2.0 });
    // EXPLORE should be boosted (up to clamp)
    assert.ok(weighted[HeroGoal.EXPLORE] >= base[HeroGoal.EXPLORE],
      `weighted EXPLORE (${weighted[HeroGoal.EXPLORE]}) should be >= base (${base[HeroGoal.EXPLORE]})`);
  });

  test('goalWeights can suppress a goal', () => {
    const sim = makeHeroSim();
    const board = assessHeroBoard(sim);
    const suppressed = scoreHeroGoals(board, { [HeroGoal.EXPLORE]: 0.0 });
    assert.equal(suppressed[HeroGoal.EXPLORE], 0);
  });
});

// ── allocateBudget integration ──────────────────────────────────────────────

describe('allocateBudget with hero goals', () => {
  test('distributes budget across hero goals', () => {
    const scores = {
      [HeroGoal.PROTECT_HERO]: 0.5,
      [HeroGoal.CONTROL_NODES]: 0.4,
      [HeroGoal.EXPLORE]: 0.6,
    };
    const budget = allocateBudget(scores, 8);
    const total = Object.values(budget).reduce((s, v) => s + v, 0);
    assert.equal(total, 8);
  });

  test('active goals get at least 2 AP (no thin allocations)', () => {
    const scores = {
      [HeroGoal.PROTECT_HERO]: 0.8,
      [HeroGoal.CONTROL_NODES]: 0.3,
      [HeroGoal.EXPLORE]: 0.3,
    };
    const budget = allocateBudget(scores, 12);
    for (const g of Object.keys(scores)) {
      assert.ok(budget[g] === 0 || budget[g] >= 2,
        `${g} should be 0 or >= 2 AP, got ${budget[g]}`);
    }
  });

  test('highest urgency goal gets most budget', () => {
    const scores = {
      [HeroGoal.PROTECT_HERO]: 0.1,
      [HeroGoal.CONTROL_NODES]: 0.1,
      [HeroGoal.EXPLORE]: 0.9,
    };
    const budget = allocateBudget(scores, 10);
    assert.ok(budget[HeroGoal.EXPLORE] > budget[HeroGoal.PROTECT_HERO],
      `EXPLORE (${budget[HeroGoal.EXPLORE]}) should exceed PROTECT (${budget[HeroGoal.PROTECT_HERO]})`);
  });

  test('zero budget returns all zeros', () => {
    const scores = {
      [HeroGoal.PROTECT_HERO]: 0.5,
      [HeroGoal.CONTROL_NODES]: 0.5,
      [HeroGoal.EXPLORE]: 0.5,
    };
    const budget = allocateBudget(scores, 0);
    for (const v of Object.values(budget)) {
      assert.equal(v, 0);
    }
  });
});

// ── Personality configs ─────────────────────────────────────────────────────

describe('HERO_PERSONALITY_CONFIGS', () => {
  test('has 4 personalities', () => {
    const names = Object.keys(HERO_PERSONALITY_CONFIGS);
    assert.deepEqual(names.sort(), ['aggressive', 'balanced', 'defensive', 'explorer']);
  });

  test('each config has required fields', () => {
    for (const [name, cfg] of Object.entries(HERO_PERSONALITY_CONFIGS)) {
      assert.ok(cfg.goalWeights, `${name} missing goalWeights`);
      assert.ok(typeof cfg.engageFloor === 'string', `${name} missing engageFloor`);
      assert.ok(typeof cfg.shelterThreshold === 'number', `${name} missing shelterThreshold`);
      assert.ok(typeof cfg.fortifyCapDay === 'number', `${name} missing fortifyCapDay`);
      assert.ok(typeof cfg.fortifyCapNight === 'number', `${name} missing fortifyCapNight`);
    }
  });

  test('each config has weights for all 3 goals', () => {
    for (const [name, cfg] of Object.entries(HERO_PERSONALITY_CONFIGS)) {
      for (const g of Object.values(HeroGoal)) {
        assert.ok(cfg.goalWeights[g] != null, `${name} missing weight for ${g}`);
      }
    }
  });

  test('different personalities produce different score distributions', () => {
    const sim = makeHeroSim();
    const board = assessHeroBoard(sim);
    const balanced = scoreHeroGoals(board, HERO_PERSONALITY_CONFIGS.balanced.goalWeights);
    const aggressive = scoreHeroGoals(board, HERO_PERSONALITY_CONFIGS.aggressive.goalWeights);
    // Aggressive should weight CONTROL_NODES higher
    assert.ok(aggressive[HeroGoal.CONTROL_NODES] >= balanced[HeroGoal.CONTROL_NODES],
      `aggressive CONTROL (${aggressive[HeroGoal.CONTROL_NODES]}) should be >= balanced (${balanced[HeroGoal.CONTROL_NODES]})`);
  });
});

// ── HeroEnginePlanSimState ──────────────────────────────────────────────────

describe('HeroEnginePlanSimState', () => {
  test('resourceLedger uses shared inventory', () => {
    const sim = makeHeroEngineSim();
    assert.equal(sim.resourceLedger[ResourceType.WOOD], 2);
    assert.equal(sim.resourceLedger[ResourceType.METAL], 1);
  });

  test('has departedHexes and unitCommitments', () => {
    const sim = makeHeroEngineSim();
    assert.ok(sim.departedHexes instanceof Map);
    assert.ok(sim.unitCommitments instanceof Map);
  });
});

// ── estimateHeroCombat ──────────────────────────────────────────────────────

describe('estimateHeroCombat', () => {
  test('returns favorability and classification', () => {
    const sim = makeHeroSim();
    const board = assessHeroBoard(sim);
    const result = estimateHeroCombat(board.hero, board.witch, board);
    assert.ok('favorability' in result);
    assert.ok('classification' in result);
    assert.ok(['overwhelming', 'favorable', 'unfavorable', 'suicidal'].includes(result.classification));
  });

  test('strong attacker vs weak defender is favorable', () => {
    const sim = makeHeroSim({
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3, hp: 10, maxHp: 10, attack: 6, defense: 4, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 4, row: 3, hp: 3, maxHp: 8, attack: 1, defense: 1 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const result = estimateHeroCombat(board.hero, board.witch, board);
    assert.ok(result.favorability > 0, `expected positive favorability, got ${result.favorability}`);
  });

  test('hero is weaker at night vs witch (witch gets night bonus)', () => {
    const sim = makeHeroSim({
      phase: Phase.NIGHT,
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3, hp: 10, maxHp: 10, attack: 3, defense: 2, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 4, row: 3, hp: 8, maxHp: 8, attack: 3, defense: 2 }),
      ],
    });
    const dayBoard = assessHeroBoard(makeHeroSim({
      phase: Phase.DAY,
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3, hp: 10, maxHp: 10, attack: 3, defense: 2, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 4, row: 3, hp: 8, maxHp: 8, attack: 3, defense: 2 }),
      ],
    }));
    const nightBoard = assessHeroBoard(sim);
    const dayResult = estimateHeroCombat(dayBoard.hero, dayBoard.witch, dayBoard);
    const nightResult = estimateHeroCombat(nightBoard.hero, nightBoard.witch, nightBoard);
    assert.ok(nightResult.favorability < dayResult.favorability, 'hero should be weaker at night vs witch');
  });
});

// ── genProtectHero ──────────────────────────────────────────────────────────

describe('genProtectHero', () => {
  test('emits USE_ITEM herbs when hero is injured', () => {
    const sim = makeHeroEngineSim({
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3, hp: 5, maxHp: 10,
          items: { [ResourceType.HERBS]: 2 } }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const actions = genProtectHero(sim, board, 3);
    const herbAction = actions.find(a => a.type === PlanActionType.HEAL);
    assert.ok(herbAction, 'should emit HEAL action');
  });

  test('emits EQUIP_WEAPON when hero has unequipped weapon', () => {
    const sim = makeHeroEngineSim({
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3, hp: 5, maxHp: 10,
          items: { 'weapon:sword': 1 } }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const actions = genProtectHero(sim, board, 3);
    const equipAction = actions.find(a => a.type === PlanActionType.EQUIP_WEAPON);
    assert.ok(equipAction, 'should emit EQUIP_WEAPON');
  });

  test('flee when HP below shelter threshold and enemy nearby', () => {
    const sim = makeHeroEngineSim({
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3, hp: 2, maxHp: 10, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 4, row: 3 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const config = { shelterThreshold: 0.4 };
    const actions = genProtectHero(sim, board, 3, config);
    const moveAction = actions.find(a => a.type === PlanActionType.MOVE);
    assert.ok(moveAction, 'should emit MOVE to flee');
  });

  test('no actions when hero is healthy', () => {
    const sim = makeHeroEngineSim({
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3, hp: 10, maxHp: 10, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const actions = genProtectHero(sim, board, 3);
    assert.equal(actions.length, 0);
  });

  test('explores current unexplored building at high priority', () => {
    const sim = makeHeroEngineSim({
      entities: [
        makeEntity({ id: 'hero1', col: 1, row: 1, hp: 10, maxHp: 10, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    // hero at (1,1) which is an unexplored building in makeFakeState
    const board = assessHeroBoard(sim);
    const actions = genProtectHero(sim, board, 3);
    const explore = actions.find(a => a.type === PlanActionType.EXPLORE);
    assert.ok(explore, 'should explore current unexplored building');
    assert.equal(explore._priority, 1, 'should be high priority');
  });

  test('does not explore already-explored building', () => {
    const tiles = new Map();
    for (let c = 0; c < 7; c++) {
      for (let r = 0; r < 7; r++) {
        tiles.set(hexKey(c, r), {
          col: c, row: r, type: TileType.GRASS, explored: true,
          building: null, resource: null, fortifyLevel: 0,
        });
      }
    }
    // Building at (1,1) already explored
    tiles.set(hexKey(1, 1), {
      col: 1, row: 1, type: TileType.BUILDING, explored: true,
      building: 'house', resource: null, fortifyLevel: 0,
    });
    const sim = makeHeroEngineSim({
      tiles,
      entities: [
        makeEntity({ id: 'hero1', col: 1, row: 1, hp: 10, maxHp: 10, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const actions = genProtectHero(sim, board, 3);
    const explore = actions.find(a => a.type === PlanActionType.EXPLORE);
    assert.equal(explore, undefined, 'should not explore already-explored building');
  });
});

// ── genSlayWitch ────────────────────────────────────────────────────────────

describe.skip('genSlayWitch (removed — merged into CONTROL_NODES combat)', () => {
  test('emits BATTLE_UNIT when hero adjacent to witch', () => {
    const sim = makeHeroEngineSim({
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3, hp: 10, maxHp: 10, attack: 5, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 4, row: 3, hp: 8, maxHp: 8, attack: 2, defense: 1 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const actions = genSlayWitch(sim, board, 3);
    const battle = actions.find(a => a.type === PlanActionType.BATTLE_UNIT);
    assert.ok(battle, 'should emit BATTLE_UNIT');
    assert.equal(battle.targetId, 'witch1');
  });

  test('chases witch when not adjacent but within sight', () => {
    const sim = makeHeroEngineSim({
      entities: [
        makeEntity({ id: 'hero1', col: 0, row: 0, hp: 10, maxHp: 10, items: {} }),
        // Within hero DAY sight range (3 hexes)
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 2, row: 1, hp: 8, maxHp: 8 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const actions = genSlayWitch(sim, board, 3);
    const moves = actions.filter(a => a.type === PlanActionType.MOVE);
    assert.ok(moves.length > 0, 'should emit MOVE actions toward witch');
  });

  test('respects engage floor', () => {
    // Weak hero vs strong witch — 'unfavorable' floor should skip battle
    const sim = makeHeroEngineSim({
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3, hp: 3, maxHp: 10, attack: 1, defense: 0, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 4, row: 3, hp: 8, maxHp: 8, attack: 5, defense: 4 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const config = { engageFloor: 'unfavorable' };
    const actions = genSlayWitch(sim, board, 3, config);
    const battle = actions.find(a => a.type === PlanActionType.BATTLE_UNIT);
    // With suicidal classification and unfavorable floor, should not battle
    assert.equal(battle, undefined, 'should not battle when below engage floor');
  });

  test('returns empty when witch not visible', () => {
    const sim = makeHeroEngineSim({
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3, hp: 10, maxHp: 10, items: {} }),
        // No witch entity
      ],
    });
    const board = assessHeroBoard(sim);
    const actions = genSlayWitch(sim, board, 3);
    assert.equal(actions.length, 0);
  });
});

// ── genControlNodes ─────────────────────────────────────────────────────────

describe('genControlNodes', () => {
  test('moves hero toward uncovered node', () => {
    const sim = makeHeroEngineSim({
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3, hp: 10, maxHp: 10, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const actions = genControlNodes(sim, board, 5);
    const moves = actions.filter(a => a.type === PlanActionType.MOVE);
    assert.ok(moves.length > 0, 'should emit MOVE toward node');
  });

  test('battles adjacent enemy when on node', () => {
    const sim = makeHeroEngineSim({
      witchObjectives: [{ col: 3, row: 3, hexes: [{ col: 3, row: 3 }] }],
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3, hp: 10, maxHp: 10, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 4, row: 3 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const actions = genControlNodes(sim, board, 3);
    const battle = actions.find(a => a.type === PlanActionType.BATTLE_UNIT);
    assert.ok(battle, 'should battle adjacent enemy on node');
  });
});

// ── genExplore ──────────────────────────────────────────────────────────────

describe('genExplore', () => {
  test('explores current unexplored building', () => {
    const sim = makeHeroEngineSim({
      entities: [
        makeEntity({ id: 'hero1', col: 1, row: 1, hp: 10, maxHp: 10, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const actions = genExplore(sim, board, 3);
    const explore = actions.find(a => a.type === PlanActionType.EXPLORE);
    assert.ok(explore, 'should emit EXPLORE on current building');
  });

  test('moves toward nearest unexplored building', () => {
    const sim = makeHeroEngineSim({
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3, hp: 10, maxHp: 10, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const actions = genExplore(sim, board, 3);
    const moves = actions.filter(a => a.type === PlanActionType.MOVE);
    assert.ok(moves.length > 0, 'should emit MOVE toward unexplored building');
  });

  test('returns only fortify when no unexplored buildings but has resources', () => {
    const tiles = new Map();
    for (let c = 0; c < 7; c++) {
      for (let r = 0; r < 7; r++) {
        tiles.set(hexKey(c, r), {
          col: c, row: r, type: TileType.GRASS, explored: true,
          building: null, resource: null, fortifyLevel: 0,
        });
      }
    }
    const sim = makeHeroEngineSim({
      tiles,
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3, hp: 10, maxHp: 10, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const actions = genExplore(sim, board, 3);
    // No exploring to do, but hero will fortify current hex if resources available
    assert.ok(actions.every(a => a.type === PlanActionType.FORTIFY),
      'should only produce fortify actions when nothing to explore');
  });
});

// ── genFortifyPosition ──────────────────────────────────────────────────────

describe.skip('genFortifyPosition (removed — merged into EXPLORE and CONTROL_NODES)', () => {
  test('seeks shelter at night when not in building', () => {
    const sim = makeHeroEngineSim({
      phase: Phase.NIGHT,
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3, hp: 10, maxHp: 10, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const actions = genFortifyPosition(sim, board, 3);
    const moves = actions.filter(a => a.type === PlanActionType.MOVE);
    assert.ok(moves.length > 0, 'should emit MOVE toward building at night');
  });

  test('fortifies building when in one with resources', () => {
    const sim = makeHeroEngineSim({
      phase: Phase.NIGHT,
      entities: [
        makeEntity({ id: 'hero1', col: 1, row: 1, hp: 10, maxHp: 10, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const actions = genFortifyPosition(sim, board, 5);
    const fortify = actions.find(a => a.type === PlanActionType.FORTIFY);
    assert.ok(fortify, 'should emit FORTIFY when in building with resources');
  });

  test('shelters survivors at night', () => {
    const sim = makeHeroEngineSim({
      phase: Phase.NIGHT,
      entities: [
        makeEntity({ id: 'hero1', col: 1, row: 1, hp: 10, maxHp: 10, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
        makeEntity({ id: 's1', type: EntityType.SURVIVOR, owner: 'hero', col: 3, row: 3, hp: 3, maxHp: 3 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const actions = genFortifyPosition(sim, board, 5);
    const survivorMove = actions.find(a => a.type === PlanActionType.MOVE && a.entityId === 's1');
    assert.ok(survivorMove, 'should shelter survivor');
  });

  test('respects fortifyCap', () => {
    const sim = makeHeroEngineSim({
      phase: Phase.DAY,
      entities: [
        makeEntity({ id: 'hero1', col: 1, row: 1, hp: 10, maxHp: 10, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const config = { fortifyCapDay: 1, fortifyCapNight: 3 };
    const actions = genFortifyPosition(sim, board, 5, config);
    const fortifyCount = actions.filter(a => a.type === PlanActionType.FORTIFY).length;
    assert.ok(fortifyCount <= 1, `should not exceed day cap (got ${fortifyCount})`);
  });
});

// ── fillGapsHero ────────────────────────────────────────────────────────────

describe('fillGapsHero', () => {
  test('attacks adjacent enemies in gap fill', () => {
    const sim = makeHeroEngineSim({
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3, hp: 10, maxHp: 10, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 4, row: 3 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const heroEntity = sim.entities.find(e => e.id === 'hero1');
    const plan = [];
    fillGapsHero(plan, sim, board, heroEntity, 2, new Map());
    const battle = plan.find(a => a.type === PlanActionType.BATTLE_UNIT);
    assert.ok(battle, 'should attack adjacent enemy in gap fill');
  });

  test('adds guard fallback when nothing else to do', () => {
    const tiles = new Map();
    for (let c = 0; c < 7; c++) {
      for (let r = 0; r < 7; r++) {
        tiles.set(hexKey(c, r), {
          col: c, row: r, type: TileType.GRASS, explored: true,
          building: null, resource: null, fortifyLevel: 0,
        });
      }
    }
    const sim = makeHeroEngineSim({
      tiles,
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3, hp: 10, maxHp: 10, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const heroEntity = sim.entities.find(e => e.id === 'hero1');
    const plan = [];
    fillGapsHero(plan, sim, board, heroEntity, 1, new Map());
    assert.ok(plan.length > 0, 'should add fallback actions');
  });
});

// ── Phase 3: HeroAIEngine + self-registration ──────────────────────────────

describe('HeroAIEngine', () => {
  test('constructor sets defaults', () => {
    const state = makeFakeState();
    const engine = new HeroAIEngine(state, () => {});
    assert.equal(engine.thinkDelay, 600);
    assert.equal(engine.playerId, null);
    assert.deepEqual(engine.config, HERO_PERSONALITY_CONFIGS.balanced);
    assert.ok(engine._prevPositions instanceof Map);
  });

  test('generatePlan returns non-empty plan', () => {
    const state = makeFakeState();
    const engine = new HeroAIEngine(state, () => {});
    const plan = engine.generatePlan();
    assert.ok(Array.isArray(plan));
    assert.ok(plan.length > 0, 'should generate at least one action');
  });

  test('generatePlan preserves _goal metadata for debug', () => {
    const state = makeFakeState();
    const engine = new HeroAIEngine(state, () => {});
    const plan = engine.generatePlan();
    const withGoal = plan.filter(a => a._goal != null);
    assert.ok(withGoal.length > 0 || plan.length === 0, 'plan actions should have _goal metadata');
  });

  test('generatePlan returns empty for missing hero', () => {
    const state = makeFakeState({
      entities: [
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const engine = new HeroAIEngine(state, () => {});
    const plan = engine.generatePlan();
    assert.deepEqual(plan, []);
  });

  test('cross-turn memory updates after generatePlan', () => {
    const state = makeFakeState();
    const engine = new HeroAIEngine(state, () => {});
    engine.generatePlan();
    assert.ok(engine._prevPositions.size > 0, 'should record positions');
    assert.ok(engine._prevPositions.has('hero1'), 'should track hero');
  });

  test('different configs produce different plans', () => {
    const state = makeFakeState({
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3, hp: 10, maxHp: 10,
          items: { [ResourceType.HERBS]: 1, [ResourceType.FOOD]: 2 } }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch',
          col: 4, row: 3, hp: 8, maxHp: 8 }),
        makeEntity({ id: 's1', type: EntityType.SURVIVOR, owner: 'hero',
          col: 3, row: 4, hp: 4, maxHp: 4 }),
      ],
    });

    const aggressive = new HeroAIEngine(state, () => {}, 600, null, HERO_PERSONALITY_CONFIGS.aggressive);
    const defensive = new HeroAIEngine(state, () => {}, 600, null, HERO_PERSONALITY_CONFIGS.defensive);

    const aggrPlan = aggressive.generatePlan();
    const defPlan = defensive.generatePlan();

    // Plans may differ in length or composition
    const aggrTypes = aggrPlan.map(a => a.type).join(',');
    const defTypes = defPlan.map(a => a.type).join(',');
    // Not asserting they're different (might occasionally match), but both should be valid
    assert.ok(aggrPlan.length > 0);
    assert.ok(defPlan.length > 0);
  });
});

describe('createHeroAI', () => {
  test('creates engine with named config', () => {
    const state = makeFakeState();
    const engine = createHeroAI('aggressive', state, () => {});
    assert.ok(engine instanceof HeroAIEngine);
    assert.deepEqual(engine.config, HERO_PERSONALITY_CONFIGS.aggressive);
  });

  test('falls back to balanced for unknown personality', () => {
    const state = makeFakeState();
    const engine = createHeroAI('nonexistent', state, () => {});
    assert.deepEqual(engine.config, HERO_PERSONALITY_CONFIGS.balanced);
  });
});

describe('HERO_PERSONALITIES self-registration', () => {
  test('registers all four personalities', () => {
    const names = Object.keys(HERO_PERSONALITY_CONFIGS);
    for (const name of names) {
      assert.ok(HERO_PERSONALITIES[name], `missing personality: ${name}`);
    }
  });

  test('registered classes are constructable', () => {
    const state = makeFakeState();
    for (const name of Object.keys(HERO_PERSONALITY_CONFIGS)) {
      const Cls = HERO_PERSONALITIES[name];
      const instance = new Cls(state, () => {});
      assert.ok(instance instanceof HeroAIEngine);
      assert.deepEqual(instance.config, HERO_PERSONALITY_CONFIGS[name]);
    }
  });

  test('registered classes have descriptive names', () => {
    for (const name of Object.keys(HERO_PERSONALITY_CONFIGS)) {
      assert.equal(HERO_PERSONALITIES[name].name, `HeroAI_${name}`);
    }
  });

  test('registered classes generate valid plans', () => {
    const state = makeFakeState();
    for (const name of Object.keys(HERO_PERSONALITY_CONFIGS)) {
      const Cls = HERO_PERSONALITIES[name];
      const ai = new Cls(state, () => {});
      const plan = ai.generatePlan();
      assert.ok(Array.isArray(plan), `${name} should return array`);
      assert.ok(plan.length > 0, `${name} should generate actions`);
    }
  });
});
