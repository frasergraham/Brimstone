// Captain AI — the hero AI playing the Captain's kit properly:
//   • Catapults FIRE: friendly catapults are enumerated as commandable units
//     and get BATTLE_UNIT orders at enemies inside their weapon range — and
//     NEVER get MOVE / EXPLORE / MARCH orders (they are immobile).
//   • MARCH: when the captain shares a tile with ≥2 soldiers and the AI wants
//     the group moved (node push, retreat, hunt), ONE MARCH moves the whole
//     stack instead of N individual moves. Destination hex capacity is
//     respected (overflow stays behind — a nearly-full hex falls back to MOVE).
//   • BUILD_SIEGE: build a catapult when affordable (4 wood + 1 metal) AND
//     tactically sensible (near a node to hold, or defending), capped at 2
//     live engines so siege spending never strips the fortify wood.
//   • Paladin/rogue neutrality: everything keys off faction predicates
//     (canMarch / canBuildSiege) or unit-type presence — default hero AI
//     output is unchanged.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Phase } from '../src/game.js';
import { EntityType, normalizeItems } from '../src/entities.js';
import { TileType, ResourceType } from '../src/tiles.js';
import { hexKey, hexDistance } from '../src/hex.js';
import { assemblePlan } from '../src/ai-engine.js';
import {
  HeroGoal,
  HeroEnginePlanSimState,
  HeroAIEngine,
  assessHeroBoard,
  genControlNodes,
  genHuntWitch,
  fillGapsHero,
  queueLeaderStep,
  MARCH_MIN_CARRIED,
} from '../src/hero-ai-engine.js';
import { PlanActionType } from '../src/planner.js';

// ── Test helpers (same fake-state harness as tests/hero-ai-engine.test.js) ──

const normSidesInv = (inv) =>
  Object.fromEntries(Object.entries(inv ?? {}).map(([s, m]) => [s, normalizeItems(m)]));

function makeEntity(overrides) {
  return {
    id: 'e1', type: EntityType.HERO, owner: 'hero',
    col: 0, row: 0, hp: 10, maxHp: 10, attack: 3, defense: 2,
    alive: true, displayName: 'Hero', ownerId: null,
    items: {}, ...overrides,
  };
}

function makeCaptain(overrides = {}) {
  return makeEntity({
    id: 'cap1', type: EntityType.CAPTAIN, factionId: 'captain',
    displayName: 'Captain', col: 3, row: 3, hp: 10, maxHp: 10, attack: 1,
    ...overrides,
  });
}

function makeSoldier(id, col, row) {
  return makeEntity({
    id, type: EntityType.SOLDIER, displayName: 'Soldier',
    col, row, hp: 2, maxHp: 2, attack: 1, defense: 1,
  });
}

function makeCatapult(id, col, row) {
  return makeEntity({
    id, type: EntityType.CATAPULT, displayName: 'Catapult',
    col, row, hp: 4, maxHp: 4, attack: 2, defense: 1,
    items: { catapult_stone: { count: 1, equipped: true } },
  });
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
  if (overrides.tiles) {
    for (const [k, v] of overrides.tiles) tiles.set(k, v);
  }

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
    inventory: normSidesInv(overrides.inventory ?? {
      witch: {},
      hero: { [ResourceType.WOOD]: 2, [ResourceType.METAL]: 1, [ResourceType.FOOD]: 0 },
    }),
    entities: overrides.entities ?? [makeCaptain()],
  };
}

function makeSim(stateOverrides = {}) {
  return new HeroEnginePlanSimState(makeFakeState(stateOverrides));
}

// ── Catapults fire ───────────────────────────────────────────────────────────

