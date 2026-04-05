// AI Engine — 3-goal simplified witch AI
// All witch personalities are config-driven variants of this single engine.
//
// Pipeline: EVALUATE → SCORE → ALLOCATE → GENERATE → ASSEMBLE
//
// Goals:
//   BUILD_ARMY      — explore for resources, summon troops
//   CONTROL_NODES   — find and hold power nodes
//   DEFEND_WITCH    — flee when health low or outnumbered

import { PlanSimState, stepToward, stepAwayFrom, roadStepToward, bestWitchObjective, nearestBuilding, roundsUntilScoring, scoreNodeFeasibility, WITCH_PERSONALITIES } from './ai.js';
import { hexDistance, hexKey, getNeighbors } from './hex.js';
import { Phase, nodeController } from './game.js';
import { EntityType } from './entities.js';
import { TileType, ResourceType } from './tiles.js';
import { PlanActionType, MAX_PLAN_LENGTH } from './planner.js';

// ── Goal names ───────────────────────────────────────────────────────────────

export const Goal = Object.freeze({
  BUILD_ARMY:       'BUILD_ARMY',
  CONTROL_NODES:    'CONTROL_NODES',
  DEFEND_WITCH:     'DEFEND_WITCH',
});

const ALL_GOALS = Object.values(Goal);

// ── Personality configs ─────────────────────────────────────────────────────
// goalWeights: post-scoring multipliers per goal (higher = more budget share)
// fleeThreshold: witch HP ratio below which flee actions trigger
// engageFloor: minimum combat classification to attack

export const PERSONALITY_CONFIGS = Object.freeze({
  balanced: Object.freeze({
    goalWeights: Object.freeze({
      [Goal.BUILD_ARMY]: 1.0, [Goal.CONTROL_NODES]: 1.0, [Goal.DEFEND_WITCH]: 1.0,
    }),
    fleeThreshold: 0.3,
    engageFloor: 'suicidal',
  }),
  aggressive: Object.freeze({
    goalWeights: Object.freeze({
      [Goal.BUILD_ARMY]: 0.8, [Goal.CONTROL_NODES]: 0.6, [Goal.DEFEND_WITCH]: 0.5,
    }),
    fleeThreshold: 0.15,
    engageFloor: 'suicidal',
  }),
  swarm: Object.freeze({
    goalWeights: Object.freeze({
      [Goal.BUILD_ARMY]: 1.5, [Goal.CONTROL_NODES]: 1.2, [Goal.DEFEND_WITCH]: 1.3,
    }),
    fleeThreshold: 0.4,
    engageFloor: 'unfavorable',
  }),
});

// ── EnginePlanSimState ───────────────────────────────────────────────────────
// Extends PlanSimState with extra tracking for the engine pipeline.

export class EnginePlanSimState extends PlanSimState {
  constructor(realState, faction, playerId = null) {
    super(realState, faction, playerId);

    // Map<entityId, Set<hexKey>> — hexes each unit departed during this plan
    this.departedHexes = new Map();

    // Map<entityId, string> — locks a unit to a goal name
    this.unitCommitments = new Map();

    // Independent copy of witch inventory for tracking projected spend
    this.resourceLedger = JSON.parse(JSON.stringify(this.inventory.witch));
  }

  applyMove(entityId, toCol, toRow) {
    const e = this.entities.find(e => e.id === entityId);
    if (e) {
      // Only record the entity's INITIAL position as a departed hex.
      // Recording every intermediate stop caused the anti-oscillation filter
      // in assemblePlan to incorrectly reject forward moves along multi-step
      // road paths (e.g. A→C→E: C was flagged as departed, so MOVE→C got
      // filtered out, leaving only the unreachable MOVE→E).
      if (!this.departedHexes.has(entityId)) {
        this.departedHexes.set(entityId, new Set());
        this.departedHexes.get(entityId).add(hexKey(e.col, e.row));
      }
    }
    super.applyMove(entityId, toCol, toRow);
  }
}

// ── Stage 1: Board Evaluation ────────────────────────────────────────────────

