// Geometry, content + sightline validation for the "Learn to Play" tutorial.
//
// The scripted path (advance → fight → fortify/guard) is only playable if every
// move is reachable, every attack is in range, and the Witch's forces are hidden
// at the start. Rather than hand-derive odd-r offset coordinates and line-of-sight,
// assert them against the live engine here and adjust src/learn/learn-config.js
// until green.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GameState } from '../src/game.js';
import { EntityType, normalizeItems } from '../src/entities.js';
import { getReachableHexes, computeLineOfSight, hasLineOfSight, executeSummon } from '../src/actions.js';
import { hexDistance, hexKey } from '../src/hex.js';
import { isBuildingFootprint } from '../src/tiles.js';
import { PlanActionType } from '../src/planner.js';
import { MissionConductor } from '../src/mission-conductor.js';
import {
  buildLearnMap, placeLearnUnits, LEARN_STEPS, LEARN_CONDUCTOR_CONFIG,
  LEARN_HERO_START, LEARN_CHURCH, LEARN_BRIDGE, LEARN_SOLDIER, LEARN_ISAAC,
  LEARN_ISAAC_VANTAGE, LEARN_ZOMBIES, LEARN_WITCH_APPROACH,
  LEARN_STATS_IDS, buildLearnGameStats,
} from '../src/learn/learn-config.js';

// Build the live starting board exactly as the launcher does.
function buildBoard() {
  const map = buildLearnMap();
  const state = new GameState(false, false, 'tutorial', null, map);
  state.fogOfWar = 'partial';
  const { soldier, isaac, zombies } = placeLearnUnits(state);
  return { state, hero: state.hero, witch: state.witch, soldier, isaac, zombies };
}

const reaches = (state, actor, hex, range = 1) =>
  getReachableHexes(state, actor, range).some(h => h.col === hex.col && h.row === hex.row);

test('learn map: nobody starts on the bridge', () => {
  for (const u of [LEARN_HERO_START, LEARN_SOLDIER, LEARN_ISAAC]) {
    assert.ok(!(u.col === LEARN_BRIDGE.col && u.row === LEARN_BRIDGE.row),
      'no friendly unit may start on the bridge');
  }
});

test('learn map: the hero reaches the church in ONE move', () => {
  const { state, hero } = buildBoard();
  assert.ok(reaches(state, hero, LEARN_CHURCH, 1), 'church should be reachable in a single move');
});

test('learn units: the two townsfolk are the fixed named characters', () => {
  const { soldier, isaac } = buildBoard();
  assert.equal(soldier.name, LEARN_SOLDIER.name);
  assert.equal(isaac.name, LEARN_ISAAC.name);
  assert.ok(isaac.getEquippedWeaponId?.() === 'bow' || isaac.items?.bow, 'Isaac carries a bow');
});

test('learn map: the soldier needs TWO move actions to reach the hero\'s tile', () => {
  const { state, soldier } = buildBoard();
  assert.ok(!reaches(state, soldier, LEARN_CHURCH, 1), 'church should NOT be reachable in one move');
  assert.ok(reaches(state, soldier, LEARN_BRIDGE, 1), 'soldier reaches the bridge on the first move');
  soldier.col = LEARN_BRIDGE.col; soldier.row = LEARN_BRIDGE.row;
  assert.ok(reaches(state, soldier, LEARN_CHURCH, 1), 'soldier reaches the church on the second move');
});

test('learn map: Isaac reaches the northern clearing in one move and sees across', () => {
  const { state, isaac } = buildBoard();
  assert.ok(reaches(state, isaac, LEARN_ISAAC_VANTAGE, 1), 'Isaac reaches his vantage in one move');
  // From the vantage, clear line of sight to where the far zombie advances.
  const z2 = LEARN_ZOMBIES[1].advance;
  assert.ok(hasLineOfSight(state, LEARN_ISAAC_VANTAGE.col, LEARN_ISAAC_VANTAGE.row, z2.col, z2.row),
    'Isaac\'s vantage must see across the river to the far zombie');
});

test('learn map: the Witch\'s forces are ALL hidden at the start', () => {
  const { state, witch, zombies } = buildBoard();
  const visible = computeLineOfSight(state, 'hero');
  for (const z of zombies) {
    assert.ok(!visible.has(hexKey(z.col, z.row)), `zombie at ${z.col},${z.row} must be hidden at start`);
  }
  assert.ok(!visible.has(hexKey(witch.col, witch.row)), 'the Witch must be hidden at start');
});

