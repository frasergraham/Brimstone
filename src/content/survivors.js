// Survivor roster — Phase 6 of the units/items/abilities refactor
// extracted this file out of src/entities.js. Adding a new survivor is
// a one-file change: append an entry to SURVIVOR_ROSTER. Add a new
// colour slot to SURVIVOR_COLORS if you want the new entry to get a
// distinct unit circle / plan-arrow colour.
//
// Ability ids reference src/abilities.js — register the ability there
// first (with statMods or execute/validate as appropriate) before
// assigning it to a roster entry.
//
// See docs/design/units-items-abilities-refactor.md §"Files" and
// CLAUDE.md §"How to add content".

import { SurvivorAbility } from '../abilities.js';

// One distinct colour per roster slot — used for unit circles and plan arrows.
// Friendly palette: greens, blues and yellows so survivors read as civilian/ally.
export const SURVIVOR_COLORS = [
  '#5dbd72',  // forest green
  '#4ab5d4',  // sky blue
  '#d4c44a',  // wheat yellow
  '#3ec98c',  // jade green
  '#5fa8e8',  // cornflower blue
  '#e8d454',  // sunflower yellow
  '#7dd65e',  // lime green
  '#3eb8c8',  // teal
  '#c8d440',  // yellow-green
  '#68c4e0',  // light blue
  '#4cba5a',  // vivid green
  '#f0e060',  // bright yellow
  '#a8d86c',  // pastel lime
  '#48a0c0',  // steel blue
  '#d0b840',  // dark gold
  '#60d4a0',  // mint
  '#88b8f0',  // periwinkle
  '#c8e048',  // chartreuse
  '#50c8a0',  // seafoam
  '#e0c868',  // muted amber
];

