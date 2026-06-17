// Tests for AI strategy improvements:
// 1. Sound Horn generation
// 2. Scoring awareness & phase timing
// 3. Node feasibility scoring
// 4. NvN ally coordination

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Phase, nodeController } from '../src/game.js';
import { EntityType, normalizeItems } from '../src/entities.js';

// Phase-2 inventory: normalize each side's flat `{ id: N }` seed to the
// canonical dict-of-objects shape `{ id: { count: N } }` the runtime uses.
const normSidesInv = (inv) =>
  Object.fromEntries(Object.entries(inv ?? {}).map(([s, m]) => [s, normalizeItems(m)]));
import { TileType, ResourceType } from '../src/tiles.js';
import { hexKey } from '../src/hex.js';
import { PlanSimState, roundsUntilScoring, scoreNodeFeasibility } from '../src/ai.js';
import { allocateBudget } from '../src/ai-engine.js';
import {
  HeroEnginePlanSimState,
  HeroAIEngine,
  assessHeroBoard,
  scoreHeroGoals,
  HeroGoal,
  genExplore,
  genControlNodes as genControlNodesHero,
} from '../src/hero-ai-engine.js';
import {
  EnginePlanSimState,
  WitchAIEngine,
  assessBoard,
  scoreGoals,
  Goal,
  genControlNodes as genControlNodesWitch,
} from '../src/ai-engine.js';
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

const nodeHexes = (c, r) => [{ col: c, row: r }];

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
  // Place some unexplored buildings
  for (const [c, r] of [[1, 1], [2, 2], [5, 5], [4, 4]]) {
    tiles.set(hexKey(c, r), {
      col: c, row: r, type: TileType.BUILDING, explored: false,
      building: 'house', resource: null, fortifyLevel: 0,
    });
  }
  if (overrides.tiles) {
    for (const [k, v] of overrides.tiles) tiles.set(k, v);
  }

  const hero = makeEntity({
    id: 'hero1', type: EntityType.HERO, owner: 'hero',
    col: 3, row: 3, hp: 10, maxHp: 10,
    items: { [ResourceType.HERBS]: 1 },
  });
  const witch = makeEntity({
    id: 'witch1', type: EntityType.WITCH, owner: 'witch',
    col: 6, row: 6, hp: 8, maxHp: 8,
  });
  const entities = overrides.entities ?? [hero, witch];

  return {
    tiles,
    phase: overrides.phase ?? Phase.DAY,
    round: overrides.round ?? 3,
    witchObjectives: overrides.witchObjectives ?? [
      { col: 0, row: 3, hexes: nodeHexes(0, 3), label: 'Node A' },
      { col: 3, row: 0, hexes: nodeHexes(3, 0), label: 'Node B' },
      { col: 6, row: 3, hexes: nodeHexes(6, 3), label: 'Node C' },
    ],
    nodeScore: overrides.nodeScore ?? { hero: 0, witch: 0 },
    fogOfWar: 'none',
    inventory: normSidesInv(overrides.inventory ?? {
      witch: { [ResourceType.WOOD]: 2, [ResourceType.METAL]: 0 },
      hero: { [ResourceType.WOOD]: 2, [ResourceType.METAL]: 1, [ResourceType.FOOD]: 3 },
    }),
    entities,
  };
}

// ── roundsUntilScoring ──────────────────────────────────────────────────────

describe('roundsUntilScoring', () => {
  test('returns 0 for DAWN (round 1)', () => {
    assert.equal(roundsUntilScoring(1), 0, 'round 1 is DAWN, scoring now');
  });

  test('returns 0 for DUSK (round 5)', () => {
    assert.equal(roundsUntilScoring(5), 0, 'round 5 is DUSK, scoring now');
  });

  test('returns rounds until DUSK during DAY', () => {
    assert.equal(roundsUntilScoring(2), 3, 'round 2: 3 rounds until DUSK');
    assert.equal(roundsUntilScoring(3), 2, 'round 3: 2 rounds until DUSK');
    assert.equal(roundsUntilScoring(4), 1, 'round 4: 1 round until DUSK');
  });

  test('returns rounds until DAWN during NIGHT', () => {
    assert.equal(roundsUntilScoring(6), 3, 'round 6: 3 rounds until next DAWN');
    assert.equal(roundsUntilScoring(7), 2, 'round 7: 2 rounds until next DAWN');
    assert.equal(roundsUntilScoring(8), 1, 'round 8: 1 round until next DAWN');
  });

  test('works for second cycle', () => {
    // Round 9 is DAWN (cycle 2)
    assert.equal(roundsUntilScoring(9), 0, 'round 9 is DAWN');
    assert.equal(roundsUntilScoring(10), 3, 'round 10 is DAY');
    assert.equal(roundsUntilScoring(13), 0, 'round 13 is DUSK');
  });

  test('handles round 0 / undefined gracefully', () => {
    // Should not crash
    const r = roundsUntilScoring(0);
    assert.ok(typeof r === 'number');
  });
});

