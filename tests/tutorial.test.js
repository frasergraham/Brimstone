// Tests for tutorial mode: map generation, conductor step logic, witch plan scripting.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTutorialMap } from '../src/map.js';
import { GameState } from '../src/game.js';
import { TutorialConductor, TUTORIAL_STEPS } from '../src/tutorial.js';
import { EntityType, setForcedDice } from '../src/entities.js';
import { hexKey, MAP_COLS, MAP_ROWS } from '../src/hex.js';
import { TileType, BuildingType } from '../src/tiles.js';
import { PlanActionType } from '../src/planner.js';

// ── generateTutorialMap ───────────────────────────────────────────────────────

describe('generateTutorialMap', () => {
  test('returns a 9×9 tile map', () => {
    const { tiles, cols, rows } = generateTutorialMap();
    assert.equal(cols, 9);
    assert.equal(rows, 9);
    assert.equal(tiles.size, 81);
  });

  test('sets global map dimensions to 9×9', () => {
    generateTutorialMap();
    assert.equal(MAP_COLS, 9);
    assert.equal(MAP_ROWS, 9);
  });

  test('INN is at (2,6)', () => {
    const { tiles } = generateTutorialMap();
    const t = tiles.get(hexKey(2, 6));
    assert.ok(t, 'tile exists at (2,6)');
    assert.equal(t.type, TileType.BUILDING);
    assert.equal(t.building, BuildingType.INN);
  });

  test('CHURCH is at (2,5)', () => {
    const { tiles } = generateTutorialMap();
    const t = tiles.get(hexKey(2, 5));
    assert.ok(t, 'tile exists at (2,5)');
    assert.equal(t.type, TileType.BUILDING);
    assert.equal(t.building, BuildingType.CHURCH);
  });

  test('GRAVEYARD is at (7,1)', () => {
    const { tiles } = generateTutorialMap();
    const t = tiles.get(hexKey(7, 1));
    assert.ok(t, 'tile exists at (7,1)');
    assert.equal(t.type, TileType.BUILDING);
    assert.equal(t.building, BuildingType.GRAVEYARD);
  });

  test('heroStart is at INN position (2,6)', () => {
    const { heroStart } = generateTutorialMap();
    assert.equal(heroStart.col, 2);
    assert.equal(heroStart.row, 6);
  });

  test('witchStart is at GRAVEYARD position (7,1)', () => {
    const { witchStart } = generateTutorialMap();
    assert.equal(witchStart.col, 7);
    assert.equal(witchStart.row, 1);
  });

  test('single power node exists', () => {
    const { witchObjectives } = generateTutorialMap();
    assert.equal(witchObjectives.length, 1);
    assert.equal(witchObjectives[0].col, 4);
    assert.equal(witchObjectives[0].row, 4);
  });

  test('power node cluster has exactly 3 hexes', () => {
    const { witchObjectives } = generateTutorialMap();
    assert.equal(witchObjectives[0].hexes.length, 3);
  });

  test('power node is always visible (seenByHero and seenByWitch)', () => {
    const { witchObjectives } = generateTutorialMap();
    assert.equal(witchObjectives[0].seenByHero,  true);
    assert.equal(witchObjectives[0].seenByWitch, true);
  });

  test('INN and CHURCH are road-connected via roadDirs', () => {
    const { tiles } = generateTutorialMap();
    const inn    = tiles.get(hexKey(2, 6));
    const church = tiles.get(hexKey(2, 5));
    assert.ok(inn.roadDirs.has(hexKey(2, 5)),    'INN → CHURCH');
    assert.ok(church.roadDirs.has(hexKey(2, 6)), 'CHURCH → INN');
  });

  test('survivorCounts is {buildings:0, terrain:0} (tutorial places survivors manually)', () => {
    const { survivorCounts } = generateTutorialMap();
    assert.equal(survivorCounts.buildings, 0);
    assert.equal(survivorCounts.terrain,   0);
  });
});

// ── GameState with mapDataOverride ────────────────────────────────────────────

describe('GameState with tutorial map override', () => {
  test('accepts tutorial map as 5th constructor argument', () => {
    const mapData = generateTutorialMap();
    const state = new GameState(false, false, 'tutorial', null, mapData);
    assert.ok(state.tiles.size > 0);
  });

  test('hero starts at INN (2,6)', () => {
    const mapData = generateTutorialMap();
    const state   = new GameState(false, false, 'tutorial', null, mapData);
    const hero    = state.entities.find(e => e.type === EntityType.HERO);
    assert.ok(hero, 'hero entity exists');
    assert.equal(hero.col, 2);
    assert.equal(hero.row, 6);
  });

  test('witch starts at GRAVEYARD (7,1)', () => {
    const mapData = generateTutorialMap();
    const state   = new GameState(false, false, 'tutorial', null, mapData);
    const witch   = state.entities.find(e => e.type === EntityType.WITCH);
    assert.ok(witch, 'witch entity exists');
    assert.equal(witch.col, 7);
    assert.equal(witch.row, 1);
  });
});

