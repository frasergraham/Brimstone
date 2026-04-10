// Serialize / deserialize a live GameState instance.
// serializeState  → plain JSON-safe snapshot (network transmission, save storage)
// deserializeState ← reconstruct a live GameState from a saved snapshot (resume)
import { VERSION }           from '../src/version.js';
import { Entity, bumpEntityId } from '../src/entities.js';
import { GameState }         from '../src/game.js';
import { setMapDimensions }  from '../src/hex.js';

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
    defendCount:   e.defendCount   ?? 0,
    guarding:      e.guarding      ?? 0,
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
    // Players registry (multiplayer) — spread includes respawnRound if present
    players:              (state.players ?? []).map(p => ({ ...p })),
    // Simultaneous-turn planning fields
    planningPhase:        state.planningPhase   ?? false,
    resolving:            state.resolving       ?? false,
    heroReady:            state.heroReady        ?? false,
    witchReady:           state.witchReady       ?? false,
    heroActionsLeft:      state.heroActionsLeft  ?? 0,
    witchActionsLeft:     state.witchActionsLeft ?? 0,
    fogOfWar:             state.fogOfWar,
    exploredHexes: Object.fromEntries(
      Object.entries(state.exploredHexes ?? {}).map(([k, v]) => [k, [...(v ?? [])]])
    ),
    winner:               state.winner,
    winReason:            state.winReason,
    attritionLevel:       state.attritionLevel,
    attritionChanged:     state.attritionChanged ?? false,
    heroKills:            state.heroKills        ?? 0,
    witchKills:           state.witchKills       ?? 0,
    witchSummonCount:     state.witchSummonCount ?? 0,
    heroRevealedByHorn:   state.heroRevealedByHorn ?? false,
    nodeScore:            { ...state.nodeScore },
    disableScoring:       !!state.disableScoring,
    gameMode:             state.gameMode ?? 'standard',
    battleConfig:         state.battleConfig ? { ...state.battleConfig } : null,
    maxDiscoverableSurvivors: state.maxDiscoverableSurvivors ?? null,
    discoveredSurvivorCount:  state.discoveredSurvivorCount ?? 0,
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
    missionTargetHex:     state.missionTargetHex
      ? { col: state.missionTargetHex.col, row: state.missionTargetHex.row,
          color: state.missionTargetHex.color, label: state.missionTargetHex.label,
          seen: state.missionTargetHex.seen ?? false }
      : null,
    inventory:            JSON.parse(JSON.stringify(state.inventory)),
    postRoundEvents:      [...(state.postRoundEvents || [])],
    nodeSpawnedSurvivors: [...(state.nodeSpawnedSurvivors || [])],
    heroId:               state.hero?.id  ?? null,
    witchId:              state.witch?.id ?? null,
    mapCols,
    mapRows,
    mapSize:              state.mapSize ?? 'standard',
    campaignAIBudgetBonus: state.campaignAIBudgetBonus ?? 0,
    // Per-player planning state (multiplayer) — serialized so hibernated saves
    // don't lose submitted plans.  Maps are converted to plain objects for JSON.
    planning: (state.playerPlans?.size > 0 || state.playerReady?.size > 0) ? {
      plans:   Object.fromEntries(state.playerPlans   ?? new Map()),
      ready:   Object.fromEntries(state.playerReady   ?? new Map()),
      budgets: Object.fromEntries(state.playerActionsLeft ?? new Map()),
    } : null,
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

  // Restore global hex math dimensions so neighbor/distance calculations use the
  // correct grid size. The constructor above generated a default-size map which
  // set MAP_COLS/MAP_ROWS to standard defaults; overwrite them now.
  setMapDimensions(snap.mapCols, snap.mapRows);

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
  state.attritionLevel       = snap.attritionLevel       ?? 1;
  state.attritionChanged     = snap.attritionChanged     ?? false;
  state.nodeScore            = { ...snap.nodeScore };
  state.disableScoring       = !!snap.disableScoring;
  state.maxDiscoverableSurvivors = snap.maxDiscoverableSurvivors ?? null;
  state.discoveredSurvivorCount  = snap.discoveredSurvivorCount  ?? 0;
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
  state.missionTargetHex     = snap.missionTargetHex
    ? { col: snap.missionTargetHex.col, row: snap.missionTargetHex.row,
        color: snap.missionTargetHex.color, label: snap.missionTargetHex.label,
        seen: snap.missionTargetHex.seen ?? false }
    : null;
  state.inventory            = JSON.parse(JSON.stringify(snap.inventory));
  // Backward compat: rename 'shared' → 'hero' for saves predating the refactor.
  if (state.inventory.shared && !state.inventory.hero) {
    state.inventory.hero = state.inventory.shared;
    delete state.inventory.shared;
  }
  state.postRoundEvents      = [...(snap.postRoundEvents || [])];
  state.nodeSpawnedSurvivors = [...(snap.nodeSpawnedSurvivors || [])];
  // Backward compat: old saves stored fogOfWar as boolean
  state.fogOfWar             = typeof snap.fogOfWar === 'boolean'
    ? (snap.fogOfWar ? 'partial' : 'none')
    : (snap.fogOfWar ?? 'none');
  // Restore per-faction explored hex Sets. Backward compat: if missing, keep the
  // constructor's defaults (which initializes empty Sets for all registered factions).
  if (snap.exploredHexes) {
    for (const [k, v] of Object.entries(snap.exploredHexes)) {
      state.exploredHexes[k] = new Set(v ?? []);
    }
  }
  state.mapSize              = snap.mapSize   ?? 'standard';
  state.winner               = snap.winner    ?? null;
  state.winReason            = snap.winReason ?? null;
  state.heroKills            = snap.heroKills        ?? 0;
  state.witchKills           = snap.witchKills       ?? 0;
  state.witchSummonCount     = snap.witchSummonCount ?? 0;
  state.heroRevealedByHorn   = snap.heroRevealedByHorn ?? false;
  state.campaignAIBudgetBonus = snap.campaignAIBudgetBonus ?? 0;
  state.gameMode             = snap.gameMode ?? 'standard';
  state.battleConfig         = snap.battleConfig ? { ...snap.battleConfig } : null;

  // ── Planning fields ──────────────────────────────────────────────────────
  state.planningPhase    = snap.planningPhase ?? false;
  state.resolving        = snap.resolving     ?? false;
  state.heroPlan         = null;
  state.witchPlan        = null;
  state.heroReady        = snap.heroReady     ?? false;
  state.witchReady       = snap.witchReady    ?? false;
  state.heroActionsLeft  = snap.heroActionsLeft  ?? 0;
  state.witchActionsLeft = snap.witchActionsLeft ?? 0;
  state.planningDeadline = null;

  // Restore per-player planning data if serialized (new saves); otherwise
  // leave empty Maps for the caller (recoverRoom) to populate from DB.
  if (snap.planning) {
    state.playerPlans       = new Map(Object.entries(snap.planning.plans   ?? {}));
    state.playerReady       = new Map(Object.entries(snap.planning.ready   ?? {}).map(([k, v]) => [k, !!v]));
    state.playerActionsLeft = new Map(Object.entries(snap.planning.budgets ?? {}).map(([k, v]) => [k, Number(v)]));
  } else {
    state.playerPlans       = new Map();
    state.playerReady       = new Map();
    state.playerActionsLeft = new Map();
  }

  return state;
}
