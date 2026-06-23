// ═══════════════════════════════════════════════════════════════════════════
// Learn to Play — standalone guided tutorial (NOT a campaign mission).
//
// A fixed, smallest-size map with a single river crossing, the banks shrouded in
// trees so the Witch's forces stay hidden until the party crosses. The conductor
// steers the player through three guided rounds (advance → fight → fortify/guard)
// then HANDS OFF: the witch becomes a normal AI opponent and the battle plays out
// as a real, winnable game (hold the Power Node to 4 points, or slay the Witch).
//
// This module owns only DATA + pure builders — no DOM, no GameState mutation.
// The launcher in main.js (`_startLearnToPlay`) places the units, wires the
// MissionConductor, and performs the AI handoff. The conductor gates the player
// to the scripted path via per-step `allowHexes` / `allowActions` allowlists, a
// red arrow, and a pulsing red circle (see mission-conductor.js).
//
// Coordinates are odd-r offset (pointy-top). Every scripted move/attack and the
// start-of-game sightlines are validated against the live engine by
// tests/learn-tutorial.test.js — adjust coordinates there, not by hand.
// ═══════════════════════════════════════════════════════════════════════════

import { Tile, TileType, BuildingType, decomposeTileType, legacyTileType } from '../tiles.js';
import { hexKey, setMapDimensions } from '../hex.js';
import { NODE_COLORS } from '../map.js';
import { PlanActionType } from '../planner.js';
import { ActionType } from '../actions.js';
import { EntityType, createSurvivor, createZombie } from '../entities.js';

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

// A building is a compound object: a passable ENTRANCE tile plus one impassable
// FOOTPRINT hex adjacent to it (the building's mass / wall, which also blocks
// line of sight). This mirrors the procedural generator's footprinted buildings.
function setBuilding(tiles, col, row, building, fp, fortLevel = 0) {
  const t = tiles.get(hexKey(col, row));
  if (t) { decomposeTileType(t, TileType.BUILDING); t.building = building; t.fortifyLevel = fortLevel; }
  const f = fp && tiles.get(hexKey(fp.col, fp.row));
  if (t && f) {
    t.footprintHexes = [hexKey(fp.col, fp.row)];
    f.buildingFootprintOf = hexKey(col, row);
  }
}

function setRiver(tiles, col, row) {
  const t = tiles.get(hexKey(col, row));
  if (t) decomposeTileType(t, TileType.RIVER);
}

function setBridge(tiles, col, row) {
  const t = tiles.get(hexKey(col, row));
  if (t) decomposeTileType(t, TileType.BRIDGE);
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
  // Promote bare grass crossings to ROAD so the deck draws and movement costs 1.
  for (const rc of [from, to]) {
    const t = tiles.get(hexKey(rc.col, rc.row));
    if (t && legacyTileType(t) === TileType.GRASS) decomposeTileType(t, TileType.ROAD);
  }
}

// ── Fixed positions ───────────────────────────────────────────────────────────
// The hero leader (Ishmael Charger) is placed by GameState at heroStart. The two
// townsfolk + two zombies are placed by the launcher. The Witch leader starts far
// on the east bank (fogged) and is held idle by the conductor until the handoff.

export const LEARN_HERO_START  = { col: 2, row: 5 };   // Inn — Ishmael Charger
export const LEARN_WITCH_START  = { col: 7, row: 3 };   // far bank, fogged

// The forward strongpoint the party advances onto — a CHURCH (so FORTIFY works),
// across the bridge and holding the Power Node.
export const LEARN_CHURCH = { col: 5, row: 5 };
export const LEARN_BRIDGE = { col: 4, row: 5 };

// Townsfolk. The melee soldier advances onto Ishmael's tile (teaching tile
// sharing); Isaac carries a bow and takes a vantage where he can see the enemy.
export const LEARN_SOLDIER = { col: 3, row: 6 };                 // melee
export const LEARN_ISAAC   = { col: 2, row: 4, weapon: 'bow', name: 'Isaac' }; // archer
export const LEARN_ISAAC_VANTAGE = { col: 3, row: 4 };          // clearing — sees across