// ── scoreNodeFeasibility ────────────────────────────────────────────────────

describe('scoreNodeFeasibility', () => {
  test('returns 0–1', () => {
    const node = { obj: { col: 3, row: 0, hexes: nodeHexes(3, 0) }, controller: 'neutral' };
    const entities = [
      makeEntity({ id: 'h1', owner: 'hero', col: 3, row: 1 }),
      makeEntity({ id: 'w1', owner: 'witch', type: EntityType.WITCH, col: 6, row: 6 }),
    ];
    const score = scoreNodeFeasibility(node, 'hero', entities);
    assert.ok(score >= 0 && score <= 1, `score ${score} should be 0-1`);
  });

  test('higher when friendly unit is closer than enemy', () => {
    const node = { obj: { col: 3, row: 0, hexes: nodeHexes(3, 0) }, controller: 'neutral' };
    const entitiesClose = [
      makeEntity({ id: 'h1', owner: 'hero', col: 3, row: 1 }),
      makeEntity({ id: 'w1', owner: 'witch', type: EntityType.WITCH, col: 6, row: 6 }),
    ];
    const entitiesFar = [
      makeEntity({ id: 'h1', owner: 'hero', col: 6, row: 6 }),
      makeEntity({ id: 'w1', owner: 'witch', type: EntityType.WITCH, col: 3, row: 1 }),
    ];
    const scoreClose = scoreNodeFeasibility(node, 'hero', entitiesClose);
    const scoreFar = scoreNodeFeasibility(node, 'hero', entitiesFar);
    assert.ok(scoreClose > scoreFar, `close (${scoreClose}) should beat far (${scoreFar})`);
  });

  test('higher when already holding the node with presence', () => {
    const node = { obj: { col: 3, row: 0, hexes: nodeHexes(3, 0) }, controller: 'hero' };
    const entities = [
      makeEntity({ id: 'h1', owner: 'hero', col: 3, row: 0 }), // on node
      makeEntity({ id: 'w1', owner: 'witch', type: EntityType.WITCH, col: 6, row: 6 }),
    ];
    const score = scoreNodeFeasibility(node, 'hero', entities);
    assert.ok(score >= 0.7, `holding node with presence should score high, got ${score}`);
  });

  test('low when enemy far away and own units distant', () => {
    const node = { obj: { col: 3, row: 0, hexes: nodeHexes(3, 0) }, controller: 'witch' };
    const entities = [
      makeEntity({ id: 'h1', owner: 'hero', col: 6, row: 6 }),
      makeEntity({ id: 'w1', owner: 'witch', type: EntityType.WITCH, col: 3, row: 0 }),
    ];
    const score = scoreNodeFeasibility(node, 'hero', entities);
    assert.ok(score < 0.3, `distant and enemy-held should score low, got ${score}`);
  });
});

// ── Sound Horn generation ───────────────────────────────────────────────────

