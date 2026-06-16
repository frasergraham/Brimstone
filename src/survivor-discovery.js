// Survivor / NPC discovery — extracted from actions.js so both the move
// and explore action paths share the implementation, AND so faction
// overrides (e.g. RogueFaction.onAfterMoveStep) can call into the same
// reveal logic without re-importing actions.js (which would create a
// circular import via factions.js).
//
// Reveals and materialises a hidden survivor (or zombie for the witch)
// on a tile. Clears the tile's hiddenSurvivor flag and returns
// { encounterLog, encounterSurvivor } | null when the tile has nothing
// hidden or the campaign discovery cap has been reached.

import { hexKey } from './hex.js';
import { pickUnitSlot } from './hex-slots.js';
import { getFaction } from './factions.js';

/** The stable logic `ref` a placed hidden survivor binds to: its pinned roster
 *  name, or a hex-derived id for a random one. MUST match the discovery above. */
export function survivorRef(hiddenSurvivorId, col, row) {
  return hiddenSurvivorId || `survivor_${col}_${row}`;
}

export function triggerSurvivorEncounter(state, actor, col, row) {
  const st = state.tiles.get(hexKey(col, row));
  if (!st?.hiddenSurvivor) return null;

  const faction = getFaction(actor.owner);

  // Campaign cap: skip encounter if faction already found max discoverable NPCs
  if (faction.canDiscoverNPCs() &&
      state.maxDiscoverableSurvivors != null &&
      state.discoveredSurvivorCount >= state.maxDiscoverableSurvivors) {
    st.hiddenSurvivor = false;
    return null;
  }

  // Authored missions may pin a specific roster survivor to this tile.
  const forcedSurvivorId = st.hiddenSurvivorId ?? null;
  // …and an optional spawn level so future-chapter recruits arrive scaled.
  // Default 1 (no scaling). Ignored by the witch's zombie discovery.
  const forcedSurvivorLevel = st.hiddenSurvivorLevel ?? 1;

  st.hiddenSurvivor = false;
  st.hiddenSurvivorId = null;
  st.hiddenSurvivorLevel = null;

  const entity = faction.createDiscoveryEntity(col, row, actor.ownerId, state, forcedSurvivorId, forcedSurvivorLevel);
  // The discovered survivor carries a stable logic `ref` so an On Actor (OnSpawn)
  // node can fire when THIS survivor is found — e.g. to start a conversation. A
  // pinned survivor uses its pin; a random one uses its hex (matches the editor's
  // Survivor node — keep `survivorRef` below in sync). Hero discovery only (the
  // witch's "discovery" turns survivors into zombies).
  if (faction.canDiscoverNPCs()) entity.ref = forcedSurvivorId ?? `survivor_${col}_${row}`;
  // Pick a sub-hex slot around whoever is already on this tile (the discovering
  // actor, at least) and the tile's blocked tree/bridge slots.
  const occupied = state.entities
    .filter(e => e.alive && e.col === col && e.row === row)
    .map(e => e.slot ?? 0);
  entity.slot = pickUnitSlot(st.blockedSlots ?? [], occupied);
  state.entities.push(entity);
  if (faction.canDiscoverNPCs()) {
    state.discoveredSurvivorCount = (state.discoveredSurvivorCount || 0) + 1;
  }
  const result = faction.buildDiscoveryResult(entity);
  return {
    encounterLog: [...result.encounterLog],
    encounterSurvivor: result.encounterSurvivor,
  };
}