// Named character pool — one is drawn at random when a survivor is discovered.
// Base stats are pre-passive: BRAWLER / STURDY roster entries are stored with
// the un-baked number, and getAttack() / getDefense() compose the +1 from
// ABILITIES[id].statMods at call time.
export const SURVIVOR_ROSTER = [
  {
    name: "John O'Connor",
    title: 'Innkeeper',
    bio: "Ran the inn for thirty years. Built half the town's doors himself.",
    maxHp: 5, attack: 2, defense: 2,
    ability: SurvivorAbility.FORTIFY_DOUBLE,
    abilityLabel: 'Strong Back — fortifies a building to full strength with just Wood',
  },
  {
    name: 'Mary Quinn',
    title: 'Nurse',
    bio: "Kept half of Caleb's Hollow alive through the fever of '88.",
    maxHp: 5, attack: 1, defense: 3,
    ability: SurvivorAbility.HEAL,
    abilityLabel: 'Tend Wounds — heals the hero 1 HP (costs 1 action)',
  },
  {
    name: 'Thomas Putnam',
    title: 'Blacksmith',
    bio: "Arms like anvils. He's been hitting things with hammers his entire life.",
    maxHp: 5, attack: 2, defense: 2,
    ability: SurvivorAbility.BRAWLER,
    abilityLabel: 'Iron Fists — +1 ATK',
  },
  {
    name: 'Abigail Foster',
    title: 'Herbalist',
    bio: "She can find medicine in a snowdrift. Every expedition turns up something useful.",
    maxHp: 4, attack: 1, defense: 2,
    ability: SurvivorAbility.HERBALIST,
    abilityLabel: 'Wild Harvest — each exploration also yields 1 Herbs',
  },
  {
    name: 'Samuel Cooper',
    title: 'Militia Sergeant',
    bio: "Drilled the town militia for a decade. His voice alone steadies the line.",
    maxHp: 4, attack: 2, defense: 2,
    ability: SurvivorAbility.INSPIRE,
    abilityLabel: 'Battle Cry — grants hero +1 ATK for the next battle (free)',
  },
  {
    name: 'Father Crane',
    title: 'Parish Priest',
    bio: "His sermons are long but his faith is genuine. And occasionally useful.",
    maxHp: 5, attack: 1, defense: 3,
    ability: SurvivorAbility.RALLY,
    abilityLabel: 'Holy Sermon — grants the hero 1 bonus action (free)',
  },
  {
    name: 'Hannah Marsh',
    title: 'Baker',
    bio: "Survived three hard winters by sheer stubbornness.",
    maxHp: 7, attack: 1, defense: 2,
    ability: SurvivorAbility.STURDY,
    abilityLabel: 'Iron Stomach — +1 DEF',
  },
  {
    name: 'Ezra Boone',
    title: 'Trapper',
    bio: "Spent thirty years in the deep woods. He sees the shadows before they see him.",
    maxHp: 4, attack: 2, defense: 2,
    ability: SurvivorAbility.SCOUT,
    abilityLabel: "Woodsman — reveals the witch's forces within 3 hexes",
  },
  {
    name: 'Constance Bell',
    title: 'Schoolteacher',
    bio: "Sharp-minded and resourceful. She reads the witch's markings like a primer.",
    maxHp: 4, attack: 1, defense: 2,
    ability: SurvivorAbility.HERBALIST,
    abilityLabel: 'Resourceful — each exploration also yields 1 Herbs',
  },
  {
    name: 'Isaac Graves',
    title: 'Gravedigger',
    bio: "Has faced death every working day. Nothing frightens him anymore.",
    maxHp: 7, attack: 1, defense: 2,
    ability: SurvivorAbility.STURDY,
    abilityLabel: 'Six Feet Under — +1 DEF',
  },
  {
    name: 'Patience Cole',
    title: 'Midwife',
    bio: "Has guided life into the world through hardship and darkness alike.",
    maxHp: 7, attack: 1, defense: 3,
    ability: SurvivorAbility.HEAL,
    abilityLabel: 'Tender Care — heals the hero 1 HP (costs 1 action)',
  },
  {
    name: 'Silas Holt',
    title: 'Farmhand',
    bio: "Young, strong, and fueled by righteous anger.",
    maxHp: 4, attack: 1, defense: 2,
    ability: SurvivorAbility.BRAWLER,
    abilityLabel: 'Farm Strong — +1 ATK',
  },
  {
    name: 'Mercy Hale',
    title: 'Tanner',
    bio: "Cures leather like her grandmother before her. Hands tough as the hides she works.",
    maxHp: 5, attack: 2, defense: 2,
    ability: SurvivorAbility.STURDY,
    abilityLabel: 'Thick Skin — +1 DEF',
  },
  {
    name: 'Elijah Pratt',
    title: 'Chandler',
    bio: "Makes candles and soap. Knows every cellar and storeroom in town.",
    maxHp: 4, attack: 2, defense: 2,
    ability: SurvivorAbility.SCOUT,
    abilityLabel: "Candle Light — reveals the witch's forces within 3 hexes",
  },
  {
    name: 'Ruth Wardwell',
    title: 'Goodwife',
    bio: "Raised seven children through famine and fever. Nothing breaks her resolve.",
    maxHp: 7, attack: 1, defense: 2,
    ability: SurvivorAbility.RALLY,
    abilityLabel: 'Stalwart Spirit — grants the hero 1 bonus action (free)',
  },
  {
    name: 'Nathaniel Corwin',
    title: 'Constable',
    bio: "Enforced the law before the law stopped mattering.",
    maxHp: 5, attack: 2, defense: 2,
    ability: SurvivorAbility.BRAWLER,
    abilityLabel: 'Heavy Hand — +1 ATK',
  },
  {
    name: 'Agnes Whittaker',
    title: 'Weaver',
    bio: "Her loom sits idle but her hands are still quick with needle and knot.",
    maxHp: 4, attack: 1, defense: 2,
    ability: SurvivorAbility.FORTIFY_DOUBLE,
    abilityLabel: 'Nimble Fingers — fortifies a building to full strength with just Wood',
  },
  {
    name: 'Josiah Dane',
    title: 'Carpenter',
    bio: "Built half the roofs in Caleb's Hollow. Knows timber like a brother.",
    maxHp: 5, attack: 2, defense: 2,
    ability: SurvivorAbility.FORTIFY_DOUBLE,
    abilityLabel: 'Master Builder — fortifies a building to full strength with just Wood',
  },
  {
    name: 'Prudence Faulkner',
    title: "Apothecary's Daughter",
    bio: "Learned her mother's remedies before the trials took everything.",
    maxHp: 4, attack: 1, defense: 3,
    ability: SurvivorAbility.HEAL,
    abilityLabel: 'Salve and Poultice — heals the hero 1 HP (costs 1 action)',
  },
  {
    name: 'Caleb Osgood',
    title: 'Fisherman',
    bio: "Hauled nets in storms that would drown lesser men.",
    maxHp: 5, attack: 2, defense: 2,
    ability: SurvivorAbility.INSPIRE,
    abilityLabel: 'Sea-Hardened — grants hero +1 ATK for the next battle (free)',
  },
];
