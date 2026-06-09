// ITEMS registry — single source of truth for all items.
//
// Phase 1 populates weapon entries only; WEAPON_STATS and WEAPON_LABEL in
// src/tiles.js derive from this registry. Phase 3 extends entries with
// combatTriggers (so staff-vs-undead moves out of Entity.resolveCombat)
// and folds in consumables (silver, food, herbs, scripture) and the horse
// mount. See docs/design/units-items-abilities-refactor.md.
//
// `category` — 'melee' | 'ranged'. Factions gate equipping per-category
// via Faction.canEquipWeaponItem (e.g. the rogue refuses melee weapons).
//
// `range` — the attack-target distance the weapon grants its wielder, in
// hexes. Omitted (melee weapons / unarmed) ⇒ range 1. A unit has NO innate
// range any more — Entity.getRange() reads it from the equipped weapon, so
// a bow turns any wielder into an archer (range 3) and an unarmed unit is
// melee. `projectileType` names the replay animation for ranged shots.
//
// `wielderFactions` — if present, only those faction ids may equip the
// weapon (e.g. Magic Bolt is witch/necromancer-only). `noLoot` marks
// weapons that are issued as starting gear and never appear in loot tables.

export const ITEMS = Object.freeze({
  sword: {
    id: 'sword',
    kind: 'weapon',
    slot: 'weapon',
    category: 'melee',
    statMods: { attack: 2, defense: 0 },
    label: '⚔ Sword (+2 ATK)',
  },
  axe: {
    id: 'axe',
    kind: 'weapon',
    slot: 'weapon',
    category: 'melee',
    statMods: { attack: 1, defense: 1 },
    label: '🪓 Axe (+1 ATK, +1 DEF)',
  },
  bow: {
    id: 'bow',
    kind: 'weapon',
    slot: 'weapon',
    category: 'ranged',
    statMods: { attack: 0, defense: 0 },
    range: 3,
    projectileType: 'bolt',
    label: '🏹 Bow (range 3)',
  },
  crossbow: {
    id: 'crossbow',
    kind: 'weapon',
    slot: 'weapon',
    category: 'ranged',
    statMods: { attack: 1, defense: 0 },
    range: 2,
    projectileType: 'bolt',
    label: '🏹 Crossbow (+1 ATK, range 2)',
  },
  musket: {
    id: 'musket',
    kind: 'weapon',
    slot: 'weapon',
    category: 'ranged',
    statMods: { attack: 2, defense: 0 },
    range: 2,
    projectileType: 'bolt',
    label: '🔫 Musket (+2 ATK, range 2)',
  },
  pistol: {
    id: 'pistol',
    kind: 'weapon',
    slot: 'weapon',
    category: 'ranged',
    statMods: { attack: 1, defense: 0 },
    range: 2,
    projectileType: 'bolt',
    label: '🔫 Flintlock (+1 ATK, range 2)',
  },
  sling: {
    id: 'sling',
    kind: 'weapon',
    slot: 'weapon',
    category: 'ranged',
    statMods: { attack: 0, defense: 0 },
    range: 2,
    projectileType: 'bolt',
    label: '🪨 Sling (range 2)',
  },
  shield: {
    id: 'shield',
    kind: 'weapon',
    slot: 'weapon',
    category: 'melee',
    statMods: { attack: 0, defense: 2 },
    label: '🛡 Shield (+2 DEF)',
  },
  staff: {
    id: 'staff',
    kind: 'weapon',
    slot: 'weapon',
    category: 'melee',
    statMods: { attack: 1, defense: 0 },
    label: '🪄 Staff (+1 ATK, advantage vs undead)',
    // Grants +1 attack advantage die vs undead defenders only (zombies).
    // Pre-refactor this also fired against minions and golems, but that
    // effectively made the staff a flat +adv vs every witch unit — not
    // the "specialist anti-undead weapon" its label suggests. Narrowed
    // to match the label.
    combatTriggers: [
      { when: 'attack', ifDefenderHasAnyTag: ['undead'], advantage: 1 },
    ],
  },
  dagger: {
    id: 'dagger',
    kind: 'weapon',
    slot: 'weapon',
    category: 'melee',
    statMods: { attack: 1, defense: 0 },
    label: '🗡 Dagger (+1 ATK)',
  },
  // Witch / Necromancer innate ranged attack. Issued as starting gear via
  // Faction.innateLeaderWeapon; never looted (noLoot) and equippable only
  // by its wielderFactions.
  magic_bolt: {
    id: 'magic_bolt',
    kind: 'weapon',
    slot: 'weapon',
    category: 'ranged',
    // +1 ATK mirrors the Paladin's starting sword edge so the night side
    // keeps pace (witch effective ATK 3 vs paladin 4 — the same +1 gap as
    // the pre-overhaul baseline). Tuned via the balance sims.
    statMods: { attack: 1, defense: 0 },
    range: 2,
    projectileType: 'sparkle',
    wielderFactions: ['witch', 'necromancer'],
    noLoot: true,
    label: '✨ Magic Bolt (+1 ATK, range 2)',
  },
});

export function getItem(id) {
  return ITEMS[id];
}
