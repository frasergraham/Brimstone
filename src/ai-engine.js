// AI Engine — 5-stage pipeline witch AI
// All witch personalities are config-driven variants of this single engine.
//
// Pipeline: EVALUATE → SCORE → ALLOCATE → GENERATE → ASSEMBLE

import { PlanSimState, stepToward, stepAwayFrom, roadStepToward, bestWitchObjective, nearestBuilding, WITCH_PERSONALITIES } from './ai.js';
import { hexDistance, hexKey, getNeighbors } from './hex.js';
import { Phase, nodeController } from './game.js';
import { EntityType } from './entities.js';
import { TileType, ResourceType } from './tiles.js';
import { PlanActionType, MAX_PLAN_LENGTH } from './planner.js';

// ── Goal names ───────────────────────────────────────────────────────────────

export const Goal = Object.freeze({
  KILL_HERO:        'KILL_HERO',
  CONTROL_NODES:    'CONTROL_NODES',
  BUILD_ARMY:       'BUILD_ARMY',
  GATHER_RESOURCES: 'GATHER_RESOURCES',
  DEFEND_WITCH:     'DEFEND_WITCH',
});

const ALL_GOALS = Object.values(Goal);

// ── Personality configs ─────────────────────────────────────────────────────
// goalWeights: post-scoring multipliers per goal (higher = more budget share)
// fleeThreshold: witch HP ratio below which flee actions trigger
// engageFloor: minimum combat classification to attack
//   'suicidal' → only skip suicidal; 'unfavorable' → need favorable+; 'favorable' → need overwhelming

