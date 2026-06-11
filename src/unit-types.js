// UNIT_TYPES registry — single source of truth for per-entity-type stats,
// agility, visual colour, and tag metadata.
//
// Keyed by EntityType string value (e.g. 'paladin', 'witch', 'zombie') so
// this module has no import dependency on entities.js. BASE_STATS,
// BASE_AGILITY, and ENTITY_COLOR in src/entities.js derive from this
// registry.
//
// `tags` drives item combat triggers and faction-level predicates
// (e.g. staff-vs-undead matches against defender.tags).
//
// NOTE: units have NO innate attack range. Range is entirely weapon-derived
// (see src/items.js `range` + Entity.getRange()). Leaders are issued a
// starting weapon via Faction.innateLeaderWeapon — the Rogue's bow grants
// range 3, the Witch/Necromancer's Magic Bolt grants range 2, the Paladin's
// sword is melee. `projectileType` for ranged shots lives on the weapon too.
// HP NOTE: maxHp values are pre-multiplied by DAMAGE_SCALE (=7) from
// src/balance.js. Weapons deal rolled damage averaging ~7 per hit, so these
// scaled pools keep the average hits-to-kill identical to the pre-dice
// baseline (paladin 98 = 14×7, zombie 14 = 2×7, …). When adding a unit type,
// pick a small "logical" HP and multiply by 7.
export const UNIT_TYPES = Object.freeze({
  paladin: {
    // Base attack is 2; the starting sword (+2) brings effective ATK to 4.
    baseStats: { maxHp: 98, attack: 2, defense: 2 },
    agility: 6,
    color: '#d4a72c',
    tags: ['living', 'leader', 'day-leader'],
  },
  rogue: {
    baseStats: { maxHp: 70, attack: 3, defense: 1 },
    agility: 8,
    color: '#b88a1c',
    tags: ['living', 'leader', 'day-leader'],
  },
  captain: {
    baseStats: { maxHp: 84, attack: 2, defense: 3 },
    agility: 5,
    color: '#e8c660',
    tags: ['living', 'leader', 'day-leader'],
  },
  witch: {
    baseStats: { maxHp: 70, attack: 2, defense: 2 },
    agility: 5,
    color: '#9b59b6',
    tags: ['living', 'leader', 'night-leader'],
  },
  necromancer: {
    baseStats: { maxHp: 70, attack: 1, defense: 2 },
    agility: 4,
    color: '#7d4393',
    tags: ['living', 'leader', 'night-leader'],
  },
  brute: {
    baseStats: { maxHp: 126, attack: 4, defense: 3 },
    agility: 3,
    color: '#b075c8',
    tags: ['living', 'leader', 'night-leader'],
  },
  survivor: {
    baseStats: { maxHp: 28, attack: 1, defense: 1 },
    agility: 4,
    color: '#4caf7d',
    tags: ['living'],
  },
  // Soldier — day-side grunt, mirror of the witch's minion. Summoned by
  // the Captain faction (bespoke ability lands in a follow-up PR); the
  // unit type itself is registered here so combat, rendering, pathfinding
  // and serialization work generically the moment a summoner exists.
  soldier: {
    baseStats: { maxHp: 14, attack: 1, defense: 1 },
    agility: 5,
    color: '#3f78c4',
    tags: ['living', 'soldier', 'summoned'],
  },
  zombie: {
    baseStats: { maxHp: 14, attack: 2, defense: 0 },
    agility: 2,
    color: '#7c9a57',
    tags: ['undead'],
  },
  minion: {
    baseStats: { maxHp: 14, attack: 1, defense: 0 },
    agility: 5,
    color: '#c0392b',
    tags: ['minion', 'summoned'],
  },
  wood_golem: {
    baseStats: { maxHp: 21, attack: 2, defense: 3 },
    agility: 3,
    color: '#8B5E3C',
    tags: ['construct', 'summoned'],
  },
  iron_golem: {
    baseStats: { maxHp: 35, attack: 3, defense: 2 },
    agility: 2,
    color: '#607D8B',
    tags: ['construct', 'summoned'],
  },
});

export function getUnitType(type) {
  return UNIT_TYPES[type];
}
