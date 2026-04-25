// Hero AI Engine — 4-goal aggressive hero AI
// All hero personalities are config-driven variants of this single engine.
//
// Pipeline: EVALUATE → SCORE → ALLOCATE → GENERATE → ASSEMBLE
//
// Goals:
//   EXPLORE         — find survivors, loot buildings, sound horn, fortify shelter
//   CONTROL_NODES   — hold power nodes, aggressively fight for them
//   PROTECT_HERO    — flee when health low, use herbs, equip weapons
//   HUNT_WITCH      — seek and destroy the witch for kill wins

import { PlanSimState, stepToward, stepAwayFrom, roadStepToward, nearestBuilding, isOnNode, inBuilding, roundsUntilScoring, scoreNodeFeasibility, HERO_PERSONALITIES } from './ai.js';
import { EnginePlanSimState, BaseAIEngine, allocateBudget, assemblePlan, clamp01, updateAllyClaimedNodes, personalityName } from './ai-engine.js';
import { hexDistance, hexKey, getNeighbors } from './hex.js';
import { Phase, nodeController } from './game.js';
import { EntityType, ADVANTAGE_CAP, expectedDieValue, isLeaderType, attackOf, defenseOf, SurvivorAbility } from './entities.js';
import { TileType, ResourceType } from './tiles.js';
import { ITEMS } from './items.js';
import { PlanActionType, MAX_PLAN_LENGTH } from './planner.js';

// ── Goal names ───────────────────────────────────────────────────────────────

export const HeroGoal = Object.freeze({
  EXPLORE:          'EXPLORE',
  CONTROL_NODES:    'CONTROL_NODES',
  PROTECT_HERO:     'PROTECT_HERO',
  HUNT_WITCH:       'HUNT_WITCH',
});

const ALL_HERO_GOALS = Object.values(HeroGoal);

// ── Hero sight range helper (phase-dependent) ─────────────────────────────
function _heroSightBase(phase) {
  switch (phase) {
    case Phase.DAY:   return 3;
    case Phase.NIGHT: return 1;
    default:          return 2; // DAWN, DUSK
  }
}

// ── Personality configs ─────────────────────────────────────────────────────

export const HERO_PERSONALITY_CONFIGS = Object.freeze({
  balanced: Object.freeze({
    goalWeights: Object.freeze({
      [HeroGoal.EXPLORE]: 1.0, [HeroGoal.CONTROL_NODES]: 1.4, [HeroGoal.PROTECT_HERO]: 0.6, [HeroGoal.HUNT_WITCH]: 0.9,
    }),
    engageFloor: 'suicidal',
    shelterThreshold: 0.2,
    fortifyCapDay: 2,
    fortifyCapNight: 3,
  }),
  aggressive: Object.freeze({
    goalWeights: Object.freeze({
      [HeroGoal.EXPLORE]: 0.7, [HeroGoal.CONTROL_NODES]: 1.2, [HeroGoal.PROTECT_HERO]: 0.3, [HeroGoal.HUNT_WITCH]: 1.4,
    }),
    engageFloor: 'suicidal',
    shelterThreshold: 0.15,
    fortifyCapDay: 1,
    fortifyCapNight: 3,
  }),
  defensive: Object.freeze({
    goalWeights: Object.freeze({
      [HeroGoal.EXPLORE]: 0.9, [HeroGoal.CONTROL_NODES]: 1.4, [HeroGoal.PROTECT_HERO]: 0.8, [HeroGoal.HUNT_WITCH]: 0.7,
    }),
    engageFloor: 'unfavorable',
    shelterThreshold: 0.3,
    fortifyCapDay: 2,
    fortifyCapNight: 4,
  }),
  explorer: Object.freeze({
    goalWeights: Object.freeze({
      [HeroGoal.EXPLORE]: 1.6, [HeroGoal.CONTROL_NODES]: 1.2, [HeroGoal.PROTECT_HERO]: 0.5, [HeroGoal.HUNT_WITCH]: 0.8,
    }),
    engageFloor: 'suicidal',
    shelterThreshold: 0.2,
    fortifyCapDay: 2,
    fortifyCapNight: 3,
  }),
  // Node denial: clear and hold every Power Node. Used by campaign
  // missions where the only victory check is "no witch on a node at dawn"
  // or "hero on every node at dawn" — exploring/hunting the witch is a
  // distraction. Heavy CONTROL_NODES, near-zero HUNT_WITCH/EXPLORE.
  node_denier: Object.freeze({
    goalWeights: Object.freeze({
      [HeroGoal.EXPLORE]: 0.3, [HeroGoal.CONTROL_NODES]: 2.2, [HeroGoal.PROTECT_HERO]: 0.4, [HeroGoal.HUNT_WITCH]: 0.2,
    }),
    engageFloor: 'suicidal',
    shelterThreshold: 0.15,
    fortifyCapDay: 1,
    fortifyCapNight: 2,
  }),
  // Witch hunter: kill the witch and nothing else. For missions where the
  // sole victory is slay_witch and node-holding is meaningless (or even
  // counterproductive — splitting from the hunting party).
  witch_hunter: Object.freeze({
    goalWeights: Object.freeze({
      [HeroGoal.EXPLORE]: 0.3, [HeroGoal.CONTROL_NODES]: 0.4, [HeroGoal.PROTECT_HERO]: 0.3, [HeroGoal.HUNT_WITCH]: 2.5,
    }),
    engageFloor: 'suicidal',
    shelterThreshold: 0.15,
    fortifyCapDay: 1,
    fortifyCapNight: 2,
  }),
});

// ── HeroEnginePlanSimState ───────────────────────────────────────────────────

export class HeroEnginePlanSimState extends EnginePlanSimState {
  constructor(realState, playerId = null) {
    super(realState, 'hero', playerId);
    this.resourceLedger = JSON.parse(JSON.stringify(this.inventory.hero || {}));
  }
}