export function assessBoard(sim) {
  const witch = sim.witch;
  const phase = sim.phase;

  const isNight = phase === Phase.NIGHT;
  const isDay = phase === Phase.DAY;
  const isDawnOrDusk = phase === Phase.DAWN || phase === Phase.DUSK;

  // Unit census
  const witchUnits = sim.entities.filter(e =>
    e.alive && e.owner === 'witch' && e.type !== EntityType.WITCH
  );
  const minions = witchUnits;
  const minionCount = minions.length;
  const armyStrength = minions.reduce((sum, e) => sum + e.hp, 0);

  // Visible heroes — filtered by fog-of-war awareness.
  const WITCH_LEADER_SIGHT = 4;
  const WITCH_MINION_SIGHT = 2;
  const allHeroes = sim.entities.filter(e => e.alive && e.owner === 'hero');
  const witchSideUnits = sim.entities.filter(e => e.alive && e.owner === 'witch');
  const visibleHeroes = allHeroes.filter(hero =>
    witchSideUnits.some(w => {
      const sight = w.type === EntityType.WITCH ? WITCH_LEADER_SIGHT : WITCH_MINION_SIGHT;
      return hexDistance(w.col, w.row, hero.col, hero.row) <= sight;
    })
  );

  let heroDistance = Infinity;
  let heroHpRatio = 1;
  if (witch && visibleHeroes.length > 0) {
    let nearest = null;
    let nearestDist = Infinity;
    for (const h of visibleHeroes) {
      const d = hexDistance(witch.col, witch.row, h.col, h.row);
      if (d < nearestDist) { nearestDist = d; nearest = h; }
    }
    heroDistance = nearestDist;
    if (nearest) heroHpRatio = nearest.hp / (nearest.maxHp || nearest.hp || 1);
  }

  // Node state
  const objectives = sim.witchObjectives || [];
  const nodes = objectives.map(obj => {
    const controller = nodeController(obj, sim.entities);
    const witchPresent = obj.hexes
      ? obj.hexes.some(h => sim.entities.some(e => e.alive && e.owner === 'witch' && e.col === h.col && e.row === h.row))
      : sim.entities.some(e => e.alive && e.owner === 'witch' && e.col === obj.col && e.row === obj.row);
    const heroPresent = obj.hexes
      ? obj.hexes.some(h => visibleHeroes.some(e => e.col === h.col && e.row === h.row))
      : visibleHeroes.some(e => e.col === obj.col && e.row === obj.row);

    let distToNearest = Infinity;
    if (witch) {
      const witchAll = sim.entities.filter(e => e.alive && e.owner === 'witch');
      for (const e of witchAll) {
        const d = hexDistance(e.col, e.row, obj.col, obj.row);
        if (d < distToNearest) distToNearest = d;
      }
    }

    return { obj, controller, witchPresent, heroPresent, distToNearest };
  });
  const witchHeldCount = nodes.filter(n => n.controller === 'witch').length;
  const heroHeldCount = nodes.filter(n => n.controller === 'hero').length;

  // Scores
  const witchScore = sim.nodeScore?.witch ?? 0;
  const heroScore = sim.nodeScore?.hero ?? 0;

  // Resources
  const inv = sim.inventory?.witch || {};
  const metalCount = inv[ResourceType.METAL] || 0;
  const woodCount = inv[ResourceType.WOOD] || 0;
  const totalResources = Object.values(inv).reduce((s, v) => s + (v || 0), 0);
  const canAffordSummon = totalResources >= 2;
  let bestSummonType = null;
  if (canAffordSummon) {
    if (metalCount >= 2) bestSummonType = EntityType.IRON_GOLEM;
    else if (woodCount >= 2) bestSummonType = EntityType.WOOD_GOLEM;
    else bestSummonType = EntityType.MINION;
  }

  // Unexplored buildings
  const unexploredBuildings = [];
  for (const [, t] of sim.tiles) {
    if (t.type === TileType.BUILDING && !t.explored) {
      unexploredBuildings.push(t);
    }
  }

  // Scoring-phase timing
  const round = sim.round;
  const roundsToScoring = roundsUntilScoring(round);

  // Count enemy units near witch for outnumbered check
  const enemiesNearWitch = witch ? visibleHeroes.filter(h =>
    hexDistance(witch.col, witch.row, h.col, h.row) <= 3
  ).length : 0;

  return {
    phase, isNight, isDay, isDawnOrDusk,
    round, roundsToScoring,
    witch,
    witchHp: witch?.hp ?? 0,
    witchMaxHp: witch?.maxHp ?? witch?.hp ?? 1,
    witchHpRatio: witch ? witch.hp / (witch.maxHp || witch.hp || 1) : 1,
    minions, minionCount, armyStrength,
    visibleHeroes, heroDistance, heroHpRatio, enemiesNearWitch,
    nodes, witchHeldCount, heroHeldCount,
    witchScore, heroScore,
    totalResources, metalCount, woodCount, canAffordSummon, bestSummonType,
    unexploredBuildings,
    totalBudget: sim.actionsLeft,
  };
}

// ── Stage 2: Goal Scoring ────────────────────────────────────────────────────

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

export function scoreGoals(board, goalWeights = null) {
  // DEFEND_WITCH — high when HP low or outnumbered near hero
  let defend = 0;
  if (board.witchHpRatio < 0.3) defend = 1.0;
  else if (board.witchHpRatio < 0.5) defend = 0.6;
  if (board.heroDistance <= 2 && board.witchHpRatio < 0.5) defend = 1.0;
  if (board.enemiesNearWitch > board.minionCount + 1) defend = Math.max(defend, 0.8);
  defend = clamp01(defend);

  // BUILD_ARMY — high when few minions, drops off once nodes are covered
  let army = 0;
  const nodeCount = board.nodes.length || 3;
  if (board.minionCount < nodeCount) {
    // Fewer minions than nodes — need more bodies
    army = 0.8;
  } else if (board.minionCount < nodeCount + 1) {
    // One reserve minion
    army = 0.4;
  } else {
    // Enough minions — focus on nodes instead
    army = 0.1;
  }
  // Boost if we have resources to spend but few minions
  if (board.canAffordSummon && board.minionCount < nodeCount) army = Math.max(army, 0.9);
  // If no resources and nothing to explore, army building is less useful
  if (!board.canAffordSummon && board.unexploredBuildings.length === 0) army *= 0.3;
  army = clamp01(army);

  // CONTROL_NODES — based on uncovered/contested nodes
  let control = 0.4;
  const uncovered = board.nodes.filter(n => n.controller !== 'witch' || !n.witchPresent).length;
  const allCovered = uncovered === 0;
  control += uncovered * 0.15;
  if (board.heroScore >= 3) control += 0.3;
  if (board.heroHeldCount > 0) control += 0.2;
  if (board.heroHeldCount > board.witchHeldCount) control += 0.25;
  if (board.roundsToScoring <= 2) control += 0.2;
  else if (board.roundsToScoring <= 1) control += 0.15;
  const controlMult = board.isDawnOrDusk ? 1.8 : 1.0;
  control = clamp01(clamp01(control) * controlMult);

  // If all nodes are covered with witch units, reduce control priority slightly
  // but don't shift to army building — keep defending nodes
  if (allCovered) {
    control *= 0.6;
  }

  const scores = {
    [Goal.DEFEND_WITCH]:  defend,
    [Goal.BUILD_ARMY]:    army,
    [Goal.CONTROL_NODES]: control,
  };

  // Apply personality goal weights
  if (goalWeights) {
    for (const g of ALL_GOALS) {
      if (goalWeights[g] != null) scores[g] = clamp01(scores[g] * goalWeights[g]);
    }
  }

  // Early-game focus: no enemies visible + unexplored buildings + few minions → build army
  if (board.visibleHeroes.length === 0 && board.unexploredBuildings.length > 0 &&
      board.minionCount < nodeCount + 1) {
    scores[Goal.BUILD_ARMY] = clamp01(scores[Goal.BUILD_ARMY] + 0.4);
    scores[Goal.DEFEND_WITCH] = Math.min(scores[Goal.DEFEND_WITCH], 0.1);
  }

  return scores;
}

