// Serialize / deserialize a live GameState instance.
// serializeState  → plain JSON-safe snapshot (network transmission, save storage)
// deserializeState ← reconstruct a live GameState from a saved snapshot (resume)
import { VERSION }           from '../src/version.js';
import { Entity, BASE_AGILITY, BASE_RANGE } from '../src/entities.js';
import { GameState }         from '../src/game.js';
import { setMapDimensions, hexKey }  from '../src/hex.js';
import { Tile, TileType, legacyTileType, decomposeTileType } from '../src/tiles.js';
import { pickFootprintNeighbor } from '../src/building-footprint.js';

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
      // Layered tile model (P1): serialize the three explicit layers so the
      // canonical shape round-trips losslessly — crucially a road/building over
      // a non-grass base (e.g. road-through-forest) preserves its `base`, which
      // the derived `type` enum alone cannot express. The vestigial `type` is
      // still emitted (derived via legacyTileType) so the legacy-snapshot
      // reconstruction fallback in deserializeState — and any external legacy
      // reader — keeps working; base/structure/path are the canonical fields.
      base:           tile.base ?? TileType.GRASS,
      structure:      tile.structure ?? null,
      path:           tile.path ?? null,
      type:           legacyTileType(tile),
      building:       tile.building       ?? null,
      resource:       tile.resource       ?? null,
      fortifyLevel:   tile.fortifyLevel   ?? 0,
      explored:       tile.explored       ?? false,
      hiddenSurvivor: tile.hiddenSurvivor ?? false,
      roadDirs:       tile.roadDirs ? [...tile.roadDirs] : [],
      // Building footprint (P1). Entrances carry footprintHexes; footprint hexes
      // carry the buildingFootprintOf back-pointer. Both default to []/null.
      footprintHexes:      Array.isArray(tile.footprintHexes) ? [...tile.footprintHexes] : [],
      buildingFootprintOf: tile.buildingFootprintOf ?? null,
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
    agility:       e.agility ?? BASE_AGILITY[e.type] ?? 1,
    range:         e.range   ?? BASE_RANGE[e.type]   ?? 1,
    attackBonus:   e.attackBonus,
    defenseBonus:  e.defenseBonus,
    weapon:        e.weapon        ?? null,
    name:          e.name          ?? null,
    title:         e.title         ?? null,
    bio:           e.bio           ?? null,
    abilities:     Array.isArray(e.abilities) ? [...e.abilities] : [],
    abilityLabel:  e.abilityLabel  ?? null,
    // factionId — concrete faction (e.g. 'rogue', 'captain') vs the side
    // string in `owner`. Required so faction-specific overrides
    // (canEquipWeaponItem, modifyLootRoll, onAfterMoveStep, sight bonuses)
    // survive the wire/save roundtrip. Without this field the rogue
    // silently reverts to paladin behaviour after each round of state-sync.
    factionId:     e.factionId     ?? null,
    actedThisTurn: e.actedThisTurn ?? false,
    defendCount:   e.defendCount   ?? 0,
    guarding:      e.guarding      ?? 0,
    killsThisRound: e.killsThisRound ?? 0,
    effects:       Array.isArray(e.effects)
      ? e.effects.map(rec => ({ ...rec }))
      : [],
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
    disableCycleBar:      !!state.disableCycleBar,
    disableNodeSweep:     !!state.disableNodeSweep,
    disableScoreWin:      !!state.disableScoreWin,
    nodeScoreThreshold:   state.nodeScoreThreshold ?? 4,
    noWitchMission:       !!state.noWitchMission,
    gameMode:             state.gameMode ?? 'standard',
    battleConfig:         state.battleConfig ? { ...state.battleConfig } : null,
    cycleConfig:          state.cycleConfig
      ? {
          phases: [...state.cycleConfig.phases],
          loop:   state.cycleConfig.loop,
          ...(state.cycleConfig.extraScoringPhases
              ? { extraScoringPhases: [...state.cycleConfig.extraScoringPhases] }
              : {}),
          ...(state.cycleConfig.extendOnWitchScore
              ? { extendOnWitchScore: [...state.cycleConfig.extendOnWitchScore] }
              : {}),
        }
      : null,
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
    season:               state.season ?? null,
    campaignAIBudgetBonus: state.campaignAIBudgetBonus ?? 0,
    // Per-state entity/roster counters. Persisting `usedRosterIndices` prevents
    // duplicate survivor names when a mid-game save is resumed and new
    // survivors spawn from unexplored buildings. nextEntityId is informational;
    // on resume we derive the floor from the max restored entity id anyway.
    // `forcedDice` is intentionally NOT persisted — it's a per-round tutorial
    // scratch queue re-populated by the mission conductor each planning phase.
    nextEntityId:         state.nextEntityId ?? 1,
    usedRosterIndices:    [...(state.usedRosterIndices ?? [])],
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
  // Reconstruct each tile as a real `Tile` instance (matching the live map-gen
  // representation) so the layered model and the baseOf/pathOf/structureOf
  // accessors all return correct values downstream.
  //
  // Two snapshot shapes are handled:
  //   • NEW saves (P1+): carry explicit `base`/`structure`/`path` layers. These
  //     are restored DIRECTLY — routing through the `type` shim would be lossy
  //     (e.g. a road over forest serializes base='forest', path='road', but
  //     `type` is just 'road', so re-deriving from `type` would reset base to
  //     the grass default and drop the forest cover).
  //   • LEGACY saves: carry only the derived `type` enum (no layer fields).
  //     `decomposeTileType()` produces the correct (base, structure, path) —
  //     the single source of that mapping.
  state.tiles = new Map();
  for (const t of snap.tiles) {
    const tile = new Tile(t.col, t.row);
    const hasLayers = t.base !== undefined || t.structure !== undefined || t.path !== undefined;
    if (hasLayers) {
      tile.base      = t.base      ?? TileType.GRASS;
      tile.structure = t.structure ?? null;
      tile.path      = t.path      ?? null;
    } else {
      // Legacy snapshot — decompose the single `type` into the three layers.
      decomposeTileType(tile, t.type);
    }
    tile.building       = t.building       ?? null;
    tile.resource       = t.resource       ?? null;
    tile.fortifyLevel   = t.fortifyLevel   ?? 0;
    tile.explored       = t.explored       ?? false;
    tile.hiddenSurvivor = t.hiddenSurvivor ?? false;
    tile.roadDirs       = new Set(t.roadDirs || []);
    // Building footprint (P1). Restore as real fields; legacy snapshots lack
    // them → defaults, then the migration pass below populates them.
    tile.footprintHexes      = Array.isArray(t.footprintHexes) ? [...t.footprintHexes] : [];
    tile.buildingFootprintOf = t.buildingFootprintOf ?? null;
    state.tiles.set(t.key, tile);
  }

  // ── Building-footprint auto-migration (P1) ────────────────────────────────
  // Pre-v6 saves (and any building authored without a footprint) have a
  // `building` but an empty `footprintHexes`. Assign each unmigrated entrance
  // one eligible adjacent footprint hex, deterministically.
  migrateBuildingFootprints(state.tiles, snap);

  // ── Entities — restore as real Entity instances so game-logic methods work ─
  state.entities = snap.entities.map(data => {
    const e = Object.create(Entity.prototype);
    Object.assign(e, data, {
      items:   { ...(data.items   || {}) },
      effects: Array.isArray(data.effects) ? data.effects.map(r => ({ ...r })) : [],
    });
    // Ensure ownerId is present even on saves from before the multiplayer update
    if (e.ownerId === undefined) e.ownerId = null;
    // Back-compat for pre-effects saves
    if (!Array.isArray(e.effects)) e.effects = [];
    if (e.killsThisRound === undefined) e.killsThisRound = 0;
    // Hero → Paladin entity-type rename. Pre-PR4 saves carry type='hero';
    // re-key them to 'paladin' so the new BASE_STATS/BASE_AGILITY tables
    // and `e.type === EntityType.PALADIN` checks all line up.
    if (e.type === 'hero') e.type = 'paladin';
    // Back-compat hydrate Agility for pre-002 saves.
    if (e.agility === undefined) e.agility = BASE_AGILITY[e.type] ?? 1;
    // Back-compat hydrate Range for pre-ranged-attacks saves. New games
    // set `range` in the Entity constructor; old snapshots default to the
    // unit-type's registry value (1 for every existing unit except witch).
    if (e.range === undefined) e.range = BASE_RANGE[e.type] ?? 1;
    // Back-compat: pre-PR factionId. Saves from before the rogue PR
    // don't carry factionId; fall back to null so factionOf(actor) →
    // getFaction(owner) — i.e. the side default. Saves that DO carry
    // factionId restore the concrete faction.
    if (e.factionId === undefined) e.factionId = null;
    return e;
  });

  // Advance the per-state counter past every restored ID; GameState.bumpEntityId
  // also advances the module-level counter so any standalone createFoo() paths
  // (editor previews, legacy tests) never collide with restored entities.
  const maxId = snap.entities.reduce((max, e) => {
    const n = parseInt(e.id?.slice(1) ?? '0', 10);
    return isNaN(n) ? max : Math.max(max, n);
  }, 0);
  state.bumpEntityId(maxId);

  // Restore per-state roster tracker if the snapshot carries it; older saves
  // that predate this field will keep the fresh empty set from the
  // constructor. nextEntityId is re-derived by the bump above.
  if (Array.isArray(snap.usedRosterIndices)) {
    state.usedRosterIndices = new Set(snap.usedRosterIndices);
  }

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
  state.disableCycleBar      = !!snap.disableCycleBar;
  state.disableNodeSweep     = !!snap.disableNodeSweep;
  state.disableScoreWin      = !!snap.disableScoreWin;
  state.nodeScoreThreshold   = snap.nodeScoreThreshold ?? 4;
  state.noWitchMission       = !!snap.noWitchMission;
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
  state.season               = snap.season    ?? null;
  state.winner               = snap.winner    ?? null;
  state.winReason            = snap.winReason ?? null;
  state.heroKills            = snap.heroKills        ?? 0;
  state.witchKills           = snap.witchKills       ?? 0;
  state.witchSummonCount     = snap.witchSummonCount ?? 0;
  state.heroRevealedByHorn   = snap.heroRevealedByHorn ?? false;
  state.campaignAIBudgetBonus = snap.campaignAIBudgetBonus ?? 0;
  state.gameMode             = snap.gameMode ?? 'standard';
  state.battleConfig         = snap.battleConfig ? { ...snap.battleConfig } : null;
  state.cycleConfig          = snap.cycleConfig
    ? {
        phases: [...snap.cycleConfig.phases],
        loop:   snap.cycleConfig.loop,
        ...(snap.cycleConfig.extraScoringPhases
            ? { extraScoringPhases: [...snap.cycleConfig.extraScoringPhases] }
            : {}),
        ...(snap.cycleConfig.extendOnWitchScore
            ? { extendOnWitchScore: [...snap.cycleConfig.extendOnWitchScore] }
            : {}),
      }
    : null;

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

