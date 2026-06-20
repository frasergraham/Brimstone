// Campaign state management — persistence, roster, resources, progression.
// Stored in localStorage; optionally synced to server for verified users.

import { countHeldNodes } from '../game.js';
import { ICON } from '../icons.js';
import { getFaction } from '../factions.js';
import { hexDistance } from '../hex.js';
import { EntityType, applyLevel, normalizeItems, getEquippedWeaponIdOf,
         equipWeaponInItems, addItemInItems, removeItemInItems, getItemCountOf } from '../entities.js';
import { SURVIVOR_ROSTER, SURVIVOR_COLORS } from '../content/survivors.js';
import { ITEMS } from '../items.js';
import { isRiver, hasBuilding } from '../tiles.js';
import { hasLineOfSight } from '../actions.js';
import { evaluateUnlock } from './unlock.js';

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
// v4: the guided `tutorial` is folded in as Chapter 1's first mission and "The
// Awakening" (`prologue`) now requires it. A pre-v4 Chapter-1 save predates the
// fold and never recorded `tutorial` as completed (it lived in a separate
// one-mission campaign), so The Awakening would lock. `_migrate()` backfills
// `tutorial` into completedMissions for the Chapter-1 campaign.
//
// v5: Phase 1 of the inventory refactor. The equipped weapon moved from a
// `weapon` string slot on heroStats / each roster unit INTO their `items` dict,
// tagged `{ equipped: true }`; backpack entries changed from `{ id: count }` to
// `{ id: { count, equipped? } }`. `_migrate` folds the legacy `weapon` field in
// and normalizes item counts. (The shared armory pool was still flat then.)
//
// v6: Phase 2 of the inventory refactor. The shared armory pool (`weapons`)
// flattens from `{ id: count }` to the SAME dict-of-objects shape as unit
// backpacks and the live faction inventory (`{ id: { count } }`). `_migrate`
// runs normalizeItems over `weapons`. The campaign `resources` map deliberately
// stays a flat `{ id: N }` numeric map (it is not unified — see main.js boundary
// conversions).
//
// v7: Survivor permadeath memorial. A new `fallen[]` list records survivors who
// died on a COMPLETED (won) mission — they are removed from the roster forever,
// can never be re-found in the discovery pool, and surface in the ⚰ Fallen
// memorial UI. Entries are `{ name, title, level, diedInMission }` (mission id;
// the UI resolves the mission title). Deaths on a LOST/retried mission do NOT
// permakill — the party is restored (existing behaviour). `_migrate` backfills
// `fallen: []` onto pre-v7 saves so no progress is lost.
//
// v8: Persisted active-party (deployed roster) selection. The set of roster
// indices the player marks "active" on the Party Management / Progress screen
// was previously held in memory only (`_activeRosterIndices` in main.js) and
// reset on every reload. A new `activeParty[]` of roster indices rides the
// slot-aware save so each campaign+slot remembers its own deployed squad. The
// stored indices are sanitized on read (`getActiveParty`) — out-of-range entries
// are dropped so a shrunken roster (permadeath) falls back gracefully. `_migrate`
// backfills `activeParty: []` onto pre-v8 saves.
const SAVE_VERSION = 8;

// Fresh-campaign hero loadout. A factory (not a shared literal) so each new
// campaign gets its own object graph — the equipped sword lives in `items`.
function _defaultHeroStats() {
  return {
    hp: 98, maxHp: 98, attack: 2, defense: 2, level: 1, xp: 0,
    items: { sword: { count: 1, equipped: true } },
  };
}

// ── Save slots ────────────────────────────────────────────────────────────────
// Each campaign supports several independent playthroughs ("slots"). The slot
// is the only piece of the localStorage key that varies per save — everything
// else hangs off campaignDef.id. Slot-aware keys look like
// `campaign-<id>-slot<N>`; the legacy unsuffixed `campaign-<id>` form written by
// builds before multi-save is adopted into slot 1 on first read (and left in
// place so older builds keep working).

export const CAMPAIGN_SLOT_COUNT = 3;

/** Coerce an arbitrary slot value into a valid 1..CAMPAIGN_SLOT_COUNT index. */
export function clampSlotIndex(slotIndex) {
  const n = Math.floor(Number(slotIndex));
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > CAMPAIGN_SLOT_COUNT) return CAMPAIGN_SLOT_COUNT;
  return n;
}

/** localStorage save-slot suffix for a campaign + slot index. */
export function campaignSlotSaveSlot(campaignId, slotIndex = 1) {
  return `campaign-${campaignId}-slot${clampSlotIndex(slotIndex)}`;
}

/** Legacy (pre multi-save) unsuffixed save-slot suffix. */
export function legacyCampaignSaveSlot(campaignId) {
  return `campaign-${campaignId}`;
}

// ── Active slot ─────────────────────────────────────────────────────────────
// Which playthrough slot the player last selected/started for a campaign. The
// menu persists this so the Continue card and the Campaign destination resume
// the slot the player actually cares about — not just whichever slot was
// touched most recently by an autosave. Stored as a single small int per
// campaign under its own key; defaults to slot 1 when never set.

/** localStorage key holding the active (last-selected) slot for a campaign. */
export function campaignActiveSlotKey(campaignId) {
  return `brimstone-campaign-${campaignId}-activeSlot`;
}

/**
 * Read the persisted active slot for a campaign, clamped to a valid index.
 * Defaults to slot 1 when never set or unreadable.
 */
export function getActiveSlot(campaignId) {
  try {
    const raw = localStorage.getItem(campaignActiveSlotKey(campaignId));
    return raw == null ? 1 : clampSlotIndex(raw);
  } catch {
    return 1;
  }
}

/**
 * Persist the active slot for a campaign (clamped). Call when the player
 * selects or starts a slot so Continue/Campaign resume the right playthrough.
 */
export function setActiveSlot(campaignId, slotIndex) {
  try {
    localStorage.setItem(campaignActiveSlotKey(campaignId), String(clampSlotIndex(slotIndex)));
  } catch { /* storage unavailable — non-fatal */ }
}

/**
 * Serialize a survivor entity into a plain object for campaign roster storage.
 * Captures all fields needed to reconstruct the entity between missions.
 *
 * Permanent effects (duration === 'permanent') carry over between missions —
 * these are typically traits earned mid-campaign. Mission- and round-scoped
 * effects are deliberately dropped: they belong to a single deployment and
 * shouldn't shape the next mission's starting roster.
 */
// Max weapons a single unit may carry into a mission (one equipped, the rest
// swappable mid-mission). The party screen enforces this when handing weapons
// out of the shared armory.
export const WEAPON_CARRY_CAP = 2;

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
    agility:      entity.agility,
    // Campaign veterancy — carry level + accumulated XP between missions. Before
    // this, static levels evaporated and survivors reset to L1 each mission.
    level:        entity.level || 1,
    xp:           entity.xp || 0,
    // Equipped weapon rides inside `items` (tagged equipped); deep-copy into the
    // canonical shape so the roster snapshot never aliases the live entity.
    items:        normalizeItems(entity.items),
    effects:      permanentEffects,
  };
}

