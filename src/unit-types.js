// UNIT_TYPES registry — single source of truth for per-entity-type stats,
// agility, visual colour, and tag metadata.
//
// Keyed by EntityType string value (e.g. 'paladin', 'witch', 'zombie') so
// this module has no import dependency on entities.js. BASE_STATS,
// BASE_AGILITY, and ENTITY_COLOR in src/entities.js derive from this
// registry.
//
// `tags` is currently metadata-only — no reader in code. Phase 3 of the
// units/items/abilities refactor will read tags from Entity.resolveCombat
// (staff-vs-undead becomes a data-driven trigger) and from item combat
// triggers generally. See docs/design/units-items-abilities-refactor.md.

// `range` is the attack-target distance in hexes. 1 = melee-only; >1 = ranged.
// Ranged attacks obey a different rule set (no gang-up, no crush/splash,
// forest cover, close-range disadvantage) — see Entity.resolveCombat and
// executeBattle. `projectileType` names the replay animation used for
// ranged attacks; unused for melee (range 1) units.
export const UNIT_TYPES = Object.freeze({
  paladin: {
    baseStats: { maxHp: 14, attack: 3, defense: 2 },
    agility: 6,
    range: 1,
    color: '#d4a72c',
    tags: ['living', 'leader', 'day-leader'],
  },
  rogue: {
    baseStats: { maxHp: 10, attack: 3, defense: 1 },
    agility: 8,
    range: 3,
    projectileType: 'bolt',
    color: '#b88a1c',
    tags: ['living', 'leader', 'day-leader'],
  },
  captain: {
    baseStats: { maxHp: 12, attack: 2, defense: 3 },
    agility: 5,
    range: 1,
    color: '#e8c660',
    tags: ['living', 'leader', 'day-leader'],
  },
  witch: {
    baseStats: { maxHp: 10, attack: 2, defense: 2 },
    agility: 5,
    range: 2,
    projectileType: 'sparkle',
    color: '#9b59b6',
    tags: ['living', 'leader', 'night-leader'],
  },
  necromancer: {
    baseStats: { maxHp: 10, attack: 1, defense: 2 },
    agility: 4,
    range: 1,
    color: '#7d4393',
    tags: ['living', 'leader', 'night-leader'],
  },
  brute: {
    baseStats: { maxHp: 14, attack: 3, defense: 1 },
    agility: 3,
    range: 1,
    color: '#b075c8',
    tags: ['living', 'leader', 'night-leader'],
  },
  survivor: {
    baseStats: { maxHp: 4, attack: 1, defense: 1 },
    agility: 4,
    range: 1,
    color: '#4caf7d',
    tags: ['living'],
  },
  // Soldier — day-side grunt, mirror of the witch's minion. Summoned by
  // the Captain faction (bespoke ability lands in a follow-up PR); the
  // unit type itself is registered here so combat, rendering, pathfinding
  // and serialization work generically the moment a summoner exists.
  soldier: {
    baseStats: { maxHp: 2, attack: 1, defense: 1 },
    agility: 5,
    range: 1,
    color: '#3f78c4',
    tags: ['living', 'soldier', 'summoned'],
  },
  zombie: {
    baseStats: { maxHp: 2, attack: 2, defense: 0 },
    agility: 2,
    range: 1,
    color: '#7c9a57',
    tags: ['undead'],
  },
  minion: {
    baseStats: { maxHp: 2, attack: 1, defense: 0 },
    agility: 5,
    range: 1,
    color: '#c0392b',
    tags: ['minion', 'summoned'],
  },
  wood_golem: {
    baseStats: { maxHp: 3, attack: 2, defense: 3 },
    agility: 3,
    range: 1,
    color: '#8B5E3C',
    tags: ['construct', 'summoned'],
  },
  iron_golem: {
    baseStats: { maxHp: 5, attack: 3, defense: 2 },
    agility: 2,
    range: 1,
    color: '#607D8B',
    tags: ['construct', 'summoned'],
  },
});

export function getUnitType(type) {
  return UNIT_TYPES[type];
}