test('learn map: buildings sit on a hex with an adjacent impassable footprint', () => {
  const { state } = buildBoard();
  for (const b of [LEARN_HERO_START, LEARN_CHURCH, { col: 7, row: 2 }]) {
    const t = state.tiles.get(hexKey(b.col, b.row));
    assert.ok(t?.building, `expected a building at ${b.col},${b.row}`);
    assert.ok(t.footprintHexes?.length === 1, `building at ${b.col},${b.row} needs a footprint hex`);
    const fp = state.tiles.get(t.footprintHexes[0]);
    assert.ok(isBuildingFootprint(fp), 'the footprint hex must be an impassable wall');
  }
});

test('learn map: zombies advance into combat range', () => {
  const { state, zombies } = buildBoard();
  for (let i = 0; i < zombies.length; i++) {
    assert.ok(reaches(state, zombies[i], LEARN_ZOMBIES[i].advance, 1),
      `zombie ${i} should reach its advance hex`);
  }
  const z1 = LEARN_ZOMBIES[0].advance, z2 = LEARN_ZOMBIES[1].advance;
  assert.equal(hexDistance(LEARN_CHURCH.col, LEARN_CHURCH.row, z1.col, z1.row), 1,
    'Z1 must end adjacent to the church for the hero\'s melee strike');
  assert.ok(hexDistance(LEARN_ISAAC_VANTAGE.col, LEARN_ISAAC_VANTAGE.row, z2.col, z2.row) <= 3,
    'Z2 must end within bow range of Isaac\'s vantage');
});

test('learn map: the Witch makes her two-step approach into the guard trap', () => {
  const { state, witch } = buildBoard();
  assert.ok(witch, 'a Witch leader must exist for the free-play handoff');
  assert.ok(reaches(state, witch, LEARN_WITCH_APPROACH[0], 1), 'witch reaches her round-1 emergence hex');
  witch.col = LEARN_WITCH_APPROACH[0].col; witch.row = LEARN_WITCH_APPROACH[0].row;
  assert.ok(reaches(state, witch, LEARN_WITCH_APPROACH[1], 1), 'witch reaches the guard-trap hex');
  assert.equal(hexDistance(LEARN_CHURCH.col, LEARN_CHURCH.row, LEARN_WITCH_APPROACH[1].col, LEARN_WITCH_APPROACH[1].row), 1,
    'the witch\'s final hex must be adjacent to the church so the guard fires');
});

test('learn steps: action-gated steps carry a spotlight arrow and a click allowlist', () => {
  const ACTION_GATED = new Set(['action_queued', 'entity_selected']);
  for (const step of LEARN_STEPS) {
    assert.ok(step.id && step.title && step.body, `step ${step.id} needs id/title/body`);
    assert.ok(!/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(step.title + step.body),
      `step ${step.id} must not contain color emoji`);
    const t = step.trigger;
    if (t && typeof t === 'object' && ACTION_GATED.has(t.type)) {
      assert.ok(step.spotlight, `gated step ${step.id} needs a spotlight`);
      assert.ok(step.spotlight.arrow, `gated step ${step.id} needs a directional arrow`);
      assert.ok(Array.isArray(step.allowHexes), `gated step ${step.id} needs an allowHexes list`);
    }
  }
});

test('learn steps: copy refers to the hero/leader and Isaac, never "Paladin" or "Chapel"', () => {
  for (const step of LEARN_STEPS) {
    const text = `${step.title} ${step.body}`;
    assert.ok(!/paladin/i.test(text), `step ${step.id} must not say "Paladin"`);
    assert.ok(!/chapel/i.test(text), `step ${step.id} must say "church", not "chapel"`);
  }
});

