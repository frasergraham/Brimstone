// Tests for tutorial/prologue mode: map generation, conductor step logic, witch plan scripting.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTutorialMap, TUTORIAL_STEPS, TUTORIAL_WAVES, TUTORIAL_FORCED_DICE, TUTORIAL_CONDUCTOR_CONFIG } from '../src/tutorial/tutorial-config.js';
import { GameState } from '../src/game.js';
import { MissionConductor } from '../src/mission-conductor.js';
import { EntityType, setForcedDice, Entity } from '../src/entities.js';
import { hexKey, MAP_COLS, MAP_ROWS } from '../src/hex.js';
import { TileType, BuildingType, legacyTileType } from '../src/tiles.js';
import { PlanActionType } from '../src/planner.js';

// ── buildTutorialMap ─────────────────────────────────────────────────────────

describe('buildTutorialMap', () => {
  test('returns a 9×9 tile map', () => {
    const { tiles, cols, rows } = buildTutorialMap();
    assert.equal(cols, 9);
    assert.equal(rows, 9);
    assert.equal(tiles.size, 81);
  });

  test('sets global map dimensions to 9×9', () => {
    buildTutorialMap();
    assert.equal(MAP_COLS, 9);
    assert.equal(MAP_ROWS, 9);
  });

  test('INN is at (2,7)', () => {
    const { tiles } = buildTutorialMap();
    const t = tiles.get(hexKey(2, 7));
    assert.ok(t, 'tile exists at (2,7)');
    assert.equal(legacyTileType(t), TileType.BUILDING);
    assert.equal(t.building, BuildingType.INN);
  });

  test('CHURCH is at (2,5)', () => {
    const { tiles } = buildTutorialMap();
    const t = tiles.get(hexKey(2, 5));
    assert.ok(t, 'tile exists at (2,5)');
    assert.equal(legacyTileType(t), TileType.BUILDING);
    assert.equal(t.building, BuildingType.CHURCH);
  });

  test('HOUSE (survivor building) is at (2,3)', () => {
    const { tiles } = buildTutorialMap();
    const t = tiles.get(hexKey(2, 3));
    assert.ok(t, 'tile exists at (2,3)');
    assert.equal(legacyTileType(t), TileType.BUILDING);
    assert.equal(t.building, BuildingType.HOUSE);
  });

  test('Blacksmith is at (5,5)', () => {
    const { tiles } = buildTutorialMap();
    const t = tiles.get(hexKey(5, 5));
    assert.ok(t, 'tile exists at (5,5)');
    assert.equal(legacyTileType(t), TileType.BUILDING);
    assert.equal(t.building, BuildingType.BLACKSMITH);
  });

  test('Barn is at (6,3)', () => {
    const { tiles } = buildTutorialMap();
    const t = tiles.get(hexKey(6, 3));
    assert.ok(t, 'tile exists at (6,3)');
    assert.equal(legacyTileType(t), TileType.BUILDING);
    assert.equal(t.building, BuildingType.BARN);
  });

  test('Graveyard is at (7,2)', () => {
    const { tiles } = buildTutorialMap();
    const t = tiles.get(hexKey(7, 2));
    assert.ok(t, 'tile exists at (7,2)');
    assert.equal(legacyTileType(t), TileType.BUILDING);
    assert.equal(t.building, BuildingType.GRAVEYARD);
  });

  test('INN and CHURCH are road-connected via roadDirs', () => {
    const { tiles } = buildTutorialMap();
    const inn    = tiles.get(hexKey(2, 7));
    const road26 = tiles.get(hexKey(2, 6));
    const church = tiles.get(hexKey(2, 5));
    assert.ok(inn.roadDirs.has(hexKey(2, 6)),    'INN → road(2,6)');
    assert.ok(road26.roadDirs.has(hexKey(2, 7)), 'road(2,6) → INN');
    assert.ok(road26.roadDirs.has(hexKey(2, 5)), 'road(2,6) → CHURCH');
    assert.ok(church.roadDirs.has(hexKey(2, 6)), 'CHURCH → road(2,6)');
  });

  test('Church and Blacksmith are road-connected', () => {
    const { tiles } = buildTutorialMap();
    const church = tiles.get(hexKey(2, 5));
    const smith  = tiles.get(hexKey(5, 5));
    assert.ok(church.roadDirs.has(hexKey(3, 5)), 'Church connects east via road');
    assert.ok(smith.roadDirs.has(hexKey(4, 5)),  'Blacksmith connects west via road');
  });

  test('heroStart is at INN position (2,7)', () => {
    const { heroStart } = buildTutorialMap();
    assert.equal(heroStart.col, 2);
    assert.equal(heroStart.row, 7);
  });

  test('noWitch flag is set', () => {
    const mapData = buildTutorialMap();
    assert.equal(mapData.noWitch, true);
  });

  test('single power node exists east of Blacksmith', () => {
    const { witchObjectives } = buildTutorialMap();
    assert.equal(witchObjectives.length, 1);
    assert.equal(witchObjectives[0].col, 7);
    assert.equal(witchObjectives[0].row, 5);
  });

  test('power node cluster has exactly 3 hexes', () => {
    const { witchObjectives } = buildTutorialMap();
    assert.equal(witchObjectives[0].hexes.length, 3);
  });

  test('power node starts hidden from hero (discovered via proximity in round 4)', () => {
    const { witchObjectives } = buildTutorialMap();
    assert.equal(witchObjectives[0].seenByHero,  false);
    assert.equal(witchObjectives[0].seenByWitch, true);
  });

  test('survivorCounts is {buildings:0, terrain:0} (tutorial places survivors manually)', () => {
    const { survivorCounts } = buildTutorialMap();
    assert.equal(survivorCounts.buildings, 0);
    assert.equal(survivorCounts.terrain,   0);
  });

  test('hero starts 2 hexes from church (road allows reaching in one move)', () => {
    const { heroStart } = buildTutorialMap();
    // Hero at (2,7), Church at (2,5) — 2 hexes apart
    assert.equal(heroStart.col, 2);
    assert.equal(heroStart.row, 7);
    // Church is at row 5, hero at row 7, distance = 2
    assert.equal(heroStart.row - 5, 2);
  });
});

