// Witch AI — objective-based strategy with fog-of-war log masking
import { getNeighbors, hexDistance, hexKey } from './hex.js';
import { TileType, ResourceType } from './tiles.js';
import { EntityType } from './entities.js';
import {
  executeMove, executeExplore, executeBattle, executeSummon,
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
      return t && !t.explored && (t.hasSurvivor || t.resource || t.building) &&
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

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}