test('learn config: scripted MOVE plans use toCol/toRow (resolver field), so the enemy actually moves', () => {
  const { state, zombies } = buildBoard();
  const provider = LEARN_CONDUCTOR_CONFIG.witchPlanProvider;
  // Round 0: both zombies advance to their advance hexes.
  const r0 = provider(0, state);
  assert.equal(r0.length, zombies.length, 'round 0 should move every zombie');
  for (const a of r0) {
    assert.equal(a.type, 'move');
    assert.ok(Number.isInteger(a.toCol) && Number.isInteger(a.toRow), 'MOVE must carry toCol/toRow');
    assert.equal(a.targetCol, undefined, 'MOVE must NOT use targetCol (that is for BATTLE)');
  }
  const dests = r0.map(a => `${a.toCol},${a.toRow}`).sort();
  assert.deepEqual(dests, LEARN_ZOMBIES.map(z => `${z.advance.col},${z.advance.row}`).sort());
  // Round 2: the witch advances (MOVE toCol/toRow) and strikes (BATTLE targetCol/targetRow).
  state.hero.col = LEARN_CHURCH.col; state.hero.row = LEARN_CHURCH.row;
  const r2 = provider(2, state);
  const move = r2.find(a => a.type === 'move');
  assert.ok(move && Number.isInteger(move.toCol), 'witch MOVE must carry toCol');
  const battle = r2.find(a => a.type === 'battle-unit');
  assert.ok(battle && Number.isInteger(battle.targetCol), 'witch BATTLE must carry targetCol');
});

// ── One click per step: the pulse must sit on the hex the player clicks NEXT ──
// Regression: the soldier's two-move crossing used to be a single step that
// spotlit the END hex (the church) — players clicked the pulse and nothing
// happened, because the first click had to be the bridge.

test('learn steps: every MOVE step\'s spotlight sits on its trigger destination', () => {
  for (const step of LEARN_STEPS) {
    const t = step.trigger;
    if (t?.type !== 'action_queued' || t.actionType !== PlanActionType.MOVE) continue;
    assert.equal(step.spotlight.col, t.toCol,
      `${step.id}: the pulsing spotlight must mark the hex that completes the step`);
    assert.equal(step.spotlight.row, t.toRow,
      `${step.id}: the pulsing spotlight must mark the hex that completes the step`);
  }
});

test('learn steps: every MOVE step\'s destination is ONE move from the unit\'s scripted position', () => {
  const { state, hero, soldier, isaac } = buildBoard();
  // Scripted position of each mover when its step begins.
  const moverAt = {
    move_hero:      hero,
    move_soldier:   soldier,
    move_soldier_2: Object.assign(Object.create(Object.getPrototypeOf(soldier)),
      soldier, { col: LEARN_BRIDGE.col, row: LEARN_BRIDGE.row }),
    move_isaac:     isaac,
  };
  for (const [id, mover] of Object.entries(moverAt)) {
    const step = LEARN_STEPS.find(s => s.id === id);
    assert.ok(step, `step ${id} exists`);
    assert.ok(reaches(state, mover, { col: step.trigger.toCol, row: step.trigger.toRow }, 1),
      `${id}: one click on the spotlit hex must queue the move (single-move reach)`);
  }
});

test('learn steps: the soldier crossing is split into two one-move legs', () => {
  const leg1 = LEARN_STEPS.find(s => s.id === 'move_soldier');
  const leg2 = LEARN_STEPS.find(s => s.id === 'move_soldier_2');
  assert.ok(leg1 && leg2, 'both legs exist');
  assert.deepEqual({ col: leg1.trigger.toCol, row: leg1.trigger.toRow }, LEARN_BRIDGE,
    'leg 1 gates on reaching the bridge');
  assert.deepEqual({ col: leg2.trigger.toCol, row: leg2.trigger.toRow }, LEARN_CHURCH,
    'leg 2 gates on reaching the church');
  assert.equal(leg2.keepSelection, true,
    'leg 2 must keep Thomas selected so the second click chains his move');
  assert.ok(!leg1.allowHexes.some(h => h.col === LEARN_CHURCH.col && h.row === LEARN_CHURCH.row),
    'leg 1 must NOT allow clicking the church — that click selects the hero\'s ghost instead');
  assert.ok(leg2.allowHexes.some(h => h.col === LEARN_BRIDGE.col && h.row === LEARN_BRIDGE.row),
    'leg 2 must allow the bridge so Thomas can be re-selected at his ghost if deselected');
});

test('learn steps: unit-gated steps restrict which unit types are selectable', () => {
  const expect = {
    move_hero:      [EntityType.HERO],
    move_soldier:   [EntityType.SURVIVOR],
    move_soldier_2: [EntityType.SURVIVOR],
    move_isaac:     [EntityType.SURVIVOR],
    combat_intro:   [EntityType.HERO],
    fortify_intro:  [EntityType.HERO],
    guard_intro:    [EntityType.SURVIVOR],
  };
  for (const [id, types] of Object.entries(expect)) {
    const step = LEARN_STEPS.find(s => s.id === id);
    assert.deepEqual(step.allowUnits, types, `${id} allowUnits`);
  }
});