// Two zombies start deep on the east bank (behind the trees) and advance into
// view during the first resolution.
export const LEARN_ZOMBIES = [
  { id: 'z1', start: { col: 7, row: 5 }, advance: { col: 6, row: 5 } }, // → beside the church (melee)
  { id: 'z2', start: { col: 7, row: 4 }, advance: { col: 6, row: 4 } }, // → within Isaac's bow range
];

// The Witch's two-step approach into the guard trap (rounds 1 then 2).
export const LEARN_WITCH_APPROACH = [
  { col: 6, row: 3 },   // round 1: emerges into view
  { col: 6, row: 4 },   // round 2: steps adjacent to the church (the guard trap)
];

// ── Map builder ──────────────────────────────────────────────────────────────

export function buildLearnMap() {
  const COLS = 9, ROWS = 8;
  setMapDimensions(COLS, ROWS);
  const tiles = makeTiles(COLS, ROWS);

  // Buildings (entrance + impassable footprint wall).
  setBuilding(tiles, LEARN_HERO_START.col, LEARN_HERO_START.row, BuildingType.INN,   { col: 2, row: 6 }, 1);
  setBuilding(tiles, LEARN_CHURCH.col,      LEARN_CHURCH.row,     BuildingType.CHURCH, { col: 5, row: 6 }, 0);
  setBuilding(tiles, 7, 2, BuildingType.GRAVEYARD, { col: 7, row: 1 }, 0);

  // River wall down column 4, with a single BRIDGE crossing at row 5.
  for (const row of [0, 1, 2, 3, 4, 6, 7]) setRiver(tiles, 4, row);
  setBridge(tiles, LEARN_BRIDGE.col, LEARN_BRIDGE.row);

  // Road across the bridge linking the Inn to the church and the node beyond.
  addRoad(tiles, { col: 2, row: 5 }, { col: 3, row: 5 });
  addRoad(tiles, { col: 3, row: 5 }, { col: 4, row: 5 });
  addRoad(tiles, { col: 4, row: 5 }, { col: 5, row: 5 });
  addRoad(tiles, { col: 5, row: 5 }, { col: 6, row: 5 });

  // Trees shroud both banks so the Witch's forces stay hidden until the party
  // crosses — leaving a CLEARING to the north (cols 2-4, rows 0-2, and Isaac's
  // vantage at (3,4)) where the bow can see across, and the road corridor open.
  setForest(tiles, [
    // east-bank screen in front of the enemy starts
    { col: 7, row: 3 }, { col: 7, row: 4 }, { col: 7, row: 5 }, { col: 7, row: 6 },
    { col: 8, row: 4 }, { col: 8, row: 6 }, { col: 8, row: 3 },
    { col: 6, row: 6 }, { col: 6, row: 7 }, { col: 5, row: 7 }, { col: 5, row: 2 },
    { col: 6, row: 2 }, { col: 5, row: 3 },
    // west-bank cover hemming the approach (south of the road)
    { col: 3, row: 7 }, { col: 2, row: 7 }, { col: 1, row: 6 }, { col: 6, row: 1 },
  ]);

  // Power Node cluster around the church — holding the far bank scores it.
  const witchObjectives = [
    {
      col: LEARN_CHURCH.col, row: LEARN_CHURCH.row,
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
    // The Witch leader IS created so the free-play handoff is a real, winnable
    // battle — she just starts far away and shrouded.
    noWitch: false,
    heroName:  'Ishmael Charger',
    witchName: 'The Witch',
  };
}

// ── Unit placement ────────────────────────────────────────────────────────────
// Single source of truth for the non-leader units, shared by the launcher and
// the validation test so they can never drift. SCOUT is stripped so a random
// roster roll can't widen a survivor's sight and reveal the shrouded enemy early.

function _stripScout(e) {
  if (Array.isArray(e.abilities)) e.abilities = e.abilities.filter(a => a !== 'scout');
}

export function placeLearnUnits(state) {
  const soldier = createSurvivor(LEARN_SOLDIER.col, LEARN_SOLDIER.row, null, state);
  soldier.owner = 'hero';
  _stripScout(soldier);

  const isaac = createSurvivor(LEARN_ISAAC.col, LEARN_ISAAC.row, null, state);
  isaac.owner = 'hero';
  isaac.equipWeapon(LEARN_ISAAC.weapon);
  isaac.name = LEARN_ISAAC.name;
  _stripScout(isaac);

  state.entities.push(soldier, isaac);

  // The Witch's two zombies — 1 HP so the scripted strikes are always lethal.
  const zombies = LEARN_ZOMBIES.map(z => {
    const e = createZombie(z.start.col, z.start.row, 'witch', state);
    e.hp = 1; e.maxHp = 1;
    state.entities.push(e);
    return e;
  });

  return { soldier, isaac, zombies };
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
    // MOVE actions are keyed by toCol/toRow in the resolver (executeMove).
    plan.push({ type: PlanActionType.MOVE, entityId: zombies[i].id, toCol: dst.col, toRow: dst.row });
  }
  return plan;
}

