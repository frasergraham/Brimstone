// Hero AI Engine — 5-stage pipeline hero AI
// All hero personalities are config-driven variants of this single engine.
//
// Pipeline: EVALUATE → SCORE → ALLOCATE → GENERATE → ASSEMBLE

import { PlanSimState, stepToward, stepAwayFrom, roadStepToward, nearestBuilding, isOnNode, inBuilding, roundsUntilScoring, scoreNodeFeasibility, HERO_PERSONALITIES } from './ai.js';
import { EnginePlanSimState, allocateBudget, assemblePlan } from './ai-engine.js';
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

// ── HeroEnginePlanSimState ───────────────────────────────────────────────────
// Extends EnginePlanSimState with hero-specific resource ledger (shared inventory).

export class HeroEnginePlanSimState extends EnginePlanSimState {
  constructor(realState, playerId = null) {
    super(realState, 'hero', playerId);
    // Hero uses shared inventory (wood/metal for fortification), not witch inventory
    this.resourceLedger = JSON.parse(JSON.stringify(this.inventory.shared || {}));
  }
}

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
  // Food is in the shared inventory, not the hero's personal items
  const foodCount = sim.inventory?.shared?.[ResourceType.FOOD] || 0;

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

  // Nearest enemy distance (any witch-owned entity)
  let nearestEnemyDist = Infinity;
  if (hero) {
    for (const e of sim.entities) {
      if (!e.alive || e.owner !== 'witch') continue;
      const d = hexDistance(hero.col, hero.row, e.col, e.row);
      if (d < nearestEnemyDist) nearestEnemyDist = d;
    }
  }

  // Scoring-phase timing
  const round = sim.round;
  const roundsToScoring = roundsUntilScoring(round);

  return {
    phase, isNight, isDay, isDawnOrDusk,
    round, roundsToScoring,
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
    nearestEnemyDist,
    totalBudget: sim.actionsLeft,
  };
}

// ── Stage 2: Goal Scoring ────────────────────────────────────────────────────

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// Phase multipliers: [night, day, dawnOrDusk]
const PHASE_MULT = {
  [HeroGoal.PROTECT_HERO]:     { night: 1.5, day: 0.8, dawnOrDusk: 1.0 },
  [HeroGoal.SLAY_WITCH]:       { night: 0.5, day: 1.4, dawnOrDusk: 1.0 },
  [HeroGoal.CONTROL_NODES]:    { night: 0.8, day: 1.0, dawnOrDusk: 1.8 },
  [HeroGoal.EXPLORE]:          { night: 0.3, day: 1.5, dawnOrDusk: 1.0 },
  [HeroGoal.FORTIFY_POSITION]: { night: 2.0, day: 0.5, dawnOrDusk: 1.5 },
};

function phaseMult(goal, board) {
  const m = PHASE_MULT[goal];
  if (board.isNight) return m.night;
  if (board.isDay) return m.day;
  return m.dawnOrDusk;
}