test('learn steps: fortify gates on the HERO and guard on the SURVIVOR queuing it', () => {
  assert.equal(LEARN_STEPS.find(s => s.id === 'fortify_intro').trigger.entityType, EntityType.HERO);
  assert.equal(LEARN_STEPS.find(s => s.id === 'guard_intro').trigger.entityType, EntityType.SURVIVOR);
});

test('learn steps: the combat step requires stacking TWO attacks before advancing', () => {
  const combat = LEARN_STEPS.find(s => s.id === 'combat_intro');
  assert.equal(combat.trigger.count, 2, 'combat_intro must gate on two attacks so the player can stack');
});

test('learn steps: combat restricts the disambiguation pick to the hero', () => {
  const combat = LEARN_STEPS.find(s => s.id === 'combat_intro');
  assert.ok(Array.isArray(combat.allowUnits) && combat.allowUnits.includes(EntityType.HERO),
    'combat_intro must only allow picking the hero from the shared hex');
});

test('learn steps: each Submit step locks the map (no stray actions while awaiting Submit)', () => {
  for (const s of LEARN_STEPS) {
    if (s.trigger?.type === 'plan_submitted') {
      assert.deepEqual(s.allowHexes, [], `submit step ${s.id} must lock the map with allowHexes: []`);
    }
  }
});

// ── Mission stats: Learn to Play reports as an explicit mission ───────────────

test('learn stats: payload carries the exact campaign_game_stats schema', () => {
  const { state } = buildBoard();
  state.winner = 'hero';
  const stats = buildLearnGameStats(state, { id: 'row-1', version: '9.9.9', durationMs: 1234 });
  // Field-for-field the columns of the campaign_game_stats insert
  // (server/db/sqlite/campaign-stats.js) — a drifted key silently drops data.
  assert.deepEqual(Object.keys(stats).sort(), [
    'id', 'campaign_id', 'mission_id', 'mission_title',
    'winner', 'win_reason', 'rounds', 'final_phase',
    'hero_kills', 'witch_kills',
    'survivors_deployed', 'survivors_lost', 'enemies_spawned',
    'has_witch', 'ai_personality', 'map_size',
    'game_version', 'duration_ms',
  ].sort());
});

test('learn stats: reports the synthetic learn mission with real board counts', () => {
  const { state, soldier, zombies } = buildBoard();
  state.winner = 'witch';
  state.winReason = 'The hero has fallen.';
  state.heroKills = 2;
  state.witchKills = 1;
  soldier.hp = 0;   // Thomas fell (alive is derived from hp)
  const stats = buildLearnGameStats(state, { id: 'row-2', version: '1.11.0', durationMs: 60000 });

  assert.equal(stats.campaign_id,   LEARN_STATS_IDS.campaignId);
  assert.equal(stats.mission_id,    LEARN_STATS_IDS.missionId);
  assert.equal(stats.mission_title, 'Learn to Play');
  assert.equal(stats.winner, 'witch');
  assert.equal(stats.win_reason, 'The hero has fallen.');
  assert.equal(stats.hero_kills, 2);
  assert.equal(stats.witch_kills, 1);
  assert.equal(stats.survivors_deployed, 2, 'Thomas + Isaac');
  assert.equal(stats.survivors_lost, 1, 'dead survivors still count as deployed');
  assert.equal(stats.enemies_spawned, zombies.length + 1, 'two zombies + the Witch');
  assert.equal(stats.has_witch, 1);
  assert.equal(stats.map_size, 'tutorial');
  assert.equal(stats.game_version, '1.11.0');
  assert.equal(stats.duration_ms, 60000);
});

test('learn handoff: state.maxWitchSummons hard-caps the witch\'s total summons', () => {
  const { state, witch } = buildBoard();
  state.inventory.witch = normalizeItems({ wood: 20, metal: 20 }); // plenty of fuel
  state.maxWitchSummons = 2;
  let summoned = 0;
  for (let i = 0; i < 6; i++) { if (executeSummon(state, witch).success) summoned++; }
  assert.equal(summoned, 2, 'the witch must be capped at exactly maxWitchSummons summons');
  // No cap (the default everywhere else) leaves summoning unrestricted.
  const { state: s2, witch: w2 } = buildBoard();
  s2.inventory.witch = normalizeItems({ wood: 20, metal: 20 });
  assert.ok(executeSummon(s2, w2).success, 'with no cap set, the witch can still summon');
});

