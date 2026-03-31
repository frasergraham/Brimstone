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
