// AI shared helpers + PlanSimState
// Hero AI: hero-ai-engine.js (HeroAIEngine)
// Witch AI: ai-engine.js (WitchAIEngine)
import { getNeighbors, hexDistance, hexKey } from './hex.js';
import { hasBuilding, isRiver, tileCapacityRemaining } from './tiles.js';
import { Entity, EntityType, isLeaderType, getItemCountOf, removeItemInItems } from './entities.js';
import { Phase, computeActions, computeActionsForPlayer, nodeController, countHeldNodes } from './game.js';
import { getReachableHexes, isFortBlocking } from './actions.js';
import { concreteFactionOf } from './factions.js';

// Hex-capacity check for AI pathfinders. Same gate as actions.isTileFullForMove
// but inlined here so ai.js doesn't pull in the rest of actions.js machinery
// for stepToward / stepAwayFrom. Excludes the moving actor from the unit
// count on the target tile.
function _isFullForMove(state, actor, col, row) {
  const t = state.tiles.get(hexKey(col, row));
  if (!t) return false;
  let others = 0;
  for (const e of state.entities) {
    if (e.alive && e.id !== actor.id && e.col === col && e.row === row) others++;
  }
  return tileCapacityRemaining(t, others) <= 0;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

export function stepToward(state, actor, target) {
  if (!target) return null;
  const targetK = hexKey(target.col, target.row);
  const visited = new Set([hexKey(actor.col, actor.row)]);
  const queue   = [{ col: actor.col, row: actor.row, first: null }];

  while (queue.length) {
    const { col, row, first } = queue.shift();
    if (col === target.col && row === target.row) return first;

    for (const n of getNeighbors(col, row)) {
      const k = hexKey(n.col, n.row);
      if (visited.has(k)) continue;
      const t = state.tiles.get(k);
      if (!t || isRiver(t)) continue;
      // Hex-capacity gate — a full hex is impassable for movement. The
      // target itself is allowed through so callers (e.g. melee approach)
      // can still discover a path that ends at a full hex; the actual move
      // execution then refuses the final step.
      if (k !== targetK && _isFullForMove(state, actor, n.col, n.row)) continue;
      visited.add(k);
      queue.push({ col: n.col, row: n.row, first: first || n });
    }
  }
  return null;
}

// Returns an adjacent hex that has an impassable fortification (blocking `actor`)
// and is also the adjacent hex closest to `target`.  Used by the witch AI to
// decide whether to siege a wall instead of continuing to path-find around it.
// Returns { col, row, fortLevel } or null.
export function adjacentBlockingFortToward(state, actor, target) {
  if (!target) return null;
  let best = null, bestDist = Infinity;
  for (const n of getNeighbors(actor.col, actor.row)) {
    const t = state.tiles.get(hexKey(n.col, n.row));
    if (!isFortBlocking(t, actor.owner)) continue;
    const d = hexDistance(n.col, n.row, target.col, target.row);
    if (d < bestDist) {
      best = { col: n.col, row: n.row, fortLevel: t.fortifyLevel };
      bestDist = d;
    }
  }
  return best;
}

// Road-aware movement: picks the reachable hex (within 1 move action) closest
// to the target. Roads/bridges/buildings cost 1 (vs 2 for off-road), so this
// can cover 2 hexes per action on roads. Falls back to plain stepToward.
export function roadStepToward(state, actor, target) {
  if (!target) return null;
  const reachable = getReachableHexes(state, actor, 1);
  if (reachable.length === 0) return stepToward(state, actor, target);

  let best = null, bestDist = Infinity;
  for (const h of reachable) {
    const d = hexDistance(h.col, h.row, target.col, target.row);
    if (d < bestDist) { bestDist = d; best = h; }
  }

  const currentDist = hexDistance(actor.col, actor.row, target.col, target.row);
  if (best && bestDist < currentDist) return best;
  return stepToward(state, actor, target);
}

export function nearestBuilding(state, actor) {
  let best = null, bestDist = Infinity;
  for (const [, t] of state.tiles) {
    if (!hasBuilding(t)) continue;
    const d = hexDistance(actor.col, actor.row, t.col, t.row);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  return best;
}

export function stepAwayFrom(state, actor, threat) {
  const neighbors = getNeighbors(actor.col, actor.row).filter(n => {
    const t = state.tiles.get(hexKey(n.col, n.row));
    return t && !isRiver(t) &&
      !state.entities.some(e => e.alive && e.owner === 'hero' && e.col === n.col && e.row === n.row) &&
      !_isFullForMove(state, actor, n.col, n.row);
  });
  if (!neighbors.length) return null;
  neighbors.sort((a, b) =>
    hexDistance(b.col, b.row, threat.col, threat.row) -
    hexDistance(a.col, a.row, threat.col, threat.row)
  );
  return neighbors[0];
}

export function isOnNode(state, entity) {
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
export function bestWitchObjective(state, actor, claimedNodes = null) {
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

export function inBuilding(state, entity) {
  const t = state.tiles.get(hexKey(entity.col, entity.row));
  return t && hasBuilding(t);
}

// ── AI difficulty ─────────────────────────────────────────────────────────────
// Human-vs-AI difficulty tiers scale how many actions the AI *plans* each
// round (the same lever campaign missions use via campaignAIBudgetBonus).
// 'normal' is the tuned baseline; never let a tier change AI behaviour in
// AI-vs-AI balance runs unless state.aiDifficulty is explicitly set.

export const AI_DIFFICULTIES = Object.freeze(['easy', 'normal', 'hard']);
export const AI_DIFFICULTY_BUDGET_DELTA = Object.freeze({ easy: -1, normal: 0, hard: 1 });

// ── Plan simulation state ─────────────────────────────────────────────────────
// A lightweight clone of GameState used for synchronous plan generation.
// Only entity positions and action budget are tracked; combat outcomes are
// not simulated (dice unknown) — battles simply consume one budget slot.

export class PlanSimState {
  constructor(realState, faction, playerId = null) {
    this.tiles            = realState.tiles;          // read-only reference
    this.phase            = realState.phase;
    this.round            = realState.round ?? 1;
    this.cycleConfig      = realState.cycleConfig ?? null;
    this.witchObjectives  = realState.witchObjectives;
    this.nodeScore        = realState.nodeScore;
    this.fogOfWar         = realState.fogOfWar;
    this.inventory        = JSON.parse(JSON.stringify(realState.inventory));

    // Shallow-copy live entities so position tracking works without mutating the real state.
    // Clones are re-parented to Entity.prototype *after* the spread so Object.assign-style
    // assignment never fires any of Entity's getter-only properties (alive / displayName /
    // abilities). Any own property set via spread shadows the corresponding prototype
    // getter on access, matching the pre-refactor sim-clone semantics.
    this.entities = realState.entities
      .filter(e => e.alive)
      .map(e => {
        const clone = Object.setPrototypeOf({ ...e }, Entity.prototype);
        // Deep-clone `items` so sim projection (equip toggles, item use) never
        // mutates the real entity's backpack. The equipped weapon now lives
        // INSIDE items as an `{ equipped: true }` tag, so a shared reference
        // would corrupt live equipped state. The equipped-weapon memo cache is
        // non-enumerable, so `{...e}` doesn't copy it — the clone rescans the
        // fresh dict on first lookup. (Phase 1 inventory refactor.)
        clone.items = e.items ? structuredClone(e.items) : {};
        return clone;
      });

    if (playerId) {
      // Multiplayer: scope leader ref and budget to this specific player.
      // sim.hero / sim.witch serve two roles:
      //   • The faction that matches the player → their own leader (the actor)
      //   • The opposite faction → the nearest enemy leader (for flee/hunt distance checks)
      // Without an enemy leader reference, flee and hunt logic silently no-ops.
      //
      // Leaders are matched by ownership, not by fixed entity type, so stub
      // factions (Rogue/Captain/Necromancer/Brute) work here too. The side
      // membership stays encoded in `owner` ('hero' for day, 'witch' for
      // night).
      const enemyOwner = faction === 'hero' ? 'witch' : 'hero';
      const leader = this.entities.find(e =>
        e.ownerId === playerId && isLeaderType(e.type)
      ) ?? null;
      // Nearest enemy leader (fallback: any enemy leader)
      const enemies = this.entities.filter(e =>
        e.alive && e.owner === enemyOwner && isLeaderType(e.type)
      );
      const enemyLeader = leader
        ? (enemies.sort((a, b) =>
            hexDistance(a.col, a.row, leader.col, leader.row) -
            hexDistance(b.col, b.row, leader.col, leader.row))[0] ?? null)
        : (enemies[0] ?? null);
      this.hero  = faction === 'hero'  ? leader : enemyLeader;
      this.witch = faction === 'witch' ? leader : enemyLeader;
      const nb = countHeldNodes(faction, realState.witchObjectives ?? [], this.entities);
      this.actionsLeft = computeActionsForPlayer(playerId, faction, realState.phase, this.entities, nb);
    } else {
      // Offline / legacy: pick the first leader on each side (handles stub
      // factions as well as the Paladin/Witch defaults).
      this.hero  = this.entities.find(e => e.owner === 'hero'  && isLeaderType(e.type)) ?? null;
      this.witch = this.entities.find(e => e.owner === 'witch' && isLeaderType(e.type)) ?? null;
      const nb = countHeldNodes(faction, realState.witchObjectives ?? [], this.entities);
      this.actionsLeft = computeActions(
        faction,
        realState.phase,
        this.entities,
        nb,
      );
    }
    this._faction = faction;
    // Kept for possession-command checks (canCommandEntity): multiplayer
    // paths identify the commander by playerId, offline paths by faction.
    this._playerId = playerId ?? null;
    this.campaignAIBudgetBonus = realState.campaignAIBudgetBonus ?? 0;
    this.aiDifficultyDelta = AI_DIFFICULTY_BUDGET_DELTA[realState.aiDifficulty] ?? 0;
    this.noWitchMission = !!realState.noWitchMission;

    // Count active players per faction — used by NvN-aware tunings such as
    // the witch minion cap, which scales with witch team size so a 3-witch
    // side isn't rationed to the same 7-minion ceiling as a solo witch.
    // Use a keyed map to avoid hard-coded faction string equality checks
    // (see docs/design/refactor.md / faction-string-checks guard).
    const playerCounts = {};
    for (const p of (realState.players || [])) {
      if (p && p.faction) playerCounts[p.faction] = (playerCounts[p.faction] || 0) + 1;
    }
    this.playerCounts = playerCounts;

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

  applySummon(leader) {
    const col = leader?.col ?? 0;
    const row = leader?.row ?? 0;
    this.entities.push({
      id: `sim-${this.entities.length}`,
      type: EntityType.MINION, owner: this._faction,
      col, row, alive: true, hp: 2,
    });
    // Spend the summoner's minion cost from faction inventory (drain largest
    // stacks first). The price is faction-aware: witch 2, necromancer/brute 1
    // (concreteFactionOf reads the leader's factionId, falling back to the
    // side default when no leader is supplied).
    const inv = this.inventory[this._faction];
    const keys = Object.keys(inv).filter(k => getItemCountOf(inv, k) > 0)
      .sort((a, b) => getItemCountOf(inv, b) - getItemCountOf(inv, a));
    let remaining = leader ? concreteFactionOf(leader).getMinionCost() : 2;
    for (const k of keys) {
      const spend = Math.min(getItemCountOf(inv, k), remaining);
      removeItemInItems(inv, k, spend);
      remaining -= spend;
      if (remaining === 0) break;
    }
    this.actionsLeft--;
  }

  applyGuard(entityId) {
    const e = this.entities.find(en => en.id === entityId);
    if (e) e.guarding = (e.guarding || 0) + 1;
    this.actionsLeft--;
  }

  // Project a TELEPORT (necromancer): optimistic landing on the chosen center
  // hex — real resolution scatters to a seeded-random clump member, but the
  // center is the expected landing zone for planning purposes. Mirrors
  // applyMove's node-departure tracking so anti-oscillation keeps working.
  applyTeleport(entityId, toCol, toRow) {
    const e = this.entities.find(en => en.id === entityId);
    if (e) {
      const wasOnNode = this.witchObjectives.some(obj => obj.col === e.col && obj.row === e.row);
      if (wasOnNode) this._justLeft[entityId] = { col: e.col, row: e.row };
      e.col = toCol; e.row = toRow;
    }
    this.actionsLeft--;
  }

  // Book a POSSESS (necromancer) — one action, no sim-visible state change:
  // the payoff (a commandable thrall) only materialises NEXT round, when
  // assessBoard reads the live `possessed` effect off the real entity.
  applyPossess() {
    this.actionsLeft--;
  }

  // Book a wall-siege action. The sim holds `tiles` as a read-only reference to
  // real game state, so we do NOT mutate fortifyLevel here. Callers should
  // break out of their per-unit loop after queueing a siege so we don't keep
  // targeting the same wall in the same turn-plan.
  applySiege(_col, _row) {
    this.actionsLeft--;
  }

  applySoundHorn() {
    const inv = this.inventory?.hero || {};
    if (getItemCountOf(inv, 'food') >= 1) removeItemInItems(inv, 'food', 1);
    this.actionsLeft--;
  }
}

// ── Scoring-phase helpers ───────────────────────────────────────────────────────
// Scoring happens at DAWN (cycle pos 0) and DUSK (cycle pos 4).
// Returns the number of rounds until the next scoring check (0 = this round).
// When cycleConfig is provided (campaign missions), scans the custom phase array.
const CYCLE_LENGTH = 8;

export function roundsUntilScoring(round, cycleConfig = null) {
  if (!cycleConfig) {
    const r = ((round || 1) - 1) % CYCLE_LENGTH;
    if (r === 0 || r === 4) return 0; // scoring this round (DAWN or DUSK)
    if (r < 4) return 4 - r;          // rounds until DUSK
    return CYCLE_LENGTH - r;           // rounds until next DAWN
  }
  const { phases, loop } = cycleConfig;
  const len = phases.length;
  const currentIdx = loop ? ((round || 1) - 1) % len : (round || 1) - 1;
  if (currentIdx >= len) return Infinity;
  if (phases[currentIdx] === 'dawn' || phases[currentIdx] === 'dusk') return 0;
  for (let offset = 1; offset < len; offset++) {
    const i = loop ? (currentIdx + offset) % len : currentIdx + offset;
    if (i >= len) return Infinity;
    if (phases[i] === 'dawn' || phases[i] === 'dusk') return offset;
  }
  return Infinity;
}

// ── Node feasibility scoring ────────────────────────────────────────────────────
// Evaluates how realistic it is for a faction to hold a given node.
// Returns 0–1; higher = more feasible to contest/hold.

export function scoreNodeFeasibility(node, myFaction, entities) {
  const myUnits = entities.filter(e => e.alive && e.owner === myFaction);
  const enemyUnits = entities.filter(e => e.alive && e.owner !== myFaction);

  // Nearest friendly/enemy unit distance to node center
  let myNearest = Infinity, enemyNearest = Infinity;
  for (const e of myUnits) {
    const d = hexDistance(e.col, e.row, node.obj.col, node.obj.row);
    if (d < myNearest) myNearest = d;
  }
  for (const e of enemyUnits) {
    const d = hexDistance(e.col, e.row, node.obj.col, node.obj.row);
    if (d < enemyNearest) enemyNearest = d;
  }

  // Count units on node hexes
  const nodeHexes = node.obj.hexes || [node.obj];
  const isOnNodeHex = (e) => nodeHexes.some(h => h.col === e.col && h.row === e.row);
  const myOnNode = myUnits.filter(isOnNodeHex).length;
  const enemyOnNode = enemyUnits.filter(isOnNodeHex).length;

  let score = 0.5;

  // Already held by us with presence: very feasible to defend
  if (node.controller === myFaction && myOnNode > 0) score += 0.3;

  // Distance advantage: we're closer than enemy
  if (myNearest < enemyNearest) score += 0.15;
  else if (myNearest > enemyNearest + 2) score -= 0.25;

  // Force advantage on node
  if (myOnNode > enemyOnNode) score += 0.2;
  else if (enemyOnNode > myOnNode + 1) score -= 0.25;

  // Too far away with enemy presence — likely hopeless
  if (myNearest > 5 && enemyOnNode > 0) score -= 0.35;

  // Neutral and close — good opportunity
  if (node.controller === 'neutral' && myNearest <= 2) score += 0.15;

  return Math.max(0, Math.min(1, score));
}

// ── Personality registries ──────────────────────────────────────────────────────
// Hero personalities are config-driven variants of HeroAIEngine (see hero-ai-engine.js).
// Import hero-ai-engine.js as a side-effect to populate this registry.
export const HERO_PERSONALITIES = {};

// Witch personalities are config-driven variants of WitchAIEngine (see ai-engine.js).
// Import ai-engine.js as a side-effect to populate this registry.
export const WITCH_PERSONALITIES = {};