// ── Conductor behavior: chained two-leg move + scripted plan lock ─────────────
// DOM-free conductor harness (same pattern as tests/tutorial.test.js).

function _makeLearnConductor() {
  const prevDoc = globalThis.document;
  globalThis.document = { getElementById: () => null, querySelector: () => null };
  const ui = {
    tutorialClickBlocked: false, tutorialSubmitBlocked: false,
    tutorialPlanLocked: false, _tutorialSuppressReselect: false,
    clearSelectionCalls: 0,
    _clearSelection() { this.clearSelectionCalls++; },
  };
  const state = { round: 1, entities: [
    { id: 'h1', type: EntityType.HERO },
    { id: 's1', type: EntityType.SURVIVOR },
  ] };
  let conductor;
  try {
    conductor = new MissionConductor(state, ui, {}, null, LEARN_STEPS, LEARN_CONDUCTOR_CONFIG);
  } finally {
    globalThis.document = prevDoc;
  }
  return { conductor, ui, state };
}

test('conductor: a keepSelection follow-up chains the two-leg move without dropping the unit', () => {
  const { conductor, ui } = _makeLearnConductor();
  const legIdx = LEARN_STEPS.findIndex(s => s.id === 'move_soldier');
  conductor._showStep(legIdx);
  assert.equal(conductor.currentStepId, 'move_soldier');

  // Leg 1 completes: the follow-up step keeps the selection, so the conductor
  // must NOT suppress the UI's chaining re-select and must NOT clear selection.
  const clearsBefore = ui.clearSelectionCalls;
  conductor.onActionQueued({
    type: PlanActionType.MOVE, entityId: 's1',
    toCol: LEARN_BRIDGE.col, toRow: LEARN_BRIDGE.row,
  });
  assert.equal(conductor.currentStepId, 'move_soldier_2', 'leg 1 advances to leg 2');
  assert.equal(ui._tutorialSuppressReselect, false,
    'keepSelection follow-up must not suppress the post-move re-select');
  assert.equal(ui.clearSelectionCalls, clearsBefore,
    'entering a keepSelection step must not clear the selection');

  // Leg 2 completes: the next step (move_isaac) switches units — the normal
  // suppress + clear behavior applies again.
  conductor.onActionQueued({
    type: PlanActionType.MOVE, entityId: 's1',
    toCol: LEARN_CHURCH.col, toRow: LEARN_CHURCH.row,
  });
  assert.equal(conductor.currentStepId, 'move_isaac', 'leg 2 advances to Isaac');
  assert.equal(ui._tutorialSuppressReselect, true,
    'a normal follow-up suppresses the chaining re-select');
  assert.ok(ui.clearSelectionCalls > clearsBefore,
    'entering a normal gated step clears the lingering selection');
});

test('conductor: a mid-step MOVE to the wrong hex does not advance (destination filter)', () => {
  const { conductor } = _makeLearnConductor();
  conductor._showStep(LEARN_STEPS.findIndex(s => s.id === 'move_soldier'));
  conductor.onActionQueued({
    type: PlanActionType.MOVE, entityId: 's1',
    toCol: LEARN_CHURCH.col, toRow: LEARN_CHURCH.row,   // not the bridge
  });
  assert.equal(conductor.currentStepId, 'move_soldier', 'stays on leg 1');
});

test('learn steps: the modes dialog pulses a red outline on the Action Budget', () => {
  const step = LEARN_STEPS.find(s => s.id === 'modes');
  assert.equal(step.spotlight?.type, 'element', 'modes spotlights a UI element');
  assert.ok(step.spotlight.selector.includes('action-budget'),
    'the spotlight targets the Action Budget chip');
  assert.equal(step.pulse, true, 'pulse:true on an element target = pulsing red outline');
});

test('learn steps: node copy describes hex-majority control, not unit counts', () => {
  const step = LEARN_STEPS.find(s => s.id === 'node_intro');
  assert.ok(!/most units/i.test(step.body),
    'control is by occupied HEXES (stacked units count once), not unit count');
  assert.ok(/hex/i.test(step.body), 'the copy explains hex occupation');
});

