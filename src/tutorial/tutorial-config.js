// ═══════════════════════════════════════════════════════════════════════════
// Tutorial / Prologue Configuration
// Self-contained tutorial definition used by the Prologue campaign.
// Contains the tutorial map builder, step definitions, wave config,
// forced dice settings, and MissionConductor config.
// ═══════════════════════════════════════════════════════════════════════════

import { Tile, TileType, BuildingType, ResourceType, decomposeTileType, legacyTileType } from '../tiles.js';
import { hexKey, setMapDimensions } from '../hex.js';
import { NODE_COLORS } from '../map.js';
import { PlanActionType } from '../planner.js';
import { EntityType } from '../entities.js';

// ── Map helpers (same pattern as campaign map builders) ───────────────────

function makeTiles(cols, rows) {
  const tiles = new Map();
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      tiles.set(hexKey(col, row), new Tile(col, row, TileType.GRASS));
    }
  }
  return tiles;
}

function setBuilding(tiles, col, row, building, fortLevel = 0) {
  const t = tiles.get(hexKey(col, row));
  if (t) { decomposeTileType(t, TileType.BUILDING); t.building = building; t.fortifyLevel = fortLevel; }
}

function setForest(tiles, hexes) {
  for (const { col, row } of hexes) {
    const t = tiles.get(hexKey(col, row));
    if (t && legacyTileType(t) === TileType.GRASS) decomposeTileType(t, TileType.FOREST);
  }
}

function addRoad(tiles, from, to) {
  const a = tiles.get(hexKey(from.col, from.row));
  const b = tiles.get(hexKey(to.col, to.row));
  if (a) a.roadDirs.add(hexKey(to.col, to.row));
  if (b) b.roadDirs.add(hexKey(from.col, from.row));
}

function setResource(tiles, col, row, resource) {
  const t = tiles.get(hexKey(col, row));
  if (t) t.resource = resource;
}

function setHiddenSurvivor(tiles, col, row) {
  const t = tiles.get(hexKey(col, row));
  if (t) t.hiddenSurvivor = true;
}

// ── Tutorial map builder ──────────────────────────────────────────────────
//
// 9×9 grid with more buildings and roads than the old tutorial map.
// No witch — tutorial uses noWitch flag.
//
// Layout:
//   Hero start: INN at (2,7)
//   Church at (2,5) — 2 hexes north of INN, connected by road
//   House at (2,3) — north of church, contains hidden survivor
//   Blacksmith at (5,5), Barn at (6,3) — across the map with roads
//   Graveyard at (7,2) — atmospheric, no witch spawn
//
// Road network connects buildings for visual interest and teaching road movement.
// Minion spawns adjacent to Church after round 1 via wave system.

export function buildTutorialMap() {
  const COLS = 9, ROWS = 9;
  setMapDimensions(COLS, ROWS);
  const tiles = makeTiles(COLS, ROWS);

  // ── Buildings ────────────────────────────────────────────────────────────
  setBuilding(tiles, 2, 7, BuildingType.INN, 1);
  setBuilding(tiles, 2, 5, BuildingType.CHURCH, 1);
  setBuilding(tiles, 2, 3, BuildingType.HOUSE, 1);
  setBuilding(tiles, 5, 5, BuildingType.BLACKSMITH, 0);
  setBuilding(tiles, 6, 3, BuildingType.BARN, 0);
  setBuilding(tiles, 7, 2, BuildingType.GRAVEYARD, 1);

  // ── Road network ─────────────────────────────────────────────────────────
  // INN (2,7) → road (2,6) → Church (2,5)
  addRoad(tiles, { col: 2, row: 7 }, { col: 2, row: 6 });
  addRoad(tiles, { col: 2, row: 6 }, { col: 2, row: 5 });

  // Church (2,5) → road (2,4) → House (2,3)
  addRoad(tiles, { col: 2, row: 5 }, { col: 2, row: 4 });
  addRoad(tiles, { col: 2, row: 4 }, { col: 2, row: 3 });

  // Church (2,5) → road (3,5) → road (4,5) → Blacksmith (5,5)
  addRoad(tiles, { col: 2, row: 5 }, { col: 3, row: 5 });
  addRoad(tiles, { col: 3, row: 5 }, { col: 4, row: 5 });
  addRoad(tiles, { col: 4, row: 5 }, { col: 5, row: 5 });

  // Blacksmith (5,5) → road (6,4) → Barn (6,3)
  addRoad(tiles, { col: 5, row: 5 }, { col: 6, row: 4 });
  addRoad(tiles, { col: 6, row: 4 }, { col: 6, row: 3 });

  // Make road-only tiles into ROAD type
  for (const rc of [
    { col: 2, row: 6 }, { col: 2, row: 4 },
    { col: 3, row: 5 }, { col: 4, row: 5 },
    { col: 6, row: 4 },
  ]) {
    const t = tiles.get(hexKey(rc.col, rc.row));
    if (t && legacyTileType(t) === TileType.GRASS) decomposeTileType(t, TileType.ROAD);
  }

  // ── Forest clusters ──────────────────────────────────────────────────────
  setForest(tiles, [
    { col: 0, row: 2 }, { col: 1, row: 2 },
    { col: 7, row: 1 }, { col: 8, row: 1 }, { col: 8, row: 2 },
  ]);

  // ── Resources ────────────────────────────────────────────────────────────
  setResource(tiles, 1, 5, ResourceType.HERBS);
  setResource(tiles, 5, 3, ResourceType.WOOD);

  // ── Power Node — cluster at (7,5),(7,4),(8,5) ───────────────────────────
  // East of Blacksmith. Hidden initially — only within hero's sight range
  // once they reach the Blacksmith (5,5) in round 4 (DAY sight = 3).
  const witchObjectives = [
    {
      col: 7, row: 5,
      label: 'The Crossroads',
      hexes: [{ col: 7, row: 5 }, { col: 7, row: 4 }, { col: 8, row: 5 }],
      color: NODE_COLORS[0],
      seenByHero:  false,
      seenByWitch: true,
      prevCtrl: 'neutral',
    },
  ];

  return {
    tiles,
    witchObjectives,
    heroStart:      { col: 2, row: 7 },
    witchStart:     { col: 7, row: 2 },   // graveyard position (unused — noWitch)
    mapSize:        'tutorial',
    survivorCounts: { buildings: 0, terrain: 0 },
    cols: COLS,
    rows: ROWS,
    noWitch:        true,
  };
}

