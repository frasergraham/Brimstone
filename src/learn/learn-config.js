// ═══════════════════════════════════════════════════════════════════════════
// Learn to Play — standalone guided tutorial (NOT a campaign mission).
//
// A fixed, smallest-size map with a single river crossing. The conductor steers
// the player through three guided rounds (advance → fight → fortify/guard), then
// HANDS OFF: the witch becomes a normal AI opponent and the battle plays out as
// a real, winnable game (hold the Power Node to 4 points, or slay the Witch).
//
// This module owns only DATA + pure builders — no DOM, no GameState mutation.
// The launcher in main.js (`_startLearnToPlay`) places the units, wires the
// MissionConductor, and performs the AI handoff. The conductor gates the player
// to the scripted path via per-step `allowHexes` / `allowActions` allowlists and
// a pulsing red circle (see mission-conductor.js).
//
// Coordinates are odd-r offset (pointy-top). Every scripted move/attack is
// validated against the live engine by tests/learn-tutorial.test.js — adjust
// coordinates there, not by hand.
// ═══════════════════════════════════════════════════════════════════════════

import { Tile, TileType, BuildingType, decomposeTileType, legacyTileType } from '../tiles.js';
import { hexKey, setMapDimensions } from '../hex.js';
import { NODE_COLORS } from '../map.js';
import { PlanActionType } from '../planner.js';
import { ActionType } from '../actions.js';
import { EntityType } from '../entities.js';

// ── Map helpers (same pattern as the campaign/tutorial map builders) ─────────

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

function setRiver(tiles, col, row) {
  const t = tiles.get(hexKey(col, row));
  if (t) decomposeTileType(t, TileType.RIVER);
}

function setBridge(tiles, col, row) {
  const t = tiles.get(hexKey(col, row));
  if (t) decomposeTileType(t, TileType.BRIDGE);
}

function addRoad(tiles, from, to) {
  const a = tiles.get(hexKey(from.col, from.row));
  const b = tiles.get(hexKey(to.col, to.row));
  if (a) a.roadDirs.add(hexKey(to.col, to.row));
  if (b) b.roadDirs.add(hexKey(from.col, from.row));
  // Promote bare grass crossings to ROAD so the deck draws and movement costs 1.
  for (const rc of [from, to]) {
    const t = tiles.get(hexKey(rc.col, rc.row));
    if (t && legacyTileType(t) === TileType.GRASS) decomposeTileType(t, TileType.ROAD);
  }
}

// ── Fixed unit start positions ───────────────────────────────────────────────
// The hero leader is placed by GameState at heroStart. Survivors + zombies are
// placed by the launcher. The Witch leader starts far away (fogged) and is held
// idle by the conductor until the handoff, then driven by the AI.

export const LEARN_HERO_START   = { col: 3, row: 5 };   // Inn — the Paladin
export const LEARN_WITCH_START  = { col: 7, row: 4 };   // far bank, fogged

// Two townsfolk. SURVIVOR_A is melee and advances onto the hero's tile to teach
// tile-sharing; SURVIVOR_B carries a bow and stays back as the archer.
export const LEARN_SURVIVOR_A   = { col: 4, row: 5 };   // on the bridge, melee
export const LEARN_SURVIVOR_B   = { col: 3, row: 6, weapon: 'bow' }; // archer

// Forward strongpoint the party advances onto (a building, so FORTIFY works).
export const LEARN_CHAPEL = { col: 5, row: 5 };

// The townsfolk advance targets (round 0): A shares the hero's chapel hex, B
// repositions a step to hold the flank within bow range of the far zombie.
export const LEARN_SURVIVOR_A_ADVANCE = { col: 5, row: 5 }; // onto the hero's hex
export const LEARN_SURVIVOR_B_ADVANCE = { col: 2, row: 6 }; // flank

