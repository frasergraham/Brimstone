// Campaign state management — persistence, roster, resources, progression.
// Stored in localStorage; optionally synced to server for verified users.

import { countHeldNodes } from '../game.js';
import { getFaction } from '../factions.js';
import { hexDistance } from '../hex.js';
import { EntityType } from '../entities.js';
import { isRiver, hasBuilding } from '../tiles.js';

// v1: initial campaign save format.
// v2 (Phase 4 of units/items/abilities refactor): BRAWLER / STURDY
// passives were un-baked from SURVIVOR_ROSTER base stats. Pre-v2
// campaign saves carry the pre-refactor baked `attack`/`defense` numbers
// plus a singular `ability` string; loading one onto a new Entity would
// double-count the passive via getAttack()/getDefense() composition.
// Campaign.load() drops saves at lower versions; a brand-new campaign
// starts in their place.
// v3: insertion of `long_watch` between `dark_ritual` and `witchs_trail`.
// `witchs_trail.requires` changes from ['dark_ritual'] → ['long_watch'], so a
// v2 save mid-campaign at `witchs_trail` would brick (prereq never satisfied,
// no in-progress mission to launch). Migration shim in `_migrate()` backfills
// `long_watch` into completedMissions for those saves.
const SAVE_VERSION = 3;

/**
 * Serialize a survivor entity into a plain object for campaign roster storage.
 * Captures all fields needed to reconstruct the entity between missions.
 *
 * Permanent effects (duration === 'permanent') carry over between missions —
 * these are typically traits earned mid-campaign. Mission- and round-scoped
 * effects are deliberately dropped: they belong to a single deployment and
 * shouldn't shape the next mission's starting roster.
 */
export function snapshotSurvivor(entity) {
  const permanentEffects = Array.isArray(entity.effects)
    ? entity.effects.filter(e => e.duration === 'permanent').map(e => ({ ...e }))
    : [];
  return {
    name:         entity.name,
    title:        entity.title,
    bio:          entity.bio,
    abilities:    Array.isArray(entity.abilities) ? [...entity.abilities] : [],
    abilityLabel: entity.abilityLabel,
    color:        entity.color,
    hp:           entity.hp,
    maxHp:        entity.maxHp,
    attack:       entity.attack,
    defense:      entity.defense,
    weapon:       entity.weapon,
    items:        { ...entity.items },
    effects:      permanentEffects,
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
    case 'witch_score_threshold': {
      // Fails when the witch accumulates `points` node-score points (multiplayer-style).
      if ((state.nodeScore?.witch ?? 0) < cond.points) return null;
      return {
        winner: 'witch',
        winReason: cond.reason || 'The witch has held the nodes too long.',
        log: '🌑 The ritual has reached its climax.',
      };
    }
    default:
      // Mission def referenced an unknown condition type — soft-fail with a
      // warning so the mission becomes silently un-losable rather than crashing
      // the game, but the typo still surfaces in dev consoles + tests.
      console.warn(`[campaign] Unknown lose condition type: ${cond.type}`);
      return null;
  }
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
        (e.type === EntityType.PALADIN || e.type === EntityType.SURVIVOR)
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
    case 'hero_holds_all_nodes': {
      // Win when every power node is hero-controlled at the target phase.
      // Pair with `witch_holds_node` lose to flag any non-hero state as defeat.
      if (cond.phase && state.phase !== cond.phase) return null;
      if (!state.witchObjectives || state.witchObjectives.length === 0) return null;
      if (countHeldNodes('hero', state.witchObjectives, state.entities)
          !== state.witchObjectives.length) return null;
      return {
        winner: 'hero',
        winReason: cond.reason || 'You hold every node at dawn.',
        log: '☀ Every node bears your banner at first light.',
      };
    }
    case 'control_nodes':
      // Standard node scoring — delegate to existing logic (return null to let it run)
      return DEFERRED;
    case 'conductor_complete':
      // MissionConductor handles completion directly — never auto-trigger victory
      return DEFERRED;
    default:
      // Mission def referenced an unknown condition type — soft-fail with a
      // warning. Avoids silently un-winnable missions on a typo.
      console.warn(`[campaign] Unknown win condition type: ${cond.type}`);
      return null;
  }
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
      if (isRiver(tile)) continue;
      if (hasBuilding(tile)) continue;
      edges.push(tile);
    }
    if (edges.length === 0) return null;
    const t = edges[Math.floor(Math.random() * edges.length)];
    return { col: t.col, row: t.row };
  }
  if (spawnAt === 'near_hero') {
    // Spawn on a passable tile close enough for the hero to see on spawn, but
    // not adjacent. Hero day-phase sight is 3; target an annulus of 2–3 hexes.
    const hero = state.hero;
    if (!hero) return null;
    const isPassable = (tile) =>
      !isRiver(tile) && !hasBuilding(tile);
    const isOccupied = (col, row) =>
      state.entities.some(e => e.alive && e.col === col && e.row === row);
    const pickFrom = (minDist, maxDist) => {
      const candidates = [];
      for (const [, tile] of state.tiles) {
        if (!isPassable(tile)) continue;
        if (isOccupied(tile.col, tile.row)) continue;
        const d = hexDistance(tile.col, tile.row, hero.col, hero.row);
        if (d >= minDist && d <= maxDist) candidates.push(tile);
      }
      return candidates;
    };
    // Prefer 2–3 hexes (visible but not adjacent). Widen if we must.
    let candidates = pickFrom(2, 3);
    if (candidates.length === 0) candidates = pickFrom(1, 4);
    if (candidates.length === 0) return null;
    const t = candidates[Math.floor(Math.random() * candidates.length)];
    return { col: t.col, row: t.row };
  }
  return null;
}

