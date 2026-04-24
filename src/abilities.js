// ABILITIES registry — single source of truth for the 8 survivor
// abilities.
//
// Phase 1 captures id / kind / label / description metadata so the
// SurvivorAbility enum can derive from this registry. Phase 4 will add
// statMods (for passives like BRAWLER / STURDY) and execute / hooks
// (for actives like HEAL / INSPIRE / RALLY). Faction-innate abilities
// (sound_horn, summon) are registered here in Phase 5 when leader
// action gates move off the isLeaderType+owner check.
//
// See docs/design/units-items-abilities-refactor.md.

export const ABILITIES = Object.freeze({
  fortify_double: {
    id: 'fortify_double',
    kind: 'passive',
    label: 'Fortify Double',
    description: 'Wood fortifies to full strength (level 2)',
  },
  heal: {
    id: 'heal',
    kind: 'active',
    label: 'Heal',
    description: 'Action (1): heals hero on same hex 1 HP',
  },
  brawler: {
    id: 'brawler',
    kind: 'passive',
    label: 'Brawler',
    description: '+1 ATK (Phase 4 un-bakes this into statMods)',
  },
  sturdy: {
    id: 'sturdy',
    kind: 'passive',
    label: 'Sturdy',
    description: '+1 DEF (Phase 4 un-bakes this into statMods)',
  },
  herbalist: {
    id: 'herbalist',
    kind: 'passive',
    label: 'Herbalist',
    description: 'Each exploration also yields 1 Herbs',
  },
  inspire: {
    id: 'inspire',
    kind: 'active',
    label: 'Inspire',
    description: 'Action (free): hero gets +1 ATK next battle',
  },
  rally: {
    id: 'rally',
    kind: 'active',
    label: 'Rally',
    description: 'Action (free): hero gets 1 bonus action',
  },
  scout: {
    id: 'scout',
    kind: 'passive',
    label: 'Scout',
    description: 'Reveals night-side units within 3 hexes',
  },
});

// Derived enum for backwards compatibility with the `SurvivorAbility`
// name used throughout src/ and tests/. New code should reference
// ABILITIES[id] directly.
export const SurvivorAbility = Object.freeze(
  Object.fromEntries(
    Object.values(ABILITIES).map(a => [a.id.toUpperCase(), a.id])
  )
);

export function getAbility(id) {
  return ABILITIES[id];
}