// ── Select-then-target spotlight: unit first, destination once selected ───────

test('conductor: unit-gated move/attack steps use the select-then-target spotlight', () => {
  const { conductor } = _makeLearnConductor();
  for (const id of ['move_hero', 'move_soldier', 'move_soldier_2', 'move_isaac', 'combat_intro', 'ranged']) {
    const step = LEARN_STEPS.find(s => s.id === id);
    assert.ok(conductor._isSelectThenTarget(step), `${id} qualifies`);
  }
  for (const id of ['fortify_intro', 'guard_intro', 'submit_r0', 'welcome']) {
    const step = LEARN_STEPS.find(s => s.id === id);
    assert.ok(!conductor._isSelectThenTarget(step),
      `${id} keeps a static spotlight (single-hex flow or dialog)`);
  }
});

test('conductor: the spotlight anchors on the unit until it is selected, then the destination', () => {
  const prevDoc = globalThis.document;
  globalThis.document = { getElementById: () => null, querySelector: () => null };
  const hero = { id: 'h1', type: EntityType.HERO, alive: true, col: LEARN_HERO_START.col, row: LEARN_HERO_START.row };
  const ui = {
    tutorialClickBlocked: false, tutorialSubmitBlocked: false,
    _selectedEntity: null,
    _tutorialCanSelect: () => true,
    _clearSelection() {},
  };
  const state = { round: 1, entities: [hero] };
  let conductor;
  try {
    conductor = new MissionConductor(state, ui, {}, null, LEARN_STEPS, LEARN_CONDUCTOR_CONFIG);
  } finally {
    globalThis.document = prevDoc;
  }
  const step = LEARN_STEPS.find(s => s.id === 'move_hero');

  // Nothing selected → anchor on Ishmael's hex (the first click).
  assert.deepEqual(conductor._selectThenTargetPos(step), { col: LEARN_HERO_START.col, row: LEARN_HERO_START.row });
  // Wrong selection (e.g. an enemy inspected) → still the unit.
  ui._selectedEntity = { id: 'z9', type: EntityType.ZOMBIE };
  assert.deepEqual(conductor._selectThenTargetPos(step), { col: LEARN_HERO_START.col, row: LEARN_HERO_START.row });
  // The gated unit selected → anchor moves to the destination (the second click).
  ui._selectedEntity = hero;
  assert.deepEqual(conductor._selectThenTargetPos(step), { col: LEARN_CHURCH.col, row: LEARN_CHURCH.row });
  // Deselect → self-heals back to the unit.
  ui._selectedEntity = null;
  assert.deepEqual(conductor._selectThenTargetPos(step), { col: LEARN_HERO_START.col, row: LEARN_HERO_START.row });
});

test('conductor: the unit anchor uses the GHOST position for a mid-plan unit', () => {
  const prevDoc = globalThis.document;
  globalThis.document = { getElementById: () => null, querySelector: () => null };
  const thomas = { id: 's1', type: EntityType.SURVIVOR, alive: true, col: LEARN_SOLDIER.col, row: LEARN_SOLDIER.row };
  const ui = {
    tutorialClickBlocked: false, tutorialSubmitBlocked: false,
    _selectedEntity: null,
    _planMode: true,
    _tutorialCanSelect: () => true,
    _getProjectedPos: (id) => (id === 's1' ? { col: LEARN_BRIDGE.col, row: LEARN_BRIDGE.row } : null),
    _clearSelection() {},
  };
  const state = { round: 1, entities: [thomas] };
  let conductor;
  try {
    conductor = new MissionConductor(state, ui, {}, null, LEARN_STEPS, LEARN_CONDUCTOR_CONFIG);
  } finally {
    globalThis.document = prevDoc;
  }
  // Leg 2 with Thomas deselected: the anchor is his ghost on the BRIDGE (where
  // the player sees him), not his real start hex.
  const step = LEARN_STEPS.find(s => s.id === 'move_soldier_2');
  assert.deepEqual(conductor._selectThenTargetPos(step), { col: LEARN_BRIDGE.col, row: LEARN_BRIDGE.row });
});

