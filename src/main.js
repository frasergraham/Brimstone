// Entry point: wires all modules, setup screen flow, resize
import { GameState, Player } from './game.js';
import { Renderer }          from './renderer.js';
import { UIController, UIMode } from './ui.js';
import { HeroAI, WITCH_PERSONALITIES }   from './ai.js';
import { WitchAIEngine } from './ai-engine.js';
import {
  MultiplayerClient, MirrorState, loadSession, clearSession,
  checkEmailTokenInUrl, requestLinkEmail, requestEmailLogin, fetchIdentities,
} from './multiplayer.js';
import { VERSION, BUILD_VERSION } from './version.js';
import { resolvePlans, ResEventType } from '../server/resolver.js';
import { PlanActionType }    from './planner.js';
import { hexDistance, getNeighbors } from './hex.js';
import { compileTurnBattleSummary } from './battle-utils.js';
import { serializeState, deserializeState } from '../server/state-sync.js';
import { MAP_SIZES } from './map.js';
import { buildTutorialMap, TUTORIAL_WAVES, TUTORIAL_FORCED_DICE } from './tutorial/tutorial-config.js';
import { nodeController } from './game.js';
import { TutorialConductor } from './tutorial.js';
import { createMinion, createZombie, createWoodGolem, createIronGolem, createSurvivor, setForcedDice, EntityType, markRosterUsedByName } from './entities.js';
import { hexKey as _hexKey } from './hex.js';
import { Campaign, buildVictoryDelegate, snapshotSurvivor, processWaves } from './campaign/campaign.js';
import { CAMPAIGNS, getCampaignById } from './campaign/campaign-registry.js';

// Stamp version into badges
document.getElementById('version-badge').textContent = `v${BUILD_VERSION}`;
document.getElementById('menu-version').textContent  = `v${BUILD_VERSION}`;

let state, renderer, ui, witchAI, heroAI;
let _autoplay  = false;
let _resolving = false;           // true while _animateResolutionSteps is running
let _pendingPlanningPhase = null; // buffered onPlanningPhase payload received during animation
let _tutorialConductor = null;    // non-null while a tutorial session is active
let _gameStartTime = null;        // wall-clock timestamp for game duration tracking

// ── Round-history for full-game replay ───────────────────────────────────────
// Accumulated during a session; reset each new/resumed game.
let _roundHistory        = [];  // SP offline:  { roundNum, preState, steps }[]
let _onlineRoundHistory  = [];  // MP online:   { roundNum, preState, steps }[]
let _replayAborted       = false;
let _replayPaused        = false;
let _replayGoBack        = false;   // false | 'curr' | 'prev'
let _replayAtRoundStart  = false;   // true while paused at the pre-animation point of a round
let _replayActive        = false;   // true while _replayFullGame is running
let _replaySpeedMult     = 0.5;     // playback speed multiplier (0.5=play, 1.0=ff, 1.5=vff)
let _replayJumpToEnd     = false;   // true when user wants to skip to the final game state

// ── Local game init ───────────────────────────────────────────────────────────

function _genSaveId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * Shared setup for all local (single-player) game starts.
 * Creates the Renderer, UIController, and wires the callbacks that must be
 * present regardless of whether the game is new or resumed:
 *   - onQuitToMenu  → reload the page (returns to setup screen)
 *   - AI battle callbacks → show animated battle dialog
 *
 * Called by both init() and _startFromState() so neither can forget a callback.
 */
function _setupLocalUI(canvas, localWitchAI, localHeroAI, autoplay) {
  renderer = new Renderer(canvas, state);
  renderer.resize();
  renderer.loadImages();

  ui = new UIController(canvas, state, renderer, localWitchAI, redraw, localHeroAI, autoplay);
  ui.onQuitToMenu = () => location.reload();

  const battleCallback = (actorSnap, targetSnap, result) =>
    new Promise(resolve => ui._showBattleDialog(actorSnap, targetSnap, result, resolve));
  if (localWitchAI) localWitchAI.onBattleResult = battleCallback;
  if (localHeroAI)  localHeroAI.onBattleResult  = battleCallback;
}

function init(witchIsAI, heroIsAI, autoplay = false) {
  _autoplay = autoplay;
  _gameStartTime = Date.now();
  _tutorialConductor = null; // ensure tutorial state is cleared for normal games
  _roundHistory = [];
  // Assign a fresh save ID for this game (only used for single-player saves)
  _spSaveId = _genSaveId();
  const canvas = document.getElementById('game-canvas');

  document.getElementById('setup-screen').style.display  = 'none';
  document.getElementById('game-screen').style.display   = 'flex';

  const mapSize   = document.getElementById('select-map-size')?.value ?? 'standard';
  const nodeCount = parseInt(document.getElementById('select-node-count')?.value ?? '3', 10);
  state    = new GameState(witchIsAI, heroIsAI, mapSize, nodeCount);
  // Allow global fog-of-war override from the setup screen select.
  const fogSel = document.getElementById('select-fog-of-war');
  if (fogSel) state.fogOfWar = fogSel.value;

  const thinkDelay = autoplay ? 0 : undefined;
  witchAI = witchIsAI ? new WitchAIEngine(state, redraw, thinkDelay) : null;
  heroAI  = heroIsAI  ? new HeroAI(state, redraw, thinkDelay)  : null;

  _setupLocalUI(canvas, witchAI, heroAI, autoplay);

  redraw();

  requestAnimationFrame(() => {
    // Resize now that game-screen layout is complete and the canvas has real dimensions.
    renderer.resize();
    // Re-frame starting units with correct dimensions (overrides the one queued in
    // enterPlanningMode which fired before layout was resolved).
    if (!_autoplay) {
      const humanFaction = !state.heroIsAI ? 'hero' : 'witch';
      const startUnits = state.entities.filter(e => e.alive && e.owner === humanFaction);
      if (startUnits.length > 0) {
        renderer.frameHexes(startUnits, { maxZoom: 1.8, paddingHexes: 2.5, duration: 550 });
      }
    }
    redraw();
  });

  _startLocalPlanningPhase();
}

function redraw() {
  renderer.draw();
  if (ui) ui._updateSidebar?.();
}

/** Record game stats to server (falls back to localStorage if unavailable). */
function _recordLocalGameStats() {
  if (!state || !state.gameOver) return;
  const stats = {
    id:                crypto.randomUUID(),
    mode:              'local',
    game_version:      VERSION,
    map_size:          state.mapSize || 'standard',
    winner:            state.winner,
    win_reason:        state.winReason,
    rounds:            state.round,
    final_phase:       state.phase,
    hero_score:        state.nodeScore?.hero  || 0,
    witch_score:       state.nodeScore?.witch || 0,
    hero_kills:        state.heroKills  || 0,
    witch_kills:       state.witchKills || 0,
    hero_survivors:    state.entities.filter(e => e.owner === 'hero' && e.type === 'survivor').length,
    witch_summons:     state.witchSummonCount || 0,
    hero_personality:  heroAI?.constructor?.name  || null,
    witch_personality: witchAI?.constructor?.name || null,
    hero_player_id:    null,
    witch_player_id:   null,
    fog_of_war:        state.fogOfWar !== 'none' ? 1 : 0,
    duration_ms:       _gameStartTime ? Date.now() - _gameStartTime : null,
  };
  fetch('/api/game-stats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(stats),
  }).catch(() => {
    // Server not available — store locally for later
    try {
      const local = JSON.parse(localStorage.getItem('brimstone_stats') || '[]');
      local.push(stats);
      localStorage.setItem('brimstone_stats', JSON.stringify(local));
    } catch { /* storage full or unavailable — silently discard */ }
  });
}

/** Record campaign game stats to server (falls back to localStorage). */
function _recordCampaignGameStats() {
  if (!state || !state.gameOver || !_activeCampaign || !_activeMissionDef) return;
  const missionDef = _activeMissionDef;
  const survivorsDeployed = state.entities.filter(
    e => e.owner === 'hero' && e.type === EntityType.SURVIVOR
  ).length;
  const survivorsLost = state.entities.filter(
    e => e.owner === 'hero' && e.type === EntityType.SURVIVOR && !e.alive
  ).length;
  const enemiesSpawned = state.entities.filter(e => e.owner === 'witch').length;
  const stats = {
    id:                 crypto.randomUUID(),
    campaign_id:        _activeCampaign.campaignDef.id,
    mission_id:         missionDef.id,
    mission_title:      missionDef.title || '',
    winner:             state.winner,
    win_reason:         state.winReason || '',
    rounds:             state.round,
    final_phase:        state.phase,
    hero_kills:         state.heroKills  || 0,
    witch_kills:        state.witchKills || 0,
    survivors_deployed: survivorsDeployed,
    survivors_lost:     survivorsLost,
    enemies_spawned:    enemiesSpawned,
    has_witch:          missionDef.hasWitch ? 1 : 0,
    ai_personality:     missionDef.aiPersonality || null,
    map_size:           missionDef.mapSize || 'standard',
    game_version:       VERSION,
    duration_ms:        _gameStartTime ? Date.now() - _gameStartTime : null,
  };
  fetch('/api/campaign-game-stats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(stats),
  }).catch(() => {
    try {
      const local = JSON.parse(localStorage.getItem('brimstone_campaign_stats') || '[]');
      local.push(stats);
      localStorage.setItem('brimstone_campaign_stats', JSON.stringify(local));
    } catch { /* storage full or unavailable — silently discard */ }
  });
}

// ── Tutorial mode ─────────────────────────────────────────────────────────────

function initTutorial() {
  _autoplay  = false;
  _spSaveId  = null; // no save for tutorial
  const canvas = document.getElementById('game-canvas');

  document.getElementById('setup-screen').style.display = 'none';
  document.getElementById('game-screen').style.display  = 'flex';

  // Build the fixed tutorial map and inject it into a new GameState.
  // witchIsAI = false so we can drive the witch plan ourselves via TutorialConductor.
  // noWitch = true so no witch entity is created.
  const mapData = buildTutorialMap();
  state = new GameState(false, false, 'tutorial', null, mapData);

  // Disable fog of war — tutorial should be fully visible.
  state.fogOfWar = 'none';

  // Guarantee a survivor in the HOUSE at (2,3) for the round-3 exploration demo.
  const houseTile = state.tiles.get(_hexKey(2, 3));
  if (houseTile) houseTile.hiddenSurvivor = true;

  // No AI helpers for tutorial — TutorialConductor drives the witch plan.
  witchAI = null;
  heroAI  = null;

  _setupLocalUI(canvas, null, null, false);

  // Suppress phase modals and hero auto-select during the tutorial.
  ui.tutorialMode = true;

  // Wire tutorial callbacks into UIController.
  ui.onPlanActionAdded = (action) => _tutorialConductor?.onActionQueued(action);
  ui.onEntitySelected  = (entity) => _tutorialConductor?.onEntitySelected(entity);

  // Suppress the resolution summary modal — tutorial has its own flow.
  const _origOnPlanSubmit = null; // will be set per-round below

  redraw();

  requestAnimationFrame(() => {
    renderer.resize();
    const heroEntity = state.entities.find(e => e.type === 'hero');
    if (heroEntity) {
      renderer.frameHexes([heroEntity], { maxZoom: 2.2, paddingHexes: 3, duration: 500 });
    }
    redraw();
  });

  // Create conductor after UI is set up so renderer reference is valid.
  _tutorialConductor = new TutorialConductor(state, ui, renderer, redraw);
  _tutorialConductor.start();

  _startLocalPlanningPhase();
}

// ── Local planning lifecycle ──────────────────────────────────────────────────

function _startLocalPlanningPhase() {
  if (!state || state.gameOver) return;
  state.startPlanning();

  if (_autoplay) {
    // AI vs AI: generate both plans immediately then resolve
    setTimeout(() => _runLocalAutoResolution(), 0);
    return;
  }

  // Tutorial mode: hero always plans; conductor provides scripted witch plan.
  if (_tutorialConductor) {
    _tutorialConductor.onPlanningPhaseStart();
    // After round 3 (survivor rescue) the tutorial is in explanation-only mode —
    // no more planning rounds.  We still call onPlanningPhaseStart so the conductor
    // can advance to the explanation steps, but we don't enter planning mode.
    if (_tutorialConductor._round >= 3) return;
    ui.enterPlanningMode('hero', state.heroActionsLeft);
    ui.onPlanSubmit = (heroPlan) => _onTutorialPlanSubmit(heroPlan);
    return;
  }

  const humanFaction = !state.heroIsAI ? 'hero' : 'witch';
  const budget = humanFaction === 'hero' ? state.heroActionsLeft : state.witchActionsLeft;

  if (!state.heroIsAI && !state.witchIsAI) {
    // Human vs Human: hero plans first, then witch
    ui.enterPlanningMode('hero', state.heroActionsLeft);
    ui.onPlanSubmit = (heroPlan) => _onLocalHvHHeroPlan(heroPlan);
  } else {
    // One human vs AI
    ui.enterPlanningMode(humanFaction, budget);
    ui.onPlanSubmit = (plan) => _onLocalHumanPlanSubmit(humanFaction, plan);
  }
}

/**
 * Tutorial plan submit: hero submits, conductor provides scripted witch plan,
 * then both resolve together.  No resolution summary modal is shown.
 */
async function _onTutorialPlanSubmit(heroPlan) {
  ui.exitPlanningMode();
  _tutorialConductor?.onPlanSubmitted();

  // Round 2 (combat round): force deterministic dice so the tutorial can
  // describe the outcome reliably.
  // Hero (ATK 3) attacks Minion (DEF 0): die=6 → atk=9, die=1 → def=1 → crush 2 dmg → kills minion
  if (_tutorialConductor?._round === 1) {
    setForcedDice(...TUTORIAL_FORCED_DICE);
  }

  state.submitPlan('hero', heroPlan);
  const witchPlan = _tutorialConductor ? _tutorialConductor.getWitchPlan() : [];
  state.submitPlan('witch', witchPlan);

  await _runLocalResolution(true /* skipSummary */);
}

/** Human vs Human: hero submitted, now show witch planning. */
async function _onLocalHvHHeroPlan(heroPlan) {
  ui.exitPlanningMode();
  state.submitPlan('hero', heroPlan); // witchPlan not set yet → not both ready

  ui.enterPlanningMode('witch', state.witchActionsLeft);
  ui.onPlanSubmit = async (witchPlan) => {
    ui.exitPlanningMode();
    state.submitPlan('witch', witchPlan); // both ready → resolving = true
    await _runLocalResolution();
  };
}

/** Human submitted their plan; generate AI plan then resolve. */
async function _onLocalHumanPlanSubmit(faction, plan) {
  ui.exitPlanningMode();

  let bothReady = state.submitPlan(faction, plan);
  if (!bothReady) {
    const aiPlan = faction === 'hero'
      ? (witchAI ? witchAI.generatePlan() : [])
      : (heroAI  ? heroAI.generatePlan()  : []);
    const aiFaction = faction === 'hero' ? 'witch' : 'hero';
    bothReady = state.submitPlan(aiFaction, aiPlan);
  }

  if (bothReady) await _runLocalResolution();
}

async function _runLocalAutoResolution() {
  if (!state || state.gameOver) return;
  const heroPlan  = heroAI  ? heroAI.generatePlan()  : [];
  const witchPlan = witchAI ? witchAI.generatePlan() : [];
  state.submitPlan('hero',  heroPlan);
  state.submitPlan('witch', witchPlan);
  await _runLocalResolution();
}

