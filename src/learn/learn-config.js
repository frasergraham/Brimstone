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

export const LEARN_HERO_START  = { col: 3, row: 5 };   // Inn — Ishmael Charger (1 move to the church)
export const LEARN_WITCH_START  = { col: 7, row: 4 };   // far bank, fogged

// The forward strongpoint the party advances onto — a CHURCH (so FORTIFY works),
// across the bridge and holding the Power Node.
export const LEARN_CHURCH = { col: 5, row: 5 };
export const LEARN_BRIDGE = { col: 4, row: 5 };

// Townsfolk — fixed roster characters so they never change between playthroughs.
// Thomas the soldier advances onto Ishmael's tile in TWO moves (teaching the
// intermediate click + tile sharing); Isaac carries a bow and takes a vantage.
export const LEARN_SOLDIER = { col: 3, row: 6, name: 'Thomas Putnam' };          // melee
export const LEARN_ISAAC   = { col: 2, row: 4, weapon: 'bow', name: 'Isaac Graves' }; // archer
export const LEARN_ISAAC_VANTAGE = { col: 2, row: 3 };          // clearing — sees across

// Two zombies start deep on the east bank (behind the trees) and advance into
// view during the first resolution.
export const LEARN_ZOMBIES = [
  { id: 'z1', start: { col: 8, row: 5 }, advance: { col: 6, row: 5 } }, // → beside the church (melee)
  { id: 'z2', start: { col: 6, row: 3 }, advance: { col: 5, row: 3 } }, // → within Isaac's bow range
];

// The Witch's two-step approach into the guard trap (rounds 1 then 2).
export const LEARN_WITCH_APPROACH = [
  { col: 6, row: 4 },   // round 1: emerges into view
  { col: 5, row: 4 },   // round 2: steps adjacent to the church (the guard trap)
];

// ── Map builder ──────────────────────────────────────────────────────────────

