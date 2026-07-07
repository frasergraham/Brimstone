// Tests for necromancer-aware witch AI (src/ai-engine.js):
//   • Faction-aware summon economics (getMinionCost: necromancer 1, witch 2)
//   • POSSESS generator (genPossess) — worthy targets only, ability-gated
//   • Possessed thralls are commanded next round (assessBoard + genHuntHeroes)
//   • TELEPORT — escape (genDefendWitch) and node-grab (genControlNodes)
// Witch-neutrality is asserted throughout: the plain witch must behave
// exactly as before (cost 2, no POSSESS/TELEPORT ever emitted).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Phase } from '../src/game.js';
import { EntityType, normalizeItems } from '../src/entities.js';
import { TileType, ResourceType } from '../src/tiles.js';
import { hexKey, hexDistance } from '../src/hex.js';
import {
  EnginePlanSimState,
  assessBoard,
  genBuildArmy,
  genDefendWitch,
  genControlNodes,
  genHuntHeroes,
  genPossess,
} from '../src/ai-engine.js';
import { PlanActionType } from '../src/planner.js';

// ── Test helpers (mirrors tests/ai-engine.test.js) ──────────────────────────

const normSidesInv = (inv) =>
  Object.fromEntries(Object.entries(inv ?? {}).map(([s, m]) => [s, normalizeItems(m)]));

function makeEntity(overrides) {
  return {
    id: 'e1', type: EntityType.WITCH, owner: 'witch',
    col: 0, row: 0, hp: 10, maxHp: 10, attack: 2, defense: 2,
    alive: true, displayName: 'Witch', ownerId: null,
    items: {}, ...overrides,
  };
}

// Necromancer leader fixture — carries the live entity's factionId and the
// faction's innate abilities (mirrors NecromancerFaction.createLeader()).
function makeNecromancer(overrides = {}) {
  return makeEntity({
    id: 'necro1', type: EntityType.NECROMANCER, factionId: 'necromancer',
    abilities: ['summon', 'possess', 'teleport'],
    displayName: 'Necromancer', hp: 14, maxHp: 14, ownerId: 'witch',
    ...overrides,
  });
}

function makeWitch(overrides = {}) {
  return makeEntity({
    id: 'witch1', abilities: ['summon'], ownerId: 'witch', ...overrides,
  });
}

// Brute leader fixture — inherits the witch's golem-bearing getUnitTypes()
// roster but its getSummonOptions() is minion-only at cost 1, which is
// exactly the trap the summon ledger must not fall into.
function makeBrute(overrides = {}) {
  return makeEntity({
    id: 'brute1', type: EntityType.BRUTE, factionId: 'brute',
    abilities: ['summon'],
    displayName: 'The Brute', hp: 20, maxHp: 20, ownerId: 'witch',
    ...overrides,
  });
}

function makeFakeState(overrides = {}) {
  const tiles = new Map();
  const size = overrides.mapSize ?? 9;
  for (let c = 0; c < size; c++) {
    for (let r = 0; r < size; r++) {
      tiles.set(hexKey(c, r), {
        col: c, row: r, type: TileType.GRASS, explored: true,
        building: null, resource: null, fortifyLevel: 0,
      });
    }
  }

  return {
    tiles,
    phase: overrides.phase ?? Phase.NIGHT,
    round: overrides.round ?? 6,
    witchObjectives: overrides.witchObjectives ?? [],
    nodeScore: overrides.nodeScore ?? { hero: 0, witch: 0 },
    fogOfWar: 'none',
    inventory: normSidesInv(overrides.inventory ?? { witch: {}, hero: {} }),
    entities: overrides.entities ?? [makeWitch()],
    noWitchMission: false,
  };
}

function makeSim(stateOverrides = {}) {
  return new EnginePlanSimState(makeFakeState(stateOverrides), 'witch');
}

const summonsIn = (actions) => actions.filter(a => a.type === PlanActionType.SUMMON);
const teleportsIn = (actions) => actions.filter(a => a.type === PlanActionType.TELEPORT);
const possessesIn = (actions) => actions.filter(a => a.type === PlanActionType.POSSESS);

// ── Faction-aware summon ledger ──────────────────────────────────────────────