async function _runLocalResolution(skipSummary = false) {
  if (!state || state.gameOver) return;

  // Cap shared food to the human player's enabled food count so the resolver
  // only auto-spends the rations the player actually chose to commit.
  const shared = state.inventory?.shared;
  if (shared && ui?._planFoodEnabled != null) {
    const foodKey = 'food';
    const orig = shared[foodKey] || 0;
    const cap  = Math.min(ui._planFoodEnabled, orig);
    shared[foodKey] = cap;
    // Restore any uncapped food after resolution completes (handled below).
    var _foodOverage = orig - cap;
  }

  // Snapshot state BEFORE resolution for full-game replay
  const _preResolveStateJson = JSON.stringify(serializeState(state));
  const _preResolveRoundNum  = state.round;

  // Snapshot which tiles are explored before resolution so we can defer
  // showing the explored dot until the EXPLORE step is actually animated.
  const preExploredSet = new Set();
  for (const [k, t] of state.tiles) { if (t.explored) preExploredSet.add(k); }

  let steps;
  try {
    steps = resolvePlans(state, state.heroPlan, state.witchPlan);
  } catch (err) {
    console.error('resolvePlans error:', err);
    steps = [];
  }

  // Restore food that wasn't committed.
  if (shared && _foodOverage > 0) {
    const foodKey = 'food';
    shared[foodKey] = (shared[foodKey] || 0) + _foodOverage;
  }

  // resolvePlans has fully mutated state to its final configuration.
  // Hold a reference to the final entity array so we can restore it after animation.
  const finalEntities = state.entities;

  // Snapshot post-resolution explored flags, then revert to pre-resolution state
  // so the explored dot only appears when the EXPLORE step is actually animated.
  const postExplored = new Map();
  for (const [k, t] of state.tiles) postExplored.set(k, t.explored);
  for (const [k, t] of state.tiles) {
    if (t.explored && !preExploredSet.has(k)) t.explored = false;
  }

  const humanFaction = !state.heroIsAI ? 'hero' : !state.witchIsAI ? 'witch' : null;
  const preReplayEntities = steps[0]?.entitySnapshot ?? finalEntities;

  // Snapshot node control BEFORE resolution so we can detect changes from unit movement
  const preResEntities = steps[0]?.entitySnapshot ?? state.entities;
  const prevNodes = state.witchObjectives.map(obj => ({
    col: obj.col, row: obj.row, label: obj.label,
    owner: nodeController(obj, preResEntities),
  }));

  await _animateResolutionSteps(steps, finalEntities, redraw, humanFaction, null);

  // Restore final explored state after animation completes.
  for (const [k, v] of postExplored) {
    const t = state.tiles.get(k);
    if (t) t.explored = v;
  }

  // Notify tutorial conductor that resolution animation has finished.
  if (_tutorialConductor) _tutorialConductor.onResolutionComplete();

  // Add aggregate battle summary to the log before endRound inserts phase entries
  const summaryLines = compileTurnBattleSummary(steps, state.entities, ResEventType, PlanActionType);
  for (const line of summaryLines) state.log.push(line);
  if (summaryLines.length && ui) ui._renderLog();

  // Snapshot score BEFORE endRound so we can detect scoring changes
  const prevScore = { hero: state.nodeScore.hero, witch: state.nodeScore.witch };

  state.updateNodeDiscovery();
  state.checkAndLogNodeControlChanges();
  state.endRound();

  // Campaign wave spawning: inject new enemies after each round
  if (_activeMissionDef?.waves) {
    const waveLogs = processWaves(state, _activeMissionDef.waves, _createEnemyEntity);
    for (const msg of waveLogs) state.addLog(msg);
  }

  // Tutorial wave spawning: minion appears after round 1
  if (_tutorialConductor) {
    const waveLogs = processWaves(state, TUTORIAL_WAVES, _createEnemyEntity);
    for (const msg of waveLogs) state.addLog(msg);
  }

  if (ui) await ui._triggerPostRoundEffects();
  redraw();

  // Persist single-player progress to localStorage
  _saveSpGame();

  // Accumulate round for full-game replay
  if (!_autoplay) {
    _roundHistory.push({
      roundNum:     _preResolveRoundNum,
      preState:     _preResolveStateJson,
      steps:        JSON.stringify(steps),
      // Save post-resolution entities for the last round so the replay
      // correctly snaps to the outcome (not back to pre-action positions).
      // Captured before endRound() so it reflects combat results only.
      finalEntities: state.gameOver ? finalEntities : undefined,
    });
  }

  // Show post-resolution summary modal (skip in autoplay or tutorial mode)
  if (!_autoplay && !skipSummary && ui && humanFaction) {
    // Finalize game-over immediately — cleanup survives any navigation away
    if (state.gameOver) {
      if (!_activeCampaign) {
        _recordLocalGameStats();
        if (_spSaveId) { _deleteSpSave(_spSaveId); _spSaveId = null; }
        _saveCompletedSpGame(state.winner, state.winReason);
        _uploadSpGame(state.winner, state.winReason);
      }
    }

    // Save game-over state — replay mutates `state` with intermediate round data
    const _goState = { gameOver: state.gameOver, winner: state.winner, winReason: state.winReason };

    let action;
    do {
      action = await ui._showResolutionSummary(steps, state.round - 1, {
        prevScore, prevNodes, humanFaction, fogOfWar: state.fogOfWar,
        gameOver: _goState.gameOver, winner: _goState.winner, winReason: _goState.winReason,
        hasFullReplay: _roundHistory.length > 0,
      });
      if (action === 'replay') {
        state.entities = preReplayEntities;
        // Reset explored flags so they reveal progressively during replay.
        for (const [k, t] of state.tiles) {
          if (t.explored && !preExploredSet.has(k)) t.explored = false;
        }
        redraw();
        await _animateResolutionSteps(steps, finalEntities, redraw, humanFaction, null);
        for (const [k, v] of postExplored) { const t = state.tiles.get(k); if (t) t.explored = v; }
      } else if (action === 'replay-full') {
        await _replayFullGame(_roundHistory, _goState.winner, _goState.winReason,
          state.hero?.displayName ?? 'Hero', state.witch?.displayName ?? 'Witch');
        _doRestart();
        return;
      }
    } while (action === 'replay');
    // Animate score bar changes after summary is dismissed
    ui._animateScoreBar(prevScore, prevNodes);

    if (state.gameOver) {
      // Campaign mission debrief
      if (_activeCampaign && _activeMissionDef) {
        _handleCampaignMissionEnd();
        return;
      }
      if (action === 'restart') {
        _doRestart();
      }
      return;
    }
  } else if (state.gameOver && ui) {
    // Autoplay game-over — still show the summary so the user sees the result
    if (!_activeCampaign) {
      _recordLocalGameStats();
      if (_spSaveId) { _deleteSpSave(_spSaveId); _spSaveId = null; }
      _saveCompletedSpGame(state.winner, state.winReason);
      _uploadSpGame(state.winner, state.winReason);
    }
    // Save game-over state — replay mutates `state` with intermediate round data
    const _goStateAP = { gameOver: true, winner: state.winner, winReason: state.winReason };

    let action;
    do {
      action = await ui._showResolutionSummary(steps, state.round - 1, {
        prevScore, prevNodes, humanFaction: null, fogOfWar: 'none',
        gameOver: true, winner: _goStateAP.winner, winReason: _goStateAP.winReason,
        hasFullReplay: _roundHistory.length > 0,
      });
      if (action === 'replay') {
        state.entities = preReplayEntities;
        for (const [k, t] of state.tiles) {
          if (t.explored && !preExploredSet.has(k)) t.explored = false;
        }
        redraw();
        await _animateResolutionSteps(steps, finalEntities, redraw, null, null);
        for (const [k, v] of postExplored) { const t = state.tiles.get(k); if (t) t.explored = v; }
      } else if (action === 'replay-full') {
        await _replayFullGame(_roundHistory, _goStateAP.winner, _goStateAP.winReason,
          state.hero?.displayName ?? 'Hero', state.witch?.displayName ?? 'Witch');
        _doRestart();
        return;
      }
    } while (action === 'replay');
    if (action === 'restart') {
      _doRestart();
    }
    return;
  } else if (state.gameOver) {
    // No UI (headless) — just clean up
    if (!_activeCampaign) {
      _recordLocalGameStats();
      if (_spSaveId) { _deleteSpSave(_spSaveId); _spSaveId = null; }
      _saveCompletedSpGame(state.winner, state.winReason);
    }
    return;
  }

  if (_autoplay) {
    await _delay(300);
  }
  _startLocalPlanningPhase();
}

/**
 * Fire the visual result animations that follow a battle (HP floaters, death burst).
 * Uses result.damage / result.counterDmg directly so that simultaneous battles in
 * the same step each show only their own damage, not accumulated step damage.
 */
function _playBattleResultAnims(actorSnap, targetSnap, result, redrawFn) {
  renderer.addAttackAnim(actorSnap.col, actorSnap.row, targetSnap.col, targetSnap.row);
  if (result?.damage)      renderer.addHpChangeFlash(targetSnap.col, targetSnap.row, -(result.damage));
  if (result?.counterDmg)  renderer.addHpChangeFlash(actorSnap.col,  actorSnap.row,  -(result.counterDmg));
  if (result?.fortDamaged) renderer.addFlash(targetSnap.col, targetSnap.row, '🏰-1',
    'rgba(120,120,140,0.15)', 1600, 0.65, 'rgba(180,180,200,1)');
  if (result?.killed) {
    const deadColor = targetSnap.owner === 'hero' ? '#d4a72c' : '#9b59b6';
    renderer.addDeathAnim(targetSnap.col, targetSnap.row, deadColor);
  }
  redrawFn();
}

/**
 * Find entities adjacent to a battle that provide gang-up or ally-defence bonuses.
 * Returns the entities (with .col/.row) so the caller can build hex lists.
 */
function _getBattleAllyEntities(actorSnap, targetSnap, entities) {
  return entities.filter(e => {
    if (!e.alive) return false;
    if (e.id === actorSnap.id || e.id === targetSnap.id) return false;
    // Attacker-side ally adjacent to the target (gang-up)
    if (e.owner === actorSnap.owner &&
        hexDistance(e.col, e.row, targetSnap.col, targetSnap.row) <= 1) return true;
    // Defender-side ally adjacent to the attacker (defensive support)
    if (e.owner === targetSnap.owner &&
        hexDistance(e.col, e.row, actorSnap.col, actorSnap.row) <= 1) return true;
    return false;
  });
}

/**
 * Animate a resolution step array.
 *
 * Each step record carries an `entitySnapshot` taken before that step ran.
 * For each step we:
 *   1. Set state.entities to the POST-step snapshot (next step's pre-snapshot, or
 *      finalEntities for the last step).  This is the "landing" state.
 *   2. Fire addMoveAnim for every MOVE in this step, using the pre-step snapshot as
 *      the FROM position and the action target as the TO position.
 *      The entity is hidden from the static draw while animating; when the anim
 *      expires it falls back to state.entities which is already at the destination.
 *      → no more "flicker to final position" artefact.
 *   3. Await the slide duration, then process dialogs.
 *
 * finalEntities: real post-resolution entity array (restored after all steps).
 * humanFaction:  if set, suppress opponent-only battle/explore dialogs.
 */
async function _animateResolutionSteps(steps, finalEntities, redrawFn, humanFaction = null, myPlayerId = null) {
  _resolving = true;
  for (let i = 0; i < steps.length; i++) {
    // During replay: if BACK or STOP was pressed, abort remaining steps immediately
    if (_replayGoBack || _replayAborted || _replayJumpToEnd) break;
    const step = steps[i];
    // Post-step entities: what the world looks like AFTER this step resolves.
    const postEntities = i + 1 < steps.length ? steps[i + 1].entitySnapshot : finalEntities;

    // Support both legacy {heroEvents, witchEvents} (offline) and
    // new {playerEvents: [{playerId, faction, events}]} (online MP) step formats.
    const allStepEvents = [
      ...(step.heroEvents  ?? []),
      ...(step.witchEvents ?? []),
      ...(step.playerEvents ?? []).flatMap(pe => pe.events ?? []),
    ];
    const events = allStepEvents.filter(ev => ev.type === ResEventType.ACTION_OK);

    // Restore pre-step entity state before the camera pan so the canvas never
    // shows the final resolved state during the framing delay.
    const displayEntities = step.entitySnapshot.map(e => ({ ...e }));
    // Apply GUARD actions from this step so guard zone highlights render immediately.
    for (const ev of allStepEvents) {
      if (ev.type === ResEventType.ACTION_OK && ev.action?.type === PlanActionType.GUARD) {
        const de = displayEntities.find(e => e.id === ev.action.entityId);
        if (de) de.guarding = (de.guarding || 0) + 1;
      }
    }
    state.entities = displayEntities;

    // Track the last battle dialog's framed hex positions so we can skip
    // redundant camera reframes when consecutive battles are at the same spot.
    // Declared before the step-level frame so we can pre-apply the dialog
    // inset when the first action in a step is a battle.
    let _lastBattleFrameKey = null;
    let _battleInsetActive = false;
    const _prevInsetRight = renderer.insetRight ?? 0;
    // The battle dialog only docks to the right (needing an inset offset)
    // on wide landscape screens — on phone-sized screens it's a centered
    // overlay so no camera offset is needed.
    const _dialogDocksRight = (typeof window !== 'undefined'
      && window.matchMedia?.('(min-width: 900px) and (min-aspect-ratio: 5/4)')?.matches) ?? false;
    const _battleInsetValue = _dialogDocksRight ? 500 : 0;

    // ── Frame camera on this step's actors ──────────────────────────────────
    if (!_autoplay) {
      const _cspd = ui?.speedMode ?? 'cinematic';
      {
        // In cinematic/step modes, battles get per-battle dialog framing
        // (with insetRight=500). To avoid a "yoyo" (centered frame → dialog
        // reframe), detect the first visible battle and apply the dialog
        // inset directly in this step-level frame, so the camera lands in the
        // final position from the start.
        const hasBattleDialogFraming = (_cspd === 'cinematic' || _cspd === 'step');
        let firstBattleTargets = null;
        let firstBattleFrameKey = null;
        if (hasBattleDialogFraming) {
          for (const ev of events) {
            if (ev.action.type !== PlanActionType.BATTLE_UNIT && ev.action.type !== PlanActionType.BATTLE_HEX) continue;
            if (!ev.battleSnaps) continue;
            const { actorSnap, targetSnap } = ev.battleSnaps;
            const myUnit = myPlayerId && (
              actorSnap?.ownerId === myPlayerId || targetSnap?.ownerId === myPlayerId
            );
            const showForPlayer = myPlayerId
              ? myUnit
              : (!humanFaction || state.fogOfWar === 'none' || ev.faction === humanFaction
                  || (targetSnap?.owner === humanFaction || actorSnap?.owner === humanFaction));
            if (showForPlayer && actorSnap && targetSnap) {
              firstBattleTargets = [
                { col: actorSnap.col, row: actorSnap.row },
                { col: targetSnap.col, row: targetSnap.row },
              ];
              firstBattleFrameKey = `${actorSnap.col},${actorSnap.row}|${targetSnap.col},${targetSnap.row}`;
              break;
            }
          }
        }

        const frameTargets = [];
        if (firstBattleTargets) {
          // Pre-apply the dialog inset so the step-level frame already
          // accounts for the battle dialog panel — no second reframe needed.
          if (_dialogDocksRight) {
            renderer.insetRight = _battleInsetValue;
            _battleInsetActive = true;
          }
          _lastBattleFrameKey = firstBattleFrameKey;
          frameTargets.push(...firstBattleTargets);
        } else {
          for (const ev of events) {
            const snap = step.entitySnapshot?.find(e => e.id === ev.action?.entityId);
            const isOpponent = humanFaction && ev.faction !== humanFaction;
            if (snap && !(isOpponent && state.fogOfWar !== 'none')) {
              // For moves, frame the destination; for others, frame the actor's current position
              if (ev.action.type === PlanActionType.MOVE) {
                frameTargets.push({ col: ev.action.toCol, row: ev.action.toRow });
              } else {
                frameTargets.push({ col: snap.col, row: snap.row });
              }
              // For battles, also frame the target
              if ((ev.action.type === PlanActionType.BATTLE_UNIT || ev.action.type === PlanActionType.BATTLE_HEX) && ev.battleSnaps?.targetSnap) {
                frameTargets.push({ col: ev.battleSnaps.targetSnap.col, row: ev.battleSnaps.targetSnap.row });
              }
            }
          }
        }
        if (frameTargets.length) {
          const _isStep = _cspd === 'step';
          renderer.frameHexes(frameTargets, {
            paddingHexes: firstBattleTargets ? 2.5 : (_isStep ? 1.5 : 3.0),
            maxZoom:      _isStep ? 3.5 : 2.0,
            duration:     _isStep ? 400 : 250,
          });
          await _delay(_isStep ? 400 : (_cspd === 'vfast' ? 140 : 280));
        }
      }
    }

    // ── Phase 0: food consumed floaters ──────────────────────────────────────
    for (const ev of allStepEvents.filter(e => e.type === ResEventType.FOOD_CONSUMED)) {
      if (humanFaction && ev.faction !== humanFaction) continue;
      // Find the action that consumed the food — show the floater over the acting
      // unit, not the hero.
      const actionEv = allStepEvents.find(
        e => e.type === ResEventType.ACTION_OK && e.faction === ev.faction,
      );
      const actorSnap = actionEv
        ? step.entitySnapshot?.find(e => e.id === actionEv.action.entityId)
        : null;
      if (actorSnap) {
        renderer.addFlash(actorSnap.col, actorSnap.row, '-1\u00a0🍞', 'rgba(200,140,40,0.1)', 1600, 0.72, '#e8c84a');
        redrawFn();
      }
    }

    // ── Phase 1: animate moves for both factions simultaneously ──────────────
    // Multi-hex moves (horse or road chains) animate hop-by-hop using result.path.
    let hadMove = false;
    const pendingDialogs = [];

    // Collect pre-step snapshots and paths for all move events
    const moveAnims = [];
    for (const ev of events) {
      const { action, result } = ev;
      if (action.type !== PlanActionType.MOVE) continue;

      const preSnap = step.entitySnapshot?.find(e => e.id === action.entityId);
      const isOpponent = humanFaction && ev.faction !== humanFaction;
      const visible = preSnap && !(isOpponent && state.fogOfWar !== 'none');

      // Use result.path if available (new path-following move); fall back to single hop
      const path = result?.path?.length > 0
        ? result.path
        : [{ col: action.toCol, row: action.toRow }];

      if (visible) moveAnims.push({ ev, preSnap, path });

      if ((!humanFaction || ev.faction === humanFaction) && result?.encounterLog?.length) {
        if (!myPlayerId || preSnap?.ownerId === myPlayerId) {
          pendingDialogs.push({ log: result.encounterLog, encounterUnit: result.encounterSurvivor ?? null });
        }
      }
    }

    if (moveAnims.length > 0) {
      hadMove = true;
      const _spd = ui?.speedMode ?? 'cinematic';
      const hopDelay = _spd === 'vfast' ? 160 : 320;

      // Determine max hops across all moving entities
      const maxHops = moveAnims.reduce((m, a) => Math.max(m, a.path.length), 0);

      for (let hop = 0; hop < maxHops; hop++) {
        // Start animations for all entities at this hop index
        for (const { ev, preSnap, path } of moveAnims) {
          if (hop >= path.length) continue;
          const fromPos = hop === 0 ? preSnap : path[hop - 1];
          const toPos   = path[hop];
          renderer.addMoveAnim(
            ev.action.entityId,
            fromPos.col, fromPos.row,
            toPos.col, toPos.row,
            preSnap.type, preSnap.owner,
            preSnap.title ?? null,
          );
          // Patch display entity to current hop destination
          const ent = displayEntities.find(e => e.id === ev.action.entityId);
          if (ent) { ent.col = toPos.col; ent.row = toPos.row; }
        }
        state.entities = displayEntities;
        redrawFn();
        if (!_autoplay && hopDelay > 0) await _delay(hopDelay);
      }
    } else {
      // No visible moves — still need to patch display entities to final positions
      for (const ev of events) {
        if (ev.action.type !== PlanActionType.MOVE) continue;
        const path = ev.result?.path;
        const finalPos = path?.length > 0 ? path[path.length - 1] : { col: ev.action.toCol, row: ev.action.toRow };
        const ent = displayEntities.find(e => e.id === ev.action.entityId);
        if (ent) { ent.col = finalPos.col; ent.row = finalPos.row; }
      }
      state.entities = displayEntities;
      redrawFn();
    }

    const _suppressDialogs = _replayActive || ui?.speedMode === 'fast' || ui?.speedMode === 'vfast';
    if (!_suppressDialogs) {
      for (const entry of pendingDialogs) {
        redrawFn();
        if (entry.encounterUnit) {
          await new Promise(resolve => ui._showEncounterDialog(entry.encounterUnit, resolve));
        } else {
          await new Promise(resolve => ui._showResultDialog(entry.log, resolve));
        }
      }
    }

    // ── Phase 2: battles and summons ──────────────────────────────────────────
    let hadBattle = false;
    for (const ev of events) {
      const { action, result, battleSnaps } = ev;
      if (action.type === PlanActionType.BATTLE_UNIT || action.type === PlanActionType.BATTLE_HEX) {
        // Show animation/dialog if one of my own units is involved (team MP), or falling
        // back to faction-level logic (offline / fog-off / standard 1v1).
        const myUnit = myPlayerId && battleSnaps && (
          battleSnaps.actorSnap?.ownerId  === myPlayerId ||
          battleSnaps.targetSnap?.ownerId === myPlayerId
        );
        const showForPlayer = myPlayerId
          ? myUnit
          : (!humanFaction || state.fogOfWar === 'none' || ev.faction === humanFaction
              || (battleSnaps && (
                   battleSnaps.targetSnap?.owner === humanFaction ||
                   battleSnaps.actorSnap?.owner  === humanFaction
                 )));
        if (battleSnaps && showForPlayer) {
          const { actorSnap, targetSnap } = battleSnaps;
          const isKill = !!result?.killed;

          if (!_autoplay) {
            const speed = ui?.speedMode ?? 'cinematic';

            // ── Step 1: Lunge — attacker slides toward target border ──────────
            // Use current display position for both ends: if the target (or
            // actor) also has a MOVE in this same step, displayEntities already
            // has it at the post-move hex, so the lunge must chase that position
            // rather than the pre-move battleSnap coordinates.
            const actorDisplay  = state.entities.find(e => e.id === actorSnap.id);
            const targetDisplay = state.entities.find(e => e.id === targetSnap.id);
            const lungeFromCol = actorDisplay?.col  ?? actorSnap.col;
            const lungeFromRow = actorDisplay?.row  ?? actorSnap.row;
            const lungeToCol   = targetDisplay?.col ?? targetSnap.col;
            const lungeToRow   = targetDisplay?.row ?? targetSnap.row;
            renderer.addLungeAnim(
              actorSnap.id,
              lungeFromCol, lungeFromRow,
              lungeToCol, lungeToRow,
              actorSnap.type, actorSnap.owner, actorSnap.title ?? null,
            );
            redrawFn();
            await _delay(speed === 'vfast' ? 140 : 280);

            // ── Step 2: Battle hex highlights ────────────────────────────────
            {
              const allyEntities = _getBattleAllyEntities(actorSnap, targetSnap, state.entities);
              renderer.setBattleHighlights(
                [{ col: lungeFromCol, row: lungeFromRow }, { col: lungeToCol, row: lungeToRow }],
                allyEntities.map(e => ({ col: e.col, row: e.row })),
              );
              redrawFn();
            }

            // ── Step 3: Dialog (cinematic/step) or toast+floater (fast/vfast) ─
            if (speed === 'cinematic' || speed === 'step') {
              // Full dialog for every battle — no significance filter.
              // Offset camera so the map is visible beside the docked dialog.
              // Skip the reframe if the camera is already positioned for these
              // same hex positions (avoids yoyo between consecutive battles at
              // the same spot).
              const frameKey = `${actorSnap.col},${actorSnap.row}|${targetSnap.col},${targetSnap.row}`;
              const needsReframe = frameKey !== _lastBattleFrameKey || (_dialogDocksRight && !_battleInsetActive);
              if (needsReframe) {
                if (_dialogDocksRight) {
                  renderer.insetRight = _battleInsetValue;
                  _battleInsetActive = true;
                }
                renderer.frameHexes(
                  [{ col: actorSnap.col, row: actorSnap.row }, { col: targetSnap.col, row: targetSnap.row }],
                  { paddingHexes: 2.5, maxZoom: 2.0, duration: 200 },
                );
              }
              _lastBattleFrameKey = frameKey;
              // Wait for dialog dismiss, THEN play floaters so nothing overlaps.
              await new Promise(resolve => {
                ui._showBattleDialog(actorSnap, targetSnap, result, resolve);
              });
              _playBattleResultAnims(actorSnap, targetSnap, result, redrawFn);
              // Drain all floaters (HP text 1800ms, death burst 600ms) before next battle.
              await renderer.waitForAnimations();
            } else if (speed === 'fast' || speed === 'vfast') {
              // Toast + floater only — no dialog.
              // On a miss show a randomised flavour word; hits communicate via HP floater.
              if (!result.hit) {
                const _MISS_TEXT = ['miss', 'dodged', 'blocked', 'parried', 'deflected'];
                const missText = _MISS_TEXT[Math.floor(Math.random() * _MISS_TEXT.length)];
                renderer.addFlash(targetSnap.col, targetSnap.row, missText, 'rgba(100,100,100,0.1)', 1000, 0.65, '#888');
              }
              _playBattleResultAnims(actorSnap, targetSnap, result, redrawFn);
              // Brief wait so floaters from different battles don't pile up.
              await _delay(speed === 'vfast' ? 200 : 400);
            }

            // ── Step 4: Clear highlights, animate lunge return ───────────────
            renderer.clearBattleHighlights();
            renderer.returnAllLungeAnims(); // slide entity back rather than snap
            if (speed === 'cinematic' || speed === 'step') await renderer.waitForAnimations();
            redrawFn();

          } else {
            // Autoplay: fire all animations immediately without dialogs or lunge.
            _playBattleResultAnims(actorSnap, targetSnap, result, redrawFn);
          }
          hadBattle = true;
        }
      } else if (action.type === PlanActionType.SUMMON) {
        const actorSnap = step.entitySnapshot?.find(e => e.id === action.entityId);
        if (actorSnap) renderer.addSpawnAnim(actorSnap.col, actorSnap.row, '#b39ddb');
        hadBattle = true;
      }
    }

    // ── Phase 2b: guard strike reactions ─────────────────────────────────────
    // Guard strikes are reactive attacks emitted as GUARD_STRIKE events.
    // Animate them the same way as normal battles: lunge, highlights, dialog/toast.
    const guardStrikeEvents = allStepEvents.filter(ev => ev.type === ResEventType.GUARD_STRIKE);
    for (const ev of guardStrikeEvents) {
      const { result, battleSnaps } = ev;
      if (!battleSnaps) continue;
      const { actorSnap, targetSnap } = battleSnaps;

      const showForPlayer = myPlayerId
        ? (actorSnap?.ownerId === myPlayerId || targetSnap?.ownerId === myPlayerId)
        : (!humanFaction || state.fogOfWar === 'none' || ev.faction === humanFaction
            || targetSnap?.owner === humanFaction || actorSnap?.owner === humanFaction);

      if (!showForPlayer) continue;

      if (!_autoplay) {
        const speed = ui?.speedMode ?? 'cinematic';

        // Lunge: guardian slides toward the target
        const guardDisplay  = state.entities.find(e => e.id === actorSnap.id);
        const targetDisplay = state.entities.find(e => e.id === targetSnap.id);
        const lungeFromCol = guardDisplay?.col  ?? actorSnap.col;
        const lungeFromRow = guardDisplay?.row  ?? actorSnap.row;
        const lungeToCol   = targetDisplay?.col ?? targetSnap.col;
        const lungeToRow   = targetDisplay?.row ?? targetSnap.row;
        renderer.addLungeAnim(
          actorSnap.id,
          lungeFromCol, lungeFromRow,
          lungeToCol, lungeToRow,
          actorSnap.type, actorSnap.owner, actorSnap.title ?? null,
        );
        redrawFn();
        await _delay(speed === 'vfast' ? 140 : 280);

        // Battle hex highlights
        renderer.setBattleHighlights(
          [{ col: lungeFromCol, row: lungeFromRow }, { col: lungeToCol, row: lungeToRow }],
          [],  // no allies for guard strikes
        );
        redrawFn();

        if (speed === 'cinematic' || speed === 'step') {
          // Reuse the same frame-key tracking from Phase 2 so guard strikes
          // at the same position as a preceding regular battle skip reframing.
          const frameKey = `${actorSnap.col},${actorSnap.row}|${targetSnap.col},${targetSnap.row}`;
          const needsReframe = frameKey !== _lastBattleFrameKey || (_dialogDocksRight && !_battleInsetActive);
          if (needsReframe) {
            if (_dialogDocksRight) {
              renderer.insetRight = _battleInsetValue;
              _battleInsetActive = true;
            }
            renderer.frameHexes(
              [{ col: actorSnap.col, row: actorSnap.row }, { col: targetSnap.col, row: targetSnap.row }],
              { paddingHexes: 2.5, maxZoom: 2.0, duration: 200 },
            );
          }
          _lastBattleFrameKey = frameKey;
          await new Promise(resolve => {
            ui._showBattleDialog(actorSnap, targetSnap, result, resolve);
          });
          _playBattleResultAnims(actorSnap, targetSnap, result, redrawFn);
          await renderer.waitForAnimations();
        } else {
          if (!result.hit) {
            const _MISS_TEXT = ['miss', 'dodged', 'blocked', 'parried', 'deflected'];
            const missText = _MISS_TEXT[Math.floor(Math.random() * _MISS_TEXT.length)];
            renderer.addFlash(targetSnap.col, targetSnap.row, missText, 'rgba(100,100,100,0.1)', 1000, 0.65, '#888');
          }
          _playBattleResultAnims(actorSnap, targetSnap, result, redrawFn);
          await _delay(speed === 'vfast' ? 200 : 400);
        }

        // Clear highlights, return lunge
        renderer.clearBattleHighlights();
        renderer.returnAllLungeAnims();
        if (speed === 'cinematic' || speed === 'step') await renderer.waitForAnimations();
        redrawFn();

      } else {
        // Autoplay: fire all animations immediately
        _playBattleResultAnims(actorSnap, targetSnap, result, redrawFn);
      }
      hadBattle = true;
    }
    // Restore inset after all battles (regular + guard strikes) are done.
    if (_battleInsetActive) {
      renderer.insetRight = _prevInsetRight;
      _battleInsetActive = false;
    }

    // ── Phase 3: explore results — only this player's own entities ───────────
    // In team MP each player owns a subset of their faction's units via ownerId.
    // Only show dialogs for entities this player directly controls; other players'
    // units on the same team resolve silently.
    // In offline/solo mode myPlayerId is null so we fall back to faction filtering.
    for (const ev of events) {
      const { action, result } = ev;
      if (action.type !== PlanActionType.EXPLORE) continue;
      // Reveal the explored dot now that the explore step is being animated.
      const explorer = step.entitySnapshot?.find(e => e.id === action.entityId);
      if (explorer) {
        const tk = _hexKey(explorer.col, explorer.row);
        const tt = state.tiles.get(tk);
        if (tt) tt.explored = true;
      }
      if (!result?.log?.length) continue;
      if (humanFaction && ev.faction !== humanFaction) continue;
      const actor = explorer;
      if (myPlayerId && actor?.ownerId !== myPlayerId) continue;
      if (actor) ui._showLootFlashes(actor, result.lootItems ?? []);
      redrawFn();
      if (!_suppressDialogs && result.encounterSurvivor) {
        await new Promise(resolve => ui._showEncounterDialog(result.encounterSurvivor, resolve));
      }
    }

    // Apply the full post-step entity state now that all dialogs for this step
    // have been shown.  This reveals HP changes, deaths, and new encounter
    // entities only after the player has seen the relevant dialog/animation.
    // Snapshot node control BEFORE applying post-step entities so we can detect captures this step.
    const preStepNodeOwners = state.witchObjectives?.map(obj => {
      const holder = step.entitySnapshot?.find(e => e.alive && e.col === obj.col && e.row === obj.row);
      return holder?.owner ?? null;
    });

    state.entities = postEntities;
    redrawFn();

    // Animate node dot changes that happened this step (real-time capture feedback)
    if (ui && state.witchObjectives && preStepNodeOwners) {
      ui._renderObjectives();
      const barEl = document.getElementById('score-bar-content');
      if (barEl) {
        const dots = barEl.querySelectorAll('.node-dot');
        let hadNodeChange = false;
        preStepNodeOwners.forEach((prevOwner, idx) => {
          if (idx >= dots.length) return;
          const obj = state.witchObjectives[idx];
          const postHolder = postEntities.find(e => e.alive && e.col === obj.col && e.row === obj.row);
          const postOwner = postHolder?.owner ?? null;
          if (postOwner !== prevOwner) {
            dots[idx].classList.add('node-dot-glow');
            hadNodeChange = true;
          }
        });
        if (hadNodeChange) {
          setTimeout(() => {
            dots.forEach(d => d.classList.remove('node-dot-glow'));
          }, 2000);
        }
      }
    }

    if (hadMove || hadBattle) {
      if (!_autoplay) {
        const _spd2 = ui?.speedMode ?? 'cinematic';
        if (_spd2 === 'step') {
          await ui._waitForStep();
        } else {
          await _delay(_spd2 === 'vfast' ? (hadMove ? 150 : 125) : hadMove ? 300 : 250);
        }
      }
    } else if (events.length > 0 && !_autoplay) {
      // Non-visual actions (fortify, use_item, etc.) — brief pause so resolution feels deliberate.
      const _spd3 = ui?.speedMode ?? 'cinematic';
      if (_spd3 === 'step') {
        await ui._waitForStep();
      } else {
        await _delay(_spd3 === 'vfast' ? 75 : 150);
      }
    }
  }

  // Restore the authoritative final state.
  ui?._clearStepContinue();
  state.entities = finalEntities;
  // Skip the final redraw during replay navigation (caller will render the target preState).
  if (!_replayGoBack && !_replayAborted && !_replayJumpToEnd) {
    redrawFn();
  }
  _resolving = false;
}