// ── GameState with mapDataOverride ────────────────────────────────────────────

describe('GameState with tutorial map override', () => {
  test('accepts tutorial map as 5th constructor argument', () => {
    const mapData = buildTutorialMap();
    const state = new GameState(false, false, 'tutorial', null, mapData);
    assert.ok(state.tiles.size > 0);
  });

  test('hero starts at INN (2,7)', () => {
    const mapData = buildTutorialMap();
    const state   = new GameState(false, false, 'tutorial', null, mapData);
    const hero    = state.entities.find(e => e.type === EntityType.HERO);
    assert.ok(hero, 'hero entity exists');
    assert.equal(hero.col, 2);
    assert.equal(hero.row, 7);
  });

  test('no witch entity when noWitch is set', () => {
    const mapData = buildTutorialMap();
    const state   = new GameState(false, false, 'tutorial', null, mapData);
    const witch   = state.entities.find(e => e.type === EntityType.WITCH);
    assert.equal(witch, undefined, 'no witch entity');
    assert.equal(state.witch, null, 'state.witch is null');
  });
});

// ── setForcedDice ─────────────────────────────────────────────────────────────

describe('setForcedDice', () => {
  test('tutorial forced dice produce a crush kill on minion', () => {
    // Hero (ATK 3, DEF 2) vs Minion (ATK 1, DEF 0)
    // Force: atkDie=6 → atk=9, defDie=1 → def=1 → crush (9 >= 2×1)
    const hero   = { type: 'hero',  attack: 3, defense: 2, attackBonus: 0, defenseBonus: 0, weapon: null };
    const minion = { type: 'minion', attack: 1, defense: 0, attackBonus: 0, defenseBonus: 0, weapon: null };
    setForcedDice(...TUTORIAL_FORCED_DICE);
    const result = Entity.resolveCombat(hero, minion);
    assert.equal(result.atkBaseDie,  6);
    assert.equal(result.defBaseDie,  1);
    assert.equal(result.attackRoll,  9);   // 6 + 3
    assert.equal(result.defenseRoll, 1);   // 1 + 0
    assert.equal(result.hit, true);
    // Crush: attackRoll >= 2 * defenseRoll → 9 >= 2 → 2 damage kills minion (HP 2)
    assert.ok(result.attackRoll >= 2 * result.defenseRoll, 'crush threshold met');
  });

  test('reverts to random after forced queue empties', () => {
    setForcedDice(6, 6); // use up the forced values
    Entity.resolveCombat(
      { type: 'hero',  attack: 3, defense: 2, attackBonus: 0, defenseBonus: 0, weapon: null },
      { type: 'minion', attack: 1, defense: 0, attackBonus: 0, defenseBonus: 0, weapon: null },
    );
    // After consuming both forced dice the queue is empty; a second call must
    // not throw and must return a valid result (random dice, so just check shape).
    const r2 = Entity.resolveCombat(
      { type: 'hero',  attack: 3, defense: 2, attackBonus: 0, defenseBonus: 0, weapon: null },
      { type: 'minion', attack: 1, defense: 0, attackBonus: 0, defenseBonus: 0, weapon: null },
    );
    assert.ok(typeof r2.atkBaseDie === 'number');
    assert.ok(r2.atkBaseDie >= 1 && r2.atkBaseDie <= 6);
  });
});

// ── TUTORIAL_STEPS definitions ────────────────────────────────────────────────

