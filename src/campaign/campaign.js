// Campaign state management — persistence, roster, resources, progression.
// Stored in localStorage; optionally synced to server for verified users.

import { countHeldNodes } from '../game.js';
import { getFaction } from '../factions.js';

const SAVE_VERSION = 1;

/**
 * Serialize a survivor entity into a plain object for campaign roster storage.
 * Captures all fields needed to reconstruct the entity between missions.
 */
export function snapshotSurvivor(entity) {
  return {
    name:         entity.name,
    title:        entity.title,
    bio:          entity.bio,
    ability:      entity.ability,
    abilityLabel: entity.abilityLabel,
    color:        entity.color,
    hp:           entity.hp,
    maxHp:        entity.maxHp,
    attack:       entity.attack,
    defense:      entity.defense,
    weapon:       entity.weapon,
    items:        { ...entity.items },
  };
}

/**
 * Build the post-mission roster for a victorious campaign mission.
 *
 * Permadeath rule: any roster survivor who was deployed and died in the
 * mission is removed from the party. Undeployed roster members carry over
 * untouched. Deployed-and-alive survivors have their post-mission stats
 * snapshotted.
 *
 * The "deployed" set is built from ALL survivor entities — alive or dead —
 * so a dead deployed survivor is not silently restored from the pre-mission
 * roster.
 *
 * @param {object[]} preMissionRoster  Snapshot-style roster as it was before the mission.
 * @param {object[]} entities          state.entities after the mission ended.
 * @returns {object[]}                 New roster: live deployed + undeployed.
 */
export function reconcileRosterAfterMission(preMissionRoster, entities) {
  const deployedNames = new Set();
  const deployedSurvivors = [];
  for (const e of entities) {
    if (e.type !== 'survivor') continue;
    const f = e.owner ? getFaction(e.owner) : null;
    if (!f?.canDiscoverNPCs()) continue;
    deployedNames.add(e.name);
    if (e.alive) deployedSurvivors.push(snapshotSurvivor(e));
  }
  const undeployed = preMissionRoster.filter(s => !deployedNames.has(s.name));
  return [...deployedSurvivors, ...undeployed];
}

/**
 * Build victory/defeat delegate function from mission objectives.
 * Returns a function (state) => { winner, winReason, log } | null.
 *
 * `objectives.win` and `objectives.lose` may each be either a single condition
 * object or an array of conditions. When an array is given, the first matching
 * condition wins — lose conditions are checked before win conditions.
 */
export function buildVictoryDelegate(objectives) {
  return (state) => {
    // Check lose condition(s) first (may be null for tutorial/conductor missions)
    if (objectives.lose) {
      const loseConds = Array.isArray(objectives.lose) ? objectives.lose : [objectives.lose];
      for (const cond of loseConds) {
        const result = _checkLoseCondition(cond, state);
        if (result) return result;
      }
    }
    // Check win condition(s)
    if (objectives.win) {
      const winConds = Array.isArray(objectives.win) ? objectives.win : [objectives.win];
      for (const cond of winConds) {
        const result = _checkWinCondition(cond, state);
        if (result === null) continue;     // condition not met — try next
        if (result === DEFERRED) return null; // let external systems resolve
        return result;
      }
    }
    return null; // no victory yet
  };
}

// Sentinel returned by a win condition that should defer to external systems
// (e.g. standard node scoring, conductor missions) instead of resolving now.
const DEFERRED = Symbol('victory-deferred');

function _heroSurvivorCount(state) {
  return state.entities.filter(e => {
    if (!e.alive || e.type !== 'survivor' || !e.owner) return false;
    return getFaction(e.owner).canDiscoverNPCs();
  }).length;
}