// ── Wave config — minion spawns adjacent to hero after round 1 ────────────
// state.round starts at 1 and endRound() increments it, so after the first
// resolution state.round === 2. processWaves checks wave.round === state.round.

export const TUTORIAL_WAVES = [
  {
    round: 2,
    units: [{ type: 'minion', spawnAt: { col: 3, row: 5 } }],
  },
];

// ── Forced dice config — hero crushes the minion in round 2 ───────────────
// Hero ATK=3, Minion DEF=0: die=6 → atk=9, die=1 → def=1 → 9 >= 2×1 = crush (2 dmg)
// Minion HP=2, dies instantly. No counter-attack.

export const TUTORIAL_FORCED_DICE = [6, 1];

// ── Tutorial step definitions ─────────────────────────────────────────────
//
// Each step has:
//   id          — unique string identifier
//   title       — tooltip heading
//   body        — tooltip explanation (may contain \n for line breaks).
//                 Keep it SHORT: ≤2 sentences or ≤3 bullets — a concept is
//                 taught by doing it, not by reading about it (lint-enforced
//                 in tests/tutorial.test.js).
//   trigger     — what advances the step:
//                   'click'        → "Got it →" button
//                   'auto'         → advances automatically via onPlanningPhaseStart
//                   'complete'     → final step button (label from buttonLabel field)
//                   { type: 'entity_selected', entityType }
//                   { type: 'action_queued',   actionType, entityType? }
//                   { type: 'plan_submitted' }
//   spotlight   — what to highlight:
//                   null
//                   { type: 'hex',     col, row, arrow? }
//                   { type: 'element', selector, arrow? }
//                 `arrow` ('up'|'down'|'left'|'right') is the direction the
//                 arrow POINTS — it sits opposite, aimed at the target. Every
//                 action-gated step must carry one (lint-enforced).
//   tooltipPos  — 'center' | 'bottom-left' | 'bottom-right'. Blocking dialogs
//                 ('click'/'complete') are forced to center by the conductor.
//   buttonLabel — custom button text for 'complete' trigger steps
//   witchPlan   — scripted witch plan for this round (null = N/A)