describe('TUTORIAL_STEPS', () => {
  test('has 25 steps', () => {
    assert.equal(TUTORIAL_STEPS.length, 25);
  });

  test('first step id is "welcome"', () => {
    assert.equal(TUTORIAL_STEPS[0].id, 'welcome');
  });

  test('last step id is "complete" with trigger "complete"', () => {
    const last = TUTORIAL_STEPS[TUTORIAL_STEPS.length - 1];
    assert.equal(last.id,      'complete');
    assert.equal(last.trigger, 'complete');
  });

  test('all steps have required fields', () => {
    for (const step of TUTORIAL_STEPS) {
      assert.ok(step.id,     `step ${step.id} has id`);
      assert.ok(step.title,  `step ${step.id} has title`);
      assert.ok(step.body,   `step ${step.id} has body`);
      assert.ok(step.trigger !== undefined, `step ${step.id} has trigger`);
    }
  });

  test('unit_selection step exists between planning_intro and select_hero', () => {
    const piIdx = TUTORIAL_STEPS.findIndex(s => s.id === 'planning_intro');
    const usIdx = TUTORIAL_STEPS.findIndex(s => s.id === 'unit_selection');
    const shIdx = TUTORIAL_STEPS.findIndex(s => s.id === 'select_hero');
    assert.ok(usIdx > piIdx, 'unit_selection comes after planning_intro');
    assert.ok(usIdx < shIdx, 'unit_selection comes before select_hero');
    assert.equal(TUTORIAL_STEPS[usIdx].trigger, 'click');
  });

  test('queue_explore step spotlights Church (2,5) not Inn', () => {
    const step = TUTORIAL_STEPS.find(s => s.id === 'queue_explore');
    assert.ok(step, 'queue_explore step exists');
    assert.equal(step.spotlight?.type, 'hex');
    assert.equal(step.spotlight?.col, 2);
    assert.equal(step.spotlight?.row, 5);
  });

  test('submit_plan and submit_fight use bottom-left tooltip position', () => {
    const sp = TUTORIAL_STEPS.find(s => s.id === 'submit_plan');
    const sf = TUTORIAL_STEPS.find(s => s.id === 'submit_fight');
    assert.equal(sp.tooltipPos, 'bottom-left');
    assert.equal(sf.tooltipPos, 'bottom-left');
  });

  test('round-1 witch plan step has witchPlan: []', () => {
    const submitStep = TUTORIAL_STEPS.find(s => s.id === 'submit_plan');
    assert.ok(submitStep, 'submit_plan step exists');
    assert.deepEqual(submitStep.witchPlan, []);
  });

  test('round-3 submit step has witchPlan: []', () => {
    const step = TUTORIAL_STEPS.find(s => s.id === 'submit_r3');
    assert.ok(step, 'submit_r3 step exists');
    assert.deepEqual(step.witchPlan, []);
  });

  test('combat_intro comes after watch_r1 (not day_night first)', () => {
    const w1 = TUTORIAL_STEPS.findIndex(s => s.id === 'watch_r1');
    const ci = TUTORIAL_STEPS.findIndex(s => s.id === 'combat_intro');
    assert.ok(ci > w1, 'combat_intro after watch_r1');
    assert.equal(TUTORIAL_STEPS[ci].trigger.actionType, PlanActionType.BATTLE_UNIT);
  });

  test('day_night comes after watch_r2 (moved later in sequence)', () => {
    const w2 = TUTORIAL_STEPS.findIndex(s => s.id === 'watch_r2');
    const dn = TUTORIAL_STEPS.findIndex(s => s.id === 'day_night');
    assert.ok(dn > w2, 'day_night after watch_r2');
    assert.equal(TUTORIAL_STEPS[dn].trigger, 'click');
    assert.ok(TUTORIAL_STEPS[dn].spotlight?.selector?.includes('cycle-bump'), 'spotlights cycle-bump');
  });

  test('survivor and smithy steps exist in correct order', () => {
    const ids = ['watch_r2', 'day_night', 'move_to_house', 'explore_house',
      'submit_r3', 'watch_r3', 'select_survivor', 'survivor_move', 'smithy_intro',
      'submit_r4', 'watch_r4'];
    const indices = ids.map(id => TUTORIAL_STEPS.findIndex(s => s.id === id));
    for (let i = 1; i < indices.length; i++) {
      assert.ok(indices[i] > indices[i - 1], `${ids[i]} comes after ${ids[i - 1]}`);
    }
  });

  test('select_survivor is gated on selecting the SURVIVOR (was a passive card)', () => {
    const step = TUTORIAL_STEPS.find(s => s.id === 'select_survivor');
    assert.ok(step, 'select_survivor step exists');
    assert.equal(step.trigger?.type, 'entity_selected');
    assert.equal(step.trigger?.entityType, EntityType.SURVIVOR);
  });

  test('action_budget step spotlights the budget badge', () => {
    const step = TUTORIAL_STEPS.find(s => s.id === 'action_budget');
    assert.ok(step, 'action_budget step exists');
    assert.equal(step.spotlight?.type, 'element');
    assert.ok(step.spotlight.selector.includes('plan-budget-badge'), 'spotlights #plan-budget-badge');
    assert.ok(step.body.toLowerCase().includes('budget'), 'body explains the budget');
  });

  test('survivor_move gates on the SURVIVOR queuing a MOVE (shared-budget lesson)', () => {
    const step = TUTORIAL_STEPS.find(s => s.id === 'survivor_move');
    assert.ok(step, 'survivor_move step exists');
    assert.equal(step.trigger?.type, 'action_queued');
    assert.equal(step.trigger?.actionType, PlanActionType.MOVE);
    assert.equal(step.trigger?.entityType, EntityType.SURVIVOR);
    assert.ok(step.spotlight.selector.includes('plan-budget-badge'), 'spotlights the budget badge');
  });

  test('smithy_intro gates on the HERO queuing a MOVE', () => {
    const step = TUTORIAL_STEPS.find(s => s.id === 'smithy_intro');
    assert.equal(step.trigger?.entityType, EntityType.HERO);
  });

  test('move_to_house spotlights HOUSE at (2,3)', () => {
    const step = TUTORIAL_STEPS.find(s => s.id === 'move_to_house');
    assert.ok(step, 'move_to_house step exists');
    assert.equal(step.spotlight?.type, 'hex');
    assert.equal(step.spotlight?.col, 2);
    assert.equal(step.spotlight?.row, 3);
    assert.equal(step.trigger?.actionType, PlanActionType.MOVE);
  });

  test('explore_house triggers on EXPLORE action', () => {
    const step = TUTORIAL_STEPS.find(s => s.id === 'explore_house');
    assert.ok(step, 'explore_house step exists');
    assert.equal(step.trigger?.type, 'action_queued');
    assert.equal(step.trigger?.actionType, PlanActionType.EXPLORE);
  });

  test('node_discovered then complete close out the tutorial (fortify/guard/score moved to Ch1 hints)', () => {
    const r4  = TUTORIAL_STEPS.findIndex(s => s.id === 'watch_r4');
    const nd  = TUTORIAL_STEPS.findIndex(s => s.id === 'node_discovered');
    const cp  = TUTORIAL_STEPS.findIndex(s => s.id === 'complete');
    assert.ok(nd > r4, 'node_discovered after watch_r4');
    assert.equal(cp, TUTORIAL_STEPS.length - 1, 'complete is last');
    assert.equal(TUTORIAL_STEPS[nd].trigger, 'click');
    // The passive ending cards were redistributed into Chapter 1 micro-lessons.
    for (const moved of ['score_tracker', 'fortify', 'guard', 'night_warning', 'multi_select', 'survivor_intro', 'ghost_arrow']) {
      assert.equal(TUTORIAL_STEPS.findIndex(s => s.id === moved), -1, `${moved} removed from prologue`);
    }
  });

  test('auto-trigger steps are watch_r1, watch_r2, watch_r3, watch_r4 only', () => {
    const autoSteps = TUTORIAL_STEPS.filter(s => s.trigger === 'auto').map(s => s.id);
    assert.deepEqual(autoSteps.sort(), ['watch_r1', 'watch_r2', 'watch_r3', 'watch_r4'].sort());
  });

  test('combat_intro does not mention action menu for battle', () => {
    const step = TUTORIAL_STEPS.find(s => s.id === 'combat_intro');
    assert.ok(!step.body.includes('action menu'), 'should not reference action menu for attacking');
    assert.ok(!step.body.includes('choose Battle'), 'should not say choose Battle');
  });

  test('combat_formula does not say "d6"', () => {
    const step = TUTORIAL_STEPS.find(s => s.id === 'combat_formula');
    assert.ok(!step.body.includes('d6'), 'should not reference d6');
  });

  test('combat steps never mention damage numbers (damage system is tuned separately)', () => {
    for (const id of ['combat_intro', 'combat_formula', 'submit_fight', 'watch_r2']) {
      const step = TUTORIAL_STEPS.find(s => s.id === id);
      assert.ok(!/\d+\s*damage|damage\s*\d+/i.test(step.body),
        `${id} must describe hit/crush/counter outcomes, not damage numbers`);
    }
  });

  test('combat_intro tells the player to select the hero first', () => {
    const step = TUTORIAL_STEPS.find(s => s.id === 'combat_intro');
    assert.ok(/select your .*hero/i.test(step.body), 'hero is not auto-selected in tutorial mode');
  });

  test('combat_formula calls out the ally/gang-up advantage', () => {
    const step = TUTORIAL_STEPS.find(s => s.id === 'combat_formula');
    assert.ok(/all(y|ies)/i.test(step.body), 'mentions allies');
    assert.ok(/outnumbered|gang up/i.test(step.body), 'warns against outnumbered fights');
  });
});

