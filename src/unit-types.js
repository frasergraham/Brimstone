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
    // Deliberately weaker than the paladin (98 HP / effective ATK 4 with
    // sword): the Captain wins through troops (soldiers, catapults), not
    // personal prowess. 70 = 10×7; sword brings effective ATK to 3.
    baseStats: { maxHp: 70, attack: 1, defense: 2 },
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
    baseStats: { maxHp: 100, attack: 4, defense: 3 },
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
  // Soldier — day-side grunt, EXACT mirror of the witch's minion (14 HP /
  // 1 ATK / 0 DEF / agility 5). Summoned by the Captain faction (CALL
  // REINFORCEMENTS). Defense was 1 at introduction — a strict upgrade over
  // the minion it mirrors — and was dropped to 0 when the hero AI learned
  // MARCH + catapult fire: the efficiency gain pushed the captain past the
  // 62% balance ceiling (2026-07-06 headless, 300 std games at 62-69%), and
  // the tankier-than-minion grunt was the asymmetry funding it.
  soldier: {
    baseStats: { maxHp: 14, attack: 1, defense: 0 },
    agility: 5,
    color: '#3f78c4',
    tags: ['living', 'soldier', 'summoned'],
  },
  // Catapult — the Captain's built siege engine. IMMOBILE (the 'immobile'
  // tag gates MOVE / March pickup in getValidActions + executeMove); its
  // reach comes entirely from the innate catapult_stone weapon (range 4)
  // equipped by createCatapult. 28 = 4×7.
  catapult: {
    baseStats: { maxHp: 28, attack: 2, defense: 1 },
    agility: 1,
    color: '#8a7a5c',
    tags: ['construct', 'immobile'],
  },
  zombie: {
    baseStats: { maxHp: 14, attack: 2, defense: 0 },
    agility: 2,
    color: '#7c9a57',
    tags: ['undead'],
  },
  // Skeleton — the Necromancer's conjured chaff (RAISE DEAD's fresh-summon
  // path). Zombie/minion neighborhood: same 2-logical-HP pool (14 = 2×7 — see
  // the HP NOTE above), trading the zombie's hitting power for a point of
  // bone-armour and enough agility to act before the shamblers.
  skeleton: {
    baseStats: { maxHp: 14, attack: 1, defense: 1 },
    agility: 4,
    color: '#c9c4ae',
    tags: ['undead', 'summoned'],
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

/**
 * True if units of this type can never move (no MOVE action, never picked
 * up as a March passenger). Driven by the 'immobile' tag — the catapult is
 * the first such unit. Kept here (tag metadata) so actions/planner/AI all
 * share one predicate.
 */
export function isImmobileType(type) {
  return UNIT_TYPES[type]?.tags?.includes('immobile') ?? false;
}