function _checkLoseCondition(cond, state) {
  switch (cond.type) {
    case 'hero_killed':
      if (state.factionEliminated('hero')) {
        return {
          winner: 'witch',
          winReason: cond.reason || 'The hero has fallen.',
          log: '💀 The hero has been slain…',
        };
      }
      return null;
    case 'rounds_exceeded':
      if (state.round > cond.rounds) {
        return {
          winner: 'witch',
          winReason: cond.reason || `Failed to complete the mission in ${cond.rounds} rounds.`,
          log: `⏳ Time ran out — the mission is lost.`,
        };
      }
      return null;
    case 'phase_without_survivors':
      if (state.phase === cond.phase && _heroSurvivorCount(state) < cond.survivors) {
        return {
          winner: 'witch',
          winReason: cond.reason || `Night fell before you gathered enough survivors.`,
          log: `🌒 The light fades and you stand alone — the mission is lost.`,
        };
      }
      return null;
    case 'survivors_below':
      // Fails at any time the hero faction has fewer than `count` survivors alive.
      if (_heroSurvivorCount(state) < cond.count) {
        return {
          winner: 'witch',
          winReason: cond.reason || 'A companion has fallen — the party is broken.',
          log: '💔 The party is broken.',
        };
      }
      return null;
    case 'witch_holds_node': {
      // Fails when the witch still controls ≥1 power node at the target phase.
      // Pair with `witch_denied_nodes` win.
      if (cond.phase && state.phase !== cond.phase) return null;
      if (!state.witchObjectives || state.witchObjectives.length === 0) return null;
      if (countHeldNodes('witch', state.witchObjectives, state.entities) === 0) return null;
      return {
        winner: 'witch',
        winReason: cond.reason || 'The witch holds a node at dawn.',
        log: '🌑 Dawn breaks and her power still pulses through the grove.',
      };
    }
  }
  return null;
}

function _checkWinCondition(cond, state) {
  switch (cond.type) {
    case 'eliminate_all': {
      const target = cond.targetFaction || 'witch';
      if (state.entities.filter(e => e.owner === target && e.alive).length === 0) {
        return {
          winner: 'hero',
          winReason: cond.reason || 'All enemies have been eliminated.',
          log: '☀ Every last enemy has been vanquished!',
        };
      }
      return null;
    }
    case 'survive_rounds':
      if (state.round > cond.rounds) {
        return {
          winner: 'hero',
          winReason: cond.reason || `Survived ${cond.rounds} rounds.`,
          log: `☀ You held the line! The darkness recedes… for now.`,
        };
      }
      return null;
    case 'reach_hex':
      if (state.hero?.col === cond.col && state.hero?.row === cond.row) {
        return {
          winner: 'hero',
          winReason: cond.reason || 'Reached the objective.',
          log: '☀ The hero has reached the objective!',
        };
      }
      return null;
    case 'slay_witch':
      if (state.factionEliminated('witch')) {
        return {
          winner: 'hero',
          winReason: cond.reason || 'The witch has been slain!',
          log: '☀ The witch has been defeated! Caleb\'s Hollow is saved!',
        };
      }
      return null;
    case 'gather_and_survive': {
      // Win when enough survivors are gathered AND either the kill quota is met
      // or the fallback phase has been reached.
      const survivors = _heroSurvivorCount(state);
      if (survivors < cond.survivors) return null;
      const killsOk = cond.kills == null || (state.heroKills ?? 0) >= cond.kills;
      const phaseOk = cond.phaseFallback && state.phase === cond.phaseFallback;
      if (killsOk || phaseOk) {
        return {
          winner: 'hero',
          winReason: cond.reason || 'Survivors gathered — the mission is a success.',
          log: '☀ The survivors are safe!',
        };
      }
      return null;
    }
    case 'survive_with_party': {
      // Win when the target phase is reached with the hero alive and enough
      // survivors still standing. Pair with `phase_without_survivors` lose.
      if (state.phase !== cond.phase) return null;
      if (_heroSurvivorCount(state) < cond.survivors) return null;
      return {
        winner: 'hero',
        winReason: cond.reason || 'You and your companions survived until dawn.',
        log: '☀ Dawn breaks — you have survived the night.',
      };
    }
    case 'all_party_at_hexes': {
      // Win when every living hero-faction party member (hero + survivors) stands
      // on one of the listed target hexes.
      const partyFaction = cond.faction || 'hero';
      const party = state.entities.filter(e =>
        e.alive && e.owner === partyFaction &&
        (e.type === 'hero' || e.type === 'survivor')
      );
      if (party.length === 0) return null;
      const hexes = cond.hexes;
      if (!hexes || hexes.length === 0) return null;
      const allThere = party.every(p =>
        hexes.some(h => h.col === p.col && h.row === p.row)
      );
      if (!allThere) return null;
      return {
        winner: 'hero',
        winReason: cond.reason || 'The party has reached the target.',
        log: '☀ The whole party has made it through.',
      };
    }
    case 'witch_denied_nodes': {
      // Win when the witch controls zero power nodes at the target phase.
      // Pair with `witch_holds_node` lose.
      if (cond.phase && state.phase !== cond.phase) return null;
      if (!state.witchObjectives || state.witchObjectives.length === 0) return null;
      if (countHeldNodes('witch', state.witchObjectives, state.entities) !== 0) return null;
      return {
        winner: 'hero',
        winReason: cond.reason || 'The witch has been denied at every node.',
        log: '☀ Dawn breaks over silent nodes — the ritual is broken!',
      };
    }
    case 'control_nodes':
      // Standard node scoring — delegate to existing logic (return null to let it run)
      return DEFERRED;
    case 'conductor_complete':
      // MissionConductor handles completion directly — never auto-trigger victory
      return DEFERRED;
  }
  return null;
}