// ── Stage 3: Budget Allocation ───────────────────────────────────────────────

const URGENCY_THRESHOLD = 0.05;

export function allocateBudget(scores, totalBudget) {
  const MIN_CHUNK = 2;

  const allGoals = Object.keys(scores);
  const result = {};
  for (const g of allGoals) result[g] = 0;

  if (totalBudget <= 0) return result;

  const qualifying = allGoals
    .filter(g => scores[g] > URGENCY_THRESHOLD)
    .sort((a, b) => scores[b] - scores[a]);

  if (qualifying.length === 0) {
    result[allGoals[0]] = totalBudget;
    return result;
  }

  const maxActive = Math.max(1, Math.floor(totalBudget / MIN_CHUNK));
  const active = qualifying.slice(0, maxActive);

  const totalUrgency = active.reduce((s, g) => s + scores[g], 0);
  for (const g of active) {
    result[g] = Math.floor((scores[g] / totalUrgency) * totalBudget);
  }

  let remainder = totalBudget - active.reduce((s, g) => s + result[g], 0);
  let i = 0;
  while (remainder > 0) {
    result[active[i % active.length]]++;
    remainder--;
    i++;
  }

  for (const g of active) {
    if (result[g] > 0 && result[g] < MIN_CHUNK) {
      const deficit = MIN_CHUNK - result[g];
      for (let d = active.length - 1; d >= 0; d--) {
        if (active[d] === g) continue;
        const give = Math.min(deficit, result[active[d]] - MIN_CHUNK);
        if (give > 0) {
          result[active[d]] -= give;
          result[g] += give;
          if (result[g] >= MIN_CHUNK) break;
        }
      }
    }
  }

  return result;
}

// ── Combat estimation helper ────────────────────────────────────────────────