// ── Carried hero loadout ─────────────────────────────────────────────────────

/**
 * Apply a campaign's carried-over hero loadout onto a freshly created leader.
 *
 * The leader is built via Faction.createLeader (so it already holds its
 * faction starting weapon — the Paladin's sword). We only override the weapon
 * when the campaign actually carries one: a null/absent carried weapon KEEPS
 * the starting weapon rather than disarming the hero. (Pre-overhaul saves and
 * the old default stored weapon:null, which would otherwise strip the new
 * starting sword on every mission load.) Uses equipWeapon so the
 * weapon-derived range stays in sync.
 *
 * @param {Entity} hero        the freshly created hero leader
 * @param {object} heroStats   { hp, weapon, items } carried by the campaign
 */
export function applyCarriedHeroLoadout(hero, heroStats) {
  if (!hero || !heroStats) return;
  if (typeof heroStats.hp === 'number') hero.hp = Math.min(heroStats.hp, hero.maxHp);
  if (heroStats.weapon) hero.equipWeapon(heroStats.weapon);
  hero.items = { ...(heroStats.items || {}) };
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
    this.heroStats         = { hp: 14, maxHp: 14, attack: 2, defense: 2, weapon: 'sword', items: {} };
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

  /** Load from localStorage. Returns true if a save was found and is compatible. */
  load() {
    const raw = localStorage.getItem(`brimstone-${this.saveSlot}`);
    if (!raw) return false;
    const data = JSON.parse(raw);
    // Pre-v2 saves (Phase-4 baked-stats era) cannot be migrated and are dropped;
    // anything v2+ goes through _migrate() to bring it forward.
    const savedVersion = data.version ?? 1;
    if (savedVersion < 2) {
      localStorage.removeItem(`brimstone-${this.saveSlot}`);
      return false;
    }
    const migrated = _migrate(data, savedVersion);
    this.version           = migrated.version;
    this.currentMission    = migrated.currentMission ?? this.campaignDef.firstMission;
    this.completedMissions = new Set(migrated.completedMissions ?? []);
    this.roster            = migrated.roster ?? [];
    this.resources         = { wood: 0, metal: 0, herbs: 0, food: 0, silver: 0, scripture: 0, ...migrated.resources };
    this.heroStats         = migrated.heroStats ?? { hp: 14, maxHp: 14, attack: 2, defense: 2, weapon: 'sword', items: {} };
    this.storyFlags        = migrated.storyFlags ?? {};
    this.updatedAt         = migrated.updatedAt ?? Date.now();
    // Persist the migrated form so we don't re-migrate every load.
    if (migrated.version !== savedVersion) this.save();
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

  /**
   * Check if all missions in this campaign are completed.
   * Returns false for a campaign with no missions defined — an empty missions
   * array isn't "complete", it's unpopulated (e.g. a Coming Soon chapter).
   */
  isComplete() {
    if (this.campaignDef.missions.length === 0) return false;
    return this.campaignDef.missions.every(m => this.completedMissions.has(m.id));
  }

  /**
   * Check if a campaign is completed by loading its save.
   * Returns true only if a save exists and every mission is completed.
   */
  static isCampaignCompleted(campaignDef) {
    return Campaign.getCampaignProgress(campaignDef).status === 'completed';
  }

  /** Count of missions completed so far in this campaign. */
  getCompletedCount() {
    return this.campaignDef.missions.filter(m => this.completedMissions.has(m.id)).length;
  }

  /** Total number of missions in this campaign. */
  getMissionCount() {
    return this.campaignDef.missions.length;
  }

  /**
   * Get a summary of this campaign's progress status.
   * Returns one of: 'completed', 'in-progress', 'new'.
   */
  getStatus() {
    if (this.isComplete()) return 'completed';
    if (this.getCompletedCount() > 0) return 'in-progress';
    return 'new';
  }

  /**
   * Inspect the saved progress for a campaign without keeping an instance around.
   * Returns { status, completed, total } where status is 'completed' | 'in-progress' | 'new'.
   * If no save exists, returns status 'new' with completed=0.
   */
  static getCampaignProgress(campaignDef) {
    const c = new Campaign(campaignDef);
    const loaded = c.load();
    const total = c.getMissionCount();
    if (!loaded) return { status: 'new', completed: 0, total };
    return { status: c.getStatus(), completed: c.getCompletedCount(), total };
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

  /** Restore campaign state from a server-fetched data object.
   *  Returns false if the server save is pre-v2 and must be discarded. */
  restoreFromServerData(data) {
    const savedVersion = data.version ?? 1;
    if (savedVersion < 2) return false;
    const migrated = _migrate(data, savedVersion);
    this.version           = migrated.version;
    this.currentMission    = migrated.currentMission ?? this.campaignDef.firstMission;
    this.completedMissions = new Set(migrated.completedMissions ?? []);
    this.roster            = migrated.roster ?? [];
    this.resources         = { wood: 0, metal: 0, herbs: 0, food: 0, silver: 0, scripture: 0, ...migrated.resources };
    this.heroStats         = migrated.heroStats ?? { hp: 14, maxHp: 14, attack: 2, defense: 2, weapon: 'sword', items: {} };
    this.storyFlags        = migrated.storyFlags ?? {};
    this.updatedAt         = migrated.updatedAt ?? Date.now();
    this.save(); // persist to localStorage
    return true;
  }
}

// ── Save migration ──────────────────────────────────────────────────────────

/**
 * Bring a saved campaign blob forward to SAVE_VERSION.
 * Returns the (possibly mutated) data object with `version` updated.
 *
 * Migrations are additive — each version step preserves player progress
 * where possible rather than wiping the save.
 */
export function _migrate(data, fromVersion) {
  let v = fromVersion;
  let out = data;

  // v2 → v3: a new mission `long_watch` is inserted between `dark_ritual` and
  // `witchs_trail`. Players already on `witchs_trail` would otherwise fail the
  // new prereq check (it now requires `long_watch`) and end up with no
  // launchable mission. Backfill the prereq into completedMissions so the
  // player keeps their progress.
  if (v === 2) {
    const completed = new Set(out.completedMissions ?? []);
    if (out.currentMission === 'witchs_trail' && !completed.has('long_watch')) {
      completed.add('long_watch');
    }
    out = { ...out, completedMissions: [...completed], version: 3 };
    v = 3;
  }

  return out;
}
