// Witch AI — objective-based strategy with fog-of-war log masking
import { getNeighbors, hexDistance, hexKey } from './hex.js';
import { TileType, ResourceType } from './tiles.js';
import { EntityType } from './entities.js';
import { WITCH_OBJECTIVES } from './map.js';
import {
  executeMove, executeExplore, executeBattle, executeSummon,
  executeAttackFortification,
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
    this._running      = false;
  }

  async takeTurn() {
    if (this._running) return;
    this._running = true;
    const state = this.state;

    while (state.actionsAvailable > 0 && !state.gameOver) {
      await this._think();
      const acted = this._chooseAction();
      if (!acted) break;
      this.onStateChange();
      await delay(THINK_DELAY_MS);
    }

    state.endTurn();
    this.onStateChange();
    this._running = false;
  }

  _chooseAction() {
    const state = this.state;
    const witch = state.witch;

    // 1. Fight any hero unit co-located with the witch
    const colocatedEnemy = state.entities.find(
      e => e.alive && e.owner === 'hero' && e.col === witch.col && e.row === witch.row
    );
    if (colocatedEnemy) {
      const result = executeBattle(state, witch, colocatedEnemy);
      logResult(state, result);
      state.spendAction(result.cost);
      return true;
    }

    // 2. Attack adjacent fortification that contains hero units (break it open)
    const fortifiedWithHero = getNeighbors(witch.col, witch.row).find(n => {
      const t = state.tiles.get(hexKey(n.col, n.row));
      if (!t || t.fortifyLevel <= 0) return false;
      return state.entities.some(
        e => e.alive && e.owner === 'hero' && e.col === n.col && e.row === n.row
      );
    });
    if (fortifiedWithHero) {
      const result = executeAttackFortification(
        state, witch, fortifiedWithHero.col, fortifiedWithHero.row
      );
      logResult(state, result);
      if (result.success) state.spendAction(result.cost);
      return result.success;
    }

    // 3. Summon if resources available and army is still small
    const inv = state.inventory.witch;
    const totalRes = Object.values(inv).reduce((s, v) => s + v, 0);
    const witchMinions = state.entities.filter(
      e => e.alive && e.owner === 'witch' && e.type !== EntityType.WITCH
    );
    if (totalRes > 0 && witchMinions.length < 8) {
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

    // 4. Explore current tile if unexplored
    const witchTile = state.tiles.get(hexKey(witch.col, witch.row));
    if (witchTile && !witchTile.explored) {
      const result = executeExplore(state, witch);
      logResult(state, result);
      state.spendAction(result.cost);
      return true;
    }

    // 5. Activate each minion/golem
    const minions = state.entities.filter(
      e => e.alive && e.owner === 'witch' && e.type !== EntityType.WITCH
    );
    for (const minion of minions) {
      // Fight co-located enemy
      const minionEnemy = state.entities.find(
        e => e.alive && e.owner === 'hero' && e.col === minion.col && e.row === minion.row
      );
      if (minionEnemy) {
        const result = executeBattle(state, minion, minionEnemy);
        logResult(state, result);
        state.spendAction(result.cost);
        return true;
      }
      // Fight adjacent hero
      if (isAdjacent(minion, state.hero) && state.hero.alive) {
        const result = executeBattle(state, minion, state.hero);
        logResult(state, result);
        state.spendAction(result.cost);
        return true;
      }
      // Attack adjacent fortification blocking progress toward hero/objectives
      const minionFortTarget = getNeighbors(minion.col, minion.row).find(n => {
        const t = state.tiles.get(hexKey(n.col, n.row));
        if (!t || t.fortifyLevel <= 0) return false;
        return state.entities.some(
          e => e.alive && e.owner === 'hero' && e.col === n.col && e.row === n.row
        );
      });
      if (minionFortTarget) {
        const result = executeAttackFortification(
          state, minion, minionFortTarget.col, minionFortTarget.row
        );
        logResult(state, result);
        if (result.success) {
          state.spendAction(result.cost);
          return true;
        }
      }
      // Move toward nearest unclaimed objective
      const targetObj = _unoccupiedObjective(state, minion);
      if (targetObj) {
        const step = stepToward(state, minion, targetObj);
        if (step) {
          const result = executeMove(state, minion, step.col, step.row);
          logResult(state, result);
          state.spendAction(result.cost);
          return true;
        }
        // Blocked by fortification — attack it to clear the way
        const blockingFort = getNeighbors(minion.col, minion.row).find(n => {
          const t = state.tiles.get(hexKey(n.col, n.row));
          return t && t.fortifyLevel > 0;
        });
        if (blockingFort) {
          const result = executeAttackFortification(
            state, minion, blockingFort.col, blockingFort.row
          );
          logResult(state, result);
          if (result.success) {
            state.spendAction(result.cost);
            return true;
          }
        }
      }
      // Otherwise close on hero
      const step = stepToward(state, minion, state.hero);
      if (step) {
        const result = executeMove(state, minion, step.col, step.row);
        logResult(state, result);
        state.spendAction(result.cost);
        return true;
      }
      // Hero path is blocked — tear at nearest fortification
      const anyFort = getNeighbors(minion.col, minion.row).find(n => {
        const t = state.tiles.get(hexKey(n.col, n.row));
        return t && t.fortifyLevel > 0;
      });
      if (anyFort) {
        const result = executeAttackFortification(
          state, minion, anyFort.col, anyFort.row
        );
        logResult(state, result);
        if (result.success) {
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

    // 7. If witch path is blocked, attack an adjacent fortification to clear it
    const blockingFort = getNeighbors(witch.col, witch.row).find(n => {
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && t.fortifyLevel > 0;
    });
    if (blockingFort) {
      const result = executeAttackFortification(
        state, witch, blockingFort.col, blockingFort.row
      );
      logResult(state, result);
      if (result.success) {
        state.spendAction(result.cost);
        return true;
      }
    }

    // 8. Move to adjacent unexplored building/resource tile
    const unexploredAdj = getNeighbors(witch.col, witch.row).find(n => {
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && !t.explored && (t.hasSurvivor || t.resource || t.building) &&
        t.type !== TileType.RIVER && t.fortifyLevel === 0;
    });
    if (unexploredAdj) {
      const result = executeMove(state, witch, unexploredAdj.col, unexploredAdj.row);
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

function _unoccupiedObjective(state, actor) {
  const unclaimed = WITCH_OBJECTIVES.filter(obj =>
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

// BFS pathfinding — witch units skip fortified tiles
function stepToward(state, actor, target) {
  const isWitch = actor.owner === 'witch';
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
      if (isWitch && t.fortifyLevel > 0) continue; // blocked by fortification
      visited.add(k);
      queue.push({ col: n.col, row: n.row, first: first || n });
    }
  }
  return null;
}

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}