/**
 * Process wave spawns for the current round.
 * Called after plan resolution, before endRound().
 * Returns an array of log messages for spawned units.
 */
export function processWaves(state, waves, createEnemyFn) {
  if (!waves) return [];
  const logs = [];
  for (const wave of waves) {
    // Round-based trigger (legacy)
    if (wave.round !== undefined && wave.round !== state.round) continue;

    // Kill-count trigger — fires once when state.heroKills crosses threshold
    if (wave.trigger === 'hero_kills') {
      if ((state.heroKills ?? 0) < wave.count) continue;
      if (!state._firedWaves) state._firedWaves = new Set();
      const key = wave.id ?? `kills:${wave.count}`;
      if (state._firedWaves.has(key)) continue;
      state._firedWaves.add(key);
    }

    // Area trigger — fires once when hero stands on any listed hex
    if (wave.trigger === 'area') {
      const hero = state.hero;
      if (!hero) continue;
      if (!wave.hexes?.some(h => h.col === hero.col && h.row === hero.row)) continue;
      if (!state._firedWaves) state._firedWaves = new Set();
      const key = wave.id ?? `area:${wave.hexes[0].col},${wave.hexes[0].row}`;
      if (state._firedWaves.has(key)) continue;
      state._firedWaves.add(key);
    }

    for (const unit of wave.units) {
      const pos = resolveSpawnPosition(state, unit.spawnAt);
      if (!pos) continue;
      const entity = createEnemyFn(unit.type, pos.col, pos.row, state);
      if (entity) {
        if (unit.overrides) Object.assign(entity, unit.overrides);
        state.entities.push(entity);
        logs.push(unit.spawnLog ?? `🌑 ${entity.displayName} emerges from the shadows!`);
      }
    }
  }
  return logs;
}

/**
 * Resolve a spawn position descriptor to {col, row}.
 */
function resolveSpawnPosition(state, spawnAt) {
  if (typeof spawnAt === 'object' && spawnAt.col !== undefined) {
    return { col: spawnAt.col, row: spawnAt.row };
  }
  if (spawnAt === 'graveyard') {
    const graveyards = [];
    for (const [, tile] of state.tiles) {
      if (tile.building === 'graveyard') graveyards.push(tile);
    }
    if (graveyards.length === 0) return null;
    const t = graveyards[Math.floor(Math.random() * graveyards.length)];
    return { col: t.col, row: t.row };
  }
  if (spawnAt === 'map_edge') {
    // Pick a random passable tile along any of the four outer edges.
    let maxCol = 0, maxRow = 0;
    for (const [, tile] of state.tiles) {
      if (tile.col > maxCol) maxCol = tile.col;
      if (tile.row > maxRow) maxRow = tile.row;
    }
    const edges = [];
    for (const [, tile] of state.tiles) {
      const isEdge = tile.col === 0 || tile.col === maxCol
                  || tile.row === 0 || tile.row === maxRow;
      if (!isEdge) continue;
      if (tile.type === 'river') continue;
      if (tile.type === 'building') continue;
      edges.push(tile);
    }
    if (edges.length === 0) return null;
    const t = edges[Math.floor(Math.random() * edges.length)];
    return { col: t.col, row: t.row };
  }
  return null;
}