export function buildLearnMap() {
  const COLS = 9, ROWS = 8;
  setMapDimensions(COLS, ROWS);
  const tiles = makeTiles(COLS, ROWS);

  // Buildings (entrance + impassable footprint wall).
  setBuilding(tiles, LEARN_HERO_START.col, LEARN_HERO_START.row, BuildingType.INN,   { col: 3, row: 4 }, 1);
  setBuilding(tiles, LEARN_CHURCH.col,      LEARN_CHURCH.row,     BuildingType.CHURCH, { col: 5, row: 6 }, 0);
  setBuilding(tiles, 7, 2, BuildingType.GRAVEYARD, { col: 7, row: 1 }, 0);

  // River wall down column 4, with a single BRIDGE crossing at row 5.
  for (const row of [0, 1, 2, 3, 4, 6, 7]) setRiver(tiles, 4, row);
  setBridge(tiles, LEARN_BRIDGE.col, LEARN_BRIDGE.row);

  // Road across the bridge linking the Inn to the church and the node beyond,
  // continuing east so the melee zombie can advance a road-hop into reach while
  // starting far enough to stay out of sight.
  addRoad(tiles, { col: 3, row: 5 }, { col: 4, row: 5 });
  addRoad(tiles, { col: 4, row: 5 }, { col: 5, row: 5 });
  addRoad(tiles, { col: 5, row: 5 }, { col: 6, row: 5 });
  addRoad(tiles, { col: 6, row: 5 }, { col: 7, row: 5 });
  addRoad(tiles, { col: 7, row: 5 }, { col: 8, row: 5 });

  // Trees shroud both banks so the Witch's forces stay out of sight until the
  // party crosses — leaving a CLEARING to the north (cols 1-3, rows 1-3, incl.
  // Isaac's vantage at (2,3)) where the bow can see across, and the road open.
  setForest(tiles, [
    // east-bank screen in front of the enemy starts
    { col: 7, row: 3 }, { col: 7, row: 6 },
    { col: 8, row: 4 }, { col: 8, row: 6 }, { col: 8, row: 3 },
    { col: 6, row: 6 }, { col: 6, row: 7 }, { col: 5, row: 7 },
    { col: 6, row: 2 }, { col: 6, row: 4 }, { col: 5, row: 6 },
    // screen the hero's cross-river view of the far zombie (Isaac, north of this,
    // still sees the zombie's advance hex — an endpoint — clearly)
    { col: 5, row: 3 }, { col: 5, row: 2 },
    // west-bank cover south of the road
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
  // Fixed roster characters (forcedName) so the party is identical every time.
  const soldier = createSurvivor(LEARN_SOLDIER.col, LEARN_SOLDIER.row, null, state, LEARN_SOLDIER.name);
  soldier.owner = 'hero';
  _stripScout(soldier);

  const isaac = createSurvivor(LEARN_ISAAC.col, LEARN_ISAAC.row, null, state, LEARN_ISAAC.name);
  isaac.owner = 'hero';
  isaac.equipWeapon(LEARN_ISAAC.weapon);
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
    body: 'Caleb\'s Hollow is a turn based strategy game. You control either a Day or Night faction in a battle over multiple days.',
    trigger: 'click', spotlight: null, tooltipPos: 'center',
  },
  {
    id: 'modes',
    title: 'Plan, Then Resolve',
    body: 'The game is in one of two modes: planning or resolution. In plan mode you see all your units and what they can see. In PLANNING mode you spend your ACTION BUDGET to plan moves, attacks or exploration. When you\'re happy with your plan you SUBMIT.',
    trigger: 'click', spotlight: null, tooltipPos: 'center',
  },
  {
    id: 'resolution',
    title: 'Resolution',
    body: 'In RESOLUTION mode you get to see the plan play out alongside the plans of all the other players in the game. We step through each action and see if your plan was successful. Did the attack land? Did they flee before you struck?',
    trigger: 'click', spotlight: null, tooltipPos: 'center',
  },
  {
    id: 'day_night',
    title: 'The Turning Day',
    body: 'The day cycle advances every turn, as the sun sets the power dynamics shift. The human factions are stronger when the sun is out, the witch factions stronger by moonlight.',
    trigger: 'click', spotlight: null, tooltipPos: 'center',
  },
  {
    id: 'arena',
    title: 'Ishmael\'s Stand',
    body: 'In this battle arena Ishmael and two townsfolk face off against the witch\'s forces.',
    trigger: 'click', spotlight: null, tooltipPos: 'center',
  },

  // ── Round 0: advance (two moves) + share a tile + scout ─────────────────────
  {
    id: 'move_hero',
    title: 'Advance the Hero',
    body: 'Plan a move forward for your hero across the bridge to the church to try and find the enemy. He reaches it in a single move.',
    trigger: { type: 'action_queued', actionType: PlanActionType.MOVE, entityType: EntityType.HERO, toCol: CHURCH.col, toRow: CHURCH.row },
    spotlight: { type: 'hex', col: CHURCH.col, row: CHURCH.row, arrow: 'down' },
    pulse: true, tooltipPos: 'bottom-left',
    allowHexes: [HERO, CHURCH], allowActions: [],
  },
  {
    id: 'move_soldier',
    title: 'Friendly Units Share a Tile',
    body: 'Now move the townsfolk alongside him. Friendly units can share a tile. Thomas is further back, so it takes two moves — click the bridge first, then the church.',
    trigger: { type: 'action_queued', actionType: PlanActionType.MOVE, entityType: EntityType.SURVIVOR, toCol: CHURCH.col, toRow: CHURCH.row },
    spotlight: { type: 'hex', col: CHURCH.col, row: CHURCH.row, arrow: 'down' },
    pulse: true, tooltipPos: 'bottom-left',
    allowHexes: [LEARN_SOLDIER, BRIDGE, CHURCH], allowActions: [],
  },
  {
    id: 'move_isaac',
    title: 'Eyes Across the River',
    body: 'Isaac has a bow, so let\'s move him to a spot where he can see the enemy — the clearing on the north bank, looking across the river.',
    trigger: { type: 'action_queued', actionType: PlanActionType.MOVE, entityType: EntityType.SURVIVOR, toCol: VANTAGE.col, toRow: VANTAGE.row },
    spotlight: { type: 'hex', col: VANTAGE.col, row: VANTAGE.row, arrow: 'down' },
    pulse: true, tooltipPos: 'bottom-left',
    allowHexes: [LEARN_ISAAC, VANTAGE], allowActions: [],
  },
  {
    id: 'selection_hint',
    title: 'Selecting Units',
    body: 'The plan mode shows you what each unit is planning to do. You can select your units in the viewport, in the plan panel, or cycle through them with the Tab key.',
    trigger: 'click', spotlight: null, tooltipPos: 'center',
  },
  {
    id: 'submit_r0',
    title: 'Submit Your Plan',
    body: 'Now you have your turn planned you can SUBMIT it.',
    trigger: { type: 'plan_submitted' },
    spotlight: { type: 'element', selector: '#plan-submit-btn', arrow: 'right' },
    pulse: true, tooltipPos: 'bottom-left',
  },
  {
    id: 'watch_r0',
    title: 'Resolution',
    body: 'Now we enter the resolution mode. Here you can step through each action and see how your plan played out.',
    trigger: 'auto', spotlight: null, tooltipPos: 'top',
  },

  // ── Round 1: combat ─────────────────────────────────────────────────────────
  {
    id: 'combat_intro',
    title: 'Strike!',
    body: 'Now you saw the witch\'s forces enter your field of view. Let\'s attack them. Select the hex with your hero — there are two units there, so choose Ishmael. You can see the % chance to HIT or CRUSH the target next to its icon. Click the zombie to add an ATTACK, then click again to stack two attacks in a row.',
    trigger: { type: 'action_queued', actionType: PlanActionType.BATTLE_UNIT, entityType: EntityType.HERO, count: 2 },
    spotlight: { type: 'hex', col: Z1.col, row: Z1.row, arrow: 'down' },
    pulse: true, tooltipPos: 'bottom-left',
    allowHexes: [CHURCH, Z1], allowActions: [],
  },
  {
    id: 'combat_explain',
    title: 'How Combat Works',
    body: 'Allies next to your target join any attacks and make a big difference, but defenders also join in to balance it out. The sure-fire way to win a battle is with strength in numbers.',
    trigger: 'click', spotlight: null, tooltipPos: 'center',
  },
  {
    id: 'ranged',
    title: 'Loose an Arrow',
    body: 'Now let\'s get the other zombie. Isaac has a bow so he can attack at a distance. Select Isaac and click on the other zombie.',
    trigger: { type: 'action_queued', actionType: PlanActionType.BATTLE_UNIT, entityType: EntityType.SURVIVOR },
    spotlight: { type: 'hex', col: Z2.col, row: Z2.row, arrow: 'down' },
    pulse: true, tooltipPos: 'bottom-left',
    allowHexes: [VANTAGE, Z2], allowActions: [],
  },
  {
    id: 'submit_r1',
    title: 'Submit and Fight',
    body: 'Ok, you\'ve loaded up some actions, now let\'s SUBMIT.',
    trigger: { type: 'plan_submitted' },
    spotlight: { type: 'element', selector: '#plan-submit-btn', arrow: 'right' },
    pulse: true, tooltipPos: 'bottom-left',
  },
  {
    id: 'watch_r1',
    title: 'The Zombies Fall',
    body: 'Great work, the zombies are gone but the witch is coming. Prepare for an assault.',
    trigger: 'auto', spotlight: null, tooltipPos: 'top',
  },

  // ── Round 2: fortify + guard ────────────────────────────────────────────────
  {
    id: 'fortify_intro',
    title: 'Dig In',
    body: 'You can fortify locations by using resources. Select a unit and have them fortify the building they are in.',
    trigger: { type: 'action_queued', actionType: PlanActionType.FORTIFY },
    spotlight: { type: 'hex', col: CHURCH.col, row: CHURCH.row, arrow: 'down' },
    pulse: true, tooltipPos: 'bottom-left',
    allowHexes: [CHURCH], allowActions: [ActionType.FORTIFY],
  },
  {
    id: 'guard_intro',
    title: 'Set a Trap',
    body: 'We\'re not going to leave this spot, but we know the witch is coming — so we should be ready. Select the Guard action: your unit will prep for one opportunity attack if an enemy moves within range. You can stack multiple guards for more reactions, and Auto-Guard fills the rest of your budget with guards.',
    trigger: { type: 'action_queued', actionType: PlanActionType.GUARD },
    spotlight: { type: 'hex', col: CHURCH.col, row: CHURCH.row, arrow: 'down' },
    pulse: true, tooltipPos: 'bottom-left',
    allowHexes: [CHURCH], allowActions: [ActionType.GUARD],
  },
  {
    id: 'submit_r2',
    title: 'Submit and Hold',
    body: 'Submit your plan and brace for the assault.',
    trigger: { type: 'plan_submitted' },
    spotlight: { type: 'element', selector: '#plan-submit-btn', arrow: 'right' },
    pulse: true, tooltipPos: 'bottom-left',
  },
  {
    id: 'watch_r2',
    title: 'Into the Trap',
    body: 'The witch stepped right into your trap, but she still managed to do some damage to you AND your fortifications.',
    trigger: 'auto', spotlight: null, tooltipPos: 'top',
  },

  // ── Round 3: nodes + handoff to free play ───────────────────────────────────
  {
    id: 'node_intro',
    title: 'Power Nodes',
    body: 'Killing the witch is one way to win the battle, but the more tactical path is to control the majority of POWER NODES on the map. The highlighted hexes are controlled by whoever has the most units present. At dawn and dusk each day, the faction with the most power nodes in their control scores. Four points and the battle is yours.',
    trigger: 'click',
    spotlight: { type: 'hex', col: CHURCH.col, row: CHURCH.row, arrow: 'down' },
    pulse: true, tooltipPos: 'center',
  },
  {
    id: 'good_luck',
    title: 'The Battle Is Yours',
    body: 'Now, try and hold the power node or defeat the witch. Good luck.',
    trigger: 'handoff', buttonLabel: 'Play on →',
    spotlight: null, tooltipPos: 'center',
  },
];