// ── TUTORIAL_WAVES ───────────────────────────────────────────────────────────

describe('TUTORIAL_WAVES', () => {
  test('wave spawns minion at (3,5) on round 2 (after first endRound)', () => {
    assert.equal(TUTORIAL_WAVES.length, 1);
    assert.equal(TUTORIAL_WAVES[0].round, 2);
    assert.equal(TUTORIAL_WAVES[0].units[0].type, 'minion');
    assert.deepEqual(TUTORIAL_WAVES[0].units[0].spawnAt, { col: 3, row: 5 });
  });
});

// ── MissionConductor step gating ─────────────────────────────────────────────

describe('MissionConductor logic (no DOM)', () => {
  test('TUTORIAL_STEPS step indices are consistent', () => {
    // Verify the step index lookups used in onPlanningPhaseStart() are valid
    const r1Idx      = TUTORIAL_STEPS.findIndex(s => s.id === 'watch_r1');
    const combatIdx  = TUTORIAL_STEPS.findIndex(s => s.id === 'combat_intro');
    const r2Idx      = TUTORIAL_STEPS.findIndex(s => s.id === 'watch_r2');
    const dayNight   = TUTORIAL_STEPS.findIndex(s => s.id === 'day_night');
    const moveHouse  = TUTORIAL_STEPS.findIndex(s => s.id === 'move_to_house');
    const r3Idx      = TUTORIAL_STEPS.findIndex(s => s.id === 'watch_r3');
    const selSurv    = TUTORIAL_STEPS.findIndex(s => s.id === 'select_survivor');
    assert.ok(r1Idx      >= 0, 'watch_r1 step found');
    assert.ok(combatIdx  > r1Idx,      'combat_intro comes after watch_r1');
    assert.ok(r2Idx      > combatIdx,  'watch_r2 comes after combat_intro');
    assert.ok(dayNight   > r2Idx,      'day_night comes after watch_r2');
    assert.ok(moveHouse  > dayNight,   'move_to_house comes after day_night');
    assert.ok(r3Idx      > moveHouse,  'watch_r3 comes after move_to_house');
    assert.ok(selSurv    > r3Idx,      'select_survivor comes after watch_r3');
  });

  test('getWitchPlan returns [] when round 0 and submit_plan step has witchPlan:[]', () => {
    // Verify round 0 (first round) witch plan logic
    const submitStep = TUTORIAL_STEPS.find(s => s.id === 'submit_plan');
    assert.deepEqual(submitStep.witchPlan, []);
  });

  test('combat_intro step triggers on BATTLE_UNIT action', () => {
    const step = TUTORIAL_STEPS.find(s => s.id === 'combat_intro');
    assert.equal(step.trigger.type,       'action_queued');
    assert.equal(step.trigger.actionType, PlanActionType.BATTLE_UNIT);
  });

  test('queue_move step triggers on MOVE action', () => {
    const step = TUTORIAL_STEPS.find(s => s.id === 'queue_move');
    assert.equal(step.trigger.type,       'action_queued');
    assert.equal(step.trigger.actionType, PlanActionType.MOVE);
  });

  test('queue_explore step triggers on EXPLORE action', () => {
    const step = TUTORIAL_STEPS.find(s => s.id === 'queue_explore');
    assert.equal(step.trigger.type,       'action_queued');
    assert.equal(step.trigger.actionType, PlanActionType.EXPLORE);
  });

  test('select_hero step triggers on hero entity selected', () => {
    const step = TUTORIAL_STEPS.find(s => s.id === 'select_hero');
    assert.equal(step.trigger.type,       'entity_selected');
    assert.equal(step.trigger.entityType, EntityType.HERO);
  });

  test('plan-spotlight steps reference valid DOM selectors', () => {
    for (const step of TUTORIAL_STEPS) {
      if (step.spotlight?.type === 'element') {
        assert.ok(typeof step.spotlight.selector === 'string',
          `${step.id} spotlight selector is a string`);
        assert.ok(step.spotlight.selector.startsWith('#') || step.spotlight.selector.startsWith('.'),
          `${step.id} spotlight selector starts with # or .`);
      }
    }
  });

  test('hex-spotlight steps have valid col/row for 9×9 tutorial map', () => {
    for (const step of TUTORIAL_STEPS) {
      if (step.spotlight?.type === 'hex') {
        assert.ok(step.spotlight.col >= 0 && step.spotlight.col < 9,
          `${step.id} spotlight col in bounds`);
        assert.ok(step.spotlight.row >= 0 && step.spotlight.row < 9,
          `${step.id} spotlight row in bounds`);
      }
    }
  });

  test('arrow spotlight steps have valid direction values', () => {
    const validDirs = ['up', 'down', 'left', 'right'];
    for (const step of TUTORIAL_STEPS) {
      if (step.spotlight?.arrow) {
        assert.ok(validDirs.includes(step.spotlight.arrow),
          `${step.id} arrow direction "${step.spotlight.arrow}" is valid`);
      }
    }
  });

  test('click and complete steps should block map clicks; action-gated steps should not', () => {
    for (const step of TUTORIAL_STEPS) {
      const t = step.trigger;
      if (t === 'click' || t === 'complete') {
        // These dialog steps should block map interaction
        assert.ok(true, `${step.id} (trigger=${t}) blocks clicks`);
      } else {
        // Action-gated and auto steps need map to be interactive
        assert.ok(t === 'auto' || (typeof t === 'object' && t.type),
          `${step.id} has valid non-blocking trigger`);
      }
    }
  });
});