function _delay(ms) {
  if (!_replayActive) return new Promise(resolve => setTimeout(resolve, ms));

  // During replay: poll every ≤50 ms so pause/abort/back take effect immediately.
  const effective = _replaySpeedMult > 0 ? ms / _replaySpeedMult : ms;
  return new Promise(resolve => {
    let remaining = effective;
    let last = Date.now();
    function tick() {
      if (_replayAborted || _replayGoBack || _replayJumpToEnd) { resolve(); return; }
      if (!_replayPaused) {
        const now = Date.now();
        remaining -= (now - last);
        last = now;
      } else {
        last = Date.now(); // don't count paused time toward remaining
      }
      if (remaining <= 0) { resolve(); return; }
      setTimeout(tick, Math.min(50, remaining));
    }
    tick();
  });
}


// ── Online game init ──────────────────────────────────────────────────────────

let mp = null; // MultiplayerClient instance

function initOnline(mirrorState, myFaction, mpClient) {
  state    = mirrorState;
  const canvas = document.getElementById('game-canvas');

  document.getElementById('setup-screen').style.display = 'none';
  document.getElementById('game-screen').style.display  = 'flex';

  renderer = new Renderer(canvas, state);
  renderer.resize();
  renderer.loadImages();

  // No local AI — all turns handled server-side
  ui = new UIController(canvas, state, renderer, null, redrawOnline, null, false);
  ui.onQuitToMenu = () => location.reload();
  ui.mp         = mpClient;
  ui.myPlayerId = mpClient.myPlayerId ?? null;
  ui._players   = state.players ?? [];

  redrawOnline();

  requestAnimationFrame(() => {
    // Resize now that game-screen layout is complete and canvas has real dimensions.
    renderer.resize();
    // Frame the human player's starting units (matches local mode init behaviour).
    const myUnits = state.entities.filter(e => e.alive && e.owner === mp.myFaction);
    if (myUnits.length > 0) {
      renderer.frameHexes(myUnits, { maxZoom: 1.8, paddingHexes: 2.5, duration: 0 });
    }
    redrawOnline();
  });
}

function redrawOnline() {
  if (!renderer) return;
  renderer.draw();
  if (ui) ui._updateSidebar?.();
}

// ── Window resize ─────────────────────────────────────────────────────────────

window.addEventListener('resize', () => {
  if (!renderer) return;
  renderer.resize();
  redraw();
});

// ── Setup screen ──────────────────────────────────────────────────────────────

const stepMode         = document.getElementById('setup-step-mode');
const stepSpChoice     = document.getElementById('setup-step-sp-choice');
const stepSinglePlayer = document.getElementById('setup-step-singleplayer');
const stepCampaignSelect = document.getElementById('setup-step-campaign-select');
const stepCampaign     = document.getElementById('setup-step-campaign');
const stepDebrief      = document.getElementById('setup-step-debrief');
const stepMultiplayer  = document.getElementById('setup-step-multiplayer');
const stepHowto        = document.getElementById('setup-step-howtoplay');
const stepOptions      = document.getElementById('setup-step-options');
const stepChangelog    = document.getElementById('setup-step-changelog');
const stepAccount      = document.getElementById('setup-step-account');
const stepWaiting      = document.getElementById('setup-step-waiting');
const stepCreateGame   = document.getElementById('setup-step-create-game');
const stepJoinGame     = document.getElementById('setup-step-join-game');
const stepLobby        = document.getElementById('setup-step-lobby');
const stepAsyncCreate  = document.getElementById('setup-step-async-create');
const stepAsyncCreated = document.getElementById('setup-step-async-created');
const stepAsyncJoin    = document.getElementById('setup-step-async-join');

function showStep(step) {
  stepMode        .style.display = step === 'mode'          ? '' : 'none';
  stepSpChoice      .style.display = step === 'sp-choice'       ? '' : 'none';
  stepSinglePlayer  .style.display = step === 'singleplayer'    ? '' : 'none';
  stepCampaignSelect.style.display = step === 'campaign-select' ? '' : 'none';
  stepCampaign      .style.display = step === 'campaign'        ? '' : 'none';
  stepDebrief       .style.display = step === 'debrief'         ? '' : 'none';
  stepMultiplayer .style.display = step === 'multiplayer'   ? '' : 'none';
  stepHowto       .style.display = step === 'howtoplay'     ? '' : 'none';
  stepOptions     .style.display = step === 'options'       ? '' : 'none';
  stepChangelog   .style.display = step === 'changelog'     ? '' : 'none';
  stepAccount     .style.display = step === 'account'       ? '' : 'none';
  stepWaiting     .style.display = step === 'waiting'       ? '' : 'none';
  stepCreateGame  .style.display = step === 'create-game'   ? '' : 'none';
  stepJoinGame    .style.display = step === 'join-game'     ? '' : 'none';
  stepLobby       .style.display = step === 'lobby'         ? '' : 'none';
  stepAsyncCreate .style.display = step === 'async-create'  ? '' : 'none';
  stepAsyncCreated.style.display = step === 'async-created' ? '' : 'none';
  stepAsyncJoin   .style.display = step === 'async-join'    ? '' : 'none';
}

// Current lobby state (pre-game)
let _currentLobby = null;

// ── Welcome screen buttons ────────────────────────────────────────────────────

document.getElementById('btn-single-player').addEventListener('click', () => showStep('sp-choice'));
document.getElementById('btn-quick-play')    .addEventListener('click', () => _showSinglePlayerScreen());
document.getElementById('btn-story-mode')    .addEventListener('click', () => _showCampaignSelectScreen());
document.getElementById('btn-sp-choice-back').addEventListener('click', () => showStep('mode'));
document.getElementById('btn-multiplayer')  .addEventListener('click', () => _showMultiplayerScreen());
document.getElementById('btn-tutorial')     .addEventListener('click', () => initTutorial());
document.getElementById('btn-how-to-play')  .addEventListener('click', () => showStep('howtoplay'));
document.getElementById('btn-options')      .addEventListener('click', () => showStep('options'));
document.getElementById('btn-account')      .addEventListener('click', () => { _initAccountPage(); showStep('account'); });
document.getElementById('btn-howtoplay-back').addEventListener('click', () => showStep('mode'));
document.getElementById('btn-options-back') .addEventListener('click', () => showStep('mode'));
document.getElementById('btn-account-back') .addEventListener('click', () => showStep('mode'));
document.getElementById('btn-changelog-back').addEventListener('click', () => showStep('mode'));

// Show game version on main menu
document.getElementById('menu-version').textContent = `v${VERSION}`;

// Show admin link only for admin users
{
  const _s = loadSession();
  if (_s?.is_admin) {
    const _adminLink = document.getElementById('admin-link');
    if (_adminLink) {
      _adminLink.style.display = '';
    }
  }
}

// Version badge opens revision history
document.getElementById('version-badge').addEventListener('click', (e) => {
  e.preventDefault();
  _openChangelog();
});

let _changelogLoaded = false;
function _openChangelog() {
  showStep('changelog');
  if (_changelogLoaded) return;
  fetch('/CHANGELOG.json')
    .then(r => r.json())
    .then(releases => {
      const container = document.getElementById('changelog-body');
      container.innerHTML = releases.map(r => `
        <div class="changelog-release">
          <div class="changelog-version-heading">v${r.version}</div>
          <div class="changelog-date">${r.date}${r.summary ? ' — ' + r.summary : ''}</div>
          <ul class="changelog-notes">
            ${r.notes.map(n => `<li>${n}</li>`).join('')}
          </ul>
        </div>
      `).join('');
      _changelogLoaded = true;
    })
    .catch(() => {
      document.getElementById('changelog-body').textContent = 'Could not load revision history.';
    });
}

// ── Single Player screen ───────────────────────────────────────────────────────

function _showSinglePlayerScreen() {
  showStep('singleplayer');
  _renderSpSaves();
  _renderCompletedSpGames();
}

document.getElementById('btn-singleplayer-back').addEventListener('click', () => {
  renderer = null; ui = null; state = null;
  showStep('sp-choice');
});

// ── Campaign / Story Mode ─────────────────────────────────────────────────────

let _activeCampaign  = null;  // Campaign instance (persists across missions)
let _activeMissionDef = null; // Current mission definition
let _campaignSelectedMission = null; // Mission ID selected on campaign screen

