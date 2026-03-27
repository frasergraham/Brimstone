// Serialize / deserialize a live GameState instance.
// serializeState  → plain JSON-safe snapshot (network transmission, save storage)
// deserializeState ← reconstruct a live GameState from a saved snapshot (resume)
import { VERSION }           from '../src/version.js';
import { Entity, bumpEntityId } from '../src/entities.js';
import { GameState }         from '../src/game.js';

export function serializeState(state) {
  const tiles = [];
  let mapCols = 0, mapRows = 0;
  for (const [key, tile] of state.tiles) {
    if (tile.col + 1 > mapCols) mapCols = tile.col + 1;
    if (tile.row + 1 > mapRows) mapRows = tile.row + 1;
    tiles.push({
      key,
      col:            tile.col,
      row:            tile.row,
      type:           tile.type,
      building:       tile.building       ?? null,
      road:           tile.road           ?? false,
      river:          tile.river          ?? false,
      bridge:         tile.bridge         ?? false,
      fortifyLevel:   tile.fortifyLevel   ?? 0,
      explored:       tile.explored       ?? false,
      hiddenSurvivor: tile.hiddenSurvivor ?? false,
      roadDirs:       tile.roadDirs ? [...tile.roadDirs] : [],
    });
  }

  const entities = state.entities.map(e => ({
    id:            e.id,
    type:          e.type,
    owner:         e.owner,
    ownerId:       e.ownerId       ?? null,   // player UUID — new multiplayer field
    color:         e.color         ?? null,   // per-player color override
    col:           e.col,
    row:           e.row,
    hp:            e.hp,
    maxHp:         e.maxHp,
    attack:        e.attack,
    defense:       e.defense,
    attackBonus:   e.attackBonus,
    defenseBonus:  e.defenseBonus,
    weapon:        e.weapon        ?? null,
    name:          e.name          ?? null,
    title:         e.title         ?? null,
    bio:           e.bio           ?? null,
    ability:       e.ability       ?? null,
    abilityLabel:  e.abilityLabel  ?? null,
    actedThisTurn: e.actedThisTurn ?? false,
    items:         { ...e.items },
    // alive is omitted — Entity derives it from hp via getter
  }));

  return {
    version:              VERSION,
    phase:                state.phase,
    round:                state.round,
    activePlayer:         state.activePlayer,
    actionsLeft:          state.actionsLeft,
    witchIsAI:            state.witchIsAI,
    heroIsAI:             state.heroIsAI,
    // Players registry (multiplayer)
    players:              (state.players ?? []).map(p => ({ ...p })),
    // Simultaneous-turn planning fields
    planningPhase:        state.planningPhase   ?? false,
    resolving:            state.resolving       ?? false,
    heroReady:            state.heroReady        ?? false,
    witchReady:           state.witchReady       ?? false,
    heroActionsLeft:      state.heroActionsLeft  ?? 0,
    witchActionsLeft:     state.witchActionsLeft ?? 0,
    fogOfWar:             state.fogOfWar,
    winner:               state.winner,
    winReason:            state.winReason,
    attritionLevel:       state.attritionLevel,
    attritionChanged:     state.attritionChanged ?? false,
    nodeScore:            { ...state.nodeScore },
    log:                  [...state.log],
    witchObjectives:      state.witchObjectives.map(o => ({
      col:        o.col,
      row:        o.row,
      label:      o.label,
      color:      o.color      ?? '#22c55e',
      hexes:      (o.hexes ?? [{ col: o.col, row: o.row }]).map(h => ({ col: h.col, row: h.row })),
      seenByHero:  o.seenByHero  ?? false,
      seenByWitch: o.seenByWitch ?? false,
      prevCtrl:    o.prevCtrl    ?? 'neutral',
    })),
    inventory:            JSON.parse(JSON.stringify(state.inventory)),
    lastNightDamage:      [...(state.lastNightDamage || [])],
    lastDayDamage:        [...(state.lastDayDamage   || [])],
    lastHazardLog:        [...(state.lastHazardLog   || [])],
    heroId:               state.hero?.id  ?? null,
    witchId:              state.witch?.id ?? null,
    mapCols,
    mapRows,
    tiles,
    entities,
  };
}