describe('faction-aware summon economics', () => {
  test('necromancer summons with a single resource (cost 1)', () => {
    const sim = makeSim({
      entities: [makeNecromancer({ col: 4, row: 4 })],
      inventory: { witch: { [ResourceType.WOOD]: 1 }, hero: {} },
    });
    const board = assessBoard(sim);
    const actions = genBuildArmy(sim, board, 3);
    assert.equal(summonsIn(actions).length, 1,
      'necromancer with 1 wood must queue exactly 1 summon');
  });

  test('necromancer converts 3 resources into 3 summons (no golem spend)', () => {
    const sim = makeSim({
      entities: [makeNecromancer({ col: 4, row: 4 })],
      inventory: { witch: { [ResourceType.WOOD]: 3 }, hero: {} },
    });
    const board = assessBoard(sim);
    const actions = genBuildArmy(sim, board, 4);
    assert.equal(summonsIn(actions).length, 3,
      'necromancer with 3 wood must queue 3 summons at cost 1 each');
  });

  test('plain witch still pays 2 — one wood golem from 3 wood', () => {
    const sim = makeSim({
      entities: [makeWitch({ col: 4, row: 4 })],
      inventory: { witch: { [ResourceType.WOOD]: 3 }, hero: {} },
    });
    const board = assessBoard(sim);
    const actions = genBuildArmy(sim, board, 4);
    assert.equal(summonsIn(actions).length, 1,
      'witch with 3 wood must queue exactly 1 summon (2-wood golem, 1 left over)');
  });

  test('plain witch cannot summon with a single resource', () => {
    const sim = makeSim({
      entities: [makeWitch({ col: 4, row: 4 })],
      inventory: { witch: { [ResourceType.WOOD]: 1 }, hero: {} },
    });
    const board = assessBoard(sim);
    const actions = genBuildArmy(sim, board, 3);
    assert.equal(summonsIn(actions).length, 0);
  });

  test('assessBoard.canAffordSummon is cost-aware per faction', () => {
    const necroSim = makeSim({
      entities: [makeNecromancer({ col: 4, row: 4 })],
      inventory: { witch: { [ResourceType.FOOD]: 1 }, hero: {} },
    });
    assert.equal(assessBoard(necroSim).canAffordSummon, true,
      'necromancer affords a summon with 1 resource');

    const witchSim = makeSim({
      entities: [makeWitch({ col: 4, row: 4 })],
      inventory: { witch: { [ResourceType.FOOD]: 1 }, hero: {} },
    });
    assert.equal(assessBoard(witchSim).canAffordSummon, false,
      'witch still needs 2 resources');
  });

  test('assessBoard.bestSummonType never suggests golems for the necromancer', () => {
    const sim = makeSim({
      entities: [makeNecromancer({ col: 4, row: 4 })],
      inventory: { witch: { [ResourceType.METAL]: 2 }, hero: {} },
    });
    const board = assessBoard(sim);
    assert.notEqual(board.bestSummonType, EntityType.IRON_GOLEM);
    assert.notEqual(board.bestSummonType, EntityType.WOOD_GOLEM);
    assert.ok(board.bestSummonType, 'necromancer with resources has a summon type');
  });

  test('brute converts 2 metal into 2 cost-1 minions — never a golem', () => {
    const sim = makeSim({
      entities: [makeBrute({ col: 4, row: 4 })],
      inventory: { witch: { [ResourceType.METAL]: 2 }, hero: {} },
    });
    const board = assessBoard(sim);
    const actions = genBuildArmy(sim, board, 3);
    assert.equal(summonsIn(actions).length, 2,
      'brute must book getSummonOptions economics (2 × 1-cost minion), ' +
      'not the inherited golem roster (1 × 2-metal iron golem)');
  });

  test('assessBoard.bestSummonType for the brute is MINION even with golem resources', () => {
    const sim = makeSim({
      entities: [makeBrute({ col: 4, row: 4 })],
      inventory: { witch: { [ResourceType.METAL]: 2, [ResourceType.WOOD]: 2 }, hero: {} },
    });
    assert.equal(assessBoard(sim).bestSummonType, EntityType.MINION,
      'the brute auto-pick is always the 1-cost minion — golems are unreachable');
  });

  test('assessBoard.bestSummonType golem preference unchanged for the witch', () => {
    const sim = makeSim({
      entities: [makeWitch({ col: 4, row: 4 })],
      inventory: { witch: { [ResourceType.METAL]: 2 }, hero: {} },
    });
    assert.equal(assessBoard(sim).bestSummonType, EntityType.IRON_GOLEM);
  });
});

// ── POSSESS generator ────────────────────────────────────────────────────────