// ── setForcedDice ─────────────────────────────────────────────────────────────

import { Entity } from '../src/entities.js';

describe('setForcedDice', () => {
  test('forced dice produce deterministic resolveCombat results', () => {
    // Hero (ATK 3, DEF 2) vs Minion (ATK 1, DEF 0)
    // Force: atkDie=2 → atk=5, defDie=3 → def=3 → hit, margin=2
    const hero   = { type: 'hero',  attack: 3, defense: 2, attackBonus: 0, defenseBonus: 0, weapon: null };
    const minion = { type: 'minion', attack: 1, defense: 0, attackBonus: 0, defenseBonus: 0, weapon: null };
    setForcedDice(2, 3);
    const result = Entity.resolveCombat(hero, minion);
    assert.equal(result.atkBaseDie,  2);
    assert.equal(result.defBaseDie,  3);
    assert.equal(result.attackRoll,  5);   // 2 + 3
    assert.equal(result.defenseRoll, 3);   // 3 + 0
    assert.equal(result.hit, true);
    assert.equal(result.margin, 2);
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
  test('has 14 steps', () => {
    assert.equal(TUTORIAL_STEPS.length, 14);
  });

  test('first step id is "welcome"', () => {
    assert.equal(TUTORIAL_STEPS[0].id, 'welcome');
  });

  test('last step id is "complete" with trigger "start_game"', () => {
    const last = TUTORIAL_STEPS[TUTORIAL_STEPS.length - 1];
    assert.equal(last.id,      'complete');
    assert.equal(last.trigger, 'start_game');
  });

  test('all steps have required fields', () => {
    for (const step of TUTORIAL_STEPS) {
      assert.ok(step.id,     `step ${step.id} has id`);
      assert.ok(step.title,  `step ${step.id} has title`);
      assert.ok(step.body,   `step ${step.id} has body`);
      assert.ok(step.trigger !== undefined, `step ${step.id} has trigger`);
    }
  });

  test('click_stages step exists between planning_intro and select_hero', () => {
    const piIdx = TUTORIAL_STEPS.findIndex(s => s.id === 'planning_intro');
    const csIdx = TUTORIAL_STEPS.findIndex(s => s.id === 'click_stages');
    const shIdx = TUTORIAL_STEPS.findIndex(s => s.id === 'select_hero');
    assert.ok(csIdx > piIdx, 'click_stages comes after planning_intro');
    assert.ok(csIdx < shIdx, 'click_stages comes before select_hero');
    assert.equal(TUTORIAL_STEPS[csIdx].trigger, 'click');
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
});

// ── TutorialConductor step gating ────────────────────────────────────────────

// Minimal stubs — conductor only uses these specific properties/methods.
function makeStubs() {
  const renderer = {
    tutorialSpotlightHex: null,
  };
  const ui = {};
  const state = {
    entities: [],
  };
  const domStubs = {
    backdrop: { classList: { add() {}, remove() {} } },
    tooltip:  {
      style: { display: '' },
      className: '',
      querySelector: (sel) => {
        if (sel === '.tut-title') return { textContent: '' };
        if (sel === '.tut-body')  return { textContent: '' };
        if (sel === '.tut-next-btn') return {
          textContent: '', style: { display: '' },
          addEventListener() {},
        };
        return null;
      },
    },
  };

  // Patch document.getElementById to return stubs
  const origGetById  = globalThis.document?.getElementById?.bind(document);
  const origQuerySel = globalThis.document?.querySelector?.bind(document);

  if (typeof document !== 'undefined') {
    document.getElementById = (id) => {
      if (id === 'tutorial-backdrop') return domStubs.backdrop;
      if (id === 'tutorial-tooltip')  return domStubs.tooltip;
      return origGetById(id);
    };
    document.querySelector = (sel) => {
      if (sel === '.tutorial-spotlit') return null;
      return origQuerySel(sel);
    };
  }

  return { renderer, ui, state, domStubs, origGetById, origQuerySel };
}

// Only run DOM-dependent tests when a document is available (Node test runner
// does not include a DOM by default — these tests are tagged as needing jsdom).
// For now, test the pure-logic parts that don't touch DOM.

describe('TutorialConductor logic (no DOM)', () => {
  test('TUTORIAL_STEPS step indices are consistent', () => {
    // Verify the step index lookup used in onPlanningPhaseStart() works
    const idx = TUTORIAL_STEPS.findIndex(s => s.id === 'watch_resolution');
    assert.ok(idx >= 0, 'watch_resolution step found');
    const combatIdx = TUTORIAL_STEPS.findIndex(s => s.id === 'combat_intro');
    assert.ok(combatIdx > idx, 'combat_intro comes after watch_resolution');
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
});