/**
 * Reconstruct a live GameState from a serialized snapshot.
 * Calls the GameState constructor to get a properly-prototyped instance,
 * then overwrites all data fields from the snapshot.
 */
export function deserializeState(snap) {
  // Construct a throw-away GameState just to get a prototyped instance.
  const state = new GameState(snap.witchIsAI ?? false, snap.heroIsAI ?? false);

  // ── Tiles ─────────────────────────────────────────────────────────────────
  state.tiles = new Map();
  for (const t of snap.tiles) {
    state.tiles.set(t.key, { ...t, roadDirs: new Set(t.roadDirs || []) });
  }

  // ── Entities — restore as real Entity instances so game-logic methods work ─
  state.entities = snap.entities.map(data => {
    const e = Object.create(Entity.prototype);
    Object.assign(e, data, { items: { ...(data.items || {}) } });
    // Ensure ownerId is present even on saves from before the multiplayer update
    if (e.ownerId === undefined) e.ownerId = null;
    return e;
  });

  // Advance the global ID counter past every restored ID to prevent collisions.
  const maxId = snap.entities.reduce((max, e) => {
    const n = parseInt(e.id?.slice(1) ?? '0', 10);
    return isNaN(n) ? max : Math.max(max, n);
  }, 0);
  bumpEntityId(maxId);

  // ── Leader references ─────────────────────────────────────────────────────
  state.hero  = state.entities.find(e => e.id === snap.heroId)  ?? null;
  state.witch = state.entities.find(e => e.id === snap.witchId) ?? null;

  // ── Players registry ──────────────────────────────────────────────────────
  // Restore if present (multiplayer saves); synthesize 2-player entries otherwise.
  if (snap.players && snap.players.length > 0) {
    state.players = snap.players.map(p => ({ ...p }));
  } else {
    // Legacy 1v1 save: reconstruct synthetic player entries from hero/witch leaders.
    state.players = [];
    if (state.hero)  state.players.push({ id: 'hero',  name: 'Hero',  faction: 'hero',  isAI: snap.heroIsAI  ?? false, leaderId: state.hero.id  });
    if (state.witch) state.players.push({ id: 'witch', name: 'Witch', faction: 'witch', isAI: snap.witchIsAI ?? false, leaderId: state.witch.id });
  }

  // ── Scalar game fields ───────────────────────────────────────────────────
  state.phase                = snap.phase;
  state.round                = snap.round;
  state.activePlayer         = snap.activePlayer;
  state.actionsLeft          = snap.actionsLeft;
  state.attritionLevel       = snap.attritionLevel       ?? 0;
  state.attritionChanged     = snap.attritionChanged     ?? false;
  state.nodeScore            = { ...snap.nodeScore };
  state.log                  = [...snap.log];
  state.witchObjectives      = snap.witchObjectives.map(o => ({
    col:        o.col,
    row:        o.row,
    label:      o.label,
    color:      o.color      ?? '#22c55e',
    hexes:      (o.hexes ?? [{ col: o.col, row: o.row }]).map(h => ({ col: h.col, row: h.row })),
    seenByHero:  o.seenByHero  ?? false,
    seenByWitch: o.seenByWitch ?? false,
    prevCtrl:    o.prevCtrl    ?? 'neutral',
  }));
  state.inventory            = JSON.parse(JSON.stringify(snap.inventory));
  state.lastNightDamage      = [...(snap.lastNightDamage || [])];
  state.lastDayDamage        = [...(snap.lastDayDamage   || [])];
  state.lastHazardLog        = [...(snap.lastHazardLog   || [])];
  state.fogOfWar             = snap.fogOfWar;
  state.winner               = snap.winner    ?? null;
  state.winReason            = snap.winReason ?? null;

  // ── Planning fields — reset to clean pre-planning state ──────────────────
  state.planningPhase    = false;
  state.resolving        = false;
  state.heroPlan         = null;
  state.witchPlan        = null;
  state.heroReady        = false;
  state.witchReady       = false;
  state.heroActionsLeft  = snap.heroActionsLeft  ?? 0;
  state.witchActionsLeft = snap.witchActionsLeft ?? 0;
  state.playerPlans       = new Map();
  state.playerReady       = new Map();
  state.playerActionsLeft = new Map();
  state.planningDeadline  = null;

  return state;
}
