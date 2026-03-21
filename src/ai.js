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

function _unoccupiedObjective(state, actor, owner = 'witch') {
  const unclaimed = state.witchObjectives.filter(obj =>
    !state.entities.some(e => e.alive && e.owner === owner && e.col === obj.col && e.row === obj.row)
  );
  if (!unclaimed.length) return null;
  unclaimed.sort((a, b) =>
    hexDistance(actor.col, actor.row, a.col, a.row) -
    hexDistance(actor.col, actor.row, b.col, b.row)
  );
  return unclaimed[0];
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
  constructor(state, onStateChange) {
    this.state         = state;
    this.onStateChange = onStateChange;
    this.onBattleResult = null;
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

      // 5. Move minions toward hero units aggressively
      for (const m of minions) {
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
        // Fallback: move toward unclaimed objective
        const obj = _unoccupiedObjective(state, m, 'witch');
        if (obj) {
          const step = stepToward(state, m, obj);
          if (step) {
            const result = executeMove(state, m, step.col, step.row);
            logResult(state, result);
            state.spendAction(result.cost);
            return true;
          }
        }
      }

      // 6. Move witch toward unclaimed objective or hero
      const witchTarget = _unoccupiedObjective(state, witch, 'witch') || state.hero;
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
    // Priority: shelter minions from sunlight; explore for resources; build army;
    //           creep toward objectives without exposing minions

    // 1. Move exposed minions into buildings (to avoid day damage)
    for (const m of minions) {
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

    // 2. Summon if resources allow (build the army during daytime)
    if (await this._trySummon(witch, minions.length)) return true;

    // 3. Witch explores current tile if unexplored (gather resources safely)
    const witchTile = state.tiles.get(hexKey(witch.col, witch.row));
    if (witchTile && !witchTile.explored) {
      const result = executeExplore(state, witch);
      logResult(state, result);
      state.spendAction(result.cost);
      return true;
    }

    // 4. Move to adjacent unexplored building/resource tile (stay stealthy)
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

    // 5. Witch moves toward an unclaimed objective via buildings (safe path)
    const obj = _unoccupiedObjective(state, witch, 'witch');
    if (obj) {
      const step = stepToward(state, witch, obj);
      if (step) {
        const result = executeMove(state, witch, step.col, step.row);
        logResult(state, result);
        state.spendAction(result.cost);
        return true;
      }
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
    await delay(THINK_DELAY_MS * 0.5);
  }
}

// ── HeroAI ────────────────────────────────────────────────────────────────────
// Strategy shifts with the day/night cycle:
//   DAWN/DAY  : Hunt aggressively — find survivors fast, then pursue witch/nodes
//   DUSK      : Seek shelter while still fighting if opportunity arises
//   NIGHT     : Hunker down — shelter all units in buildings; avoid open combat

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

    // 5. Explore current building for loot
    const heroTile = state.tiles.get(hexKey(hero.col, hero.row));
    if (heroTile && heroTile.type === TileType.BUILDING && !heroTile.explored) {
      const result = executeExplore(state, hero);
      for (const msg of result.log) state.addLog(msg);
      state.spendAction(result.cost);
      return result.success;
    }

    // 6. Move toward nearest unexplored building (find survivors + loot fast)
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

    // 7. Move survivors toward unclaimed nodes
    for (const s of survivors) {
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
