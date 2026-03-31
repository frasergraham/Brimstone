// Tests for src/hero-ai-engine.js — Phase 1
// Covers assessHeroBoard, scoreHeroGoals, and allocateBudget integration.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Phase } from '../src/game.js';
import { EntityType } from '../src/entities.js';
import { TileType, ResourceType } from '../src/tiles.js';
import { hexKey } from '../src/hex.js';
import { PlanSimState } from '../src/ai.js';
import { allocateBudget } from '../src/ai-engine.js';
import {
  HeroGoal,
  HERO_PERSONALITY_CONFIGS,
  assessHeroBoard,
  scoreHeroGoals,
} from '../src/hero-ai-engine.js';

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