// The Witch's two zombies — start across the river, hidden by fog, and advance
// into view during the first resolution (round 0 witch plan).
export const LEARN_ZOMBIES = [
  { id: 'z1', start: { col: 7, row: 5 }, advance: { col: 6, row: 5 } }, // → beside the chapel
  { id: 'z2', start: { col: 6, row: 6 }, advance: { col: 5, row: 6 } }, // → within bow range
];

// The Witch's two-step approach into the guard trap (rounds 1 then 2).
export const LEARN_WITCH_APPROACH = [
  { col: 6, row: 4 },   // round 1: emerges into view
  { col: 5, row: 4 },   // round 2: steps adjacent to the chapel (the guard trap)
];

// ── Map builder ──────────────────────────────────────────────────────────────

export function buildLearnMap() {
  const COLS = 9, ROWS = 8;
  setMapDimensions(COLS, ROWS);
  const tiles = makeTiles(COLS, ROWS);

  // Buildings — hero's Inn, the forward Chapel strongpoint, a far Graveyard.
  setBuilding(tiles, LEARN_HERO_START.col, LEARN_HERO_START.row, BuildingType.INN, 1);
  setBuilding(tiles, LEARN_CHAPEL.col, LEARN_CHAPEL.row, BuildingType.CHURCH, 0);
  setBuilding(tiles, LEARN_WITCH_START.col, LEARN_WITCH_START.row, BuildingType.GRAVEYARD, 0);

  // River wall down column 4, with a single BRIDGE crossing at row 5.
  for (const row of [1, 2, 3, 4, 6, 7]) setRiver(tiles, 4, row);
  setBridge(tiles, 4, 5);

  // Road across the bridge linking the Inn to the Chapel and the node beyond.
  addRoad(tiles, { col: 3, row: 5 }, { col: 4, row: 5 });
  addRoad(tiles, { col: 4, row: 5 }, { col: 5, row: 5 });
  addRoad(tiles, { col: 5, row: 5 }, { col: 6, row: 5 });

  // Power Node cluster around the Chapel — holding the far bank scores it.
  const witchObjectives = [
    {
      col: 5, row: 5,
      label: 'The Crossing',
      hexes: [{ col: 5, row: 4 }, { col: 5, row: 5 }, { col: 6, row: 5 }],
      color: NODE_COLORS[0],
      seenByHero:  false,
      seenByWitch: true,
      prevCtrl: 'neutral',
    },
  ];

  return {
    tiles,
    witchObjectives,
    heroStart:      { ...LEARN_HERO_START },
    witchStart:     { ...LEARN_WITCH_START },
    mapSize:        'tutorial',
    survivorCounts: { buildings: 0, terrain: 0 },
    cols: COLS,
    rows: ROWS,
    // Witch leader IS created (unlike the old tutorial) so the free-play handoff
    // is a real, winnable battle — it just starts far away and fogged.
    noWitch: false,
    heroName:  'The Paladin',
    witchName: 'The Witch',
  };
}

// ── Scripted opponent plans + dice ────────────────────────────────────────────
// Round counter is the conductor's own `_round` (0-based), incremented after
// each resolution. Rounds 0–2 are guided; round 3+ is AI free-play (handoff).

function _zombieAdvancePlan(state) {
  // Round 0 resolution: the two zombies emerge from the tree line into view.
  const plan = [];
  const zombies = state.entities.filter(e => e.type === EntityType.ZOMBIE && e.alive);
  for (let i = 0; i < zombies.length && i < LEARN_ZOMBIES.length; i++) {
    const dst = LEARN_ZOMBIES[i].advance;
    plan.push({ type: PlanActionType.MOVE, entityId: zombies[i].id, targetCol: dst.col, targetRow: dst.row });
  }
  return plan;
}