// ── Campaign class ──────────────────────────────────────────────────────────

export class Campaign {
  /**
   * @param {object} campaignDef  Campaign definition from campaign-registry.
   *   Must include { id, title, missions[], mapBuilders, firstMission }.
   * @param {string} saveSlot     localStorage key suffix (defaults to campaignDef.id).
   */
  constructor(campaignDef, saveSlot) {
    this.campaignDef       = campaignDef;
    this.saveSlot          = saveSlot ?? `campaign-${campaignDef.id}`;
    this.version           = SAVE_VERSION;
    this.currentMission    = campaignDef.firstMission;
    this.completedMissions = new Set();
    this.roster            = []; // Array of snapshotSurvivor() objects
    this.resources         = { wood: 0, metal: 0, herbs: 0, food: 0, silver: 0, scripture: 0 };
    this.heroStats         = { hp: 14, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} };
    this.storyFlags        = {};
    this.updatedAt         = Date.now();
  }

  /** Persist to localStorage. */
  save() {
    this.updatedAt = Date.now();
    const data = {
      campaignId:        this.campaignDef.id,
      version:           this.version,
      currentMission:    this.currentMission,
      completedMissions: [...this.completedMissions],
      roster:            this.roster,
      resources:         { ...this.resources },
      heroStats:         JSON.parse(JSON.stringify(this.heroStats)),
      storyFlags:        { ...this.storyFlags },
      updatedAt:         this.updatedAt,
    };
    localStorage.setItem(`brimstone-${this.saveSlot}`, JSON.stringify(data));
  }

  /** Load from localStorage. Returns true if a save was found. */
  load() {
    const raw = localStorage.getItem(`brimstone-${this.saveSlot}`);
    if (!raw) return false;
    const data = JSON.parse(raw);
    this.version           = data.version ?? SAVE_VERSION;
    this.currentMission    = data.currentMission ?? this.campaignDef.firstMission;
    this.completedMissions = new Set(data.completedMissions ?? []);
    this.roster            = data.roster ?? [];
    this.resources         = { wood: 0, metal: 0, herbs: 0, food: 0, silver: 0, scripture: 0, ...data.resources };
    this.heroStats         = data.heroStats ?? { hp: 14, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} };
    this.storyFlags        = data.storyFlags ?? {};
    this.updatedAt         = data.updatedAt ?? Date.now();
    return true;
  }

  /** Delete campaign save. */
  delete() {
    localStorage.removeItem(`brimstone-${this.saveSlot}`);
  }

  /** Check if a save exists without fully loading. */
  static exists(saveSlot) {
    return localStorage.getItem(`brimstone-${saveSlot}`) !== null;
  }

  /** Get mission definition by ID (from this campaign's missions). */
  getMissionDef(missionId) {
    return this.campaignDef.missions.find(m => m.id === missionId) ?? null;
  }

  /** Get the map builder function for a mission. */
  getMapBuilder(mapBuilderKey) {
    return this.campaignDef.mapBuilders[mapBuilderKey] ?? null;
  }

  /** Get the next available (unlocked, not completed) mission. */
  getNextMission() {
    for (const mission of this.campaignDef.missions) {
      if (this.completedMissions.has(mission.id)) continue;
      if (mission.requires && !mission.requires.every(r => this.completedMissions.has(r))) continue;
      return mission.id;
    }
    return null; // all missions completed
  }

  /** Check if all missions in this campaign are completed. */
  isComplete() {
    return this.campaignDef.missions.every(m => this.completedMissions.has(m.id));
  }

  /**
   * Check if a campaign is completed by loading its save.
   * Returns true only if a save exists and every mission is completed.
   */
  static isCampaignCompleted(campaignDef) {
    const c = new Campaign(campaignDef);
    if (!c.load()) return false;
    return c.isComplete();
  }

  /** Get list of missions with their status for the mission select screen. */
  getMissionList() {
    return this.campaignDef.missions.map(m => {
      const completed = this.completedMissions.has(m.id);
      const available = completed || (
        !m.requires || m.requires.every(r => this.completedMissions.has(r))
      );
      return {
        id: m.id,
        title: m.title,
        briefing: m.briefing,
        completed,
        available,
        current: m.id === this.currentMission,
      };
    });
  }

  /**
   * Apply the result of a completed mission.
   * @param {string} missionId
   * @param {object} result - { won, survivors[], resources, heroStats, flags }
   */
  applyMissionResult(missionId, result) {
    // On defeat: no state changes — party is restored to pre-mission state
    if (!result.won) return;

    const missionDef = this.getMissionDef(missionId);

    this.completedMissions.add(missionId);
    this.currentMission = this.getNextMission() ?? missionId;

    // Permadeath: replace roster with only surviving survivors
    if (result.survivors) {
      this.roster = result.survivors.map(s => snapshotSurvivor(s));
    }

    // Carry forward hero stats
    if (result.heroStats) {
      this.heroStats = {
        hp:      result.heroStats.hp,
        maxHp:   result.heroStats.maxHp,
        attack:  result.heroStats.attack,
        defense: result.heroStats.defense,
        weapon:  result.heroStats.weapon,
        items:   { ...result.heroStats.items },
      };
    }

    // Carry forward resources
    if (result.resources) {
      for (const key of Object.keys(this.resources)) {
        this.resources[key] = result.resources[key] ?? 0;
      }
    }

    // Apply heal bonus
    if (missionDef?.healBonus) {
      const bonus = missionDef.healBonus;
      this.heroStats.hp = Math.min(this.heroStats.hp + bonus, this.heroStats.maxHp);
      for (const s of this.roster) {
        s.hp = Math.min(s.hp + bonus, s.maxHp);
      }
    }

    // Apply mission rewards
    if (missionDef?.rewards) {
      for (const [key, val] of Object.entries(missionDef.rewards)) {
        this.resources[key] = (this.resources[key] ?? 0) + val;
      }
    }

    // Update story flags
    if (result.flags) {
      Object.assign(this.storyFlags, result.flags);
    }

    this.save();
  }

  // ── Server sync (for verified users) ──────────────────────────────────────

  /** Push current state to server. Requires valid token + verified email. */
  async syncToServer(token) {
    if (!token) return { ok: false, error: 'No token' };
    const data = {
      campaignId:        this.campaignDef.id,
      version:           this.version,
      currentMission:    this.currentMission,
      completedMissions: [...this.completedMissions],
      roster:            this.roster,
      resources:         this.resources,
      heroStats:         this.heroStats,
      storyFlags:        this.storyFlags,
      updatedAt:         this.updatedAt,
    };
    try {
      const res = await fetch(`${window.BRIMSTONE_SERVER || ''}/api/campaign-saves/${this.saveSlot}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-token': token },
        body: JSON.stringify({ state: data }),
      });
      return await res.json();
    } catch {
      return { ok: false, error: 'Network error' };
    }
  }

  /** Pull state from server. Returns { ok, data?, updatedAt? } */
  async syncFromServer(token) {
    if (!token) return { ok: false, error: 'No token' };
    try {
      const res = await fetch(`${window.BRIMSTONE_SERVER || ''}/api/campaign-saves/${this.saveSlot}`, {
        headers: { 'x-token': token },
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const json = await res.json();
      return { ok: true, data: json.state, updatedAt: json.updatedAt };
    } catch {
      return { ok: false, error: 'Network error' };
    }
  }

  /** Restore campaign state from a server-fetched data object. */
  restoreFromServerData(data) {
    this.version           = data.version ?? SAVE_VERSION;
    this.currentMission    = data.currentMission ?? this.campaignDef.firstMission;
    this.completedMissions = new Set(data.completedMissions ?? []);
    this.roster            = data.roster ?? [];
    this.resources         = { wood: 0, metal: 0, herbs: 0, food: 0, silver: 0, scripture: 0, ...data.resources };
    this.heroStats         = data.heroStats ?? { hp: 14, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} };
    this.storyFlags        = data.storyFlags ?? {};
    this.updatedAt         = data.updatedAt ?? Date.now();
    this.save(); // persist to localStorage
  }
}