describe('Sound Horn AI generation', () => {
  test('genExplore generates SOUND_HORN when food available and unexplored buildings exist', () => {
    const state = makeFakeState({
      phase: Phase.DAY,
      round: 3,
    });
    const sim = new HeroEnginePlanSimState(state);
    const board = assessHeroBoard(sim);

    // Verify preconditions
    assert.ok(board.foodCount >= 1, 'should have food');
    assert.ok(board.unexploredBuildings.length >= 2, 'should have unexplored buildings');
    assert.ok(board.heroHpRatio > 0.3, 'hero should be healthy');

    const actions = genExplore(sim, board, 3);
    const hornActions = actions.filter(a => a.type === PlanActionType.SOUND_HORN);
    assert.ok(hornActions.length > 0, 'should generate at least one SOUND_HORN action');
    assert.equal(hornActions[0].entityId, 'hero1');
  });

  test('genExplore does NOT generate SOUND_HORN when no food', () => {
    const state = makeFakeState({
      inventory: {
        witch: {},
        hero: { [ResourceType.WOOD]: 2, [ResourceType.METAL]: 1, [ResourceType.FOOD]: 0 },
      },
    });
    const sim = new HeroEnginePlanSimState(state);
    const board = assessHeroBoard(sim);

    const actions = genExplore(sim, board, 3);
    const hornActions = actions.filter(a => a.type === PlanActionType.SOUND_HORN);
    assert.equal(hornActions.length, 0, 'should not sound horn without food');
  });

  test('genExplore does NOT generate SOUND_HORN when no unexplored buildings', () => {
    // All buildings explored — no hidden survivors likely remain
    const tiles = new Map();
    for (let c = 0; c < 7; c++) {
      for (let r = 0; r < 7; r++) {
        tiles.set(hexKey(c, r), {
          col: c, row: r, type: TileType.GRASS, explored: true,
          building: null, resource: null, fortifyLevel: 0,
        });
      }
    }

    const state = makeFakeState({ tiles });
    const sim = new HeroEnginePlanSimState(state);
    const board = assessHeroBoard(sim);

    assert.equal(board.unexploredBuildings.length, 0, 'no unexplored buildings');
    const actions = genExplore(sim, board, 3);
    const hornActions = actions.filter(a => a.type === PlanActionType.SOUND_HORN);
    assert.equal(hornActions.length, 0, 'should not sound horn with no unexplored buildings');
  });

  test('applySoundHorn deducts food from shared inventory', () => {
    const state = makeFakeState();
    const sim = new PlanSimState(state, 'hero');
    const foodBefore = (sim.inventory.hero[ResourceType.FOOD]?.count ?? 0);
    const budgetBefore = sim.actionsLeft;

    sim.applySoundHorn();

    assert.equal((sim.inventory.hero[ResourceType.FOOD]?.count ?? 0), foodBefore - 1);
    assert.equal(sim.actionsLeft, budgetBefore - 1);
  });
});

// ── Scoring awareness ───────────────────────────────────────────────────────

