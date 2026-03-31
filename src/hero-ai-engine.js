// Hero AI Engine — 5-stage pipeline hero AI
// All hero personalities are config-driven variants of this single engine.
//
// Pipeline: EVALUATE → SCORE → ALLOCATE → GENERATE → ASSEMBLE

import { PlanSimState, stepToward, stepAwayFrom, nearestBuilding, isOnNode, inBuilding, HERO_PERSONALITIES } from './ai.js';
import { EnginePlanSimState, allocateBudget, assemblePlan, estimateCombat } from './ai-engine.js';
import { hexDistance, hexKey, getNeighbors } from './hex.js';
import { Phase, nodeController } from './game.js';
import { EntityType } from './entities.js';
import { TileType, ResourceType } from './tiles.js';
import { PlanActionType, MAX_PLAN_LENGTH } from './planner.js';

// ── Goal names ───────────────────────────────────────────────────────────────

export const HeroGoal = Object.freeze({
  SLAY_WITCH:       'SLAY_WITCH',
  CONTROL_NODES:    'CONTROL_NODES',
  EXPLORE:          'EXPLORE',
  FORTIFY_POSITION: 'FORTIFY_POSITION',
  PROTECT_HERO:     'PROTECT_HERO',
});

const ALL_HERO_GOALS = Object.values(HeroGoal);

// ── Personality configs ─────────────────────────────────────────────────────
// goalWeights: post-scoring multipliers per goal (higher = more budget share)
// engageFloor: minimum combat classification to attack
//   'suicidal' → only skip suicidal; 'unfavorable' → need favorable+; 'favorable' → need overwhelming
// shelterThreshold: HP ratio below which hero seeks shelter even during day
// fortifyCapDay/Night: max fortification level to invest during day/night

export const HERO_PERSONALITY_CONFIGS = Object.freeze({
  balanced: Object.freeze({
    goalWeights: Object.freeze({
      [HeroGoal.SLAY_WITCH]: 1.0, [HeroGoal.CONTROL_NODES]: 1.0,
      [HeroGoal.EXPLORE]: 1.0, [HeroGoal.FORTIFY_POSITION]: 1.0, [HeroGoal.PROTECT_HERO]: 1.0,
    }),
    engageFloor: 'unfavorable',
    shelterThreshold: 0.4,
    fortifyCapDay: 1,
    fortifyCapNight: 3,
  }),
  aggressive: Object.freeze({
    goalWeights: Object.freeze({
      [HeroGoal.SLAY_WITCH]: 2.0, [HeroGoal.CONTROL_NODES]: 0.6,
      [HeroGoal.EXPLORE]: 0.5, [HeroGoal.FORTIFY_POSITION]: 0.4, [HeroGoal.PROTECT_HERO]: 0.6,
    }),
    engageFloor: 'suicidal',
    shelterThreshold: 0.2,
    fortifyCapDay: 0,
    fortifyCapNight: 3,
  }),
  defensive: Object.freeze({
    goalWeights: Object.freeze({
      [HeroGoal.SLAY_WITCH]: 0.4, [HeroGoal.CONTROL_NODES]: 1.5,
      [HeroGoal.EXPLORE]: 0.8, [HeroGoal.FORTIFY_POSITION]: 2.0, [HeroGoal.PROTECT_HERO]: 1.5,
    }),
    engageFloor: 'unfavorable',
    shelterThreshold: 0.5,
    fortifyCapDay: 1,
    fortifyCapNight: 4,
  }),
  explorer: Object.freeze({
    goalWeights: Object.freeze({
      [HeroGoal.SLAY_WITCH]: 0.5, [HeroGoal.CONTROL_NODES]: 0.8,
      [HeroGoal.EXPLORE]: 2.0, [HeroGoal.FORTIFY_POSITION]: 1.0, [HeroGoal.PROTECT_HERO]: 1.0,
    }),
    engageFloor: 'unfavorable',
    shelterThreshold: 0.5,
    fortifyCapDay: 1,
    fortifyCapNight: 3,
  }),
});

// ── Stage 1: Board Evaluation ────────────────────────────────────────────────

