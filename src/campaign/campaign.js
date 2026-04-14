// Campaign state management — persistence, roster, resources, progression.
// Stored in localStorage; optionally synced to server for verified users.

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
    if (e.owner !== 'hero' || e.type !== 'survivor') continue;
    deployedNames.add(e.name);
    if (e.alive) deployedSurvivors.push(snapshotSurvivor(e));
  }
  const undeployed = preMissionRoster.filter(s => !deployedNames.has(s.name));
  return [...deployedSurvivors, ...undeployed];
}

/**
 * Build victory/defeat delegate function from mission objectives.
 * Returns a function (state) => { winner, winReason, log } | null.
 */
export function buildVictoryDelegate(objectives) {
  return (state) => {
    // Check lose condition first (may be null for tutorial/conductor missions)
    if (objectives.lose) {
      switch (objectives.lose.type) {
        case 'hero_killed':
          if (state.factionEliminated('hero')) {
            return {
              winner: 'witch',
              winReason: objectives.lose.reason || 'The hero has fallen.',
              log: '💀 The hero has been slain…',
            };
          }
          break;
        case 'rounds_exceeded':
          if (state.round > objectives.lose.rounds) {
            return {
              winner: 'witch',
              winReason: objectives.lose.reason || `Failed to complete the mission in ${objectives.lose.rounds} rounds.`,
              log: `⏳ Time ran out — the mission is lost.`,
            };
          }
          break;
      }
    }
    // Check win condition
    if (objectives.win) {
      switch (objectives.win.type) {
        case 'eliminate_all':
          if (state.entities.filter(e => e.owner === 'witch' && e.alive).length === 0) {
            return {
              winner: 'hero',
              winReason: objectives.win.reason || 'All enemies have been eliminated.',
              log: '☀ Every last enemy has been vanquished!',
            };
          }
          break;
        case 'survive_rounds':
          if (state.round > objectives.win.rounds) {
            return {
              winner: 'hero',
              winReason: objectives.win.reason || `Survived ${objectives.win.rounds} rounds.`,
              log: `☀ You held the line! The darkness recedes… for now.`,
            };
          }
          break;
        case 'reach_hex':
          if (state.hero?.col === objectives.win.col && state.hero?.row === objectives.win.row) {
            return {
              winner: 'hero',
              winReason: objectives.win.reason || 'Reached the objective.',
              log: '☀ The hero has reached the objective!',
            };
          }
          break;
        case 'slay_witch':
          if (state.factionEliminated('witch')) {
            return {
              winner: 'hero',
              winReason: objectives.win.reason || 'The witch has been slain!',
              log: '☀ The witch has been defeated! Caleb\'s Hollow is saved!',
            };
          }
          break;
        case 'control_nodes':
          // Standard node scoring — delegate to existing logic (return null to let it run)
          return null;
        case 'conductor_complete':
          // MissionConductor handles completion directly — never auto-trigger victory
          return null;
      }
    }
    return null; // no victory yet
  };
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

    for (const unit of wave.units) {
      const pos = resolveSpawnPosition(state, unit.spawnAt);
      if (!pos) continue;
      const entity = createEnemyFn(unit.type, pos.col, pos.row);
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
    // Pick a random walkable border hex
    const edges = [];
    for (const [, tile] of state.tiles) {
      if (tile.col === 0 || tile.row === 0 || tile.type === 'river') continue;
      // Rough edge check
      if (tile.col <= 1 || tile.row <= 1) edges.push(tile);
    }
    if (edges.length === 0) return null;
    return edges[Math.floor(Math.random() * edges.length)];
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
