// Serialize a live GameState instance into a plain JSON-safe snapshot.
// The client uses this snapshot to construct a MirrorState for rendering.
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
    // alive is omitted — MirrorEntity derives it from hp via getter
  }));

  return {
    phase:                state.phase,
    round:                state.round,
    activePlayer:         state.activePlayer,
    actionsLeft:          state.actionsLeft,
    witchIsAI:            state.witchIsAI,
    heroIsAI:             state.heroIsAI,
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
    witchSummonsThisTurn: state.witchSummonsThisTurn,
    attritionLevel:       state.attritionLevel,
    nodeScore:            { ...state.nodeScore },
    log:                  [...state.log],
    witchObjectives:      state.witchObjectives.map(o => ({ ...o })),
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