function _witchApproachPlan(state, step) {
  // Rounds 1 & 2: the Witch advances one hex toward the church. On round 2 she
  // also strikes a defender so she "does some damage" after the guard fires.
  const witch = state.witch;
  if (!witch || !witch.alive) return [];
  const dst = LEARN_WITCH_APPROACH[step] ?? LEARN_WITCH_APPROACH[LEARN_WITCH_APPROACH.length - 1];
  const plan = [{ type: PlanActionType.MOVE, entityId: witch.id, toCol: dst.col, toRow: dst.row }];
  if (step === 1) {
    // Strike whoever holds the church after closing in (any non-witch unit there).
    const target = state.entities.find(
      e => e.alive && e.owner !== witch.owner && e.col === LEARN_CHURCH.col && e.row === LEARN_CHURCH.row
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
//   allowHexes   — the ONLY map hexes the player may click this step.
//   allowActions — the ONLY arc-menu actions offered this step (`[]` shows none).
//   pulse        — draw the pulsing red circle on the spotlight target.
// A MOVE trigger may carry `toCol/toRow` to require REACHING a hex (so a two-move
// advance only completes on the final leg). New trigger 'handoff' releases to
// free play. Resolution ('auto') steps sit at the top so they never cover the
// bottom replay controls on mobile.

const HERO = LEARN_HERO_START;
const CHURCH = LEARN_CHURCH;
const BRIDGE = LEARN_BRIDGE;
const Z1 = LEARN_ZOMBIES[0].advance;
const Z2 = LEARN_ZOMBIES[1].advance;
const VANTAGE = LEARN_ISAAC_VANTAGE;

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
    title: 'Ishmael\'s Stand',
    body: 'Your hero Ishmael Charger and two townsfolk face the Witch\'s forces across the river. Advance over the bridge to find the enemy.',
    trigger: 'click', spotlight: null, tooltipPos: 'center',
  },

  // ── Round 0: advance (two moves) + share a tile + scout ─────────────────────
  {
    id: 'move_hero',
    title: 'Advance the Hero',
    body: 'Select Ishmael, then move him across the bridge to the church. It takes two moves — click the bridge, then the church.',
    trigger: { type: 'action_queued', actionType: PlanActionType.MOVE, entityType: EntityType.HERO, toCol: CHURCH.col, toRow: CHURCH.row },
    spotlight: { type: 'hex', col: CHURCH.col, row: CHURCH.row, arrow: 'down' },
    pulse: true, tooltipPos: 'bottom-left',
    allowHexes: [HERO, BRIDGE, CHURCH], allowActions: [],
  },
  {
    id: 'move_soldier',
    title: 'Friendly Units Share a Tile',
    body: 'Now bring a townsperson alongside the hero. Friendly units can share a tile — move the soldier across to the church too.',
    trigger: { type: 'action_queued', actionType: PlanActionType.MOVE, entityType: EntityType.SURVIVOR, toCol: CHURCH.col, toRow: CHURCH.row },
    spotlight: { type: 'hex', col: CHURCH.col, row: CHURCH.row, arrow: 'down' },
    pulse: true, tooltipPos: 'bottom-left',
    allowHexes: [LEARN_SOLDIER, BRIDGE, CHURCH], allowActions: [],
  },
  {
    id: 'move_isaac',
    title: 'Eyes Across the River',
    body: 'Isaac has a bow. Move him to the clearing on the north bank where he can see across the river.',
    trigger: { type: 'action_queued', actionType: PlanActionType.MOVE, entityType: EntityType.SURVIVOR, toCol: VANTAGE.col, toRow: VANTAGE.row },
    spotlight: { type: 'hex', col: VANTAGE.col, row: VANTAGE.row, arrow: 'down' },
    pulse: true, tooltipPos: 'bottom-left',
    allowHexes: [LEARN_ISAAC, VANTAGE], allowActions: [],
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
    body: 'Watch both sides move at once — the Witch\'s forces creep out of the trees.',
    trigger: 'auto', spotlight: null, tooltipPos: 'top',
  },

  // ── Round 1: combat ─────────────────────────────────────────────────────────
  {
    id: 'combat_intro',
    title: 'Strike!',
    body: 'A zombie stands beside you. Click the church, choose Ishmael from the two units there, then click the zombie. Click again to stack a second strike.',
    trigger: { type: 'action_queued', actionType: PlanActionType.BATTLE_UNIT, entityType: EntityType.HERO },
    spotlight: { type: 'hex', col: Z1.col, row: Z1.row, arrow: 'down' },
    pulse: true, tooltipPos: 'bottom-left',
    allowHexes: [CHURCH, Z1], allowActions: [],
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
    body: 'Isaac can strike at range. Select him and click the far zombie to queue a ranged attack.',
    trigger: { type: 'action_queued', actionType: PlanActionType.BATTLE_UNIT, entityType: EntityType.SURVIVOR },
    spotlight: { type: 'hex', col: Z2.col, row: Z2.row, arrow: 'down' },
    pulse: true, tooltipPos: 'bottom-left',
    allowHexes: [VANTAGE, Z2], allowActions: [],
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
    trigger: 'auto', spotlight: null, tooltipPos: 'top',
  },

  // ── Round 2: fortify + guard ────────────────────────────────────────────────
  {
    id: 'fortify_intro',
    title: 'Dig In',
    body: 'The Witch is coming. Hold this church: select a unit here and choose Fortify to spend resources hardening it.',
    trigger: { type: 'action_queued', actionType: PlanActionType.FORTIFY },
    spotlight: { type: 'hex', col: CHURCH.col, row: CHURCH.row, arrow: 'down' },
    pulse: true, tooltipPos: 'bottom-left',
    allowHexes: [CHURCH], allowActions: [ActionType.FORTIFY],
  },
  {
    id: 'guard_intro',
    title: 'Set a Trap',
    body: 'Now choose Guard — the unit readies an opportunity attack if an enemy steps within reach. Stack guards for more reactions.',
    trigger: { type: 'action_queued', actionType: PlanActionType.GUARD },
    spotlight: { type: 'hex', col: CHURCH.col, row: CHURCH.row, arrow: 'down' },
    pulse: true, tooltipPos: 'bottom-left',
    allowHexes: [CHURCH], allowActions: [ActionType.GUARD],
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
    trigger: 'auto', spotlight: null, tooltipPos: 'top',
  },

  // ── Round 3: nodes + handoff to free play ───────────────────────────────────
  {
    id: 'node_intro',
    title: 'Power Nodes',
    body: 'Slaying the Witch wins the battle — but the surer path is the Power Nodes. The highlighted hexes belong to whoever has the most units there; hold the most at dawn and dusk to score. First to four points wins.',
    trigger: 'click',
    spotlight: { type: 'hex', col: CHURCH.col, row: CHURCH.row, arrow: 'down' },
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