/**
 * Build a roster snapshot (same shape as {@link snapshotSurvivor}) for a named
 * SURVIVOR_ROSTER character — the data-driven path for granting a survivor as a
 * mission reward without spinning up a live Entity. Stats are the roster base
 * (level 1, full HP, no carried items). Returns `null` for an unknown name.
 *
 * @param {string} name   exact SURVIVOR_ROSTER `name`.
 * @returns {object|null} snapshot-shaped roster entry, or null if not found.
 */
export function rosterSnapshotFromName(name) {
  const i = SURVIVOR_ROSTER.findIndex(c => c.name === name);
  if (i < 0) return null;
  const char = SURVIVOR_ROSTER[i];
  return {
    name:         char.name,
    title:        char.title,
    bio:          char.bio,
    abilities:    char.ability ? [char.ability] : [],
    abilityLabel: char.abilityLabel,
    color:        SURVIVOR_COLORS[i % SURVIVOR_COLORS.length],
    hp:           char.maxHp,
    maxHp:        char.maxHp,
    attack:       char.attack,
    defense:      char.defense,
    ...(typeof char.agility === 'number' ? { agility: char.agility } : {}),
    level:        1,
    xp:           0,
    items:        {},
    effects:      [],
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
    if (e.isNpc) continue; // scripted conversation NPCs never join the roster
    const f = e.owner ? getFaction(e.owner) : null;
    if (!f?.canDiscoverNPCs()) continue;
    deployedNames.add(e.name);
    if (e.alive) deployedSurvivors.push(snapshotSurvivor(e));
  }
  const undeployed = preMissionRoster.filter(s => !deployedNames.has(s.name));
  return [...deployedSurvivors, ...undeployed];
}

/**
 * Collect the survivors who DIED during a (now-completed) mission, as Fallen
 * memorial entries. Permadeath is recorded ONLY on a WON mission — the caller
 * gates on victory; a lost/retried mission must NOT call this (the party is
 * restored instead).
 *
 * Mirrors the "deployed" detection in {@link reconcileRosterAfterMission}: a
 * dead hero-faction, non-NPC survivor that a discovering faction would track is
 * a permadeath. Each entry is `{ name, title, level, diedInMission }` — the UI
 * resolves the mission title from the id.
 *
 * @param {object[]} entities    state.entities after the mission ended.
 * @param {string}   missionId   the completed mission's id.
 * @returns {{name:string, title:string, level:number, diedInMission:string}[]}
 */
export function collectFallenAfterMission(entities, missionId) {
  const fallen = [];
  const seen = new Set();
  for (const e of entities) {
    if (e.type !== 'survivor') continue;
    if (e.isNpc) continue;            // scripted conversation NPCs never join the roster
    if (e.alive) continue;            // only the dead are mourned
    const f = e.owner ? getFaction(e.owner) : null;
    if (!f?.canDiscoverNPCs()) continue;
    if (seen.has(e.name)) continue;   // dedup by name within this mission
    seen.add(e.name);
    fallen.push({
      name:          e.name,
      title:         e.title ?? null,
      level:         e.level || 1,
      diedInMission: missionId,
    });
  }
  return fallen;
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

/**
 * Resolve a mission's effective witch AI budget bonus. `aiBudgetBonus` is
 * normally a static integer, but a mission may instead declare a DYNAMIC bonus
 * that scales with campaign progress:
 *
 *   "aiBudgetBonus": { "type": "missing_wins", "of": [ids…], "target": N }
 *
 * → bonus = max(0, target − (how many of `of` are already won)). This drives the
 * Long Watch (M6) difficulty: the more neighbouring villages the hero cleared,
 * the fewer extra actions the witch gets — with target 5, 3 villages won ⇒ +2,
 * 4 ⇒ +1, 5 ⇒ +0. Returns 0 for an absent/zero bonus or a null campaign.
 */
export function effectiveAiBudgetBonus(missionDef, campaign) {
  const b = missionDef?.aiBudgetBonus;
  if (b == null) return 0;
  if (typeof b === 'number') return b;
  if (typeof b === 'object' && b.type === 'missing_wins') {
    const of = Array.isArray(b.of) ? b.of : [];
    const target = Number.isFinite(b.target) ? b.target : of.length;
    const won = of.reduce((n, id) => n + (campaign?.completedMissions?.has(id) ? 1 : 0), 0);
    return Math.max(0, target - won);
  }
  return 0;
}

// Sentinel returned by a win condition that should defer to external systems
// (e.g. standard node scoring, conductor missions) instead of resolving now.
const DEFERRED = Symbol('victory-deferred');

function _heroSurvivorCount(state) {
  return state.entities.filter(e => {
    if (!e.alive || e.type !== 'survivor' || !e.owner) return false;
    if (e.isNpc) return false; // scripted NPCs don't count toward objectives
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
          log: '\uE097 The hero has been slain…',
        };
      }
      return null;
    case 'rounds_exceeded':
      if (state.round > cond.rounds) {
        return {
          winner: 'witch',
          winReason: cond.reason || `Failed to complete the mission in ${cond.rounds} rounds.`,
          log: `${ICON.hourglass} Time ran out — the mission is lost.`,
        };
      }
      return null;
    case 'phase_without_survivors':
      if (state.phase === cond.phase && _heroSurvivorCount(state) < cond.survivors) {
        return {
          winner: 'witch',
          winReason: cond.reason || `Night fell before you gathered enough survivors.`,
          log: `${ICON.newMoon} The light fades and you stand alone — the mission is lost.`,
        };
      }
      return null;
    case 'survivors_below':
      // Fails at any time the hero faction has fewer than `count` survivors alive.
      if (_heroSurvivorCount(state) < cond.count) {
        return {
          winner: 'witch',
          winReason: cond.reason || 'A companion has fallen — the party is broken.',
          log: '\uE09D The party is broken.',
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
        log: '\uE024 Dawn breaks and her power still pulses through the grove.',
      };
    }
    case 'witch_score_threshold': {
      // Fails when the witch accumulates `points` node-score points (multiplayer-style).
      if ((state.nodeScore?.witch ?? 0) < cond.points) return null;
      return {
        winner: 'witch',
        winReason: cond.reason || 'The witch has held the nodes too long.',
        log: '\uE024 The ritual has reached its climax.',
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
          log: '\uE021 Every last enemy has been vanquished!',
        };
      }
      return null;
    }
    case 'survive_rounds':
      if (state.round > cond.rounds) {
        return {
          winner: 'hero',
          winReason: cond.reason || `Survived ${cond.rounds} rounds.`,
          log: `${ICON.day} You held the line! The darkness recedes… for now.`,
        };
      }
      return null;
    case 'reach_hex':
      if (state.hero?.col === cond.col && state.hero?.row === cond.row) {
        return {
          winner: 'hero',
          winReason: cond.reason || 'Reached the objective.',
          log: '\uE021 The hero has reached the objective!',
        };
      }
      return null;
    case 'slay_witch':
      if (state.factionEliminated('witch')) {
        return {
          winner: 'hero',
          winReason: cond.reason || 'The witch has been slain!',
          log: '\uE021 The witch has been defeated! Caleb\'s Hollow is saved!',
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
          log: '\uE021 The survivors are safe!',
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
        log: '\uE021 Dawn breaks — you have survived the night.',
      };
    }
    case 'all_party_at_hexes': {
      // Win when every living hero-faction party member (hero + survivors) stands
      // on one of the listed target hexes.
      const partyFaction = cond.faction || 'hero';
      const party = state.entities.filter(e =>
        e.alive && e.owner === partyFaction && !e.isNpc &&
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
        log: '\uE021 The whole party has made it through.',
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
        log: '\uE021 Dawn breaks over silent nodes — the ritual is broken!',
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
        log: '\uE021 Every node bears your banner at first light.',
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
        // Level scaling first (HP/ATK/DEF), so explicit overrides still win.
        if (unit.level) applyLevel(entity, unit.level);
        if (unit.overrides) Object.assign(entity, unit.overrides);
        state.entities.push(entity);
        logs.push(unit.spawnLog ?? `${ICON.newMoon} ${entity.displayName} emerges from the shadows!`);
      }
    }
  }
  return logs;
}