/**
 * Auto-migrate buildings that lack a footprint (P1).
 *
 * For each ENTRANCE tile (`building != null`) whose `footprintHexes` is empty,
 * pick one eligible adjacent hex and wire both fields: the entrance's
 * `footprintHexes` gets the chosen key, the chosen hex's `buildingFootprintOf`
 * points back at the entrance.
 *
 * Eligibility for a neighbour to become a footprint hex is delegated to the
 * shared `eligibleFootprintNeighbors`/`pickFootprintNeighbor` helper
 * (`src/building-footprint.js`) so map-gen and migration apply identical rules:
 *   • in map bounds (the tile exists in the map)
 *   • base !== 'river' AND path !== 'river' AND path !== 'bridge' AND
 *     path !== 'road'  (the road exclusion now applies to migration too — a road
 *     can never be turned into an impassable footprint)
 *   • not itself a building (`building == null`)
 *   • not already claimed as another building's footprint
 *   • not a power-node hex (derived from snap.witchObjectives, passed as
 *     `opts.nodeKeySet`)
 *   • (start-hex exclusion is skipped — start positions aren't in the snapshot,
 *      so this is best-effort per the migration spec)
 *
 * Deterministic pick: the helper takes neighbours in odd-r direction order
 * (0..5) and returns the FIRST eligible one (no `rand` passed). Buildings are
 * processed in sorted-key order so the same snapshot loaded twice yields
 * identical results.
 *
 * Orphans (no eligible neighbour) keep `footprintHexes: []` and emit a single
 * console.warn — P3 treats them as regular 1-hex buildings.
 *
 * @param {Map<string, Tile>} tiles  the reconstructed tile map (mutated in place)
 * @param {object} snap              the snapshot (for witchObjectives → node hexes)
 */