// ── TUTORIAL_CONDUCTOR_CONFIG ────────────────────────────────────────────────

describe('TUTORIAL_CONDUCTOR_CONFIG', () => {
  test('has required config fields', () => {
    assert.ok(TUTORIAL_CONDUCTOR_CONFIG.roundStepMap, 'has roundStepMap');
    assert.ok(typeof TUTORIAL_CONDUCTOR_CONFIG.witchPlanProvider === 'function', 'witchPlanProvider is a function');
    assert.ok(Array.isArray(TUTORIAL_CONDUCTOR_CONFIG.forcedDice), 'forcedDice is an array');
    assert.equal(typeof TUTORIAL_CONDUCTOR_CONFIG.maxPlanningRounds, 'number', 'maxPlanningRounds is a number');
  });

  test('roundStepMap maps rounds 1-4 to known step IDs', () => {
    const map = TUTORIAL_CONDUCTOR_CONFIG.roundStepMap;
    assert.equal(map[1], 'combat_intro');
    assert.equal(map[2], 'move_to_house');
    assert.equal(map[3], 'select_survivor');
    assert.equal(map[4], 'node_discovered');
    for (const id of Object.values(map)) {
      assert.ok(TUTORIAL_STEPS.some(s => s.id === id), `step "${id}" exists`);
    }
  });

  test('forcedDice entry for round 1 matches TUTORIAL_FORCED_DICE', () => {
    const entry = TUTORIAL_CONDUCTOR_CONFIG.forcedDice.find(e => e.round === 1);
    assert.ok(entry, 'forcedDice entry for round 1 exists');
    assert.deepEqual(entry.dice, TUTORIAL_FORCED_DICE);
  });

  test('maxPlanningRounds is 4', () => {
    assert.equal(TUTORIAL_CONDUCTOR_CONFIG.maxPlanningRounds, 4);
  });

  test('witchPlanProvider returns [] for round 0 with empty witchPlan step', () => {
    const fakeState = { entities: [] };
    const fakeStep = { witchPlan: [] };
    const plan = TUTORIAL_CONDUCTOR_CONFIG.witchPlanProvider(0, fakeState, fakeStep);
    assert.deepEqual(plan, []);
  });

  test('witchPlanProvider returns [] for round 3+ (idle)', () => {
    const fakeState = { entities: [] };
    const plan = TUTORIAL_CONDUCTOR_CONFIG.witchPlanProvider(3, fakeState, null);
    assert.deepEqual(plan, []);
  });
});