function _showCampaignSelectScreen() {
  const listEl = document.getElementById('campaign-select-list');
  listEl.innerHTML = CAMPAIGNS.map(c => {
    const hasSave = Campaign.exists(`campaign-${c.id}`);
    const locked = c.prerequisiteCampaign
      ? !Campaign.isCampaignCompleted(getCampaignById(c.prerequisiteCampaign))
      : false;
    const cls = `campaign-select-item${locked ? ' locked' : ''}`;
    return `<div class="${cls}" data-campaign="${c.id}">
      <div class="campaign-select-title">${locked ? '🔒 ' : ''}${c.title}</div>
      <div class="campaign-select-desc">${c.description}</div>
      ${hasSave ? '<div class="campaign-select-badge">Save found</div>' : ''}
      ${locked ? '<div class="campaign-select-badge">Complete the previous chapter to unlock</div>' : ''}
    </div>`;
  }).join('');

  listEl.querySelectorAll('.campaign-select-item:not(.locked)').forEach(el => {
    el.addEventListener('click', () => {
      const def = getCampaignById(el.dataset.campaign);
      if (def) _showCampaignScreen(def);
    });
  });

  showStep('campaign-select');
}

function _showCampaignScreen(campaignDef) {
  if (campaignDef) {
    _activeCampaign = new Campaign(campaignDef);
    _activeCampaign.load();
  }
  _renderCampaignScreen();
  showStep('campaign');
}

function _renderCampaignScreen() {
  const listEl = document.getElementById('campaign-mission-list');
  const briefEl = document.getElementById('campaign-briefing');
  const navEl = document.getElementById('campaign-nav');
  const rosterEl = document.getElementById('campaign-roster-summary');
  briefEl.style.display = 'none';
  navEl.style.display = '';
  listEl.style.display = '';

  // Set campaign title from definition
  const titleEl = document.getElementById('campaign-title');
  if (titleEl && _activeCampaign?.campaignDef) {
    titleEl.textContent = _activeCampaign.campaignDef.title;
  }

  // Roster summary
  if (_activeCampaign.roster.length > 0) {
    rosterEl.style.display = '';
    rosterEl.innerHTML = `<div class="campaign-roster-label">Roster: ${_activeCampaign.roster.length} survivor${_activeCampaign.roster.length !== 1 ? 's' : ''}</div>` +
      `<div class="campaign-resources-label">` +
      Object.entries(_activeCampaign.resources).filter(([,v]) => v > 0).map(([k,v]) => `${k}: ${v}`).join(' · ') +
      `</div>`;
  } else {
    rosterEl.style.display = 'none';
  }

  // Mission list
  const missions = _activeCampaign.getMissionList();
  listEl.innerHTML = missions.map(m => {
    const cls = m.completed ? 'campaign-mission completed' : m.available ? 'campaign-mission available' : 'campaign-mission locked';
    const icon = m.completed ? '✓' : m.available ? '→' : '🔒';
    return `<div class="${cls}" data-mission="${m.id}">
      <span class="campaign-mission-icon">${icon}</span>
      <span class="campaign-mission-name">${m.title}</span>
      ${m.completed ? '<span class="campaign-mission-status">Complete</span>' : ''}
    </div>`;
  }).join('');

  // Click handlers for missions
  listEl.querySelectorAll('.campaign-mission.available').forEach(el => {
    el.addEventListener('click', () => {
      _campaignSelectedMission = el.dataset.mission;
      _showMissionBriefing(_campaignSelectedMission);
    });
  });
}

function _showMissionBriefing(missionId) {
  const missionDef = _activeCampaign.getMissionDef(missionId);
  if (!missionDef) return;

  const listEl = document.getElementById('campaign-mission-list');
  const briefEl = document.getElementById('campaign-briefing');
  const navEl = document.getElementById('campaign-nav');

  listEl.style.display = 'none';
  navEl.style.display = 'none';
  briefEl.style.display = '';

  document.getElementById('campaign-mission-title').textContent = missionDef.title;
  document.getElementById('campaign-mission-text').textContent = missionDef.briefing;

  // Objectives
  const objEl = document.getElementById('campaign-objectives');
  const winDesc = _objectiveDescription(missionDef.objectives.win);
  const loseDesc = _objectiveDescription(missionDef.objectives.lose);
  objEl.innerHTML = `
    <div class="campaign-obj"><span class="campaign-obj-icon">☀</span> <strong>Victory:</strong> ${winDesc}</div>
    <div class="campaign-obj"><span class="campaign-obj-icon">💀</span> <strong>Defeat:</strong> ${loseDesc}</div>
  `;

  // Deploy roster (if campaign has survivors and mission allows them)
  const deployEl = document.getElementById('campaign-deploy-roster');
  const pickerEl = document.getElementById('campaign-roster-picker');
  if (_activeCampaign.roster.length > 0 && missionDef.maxSurvivorsFromRoster > 0) {
    deployEl.style.display = '';
    pickerEl.innerHTML = _activeCampaign.roster.map((s, i) => `
      <label class="campaign-survivor-pick">
        <input type="checkbox" data-idx="${i}" ${i < missionDef.maxSurvivorsFromRoster ? 'checked' : ''}>
        <span>${s.name} (${s.ability}) HP:${s.hp}/${s.maxHp}</span>
      </label>
    `).join('');
  } else {
    deployEl.style.display = 'none';
  }
}

function _objectiveDescription(obj) {
  if (!obj) return 'None';
  switch (obj.type) {
    case 'eliminate_all':  return 'Eliminate all enemies';
    case 'hero_killed':    return 'Don\'t let the hero fall';
    case 'survive_rounds': return `Survive ${obj.rounds} rounds`;
    case 'reach_hex':      return 'Reach the objective hex';
    case 'slay_witch':     return 'Slay the witch';
    case 'control_nodes':  return 'Control the Power Nodes';
    default:               return obj.type;
  }
}

function _createEnemyEntity(type, col, row) {
  switch (type) {
    case 'zombie':     return createZombie(col, row, 'witch');
    case 'minion':     return createMinion(col, row, 'witch');
    case 'wood_golem': return createWoodGolem(col, row, 'witch');
    case 'iron_golem': return createIronGolem(col, row, 'witch');
    default:           return createMinion(col, row, 'witch');
  }
}

const _DEPARTURE_MESSAGES = [
  name => `${name} left town to search for supplies in the outlying farms.`,
  name => `${name} slipped away at dawn to scout the old trade road.`,
  name => `${name} volunteered to warn the neighboring settlement.`,
  name => `${name} departed to tend to a wounded traveler found on the road.`,
  name => `${name} set off alone to bury the dead in the churchyard.`,
  name => `${name} vanished into the fog — perhaps the strain was too much.`,
  name => `${name} headed south, hoping to find reinforcements.`,
  name => `${name} left to guard the bridge crossing overnight.`,
];

const _ARRIVAL_MESSAGES = [
  name => `${name} wanders into town, weary but willing to fight.`,
  name => `${name} stumbles out of the tree line, clutching a makeshift weapon.`,
  name => `${name} emerges from the cellar of a ruined house and joins you.`,
  name => `A voice calls from the fog — ${name} steps forward, ready for battle.`,
  name => `${name} was hiding in the church. Hearing your approach, they join the cause.`,
  name => `${name} arrives breathless, having fled the horrors to the north.`,
  name => `The door of the inn creaks open — ${name} has been waiting for someone to lead.`,
  name => `${name} crawls from the wreckage of a collapsed barn, bruised but alive.`,
];

function _departureMessage(name) {
  return _DEPARTURE_MESSAGES[Math.floor(Math.random() * _DEPARTURE_MESSAGES.length)](name);
}

function _arrivalMessage(name) {
  return _ARRIVAL_MESSAGES[Math.floor(Math.random() * _ARRIVAL_MESSAGES.length)](name);
}

function _initCampaignMission(missionDef) {
  _activeMissionDef = missionDef;
  _gameStartTime = Date.now();
  _spSaveId = null; // campaign uses its own save system

  // Build map
  const builder = _activeCampaign.getMapBuilder(missionDef.mapBuilder);
  if (!builder) { console.error('No map builder for', missionDef.mapBuilder); return; }
  const mapData = builder();
  mapData.noWitch = !missionDef.hasWitch;
  mapData.disableScoring = !!missionDef.disableScoring;
  if (missionDef.maxDiscoverableSurvivors != null) {
    mapData.maxDiscoverableSurvivors = missionDef.maxDiscoverableSurvivors;
  }

  // Hide setup, show game
  document.getElementById('setup-screen').style.display = 'none';
  document.getElementById('game-screen').style.display = 'flex';
  const canvas = document.getElementById('game-canvas');

  // Create game state
  state = new GameState(true, false, missionDef.mapSize, null, mapData);
  state.fogOfWar = 'partial';

  // Set custom victory delegate
  state.victoryDelegate = buildVictoryDelegate(missionDef.objectives);

  // Inject carried-over hero stats
  if (_activeCampaign && _activeCampaign.heroStats) {
    const hs = _activeCampaign.heroStats;
    state.hero.hp      = Math.min(hs.hp, state.hero.maxHp);
    state.hero.weapon  = hs.weapon;
    state.hero.items   = { ...hs.items };
  }

  // Inject carried-over resources
  if (_activeCampaign) {
    const res = { ...(_activeCampaign.resources || {}) };
    // Add mission starting resources
    if (missionDef.startingResources) {
      for (const [k, v] of Object.entries(missionDef.startingResources)) {
        res[k] = (res[k] || 0) + v;
      }
    }
    Object.assign(state.inventory.shared, res);
  }

  // Deploy carried-over survivors from roster
  if (_activeCampaign && missionDef.maxSurvivorsFromRoster > 0) {
    const pickerEl = document.getElementById('campaign-roster-picker');
    const checked = pickerEl ? [...pickerEl.querySelectorAll('input:checked')].map(cb => parseInt(cb.dataset.idx)) : [];
    const toDeploy = checked.slice(0, missionDef.maxSurvivorsFromRoster);
    // Place survivors near hero start
    const heroStart = mapData.heroStart;
    const neighbors = getNeighbors(heroStart.col, heroStart.row);
    for (let i = 0; i < toDeploy.length && i < neighbors.length; i++) {
      const rosterEntry = _activeCampaign.roster[toDeploy[i]];
      if (!rosterEntry) continue;
      const n = neighbors[i];
      const s = createSurvivor(n.col, n.row, 'hero');
      // Restore stats from roster
      s.name = rosterEntry.name;
      s.title = rosterEntry.title;
      s.bio = rosterEntry.bio;
      s.ability = rosterEntry.ability;
      s.abilityLabel = rosterEntry.abilityLabel;
      s.color = rosterEntry.color;
      s.hp = rosterEntry.hp;
      s.maxHp = rosterEntry.maxHp;
      s.attack = rosterEntry.attack;
      s.defense = rosterEntry.defense;
      s.weapon = rosterEntry.weapon;
      s.items = { ...rosterEntry.items };
      s.owner = 'hero';
      state.entities.push(s);
      // Exclude this character from the hidden-survivor discovery pool
      markRosterUsedByName(rosterEntry.name);
    }
  }

  // ── Roster balancing: enforce min/max survivor count ──────────────────────
  if (missionDef.minSurvivors != null || missionDef.maxSurvivors != null) {
    const heroSurvivors = state.entities.filter(
      e => e.alive && e.owner === 'hero' && e.type === EntityType.SURVIVOR
    );
    const min = missionDef.minSurvivors ?? 0;
    const max = missionDef.maxSurvivors ?? Infinity;

    // Too many — some leave with a narrative reason
    if (heroSurvivors.length > max) {
      const excess = heroSurvivors.slice(max);
      for (const s of excess) {
        state.entities.splice(state.entities.indexOf(s), 1);
        state.addLog(_departureMessage(s.name));
      }
    }

    // Too few — newcomers arrive
    const currentCount = state.entities.filter(
      e => e.alive && e.owner === 'hero' && e.type === EntityType.SURVIVOR
    ).length;
    if (currentCount < min) {
      const heroStart = mapData.heroStart;
      const spots = getNeighbors(heroStart.col, heroStart.row)
        .filter(n => !state.entities.some(e => e.col === n.col && e.row === n.row));
      for (let i = currentCount; i < min && spots.length > 0; i++) {
        const spot = spots.shift();
        const s = createSurvivor(spot.col, spot.row, 'hero');
        s.owner = 'hero';
        state.entities.push(s);
        state.addLog(_arrivalMessage(s.name));
      }
    }
  }

  // Pre-place enemy units from mission definition
  if (missionDef.enemyUnits) {
    for (const enemy of missionDef.enemyUnits) {
      const e = _createEnemyEntity(enemy.type, enemy.col, enemy.row);
      if (e) state.entities.push(e);
    }
  }

  // Set up AI
  const AIClass = WITCH_PERSONALITIES[missionDef.aiPersonality] ?? WitchAIEngine;
  witchAI = new AIClass(state, redraw);
  heroAI = null;

  _setupLocalUI(canvas, witchAI, null, false);
  _roundHistory = [];

  // Log victory conditions at mission start
  const winDesc = _objectiveDescription(missionDef.objectives?.win);
  const loseDesc = _objectiveDescription(missionDef.objectives?.lose);
  state.addLog(`═══ ${missionDef.title} ═══`);
  state.addLog(`☀ Victory: ${winDesc}`);
  state.addLog(`💀 Defeat: ${loseDesc}`);

  redraw();
  _startLocalPlanningPhase();
}

function _handleCampaignMissionEnd() {
  if (!_activeCampaign || !_activeMissionDef || !state) return;

  // Record campaign-specific stats before cleaning up
  _recordCampaignGameStats();

  const won = state.winner === 'hero';
  const missionDef = _activeMissionDef;

  // Gather surviving survivors for roster (permadeath: dead ones are lost)
  const survivors = state.entities
    .filter(e => e.alive && e.owner === 'hero' && e.type === EntityType.SURVIVOR)
    .map(e => snapshotSurvivor(e));

  // Apply mission result to campaign state
  _activeCampaign.applyMissionResult(missionDef.id, {
    won,
    survivors,
    resources: { ...state.inventory.shared },
    heroStats: state.hero ? {
      hp: state.hero.hp, maxHp: state.hero.maxHp,
      attack: state.hero.attack, defense: state.hero.defense,
      weapon: state.hero.weapon, items: { ...state.hero.items },
    } : _activeCampaign.heroStats,
    flags: {},
  });

  // Show debrief screen
  document.getElementById('game-screen').style.display = 'none';
  document.getElementById('setup-screen').style.display = '';

  const title = won ? 'VICTORY' : 'DEFEAT';
  const text = won ? (missionDef.victoryText || 'Mission complete.') : (missionDef.defeatText || 'Mission failed.');
  document.getElementById('debrief-title').textContent = title;
  document.getElementById('debrief-text').textContent = text;

  // Stats
  const statsEl = document.getElementById('debrief-stats');
  statsEl.innerHTML = `
    <div>Rounds: ${state.round}</div>
    <div>Kills: ${state.heroKills}</div>
    <div>Survivors remaining: ${survivors.length}</div>
  `;

  // Roster status
  const rosterEl = document.getElementById('debrief-roster');
  if (survivors.length > 0) {
    rosterEl.innerHTML = '<h3>Surviving Roster</h3>' +
      survivors.map(s => `<div class="debrief-survivor">${s.name} — HP: ${s.hp}/${s.maxHp}</div>`).join('');
  } else {
    rosterEl.innerHTML = '';
  }

  // Clean up game state
  renderer = null; ui = null; witchAI = null; heroAI = null;
  _activeMissionDef = null;

  showStep('debrief');
}

// Campaign event listeners
document.getElementById('btn-campaign-select-back').addEventListener('click', () => showStep('sp-choice'));
document.getElementById('btn-campaign-back')   .addEventListener('click', () => _showCampaignSelectScreen());
document.getElementById('btn-briefing-back')   .addEventListener('click', () => _renderCampaignScreen());
document.getElementById('btn-delete-campaign')  .addEventListener('click', () => {
  if (confirm('Start over? All campaign progress, roster survivors, and resources will be lost. This cannot be undone.')) {
    _activeCampaign.delete();
    _showCampaignSelectScreen();
  }
});
document.getElementById('btn-start-mission')   .addEventListener('click', () => {
  if (!_campaignSelectedMission) return;
  const missionDef = _activeCampaign.getMissionDef(_campaignSelectedMission);
  if (missionDef) _initCampaignMission(missionDef);
});
document.getElementById('btn-debrief-continue').addEventListener('click', () => {
  _showCampaignScreen();
});

