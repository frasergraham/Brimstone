// AI controllers — WitchAI and HeroAI
// Both use a weight-based priority system that shifts based on the day/night phase.
import { getNeighbors, hexDistance, hexKey } from './hex.js';
import { TileType, ResourceType } from './tiles.js';
import { EntityType } from './entities.js';
import { Phase } from './game.js';
import {
  executeMove, executeExplore, executeBattle, executeSummon, executeUseItem,
} from './actions.js';

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

    while (state.actionsAvailable > 0 && !state.gameOver) {
      await this._think();
      const acted = await this._chooseAction();
      if (!acted) break;
      this.onStateChange();
      await delay(this.thinkDelay);
    }

    state.endTurn();
    this.onStateChange();
    this._running = false;
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
    const isDay   = phase === Phase.DAY  || phase === Phase.DAWN;
    const isNight = phase === Phase.NIGHT || phase === Phase.DUSK;

    const minions = state.entities.filter(
      e => e.alive && e.owner === 'witch' && e.type !== EntityType.WITCH
    );

    // ── NIGHT STRATEGY ─────────────────────────────────────────────────────
    // Priority: attack, seize objectives, summon reinforcements
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

      // 2. Fight adjacent hero units if witch is strong or it's a good fight
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

      // 4. Summon more troops if resources available and army is small
      if (await this._trySummon(witch, minions.length)) return true;

      // 5. Witch moves toward best objective (unclaimed first, then hero-held to contest)
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

      // 6. Move minions toward objectives; minions already on a node hold position
      for (const m of minions) {
        if (_isOnNode(state, m)) continue; // hold the node
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
        const heroUnits = state.entities.filter(e => e.alive && e.owner === 'hero');
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

      // 7. Move witch toward hero if no unclaimed objective
      const witchTarget = state.hero;
      const step = stepToward(state, witch, witchTarget);
      if (step) {
        const result = executeMove(state, witch, step.col, step.row);
        logResult(state, result);
        state.spendAction(result.cost);
        return true;
      }

      return false;
    }

    // ── DAY STRATEGY ──────────────────────────────────────────────────────
    // Priority: survive; shelter minions; explore for resources; seize nodes

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

    // 1. Move exposed minions into buildings to avoid day damage (skip minions holding nodes)
    for (const m of minions) {
      if (_isOnNode(state, m)) continue; // stay on the node even if exposed
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

    // 2. Witch moves toward best objective (unclaimed first, then hero-held to contest)
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

    // 3. Summon if resources allow (build the army during daytime)
    if (await this._trySummon(witch, minions.length)) return true;

    // 4. Witch explores current tile if unexplored (gather resources safely)
    const witchTile = state.tiles.get(hexKey(witch.col, witch.row));
    if (witchTile && !witchTile.explored) {
      const result = executeExplore(state, witch);
      logResult(state, result);
      state.spendAction(result.cost);
      return true;
    }

    // 5. Move to adjacent unexplored building/resource tile (stay stealthy)
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

    return false;
  }

  async _trySummon(witch, minionCount) {
    const state = this.state;
    const inv = state.inventory.witch;
    const totalRes = Object.values(inv).reduce((s, v) => s + v, 0);
    // Limit army size more conservatively during day, more aggressively at night
    const cap = (state.phase === Phase.NIGHT || state.phase === Phase.DUSK) ? 6 : 4;
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

    while (state.actionsAvailable > 0 && !state.gameOver) {
      await delay(this.thinkDelay * 0.5);
      const acted = await this._chooseAction();
      if (!acted) break;
      this.onStateChange();
      await delay(this.thinkDelay);
    }

    state.endTurn();
    this.onStateChange();
    this._running = false;
  }

  async _executeBattleWithUI(actor, target) {
    const actorSnap  = _snapEntity(actor);
    const targetSnap = _snapEntity(target);
    const result = executeBattle(this.state, actor, target);
    for (const msg of result.log) this.state.addLog(msg);
    this.state.spendAction(result.cost);
    if (this.onBattleResult) {
      await this.onBattleResult(actorSnap, targetSnap, result);
    }
    return true;
  }

  async _chooseAction() {
    const state  = this.state;
    const hero   = state.hero;
    const phase  = state.phase;
    const isDay  = phase === Phase.DAY || phase === Phase.DAWN;
    const isNight = phase === Phase.NIGHT || phase === Phase.DUSK;

    const survivors = state.entities.filter(
      e => e.alive && e.owner === 'hero' && e.type === EntityType.SURVIVOR
    );

    // ── NIGHT STRATEGY ─────────────────────────────────────────────────────
    // Get all units into buildings. Only fight if cornered.
    if (isNight) {
      // 1. Heal if badly hurt
      if (await this._tryHeal(hero)) return true;

      // 2. Hero seeks shelter
      if (!inBuilding(state, hero)) {
        const shelter = nearestBuilding(state, hero);
        if (shelter) {
          const step = stepToward(state, hero, shelter);
          if (step) {
            const result = executeMove(state, hero, step.col, step.row);
            for (const msg of result.log) state.addLog(msg);
            state.spendAction(result.cost);
            return true;
          }
        }
      }

      // 3. Survivors shelter too (survivors take night damage in the open)
      for (const s of survivors) {
        if (!inBuilding(state, s)) {
          const shelter = nearestBuilding(state, s);
          if (shelter) {
            const step = stepToward(state, s, shelter);
            if (step && !state.entities.some(e => e.alive && e.owner === 'witch' && e.col === step.col && e.row === step.row)) {
              const result = executeMove(state, s, step.col, step.row);
              for (const msg of result.log) state.addLog(msg);
              state.spendAction(result.cost);
              return true;
            }
          }
        }
      }

      // 4. Fight co-located enemies only if sheltered and forced to
      const colocated = state.entities.find(
        e => e.alive && e.owner === 'witch' && e.col === hero.col && e.row === hero.row
      );
      if (colocated) return this._executeBattleWithUI(hero, colocated);

      // 5. Explore current building if sheltered and unexplored
      const heroTile = state.tiles.get(hexKey(hero.col, hero.row));
      if (heroTile && heroTile.type === TileType.BUILDING && !heroTile.explored) {
        const result = executeExplore(state, hero);
        for (const msg of result.log) state.addLog(msg);
        state.spendAction(result.cost);
        return result.success;
      }

      return false;
    }

    // ── DAY STRATEGY ──────────────────────────────────────────────────────
    // Aggressive exploration, survivor recruitment, node contesting, witch hunting

    // 1. Heal if injured
    if (await this._tryHeal(hero)) return true;

    // 2. Fight co-located witch units (free attacks when co-located)
    const colocated = state.entities.find(
      e => e.alive && e.owner === 'witch' && e.col === hero.col && e.row === hero.row
    );
    if (colocated) return this._executeBattleWithUI(hero, colocated);

    // 3. Fight adjacent witch units — prioritise the witch herself
    const adjWitchFirst = [
      state.entities.find(e => e.alive && e.type === EntityType.WITCH && hexDistance(hero.col, hero.row, e.col, e.row) === 1),
      state.entities.find(e => e.alive && e.owner === 'witch' && hexDistance(hero.col, hero.row, e.col, e.row) === 1),
    ].find(Boolean);
    if (adjWitchFirst) return this._executeBattleWithUI(hero, adjWitchFirst);

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

    // 5. Contest unclaimed power node (node victory is the primary win condition)
    const nodeTarget = _unclaimedNodeForHero(state, hero);
    if (nodeTarget) {
      const step = stepToward(state, hero, nodeTarget);
      if (step) {
        const result = executeMove(state, hero, step.col, step.row);
        for (const msg of result.log) state.addLog(msg);
        state.spendAction(result.cost);
        return true;
      }
    }

    // 6. Move survivors toward unclaimed nodes
    for (const s of survivors) {
      const sNodeTarget = _unclaimedNodeForHero(state, s);
      if (sNodeTarget) {
        const step = stepToward(state, s, sNodeTarget);
        if (step) {
          const result = executeMove(state, s, step.col, step.row);
          for (const msg of result.log) state.addLog(msg);
          state.spendAction(result.cost);
          return true;
        }
      }
    }

    // 7. Explore current building for loot
    const heroTile = state.tiles.get(hexKey(hero.col, hero.row));
    if (heroTile && heroTile.type === TileType.BUILDING && !heroTile.explored) {
      const result = executeExplore(state, hero);
      for (const msg of result.log) state.addLog(msg);
      state.spendAction(result.cost);
      return result.success;
    }

    // 8. Move toward nearest unexplored building (find survivors + loot)
    const unxBuilding = _nearestUnexploredBuilding(state, hero);
    if (unxBuilding) {
      const step = stepToward(state, hero, unxBuilding);
      if (step) {
        const result = executeMove(state, hero, step.col, step.row);
        for (const msg of result.log) state.addLog(msg);
        state.spendAction(result.cost);
        return true;
      }
    }

    // 9. Hunt the witch
    const step = stepToward(state, hero, state.witch);
    if (step) {
      const result = executeMove(state, hero, step.col, step.row);
      for (const msg of result.log) state.addLog(msg);
      state.spendAction(result.cost);
      return true;
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

// Returns the best node target for the hero: unclaimed first, then witch-held nodes to contest.
function _unclaimedNodeForHero(state, actor) {
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