describe('genPossess', () => {
  test('possesses an armed survivor in range', () => {
    const necro = makeNecromancer({ col: 4, row: 4 });
    const armed = makeEntity({
      id: 'surv1', type: EntityType.SURVIVOR, owner: 'hero', ownerId: 'hero',
      col: 5, row: 4, hp: 3, maxHp: 3, attack: 1, defense: 1,
      displayName: 'Armed Survivor',
      items: { sword: { count: 1, equipped: true } },
    });
    const sim = makeSim({ entities: [necro, armed] });
    const board = assessBoard(sim);
    const actions = genPossess(sim, board);
    const poss = possessesIn(actions);
    assert.equal(poss.length, 1, 'one POSSESS queued');
    assert.equal(poss[0].entityId, 'necro1');
    assert.equal(poss[0].targetId, 'surv1');
  });

  test('prefers the armed target over unarmed chaff', () => {
    const necro = makeNecromancer({ col: 4, row: 4 });
    const chaff = makeEntity({
      id: 'chaff1', type: EntityType.SURVIVOR, owner: 'hero', ownerId: 'hero',
      col: 4, row: 5, hp: 3, maxHp: 3, attack: 1, defense: 1,
      displayName: 'Unarmed Survivor',
    });
    const armed = makeEntity({
      id: 'surv1', type: EntityType.SURVIVOR, owner: 'hero', ownerId: 'hero',
      col: 5, row: 4, hp: 3, maxHp: 3, attack: 1, defense: 1,
      displayName: 'Armed Survivor',
      items: { musket: { count: 1, equipped: true } },
    });
    const sim = makeSim({ entities: [necro, chaff, armed] });
    const board = assessBoard(sim);
    const poss = possessesIn(genPossess(sim, board));
    assert.equal(poss.length, 1);
    assert.equal(poss[0].targetId, 'surv1', 'armed survivor outranks chaff');
  });

  test('skips worthless targets (unarmed weak chaff only)', () => {
    const necro = makeNecromancer({ col: 4, row: 4 });
    const chaff = makeEntity({
      id: 'chaff1', type: EntityType.SURVIVOR, owner: 'hero', ownerId: 'hero',
      col: 4, row: 5, hp: 3, maxHp: 3, attack: 1, defense: 1,
      displayName: 'Unarmed Survivor',
    });
    const sim = makeSim({ entities: [necro, chaff] });
    const board = assessBoard(sim);
    assert.equal(possessesIn(genPossess(sim, board)).length, 0,
      'possession is wasted on worthless chaff');
  });

  test('never targets enemy leaders and respects range', () => {
    const necro = makeNecromancer({ col: 4, row: 4 });
    const heroLeader = makeEntity({
      id: 'hero1', type: EntityType.HERO, owner: 'hero', ownerId: 'hero',
      col: 5, row: 4, hp: 8, maxHp: 8, attack: 3, defense: 2, displayName: 'Hero',
    });
    const farArmed = makeEntity({
      id: 'surv1', type: EntityType.SURVIVOR, owner: 'hero', ownerId: 'hero',
      col: 8, row: 4, hp: 3, maxHp: 3, attack: 1, defense: 1,
      displayName: 'Far Armed Survivor',
      items: { sword: { count: 1, equipped: true } },
    });
    const sim = makeSim({ entities: [necro, heroLeader, farArmed] });
    const board = assessBoard(sim);
    assert.equal(possessesIn(genPossess(sim, board)).length, 0);
  });

  test('pending possess target leaves board.visibleHeroes — no same-round BATTLE on the fresh thrall', () => {
    const necro = makeNecromancer({ col: 4, row: 4 });
    const armed = makeEntity({
      id: 'surv1', type: EntityType.SURVIVOR, owner: 'hero', ownerId: 'hero',
      col: 5, row: 4, hp: 3, maxHp: 3, attack: 1, defense: 1,
      displayName: 'Armed Survivor',
      items: { musket: { count: 1, equipped: true } },
    });
    // Zombie adjacent to the survivor: without the fix, genHuntHeroes (and
    // gap-fill) happily queue a BATTLE on the very unit being possessed,
    // killing the thrall the same round it is seized.
    const zombie = makeEntity({
      id: 'zom1', type: EntityType.ZOMBIE, owner: 'witch', ownerId: 'witch',
      col: 5, row: 5, hp: 7, maxHp: 7, attack: 2, defense: 1,
      displayName: 'Zombie',
    });
    const sim = makeSim({ entities: [necro, armed, zombie] });
    const board = assessBoard(sim);

    const poss = possessesIn(genPossess(sim, board));
    assert.equal(poss.length, 1, 'fixture: POSSESS queued on the survivor');
    assert.equal(poss[0].targetId, 'surv1');
    assert.ok(!board.visibleHeroes.some(h => h.id === 'surv1'),
      'pending possess target must be removed from board.visibleHeroes');

    const battles = genHuntHeroes(sim, board, 4).filter(a =>
      a.type === PlanActionType.BATTLE_UNIT && a.targetId === 'surv1');
    assert.equal(battles.length, 0,
      'no witch unit may battle the unit being possessed this round');
  });

  test('plain witch never emits POSSESS', () => {
    const witch = makeWitch({ col: 4, row: 4 });
    const armed = makeEntity({
      id: 'surv1', type: EntityType.SURVIVOR, owner: 'hero', ownerId: 'hero',
      col: 5, row: 4, hp: 3, maxHp: 3, attack: 1, defense: 1,
      displayName: 'Armed Survivor',
      items: { sword: { count: 1, equipped: true } },
    });
    const sim = makeSim({ entities: [witch, armed] });
    const board = assessBoard(sim);
    assert.equal(possessesIn(genPossess(sim, board)).length, 0);
  });
});