// Tab switching for In Progress / Completed panels (SP and MP)
document.addEventListener('click', e => {
  const tab = e.target.closest('.saves-tab');
  if (!tab) return;
  const bar = tab.closest('.saves-tab-bar');
  if (!bar) return;
  // Deactivate all tabs in this bar
  bar.querySelectorAll('.saves-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  // Show the target panel, hide siblings
  const targetId = tab.dataset.target;
  const section  = bar.closest('.active-games-section');
  if (!section) return;
  section.querySelectorAll('.saves-list').forEach(el => {
    el.style.display = el.id === targetId ? '' : 'none';
  });
});

// Quick Play faction toggle
let _qpFaction = 'hero';
document.getElementById('btn-faction-hero').addEventListener('click', () => {
  _qpFaction = 'hero';
  document.getElementById('btn-faction-hero').classList.add('active');
  document.getElementById('btn-faction-witch').classList.remove('active');
});
document.getElementById('btn-faction-witch').addEventListener('click', () => {
  _qpFaction = 'witch';
  document.getElementById('btn-faction-witch').classList.add('active');
  document.getElementById('btn-faction-hero').classList.remove('active');
});

// Quick Play start button (always 1v1 vs AI)
document.getElementById('btn-start-qp').addEventListener('click', () => {
  if (_qpFaction === 'hero') init(true, false);
  else init(false, true);
});

// Local Pass & Play (from multiplayer screen)
document.getElementById('btn-local-pass-play').addEventListener('click', () => {
  init(false, false);
});

function _doRestart() {
  // Disconnect from server if in online mode
  if (mp) { mp.disconnect(); mp = null; }

  // Reset game objects so initOnline / init start fresh
  renderer = null;
  ui       = null;
  state    = null;
  witchAI  = null;
  heroAI   = null;
  _activeMissionDef = null;

  if (_autoplay) {
    init(true, true, true);
  } else {
    showStep('mode');
    document.getElementById('setup-screen').style.display = 'flex';
    document.getElementById('game-screen').style.display  = 'none';
  }
}

function _esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Single-player localStorage saves ─────────────────────────────────────────

const _SP_SAVE_KEY = 'brimstone_sp_saves';

function _loadSpSaves() {
  try {
    return JSON.parse(localStorage.getItem(_SP_SAVE_KEY) || '[]');
  } catch { return []; }
}

function _saveSpSaves(saves) {
  try { localStorage.setItem(_SP_SAVE_KEY, JSON.stringify(saves)); } catch {}
}

/** Persist the current single-player game state to localStorage. */
function _saveSpGame() {
  if (!state || state.gameOver || _autoplay) return;
  const saves = _loadSpSaves();
  const existing = saves.findIndex(s => s.id === _spSaveId);
  const mode = !state.heroIsAI ? 'hero' : !state.witchIsAI ? 'witch' : 'two-players';
  const serialized = serializeState(state);
  const entry = {
    id:         _spSaveId,
    mode,
    mapSize:    state.mapSize ?? 'standard',
    fog:        state.fogOfWar,
    round:      state.round,
    phase:      state.phase,
    updatedAt:  Math.floor(Date.now() / 1000),
    startedAt:  existing >= 0 ? saves[existing].startedAt : Math.floor(Date.now() / 1000),
    state:      serialized,
  };
  if (existing >= 0) saves[existing] = entry;
  else saves.unshift(entry);
  // Keep at most 10 saves
  const kept = saves.slice(0, 10);
  // Remove history for saves that are being dropped
  for (const dropped of saves.slice(10)) {
    try { localStorage.removeItem('brimstone_sp_history_' + dropped.id); } catch {}
  }
  _saveSpSaves(kept);
  // Persist round history separately (avoids bloating the saves list)
  try { localStorage.setItem('brimstone_sp_history_' + _spSaveId, JSON.stringify(_roundHistory)); } catch {}
}

/** Delete a single-player save. */
function _deleteSpSave(id) {
  const saves = _loadSpSaves().filter(s => s.id !== id);
  _saveSpSaves(saves);
  try { localStorage.removeItem('brimstone_sp_history_' + id); } catch {}
}

/** Render the in-progress saves list on the Single Player screen. */
function _renderSpSaves() {
  const list = document.getElementById('sp-saves-list');
  if (!list) return;
  const saves = _loadSpSaves();
  if (!saves.length) {
    list.innerHTML = '<p class="saves-empty">No saved games.</p>';
    return;
  }
  list.innerHTML = '';
  const modeLabels = { hero: '⚔ vs AI (Hero)', witch: '✦ vs AI (Witch)', 'two-players': '👥 Two Players' };
  const phaseLabel = { dawn: '🌅 Dawn', day: '☀ Day', dusk: '🌇 Dusk', night: '🌙 Night' };
  for (const s of saves) {
    const ago = _timeAgo(s.updatedAt);
    const entry = document.createElement('div');
    entry.className = 'save-entry';
    entry.innerHTML = `
      <div class="save-entry-info">
        <div class="save-entry-title">${modeLabels[s.mode] ?? s.mode}</div>
        <div class="save-entry-meta">Round ${s.round} · ${phaseLabel[s.phase] ?? s.phase} · ${_esc(s.mapSize)} · ${ago}</div>
      </div>
      <div style="display:flex;gap:0.4rem">
        <button class="setup-btn primary sp-resume-btn">Resume</button>
        <button class="setup-btn sp-delete-btn" title="Delete save">✕</button>
      </div>
    `;
    entry.querySelector('.sp-resume-btn').addEventListener('click', () => _resumeSpSave(s));
    entry.querySelector('.sp-delete-btn').addEventListener('click', () => {
      _deleteSpSave(s.id);
      _renderSpSaves();
    });
    list.appendChild(entry);
  }
}

let _spSaveId = null;

/** Resume a single-player game from localStorage. */
function _resumeSpSave(save) {
  _spSaveId = save.id;
  const deserialized = deserializeState(save.state);
  // Restore round history accumulated before the save
  let priorHistory = [];
  try {
    const raw = localStorage.getItem('brimstone_sp_history_' + save.id);
    if (raw) priorHistory = JSON.parse(raw);
  } catch {}
  _startFromState(deserialized, save.mode, priorHistory);
}

/** Start a game from an existing deserialized state (used by SP resume). */
function _startFromState(existingState, mode, existingHistory) {
  _autoplay = false;
  _roundHistory = existingHistory || [];
  const canvas = document.getElementById('game-canvas');

  document.getElementById('setup-screen').style.display = 'none';
  document.getElementById('game-screen').style.display  = 'flex';

  state   = existingState;
  witchAI = state.witchIsAI ? new WitchAIEngine(state, redraw) : null;
  heroAI  = state.heroIsAI  ? new HeroAI(state, redraw)  : null;

  _setupLocalUI(canvas, witchAI, heroAI, false);

  redraw();

  requestAnimationFrame(() => {
    renderer.resize();
    redraw();
  });

  _startLocalPlanningPhase();
}

// ── Active games (inline in New Game screen) ──────────────────────────────────

function _fetchActiveSaves() {
  const list = document.getElementById('active-games-list');
  if (!list) return;
  list.innerHTML = '<p class="saves-empty">Loading…</p>';

  const session = loadSession();
  if (!session) {
    list.innerHTML = '<p class="saves-empty">Sign in to see your active games.</p>';
    return;
  }

  const base = window.BRIMSTONE_SERVER || '';
  fetch(`${base}/api/saves?token=${encodeURIComponent(session.token)}`)
    .then(r => r.json())
    .then(saves => _renderSaves(saves))
    .catch(() => {
      list.innerHTML = '<p class="saves-empty">Could not load saves (offline?).</p>';
    });
}

function _renderSaves(saves) {
  const list = document.getElementById('active-games-list');
  const session = loadSession();

  if (!saves.length) {
    list.innerHTML = '<p class="saves-empty">No games in progress.</p>';
    return;
  }

  list.innerHTML = '';
  for (const s of saves) {
    const myFaction  = s.hero_player_id  === session?.id ? 'hero' : 'witch';
    const oppName    = myFaction === 'hero' ? (s.witch_name || 'Witch') : (s.hero_name || 'Hero');
    const factionSymbol = myFaction === 'hero' ? '⚔' : '✦';
    const phaseLabel = { dawn: '🌅 Dawn', day: '☀ Day', dusk: '🌇 Dusk', night: '🌙 Night' }[s.phase] ?? s.phase;

    const entry = document.createElement('div');
    entry.className = 'save-entry';
    entry.innerHTML = `
      <div class="save-entry-info">
        <div class="save-entry-title">${factionSymbol} vs ${_esc(oppName)}</div>
        <div class="save-entry-meta">Round ${s.round} · ${phaseLabel}</div>
      </div>
      <button class="setup-btn primary">Rejoin</button>
    `;
    entry.querySelector('button').addEventListener('click', () => _resumeSave(s.room_id));
    list.appendChild(entry);
  }
}

function _resumeSave(roomId) {
  _ensureAuthed(() => {
    showStep('waiting');
    document.getElementById('waiting-subtitle').textContent = 'Rejoining game…';
    document.getElementById('waiting-message').textContent  = 'Reconnecting to your game…';
    mp.resumeSave(roomId);
  });
}

function _timeAgo(unixSecs) {
  const diff = Math.floor(Date.now() / 1000) - unixSecs;
  if (diff < 60)   return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ── Async games ─────────────────────────────────────────────────────────────

function _fetchAsyncGames() {
  const list = document.getElementById('async-games-list');
  if (!list) return;
  list.innerHTML = '<p class="saves-empty">Loading…</p>';

  const session = loadSession();
  if (!session) {
    list.innerHTML = '<p class="saves-empty">Sign in to see async games.</p>';
    return;
  }

  const base = window.BRIMSTONE_SERVER || '';
  fetch(`${base}/api/async-games?token=${encodeURIComponent(session.token)}`)
    .then(r => r.json())
    .then(games => _renderAsyncGames(games))
    .catch(() => {
      list.innerHTML = '<p class="saves-empty">Could not load async games.</p>';
    });
}

function _renderAsyncGames(games) {
  const list = document.getElementById('async-games-list');

  if (!games.length) {
    list.innerHTML = '<p class="saves-empty">No async games.</p>';
    return;
  }

  list.innerHTML = '';
  for (const g of games) {
    const factionSymbol = g.my_faction === 'hero' ? '⚔' : '✦';
    const phaseLabel = { dawn: 'Dawn', day: 'Day', dusk: 'Dusk', night: 'Night' }[g.phase] ?? g.phase;
    const entry = document.createElement('div');
    entry.className = 'save-entry';

    if (g.status === 'waiting') {
      // Waiting for opponent
      entry.innerHTML = `
        <div class="save-entry-info">
          <div class="save-entry-title">${factionSymbol} Waiting for opponent</div>
          <div class="save-entry-meta">Code: <strong>${_esc(g.code)}</strong></div>
        </div>
        <button class="setup-btn secondary async-copy-btn" data-code="${_esc(g.code)}">Copy</button>
      `;
      entry.querySelector('.async-copy-btn').addEventListener('click', (e) => {
        navigator.clipboard?.writeText(e.target.dataset.code);
        e.target.textContent = 'Copied!';
        setTimeout(() => { e.target.textContent = 'Copy'; }, 1500);
      });
    } else if (g.status === 'finished' || g.status === 'abandoned') {
      const label = g.status === 'abandoned' ? 'Abandoned' : (g.winner === g.my_faction ? 'Victory' : 'Defeat');
      entry.innerHTML = `
        <div class="save-entry-info">
          <div class="save-entry-title">${factionSymbol} vs ${_esc(g.opponent_name)}</div>
          <div class="save-entry-meta">${label} · Round ${g.round}</div>
        </div>
      `;
    } else {
      // Playing
      const deadline = g.turn_deadline
        ? _timeRemaining(g.turn_deadline)
        : '';
      const mySubmitted = g.my_plan_submitted;
      const statusBadge = mySubmitted
        ? '<span class="async-badge async-badge-waiting">Waiting</span>'
        : '<span class="async-badge async-badge-turn">Your turn</span>';
      const actionBtn = mySubmitted
        ? '<button class="setup-btn secondary async-view-btn">View</button>'
        : '<button class="setup-btn primary async-play-btn">Play</button>';

      entry.innerHTML = `
        <div class="save-entry-info">
          <div class="save-entry-title">${factionSymbol} vs ${_esc(g.opponent_name)} ${statusBadge}</div>
          <div class="save-entry-meta">Round ${g.round} · ${phaseLabel}${deadline ? ' · ' + deadline : ''} · ${g.players_submitted}/${g.players_total} submitted</div>
        </div>
        ${actionBtn}
      `;
      const btn = entry.querySelector('.async-play-btn, .async-view-btn');
      btn?.addEventListener('click', () => _openAsyncGame(g.room_id));
    }

    list.appendChild(entry);
  }
}

function _timeRemaining(deadlineUnixSecs) {
  const diff = deadlineUnixSecs - Math.floor(Date.now() / 1000);
  if (diff <= 0) return 'expired';
  if (diff < 3600) return `${Math.floor(diff / 60)}m left`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h left`;
  return `${Math.floor(diff / 86400)}d left`;
}

/** State for the currently open async game. */
let _asyncRoomId = null;
let _asyncFaction = null;

function _openAsyncGame(roomId) {
  _asyncRoomId = roomId;
  _ensureAuthed(() => {
    mp.connectAsync(roomId);
  });
}

function _handleAsyncStateUpdate(msg) {
  _asyncRoomId  = msg.roomId;
  _asyncFaction = msg.faction;

  const mirror = MirrorState.fromSnapshot(msg.state);
  mirror.myFaction = msg.faction;

  // Set planning state based on plan submission
  mirror.planningPhase = !msg.myPlanSubmitted && msg.gameStatus === 'playing';

  // Set up MP client state for the planning UI
  mp.myFaction  = msg.faction;
  mp.myPlayerId = msg.myPlayerId;
  mp.roomId     = msg.roomId;
  mp.active     = true;

  // Init the game view
  if (!renderer || !ui) {
    try {
      initOnline(mirror, msg.faction, mp);
    } catch (err) {
      console.error('initOnline (async) failed:', err);
      _onlineError(`Failed to load game: ${err.message}`);
      showStep('multiplayer');
      _initMpStep();
      return;
    }
  } else {
    Object.assign(state, mirror);
    state.hero      = mirror.hero;
    state.witch     = mirror.witch;
    state.myFaction = msg.faction;
    redrawOnline();
  }

  if (msg.gameStatus === 'finished' || msg.gameStatus === 'abandoned') {
    const label = msg.winner === msg.faction ? 'Victory' : (msg.winner ? 'Defeat' : 'Game Over');
    ui?._showResultDialog([label, msg.winReason || '']);
    return;
  }

  if (msg.myPlanSubmitted) {
    ui?.exitPlanningMode();
    ui?._showResultDialog([
      '⏳ Plan submitted',
      'Waiting for your opponent to submit their plan.',
      `${msg.planStatus.filter(p => p.submitted).length}/${msg.planStatus.length} players submitted.`,
    ]);
  } else {
    // Enter planning mode — wire up submit to async plan submission
    const budget = msg.myActionsLeft ?? 3;
    ui?.exitPlanningMode();
    ui?.enterPlanningMode(msg.faction, budget, 0);
    if (ui) ui.onPlanSubmit = (plan) => mp.submitAsyncPlan(msg.roomId, plan);
  }
}

function _handleAsyncPlanAccepted(_msg) {
  if (ui) {
    ui._showResultDialog([
      '✓ Plan submitted!',
      'Waiting for your opponent. You\'ll be notified when the round resolves.',
    ]);
  }
}

function _handleAsyncResolution({ roomId, steps, finalState }) {
  if (!state || !renderer) return;

  // Same resolution flow as real-time games
  Object.assign(state, finalState);
  state.hero      = finalState.hero;
  state.witch     = finalState.witch;
  state.myFaction = _asyncFaction;
  redrawOnline();

  if (state.gameOver) {
    ui?._showResultDialog([
      state.winner === _asyncFaction ? '🏆 Victory!' : '💀 Defeat',
      state.winReason || '',
    ]);
  } else {
    ui?._showResultDialog([
      `Round ${state.round - 1} resolved!`,
      'A new planning phase has begun.',
    ]);
  }
}

function _handleAsyncPlanStatus(msg) {
  // Update status while viewing — could show a toast
}

// ── Completed SP games (localStorage) ────────────────────────────────────────

const _SP_COMPLETED_INDEX_KEY = 'brimstone_completed_index';
const _SP_COMPLETED_MAX_AGE_S = 3 * 86400;  // 3 days
const _SP_COMPLETED_MAX_GAMES = 10;

function _loadCompletedSpIndex() {
  try { return JSON.parse(localStorage.getItem(_SP_COMPLETED_INDEX_KEY) || '[]'); } catch { return []; }
}

function _saveCompletedSpIndex(index) {
  try { localStorage.setItem(_SP_COMPLETED_INDEX_KEY, JSON.stringify(index)); } catch {}
}

/** Load full replay data for one completed game (or null). */
function _loadCompletedSpGame(id) {
  try { return JSON.parse(localStorage.getItem(`brimstone_completed_${id}`) || 'null'); } catch { return null; }
}

function _saveCompletedSpGameData(id, data) {
  try { localStorage.setItem(`brimstone_completed_${id}`, JSON.stringify(data)); } catch {}
}

function _deleteCompletedSpGame(id) {
  const index = _loadCompletedSpIndex().filter(g => g.id !== id);
  _saveCompletedSpIndex(index);
  try { localStorage.removeItem(`brimstone_completed_${id}`); } catch {}
}

function _pinCompletedSpGame(id, pinned) {
  const index = _loadCompletedSpIndex();
  const entry = index.find(g => g.id === id);
  if (entry) {
    entry.pinned = pinned;
    _saveCompletedSpIndex(index);
  }
}

/** Remove expired (unpinned, > 3 days old) completed games. */
function _pruneCompletedSpGames() {
  const now = Math.floor(Date.now() / 1000);
  const index = _loadCompletedSpIndex();
  const keep = index.filter(g => g.pinned || (now - g.createdAt) < _SP_COMPLETED_MAX_AGE_S);
  const removed = index.filter(g => !keep.includes(g));
  for (const g of removed) {
    try { localStorage.removeItem(`brimstone_completed_${g.id}`); } catch {}
  }
  if (removed.length) _saveCompletedSpIndex(keep);
}

/** Persist a completed SP game with full replay rounds to localStorage. */
function _saveCompletedSpGame(winner, winReason) {
  if (!state || !_roundHistory.length) return;
  const id      = _genSaveId();
  const mode    = !state.heroIsAI ? 'hero' : !state.witchIsAI ? 'witch' : 'two-players';
  const now     = Math.floor(Date.now() / 1000);
  const meta    = {
    id,
    mode,
    winner:      winner      ?? '',
    winReason:   winReason   ?? '',
    heroName:    state.hero?.displayName  ?? 'Hero',
    witchName:   state.witch?.displayName ?? 'Witch',
    totalRounds: state.round - 1,
    createdAt:   now,
    pinned:      false,
  };

  // Write replay data
  _saveCompletedSpGameData(id, { meta, rounds: _roundHistory });

  // Update index — keep max N (unpinned, non-latest removed first)
  const index = _loadCompletedSpIndex();
  index.unshift(meta);
  // Prune: drop oldest unpinned beyond the limit
  let kept = 0;
  const pruned = [];
  for (const g of index) {
    if (g.pinned || kept < _SP_COMPLETED_MAX_GAMES) { kept++; }
    else { pruned.push(g); }
  }
  for (const g of pruned) {
    try { localStorage.removeItem(`brimstone_completed_${g.id}`); } catch {}
  }
  _saveCompletedSpIndex(index.filter(g => !pruned.includes(g)));
}

/**
 * Fire-and-forget: upload the just-completed SP game to the server.
 * Silently swallows errors — local localStorage copy is always authoritative.
 */
function _uploadSpGame(winner, winReason) {
  if (!state || !_roundHistory.length) return;
  const base = window.BRIMSTONE_SERVER || '';
  if (!base && !location.hostname) return;  // no server configured

  const mode    = !state.heroIsAI ? 'hvai' : !state.witchIsAI ? 'aivh' : 'aivai';
  const gameId  = _genSaveId();
  const payload = {
    gameId,
    heroName:    state.hero?.displayName  ?? 'Hero',
    witchName:   state.witch?.displayName ?? 'Witch',
    winner:      winner    ?? '',
    winReason:   winReason ?? '',
    totalRounds: state.round - 1,
    gameVersion: VERSION,
    mode,
    rounds: _roundHistory.map(r => ({
      roundNum: r.roundNum,
      preState: typeof r.preState === 'string' ? r.preState : JSON.stringify(r.preState),
      steps:    typeof r.steps    === 'string' ? r.steps    : JSON.stringify(r.steps),
    })),
  };

  fetch(`${base}/api/sp/completed-games`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  }).catch(() => {});  // silently ignore network errors
}

/** Render the completed games tab on the SP setup screen. */
function _renderCompletedSpGames() {
  const list = document.getElementById('sp-completed-list');
  if (!list) return;
  _pruneCompletedSpGames();
  const index = _loadCompletedSpIndex();
  if (!index.length) {
    list.innerHTML = '<p class="saves-empty">No completed games yet.</p>';
    return;
  }
  const modeLabels = { hero: '⚔ vs AI', witch: '✦ vs AI', 'two-players': '👥 Two Players' };
  list.innerHTML = '';
  for (const g of index) {
    const winnerLabel = g.winner === 'hero' ? '⚔ Hero wins' : '✦ Witch wins';
    const ago = _timeAgo(g.createdAt);
    const entry = document.createElement('div');
    entry.className = 'save-entry';
    entry.innerHTML = `
      <div class="save-entry-info">
        <div class="save-entry-title">${modeLabels[g.mode] ?? g.mode} — ${winnerLabel}</div>
        <div class="save-entry-meta">${_esc(g.winReason)} · ${g.totalRounds} rounds · ${ago}${g.pinned ? ' 📌' : ''}</div>
      </div>
      <div style="display:flex;gap:0.4rem">
        <button class="setup-btn primary sp-completed-replay-btn">Replay</button>
        <button class="setup-btn sp-completed-pin-btn"   title="${g.pinned ? 'Unpin' : 'Pin to keep'}">${g.pinned ? '📌' : '📎'}</button>
        <button class="setup-btn sp-completed-delete-btn" title="Delete">✕</button>
      </div>
    `;
    entry.querySelector('.sp-completed-replay-btn').addEventListener('click', async () => {
      const data = _loadCompletedSpGame(g.id);
      if (!data?.rounds?.length) { alert('Replay data not found.'); return; }
      // Need a game state to render — start a replay-only session
      await _startSpReplay(data);
    });
    entry.querySelector('.sp-completed-pin-btn').addEventListener('click', () => {
      _pinCompletedSpGame(g.id, !g.pinned);
      _renderCompletedSpGames();
    });
    entry.querySelector('.sp-completed-delete-btn').addEventListener('click', () => {
      _deleteCompletedSpGame(g.id);
      _renderCompletedSpGames();
    });
    list.appendChild(entry);
  }
}

/** Start a full-game replay from the setup screen (no active game session). */
async function _startSpReplay(data) {
  const { meta, rounds } = data;
  if (!rounds.length) return;

  // Reconstruct state from the first round's preState
  const firstState = deserializeState(JSON.parse(rounds[0].preState));
  const canvas = document.getElementById('game-canvas');

  document.getElementById('setup-screen').style.display = 'none';
  document.getElementById('game-screen').style.display  = 'flex';

  state   = firstState;
  witchAI = null;
  heroAI  = null;

  _setupLocalUI(canvas, null, null, false);
  redraw();

  requestAnimationFrame(async () => {
    renderer.resize();
    redraw();
    await _replayFullGame(rounds, meta.winner, meta.winReason, meta.heroName, meta.witchName);
    // After replay finishes, return to setup
    document.getElementById('setup-screen').style.display = '';
    document.getElementById('game-screen').style.display  = 'none';
    state = null; renderer = null; ui = null;
    showStep('singleplayer');
    _renderSpSaves();
    _renderCompletedSpGames();
  });
}

// ── Full-game replay engine ───────────────────────────────────────────────────

/**
 * Replay all rounds of a completed game in sequence (fast mode by default).
 * @param {Array}  rounds       — [{ roundNum, preState, steps }]
 * @param {string} winner
 * @param {string} winReason
 * @param {string} heroName
 * @param {string} witchName
 * @param {Function} [redrawFn] — defaults to local redraw()
 */
async function _replayFullGame(rounds, winner, winReason, heroName, witchName, redrawFn) {
  if (!rounds.length || !ui || !renderer) return null;
  const draw = redrawFn ?? redraw;

  _replayAborted      = false;
  _replayPaused       = true;    // start paused at round 1; user presses play to begin
  _replayGoBack       = false;
  _replayAtRoundStart = false;
  _replayActive       = true;
  _replaySpeedMult    = 0.5;   // default: PLAY speed
  const savedSpeedMode = ui.speedMode;
  ui.speedMode = 'fast';

  // Control callback wired to HUD buttons; override initial state to paused
  ui.showReplayHUD(rounds.length, (action) => {
    switch (action) {
      case 'play':
        _replaySpeedMult = 0.5; _replayPaused = false;
        ui.setReplayPlayState('play');
        break;
      case 'ff':
        _replaySpeedMult = 1.0; _replayPaused = false;
        ui.setReplayPlayState('ff');
        break;
      case 'vff':
        _replaySpeedMult = 2.0; _replayPaused = false;
        ui.setReplayPlayState('vff');
        break;
      case 'pause':
        _replayPaused = true;
        ui.setReplayPlayState('pause');
        break;
      case 'back':
        // Music-player behaviour: back at round start → go to previous round;
        // back mid-animation → restart current round. Either way, implies pause.
        _replayPaused = true;
        _replayGoBack = _replayAtRoundStart ? 'prev' : 'curr';
        ui.setReplayPlayState('pause');
        break;
      case 'end':
        _replayJumpToEnd = true; _replayPaused = false;
        break;
      case 'stop':
        _replayPaused = true;
        ui.setReplayPlayState('pause');
        ui.showReplayExitDialog().then(choice => {
          if (choice === 'exit') {
            _replayAborted = true; _replayPaused = false;
          }
          // 'cancel' → stays paused, user presses play to resume
        });
        break;
    }
  });
  ui.setReplayPlayState('pause'); // override showReplayHUD's default 'play' indicator

  let lastSteps    = null;
  let lastRoundNum = 0;
  let lastPreState = null;

  let _startFrom = 0;

  // Outer loop: re-entered when BACK is pressed at the end-of-replay hold screen
  replayOuter: while (true) {
    for (let i = _startFrom; i < rounds.length; i++) {
      if (_replayAborted) break;

      // Jump to end: restore final game state and skip to end-of-replay hold
      if (_replayJumpToEnd) {
        _replayJumpToEnd = false;
        const lastRound = rounds[rounds.length - 1];
        const lastData = typeof lastRound.preState === 'string'
          ? JSON.parse(lastRound.preState) : lastRound.preState;
        const lastState = deserializeState(lastData);
        renderer.clearAnimations();
        Object.assign(state, lastState);
        state.hero     = lastState.hero;
        state.witch    = lastState.witch;
        state.fogOfWar = 'none';
        // Apply final entities if available (captures combat outcomes of last round)
        if (lastRound.finalEntities) {
          const finals = lastRound.finalEntities;
          for (const e of state.entities) {
            const f = finals.find(fe => fe.id === e.id);
            if (f) Object.assign(e, f);
          }
        }
        draw();
        ui.updateReplayHUD();
        break; // exit for-loop → falls through to end-of-replay hold
      }

      const round = rounds[i];
      const preStateData = typeof round.preState === 'string'
        ? JSON.parse(round.preState)
        : round.preState;
      const preState = deserializeState(preStateData);

      // Restore state and draw BEFORE the pause check — canvas always has valid content.
      // Clear lingering animations from the previous round first to avoid ghost effects.
      renderer.clearAnimations();
      Object.assign(state, preState);
      state.hero     = preState.hero;
      state.witch    = preState.witch;
      state.fogOfWar = 'none';
      draw();

      // ── At round start: accept BACK / PAUSE before animation begins ─────────
      _replayAtRoundStart = true;
      while (_replayPaused && !_replayAborted && !_replayGoBack && !_replayJumpToEnd) {
        await new Promise(r => setTimeout(r, 50));
      }
      _replayAtRoundStart = false;
      if (_replayAborted) break;
      if (_replayJumpToEnd) continue; // handled at top of loop

      // BACK pressed while paused at round start → jump to prev/curr round
      if (_replayGoBack) {
        const toPrev = _replayGoBack === 'prev';
        _replayGoBack = false;
        i = Math.max(-1, toPrev ? i - 2 : i - 1);
        continue;
      }

      // Show hazard flashes from the previous round's endRound() before animating
      if (preState.postRoundEvents?.some(ev => ev.flash)) {
        ui._triggerPostRoundEffects();
        await _delay(600);
        if (_replayAborted) break;
      }

      ui.updateReplayHUD();

      // Get final entities (start of next round = end of this round)
      let finalEntities;
      if (i + 1 < rounds.length) {
        const nextData = typeof rounds[i + 1].preState === 'string'
          ? JSON.parse(rounds[i + 1].preState)
          : rounds[i + 1].preState;
        finalEntities = nextData.entities ?? preState.entities;
      } else {
        // Last round: use saved post-resolution entities if present (captures actual
        // combat outcomes), otherwise fall back to preState entities.
        finalEntities = round.finalEntities ?? preState.entities;
      }

      const stepsRaw = typeof round.steps === 'string' ? JSON.parse(round.steps) : round.steps;
      lastSteps    = stepsRaw;
      lastRoundNum = typeof round.roundNum === 'number' ? round.roundNum : i + 1;
      lastPreState = preState;

      await _animateResolutionSteps(stepsRaw, finalEntities, draw, null, null);

      if (_replayAborted) break;
      if (_replayJumpToEnd) continue; // handled at top of loop

      // BACK pressed during animation → jump to prev/curr round
      if (_replayGoBack) {
        const toPrev = _replayGoBack === 'prev';
        _replayGoBack = false;
        i = Math.max(-1, toPrev ? i - 2 : i - 1);
        continue;
      }

      // Brief inter-round pause (respects pause/abort flags via _delay)
      if (i < rounds.length - 1) {
        await _delay(300);
        if (_replayGoBack) {
          const toPrev = _replayGoBack === 'prev';
          _replayGoBack = false;
          i = Math.max(-1, toPrev ? i - 2 : i - 1);
          continue;
        }
      }
    }

    _startFrom = 0; // reset for any restart

    if (_replayAborted) break replayOuter;

    // ── End-of-replay hold ──────────────────────────────────────────────────
    // All rounds played — pause and wait for STOP or BACK rather than auto-exiting
    _replayPaused       = true;
    _replayAtRoundStart = true;   // treat end-hold as "at round start" for BACK logic
    ui.setReplayPlayState('pause');

    while (!_replayAborted && !_replayGoBack) {
      await new Promise(r => setTimeout(r, 50));
    }
    _replayAtRoundStart = false;

    if (_replayAborted) break replayOuter;

    // BACK from end: jump to last or second-to-last round (stay paused)
    if (_replayGoBack) {
      const toPrev = _replayGoBack === 'prev';
      _replayGoBack = false;
      _startFrom = toPrev ? Math.max(0, rounds.length - 2) : Math.max(0, rounds.length - 1);
      continue replayOuter;
    }

    break replayOuter; // safety exit (shouldn't reach here)
  }

  ui.hideReplayHUD();
  _replayActive       = false;
  _replayAborted      = false;
  _replayPaused       = false;
  _replayGoBack       = false;
  _replayAtRoundStart = false;
  _replayJumpToEnd    = false;
  _replaySpeedMult    = 0.5;
  ui.speedMode        = savedSpeedMode;
  // Caller is responsible for navigation (e.g. _doRestart() or showing setup screen)
}

// ── Multiplayer completed games ───────────────────────────────────────────────

function _fetchCompletedGames() {
  const list = document.getElementById('mp-completed-list');
  if (!list) return;
  list.innerHTML = '<p class="saves-empty">Loading…</p>';

  const session = loadSession();
  if (!session) {
    list.innerHTML = '<p class="saves-empty">Sign in to see completed games.</p>';
    return;
  }

  const base = window.BRIMSTONE_SERVER || '';
  fetch(`${base}/api/completed-games?token=${encodeURIComponent(session.token)}`)
    .then(r => r.json())
    .then(games => _renderCompletedGames(games, session))
    .catch(() => {
      list.innerHTML = '<p class="saves-empty">Could not load completed games.</p>';
    });
}

function _renderCompletedGames(games, session) {
  const list = document.getElementById('mp-completed-list');
  if (!list) return;
  if (!games.length) {
    list.innerHTML = '<p class="saves-empty">No completed games.</p>';
    return;
  }
  list.innerHTML = '';
  const base = window.BRIMSTONE_SERVER || '';
  for (const g of games) {
    const myFaction   = g.hero_player_id === session?.id ? 'hero' : 'witch';
    const winnerLabel = g.winner === 'hero' ? '⚔ Hero wins' : '✦ Witch wins';
    const ago = _timeAgo(g.created_at);
    const entry = document.createElement('div');
    entry.className = 'save-entry';
    entry.innerHTML = `
      <div class="save-entry-info">
        <div class="save-entry-title">${_esc(g.hero_name)} vs ${_esc(g.witch_name)} — ${winnerLabel}</div>
        <div class="save-entry-meta">${_esc(g.win_reason)} · ${g.total_rounds} rounds · ${ago}${g.pinned ? ' 📌' : ''}</div>
      </div>
      <div style="display:flex;gap:0.4rem">
        <button class="setup-btn primary mp-completed-replay-btn">Replay</button>
        <button class="setup-btn mp-completed-pin-btn"   title="${g.pinned ? 'Unpin' : 'Pin to keep'}">${g.pinned ? '📌' : '📎'}</button>
        <button class="setup-btn mp-completed-delete-btn" title="Delete">✕</button>
      </div>
    `;
    entry.querySelector('.mp-completed-replay-btn').addEventListener('click', async () => {
      const token = session.token;
      try {
        const rounds = await fetch(
          `${base}/api/completed-games/${encodeURIComponent(g.game_id)}/rounds?token=${encodeURIComponent(token)}`
        ).then(r => r.json());
        await _startMpReplay(rounds, g);
      } catch { alert('Could not load replay data.'); }
    });
    entry.querySelector('.mp-completed-pin-btn').addEventListener('click', async () => {
      const token = session.token;
      await fetch(`${base}/api/completed-games/${encodeURIComponent(g.game_id)}/pin?token=${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: !g.pinned }),
      });
      _fetchCompletedGames();
    });
    entry.querySelector('.mp-completed-delete-btn').addEventListener('click', async () => {
      const token = session.token;
      await fetch(`${base}/api/completed-games/${encodeURIComponent(g.game_id)}?token=${encodeURIComponent(token)}`, {
        method: 'DELETE',
      });
      _fetchCompletedGames();
    });
    list.appendChild(entry);
  }
}

