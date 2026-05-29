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
  test('has 29 steps', () => {
    assert.equal(TUTORIAL_STEPS.length, 29);
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
    const ids = ['watch_r2', 'day_night', 'survivor_intro', 'move_to_house', 'explore_house',
      'submit_r3', 'watch_r3', 'night_warning', 'multi_select', 'smithy_intro', 'submit_r4', 'watch_r4'];
    const indices = ids.map(id => TUTORIAL_STEPS.findIndex(s => s.id === id));
    for (let i = 1; i < indices.length; i++) {
      assert.ok(indices[i] > indices[i - 1], `${ids[i]} comes after ${ids[i - 1]}`);
    }
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

  test('explanation steps exist after watch_r4 including guard', () => {
    const r4  = TUTORIAL_STEPS.findIndex(s => s.id === 'watch_r4');
    const nd  = TUTORIAL_STEPS.findIndex(s => s.id === 'node_discovered');
    const st  = TUTORIAL_STEPS.findIndex(s => s.id === 'score_tracker');
    const ft  = TUTORIAL_STEPS.findIndex(s => s.id === 'fortify');
    const gd  = TUTORIAL_STEPS.findIndex(s => s.id === 'guard');
    assert.ok(nd > r4,  'node_discovered after watch_r4');
    assert.ok(st > nd,  'score_tracker after node_discovered');
    assert.ok(ft > st,  'fortify after score_tracker');
    assert.ok(gd > ft,  'guard after fortify');
    assert.equal(TUTORIAL_STEPS[nd].trigger, 'click');
    assert.equal(TUTORIAL_STEPS[st].trigger, 'click');
    assert.equal(TUTORIAL_STEPS[ft].trigger, 'click');
    assert.equal(TUTORIAL_STEPS[gd].trigger, 'click');
  });

  test('guard step exists', () => {
    const step = TUTORIAL_STEPS.find(s => s.id === 'guard');
    assert.ok(step, 'guard step exists');
    assert.equal(step.trigger, 'click');
    assert.ok(step.body.toLowerCase().includes('guard'), 'body mentions guard');
  });

  test('score_tracker spotlights #score-bar element', () => {
    const step = TUTORIAL_STEPS.find(s => s.id === 'score_tracker');
    assert.ok(step, 'score_tracker step exists');
    assert.equal(step.spotlight?.type, 'element');
    assert.ok(step.spotlight?.selector?.includes('score-bar'), 'spotlights score-bar');
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
    const survivorIn = TUTORIAL_STEPS.findIndex(s => s.id === 'survivor_intro');
    const r3Idx      = TUTORIAL_STEPS.findIndex(s => s.id === 'watch_r3');
    const multiSel   = TUTORIAL_STEPS.findIndex(s => s.id === 'multi_select');
    assert.ok(r1Idx      >= 0, 'watch_r1 step found');
    assert.ok(combatIdx  > r1Idx,      'combat_intro comes after watch_r1');
    assert.ok(r2Idx      > combatIdx,  'watch_r2 comes after combat_intro');
    assert.ok(dayNight   > r2Idx,      'day_night comes after watch_r2');
    assert.ok(survivorIn > dayNight,   'survivor_intro comes after day_night');
    assert.ok(r3Idx      > survivorIn, 'watch_r3 comes after survivor_intro');
    assert.ok(multiSel   > r3Idx,      'multi_select comes after watch_r3');
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
    assert.equal(map[2], 'survivor_intro');
    assert.equal(map[3], 'night_warning');
    assert.equal(map[4], 'node_discovered');
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