// ── Stage 1: Board Evaluation ────────────────────────────────────────────────

export function assessHeroBoard(sim) {
  const hero = sim.hero;
  const phase = sim.phase;

  const isNight = phase === Phase.NIGHT;
  const isDay = phase === Phase.DAY;
  const isDawnOrDusk = phase === Phase.DAWN || phase === Phase.DUSK;

  const heroHp = hero?.hp ?? 0;
  const heroMaxHp = hero?.maxHp ?? hero?.hp ?? 1;
  const heroHpRatio = hero ? heroHp / (heroMaxHp || 1) : 1;

  const survivors = sim.entities.filter(e =>
    e.alive && e.owner === 'hero' && e.type === EntityType.SURVIVOR
  );
  const survivorCount = survivors.length;

  // Fog-of-war awareness
  const heroSideUnits = sim.entities.filter(e => e.alive && e.owner === 'hero');
  function _heroCanSee(target) {
    return heroSideUnits.some(viewer => {
      const range = viewer.type === EntityType.SURVIVOR && viewer.hasAbility(SurvivorAbility.SCOUT)
        ? _heroSightBase(phase) + 1
        : _heroSightBase(phase);
      return hexDistance(viewer.col, viewer.row, target.col, target.row) <= range;
    });
  }

  // Any night-side leader (Witch / Necromancer / Brute) is the "witch" for
  // the hero AI's threat evaluation.
  const witchEntity = sim.entities.find(e => e.alive && e.owner === 'witch' && isLeaderType(e.type));
  const witch = witchEntity && _heroCanSee(witchEntity) ? witchEntity : null;
  const witchVisible = !!witch;
  let witchDistance = Infinity;
  let witchHpRatio = 1;
  if (witch && hero) {
    witchDistance = hexDistance(hero.col, hero.row, witch.col, witch.row);
    witchHpRatio = witch.hp / (witch.maxHp || witch.hp || 1);
  }

  const witchMinions = sim.entities.filter(e =>
    e.alive && e.owner === 'witch' && !isLeaderType(e.type) && _heroCanSee(e)
  );
  const witchMinionCount = witchMinions.length;
  const heroArmyStrength = (hero ? attackOf(hero) + hero.hp : 0) +
    survivors.reduce((s, e) => s + attackOf(e) + e.hp, 0);
  const witchArmyStrength = (witch ? attackOf(witch) + witch.hp : 0) +
    witchMinions.reduce((s, e) => s + attackOf(e) + e.hp, 0);

  // Node state
  const objectives = sim.witchObjectives || [];
  const nodes = objectives.map(obj => {
    const controller = nodeController(obj, sim.entities);
    const heroPresent = obj.hexes
      ? obj.hexes.some(h => sim.entities.some(e => e.alive && e.owner === 'hero' && e.col === h.col && e.row === h.row))
      : sim.entities.some(e => e.alive && e.owner === 'hero' && e.col === obj.col && e.row === obj.row);
    const allWitchUnits = sim.entities.filter(e => e.alive && e.owner === 'witch');
    const witchPresent = obj.hexes
      ? obj.hexes.some(h => allWitchUnits.some(e => e.col === h.col && e.row === h.row))
      : allWitchUnits.some(e => e.col === obj.col && e.row === obj.row);

    let distToHero = Infinity;
    if (hero) distToHero = hexDistance(hero.col, hero.row, obj.col, obj.row);

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

  const heroScore = sim.nodeScore?.hero ?? 0;
  const witchScore = sim.nodeScore?.witch ?? 0;

  const heroItems = hero?.items ? { ...hero.items } : {};
  const herbCount = sim.inventory?.hero?.[ResourceType.HERBS] || 0;
  const foodCount = sim.inventory?.hero?.[ResourceType.FOOD] || 0;

  const heroWeapons = hero?.items
    ? Object.keys(hero.items).filter(k => ITEMS[k]?.kind === 'weapon' && hero.items[k] > 0)
    : [];

  const shared = sim.inventory?.hero || {};
  const woodCount = shared[ResourceType.WOOD] || 0;
  const metalCount = shared[ResourceType.METAL] || 0;
  const sharedInventory = { ...shared };

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

  const heroOnNode = hero ? isOnNode(sim, hero) : false;
  const heroInBuilding = hero ? inBuilding(sim, hero) : false;
  const heroTile = hero ? sim.tiles.get(hexKey(hero.col, hero.row)) : null;
  const heroTileExplored = heroTile ? (sim.isExplored ? sim.isExplored(heroTile.col, heroTile.row) : !!heroTile.explored) : true;
  const heroTileFortLevel = heroTile?.fortifyLevel || 0;

  let nearestEnemyDist = Infinity;
  if (hero) {
    const allVisibleEnemies = [witch, ...witchMinions].filter(Boolean);
    for (const e of allVisibleEnemies) {
      const d = hexDistance(hero.col, hero.row, e.col, e.row);
      if (d < nearestEnemyDist) nearestEnemyDist = d;
    }
  }

  const round = sim.round;
  const roundsToScoring = roundsUntilScoring(round, sim.cycleConfig);

  return {
    phase, isNight, isDay, isDawnOrDusk,
    round, roundsToScoring,
    hero,
    heroHp, heroMaxHp, heroHpRatio,
    survivors, survivorCount,
    witch, witchVisible, witchDistance, witchHpRatio,
    witchMinions, witchMinionCount,
    heroArmyStrength, witchArmyStrength,
    nodes, heroHeldCount, witchHeldCount,
    heroScore, witchScore,
    heroItems, herbCount, foodCount,
    heroWeapons,
    sharedInventory, woodCount, metalCount,
    unexploredBuildings, nearestUnexplored,
    heroOnNode, heroInBuilding, heroTileExplored, heroTileFortLevel,
    nearestEnemyDist,
    totalBudget: sim.actionsLeft,
    heroPlayerCount:  (sim.playerCounts && sim.playerCounts.hero)  || 1,
    witchPlayerCount: (sim.playerCounts && sim.playerCounts.witch) || 1,
  };
}

// ── Stage 2: Goal Scoring ────────────────────────────────────────────────────

export function scoreHeroGoals(board, goalWeights = null) {
  // PROTECT_HERO — only when genuinely critical (hero has 14HP, hard to kill)
  let protect = 0;
  if (board.heroHpRatio < 0.15) protect = 0.8;
  else if (board.heroHpRatio < 0.25) protect = 0.4;
  // Use herbs if we have them and are injured
  if (board.herbCount > 0 && board.heroHpRatio < 0.7) protect = Math.max(protect, 0.2);
  protect = clamp01(protect);

  // EXPLORE — critical early game to build survivor army
  let explore = 0;
  const nodeCount = board.nodes.length || 3;
  if (board.survivorCount === 0) {
    explore = 1.0;
  } else if (board.survivorCount < nodeCount && board.unexploredBuildings.length > 0) {
    // Need survivors for every node — keep exploring until we have enough
    explore = 0.6;
  } else {
    explore = board.unexploredBuildings.length > 0 ? 0.1 : 0;
  }
  if (board.heroInBuilding && !board.heroTileExplored) explore += 0.3;
  // Phase adjustments are minimal — always explore when needed
  if (board.isNight) explore *= 0.7;
  explore = clamp01(explore);

  // CONTROL_NODES — dominant priority, especially near scoring
  let control = 0.5;
  const uncovered = board.nodes.filter(n => n.controller !== 'hero' && !n.heroPresent).length;
  control += uncovered * 0.12;
  if (board.survivorCount >= 1) control += 0.15;
  // Witch holding 2+ nodes is an emergency — about to sweep
  if (board.witchHeldCount >= 2) control += 0.4;
  const scoreDiff = board.heroScore - board.witchScore;
  if (scoreDiff < 0) control += 0.25;
  if (scoreDiff <= -2) control += 0.3;
  if (board.witchScore >= 3) control += 0.3;
  if (board.roundsToScoring <= 2) control += 0.4;
  else if (board.roundsToScoring <= 4) control += 0.2;
  if (board.isDawnOrDusk) control *= 1.8;
  control = clamp01(control);

  // HUNT_WITCH — opportunistic kill wins when witch is close or weak
  let hunt = 0;
  if (board.witchVisible) {
    // Only allocate hunt budget when witch is reachable
    if (board.witchDistance <= 3) hunt = 0.4;
    else if (board.witchDistance <= 5) hunt = 0.2;
    // Witch is wounded — go for the kill
    if (board.witchHpRatio < 0.4) hunt = Math.max(hunt, 0.7);
    else if (board.witchHpRatio < 0.6) hunt += 0.2;
    // Daytime hero is strongest
    if (board.isDay) hunt += 0.1;
    // Near scoring — nodes matter more than hunting
    if (board.roundsToScoring <= 2) hunt *= 0.3;
    // Don't hunt when hero is low HP
    if (board.heroHpRatio < 0.3) hunt *= 0.1;
  }
  hunt = clamp01(hunt);

  const scores = {
    [HeroGoal.PROTECT_HERO]:  protect,
    [HeroGoal.EXPLORE]:       explore,
    [HeroGoal.CONTROL_NODES]: control,
    [HeroGoal.HUNT_WITCH]:    hunt,
  };

  // Apply personality goal weights
  if (goalWeights) {
    for (const g of ALL_HERO_GOALS) {
      if (goalWeights[g] != null) scores[g] = clamp01(scores[g] * goalWeights[g]);
    }
  }

  // Early-game explore focus: no enemies visible + buildings remain
  if (board.nearestEnemyDist > 4 && board.unexploredBuildings.length > 0) {
    scores[HeroGoal.EXPLORE] = clamp01(scores[HeroGoal.EXPLORE] + 0.4);
    scores[HeroGoal.PROTECT_HERO] = Math.min(scores[HeroGoal.PROTECT_HERO], 0.1);
  }
  // No enemies visible: suppress protection entirely
  if (board.nearestEnemyDist === Infinity) {
    scores[HeroGoal.PROTECT_HERO] = 0;
  }

  return scores;
}

// ── Combat estimation (hero-perspective) ─────────────────────────────────────

export function estimateHeroCombat(attacker, defender, board) {
  // Witch gets +2 ATK at night — account for it when estimating the defender's
  // effective strength (the AI should avoid attacking witch units at night).
  const defNightBonus = board.isNight && defender.owner === 'witch' ? 2 : 0;

  const allies = [board.hero, ...board.survivors].filter(e =>
    e && e.id !== attacker.id && hexDistance(e.col, e.row, defender.col, defender.row) <= 1
  );
  const gangUpDice = Math.min(allies.length, ADVANTAGE_CAP);

  const defAllies = [board.witch, ...board.witchMinions].filter(e =>
    e && e.id !== defender.id && hexDistance(e.col, e.row, defender.col, defender.row) <= 1
  );
  const defAllyDice = Math.min(defAllies.length, ADVANTAGE_CAP);

  const fortBonus = defender.fortification || 0;
  const atkBonus = attacker.attackBonus || 0;
  const defBonus = defender.defenseBonus || 0;

  const atkGangupFlat = Math.min(allies.length, ADVANTAGE_CAP);
  const defGangupFlat = Math.min(defAllies.length, ADVANTAGE_CAP);
  const expectedAtk = attackOf(attacker) + atkBonus + atkGangupFlat + expectedDieValue(gangUpDice);
  const expectedDef = defenseOf(defender) + defBonus + fortBonus + defNightBonus + defGangupFlat + expectedDieValue(defAllyDice);

  const favorability = expectedAtk - expectedDef;
  const expectedDamage = favorability > 0 ? (favorability > 3 ? 2 : 1) : 0;
  const canKill = expectedDamage >= (defender.hp || 1);

  let classification;
  if (favorability > 3)       classification = 'overwhelming';
  else if (favorability > 0)  classification = 'favorable';
  else if (favorability > -3) classification = 'unfavorable';
  else                        classification = 'suicidal';

  return { favorability, classification, expectedDamage, canKill, gangUpCount: gangUpDice };
}

function meetsEngageFloor(classification, floor) {
  if (floor === 'suicidal') return classification !== 'suicidal';
  if (floor === 'unfavorable') return classification === 'favorable' || classification === 'overwhelming';
  if (floor === 'favorable') return classification === 'overwhelming';
  return true;
}

// ── Helper: closest uncommitted hero unit to a target ───────────────────────

function _closestUncommittedHero(sim, board, target, preferSurvivors = false) {
  let best = null, bestDist = Infinity;
  const candidates = preferSurvivors
    ? [...board.survivors, board.hero].filter(e => e && e.alive)
    : [board.hero, ...board.survivors].filter(e => e && e.alive);
  for (const e of candidates) {
    if (sim.unitCommitments.has(e.id)) continue;
    const d = hexDistance(e.col, e.row, target.col, target.row);
    if (d < bestDist) { bestDist = d; best = e; }
  }
  return best;
}

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

// ── Generator: PROTECT_HERO ─────────────────────────────────────────────────
// Flee when health low, use herbs, equip weapons.

export function genProtectHero(sim, board, budget, config = null) {
  const actions = [];
  if (!board.hero) return actions;
  let remaining = budget;

  const heroEntity = sim.entities.find(e => e.id === board.hero.id);
  if (!heroEntity) return actions;

  // Heal: use herbs if hero injured (costs 1 action, from shared supply)
  let herbs = sim.inventory?.hero?.[ResourceType.HERBS] || 0;
  if (herbs > 0 && board.heroHpRatio < 1.0 && remaining > 0) {
    actions.push({
      type: PlanActionType.HEAL, entityId: board.hero.id,
      _priority: 0, _goal: HeroGoal.PROTECT_HERO,
    });
    remaining--;
    herbs--;
  }

  // Heal injured survivors with remaining shared herbs
  if (herbs > 0 && remaining > 0) {
    const injuredSurvivors = board.survivors
      .filter(s => s.hp < s.maxHp)
      .sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp)); // most injured first
    for (const s of injuredSurvivors) {
      if (herbs <= 0 || remaining <= 0) break;
      actions.push({
        type: PlanActionType.HEAL, entityId: s.id,
        _priority: 1, _goal: HeroGoal.PROTECT_HERO,
      });
      remaining--;
      herbs--;
    }
  }

  // Free action: equip best unequipped weapon
  if (board.heroWeapons.length > 0 && !heroEntity.weapon) {
    actions.push({
      type: PlanActionType.EQUIP_WEAPON, entityId: board.hero.id,
      weapon: board.heroWeapons[0], _priority: 0, _goal: HeroGoal.PROTECT_HERO,
    });
  }

  // Explore current building if unexplored (always worth doing)
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

  // Night shelter: only seek shelter when genuinely low HP, not just because it's night
  if (board.heroHpRatio < shelterThreshold && !board.heroInBuilding && remaining > 0) {
    if (!sim.unitCommitments.has(board.hero.id)) {
      const shelter = nearestBuilding(sim, heroEntity);
      if (shelter) {
        const step = roadStepToward(sim, heroEntity, shelter);
        if (step) {
          actions.push({
            type: PlanActionType.MOVE, entityId: board.hero.id,
            toCol: step.col, toRow: step.row,
            _priority: 2, _goal: HeroGoal.PROTECT_HERO,
          });
          sim.applyMove(board.hero.id, step.col, step.row);
          remaining--;
          sim.unitCommitments.set(board.hero.id, HeroGoal.PROTECT_HERO);
        }
      }
    }
  }

  // Survivors shelter only if very close to a building (1 step) — don't waste actions
  if (board.isNight && remaining > 0) {
    for (const s of board.survivors) {
      if (remaining <= 0) break;
      if (sim.unitCommitments.has(s.id)) continue;
      const simS = sim.entities.find(e => e.id === s.id);
      if (!simS) continue;
      if (inBuilding(sim, simS)) continue;

      const shelter = nearestBuilding(sim, simS);
      if (!shelter || hexDistance(simS.col, simS.row, shelter.col, shelter.row) > 1) continue;
      const step = roadStepToward(sim, simS, shelter);
      if (!step) continue;

      actions.push({
        type: PlanActionType.MOVE, entityId: s.id,
        toCol: step.col, toRow: step.row,
        _priority: 2, _goal: HeroGoal.PROTECT_HERO,
      });
      sim.applyMove(s.id, step.col, step.row);
      sim.unitCommitments.set(s.id, HeroGoal.PROTECT_HERO);
      remaining--;
    }
  }

  return actions;
}