/**
 * Resolve a spawn position descriptor to {col, row}.
 * Exported so the mission-logic GameContext spawns through the same path as
 * processWaves (docs/09 — parity).
 */
export function resolveSpawnPosition(state, spawnAt) {
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
    // Crucially, require an unobstructed LINE OF SIGHT from the tile to the
    // hero — distance alone isn't enough on a forested map, where a 2–3 hex
    // tile can sit behind a tree/wall and the unit would "rise" off-screen.
    // The golem must appear where the player can watch it emerge.
    const hero = state.hero;
    if (!hero) return null;
    const isPassable = (tile) =>
      !isRiver(tile) && !hasBuilding(tile);
    const isOccupied = (col, row) =>
      state.entities.some(e => e.alive && e.col === col && e.row === row);
    const inSight = (tile) =>
      hasLineOfSight(state, tile.col, tile.row, hero.col, hero.row);
    // requireLos: when true, drop tiles the hero can't actually see. Used for
    // the preferred passes; the final fallback drops it so we never fail to
    // spawn on a pathological map.
    const pickFrom = (minDist, maxDist, requireLos) => {
      const candidates = [];
      for (const [, tile] of state.tiles) {
        if (!isPassable(tile)) continue;
        if (isOccupied(tile.col, tile.row)) continue;
        const d = hexDistance(tile.col, tile.row, hero.col, hero.row);
        if (d < minDist || d > maxDist) continue;
        if (requireLos && !inSight(tile)) continue;
        candidates.push(tile);
      }
      return candidates;
    };
    // Prefer 2–3 hexes IN SIGHT (visible but not adjacent). Widen the ring,
    // then — only if the whole map is somehow blocked — drop the LOS gate.
    let candidates = pickFrom(2, 3, true);
    if (candidates.length === 0) candidates = pickFrom(1, 4, true);
    if (candidates.length === 0) candidates = pickFrom(1, 4, false);
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
 * faction starting weapon — the Paladin's sword — equipped inside its items).
 * We only replace the backpack when the campaign actually carries an equipped
 * weapon: a carried loadout with NO equipped weapon KEEPS the starting weapon
 * rather than disarming the hero. (Pre-overhaul saves and the old default
 * stored weapon:null / an empty pack, which would otherwise strip the new
 * starting sword on every mission load.)
 *
 * @param {Entity} hero        the freshly created hero leader
 * @param {object} heroStats   { hp, items } carried by the campaign (items may
 *   carry the equipped weapon as an `{ equipped: true }` entry)
 */
export function applyCarriedHeroLoadout(hero, heroStats) {
  if (!hero || !heroStats) return;
  // Campaign veterancy: restore earned level + accumulated XP first, so the
  // wounded-fraction HP carry below is taken off the LEVELED max. applyLevel is
  // idempotent against the freshly-created hero's L1 base and a no-op at L1
  // (so pre-veterancy saves are unchanged). Mirrors the survivor deploy path.
  hero.xp = heroStats.xp || 0;
  if (heroStats.level > 1) applyLevel(hero, heroStats.level);
  if (typeof heroStats.hp === 'number') {
    if (typeof heroStats.maxHp === 'number' && heroStats.maxHp > 0) {
      // Carry the wounded FRACTION, not the absolute HP. This is scale-
      // invariant: a hero saved at half HP returns at half of the leader's
      // (possibly rescaled) max, so a save written before the HP×DAMAGE_SCALE
      // change resolves to the right amount instead of clamping a 98-HP Paladin
      // down to a stale "14".
      const frac = Math.max(0, Math.min(1, heroStats.hp / heroStats.maxHp));
      hero.hp = Math.max(1, Math.round(hero.maxHp * frac));
    } else {
      // No carried maxHp (older/partial loadout) — treat hp as an absolute.
      hero.hp = Math.min(heroStats.hp, hero.maxHp);
    }
  }
  const carriedItems = normalizeItems(heroStats.items);
  const carriedEquippedId = getEquippedWeaponIdOf(carriedItems);
  if (carriedEquippedId) {
    // Carried loadout includes an equipped weapon — adopt the whole backpack.
    hero.items = carriedItems;
  } else {
    // No carried equipped weapon (legacy / null) — KEEP the innate starting
    // weapon (already equipped by createLeader) and fold in any carried pack
    // items, re-flagging the innate weapon as equipped afterwards.
    const innateId = hero.getEquippedWeaponId();
    hero.items = carriedItems;
    if (innateId) hero.equipWeapon(innateId);
  }
  // Wholesale `hero.items = …` reassignment self-invalidates the equipped-weapon
  // memo cache (it keys on the items-object identity), so no explicit clear here.
}

// ── Campaign class ──────────────────────────────────────────────────────────

export class Campaign {
  /**
   * @param {object} campaignDef  Campaign definition from campaign-registry.
   *   Must include { id, title, missions[], mapBuilders, firstMission }.
   * @param {number} slotIndex    Save slot (1..CAMPAIGN_SLOT_COUNT, default 1).
   */
  constructor(campaignDef, slotIndex = 1) {
    this.campaignDef       = campaignDef;
    this.slotIndex         = clampSlotIndex(slotIndex);
    this.saveSlot          = campaignSlotSaveSlot(campaignDef.id, this.slotIndex);
    this.version           = SAVE_VERSION;
    this.currentMission    = campaignDef.firstMission;
    this.completedMissions = new Set();
    this.roster            = []; // Array of snapshotSurvivor() objects
    // Permadeath memorial: survivors who died on a COMPLETED (won) mission.
    // Entries are { name, title, level, diedInMission }. A fallen survivor is
    // removed from the roster forever and excluded from the discovery pool.
    this.fallen            = [];
    this.resources         = { wood: 0, metal: 0, herbs: 0, food: 0, silver: 0, scripture: 0 };
    this.heroStats         = _defaultHeroStats();
    // Shared armory: weapons not bound to any one unit. Units can stow a spare
    // weapon here (returnWeaponToInventory) and any unit can draw from it
    // (equipFromInventory) — so a weapon looted by one survivor can be handed to
    // another between missions. Shape: { weaponId: { count } } — the same
    // dict-of-objects shape as unit backpacks and the live faction inventory.
    this.weapons           = {};
    this.storyFlags        = {};
    // Persisted active-party selection: roster indices the player has marked
    // "active" (deployed) on the Party Management / Progress screen. Held here so
    // it round-trips through save()/load() per campaign+slot instead of evaporating
    // on reload. Sanitized against the live roster on read via getActiveParty().
    this.activeParty       = [];
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
      fallen:            this.fallen.map(f => ({ ...f })),
      resources:         { ...this.resources },
      weapons:           { ...this.weapons },
      heroStats:         JSON.parse(JSON.stringify(this.heroStats)),
      storyFlags:        { ...this.storyFlags },
      activeParty:       Array.isArray(this.activeParty) ? [...this.activeParty] : [],
      updatedAt:         this.updatedAt,
    };
    localStorage.setItem(`brimstone-${this.saveSlot}`, JSON.stringify(data));
  }

  /** Load from localStorage. Returns true if a save was found and is compatible. */
  load() {
    let raw = localStorage.getItem(`brimstone-${this.saveSlot}`);
    // Backwards-compat: a legacy unsuffixed `campaign-<id>` save (written before
    // multi-save existed) is adopted as slot 1 on first read. One-shot and
    // idempotent — once copied into the slot-1 key it is never consulted again.
    // The legacy key is left in place so older builds keep working.
    if (raw == null && this.slotIndex === 1) {
      const legacyRaw = localStorage.getItem(`brimstone-${legacyCampaignSaveSlot(this.campaignDef.id)}`);
      if (legacyRaw != null) {
        localStorage.setItem(`brimstone-${this.saveSlot}`, legacyRaw);
        raw = legacyRaw;
      }
    }
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
    this.fallen            = Array.isArray(migrated.fallen) ? migrated.fallen : [];
    this.resources         = { wood: 0, metal: 0, herbs: 0, food: 0, silver: 0, scripture: 0, ...migrated.resources };
    this.weapons           = { ...migrated.weapons }; // pre-armory saves → empty pool
    this.heroStats         = migrated.heroStats ?? _defaultHeroStats();
    // Backfill veterancy fields for saves written before XP existed.
    if (this.heroStats.level == null) this.heroStats.level = 1;
    if (this.heroStats.xp == null) this.heroStats.xp = 0;
    this.storyFlags        = migrated.storyFlags ?? {};
    // Persisted active-party selection. Stored as a plain index array; sanitized
    // against the live roster lazily on read (getActiveParty), so a roster that
    // shrank since the save was written degrades gracefully rather than indexing
    // out of bounds.
    this.activeParty       = Array.isArray(migrated.activeParty) ? [...migrated.activeParty] : [];
    this.updatedAt         = migrated.updatedAt ?? Date.now();
    // Persist the migrated form so we don't re-migrate every load.
    if (migrated.version !== savedVersion) this.save();
    return true;
  }

  /** Delete campaign save. */
  delete() {
    localStorage.removeItem(`brimstone-${this.saveSlot}`);
    // Slot 1 owns the legacy unsuffixed key (adopted on migration); clear it too
    // so an explicit delete ("Start Over") isn't resurrected from a stale legacy
    // save on the next load.
    if (this.slotIndex === 1) {
      localStorage.removeItem(`brimstone-${legacyCampaignSaveSlot(this.campaignDef.id)}`);
    }
  }

  /** Check if a save exists in the given slot without fully loading. */
  static exists(campaignDef, slotIndex = 1) {
    const slot = campaignSlotSaveSlot(campaignDef.id, slotIndex);
    if (localStorage.getItem(`brimstone-${slot}`) !== null) return true;
    // Slot 1 also covers a not-yet-migrated legacy save.
    if (clampSlotIndex(slotIndex) === 1 &&
        localStorage.getItem(`brimstone-${legacyCampaignSaveSlot(campaignDef.id)}`) !== null) return true;
    return false;
  }

  /** Get mission definition by ID (from this campaign's missions). */
  getMissionDef(missionId) {
    return this.campaignDef.missions.find(m => m.id === missionId) ?? null;
  }

  /** Get the map builder function for a mission. */
  getMapBuilder(mapBuilderKey) {
    return this.campaignDef.mapBuilders[mapBuilderKey] ?? null;
  }

  /**
   * Build the unlock-evaluation context from current campaign progress (docs/09
   * §5.5). `level` maps to a progression metric — the hero's level if one ever
   * exists, else the number of missions cleared — so `{ level: N }` is meaningful
   * today and auto-upgrades if an XP/level system is added.
   */
  buildUnlockContext() {
    return {
      isCompleted: (id) => this.completedMissions.has(id),
      hasItem: (id) => (this.heroStats?.items?.[id]?.count ?? 0) > 0,
      level: this.heroStats?.level ?? this.getCompletedCount(),
      getFlag: (key) => this.storyFlags?.[key],
      getResource: (key) => this.resources?.[key] ?? 0,
    };
  }

  /**
   * Single source of truth for "can the player launch this mission right now":
   * not already completed, every legacy `requires` entry completed, AND the rich
   * `unlock` criterion (if any) satisfied. Both `isMissionUnlocked()` and the
   * `.available` flag in `getMissionList()` delegate here so the predicate never
   * drifts between the two.
   */
  _canPlayMission(mission) {
    if (this.completedMissions.has(mission.id)) return false;
    if (mission.requires && !mission.requires.every(r => this.completedMissions.has(r))) return false;
    if (mission.unlock != null && !evaluateUnlock(mission.unlock, this.buildUnlockContext())) return false;
    return true;
  }

  /** Whether `mission` is currently available: not done, legacy `requires` all
   *  completed, AND the rich `unlock` criterion (if any) satisfied. */
  isMissionUnlocked(mission) {
    return this._canPlayMission(mission);
  }

  /**
   * The missionDone-style prerequisites still blocking `mission`, or `null` when
   * a blocker is structurally richer than a bare `missionDone` (an `any`/`not`,
   * an array, or a non-missionDone leaf like `level`/`flag`). Used by
   * `_isMissionVisible()` to decide whether a locked mission is "one step away".
   * Returns blocker mission ids drawn from unsatisfied `requires` entries plus
   * unsatisfied top-level / inside-`all` `missionDone` leaves of `unlock`.
   */
  _missionBlockers(mission) {
    const ctx = this.buildUnlockContext();
    const reqMissing = (mission.requires ?? []).filter(r => !this.completedMissions.has(r));
    const unlockMissing = this._unlockMissionBlockers(mission.unlock, ctx);
    if (unlockMissing === null) return null;
    return [...reqMissing, ...unlockMissing];
  }

  /** @returns {string[]|null} unsatisfied missionDone ids from a simple `unlock`
   *  (top-level leaf or a single `all:[]` of leaves), or `null` if the unsatisfied
   *  part is anything richer. An already-satisfied `unlock` yields `[]`. */
  _unlockMissionBlockers(unlock, ctx) {
    if (unlock == null) return [];
    if (evaluateUnlock(unlock, ctx)) return [];
    const leafId = (c) =>
      c && typeof c === 'object' && !Array.isArray(c) &&
      !c.all && !c.any && c.not === undefined && 'missionDone' in c
        ? c.missionDone : undefined;

    const top = leafId(unlock);
    if (top !== undefined) return ctx.isCompleted?.(top) ? [] : [top];

    if (Array.isArray(unlock.all) && !unlock.any && unlock.not === undefined) {
      const missing = [];
      for (const c of unlock.all) {
        const id = leafId(c);
        if (id === undefined) {
          // A non-leaf clause that's still unsatisfied makes the gate non-simple.
          if (!evaluateUnlock(c, ctx)) return null;
          continue;
        }
        if (!ctx.isCompleted?.(id)) missing.push(id);
      }
      return missing;
    }
    return null; // any / not / array-sugar / non-missionDone leaf → not "one step"
  }

  /**
   * Whether a mission row should be SHOWN on the mission list (vs hidden until
   * later). Completed and currently-playable missions are always visible. A
   * locked mission is visible only when it's "one step from playable": its sole
   * remaining blocker is a single missionDone-style prerequisite AND that blocker
   * mission is itself playable right now (the immediate next mission in line).
   */
  _isMissionVisible(mission) {
    if (this.completedMissions.has(mission.id)) return true;
    if (this._canPlayMission(mission)) return true;
    const blockers = this._missionBlockers(mission);
    if (blockers === null || blockers.length !== 1) return false;
    const dep = this.getMissionDef(blockers[0]);
    return !!dep && this._canPlayMission(dep);
  }

  /** Get the next available (unlocked, not completed) mission. */
  getNextMission() {
    for (const mission of this.campaignDef.missions) {
      if (this.isMissionUnlocked(mission)) return mission.id;
    }
    return null; // all missions completed / nothing unlocked yet
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
   * Check if a campaign is completed in ANY save slot (used for chapter
   * prerequisite unlocking). Returns true if a save exists in some slot with
   * every mission completed.
   */
  static isCampaignCompleted(campaignDef) {
    for (let s = 1; s <= CAMPAIGN_SLOT_COUNT; s++) {
      if (Campaign.getCampaignProgress(campaignDef, s).status === 'completed') return true;
    }
    return false;
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
   * Inspect the saved progress for one slot of a campaign without keeping an
   * instance around. Returns { status, completed, total } where status is
   * 'completed' | 'in-progress' | 'new'. If no save exists, returns status 'new'
   * with completed=0.
   */
  static getCampaignProgress(campaignDef, slotIndex = 1) {
    const c = new Campaign(campaignDef, slotIndex);
    const loaded = c.load();
    const total = c.getMissionCount();
    if (!loaded) return { status: 'new', completed: 0, total };
    return { status: c.getStatus(), completed: c.getCompletedCount(), total };
  }

  /**
   * Aggregate progress across all slots — the furthest-along slot wins. Used to
   * summarize a campaign on the chapter-select card where individual slots
   * aren't shown. 'completed' > 'in-progress' > 'new'; ties break on the higher
   * completed count.
   */
  static getAggregateProgress(campaignDef) {
    const rank = { new: 0, 'in-progress': 1, completed: 2 };
    let best = { status: 'new', completed: 0, total: 0 };
    for (let s = 1; s <= CAMPAIGN_SLOT_COUNT; s++) {
      const p = Campaign.getCampaignProgress(campaignDef, s);
      best.total = p.total;
      if (rank[p.status] > rank[best.status] ||
          (rank[p.status] === rank[best.status] && p.completed > best.completed)) {
        best = { status: p.status, completed: p.completed, total: p.total };
      }
    }
    return best;
  }

  /**
   * Rich per-slot summary for the save-slot picker. A slot is `used` when it has
   * a progress save (a fresh "New Game" writes one immediately). When used,
   * reports the mission the player would resume next plus the last-saved time.
   */
  static getSlotSummary(campaignDef, slotIndex = 1) {
    const c = new Campaign(campaignDef, slotIndex);
    const used = c.load();
    const total = c.getMissionCount();
    if (!used) {
      return { slotIndex: c.slotIndex, used: false, status: 'new', completed: 0, total };
    }
    const currentId = c.getNextMission() ?? c.currentMission;
    const def = c.getMissionDef(currentId);
    return {
      slotIndex:           c.slotIndex,
      used:                true,
      status:              c.getStatus(),
      completed:           c.getCompletedCount(),
      total,
      currentMission:      currentId,
      currentMissionTitle: def?.title ?? currentId,
      updatedAt:           c.updatedAt,
    };
  }

  /**
   * Get list of missions with their status for the mission select screen.
   * `available` (can launch now) flows through the single `_canPlayMission()`
   * predicate, so it honors rich `unlock` criteria — not just legacy `requires`.
   * `visible` marks whether the row should be shown at all: completed and
   * playable missions always show; a locked mission shows only when it's the
   * immediate next one ("one step from playable", see `_isMissionVisible`).
   */
  getMissionList() {
    return this.campaignDef.missions.map(m => ({
      id: m.id,
      title: m.title,
      briefing: m.briefing,
      completed: this.completedMissions.has(m.id),
      available: this._canPlayMission(m),
      visible: this._isMissionVisible(m),
      current: m.id === this.currentMission,
    }));
  }

  /**
   * Apply the result of a completed mission.
   * @param {string} missionId
   * @param {object} result - { won, survivors[], resources, heroStats, flags }
   * @returns {{won:boolean, rewards:{survivors:object[], resources:Object<string,number>}}}
   *   On a WIN, `rewards` summarises what the mission GRANTED this run — the
   *   granted survivor snapshots (full icon/stats/abilities, for the debrief's
   *   Rewards section) and the positive resource deltas applied. Empty arrays/
   *   object when the mission has no `rewards` block. On a LOSS, `won:false` and
   *   an empty reward summary (the party is restored — nothing is granted).
   */
  applyMissionResult(missionId, result) {
    // On defeat: no state changes — party is restored to pre-mission state
    if (!result.won) return { won: false, rewards: { survivors: [], resources: {} } };

    const missionDef = this.getMissionDef(missionId);

    this.completedMissions.add(missionId);
    // Data-driven completion fan-out: a mission may also mark other mission ids
    // complete on win (`alsoCompletes: [...]`). Used so beating "The Awakening"
    // after skipping the tutorial still flags the tutorial as done, keeping
    // progression/unlock gates consistent. Idempotent — a Set add is a no-op for
    // an already-completed id.
    if (Array.isArray(missionDef?.alsoCompletes)) {
      for (const id of missionDef.alsoCompletes) {
        if (id) this.completedMissions.add(id);
      }
    }
    this.currentMission = this.getNextMission() ?? missionId;

    // Permadeath: replace roster with only surviving survivors
    if (result.survivors) {
      this.roster = result.survivors.map(s => snapshotSurvivor(s));
    }

    // Permadeath memorial: a survivor who died on this COMPLETED mission is
    // mourned forever — added to `fallen`, excluded from the roster (above),
    // and never re-found in the discovery pool. Only reached on a WIN (this
    // method early-returns on a loss), so a death on a failed/retried mission
    // never permakills. Dedup by name (a fallen survivor can never re-fall).
    if (Array.isArray(result.fallen) && result.fallen.length) {
      this.recordFallen(result.fallen);
    }

    // Carry forward hero stats
    if (result.heroStats) {
      this.heroStats = {
        hp:      result.heroStats.hp,
        maxHp:   result.heroStats.maxHp,
        attack:  result.heroStats.attack,
        defense: result.heroStats.defense,
        // Campaign veterancy carries forward; default to current/L1 when the
        // result predates XP (e.g. conductor missions passing the old heroStats).
        level:   result.heroStats.level ?? this.heroStats.level ?? 1,
        xp:      result.heroStats.xp ?? this.heroStats.xp ?? 0,
        // Equipped weapon rides inside items (tagged equipped); normalize to the
        // canonical shape (tolerates a legacy result blob mid-upgrade).
        items:   normalizeItems(result.heroStats.items),
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

    // Apply mission rewards. Numeric keys top up `resources`; the reserved
    // `survivors` key (an array of { name? } specs) grants roster survivors —
    // the reusable post-mission survivor-reward hook (see grantRewardSurvivors).
    // Granting runs AFTER the roster is rebuilt above so the new ally survives
    // the permadeath reconcile, and after the heal bonus so a freshly-granted
    // survivor starts at full HP rather than over-healed.
    //
    // `rewardSummary` captures what was granted so the caller (the debrief)
    // can SHOW it — the granted survivor snapshots (rendered as full cards) and
    // the positive resource deltas applied this run.
    const rewardSummary = { survivors: [], resources: {} };
    if (missionDef?.rewards) {
      for (const [key, val] of Object.entries(missionDef.rewards)) {
        if (key === 'survivors') continue; // handled below — not a resource
        this.resources[key] = (this.resources[key] ?? 0) + val;
        if (val) rewardSummary.resources[key] = val;
      }
      if (Array.isArray(missionDef.rewards.survivors)) {
        rewardSummary.survivors = this.grantRewardSurvivors(missionDef.rewards.survivors);
      }
    }

    // Update story flags
    if (result.flags) {
      Object.assign(this.storyFlags, result.flags);
    }

    this.save();

    return { won: true, rewards: rewardSummary };
  }

  /**
   * Grant survivors as a post-mission reward — the reusable data-driven hook
   * behind a mission's `rewards.survivors` block. Each spec is `{ name? }`:
   *   • a named spec adds THAT SURVIVOR_ROSTER character (so a mission can
   *     promise a specific ally);
   *   • a nameless / unknown-name spec adds a RANDOM roster character not
   *     already in the party or fallen (so "a new survivor joins you" works
   *     regardless of who was discovered mid-mission).
   * Already-rostered and permadead (fallen) survivors are never granted, so the
   * reward never duplicates a party member or resurrects a mourned one. Does NOT
   * save on its own — the caller (applyMissionResult) persists afterward.
   *
   * @param {{name?:string}[]} specs
   * @returns {object[]} the roster snapshots actually granted (in order) — the
   *   same objects pushed onto `roster`, so the debrief can render each as a full
   *   survivor card (icon/stats/abilities) without re-deriving from the name.
   */
  grantRewardSurvivors(specs) {
    if (!Array.isArray(specs)) return [];
    const granted = [];
    // Names already spoken for: current party + the mourned dead + any granted
    // earlier in this same call — so repeated nameless specs draw distinct allies.
    const taken = new Set([
      ...this.roster.map(s => s.name),
      ...this.fallen.map(f => f.name),
    ]);
    for (const spec of specs) {
      let snapshot = null;
      const wanted = spec?.name;
      if (wanted && !taken.has(wanted)) {
        snapshot = rosterSnapshotFromName(wanted);
      }
      if (!snapshot) {
        // Random pick from roster characters not already taken.
        const candidates = SURVIVOR_ROSTER
          .map(c => c.name)
          .filter(n => !taken.has(n));
        if (candidates.length === 0) continue; // roster exhausted — nothing to grant
        const name = candidates[Math.floor(Math.random() * candidates.length)];
        snapshot = rosterSnapshotFromName(name);
      }
      if (!snapshot) continue;
      taken.add(snapshot.name);
      this.roster.push(snapshot);
      granted.push(snapshot);
    }
    return granted;
  }

  /**
   * Append survivors to the Fallen memorial, deduped by name. A survivor only
   * ever falls once — if their name is already in `fallen` (or, defensively, if
   * they somehow still sit in the roster) the new entry is ignored. Does NOT
   * persist on its own; callers (applyMissionResult) save after.
   *
   * @param {{name:string, title?:string, level?:number, diedInMission:string}[]} entries
   */
  recordFallen(entries) {
    if (!Array.isArray(entries)) return;
    const known = new Set(this.fallen.map(f => f.name));
    for (const e of entries) {
      if (!e || !e.name || known.has(e.name)) continue;
      known.add(e.name);
      this.fallen.push({
        name:          e.name,
        title:         e.title ?? null,
        level:         e.level || 1,
        diedInMission: e.diedInMission ?? null,
      });
    }
  }

  /**
   * The set of fallen survivor names — used to exclude them from the
   * hidden-survivor discovery pool so a permadead survivor can never be
   * re-found. Mirrored onto the mission GameState at start (and via state-sync
   * so a mid-mission resume keeps the exclusion).
   * @returns {Set<string>}
   */
  fallenSurvivorNameSet() {
    return new Set(this.fallen.map(f => f.name));
  }

  /**
   * Sanitize an arbitrary list of roster indices against the current roster:
   * coerce to integers, drop anything out of range, and de-duplicate while
   * preserving order. The single chokepoint for "which indices are valid right
   * now" — shared by setActiveParty (write) and getActiveParty (read) so a
   * roster that shrank (permadeath) can never surface a stale index.
   * @param {number[]} indices
   * @returns {number[]} valid, unique roster indices in original order.
   */
  _sanitizeRosterIndices(indices) {
    if (!Array.isArray(indices)) return [];
    const size = Array.isArray(this.roster) ? this.roster.length : 0;
    const seen = new Set();
    const out = [];
    for (const raw of indices) {
      const i = Math.floor(Number(raw));
      if (!Number.isFinite(i) || i < 0 || i >= size) continue;
      if (seen.has(i)) continue;
      seen.add(i);
      out.push(i);
    }
    return out;
  }

  /**
   * Record the player's active-party (deployed roster) selection and persist it.
   * Indices are sanitized against the current roster before storing, so the saved
   * blob never carries an out-of-range or duplicate index. Persists immediately
   * (the screen mutates one unit at a time, like the heal/equip helpers).
   * @param {number[]} indices  roster indices to mark active/deployed.
   */
  setActiveParty(indices) {
    this.activeParty = this._sanitizeRosterIndices(indices);
    this.save();
  }

  /**
   * The persisted active-party selection, sanitized against the current roster
   * and clamped to `maxActive`. Sanitizing on read (not just on write) means a
   * save written before the roster shrank — or one loaded from another build —
   * degrades gracefully to whatever indices still exist.
   * @param {number} [maxActive]  optional cap (e.g. the mission/screen squad cap).
   * @returns {number[]} valid active roster indices, length ≤ maxActive.
   */
  getActiveParty(maxActive = Infinity) {
    const valid = this._sanitizeRosterIndices(this.activeParty);
    const cap = Number.isFinite(maxActive) ? Math.max(0, Math.floor(maxActive)) : valid.length;
    return valid.slice(0, cap);
  }

  /**
   * Heal one party member with a single herb, BETWEEN missions.
   *
   * This is the campaign-landing analogue of the mid-mission `executeHeal`
   * action — but it can't reuse that one (it is sealed-resolution and operates
   * on a live GameState's faction inventory). Here we decrement the shared
   * campaign `resources.herbs`, roll 2×1d10 (between-mission ops aren't
   * deterministic like in-mission resolution, so plain Math.random is fine),
   * clamp the result to the unit's maxHp, and persist.
   *
   * @param {number|'leader'} rosterIndex  Index into `this.roster`, or the
   *   sentinel `'leader'` to heal the hero/Paladin (`this.heroStats`).
   * @returns {number|null}  The unit's new hp, or `null` if the heal was a
   *   no-op (no herbs, unknown unit, or already at full health).
   */
  healUnitWithHerb(rosterIndex) {
    if ((this.resources.herbs ?? 0) < 1) return null;
    const unit = rosterIndex === 'leader' ? this.heroStats : this.roster[rosterIndex];
    if (!unit || unit.hp >= unit.maxHp) return null;
    const roll = (Math.floor(Math.random() * 10) + 1) + (Math.floor(Math.random() * 10) + 1);
    this.resources.herbs -= 1;
    unit.hp = Math.min(unit.maxHp, unit.hp + roll);
    this.save();
    return unit.hp;
  }

  /**
   * Set a roster unit's equipped weapon from its own backpack — the
   * between-mission counterpart to the in-mission equip action.
   *
   * Post-inventory-refactor this is a pure tag flip: the equipped weapon lives
   * inside the unit's `items` dict tagged `{ equipped: true }`, so equipping a
   * spare just moves the flag — both the old and new weapons stay in the
   * backpack at their existing counts (nothing is consumed or lost).
   *
   * @param {number|'leader'} rosterIndex  roster index, or 'leader' for the hero.
   * @param {string} weaponId  weapon id to equip; must be a weapon already in
   *   the unit's backpack (`items`). Equipping the already-equipped weapon is a
   *   no-op.
   * @returns {string|null}  the newly equipped weapon id, or `null` on no-op
   *   (unknown unit, not a weapon, not carried, or already equipped).
   */
  equipWeaponForUnit(rosterIndex, weaponId) {
    const unit = rosterIndex === 'leader' ? this.heroStats : this.roster[rosterIndex];
    if (!unit) return null;
    if (ITEMS[weaponId]?.kind !== 'weapon') return null;
    const items = unit.items ?? (unit.items = {});
    if (getEquippedWeaponIdOf(items) === weaponId) return null; // already equipped
    if ((items[weaponId]?.count ?? 0) < 1) return null; // not in this unit's backpack
    equipWeaponInItems(items, weaponId); // flag it, clear the prior equipped entry
    this.save();
    return weaponId;
  }

  /**
   * Move a spare weapon out of a unit's backpack and into the shared armory
   * (`this.weapons`) — the inverse direction of {@link equipFromInventory}, so
   * weapons can flow back and forth between a unit and the shared pool. Operates
   * on a *carried* (backpack) weapon, never the equipped one: an equipped weapon
   * is freed by equipping a different one first (the old one drops to the
   * backpack), which keeps the equipped slot — and the Paladin's default-weapon
   * fallback — from being silently emptied.
   *
   * @param {number|'leader'} rosterIndex  roster index, or 'leader' for the hero.
   * @param {string} weaponId  weapon id carried in the unit's backpack (`items`).
   * @returns {string|null}  the pooled weapon id, or `null` on no-op (unknown
   *   unit, not a weapon, or not carried by this unit).
   */
  returnWeaponToInventory(rosterIndex, weaponId) {
    const unit = rosterIndex === 'leader' ? this.heroStats : this.roster[rosterIndex];
    if (!unit) return null;
    if (ITEMS[weaponId]?.kind !== 'weapon') return null;
    const items = unit.items ?? (unit.items = {});
    const entry = items[weaponId];
    const count = entry?.count ?? 0;
    // Only a *spare* copy may flow to the pool — never the wielded one. A spare
    // is a non-equipped entry, or the equipped weapon held in multiples.
    const spareCount = entry?.equipped ? count - 1 : count;
    if (spareCount < 1) return null;
    if (entry.equipped || count - 1 > 0) entry.count = count - 1; // keep entry (+ equipped flag) for the remaining copy
    else delete items[weaponId];
    this.weapons = { ...(this.weapons || {}) };
    addItemInItems(this.weapons, weaponId, 1);
    this.save();
    return weaponId;
  }

  /**
   * Equip a weapon drawn from the shared armory (`this.weapons`) onto a unit —
   * the inverse direction of {@link returnWeaponToInventory}. Non-destructive:
   * the unit's previously-equipped weapon (if any) is returned to the shared
   * pool, so no gear is ever lost in a swap. This is what lets a weapon looted
   * by one survivor be handed to another between missions.
   *
   * @param {number|'leader'} rosterIndex  roster index, or 'leader' for the hero.
   * @param {string} weaponId  weapon id present in the shared pool.
   * @returns {string|null}  the newly equipped weapon id, or `null` on no-op
   *   (unknown unit, not a weapon, already equipped, or not in the pool).
   */
  equipFromInventory(rosterIndex, weaponId) {
    const unit = rosterIndex === 'leader' ? this.heroStats : this.roster[rosterIndex];
    if (!unit) return null;
    if (ITEMS[weaponId]?.kind !== 'weapon') return null;
    const items = unit.items ?? (unit.items = {});
    if (getEquippedWeaponIdOf(items) === weaponId) return null; // already equipped
    // Deep-clone the pool (dict-of-objects) so we mutate a fresh copy, never the
    // live `this.weapons` nested entries, before reassigning at the end.
    const pool = normalizeItems(this.weapons);
    if (getItemCountOf(pool, weaponId) < 1) return null; // not in the shared pool
    removeItemInItems(pool, weaponId, 1);
    // Return the outgoing equipped weapon (one copy) to the shared pool —
    // non-destructive. Remove one copy from items; if it was the last copy the
    // entry disappears, else an (unequipped) spare remains.
    const prevId = getEquippedWeaponIdOf(items);
    if (prevId) {
      const prevEntry = items[prevId];
      if ((prevEntry.count ?? 0) > 1) prevEntry.count -= 1;
      else delete items[prevId];
      addItemInItems(pool, prevId, 1);
    }
    // Bank the drawn weapon into the unit's items and flag it equipped
    // (equipWeaponInItems also clears any stale equipped flag left above).
    addItemInItems(items, weaponId, 1);
    equipWeaponInItems(items, weaponId);
    this.weapons = pool;
    this.save();
    return weaponId;
  }

  /**
   * Carry an extra weapon from the shared armory into a unit's backpack WITHOUT
   * displacing the current one — a unit may hold up to {@link WEAPON_CARRY_CAP}
   * weapons and switch between them mid-mission. Auto-equips when it's the unit's
   * first weapon. No-op when the unit is already at capacity, the id isn't a
   * weapon, or it isn't in the shared pool.
   * @param {number|'leader'} rosterIndex  roster index, or 'leader' for the hero.
   * @param {string} weaponId  weapon id present in the shared pool.
   * @returns {{success:boolean, weaponId?:string, reason?:string}}
   */
  carryFromInventory(rosterIndex, weaponId) {
    const unit = rosterIndex === 'leader' ? this.heroStats : this.roster[rosterIndex];
    if (!unit) return { success: false };
    if (ITEMS[weaponId]?.kind !== 'weapon') return { success: false };
    const items = unit.items ?? (unit.items = {});
    const carried = Object.entries(items).reduce((sum, [id, e]) =>
      sum + (ITEMS[id]?.kind === 'weapon' ? (e?.count ?? 0) : 0), 0);
    if (carried >= WEAPON_CARRY_CAP) return { success: false, reason: 'full' };
    const pool = normalizeItems(this.weapons);
    if (getItemCountOf(pool, weaponId) < 1) return { success: false };
    removeItemInItems(pool, weaponId, 1);
    addItemInItems(items, weaponId, 1);
    if (!getEquippedWeaponIdOf(items)) equipWeaponInItems(items, weaponId);
    this.weapons = pool;
    this.save();
    return { success: true, weaponId };
  }

  /**
   * Take a unit's *equipped* weapon off entirely and bank it in the shared
   * armory (`this.weapons`) without equipping a replacement — the missing
   * direction alongside {@link equipFromInventory} (pool → equipped) and
   * {@link returnWeaponToInventory} (backpack → pool). Used to rearrange
   * loadouts between missions: a leader can drop a weapon into the pool for
   * another unit to take, leaving themselves unarmed until equipped again.
   *
   * @param {number|'leader'} rosterIndex  roster index, or 'leader' for the hero.
   * @returns {{success:boolean, weaponId?:string}}  `{ success:true, weaponId }`
   *   on success, or `{ success:false }` when there's nothing equipped to
   *   remove (or the unit is unknown).
   */
  unequipToInventory(rosterIndex) {
    const unit = rosterIndex === 'leader' ? this.heroStats : this.roster[rosterIndex];
    if (!unit) return { success: false };
    const items = unit.items ?? {};
    const weaponId = getEquippedWeaponIdOf(items);
    if (!weaponId) return { success: false }; // nothing equipped — no-op
    // Bank the wielded copy in the pool. If the unit held a spare of the same
    // weapon, leave it behind as an unequipped backpack entry.
    const entry = items[weaponId];
    if ((entry.count ?? 0) > 1) { entry.count -= 1; delete entry.equipped; }
    else delete items[weaponId];
    this.weapons = { ...(this.weapons || {}) };
    addItemInItems(this.weapons, weaponId, 1);
    this.save();
    return { success: true, weaponId };
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
      fallen:            this.fallen,
      resources:         this.resources,
      weapons:           this.weapons,
      heroStats:         this.heroStats,
      storyFlags:        this.storyFlags,
      activeParty:       Array.isArray(this.activeParty) ? [...this.activeParty] : [],
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
    this.fallen            = Array.isArray(migrated.fallen) ? migrated.fallen : [];
    this.resources         = { wood: 0, metal: 0, herbs: 0, food: 0, silver: 0, scripture: 0, ...migrated.resources };
    this.weapons           = { ...migrated.weapons }; // pre-armory saves → empty pool
    this.heroStats         = migrated.heroStats ?? _defaultHeroStats();
    // Backfill veterancy fields for saves written before XP existed.
    if (this.heroStats.level == null) this.heroStats.level = 1;
    if (this.heroStats.xp == null) this.heroStats.xp = 0;
    this.storyFlags        = migrated.storyFlags ?? {};
    this.activeParty       = Array.isArray(migrated.activeParty) ? [...migrated.activeParty] : [];
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

  // v3 → v4: the `tutorial` mission is folded into Chapter 1 as its first
  // mission, and "The Awakening" (`prologue`) now requires `tutorial`. A v3
  // Chapter-1 save predates the fold and never recorded `tutorial` as completed,
  // so The Awakening would lock with no way to satisfy the prereq mid-campaign.
  // Backfill `tutorial` so returning players keep their progress (worst case they
  // skip a tutorial they almost certainly already played).
  if (v === 3) {
    const completed = new Set(out.completedMissions ?? []);
    if (out.campaignId === 'calebs_hollow_prologue' && !completed.has('tutorial')) {
      completed.add('tutorial');
    }
    out = { ...out, completedMissions: [...completed], version: 4 };
    v = 4;
  }

  // v4 → v5: the equipped weapon moves from a `weapon` string slot on heroStats
  // and each roster unit INTO their `items` dict, tagged `{ equipped: true }`;
  // backpack entries change from `{ id: count }` to `{ id: { count, equipped? } }`.
  // Fold the legacy `weapon` field in and normalize counts. The shared armory
  // pool (`weapons`) stays a flat `{ id: count }` map — untouched.
  if (v === 4) {
    out = {
      ...out,
      heroStats: out.heroStats ? _migrateUnitInventory(out.heroStats) : out.heroStats,
      roster: Array.isArray(out.roster) ? out.roster.map(_migrateUnitInventory) : out.roster,
      version: 5,
    };
    v = 5;
  }

  // v5 → v6: the shared armory pool (`weapons`) flattens from `{ id: count }` to
  // the dict-of-objects shape `{ id: { count } }` used by unit backpacks and the
  // live faction inventory. normalizeItems folds both forms, so a v5 (numeric)
  // pool and a v6 (already-object) pool both round-trip. `resources` is left
  // alone — it deliberately stays a flat numeric map.
  if (v === 5) {
    out = {
      ...out,
      weapons: normalizeItems(out.weapons),
      version: 6,
    };
    v = 6;
  }

  // v6 → v7: survivor permadeath memorial. Backfill an empty `fallen[]` list —
  // pre-v7 saves predate permadeath tracking, so no one has fallen yet. All
  // other fields are preserved untouched.
  if (v === 6) {
    out = {
      ...out,
      fallen: Array.isArray(out.fallen) ? out.fallen : [],
      version: 7,
    };
    v = 7;
  }

  // v7 → v8: persisted active-party selection. Backfill an empty `activeParty[]`
  // — pre-v8 saves never recorded the deployed squad (it lived in memory only),
  // so on first load the squad re-seeds from the front of the roster as before.
  if (v === 7) {
    out = {
      ...out,
      activeParty: Array.isArray(out.activeParty) ? out.activeParty : [],
      version: 8,
    };
    v = 8;
  }

  return out;
}

/** Fold a pre-v5 unit's `weapon` slot into its `items` dict (new equipped-tag
 *  shape) and normalize backpack counts. Returns a new unit object. */
function _migrateUnitInventory(unit) {
  if (!unit) return unit;
  const items = normalizeItems(unit.items);
  if (unit.weapon) {
    // The legacy slot copy was counted separately from the pack, so bump the
    // count if a spare of the same id already sat in the backpack.
    if (items[unit.weapon]) items[unit.weapon].count = (items[unit.weapon].count ?? 0) + 1;
    else items[unit.weapon] = { count: 1 };
    items[unit.weapon].equipped = true;
  }
  const { weapon, ...rest } = unit;
  return { ...rest, items };
}