function migrateBuildingFootprints(tiles, snap) {
  // Power-node hexes are excluded as footprint candidates.
  const nodeKeySet = new Set();
  for (const o of snap.witchObjectives ?? []) {
    for (const h of o.hexes ?? [{ col: o.col, row: o.row }]) {
      nodeKeySet.add(hexKey(h.col, h.row));
    }
  }

  // Deterministic building order: sort entrance keys (row, then col).
  const entranceKeys = [];
  for (const [key, tile] of tiles) {
    if (tile.building != null && (!Array.isArray(tile.footprintHexes) || tile.footprintHexes.length === 0)) {
      entranceKeys.push(key);
    }
  }
  entranceKeys.sort((a, b) => {
    const [ac, ar] = a.split(',').map(Number);
    const [bc, br] = b.split(',').map(Number);
    return ar - br || ac - bc;
  });

  for (const key of entranceKeys) {
    const entrance = tiles.get(key);
    // First eligible neighbour (no rand → deterministic). The shared helper
    // applies the full eligibility rules including the road exclusion; because
    // we write `buildingFootprintOf` as we go, hexes claimed by an
    // already-processed building are skipped automatically — no separate
    // `claimed` set needed.
    const chosen = pickFootprintNeighbor(tiles, entrance.col, entrance.row, null, { nodeKeySet });
    if (chosen) {
      const nk = hexKey(chosen.col, chosen.row);
      entrance.footprintHexes = [nk];
      tiles.get(nk).buildingFootprintOf = key;
    } else {
      // Orphan building — no eligible neighbour. Leave empty; warn once.
      console.warn(`[state-sync] building at ${key} has no eligible footprint hex (orphan; treated as 1-hex)`);
    }
  }
}