export const PERSONALITY_CONFIGS = Object.freeze({
  balanced: Object.freeze({
    goalWeights: Object.freeze({
      [Goal.KILL_HERO]: 1.0, [Goal.CONTROL_NODES]: 1.0,
      [Goal.BUILD_ARMY]: 1.0, [Goal.GATHER_RESOURCES]: 1.0, [Goal.DEFEND_WITCH]: 1.0,
    }),
    fleeThreshold: 0.3,
    engageFloor: 'suicidal',
  }),
  aggressive: Object.freeze({
    goalWeights: Object.freeze({
      [Goal.KILL_HERO]: 1.8, [Goal.CONTROL_NODES]: 0.6,
      [Goal.BUILD_ARMY]: 0.7, [Goal.GATHER_RESOURCES]: 0.4, [Goal.DEFEND_WITCH]: 0.7,
    }),
    fleeThreshold: 0.15,
    engageFloor: 'suicidal',
  }),
  swarm: Object.freeze({
    goalWeights: Object.freeze({
      [Goal.KILL_HERO]: 0.4, [Goal.CONTROL_NODES]: 1.5,
      [Goal.BUILD_ARMY]: 2.0, [Goal.GATHER_RESOURCES]: 1.3, [Goal.DEFEND_WITCH]: 1.3,
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
      // Record the hex being departed
      if (!this.departedHexes.has(entityId)) {
        this.departedHexes.set(entityId, new Set());
      }
      this.departedHexes.get(entityId).add(hexKey(e.col, e.row));
    }
    // Delegate to parent (handles _justLeft, position update, budget decrement)
    super.applyMove(entityId, toCol, toRow);
  }
}

// ── Stage 1: Board Evaluation ────────────────────────────────────────────────

export function assessBoard(sim) {
  const witch = sim.witch;
  const phase = sim.phase;

  // Phase info
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

  // Visible heroes (AI has full knowledge during planning)
  const visibleHeroes = sim.entities.filter(e => e.alive && e.owner === 'hero');

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
      ? obj.hexes.some(h => sim.entities.some(e => e.alive && e.owner === 'hero' && e.col === h.col && e.row === h.row))
      : sim.entities.some(e => e.alive && e.owner === 'hero' && e.col === obj.col && e.row === obj.row);

    // Distance from nearest witch unit to this node
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

  return {
    phase, isNight, isDay, isDawnOrDusk,
    witch,
    witchHp: witch?.hp ?? 0,
    witchMaxHp: witch?.maxHp ?? witch?.hp ?? 1,
    witchHpRatio: witch ? witch.hp / (witch.maxHp || witch.hp || 1) : 1,
    minions, minionCount, armyStrength,
    visibleHeroes, heroDistance, heroHpRatio,
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
  // DEFEND_WITCH
  let defend = 0;
  if (board.witchHpRatio < 0.3) defend = 1.0;
  else if (board.witchHpRatio < 0.5) defend = 0.6;
  if (board.heroDistance <= 2) defend = Math.max(defend, 0.7);
  if (board.heroDistance <= 3 && board.witchHpRatio < 0.5) defend = 1.0;
  defend = clamp01(defend);

  // KILL_HERO
  let kill = 0;
  if (board.heroDistance <= 1) kill = 0.8;
  else if (board.heroDistance <= 3) kill = 0.5;
  else if (board.heroDistance <= 5) kill = 0.3;
  else kill = 0.1;
  if (board.heroHpRatio < 0.4) kill += 0.2;
  const killMult = board.isNight ? 1.5 : board.isDay ? 0.6 : 1.0;
  kill = clamp01(clamp01(kill) * killMult);

  // CONTROL_NODES
  let control = 0.3;
  const uncovered = board.nodes.filter(n => n.controller !== 'witch' && !n.witchPresent).length;
  control += uncovered * 0.15;
  if (board.heroScore >= 3) control += 0.3;
  if (board.nodes.length > 0 && board.witchHeldCount === board.nodes.length - 1) control += 0.2;
  // Urgency: contest hero-held nodes — the more they hold, the higher the pressure
  if (board.heroHeldCount > 0) control += 0.2;
  if (board.heroHeldCount > board.witchHeldCount) control += 0.25;
  const controlMult = board.isDawnOrDusk ? 1.8 : 1.0;
  control = clamp01(clamp01(control) * controlMult);

  // BUILD_ARMY
  let army = 0;
  if (board.minionCount === 0) army = 0.7;
  else if (board.minionCount <= 2) army = 0.5;
  else if (board.minionCount <= 4) army = 0.3;
  else army = 0.1;
  if (!board.canAffordSummon) army = 0;
  army = clamp01(army);

  // GATHER_RESOURCES
  let gather = 0.2;
  if (board.totalResources < 2) gather = 0.6;
  else if (board.totalResources < 4) gather = 0.4;
  if (board.unexploredBuildings.length > 0) gather += 0.1;
  const gatherMult = board.isDay ? 1.5 : board.isNight ? 0.5 : 1.0;
  gather = clamp01(clamp01(gather) * gatherMult);

  const scores = {
    [Goal.DEFEND_WITCH]:     defend,
    [Goal.KILL_HERO]:        kill,
    [Goal.CONTROL_NODES]:    control,
    [Goal.BUILD_ARMY]:       army,
    [Goal.GATHER_RESOURCES]: gather,
  };

  // Apply personality goal weights
  if (goalWeights) {
    for (const g of ALL_GOALS) {
      if (goalWeights[g] != null) scores[g] = clamp01(scores[g] * goalWeights[g]);
    }
  }

  // Early-game focus: when the hero is far away and unexplored buildings remain,
  // prioritize resource gathering and army building over passive defense.
  // Mirrors the hero's early-game explore focus — no reason to turtle when
  // there are no threats and resources to claim.
  if (board.heroDistance > 4 && board.unexploredBuildings.length > 0) {
    scores[Goal.GATHER_RESOURCES] = clamp01(scores[Goal.GATHER_RESOURCES] + 0.4);
    scores[Goal.DEFEND_WITCH] = Math.min(scores[Goal.DEFEND_WITCH], 0.1);
    if (board.canAffordSummon) {
      scores[Goal.BUILD_ARMY] = clamp01(scores[Goal.BUILD_ARMY] + 0.2);
    }
  }

  return scores;
}

// ── Stage 3: Budget Allocation ───────────────────────────────────────────────

const URGENCY_THRESHOLD = 0.05;

export function allocateBudget(scores, totalBudget) {
  const allGoals = Object.keys(scores);
  const result = {};
  for (const g of allGoals) result[g] = 0;

  if (totalBudget <= 0) return result;

  // Filter qualifying goals
  const qualifying = allGoals.filter(g => scores[g] > URGENCY_THRESHOLD);

  if (qualifying.length === 0) {
    // Edge case: nothing qualifies — give all to first goal (faction default)
    result[allGoals[0]] = totalBudget;
    return result;
  }

  // Normalize
  const totalUrgency = qualifying.reduce((s, g) => s + scores[g], 0);

  // Floor allocation
  for (const g of qualifying) {
    result[g] = Math.floor((scores[g] / totalUrgency) * totalBudget);
  }

  // Distribute remainder to highest-urgency goals
  let remainder = totalBudget - qualifying.reduce((s, g) => s + result[g], 0);
  const sorted = [...qualifying].sort((a, b) => scores[b] - scores[a]);
  let i = 0;
  while (remainder > 0) {
    result[sorted[i % sorted.length]]++;
    remainder--;
    i++;
  }

  // Guarantee: every qualifying goal gets at least 1 AP
  for (const g of qualifying) {
    if (result[g] === 0) {
      // Steal from lowest-urgency goal that has > 1
      const donor = [...qualifying]
        .sort((a, b) => scores[a] - scores[b])
        .find(d => result[d] > 1);
      if (donor) {
        result[donor]--;
        result[g] = 1;
      }
    }
  }

  return result;
}

// ── Stage 4: Tactic Generators ──────────────────────────────────────────────

// ── Combat estimation helper ────────────────────────────────────────────────
// Lightweight expected-value model. Returns { favorability, classification }.
// favorability > 0 means attacker-favored. classification is a string label.

export function estimateCombat(attacker, defender, board) {
  const nightBonus = board.isNight && attacker.owner === 'witch' ? 2 : 0;

  // Count attacker allies adjacent to the target
  const gangUpCount = board.minions.filter(m =>
    m.id !== attacker.id && hexDistance(m.col, m.row, defender.col, defender.row) <= 1
  ).length;
  const gangUpDice = Math.min(gangUpCount, 3);

  // Count defender allies adjacent to the target
  const defAllyCount = (board.visibleHeroes || []).filter(h =>
    h.id !== defender.id && hexDistance(h.col, h.row, defender.col, defender.row) <= 1
  ).length;
  const defAllyDice = Math.min(defAllyCount, 3);

  // Expected d6 is 3.5, expected d3 is 2
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

function _closestUncommitted(sim, board, target) {
  let best = null, bestDist = Infinity;
  const candidates = [board.witch, ...board.minions].filter(e => e && e.alive);
  for (const e of candidates) {
    if (sim.unitCommitments.has(e.id)) continue;
    const d = hexDistance(e.col, e.row, target.col, target.row);
    if (d < bestDist) { bestDist = d; best = e; }
  }
  return best;
}

// ── Generator: DEFEND_WITCH ─────────────────────────────────────────────────

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
    // Free action, don't decrement remaining
  }

  // Flee away from nearest hero if HP critical
  const fleeThreshold = config?.fleeThreshold ?? 0.3;
  if (board.witchHpRatio < fleeThreshold && board.visibleHeroes.length > 0 && remaining > 0) {
    const nearestHero = board.visibleHeroes.reduce((best, h) => {
      const d = hexDistance(board.witch.col, board.witch.row, h.col, h.row);
      const bd = best ? hexDistance(board.witch.col, board.witch.row, best.col, best.row) : Infinity;
      return d < bd ? h : best;
    }, null);

    if (nearestHero) {
      const fleeStep = stepAwayFrom(sim, witchEntity, nearestHero);
      if (fleeStep) {
        actions.push({
          type: PlanActionType.MOVE, entityId: board.witch.id,
          toCol: fleeStep.col, toRow: fleeStep.row,
          _priority: 1, _goal: Goal.DEFEND_WITCH,
        });
        sim.applyMove(board.witch.id, fleeStep.col, fleeStep.row);
        sim.unitCommitments.set(board.witch.id, Goal.DEFEND_WITCH);
        remaining--;
      }
    }
  }

  // Interpose nearest minion between witch and hero threat
  if (board.heroDistance <= 3 && board.minions.length > 0 && remaining > 0) {
    const nearestHero = board.visibleHeroes[0];
    if (nearestHero) {
      // Find closest uncommitted minion (exclude witch)
      let guard = null, guardDist = Infinity;
      for (const m of board.minions) {
        if (sim.unitCommitments.has(m.id)) continue;
        const d = hexDistance(m.col, m.row, board.witch.col, board.witch.row);
        if (d < guardDist) { guardDist = d; guard = m; }
      }
      if (guard) {
        // Move guard toward witch (to shield)
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

// ── Generator: BUILD_ARMY ───────────────────────────────────────────────────

export function genBuildArmy(sim, board, budget) {
  const actions = [];
  if (budget <= 0 || !board.witch || !board.canAffordSummon) return actions;
  let remaining = budget;

  // Army cap: 8 at night/dusk, 5 at day/dawn
  const armyCap = (board.isNight || board.phase === Phase.DUSK) ? 8 : 5;
  let currentArmy = board.minionCount;

  while (remaining > 0 && currentArmy < armyCap) {
    // Check resource ledger for affordability
    const ledger = sim.resourceLedger;
    const metal = ledger[ResourceType.METAL] || 0;
    const wood = ledger[ResourceType.WOOD] || 0;
    const total = Object.values(ledger).reduce((s, v) => s + (v || 0), 0);

    if (total < 2) break;

    // Pick best summon type
    let summonType;
    if (metal >= 2) summonType = EntityType.IRON_GOLEM;
    else if (wood >= 2) summonType = EntityType.WOOD_GOLEM;
    else summonType = EntityType.MINION;

    // Deduct from resource ledger
    if (summonType === EntityType.IRON_GOLEM) {
      ledger[ResourceType.METAL] -= 2;
    } else if (summonType === EntityType.WOOD_GOLEM) {
      ledger[ResourceType.WOOD] -= 2;
    } else {
      // Minion: spend 2 from any, largest stacks first
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

    // Update sim state to reflect summon
    sim.applySummon(board.witch);
    currentArmy++;
    remaining--;
  }

  return actions;
}

// ── Generator: CONTROL_NODES ────────────────────────────────────────────────

export function genControlNodes(sim, board, budget) {
  const actions = [];
  if (budget <= 0 || !board.witch) return actions;
  let remaining = budget;

  // Include uncovered/enemy-held nodes AND witch-held nodes with nearby threats
  const heroThreatenedNode = (n) => board.visibleHeroes.some(h =>
    hexDistance(h.col, h.row, n.obj.col, n.obj.row) <= 2
  );
  const targetNodes = board.nodes
    .filter(n => n.controller !== 'witch' || !n.witchPresent || n.heroPresent || heroThreatenedNode(n))
    .sort((a, b) => {
      // Priority: hero-held > neutral > witch-held-but-threatened, then by distance
      const aPrio = a.controller === 'hero' ? 0 : (a.controller === 'witch' && a.witchPresent ? 2 : 1);
      const bPrio = b.controller === 'hero' ? 0 : (b.controller === 'witch' && b.witchPresent ? 2 : 1);
      if (aPrio !== bPrio) return aPrio - bPrio;
      return a.distToNearest - b.distToNearest;
    });

  for (const node of targetNodes) {
    if (remaining <= 0) break;

    // Find closest uncommitted unit
    const unit = _closestUncommitted(sim, board, node.obj);
    if (!unit) continue;

    const simUnit = sim.entities.find(e => e.id === unit.id);
    if (!simUnit) continue;

    // If unit is already on the node with nearby threats, guard instead
    const onNode = node.obj.hexes
      ? node.obj.hexes.some(h => h.col === simUnit.col && h.row === simUnit.row)
      : (simUnit.col === node.obj.col && simUnit.row === node.obj.row);

    if (onNode) {
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
        continue;
      }
      // Already on node, no threats — skip, unit can be used elsewhere
      continue;
    }

    // Generate MOVE sequence toward node
    sim.unitCommitments.set(simUnit.id, Goal.CONTROL_NODES);
    let stepsForUnit = Math.min(remaining, 3); // max 3 moves per unit toward a node
    while (stepsForUnit > 0) {
      // Target the nearest hex of the node cluster
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

// ── Generator: KILL_HERO ────────────────────────────────────────────────────

export function genKillHero(sim, board, budget, config = null) {
  const actions = [];
  if (budget <= 0 || !board.witch || board.visibleHeroes.length === 0) return actions;
  let remaining = budget;

  const targetHero = board.visibleHeroes.reduce((best, h) => {
    const d = hexDistance(board.witch.col, board.witch.row, h.col, h.row);
    const bd = best ? hexDistance(board.witch.col, board.witch.row, best.col, best.row) : Infinity;
    return d < bd ? h : best;
  }, null);
  if (!targetHero) return actions;

  // Battle any witch unit adjacent to a hero
  const witchUnits = [board.witch, ...board.minions];
  for (const unit of witchUnits) {
    if (remaining <= 0) break;
    if (sim.unitCommitments.has(unit.id)) continue;

    const simUnit = sim.entities.find(e => e.id === unit.id);
    if (!simUnit) continue;

    // Check if adjacent to any hero
    for (const hero of board.visibleHeroes) {
      const dist = hexDistance(simUnit.col, simUnit.row, hero.col, hero.row);
      if (dist <= 1) {
        // Combat estimation — skip attacks below engage floor
        const est = estimateCombat(simUnit, hero, board);
        const floor = config?.engageFloor ?? 'suicidal';
        if (floor === 'unfavorable' && (est.classification === 'suicidal' || est.classification === 'unfavorable')) continue;
        if (floor === 'favorable' && est.classification !== 'overwhelming' && est.classification !== 'favorable') continue;
        if (floor === 'suicidal' && est.classification === 'suicidal') continue;

        actions.push({
          type: PlanActionType.BATTLE_UNIT, entityId: simUnit.id,
          targetId: hero.id, targetCol: hero.col, targetRow: hero.row,
          _priority: 3, _goal: Goal.KILL_HERO,
        });
        sim.applyBattle();
        sim.unitCommitments.set(simUnit.id, Goal.KILL_HERO);
        remaining--;
        break;
      }
    }
  }

  // Move uncommitted units toward hero
  for (const unit of witchUnits) {
    if (remaining <= 0) break;
    if (sim.unitCommitments.has(unit.id)) continue;

    const simUnit = sim.entities.find(e => e.id === unit.id);
    if (!simUnit) continue;

    const step = roadStepToward(sim, simUnit, targetHero);
    if (!step) continue;

    actions.push({
      type: PlanActionType.MOVE, entityId: simUnit.id,
      toCol: step.col, toRow: step.row,
      _priority: 5, _goal: Goal.KILL_HERO,
    });
    sim.applyMove(simUnit.id, step.col, step.row);
    sim.unitCommitments.set(simUnit.id, Goal.KILL_HERO);
    remaining--;
  }

  return actions;
}

// ── Generator: GATHER_RESOURCES ─────────────────────────────────────────────

export function genGatherResources(sim, board, budget) {
  const actions = [];
  if (budget <= 0 || !board.witch) return actions;
  let remaining = budget;

  const witchEntity = sim.entities.find(e => e.id === board.witch.id);
  if (!witchEntity) return actions;

  // If witch is on unexplored tile, explore first
  if (!sim.isExplored(witchEntity.col, witchEntity.row)) {
    if (!sim.unitCommitments.has(board.witch.id)) {
      actions.push({
        type: PlanActionType.EXPLORE, entityId: board.witch.id,
        _priority: 6, _goal: Goal.GATHER_RESOURCES,
      });
      sim.applyExplore(board.witch.id);
      sim.unitCommitments.set(board.witch.id, Goal.GATHER_RESOURCES);
      remaining--;
    }
  }

  // Move toward nearest unexplored building, then explore
  if (remaining > 0 && !sim.unitCommitments.has(board.witch.id)) {
    const building = nearestBuilding(sim, witchEntity);
    if (building && !sim.isExplored(building.col, building.row)) {
      // Move toward building
      let stepsLeft = Math.min(remaining, 3);
      while (stepsLeft > 0) {
        if (witchEntity.col === building.col && witchEntity.row === building.row) {
          // Arrived — explore
          actions.push({
            type: PlanActionType.EXPLORE, entityId: board.witch.id,
            _priority: 6, _goal: Goal.GATHER_RESOURCES,
          });
          sim.applyExplore(board.witch.id);
          remaining--;
          break;
        }
        const step = roadStepToward(sim, witchEntity, building);
        if (!step) break;

        actions.push({
          type: PlanActionType.MOVE, entityId: board.witch.id,
          toCol: step.col, toRow: step.row,
          _priority: 6, _goal: Goal.GATHER_RESOURCES,
        });
        sim.applyMove(board.witch.id, step.col, step.row);
        remaining--;
        stepsLeft--;
      }
      sim.unitCommitments.set(board.witch.id, Goal.GATHER_RESOURCES);
    }
  }

  return actions;
}

// ── Stage 5: Plan Assembly ──────────────────────────────────────────────────
// Merges generator outputs, validates, filters oscillation, fills gaps.

// Free actions that don't cost AP
const FREE_ACTIONS = new Set([PlanActionType.USE_ITEM, PlanActionType.EQUIP_WEAPON]);

export function assemblePlan(allActions, sim, board, prevPositions, gapFillFn = null) {
  // 1. Sort by priority (lower = higher priority)
  const sorted = [...allActions].sort((a, b) => (a._priority ?? 99) - (b._priority ?? 99));

  // 2. Anti-oscillation filter: remove moves that return a unit to its
  //    previous-turn position (cross-turn memory)
  const filtered = sorted.filter(action => {
    if (action.type !== PlanActionType.MOVE) return true;
    // Intra-plan: skip if unit already departed this hex this plan
    const departed = sim.departedHexes.get(action.entityId);
    if (departed && departed.has(hexKey(action.toCol, action.toRow))) return false;
    // Cross-turn: skip if returning to exact previous-turn position
    const prev = prevPositions.get(action.entityId);
    if (prev && prev.col === action.toCol && prev.row === action.toRow) return false;
    return true;
  });

  // 3. Deduplicate: remove duplicate actions on the same entity+hex
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

  // 4. Enforce budget: count AP-costing actions, drop excess from tail
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

  // 5. Gap-fill: if we have remaining AP, fill with useful fallback actions
  const remaining = totalBudget - apUsed;
  if (remaining > 0) {
    if (gapFillFn) {
      gapFillFn(budgetCapped, sim, board, remaining, prevPositions);
    } else if (board.witch) {
      const witchEntity = sim.entities.find(e => e.id === board.witch.id);
      if (witchEntity) {
        _fillGaps(budgetCapped, sim, board, witchEntity, remaining, prevPositions);
      }
    }
  }

  // 6. Strip internal metadata and truncate to MAX_PLAN_LENGTH
  const plan = budgetCapped.slice(0, MAX_PLAN_LENGTH).map(a => {
    const clean = { ...a };
    delete clean._priority;
    delete clean._goal;
    return clean;
  });

  return plan;
}

function _fillGaps(plan, sim, board, witchEntity, remaining, prevPositions) {
  let left = remaining;

  // Try to explore current hex if unexplored
  if (left > 0 && !sim.isExplored(witchEntity.col, witchEntity.row)) {
    plan.push({ type: PlanActionType.EXPLORE, entityId: witchEntity.id });
    sim.applyExplore(witchEntity.id);
    left--;
  }

  // Move uncommitted minions toward nearest uncovered node
  if (left > 0) {
    const uncoveredNodes = board.nodes.filter(n => n.controller !== 'witch');
    for (const minion of board.minions) {
      if (left <= 0) break;
      if (sim.unitCommitments.has(minion.id)) continue;
      const simMinion = sim.entities.find(e => e.id === minion.id);
      if (!simMinion) continue;

      // Pick closest uncovered node
      let bestNode = null, bestDist = Infinity;
      for (const n of uncoveredNodes) {
        const d = hexDistance(simMinion.col, simMinion.row, n.obj.col, n.obj.row);
        if (d < bestDist) { bestDist = d; bestNode = n; }
      }
      if (!bestNode) continue;

      const step = roadStepToward(sim, simMinion, bestNode.obj);
      if (!step) continue;

      // Anti-oscillation check for gap-fill moves too
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

  // Guard with the witch if nothing else to do
  if (left > 0) {
    plan.push({ type: PlanActionType.GUARD, entityId: witchEntity.id });
    left--;
  }
}

// ── WitchAIEngine ────────────────────────────────────────────────────────────

export class WitchAIEngine {
  constructor(state, onStateChange, thinkDelay = 600, playerId = null, config = null) {
    this.state = state;
    this.onStateChange = onStateChange;
    this.onBattleResult = null; // unused in planning mode, but expected by consumers
    this.thinkDelay = thinkDelay;
    this.playerId = playerId;
    this.config = config ?? PERSONALITY_CONFIGS.balanced;

    // Cross-turn anti-oscillation memory: Map<entityId, {col, row}>
    this._prevPositions = new Map();
  }

  generatePlan(allyContext = null) {
    const sim = new EnginePlanSimState(this.state, 'witch', this.playerId);
    const board = assessBoard(sim);

    // Leaderless mode: no witch entity (campaign missions with hasWitch: false).
    // Minions/zombies simply attack and chase hero units.
    if (!board.witch) {
      return this._generateLeaderlessPlan(sim, board);
    }

    const cfg = this.config;
    const scores = scoreGoals(board, cfg.goalWeights);
    const budget = allocateBudget(scores, board.totalBudget);

    // Stage 4: Run generators in priority order
    // Each generator mutates sim state (positions, commitments, ledger)
    // so later generators see the projected world.
    const defendActions  = genDefendWitch(sim, board, budget[Goal.DEFEND_WITCH], cfg);
    const buildActions   = genBuildArmy(sim, board, budget[Goal.BUILD_ARMY]);
    const controlActions = genControlNodes(sim, board, budget[Goal.CONTROL_NODES]);
    const killActions    = genKillHero(sim, board, budget[Goal.KILL_HERO], cfg);
    const gatherActions  = genGatherResources(sim, board, budget[Goal.GATHER_RESOURCES]);

    // Collect all generated actions
    const allActions = [
      ...defendActions,
      ...buildActions,
      ...controlActions,
      ...killActions,
      ...gatherActions,
    ];

    // Stage 5: Assemble final plan
    const plan = assemblePlan(allActions, sim, board, this._prevPositions);

    // Update cross-turn memory
    for (const e of sim.entities) {
      if (e.alive && e.owner === 'witch') {
        this._prevPositions.set(e.id, { col: e.col, row: e.row });
      }
    }

    return plan;
  }

  /** Leaderless plan: no witch on the map (campaign missions). Minions attack and chase hero. */
  _generateLeaderlessPlan(sim, board) {
    const plan = [];
    const minions = sim.entities.filter(e => e.alive && e.owner === 'witch' && !e.id.startsWith('sim-'));
    if (minions.length === 0) return plan;

    const heroes = board.visibleHeroes;
    const target = heroes[0] ?? sim.entities.find(e => e.alive && e.owner === 'hero');
    let remaining = board.totalBudget;

    // 1. Attack heroes on the same hex or adjacent
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

    // 2. Move remaining minions toward closest hero
    if (target) {
      for (const m of minions) {
        if (remaining <= 0 || plan.length >= MAX_PLAN_LENGTH) break;
        // Skip units that already acted
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

/** Create a WitchAIEngine with a named personality config. */
export function createWitchAI(personality, state, onStateChange, thinkDelay = 600, playerId = null) {
  const cfg = PERSONALITY_CONFIGS[personality] ?? PERSONALITY_CONFIGS.balanced;
  return new WitchAIEngine(state, onStateChange, thinkDelay, playerId, cfg);
}

// ── Register all witch personalities ────────────────────────────────────────
// Each entry is a constructor-like function matching the (state, onChange, delay, playerId) interface.

for (const name of Object.keys(PERSONALITY_CONFIGS)) {
  WITCH_PERSONALITIES[name] = class extends WitchAIEngine {
    constructor(state, onStateChange, thinkDelay = 600, playerId = null) {
      super(state, onStateChange, thinkDelay, playerId, PERSONALITY_CONFIGS[name]);
    }
  };
  Object.defineProperty(WITCH_PERSONALITIES[name], 'name', { value: `WitchAI_${name}` });
}

