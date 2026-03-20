// Witch AI — objective-based strategy
// Priority: hold/claim 3 power nodes → build an army → pressure hero
import { getNeighbors, hexDistance, hexKey } from './hex.js';
import { TileType, ResourceType } from './tiles.js';
import { EntityType } from './entities.js';
import { WITCH_OBJECTIVES } from './map.js';
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
    const state = this.state;
    const witch = state.witch;

    // 1. If witch is in combat (hero or hero units co-located), fight
    const colocatedEnemy = state.entities.find(
      e => e.alive && e.owner === 'hero' && e.col === witch.col && e.row === witch.row
    );
    if (colocatedEnemy) {
      const result = executeBattle(state, witch, colocatedEnemy);
      logResult(state, result);
      state.spendAction(result.cost);
      return true;
    }

    // 2. Summon if resources are available and adjacent empty hex exists
    const inv = state.inventory.witch;
    const totalRes = Object.values(inv).reduce((s, v) => s + v, 0);
    const witchMinions = state.entities.filter(
      e => e.alive && e.owner === 'witch' && e.type !== EntityType.WITCH
    );
    // Summon if we have resources and could use more troops
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

    // 3. Explore current tile if unexplored (gather resources)
    const tile = state.tiles.get(hexKey(witch.col, witch.row));
    if (tile && !tile.explored) {
      const result = executeExplore(state, witch);
      logResult(state, result);
      state.spendAction(result.cost);
      return true;
    }

    // 4. Explore adjacent unexplored tile (move to it)
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

    // 5. Move minions/golems toward unclaimed objectives or hero
    const minions = state.entities.filter(
      e => e.alive && e.owner === 'witch' && e.type !== EntityType.WITCH
    );
    for (const minion of minions) {
      // If minion is co-located with a hero unit, fight
      const minionEnemy = state.entities.find(
        e => e.alive && e.owner === 'hero' && e.col === minion.col && e.row === minion.row
      );
      if (minionEnemy) {
        const result = executeBattle(state, minion, minionEnemy);
        logResult(state, result);
        state.spendAction(result.cost);
        return true;
      }
      // If adjacent to hero unit, fight
      if (isAdjacent(minion, state.hero) && state.hero.alive) {
        const result = executeBattle(state, minion, state.hero);
        logResult(state, result);
        state.spendAction(result.cost);
        return true;
      }
      // If this minion is not yet at an objective, direct it to one
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
      // Otherwise converge on hero
      const step = stepToward(state, minion, state.hero);
      if (step) {
        const result = executeMove(state, minion, step.col, step.row);
        logResult(state, result);
        state.spendAction(result.cost);
        return true;
      }
    }

    // 6. Move witch toward nearest unclaimed objective; otherwise toward hero
    const witchTarget = _unoccupiedObjective(state, witch) || state.hero;
    const step = stepToward(state, witch, witchTarget);
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

// Return the nearest WITCH_OBJECTIVE not already occupied by a witch-side entity,
// biased toward objectives not occupied by anyone.
function _unoccupiedObjective(state, actor) {
  const objectives = WITCH_OBJECTIVES.map(obj => {
    const occupants = state.entities.filter(
      e => e.alive && e.col === obj.col && e.row === obj.row
    );
    const witchHeld = occupants.some(e => e.owner === 'witch');
    return { ...obj, witchHeld, empty: occupants.length === 0 };
  });

  // Prefer objectives not yet held by witch, nearest first
  const unclaimed = objectives.filter(o => !o.witchHeld);
  if (!unclaimed.length) return null;

  unclaimed.sort(
    (a, b) =>
      hexDistance(actor.col, actor.row, a.col, a.row) -
      hexDistance(actor.col, actor.row, b.col, b.row)
  );
  return unclaimed[0];
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isAdjacent(a, b) {
  return hexDistance(a.col, a.row, b.col, b.row) === 1;
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
