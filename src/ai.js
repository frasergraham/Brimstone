// AI controllers — WitchAI and HeroAI
// Both use a weight-based priority system that shifts based on the day/night phase.
import { getNeighbors, hexDistance, hexKey } from './hex.js';
import { TileType, ResourceType } from './tiles.js';
import { EntityType } from './entities.js';
import { Phase, computeActions, Player } from './game.js';
import {
  executeMove, executeExplore, executeBattle, executeSummon, executeUseItem,
  getVisibleEnemyHexes, getVisibleHeroHexes,
} from './actions.js';
import { PlanActionType, MAX_PLAN_LENGTH } from './planner.js';

const THINK_DELAY_MS = 600;

// Vague chronicle messages used when fog of war is active
const FOG_MESSAGES = [
  'Something moves in the darkness.',
  'A presence stirs beyond the torchlight.',
  'The shadows shift and writhe.',
  'An unseen force moves through the night.',
  'Something hunts in the fog.',
  'The darkness advances.',
  'A cold wind moves through the trees.',
  'The night whispers secrets you cannot hear.',
];

function fogLog(state) {
  if (state.fogOfWar) {
    state.addLog(FOG_MESSAGES[Math.floor(Math.random() * FOG_MESSAGES.length)]);
  }
}

function logResult(state, result) {
  if (state.fogOfWar) {
    if (result.success) fogLog(state);
  } else {
    for (const msg of result.log) state.addLog(msg);
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function _snapEntity(e) {
  return { id: e.id, name: e.displayName, hp: e.hp, maxHp: e.maxHp, attack: e.attack, defense: e.defense, type: e.type };
}


function stepToward(state, actor, target) {
  if (!target) return null;
  const visited = new Set([hexKey(actor.col, actor.row)]);
  const queue   = [{ col: actor.col, row: actor.row, first: null }];

  while (queue.length) {
    const { col, row, first } = queue.shift();
    if (col === target.col && row === target.row) return first;

    for (const n of getNeighbors(col, row)) {
      const k = hexKey(n.col, n.row);
      if (visited.has(k)) continue;
      const t = state.tiles.get(k);
      if (!t || t.type === TileType.RIVER) continue;
      visited.add(k);
      queue.push({ col: n.col, row: n.row, first: first || n });
    }
  }
  return null;
}

function nearestBuilding(state, actor) {
  let best = null, bestDist = Infinity;
  for (const [, t] of state.tiles) {
    if (t.type !== TileType.BUILDING) continue;
    const d = hexDistance(actor.col, actor.row, t.col, t.row);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  return best;
}

function stepAwayFrom(state, actor, threat) {
  const neighbors = getNeighbors(actor.col, actor.row).filter(n => {
    const t = state.tiles.get(hexKey(n.col, n.row));
    return t && t.type !== TileType.RIVER &&
      !state.entities.some(e => e.alive && e.owner === 'hero' && e.col === n.col && e.row === n.row);
  });
  if (!neighbors.length) return null;
  neighbors.sort((a, b) =>
    hexDistance(b.col, b.row, threat.col, threat.row) -
    hexDistance(a.col, a.row, threat.col, threat.row)
  );
  return neighbors[0];
}

function _isOnNode(state, entity) {
  return state.witchObjectives.some(obj => obj.col === entity.col && obj.row === entity.row);
}

// Returns the best node target for the witch: unclaimed first, then hero-held nodes to contest.
function _bestWitchObjective(state, actor) {
  const unclaimed = state.witchObjectives.filter(obj =>
    !state.entities.some(e => e.alive && e.col === obj.col && e.row === obj.row)
  );
  if (unclaimed.length) {
    unclaimed.sort((a, b) =>
      hexDistance(actor.col, actor.row, a.col, a.row) -
      hexDistance(actor.col, actor.row, b.col, b.row)
    );
    return unclaimed[0];
  }
  const heroHeld = state.witchObjectives.filter(obj =>
    state.entities.some(e => e.alive && e.owner === 'hero' && e.col === obj.col && e.row === obj.row) &&
    !state.entities.some(e => e.alive && e.owner === 'witch' && e.col === obj.col && e.row === obj.row)
  );
  if (heroHeld.length) {
    heroHeld.sort((a, b) =>
      hexDistance(actor.col, actor.row, a.col, a.row) -
      hexDistance(actor.col, actor.row, b.col, b.row)
    );
    return heroHeld[0];
  }
  return null;
}

function inBuilding(state, entity) {
  const t = state.tiles.get(hexKey(entity.col, entity.row));
  return t && t.type === TileType.BUILDING;
}

// ── WitchAI ───────────────────────────────────────────────────────────────────
// Strategy shifts with the day/night cycle:
//   DAWN/DAY : Seek buildings to shelter minions; amass army; stealth toward nodes
//   DUSK     : Begin mobilising; move toward nodes stealthily
//   NIGHT    : Strike hard — hunt hero units; seize nodes; summon more troops

export class WitchAI {
  constructor(state, onStateChange, thinkDelay = THINK_DELAY_MS) {
    this.state         = state;
    this.onStateChange = onStateChange;
    this.onBattleResult = null;
    this._running      = false;
    this.thinkDelay    = thinkDelay;
  }

  async takeTurn() {
    if (this._running) return;
    this._running = true;
    const state = this.state;
    try {
      while (state.actionsAvailable > 0 && !state.gameOver) {
        await this._think();
        let acted = false;
        try { acted = await this._chooseAction(); } catch (err) {
          console.error('WitchAI _chooseAction error:', err);
        }
        if (!acted) break;
        this.onStateChange();
        await delay(this.thinkDelay);
      }
      if (!state.gameOver) state.endTurn();
      this.onStateChange();
    } finally {
      this._running = false;
    }
  }

  async _executeBattleWithUI(actor, target) {
    const actorSnap  = _snapEntity(actor);
    const targetSnap = _snapEntity(target);
    const result = executeBattle(this.state, actor, target);
    logResult(this.state, result);
    this.state.spendAction(result.cost);
    if (this.onBattleResult) {
      await this.onBattleResult(actorSnap, targetSnap, result);
    }
    return true;
  }

  async _chooseAction() {
    const state = this.state;
    const phase = state.phase;
    const witch = state.witch;
    const isNight = phase === Phase.NIGHT || phase === Phase.DUSK;

    const minions = state.entities.filter(
      e => e.alive && e.owner === 'witch' && e.type !== EntityType.WITCH
    );

    const witchOnNode  = _isOnNode(state, witch);
    const heroScore    = state.nodeScore.hero;
    // Nodes not currently held by any witch unit (witch or minion)
    const uncoveredNodes = state.witchObjectives.filter(obj =>
      !state.entities.some(e => e.alive && e.owner === 'witch' && e.col === obj.col && e.row === obj.row)
    );

    // ── NIGHT STRATEGY ─────────────────────────────────────────────────────
    // Priority: flee → fight → urgent contest → HOLD node → summon →
    //           advance witch → advance minions → hunt hero
    if (isNight) {
      // 0. Flee if witch HP is critical and hero is close with no minion cover
      const hasAdjacentMinion = minions.some(m => hexDistance(witch.col, witch.row, m.col, m.row) <= 1);
      const distToHeroNight   = hexDistance(witch.col, witch.row, state.hero.col, state.hero.row);
      if (witch.hp <= Math.ceil(witch.maxHp * 0.3) && distToHeroNight <= 2 && !hasAdjacentMinion) {
        const fleeStep = stepAwayFrom(state, witch, state.hero);
        if (fleeStep) {
          const result = executeMove(state, witch, fleeStep.col, fleeStep.row);
          logResult(state, result);
          state.spendAction(result.cost);
          return true;
        }
      }

      // 1. Witch fights any co-located hero unit
      const witchColocated = state.entities.find(
        e => e.alive && e.owner === 'hero' && e.col === witch.col && e.row === witch.row
      );
      if (witchColocated) return this._executeBattleWithUI(witch, witchColocated);

      // 2. Fight adjacent hero units
      const adjHero = state.entities.find(
        e => e.alive && e.owner === 'hero' && hexDistance(witch.col, witch.row, e.col, e.row) === 1
      );
      if (adjHero) return this._executeBattleWithUI(witch, adjHero);

      // 3. Each minion attacks if it can
      for (const m of minions) {
        const colocated = state.entities.find(
          e => e.alive && e.owner === 'hero' && e.col === m.col && e.row === m.row
        );
        if (colocated) return this._executeBattleWithUI(m, colocated);

        const adjEnemy = state.entities.find(
          e => e.alive && e.owner === 'hero' && hexDistance(m.col, m.row, e.col, e.row) === 1
        );
        if (adjEnemy) return this._executeBattleWithUI(m, adjEnemy);
      }

      // 4. URGENT: hero has 2 score points — race every free unit to uncovered nodes
      if (heroScore >= 2) {
        const urgentNode = _bestWitchObjective(state, witch);
        if (urgentNode && !witchOnNode) {
          const step = stepToward(state, witch, urgentNode);
          if (step) {
            const result = executeMove(state, witch, step.col, step.row);
            logResult(state, result);
            state.spendAction(result.cost);
            return true;
          }
        }
        for (const m of minions) {
          if (_isOnNode(state, m)) continue;
          const mn = _bestWitchObjective(state, m);
          if (mn) {
            const step = stepToward(state, m, mn);
            if (step) {
              const result = executeMove(state, m, step.col, step.row);
              logResult(state, result);
              state.spendAction(result.cost);
              return true;
            }
          }
        }
      }

      // 5. HOLD: witch is on a node — fight adjacent threats; dispatch minions to other nodes
      if (witchOnNode) {
        const adjThreat = state.entities.find(
          e => e.alive && e.owner === 'hero' && hexDistance(witch.col, witch.row, e.col, e.row) === 1
        );
        if (adjThreat) return this._executeBattleWithUI(witch, adjThreat);

        for (const m of minions) {
          if (_isOnNode(state, m)) continue;
          if (uncoveredNodes.length) {
            uncoveredNodes.sort((a, b) =>
              hexDistance(m.col, m.row, a.col, a.row) - hexDistance(m.col, m.row, b.col, b.row)
            );
            const step = stepToward(state, m, uncoveredNodes[0]);
            if (step) {
              const result = executeMove(state, m, step.col, step.row);
              logResult(state, result);
              state.spendAction(result.cost);
              return true;
            }
          }
        }
        return false; // hold position
      }

      // 6. Summon more troops if resources available and army is small
      if (await this._trySummon(witch, minions.length)) return true;

      // 7. Witch moves toward best objective
      const witchNodeTarget = _bestWitchObjective(state, witch);
      if (witchNodeTarget) {
        const nodeStep = stepToward(state, witch, witchNodeTarget);
        if (nodeStep) {
          const result = executeMove(state, witch, nodeStep.col, nodeStep.row);
          logResult(state, result);
          state.spendAction(result.cost);
          return true;
        }
      }

      // 8. Move minions toward objectives; minions on a node hold position
      const nightVisibleHeroHexes = getVisibleHeroHexes(state);
      for (const m of minions) {
        if (_isOnNode(state, m)) continue;
        const obj = _bestWitchObjective(state, m);
        if (obj) {
          const step = stepToward(state, m, obj);
          if (step) {
            const result = executeMove(state, m, step.col, step.row);
            logResult(state, result);
            state.spendAction(result.cost);
            return true;
          }
        }
        // Only pursue visible hero units
        const heroUnits = state.entities.filter(
          e => e.alive && e.owner === 'hero' && nightVisibleHeroHexes.has(hexKey(e.col, e.row))
        );
        if (heroUnits.length) {
          heroUnits.sort((a, b) =>
            hexDistance(m.col, m.row, a.col, a.row) -
            hexDistance(m.col, m.row, b.col, b.row)
          );
          const step = stepToward(state, m, heroUnits[0]);
          if (step) {
            const result = executeMove(state, m, step.col, step.row);
            logResult(state, result);
            state.spendAction(result.cost);
            return true;
          }
        }
      }

      // 9. Hunt the hero — only if visible
      if (nightVisibleHeroHexes.has(hexKey(state.hero.col, state.hero.row))) {
        const step = stepToward(state, witch, state.hero);
        if (step) {
          const result = executeMove(state, witch, step.col, step.row);
          logResult(state, result);
          state.spendAction(result.cost);
          return true;
        }
      }

      return false;
    }

    // ── DAY STRATEGY ──────────────────────────────────────────────────────
    // Priority: flee → urgent contest → HOLD node → dispatch minions to nodes →
    //           summon → explore → advance witch → shelter stray minions

    // 0. Flee if hero is close and witch HP is low
    const distToHero = hexDistance(witch.col, witch.row, state.hero.col, state.hero.row);
    if (distToHero <= 2 && witch.hp <= Math.ceil(witch.maxHp * 0.6)) {
      const fleeStep = stepAwayFrom(state, witch, state.hero);
      if (fleeStep) {
        const result = executeMove(state, witch, fleeStep.col, fleeStep.row);
        logResult(state, result);
        state.spendAction(result.cost);
        return true;
      }
    }

    // 1. URGENT: hero has 2 score points — drop everything and contest remaining nodes
    if (heroScore >= 2) {
      const urgentNode = _bestWitchObjective(state, witch);
      if (urgentNode && !witchOnNode) {
        const step = stepToward(state, witch, urgentNode);
        if (step) {
          const result = executeMove(state, witch, step.col, step.row);
          logResult(state, result);
          state.spendAction(result.cost);
          return true;
        }
      }
      for (const m of minions) {
        if (_isOnNode(state, m)) continue;
        const mn = _bestWitchObjective(state, m);
        if (mn) {
          const step = stepToward(state, m, mn);
          if (step) {
            const result = executeMove(state, m, step.col, step.row);
            logResult(state, result);
            state.spendAction(result.cost);
            return true;
          }
        }
      }
    }

    // 2. HOLD: witch is on a node — defend it; dispatch minions to uncover other nodes
    if (witchOnNode) {
      const adjThreat = state.entities.find(
        e => e.alive && e.owner === 'hero' && hexDistance(witch.col, witch.row, e.col, e.row) === 1
      );
      if (adjThreat) return this._executeBattleWithUI(witch, adjThreat);

      for (const m of minions) {
        if (_isOnNode(state, m)) continue;
        if (uncoveredNodes.length) {
          uncoveredNodes.sort((a, b) =>
            hexDistance(m.col, m.row, a.col, a.row) - hexDistance(m.col, m.row, b.col, b.row)
          );
          const step = stepToward(state, m, uncoveredNodes[0]);
          if (step) {
            const result = executeMove(state, m, step.col, step.row);
            logResult(state, result);
            state.spendAction(result.cost);
            return true;
          }
        }
      }
      return false; // hold position
    }

    // 3. Dispatch minions toward uncovered nodes (before summoning more)
    for (const m of minions) {
      if (_isOnNode(state, m)) continue;
      const nodeTarget = _bestWitchObjective(state, m);
      if (nodeTarget) {
        const step = stepToward(state, m, nodeTarget);
        if (step) {
          const result = executeMove(state, m, step.col, step.row);
          logResult(state, result);
          state.spendAction(result.cost);
          return true;
        }
      }
    }

    // 4. Summon if nodes are covered or army is depleted (resources permitting)
    if (uncoveredNodes.length === 0 || minions.length === 0) {
      if (await this._trySummon(witch, minions.length)) return true;
    }

    // 5. Witch explores current tile (gather resources)
    const witchTile = state.tiles.get(hexKey(witch.col, witch.row));
    if (witchTile && !witchTile.explored) {
      const result = executeExplore(state, witch);
      logResult(state, result);
      state.spendAction(result.cost);
      return true;
    }

    // 6. Move to adjacent unexplored resource tile
    const unexploredAdj = getNeighbors(witch.col, witch.row).find(n => {
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && !t.explored && (t.hiddenSurvivor || t.resource || t.building) &&
        t.type !== TileType.RIVER;
    });
    if (unexploredAdj) {
      const result = executeMove(state, witch, unexploredAdj.col, unexploredAdj.row);
      logResult(state, result);
      state.spendAction(result.cost);
      return true;
    }

    // 7. Witch moves toward best objective
    const obj = _bestWitchObjective(state, witch);
    if (obj) {
      const step = stepToward(state, witch, obj);
      if (step) {
        const result = executeMove(state, witch, step.col, step.row);
        logResult(state, result);
        state.spendAction(result.cost);
        return true;
      }
    }

    // 8. Shelter stray minions not on nodes (low priority — nodes always beat shelter)
    for (const m of minions) {
      if (_isOnNode(state, m)) continue;
      if (!inBuilding(state, m)) {
        const shelter = nearestBuilding(state, m);
        if (shelter) {
          const step = stepToward(state, m, shelter);
          if (step && !state.entities.some(e => e.alive && e.owner === 'hero' && e.col === step.col && e.row === step.row)) {
            const result = executeMove(state, m, step.col, step.row);
            logResult(state, result);
            state.spendAction(result.cost);
            return true;
          }
        }
      }
    }

    return false;
  }

  async _trySummon(witch, minionCount) {
    const state = this.state;
    const inv = state.inventory.witch;
    const totalRes = Object.values(inv).reduce((s, v) => s + v, 0);
    // Build a large horde — cap is generous since minions are cheap/weak
    const cap = (state.phase === Phase.NIGHT || state.phase === Phase.DUSK) ? 12 : 8;
    if (totalRes <= 0 || minionCount >= cap) return false;

    const spawnAdj = getNeighbors(witch.col, witch.row).find(n => {
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && t.type !== TileType.RIVER &&
        state.entities.filter(e => e.alive && e.col === n.col && e.row === n.row).length === 0;
    });
    if (!spawnAdj) return false;

    const result = executeSummon(state, witch, spawnAdj.col, spawnAdj.row);
    logResult(state, result);
    state.spendAction(result.cost);
    return true;
  }

  async _think() {
    await delay(this.thinkDelay * 0.5);
  }

  /** Generate a complete plan synchronously for the simultaneous-turn system. */
  generatePlan() {
    const sim = new PlanSimState(this.state, 'witch');
    const plan = [];

    while (sim.actionsLeft > 0 && plan.length < MAX_PLAN_LENGTH) {
      const action = this._decidePlanAction(sim);
      if (!action) break;
      plan.push(action);
      switch (action.type) {
        case PlanActionType.MOVE:         sim.applyMove(action.entityId, action.toCol, action.toRow); break;
        case PlanActionType.BATTLE_UNIT:
        case PlanActionType.BATTLE_HEX:  sim.applyBattle(); break;
        case PlanActionType.EXPLORE:     sim.applyExplore(); break;
        case PlanActionType.SUMMON:      sim.applySummon(action.toCol, action.toRow); break;
        default:                         sim.actionsLeft--; break;
      }
    }
    return plan;
  }

  /** Synchronous action decision for plan generation. Returns a PlanAction or null. */
  _decidePlanAction(sim) {
    const witch = sim.witch;
    if (!witch) return null;

    const phase  = sim.phase;
    const isNight = phase === Phase.NIGHT || phase === Phase.DUSK;
    const minions = sim.entities.filter(e => e.alive && e.owner === 'witch' && e.type !== EntityType.WITCH);
    const witchOnNode = _isOnNode(sim, witch);
    const heroScore   = sim.nodeScore.hero;
    const hero        = sim.hero;
    const uncoveredNodes = sim.witchObjectives.filter(obj =>
      !sim.entities.some(e => e.alive && e.owner === 'witch' && e.col === obj.col && e.row === obj.row)
    );

    const tryMove = (entity, target) => {
      const step = stepToward(sim, entity, target);
      if (step) return { type: PlanActionType.MOVE, entityId: entity.id, toCol: step.col, toRow: step.row };
      return null;
    };

    const tryFlee = (entity, threat) => {
      const step = stepAwayFrom(sim, entity, threat);
      if (step) return { type: PlanActionType.MOVE, entityId: entity.id, toCol: step.col, toRow: step.row };
      return null;
    };

    const tryBattle = (actor, target) =>
      ({ type: PlanActionType.BATTLE_UNIT, entityId: actor.id, targetId: target.id });

    if (isNight) {
      // 0. Flee if critical HP
      if (hero && witch.hp <= Math.ceil(witch.maxHp * 0.3)) {
        const close = hexDistance(witch.col, witch.row, hero.col, hero.row) <= 2;
        const covered = minions.some(m => hexDistance(witch.col, witch.row, m.col, m.row) <= 1);
        if (close && !covered) { const a = tryFlee(witch, hero); if (a) return a; }
      }

      // 1. Witch fights co-located hero unit
      const col1 = sim.entities.find(e => e.alive && e.owner === 'hero' && e.col === witch.col && e.row === witch.row);
      if (col1) return tryBattle(witch, col1);

      // 2. Fight adjacent hero unit
      const adj2 = sim.entities.find(e => e.alive && e.owner === 'hero' && hexDistance(witch.col, witch.row, e.col, e.row) === 1);
      if (adj2) return tryBattle(witch, adj2);

      // 3. Minion attacks
      for (const m of minions) {
        const mc = sim.entities.find(e => e.alive && e.owner === 'hero' && e.col === m.col && e.row === m.row);
        if (mc) return tryBattle(m, mc);
        const ma = sim.entities.find(e => e.alive && e.owner === 'hero' && hexDistance(m.col, m.row, e.col, e.row) === 1);
        if (ma) return tryBattle(m, ma);
      }

      // 4. Urgent race to nodes
      if (heroScore >= 2) {
        if (!witchOnNode) { const a = tryMove(witch, _bestWitchObjective(sim, witch)); if (a) return a; }
        for (const m of minions) {
          if (_isOnNode(sim, m)) continue;
          const a = tryMove(m, _bestWitchObjective(sim, m)); if (a) return a;
        }
      }

      // 5. Hold node
      if (witchOnNode) {
        const thr = sim.entities.find(e => e.alive && e.owner === 'hero' && hexDistance(witch.col, witch.row, e.col, e.row) === 1);
        if (thr) return tryBattle(witch, thr);
        const srt = [...uncoveredNodes].sort((a, b) =>
          hexDistance(witch.col, witch.row, a.col, a.row) - hexDistance(witch.col, witch.row, b.col, b.row));
        for (const m of minions) {
          if (_isOnNode(sim, m) || !srt.length) continue;
          const s = [...srt].sort((a, b) => hexDistance(m.col, m.row, a.col, a.row) - hexDistance(m.col, m.row, b.col, b.row));
          const a = tryMove(m, s[0]); if (a) return a;
        }
        return null;
      }

      // 6. Summon
      if (sim.witchSummonsThisTurn === 0) {
        const inv = sim.inventory.witch;
        const total = Object.values(inv).reduce((s, v) => s + v, 0);
        if (total > 0 && minions.length < 12) {
          const hex = getNeighbors(witch.col, witch.row).find(n => {
            const t = sim.tiles.get(hexKey(n.col, n.row));
            return t && t.type !== TileType.RIVER && !sim.entities.some(e => e.alive && e.col === n.col && e.row === n.row);
          });
          if (hex) return { type: PlanActionType.SUMMON, entityId: witch.id, toCol: hex.col, toRow: hex.row };
        }
      }

      // 7. Witch moves toward objective
      { const a = tryMove(witch, _bestWitchObjective(sim, witch)); if (a) return a; }

      // 8. Move minions toward objectives or hero
      for (const m of minions) {
        if (_isOnNode(sim, m)) continue;
        const obj = _bestWitchObjective(sim, m);
        if (obj) { const a = tryMove(m, obj); if (a) return a; }
        if (hero) { const a = tryMove(m, hero); if (a) return a; }
      }

      // 9. Hunt hero
      if (hero) { const a = tryMove(witch, hero); if (a) return a; }
      return null;
    }

    // ── DAY strategy ──────────────────────────────────────────────────────────
    const distToHero = hero ? hexDistance(witch.col, witch.row, hero.col, hero.row) : Infinity;

    // 0. Flee
    if (hero && distToHero <= 2 && witch.hp <= Math.ceil(witch.maxHp * 0.6)) {
      const a = tryFlee(witch, hero); if (a) return a;
    }

    // 1. Urgent
    if (heroScore >= 2) {
      if (!witchOnNode) { const a = tryMove(witch, _bestWitchObjective(sim, witch)); if (a) return a; }
      for (const m of minions) {
        if (_isOnNode(sim, m)) continue;
        const a = tryMove(m, _bestWitchObjective(sim, m)); if (a) return a;
      }
    }

    // 2. Hold node
    if (witchOnNode) {
      const thr = sim.entities.find(e => e.alive && e.owner === 'hero' && hexDistance(witch.col, witch.row, e.col, e.row) === 1);
      if (thr) return tryBattle(witch, thr);
      for (const m of minions) {
        if (_isOnNode(sim, m) || !uncoveredNodes.length) continue;
        const s = [...uncoveredNodes].sort((a, b) => hexDistance(m.col, m.row, a.col, a.row) - hexDistance(m.col, m.row, b.col, b.row));
        const a = tryMove(m, s[0]); if (a) return a;
      }
      return null;
    }

    // 3. Minions toward nodes
    for (const m of minions) {
      if (_isOnNode(sim, m)) continue;
      const a = tryMove(m, _bestWitchObjective(sim, m)); if (a) return a;
    }

    // 4. Summon
    if (uncoveredNodes.length === 0 || minions.length === 0) {
      if (sim.witchSummonsThisTurn === 0) {
        const inv = sim.inventory.witch;
        const total = Object.values(inv).reduce((s, v) => s + v, 0);
        if (total > 0 && minions.length < 8) {
          const hex = getNeighbors(witch.col, witch.row).find(n => {
            const t = sim.tiles.get(hexKey(n.col, n.row));
            return t && t.type !== TileType.RIVER && !sim.entities.some(e => e.alive && e.col === n.col && e.row === n.row);
          });
          if (hex) return { type: PlanActionType.SUMMON, entityId: witch.id, toCol: hex.col, toRow: hex.row };
        }
      }
    }

    // 5. Explore current tile
    const wt = sim.tiles.get(hexKey(witch.col, witch.row));
    if (wt && !wt.explored) return { type: PlanActionType.EXPLORE, entityId: witch.id };

    // 6. Move to adjacent unexplored resource tile
    const unexpAdj = getNeighbors(witch.col, witch.row).find(n => {
      const t = sim.tiles.get(hexKey(n.col, n.row));
      return t && !t.explored && (t.hiddenSurvivor || t.resource || t.building) && t.type !== TileType.RIVER;
    });
    if (unexpAdj) return { type: PlanActionType.MOVE, entityId: witch.id, toCol: unexpAdj.col, toRow: unexpAdj.row };

    // 7. Move toward objective
    { const a = tryMove(witch, _bestWitchObjective(sim, witch)); if (a) return a; }

    // 8. Shelter stray minions
    for (const m of minions) {
      if (_isOnNode(sim, m)) continue;
      const mt = sim.tiles.get(hexKey(m.col, m.row));
      if (!mt || mt.type !== TileType.BUILDING) {
        const a = tryMove(m, nearestBuilding(sim, m)); if (a) return a;
      }
    }

    return null;
  }
}

// ── HeroAI ────────────────────────────────────────────────────────────────────
// Strategy shifts with the day/night cycle:
//   DAWN/DAY  : Hunt aggressively — find survivors fast, then pursue witch/nodes
//   DUSK      : Seek shelter while still fighting if opportunity arises
//   NIGHT     : Hunker down — shelter all units in buildings; avoid open combat

export class HeroAI {
  constructor(state, onStateChange, thinkDelay = THINK_DELAY_MS) {
    this.state         = state;
    this.onStateChange = onStateChange;
    this.onBattleResult = null;
    this._running       = false;
    this.thinkDelay     = thinkDelay;
  }

  async takeTurn() {
    if (this._running) return;
    this._running = true;
    const state = this.state;
    try {
      while (state.actionsAvailable > 0 && !state.gameOver) {
        await delay(this.thinkDelay * 0.5);
        let acted = false;
        try { acted = await this._chooseAction(); } catch (err) {
          console.error('HeroAI _chooseAction error:', err);
        }
        if (!acted) break;
        this.onStateChange();
        await delay(this.thinkDelay);
      }
      if (!state.gameOver) state.endTurn();
      this.onStateChange();
    } finally {
      this._running = false;
    }
  }

  async _executeBattleWithUI(actor, target) {
    const actorSnap  = _snapEntity(actor);
    const targetSnap = _snapEntity(target);
    const result = executeBattle(this.state, actor, target);
    logResult(this.state, result);
    this.state.spendAction(result.cost);
    if (this.onBattleResult) {
      await this.onBattleResult(actorSnap, targetSnap, result);
    }
    return true;
  }

  async _chooseAction() {
    const state   = this.state;
    const hero    = state.hero;
    const phase   = state.phase;
    const isNight = phase === Phase.NIGHT || phase === Phase.DUSK;

    const survivors = state.entities.filter(
      e => e.alive && e.owner === 'hero' && e.type === EntityType.SURVIVOR
    );

    const heroOnNode = _isOnNode(state, hero);
    const witchNodeCount = state.witchObjectives.filter(obj =>
      state.entities.some(e => e.alive && e.owner === 'witch' && e.col === obj.col && e.row === obj.row)
    ).length;

    // ── NIGHT STRATEGY ─────────────────────────────────────────────────────
    // Hold nodes; only shelter if not on one. Urgently contest if witch is about to win.
    if (isNight) {
      // 1. Heal if badly hurt
      if (await this._tryHeal(hero)) return true;

      // 2. Fight any co-located witch unit (happens on nodes too)
      const colocatedN = state.entities.find(
        e => e.alive && e.owner === 'witch' && e.col === hero.col && e.row === hero.row
      );
      if (colocatedN) return this._executeBattleWithUI(hero, colocatedN);

      // 3. Hold current node — the node heals +1 HP/turn and holding it matters for scoring.
      //    Fight adjacent threats, then stand firm.
      if (heroOnNode) {
        const adjThreat = state.entities.find(
          e => e.alive && e.owner === 'witch' && hexDistance(hero.col, hero.row, e.col, e.row) === 1
        );
        if (adjThreat) return this._executeBattleWithUI(hero, adjThreat);

        // Use spare action to move a survivor toward an undefended node
        const undefended = _undefendedNodes(state, hero);
        for (const s of survivors) {
          if (_isOnNode(state, s)) continue;
          if (undefended.length) {
            undefended.sort((a, b) =>
              hexDistance(s.col, s.row, a.col, a.row) - hexDistance(s.col, s.row, b.col, b.row)
            );
            const step = stepToward(state, s, undefended[0]);
            if (step) {
              const result = executeMove(state, s, step.col, step.row);
              logResult(state, result);
              state.spendAction(result.cost);
              return true;
            }
          }
        }
        return false; // hold position
      }

      // 4. URGENT: witch holds 2+ nodes — race to contest the remaining one even at night
      if (witchNodeCount >= 2) {
        const urgentNode = _bestNodeForHero(state, hero);
        if (urgentNode) {
          const step = stepToward(state, hero, urgentNode);
          if (step) {
            const result = executeMove(state, hero, step.col, step.row);
            logResult(state, result);
            state.spendAction(result.cost);
            return true;
          }
        }
      }

      // 5. Hero seeks shelter
      if (!inBuilding(state, hero)) {
        const shelter = nearestBuilding(state, hero);
        if (shelter) {
          const step = stepToward(state, hero, shelter);
          if (step) {
            const result = executeMove(state, hero, step.col, step.row);
            logResult(state, result);
            state.spendAction(result.cost);
            return true;
          }
        }
      }

      // 6. Survivors: hold their nodes; otherwise shelter
      for (const s of survivors) {
        if (_isOnNode(state, s)) continue; // hold position
        if (!inBuilding(state, s)) {
          const shelter = nearestBuilding(state, s);
          if (shelter) {
            const step = stepToward(state, s, shelter);
            if (step && !state.entities.some(e => e.alive && e.owner === 'witch' && e.col === step.col && e.row === step.row)) {
              const result = executeMove(state, s, step.col, step.row);
              logResult(state, result);
              state.spendAction(result.cost);
              return true;
            }
          }
        }
      }

      // 7. Explore current building if sheltered and unexplored
      const heroTileN = state.tiles.get(hexKey(hero.col, hero.row));
      if (heroTileN && heroTileN.type === TileType.BUILDING && !heroTileN.explored) {
        const result = executeExplore(state, hero);
        logResult(state, result);
        state.spendAction(result.cost);
        return result.success;
      }

      return false;
    }

    // ── DAY STRATEGY ──────────────────────────────────────────────────────
    // Priority: heal → fight → HOLD NODE → urgent contest → contest nodes →
    //           anchor survivors → explore → hunt witch

    // 1. Heal if injured
    if (await this._tryHeal(hero)) return true;

    // 2. Fight co-located witch units
    const colocated = state.entities.find(
      e => e.alive && e.owner === 'witch' && e.col === hero.col && e.row === hero.row
    );
    if (colocated) return this._executeBattleWithUI(hero, colocated);

    // 3. Fight adjacent witch units — prioritise the witch herself
    const adjWitch = [
      state.entities.find(e => e.alive && e.type === EntityType.WITCH && hexDistance(hero.col, hero.row, e.col, e.row) === 1),
      state.entities.find(e => e.alive && e.owner === 'witch' && hexDistance(hero.col, hero.row, e.col, e.row) === 1),
    ].find(Boolean);
    if (adjWitch) return this._executeBattleWithUI(hero, adjWitch);

    // 4. Survivors fight if they can
    for (const s of survivors) {
      const sc = state.entities.find(
        e => e.alive && e.owner === 'witch' && e.col === s.col && e.row === s.row
      );
      if (sc) return this._executeBattleWithUI(s, sc);
      const sa = state.entities.find(
        e => e.alive && e.owner === 'witch' && hexDistance(s.col, s.row, e.col, e.row) === 1
      );
      if (sa) return this._executeBattleWithUI(s, sa);
    }

    // 5. HOLD NODE: hero is already on a node — defend it and anchor survivors to others.
    //    Hold firmly only if survivors are covering other nodes OR witch is threatening.
    //    Otherwise fall through to building exploration to recruit those survivors first.
    if (heroOnNode) {
      // Fight adjacent threats to the node
      const adjThreat = state.entities.find(
        e => e.alive && e.owner === 'witch' && hexDistance(hero.col, hero.row, e.col, e.row) === 1
      );
      if (adjThreat) return this._executeBattleWithUI(hero, adjThreat);

      // Send survivors toward undefended nodes while hero holds this one
      const undefended = _undefendedNodes(state, hero);
      for (const s of survivors) {
        if (_isOnNode(state, s)) continue;
        if (undefended.length) {
          undefended.sort((a, b) =>
            hexDistance(s.col, s.row, a.col, a.row) - hexDistance(s.col, s.row, b.col, b.row)
          );
          const step = stepToward(state, s, undefended[0]);
          if (step) {
            const result = executeMove(state, s, step.col, step.row);
            logResult(state, result);
            state.spendAction(result.cost);
            return true;
          }
        }
      }

      // Hold firmly if we have node support from survivors OR witch is already contesting
      const hasSurvivorOnNode = survivors.some(s => _isOnNode(state, s));
      const witchPressingUs   = witchNodeCount >= 1 || state.nodeScore.witch >= 1;
      if (hasSurvivorOnNode || witchPressingUs) {
        return false; // hold position
      }
      // No support and no immediate threat: fall through to recruit survivors from buildings
    }

    // 6. URGENT: witch holds 2+ nodes — drop everything and race to contest
    if (witchNodeCount >= 2) {
      const urgentNode = _bestNodeForHero(state, hero);
      if (urgentNode) {
        const step = stepToward(state, hero, urgentNode);
        if (step) {
          const result = executeMove(state, hero, step.col, step.row);
          logResult(state, result);
          state.spendAction(result.cost);
          return true;
        }
      }
      // Also rush survivors
      for (const s of survivors) {
        if (_isOnNode(state, s)) continue;
        const ct = _bestNodeForHero(state, s);
        if (ct) {
          const step = stepToward(state, s, ct);
          if (step) {
            const result = executeMove(state, s, step.col, step.row);
            logResult(state, result);
            state.spendAction(result.cost);
            return true;
          }
        }
      }
    }

    // 7. Move toward the nearest unclaimed or witch-held node
    const nodeTarget = _bestNodeForHero(state, hero);
    if (nodeTarget) {
      const step = stepToward(state, hero, nodeTarget);
      if (step) {
        const result = executeMove(state, hero, step.col, step.row);
        logResult(state, result);
        state.spendAction(result.cost);
        return true;
      }
    }

    // 8. Anchor survivors to undefended nodes
    for (const s of survivors) {
      if (_isOnNode(state, s)) continue;
      const sNode = _bestNodeForHero(state, s);
      if (sNode) {
        const step = stepToward(state, s, sNode);
        if (step) {
          const result = executeMove(state, s, step.col, step.row);
          logResult(state, result);
          state.spendAction(result.cost);
          return true;
        }
      }
    }

    // 9. Explore current building for loot
    const heroTile = state.tiles.get(hexKey(hero.col, hero.row));
    if (heroTile && heroTile.type === TileType.BUILDING && !heroTile.explored) {
      const result = executeExplore(state, hero);
      logResult(state, result);
      state.spendAction(result.cost);
      return result.success;
    }

    // 10. Move toward nearest unexplored building (find survivors + loot) — skip if witch is ahead on nodes
    if (witchNodeCount < 2) {
      const unxBuilding = _nearestUnexploredBuilding(state, hero);
      if (unxBuilding) {
        const step = stepToward(state, hero, unxBuilding);
        if (step) {
          const result = executeMove(state, hero, step.col, step.row);
          logResult(state, result);
          state.spendAction(result.cost);
          return true;
        }
      }
    }

    // 11. Hunt the witch — only if visible
    const visibleWitchHexes = getVisibleEnemyHexes(state);
    if (visibleWitchHexes.has(hexKey(state.witch.col, state.witch.row))) {
      const step = stepToward(state, hero, state.witch);
      if (step) {
        const result = executeMove(state, hero, step.col, step.row);
        logResult(state, result);
        state.spendAction(result.cost);
        return true;
      }
    }

    return false;
  }

  async _tryHeal(hero) {
    const herbs = (hero.items && hero.items[ResourceType.HERBS]) || 0;
    if (herbs > 0 && hero.hp < hero.maxHp) {
      const result = executeUseItem(this.state, hero, ResourceType.HERBS);
      for (const msg of result.log) this.state.addLog(msg);
      if (result.success) this.state.spendAction(result.cost);
      return result.success;
    }
    return false;
  }

  /** Generate a complete plan synchronously for the simultaneous-turn system. */
  generatePlan() {
    const sim = new PlanSimState(this.state, 'hero');
    const plan = [];

    while (sim.actionsLeft > 0 && plan.length < MAX_PLAN_LENGTH) {
      const action = this._decidePlanAction(sim);
      if (!action) break;
      plan.push(action);
      switch (action.type) {
        case PlanActionType.MOVE:         sim.applyMove(action.entityId, action.toCol, action.toRow); break;
        case PlanActionType.BATTLE_UNIT:
        case PlanActionType.BATTLE_HEX:  sim.applyBattle(); break;
        case PlanActionType.EXPLORE:     sim.applyExplore(); break;
        case PlanActionType.USE_ITEM:    /* herbs are free, food costs 1 */ if (action.item !== ResourceType.HERBS) sim.actionsLeft--; break;
        default:                         sim.actionsLeft--; break;
      }
    }
    return plan;
  }

  /** Synchronous action decision for plan generation. Returns a PlanAction or null. */
  _decidePlanAction(sim) {
    const hero = sim.hero;
    if (!hero) return null;

    const phase   = sim.phase;
    const isNight = phase === Phase.NIGHT || phase === Phase.DUSK;
    const survivors = sim.entities.filter(e => e.alive && e.owner === 'hero' && e.type === EntityType.SURVIVOR);
    const heroOnNode = _isOnNode(sim, hero);
    const witch = sim.witch;
    const witchNodeCount = sim.witchObjectives.filter(obj =>
      sim.entities.some(e => e.alive && e.owner === 'witch' && e.col === obj.col && e.row === obj.row)
    ).length;

    const tryMove = (entity, target) => {
      if (!target) return null;
      const step = stepToward(sim, entity, target);
      if (step) return { type: PlanActionType.MOVE, entityId: entity.id, toCol: step.col, toRow: step.row };
      return null;
    };
    const tryBattle = (actor, target) =>
      ({ type: PlanActionType.BATTLE_UNIT, entityId: actor.id, targetId: target.id });

    // Heal via herbs (free action — always good to include)
    const herbs = (hero.items && hero.items[ResourceType.HERBS]) || 0;
    if (herbs > 0 && hero.hp < hero.maxHp) {
      return { type: PlanActionType.USE_ITEM, entityId: hero.id, item: ResourceType.HERBS };
    }

    if (isNight) {
      // 2. Fight co-located witch unit
      const colN = sim.entities.find(e => e.alive && e.owner === 'witch' && e.col === hero.col && e.row === hero.row);
      if (colN) return tryBattle(hero, colN);

      // 3. Hold current node
      if (heroOnNode) {
        const thr = sim.entities.find(e => e.alive && e.owner === 'witch' && hexDistance(hero.col, hero.row, e.col, e.row) === 1);
        if (thr) return tryBattle(hero, thr);
        const undef = _undefendedNodes(sim, hero);
        for (const s of survivors) {
          if (_isOnNode(sim, s)) continue;
          if (undef.length) {
            const sorted = [...undef].sort((a, b) => hexDistance(s.col, s.row, a.col, a.row) - hexDistance(s.col, s.row, b.col, b.row));
            const a = tryMove(s, sorted[0]); if (a) return a;
          }
        }
        return null;
      }

      // 4. Urgent: witch holds 2+
      if (witchNodeCount >= 2) {
        const a = tryMove(hero, _bestNodeForHero(sim, hero)); if (a) return a;
        for (const s of survivors) {
          if (_isOnNode(sim, s)) continue;
          const b = tryMove(s, _bestNodeForHero(sim, s)); if (b) return b;
        }
      }

      // 5. Seek shelter
      const heroTile = sim.tiles.get(hexKey(hero.col, hero.row));
      if (!heroTile || heroTile.type !== TileType.BUILDING) {
        const a = tryMove(hero, nearestBuilding(sim, hero)); if (a) return a;
      }

      // 6. Move survivors to shelter
      for (const s of survivors) {
        if (_isOnNode(sim, s)) continue;
        const st = sim.tiles.get(hexKey(s.col, s.row));
        if (!st || st.type !== TileType.BUILDING) {
          const a = tryMove(s, nearestBuilding(sim, s)); if (a) return a;
        }
      }

      // 7. Explore building while sheltered
      const heroTN = sim.tiles.get(hexKey(hero.col, hero.row));
      if (heroTN && heroTN.type === TileType.BUILDING && !heroTN.explored) {
        return { type: PlanActionType.EXPLORE, entityId: hero.id };
      }
      return null;
    }

    // ── DAY strategy ──────────────────────────────────────────────────────────

    // 2. Fight co-located
    const col = sim.entities.find(e => e.alive && e.owner === 'witch' && e.col === hero.col && e.row === hero.row);
    if (col) return tryBattle(hero, col);

    // 3. Fight adjacent witch — prioritise the witch herself
    const adjW = [
      sim.entities.find(e => e.alive && e.type === EntityType.WITCH && hexDistance(hero.col, hero.row, e.col, e.row) === 1),
      sim.entities.find(e => e.alive && e.owner === 'witch' && hexDistance(hero.col, hero.row, e.col, e.row) === 1),
    ].find(Boolean);
    if (adjW) return tryBattle(hero, adjW);

    // 4. Survivors fight
    for (const s of survivors) {
      const sc = sim.entities.find(e => e.alive && e.owner === 'witch' && e.col === s.col && e.row === s.row);
      if (sc) return tryBattle(s, sc);
      const sa = sim.entities.find(e => e.alive && e.owner === 'witch' && hexDistance(s.col, s.row, e.col, e.row) === 1);
      if (sa) return tryBattle(s, sa);
    }

    // 5. Hold node
    if (heroOnNode) {
      const thr = sim.entities.find(e => e.alive && e.owner === 'witch' && hexDistance(hero.col, hero.row, e.col, e.row) === 1);
      if (thr) return tryBattle(hero, thr);
      const undef = _undefendedNodes(sim, hero);
      for (const s of survivors) {
        if (_isOnNode(sim, s)) continue;
        if (undef.length) {
          const sorted = [...undef].sort((a, b) => hexDistance(s.col, s.row, a.col, a.row) - hexDistance(s.col, s.row, b.col, b.row));
          const a = tryMove(s, sorted[0]); if (a) return a;
        }
      }
      const hasSurvivorOnNode = survivors.some(s => _isOnNode(sim, s));
      if (hasSurvivorOnNode || witchNodeCount >= 1 || sim.nodeScore.witch >= 1) return null;
    }

    // 6. Urgent: witch holds 2+
    if (witchNodeCount >= 2) {
      const a = tryMove(hero, _bestNodeForHero(sim, hero)); if (a) return a;
      for (const s of survivors) {
        if (_isOnNode(sim, s)) continue;
        const b = tryMove(s, _bestNodeForHero(sim, s)); if (b) return b;
      }
    }

    // 7. Move toward nearest node
    { const a = tryMove(hero, _bestNodeForHero(sim, hero)); if (a) return a; }

    // 8. Anchor survivors to nodes
    for (const s of survivors) {
      if (_isOnNode(sim, s)) continue;
      const a = tryMove(s, _bestNodeForHero(sim, s)); if (a) return a;
    }

    // 9. Explore current building
    const heroTile = sim.tiles.get(hexKey(hero.col, hero.row));
    if (heroTile && heroTile.type === TileType.BUILDING && !heroTile.explored) {
      return { type: PlanActionType.EXPLORE, entityId: hero.id };
    }

    // 10. Move toward nearest unexplored building
    if (witchNodeCount < 2) {
      const a = tryMove(hero, _nearestUnexploredBuilding(sim, hero)); if (a) return a;
    }

    // 11. Hunt the witch
    if (witch) { const a = tryMove(hero, witch); if (a) return a; }

    return null;
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _nearestUnexploredBuilding(state, actor) {
  let best = null, bestDist = Infinity;
  for (const [, t] of state.tiles) {
    if (t.type !== TileType.BUILDING || t.explored) continue;
    const d = hexDistance(actor.col, actor.row, t.col, t.row);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  return best;
}

// Nodes not currently defended by any hero unit (excluding the holding actor itself).
function _undefendedNodes(state, holder) {
  return state.witchObjectives.filter(obj =>
    !(obj.col === holder.col && obj.row === holder.row) &&
    !state.entities.some(e => e.alive && e.owner === 'hero' && e.col === obj.col && e.row === obj.row)
  );
}

// Best node target for a hero unit: unclaimed first, then witch-held nodes to contest.
// Excludes nodes already occupied by the actor (no need to move there).
function _bestNodeForHero(state, actor) {
  const unclaimed = state.witchObjectives.filter(obj =>
    !state.entities.some(e => e.alive && e.col === obj.col && e.row === obj.row)
  );
  if (unclaimed.length) {
    unclaimed.sort((a, b) =>
      hexDistance(actor.col, actor.row, a.col, a.row) -
      hexDistance(actor.col, actor.row, b.col, b.row)
    );
    return unclaimed[0];
  }
  const witchHeld = state.witchObjectives.filter(obj =>
    state.entities.some(e => e.alive && e.owner === 'witch' && e.col === obj.col && e.row === obj.row) &&
    !state.entities.some(e => e.alive && e.owner === 'hero' && e.col === obj.col && e.row === obj.row)
  );
  if (witchHeld.length) {
    witchHeld.sort((a, b) =>
      hexDistance(actor.col, actor.row, a.col, a.row) -
      hexDistance(actor.col, actor.row, b.col, b.row)
    );
    return witchHeld[0];
  }
  return null;
}

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

// ── Plan simulation state ─────────────────────────────────────────────────────
// A lightweight clone of GameState used for synchronous plan generation.
// Only entity positions and action budget are tracked; combat outcomes are
// not simulated (dice unknown) — battles simply consume one budget slot.

class PlanSimState {
  constructor(realState, faction) {
    this.tiles            = realState.tiles;          // read-only reference
    this.phase            = realState.phase;
    this.witchObjectives  = realState.witchObjectives;
    this.nodeScore        = realState.nodeScore;
    this.fogOfWar         = realState.fogOfWar;
    this.inventory        = JSON.parse(JSON.stringify(realState.inventory));
    this.witchSummonsThisTurn = realState.witchSummonsThisTurn ?? 0;

    // Shallow-copy live entities so position tracking works without mutating the real state
    this.entities = realState.entities
      .filter(e => e.alive)
      .map(e => ({ ...e }));

    this.hero  = this.entities.find(e => e.type === EntityType.HERO);
    this.witch = this.entities.find(e => e.type === EntityType.WITCH);

    this.actionsLeft = computeActions(
      faction === 'hero' ? Player.HERO : Player.WITCH,
      realState.phase,
      this.entities,
    );
    this._faction = faction;
  }

  applyMove(entityId, toCol, toRow) {
    const e = this.entities.find(e => e.id === entityId);
    if (e) { e.col = toCol; e.row = toRow; }
    this.actionsLeft--;
  }

  applyBattle() {
    this.actionsLeft--;
  }

  applyExplore() {
    this.actionsLeft--;
  }

  applySummon(toCol, toRow) {
    this.entities.push({
      id: `sim-${this.entities.length}`,
      type: EntityType.MINION, owner: 'witch',
      col: toCol, row: toRow, alive: true, hp: 2,
    });
    this.witchSummonsThisTurn++;
    this.actionsLeft--;
  }
}
