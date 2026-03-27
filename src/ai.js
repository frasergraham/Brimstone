// AI controllers — WitchAI and HeroAI
// Both use a weight-based priority system that shifts based on the day/night phase.
import { getNeighbors, hexDistance, hexKey } from './hex.js';
import { TileType, ResourceType } from './tiles.js';
import { EntityType } from './entities.js';
import { Phase, computeActions, computeActionsForPlayer, Player, nodeController } from './game.js';
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
  return state.witchObjectives.some(obj =>
    obj.hexes.some(h => h.col === entity.col && h.row === entity.row)
  );
}

// Returns the hex in obj.hexes closest to actor.
function _nearestClusterHex(actor, obj) {
  let best = obj, bestDist = Infinity;
  for (const h of obj.hexes) {
    const d = hexDistance(actor.col, actor.row, h.col, h.row);
    if (d < bestDist) { bestDist = d; best = h; }
  }
  return best;
}

// Returns the best node target for the witch: neutral nodes first, then hero-controlled.
// Excludes the node the actor just departed (prevents oscillation in planning sim).
// claimedNodes (optional Set<"col,row">) — nodes already targeted by allied AI players;
//   the chosen objective's hexes are added to this set so subsequent allies pick differently.
function _bestWitchObjective(state, actor, claimedNodes = null) {
  const justLeft = state._justLeft && state._justLeft[actor.id];
  const notJustLeft = obj => !(justLeft && justLeft.col === obj.col && justLeft.row === obj.row);
  const notClaimed  = obj => !claimedNodes || !obj.hexes.some(h => claimedNodes.has(hexKey(h.col, h.row)));

  const neutral = state.witchObjectives.filter(obj =>
    nodeController(obj, state.entities) === 'neutral' && notJustLeft(obj) && notClaimed(obj)
  );
  if (neutral.length) {
    neutral.sort((a, b) =>
      hexDistance(actor.col, actor.row, a.col, a.row) -
      hexDistance(actor.col, actor.row, b.col, b.row)
    );
    const chosen = neutral[0];
    if (claimedNodes) chosen.hexes.forEach(h => claimedNodes.add(hexKey(h.col, h.row)));
    return _nearestClusterHex(actor, chosen);
  }
  const heroHeld = state.witchObjectives.filter(obj =>
    nodeController(obj, state.entities) === 'hero' && notJustLeft(obj) && notClaimed(obj)
  );
  if (heroHeld.length) {
    heroHeld.sort((a, b) =>
      hexDistance(actor.col, actor.row, a.col, a.row) -
      hexDistance(actor.col, actor.row, b.col, b.row)
    );
    const chosen = heroHeld[0];
    if (claimedNodes) chosen.hexes.forEach(h => claimedNodes.add(hexKey(h.col, h.row)));
    return _nearestClusterHex(actor, chosen);
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
  constructor(state, onStateChange, thinkDelay = THINK_DELAY_MS, playerId = null) {
    this.state         = state;
    this.onStateChange = onStateChange;
    this.onBattleResult = null;
    this._running      = false;
    this.thinkDelay    = thinkDelay;
    this.playerId      = playerId;  // null → offline/legacy; set → scoped MP plan
    this._allyContext  = null;      // set during generatePlan() for MP coordination
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
    // Cap keeps army manageable — too many minions let witch dominate nodes passively
    const cap = (state.phase === Phase.NIGHT || state.phase === Phase.DUSK) ? 8 : 5;
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

  /** Generate a complete plan synchronously for the simultaneous-turn system.
   * @param {object|null} allyContext - Shared mutable coordination context for allied AI players.
   *   Shape: { claimedNodes: Set<string>, allyPositions: {col,row}[] }
   *   Passing null (default) disables all ally-awareness — identical to solo/offline behaviour.
   */
  generatePlan(allyContext = null) {
    this._allyContext = allyContext;
    const sim = new PlanSimState(this.state, 'witch', this.playerId);
    const plan = [];

    while (sim.actionsLeft > 0 && plan.length < MAX_PLAN_LENGTH) {
      const action = this._decidePlanAction(sim);
      if (!action) break;
      plan.push(action);
      switch (action.type) {
        case PlanActionType.MOVE:         sim.applyMove(action.entityId, action.toCol, action.toRow); break;
        case PlanActionType.BATTLE_UNIT:
        case PlanActionType.BATTLE_HEX:  sim.applyBattle(); break;
        case PlanActionType.EXPLORE:     sim.applyExplore(action.entityId); break;
        case PlanActionType.SUMMON:      sim.applySummon(action.toCol, action.toRow); break;
        default:                         sim.actionsLeft--; break;
      }
    }
    this._allyContext = null;
    return plan;
  }

  /** Synchronous action decision for plan generation. Returns a PlanAction or null. */
  _decidePlanAction(sim) {
    const witch = sim.witch;
    if (!witch) return null;

    const phase  = sim.phase;
    const isNight = phase === Phase.NIGHT || phase === Phase.DUSK;
    const minions = sim.entities.filter(e => e.alive && e.owner === 'witch' && e.type !== EntityType.WITCH);
    // Only dispatch minions with real entity IDs (not sim-summoned placeholders whose IDs
    // won't exist in the real state and would SKIP in resolution, wasting budget slots).
    const realMinions = minions.filter(m => !m.id.startsWith('sim-'));
    const witchOnNode = _isOnNode(sim, witch);
    const heroScore   = sim.nodeScore.hero;
    const hero        = sim.hero;
    // Ally context shorthand (null in 1v1 / offline — no behaviour change)
    const claimedNodes  = this._allyContext?.claimedNodes ?? null;
    const allyPositions = this._allyContext?.allyPositions ?? null;
    // Nodes uncovered by any witch unit, also excluding nodes already claimed by allied AI players
    const uncoveredNodes = sim.witchObjectives.filter(obj =>
      !sim.entities.some(e => e.alive && e.owner === 'witch' && e.col === obj.col && e.row === obj.row) &&
      !(claimedNodes && obj.hexes.some(h => claimedNodes.has(hexKey(h.col, h.row))))
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
      // 0. Flee if critical HP — suppressed when an allied leader is adjacent (mutual support)
      if (hero && witch.hp <= Math.ceil(witch.maxHp * 0.3)) {
        const close   = hexDistance(witch.col, witch.row, hero.col, hero.row) <= 2;
        const covered = minions.some(m => hexDistance(witch.col, witch.row, m.col, m.row) <= 1);
        const allyNearby = allyPositions?.some(a => hexDistance(a.col, a.row, witch.col, witch.row) <= 1) ?? false;
        if (close && !covered && !allyNearby) { const a = tryFlee(witch, hero); if (a) return a; }
      }

      // 1. Witch fights co-located hero unit
      const col1 = sim.entities.find(e => e.alive && e.owner === 'hero' && e.col === witch.col && e.row === witch.row);
      if (col1) return tryBattle(witch, col1);

      // 2. Fight adjacent hero unit — prioritise the hero leader over survivors
      const adj2 = sim.entities.find(e => e.alive && e.type === EntityType.HERO && hexDistance(witch.col, witch.row, e.col, e.row) === 1)
        ?? sim.entities.find(e => e.alive && e.owner === 'hero' && hexDistance(witch.col, witch.row, e.col, e.row) === 1)
        ?? null;
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
        if (!witchOnNode) { const a = tryMove(witch, _bestWitchObjective(sim, witch, claimedNodes)); if (a) return a; }
        for (const m of realMinions) {
          if (_isOnNode(sim, m)) continue;
          const a = tryMove(m, _bestWitchObjective(sim, m, claimedNodes)); if (a) return a;
        }
      }

      // 5. Hold node
      if (witchOnNode) {
        const thr = sim.entities.find(e => e.alive && e.type === EntityType.HERO && hexDistance(witch.col, witch.row, e.col, e.row) === 1)
          ?? sim.entities.find(e => e.alive && e.owner === 'hero' && hexDistance(witch.col, witch.row, e.col, e.row) === 1)
          ?? null;
        if (thr) return tryBattle(witch, thr);
        const srt = [...uncoveredNodes].sort((a, b) =>
          hexDistance(witch.col, witch.row, a.col, a.row) - hexDistance(witch.col, witch.row, b.col, b.row));
        for (const m of realMinions) {
          if (_isOnNode(sim, m) || !srt.length) continue;
          const s = [...srt].sort((a, b) => hexDistance(m.col, m.row, a.col, a.row) - hexDistance(m.col, m.row, b.col, b.row));
          const a = tryMove(m, s[0]); if (a) return a;
        }
        // Use spare budget: summon or explore; stay on node at night.
        {
          const inv = sim.inventory.witch;
          const total = Object.values(inv).reduce((s, v) => s + v, 0);
          if (total >= 2 && minions.length < 8) {
            const hex = getNeighbors(witch.col, witch.row).find(n => {
              const t = sim.tiles.get(hexKey(n.col, n.row));
              return t && t.type !== TileType.RIVER && !sim.entities.some(e => e.alive && e.col === n.col && e.row === n.row);
            });
            if (hex) return { type: PlanActionType.SUMMON, entityId: witch.id, toCol: hex.col, toRow: hex.row };
          }
        }
        const wtn = sim.tiles.get(hexKey(witch.col, witch.row));
        if (wtn && !sim.isExplored(witch.col, witch.row)) return { type: PlanActionType.EXPLORE, entityId: witch.id };
        // All nodes covered + spare night budget — hunt the hero (night ATK bonus!)
        if (hero) { const a = tryMove(witch, hero); if (a) return a; }
        return null;
      }

      // 6. Summon
      {
        const inv = sim.inventory.witch;
        const total = Object.values(inv).reduce((s, v) => s + v, 0);
        if (total >= 2 && minions.length < 8) {
          const hex = getNeighbors(witch.col, witch.row).find(n => {
            const t = sim.tiles.get(hexKey(n.col, n.row));
            return t && t.type !== TileType.RIVER && !sim.entities.some(e => e.alive && e.col === n.col && e.row === n.row);
          });
          if (hex) return { type: PlanActionType.SUMMON, entityId: witch.id, toCol: hex.col, toRow: hex.row };
        }
      }

      // 7. Witch moves toward objective
      { const a = tryMove(witch, _bestWitchObjective(sim, witch, claimedNodes)); if (a) return a; }

      // 8. Move minions toward objectives or hero
      for (const m of realMinions) {
        if (_isOnNode(sim, m)) continue;
        const obj = _bestWitchObjective(sim, m, claimedNodes);
        if (obj) { const a = tryMove(m, obj); if (a) return a; }
        if (hero) { const a = tryMove(m, hero); if (a) return a; }
      }

      // 9. Hunt hero — always pursue at night; night ATK bonus makes this powerful
      if (hero) { const a = tryMove(witch, hero); if (a) return a; }
      return null;
    }

    // ── DAY strategy ──────────────────────────────────────────────────────────
    const distToHero = hero ? hexDistance(witch.col, witch.row, hero.col, hero.row) : Infinity;

    // 0. Flee if injured and hero nearby — suppressed when an allied leader is adjacent.
    //    In team games the hero's stat advantage (14HP/3ATK) is more punishing; flee sooner.
    const allyNearbyDay = allyPositions?.some(a => hexDistance(a.col, a.row, witch.col, witch.row) <= 1) ?? false;
    const dayFleeHpRatio = allyPositions !== null ? 0.75 : 0.60;
    const dayFleeDist    = allyPositions !== null ? 3 : 2;
    if (hero && distToHero <= dayFleeDist && witch.hp <= Math.ceil(witch.maxHp * dayFleeHpRatio) && !allyNearbyDay) {
      const a = tryFlee(witch, hero); if (a) return a;
    }

    // 1. Witch fights co-located hero unit (always — can't share a hex peacefully)
    const colD = sim.entities.find(e => e.alive && e.owner === 'hero' && e.col === witch.col && e.row === witch.row);
    if (colD) return tryBattle(witch, colD);

    // 2. Minion co-location attacks (enemies on the same hex must be engaged)
    for (const m of minions) {
      const mc = sim.entities.find(e => e.alive && e.owner === 'hero' && e.col === m.col && e.row === m.row);
      if (mc) return tryBattle(m, mc);
    }

    // 3. Urgent node race
    if (heroScore >= 2) {
      if (!witchOnNode) { const a = tryMove(witch, _bestWitchObjective(sim, witch, claimedNodes)); if (a) return a; }
      for (const m of realMinions) {
        if (_isOnNode(sim, m)) continue;
        const a = tryMove(m, _bestWitchObjective(sim, m, claimedNodes)); if (a) return a;
      }
    }

    // 4. Hold node
    if (witchOnNode) {
      const thr = sim.entities.find(e => e.alive && e.type === EntityType.HERO && hexDistance(witch.col, witch.row, e.col, e.row) === 1)
        ?? sim.entities.find(e => e.alive && e.owner === 'hero' && hexDistance(witch.col, witch.row, e.col, e.row) === 1)
        ?? null;
      if (thr) return tryBattle(witch, thr);
      for (const m of realMinions) {
        if (_isOnNode(sim, m) || !uncoveredNodes.length) continue;
        const s = [...uncoveredNodes].sort((a, b) => hexDistance(m.col, m.row, a.col, a.row) - hexDistance(m.col, m.row, b.col, b.row));
        const a = tryMove(m, s[0]); if (a) return a;
      }
      // Use spare budget: summon more troops or explore for resources; do NOT leave node.
      {
        const inv = sim.inventory.witch;
        const total = Object.values(inv).reduce((s, v) => s + v, 0);
        if (total >= 2 && minions.length < 5) {
          const hex = getNeighbors(witch.col, witch.row).find(n => {
            const t = sim.tiles.get(hexKey(n.col, n.row));
            return t && t.type !== TileType.RIVER && !sim.entities.some(e => e.alive && e.col === n.col && e.row === n.row);
          });
          if (hex) return { type: PlanActionType.SUMMON, entityId: witch.id, toCol: hex.col, toRow: hex.row };
        }
      }
      const wtn = sim.tiles.get(hexKey(witch.col, witch.row));
      if (wtn && !sim.isExplored(witch.col, witch.row)) return { type: PlanActionType.EXPLORE, entityId: witch.id };
      // All nodes covered + spare budget — fight adjacent hero or pursue
      const adjD = sim.entities.find(e => e.alive && e.owner === 'hero' && hexDistance(witch.col, witch.row, e.col, e.row) === 1);
      if (adjD) return tryBattle(witch, adjD);
      if (hero) { const a = tryMove(witch, hero); if (a) return a; }
      return null; // hold the node
    }

    // 5. Witch fights adjacent hero — prioritise the hero leader over survivors
    const adjD2 = sim.entities.find(e => e.alive && e.type === EntityType.HERO && hexDistance(witch.col, witch.row, e.col, e.row) === 1)
      ?? sim.entities.find(e => e.alive && e.owner === 'hero' && hexDistance(witch.col, witch.row, e.col, e.row) === 1)
      ?? null;
    if (adjD2) return tryBattle(witch, adjD2);

    // 6. Minions toward nodes, plus adjacent attacks for node-bound minions
    for (const m of realMinions) {
      const ma = sim.entities.find(e => e.alive && e.owner === 'hero' && hexDistance(m.col, m.row, e.col, e.row) === 1);
      if (ma) return tryBattle(m, ma);
      if (_isOnNode(sim, m)) continue;
      const a = tryMove(m, _bestWitchObjective(sim, m, claimedNodes)); if (a) return a;
    }

    // 7. Summon
    if (uncoveredNodes.length === 0 || minions.length === 0) {
      const inv = sim.inventory.witch;
      const total = Object.values(inv).reduce((s, v) => s + v, 0);
      if (total >= 2 && minions.length < 5) {
        const hex = getNeighbors(witch.col, witch.row).find(n => {
          const t = sim.tiles.get(hexKey(n.col, n.row));
          return t && t.type !== TileType.RIVER && !sim.entities.some(e => e.alive && e.col === n.col && e.row === n.row);
        });
        if (hex) return { type: PlanActionType.SUMMON, entityId: witch.id, toCol: hex.col, toRow: hex.row };
      }
    }

    // 8. Explore current tile
    const wt = sim.tiles.get(hexKey(witch.col, witch.row));
    if (wt && !sim.isExplored(witch.col, witch.row)) return { type: PlanActionType.EXPLORE, entityId: witch.id };

    // 9. Move to adjacent unexplored resource tile
    const unexpAdj = getNeighbors(witch.col, witch.row).find(n => {
      const t = sim.tiles.get(hexKey(n.col, n.row));
      return t && !sim.isExplored(t.col, t.row) && (t.hiddenSurvivor || t.resource || t.building) && t.type !== TileType.RIVER;
    });
    if (unexpAdj) return { type: PlanActionType.MOVE, entityId: witch.id, toCol: unexpAdj.col, toRow: unexpAdj.row };

    // 10. Move toward objective
    { const a = tryMove(witch, _bestWitchObjective(sim, witch, claimedNodes)); if (a) return a; }

    // 11. Pursue hero to force combat
    if (hero) { const a = tryMove(witch, hero); if (a) return a; }

    return null;
  }
}

// ── HeroAI ────────────────────────────────────────────────────────────────────
// Strategy shifts with the day/night cycle:
//   DAWN/DAY  : Hunt aggressively — find survivors fast, then pursue witch/nodes
//   DUSK      : Seek shelter while still fighting if opportunity arises
//   NIGHT     : Hunker down — shelter all units in buildings; avoid open combat

export class HeroAI {
  constructor(state, onStateChange, thinkDelay = THINK_DELAY_MS, playerId = null) {
    this.state         = state;
    this.onStateChange = onStateChange;
    this.onBattleResult = null;
    this._running       = false;
    this.thinkDelay     = thinkDelay;
    this.playerId       = playerId;  // null → offline/legacy; set → scoped MP plan
    this._allyContext   = null;      // set during generatePlan() for MP coordination
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

      // 2b. Fight adjacent witch (the boss) — worth the risk at night; avoid minion swarms
      const adjThreatN = state.entities.find(
        e => e.alive && e.type === EntityType.WITCH && hexDistance(hero.col, hero.row, e.col, e.row) === 1
      );
      if (adjThreatN) return this._executeBattleWithUI(hero, adjThreatN);

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

    // 10. Hunt the witch — kill wins the game; always prefer this over building exploration
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

    // 11. Move toward nearest unexplored building (find survivors + loot) — skip if witch is ahead on nodes
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

  /** Generate a complete plan synchronously for the simultaneous-turn system.
   * @param {object|null} allyContext - Shared mutable coordination context for allied AI players.
   *   Shape: { claimedNodes: Set<string>, allyPositions: {col,row}[] }
   *   Passing null (default) disables all ally-awareness — identical to solo/offline behaviour.
   */
  generatePlan(allyContext = null) {
    this._allyContext = allyContext;
    const sim = new PlanSimState(this.state, 'hero', this.playerId);
    const plan = [];

    while (sim.actionsLeft > 0 && plan.length < MAX_PLAN_LENGTH) {
      const action = this._decidePlanAction(sim);
      if (!action) break;
      plan.push(action);
      switch (action.type) {
        case PlanActionType.MOVE:         sim.applyMove(action.entityId, action.toCol, action.toRow); break;
        case PlanActionType.BATTLE_UNIT:
        case PlanActionType.BATTLE_HEX:  sim.applyBattle(); break;
        case PlanActionType.EXPLORE:     sim.applyExplore(action.entityId); break;
        case PlanActionType.USE_ITEM:    /* herbs are free, food costs 1 */ if (action.item !== ResourceType.HERBS) sim.actionsLeft--; break;
        default:                         sim.actionsLeft--; break;
      }
    }
    this._allyContext = null;
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

    // Ally context shorthand (null in 1v1 / offline — no behaviour change)
    const claimedNodes  = this._allyContext?.claimedNodes ?? null;

    // Heal via herbs (free action — always good to include)
    const herbs = (hero.items && hero.items[ResourceType.HERBS]) || 0;
    if (herbs > 0 && hero.hp < hero.maxHp) {
      return { type: PlanActionType.USE_ITEM, entityId: hero.id, item: ResourceType.HERBS };
    }

    if (isNight) {
      // 2. Fight co-located witch unit
      const colN = sim.entities.find(e => e.alive && e.owner === 'witch' && e.col === hero.col && e.row === hero.row);
      if (colN) return tryBattle(hero, colN);

      // 2b. Fight adjacent witch (the boss) — worth the risk at night; avoid minion swarms
      const adjWitchN = sim.entities.find(e => e.alive && e.type === EntityType.WITCH && hexDistance(hero.col, hero.row, e.col, e.row) === 1);
      if (adjWitchN) return tryBattle(hero, adjWitchN);

      // 3. Node combat + dispatch — hero stays mobile, doesn't idle on node
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
        // Explore current tile
        const ht = sim.tiles.get(hexKey(hero.col, hero.row));
        if (ht && !sim.isExplored(hero.col, hero.row)) return { type: PlanActionType.EXPLORE, entityId: hero.id };
        // Advance toward witch with spare budget (hero takes no night hazard damage)
        if (witch) { const a = tryMove(hero, witch); if (a) return a; }
        return null;
      }

      // 4. Urgent: witch holds 2+
      if (witchNodeCount >= 2) {
        const a = tryMove(hero, _bestNodeForHero(sim, hero, claimedNodes)); if (a) return a;
        for (const s of survivors) {
          if (_isOnNode(sim, s)) continue;
          const b = tryMove(s, _bestNodeForHero(sim, s, claimedNodes)); if (b) return b;
        }
      }

      // 5. Seek shelter for survivors; hero moves toward objectives at night
      const heroTile = sim.tiles.get(hexKey(hero.col, hero.row));
      if (heroTile && heroTile.type !== TileType.BUILDING) {
        // Hero not in building — advance toward a node or witch rather than shelter
        // (hero takes no night damage; survivors need shelter but hero does not)
        const nodeTarget = _bestNodeForHero(sim, hero, claimedNodes);
        if (nodeTarget) { const a = tryMove(hero, nodeTarget); if (a) return a; }
        if (witch) { const a = tryMove(hero, witch); if (a) return a; }
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
      if (heroTN && heroTN.type === TileType.BUILDING && !sim.isExplored(hero.col, hero.row)) {
        return { type: PlanActionType.EXPLORE, entityId: hero.id };
      }
      // 7b. Fortify sheltered building (spare night budget — defensive investment)
      if (heroTN && heroTN.type === TileType.BUILDING) {
        const fortLevel = heroTN.fortifyLevel || 0;
        const shared = sim.inventory.shared;
        const hasWood  = (shared[ResourceType.WOOD]  || 0) > 0;
        const hasMetal = (shared[ResourceType.METAL] || 0) > 0;
        if (fortLevel < 2 && (hasWood || hasMetal)) {
          return { type: PlanActionType.FORTIFY, entityId: hero.id };
        }
      }
      // 8. Hero can move at night without hazard — advance toward witch-held nodes
      { const a = tryMove(hero, _bestNodeForHero(sim, hero)); if (a) return a; }
      // 9. Or move toward witch if close enough
      if (witch && hexDistance(hero.col, hero.row, witch.col, witch.row) <= 4) {
        const a = tryMove(hero, witch); if (a) return a;
      }
      return null;
    }

    // ── DAY strategy ──────────────────────────────────────────────────────────

    // 2. Fight co-located
    const col = sim.entities.find(e => e.alive && e.owner === 'witch' && e.col === hero.col && e.row === hero.row);
    if (col) return tryBattle(hero, col);

    // 3. Fight adjacent witch — prioritise the witch herself
    const adjW = sim.entities.find(e => e.alive && e.type === EntityType.WITCH && hexDistance(hero.col, hero.row, e.col, e.row) === 1)
      ?? sim.entities.find(e => e.alive && e.owner === 'witch' && hexDistance(hero.col, hero.row, e.col, e.row) === 1)
      ?? null;
    if (adjW) return tryBattle(hero, adjW);

    // 4. Survivors fight
    for (const s of survivors) {
      const sc = sim.entities.find(e => e.alive && e.owner === 'witch' && e.col === s.col && e.row === s.row);
      if (sc) return tryBattle(s, sc);
      const sa = sim.entities.find(e => e.alive && e.owner === 'witch' && hexDistance(s.col, s.row, e.col, e.row) === 1);
      if (sa) return tryBattle(s, sa);
    }

    // 5. Explore current building before moving out (find survivors + loot early)
    const heroTile = sim.tiles.get(hexKey(hero.col, hero.row));
    if (heroTile && heroTile.type === TileType.BUILDING && !sim.isExplored(hero.col, hero.row)) {
      return { type: PlanActionType.EXPLORE, entityId: hero.id };
    }

    // 5b. Fortify undefended building before moving out (quick one-time setup)
    if (heroTile && heroTile.type === TileType.BUILDING) {
      const fortLevel = heroTile.fortifyLevel || 0;
      const shared = sim.inventory.shared;
      const hasWood  = (shared[ResourceType.WOOD]  || 0) > 0;
      const hasMetal = (shared[ResourceType.METAL] || 0) > 0;
      if (fortLevel === 0 && (hasWood || hasMetal)) {
        return { type: PlanActionType.FORTIFY, entityId: hero.id };
      }
    }

    // 6. Hold node: fight threats, dispatch survivors to other nodes, then pursue witch
    if (heroOnNode) {
      const thrD = sim.entities.find(e => e.alive && e.owner === 'witch' && hexDistance(hero.col, hero.row, e.col, e.row) === 1);
      if (thrD) return tryBattle(hero, thrD);
      const undef = _undefendedNodes(sim, hero);
      for (const s of survivors) {
        if (_isOnNode(sim, s)) continue;
        if (undef.length) {
          const sorted = [...undef].sort((a, b) => hexDistance(s.col, s.row, a.col, a.row) - hexDistance(s.col, s.row, b.col, b.row));
          const a = tryMove(s, sorted[0]); if (a) return a;
        }
      }
      // Spare budget on a held node: pursue witch (hero doesn't leave the node in the real sense —
      // she'll keep progressing toward the witch each turn while the node scores points).
      if (witch) { const a = tryMove(hero, witch); if (a) return a; }
      return null; // node is held; end plan here
    }

    // 7. Urgent: witch holds 2+
    if (witchNodeCount >= 2) {
      const a = tryMove(hero, _bestNodeForHero(sim, hero, claimedNodes)); if (a) return a;
      for (const s of survivors) {
        if (_isOnNode(sim, s)) continue;
        const b = tryMove(s, _bestNodeForHero(sim, s, claimedNodes)); if (b) return b;
      }
    }

    // 8. Pursue witch aggressively when she's close (within 3 hexes) — force combat
    if (witch) {
      const distToWitch = hexDistance(hero.col, hero.row, witch.col, witch.row);
      if (distToWitch <= 3) {
        const a = tryMove(hero, witch); if (a) return a;
      }
    }

    // 9. Move toward nearest node
    { const a = tryMove(hero, _bestNodeForHero(sim, hero, claimedNodes)); if (a) return a; }

    // 10. Anchor survivors to nodes
    for (const s of survivors) {
      if (_isOnNode(sim, s)) continue;
      const a = tryMove(s, _bestNodeForHero(sim, s, claimedNodes)); if (a) return a;
    }

    // 11. Hunt the witch (kill wins the game; prefer this over building exploration)
    if (witch) { const a = tryMove(hero, witch); if (a) return a; }

    // 12. Move toward nearest unexplored building (recruit survivors + loot)
    //     Only when witch isn't ahead on nodes — exploration can wait in a contested game
    if (witchNodeCount < 2) {
      const a = tryMove(hero, _nearestUnexploredBuilding(sim, hero)); if (a) return a;
    }

    return null;
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _nearestUnexploredBuilding(state, actor) {
  let best = null, bestDist = Infinity;
  for (const [, t] of state.tiles) {
    if (t.type !== TileType.BUILDING) continue;
    const explored = state.isExplored ? state.isExplored(t.col, t.row) : t.explored;
    if (explored) continue;
    const d = hexDistance(actor.col, actor.row, t.col, t.row);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  return best;
}

// Nodes not currently defended by any hero unit (excluding the holding actor itself).
function _undefendedNodes(state, holder) {
  return state.witchObjectives.filter(obj =>
    !obj.hexes.some(h => h.col === holder.col && h.row === holder.row) &&
    !state.entities.some(e => e.alive && e.owner === 'hero' &&
      obj.hexes.some(h => h.col === e.col && h.row === e.row))
  );
}

// Best node target for a hero unit: neutral first, then witch-controlled to contest.
// Returns the nearest cluster hex to the actor.
// Excludes the node the actor just departed (prevents oscillation in planning sim).
// claimedNodes (optional Set<"col,row">) — nodes already targeted by allied AI players;
//   the chosen objective's hexes are added to this set so subsequent allies pick differently.
function _bestNodeForHero(state, actor, claimedNodes = null) {
  const justLeft = state._justLeft && state._justLeft[actor.id];
  const notJustLeft = obj => !(justLeft && justLeft.col === obj.col && justLeft.row === obj.row);
  const notClaimed  = obj => !claimedNodes || !obj.hexes.some(h => claimedNodes.has(hexKey(h.col, h.row)));

  const neutral = state.witchObjectives.filter(obj =>
    nodeController(obj, state.entities) === 'neutral' && notJustLeft(obj) && notClaimed(obj)
  );
  if (neutral.length) {
    neutral.sort((a, b) =>
      hexDistance(actor.col, actor.row, a.col, a.row) -
      hexDistance(actor.col, actor.row, b.col, b.row)
    );
    const chosen = neutral[0];
    if (claimedNodes) chosen.hexes.forEach(h => claimedNodes.add(hexKey(h.col, h.row)));
    return _nearestClusterHex(actor, chosen);
  }
  const witchHeld = state.witchObjectives.filter(obj =>
    nodeController(obj, state.entities) === 'witch' && notJustLeft(obj) && notClaimed(obj)
  );
  if (witchHeld.length) {
    witchHeld.sort((a, b) =>
      hexDistance(actor.col, actor.row, a.col, a.row) -
      hexDistance(actor.col, actor.row, b.col, b.row)
    );
    const chosen = witchHeld[0];
    if (claimedNodes) chosen.hexes.forEach(h => claimedNodes.add(hexKey(h.col, h.row)));
    return _nearestClusterHex(actor, chosen);
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
  constructor(realState, faction, playerId = null) {
    this.tiles            = realState.tiles;          // read-only reference
    this.phase            = realState.phase;
    this.witchObjectives  = realState.witchObjectives;
    this.nodeScore        = realState.nodeScore;
    this.fogOfWar         = realState.fogOfWar;
    this.inventory        = JSON.parse(JSON.stringify(realState.inventory));

    // Shallow-copy live entities so position tracking works without mutating the real state.
    // NOTE: Entity.alive is a getter (hp > 0) and is NOT included in spread. We must add it
    // explicitly so that e.alive checks in _decidePlanAction work on the copied objects.
    this.entities = realState.entities
      .filter(e => e.alive)
      .map(e => ({ ...e, alive: true }));

    if (playerId) {
      // Multiplayer: scope leader ref and budget to this specific player.
      // sim.hero / sim.witch serve two roles:
      //   • The faction that matches the player → their own leader (the actor)
      //   • The opposite faction → the nearest enemy leader (for flee/hunt distance checks)
      // Without an enemy leader reference, flee and hunt logic silently no-ops.
      const leaderType = faction === 'hero' ? EntityType.HERO  : EntityType.WITCH;
      const enemyType  = faction === 'hero' ? EntityType.WITCH : EntityType.HERO;
      const leader = this.entities.find(e => e.type === leaderType && e.ownerId === playerId) ?? null;
      // Nearest enemy leader (fallback: any enemy leader)
      const enemyLeader = leader
        ? (this.entities
            .filter(e => e.type === enemyType && e.alive)
            .sort((a, b) =>
              hexDistance(a.col, a.row, leader.col, leader.row) -
              hexDistance(b.col, b.row, leader.col, leader.row))[0] ?? null)
        : (this.entities.find(e => e.type === enemyType) ?? null);
      this.hero  = faction === 'hero'  ? leader : enemyLeader;
      this.witch = faction === 'witch' ? leader : enemyLeader;
      this.actionsLeft = computeActionsForPlayer(playerId, faction, realState.phase, this.entities);
    } else {
      // Offline / legacy: use first entity of each type, faction-level budget
      this.hero  = this.entities.find(e => e.type === EntityType.HERO)  ?? null;
      this.witch = this.entities.find(e => e.type === EntityType.WITCH) ?? null;
      this.actionsLeft = computeActions(
        faction === 'hero' ? Player.HERO : Player.WITCH,
        realState.phase,
        this.entities,
      );
    }
    this._faction = faction;

    // Track hexes already planned for exploration this turn so we don't
    // plan duplicate explores (sim.tiles.explored is a live reference and
    // won't reflect in-plan explores).
    this._explored = new Set();

    // Track nodes each entity just departed so they aren't immediately re-targeted.
    this._justLeft = {}; // entityId → { col, row }
  }

  isExplored(col, row) {
    const t = this.tiles.get(hexKey(col, row));
    return this._explored.has(hexKey(col, row)) || (t && t.explored);
  }

  applyMove(entityId, toCol, toRow) {
    const e = this.entities.find(e => e.id === entityId);
    if (e) {
      // Track node departure to prevent oscillation (re-targeting the just-departed node)
      const wasOnNode = this.witchObjectives.some(obj => obj.col === e.col && obj.row === e.row);
      if (wasOnNode) this._justLeft[entityId] = { col: e.col, row: e.row };
      e.col = toCol; e.row = toRow;
    }
    this.actionsLeft--;
  }

  applyBattle() {
    this.actionsLeft--;
  }

  applyExplore(entityId) {
    const e = this.entities.find(e => e.id === entityId);
    if (e) this._explored.add(hexKey(e.col, e.row));
    this.actionsLeft--;
  }

  applySummon(toCol, toRow) {
    this.entities.push({
      id: `sim-${this.entities.length}`,
      type: EntityType.MINION, owner: 'witch',
      col: toCol, row: toRow, alive: true, hp: 2,
    });
    // Spend 2 resources from witch inventory (drain largest stacks first)
    const inv = this.inventory.witch;
    const keys = Object.keys(inv).filter(k => inv[k] > 0).sort((a, b) => inv[b] - inv[a]);
    let remaining = 2;
    for (const k of keys) {
      const spend = Math.min(inv[k], remaining);
      inv[k] -= spend;
      remaining -= spend;
      if (remaining === 0) break;
    }
    this.actionsLeft--;
  }
}

// ── AI Personality variants ────────────────────────────────────────────────────
// Each subclass overrides only _decidePlanAction(sim); generatePlan() and all
// async takeTurn() logic are inherited unchanged.
//
// Hero personalities
//   Berserker  — ignore nodes, hunt the witch to the death
//   Sentinel   — race to a node and never leave, dispatch survivors to others
//   Scavenger  — loot all buildings first, fight only when healthy
//
// Witch personalities
//   Berserker  — ignore nodes, kill the hero; tiny escort army only
//   Hoarder    — build a 10-unit golem army before pushing any node
//   Swarm      — flood all three nodes with disposable minions; witch never fights

// ── Shared inline helpers (same logic as module-level helpers above) ──────────

function _makeHelpers(sim) {
  const tryMove = (entity, target) => {
    if (!target) return null;
    const step = stepToward(sim, entity, target);
    if (step) return { type: PlanActionType.MOVE, entityId: entity.id, toCol: step.col, toRow: step.row };
    return null;
  };
  const tryBattle = (actor, target) =>
    ({ type: PlanActionType.BATTLE_UNIT, entityId: actor.id, targetId: target.id });
  const trySummon = (witch, minions, cap = 8) => {
    if (minions.length >= cap) return null;
    const inv = sim.inventory.witch;
    if (Object.values(inv).reduce((s, v) => s + v, 0) < 2) return null;
    const hex = getNeighbors(witch.col, witch.row).find(n => {
      const t = sim.tiles.get(hexKey(n.col, n.row));
      return t && t.type !== TileType.RIVER &&
        !sim.entities.some(e => e.alive && e.col === n.col && e.row === n.row);
    });
    if (!hex) return null;
    return { type: PlanActionType.SUMMON, entityId: witch.id, toCol: hex.col, toRow: hex.row };
  };
  return { tryMove, tryBattle, trySummon };
}

// ── Hero: Berserker ───────────────────────────────────────────────────────────
// Chase the witch at all costs. Fight at every range, even at night.
// Only cares about nodes when the hero faction is one checkpoint from losing.

export class HeroBerserker extends HeroAI {
  _decidePlanAction(sim) {
    const hero = sim.hero;
    if (!hero) return null;
    const { tryMove, tryBattle } = _makeHelpers(sim);
    const witch     = sim.witch;
    const survivors = sim.entities.filter(e => e.alive && e.owner === 'hero' && e.type === EntityType.SURVIVOR);
    const witchNodeCount = sim.witchObjectives.filter(obj =>
      sim.entities.some(e => e.alive && e.owner === 'witch' && e.col === obj.col && e.row === obj.row)
    ).length;

    // Herbs only when nearly dead (don't waste a free action on minor wounds)
    const herbs = (hero.items?.[ResourceType.HERBS]) || 0;
    if (herbs > 0 && hero.hp <= 3) return { type: PlanActionType.USE_ITEM, entityId: hero.id, item: ResourceType.HERBS };

    // Fight co-located
    const col = sim.entities.find(e => e.alive && e.owner === 'witch' && e.col === hero.col && e.row === hero.row);
    if (col) return tryBattle(hero, col);

    // Fight adjacent — witch first
    const adj = [
      sim.entities.find(e => e.alive && e.type === EntityType.WITCH && hexDistance(hero.col, hero.row, e.col, e.row) === 1),
      sim.entities.find(e => e.alive && e.owner === 'witch' && hexDistance(hero.col, hero.row, e.col, e.row) === 1),
    ].find(Boolean);
    if (adj) return tryBattle(hero, adj);

    // Survivors fight anything adjacent
    for (const s of survivors) {
      const sc = sim.entities.find(e => e.alive && e.owner === 'witch' && e.col === s.col && e.row === s.row);
      if (sc) return tryBattle(s, sc);
      const sa = sim.entities.find(e => e.alive && e.owner === 'witch' && hexDistance(s.col, s.row, e.col, e.row) === 1);
      if (sa) return tryBattle(s, sa);
    }

    // Emergency node race (hero score almost lost)
    if (witchNodeCount >= 2) { const a = tryMove(hero, _bestNodeForHero(sim, hero, this._allyContext?.claimedNodes)); if (a) return a; }

    // Always charge toward the witch — day AND night
    if (witch) { const a = tryMove(hero, witch); if (a) return a; }

    // Survivors anchor nodes passively
    for (const s of survivors) {
      if (_isOnNode(sim, s)) continue;
      const a = tryMove(s, _bestNodeForHero(sim, s, this._allyContext?.claimedNodes)); if (a) return a;
    }
    return null;
  }
}

// ── Hero: Sentinel ────────────────────────────────────────────────────────────
// Sprint to the nearest node and entrench. Never leave voluntarily.
// Sends every survivor to defend a different node. Explore only on the node tile.

export class HeroSentinel extends HeroAI {
  _decidePlanAction(sim) {
    const hero = sim.hero;
    if (!hero) return null;
    const { tryMove, tryBattle } = _makeHelpers(sim);
    const survivors  = sim.entities.filter(e => e.alive && e.owner === 'hero' && e.type === EntityType.SURVIVOR);
    const heroOnNode = _isOnNode(sim, hero);

    // Herbs always
    const herbs = (hero.items?.[ResourceType.HERBS]) || 0;
    if (herbs > 0 && hero.hp < hero.maxHp) return { type: PlanActionType.USE_ITEM, entityId: hero.id, item: ResourceType.HERBS };

    // Fight co-located threats (can't share a hex)
    const col = sim.entities.find(e => e.alive && e.owner === 'witch' && e.col === hero.col && e.row === hero.row);
    if (col) return tryBattle(hero, col);
    for (const s of survivors) {
      const sc = sim.entities.find(e => e.alive && e.owner === 'witch' && e.col === s.col && e.row === s.row);
      if (sc) return tryBattle(s, sc);
    }

    // Not on a node yet → race there
    if (!heroOnNode) { const a = tryMove(hero, _bestNodeForHero(sim, hero, this._allyContext?.claimedNodes)); if (a) return a; }

    // On a node → defend it, dispatch survivors, explore, then hold
    if (heroOnNode) {
      const adj = sim.entities.find(e => e.alive && e.owner === 'witch' && hexDistance(hero.col, hero.row, e.col, e.row) === 1);
      if (adj) return tryBattle(hero, adj);

      const undefended = _undefendedNodes(sim, hero);
      for (const s of survivors) {
        if (_isOnNode(sim, s)) continue;
        const sorted = [...undefended].sort((a, b) =>
          hexDistance(s.col, s.row, a.col, a.row) - hexDistance(s.col, s.row, b.col, b.row));
        if (sorted.length) { const a = tryMove(s, sorted[0]); if (a) return a; }
      }
      if (!sim.isExplored(hero.col, hero.row)) return { type: PlanActionType.EXPLORE, entityId: hero.id };
      return null; // hold the node
    }

    // Survivors toward nodes
    for (const s of survivors) {
      if (_isOnNode(sim, s)) continue;
      const a = tryMove(s, _bestNodeForHero(sim, s, this._allyContext?.claimedNodes)); if (a) return a;
    }
    return null;
  }
}

// ── Hero: Scavenger ───────────────────────────────────────────────────────────
// Loot all buildings before engaging. Fights only when forced or fully healthy.
// Builds a large survivor army, then pivots to nodes once resources are secured.

export class HeroScavenger extends HeroAI {
  _decidePlanAction(sim) {
    const hero = sim.hero;
    if (!hero) return null;
    const { tryMove, tryBattle } = _makeHelpers(sim);
    const survivors = sim.entities.filter(e => e.alive && e.owner === 'hero' && e.type === EntityType.SURVIVOR);
    const witchNodeCount = sim.witchObjectives.filter(obj =>
      sim.entities.some(e => e.alive && e.owner === 'witch' && e.col === obj.col && e.row === obj.row)
    ).length;

    // Herbs — eagerly heal
    const herbs = (hero.items?.[ResourceType.HERBS]) || 0;
    if (herbs > 0 && hero.hp < hero.maxHp) return { type: PlanActionType.USE_ITEM, entityId: hero.id, item: ResourceType.HERBS };

    // Must fight co-located
    const col = sim.entities.find(e => e.alive && e.owner === 'witch' && e.col === hero.col && e.row === hero.row);
    if (col) return tryBattle(hero, col);

    // Fight adjacent only if above half HP
    if (hero.hp > hero.maxHp * 0.5) {
      const adj = [
        sim.entities.find(e => e.alive && e.type === EntityType.WITCH && hexDistance(hero.col, hero.row, e.col, e.row) === 1),
        sim.entities.find(e => e.alive && e.owner === 'witch' && hexDistance(hero.col, hero.row, e.col, e.row) === 1),
      ].find(Boolean);
      if (adj) return tryBattle(hero, adj);
    }
    for (const s of survivors) {
      const sc = sim.entities.find(e => e.alive && e.owner === 'witch' && e.col === s.col && e.row === s.row);
      if (sc) return tryBattle(s, sc);
    }

    // Emergency: witch about to win
    if (witchNodeCount >= 2) { const a = tryMove(hero, _bestNodeForHero(sim, hero, this._allyContext?.claimedNodes)); if (a) return a; }

    // Explore current tile (buildings and terrain)
    if (!sim.isExplored(hero.col, hero.row)) return { type: PlanActionType.EXPLORE, entityId: hero.id };

    // Move toward nearest unexplored building
    const bldg = _nearestUnexploredBuilding(sim, hero);
    if (bldg) { const a = tryMove(hero, bldg); if (a) return a; }

    // Buildings exhausted — pivot to nodes
    { const a = tryMove(hero, _bestNodeForHero(sim, hero, this._allyContext?.claimedNodes)); if (a) return a; }
    for (const s of survivors) {
      if (_isOnNode(sim, s)) continue;
      const a = tryMove(s, _bestNodeForHero(sim, s, this._allyContext?.claimedNodes)); if (a) return a;
    }
    return null;
  }
}

// ── Witch: Berserker ──────────────────────────────────────────────────────────
// Ignore nodes; hunt and kill the hero. Tiny 2-unit escort. No retreat.

export class WitchBerserker extends WitchAI {
  _decidePlanAction(sim) {
    const witch = sim.witch;
    if (!witch) return null;
    const { tryMove, tryBattle, trySummon } = _makeHelpers(sim);
    const hero    = sim.hero;
    const minions = sim.entities.filter(e => e.alive && e.owner === 'witch' && e.type !== EntityType.WITCH);
    const heroScore = sim.nodeScore.hero;

    // Fight co-located
    const col = sim.entities.find(e => e.alive && e.owner === 'hero' && e.col === witch.col && e.row === witch.row);
    if (col) return tryBattle(witch, col);

    // Fight adjacent — hero first
    const adj = [
      sim.entities.find(e => e.alive && e.type === EntityType.HERO && hexDistance(witch.col, witch.row, e.col, e.row) === 1),
      sim.entities.find(e => e.alive && e.owner === 'hero' && hexDistance(witch.col, witch.row, e.col, e.row) === 1),
    ].find(Boolean);
    if (adj) return tryBattle(witch, adj);

    // Minions fight anything within reach
    for (const m of minions) {
      const mc = sim.entities.find(e => e.alive && e.owner === 'hero' && e.col === m.col && e.row === m.row);
      if (mc) return tryBattle(m, mc);
      const ma = sim.entities.find(e => e.alive && e.owner === 'hero' && hexDistance(m.col, m.row, e.col, e.row) === 1);
      if (ma) return tryBattle(m, ma);
    }

    // Tiny escort only (2 minions max)
    const escort = trySummon(witch, minions, 2); if (escort) return escort;

    // Emergency node only if hero is about to score-win
    if (heroScore >= 2) {
      if (!_isOnNode(sim, witch)) { const a = tryMove(witch, _bestWitchObjective(sim, witch, this._allyContext?.claimedNodes)); if (a) return a; }
    }

    // Always charge toward hero (day and night)
    if (hero) { const a = tryMove(witch, hero); if (a) return a; }
    // Minions also charge hero
    for (const m of minions) { if (hero) { const a = tryMove(m, hero); if (a) return a; } }
    return null;
  }
}

// ── Witch: Hoarder ────────────────────────────────────────────────────────────
// Spend early rounds building a maximum army via exploration and summons.
// Only pushes nodes once army reaches 5+ units. High flee threshold.

export class WitchHoarder extends WitchAI {
  _decidePlanAction(sim) {
    const witch = sim.witch;
    if (!witch) return null;
    const { tryMove, tryBattle, trySummon } = _makeHelpers(sim);
    const hero      = sim.hero;
    const minions   = sim.entities.filter(e => e.alive && e.owner === 'witch' && e.type !== EntityType.WITCH);
    const realMinions = minions.filter(m => !m.id.startsWith('sim-'));
    const heroScore = sim.nodeScore.hero;

    // Flee if low HP (more cautious than default)
    if (hero && hexDistance(witch.col, witch.row, hero.col, hero.row) <= 2 &&
        witch.hp <= Math.ceil(witch.maxHp * 0.4)) {
      const step = stepAwayFrom(sim, witch, hero);
      if (step) return { type: PlanActionType.MOVE, entityId: witch.id, toCol: step.col, toRow: step.row };
    }

    // Must fight co-located
    const col = sim.entities.find(e => e.alive && e.owner === 'hero' && e.col === witch.col && e.row === witch.row);
    if (col) return tryBattle(witch, col);

    // Emergency: hero about to win
    if (heroScore >= 2) {
      if (!_isOnNode(sim, witch)) { const a = tryMove(witch, _bestWitchObjective(sim, witch, this._allyContext?.claimedNodes)); if (a) return a; }
    }

    // Always try to summon if under army cap
    const summon = trySummon(witch, minions, 10); if (summon) return summon;

    // Explore to gather more resources for summons
    if (minions.length < 5) {
      if (!sim.isExplored(witch.col, witch.row)) return { type: PlanActionType.EXPLORE, entityId: witch.id };
      const unexpAdj = getNeighbors(witch.col, witch.row).find(n => {
        const t = sim.tiles.get(hexKey(n.col, n.row));
        return t && !sim.isExplored(t.col, t.row) &&
          (t.hiddenSurvivor || t.resource || t.building) && t.type !== TileType.RIVER;
      });
      if (unexpAdj) return { type: PlanActionType.MOVE, entityId: witch.id, toCol: unexpAdj.col, toRow: unexpAdj.row };
    }

    // Army ready — flood nodes
    if (!_isOnNode(sim, witch)) { const a = tryMove(witch, _bestWitchObjective(sim, witch, this._allyContext?.claimedNodes)); if (a) return a; }
    for (const m of realMinions) {
      if (_isOnNode(sim, m)) continue;
      const a = tryMove(m, _bestWitchObjective(sim, m, this._allyContext?.claimedNodes)); if (a) return a;
    }
    if (_isOnNode(sim, witch)) return null; // hold

    // Fallback explore
    if (!sim.isExplored(witch.col, witch.row)) return { type: PlanActionType.EXPLORE, entityId: witch.id };
    { const a = tryMove(witch, _bestWitchObjective(sim, witch, this._allyContext?.claimedNodes)); if (a) return a; }
    return null;
  }
}

// ── Witch: Swarm ──────────────────────────────────────────────────────────────
// Flood all three nodes with disposable minions (cap 12).
// The witch herself never fights — she stays back to summon and gather resources.

export class WitchSwarm extends WitchAI {
  _decidePlanAction(sim) {
    const witch = sim.witch;
    if (!witch) return null;
    const { tryMove, tryBattle, trySummon } = _makeHelpers(sim);
    const hero      = sim.hero;
    const minions   = sim.entities.filter(e => e.alive && e.owner === 'witch' && e.type !== EntityType.WITCH);
    const realMinions = minions.filter(m => !m.id.startsWith('sim-'));

    // Witch always flees from hero to keep summoning
    if (hero && hexDistance(witch.col, witch.row, hero.col, hero.row) <= 2) {
      const step = stepAwayFrom(sim, witch, hero);
      if (step) return { type: PlanActionType.MOVE, entityId: witch.id, toCol: step.col, toRow: step.row };
    }

    // Must fight co-located (no choice)
    const col = sim.entities.find(e => e.alive && e.owner === 'hero' && e.col === witch.col && e.row === witch.row);
    if (col) return tryBattle(witch, col);

    // Minions fight anything they land on
    for (const m of realMinions) {
      const mc = sim.entities.find(e => e.alive && e.owner === 'hero' && e.col === m.col && e.row === m.row);
      if (mc) return tryBattle(m, mc);
    }

    // Summon aggressively (high cap, witch never personally attacks)
    const summon = trySummon(witch, minions, 12); if (summon) return summon;

    // Flood all minions toward uncovered nodes
    for (const m of realMinions) {
      if (_isOnNode(sim, m)) continue;
      const obj = _bestWitchObjective(sim, m, this._allyContext?.claimedNodes);
      if (obj) { const a = tryMove(m, obj); if (a) return a; }
    }

    // Witch gathers resources while staying back
    if (!sim.isExplored(witch.col, witch.row)) return { type: PlanActionType.EXPLORE, entityId: witch.id };
    const unexpAdj = getNeighbors(witch.col, witch.row).find(n => {
      const t = sim.tiles.get(hexKey(n.col, n.row));
      return t && !sim.isExplored(t.col, t.row) &&
        (t.hiddenSurvivor || t.resource || t.building) && t.type !== TileType.RIVER;
    });
    if (unexpAdj) return { type: PlanActionType.MOVE, entityId: witch.id, toCol: unexpAdj.col, toRow: unexpAdj.row };

    // Keep witch near a safe node (last resort movement)
    { const a = tryMove(witch, _bestWitchObjective(sim, witch, this._allyContext?.claimedNodes)); if (a) return a; }
    return null;
  }
}

// ── Personality registry ──────────────────────────────────────────────────────

export const HERO_PERSONALITIES = {
  balanced:   HeroAI,
  berserker:  HeroBerserker,
  sentinel:   HeroSentinel,
  scavenger:  HeroScavenger,
};

export const WITCH_PERSONALITIES = {
  balanced:  WitchAI,
  berserker: WitchBerserker,
  hoarder:   WitchHoarder,
  swarm:     WitchSwarm,
};