function _witchApproachPlan(state, step) {
  // Rounds 1 & 2: the Witch advances one hex toward the chapel. On round 2 she
  // also strikes a defender so she "does some damage" after the guard fires.
  const witch = state.witch;
  if (!witch || !witch.alive) return [];
  const dst = LEARN_WITCH_APPROACH[step] ?? LEARN_WITCH_APPROACH[LEARN_WITCH_APPROACH.length - 1];
  const plan = [{ type: PlanActionType.MOVE, entityId: witch.id, targetCol: dst.col, targetRow: dst.row }];
  if (step === 1) {
    // Strike whoever holds the chapel after closing in (any non-witch unit there).
    const target = state.entities.find(
      e => e.alive && e.owner !== witch.owner && e.col === LEARN_CHAPEL.col && e.row === LEARN_CHAPEL.row
    );
    if (target) {
      plan.push({ type: PlanActionType.BATTLE_UNIT, entityId: witch.id, targetId: target.id, targetCol: target.col, targetRow: target.row });
    }
  }
  return plan;
}

function _learnWitchPlanProvider(round, state) {
  if (round === 0) return _zombieAdvancePlan(state);        // zombies advance into view
  if (round === 1) return _witchApproachPlan(state, 0);     // zombies die; witch emerges
  if (round === 2) return _witchApproachPlan(state, 1);     // witch walks into the guard
  return [];                                                // handoff → AI takes over
}

// Round 1 combat: a generous alternating high/low queue so every player attack
// wins its roll. The guided zombies are also reduced to 1 HP by the launcher, so
// any landed hit is lethal regardless of damage-die order.
export const LEARN_COMBAT_DICE = [6, 1, 6, 1, 6, 1, 6, 1, 6, 1, 6, 1, 6, 1, 6, 1];

// ── Conductor configuration ───────────────────────────────────────────────────

export const LEARN_CONDUCTOR_CONFIG = {
  mode: 'scripted',
  roundStepMap: {
    1: 'combat_intro',     // round 1 planning → attack the zombies
    2: 'fortify_intro',    // round 2 planning → fortify + guard
    3: 'node_intro',       // round 3 planning → explain Power Nodes, then hand off
  },
  witchPlanProvider: _learnWitchPlanProvider,
  forcedDice: [{ round: 1, dice: LEARN_COMBAT_DICE }],
  // Rounds 0–2 are guided. Round 3 shows the node explanation only (no planning),
  // ending in a `handoff` step that releases control to the witch AI for free play.
  maxPlanningRounds: 3,
  // Only these actions ever appear in the arc menu for the whole tutorial.
  actionWhitelist: [ActionType.EXPLORE, ActionType.GUARD, ActionType.FORTIFY],
};

// ── Step definitions ──────────────────────────────────────────────────────────
//
// Beyond the base conductor fields (id/title/body/trigger/spotlight/tooltipPos),
// Learn-to-Play steps carry strict-gating fields read by the conductor:
//   allowHexes   — the ONLY map hexes the player may click this step ([] / absent
//                  during dialog steps where the map is blocked anyway).
//   allowActions — the ONLY arc-menu actions offered this step. `[]` shows none
//                  (move/attack are hex clicks, not arc actions); absent falls
//                  back to the config's actionWhitelist.
//   pulse        — draw the pulsing red screen-space circle on the spotlight.
//
// New trigger: 'handoff' — like 'complete' but fires config.onHandoff (release to
// free play) instead of ending the game.

const HERO = LEARN_HERO_START;
const CHAPEL = LEARN_CHAPEL;
const Z1 = LEARN_ZOMBIES[0].advance;
const Z2 = LEARN_ZOMBIES[1].advance;
const NODE = LEARN_CHAPEL;