export function estimateCombat(attacker, defender, board) {
  const nightBonus = board.isNight && attacker.owner === 'witch' ? 2 : 0;

  const gangUpCount = board.minions.filter(m =>
    m.id !== attacker.id && hexDistance(m.col, m.row, defender.col, defender.row) <= 1
  ).length;
  const gangUpDice = Math.min(gangUpCount, 3);

  const defAllyCount = (board.visibleHeroes || []).filter(h =>
    h.id !== defender.id && hexDistance(h.col, h.row, defender.col, defender.row) <= 1
  ).length;
  const defAllyDice = Math.min(defAllyCount, 3);

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

// ── Helper: pick uncommitted unit closest to a target ───────────────────────

function _closestUncommitted(sim, board, target, preferMinions = false) {
  let best = null, bestDist = Infinity;
  const candidates = preferMinions
    ? [...board.minions, board.witch].filter(e => e && e.alive)
    : [board.witch, ...board.minions].filter(e => e && e.alive);
  for (const e of candidates) {
    if (sim.unitCommitments.has(e.id)) continue;
    const d = hexDistance(e.col, e.row, target.col, target.row);
    if (d < bestDist) { bestDist = d; best = e; }
  }
  return best;
}

// ── Generator: DEFEND_WITCH ─────────────────────────────────────────────────
// Flee from hero when HP low or outnumbered. Use herbs if available.

export function genDefendWitch(sim, board, budget, config = null) {
  const actions = [];
  if (budget <= 0 || !board.witch) return actions;
  let remaining = budget;

  // Free action: use herbs if witch is injured
  const witchEntity = sim.entities.find(e => e.id === board.witch.id);
  const herbs = witchEntity?.items?.[ResourceType.HERBS] || 0;
  if (herbs > 0 && board.witchHpRatio < 1.0) {
    actions.push({
      type: PlanActionType.USE_ITEM, entityId: board.witch.id,
      item: ResourceType.HERBS, _priority: 0, _goal: Goal.DEFEND_WITCH,
    });
  }

  // Flee away from nearest hero until out of sight
  const fleeThreshold = config?.fleeThreshold ?? 0.3;
  const shouldFlee = (board.witchHpRatio < fleeThreshold) ||
    (board.enemiesNearWitch > board.minionCount + 1);

  if (shouldFlee && board.visibleHeroes.length > 0 && remaining > 0) {
    const nearestHero = board.visibleHeroes.reduce((best, h) => {
      const d = hexDistance(board.witch.col, board.witch.row, h.col, h.row);
      const bd = best ? hexDistance(board.witch.col, board.witch.row, best.col, best.row) : Infinity;
      return d < bd ? h : best;
    }, null);

    if (nearestHero) {
      sim.unitCommitments.set(board.witch.id, Goal.DEFEND_WITCH);
      // Keep fleeing until budget exhausted or out of sight range (>4 hexes)
      while (remaining > 0) {
        const currentWitch = sim.entities.find(e => e.id === board.witch.id);
        const dist = hexDistance(currentWitch.col, currentWitch.row, nearestHero.col, nearestHero.row);
        if (dist > 4) break; // out of sight range

        const fleeStep = stepAwayFrom(sim, currentWitch, nearestHero);
        if (!fleeStep) break;

        actions.push({
          type: PlanActionType.MOVE, entityId: board.witch.id,
          toCol: fleeStep.col, toRow: fleeStep.row,
          _priority: 1, _goal: Goal.DEFEND_WITCH,
        });
        sim.applyMove(board.witch.id, fleeStep.col, fleeStep.row);
        remaining--;
      }
    }
  }

  // Interpose nearest minion between witch and hero threat
  if (board.heroDistance <= 3 && board.minions.length > 0 && remaining > 0) {
    const nearestHero = board.visibleHeroes[0];
    if (nearestHero) {
      let guard = null, guardDist = Infinity;
      for (const m of board.minions) {
        if (sim.unitCommitments.has(m.id)) continue;
        const d = hexDistance(m.col, m.row, board.witch.col, board.witch.row);
        if (d < guardDist) { guardDist = d; guard = m; }
      }
      if (guard) {
        const simGuard = sim.entities.find(e => e.id === guard.id);
        const step = roadStepToward(sim, simGuard, witchEntity);
        if (step) {
          actions.push({
            type: PlanActionType.MOVE, entityId: guard.id,
            toCol: step.col, toRow: step.row,
            _priority: 1, _goal: Goal.DEFEND_WITCH,
          });
          sim.applyMove(guard.id, step.col, step.row);
          sim.unitCommitments.set(guard.id, Goal.DEFEND_WITCH);
          remaining--;
        }
      }
    }
  }

  return actions;
}

// Pick an unexplored building for the witch to explore.
// Prefers nearby buildings but adds randomness to avoid straight-line movement.
function _pickExploreBuilding(sim, actor) {
  const candidates = [];
  for (const [, t] of sim.tiles) {
    if (t.type !== TileType.BUILDING) continue;
    if (sim.isExplored(t.col, t.row)) continue;
    const d = hexDistance(actor.col, actor.row, t.col, t.row);
    candidates.push({ tile: t, dist: d });
  }
  if (candidates.length === 0) return null;
  // Sort by distance, then pick randomly from the closest few
  candidates.sort((a, b) => a.dist - b.dist);
  const pickFrom = Math.min(candidates.length, 3);
  return candidates[Math.floor(Math.random() * pickFrom)].tile;
}

// ── Generator: BUILD_ARMY ───────────────────────────────────────────────────
// Combination of exploring for resources and summoning troops.
// Witch moves to unexplored areas, explores, summons when affordable.

export function genBuildArmy(sim, board, budget) {
  const actions = [];
  if (budget <= 0 || !board.witch) return actions;
  let remaining = budget;

  const witchEntity = sim.entities.find(e => e.id === board.witch.id);
  if (!witchEntity) return actions;

  // Only witch can explore and summon — commit her to this goal if uncommitted
  if (!sim.unitCommitments.has(board.witch.id)) {
    sim.unitCommitments.set(board.witch.id, Goal.BUILD_ARMY);
  } else if (sim.unitCommitments.get(board.witch.id) !== Goal.BUILD_ARMY) {
    // Witch is committed elsewhere — can only do summons (free of movement)
    return _trySummons(actions, sim, board, remaining);
  }

  // Phase 1: Summon if we can afford it (before exploring, to use existing resources)
  const summonResult = _trySummons(actions, sim, board, remaining);
  remaining -= (summonResult.length - actions.length);
  // actions already mutated by _trySummons via shared ref — recount
  remaining = budget - actions.filter(a => a.type !== PlanActionType.USE_ITEM).length;

  // Phase 2: Explore current hex if unexplored
  if (remaining > 0 && !sim.isExplored(witchEntity.col, witchEntity.row)) {
    actions.push({
      type: PlanActionType.EXPLORE, entityId: board.witch.id,
      _priority: 2, _goal: Goal.BUILD_ARMY,
    });
    sim.applyExplore(board.witch.id);
    remaining--;

    // After exploring, maybe we can now summon
    const postExplore = _trySummons([], sim, board, remaining);
    actions.push(...postExplore);
    remaining -= postExplore.filter(a => a.type !== PlanActionType.USE_ITEM).length;
  }

  // Phase 3: Move toward an unexplored building (prefer nearby, with some randomness)
  if (remaining > 0) {
    const building = _pickExploreBuilding(sim, witchEntity);
    if (building) {
      let stepsLeft = Math.min(remaining, 3);
      while (stepsLeft > 0) {
        if (witchEntity.col === building.col && witchEntity.row === building.row) {
          // Arrived — explore
          actions.push({
            type: PlanActionType.EXPLORE, entityId: board.witch.id,
            _priority: 2, _goal: Goal.BUILD_ARMY,
          });
          sim.applyExplore(board.witch.id);
          remaining--;

          // After exploring, try to summon
          const postArr = _trySummons([], sim, board, remaining);
          actions.push(...postArr);
          remaining -= postArr.filter(a => a.type !== PlanActionType.USE_ITEM).length;
          break;
        }

        // Opportunity attack while exploring (especially at night)
        const nearbyFoes = board.visibleHeroes.filter(h =>
          hexDistance(h.col, h.row, witchEntity.col, witchEntity.row) <= 1
        );
        for (const enemy of nearbyFoes) {
          if (remaining <= 0 || stepsLeft <= 0) break;
          const est = estimateCombat(witchEntity, enemy, board);
          if (est.classification === 'suicidal') continue;
          if (!board.isNight && est.classification === 'unfavorable') continue;
          actions.push({
            type: PlanActionType.BATTLE_UNIT, entityId: board.witch.id,
            targetId: enemy.id, targetCol: enemy.col, targetRow: enemy.row,
            _priority: 3, _goal: Goal.BUILD_ARMY,
          });
          sim.applyBattle();
          remaining--;
          stepsLeft--;
        }
        if (remaining <= 0 || stepsLeft <= 0) break;

        const step = roadStepToward(sim, witchEntity, building);
        if (!step) break;

        actions.push({
          type: PlanActionType.MOVE, entityId: board.witch.id,
          toCol: step.col, toRow: step.row,
          _priority: 2, _goal: Goal.BUILD_ARMY,
        });
        sim.applyMove(board.witch.id, step.col, step.row);
        remaining--;
        stepsLeft--;
      }
    } else {
      // No unexplored buildings — pick a random unexplored hex to wander toward
      while (remaining > 0) {
        if (!sim.isExplored(witchEntity.col, witchEntity.row)) {
          actions.push({
            type: PlanActionType.EXPLORE, entityId: board.witch.id,
            _priority: 2, _goal: Goal.BUILD_ARMY,
          });
          sim.applyExplore(board.witch.id);
          remaining--;
          continue;
        }
        // Gather nearby unexplored hexes and pick one at random
        const candidates = [];
        for (const [, t] of sim.tiles) {
          if (sim.isExplored(t.col, t.row)) continue;
          if (t.terrain === 'river') continue;
          const d = hexDistance(witchEntity.col, witchEntity.row, t.col, t.row);
          if (d <= 5) candidates.push(t);
        }
        // If nothing nearby, widen to all unexplored
        if (candidates.length === 0) {
          for (const [, t] of sim.tiles) {
            if (sim.isExplored(t.col, t.row)) continue;
            if (t.terrain === 'river') continue;
            candidates.push(t);
          }
        }
        if (candidates.length === 0) break;
        const target = candidates[Math.floor(Math.random() * candidates.length)];
        const step = roadStepToward(sim, witchEntity, target);
        if (!step) break;

        actions.push({
          type: PlanActionType.MOVE, entityId: board.witch.id,
          toCol: step.col, toRow: step.row,
          _priority: 2, _goal: Goal.BUILD_ARMY,
        });
        sim.applyMove(board.witch.id, step.col, step.row);
        remaining--;
      }
    }
  }

  return actions;
}

function _trySummons(actions, sim, board, remaining) {
  if (!board.witch || remaining <= 0) return actions;

  const armyCap = (board.isNight || board.phase === Phase.DUSK) ? 8 : 5;
  let currentArmy = board.minionCount;

  while (remaining > 0 && currentArmy < armyCap) {
    const ledger = sim.resourceLedger;
    const metal = ledger[ResourceType.METAL] || 0;
    const wood = ledger[ResourceType.WOOD] || 0;
    const total = Object.values(ledger).reduce((s, v) => s + (v || 0), 0);

    if (total < 2) break;

    let summonType;
    if (metal >= 2) summonType = EntityType.IRON_GOLEM;
    else if (wood >= 2) summonType = EntityType.WOOD_GOLEM;
    else summonType = EntityType.MINION;

    if (summonType === EntityType.IRON_GOLEM) {
      ledger[ResourceType.METAL] -= 2;
    } else if (summonType === EntityType.WOOD_GOLEM) {
      ledger[ResourceType.WOOD] -= 2;
    } else {
      const keys = Object.keys(ledger).filter(k => ledger[k] > 0).sort((a, b) => ledger[b] - ledger[a]);
      let spend = 2;
      for (const k of keys) {
        const take = Math.min(ledger[k], spend);
        ledger[k] -= take;
        spend -= take;
        if (spend === 0) break;
      }
    }

    actions.push({
      type: PlanActionType.SUMMON, entityId: board.witch.id,
      _priority: 2, _goal: Goal.BUILD_ARMY,
    });
    sim.applySummon(board.witch);
    currentArmy++;
    remaining--;
  }

  return actions;
}

// ── Generator: CONTROL_NODES ────────────────────────────────────────────────
// Move units to power nodes and defend them. Prefer sending minions.
// If node not yet discovered, move toward unexplored areas.

export function genControlNodes(sim, board, budget) {
  const actions = [];
  if (budget <= 0 || !board.witch) return actions;
  let remaining = budget;

  // Ally-claimed nodes to avoid (NvN coordination)
  const allyClaimed = board.allyContext?.claimedNodes;

  // Hero-threatened node check (hero within 2 hexes of node)
  const heroThreatenedNode = (n) => board.visibleHeroes.some(h =>
    hexDistance(h.col, h.row, n.obj.col, n.obj.row) <= 2
  );

  // Score and sort nodes
  const targetNodes = board.nodes
    .filter(n => n.controller !== 'witch' || !n.witchPresent || n.heroPresent || heroThreatenedNode(n))
    .map(n => ({
      ...n,
      feasibility: scoreNodeFeasibility(n, 'witch', sim.entities),
      allyClaimed: allyClaimed ? n.obj.hexes?.some(h => allyClaimed.has(hexKey(h.col, h.row))) : false,
    }))
    .filter(n => n.feasibility >= 0.15 && !n.allyClaimed)
    .sort((a, b) => {
      const aPrio = a.controller === 'hero' ? 0 : (a.controller === 'witch' && a.witchPresent ? 2 : 1);
      const bPrio = b.controller === 'hero' ? 0 : (b.controller === 'witch' && b.witchPresent ? 2 : 1);
      if (aPrio !== bPrio) return aPrio - bPrio;
      return a.distToNearest - b.distToNearest;
    });

  for (const node of targetNodes) {
    if (remaining <= 0) break;

    // Prefer minions for node control (witch should be exploring/summoning)
    const unit = _closestUncommitted(sim, board, node.obj, true);
    if (!unit) continue;

    const simUnit = sim.entities.find(e => e.id === unit.id);
    if (!simUnit) continue;

    const onNode = node.obj.hexes
      ? node.obj.hexes.some(h => h.col === simUnit.col && h.row === simUnit.row)
      : (simUnit.col === node.obj.col && simUnit.row === node.obj.row);

    if (onNode) {
      // AGGRESSIVE: fight ALL enemies on or adjacent to the node
      const adjacentEnemies = board.visibleHeroes.filter(h =>
        hexDistance(h.col, h.row, simUnit.col, simUnit.row) <= 1
      );
      for (const enemy of adjacentEnemies) {
        if (remaining <= 0) break;
        const est = estimateCombat(simUnit, enemy, board);
        if (est.classification === 'suicidal') continue;
        actions.push({
          type: PlanActionType.BATTLE_UNIT, entityId: simUnit.id,
          targetId: enemy.id, targetCol: enemy.col, targetRow: enemy.row,
          _priority: 3, _goal: Goal.CONTROL_NODES,
        });
        sim.applyBattle();
        remaining--;
      }
      if (adjacentEnemies.length > 0) {
        sim.unitCommitments.set(simUnit.id, Goal.CONTROL_NODES);
      }
      // Guard if threats nearby but couldn't attack
      if (remaining > 0 && !sim.unitCommitments.has(simUnit.id)) {
        const nearbyThreat = board.visibleHeroes.some(h =>
          hexDistance(h.col, h.row, simUnit.col, simUnit.row) <= 2
        );
        if (nearbyThreat) {
          actions.push({
            type: PlanActionType.GUARD, entityId: simUnit.id,
            _priority: 4, _goal: Goal.CONTROL_NODES,
          });
          sim.applyGuard(simUnit.id);
          sim.unitCommitments.set(simUnit.id, Goal.CONTROL_NODES);
          remaining--;
        }
      }
      continue;
    }

    // Move toward node, attacking enemies encountered en route
    sim.unitCommitments.set(simUnit.id, Goal.CONTROL_NODES);
    let stepsForUnit = Math.min(remaining, 3);
    while (stepsForUnit > 0) {
      // Opportunity attack: fight adjacent hero units while moving
      const adjacentFoes = board.visibleHeroes.filter(h =>
        hexDistance(h.col, h.row, simUnit.col, simUnit.row) <= 1
      );
      for (const enemy of adjacentFoes) {
        if (remaining <= 0 || stepsForUnit <= 0) break;
        const est = estimateCombat(simUnit, enemy, board);
        if (est.classification === 'suicidal') continue;
        // At night, witch is stronger — attack even at unfavorable odds
        if (!board.isNight && est.classification === 'unfavorable') continue;
        actions.push({
          type: PlanActionType.BATTLE_UNIT, entityId: simUnit.id,
          targetId: enemy.id, targetCol: enemy.col, targetRow: enemy.row,
          _priority: 3, _goal: Goal.CONTROL_NODES,
        });
        sim.applyBattle();
        remaining--;
        stepsForUnit--;
      }
      if (remaining <= 0 || stepsForUnit <= 0) break;

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
        _priority: 4, _goal: Goal.CONTROL_NODES,
      });
      sim.applyMove(simUnit.id, step.col, step.row);
      remaining--;
      stepsForUnit--;
    }
  }

  return actions;
}