// ── Commanding the possessed thrall ──────────────────────────────────────────

describe('possessed thrall command', () => {
  const thrallBoardSim = () => makeSim({
    entities: [
      makeNecromancer({ col: 2, row: 2 }),
      // Thrall: hero-owned survivor currently possessed by the witch side
      makeEntity({
        id: 'thrall1', type: EntityType.SURVIVOR, owner: 'hero', ownerId: 'hero',
        col: 3, row: 2, hp: 3, maxHp: 3, attack: 2, defense: 1,
        displayName: 'Thrall',
        effects: [{ id: 'possessed', source: 'witch', duration: 1 }],
      }),
      // Enemy survivor adjacent to the thrall
      makeEntity({
        id: 'victim1', type: EntityType.SURVIVOR, owner: 'hero', ownerId: 'hero',
        col: 4, row: 2, hp: 2, maxHp: 3, attack: 1, defense: 0,
        displayName: 'Victim',
      }),
    ],
  });

  test('assessBoard lists the thrall as commandable, not as an enemy', () => {
    const board = assessBoard(thrallBoardSim());
    assert.equal(board.possessedUnits?.length, 1, 'thrall surfaces in possessedUnits');
    assert.equal(board.possessedUnits[0].id, 'thrall1');
    assert.ok(!board.visibleHeroes.some(h => h.id === 'thrall1'),
      'thrall must not be targeted as an enemy');
  });

  test('genHuntHeroes commands the thrall against its own side', () => {
    const sim = thrallBoardSim();
    const board = assessBoard(sim);
    const actions = genHuntHeroes(sim, board, 4);
    const thrallActs = actions.filter(a => a.entityId === 'thrall1');
    assert.ok(thrallActs.length >= 1, 'thrall receives at least one order');
    assert.ok(
      thrallActs.some(a => a.type === PlanActionType.BATTLE_UNIT && a.targetId === 'victim1') ||
      thrallActs.some(a => a.type === PlanActionType.MOVE),
      'thrall attacks its own side (or repositions toward it)');
  });

  test('units possessed by the ENEMY of the witch side are not commandable', () => {
    // A witch-side minion possessed by the hero side must NOT appear in
    // possessedUnits (it obeys the hero this round, not us).
    const sim = makeSim({
      entities: [
        makeWitch({ col: 2, row: 2 }),
        makeEntity({
          id: 'stolen1', type: EntityType.MINION, owner: 'witch', ownerId: 'witch',
          col: 3, row: 2, hp: 2, maxHp: 2, attack: 1, defense: 0,
          displayName: 'Stolen Minion',
          effects: [{ id: 'possessed', source: 'hero', duration: 1 }],
        }),
      ],
    });
    const board = assessBoard(sim);
    assert.equal((board.possessedUnits ?? []).length, 0);
  });
});

// ── TELEPORT — escape ────────────────────────────────────────────────────────