/** Start a full-game replay from the MP completed games tab. */
async function _startMpReplay(rounds, gameMeta) {
  if (!rounds.length) return;

  const firstState = deserializeState(JSON.parse(rounds[0].pre_state_json));
  const canvas = document.getElementById('game-canvas');

  document.getElementById('setup-screen').style.display = 'none';
  document.getElementById('game-screen').style.display  = 'flex';

  state   = firstState;
  witchAI = null;
  heroAI  = null;

  _setupLocalUI(canvas, null, null, false);
  redraw();

  requestAnimationFrame(async () => {
    renderer.resize();
    redraw();

    // Convert server round format { round_num, pre_state_json, steps_json } → replay format
    const replayRounds = rounds.map(r => ({
      roundNum: r.round_num,
      preState: r.pre_state_json,
      steps:    r.steps_json,
    }));

    await _replayFullGame(replayRounds, gameMeta.winner, gameMeta.win_reason,
      gameMeta.hero_name, gameMeta.witch_name);

    // Return to MP screen after replay
    document.getElementById('setup-screen').style.display = '';
    document.getElementById('game-screen').style.display  = 'none';
    state = null; renderer = null; ui = null;
    _showMultiplayerScreen();
  });
}

// ── Multiplayer screen ────────────────────────────────────────────────────────

function _showMultiplayerScreen() {
  showStep('multiplayer');
  _initMpStep();
  const session = loadSession();
  if (session) {
    _fetchActiveSaves();
    _fetchAsyncGames();
    _fetchCompletedGames();
  }
}

document.getElementById('btn-multiplayer-back').addEventListener('click', () => {
  if (mp) { mp.disconnect(); mp = null; }
  renderer = null; ui = null; state = null;
  showStep('mode');
});

// ── Online flow ───────────────────────────────────────────────────────────────

document.getElementById('btn-cancel-wait').addEventListener('click', () => {
  showStep('multiplayer');
  _initMpStep();
});

function _fogSelected() {
  return document.getElementById('select-fog-of-war')?.value ?? 'partial';
}

// ── Node count selectors — populate options based on map size ─────────────────

function _populateNodeCountSelect(selectId, mapSizeSelectId) {
  const mapSizeEl  = document.getElementById(mapSizeSelectId);
  const nodeEl     = document.getElementById(selectId);
  if (!mapSizeEl || !nodeEl) return;
  const cfg        = MAP_SIZES[mapSizeEl.value] ?? MAP_SIZES.standard;
  const min        = cfg.nodeCountMin ?? 1;
  const max        = cfg.nodeCountMax ?? cfg.nodeCount ?? 3;
  const current    = parseInt(nodeEl.value, 10);
  nodeEl.innerHTML = '';
  for (let i = min; i <= max; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = String(i);
    if (i === cfg.nodeCount) opt.selected = true;
    nodeEl.appendChild(opt);
  }
  // Restore previous selection if still in range; otherwise default
  if (current >= min && current <= max) nodeEl.value = String(current);
}

document.getElementById('select-map-size')?.addEventListener('change', () => {
  _populateNodeCountSelect('select-node-count', 'select-map-size');
});
document.getElementById('cg-map-size')?.addEventListener('change', () => {
  _populateNodeCountSelect('cg-node-count', 'cg-map-size');
});
// Initialize on load
_populateNodeCountSelect('select-node-count', 'select-map-size');
_populateNodeCountSelect('cg-node-count', 'cg-map-size');

// ── Create Game flow ──────────────────────────────────────────────────────────

document.getElementById('btn-create-game').addEventListener('click', () => {
  _ensureAuthed(() => showStep('create-game'));
});

document.getElementById('btn-create-game-back').addEventListener('click', () => {
  showStep('multiplayer');
});

document.getElementById('btn-create-game-confirm').addEventListener('click', () => {
  _ensureAuthed(() => {
    const config = {
      fog:           document.getElementById('cg-fog').value,
      mapSize:       document.getElementById('cg-map-size').value,
      nodeCount:     parseInt(document.getElementById('cg-node-count')?.value ?? '3', 10),
      playersPerSide: parseInt(document.querySelector('input[name="cg-pps"]:checked')?.value ?? '1', 10),
      isPrivate:     document.getElementById('cg-private').checked,
    };
    mp.createLobby(config);
    // Transition to lobby card happens in onLobbyJoined callback
  });
});

// ── Join Game flow ────────────────────────────────────────────────────────────

document.getElementById('btn-join-game').addEventListener('click', () => {
  _ensureAuthed(() => {
    showStep('join-game');
    _loadPublicLobbies();
  });
});

document.getElementById('btn-join-game-back').addEventListener('click', () => {
  showStep('multiplayer');
});

document.getElementById('btn-join-private').addEventListener('click', () => {
  const code = document.getElementById('join-code-input').value.trim().toUpperCase();
  const err  = document.getElementById('join-game-error');
  if (code.length !== 6) {
    err.textContent = 'Enter a 6-letter room code.';
    err.style.display = '';
    return;
  }
  err.style.display = 'none';
  _ensureAuthed(() => mp.joinLobby(code));
});

// ── Async Game flow ──────────────────────────────────────────────────────────

let _asyncSelectedFaction = 'hero';

document.getElementById('btn-create-async').addEventListener('click', () => {
  _ensureAuthed(() => {
    showStep('async-create');
    // Default faction selection
    _asyncSelectedFaction = 'hero';
    for (const btn of document.querySelectorAll('.async-faction-btn')) {
      btn.classList.toggle('primary', btn.dataset.faction === 'hero');
    }
  });
});

for (const btn of document.querySelectorAll('.async-faction-btn')) {
  btn.addEventListener('click', () => {
    _asyncSelectedFaction = btn.dataset.faction;
    for (const b of document.querySelectorAll('.async-faction-btn')) {
      b.classList.toggle('primary', b === btn);
    }
  });
}

document.getElementById('btn-async-create-back').addEventListener('click', () => {
  showStep('multiplayer');
});

document.getElementById('btn-async-create-go').addEventListener('click', () => {
  _ensureAuthed(() => {
    const session = loadSession();
    const base = window.BRIMSTONE_SERVER || '';
    fetch(`${base}/api/async-games`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token:        session.token,
        faction:      _asyncSelectedFaction,
        mapSize:      document.getElementById('async-map-size').value,
        fog:          document.getElementById('async-fog').value,
        turnInterval: Number(document.getElementById('async-turn-interval').value),
      }),
    })
      .then(r => r.json())
      .then(result => {
        if (result.error) {
          _onlineError(result.error);
          return;
        }
        document.getElementById('async-game-code').textContent = result.code;
        showStep('async-created');
      })
      .catch(() => _onlineError('Failed to create async game.'));
  });
});

document.getElementById('btn-async-copy-code').addEventListener('click', () => {
  const code = document.getElementById('async-game-code').textContent;
  navigator.clipboard?.writeText(code);
  const btn = document.getElementById('btn-async-copy-code');
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = 'Copy Code'; }, 1500);
});