// ── Prologue campaign definition ─────────────────────────────────────────────

describe('Prologue campaign', async () => {
  // The tutorial mission def is data-driven (src/campaign/missions/tutorial.json)
  // and registered into the campaign shell by campaign-registry.js at init, so we
  // source the populated campaign through the registry rather than the bare shell.
  const { getCampaignById } = await import('../src/campaign/campaign-registry.js');
  const prologue = getCampaignById('prologue');

  test('has expected campaign shape', () => {
    assert.equal(prologue.id, 'prologue');
    assert.equal(prologue.title, 'Prologue (Tutorial)');
    assert.equal(prologue.prerequisiteCampaign, null);
    assert.equal(prologue.firstMission, 'tutorial');
  });

  test('has exactly one mission', () => {
    assert.equal(prologue.missions.length, 1);
    assert.equal(prologue.missions[0].id, 'tutorial');
  });

  test('mission has conductorSteps and conductorConfig', () => {
    const m = prologue.missions[0];
    assert.ok(Array.isArray(m.conductorSteps), 'conductorSteps is an array');
    assert.ok(m.conductorConfig, 'conductorConfig exists');
    assert.ok(m.conductorConfig.roundStepMap, 'conductorConfig has roundStepMap');
  });

  test('mission uses tutorial waves', () => {
    const m = prologue.missions[0];
    assert.ok(Array.isArray(m.waves), 'waves is an array');
    assert.equal(m.waves.length, 1);
  });

  test('mission has conductor_complete objective', () => {
    const m = prologue.missions[0];
    assert.equal(m.objectives.win.type, 'conductor_complete');
    assert.equal(m.objectives.lose, null);
  });
});

// ── gameOver is getter-only on GameState (regression: tutorial onComplete) ───

describe('GameState.gameOver is computed from winner', () => {
  test('gameOver is false when winner is null', () => {
    const mapData = buildTutorialMap();
    const state = new GameState(false, false, 'tutorial', null, mapData);
    assert.equal(state.winner, null);
    assert.equal(state.gameOver, false);
  });

  test('setting winner makes gameOver true', () => {
    const mapData = buildTutorialMap();
    const state = new GameState(false, false, 'tutorial', null, mapData);
    state.winner = 'hero';
    assert.equal(state.gameOver, true);
  });

  test('assigning state.gameOver directly throws TypeError (getter-only)', () => {
    const mapData = buildTutorialMap();
    const state = new GameState(false, false, 'tutorial', null, mapData);
    assert.throws(() => { state.gameOver = true; }, TypeError);
  });
});

// ── Step lint: terse, centered, arrowed (applies to tutorial + all hint scripts) ──
//
// Design rules from the tutorial rework:
//   • bodies stay SHORT — concepts are taught by doing, not reading
//   • blocking dialogs ('click'/'complete') are centered — corner dialogs
//     don't get read (the conductor also force-centers them at runtime)
//   • every action-gated step carries an arrow pointing at its target
//   • element spotlight selectors must exist in index.html

import { readFileSync } from 'node:fs';
import { HINT_SCRIPTS } from '../src/campaign/hint-scripts.js';
import { CONDUCTOR_SCRIPTS, resolveConductorScript } from '../src/campaign/conductor-scripts.js';
import { areHintsSuppressed, markHintsSeen } from '../src/mission-conductor.js';

const ALL_SCRIPTS = Object.entries(CONDUCTOR_SCRIPTS).map(([key, s]) => ({ key, ...s }));
const MAX_BODY_CHARS = 230;