export const TUTORIAL_STEPS = [
  // ── Intro ──────────────────────────────────────────────────────────────────

  {
    id: 'welcome',
    title: 'The Road to Caleb\'s Hollow',
    body: 'Shadows stir in the forest — something is not right. You play as the ⚔ Hero; let\'s learn by doing.',
    trigger: 'click',
    spotlight: null,
    tooltipPos: 'center',
    witchPlan: null,
  },
  {
    id: 'planning_intro',
    title: 'Simultaneous Planning',
    body: 'Each round both sides secretly queue a plan of actions, then everything resolves at once. Nobody reacts — prediction wins battles.',
    trigger: 'click',
    spotlight: null,
    tooltipPos: 'center',
    witchPlan: null,
  },
  {
    id: 'unit_selection',
    title: 'Unit Selection',
    body: 'Click a unit to select it; click it again to open its action menu. Clicking elsewhere deselects.',
    trigger: 'click',
    spotlight: null,
    tooltipPos: 'center',
    witchPlan: null,
  },

  // ── Round 1: Move to Church + Explore ─────────────────────────────────────

  {
    id: 'select_hero',
    title: 'Select Your Hero',
    body: 'Click your ⚔ Hero on the map.',
    trigger: { type: 'entity_selected', entityType: EntityType.HERO },
    spotlight: { type: 'hex', col: 2, row: 7, arrow: 'down' },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'queue_move',
    title: 'Queue a Move',
    body: 'Green hexes are in reach — click the Church to the north to queue a Move. The road is why you reach it in one action.',
    trigger: { type: 'action_queued', actionType: PlanActionType.MOVE },
    spotlight: { type: 'hex', col: 2, row: 5, arrow: 'down' },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'action_budget',
    title: 'Action Budget',
    body: 'Every action a unit takes spends one point from your side\'s shared budget — the badge tracks what\'s left this round.',
    trigger: 'click',
    spotlight: { type: 'element', selector: '#plan-budget-badge', arrow: 'right' },
    tooltipPos: 'center',
    witchPlan: null,
  },
  {
    id: 'queue_explore',
    title: 'Explore a Building',
    body: 'The ghost at the Church is where your hero will be after moving. Click the ghost and choose Explore to search the Church.',
    trigger: { type: 'action_queued', actionType: PlanActionType.EXPLORE },
    spotlight: { type: 'hex', col: 2, row: 5, arrow: 'down' },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'submit_plan',
    title: 'Submit Your Plan',
    body: 'Move, then Explore — your plan is ready. Click Submit.',
    trigger: { type: 'plan_submitted' },
    spotlight: { type: 'element', selector: '#plan-submit-btn', arrow: 'right' },
    tooltipPos: 'bottom-left',
    witchPlan: [], // witch idles in round 1; minion spawns via wave after resolution
  },
  {
    id: 'watch_r1',
    title: 'Resolution',
    body: 'Watch both sides act at once.',
    trigger: 'auto',
    spotlight: null,
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },

  // ── Round 2: Combat (onPlanningPhaseStart jumps here when _round === 1) ───

  {
    id: 'combat_intro',
    title: 'A Minion Blocks the Road!',
    body: 'A witch\'s minion has emerged from the tree line. Select your ⚔ Hero, then click the enemy to attack it.',
    trigger: { type: 'action_queued', actionType: PlanActionType.BATTLE_UNIT },
    spotlight: { type: 'hex', col: 3, row: 5, arrow: 'down' },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'combat_formula',
    title: 'How Combat Works',
    body: 'Both sides roll dice.\n\n• Hit — your roll wins: the enemy is wounded\n• Crush — far higher: a grievous wound\n• Counter — they roll strong: you bleed instead\n\nAllies beside the target join your attack — never fight outnumbered.',
    trigger: 'click',
    spotlight: null,
    tooltipPos: 'center',
    witchPlan: null,
  },
  {
    id: 'submit_fight',
    title: 'Submit and Fight!',
    body: 'Submit your plan and watch the dice.',
    trigger: { type: 'plan_submitted' },
    spotlight: { type: 'element', selector: '#plan-submit-btn', arrow: 'right' },
    tooltipPos: 'bottom-left',
    witchPlan: null, // set dynamically by getWitchPlan() for round 2
  },
  {
    id: 'watch_r2',
    title: 'Combat Resolved',
    body: 'A crushing blow — the minion is slain!',
    trigger: 'auto',
    spotlight: null,
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'day_night',
    title: 'Day / Night Cycle',
    body: 'The badge shows the 8-round cycle: 🌅 Dawn → ☀ Day → 🌇 Dusk → 🌙 Night. Enemies grow stronger at night; Dawn and Dusk are scoring checkpoints.',
    trigger: 'click',
    spotlight: { type: 'element', selector: '#cycle-bump', arrow: 'down' },
    tooltipPos: 'center',
    witchPlan: null,
  },

  // ── Round 3: Survivor rescue (onPlanningPhaseStart jumps here when _round === 2) ──

  {
    id: 'move_to_house',
    title: 'Find Allies',
    body: 'Someone is hiding in the House to the north — survivors join your cause when found. Select your Hero and queue a Move there.',
    trigger: { type: 'action_queued', actionType: PlanActionType.MOVE },
    spotlight: { type: 'hex', col: 2, row: 3, arrow: 'down' },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'explore_house',
    title: 'Explore the House',
    body: 'Click your hero\'s ghost at the House and choose Explore.',
    trigger: { type: 'action_queued', actionType: PlanActionType.EXPLORE },
    spotlight: { type: 'hex', col: 2, row: 3, arrow: 'down' },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'submit_r3',
    title: 'Submit and Explore!',
    body: 'Submit your plan.',
    trigger: { type: 'plan_submitted' },
    spotlight: { type: 'element', selector: '#plan-submit-btn', arrow: 'right' },
    tooltipPos: 'bottom-left',
    witchPlan: [], // witch idles in round 3
  },
  {
    id: 'watch_r3',
    title: 'A Survivor Found!',
    body: 'A survivor joins your cause, sharing the hex with your Hero.',
    trigger: 'auto',
    spotlight: null,
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },

  // ── Round 4: Shared budget + Power Node discovery (onPlanningPhaseStart jumps here when _round === 3) ──

  {
    id: 'select_survivor',
    title: 'Multiple Units on a Hex',
    body: 'Your Hero and the survivor share a tile — click it and pick the Survivor from the list.',
    trigger: { type: 'entity_selected', entityType: EntityType.SURVIVOR },
    spotlight: { type: 'hex', col: 2, row: 3, arrow: 'down' },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'survivor_move',
    title: 'One Budget, Many Units',
    body: 'Queue a Move for the survivor too. All your units spend from the same action budget — watch the badge tick down.',
    trigger: { type: 'action_queued', actionType: PlanActionType.MOVE, entityType: EntityType.SURVIVOR },
    spotlight: { type: 'element', selector: '#plan-budget-badge', arrow: 'right' },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'smithy_intro',
    title: 'Explore Further',
    body: 'Now move your Hero east to the Blacksmith — the road beyond holds something important.',
    trigger: { type: 'action_queued', actionType: PlanActionType.MOVE, entityType: EntityType.HERO },
    spotlight: { type: 'hex', col: 5, row: 5, arrow: 'down' },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'submit_r4',
    title: 'Submit Your Plan',
    body: 'Submit — your party heads east.',
    trigger: { type: 'plan_submitted' },
    spotlight: { type: 'element', selector: '#plan-submit-btn', arrow: 'right' },
    tooltipPos: 'bottom-left',
    witchPlan: [],
  },
  {
    id: 'watch_r4',
    title: 'The Road East',
    body: 'Your hero travels the road to the Blacksmith.',
    trigger: 'auto',
    spotlight: null,
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },

  // ── Explanation steps (onPlanningPhaseStart jumps here when _round === 4) ──

  {
    id: 'node_discovered',
    title: 'Power Node Discovered!',
    body: 'Whichever side has more units on a Power Node controls it. The side controlling the most nodes at Dawn and Dusk scores a point — four points wins.',
    trigger: 'click',
    spotlight: { type: 'hex', col: 7, row: 5, arrow: 'down' },
    tooltipPos: 'center',
    witchPlan: null,
  },
  {
    id: 'complete',
    title: 'You\'re Ready!',
    body: 'That\'s the loop: plan, submit, watch, repeat. Find weapons and allies, beware the night, and take the Power Nodes — Caleb\'s Hollow awaits.',
    trigger: 'complete',
    buttonLabel: 'Continue to Caleb\'s Hollow →',
    spotlight: null,
    tooltipPos: 'center',
    witchPlan: null,
  },
];