document.getElementById('btn-async-created-done').addEventListener('click', () => {
  showStep('multiplayer');
  _fetchAsyncGames();
});

// Async join — the "Async" tab join is via the existing join-game code input,
// but we also add a dedicated async join card for deep links and direct joins.
document.getElementById('btn-async-join-go')?.addEventListener('click', () => {
  const code = document.getElementById('async-join-code').value.trim().toUpperCase();
  const err  = document.getElementById('async-join-error');
  if (code.length !== 6) {
    err.textContent = 'Enter a 6-character game code.';
    err.style.display = '';
    return;
  }
  err.style.display = 'none';

  _ensureAuthed(() => {
    const session = loadSession();
    const base = window.BRIMSTONE_SERVER || '';
    fetch(`${base}/api/async-games/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: session.token, code }),
    })
      .then(r => r.json())
      .then(result => {
        if (result.error) {
          err.textContent = result.error;
          err.style.display = '';
          return;
        }
        // Game joined — go to multiplayer screen and open the game
        showStep('multiplayer');
        _fetchAsyncGames();
        _openAsyncGame(result.roomId);
      })
      .catch(() => {
        err.textContent = 'Failed to join game.';
        err.style.display = '';
      });
  });
});

document.getElementById('btn-async-join-back')?.addEventListener('click', () => {
  showStep('multiplayer');
});

// ── Deep link handling for async games ──────────────────────────────────────

function _checkAsyncDeepLink() {
  const hash = window.location.hash;
  const match = hash.match(/^#async=(.+)$/);
  if (match) {
    window.location.hash = '';
    const roomId = match[1];
    _showMultiplayerScreen();
    setTimeout(() => _openAsyncGame(roomId), 500);
  }
}

// Check on page load
_checkAsyncDeepLink();

function _loadPublicLobbies() {
  if (!mp) return;
  document.getElementById('public-lobbies-list').innerHTML =
    '<p class="saves-empty">Loading…</p>';
  mp.browseLobby();
}

function _renderPublicLobbies(rooms) {
  const list = document.getElementById('public-lobbies-list');
  if (!list) return;
  if (!rooms?.length) {
    list.innerHTML = '<p class="saves-empty">No open games right now.</p>';
    return;
  }
  list.innerHTML = '';
  for (const lobby of rooms) {
    const pps    = lobby.config?.playersPerSide ?? 1;
    const size   = lobby.config?.mapSize ?? 'standard';
    const fogMode = lobby.config?.fog ?? 'partial';
    const fog    = fogMode === 'none' ? 'No Fog' : `Fog: ${fogMode.charAt(0).toUpperCase() + fogMode.slice(1)}`;
    const open   = lobby.slots?.filter(s => s.status === 'empty').length ?? 0;
    const total  = lobby.slots?.length ?? pps * 2;
    const host   = lobby.slots?.find(s => s.playerId === lobby.hostPlayerId)?.name ?? 'Unknown';

    const entry = document.createElement('div');
    entry.className = 'save-entry';
    entry.innerHTML = `
      <div class="save-entry-info">
        <div class="save-entry-title">⚔ ${_esc(host)}'s game</div>
        <div class="save-entry-meta">${pps}v${pps} · ${_esc(size.charAt(0).toUpperCase() + size.slice(1))} · ${fog} · ${total - open}/${total} players</div>
      </div>
      <button class="setup-btn primary">Join</button>
    `;
    entry.querySelector('button').addEventListener('click', () => {
      _ensureAuthed(() => mp.joinLobby(lobby.id));
    });
    list.appendChild(entry);
  }
}

// ── Lobby card ────────────────────────────────────────────────────────────────

const _HERO_PERSONALITIES  = ['balanced', 'berserker', 'sentinel', 'scavenger'];
const _WITCH_PERSONALITIES = ['balanced', 'aggressive', 'swarm'];
const _PERSONALITY_LABELS  = {
  balanced: 'Balanced', berserker: 'Berserker', sentinel: 'Sentinel',
  scavenger: 'Scavenger', aggressive: 'Aggressive', swarm: 'Swarm',
};

function _renderLobby(lobby) {
  if (!lobby) return;
  _currentLobby = lobby;
  showStep('lobby');

  // Code display for private games
  const codeWrap = document.getElementById('lobby-code-wrap');
  const codeDisp = document.getElementById('lobby-code-display');
  if (lobby.isPrivate && lobby.code) {
    codeWrap.style.display = '';
    codeDisp.textContent   = lobby.code;
  } else {
    codeWrap.style.display = 'none';
  }

  // Config summary
  const pps  = lobby.config?.playersPerSide ?? 1;
  const size = lobby.config?.mapSize ?? 'standard';
  const fogMode = lobby.config?.fog ?? 'partial';
  const fog  = fogMode === 'none' ? 'No fog' : `Fog: ${fogMode.charAt(0).toUpperCase() + fogMode.slice(1)}`;
  document.getElementById('lobby-config-summary').textContent =
    `${pps}v${pps} · ${size.charAt(0).toUpperCase() + size.slice(1)} · ${fog}`;

  // Slots grid
  const myId    = mp?.player?.id;
  const isHost  = lobby.hostPlayerId === myId;
  const grid    = document.getElementById('lobby-slots-grid');
  grid.innerHTML = '';

  const heroSlots  = lobby.slots.filter(s => s.faction === 'hero');
  const witchSlots = lobby.slots.filter(s => s.faction === 'witch');

  const container = document.createElement('div');
  container.className = 'lobby-factions';

  for (const [label, icon, slots] of [['Hero Side', '⚔', heroSlots], ['Witch Side', '✦', witchSlots]]) {
    const col = document.createElement('div');
    col.className = 'lobby-faction-col';
    col.innerHTML = `<div class="lobby-faction-label">${icon} ${label}</div>`;

    for (const slot of slots) {
      const row = document.createElement('div');
      row.className = 'lobby-slot-row';

      if (slot.status === 'human') {
        const isMe = slot.playerId === myId;
        row.innerHTML = `<span class="lobby-slot-name">${_esc(slot.name)}${isMe ? ' <em>(you)</em>' : ''}</span>`;
      } else if (slot.status === 'ai') {
        const label = _PERSONALITY_LABELS[slot.personality] ?? 'Balanced';
        row.innerHTML = `<span class="lobby-slot-name ai-slot">🤖 ${_esc(slot.name ?? 'AI')}</span>`;
        if (isHost) {
          const removeBtn = document.createElement('button');
          removeBtn.className = 'setup-btn secondary lobby-slot-btn';
          removeBtn.textContent = '✕';
          removeBtn.addEventListener('click', () => {
            mp.removeSlotAI(lobby.id, slot.seatIndex + (slot.faction === 'witch' ? pps : 0));
          });
          row.appendChild(removeBtn);
        }
      } else {
        // empty slot
        row.innerHTML = `<span class="lobby-slot-name empty-slot">Waiting…</span>`;
        if (isHost) {
          const personalities = slot.faction === 'witch' ? _WITCH_PERSONALITIES : _HERO_PERSONALITIES;
          const select = document.createElement('select');
          select.className = 'setup-select lobby-personality-select';
          // Non-balanced personalities are temporarily disabled pending tuning.
          select.innerHTML = '<option value="">— Assign AI —</option>' +
            ['random', ...personalities].map(p => {
              const disabled = p !== 'random' && p !== 'balanced';
              const label = p === 'random' ? 'Random' : (_PERSONALITY_LABELS[p] ?? p);
              return `<option value="${p}"${disabled ? ' disabled style="color:#666"' : ''}>${disabled ? `${label} (soon)` : label}</option>`;
            }).join('');
          select.addEventListener('change', () => {
            if (!select.value) return;
            const idx = lobby.slots.indexOf(slot);
            mp.setSlotAI(lobby.id, idx, select.value);
            select.value = '';
          });
          row.appendChild(select);
        }
      }
      col.appendChild(row);
    }
    container.appendChild(col);
  }
  grid.appendChild(container);

  // Start button — enabled only for host when all slots filled
  const startBtn = document.getElementById('btn-lobby-start');
  const allFilled = lobby.slots.every(s => s.status !== 'empty');
  startBtn.disabled = !(isHost && allFilled);
}

document.getElementById('btn-lobby-populate-ai').addEventListener('click', () => {
  if (_currentLobby) mp.fillAllWithAI(_currentLobby.id, 'random');
});

document.getElementById('btn-lobby-start').addEventListener('click', () => {
  if (_currentLobby) mp.startGame(_currentLobby.id);
});

document.getElementById('btn-lobby-leave').addEventListener('click', () => {
  if (_currentLobby) {
    mp.leaveLobby(_currentLobby.id);
    _currentLobby = null;
  }
  showStep('multiplayer');
});

function _initMpStep() {
  const session     = loadSession();
  const sessionInfo = document.getElementById('mp-session-info');
  const nameForm    = document.getElementById('mp-name-form');
  const actionBtns  = document.getElementById('mp-action-buttons');

  if (session) {
    document.getElementById('mp-session-name').textContent = session.username;
    sessionInfo.style.display = '';
    nameForm.style.display    = 'none';
    actionBtns.style.display  = '';
  } else {
    sessionInfo.style.display = 'none';
    nameForm.style.display    = '';
    actionBtns.style.display  = 'none';
  }

  // Reset form states
  document.getElementById('mp-name-error').style.display = 'none';
  const loginStatus = document.getElementById('mp-email-login-status');
  if (loginStatus) loginStatus.style.display = 'none';
}

// ── Account page ──────────────────────────────────────────────────────────────

async function _initAccountPage() {
  const session = loadSession();
  const signedOut = document.getElementById('acct-signed-out');
  const signedIn  = document.getElementById('acct-signed-in');

  if (!session) {
    signedOut.style.display = '';
    signedIn.style.display  = 'none';
    return;
  }

  signedOut.style.display = 'none';
  signedIn.style.display  = '';

  // Username
  document.getElementById('acct-username').textContent = session.username;
  document.getElementById('acct-name-edit').style.display = 'none';
  document.getElementById('acct-name-error').style.display = 'none';

  // Stats
  const stats = document.getElementById('acct-stats');
  stats.textContent = `${session.wins ?? 0}W / ${session.losses ?? 0}L / ${session.draws ?? 0}D`;

  // Email — fetch linked identities
  const emailEl   = document.getElementById('acct-email');
  const linkBtn   = document.getElementById('btn-acct-link-email');
  const emailForm = document.getElementById('acct-email-form');
  const emailBadge = document.getElementById('mp-email-badge');
  emailForm.style.display = 'none';
  const emailStatus = document.getElementById('acct-email-status');
  if (emailStatus) emailStatus.style.display = 'none';

  try {
    const identities = await fetchIdentities(session.token);
    if (identities === null) {
      // Token rejected by server — stale session
      clearSession();
      signedOut.style.display = '';
      signedIn.style.display  = 'none';
      return;
    }
    const emailIdentity = identities.find(i => i.provider === 'email');
    if (emailIdentity) {
      emailEl.textContent = emailIdentity.provider_id;
      linkBtn.style.display = 'none';
      // Also update the MP screen badge
      if (emailBadge) {
        emailBadge.textContent = `✓ ${emailIdentity.provider_id}`;
        emailBadge.style.display = '';
      }
    } else {
      emailEl.textContent = 'Not linked';
      linkBtn.style.display = '';
      if (emailBadge) emailBadge.style.display = 'none';
    }
  } catch {
    emailEl.textContent = 'Not linked';
    linkBtn.style.display = '';
    if (emailBadge) emailBadge.style.display = 'none';
  }
}

// Account: go to MP to sign in
document.getElementById('btn-acct-goto-mp').addEventListener('click', () => {
  _showMultiplayerScreen();
});

// Account: edit username
document.getElementById('btn-acct-edit-name').addEventListener('click', () => {
  const session = loadSession();
  document.getElementById('acct-name-input').value = session?.username || '';
  document.getElementById('acct-name-edit').style.display = '';
  document.getElementById('acct-name-error').style.display = 'none';
});

document.getElementById('btn-acct-cancel-name').addEventListener('click', () => {
  document.getElementById('acct-name-edit').style.display = 'none';
});

document.getElementById('btn-acct-save-name').addEventListener('click', async () => {
  const session = loadSession();
  if (!session) return;

  const input = document.getElementById('acct-name-input');
  const newName = input.value.trim();
  const errorEl = document.getElementById('acct-name-error');

  try {
    const res = await fetch('/api/account/username', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: session.token, username: newName }),
    });
    const data = await res.json();

    if (data.ok) {
      // Update session in localStorage
      session.username = data.player.username;
      localStorage.setItem('brimstone_session', JSON.stringify(session));
      // Update displays
      document.getElementById('acct-username').textContent = data.player.username;
      document.getElementById('acct-name-edit').style.display = 'none';
      document.getElementById('mp-session-name').textContent = data.player.username;
    } else {
      errorEl.textContent = data.error || 'Failed to change username.';
      errorEl.style.display = '';
    }
  } catch {
    errorEl.textContent = 'Network error. Please try again.';
    errorEl.style.display = '';
  }
});

// Account: link email
document.getElementById('btn-acct-link-email').addEventListener('click', () => {
  const form = document.getElementById('acct-email-form');
  form.style.display = form.style.display === 'none' ? '' : 'none';
});

document.getElementById('btn-acct-send-link').addEventListener('click', async () => {
  const session = loadSession();
  if (!session) return;

  const email = document.getElementById('acct-email-input').value.trim();
  if (!email) return;

  const statusEl = document.getElementById('acct-email-status');
  statusEl.textContent = 'Sending…';
  statusEl.className   = 'setup-hint';
  statusEl.style.display = '';

  const result = await requestLinkEmail(session.token, email);
  if (result.ok) {
    statusEl.textContent = result.message || 'Check your email for the link!';
    statusEl.className   = 'setup-hint';
  } else {
    statusEl.textContent = result.error || 'Failed to send link.';
    statusEl.className   = 'setup-error';
  }
});

// Account: sign out
document.getElementById('btn-acct-signout').addEventListener('click', () => {
  clearSession();
  if (mp) { mp.disconnect(); mp = null; }
  renderer = null; ui = null; state = null;
  _initAccountPage();
});

document.getElementById('btn-mp-signin').addEventListener('click', () => {
  _ensureAuthed(() => {
    _initMpStep();
    _fetchActiveSaves();
  });
});

document.getElementById('btn-mp-sign-out').addEventListener('click', () => {
  clearSession();
  document.getElementById('mp-session-info').style.display = 'none';
  document.getElementById('mp-name-form').style.display    = '';
  document.getElementById('mp-action-buttons').style.display = 'none';
  document.getElementById('active-games-list').innerHTML =
    '<p class="saves-empty">Sign in to see your active games.</p>';
  document.getElementById('async-games-list').innerHTML =
    '<p class="saves-empty">Sign in to see async games.</p>';
  if (mp) { mp.disconnect(); mp = null; }
  renderer = null; ui = null; state = null;
});

// ── Email login (new device, no session — on multiplayer screen) ─────────────

document.getElementById('btn-mp-email-login').addEventListener('click', async () => {
  const emailInput = document.getElementById('mp-email-login-input');
  const email = emailInput.value.trim();
  if (!email) return;

  const statusEl = document.getElementById('mp-email-login-status');
  statusEl.textContent = 'Sending…';
  statusEl.className   = 'setup-hint';
  statusEl.style.display = '';

  const result = await requestEmailLogin(email);
  if (result.ok) {
    statusEl.textContent = result.message || 'Check your email for the login link!';
    statusEl.className   = 'setup-hint';
  } else {
    statusEl.textContent = result.error || 'Failed to send link.';
    statusEl.className   = 'setup-error';
  }
});

function _onlineError(msg) {
  const el = document.getElementById('mp-name-error');
  el.textContent    = msg;
  el.style.display  = '';
}

/** Ensure we have an authenticated MultiplayerClient, then call cb(). */
function _ensureAuthed(cb) {
  const nameInput = document.getElementById('mp-username');
  const session   = loadSession();
  const wsUrl     = _serverWsUrl();

  // Create fresh client if needed, or reconnect a dropped one
  if (!mp) {
    mp = _createMpClient();
    mp.connect(wsUrl);
  } else if (!mp.connected) {
    // Stale connection — reconnect
    mp.connect(wsUrl);
  }

  if (session && mp.player?.id === session.id && mp.connected) {
    // Already authenticated on a live connection
    cb();
    return;
  }

  // Authenticate first, then run cb
  mp._opts._onAuthOk = cb;
  if (session) {
    mp.auth({ token: session.token });
  } else {
    const username = nameInput.value.trim();
    if (username.length < 2) { _onlineError('Enter a username (2+ characters).'); return; }
    mp.auth({ username });
  }
}

function _applyOnlinePlanningPhase(payload) {
  if (!ui || !mp) return;
  const { myActionsLeft, heroActionsLeft, witchActionsLeft, players, timeoutMs } = payload;
  // Prefer per-player budget; fall back to legacy faction budget for old servers.
  const budget = myActionsLeft ?? (mp.myFaction === 'hero' ? heroActionsLeft : witchActionsLeft);
  ui.exitPlanningMode();
  if (players) ui._players = players;
  ui.enterPlanningMode(mp.myFaction, budget, timeoutMs ?? 0);
  ui.onPlanSubmit = (plan) => mp.submitPlan(plan);
}

function _serverWsUrl() {
  // Allow override via global (set by server when serving the page, for production)
  if (window.BRIMSTONE_WS) return window.BRIMSTONE_WS;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}`;
}

function _createMpClient() {
  return new MultiplayerClient({
    onState(mirrorState) {
      if (!renderer || !ui) {
        // Game not started yet — any state update while active should start it
        if (mp?.active) {
          try {
            mirrorState.myFaction = mp.myFaction; // used by renderer for per-player fog
            initOnline(mirrorState, mp.myFaction, mp);
          } catch (err) {
            console.error('initOnline failed:', err);
            _onlineError(`Failed to start game: ${err.message}`);
            showStep('multiplayer');
            _initMpStep();
          }
        }
        return;
      }

      // Suppress mid-resolution state pushes — the animation owns state.entities right now.
      if (_resolving) return;

      // Already in game — update in-place (keeps renderer pan/zoom)

      // Snapshot entity positions before update so we can animate moves
      const oldPos = new Map();
      for (const e of state.entities) oldPos.set(e.id, { col: e.col, row: e.row });

      Object.assign(state, mirrorState);
      state.hero      = mirrorState.hero;
      state.witch     = mirrorState.witch;
      state.myFaction = mp.myFaction; // persist faction for per-player fog of war

      // Animate entities that changed hex position (opponent moves)
      if (!state.gameOver && renderer) {
        for (const e of state.entities) {
          const old = oldPos.get(e.id);
          if (old && (old.col !== e.col || old.row !== e.row)) {
            renderer.addMoveAnim(e.id, old.col, old.row, e.col, e.row, e.type, e.owner, e.title ?? null);
          }
        }
      }

      ui._clearSelection();
      ui._triggerPostRoundEffects();
      redrawOnline();
    },

    onBattle(actorSnap, targetSnap, result, afterDismiss) {
      // Flash attacker + defender hexes before showing the dialog
      if (renderer && state) {
        const actor  = state.entities.find(e => e.id === actorSnap.id);
        const target = state.entities.find(e => e.id === targetSnap.id);
        if (actor && target) {
          renderer.addAttackAnim(actor.col, actor.row, target.col, target.row);
          // HP-change floaters from pre/post snapshot comparison
          renderer.addHpChangeFlash(actor.col,  actor.row,  actor.hp  - actorSnap.hp);
          renderer.addHpChangeFlash(target.col, target.row, target.hp - targetSnap.hp);
        }
      }

      // Show "Battle Again" when it's our battle, the target survived, and
      // we have enough actions remaining after spending 1 on this battle.
      let onRematch = null;
      if (actorSnap.owner === mp?.myFaction && !result.killed) {
        const actorHpAfter   = actorSnap.hp - (result.counterDmg || 0);
        const actionsAfter   = (state?.actionsLeft ?? 0) - (result.cost ?? 1);
        if (actorHpAfter > 0 && actionsAfter > 0) {
          onRematch = () => {
            afterDismiss?.();   // apply state update first
            mp.sendAction('battle', { entityId: actorSnap.id, targetId: targetSnap.id });
          };
        }
      }

      if (ui) {
        ui._showBattleDialog(actorSnap, targetSnap, result, afterDismiss, onRematch);
      } else {
        afterDismiss?.();
      }
    },

    onLobbyJoined(lobby) {
      _renderLobby(lobby);
    },

    onLobbyUpdate(lobby) {
      _renderLobby(lobby);
    },

    onLobbyList(rooms) {
      _renderPublicLobbies(rooms);
    },

    onMatchFound({ roomId, faction, opponentName, aiOpponent, resumed, myPlayerId, players, priorRounds }) {
      // Reset online round history for this game, restoring prior rounds on resume
      if (resumed && priorRounds?.length) {
        _onlineRoundHistory = priorRounds.map(r => ({
          roundNum: r.roundNum,
          preState: r.preStateJson,
          steps:    r.stepsJson,
        }));
      } else {
        _onlineRoundHistory = [];
      }
      // Show waiting card briefly during game start (covers both resume and lobby→game transitions)
      showStep('waiting');
      if (resumed) {
        document.getElementById('waiting-subtitle').textContent =
          `Resuming as ${faction === 'hero' ? 'Hero ⚔' : 'Witch ✦'}`;
        document.getElementById('waiting-message').textContent =
          `Restored! Starting game…`;
      } else {
        document.getElementById('waiting-subtitle').textContent =
          `Game starting as ${faction === 'hero' ? 'Hero ⚔' : 'Witch ✦'}`;
        document.getElementById('waiting-message').textContent =
          `Starting game…`;
      }
      _currentLobby = null;
      // Store player context so initOnline / enterPlanningMode can use it.
      if (ui) {
        if (myPlayerId) ui.myPlayerId = myPlayerId;
        if (players)   ui._players   = players;
      }
      // Game starts when first stateUpdate arrives → onState handles initOnline
    },

    onPlayerSubmitted({ playerId, name, faction }) {
      if (ui) ui._onPlayerSubmitted(playerId, name, faction);
    },

    onTimerReset(timeoutMs) {
      if (ui) ui.resetCountdown(timeoutMs);
    },

    onLeaderboard(_entries) {
      // Leaderboard removed — no-op
    },

    onInQueue(_position) {
      // Queue removed — no-op
    },

    onOpponentJoined(name) {
      // Lobby update handles this now — no-op
    },

    onOpponentDisconnected(graceMs) {
      const secs = Math.round(graceMs / 1000);
      const statusEl = document.getElementById('plan-status');
      if (statusEl) statusEl.textContent = `⚠ Opponent disconnected — waiting ${secs}s for reconnect…`;
    },

    onOpponentReconnected() {
      const statusEl = document.getElementById('plan-status');
      if (statusEl) statusEl.textContent = '';
    },

    onPlanningPhase(payload) {
      if (!ui || !mp) return;
      // If the resolution animation is still running, defer until it finishes.
      if (_resolving) {
        _pendingPlanningPhase = payload;
        return;
      }
      _applyOnlinePlanningPhase(payload);
    },

    onOpponentReady() {
      const statusEl = document.getElementById('plan-status');
      if (statusEl) statusEl.textContent = 'Opponent ready — waiting for resolution…';
    },

    onResolutionComplete({ steps, finalState }) {
      if (!ui || !renderer) return;
      state.resolving = true;   // flag before exitPlanningMode fires its redraw
      ui.exitPlanningMode();

      // Snapshot state BEFORE applying finalState — used for full-game replay
      const _onlinePreStateJson = JSON.stringify(serializeState(state));
      const _onlineRoundNum     = state.round;

      // Use the server's final entity list as the landing state for the animation.
      // This ensures state.entities is already correct when the last slide lands.
      const finalEntities = finalState.entities ?? state.entities;

      const _preReplayEntitiesOnline = steps[0]?.entitySnapshot ?? finalEntities;

      // Snapshot node control BEFORE resolution using pre-step entities
      const preResEntities = steps[0]?.entitySnapshot ?? state.entities;
      const prevNodes = (state.witchObjectives ?? []).map(obj => ({
        col: obj.col, row: obj.row, label: obj.label,
        owner: nodeController(obj, preResEntities),
      }));
      const prevScore = { hero: state.nodeScore?.hero ?? 0, witch: state.nodeScore?.witch ?? 0 };

      _animateResolutionSteps(steps, finalEntities, redrawOnline, mp?.myFaction, mp?.myPlayerId ?? null).then(async () => {
        // Apply full final state (phase, round, score, tiles, etc.) BEFORE summary
        // so the reckoning section can show scoring results.
        Object.assign(state, finalState);
        state.hero      = finalState.hero;
        state.witch     = finalState.witch;
        state.myFaction = mp?.myFaction;

        // Accumulate round for full-game replay
        _onlineRoundHistory.push({
          roundNum:  _onlineRoundNum,
          preState:  _onlinePreStateJson,
          steps:     JSON.stringify(steps),
        });

        // Mirror the same post-resolution side effects as the local path.
        await ui._triggerPostRoundEffects();
        redrawOnline();

        // Show post-resolution summary modal for human players.
        // Keep _resolving = true for the whole summary+replay block so that any
        // incoming onPlanningPhase messages are buffered, not immediately applied.
        if (ui && mp?.myFaction) {
          _resolving = true;
          let action;
          do {
            action = await ui._showResolutionSummary(steps, (finalState.round ?? state.round) - 1, {
              prevScore, prevNodes, humanFaction: mp.myFaction, fogOfWar: state.fogOfWar,
              gameOver: state.gameOver, winner: state.winner, winReason: state.winReason,
              hasFullReplay: _onlineRoundHistory.length > 0,
            });
            if (action === 'replay') {
              state.entities = _preReplayEntitiesOnline;
              // Reset explored flags newly set this round so they reveal progressively.
              const preExpOnline = new Set();
              for (const s of steps) {
                for (const ev of [...(s.heroEvents ?? []), ...(s.witchEvents ?? []), ...(s.playerEvents ?? []).flatMap(pe => pe.events ?? [])]) {
                  if (ev.type === ResEventType.ACTION_OK && ev.action?.type === PlanActionType.EXPLORE) {
                    const actor = s.entitySnapshot?.find(e => e.id === ev.action.entityId);
                    if (actor) { const tk = _hexKey(actor.col, actor.row); const t = state.tiles.get(tk); if (t) t.explored = false; }
                  }
                }
              }
              redrawOnline();
              await _animateResolutionSteps(steps, finalEntities, redrawOnline, mp.myFaction, mp.myPlayerId ?? null);
              // Restore explored flags after replay.
              for (const s of steps) {
                for (const ev of [...(s.heroEvents ?? []), ...(s.witchEvents ?? []), ...(s.playerEvents ?? []).flatMap(pe => pe.events ?? [])]) {
                  if (ev.type === ResEventType.ACTION_OK && ev.action?.type === PlanActionType.EXPLORE) {
                    const actor = s.entitySnapshot?.find(e => e.id === ev.action.entityId);
                    if (actor) { const tk = _hexKey(actor.col, actor.row); const t = state.tiles.get(tk); if (t) t.explored = true; }
                  }
                }
              }
              // _animateResolutionSteps sets _resolving = false at end; re-engage
              // the guard so onPlanningPhase stays buffered during the next summary show.
              _resolving = true;
            } else if (action === 'replay-full') {
              _resolving = false;
              await _replayFullGame(_onlineRoundHistory, state.winner, state.winReason,
                state.hero?.displayName ?? 'Hero', state.witch?.displayName ?? 'Witch',
                redrawOnline);
              _doRestart();
              return;
            }
          } while (action === 'replay');
          _resolving = false;
          // Animate score bar changes after summary is dismissed
          ui._animateScoreBar(prevScore, prevNodes);

          if (state.gameOver) {
            if (action === 'viewmap') {
              state.fogOfWar = 'none';
              redrawOnline();
            } else if (action === 'restart') {
              _doRestart();
            }
            return;
          }
        } else if (state.gameOver) {
          return;
        }

        if (!state.gameOver) {
          // Planning mode: never show "no actions" dialog here — a new planning
          // phase is always imminent. Apply any buffered planning phase immediately.
          if (_pendingPlanningPhase) {
            const payload = _pendingPlanningPhase;
            _pendingPlanningPhase = null;
            _applyOnlinePlanningPhase(payload);
          }
        }
      });
    },

    // ── Async game callbacks ─────────────────────────────────────
    onAsyncStateUpdate(msg) { _handleAsyncStateUpdate(msg); },
    onAsyncPlanAccepted(msg) { _handleAsyncPlanAccepted(msg); },
    onAsyncResolution(msg)  { _handleAsyncResolution(msg); },
    onAsyncPlanStatus(msg)  { _handleAsyncPlanStatus(msg); },

    onError(msg) {
      // During auth phase, show error in the lobby
      if (!state || document.getElementById('setup-screen').style.display !== 'none') {
        showStep('multiplayer');
        _initMpStep();
        _onlineError(msg);  // show after _initMpStep so it doesn't get reset
      } else {
        // In-game error — show as modal dialog
        if (ui) ui._showResultDialog([`⚠ ${msg}`]);
      }
    },

    // Internal hook for post-auth callback
    _onAuthOk: null,
  });
}

// Patch MultiplayerClient to handle auth callbacks and surface auth errors
const _origRoute = MultiplayerClient.prototype._route;
MultiplayerClient.prototype._route = function(msg) {
  _origRoute.call(this, msg);

  if (msg.type === 'authOk' && this._opts._onAuthOk) {
    const cb = this._opts._onAuthOk;
    this._opts._onAuthOk = null;
    cb();
  }

  if (msg.type === 'authError') {
    // Token no longer valid (e.g. server restarted) — clear session and
    // show the name-entry form so the error label inside it is visible.
    const expiredSession = loadSession();
    clearSession();
    if (mp) mp._player = null;
    document.getElementById('mp-session-info').style.display    = 'none';
    document.getElementById('mp-name-form').style.display       = '';
    document.getElementById('mp-action-buttons').style.display  = 'none';
    if (expiredSession?.username) {
      document.getElementById('mp-username').value = expiredSession.username;
    }
    showStep('multiplayer');
  }
};

// ── Spectator mode ────────────────────────────────────────────────────────────

function initSpectator(roomId) {
  document.body.classList.add('spectator-mode');
  const statusEl = document.getElementById('spectate-status');
  statusEl.style.display = '';
  statusEl.textContent = 'Connecting...';

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = window.BRIMSTONE_WS ?? `${protocol}//${location.host}`;
  const ws = new WebSocket(wsUrl);

  let planningPlayers = [];
  let submittedIds    = new Set();

  ws.addEventListener('open', () => {
    statusEl.textContent = 'Joining room...';
    ws.send(JSON.stringify({ type: 'adminSpectateRoom', roomId }));
  });

  ws.addEventListener('message', e => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    _handleSpectatorMessage(msg);
  });

  ws.addEventListener('close', () => {
    statusEl.textContent = 'Disconnected.';
    statusEl.style.display = '';
  });

  ws.addEventListener('error', () => {
    statusEl.textContent = 'Connection error.';
    statusEl.style.display = '';
  });

  function _handleSpectatorMessage(msg) {
    switch (msg.type) {
      case 'adminSpectateInit': {
        statusEl.style.display = 'none';
        document.getElementById('spectator-info').style.display = '';
        document.getElementById('spectator-banner').style.display = '';
        const mirrorState = MirrorState.fromSnapshot(msg.state);
        mirrorState.fogOfWar = 'none';
        _initSpectatorUI(mirrorState);
        _updateSpectatorInfoBar(msg.players, mirrorState);
        break;
      }
      case 'stateUpdate': {
        const mirrorState = MirrorState.fromSnapshot(msg.state);
        mirrorState.fogOfWar = 'none';
        state = mirrorState;
        ui?.updateState(mirrorState);
        _updateSpectatorRoundLabel(mirrorState);
        _checkSpectatorGameOver(mirrorState);
        break;
      }
      case 'resolutionComplete': {
        const finalMirror = MirrorState.fromSnapshot(msg.finalState);
        finalMirror.fogOfWar = 'none';
        const finalEntities = finalMirror.entities;
        const redrawFn = () => renderer?.draw();
        // Animate the resolution steps before applying the final state.
        // Pass 'spectator' as humanFaction sentinel: fog is off so all units are
        // visible, battles are shown, but encounter dialogs are suppressed
        // (no faction matches 'spectator', so pendingDialogs stays empty).
        _animateResolutionSteps(
          msg.steps ?? [],
          finalEntities,
          redrawFn,
          'spectator',
          null,
        ).then(() => {
          state = finalMirror;
          ui?.updateState(finalMirror);
          _updateSpectatorRoundLabel(finalMirror);
          _checkSpectatorGameOver(finalMirror);
          planningPlayers = [];
          submittedIds = new Set();
          _renderSpectatorReadyList(planningPlayers, submittedIds);
        });
        break;
      }
      case 'adminPlanningPhase': {
        document.getElementById('sp-round').textContent = `Round ${msg.round} — ${msg.phase}`;
        if (msg.players) {
          planningPlayers = msg.players;
          submittedIds = new Set();
          _renderSpectatorReadyList(planningPlayers, submittedIds);
        }
        break;
      }
      case 'playerSubmitted': {
        submittedIds.add(msg.playerId);
        _renderSpectatorReadyList(planningPlayers, submittedIds);
        break;
      }
      case 'resolutionStart': {
        planningPlayers = [];
        submittedIds = new Set();
        _renderSpectatorReadyList(planningPlayers, submittedIds);
        break;
      }
      case 'adminRoomEnded':
        statusEl.textContent = 'Game ended.';
        statusEl.style.display = '';
        break;
      case 'error':
        statusEl.textContent = msg.message || 'Error';
        statusEl.style.display = '';
        break;
    }
  }

  function _initSpectatorUI(mirrorState) {
    const canvas = document.getElementById('game-canvas');
    renderer = new Renderer(canvas, mirrorState);
    renderer.resize();
    renderer.loadImages();
    ui = new UIController(canvas, mirrorState, renderer, null, () => renderer.draw(), null, false);
    ui.setMode(UIMode.SPECTATOR);
    ui.speedMode = 'fast';
    window.addEventListener('resize', () => { renderer.resize(); renderer.draw(); });
    renderer.draw();
  }
}

function _updateSpectatorInfoBar(players, st) {
  if (players) {
    const heroNames  = players.filter(p => p.faction === 'hero').map(p => p.name).join(', ');
    const witchNames = players.filter(p => p.faction === 'witch').map(p => p.name).join(', ');
    document.getElementById('sp-hero').textContent  = `⚔ ${heroNames  || 'Hero'}`;
    document.getElementById('sp-witch').textContent = `✦ ${witchNames || 'Witch'}`;
  }
  _updateSpectatorRoundLabel(st);
}

function _updateSpectatorRoundLabel(st) {
  document.getElementById('sp-round').textContent = `Round ${st.round} — ${st.phase}`;
}

function _checkSpectatorGameOver(st) {
  if (!st.gameOver) return;
  const goEl    = document.getElementById('spectate-game-over');
  const winText = document.getElementById('sp-winner-text');
  const reasonEl = document.getElementById('sp-win-reason');
  winText.textContent = st.winner === 'hero' ? 'Hero Wins!' : 'Witch Wins!';
  winText.style.color = st.winner === 'hero' ? 'var(--hero)' : 'var(--witch)';
  reasonEl.textContent = st.winReason || '';
  goEl.style.display = '';
}

function _renderSpectatorReadyList(players, submittedIds) {
  const panel = document.getElementById('sp-ready-panel');
  const list  = document.getElementById('sp-ready-list');
  if (!panel || !list) return;
  if (players.length === 0) { panel.style.display = 'none'; return; }
  panel.style.display = 'flex';
  list.innerHTML = players.map(p => {
    const submitted = submittedIds.has(p.playerId);
    const fCls      = `sp-ready-faction-${p.faction}`;
    const dotCls    = submitted ? 'sp-ready-dot submitted' : 'sp-ready-dot';
    const status    = submitted ? '✓' : '…';
    const safeName  = String(p.name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<div class="sp-ready-row">
      <span class="${dotCls}"></span>
      <span class="sp-ready-name ${fCls}" title="${safeName}">${safeName}</span>
      <span style="font-size:0.72rem;color:${submitted ? 'var(--green)' : 'var(--text-dim)'}">${status}</span>
    </div>`;
  }).join('');
}

// Auto-start spectator mode when ?spectate=<roomId> or ?room=<roomId> is in the URL.
// This allows /spectate?room=X (served as index.html) to work automatically.
const _spectateParam = new URLSearchParams(location.search).get('spectate')
                    ?? new URLSearchParams(location.search).get('room');
if (_spectateParam) initSpectator(_spectateParam);

// Auto-start admin replay when ?replayGame=<gameId>[&source=sp] is in the URL.
// This allows /replay?replayGame=X (served as index.html) to work automatically.
const _replayGameParam   = new URLSearchParams(location.search).get('replayGame');
const _replaySourceParam = new URLSearchParams(location.search).get('source') ?? 'mp';
if (_replayGameParam) _loadAdminReplay(_replayGameParam, _replaySourceParam);

async function _loadAdminReplay(gameId, source = 'mp') {
  const base = source === 'sp'
    ? `/admin/api/sp/completed-games/${encodeURIComponent(gameId)}`
    : `/admin/api/completed-games/${encodeURIComponent(gameId)}`;

  try {
    const [meta, rounds] = await Promise.all([
      fetch(base).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
      fetch(`${base}/rounds`).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
    ]);

    if (!rounds.length) { alert('No replay rounds found for this game.'); return; }

    const replayRounds = rounds.map(r => ({
      roundNum: r.round_num,
      preState: r.pre_state_json,
      steps:    r.steps_json,
    }));

    await _startMpReplay(replayRounds, meta);
  } catch (e) {
    console.error('Admin replay load error:', e);
    alert('Could not load replay data.');
  }
}

// Auto-login via magic link redirect: ?email_token=<token>
const _emailToken = checkEmailTokenInUrl();
if (_emailToken) {
  // The URL param is a session token from a verified magic link.
  // Store it and show the multiplayer screen as logged in.
  try {
    // We need to auth with the server to get the full player object.
    // Create a temporary client to authenticate.
    const _tmpMp = _createMpClient();
    _tmpMp.connect(_serverWsUrl());
    _tmpMp._opts._onAuthOk = () => {
      mp = _tmpMp;
      _showMultiplayerScreen();
    };
    _tmpMp.auth({ token: _emailToken });
  } catch {
    // Fallback: just store minimal session and show multiplayer screen
    _showMultiplayerScreen();
  }
}