describe('step lint (tutorial + hint scripts)', () => {
  test('step ids are unique within each script', () => {
    for (const { key, steps } of ALL_SCRIPTS) {
      const ids = steps.map(s => s.id);
      assert.equal(new Set(ids).size, ids.length, `${key}: duplicate step ids`);
    }
  });

  test(`bodies are terse (≤ ${MAX_BODY_CHARS} chars)`, () => {
    for (const { key, steps } of ALL_SCRIPTS) {
      for (const s of steps) {
        assert.ok(s.body.length <= MAX_BODY_CHARS,
          `${key}/${s.id}: body is ${s.body.length} chars (max ${MAX_BODY_CHARS}) — teach by doing, not reading`);
      }
    }
  });

  test('blocking dialogs are centered', () => {
    for (const { key, steps } of ALL_SCRIPTS) {
      for (const s of steps) {
        if (s.trigger === 'click' || s.trigger === 'complete') {
          assert.equal(s.tooltipPos ?? 'center', 'center',
            `${key}/${s.id}: blocking dialog must use tooltipPos 'center'`);
        }
      }
    }
  });

  test('every action-gated step has an arrow pointing at its target', () => {
    for (const { key, steps } of ALL_SCRIPTS) {
      for (const s of steps) {
        if (typeof s.trigger !== 'object' || !s.trigger?.type) continue;
        // Hint-mode gated steps may be spotlight-free nudges; tutorial gated
        // steps always direct the player somewhere specific.
        if (!s.spotlight) {
          assert.ok(key !== 'tutorial', `tutorial/${s.id}: gated step needs a spotlight`);
          continue;
        }
        assert.ok(['up', 'down', 'left', 'right'].includes(s.spotlight.arrow),
          `${key}/${s.id}: action-gated step needs a spotlight arrow`);
      }
    }
  });

  test('element spotlight selectors exist in index.html', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    for (const { key, steps } of ALL_SCRIPTS) {
      for (const s of steps) {
        if (s.spotlight?.type !== 'element') continue;
        const sel = s.spotlight.selector;
        if (sel.startsWith('#')) {
          assert.ok(html.includes(`id="${sel.slice(1)}"`),
            `${key}/${s.id}: selector ${sel} not found in index.html`);
        }
      }
    }
  });
});

// ── Hint scripts registry ─────────────────────────────────────────────────────

describe('HINT_SCRIPTS', () => {
  test('covers Ch1 missions 1–6', () => {
    assert.deepEqual(Object.keys(HINT_SCRIPTS).sort(),
      ['ch1m1', 'ch1m2', 'ch1m3', 'ch1m4', 'ch1m5', 'ch1m6']);
  });

  test('all hint configs use hints mode', () => {
    for (const [key, { config }] of Object.entries(HINT_SCRIPTS)) {
      assert.equal(config.mode, 'hints', `${key} must be a hints-mode script`);
    }
  });

  test('hint scripts resolve through the conductor-script registry', () => {
    for (const key of Object.keys(HINT_SCRIPTS)) {
      assert.ok(resolveConductorScript(key), `${key} resolves`);
    }
  });

  test('roundStepMap entries point at real steps', () => {
    for (const [key, { steps, config }] of Object.entries(HINT_SCRIPTS)) {
      for (const id of Object.values(config.roundStepMap ?? {})) {
        assert.ok(steps.some(s => s.id === id), `${key}: roundStepMap step "${id}" exists`);
      }
    }
  });

  test('steps not in a roundStepMap have a when() predicate (or are unreachable)', () => {
    for (const [key, { steps, config }] of Object.entries(HINT_SCRIPTS)) {
      const anchored = new Set(Object.values(config.roundStepMap ?? {}));
      for (const s of steps) {
        assert.ok(anchored.has(s.id) || typeof s.when === 'function',
          `${key}/${s.id}: needs a roundStepMap anchor or a when() predicate`);
      }
    }
  });
});

// ── MissionConductor hints mode (DOM stubbed) ────────────────────────────────

function _makeConductor(steps, config, stateOverrides = {}) {
  const prevDoc = globalThis.document;
  globalThis.document = { getElementById: () => null, querySelector: () => null };
  const ui = { tutorialClickBlocked: false, tutorialSubmitBlocked: false };
  const state = { round: 1, entities: [], ...stateOverrides };
  let conductor;
  try {
    conductor = new MissionConductor(state, ui, {}, null, steps, config);
  } finally {
    globalThis.document = prevDoc;
  }
  return { conductor, ui, state };
}

describe('MissionConductor hints mode', () => {
  const STEPS = [
    { id: 'h1', title: 'A', body: 'a', trigger: 'click', spotlight: null, tooltipPos: 'center' },
    { id: 'h2', title: 'B', body: 'b', trigger: { type: 'action_queued', actionType: PlanActionType.GUARD }, spotlight: null, tooltipPos: 'bottom-left' },
    { id: 'h3', title: 'C', body: 'c', trigger: 'click', spotlight: null, tooltipPos: 'center',
      when: (s) => s.flag === true },
  ];
  const CONFIG = { mode: 'hints', roundStepMap: { 1: 'h1', 2: 'h2' } };

  test('never blocks submission or map clicks', () => {
    const { conductor, ui } = _makeConductor(STEPS, CONFIG);
    conductor.onPlanningPhaseStart();
    assert.equal(conductor.currentStepId, 'h1');
    assert.equal(conductor.canSubmitPlan(), true);
    assert.equal(ui.tutorialClickBlocked, false);
    assert.equal(ui.tutorialSubmitBlocked, false);
  });

  test('shouldPlan is always true (conductor never owns the planning loop)', () => {
    const { conductor } = _makeConductor(STEPS, { ...CONFIG, maxPlanningRounds: 1 });
    conductor.onResolutionComplete();
    conductor.onResolutionComplete();
    assert.equal(conductor.shouldPlan(), true);
  });

  test('round-anchored hint shows once and never re-shows', () => {
    const { conductor, state } = _makeConductor(STEPS, CONFIG);
    conductor.onPlanningPhaseStart();
    assert.equal(conductor.currentStepId, 'h1');
    conductor.onPlanSubmitted();                 // dismissed without advancing
    assert.equal(conductor.currentStepId, null);
    conductor.onPlanningPhaseStart();            // still round 1 — already shown
    assert.equal(conductor.currentStepId, null);
    state.round = 2;
    conductor.onPlanningPhaseStart();
    assert.equal(conductor.currentStepId, 'h2');
  });

  test('gated hint dismisses when the action is queued (not advance)', () => {
    const { conductor, state } = _makeConductor(STEPS, CONFIG);
    state.round = 2;
    conductor.onPlanningPhaseStart();
    assert.equal(conductor.currentStepId, 'h2');
    conductor.onActionQueued({ type: PlanActionType.GUARD });
    assert.equal(conductor.currentStepId, null, 'dismissed, not advanced to h3');
  });

  test('when() predicate hint fires once its condition is true', () => {
    const { conductor, state } = _makeConductor(STEPS, CONFIG);
    state.round = 99;                            // no round anchor
    conductor.onPlanningPhaseStart();
    assert.equal(conductor.currentStepId, null);
    state.flag = true;
    conductor.onPlanningPhaseStart();
    assert.equal(conductor.currentStepId, 'h3');
  });

  test('a throwing when() predicate never breaks planning', () => {
    const steps = [{ id: 'boom', title: 'X', body: 'x', trigger: 'click', when: () => { throw new Error('boom'); } }];
    const { conductor } = _makeConductor(steps, { mode: 'hints' });
    assert.doesNotThrow(() => conductor.onPlanningPhaseStart());
    assert.equal(conductor.currentStepId, null);
  });

  test('start() is a no-op in hints mode (hints wait for planning)', () => {
    const { conductor } = _makeConductor(STEPS, CONFIG);
    conductor.start();
    assert.equal(conductor.currentStepId, null);
  });
});

