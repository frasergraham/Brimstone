// ═══════════════════════════════════════════════════════════════════════════
// Tutorial Configuration
// Self-contained tutorial definition following the campaign config pattern.
// Contains the tutorial map builder, step definitions, wave config,
// and forced dice settings. NOT registered as a campaign.
// ═══════════════════════════════════════════════════════════════════════════

import { Tile, TileType, BuildingType, ResourceType } from '../tiles.js';
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
  if (t) { t.type = TileType.BUILDING; t.building = building; t.fortifyLevel = fortLevel; }
}

function setForest(tiles, hexes) {
  for (const { col, row } of hexes) {
    const t = tiles.get(hexKey(col, row));
    if (t && t.type === TileType.GRASS) t.type = TileType.FOREST;
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
    if (t && t.type === TileType.GRASS) t.type = TileType.ROAD;
  }

  // ── Forest clusters ──────────────────────────────────────────────────────
  setForest(tiles, [
    { col: 0, row: 2 }, { col: 1, row: 2 },
    { col: 7, row: 1 }, { col: 8, row: 1 }, { col: 8, row: 2 },
  ]);

  // ── Resources ────────────────────────────────────────────────────────────
  setResource(tiles, 1, 5, ResourceType.HERBS);
  setResource(tiles, 5, 3, ResourceType.WOOD);

  // ── Power Node — cluster at (4,4),(5,4),(4,5) ───────────────────────────
  const witchObjectives = [
    {
      col: 4, row: 4,
      label: 'The Crossroads',
      hexes: [{ col: 4, row: 4 }, { col: 5, row: 4 }, { col: 4, row: 5 }],
      color: NODE_COLORS[0],
      seenByHero:  true,
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
//   body        — tooltip explanation (may contain \n for line breaks)
//   trigger     — what advances the step:
//                   'click'        → "Got it →" button
//                   'auto'         → advances automatically via onPlanningPhaseStart
//                   'start_game'   → shows "Start a Real Game →" button
//                   { type: 'entity_selected', entityType }
//                   { type: 'action_queued',   actionType }
//                   { type: 'plan_submitted' }
//   spotlight   — what to highlight:
//                   null
//                   { type: 'hex',     col, row }
//                   { type: 'element', selector, arrow: 'up'|'down'|'left'|'right' (optional) }
//   tooltipPos  — 'center' | 'bottom-left' | 'bottom-right'
//   witchPlan   — scripted witch plan for this round (null = N/A)

export const TUTORIAL_STEPS = [
  // ── Intro ──────────────────────────────────────────────────────────────────

  {
    id: 'welcome',
    title: "Welcome to Caleb's Hollow",
    body: 'A hero arrives in a cursed town. Dark forces stir in the shadows.\n\nYou play as the ⚔ Hero. Let\'s learn the core mechanics in a few minutes.',
    trigger: 'click',
    spotlight: null,
    tooltipPos: 'center',
    witchPlan: null,
  },
  {
    id: 'planning_intro',
    title: 'Simultaneous Planning',
    body: 'Each round you build a plan — an ordered list of actions. Both sides plan secretly, then everything resolves at once.\n\nNobody gets to react to the other\'s plan. Prediction wins battles.',
    trigger: 'click',
    spotlight: null,
    tooltipPos: 'center',
    witchPlan: null,
  },
  {
    id: 'unit_selection',
    title: 'Unit Selection',
    body: 'Click a unit to select it. Click the selected unit again to open the action menu.\n\nA third click, or clicking anywhere else, deselects the unit.\n\nSelected unit information is shown at the top of the screen.',
    trigger: 'click',
    spotlight: { type: 'element', selector: '#unit-stats-bar', arrow: 'up' },
    tooltipPos: 'center',
    witchPlan: null,
  },

  // ── Round 1: Move to Church + Explore ─────────────────────────────────────

  {
    id: 'select_hero',
    title: 'Select Your Hero',
    body: 'Click your ⚔ Hero on the map to select them and see available actions.',
    trigger: { type: 'entity_selected', entityType: EntityType.HERO },
    spotlight: { type: 'hex', col: 2, row: 7 },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'queue_move',
    title: 'Queue a Move',
    body: 'Green hexes show where you can move. Click the Church to the north to add a Move to your plan.\n\nNotice the road connecting the Inn to the Church — roads let you move further in a single action.',
    trigger: { type: 'action_queued', actionType: PlanActionType.MOVE },
    spotlight: { type: 'hex', col: 2, row: 5 },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'ghost_arrow',
    title: 'Action Plan',
    body: 'The action plan panel on the right shows your queued actions. You can keep queuing more — actions happen in order when you submit.\n\nThe pips at the top of the screen track your remaining action budget.',
    trigger: 'click',
    spotlight: { type: 'element', selector: '#plan-panel', arrow: 'right' },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'queue_explore',
    title: 'Explore a Building',
    body: 'Your hero\'s ghost is now at the Church. Click the ghost (the Church hex) to open the action menu there.\n\nThe ghost shows where your hero will be after the move — actions are planned from that position. Choose Explore to search the Church for supplies.',
    trigger: { type: 'action_queued', actionType: PlanActionType.EXPLORE },
    spotlight: { type: 'hex', col: 2, row: 5 },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'submit_plan',
    title: 'Submit Your Plan',
    body: 'Your plan is ready: Move to Church, then Explore. Click Submit Plan — both sides will act simultaneously.',
    trigger: { type: 'plan_submitted' },
    spotlight: { type: 'element', selector: '#plan-submit-btn' },
    tooltipPos: 'bottom-left',
    witchPlan: [], // witch idles in round 1; minion spawns via wave after resolution
  },
  {
    id: 'watch_r1',
    title: 'Resolution',
    body: 'Watch both sides act at once. Your hero walks to the Church and searches it.',
    trigger: 'auto',
    spotlight: null,
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },

  // ── Round 2: Combat (onPlanningPhaseStart jumps here when _round === 1) ───

  {
    id: 'combat_intro',
    title: 'A Minion Appears!',
    body: 'A witch\'s minion has emerged from the shadows next to your hero!\n\nClick on the enemy to attack it.',
    trigger: { type: 'action_queued', actionType: PlanActionType.BATTLE_UNIT },
    spotlight: { type: 'hex', col: 3, row: 5 },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'combat_formula',
    title: 'How Combat Works',
    body: 'Combat is resolved with a dice roll.\n\n• Hit — attacker\'s roll beats the defender\'s → 1 damage\n• Critical — attacker rolls high enough → 2 damage\n• Counter — defender rolls strongly enough → 1 damage back to the attacker\n\nAllies adjacent to the target provide bonuses to your roll.',
    trigger: 'click',
    spotlight: null,
    tooltipPos: 'center',
    witchPlan: null,
  },
  {
    id: 'submit_fight',
    title: 'Submit and Fight!',
    body: 'Submit your plan. Watch the dice resolve!',
    trigger: { type: 'plan_submitted' },
    spotlight: { type: 'element', selector: '#plan-submit-btn' },
    tooltipPos: 'bottom-left',
    witchPlan: null, // set dynamically by getWitchPlan() for round 2
  },
  {
    id: 'watch_r2',
    title: 'Combat Resolved',
    body: 'Your hero struck true — the minion is slain! A critical hit dealt 2 damage in one blow.',
    trigger: 'auto',
    spotlight: null,
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'day_night',
    title: 'Day / Night Cycle',
    body: 'The bar at the top tracks the 8-round cycle: 🌅 Dawn → ☀ Day → 🌇 Dusk → 🌙 Night.\n\nAt night, enemies grow stronger. Dawn and Dusk are scoring checkpoints for Power Nodes.',
    trigger: 'click',
    spotlight: { type: 'element', selector: '#cycle-bar', arrow: 'up' },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },

  // ── Round 3: Survivor rescue (onPlanningPhaseStart jumps here when _round === 2) ──

  {
    id: 'survivor_intro',
    title: 'Find Allies',
    body: 'Survivors will join the Hero\'s cause if you find them.\n\nThere\'s a House to the north. Move your Hero there and explore — someone is hiding inside.',
    trigger: 'click',
    spotlight: { type: 'hex', col: 2, row: 3 },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'move_to_house',
    title: 'Move to the House',
    body: 'Click your Hero (1st click to select), then click the House hex to queue a Move north.',
    trigger: { type: 'action_queued', actionType: PlanActionType.MOVE },
    spotlight: { type: 'hex', col: 2, row: 3 },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'explore_house',
    title: 'Explore the House',
    body: 'Your hero\'s ghost is now at the House. Click the ghost to open the action menu, then choose Explore to search it.',
    trigger: { type: 'action_queued', actionType: PlanActionType.EXPLORE },
    spotlight: { type: 'hex', col: 2, row: 3 },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'submit_r3',
    title: 'Submit and Explore!',
    body: 'Submit your plan. Your hero will move to the House and search it.',
    trigger: { type: 'plan_submitted' },
    spotlight: { type: 'element', selector: '#plan-submit-btn' },
    tooltipPos: 'bottom-left',
    witchPlan: [], // witch idles in round 3
  },
  {
    id: 'watch_r3',
    title: 'A Survivor Found!',
    body: 'A survivor joins your cause. They now share the hex with your Hero.',
    trigger: 'auto',
    spotlight: null,
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },

  // ── Explanation steps (onPlanningPhaseStart jumps here when _round === 3) ──

  {
    id: 'multi_select',
    title: 'Multiple Units on a Hex',
    body: 'If there are multiple units on one tile, click the tile to choose which unit to select.\n\nRemember: units with a move already planned are considered to be at the position where their last planned move ends.',
    trigger: 'click',
    spotlight: { type: 'hex', col: 2, row: 3 },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'fortify',
    title: 'Fortification',
    body: 'When night falls, enemies grow stronger. Fortifications help defend your position.\n\nSpend wood or metal to fortify a tile. Buildings already start with a fortification level of 1.',
    trigger: 'click',
    spotlight: null,
    tooltipPos: 'center',
    witchPlan: null,
  },
  {
    id: 'score_tracker',
    title: 'Score Tracker',
    body: 'Power nodes appear on the map. Whichever side has more units on a power node controls it.\n\nThe pips at the bottom of the screen show who controls which nodes. At Dawn and Dusk, the side controlling a majority of nodes scores a point — four points wins the game.\n\nYou can also win by holding ALL the nodes at Dawn or Dusk, or by killing the enemy leader.',
    trigger: 'click',
    spotlight: { type: 'element', selector: '#score-bar', arrow: 'down' },
    tooltipPos: 'center',
    witchPlan: null,
  },
  {
    id: 'guard',
    title: 'Guard',
    body: 'Sometimes you don\'t know what\'s coming. The Guard action puts your unit in a ready state until they next move — they\'ll attack anything that comes close.',
    trigger: 'click',
    spotlight: null,
    tooltipPos: 'center',
    witchPlan: null,
  },
  {
    id: 'complete',
    title: 'You\'re Ready!',
    body: 'That\'s the core loop: plan actions, submit, watch resolution, repeat.\n\nExplore buildings for weapons and survivors, fortify positions, and control the Power Nodes.\n\nGood luck out there.',
    trigger: 'start_game',
    spotlight: null,
    tooltipPos: 'center',
    witchPlan: null,
  },
];
