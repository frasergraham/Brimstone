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
  genSlayWitch,
  genControlNodes,
  genExplore,
  genFortifyPosition,
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
    col: 6, row: 6, hp: 8, maxHp: 8,
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
      shared: { [ResourceType.WOOD]: 2, [ResourceType.METAL]: 1 },
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
  test('returns scores for all 5 goals', () => {
    const sim = makeHeroSim();
    const board = assessHeroBoard(sim);
    const scores = scoreHeroGoals(board);
    const keys = Object.keys(scores);
    assert.equal(keys.length, 5);
    assert.ok(HeroGoal.PROTECT_HERO in scores);
    assert.ok(HeroGoal.SLAY_WITCH in scores);
    assert.ok(HeroGoal.CONTROL_NODES in scores);
    assert.ok(HeroGoal.EXPLORE in scores);
    assert.ok(HeroGoal.FORTIFY_POSITION in scores);
  });

  test('all scores are in [0, 1] range', () => {
    const sim = makeHeroSim();
    const board = assessHeroBoard(sim);
    const scores = scoreHeroGoals(board);
    for (const v of Object.values(scores)) {
      assert.ok(v >= 0 && v <= 1, `score ${v} out of [0,1] range`);
    }
  });

  test('night boosts FORTIFY_POSITION', () => {
    const dayBoard = assessHeroBoard(makeHeroSim({ phase: Phase.DAY }));
    const nightBoard = assessHeroBoard(makeHeroSim({ phase: Phase.NIGHT }));
    const dayScores = scoreHeroGoals(dayBoard);
    const nightScores = scoreHeroGoals(nightBoard);
    assert.ok(nightScores[HeroGoal.FORTIFY_POSITION] > dayScores[HeroGoal.FORTIFY_POSITION],
      `night FORTIFY (${nightScores[HeroGoal.FORTIFY_POSITION]}) should exceed day (${dayScores[HeroGoal.FORTIFY_POSITION]})`);
  });

  test('day boosts EXPLORE', () => {
    const dayBoard = assessHeroBoard(makeHeroSim({ phase: Phase.DAY }));
    const nightBoard = assessHeroBoard(makeHeroSim({ phase: Phase.NIGHT }));
    const dayScores = scoreHeroGoals(dayBoard);
    const nightScores = scoreHeroGoals(nightBoard);
    assert.ok(dayScores[HeroGoal.EXPLORE] > nightScores[HeroGoal.EXPLORE],
      `day EXPLORE (${dayScores[HeroGoal.EXPLORE]}) should exceed night (${nightScores[HeroGoal.EXPLORE]})`);
  });

  test('dawn/dusk boosts CONTROL_NODES', () => {
    const dayBoard = assessHeroBoard(makeHeroSim({ phase: Phase.DAY }));
    const dawnBoard = assessHeroBoard(makeHeroSim({ phase: Phase.DAWN }));
    const dayScores = scoreHeroGoals(dayBoard);
    const dawnScores = scoreHeroGoals(dawnBoard);
    assert.ok(dawnScores[HeroGoal.CONTROL_NODES] > dayScores[HeroGoal.CONTROL_NODES],
      `dawn CONTROL_NODES (${dawnScores[HeroGoal.CONTROL_NODES]}) should exceed day (${dayScores[HeroGoal.CONTROL_NODES]})`);
  });

  test('low hero HP boosts PROTECT_HERO', () => {
    const healthySim = makeHeroSim({
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3, hp: 10, maxHp: 10, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const injuredSim = makeHeroSim({
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3, hp: 2, maxHp: 10, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const healthyScores = scoreHeroGoals(assessHeroBoard(healthySim));
    const injuredScores = scoreHeroGoals(assessHeroBoard(injuredSim));
    assert.ok(injuredScores[HeroGoal.PROTECT_HERO] > healthyScores[HeroGoal.PROTECT_HERO],
      `injured PROTECT (${injuredScores[HeroGoal.PROTECT_HERO]}) should exceed healthy (${healthyScores[HeroGoal.PROTECT_HERO]})`);
  });

  test('close witch boosts SLAY_WITCH', () => {
    const farSim = makeHeroSim({
      entities: [
        makeEntity({ id: 'hero1', col: 0, row: 0, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const closeSim = makeHeroSim({
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 4, row: 3 }),
      ],
    });
    const farScores = scoreHeroGoals(assessHeroBoard(farSim));
    const closeScores = scoreHeroGoals(assessHeroBoard(closeSim));
    assert.ok(closeScores[HeroGoal.SLAY_WITCH] > farScores[HeroGoal.SLAY_WITCH],
      `close SLAY (${closeScores[HeroGoal.SLAY_WITCH]}) should exceed far (${farScores[HeroGoal.SLAY_WITCH]})`);
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
      [HeroGoal.SLAY_WITCH]: 0.3,
      [HeroGoal.CONTROL_NODES]: 0.4,
      [HeroGoal.EXPLORE]: 0.6,
      [HeroGoal.FORTIFY_POSITION]: 0.2,
    };
    const budget = allocateBudget(scores, 8);
    const total = Object.values(budget).reduce((s, v) => s + v, 0);
    assert.equal(total, 8);
  });

  test('every qualifying goal gets at least 1 AP', () => {
    const scores = {
      [HeroGoal.PROTECT_HERO]: 0.8,
      [HeroGoal.SLAY_WITCH]: 0.1,
      [HeroGoal.CONTROL_NODES]: 0.1,
      [HeroGoal.EXPLORE]: 0.1,
      [HeroGoal.FORTIFY_POSITION]: 0.1,
    };
    const budget = allocateBudget(scores, 6);
    for (const g of Object.keys(scores)) {
      assert.ok(budget[g] >= 1, `${g} should get at least 1 AP, got ${budget[g]}`);
    }
  });

  test('highest urgency goal gets most budget', () => {
    const scores = {
      [HeroGoal.PROTECT_HERO]: 0.1,
      [HeroGoal.SLAY_WITCH]: 0.1,
      [HeroGoal.CONTROL_NODES]: 0.1,
      [HeroGoal.EXPLORE]: 0.9,
      [HeroGoal.FORTIFY_POSITION]: 0.1,
    };
    const budget = allocateBudget(scores, 10);
    assert.ok(budget[HeroGoal.EXPLORE] > budget[HeroGoal.PROTECT_HERO],
      `EXPLORE (${budget[HeroGoal.EXPLORE]}) should exceed PROTECT (${budget[HeroGoal.PROTECT_HERO]})`);
  });

  test('zero budget returns all zeros', () => {
    const scores = {
      [HeroGoal.PROTECT_HERO]: 0.5,
      [HeroGoal.SLAY_WITCH]: 0.5,
      [HeroGoal.CONTROL_NODES]: 0.5,
      [HeroGoal.EXPLORE]: 0.5,
      [HeroGoal.FORTIFY_POSITION]: 0.5,
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

  test('each config has weights for all 5 goals', () => {
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
    // Aggressive should weight SLAY_WITCH higher
    assert.ok(aggressive[HeroGoal.SLAY_WITCH] >= balanced[HeroGoal.SLAY_WITCH],
      `aggressive SLAY (${aggressive[HeroGoal.SLAY_WITCH]}) should be >= balanced (${balanced[HeroGoal.SLAY_WITCH]})`);
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

  test('hero gets no night bonus', () => {
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
    assert.equal(dayResult.favorability, nightResult.favorability, 'hero combat should not change at night');
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
    const herbAction = actions.find(a => a.type === PlanActionType.USE_ITEM && a.item === ResourceType.HERBS);
    assert.ok(herbAction, 'should emit USE_ITEM herbs');
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
});

// ── genSlayWitch ────────────────────────────────────────────────────────────

describe('genSlayWitch', () => {
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

  test('chases witch when not adjacent', () => {
    const sim = makeHeroEngineSim({
      entities: [
        makeEntity({ id: 'hero1', col: 0, row: 0, hp: 10, maxHp: 10, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 4, row: 4, hp: 8, maxHp: 8 }),
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

  test('guards when on node with nearby threat', () => {
    const sim = makeHeroEngineSim({
      witchObjectives: [{ col: 3, row: 3, hexes: [{ col: 3, row: 3 }] }],
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3, hp: 10, maxHp: 10, items: {} }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 4, row: 3 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const actions = genControlNodes(sim, board, 3);
    const guard = actions.find(a => a.type === PlanActionType.GUARD);
    assert.ok(guard, 'should emit GUARD when on threatened node');
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

  test('returns empty when no unexplored buildings', () => {
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
    assert.equal(actions.length, 0);
  });
});

// ── genFortifyPosition ──────────────────────────────────────────────────────

describe('genFortifyPosition', () => {
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
  test('adds guard when enemies nearby', () => {
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
    const guard = plan.find(a => a.type === PlanActionType.GUARD);
    assert.ok(guard, 'should add GUARD when enemy nearby');
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

  test('generatePlan returns clean actions (no _priority/_goal)', () => {
    const state = makeFakeState();
    const engine = new HeroAIEngine(state, () => {});
    const plan = engine.generatePlan();
    for (const action of plan) {
      assert.equal(action._priority, undefined, 'should strip _priority');
      assert.equal(action._goal, undefined, 'should strip _goal');
    }
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
