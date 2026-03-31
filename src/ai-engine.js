// AI Engine — 5-stage pipeline witch personality
// Drop-in replacement for WitchAI with goal-based budget allocation.
//
// Pipeline: EVALUATE → SCORE → ALLOCATE → GENERATE → ASSEMBLE
// Phase 1 implements stages 1-3. Generators and assembly come in Phase 2-3.

import { PlanSimState } from './ai.js';
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

export function scoreGoals(board) {
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

  return {
    [Goal.DEFEND_WITCH]:     defend,
    [Goal.KILL_HERO]:        kill,
    [Goal.CONTROL_NODES]:    control,
    [Goal.BUILD_ARMY]:       army,
    [Goal.GATHER_RESOURCES]: gather,
  };
}

// ── Stage 3: Budget Allocation ───────────────────────────────────────────────

const URGENCY_THRESHOLD = 0.05;

export function allocateBudget(scores, totalBudget) {
  const result = {};
  for (const g of ALL_GOALS) result[g] = 0;

  if (totalBudget <= 0) return result;

  // Filter qualifying goals
  const qualifying = ALL_GOALS.filter(g => scores[g] > URGENCY_THRESHOLD);

  if (qualifying.length === 0) {
    // Edge case: nothing qualifies — give all to DEFEND_WITCH
    result[Goal.DEFEND_WITCH] = totalBudget;
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

// ── WitchAIEngine ────────────────────────────────────────────────────────────

export class WitchAIEngine {
  constructor(state, onStateChange, thinkDelay = 600, playerId = null) {
    this.state = state;
    this.onStateChange = onStateChange;
    this.thinkDelay = thinkDelay;
    this.playerId = playerId;

    // Cross-turn anti-oscillation memory: Map<entityId, {col, row}>
    this._prevPositions = new Map();
  }

  generatePlan(allyContext = null) {
    const sim = new EnginePlanSimState(this.state, 'witch', this.playerId);
    const board = assessBoard(sim);
    const scores = scoreGoals(board);
    const budget = allocateBudget(scores, board.totalBudget);

    // TODO Phase 2: run generators
    // TODO Phase 3: assemble plan

    // Update cross-turn memory
    for (const e of sim.entities) {
      if (e.alive && e.owner === 'witch') {
        this._prevPositions.set(e.id, { col: e.col, row: e.row });
      }
    }

    return [];
  }
}
