// ITEMS registry — single source of truth for all items.
//
// Phase 1 populates weapon entries only; WEAPON_STATS and WEAPON_LABEL in
// src/tiles.js derive from this registry. Phase 3 extends entries with
// combatTriggers (so staff-vs-undead moves out of Entity.resolveCombat)
// and folds in consumables (silver, food, herbs, scripture) and the horse
// mount. See docs/design/units-items-abilities-refactor.md.

export const ITEMS = Object.freeze({
  sword: {
    id: 'sword',
    kind: 'weapon',
    slot: 'weapon',
    statMods: { attack: 2, defense: 0 },
    label: '⚔ Sword (+2 ATK)',
  },
  axe: {
    id: 'axe',
    kind: 'weapon',
    slot: 'weapon',
    statMods: { attack: 1, defense: 1 },
    label: '🪓 Axe (+1 ATK, +1 DEF)',
  },
  bow: {
    id: 'bow',
    kind: 'weapon',
    slot: 'weapon',
    statMods: { attack: 1, defense: 0 },
    label: '🏹 Bow (+1 ATK)',
  },
  shield: {
    id: 'shield',
    kind: 'weapon',
    slot: 'weapon',
    statMods: { attack: 0, defense: 2 },
    label: '🛡 Shield (+2 DEF)',
  },
  staff: {
    id: 'staff',
    kind: 'weapon',
    slot: 'weapon',
    statMods: { attack: 1, defense: 0 },
    label: '🪄 Staff (+1 ATK, +2 vs undead)',
    // Phase 3 will populate combatTriggers to replace the hardcoded
    // staff-vs-undead branch in Entity.resolveCombat.
  },
  dagger: {
    id: 'dagger',
    kind: 'weapon',
    slot: 'weapon',
    statMods: { attack: 1, defense: 0 },
    label: '🗡 Dagger (+1 ATK)',
  },
});

export function getItem(id) {
  return ITEMS[id];
}