describe('Captain AI — catapults fire', () => {
  test('genControlNodes queues exactly one BATTLE_UNIT per catapult at an in-range enemy', () => {
    const sim = makeSim({
      entities: [
        makeCaptain(),                       // (3,3)
        makeCatapult('cat1', 2, 3),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch',
          col: 5, row: 3, hp: 8, maxHp: 8 }),  // dist 3 from catapult — in range 4
      ],
    });
    const board = assessHeroBoard(sim);
    const actions = genControlNodes(sim, board, 5);
    const catActions = actions.filter(a => a.entityId === 'cat1');
    assert.equal(catActions.length, 1, 'one shot per catapult per round');
    assert.equal(catActions[0].type, PlanActionType.BATTLE_UNIT);
    assert.equal(catActions[0].targetId, 'witch1');
  });

  test('prefers the enemy leader over chaff when both are in range', () => {
    const sim = makeSim({
      entities: [
        makeCaptain(),
        makeCatapult('cat1', 2, 3),
        makeEntity({ id: 'z1', type: EntityType.ZOMBIE, owner: 'witch',
          col: 3, row: 3 + 1, hp: 1, maxHp: 2 }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch',
          col: 5, row: 3, hp: 8, maxHp: 8 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const actions = genControlNodes(sim, board, 5);
    const shot = actions.find(a => a.entityId === 'cat1');
    assert.ok(shot, 'catapult fired');
    assert.equal(shot.targetId, 'witch1', 'leader outranks low-HP chaff');
  });

  test('full engine plan: catapult fires and never receives MOVE/EXPLORE/MARCH', () => {
    const state = makeFakeState({
      entities: [
        makeCaptain(),
        makeCatapult('cat1', 2, 3),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch',
          col: 5, row: 3, hp: 8, maxHp: 8 }),
      ],
    });
    const engine = new HeroAIEngine(state, () => {});
    const plan = engine.generatePlan();
    const catActions = plan.filter(a => a.entityId === 'cat1');
    assert.ok(catActions.some(a => a.type === PlanActionType.BATTLE_UNIT),
      'plan contains a catapult shot');
    for (const a of catActions) {
      assert.ok(
        a.type !== PlanActionType.MOVE &&
        a.type !== PlanActionType.MARCH &&
        a.type !== PlanActionType.EXPLORE,
        `immobile catapult must never be ordered to ${a.type}`);
    }
  });

  test('no target in range: catapult idles — zero plan slots burned', () => {
    const state = makeFakeState({
      entities: [
        makeCaptain({ col: 3, row: 5 }),
        makeCatapult('cat1', 0, 5),
        // Visible to the captain (dist 2) but 5 hexes from the catapult (> range 4).
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch',
          col: 5, row: 5, hp: 8, maxHp: 8 }),
      ],
    });
    assert.ok(hexDistance(0, 5, 5, 5) > 4, 'fixture: witch is out of catapult range');
    const engine = new HeroAIEngine(state, () => {});
    const plan = engine.generatePlan();
    assert.deepEqual(plan.filter(a => a.entityId === 'cat1'), [],
      'no orders at all for a catapult with nothing in range');
  });

  test('gap-fill fires a catapult the goal budgets starved', () => {
    const sim = makeSim({
      entities: [
        makeCaptain(),
        makeCatapult('cat1', 2, 3),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch',
          col: 5, row: 3, hp: 8, maxHp: 8 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const heroEntity = sim.entities.find(e => e.id === board.hero.id);
    const plan = [];
    fillGapsHero(plan, sim, board, heroEntity, 3, new Map());
    const shot = plan.find(a => a.entityId === 'cat1');
    assert.ok(shot, 'gap-fill queued the catapult shot');
    assert.equal(shot.type, PlanActionType.BATTLE_UNIT);
  });
});

// ── NvN seat scoping ─────────────────────────────────────────────────────────
// Online NvN validates every order by ownerId (canCommandEntity): an AI hero
// teammate must not enumerate a HUMAN captain's catapults — the resolver
// rejects those orders and each one wastes a plan slot every round.

describe('Captain AI — NvN seat scoping (catapults)', () => {
  // This seat ('p1') owns the captain and one catapult; a teammate ('p2')
  // owns the other. The witch is within range 4 of both engines.
  const seatEntities = () => [
    makeCaptain({ ownerId: 'p1' }),                                    // (3,3)
    makeCatapult('cat-own', 2, 3),
    makeCatapult('cat-foreign', 3, 4),
    makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch',
      ownerId: 'w1', col: 5, row: 3, hp: 8, maxHp: 8 }),
  ].map(e => {
    if (e.id === 'cat-own') e.ownerId = 'p1';
    if (e.id === 'cat-foreign') e.ownerId = 'p2';
    return e;
  });

  test('MP sim (playerId set): a teammate-owned catapult is not enumerated', () => {
    const sim = new HeroEnginePlanSimState(
      makeFakeState({ entities: seatEntities() }), 'p1');
    const board = assessHeroBoard(sim);
    assert.deepEqual(board.catapults.map(c => c.id), ['cat-own'],
      'board.catapults must only list engines this seat can command');
  });

  test('MP full engine plan: no orders for the foreign catapult, own one still fires', () => {
    const engine = new HeroAIEngine(
      makeFakeState({ entities: seatEntities() }), () => {}, 0, 'p1');
    const plan = engine.generatePlan();
    assert.deepEqual(plan.filter(a => a.entityId === 'cat-foreign'), [],
      'no plan slot burned on a catapult this player cannot command');
    assert.ok(plan.some(a => a.entityId === 'cat-own' &&
        a.type === PlanActionType.BATTLE_UNIT),
      'own catapult still fires');
  });

  test('offline sim (no playerId): all friendly catapults enumerated — unchanged', () => {
    const sim = new HeroEnginePlanSimState(makeFakeState({ entities: seatEntities() }));
    const board = assessHeroBoard(sim);
    assert.deepEqual(board.catapults.map(c => c.id).sort(),
      ['cat-foreign', 'cat-own']);
  });
});