// ── Generator: EXPLORE ──────────────────────────────────────────────────────
// Find survivors, loot buildings, sound horn. Also fortify buildings.

export function genExplore(sim, board, budget, config = null) {
  const actions = [];
  if (budget <= 0 || !board.hero) return actions;
  let remaining = budget;

  const heroEntity = sim.entities.find(e => e.id === board.hero.id);
  if (!heroEntity) return actions;

  // Always use herbs when injured — too valuable to skip (from shared supply)
  const herbs = sim.inventory?.hero?.[ResourceType.HERBS] || 0;
  if (herbs > 0 && board.heroHpRatio < 0.8 && remaining > 0) {
    actions.push({
      type: PlanActionType.HEAL, entityId: board.hero.id,
      _priority: 0, _goal: HeroGoal.EXPLORE,
    });
    remaining--;
  }


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

  // Sound Horn: spend 1 food + 1 AP to recruit hidden survivors — do it aggressively.
  // NvN: tighten the ceiling so survivor growth doesn't scale faster with team
  // size than minion growth (hidden survivors + horning compound otherwise).
  const nodeCount = board.nodes.length || 3;
  const heroCount = board.heroPlayerCount || 1;
  const survivorCeiling = heroCount > 1 ? nodeCount : nodeCount + 1;
  if (remaining > 0 && board.foodCount >= 1 && board.unexploredBuildings.length >= 1 &&
      board.survivorCount < survivorCeiling) {
    actions.push({
      type: PlanActionType.SOUND_HORN, entityId: board.hero.id,
      _priority: 3, _goal: HeroGoal.EXPLORE,
    });
    sim.applySoundHorn();
    remaining--;
  }

  // Move toward nearest unexplored building, then explore on arrival
  // Fight enemies encountered along the way (opportunistic combat)
  if (remaining > 0 && !sim.unitCommitments.has(board.hero.id)) {
    const building = _nearestUnexploredBuilding(sim, heroEntity);
    if (building) {
      const exploreEngageFloor = board.isDay ? 'suicidal' : (config?.engageFloor ?? 'unfavorable');
      let stepsLeft = Math.min(remaining, 3);
      while (stepsLeft > 0) {
        if (heroEntity.col === building.col && heroEntity.row === building.row) {
          actions.push({
            type: PlanActionType.EXPLORE, entityId: board.hero.id,
            _priority: 4, _goal: HeroGoal.EXPLORE,
          });
          sim.applyExplore(board.hero.id);
          remaining--;
          break;
        }

        // Opportunistic: fight adjacent enemies while exploring
        const allEnemies = [board.witch, ...board.witchMinions].filter(Boolean);
        const nearbyFoes = allEnemies.filter(e =>
          hexDistance(e.col, e.row, heroEntity.col, heroEntity.row) <= 1
        );
        for (const enemy of nearbyFoes) {
          if (remaining <= 0 || stepsLeft <= 0) break;
          const est = estimateHeroCombat(heroEntity, enemy, board);
          if (!meetsEngageFloor(est.classification, exploreEngageFloor)) continue;
          actions.push({
            type: PlanActionType.BATTLE_UNIT, entityId: board.hero.id,
            targetId: enemy.id, targetCol: enemy.col, targetRow: enemy.row,
            _priority: 3, _goal: HeroGoal.EXPLORE,
          });
          sim.applyBattle();
          remaining--;
          stepsLeft--;
        }
        if (remaining <= 0 || stepsLeft <= 0) break;

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

  // Fortify current position if hero has resources (only on buildings or node hexes)
  if (remaining > 0 && !sim.unitCommitments.has(board.hero.id)) {
    const heroTile = sim.tiles.get(hexKey(heroEntity.col, heroEntity.row));
    const fortifyCap = (board.isNight || board.isDawnOrDusk)
      ? (config?.fortifyCapNight ?? 3)
      : (config?.fortifyCapDay ?? 1);
    const onNode = board.nodes.some(n =>
      n.obj.hexes?.some(h => h.col === heroEntity.col && h.row === heroEntity.row)
    );

    if (heroTile && heroTile.type !== TileType.RIVER && (heroTile.type === TileType.BUILDING || onNode)) {
      const ledger = sim.resourceLedger;
      while (remaining > 0 && (heroTile.fortifyLevel || 0) < fortifyCap) {
        const hasWood = (ledger[ResourceType.WOOD] || 0) > 0;
        const hasMetal = (ledger[ResourceType.METAL] || 0) > 0;
        if (!hasWood && !hasMetal) break;

        actions.push({
          type: PlanActionType.FORTIFY, entityId: board.hero.id,
          _priority: 5, _goal: HeroGoal.EXPLORE,
        });
        if (hasMetal) ledger[ResourceType.METAL]--;
        else ledger[ResourceType.WOOD]--;
        heroTile.fortifyLevel = (heroTile.fortifyLevel || 0) + 1;
        sim.actionsLeft--;
        remaining--;
      }
    }
  }

  return actions;
}

// ── Generator: CONTROL_NODES ────────────────────────────────────────────────
// Move units to nodes. Aggressively fight anyone on or adjacent to the node.
// Fortify node buildings when occupying them.

export function genControlNodes(sim, board, budget, config = null) {
  const actions = [];
  if (budget <= 0 || !board.hero) return actions;
  let remaining = budget;

  const allyClaimed = board.allyContext?.claimedNodes;
  const configFloor = config?.engageFloor ?? 'unfavorable';
  // During daytime, hero is stronger — attack aggressively at nodes even at bad odds
  const engageFloor = board.isDay ? 'suicidal' : configFloor;

  // Witch-threatened node check
  const witchThreatensNode = (n) => sim.entities.some(e =>
    e.alive && e.owner === 'witch' &&
    hexDistance(e.col, e.row, n.obj.col, n.obj.row) <= 2
  );

  // During daytime, contest nodes even if it looks hopeless — hero is stronger during day
  const feasibilityFloor = board.isDay ? 0 : 0.05;

  const targetNodes = board.nodes
    .filter(n => n.controller !== 'hero' || !n.heroPresent || witchThreatensNode(n))
    .map(n => ({
      ...n,
      feasibility: scoreNodeFeasibility(n, 'hero', sim.entities),
      allyClaimed: allyClaimed ? n.obj.hexes?.some(h => allyClaimed.has(hexKey(h.col, h.row))) : false,
    }))
    .filter(n => n.feasibility >= feasibilityFloor && !n.allyClaimed)
    .sort((a, b) => a.distToNearestHeroUnit - b.distToNearestHeroUnit);

  for (const node of targetNodes) {
    if (remaining <= 0) break;

    // Send multiple units to nodes — overwhelm witch minions.
    // NvN: cap at 2 so hero teams don't over-concentrate 3 units on a single
    // node and leave the rest uncovered. 1v1 retains the 3-unit overwhelm.
    const enemyOnNode = node.witchPresent;
    const scoringImminent = board.roundsToScoring <= 2;
    const contested = enemyOnNode || (scoringImminent && node.feasibility >= 0.3);
    const isNvN = (board.heroPlayerCount || 1) > 1;
    const overwhelmCap = isNvN ? 2 : 3;
    const unitsForNode = enemyOnNode ? overwhelmCap : (contested ? 2 : (scoringImminent ? 2 : 1));

    for (let u = 0; u < unitsForNode; u++) {
      if (remaining <= 0) break;

      // Prefer survivors for node duty
      const unit = _closestUncommittedHero(sim, board, node.obj, true);
      if (!unit) break;

      const simUnit = sim.entities.find(e => e.id === unit.id);
      if (!simUnit) break;

      const onNode = node.obj.hexes
        ? node.obj.hexes.some(h => h.col === simUnit.col && h.row === simUnit.row)
        : (simUnit.col === node.obj.col && simUnit.row === node.obj.row);

      if (onNode) {
        // AGGRESSIVE: fight ALL enemies on or adjacent to the node — always
        const allEnemies = [board.witch, ...board.witchMinions].filter(Boolean);
        const nearbyEnemies = allEnemies.filter(e =>
          hexDistance(e.col, e.row, simUnit.col, simUnit.row) <= 1
        );
        for (const enemy of nearbyEnemies) {
          if (remaining <= 0) break;
          // At a power node, always fight — no combat gate
          actions.push({
            type: PlanActionType.BATTLE_UNIT, entityId: simUnit.id,
            targetId: enemy.id, targetCol: enemy.col, targetRow: enemy.row,
            _priority: enemyOnNode ? 2 : 3, _goal: HeroGoal.CONTROL_NODES,
          });
          sim.applyBattle();
          remaining--;
        }
        if (nearbyEnemies.length > 0) {
          sim.unitCommitments.set(simUnit.id, HeroGoal.CONTROL_NODES);
          // Guard after fighting to reduce incoming damage — especially when hero is the unit
          if (remaining > 0 && simUnit.id === board.hero?.id) {
            actions.push({
              type: PlanActionType.GUARD, entityId: simUnit.id,
              _priority: 3, _goal: HeroGoal.CONTROL_NODES,
            });
            sim.applyGuard(simUnit.id);
            remaining--;
          }
        }

        // Fortify node hex if on one and have resources (any hero-side unit)
        if (remaining > 0) {
          const nodeTile = sim.tiles.get(hexKey(simUnit.col, simUnit.row));
          const fortifyCap = (board.isNight || board.isDawnOrDusk)
            ? (config?.fortifyCapNight ?? 3)
            : (config?.fortifyCapDay ?? 1);
          if (nodeTile && nodeTile.type !== TileType.RIVER) {
            const ledger = sim.resourceLedger;
            while (remaining > 0 && (nodeTile.fortifyLevel || 0) < fortifyCap) {
              const hasWood = (ledger[ResourceType.WOOD] || 0) > 0;
              const hasMetal = (ledger[ResourceType.METAL] || 0) > 0;
              if (!hasWood && !hasMetal) break;
              actions.push({
                type: PlanActionType.FORTIFY, entityId: simUnit.id,
                _priority: 4, _goal: HeroGoal.CONTROL_NODES,
              });
              if (hasMetal) ledger[ResourceType.METAL]--;
              else ledger[ResourceType.WOOD]--;
              nodeTile.fortifyLevel = (nodeTile.fortifyLevel || 0) + 1;
              sim.actionsLeft--;
              remaining--;
            }
          }
        }

        // Guard if threats nearby but couldn't attack
        if (remaining > 0 && !sim.unitCommitments.has(simUnit.id) && witchThreatensNode(node)) {
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

      // Move toward node, fighting enemies encountered en route
      sim.unitCommitments.set(simUnit.id, HeroGoal.CONTROL_NODES);
      let stepsForUnit = Math.min(remaining, scoringImminent ? 4 : 3);
      while (stepsForUnit > 0) {
        const targetHex = node.obj.hexes
          ? node.obj.hexes.reduce((best, h) => {
              const d = hexDistance(simUnit.col, simUnit.row, h.col, h.row);
              const bd = hexDistance(simUnit.col, simUnit.row, best.col, best.row);
              return d < bd ? h : best;
            }, node.obj.hexes[0])
          : node.obj;

        if (simUnit.col === targetHex.col && simUnit.row === targetHex.row) break;

        // Fight adjacent enemies before moving
        const allEnemies = [board.witch, ...board.witchMinions].filter(Boolean);
        const adjacentEnemies = allEnemies.filter(e =>
          hexDistance(e.col, e.row, simUnit.col, simUnit.row) <= 1
        );
        for (const enemy of adjacentEnemies) {
          if (remaining <= 0 || stepsForUnit <= 0) break;
          // Heading to enemy-occupied node: fight at any odds
          if (!enemyOnNode) {
            const est = estimateHeroCombat(simUnit, enemy, board);
            if (!meetsEngageFloor(est.classification, engageFloor)) continue;
          }
          actions.push({
            type: PlanActionType.BATTLE_UNIT, entityId: simUnit.id,
            targetId: enemy.id, targetCol: enemy.col, targetRow: enemy.row,
            _priority: enemyOnNode ? 2 : 3, _goal: HeroGoal.CONTROL_NODES,
          });
          sim.applyBattle();
          remaining--;
          stepsForUnit--;
        }
        if (remaining <= 0 || stepsForUnit <= 0) break;

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

// ── Generator: HUNT_WITCH ──────────────────────────────────────────────────
// Seek and destroy the witch. Hero's 14HP/3ATK is far superior to witch's 10HP/2ATK.
// Kill the witch = instant win. Also target wounded minions and survivors.

export function genHuntWitch(sim, board, budget) {
  const actions = [];
  if (budget <= 0 || !board.hero || !board.witchVisible) return actions;
  let remaining = budget;

  const heroEntity = sim.entities.find(e => e.id === board.hero.id);
  if (!heroEntity) return actions;

  // Assess danger around the witch — avoid walking into gang-up traps
  const minionsNearWitch = board.witch ? board.witchMinions.filter(m =>
    hexDistance(m.col, m.row, board.witch.col, board.witch.row) <= 2
  ).length : 0;

  // Priority targets: kill adjacent minions first (clear path), then witch
  const targets = [];

  // Kill adjacent minions first — clear gang-up before engaging witch
  for (const m of board.witchMinions) {
    const nearHero = hexDistance(heroEntity.col, heroEntity.row, m.col, m.row) <= 1;
    if (nearHero) {
      targets.push({ entity: m, priority: 2 });
    }
  }

  // Witch — the kill win. Hero has 14HP and 3ATK, witch has 10HP and 2ATK
  // Only avoid when hero is very low HP AND surrounded
  if (board.witch) {
    const tooRisky = board.heroHpRatio < 0.3 && minionsNearWitch >= 3;
    if (!tooRisky) {
      targets.push({ entity: board.witch, priority: 1 });
    }
  }

  targets.sort((a, b) => a.priority - b.priority);

  for (const target of targets) {
    if (remaining <= 0) break;

    // Day-side leader hunts any night-side leader; any uncommitted unit
    // clears adjacent minions.
    const isEnemyLeader = target.entity.owner === 'witch' && isLeaderType(target.entity.type);
    const unit = isEnemyLeader
      ? (sim.unitCommitments.has(heroEntity.id) ? null : heroEntity)
      : _closestUncommittedHero(sim, board, target.entity, true);
    if (!unit) continue;

    const simUnit = sim.entities.find(e => e.id === unit.id);
    if (!simUnit) continue;

    const dist = hexDistance(simUnit.col, simUnit.row, target.entity.col, target.entity.row);

    // Adjacent — attack immediately
    if (dist <= 1) {
      const est = estimateHeroCombat(simUnit, target.entity, board);
      // Skip suicidal attacks on minions; always attack witch with hero
      if (est.classification === 'suicidal' && !isEnemyLeader) continue;
      actions.push({
        type: PlanActionType.BATTLE_UNIT, entityId: simUnit.id,
        targetId: target.entity.id, targetCol: target.entity.col, targetRow: target.entity.row,
        _priority: target.priority, _goal: HeroGoal.HUNT_WITCH,
      });
      sim.applyBattle();
      sim.unitCommitments.set(simUnit.id, HeroGoal.HUNT_WITCH);
      remaining--;
      continue;
    }

    // Within pursuit range — move toward and attack
    const pursuitRange = isEnemyLeader ? 6 : 2;
    if (dist <= pursuitRange) {
      sim.unitCommitments.set(simUnit.id, HeroGoal.HUNT_WITCH);
      let stepsLeft = Math.min(remaining, isEnemyLeader ? 4 : 2);

      while (stepsLeft > 0) {
        const curDist = hexDistance(simUnit.col, simUnit.row, target.entity.col, target.entity.row);
        if (curDist <= 1) {
          const est = estimateHeroCombat(simUnit, target.entity, board);
          if (est.classification !== 'suicidal' || isEnemyLeader) {
            actions.push({
              type: PlanActionType.BATTLE_UNIT, entityId: simUnit.id,
              targetId: target.entity.id, targetCol: target.entity.col, targetRow: target.entity.row,
              _priority: target.priority, _goal: HeroGoal.HUNT_WITCH,
            });
            sim.applyBattle();
            remaining--;
          }
          break;
        }

        const step = roadStepToward(sim, simUnit, target.entity);
        if (!step) break;

        actions.push({
          type: PlanActionType.MOVE, entityId: simUnit.id,
          toCol: step.col, toRow: step.row,
          _priority: target.priority + 1, _goal: HeroGoal.HUNT_WITCH,
        });
        sim.applyMove(simUnit.id, step.col, step.row);
        remaining--;
        stepsLeft--;
      }
    }
  }

  return actions;
}

// ── NvN Ally Coordination ───────────────────────────────────────────────────

// ── HeroAIEngine ────────────────────────────────────────────────────────────

export class HeroAIEngine extends BaseAIEngine {
  constructor(state, onStateChange, thinkDelay = 600, playerId = null, config = null) {
    super(state, onStateChange, thinkDelay, playerId, config,
      'hero', HERO_PERSONALITY_CONFIGS.balanced, HERO_PERSONALITY_CONFIGS);
  }

  createSim() {
    return new HeroEnginePlanSimState(this.state, this.playerId);
  }

  assessBoard(sim) { return assessHeroBoard(sim); }
  scoreGoals(board, goalWeights) { return scoreHeroGoals(board, goalWeights); }
  getLeader(board) { return board.hero; }

  getGenerators(sim, board, budget, cfg) {
    return [
      { goal: HeroGoal.PROTECT_HERO,  fn: () => genProtectHero(sim, board, budget[HeroGoal.PROTECT_HERO], cfg) },
      { goal: HeroGoal.CONTROL_NODES, fn: () => genControlNodes(sim, board, budget[HeroGoal.CONTROL_NODES], cfg) },
      { goal: HeroGoal.EXPLORE,       fn: () => genExplore(sim, board, budget[HeroGoal.EXPLORE], cfg) },
      { goal: HeroGoal.HUNT_WITCH,    fn: () => genHuntWitch(sim, board, budget[HeroGoal.HUNT_WITCH]) },
    ];
  }

  getGapFillFn(sim, board) {
    const heroEntity = sim.entities.find(e => e.id === board.hero?.id);
    if (!heroEntity) return null;
    return (plan, sim, board, remaining, prevPositions) => {
      fillGapsHero(plan, sim, board, heroEntity, remaining, prevPositions);
    };
  }
}

// ── Factory helper ──────────────────────────────────────────────────────────

export function createHeroAI(personality, state, onStateChange, thinkDelay = 600, playerId = null) {
  const cfg = HERO_PERSONALITY_CONFIGS[personality] ?? HERO_PERSONALITY_CONFIGS.balanced;
  return new HeroAIEngine(state, onStateChange, thinkDelay, playerId, cfg);
}

// ── Register all hero personalities ─────────────────────────────────────────

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
  const nodeCount = board.nodes.length || 3;
  const needsSurvivors = board.survivorCount < nodeCount;

  // 1. Attack adjacent enemies (opportunistic combat in gap fill)
  if (left > 0 && heroEntity) {
    const visibleEnemies = [board.witch, ...board.witchMinions].filter(Boolean);
    const adjacentEnemy = visibleEnemies.find(e =>
      hexDistance(heroEntity.col, heroEntity.row, e.col, e.row) <= 1
    );
    if (adjacentEnemy && !sim.unitCommitments.has(heroEntity.id)) {
      plan.push({
        type: PlanActionType.BATTLE_UNIT, entityId: heroEntity.id,
        targetId: adjacentEnemy.id, targetCol: adjacentEnemy.col, targetRow: adjacentEnemy.row,
      });
      sim.applyBattle();
      left--;
    } else {
      // Guard if enemies within 2 hexes but not adjacent
      const nearbyEnemy = visibleEnemies.some(e =>
        hexDistance(heroEntity.col, heroEntity.row, e.col, e.row) <= 2
      );
      if (nearbyEnemy) {
        plan.push({ type: PlanActionType.GUARD, entityId: heroEntity.id });
        sim.applyGuard(heroEntity.id);
        left--;
      }
    }
  }

  // 2. Explore current hex if unexplored
  if (left > 0 && heroEntity && !sim.isExplored(heroEntity.col, heroEntity.row)) {
    plan.push({ type: PlanActionType.EXPLORE, entityId: heroEntity.id });
    sim.applyExplore(heroEntity.id);
    left--;
  }

  // 2b. Sound Horn
  if (left > 0 && heroEntity && board.foodCount >= 1 &&
      board.unexploredBuildings.length >= 1 && board.survivorCount < nodeCount) {
    plan.push({ type: PlanActionType.SOUND_HORN, entityId: heroEntity.id });
    sim.applySoundHorn();
    left--;
  }

  // 3. Move hero toward buildings to find survivors
  if (left > 0 && needsSurvivors && heroEntity && !sim.unitCommitments.has(heroEntity.id)) {
    const building = _nearestUnexploredBuilding(sim, heroEntity);
    if (building) {
      while (left > 0) {
        if (heroEntity.col === building.col && heroEntity.row === building.row) {
          plan.push({ type: PlanActionType.EXPLORE, entityId: heroEntity.id });
          sim.applyExplore(heroEntity.id);
          left--;
          break;
        }
        const step = roadStepToward(sim, heroEntity, building);
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
      sim.unitCommitments.set(heroEntity.id, 'gap-fill');
    }
  }

  // 4. Move uncommitted survivors toward nearest uncovered node
  if (left > 0) {
    const uncoveredNodes = board.nodes.filter(n => n.controller !== 'hero' || !n.heroPresent);
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

  // 5. Move hero toward nearest uncovered node
  if (left > 0 && heroEntity && !sim.unitCommitments.has(heroEntity.id)) {
    const targetNodes = board.nodes
      .filter(n => !n.heroPresent)
      .sort((a, b) => {
        const da = hexDistance(heroEntity.col, heroEntity.row, a.obj.col, a.obj.row);
        const db = hexDistance(heroEntity.col, heroEntity.row, b.obj.col, b.obj.row);
        return da - db;
      });
    if (targetNodes.length > 0) {
      while (left > 0) {
        const step = roadStepToward(sim, heroEntity, targetNodes[0].obj);
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

  // 6. Last resort: explore unexplored hexes (prefer buildings)
  while (left > 0 && heroEntity) {
    if (!sim.isExplored(heroEntity.col, heroEntity.row)) {
      plan.push({ type: PlanActionType.EXPLORE, entityId: heroEntity.id });
      sim.applyExplore(heroEntity.id);
      left--;
      continue;
    }
    let bestHex = null, bestDist = Infinity;
    let bestAnyHex = null, bestAnyDist = Infinity;
    for (const [, t] of sim.tiles) {
      if (sim.isExplored(t.col, t.row)) continue;
      if (t.terrain === 'river') continue;
      const d = hexDistance(heroEntity.col, heroEntity.row, t.col, t.row);
      if (t.type === TileType.BUILDING && d < bestDist) { bestDist = d; bestHex = t; }
      if (d < bestAnyDist) { bestAnyDist = d; bestAnyHex = t; }
    }
    const target = bestHex || bestAnyHex;
    if (!target) break;
    const step = roadStepToward(sim, heroEntity, target);
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