export const LEARN_STEPS = [
  // ── Intro (blocking dialogs) ────────────────────────────────────────────────
  {
    id: 'welcome',
    title: 'Caleb\'s Hollow',
    body: 'A turn-based strategy game. You command a Day or Night faction in a battle waged over many days.',
    trigger: 'click', spotlight: null, tooltipPos: 'center',
  },
  {
    id: 'modes',
    title: 'Plan, Then Resolve',
    body: 'Each round has two modes. In PLANNING you spend an action budget to queue moves, attacks and explores, then SUBMIT.',
    trigger: 'click', spotlight: null, tooltipPos: 'center',
  },
  {
    id: 'resolution',
    title: 'Resolution',
    body: 'In RESOLUTION your plan plays out beside everyone else\'s — step through it and see whether each attack landed or the enemy slipped away.',
    trigger: 'click', spotlight: null, tooltipPos: 'center',
  },
  {
    id: 'day_night',
    title: 'The Turning Day',
    body: 'The day-cycle advances every round. Human factions are strong in daylight; the Witch\'s grow stronger by moonlight.',
    trigger: 'click', spotlight: null, tooltipPos: 'center',
  },
  {
    id: 'arena',
    title: 'The Paladin\'s Stand',
    body: 'The Paladin and two townsfolk face the Witch\'s forces. Advance your hero across the bridge to find the enemy.',
    trigger: 'click', spotlight: null, tooltipPos: 'center',
  },

  // ── Round 0: advance + share a tile ─────────────────────────────────────────
  {
    id: 'move_hero',
    title: 'Advance the Hero',
    body: 'Select the Paladin, then click the chapel across the bridge. Green hexes are within reach this round.',
    trigger: { type: 'action_queued', actionType: PlanActionType.MOVE, entityType: EntityType.HERO },
    spotlight: { type: 'hex', col: CHAPEL.col, row: CHAPEL.row, arrow: 'down' },
    pulse: true, tooltipPos: 'bottom-left',
    allowHexes: [HERO, CHAPEL], allowActions: [],
  },
  {
    id: 'move_survivor_a',
    title: 'Friendly Units Share a Tile',
    body: 'Now bring a townsperson alongside the hero — select the soldier on the bridge and send him onto the chapel hex.',
    trigger: { type: 'action_queued', actionType: PlanActionType.MOVE, entityType: EntityType.SURVIVOR },
    spotlight: { type: 'hex', col: CHAPEL.col, row: CHAPEL.row, arrow: 'down' },
    pulse: true, tooltipPos: 'bottom-left',
    allowHexes: [LEARN_SURVIVOR_A, CHAPEL], allowActions: [],
  },
  {
    id: 'move_survivor_b',
    title: 'Hold the Flank',
    body: 'Move your archer a couple of hexes to cover the crossing. Tab cycles units; you can also pick them from the plan panel.',
    trigger: { type: 'action_queued', actionType: PlanActionType.MOVE, entityType: EntityType.SURVIVOR },
    spotlight: { type: 'hex', col: LEARN_SURVIVOR_B_ADVANCE.col, row: LEARN_SURVIVOR_B_ADVANCE.row, arrow: 'down' },
    pulse: true, tooltipPos: 'bottom-left',
    allowHexes: [LEARN_SURVIVOR_B, LEARN_SURVIVOR_B_ADVANCE], allowActions: [],
  },
  {
    id: 'submit_r0',
    title: 'Submit Your Plan',
    body: 'Your plan is set. Click Submit to lock it in.',
    trigger: { type: 'plan_submitted' },
    spotlight: { type: 'element', selector: '#plan-submit-btn', arrow: 'right' },
    pulse: true, tooltipPos: 'bottom-left',
  },
  {
    id: 'watch_r0',
    title: 'Resolution',
    body: 'Watch both sides move at once — the Witch\'s forces creep into view.',
    trigger: 'auto', spotlight: null, tooltipPos: 'bottom-left',
  },

  // ── Round 1: combat ─────────────────────────────────────────────────────────
  {
    id: 'combat_intro',
    title: 'Strike!',
    body: 'A zombie stands beside you. Click the hero\'s hex, choose the Paladin from the two there, then click the zombie. Click again to stack a second strike.',
    trigger: { type: 'action_queued', actionType: PlanActionType.BATTLE_UNIT, entityType: EntityType.HERO },
    spotlight: { type: 'hex', col: Z1.col, row: Z1.row, arrow: 'down' },
    pulse: true, tooltipPos: 'bottom-left',
    allowHexes: [CHAPEL, Z1], allowActions: [],
  },
  {
    id: 'combat_explain',
    title: 'How Combat Works',
    body: 'Each target shows your chance to HIT or CRUSH it. Allies beside the target join your attack — and defenders join theirs. Numbers decide the day.',
    trigger: 'click', spotlight: null, tooltipPos: 'center',
  },
  {
    id: 'ranged',
    title: 'Loose an Arrow',
    body: 'Your archer can strike at range. Select the bowman and click the far zombie to queue a ranged attack.',
    trigger: { type: 'action_queued', actionType: PlanActionType.BATTLE_UNIT, entityType: EntityType.SURVIVOR },
    spotlight: { type: 'hex', col: Z2.col, row: Z2.row, arrow: 'down' },
    pulse: true, tooltipPos: 'bottom-left',
    allowHexes: [LEARN_SURVIVOR_B_ADVANCE, Z2], allowActions: [],
  },
  {
    id: 'submit_r1',
    title: 'Submit and Fight',
    body: 'Lock in your attacks and watch the dice fall.',
    trigger: { type: 'plan_submitted' },
    spotlight: { type: 'element', selector: '#plan-submit-btn', arrow: 'right' },
    pulse: true, tooltipPos: 'bottom-left',
  },
  {
    id: 'watch_r1',
    title: 'The Zombies Fall',
    body: 'Both zombies are slain — but the Witch herself emerges a few hexes away.',
    trigger: 'auto', spotlight: null, tooltipPos: 'bottom-left',
  },

  // ── Round 2: fortify + guard ────────────────────────────────────────────────
  {
    id: 'fortify_intro',
    title: 'Dig In',
    body: 'The Witch is coming. Hold this chapel: select a unit here and choose Fortify to spend resources hardening it.',
    trigger: { type: 'action_queued', actionType: PlanActionType.FORTIFY },
    spotlight: { type: 'hex', col: CHAPEL.col, row: CHAPEL.row, arrow: 'down' },
    pulse: true, tooltipPos: 'bottom-left',
    allowHexes: [CHAPEL], allowActions: [ActionType.FORTIFY],
  },
  {
    id: 'guard_intro',
    title: 'Set a Trap',
    body: 'Now choose Guard — the unit readies an opportunity attack if an enemy steps within reach. Stack guards for more reactions.',
    trigger: { type: 'action_queued', actionType: PlanActionType.GUARD },
    spotlight: { type: 'hex', col: CHAPEL.col, row: CHAPEL.row, arrow: 'down' },
    pulse: true, tooltipPos: 'bottom-left',
    allowHexes: [CHAPEL], allowActions: [ActionType.GUARD],
  },
  {
    id: 'submit_r2',
    title: 'Submit and Hold',
    body: 'Lock in your defenses and brace for the assault.',
    trigger: { type: 'plan_submitted' },
    spotlight: { type: 'element', selector: '#plan-submit-btn', arrow: 'right' },
    pulse: true, tooltipPos: 'bottom-left',
  },
  {
    id: 'watch_r2',
    title: 'Into the Trap',
    body: 'The Witch steps into your guard — yet still lands a blow on you and your works.',
    trigger: 'auto', spotlight: null, tooltipPos: 'bottom-left',
  },

  // ── Round 3: nodes + handoff to free play ───────────────────────────────────
  {
    id: 'node_intro',
    title: 'Power Nodes',
    body: 'Slaying the Witch wins the battle — but the surer path is the Power Nodes. The highlighted hexes belong to whoever has the most units there; hold the most at dawn and dusk to score. First to four points wins.',
    trigger: 'click',
    spotlight: { type: 'hex', col: NODE.col, row: NODE.row, arrow: 'down' },
    pulse: true, tooltipPos: 'center',
  },
  {
    id: 'good_luck',
    title: 'The Battle Is Yours',
    body: 'That is the loop: plan, submit, watch, repeat. Now hold the Crossing or strike down the Witch. Good luck.',
    trigger: 'handoff', buttonLabel: 'Play on →',
    spotlight: null, tooltipPos: 'center',
  },
];