export function scoreHeroGoals(board, goalWeights = null) {
  // PROTECT_HERO
  let protect = 0;
  if (board.heroHpRatio < 0.3) protect = 1.0;
  else if (board.heroHpRatio < 0.5) protect = 0.6;
  if (board.herbCount > 0 && board.heroHp < board.heroMaxHp) protect = Math.max(protect, 0.3);
  if (board.witchDistance <= 2 && board.heroHpRatio < 0.5) protect = 1.0;
  protect = clamp01(protect * phaseMult(HeroGoal.PROTECT_HERO, board));

  // SLAY_WITCH
  let slay = 0;
  if (board.witchVisible) {
    if (board.witchDistance <= 1) slay = 0.9;
    else if (board.witchDistance <= 3) slay = 0.6;
    else if (board.witchDistance <= 5) slay = 0.3;
    else slay = 0.1;
    if (board.witchHpRatio < 0.4) slay += 0.2;
  }
  slay = clamp01(clamp01(slay) * phaseMult(HeroGoal.SLAY_WITCH, board));

  // CONTROL_NODES
  let control = 0.3;
  const uncovered = board.nodes.filter(n => n.controller !== 'hero' && !n.heroPresent).length;
  control += uncovered * 0.15;
  if (board.witchHeldCount >= 2) control += 0.4;
  // Score-differential awareness: hero needs to fight harder when behind
  const scoreDiff = board.heroScore - board.witchScore;
  if (scoreDiff < 0) control += 0.15;           // behind: try harder
  if (scoreDiff <= -2) control += 0.15;          // way behind: desperate
  if (board.witchScore >= 3) control += 0.3;     // opponent at match point
  // Phase-timing urgency: ramp up as scoring round approaches
  if (board.roundsToScoring <= 2) control += 0.25;
  else if (board.roundsToScoring <= 3) control += 0.1;
  control = clamp01(clamp01(control) * phaseMult(HeroGoal.CONTROL_NODES, board));

  // EXPLORE
  let explore = 0;
  if (board.unexploredBuildings.length > 0) explore = 0.6;
  if (board.unexploredBuildings.length >= 3) explore += 0.15;
  if (board.survivorCount === 0) explore += 0.25;
  if (board.woodCount + board.metalCount < 2) explore += 0.2;
  if (board.heroInBuilding && !board.heroTileExplored) explore += 0.3;
  explore = clamp01(clamp01(explore) * phaseMult(HeroGoal.EXPLORE, board));

  // FORTIFY_POSITION
  let fortify = 0;
  if (board.isNight || board.isDawnOrDusk) {
    if (board.heroInBuilding) {
      if (board.heroTileFortLevel < 3) fortify = 0.7;
    } else {
      fortify = 0.9; // need to move to shelter first
    }
  } else if (board.heroInBuilding && board.heroTileFortLevel === 0) {
    fortify = 0.3;
  }
  fortify = clamp01(fortify * phaseMult(HeroGoal.FORTIFY_POSITION, board));

  const scores = {
    [HeroGoal.PROTECT_HERO]:     protect,
    [HeroGoal.SLAY_WITCH]:       slay,
    [HeroGoal.CONTROL_NODES]:    control,
    [HeroGoal.EXPLORE]:          explore,
    [HeroGoal.FORTIFY_POSITION]: fortify,
  };

  // Apply personality goal weights
  if (goalWeights) {
    for (const g of ALL_HERO_GOALS) {
      if (goalWeights[g] != null) scores[g] = clamp01(scores[g] * goalWeights[g]);
    }
  }

  // Early-game explore focus: when no enemies are nearby and buildings remain,
  // heavily prioritize exploration over defensive/passive goals.
  // There's no reason to guard or fortify when nothing threatens you.
  if (board.nearestEnemyDist > 4 && board.unexploredBuildings.length > 0) {
    scores[HeroGoal.EXPLORE] = clamp01(scores[HeroGoal.EXPLORE] + 0.4);
    scores[HeroGoal.FORTIFY_POSITION] = Math.min(scores[HeroGoal.FORTIFY_POSITION], 0.1);
    scores[HeroGoal.PROTECT_HERO] = Math.min(scores[HeroGoal.PROTECT_HERO], 0.1);
  }

  return scores;
}

// ── Combat estimation (hero-perspective) ─────────────────────────────────────
// Same dice model as witch estimateCombat but with hero-correct gang-up units.

export function estimateHeroCombat(attacker, defender, board) {
  // Hero never gets night ATK bonus
  const nightBonus = 0;

  // Attacker allies: hero-side units adjacent to the defender
  const allies = [board.hero, ...board.survivors].filter(e =>
    e && e.id !== attacker.id && hexDistance(e.col, e.row, defender.col, defender.row) <= 1
  );
  const gangUpDice = Math.min(allies.length, 3);

  // Defender allies: witch-side units adjacent to the defender
  const defAllies = [board.witch, ...board.witchMinions].filter(e =>
    e && e.id !== defender.id && hexDistance(e.col, e.row, defender.col, defender.row) <= 1
  );
  const defAllyDice = Math.min(defAllies.length, 3);

  const expectedAtk = (attacker.attack || 0) + 3.5 + nightBonus + gangUpDice * 2;
  const expectedDef = (defender.defense || 0) + 3.5 + defAllyDice * 2;

  const favorability = expectedAtk - expectedDef;

  let classification;
  if (favorability > 3)       classification = 'overwhelming';
  else if (favorability > 0)  classification = 'favorable';
  else if (favorability > -3) classification = 'unfavorable';
  else                        classification = 'suicidal';

  return { favorability, classification };
}

// ── Helper: engage floor check ──────────────────────────────────────────────

function meetsEngageFloor(classification, floor) {
  if (floor === 'suicidal') return classification !== 'suicidal';
  if (floor === 'unfavorable') return classification === 'favorable' || classification === 'overwhelming';
  if (floor === 'favorable') return classification === 'overwhelming';
  return true;
}