describe('teleport escape (genDefendWitch)', () => {
  test('low-HP necromancer with an adjacent enemy teleports away', () => {
    const necro = makeNecromancer({ col: 4, row: 4, hp: 2, maxHp: 14 });
    const hero = makeEntity({
      id: 'hero1', type: EntityType.HERO, owner: 'hero', ownerId: 'hero',
      col: 5, row: 4, hp: 8, maxHp: 8, attack: 3, defense: 2, displayName: 'Hero',
    });
    const sim = makeSim({ entities: [necro, hero] });
    const board = assessBoard(sim);
    const actions = genDefendWitch(sim, board, 3, null);
    const tp = teleportsIn(actions);
    assert.equal(tp.length, 1, 'exactly one escape teleport');
    assert.equal(tp[0].entityId, 'necro1');
    const before = hexDistance(4, 4, hero.col, hero.row);
    const after = hexDistance(tp[0].targetCol, tp[0].targetRow, hero.col, hero.row);
    assert.ok(after > before, `teleport center moves away from the enemy (was ${before}, now ${after})`);
    assert.ok(hexDistance(4, 4, tp[0].targetCol, tp[0].targetRow) <= 4, 'within TELEPORT_RANGE');
  });

  test('healthy necromancer does not burn the escape teleport', () => {
    const necro = makeNecromancer({ col: 4, row: 4 });
    const hero = makeEntity({
      id: 'hero1', type: EntityType.HERO, owner: 'hero', ownerId: 'hero',
      col: 5, row: 4, hp: 8, maxHp: 8, attack: 3, defense: 2, displayName: 'Hero',
    });
    const sim = makeSim({ entities: [necro, hero] });
    const board = assessBoard(sim);
    assert.equal(teleportsIn(genDefendWitch(sim, board, 3, null)).length, 0);
  });

  test('plain witch flees on foot — never teleports', () => {
    const witch = makeWitch({ col: 4, row: 4, hp: 2, maxHp: 10 });
    const hero = makeEntity({
      id: 'hero1', type: EntityType.HERO, owner: 'hero', ownerId: 'hero',
      col: 5, row: 4, hp: 8, maxHp: 8, attack: 3, defense: 2, displayName: 'Hero',
    });
    const sim = makeSim({ entities: [witch, hero] });
    const board = assessBoard(sim);
    const actions = genDefendWitch(sim, board, 3, null);
    assert.equal(teleportsIn(actions).length, 0);
    assert.ok(actions.some(a => a.type === PlanActionType.MOVE), 'witch still flees by walking');
  });
});

// ── TELEPORT — node grab ─────────────────────────────────────────────────────

describe('teleport node grab (genControlNodes)', () => {
  test('necromancer jumps to an uncontested node instead of walking', () => {
    const necro = makeNecromancer({ col: 0, row: 2 });
    const sim = makeSim({
      entities: [necro],
      witchObjectives: [{ col: 4, row: 2, hexes: [{ col: 4, row: 2 }] }],
    });
    const board = assessBoard(sim);
    const actions = genControlNodes(sim, board, 3);
    const tp = teleportsIn(actions);
    assert.equal(tp.length, 1, 'one node-grab teleport');
    assert.equal(tp[0].entityId, 'necro1');
    assert.equal(tp[0].targetCol, 4);
    assert.equal(tp[0].targetRow, 2);
  });

  test('approach warp: distant node draws a jump that saves >= 3 steps', () => {
    const necro = makeNecromancer({ col: 0, row: 2 });
    const sim = makeSim({
      entities: [necro],
      witchObjectives: [{ col: 7, row: 2, hexes: [{ col: 7, row: 2 }] }],
    });
    const board = assessBoard(sim);
    const tp = teleportsIn(genControlNodes(sim, board, 3));
    assert.equal(tp.length, 1, 'one approach teleport');
    const jumped = hexDistance(0, 2, tp[0].targetCol, tp[0].targetRow);
    assert.ok(jumped <= 4, `center within TELEPORT_RANGE (got ${jumped})`);
    const before = hexDistance(0, 2, 7, 2);
    const after = hexDistance(tp[0].targetCol, tp[0].targetRow, 7, 2);
    assert.ok(before - after >= 3, `warp gains >= 3 steps (was ${before}, now ${after})`);
  });

  test('no node-grab teleport when a hero contests the node', () => {
    const necro = makeNecromancer({ col: 0, row: 2 });
    const hero = makeEntity({
      id: 'hero1', type: EntityType.HERO, owner: 'hero', ownerId: 'hero',
      col: 4, row: 2, hp: 8, maxHp: 8, attack: 3, defense: 2, displayName: 'Hero',
    });
    const sim = makeSim({
      entities: [necro, hero],
      witchObjectives: [{ col: 4, row: 2, hexes: [{ col: 4, row: 2 }] }],
    });
    const board = assessBoard(sim);
    assert.equal(teleportsIn(genControlNodes(sim, board, 3)).length, 0);
  });

  test('plain witch walks to nodes — never teleports', () => {
    const witch = makeWitch({ col: 0, row: 2 });
    const sim = makeSim({
      entities: [witch],
      witchObjectives: [{ col: 4, row: 2, hexes: [{ col: 4, row: 2 }] }],
    });
    const board = assessBoard(sim);
    const actions = genControlNodes(sim, board, 3);
    assert.equal(teleportsIn(actions).length, 0);
    assert.ok(actions.some(a => a.type === PlanActionType.MOVE && a.entityId === 'witch1'));
  });
});