test('conductor: a gated hex step reframes the camera when a click target is not clickable', () => {
  const prevDoc = globalThis.document;
  globalThis.document = { getElementById: () => null, querySelector: () => null };
  const mkUi = () => ({ tutorialClickBlocked: false, tutorialSubmitBlocked: false, _clearSelection() {} });
  const idx = LEARN_STEPS.findIndex(s => s.id === 'move_isaac');
  const rectStub = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 }) };
  try {
    // A target under the plan panel (x beyond right-inset) → reframe with the
    // destination AND the unit's own hex, so the whole interaction is visible.
    const framed = [];
    const offView = {
      frameHexes: (hexes, opts) => framed.push({ hexes, opts }),
      getHexScreenPosition: () => ({ x: 1150, y: 300 }),   // 1280 - inset 220 = 1060 clickable edge
      canvas: rectStub, insetRight: 220,
    };
    let conductor = new MissionConductor({ round: 1, entities: [] }, mkUi(), offView, null, LEARN_STEPS, LEARN_CONDUCTOR_CONFIG);
    conductor._showStep(idx);
    assert.equal(framed.length, 1, 'an unclickable target triggers a reframe');
    const keys = framed[0].hexes.map(h => `${h.col},${h.row}`);
    assert.ok(keys.includes(`${LEARN_ISAAC_VANTAGE.col},${LEARN_ISAAC_VANTAGE.row}`), 'destination framed');
    assert.ok(keys.includes(`${LEARN_ISAAC.col},${LEARN_ISAAC.row}`), 'the unit to click is framed too');

    // Everything already comfortably clickable → the camera is left alone.
    const framed2 = [];
    const onView = {
      frameHexes: (hexes) => framed2.push(hexes),
      getHexScreenPosition: () => ({ x: 500, y: 300 }),
      canvas: rectStub, insetRight: 220,
    };
    conductor = new MissionConductor({ round: 1, entities: [] }, mkUi(), onView, null, LEARN_STEPS, LEARN_CONDUCTOR_CONFIG);
    conductor._showStep(idx);
    assert.equal(framed2.length, 0, 'no surprise camera jump when targets are already visible');
  } finally {
    globalThis.document = prevDoc;
  }
});

test('conductor: an element spotlight with pulse applies the red outline class', () => {
  const classes = new Set();
  const budgetEl = { classList: {
    add: (...cs) => cs.forEach(c => classes.add(c)),
    remove: (...cs) => cs.forEach(c => classes.delete(c)),
  } };
  const prevDoc = globalThis.document;
  globalThis.document = {
    getElementById: () => null,
    querySelector: (sel) => (sel.includes('action-budget') ? budgetEl : null),
  };
  const ui = { tutorialClickBlocked: false, tutorialSubmitBlocked: false, _clearSelection() {} };
  let conductor;
  try {
    conductor = new MissionConductor({ round: 1, entities: [] }, ui, {}, null, LEARN_STEPS, LEARN_CONDUCTOR_CONFIG);
    conductor._showStep(LEARN_STEPS.findIndex(s => s.id === 'modes'));
    assert.ok(classes.has('tutorial-spotlit-red'), 'pulse element target gets the red outline');
    assert.ok(!classes.has('tutorial-spotlit'), 'not the gold glow');
    conductor.destroy();
    assert.equal(classes.size, 0, 'destroy() removes the outline class');
  } finally {
    globalThis.document = prevDoc;
  }
});

test('conductor: scripted mode locks plan editing; destroy() unlocks it', () => {
  const { conductor, ui } = _makeLearnConductor();
  assert.equal(ui.tutorialPlanLocked, true,
    'scripted conductor must lock undo/remove/clear plan editing');
  const prevDoc = globalThis.document;
  globalThis.document = { getElementById: () => null, querySelector: () => null };
  try { conductor.destroy(); } finally { globalThis.document = prevDoc; }
  assert.equal(ui.tutorialPlanLocked, false, 'handoff restores plan editing');
});

test('learn config: round-step map points at real steps and ends in a handoff', () => {
  const ids = new Set(LEARN_STEPS.map(s => s.id));
  for (const id of Object.values(LEARN_CONDUCTOR_CONFIG.roundStepMap)) {
    assert.ok(ids.has(id), `roundStepMap references unknown step ${id}`);
  }
  assert.ok(LEARN_STEPS.some(s => s.trigger === 'handoff'), 'a handoff step must release control to free play');
  assert.equal(LEARN_CONDUCTOR_CONFIG.maxPlanningRounds, 3);
});