// ── MARCH ────────────────────────────────────────────────────────────────────

describe('Captain AI — MARCH', () => {
  test('captain + 2 soldiers on one tile, node objective: ONE MARCH moves the stack', () => {
    const sim = makeSim({
      entities: [
        makeCaptain(),                 // (3,3)
        makeSoldier('s1', 3, 3),
        makeSoldier('s2', 3, 3),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const actions = genControlNodes(sim, board, 6);

    const marches = actions.filter(a => a.type === PlanActionType.MARCH);
    assert.ok(marches.length >= 1, 'node push emits MARCH');
    assert.ok(marches.every(a => a.entityId === 'cap1'), 'MARCH is a captain action');

    const soldierMoves = actions.filter(a =>
      a.type === PlanActionType.MOVE && (a.entityId === 's1' || a.entityId === 's2'));
    assert.deepEqual(soldierMoves, [], 'no individual soldier moves — the march carries them');

    // Sim bookkeeping: passengers ride along, so later-generated actions see
    // the projected positions.
    const cap = sim.entities.find(e => e.id === 'cap1');
    for (const id of ['s1', 's2']) {
      const s = sim.entities.find(e => e.id === id);
      assert.deepEqual({ col: s.col, row: s.row }, { col: cap.col, row: cap.row },
        `${id} is projected onto the captain's hex after the march`);
      assert.ok(sim.unitCommitments.has(id), `${id} is committed (not re-ordered later)`);
    }
  });

  test('paladin with co-located survivors never marches', () => {
    const sim = makeSim({
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3 }),   // default paladin-side hero
        makeEntity({ id: 'v1', type: EntityType.SURVIVOR, col: 3, row: 3, hp: 4, maxHp: 4 }),
        makeEntity({ id: 'v2', type: EntityType.SURVIVOR, col: 3, row: 3, hp: 4, maxHp: 4 }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const actions = genControlNodes(sim, board, 6);
    assert.deepEqual(actions.filter(a => a.type === PlanActionType.MARCH), [],
      'no MARCH for a faction that cannot march');
    assert.ok(actions.some(a => a.type === PlanActionType.MOVE), 'plain moves still happen');
  });

  test('hunt: captain pursuing the witch marches the stack', () => {
    const sim = makeSim({
      entities: [
        makeCaptain(),
        makeSoldier('s1', 3, 3),
        makeSoldier('s2', 3, 3),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch',
          col: 6, row: 3, hp: 3, maxHp: 8 }),  // wounded, visible, 3 away — pursue
      ],
    });
    const board = assessHeroBoard(sim);
    const actions = genHuntWitch(sim, board, 4);
    const march = actions.find(a => a.type === PlanActionType.MARCH);
    assert.ok(march, 'pursuit emits MARCH with the stack in tow');
    assert.equal(march.entityId, 'cap1');
  });

  test('queueLeaderStep: full destination falls back to plain MOVE (overflow not worth it)', () => {
    const blockers = [];
    for (let i = 0; i < 6; i++) blockers.push(
      makeEntity({ id: `b${i}`, type: EntityType.SURVIVOR, col: 4, row: 3, hp: 4, maxHp: 4 }));
    const sim = makeSim({
      entities: [
        makeCaptain(),
        makeSoldier('s1', 3, 3),
        makeSoldier('s2', 3, 3),
        ...blockers,
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const leader = sim.entities.find(e => e.id === 'cap1');
    const actions = [];
    queueLeaderStep(actions, sim, leader, 4, 3, 5, HeroGoal.CONTROL_NODES);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].type, PlanActionType.MOVE,
      'a hex with no room for the stack is a MOVE, not a MARCH');
  });

  test('queueLeaderStep: partial capacity marches what fits, overflow stays behind', () => {
    const blockers = [];
    for (let i = 0; i < 4; i++) blockers.push(
      makeEntity({ id: `b${i}`, type: EntityType.SURVIVOR, col: 4, row: 3, hp: 4, maxHp: 4 }));
    const sim = makeSim({
      entities: [
        makeCaptain(),
        makeSoldier('s1', 3, 3),
        makeSoldier('s2', 3, 3),
        makeSoldier('s3', 3, 3),
        ...blockers,                       // dest (4,3): 7 − 4 = 3 slots − captain = 2 carried
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const leader = sim.entities.find(e => e.id === 'cap1');
    const actions = [];
    queueLeaderStep(actions, sim, leader, 4, 3, 5, HeroGoal.CONTROL_NODES);
    assert.equal(actions[0].type, PlanActionType.MARCH);
    const moved = ['s1', 's2', 's3'].filter(id => {
      const s = sim.entities.find(e => e.id === id);
      return s.col === 4 && s.row === 3;
    });
    assert.equal(moved.length, 2, 'exactly the passengers that fit are carried');
    assert.equal(MARCH_MIN_CARRIED, 2, 'march is only worth it from 2 carried soldiers up');
  });

  test('queueLeaderStep: 1 co-located soldier is not worth a MARCH', () => {
    const sim = makeSim({
      entities: [
        makeCaptain(),
        makeSoldier('s1', 3, 3),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const leader = sim.entities.find(e => e.id === 'cap1');
    const actions = [];
    queueLeaderStep(actions, sim, leader, 4, 3, 5, HeroGoal.CONTROL_NODES);
    assert.equal(actions[0].type, PlanActionType.MOVE);
  });
});

// ── BUILD_SIEGE ──────────────────────────────────────────────────────────────

describe('Captain AI — BUILD_SIEGE', () => {
  const nodeAtCaptain = [{ col: 3, row: 3, hexes: [{ col: 3, row: 3 }] }];

  test('builds when affordable and parked on a node — and spends the ledger', () => {
    const sim = makeSim({
      witchObjectives: nodeAtCaptain,
      inventory: { witch: {}, hero: { [ResourceType.WOOD]: 4, [ResourceType.METAL]: 1 } },
      entities: [
        makeCaptain(),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const actions = genControlNodes(sim, board, 4);
    const builds = actions.filter(a => a.type === PlanActionType.BUILD_SIEGE);
    assert.equal(builds.length, 1, 'exactly one build per round');
    assert.equal(builds[0].entityId, 'cap1');
    assert.equal(sim.resourceLedger[ResourceType.WOOD]?.count ?? 0, 0, '4 wood booked');
    assert.equal(sim.resourceLedger[ResourceType.METAL]?.count ?? 0, 0, '1 metal booked');
  });

  test('builds when defending (enemy in sight) even away from nodes', () => {
    const sim = makeSim({
      inventory: { witch: {}, hero: { [ResourceType.WOOD]: 4, [ResourceType.METAL]: 1 } },
      entities: [
        makeCaptain(),                    // default nodes are all 3 away
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch',
          col: 5, row: 3, hp: 8, maxHp: 8 }),  // visible, 2 away
      ],
    });
    const board = assessHeroBoard(sim);
    const actions = genControlNodes(sim, board, 4);
    assert.ok(actions.some(a => a.type === PlanActionType.BUILD_SIEGE),
      'a threatened captain digs in with a battery');
  });

  test('never builds when broke', () => {
    const sim = makeSim({
      witchObjectives: nodeAtCaptain,
      inventory: { witch: {}, hero: { [ResourceType.WOOD]: 3, [ResourceType.METAL]: 1 } },
      entities: [
        makeCaptain(),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const actions = genControlNodes(sim, board, 4);
    assert.deepEqual(actions.filter(a => a.type === PlanActionType.BUILD_SIEGE), []);
  });

  test('never builds past the 2-catapult cap (keeps the fortify wood)', () => {
    const sim = makeSim({
      witchObjectives: nodeAtCaptain,
      inventory: { witch: {}, hero: { [ResourceType.WOOD]: 9, [ResourceType.METAL]: 3 } },
      entities: [
        makeCaptain(),
        makeCatapult('cat1', 1, 1),
        makeCatapult('cat2', 5, 5),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const actions = genControlNodes(sim, board, 4);
    assert.deepEqual(actions.filter(a => a.type === PlanActionType.BUILD_SIEGE), []);
  });

  test('never builds in the open with no node and no threat', () => {
    const sim = makeSim({
      inventory: { witch: {}, hero: { [ResourceType.WOOD]: 4, [ResourceType.METAL]: 1 } },
      entities: [
        makeCaptain(),                    // default nodes all 3 away, witch out of sight
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const actions = genControlNodes(sim, board, 4);
    assert.deepEqual(actions.filter(a => a.type === PlanActionType.BUILD_SIEGE), []);
  });

  test('paladin never builds siege, even rich and on a node', () => {
    const sim = makeSim({
      witchObjectives: nodeAtCaptain,
      inventory: { witch: {}, hero: { [ResourceType.WOOD]: 9, [ResourceType.METAL]: 3 } },
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3 }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 4, row: 3 }),
      ],
    });
    const board = assessHeroBoard(sim);
    const actions = genControlNodes(sim, board, 4);
    assert.deepEqual(actions.filter(a => a.type === PlanActionType.BUILD_SIEGE), []);
  });
});

// ── assemblePlan MARCH handling ──────────────────────────────────────────────

describe('assemblePlan — MARCH handling', () => {
  test('two MARCH steps to different destinations both survive dedup (chained march)', () => {
    const sim = makeSim({ entities: [makeCaptain(),
      makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 })] });
    const board = { totalBudget: 5 };
    const actions = [
      { type: PlanActionType.MARCH, entityId: 'cap1', toCol: 2, toRow: 3, _priority: 1 },
      { type: PlanActionType.MARCH, entityId: 'cap1', toCol: 1, toRow: 3, _priority: 2 },
    ];
    const plan = assemblePlan(actions, sim, board, new Map());
    assert.equal(plan.filter(a => a.type === PlanActionType.MARCH).length, 2,
      'a chained march is two distinct steps, not a duplicate');
  });

  test('duplicate MARCH to the same destination dedups to one', () => {
    const sim = makeSim({ entities: [makeCaptain(),
      makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 })] });
    const board = { totalBudget: 5 };
    const actions = [
      { type: PlanActionType.MARCH, entityId: 'cap1', toCol: 2, toRow: 3, _priority: 1 },
      { type: PlanActionType.MARCH, entityId: 'cap1', toCol: 2, toRow: 3, _priority: 2 },
    ];
    const plan = assemblePlan(actions, sim, board, new Map());
    assert.equal(plan.filter(a => a.type === PlanActionType.MARCH).length, 1);
  });

  test('anti-oscillation drops a MARCH back to a departed hex', () => {
    const sim = makeSim({ entities: [makeCaptain(),
      makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 6, row: 6 })] });
    sim.departedHexes.set('cap1', new Set([hexKey(3, 3)]));
    const board = { totalBudget: 5 };
    const actions = [
      { type: PlanActionType.MARCH, entityId: 'cap1', toCol: 3, toRow: 3, _priority: 1 },
    ];
    const plan = assemblePlan(actions, sim, board, new Map());
    assert.deepEqual(plan, [], 'marching back where you came from is filtered');
  });
});

// ── Paladin neutrality lock ──────────────────────────────────────────────────

describe('Captain AI — paladin neutrality', () => {
  test('default hero full plan contains no MARCH and no BUILD_SIEGE', () => {
    const state = makeFakeState({
      inventory: { witch: {}, hero: { [ResourceType.WOOD]: 9, [ResourceType.METAL]: 3, [ResourceType.FOOD]: 4 } },
      entities: [
        makeEntity({ id: 'hero1', col: 3, row: 3 }),
        makeEntity({ id: 'v1', type: EntityType.SURVIVOR, col: 3, row: 3, hp: 4, maxHp: 4 }),
        makeEntity({ id: 'v2', type: EntityType.SURVIVOR, col: 3, row: 3, hp: 4, maxHp: 4 }),
        makeEntity({ id: 'witch1', type: EntityType.WITCH, owner: 'witch', col: 5, row: 3, hp: 8, maxHp: 8 }),
      ],
    });
    const engine = new HeroAIEngine(state, () => {});
    const plan = engine.generatePlan();
    assert.deepEqual(plan.filter(a =>
      a.type === PlanActionType.MARCH || a.type === PlanActionType.BUILD_SIEGE), []);
  });
});
