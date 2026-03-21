// AI controllers — WitchAI and HeroAI
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
    // Only log fog message for meaningful actions (not failed ones)
    if (result.success) fogLog(state);
  } else {
    for (const msg of result.log) state.addLog(msg);
  }
}

export class WitchAI {
  constructor(state, onStateChange) {
    this.state         = state;
    this.onStateChange = onStateChange;
    this.onBattleResult = null; // set by UI: async (actorSnap, targetSnap, result) => void
    this._running      = false;
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
      await delay(THINK_DELAY_MS);
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
    const witch = state.witch;

    // 1. Fight any hero unit co-located
    const colocatedEnemy = state.entities.find(
      e => e.alive && e.owner === 'hero' && e.col === witch.col && e.row === witch.row
    );
    if (colocatedEnemy) {
      return this._executeBattleWithUI(witch, colocatedEnemy);
    }

    // 2. Summon if resources available and army is small
    const inv = state.inventory.witch;
    const totalRes = Object.values(inv).reduce((s, v) => s + v, 0);
    const witchMinions = state.entities.filter(
      e => e.alive && e.owner === 'witch' && e.type !== EntityType.WITCH
    );
    if (totalRes > 0 && witchMinions.length < 4) {
      const spawnAdj = getNeighbors(witch.col, witch.row).find(n => {
        const t = state.tiles.get(hexKey(n.col, n.row));
        return t && t.type !== TileType.RIVER &&
          state.entities.filter(e => e.alive && e.col === n.col && e.row === n.row).length === 0;
      });
      if (spawnAdj) {
        const result = executeSummon(state, witch, spawnAdj.col, spawnAdj.row);
        logResult(state, result);
        state.spendAction(result.cost);
        return true;
      }
    }

    // 3. Explore current tile if unexplored
    const witchTile = state.tiles.get(hexKey(witch.col, witch.row));
    if (witchTile && !witchTile.explored) {
      const result = executeExplore(state, witch);
      logResult(state, result);
      state.spendAction(result.cost);
      return true;
    }

    // 4. Move to adjacent unexplored building/resource tile
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

    // 5. Activate each minion/golem — primary goal: hunt hero-side units
    const minions = state.entities.filter(
      e => e.alive && e.owner === 'witch' && e.type !== EntityType.WITCH
    );
    for (const minion of minions) {
      // Fight co-located hero-side unit
      const colocated = state.entities.find(
        e => e.alive && e.owner === 'hero' && e.col === minion.col && e.row === minion.row
      );
      if (colocated) {
        return this._executeBattleWithUI(minion, colocated);
      }
      // Fight any adjacent hero-side unit
      const adjHeroUnit = state.entities.find(
        e => e.alive && e.owner === 'hero' && hexDistance(minion.col, minion.row, e.col, e.row) === 1
      );
      if (adjHeroUnit) {
        return this._executeBattleWithUI(minion, adjHeroUnit);
      }
      // Move toward nearest hero-side unit
      const heroUnits = state.entities.filter(e => e.alive && e.owner === 'hero');
      if (heroUnits.length) {
        heroUnits.sort((a, b) =>
          hexDistance(minion.col, minion.row, a.col, a.row) -
          hexDistance(minion.col, minion.row, b.col, b.row)
        );
        const step = stepToward(state, minion, heroUnits[0]);
        if (step) {
          const result = executeMove(state, minion, step.col, step.row);
          logResult(state, result);
          state.spendAction(result.cost);
          return true;
        }
      }
      // Fallback: move toward nearest unclaimed objective
      const targetObj = _unoccupiedObjective(state, minion);
      if (targetObj) {
        const step = stepToward(state, minion, targetObj);
        if (step) {
          const result = executeMove(state, minion, step.col, step.row);
          logResult(state, result);
          state.spendAction(result.cost);
          return true;
        }
      }
    }

    // 6. Move witch toward nearest unclaimed objective or hero
    const witchTarget = _unoccupiedObjective(state, witch) || state.hero;
    const step = stepToward(state, witch, witchTarget);
    if (step) {
      const result = executeMove(state, witch, step.col, step.row);
      logResult(state, result);
      state.spendAction(result.cost);
      return true;
    }

    return false;
  }

  async _think() {
    await delay(THINK_DELAY_MS * 0.5);
  }
}

function _snapEntity(e) {
  return { id: e.id, name: e.displayName, hp: e.hp, maxHp: e.maxHp, attack: e.attack, defense: e.defense, type: e.type };
}

function _unoccupiedObjective(state, actor) {
  const unclaimed = state.witchObjectives.filter(obj =>
    !state.entities.some(e => e.alive && e.owner === 'witch' && e.col === obj.col && e.row === obj.row)
  );
  if (!unclaimed.length) return null;
  unclaimed.sort(
    (a, b) =>
      hexDistance(actor.col, actor.row, a.col, a.row) -
      hexDistance(actor.col, actor.row, b.col, b.row)
  );
  return unclaimed[0];
}