// ── Stage 5: Plan Assembly ──────────────────────────────────────────────────

const FREE_ACTIONS = new Set([PlanActionType.USE_ITEM, PlanActionType.EQUIP_WEAPON]);

export function assemblePlan(allActions, sim, board, prevPositions, gapFillFn = null) {
  // 1. Sort by priority (lower = higher priority)
  const sorted = [...allActions].sort((a, b) => (a._priority ?? 99) - (b._priority ?? 99));

  // 2. Anti-oscillation filter — remove from the END of each entity's chain
  //    first, so earlier (higher-priority) moves in a sequence are preserved.
  const removeSet = new Set();
  for (let i = sorted.length - 1; i >= 0; i--) {
    const action = sorted[i];
    if (action.type !== PlanActionType.MOVE) continue;
    const departed = sim.departedHexes.get(action.entityId);
    if (departed && departed.has(hexKey(action.toCol, action.toRow))) {
      removeSet.add(i);
      continue;
    }
    const prev = prevPositions.get(action.entityId);
    if (prev && prev.col === action.toCol && prev.row === action.toRow) {
      removeSet.add(i);
    }
  }
  const filtered = sorted.filter((_, i) => !removeSet.has(i));

  // 3. Deduplicate
  const seen = new Set();
  const deduped = filtered.filter(action => {
    let key;
    if (action.type === PlanActionType.MOVE) {
      key = `${action.entityId}:move:${action.toCol},${action.toRow}`;
    } else if (action.type === PlanActionType.BATTLE_UNIT) {
      key = `${action.entityId}:battle:${action.targetId}`;
    } else {
      key = `${action.entityId}:${action.type}`;
    }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 4. Enforce budget
  const budgetCapped = [];
  let apUsed = 0;
  const totalBudget = board.totalBudget;
  for (const action of deduped) {
    if (FREE_ACTIONS.has(action.type)) {
      budgetCapped.push(action);
      continue;
    }
    if (apUsed < totalBudget) {
      budgetCapped.push(action);
      apUsed++;
    }
  }

  // 5. Gap-fill
  const gapRemaining = totalBudget - apUsed;
  if (gapRemaining > 0) {
    if (gapFillFn) {
      gapFillFn(budgetCapped, sim, board, gapRemaining, prevPositions);
    } else if (board.witch) {
      const witchEntity = sim.entities.find(e => e.id === board.witch.id);
      if (witchEntity) {
        _fillGaps(budgetCapped, sim, board, witchEntity, gapRemaining, prevPositions);
      }
    }
  }

  // 6. Truncate to max plan length (keep _goal/_priority for debug visualization)
  const plan = budgetCapped.slice(0, MAX_PLAN_LENGTH);

  return plan;
}

function _fillGaps(plan, sim, board, witchEntity, remaining, prevPositions) {
  let left = remaining;

  // Explore current hex if unexplored
  if (left > 0 && !sim.isExplored(witchEntity.col, witchEntity.row)) {
    plan.push({ type: PlanActionType.EXPLORE, entityId: witchEntity.id });
    sim.applyExplore(witchEntity.id);
    left--;
  }

  // Move uncommitted minions toward nearest uncovered node
  if (left > 0) {
    const uncoveredNodes = board.nodes
      .filter(n => !n.witchPresent)
      .filter(n => scoreNodeFeasibility(n, 'witch', sim.entities) >= 0.15);
    for (const minion of board.minions) {
      if (left <= 0) break;
      if (sim.unitCommitments.has(minion.id)) continue;
      const simMinion = sim.entities.find(e => e.id === minion.id);
      if (!simMinion) continue;

      let bestNode = null, bestDist = Infinity;
      for (const n of uncoveredNodes) {
        const d = hexDistance(simMinion.col, simMinion.row, n.obj.col, n.obj.row);
        if (d < bestDist) { bestDist = d; bestNode = n; }
      }
      if (!bestNode) continue;

      const step = roadStepToward(sim, simMinion, bestNode.obj);
      if (!step) continue;

      const prev = prevPositions.get(minion.id);
      if (prev && prev.col === step.col && prev.row === step.row) continue;

      plan.push({
        type: PlanActionType.MOVE, entityId: simMinion.id,
        toCol: step.col, toRow: step.row,
      });
      sim.applyMove(simMinion.id, step.col, step.row);
      sim.unitCommitments.set(simMinion.id, 'gap-fill');
      left--;
    }
  }

  // Move witch toward nearest uncovered node if uncommitted
  if (left > 0 && !sim.unitCommitments.has(witchEntity.id)) {
    const targetNodes = board.nodes
      .filter(n => !n.witchPresent)
      .sort((a, b) => {
        const da = hexDistance(witchEntity.col, witchEntity.row, a.obj.col, a.obj.row);
        const db = hexDistance(witchEntity.col, witchEntity.row, b.obj.col, b.obj.row);
        return da - db;
      });
    if (targetNodes.length > 0) {
      while (left > 0) {
        const step = roadStepToward(sim, witchEntity, targetNodes[0].obj);
        if (!step) break;
        const prev = prevPositions.get(witchEntity.id);
        if (prev && prev.col === step.col && prev.row === step.row) break;
        plan.push({
          type: PlanActionType.MOVE, entityId: witchEntity.id,
          toCol: step.col, toRow: step.row,
        });
        sim.applyMove(witchEntity.id, step.col, step.row);
        left--;
      }
    }
  }

  // Last resort: explore unexplored hexes
  while (left > 0) {
    if (!sim.isExplored(witchEntity.col, witchEntity.row)) {
      plan.push({ type: PlanActionType.EXPLORE, entityId: witchEntity.id });
      sim.applyExplore(witchEntity.id);
      left--;
      continue;
    }
    let bestHex = null, bestDist = Infinity;
    for (const [, t] of sim.tiles) {
      if (sim.isExplored(t.col, t.row)) continue;
      if (t.terrain === 'river') continue;
      const d = hexDistance(witchEntity.col, witchEntity.row, t.col, t.row);
      if (d < bestDist) { bestDist = d; bestHex = t; }
    }
    if (!bestHex) break;
    const step = roadStepToward(sim, witchEntity, bestHex);
    if (!step) break;
    const prev = prevPositions.get(witchEntity.id);
    if (prev && prev.col === step.col && prev.row === step.row) break;
    plan.push({
      type: PlanActionType.MOVE, entityId: witchEntity.id,
      toCol: step.col, toRow: step.row,
    });
    sim.applyMove(witchEntity.id, step.col, step.row);
    left--;
  }
}

// ── NvN Ally Coordination ───────────────────────────────────────────────────

function _updateAllyClaimedNodes(plan, board, allyContext) {
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

function _personalityName(config) {
  for (const [name, cfg] of Object.entries(PERSONALITY_CONFIGS)) {
    if (cfg === config) return name;
  }
  return 'custom';
}

// ── WitchAIEngine ────────────────────────────────────────────────────────────

export class WitchAIEngine {
  constructor(state, onStateChange, thinkDelay = 600, playerId = null, config = null) {
    this.state = state;
    this.onStateChange = onStateChange;
    this.onBattleResult = null;
    this.thinkDelay = thinkDelay;
    this.playerId = playerId;
    this.config = config ?? PERSONALITY_CONFIGS.balanced;

    this._prevPositions = new Map();

    /** When true, generatePlan() stores intermediate data on lastDebugData. */
    this.debugCapture = false;
    /** @type {object|null} Debug snapshot from last generatePlan() call. */
    this.lastDebugData = null;
  }

  generatePlan(allyContext = null) {
    const sim = new EnginePlanSimState(this.state, 'witch', this.playerId);
    const board = assessBoard(sim);

    board.allyContext = allyContext;

    if (!board.witch) {
      this.lastDebugData = null;
      return this._generateLeaderlessPlan(sim, board);
    }

    const cfg = this.config;
    const scores = scoreGoals(board, cfg.goalWeights);
    const budget = allocateBudget(scores, board.totalBudget);

    // Stage 4: Run generators ordered by budget (highest budget first)
    const generators = [
      { goal: Goal.BUILD_ARMY,    fn: () => genBuildArmy(sim, board, budget[Goal.BUILD_ARMY]) },
      { goal: Goal.CONTROL_NODES, fn: () => genControlNodes(sim, board, budget[Goal.CONTROL_NODES]) },
      { goal: Goal.DEFEND_WITCH,  fn: () => genDefendWitch(sim, board, budget[Goal.DEFEND_WITCH], cfg) },
    ];
    // Sort by allocated budget descending — highest budget goal generates first
    generators.sort((a, b) => budget[b.goal] - budget[a.goal]);

    const allActions = [];
    for (const gen of generators) {
      allActions.push(...gen.fn());
    }

    const plan = assemblePlan(allActions, sim, board, this._prevPositions);

    // Capture debug data AFTER assemblePlan so overlay matches actual execution
    if (this.debugCapture) {
      this.lastDebugData = {
        faction: 'witch',
        personality: _personalityName(this.config),
        board,
        scores: { ...scores },
        budget: { ...budget },
        actions: plan.map(a => ({ ...a })),
        config: this.config,
        unitCommitments: new Map(sim.unitCommitments),
      };
    }

    if (allyContext) {
      _updateAllyClaimedNodes(plan, board, allyContext);
    }

    for (const e of sim.entities) {
      if (e.alive && e.owner === 'witch') {
        this._prevPositions.set(e.id, { col: e.col, row: e.row });
      }
    }

    return plan;
  }

  /** Leaderless plan: no witch on the map (campaign missions). */
  _generateLeaderlessPlan(sim, board) {
    const plan = [];
    const minions = sim.entities.filter(e => e.alive && e.owner === 'witch' && !e.id.startsWith('sim-'));
    if (minions.length === 0) return plan;

    const heroes = board.visibleHeroes;
    const target = heroes[0] ?? sim.entities.find(e => e.alive && e.owner === 'hero');
    let remaining = board.totalBudget;

    for (const m of minions) {
      if (remaining <= 0) break;
      const colocated = heroes.find(h => h.col === m.col && h.row === m.row);
      if (colocated) {
        plan.push({ type: PlanActionType.BATTLE_UNIT, entityId: m.id,
          targetId: colocated.id, targetCol: colocated.col, targetRow: colocated.row });
        sim.applyBattle();
        remaining--;
        continue;
      }
      const adj = heroes.find(h => hexDistance(m.col, m.row, h.col, h.row) === 1);
      if (adj) {
        plan.push({ type: PlanActionType.BATTLE_UNIT, entityId: m.id,
          targetId: adj.id, targetCol: adj.col, targetRow: adj.row });
        sim.applyBattle();
        remaining--;
      }
    }

    if (target) {
      for (const m of minions) {
        if (remaining <= 0 || plan.length >= MAX_PLAN_LENGTH) break;
        if (plan.some(a => a.entityId === m.id)) continue;
        const step = roadStepToward(sim, m, target);
        if (step) {
          plan.push({ type: PlanActionType.MOVE, entityId: m.id,
            toCol: step.col, toRow: step.row });
          sim.applyMove(m.id, step.col, step.row);
          remaining--;
        }
      }
    }

    return plan;
  }
}

// ── Factory helpers ─────────────────────────────────────────────────────────

export function createWitchAI(personality, state, onStateChange, thinkDelay = 600, playerId = null) {
  const cfg = PERSONALITY_CONFIGS[personality] ?? PERSONALITY_CONFIGS.balanced;
  return new WitchAIEngine(state, onStateChange, thinkDelay, playerId, cfg);
}

// ── Register all witch personalities ────────────────────────────────────────

for (const name of Object.keys(PERSONALITY_CONFIGS)) {
  WITCH_PERSONALITIES[name] = class extends WitchAIEngine {
    constructor(state, onStateChange, thinkDelay = 600, playerId = null) {
      super(state, onStateChange, thinkDelay, playerId, PERSONALITY_CONFIGS[name]);
    }
  };
  Object.defineProperty(WITCH_PERSONALITIES[name], 'name', { value: `WitchAI_${name}` });
}