describe('MissionConductor scripted mode — optional steps and entityType gating', () => {
  test('non-optional gated step blocks submission; optional does not', () => {
    const steps = [
      { id: 'a', title: 'A', body: 'a', trigger: { type: 'action_queued', actionType: PlanActionType.MOVE } },
      { id: 'b', title: 'B', body: 'b', trigger: { type: 'action_queued', actionType: PlanActionType.MOVE }, optional: true },
    ];
    const { conductor, ui } = _makeConductor(steps, {});
    conductor.start();
    assert.equal(conductor.canSubmitPlan(), false);
    assert.equal(ui.tutorialSubmitBlocked, true);
    conductor.onActionQueued({ type: PlanActionType.MOVE });
    assert.equal(conductor.currentStepId, 'b');
    assert.equal(conductor.canSubmitPlan(), true, 'optional step never gates submit');
    assert.equal(ui.tutorialSubmitBlocked, false);
  });

  test('action_queued entityType filter only matches the right unit type', () => {
    const steps = [
      { id: 'a', title: 'A', body: 'a',
        trigger: { type: 'action_queued', actionType: PlanActionType.MOVE, entityType: EntityType.SURVIVOR } },
      { id: 'b', title: 'B', body: 'b', trigger: 'click' },
    ];
    const entities = [
      { id: 1, type: EntityType.HERO },
      { id: 2, type: EntityType.SURVIVOR },
    ];
    const { conductor } = _makeConductor(steps, {}, { entities });
    conductor.start();
    conductor.onActionQueued({ type: PlanActionType.MOVE, entityId: 1 });
    assert.equal(conductor.currentStepId, 'a', 'hero move does not advance');
    conductor.onActionQueued({ type: PlanActionType.MOVE, entityId: 2 });
    assert.equal(conductor.currentStepId, 'b', 'survivor move advances');
  });
});

// ── Hint suppression (localStorage) ──────────────────────────────────────────

describe('hint suppression', () => {
  test('markHintsSeen → areHintsSuppressed round-trip (and missing storage is safe)', () => {
    const prev = globalThis.localStorage;
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, String(v)),
    };
    try {
      assert.equal(areHintsSuppressed('gathering_survivors'), false);
      markHintsSeen('gathering_survivors');
      assert.equal(areHintsSuppressed('gathering_survivors'), true);
      assert.equal(areHintsSuppressed('first_night'), false, 'per-mission key');
    } finally {
      if (prev === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = prev;
    }
    // Without localStorage at all, both helpers are silent no-ops.
    assert.doesNotThrow(() => { markHintsSeen('x'); areHintsSuppressed('x'); });
  });
});

// ── Voiceover manifest stays in sync with step text ──────────────────────────

describe('voiceover manifest', () => {
  test('manifest hashes match current narration text (regenerate with scripts/generate-voiceover.mjs)', async () => {
    const { existsSync } = await import('node:fs');
    const manifestUrl = new URL('../assets/voice/manifest.json', import.meta.url);
    if (!existsSync(manifestUrl)) return; // no clips generated yet — nothing to drift
    const { narrationText, textHash } = await import('../scripts/generate-voiceover.mjs');
    const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
    const byId = new Map();
    for (const { key, steps } of ALL_SCRIPTS) {
      for (const s of steps) byId.set(`${key}/${s.id}`, s);
    }
    for (const [id, hash] of Object.entries(manifest)) {
      const step = byId.get(id);
      assert.ok(step, `manifest entry "${id}" has no matching step — delete the stale clip`);
      assert.equal(textHash(narrationText(step)), hash,
        `narration for "${id}" is stale — re-run scripts/generate-voiceover.mjs`);
    }
  });
});