export function assessHeroBoard(sim) {
  const hero = sim.hero;
  const phase = sim.phase;

  // Phase info
  const isNight = phase === Phase.NIGHT;
  const isDay = phase === Phase.DAY;
  const isDawnOrDusk = phase === Phase.DAWN || phase === Phase.DUSK;

  // Hero stats
  const heroHp = hero?.hp ?? 0;
  const heroMaxHp = hero?.maxHp ?? hero?.hp ?? 1;
  const heroHpRatio = hero ? heroHp / (heroMaxHp || 1) : 1;

  // Survivors
  const survivors = sim.entities.filter(e =>
    e.alive && e.owner === 'hero' && e.type === EntityType.SURVIVOR
  );
  const survivorCount = survivors.length;

  // Witch info
  const witch = sim.witch;
  const witchVisible = !!witch;
  let witchDistance = Infinity;
  let witchHpRatio = 1;
  if (witch && hero) {
    witchDistance = hexDistance(hero.col, hero.row, witch.col, witch.row);
    witchHpRatio = witch.hp / (witch.maxHp || witch.hp || 1);
  }

  // Enemy units (non-witch enemies)
  const witchMinions = sim.entities.filter(e =>
    e.alive && e.owner === 'witch' && e.type !== EntityType.WITCH
  );

  // Node state
  const objectives = sim.witchObjectives || [];
  const nodes = objectives.map(obj => {
    const controller = nodeController(obj, sim.entities);
    const heroPresent = obj.hexes
      ? obj.hexes.some(h => sim.entities.some(e => e.alive && e.owner === 'hero' && e.col === h.col && e.row === h.row))
      : sim.entities.some(e => e.alive && e.owner === 'hero' && e.col === obj.col && e.row === obj.row);
    const witchPresent = obj.hexes
      ? obj.hexes.some(h => sim.entities.some(e => e.alive && e.owner === 'witch' && e.col === h.col && e.row === h.row))
      : sim.entities.some(e => e.alive && e.owner === 'witch' && e.col === obj.col && e.row === obj.row);

    // Distance from hero to this node
    let distToHero = Infinity;
    if (hero) {
      distToHero = hexDistance(hero.col, hero.row, obj.col, obj.row);
    }

    // Distance from nearest hero unit (hero + survivors) to this node
    let distToNearestHeroUnit = Infinity;
    const heroUnits = sim.entities.filter(e => e.alive && e.owner === 'hero');
    for (const e of heroUnits) {
      const d = hexDistance(e.col, e.row, obj.col, obj.row);
      if (d < distToNearestHeroUnit) distToNearestHeroUnit = d;
    }

    return { obj, controller, heroPresent, witchPresent, distToHero, distToNearestHeroUnit };
  });
  const heroHeldCount = nodes.filter(n => n.controller === 'hero').length;
  const witchHeldCount = nodes.filter(n => n.controller === 'witch').length;

  // Scores
  const heroScore = sim.nodeScore?.hero ?? 0;
  const witchScore = sim.nodeScore?.witch ?? 0;

  // Hero inventory — personal items on hero entity
  const heroItems = hero?.items ? { ...hero.items } : {};
  const herbCount = heroItems[ResourceType.HERBS] || 0;
  const foodCount = heroItems[ResourceType.FOOD] || 0;

  // Unequipped weapons (stored as 'weapon:sword' keys in hero.items)
  const heroWeapons = hero?.items
    ? Object.keys(hero.items).filter(k => k.startsWith('weapon:') && hero.items[k] > 0)
    : [];

  // Shared inventory (wood, metal for fortification)
  const shared = sim.inventory?.shared || {};
  const woodCount = shared[ResourceType.WOOD] || 0;
  const metalCount = shared[ResourceType.METAL] || 0;
  const sharedInventory = { ...shared };

  // Unexplored buildings
  const unexploredBuildings = [];
  for (const [, t] of sim.tiles) {
    if (t.type === TileType.BUILDING) {
      const explored = sim.isExplored ? sim.isExplored(t.col, t.row) : t.explored;
      if (!explored) unexploredBuildings.push(t);
    }
  }
  let nearestUnexplored = null;
  let nearestUnexploredDist = Infinity;
  if (hero) {
    for (const b of unexploredBuildings) {
      const d = hexDistance(hero.col, hero.row, b.col, b.row);
      if (d < nearestUnexploredDist) { nearestUnexploredDist = d; nearestUnexplored = b; }
    }
  }

  // Positional info
  const heroOnNode = hero ? isOnNode(sim, hero) : false;
  const heroInBuilding = hero ? inBuilding(sim, hero) : false;
  const heroTile = hero ? sim.tiles.get(hexKey(hero.col, hero.row)) : null;
  const heroTileExplored = heroTile ? (sim.isExplored ? sim.isExplored(heroTile.col, heroTile.row) : !!heroTile.explored) : true;
  const heroTileFortLevel = heroTile?.fortifyLevel || 0;

  return {
    phase, isNight, isDay, isDawnOrDusk,
    hero,
    heroHp, heroMaxHp, heroHpRatio,
    survivors, survivorCount,
    witch, witchVisible, witchDistance, witchHpRatio,
    witchMinions,
    nodes, heroHeldCount, witchHeldCount,
    heroScore, witchScore,
    heroItems, herbCount, foodCount,
    heroWeapons,
    sharedInventory, woodCount, metalCount,
    unexploredBuildings, nearestUnexplored,
    heroOnNode, heroInBuilding, heroTileExplored, heroTileFortLevel,
    totalBudget: sim.actionsLeft,
  };
}
