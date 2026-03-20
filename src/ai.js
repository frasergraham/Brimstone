// Simple witch AI
// Priority: attack hero if adjacent → attack survivors → zombify survivors → move toward hero
import { getNeighbors, hexDistance, hexKey } from './hex.js';
import { TileType } from './tiles.js';
import { EntityType } from './entities.js';
import {
  ActionType,
  executeMove, executeExplore, executeBattle, executeSummon,
} from './actions.js';

const THINK_DELAY_MS = 600;  // pause between AI actions so player can see them

export class WitchAI {
  constructor(state, onStateChange) {
    this.state        = state;
    this.onStateChange = onStateChange;
    this._running     = false;
  }

  // Called when it is the witch's turn; executes actions with delays
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
    const state  = this.state;
    const witch  = state.witch;

    // 1. Battle: attack hero if adjacent or co-located
    const heroAdj = isAdjacent(witch, state.hero) || colocated(witch, state.hero);
    if (heroAdj && state.hero.alive) {
      const result = executeBattle(state, witch, state.hero);
      logResult(state, result);
      state.spendAction(result.cost);
      return true;
    }

    // 2. Battle: attack any hero-owned survivors nearby
    const nearSurvivor = nearbyEnemy(state, witch, 'hero');
    if (nearSurvivor) {
      const result = executeBattle(state, witch, nearSurvivor);
      logResult(state, result);
      state.spendAction(result.cost);
      return true;
    }

    // 3. Explore current tile if unexplored (might find survivors to zombify)
    const tile = state.tiles.get(hexKey(witch.col, witch.row));
    if (tile && !tile.explored) {
      const result = executeExplore(state, witch);
      logResult(state, result);
      state.spendAction(result.cost);
      return true;
    }

    // 4. Explore an adjacent unexplored tile (move there first if possible)
    const unexploredAdj = getNeighbors(witch.col, witch.row).find(n => {
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && !t.explored && (t.hasSurvivor || t.resource) &&
             t.type !== TileType.RIVER;
    });
    if (unexploredAdj) {
      const result = executeMove(state, witch, unexploredAdj.col, unexploredAdj.row);
      logResult(state, result);
      state.spendAction(result.cost);
      return true;
    }

    // 5. Move minion/zombie toward hero (give each one action)
    const minions = state.entities.filter(
      e => e.alive && (e.type === EntityType.MINION || e.type === EntityType.ZOMBIE)
    );
    for (const minion of minions) {
      if (colocated(minion, state.hero)) {
        const result = executeBattle(state, minion, state.hero);
        logResult(state, result);
        state.spendAction(result.cost);
        return true;
      }
      if (isAdjacent(minion, state.hero)) {
        const result = executeBattle(state, minion, state.hero);
        logResult(state, result);
        state.spendAction(result.cost);
        return true;
      }
      // Move minion toward hero
      const step = stepToward(state, minion, state.hero);
      if (step) {
        const result = executeMove(state, minion, step.col, step.row);
        logResult(state, result);
        state.spendAction(result.cost);
        return true;
      }
    }

    // 6. Move witch toward hero
    const step = stepToward(state, witch, state.hero);
    if (step) {
      const result = executeMove(state, witch, step.col, step.row);
      logResult(state, result);
      state.spendAction(result.cost);
      return true;
    }

    // Nothing to do
    return false;
  }

  async _think() {
    await delay(THINK_DELAY_MS * 0.5);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isAdjacent(a, b) {
  return hexDistance(a.col, a.row, b.col, b.row) === 1;
}

function colocated(a, b) {
  return a.col === b.col && a.row === b.row;
}

function nearbyEnemy(state, actor, targetOwner) {
  const adj = getNeighbors(actor.col, actor.row);
  for (const n of adj) {
    const enemies = state.entities.filter(
      e => e.alive && e.col === n.col && e.row === n.row && e.owner === targetOwner
    );
    if (enemies.length) return enemies[0];
  }
  return null;
}

function stepToward(state, actor, target) {
  // BFS one step toward target, avoiding rivers
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

function logResult(state, result) {
  for (const msg of result.log) state.addLog(msg);
}

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}