function isAdjacent(a, b) {
  return hexDistance(a.col, a.row, b.col, b.row) === 1;
}

function stepToward(state, actor, target) {
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

// ── Hero AI ──────────────────────────────────────────────────────────────────

export class HeroAI {
  constructor(state, onStateChange) {
    this.state         = state;
    this.onStateChange = onStateChange;
    this.onBattleResult = null;
    this._running       = false;
  }

  async takeTurn() {
    if (this._running) return;
    this._running = true;
    const state = this.state;

    while (state.actionsAvailable > 0 && !state.gameOver) {
      await delay(THINK_DELAY_MS * 0.5);
      const acted = await this._chooseAction();
      if (!acted) break;
      this.onStateChange();
      await delay(THINK_DELAY_MS);
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
    const state = this.state;
    const hero  = state.hero;

    // 1. Fight co-located witch units
    const colocated = state.entities.find(
      e => e.alive && e.owner === 'witch' && e.col === hero.col && e.row === hero.row
    );
    if (colocated) return this._executeBattleWithUI(hero, colocated);

    // 2. Fight adjacent witch units
    const adjWitch = state.entities.find(
      e => e.alive && e.owner === 'witch' && hexDistance(hero.col, hero.row, e.col, e.row) === 1
    );
    if (adjWitch) return this._executeBattleWithUI(hero, adjWitch);

    // 3. Use herbs if injured
    const herbs = (hero.items && hero.items[ResourceType.HERBS]) || 0;
    if (herbs > 0 && hero.hp < hero.maxHp) {
      const result = executeUseItem(state, hero, ResourceType.HERBS);
      for (const msg of result.log) state.addLog(msg);
      if (result.success) state.spendAction(result.cost);
      return result.success;
    }

    // 4. At night, seek shelter if in the open
    if (state.phase === Phase.NIGHT) {
      const curTile = state.tiles.get(hexKey(hero.col, hero.row));
      if (!curTile || curTile.type !== TileType.BUILDING) {
        const shelter = _nearestBuilding(state, hero);
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
    }

    // 5. Move survivors toward power nodes or have them fight
    const survivors = state.entities.filter(
      e => e.alive && e.owner === 'hero' && e.type === 'survivor'
    );
    for (const s of survivors) {
      // Fight co-located witch unit
      const sc = state.entities.find(
        e => e.alive && e.owner === 'witch' && e.col === s.col && e.row === s.row
      );
      if (sc) return this._executeBattleWithUI(s, sc);
      // Fight adjacent witch unit
      const sa = state.entities.find(
        e => e.alive && e.owner === 'witch' && hexDistance(s.col, s.row, e.col, e.row) === 1
      );
      if (sa) return this._executeBattleWithUI(s, sa);
      // Move toward nearest unclaimed node
      const nodeTarget = _unclaimedNodeForHero(state, s);
      if (nodeTarget) {
        const step = stepToward(state, s, nodeTarget);
        if (step) {
          const result = executeMove(state, s, step.col, step.row);
          for (const msg of result.log) state.addLog(msg);
          state.spendAction(result.cost);
          return true;
        }
      }
    }

    // 6. Explore current tile if it's an unexplored building
    const heroTile = state.tiles.get(hexKey(hero.col, hero.row));
    if (heroTile && heroTile.type === TileType.BUILDING && !heroTile.explored) {
      const result = executeExplore(state, hero);
      for (const msg of result.log) state.addLog(msg);
      state.spendAction(result.cost);
      return result.success;
    }

    // 7. Move to nearest unexplored building
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

    // 8. Contest unclaimed power node
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
}

function _nearestBuilding(state, actor) {
  let best = null, bestDist = Infinity;
  for (const [, t] of state.tiles) {
    if (t.type !== TileType.BUILDING) continue;
    const d = hexDistance(actor.col, actor.row, t.col, t.row);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  return best;
}

function _nearestUnexploredBuilding(state, actor) {
  let best = null, bestDist = Infinity;
  for (const [, t] of state.tiles) {
    if (t.type !== TileType.BUILDING || t.explored) continue;
    const d = hexDistance(actor.col, actor.row, t.col, t.row);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  return best;
}

function _unclaimedNodeForHero(state, actor) {
  const unclaimed = state.witchObjectives.filter(obj =>
    !state.entities.some(e => e.alive && e.owner === 'hero' && e.col === obj.col && e.row === obj.row)
  );
  if (!unclaimed.length) return null;
  unclaimed.sort((a, b) =>
    hexDistance(actor.col, actor.row, a.col, a.row) -
    hexDistance(actor.col, actor.row, b.col, b.row)
  );
  return unclaimed[0];
}

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}