// ── MissionConductor configuration for the tutorial/prologue mission ─────

/**
 * Provides the scripted witch plan for each tutorial round.
 * Round 0: witch idles (plan from step's witchPlan field).
 * Round 1: minion attacks the hero (minion was spawned by wave after round 1).
 * Round 2+: witch idles.
 */
function _tutorialWitchPlanProvider(round, state, currentStep) {
  if (round === 0) {
    return currentStep?.witchPlan ?? [];
  }
  if (round === 1) {
    const minion = state.entities.find(
      e => e.type === EntityType.MINION && e.owner === 'witch' && e.alive
    );
    const hero = state.entities.find(e => e.type === EntityType.HERO && e.alive);
    if (minion && hero) {
      return [{
        type: PlanActionType.BATTLE_UNIT,
        entityId: minion.id, targetId: hero.id,
        targetCol: hero.col, targetRow: hero.row,
      }];
    }
  }
  return [];
}

export const TUTORIAL_CONDUCTOR_CONFIG = {
  roundStepMap: {
    1: 'combat_intro',
    2: 'move_to_house',
    3: 'select_survivor',
    4: 'node_discovered',
  },
  witchPlanProvider: _tutorialWitchPlanProvider,
  forcedDice: [{ round: 1, dice: TUTORIAL_FORCED_DICE }],
  maxPlanningRounds: 4,
  voiceKey: 'tutorial',
};