// ── Helper: closest uncommitted hero unit to a target ───────────────────────

function _closestUncommittedHero(sim, board, target) {
  let best = null, bestDist = Infinity;
  const candidates = [board.hero, ...board.survivors].filter(e => e && e.alive);
  for (const e of candidates) {
    if (sim.unitCommitments.has(e.id)) continue;
    const d = hexDistance(e.col, e.row, target.col, target.row);
    if (d < bestDist) { bestDist = d; best = e; }
  }
  return best;
}

// ── Helper: nearest unexplored building ─────────────────────────────────────

function _nearestUnexploredBuilding(sim, actor) {
  let best = null, bestDist = Infinity;
  for (const [, t] of sim.tiles) {
    if (t.type !== TileType.BUILDING) continue;
    const explored = sim.isExplored ? sim.isExplored(t.col, t.row) : t.explored;
    if (explored) continue;
    const d = hexDistance(actor.col, actor.row, t.col, t.row);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  return best;
}

// ── Stage 4: Tactic Generators ──────────────────────────────────────────────

// ── Generator: PROTECT_HERO ─────────────────────────────────────────────────

export function genProtectHero(sim, board, budget, config = null) {
  const actions = [];
  if (!board.hero) return actions;
  let remaining = budget;

  const heroEntity = sim.entities.find(e => e.id === board.hero.id);
  if (!heroEntity) return actions;

  // Free action: use herbs if injured
  const herbs = heroEntity.items?.[ResourceType.HERBS] || 0;
  if (herbs > 0 && board.heroHpRatio < 1.0) {
    actions.push({
      type: PlanActionType.USE_ITEM, entityId: board.hero.id,
      item: ResourceType.HERBS, _priority: 0, _goal: HeroGoal.PROTECT_HERO,
    });
  }

  // Free action: equip best unequipped weapon
  if (board.heroWeapons.length > 0 && !heroEntity.weapon) {
    actions.push({
      type: PlanActionType.EQUIP_WEAPON, entityId: board.hero.id,
      weapon: board.heroWeapons[0], _priority: 0, _goal: HeroGoal.PROTECT_HERO,
    });
  }

  // High-priority: explore current building if unexplored (find survivors/loot).
  // Always emitted regardless of PROTECT budget — exploring your current tile is too
  // valuable to skip due to budget splits. Uses 1 AP from whichever goal has slack.
  if (board.heroInBuilding && !sim.isExplored(heroEntity.col, heroEntity.row)) {
    actions.push({
      type: PlanActionType.EXPLORE, entityId: board.hero.id,
      _priority: 1, _goal: HeroGoal.EXPLORE,
    });
    sim.applyExplore(board.hero.id);
    remaining--;
  }

  // Flee: if hero HP below shelter threshold and enemy within 2 hexes
  const shelterThreshold = config?.shelterThreshold ?? 0.4;
  if (board.heroHpRatio < shelterThreshold && remaining > 0) {
    const nearbyEnemy = sim.entities.find(e =>
      e.alive && e.owner === 'witch' &&
      hexDistance(heroEntity.col, heroEntity.row, e.col, e.row) <= 2
    );
    if (nearbyEnemy) {
      // Try to flee toward nearest building
      const shelter = nearestBuilding(sim, heroEntity);
      const fleeStep = shelter
        ? roadStepToward(sim, heroEntity, shelter)
        : stepAwayFrom(sim, heroEntity, nearbyEnemy);
      if (fleeStep) {
        actions.push({
          type: PlanActionType.MOVE, entityId: board.hero.id,
          toCol: fleeStep.col, toRow: fleeStep.row,
          _priority: 1, _goal: HeroGoal.PROTECT_HERO,
        });
        sim.applyMove(board.hero.id, fleeStep.col, fleeStep.row);
        sim.unitCommitments.set(board.hero.id, HeroGoal.PROTECT_HERO);
        remaining--;
      }
    }
  }

  return actions;
}

// ── Generator: SLAY_WITCH ───────────────────────────────────────────────────

export function genSlayWitch(sim, board, budget, config = null) {
  const actions = [];
  if (budget <= 0 || !board.hero || !board.witchVisible) return actions;
  let remaining = budget;

  const engageFloor = config?.engageFloor ?? 'unfavorable';
  const heroEntity = sim.entities.find(e => e.id === board.hero.id);
  if (!heroEntity) return actions;

  // All hero-side units
  const heroUnits = [heroEntity, ...sim.entities.filter(e =>
    e.alive && e.owner === 'hero' && e.type === EntityType.SURVIVOR
  )];

  // All enemy units (witch + minions)
  const enemies = sim.entities.filter(e => e.alive && e.owner === 'witch');

  // Battle: hero-side units adjacent to enemies
  for (const unit of heroUnits) {
    if (remaining <= 0) break;
    if (sim.unitCommitments.has(unit.id)) continue;

    for (const enemy of enemies) {
      const dist = hexDistance(unit.col, unit.row, enemy.col, enemy.row);
      if (dist <= 1) {
        const est = estimateHeroCombat(unit, enemy, board);
        if (!meetsEngageFloor(est.classification, engageFloor)) continue;

        actions.push({
          type: PlanActionType.BATTLE_UNIT, entityId: unit.id,
          targetId: enemy.id, targetCol: enemy.col, targetRow: enemy.row,
          _priority: 3, _goal: HeroGoal.SLAY_WITCH,
        });
        sim.applyBattle();
        sim.unitCommitments.set(unit.id, HeroGoal.SLAY_WITCH);
        remaining--;
        break;
      }
    }
  }

  // Chase witch: move hero toward witch (multi-step)
  if (remaining > 0 && !sim.unitCommitments.has(board.hero.id) && board.witch) {
    const witchEntity = sim.entities.find(e => e.id === board.witch.id);
    if (witchEntity) {
      let stepsLeft = Math.min(remaining, 3);
      while (stepsLeft > 0) {
        if (hexDistance(heroEntity.col, heroEntity.row, witchEntity.col, witchEntity.row) <= 1) break;
        const step = roadStepToward(sim, heroEntity, witchEntity);
        if (!step) break;

        actions.push({
          type: PlanActionType.MOVE, entityId: board.hero.id,
          toCol: step.col, toRow: step.row,
          _priority: 5, _goal: HeroGoal.SLAY_WITCH,
        });
        sim.applyMove(board.hero.id, step.col, step.row);
        remaining--;
        stepsLeft--;
      }
      sim.unitCommitments.set(board.hero.id, HeroGoal.SLAY_WITCH);
    }
  }

  return actions;
}

// ── Generator: CONTROL_NODES ────────────────────────────────────────────────

export function genControlNodes(sim, board, budget) {
  const actions = [];
  if (budget <= 0 || !board.hero) return actions;
  let remaining = budget;

  // Ally-claimed nodes to avoid (NvN coordination)
  const allyClaimed = board.allyContext?.claimedNodes;

  // Target nodes: uncovered or witch-held, plus hero-held with nearby threats
  const witchThreatensNode = (n) => sim.entities.some(e =>
    e.alive && e.owner === 'witch' &&
    hexDistance(e.col, e.row, n.obj.col, n.obj.row) <= 2
  );

  const targetNodes = board.nodes
    .filter(n => n.controller !== 'hero' || !n.heroPresent || witchThreatensNode(n))
    .map(n => ({
      ...n,
      feasibility: scoreNodeFeasibility(n, 'hero', sim.entities),
      allyClaimed: allyClaimed ? n.obj.hexes?.some(h => allyClaimed.has(hexKey(h.col, h.row))) : false,
    }))
    // Skip hopeless nodes and ally-claimed nodes
    .filter(n => n.feasibility >= 0.1 && !n.allyClaimed)
    .sort((a, b) => {
      // Primary: feasibility (higher = better opportunity)
      if (Math.abs(a.feasibility - b.feasibility) > 0.1) return b.feasibility - a.feasibility;
      return a.distToNearestHeroUnit - b.distToNearestHeroUnit;
    });

  for (const node of targetNodes) {
    if (remaining <= 0) break;

    // Allow multiple units per high-feasibility node when scoring is imminent
    const unitsForNode = (node.feasibility >= 0.6 && board.roundsToScoring <= 2) ? 2 : 1;

    for (let u = 0; u < unitsForNode; u++) {
      if (remaining <= 0) break;

      const unit = _closestUncommittedHero(sim, board, node.obj);
      if (!unit) break;

      const simUnit = sim.entities.find(e => e.id === unit.id);
      if (!simUnit) break;

      // If unit is already on the node, guard if threatened
      const onNode = node.obj.hexes
        ? node.obj.hexes.some(h => h.col === simUnit.col && h.row === simUnit.row)
        : (simUnit.col === node.obj.col && simUnit.row === node.obj.row);

      if (onNode) {
        if (witchThreatensNode(node)) {
          actions.push({
            type: PlanActionType.GUARD, entityId: simUnit.id,
            _priority: 4, _goal: HeroGoal.CONTROL_NODES,
          });
          sim.applyGuard(simUnit.id);
          sim.unitCommitments.set(simUnit.id, HeroGoal.CONTROL_NODES);
          remaining--;
        }
        continue;
      }

      // Move toward node
      sim.unitCommitments.set(simUnit.id, HeroGoal.CONTROL_NODES);
      let stepsForUnit = Math.min(remaining, 3);
      while (stepsForUnit > 0) {
        const targetHex = node.obj.hexes
          ? node.obj.hexes.reduce((best, h) => {
              const d = hexDistance(simUnit.col, simUnit.row, h.col, h.row);
              const bd = hexDistance(simUnit.col, simUnit.row, best.col, best.row);
              return d < bd ? h : best;
            }, node.obj.hexes[0])
          : node.obj;

        if (simUnit.col === targetHex.col && simUnit.row === targetHex.row) break;

        const step = roadStepToward(sim, simUnit, targetHex);
        if (!step) break;

        actions.push({
          type: PlanActionType.MOVE, entityId: simUnit.id,
          toCol: step.col, toRow: step.row,
          _priority: 5, _goal: HeroGoal.CONTROL_NODES,
        });
        sim.applyMove(simUnit.id, step.col, step.row);
        remaining--;
        stepsForUnit--;
      }
    }
  }

  return actions;
}

// ── Generator: EXPLORE ──────────────────────────────────────────────────────

export function genExplore(sim, board, budget) {
  const actions = [];
  if (budget <= 0 || !board.hero) return actions;
  let remaining = budget;

  const heroEntity = sim.entities.find(e => e.id === board.hero.id);
  if (!heroEntity) return actions;

  // Explore current building if unexplored
  if (!sim.isExplored(heroEntity.col, heroEntity.row) && !sim.unitCommitments.has(board.hero.id)) {
    const tile = sim.tiles.get(hexKey(heroEntity.col, heroEntity.row));
    if (tile && tile.type === TileType.BUILDING) {
      actions.push({
        type: PlanActionType.EXPLORE, entityId: board.hero.id,
        _priority: 4, _goal: HeroGoal.EXPLORE,
      });
      sim.applyExplore(board.hero.id);
      remaining--;
    }
  }

  // Sound Horn: spend 1 food + 1 AP to potentially recruit a hidden survivor within 4 hexes.
  // Worth it when food available, hidden survivors likely exist (unexplored buildings remain),
  // hero isn't critically injured, and we haven't already explored most of the map.
  if (remaining > 0 && board.foodCount >= 1 && board.unexploredBuildings.length >= 2 &&
      board.heroHpRatio > 0.3 && board.survivorCount < 3) {
    actions.push({
      type: PlanActionType.SOUND_HORN, entityId: board.hero.id,
      _priority: 3, _goal: HeroGoal.EXPLORE,
    });
    sim.applySoundHorn();
    remaining--;
  }

  // Move toward nearest unexplored building, then explore on arrival
  if (remaining > 0 && !sim.unitCommitments.has(board.hero.id)) {
    const building = _nearestUnexploredBuilding(sim, heroEntity);
    if (building) {
      let stepsLeft = Math.min(remaining, 3);
      while (stepsLeft > 0) {
        if (heroEntity.col === building.col && heroEntity.row === building.row) {
          // Arrived — explore
          actions.push({
            type: PlanActionType.EXPLORE, entityId: board.hero.id,
            _priority: 4, _goal: HeroGoal.EXPLORE,
          });
          sim.applyExplore(board.hero.id);
          remaining--;
          break;
        }
        const step = roadStepToward(sim, heroEntity, building);
        if (!step) break;

        actions.push({
          type: PlanActionType.MOVE, entityId: board.hero.id,
          toCol: step.col, toRow: step.row,
          _priority: 4, _goal: HeroGoal.EXPLORE,
        });
        sim.applyMove(board.hero.id, step.col, step.row);
        remaining--;
        stepsLeft--;
      }
      sim.unitCommitments.set(board.hero.id, HeroGoal.EXPLORE);
    }
  }

  return actions;
}

// ── Generator: FORTIFY_POSITION ─────────────────────────────────────────────

export function genFortifyPosition(sim, board, budget, config = null) {
  const actions = [];
  if (budget <= 0 || !board.hero) return actions;
  let remaining = budget;

  const heroEntity = sim.entities.find(e => e.id === board.hero.id);
  if (!heroEntity) return actions;

  const fortifyCap = board.isNight || board.isDawnOrDusk
    ? (config?.fortifyCapNight ?? 3)
    : (config?.fortifyCapDay ?? 1);

  // Seek shelter: if night and hero not in a building, move to nearest building
  if ((board.isNight || board.isDawnOrDusk) && !board.heroInBuilding && remaining > 0) {
    if (!sim.unitCommitments.has(board.hero.id)) {
      const shelter = nearestBuilding(sim, heroEntity);
      if (shelter) {
        let stepsLeft = Math.min(remaining, 3);
        while (stepsLeft > 0) {
          if (heroEntity.col === shelter.col && heroEntity.row === shelter.row) break;
          const step = roadStepToward(sim, heroEntity, shelter);
          if (!step) break;

          actions.push({
            type: PlanActionType.MOVE, entityId: board.hero.id,
            toCol: step.col, toRow: step.row,
            _priority: 2, _goal: HeroGoal.FORTIFY_POSITION,
          });
          sim.applyMove(board.hero.id, step.col, step.row);
          remaining--;
          stepsLeft--;
        }
        sim.unitCommitments.set(board.hero.id, HeroGoal.FORTIFY_POSITION);
      }
    }
  }

  // Fortify: if in building and below cap and has resources
  const heroTile = sim.tiles.get(hexKey(heroEntity.col, heroEntity.row));
  if (heroTile && heroTile.type === TileType.BUILDING && remaining > 0) {
    const fortLevel = heroTile.fortifyLevel || 0;
    const ledger = sim.resourceLedger;
    while (remaining > 0 && (heroTile.fortifyLevel || 0) < fortifyCap) {
      const hasWood = (ledger[ResourceType.WOOD] || 0) > 0;
      const hasMetal = (ledger[ResourceType.METAL] || 0) > 0;
      if (!hasWood && !hasMetal) break;

      actions.push({
        type: PlanActionType.FORTIFY, entityId: board.hero.id,
        _priority: 2, _goal: HeroGoal.FORTIFY_POSITION,
      });
      // Deduct from resource ledger (prefer metal for stronger fortification)
      if (hasMetal) ledger[ResourceType.METAL]--;
      else ledger[ResourceType.WOOD]--;
      heroTile.fortifyLevel = (heroTile.fortifyLevel || 0) + 1;
      sim.actionsLeft--;
      remaining--;
    }
  }

  // Shelter survivors: move unsheltered survivors to nearest building at night
  if ((board.isNight || board.isDawnOrDusk) && remaining > 0) {
    for (const s of board.survivors) {
      if (remaining <= 0) break;
      if (sim.unitCommitments.has(s.id)) continue;

      const simS = sim.entities.find(e => e.id === s.id);
      if (!simS) continue;
      if (inBuilding(sim, simS)) continue;

      const shelter = nearestBuilding(sim, simS);
      if (!shelter) continue;

      const step = roadStepToward(sim, simS, shelter);
      if (!step) continue;

      actions.push({
        type: PlanActionType.MOVE, entityId: s.id,
        toCol: step.col, toRow: step.row,
        _priority: 2, _goal: HeroGoal.FORTIFY_POSITION,
      });
      sim.applyMove(s.id, step.col, step.row);
      sim.unitCommitments.set(s.id, HeroGoal.FORTIFY_POSITION);
      remaining--;
    }
  }

  return actions;
}

// ── Hero gap-fill ───────────────────────────────────────────────────────────

// ── NvN Ally Coordination ───────────────────────────────────────────────────
// After a plan is generated, mark the node hexes targeted by this player's
// MOVE actions so the next allied AI avoids the same targets.

function _updateHeroAllyClaimedNodes(plan, board, allyContext) {
  for (const action of plan) {
    if (action.type !== PlanActionType.MOVE) continue;
    for (const node of board.nodes) {
      if (node.obj.hexes?.some(h => h.col === action.toCol && h.row === action.toRow)) {
        node.obj.hexes.forEach(h => allyContext.claimedNodes.add(hexKey(h.col, h.row)));
      }
    }
  }
}

// ── Helper: reverse-lookup personality name from config object ──────────────

function _heroPersonalityName(config) {
  for (const [name, cfg] of Object.entries(HERO_PERSONALITY_CONFIGS)) {
    if (cfg === config) return name;
  }
  return 'custom';
}

// ── HeroAIEngine ────────────────────────────────────────────────────────────

export class HeroAIEngine {
  constructor(state, onStateChange, thinkDelay = 600, playerId = null, config = null) {
    this.state = state;
    this.onStateChange = onStateChange;
    this.onBattleResult = null; // unused in planning mode, but expected by consumers
    this.thinkDelay = thinkDelay;
    this.playerId = playerId;
    this.config = config ?? HERO_PERSONALITY_CONFIGS.balanced;

    // Cross-turn anti-oscillation memory: Map<entityId, {col, row}>
    this._prevPositions = new Map();

    /** When true, generatePlan() stores intermediate data on lastDebugData. */
    this.debugCapture = false;
    /** @type {object|null} Debug snapshot from last generatePlan() call. */
    this.lastDebugData = null;
  }

  generatePlan(allyContext = null) {
    const sim = new HeroEnginePlanSimState(this.state, this.playerId);
    const board = assessHeroBoard(sim);

    // Attach ally context so generators can avoid duplicate targeting in NvN
    board.allyContext = allyContext;

    // Leaderless mode: no hero entity (shouldn't normally happen, but be safe)
    if (!board.hero) {
      this.lastDebugData = null;
      return [];
    }

    const cfg = this.config;

    // Stage 2: Score goals
    const scores = scoreHeroGoals(board, cfg.goalWeights);

    // Stage 3: Allocate budget across goals
    const budget = allocateBudget(scores, board.totalBudget);

    // Stage 4: Run generators in priority order
    // Each generator mutates sim state (positions, commitments, ledger)
    // so later generators see the projected world.
    const protectActions  = genProtectHero(sim, board, budget[HeroGoal.PROTECT_HERO], cfg);
    const fortifyActions  = genFortifyPosition(sim, board, budget[HeroGoal.FORTIFY_POSITION], cfg);
    const slayActions     = genSlayWitch(sim, board, budget[HeroGoal.SLAY_WITCH], cfg);
    const controlActions  = genControlNodes(sim, board, budget[HeroGoal.CONTROL_NODES]);
    const exploreActions  = genExplore(sim, board, budget[HeroGoal.EXPLORE]);

    // Collect all generated actions
    const allActions = [
      ...protectActions,
      ...fortifyActions,
      ...slayActions,
      ...controlActions,
      ...exploreActions,
    ];

    // Capture debug data before assemblePlan strips metadata
    if (this.debugCapture) {
      this.lastDebugData = {
        faction: 'hero',
        personality: _heroPersonalityName(this.config),
        board,
        scores: { ...scores },
        budget: { ...budget },
        actions: allActions.map(a => ({ ...a })),  // snapshot with _goal/_priority
        config: this.config,
        unitCommitments: new Map(sim.unitCommitments),
      };
    }

    // Stage 5: Assemble final plan with hero-specific gap-fill
    const heroEntity = sim.entities.find(e => e.id === board.hero.id);
    const plan = assemblePlan(allActions, sim, board, this._prevPositions,
      (plan, sim, board, remaining, prevPositions) => {
        fillGapsHero(plan, sim, board, heroEntity, remaining, prevPositions);
      }
    );

    // Update ally context with our claimed node targets so subsequent allies pick differently
    if (allyContext) {
      _updateHeroAllyClaimedNodes(plan, board, allyContext);
    }

    // Update cross-turn memory
    for (const e of sim.entities) {
      if (e.alive && e.owner === 'hero') {
        this._prevPositions.set(e.id, { col: e.col, row: e.row });
      }
    }

    return plan;
  }
}

// ── Factory helper ──────────────────────────────────────────────────────────

/** Create a HeroAIEngine with a named personality config. */
export function createHeroAI(personality, state, onStateChange, thinkDelay = 600, playerId = null) {
  const cfg = HERO_PERSONALITY_CONFIGS[personality] ?? HERO_PERSONALITY_CONFIGS.balanced;
  return new HeroAIEngine(state, onStateChange, thinkDelay, playerId, cfg);
}

// ── Register all hero personalities ─────────────────────────────────────────
// Each entry is a constructor-like function matching the (state, onChange, delay, playerId) interface.

for (const name of Object.keys(HERO_PERSONALITY_CONFIGS)) {
  HERO_PERSONALITIES[name] = class extends HeroAIEngine {
    constructor(state, onStateChange, thinkDelay = 600, playerId = null) {
      super(state, onStateChange, thinkDelay, playerId, HERO_PERSONALITY_CONFIGS[name]);
    }
  };
  Object.defineProperty(HERO_PERSONALITIES[name], 'name', { value: `HeroAI_${name}` });
}

// ── Hero gap-fill ───────────────────────────────────────────────────────────

export function fillGapsHero(plan, sim, board, heroEntity, remaining, prevPositions) {
  let left = remaining;

  // Guard if enemies nearby
  if (left > 0 && heroEntity) {
    const nearbyEnemy = sim.entities.some(e =>
      e.alive && e.owner === 'witch' &&
      hexDistance(heroEntity.col, heroEntity.row, e.col, e.row) <= 2
    );
    if (nearbyEnemy) {
      plan.push({ type: PlanActionType.GUARD, entityId: heroEntity.id });
      sim.applyGuard(heroEntity.id);
      left--;
    }
  }

  // Explore current tile if unexplored
  if (left > 0 && heroEntity && !sim.isExplored(heroEntity.col, heroEntity.row)) {
    const tile = sim.tiles.get(hexKey(heroEntity.col, heroEntity.row));
    if (tile && tile.type === TileType.BUILDING) {
      plan.push({ type: PlanActionType.EXPLORE, entityId: heroEntity.id });
      sim.applyExplore(heroEntity.id);
      left--;
    }
  }

  // Move hero toward nearest unexplored building if no enemies nearby
  if (left > 0 && heroEntity) {
    const enemyNearby = sim.entities.some(e =>
      e.alive && e.owner === 'witch' &&
      hexDistance(heroEntity.col, heroEntity.row, e.col, e.row) <= 4
    );
    if (!enemyNearby && board.unexploredBuildings.length > 0) {
      // Find nearest unexplored building from hero's current (projected) position
      let bestB = null, bestD = Infinity;
      for (const b of board.unexploredBuildings) {
        if (sim.isExplored(b.col, b.row)) continue; // may have been explored in-plan
        const d = hexDistance(heroEntity.col, heroEntity.row, b.col, b.row);
        if (d < bestD) { bestD = d; bestB = b; }
      }
      while (left > 0 && bestB) {
        if (heroEntity.col === bestB.col && heroEntity.row === bestB.row) {
          // Arrived — explore
          plan.push({ type: PlanActionType.EXPLORE, entityId: heroEntity.id });
          sim.applyExplore(heroEntity.id);
          left--;
          break;
        }
        const step = roadStepToward(sim, heroEntity, bestB);
        if (!step) break;
        const prev = prevPositions.get(heroEntity.id);
        if (prev && prev.col === step.col && prev.row === step.row) break;
        plan.push({
          type: PlanActionType.MOVE, entityId: heroEntity.id,
          toCol: step.col, toRow: step.row,
        });
        sim.applyMove(heroEntity.id, step.col, step.row);
        left--;
      }
    }
  }

  // Move uncommitted survivors toward nearest feasible uncovered node
  if (left > 0) {
    const uncoveredNodes = board.nodes
      .filter(n => n.controller !== 'hero')
      .filter(n => scoreNodeFeasibility(n, 'hero', sim.entities) >= 0.15);
    for (const s of board.survivors) {
      if (left <= 0) break;
      if (sim.unitCommitments.has(s.id)) continue;
      const simS = sim.entities.find(e => e.id === s.id);
      if (!simS) continue;

      let bestNode = null, bestDist = Infinity;
      for (const n of uncoveredNodes) {
        const d = hexDistance(simS.col, simS.row, n.obj.col, n.obj.row);
        if (d < bestDist) { bestDist = d; bestNode = n; }
      }
      if (!bestNode) continue;

      const step = roadStepToward(sim, simS, bestNode.obj);
      if (!step) continue;

      const prev = prevPositions.get(s.id);
      if (prev && prev.col === step.col && prev.row === step.row) continue;

      plan.push({
        type: PlanActionType.MOVE, entityId: simS.id,
        toCol: step.col, toRow: step.row,
      });
      sim.applyMove(simS.id, step.col, step.row);
      sim.unitCommitments.set(simS.id, 'gap-fill');
      left--;
    }
  }

  // Guard hero if nothing else to do
  if (left > 0 && heroEntity) {
    plan.push({ type: PlanActionType.GUARD, entityId: heroEntity.id });
    left--;
  }
}