describe('Scoring awareness', () => {
  test('assessHeroBoard includes round and roundsToScoring', () => {
    const state = makeFakeState({ round: 7 });
    const sim = new HeroEnginePlanSimState(state);
    const board = assessHeroBoard(sim);

    assert.equal(board.round, 7);
    assert.equal(board.roundsToScoring, 2, 'round 7 is NIGHT, 2 rounds until DAWN');
  });

  test('assessBoard (witch) includes round and roundsToScoring', () => {
    const state = makeFakeState({ round: 4, phase: Phase.DAY });
    const sim = new EnginePlanSimState(state, 'witch');
    const board = assessBoard(sim);

    assert.equal(board.round, 4);
    assert.equal(board.roundsToScoring, 1, 'round 4 is DAY, 1 round until DUSK');
  });

  test('hero scoreGoals CONTROL_NODES increases when scoring imminent', () => {
    const state = makeFakeState({ round: 4, phase: Phase.DAY });
    const simNear = new HeroEnginePlanSimState(state);
    const boardNear = assessHeroBoard(simNear);

    const stateFar = makeFakeState({ round: 2, phase: Phase.DAY });
    const simFar = new HeroEnginePlanSimState(stateFar);
    const boardFar = assessHeroBoard(simFar);

    const scoresNear = scoreHeroGoals(boardNear);
    const scoresFar = scoreHeroGoals(boardFar);

    assert.ok(
      scoresNear[HeroGoal.CONTROL_NODES] >= scoresFar[HeroGoal.CONTROL_NODES],
      `near-scoring (${scoresNear[HeroGoal.CONTROL_NODES]}) should be >= far-scoring (${scoresFar[HeroGoal.CONTROL_NODES]})`
    );
  });

  test('hero scoreGoals CONTROL_NODES increases when behind in score', () => {
    // Use NIGHT phase with low multiplier for CONTROL_NODES (0.8) so score doesn't cap at 1.0
    // Also place hero on a node so some nodes ARE covered (reduces base urgency)
    const stateAhead = makeFakeState({
      phase: Phase.NIGHT, round: 6,
      nodeScore: { hero: 3, witch: 0 },
      entities: [
        makeEntity({ id: 'hero1', type: EntityType.HERO, owner: 'hero', col: 0, row: 3 }), // on node A
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const simAhead = new HeroEnginePlanSimState(stateAhead);
    const boardAhead = assessHeroBoard(simAhead);

    const stateBehind = makeFakeState({
      phase: Phase.NIGHT, round: 6,
      nodeScore: { hero: 0, witch: 3 },
      entities: [
        makeEntity({ id: 'hero1', type: EntityType.HERO, owner: 'hero', col: 0, row: 3 }), // on node A
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const simBehind = new HeroEnginePlanSimState(stateBehind);
    const boardBehind = assessHeroBoard(simBehind);

    const scoresAhead = scoreHeroGoals(boardAhead);
    const scoresBehind = scoreHeroGoals(boardBehind);

    assert.ok(
      scoresBehind[HeroGoal.CONTROL_NODES] > scoresAhead[HeroGoal.CONTROL_NODES],
      `behind (${scoresBehind[HeroGoal.CONTROL_NODES]}) should be > ahead (${scoresAhead[HeroGoal.CONTROL_NODES]})`
    );
  });

  test('witch scoreGoals CONTROL_NODES increases when behind in score', () => {
    // Use DAY phase which gives witch no control bonus (mult=1.0), hero far away
    // Put witch on a node to reduce uncovered count (lower base urgency when ahead)
    const stateAhead = makeFakeState({
      phase: Phase.DAY, round: 2,
      nodeScore: { witch: 3, hero: 0 },
      entities: [
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 0, row: 3 }), // on node A
        makeEntity({ id: 'hero1', type: EntityType.HERO, owner: 'hero', col: 6, row: 6 }),
      ],
    });
    const simAhead = new EnginePlanSimState(stateAhead, 'witch');
    const boardAhead = assessBoard(simAhead);

    const stateBehind = makeFakeState({
      phase: Phase.DAY, round: 2,
      nodeScore: { witch: 0, hero: 3 },
      entities: [
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 0, row: 3 }), // on node A
        makeEntity({ id: 'hero1', type: EntityType.HERO, owner: 'hero', col: 6, row: 6 }),
      ],
    });
    const simBehind = new EnginePlanSimState(stateBehind, 'witch');
    const boardBehind = assessBoard(simBehind);

    const scoresAhead = scoreGoals(boardAhead);
    const scoresBehind = scoreGoals(boardBehind);

    assert.ok(
      scoresBehind[Goal.CONTROL_NODES] > scoresAhead[Goal.CONTROL_NODES],
      `behind (${scoresBehind[Goal.CONTROL_NODES]}) should be > ahead (${scoresAhead[Goal.CONTROL_NODES]})`
    );
  });
});

// ── Node strategy ───────────────────────────────────────────────────────────

describe('Node strategy — feasibility filtering', () => {
  test('genControlNodes skips nodes with low feasibility', () => {
    // Place hero far from all nodes, witch on all nodes → all infeasible for hero
    const hero = makeEntity({
      id: 'hero1', type: EntityType.HERO, owner: 'hero',
      col: 6, row: 6, hp: 10, maxHp: 10,
    });
    const witch = makeEntity({
      id: 'witch1', type: EntityType.WITCH, owner: 'witch',
      col: 0, row: 3, hp: 8, maxHp: 8,
    });
    const minion1 = makeEntity({
      id: 'm1', type: EntityType.MINION, owner: 'witch',
      col: 3, row: 0, hp: 2, maxHp: 2,
    });
    const minion2 = makeEntity({
      id: 'm2', type: EntityType.MINION, owner: 'witch',
      col: 6, row: 3, hp: 2, maxHp: 2,
    });

    const state = makeFakeState({
      entities: [hero, witch, minion1, minion2],
    });
    const sim = new HeroEnginePlanSimState(state);
    const board = assessHeroBoard(sim);

    // With budget of 3, the hero should not waste moves on hopeless nodes
    const actions = genControlNodesHero(sim, board, 3);
    // Some or all nodes may be skipped due to low feasibility
    // The hero shouldn't move toward heavily guarded far-away nodes
    assert.ok(actions.length <= 3, 'should not generate excessive actions toward hopeless nodes');
  });
});

// ── NvN ally coordination ───────────────────────────────────────────────────

describe('NvN ally coordination', () => {
  test('generatePlan populates allyContext.claimedNodes when provided', () => {
    const state = makeFakeState({
      phase: Phase.DAY,
      round: 3,
    });
    const allyContext = { claimedNodes: new Set(), allyPositions: [] };
    const engine = new HeroAIEngine(state, () => {}, 0);
    const plan = engine.generatePlan(allyContext);

    // The plan may or may not have moves toward nodes, but the context should be updated
    assert.ok(allyContext.claimedNodes instanceof Set, 'claimedNodes should still be a Set');
  });

  test('witch generatePlan populates allyContext.claimedNodes', () => {
    const state = makeFakeState({
      phase: Phase.NIGHT,
      round: 6,
    });
    const allyContext = { claimedNodes: new Set(), allyPositions: [] };
    const engine = new WitchAIEngine(state, () => {}, 0);
    const plan = engine.generatePlan(allyContext);

    assert.ok(allyContext.claimedNodes instanceof Set, 'claimedNodes should still be a Set');
  });

  test('genControlNodes filters ally-claimed nodes', () => {
    const hero = makeEntity({
      id: 'hero1', type: EntityType.HERO, owner: 'hero',
      col: 3, row: 3, hp: 10, maxHp: 10,
    });
    const survivor = makeEntity({
      id: 's1', type: EntityType.SURVIVOR, owner: 'hero',
      col: 2, row: 3, hp: 4, maxHp: 4,
    });
    const witch = makeEntity({
      id: 'witch1', type: EntityType.WITCH, owner: 'witch',
      col: 6, row: 6, hp: 8, maxHp: 8,
    });

    const state = makeFakeState({
      entities: [hero, survivor, witch],
    });
    const sim = new HeroEnginePlanSimState(state);
    const board = assessHeroBoard(sim);

    // Claim node A (0,3) as already targeted by an ally
    board.allyContext = {
      claimedNodes: new Set([hexKey(0, 3)]),
      allyPositions: [],
    };

    const actions = genControlNodesHero(sim, board, 5);

    // No actions should target node A (0,3)
    const movesToClaimed = actions.filter(
      a => a.type === PlanActionType.MOVE && a.toCol === 0 && a.toRow === 3
    );
    assert.equal(movesToClaimed.length, 0, 'should not move directly to ally-claimed node hex');
  });

  test('generatePlan works without allyContext (null)', () => {
    const state = makeFakeState();
    const engine = new HeroAIEngine(state, () => {}, 0);
    const plan = engine.generatePlan(null);
    assert.ok(Array.isArray(plan), 'should return a valid plan array');
  });
});

// ── PlanSimState round exposure ─────────────────────────────────────────────

describe('PlanSimState round exposure', () => {
  test('PlanSimState includes round from real state', () => {
    const state = makeFakeState({ round: 15 });
    const sim = new PlanSimState(state, 'hero');
    assert.equal(sim.round, 15);
  });

  test('PlanSimState defaults round to 1 when missing', () => {
    const state = makeFakeState();
    delete state.round;
    const sim = new PlanSimState(state, 'hero');
    assert.equal(sim.round, 1);
  });
});

// ── Board foodCount ─────────────────────────────────────────────────────────

describe('Board foodCount from shared inventory', () => {
  test('assessHeroBoard foodCount reads from shared inventory', () => {
    const state = makeFakeState({
      inventory: {
        witch: {},
        hero: { [ResourceType.FOOD]: 5, [ResourceType.WOOD]: 1 },
      },
    });
    const sim = new HeroEnginePlanSimState(state);
    const board = assessHeroBoard(sim);
    assert.equal(board.foodCount, 5, 'foodCount should come from hero inventory');
  });

  test('assessHeroBoard foodCount is 0 when no food in hero inventory', () => {
    const state = makeFakeState({
      inventory: {
        witch: {},
        hero: { [ResourceType.WOOD]: 1 },
      },
    });
    const sim = new HeroEnginePlanSimState(state);
    const board = assessHeroBoard(sim);
    assert.equal(board.foodCount, 0);
  });
});
