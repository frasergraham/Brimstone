// Entry point: wires all modules, setup screen flow, resize
import { onInactiveChange, tryGameCenterAuth, isNativeMobile, refreshPushToken, loadGameCenterFriends, shareInvite } from './platform.js'; // must be first — sets server globals for Capacitor builds
import { AppMode, getMode, setMode, isInGame, isAnimating, shouldBufferMessages, onModeChange } from './app-mode.js';
import { initServerSelector } from './server-selector.js';
import { GameState, phaseForRound, getCycleLength } from './game.js';
import { DAMAGE_SCALE } from './balance.js';
import { Renderer3D, BLOCK_WORD_VARIANTS } from './renderer-3d.js';

// The in-game renderer is always 3D. The 2D `Renderer` is still exported from
// `./renderer.js` for the mission editor and admin-lighting tool.
function _pickRenderer() {
  if (typeof document !== 'undefined' && document.body) {
    document.body.classList.add('renderer-3d');
  }
  return Renderer3D;
}
import { UIController, UIMode } from './ui.js';
import { WITCH_PERSONALITIES }   from './ai.js';
import { WitchAIEngine, estimateCombat } from './ai-engine.js';
import { HeroAIEngine, estimateHeroCombat } from './hero-ai-engine.js';
import {
  isAIDebugActive, setAIDebugActive, setAIDebugData, clearAIDebugData,
  buildHexGoalMap, buildMoveArrows, buildIntentMarkers, buildNodeFeasibilityMap,
  GOAL_COLORS, updateAIDebugPanel, hideAIDebugPanel,
} from './ai-debug.js';
import {
  MultiplayerClient, MirrorState, loadSession, clearSession,
  checkEmailTokenInUrl, requestLinkEmail, requestEmailLogin, fetchIdentities,
} from './multiplayer.js';
import { VERSION, BUILD_VERSION } from './version.js';
import { buildPlayerStatusHtml } from './ui-render.js';
import { resolvePlans, ResEventType } from '../server/resolver.js';
import { PlanActionType, groupPlanByEntity } from './planner.js';
import { buildStepDigest, buildStoryBeatDigest, isEventVisible } from './replay-timeline.js';
import { hexDistance, getNeighbors, hexKey } from './hex.js';
import { planCombatFrames } from './combat-presentation.js';
import { MAX_FORTIFY_LEVEL, FORT_IMPASSABLE_THRESHOLD, deriveBlockedSlots } from './tiles.js';
import { sightRange, computeLineOfSight, hasLineOfSight, assignSlotOnTile } from './actions.js';
import { ITEMS } from './items.js';
import { getFaction, findFaction, allFactions, getFactionsForSide, sightRangeForEntity } from './factions.js';
import { compileTurnBattleSummary, compileTurnBattlePairs, collectTurnFinds, deferredMoveEntityIds } from './battle-utils.js';
import { collectWrapUpAttrition } from './post-round-effects.js';
import { applyEffect } from './effects.js';
import { installKeybindings } from './keybindings.js';
import { serializeState, deserializeState } from '../server/state-sync.js';
import * as audio from './audio.js';
import { playback, resetPlayback, replayFullGame, playbackDelay, swapState, patchAlive, withPinnedPhase } from './playback.js';
import { ReplayCache } from './replay-cache.js';
import { makeShowLoadingAndReveal } from './loading-reveal.js';
import { MAP_SIZES } from './map.js';
import { nodeController } from './game.js';
import { MissionConductor, areHintsSuppressed, markHintsSeen } from './mission-conductor.js';
import { Entity, createMinion, createZombie, createWoodGolem, createIronGolem, createSurvivor, EntityType, ENTITY_COLOR, applyLevel } from './entities.js';
import { hexKey as _hexKey } from './hex.js';
import { Campaign, CAMPAIGN_SLOT_COUNT, buildVictoryDelegate, snapshotSurvivor, processWaves, reconcileRosterAfterMission, applyCarriedHeroLoadout } from './campaign/campaign.js';
import { CAMPAIGNS, getCampaignById } from './campaign/campaign-registry.js';
import { processStoryTriggers } from './campaign/missions.js';
import { MissionLogicEngine } from './mission-logic/engine.js';
import { createGameContext } from './mission-logic/game-context.js';
import { loadConversation, bindParticipants } from './campaign/conversation-registry.js';
import { spawnNpcEntity, runScriptedActions } from './campaign/scripted-actions.js';
import { playConversation } from './conversation-player.js';
import { loadVoiceManifest } from './voiceover.js';
import { buildMissionMap } from './campaign/mission-map.js';
import { run3DCombatCardHold } from './combat-cinematic.js';
import { runDiscoveryReadout, discoveryText } from './discovery-cinematic.js';
import { playFastCombatDisplay } from './combat-fast.js';
import {
  campaignMissionSaveKey, loadCampaignMissionSave, deleteCampaignMissionSave,
  RESOURCE_ICONS as _RESOURCE_ICONS, hpColor as _hpColor,
  loadCampaignPortraits as _loadCampaignPortraits, getCampaignPortrait as _getCampaignPortrait,
  campaignCardHTML as _campaignCardHTML, survivorCardHTML as _survivorCardHTML,
  campaignPartyHTML as _campaignPartyHTML, objectiveDescription as _objectiveDescription,
  partyPaneHTML as _partyPaneHTML, missionListPaneHTML as _missionListPaneHTML,
  progressSquadCap as _progressSquadCap,
  missionRows as _missionRows,
  departureMessage as _departureMessage, arrivalMessage as _arrivalMessage,
} from './campaign/campaign-ui.js';
import { requestNotificationPermission, notifyRoundReady, notifyWaitingOnYou, notifyDeadlineApproaching, notifyGameOver } from './notifications.js';
import { mmSortRows, mmFormatRow, mmDedupeCampaignRows } from './main-menu-games.js';

// Stamp version into badge
document.getElementById('version-badge').textContent = `v${BUILD_VERSION}`;

// ── Game mode config (env-var driven) ────────────────────────────────────────
// Fetches /api/config to determine which game modes are enabled/disabled/hidden.
// Maps mode keys to the button IDs they control.
const _MODE_BUTTON_MAP = {
  singleplayer: 'btn-ng-vsai',
  multiplayer:  'btn-ng-online',
  story:        'btn-ng-campaign',
  battle:       'btn-ng-battle',
};

function _applyModeConfig(modes) {
  for (const [mode, btnId] of Object.entries(_MODE_BUTTON_MAP)) {
    const state = modes[mode];
    if (!state || state === 'enabled') continue;
    const btn = document.getElementById(btnId);
    if (!btn) continue;
    if (state === 'hidden') {
      btn.style.display = 'none';
    } else if (state === 'disabled') {
      btn.disabled = true;
      btn.classList.add('mode-disabled');
    }
  }
}

if (!window.electronAPI) {
  fetch(`${window.BRIMSTONE_SERVER || ''}/api/config`)
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (data?.modes) _applyModeConfig(data.modes);
      initServerSelector(data?.devMode ?? false);
    })
    .catch(() => {
      // offline / dev-server — all modes remain enabled; still try local dev-mode
      initServerSelector(false);
    });
} else {
  // Electron: always show selector (electronAPI implies dev)
  initServerSelector(true);
}

let state, renderer, ui, witchAI, heroAI;

// Global in-game keyboard shortcuts + debug command console. Installed once;
// reads the live UIController via the accessor so it survives ui/renderer
// re-creation across new-game / online / spectator starts. (No-op in tests.)
installKeybindings(() => ui);

let _autoplay  = false;
// _inGame and _resolving replaced by AppMode state machine (src/app-mode.js)
let _pendingPlanningPhase = null; // buffered onPlanningPhase payload received during animation
let _pendingSubmissions   = [];   // buffered playerSubmitted messages received during animation
let _missionConductor = null;     // non-null while a conductor-driven mission is active
let _gameStartTime = null;        // wall-clock timestamp for game duration tracking

// ── AI-assist (debug) ────────────────────────────────────────────────────────
// Enabled with the `aiAssist()` console command. Lets a human watch the AI play
// a (campaign) mission: during planning an "🤖 AI Plan" button appears that asks
// the AI to fill the player's plan, which the player then reviews and submits.
// `aiAssist('auto')` additionally auto-submits each round so a whole mission
// plays itself unattended.
let _aiAssistEnabled = false;
let _aiAutorun       = false;
let _assistAI        = null;   // lazily-built engine, rebuilt when state/faction change

// Faction id → leader AI engine, so a human can borrow either side's planner.
const _ASSIST_ENGINES = { hero: HeroAIEngine, witch: WitchAIEngine };

/** Build (or reuse) an AI engine for a faction against the current state. */
function _getAssistAI(faction) {
  if (!_assistAI || _assistAI.faction !== faction || _assistAI.state !== state) {
    const EngineClass = _ASSIST_ENGINES[faction] ?? HeroAIEngine;
    _assistAI = new EngineClass(state, redraw);
  }
  return _assistAI;
}

/** Generate an AI plan for the human's current planning faction. */
function _generateAssistPlan(faction) {
  if (!state || state.gameOver) return [];
  const plan = _getAssistAI(faction || 'hero').generatePlan();
  console.log(`[ai-assist] ${faction} plan — ${plan.length} actions:`,
    plan.map(a => a.type).join(', '));
  return plan;
}

/**
 * Toggle the "watch an AI play" debug mode. Driven by the in-game command
 * console (`/aiassist`, see COMMANDS in keybindings.js) — wired onto `ui` in
 * _setupLocalUI so the console can reach it without importing main.js. Modes:
 *   mode = true | 'manual'  — adds an "🤖 AI Plan" button to the planning panel;
 *                             click it to fill your plan, then Submit yourself.
 *   mode = 'auto'           — autorun: the AI fills AND submits every round (and
 *                             the wrap-up auto-advances) so the mission plays
 *                             itself.
 *   mode = false            — off.
 * Persists in module flags so it survives a mission restart (re-applied by
 * _setupLocalUI). Returns { enabled, autorun }.
 */
function applyAIAssistMode(mode = true, delayMs = null) {
  _aiAutorun       = (mode === 'auto' || mode === 'autorun');
  _aiAssistEnabled = _aiAutorun || (!!mode && mode !== 'off' && mode !== 'false');
  if (ui) {
    ui.aiAssistEnabled = _aiAssistEnabled;
    ui.aiAutorun       = _aiAutorun;
    if (delayMs != null && delayMs > 0) ui.aiAutorunDelay = delayMs;
    ui._syncAIAssistButton?.();
    // If autorun was switched on mid-planning, kick it off for this phase now.
    if (_aiAutorun) ui._maybeAutorun?.();
  }
  return { enabled: _aiAssistEnabled, autorun: _aiAutorun };
}

// Also expose on window as a convenience escape hatch for power users; the
// in-game `/aiassist` console command is the documented interface.
if (typeof window !== 'undefined') window.aiAssist = applyAIAssistMode;

// ── Round-history for full-game replay ───────────────────────────────────────
// Accumulated during a session; reset each new/resumed game.
let _roundHistory        = [];  // SP offline:  { roundNum, preState, steps }[]
let _keepTimelineForReview = false;  // SP: keep the timeline up after animation for the end-of-turn review
let _onlineRoundHistory  = [];  // MP online:   { roundNum, preState, steps }[]
// Playback state imported from ./playback.js (playback, resetPlayback, etc.)

// ── Replay cache (round-keyed) + pending server fetches ─────────────────────
// Used by "Replay last turn" to look up a replay by exact round number,
// falling back to the server if missing.
const _replayCache = new ReplayCache();
/** @type {Map<number, {resolve:Function, reject:Function, timer:any}>} */
const _replayRequests = new Map();
let _inlineReplayInFlight = false;

/**
 * Central helper: cache a replay entry by roundNum, and keep the legacy
 * chronological `_onlineRoundHistory` array in sync (used by full-game
 * PLAYBACK). Idempotent on roundNum so callers can invoke it freely.
 */
function _cacheReplay(entry) {
  if (!entry || typeof entry.roundNum !== 'number') return;
  _replayCache.set(entry);
  const tail = _onlineRoundHistory[_onlineRoundHistory.length - 1];
  if (!tail || tail.roundNum !== entry.roundNum) {
    const histEntry = {
      roundNum: entry.roundNum,
      preState: entry.preStateJson,
      steps:    entry.stepsJson,
    };
    if (entry.finalEntitiesJson) {
      histEntry.finalEntities = JSON.parse(entry.finalEntitiesJson);
    }
    _onlineRoundHistory.push(histEntry);
  }
}

/** Send a requestReplay to the server, resolving when replayData matches. */
function _requestReplayFromServer(roomId, roundNum) {
  return new Promise((resolve, reject) => {
    if (!mp) { reject(new Error('no connection')); return; }
    const prev = _replayRequests.get(roundNum);
    if (prev) {
      clearTimeout(prev.timer);
      prev.reject(new Error('superseded'));
    }
    const timer = setTimeout(() => {
      _replayRequests.delete(roundNum);
      reject(new Error('timeout'));
    }, 10_000);
    _replayRequests.set(roundNum, { resolve, reject, timer });
    mp.requestReplay(roomId, roundNum);
  });
}

function _handleReplayData(msg) {
  const entry = {
    roundNum:     msg.roundNum,
    preStateJson: msg.preStateJson,
    stepsJson:    msg.stepsJson,
  };
  _cacheReplay(entry);
  const pending = _replayRequests.get(msg.roundNum);
  if (pending) {
    clearTimeout(pending.timer);
    _replayRequests.delete(msg.roundNum);
    pending.resolve(entry);
  }
}

function _handleReplayError(msg) {
  const pending = _replayRequests.get(msg.roundNum);
  if (pending) {
    clearTimeout(pending.timer);
    _replayRequests.delete(msg.roundNum);
    pending.reject(new Error(msg.reason || 'replayError'));
  }
}

// Keep UIController.appMode in sync with the centralized mode.
onModeChange((newMode) => { if (ui) ui.appMode = newMode; });

// Compass rose visibility — show in every in-canvas mode (PLANNING / SUBMITTED
// / RESOLVING / SUMMARY / PLAYBACK / SPECTATING). Hidden on MENU. The mission
// editor / admin-tools pages load a different HTML shell, so the element isn't
// present there at all and this is a no-op when run there.
function _applyCompassRoseVisibility() {
  const el = document.getElementById('compass-rose');
  if (!el) return;
  el.hidden = getMode() === AppMode.MENU;
}
onModeChange(_applyCompassRoseVisibility);
// Apply once on registration — onModeChange listeners only fire on
// transitions, so a page that's already in PLANNING (e.g. an auto-resume or
// a fast-path entry that set the mode before main.js loaded) would otherwise
// keep the compass hidden until the next mode transition. This catches the
// initial state and matches it to whatever the mode currently is.
_applyCompassRoseVisibility();

/** Return the correct base URL for shareable links (invite, join, etc.).
 *  Inside Capacitor, location.origin is "capacitor://localhost" — useless for
 *  links shared with other people. Use BRIMSTONE_SERVER when available. */
function _linkOrigin() {
  return window.BRIMSTONE_SERVER || `${location.origin}${location.pathname}`;
}

// ── Local game init ───────────────────────────────────────────────────────────

function _genSaveId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * Show the loading overlay, drive its progress bar from the renderer's asset
 * bundle, and fade the canvas in once everything is ready. Works against either
 * renderer — the 2D path resolves almost immediately, the 3D path waits for the
 * Babylon engine + every GLB/atlas load (or the renderer's 30s safety timeout).
 *
 * `beginLoad()` is the single entry point that boots the renderer; `draw()` no
 * longer triggers init. We draw one full-quality frame while the overlay is
 * still up, wait a frame so it paints, then cross-fade overlay → canvas.
 *
 * Fire-and-forget from the synchronous init paths — the game's planning setup
 * runs in parallel; rendering simply catches up when the scene is ready.
 *
 * Reveals are serialized by a monotonic token inside the coordinator (see
 * `src/loading-reveal.js`): all three init paths drive the SAME overlay, and a
 * double-tapped "Start" (or any re-entry of an init path) starts two reveals at
 * once. Without the token, the slower one re-shows the overlay over the scene
 * the faster one already faded in ("the scene comes in and then goes back to
 * the loading screen for forest"). The token lets only the latest reveal touch
 * the shared overlay; superseded reveals become no-ops on it.
 */
const _showLoadingAndReveal = makeShowLoadingAndReveal();

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
  // Tear down previous UIController so its stale event listeners don't fire
  // on shared DOM elements (plan-submit-btn, end-turn-btn, etc.), which would
  // submit an empty plan from the old instance's _unitPlans.
  if (ui) ui.destroy();

  renderer = new (_pickRenderer())(canvas, state);
  renderer.resize();
  renderer.onImagesLoaded = () => { if (ui) ui._renderTurnInfo(); };
  // Show the loading overlay + drive the progress bar; reveals the canvas once
  // the renderer's asset bundle is ready. Subsumes the old fire-and-forget
  // loadImages() — beginLoad() (called inside) loads the atlas too.
  _showLoadingAndReveal(renderer);

  ui = new UIController(canvas, state, renderer, localWitchAI, redraw, localHeroAI, autoplay);
  ui.onQuitToMenu = () => location.reload();
  ui.showMissionInfoBtn(false); // hidden by default; campaign init enables it

  // AI-assist (debug): carry the console-toggled flags onto the fresh UI and let
  // it request AI-generated plans for the human's planning faction.
  ui.aiAssistEnabled  = _aiAssistEnabled;
  ui.aiAutorun        = _aiAutorun;
  ui.onAIAssistRequest = (faction) => _generateAssistPlan(faction);
  // Lets the in-game `/aiassist` console command toggle the mode (the console
  // reaches main.js only through `ui`, avoiding a circular import).
  ui.setAIAssistMode  = (mode, delayMs) => applyAIAssistMode(mode, delayMs);

  // Show resign option for single-player games (one side is AI)
  const isOneSided = !!(localWitchAI) !== !!(localHeroAI);
  const resignBtn = document.getElementById('menu-resign-btn');
  if (resignBtn) resignBtn.style.display = isOneSided ? '' : 'none';
  if (isOneSided) {
    const humanFaction = localWitchAI ? 'hero' : 'witch';
    ui.onResignGame = () => _resignLocalGame(humanFaction);
  }

  const battleCallback = (actorSnap, targetSnap, result) =>
    new Promise(resolve => ui._showBattleDialog(actorSnap, targetSnap, result, resolve));
  if (localWitchAI) localWitchAI.onBattleResult = battleCallback;
  if (localHeroAI)  localHeroAI.onBattleResult  = battleCallback;
}

function init(witchIsAI, heroIsAI, autoplay = false, humanFactionId = null) {
  _autoplay = autoplay;
  _gameStartTime = Date.now();
  _missionConductor?.destroy(); // clear any lingering tutorial/hint overlays
  _missionConductor = null;     // ensure conductor state is cleared for normal games
  _roundHistory = [];
  // Assign a fresh save ID for this game (only used for single-player saves)
  _spSaveId = _genSaveId();
  const canvas = document.getElementById('game-canvas');

  document.getElementById('setup-screen').style.display  = 'none';
  document.getElementById('game-screen').style.display   = 'flex';

  const mapSize   = document.getElementById('select-map-size')?.value ?? 'standard';
  const nodeCount = parseInt(document.getElementById('select-node-count')?.value ?? '3', 10);
  state    = new GameState(witchIsAI, heroIsAI, mapSize, nodeCount);

  // Difficulty applies to human-vs-AI only — AI-vs-AI (autoplay/balance) and
  // two-human games always run at the tuned 'normal' baseline.
  if ((witchIsAI || heroIsAI) && !(witchIsAI && heroIsAI)) {
    state.aiDifficulty = document.getElementById('select-ai-difficulty')?.value ?? 'normal';
  }

  // Apply the player's faction pick by swapping the side's default
  // leader entity to the picked faction. swapLeaderToFaction is a no-op
  // when the picked faction is already the leader's faction (e.g. day
  // side with paladin) — it only mutates when the type changes.
  if (humanFactionId) {
    const def = getFaction(humanFactionId);
    state.swapLeaderToFaction(def.side, humanFactionId);
  }
  // Fog of war is always on for human-vs-AI (GameState defaults it to 'partial'
  // when any side is AI, 'none' for two-human games). The AI-debug toggle below
  // can still force it off for AI-vs-AI debugging.

  const thinkDelay = autoplay ? 0 : undefined;
  witchAI = witchIsAI ? new WitchAIEngine(state, redraw, thinkDelay) : null;
  heroAI  = heroIsAI  ? new HeroAIEngine(state, redraw, thinkDelay)  : null;

  // AI debugger: admin-only, single-player only
  const aiDebugSel = document.getElementById('select-ai-debug');
  if (aiDebugSel?.value === 'on' && !autoplay && (witchIsAI || heroIsAI)) {
    setAIDebugActive(true);
    state.fogOfWar = 'none';  // full visibility for debug
    if (witchAI) witchAI.debugCapture = true;
    if (heroAI)  heroAI.debugCapture = true;
  } else {
    setAIDebugActive(false);
  }

  _setupLocalUI(canvas, witchAI, heroAI, autoplay);

  redraw();

  // Size the canvas (game-screen layout now complete) and frame the main unit.
  _enterGameView();

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
  fetch(`${window.BRIMSTONE_SERVER || ''}/api/game-stats`, {
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
  fetch(`${window.BRIMSTONE_SERVER || ''}/api/campaign-game-stats`, {
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

// ── AI Debug data capture ────────────────────────────────────────────────────

function _pushAIDebugData(aiEngine, faction) {
  const dbg = aiEngine?.lastDebugData;
  if (!dbg) return;

  setAIDebugData(dbg);

  // Build combat estimates for overlay
  const combatEstimates = [];
  const board = dbg.board;
  if (board) {
    const enemies = faction === 'witch' ? (board.visibleHeroes || []) : (board.witchMinions || []);
    const myUnits = faction === 'witch'
      ? [board.witch, ...(board.minions || [])].filter(Boolean)
      : [board.hero, ...(board.survivors || [])].filter(Boolean);

    for (const enemy of enemies) {
      if (!enemy?.alive) continue;
      // Estimate combat from nearest own unit
      let bestEst = null;
      for (const unit of myUnits) {
        if (!unit?.alive) continue;
        const est = faction === 'witch'
          ? estimateCombat(unit, enemy, board)
          : estimateHeroCombat(unit, enemy, board);
        if (!bestEst || est.favorability > bestEst.favorability) {
          bestEst = est;
        }
      }
      if (bestEst) {
        combatEstimates.push({
          col: enemy.col, row: enemy.row,
          ...bestEst,
        });
      }
    }
  }

  // Build renderer overlay
  renderer.aiDebugOverlay = {
    hexGoals: buildHexGoalMap(dbg.actions),
    moveArrows: buildMoveArrows(dbg.actions, state.entities),
    intentMarkers: buildIntentMarkers(dbg.actions, board, dbg.unitCommitments, faction),
    nodes: buildNodeFeasibilityMap(board),
    combatEstimates,
    unitCommitments: dbg.unitCommitments,
    faction,
    goalColors: GOAL_COLORS,
  };

  // Update DOM panel
  updateAIDebugPanel(dbg, state.entities);
  const debugPanel = document.getElementById('ai-debug-panel');
  if (debugPanel && !debugPanel.classList.contains('collapsed')) {
    renderer.insetLeft = 260;
  }
  redraw();
}

/** After resolution, annotate the debug panel with what actually happened. */
function _updateAIDebugResolutionOutcome(steps) {
  // Collect all resolution events by faction
  const outcomes = { hero: [], witch: [] };
  for (const step of steps) {
    for (const ev of (step.heroEvents ?? [])) {
      outcomes.hero.push(ev);
    }
    for (const ev of (step.witchEvents ?? [])) {
      outcomes.witch.push(ev);
    }
  }

  // Update the debug panel with outcome annotations
  const panel = document.getElementById('ai-debug-actions');
  if (!panel) return;

  // Add a resolution summary section
  const aiFaction = !state.heroIsAI ? 'witch' : 'hero';
  const events = outcomes[aiFaction];
  if (events.length === 0) return;

  const section = document.createElement('div');
  section.className = 'ai-debug-resolution-section';
  section.innerHTML = '<div class="ai-debug-section-title">Resolution Outcome</div>';

  const okCount = events.filter(e => e.type === ResEventType.ACTION_OK).length;
  const skipCount = events.filter(e => e.type === ResEventType.ACTION_SKIP).length;
  const failCount = events.filter(e => e.type === ResEventType.ACTION_FAIL).length;
  const capCount = events.filter(e => e.type === ResEventType.BUDGET_CAP).length;

  const list = document.createElement('div');
  list.className = 'ai-debug-kv-grid';
  const rows = [
    ['Executed', `${okCount}`],
    ['Skipped', `${skipCount}`],
    ['Failed', `${failCount}`],
  ];
  if (capCount > 0) rows.push(['Budget cap', `${capCount}`]);
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'ai-debug-kv-row';
    row.innerHTML = `<span class="ai-debug-kv-label">${label}</span><span class="ai-debug-kv-value">${value}</span>`;
    list.appendChild(row);
  }
  section.appendChild(list);

  // Show details for skipped/failed actions
  const problems = events.filter(e =>
    e.type === ResEventType.ACTION_SKIP || e.type === ResEventType.ACTION_FAIL
  );
  if (problems.length > 0) {
    const details = document.createElement('div');
    details.className = 'ai-debug-resolution-details';
    for (const ev of problems) {
      const tag = ev.type === ResEventType.ACTION_SKIP ? 'SKIP' : 'FAIL';
      const actionType = ev.action?.type ?? '?';
      const reason = ev.reason ?? '';
      const line = document.createElement('div');
      line.className = 'ai-debug-resolution-line';
      line.textContent = `[${tag}] ${actionType}: ${reason}`;
      details.appendChild(line);
    }
    section.appendChild(details);
  }

  panel.appendChild(section);
}

function _clearAIDebug() {
  clearAIDebugData();
  if (renderer) {
    renderer.aiDebugOverlay = null;
    renderer.insetLeft = 0;
  }
  hideAIDebugPanel();
}

// ── Local planning lifecycle ──────────────────────────────────────────────────

function _startLocalPlanningPhase() {
  if (!state || state.gameOver) return;
  state.updateExploredHexes();
  state.startPlanning();

  if (_autoplay) {
    // AI vs AI: generate both plans immediately then resolve
    setTimeout(() => _runLocalAutoResolution(), 0);
    return;
  }

  // Conductor-driven mission: hero always plans; conductor provides scripted opponent plan.
  // (Hints-mode conductors don't own the planning loop — they fall through to
  // the normal flow and fire from _enterLocalPlanningMode.)
  if (_missionConductor && !_missionConductor.isHints) {
    _missionConductor.onPlanningPhaseStart();
    // After maxPlanningRounds the conductor enters explanation-only mode —
    // no more planning rounds.  We still call onPlanningPhaseStart so the conductor
    // can advance to the explanation steps, but we don't enter planning mode.
    if (!_missionConductor.shouldPlan()) return;
    setMode(AppMode.PLANNING);
    // Scripted/tutorial missions don't offer the re-watch button.
    ui._hasReplayHistory = false;
    ui.enterPlanningMode('hero', state.heroActionsLeft);
    ui.onPlanSubmit = (heroPlan) => _onConductorPlanSubmit(heroPlan);
    return;
  }

  // Campaign story triggers + mission logic graph — show before planning mode.
  let storyEvents = [];
  if (_activeMissionDef?.storyTriggers && _activeCampaign) {
    storyEvents = processStoryTriggers(state, _activeMissionDef.storyTriggers, _activeCampaign.storyFlags);
  }
  if (state.logicEngine) {
    // Fire round/phase/area events, then drain everything queued so far (incl.
    // any post-resolution beats from the previous round's endRound pump).
    state.pumpMissionLogic('roundStart');
    storyEvents = storyEvents.concat(_drainLogicStoryEvents());
  }

  // The round-start pump can DECIDE the mission — an objectiveOutcome / winMission
  // / loseMission node wired to onRoundStart or onPhase (e.g. Mission 2's "night
  // fell before you found enough survivors" loss at dusk) calls setOutcome, which
  // sets state.winner ⇒ state.gameOver. The prior round's review has already run,
  // so there are no new steps — surface the debrief instead of entering planning.
  // Without this guard the mission is decided but never shown and the player is
  // soft-locked in planning with no way to progress (reported on Mission 2).
  if (state.gameOver) {
    const finish = () => _finishDecidedMissionBeforePlanning();
    if (storyEvents.length > 0) _showStorySequence(storyEvents).then(finish);
    else finish();
    return;
  }

  if (storyEvents.length > 0) {
    _showStorySequence(storyEvents).then(() => _enterLocalPlanningMode());
    return;
  }

  _enterLocalPlanningMode();
}

/** Surface a mission outcome a logic graph decided at round start (before any
 *  planning). The mission-logic engine is campaign-only, so this is the campaign
 *  debrief; a defensive fallback covers any future non-campaign logic mission. */
function _finishDecidedMissionBeforePlanning() {
  if (_activeCampaign && _activeMissionDef) { _handleCampaignMissionEnd(); return; }
  if (!_activeCampaign) {
    _recordLocalGameStats();
    if (_spSaveId) { _deleteSpSave(_spSaveId); _spSaveId = null; }
    _saveCompletedSpGame(state.winner, state.winReason);
  }
}

/**
 * Drain queued mission-logic presentation events into story-sequence events.
 * SIM events (spawn/despawn) are already applied to state — the redraw on
 * entering planning shows them — so only narrative beats are surfaced here.
 */
// Map raw mission-logic presentation events → _showStorySequence entries.
function _logicEventsToStory(events) {
  return (events ?? [])
    .filter(e => e.kind === 'storyBeat' || e.kind === 'conversation')
    .map(e => e.kind === 'conversation'
      ? { conversation: e.id, nodeId: e.nodeId, roles: e.roles }
      : { title: e.title, text: e.text });
}

function _drainLogicStoryEvents() {
  if (!state?.logicPresentation?.length) return [];
  return _logicEventsToStory(state.logicPresentation.splice(0));
}

// Present a TURN's mission-logic Show events DURING the replay, in order: a story
// beat becomes an inserted turn card; a conversation plays as its own card. Used
// by _animateResolutionSteps at the step the event fired (vs the planning-gate
// modals of _showStorySequence). `afterStepIndex` anchors the insert position.
let _beatCardSeq = 0;
// Returns true if a story beat was presented (its card already gated on NEXT),
// so the caller can skip the redundant manual-step gate for this step.
async function _presentStepLogicEvents(events, afterStepIndex) {
  let gatedBeat = false;
  for (const ev of events ?? []) {
    if (ev.kind === 'conversation') {
      await _playMissionConversation(ev.id, { manageHud: false, runOnComplete: false, nodeId: ev.nodeId, roles: ev.roles });
    } else if (ev.kind === 'storyBeat') {
      await _presentStoryBeatCard(ev, afterStepIndex);
      gatedBeat = true;
    }
  }
  return gatedBeat;
}

/** Insert a story-beat card into the live replay timeline and gate on NEXT (like
 *  a step boundary) so the player reads it; auto-advances on autoplay. */
async function _presentStoryBeatCard(beat, afterStepIndex) {
  if (!ui?.insertReplayTimelineCol) return;
  const col = buildStoryBeatDigest(beat, `${afterStepIndex}:${_beatCardSeq++}`);
  ui.insertReplayTimelineCol(col, afterStepIndex);
  ui.setReplayTimelineStep?.(col.stepIndex);
  if (_autoplay) { await playbackDelay(1100); return; }
  if (playback.paused) ui.setReplayNextReady?.(true);
  while (playback.paused && !playback.stepRequested
         && !playback.restart && !playback.aborted && !playback.goBack && !playback.jumpToEnd) {
    await new Promise(r => setTimeout(r, 50));
  }
  ui.setReplayNextReady?.(false);
  playback.stepRequested = false;
}

/** Show a sequence of story events — text modals and/or conversations. */
async function _showStorySequence(events) {
  for (const ev of events) {
    if (ev.conversation) {
      await _playMissionConversation(ev.conversation, { manageHud: true, runOnComplete: true, nodeId: ev.nodeId, roles: ev.roles });
    } else {
      await ui.showStoryModal(ev.title, ev.text);
    }
  }
}

// Mid-replay conversations defer their onComplete scripted actions until the
// authoritative entities are restored at the end of _animateResolutionSteps
// (the animation loop runs against display snapshots, so a despawn applied
// mid-loop would be undone by the final-entity restore).
let _pendingConvActions = [];

/**
 * Play one mission conversation by id: resolve its def + markdown, bind role
 * slots to live entities, and run the conversation player. Unresolvable
 * bindings (e.g. the NPC died) skip the conversation with a warning — the
 * trigger's dedup mark is already consumed, so it won't re-fire.
 */
async function _playMissionConversation(convId, { manageHud = true, runOnComplete = true, nodeId = null, roles = null } = {}) {
  // A conversation node may reference a markdown file directly by its id — the
  // editor's dropdown lists every *.md in conversations/, so an author can pick a
  // file without declaring a conversations[] entry. Fall back to treating the id
  // AS the file id, binding the universally-resolvable `hero` role by default;
  // any other role still needs a declared binding (or wired participant) and the
  // conversation skips gracefully below if a role can't be resolved.
  const convDef = _activeMissionDef?.conversations?.find(c => c.id === convId)
    ?? { id: convId, file: convId, bindings: { hero: 'hero' } };
  let convo;
  try {
    convo = await loadConversation(convDef.file);
  } catch (err) {
    console.warn(`[conversation] failed to load "${convDef.file}":`, err);
    return;
  }
  // Participants come from the declared conversations[] bindings, OVERLAID with
  // any roles wired in the logic graph (a Start Conversation node's role-input
  // pins — live entities like the survivor an On Actor node bound). Wired roles
  // win, so an authored mission can pin the hero while the graph supplies the NPC.
  const bindings = { ...(convDef.bindings ?? {}), ...(roles ?? {}) };
  const participants = bindParticipants(convo, bindings, state);
  if (!participants) {
    console.warn(`[conversation] "${convId}": could not bind all roles — skipping`);
    return;
  }
  const result = await playConversation({
    convo, participants, convDef,
    npcDefs: _activeMissionDef?.npcs ?? [],
    state, renderer, ui, redraw,
    manageHud, runOnComplete,
  });
  if (!runOnComplete && convDef.onComplete?.length) {
    _pendingConvActions.push({ convDef, skipped: result?.skipped ?? false });
  }
  // Mission-logic graph: let the graph react to the conversation finishing —
  // e.g. an NPC walk-off/despawn migrated out of conversations[].onComplete
  // (docs/09). The graph emits scriptedAction events which we run through the
  // SAME runScriptedActions choreography (correct ordering, NPC still present).
  if (runOnComplete && state?.logicEngine) {
    // Fire the Start Conversation node's Done branch now that the dialogue is
    // dismissed (latent resume), plus any On Conversation End event nodes, then
    // run the resulting NPC choreography in order.
    if (nodeId) state.logicEngine.resumeLatent(nodeId);
    state.logicEngine.dispatch('conversationEnd', { id: convId });
    await _runLogicChoreography(result?.skipped);
  }
}

/** Drain queued scriptedAction presentation events (from moveUnit/despawnUnit
 *  graph nodes) and run them through the conversation-choreography executor. */
async function _runLogicChoreography(instant = false) {
  if (!state?.logicPresentation?.length) return;
  const actions = [];
  state.logicPresentation = state.logicPresentation.filter((ev) => {
    if (ev.kind === 'scriptedAction' && ev.action) { actions.push(ev.action); return false; }
    return true;
  });
  if (!actions.length) return;
  await runScriptedActions(actions, {
    state, renderer, redraw,
    npcDefs: _activeMissionDef?.npcs ?? [],
    instant: !!instant || _autoplay,
  });
}

/** Enter planning mode after any pre-planning modals (story, phase) are done. */
function _enterLocalPlanningMode() {
  setMode(AppMode.PLANNING);
  const humanFaction = !state.heroIsAI ? 'hero' : 'witch';
  const budget = getFaction(humanFaction).getActionsLeft(state);

  // Inline "replay last round" button — available whenever there's resolved
  // history to re-watch. Most useful right after resuming a saved game (the
  // history is restored from the save), but also works mid-game from round 2 on.
  // Set BEFORE enterPlanningMode so it reads the flag for button visibility.
  ui._hasReplayHistory = _roundHistory.length > 0;
  ui.onReplayLastTurn = () => _replayLastRoundInlineLocal();

  if (!state.heroIsAI && !state.witchIsAI) {
    // Human vs Human: hero plans first, then witch
    ui.enterPlanningMode('hero', state.heroActionsLeft);
    ui.onPlanSubmit = (heroPlan) => _onLocalHvHHeroPlan(heroPlan);
  } else {
    // One human vs AI
    ui.enterPlanningMode(humanFaction, budget);
    ui.onPlanSubmit = (plan) => _onLocalHumanPlanSubmit(humanFaction, plan);
  }

  // Micro-lesson hints fire once the planning UI is up (their spotlights
  // target planning-mode elements like the budget badge).
  if (_missionConductor?.isHints) _missionConductor.onPlanningPhaseStart();
}

/**
 * Conductor-driven plan submit: hero submits, conductor provides scripted
 * witch plan, then both resolve together.  No resolution summary modal is shown.
 */
async function _onConductorPlanSubmit(heroPlan) {
  ui.exitPlanningMode();
  _missionConductor?.onPlanSubmitted();

  // Apply forced dice if configured for this round
  const forcedDice = _missionConductor?.getForcedDice();
  if (forcedDice) {
    state.setForcedDice(...forcedDice);
  }

  state.submitPlan('hero', heroPlan);
  const witchPlan = _missionConductor ? _missionConductor.getWitchPlan() : [];
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
  // Dismiss any open micro-lesson hint — hints never outlive the planning phase.
  if (_missionConductor?.isHints) _missionConductor.onPlanSubmitted();

  let bothReady = state.submitPlan(faction, plan);
  if (!bothReady) {
    const aiFaction = getFaction(faction).getOpponentId();
    const aiPlan = aiFaction === 'witch'
      ? (witchAI ? witchAI.generatePlan() : [])
      : (heroAI  ? heroAI.generatePlan()  : []);

    // Capture AI debug data after plan generation
    if (isAIDebugActive()) {
      const aiEngine = aiFaction === 'witch' ? witchAI : heroAI;
      _pushAIDebugData(aiEngine, aiFaction);
    }

    bothReady = state.submitPlan(aiFaction, aiPlan);
  }

  if (bothReady) await _runLocalResolution();
}

async function _runLocalAutoResolution() {
  if (!state || state.gameOver) return;
  const heroPlan  = heroAI  ? heroAI.generatePlan()  : [];
  const witchPlan = witchAI ? witchAI.generatePlan() : [];

  // Capture AI debug data for both sides in autoplay
  if (isAIDebugActive()) {
    if (heroAI)  _pushAIDebugData(heroAI, 'hero');
    if (witchAI) _pushAIDebugData(witchAI, 'witch');
  }

  state.submitPlan('hero',  heroPlan);
  state.submitPlan('witch', witchPlan);
  await _runLocalResolution();
}

// Build the end-of-turn wrap-up card data: the upcoming phase/round title and
// the structured combat pairs (icon-vs-icon with HP loss / kills). The UI layer
// renders the icons + score dots from this.
function _buildWrapUpContent(steps, roundNum) {
  const combats = compileTurnBattlePairs(steps, state.entities, ResEventType, PlanActionType);
  // Survivors/zombies found this round — move/explore/horn encounters plus any
  // spawned at power nodes during endRound (matches the old summary modal).
  // Also collect explored-loot icons so the card lists the actual resources.
  // Loot is the PLAYER's only — see collectTurnFinds (AI loot goes to its own
  // inventory, so counting it would double-show shared resource icons).
  const humanFaction = !state.heroIsAI ? 'hero' : !state.witchIsAI ? 'witch' : null;
  const { discoveries, loot } = collectTurnFinds(steps, humanFaction);
  for (const s of (state.nodeSpawnedSurvivors ?? [])) discoveries.push(s);

  // Night attrition roll-call — who suffered in the open and who was sheltered
  // by a building or fortification this round (from the post-round effects).
  // This restores the per-unit list the old end-of-turn modal showed.
  // KILL events are listed for either side (the player watched that unit
  // vanish — the summary must explain why); damage/shelter stay scoped to the
  // player's own units. Shared pure helper — see post-round-effects.js.
  const attrition = collectWrapUpAttrition(state.postRoundEvents, ui?.myPlayerId ?? null);

  // Title the completed turn as "Day X Round Y — SUMMARY" (cycle day + round in
  // cycle, matching the cycle bar's "Day N · Round M" convention).
  const round = roundNum ?? 0;
  const cycleLen = getCycleLength(state.cycleConfig);
  const day = Math.ceil(round / cycleLen);
  const roundInCycle = ((round - 1) % cycleLen) + 1;
  const title = `Day ${day} Round ${roundInCycle} — SUMMARY`;
  return { title, combats, discoveries, loot, attrition };
}

/**
 * Shared end-of-round review for a human player, used by BOTH orchestration
 * layers — offline (`_runLocalResolution`) and online (`onResolutionComplete`) —
 * so the two stay in lockstep. Normal turns show the timeline wrap-up CARD;
 * game-over shows the dedicated Victory/Defeat MODAL. Loops on Replay until the
 * player dismisses it, hides the timeline, and returns the final action string.
 *
 * Path-specific behaviour is injected (this is the offline/online split that
 * can't be merged — see CLAUDE.md guideline 5):
 *   - reReplay():        re-run this round's animation. Redraw target, explored-
 *                        flag handling, and app-mode buffering differ per path.
 *   - replayFull(w, r):  run the full-game replay then restart. The winner/reason
 *                        snapshot is passed in because an inline Replay clobbers
 *                        state.winner/winReason. When the player picks it, the
 *                        helper returns 'replay-full' so the caller bails out.
 *   - roundHistory:      _roundHistory | _onlineRoundHistory — gates the Replay
 *                        and full-replay buttons.
 *   - isCampaign:        suppresses the full-replay button in campaign missions.
 */
async function _runEndOfRoundReview({
  steps, roundNum, humanFaction, fogOfWar, prevScore, prevNodes,
  isCampaign = false, roundHistory, reReplay, replayFull,
}) {
  if (!state.gameOver) {
    // Normal turn — wrap-up CARD. Fold the night-attrition escalation in and
    // consume the flag so the standalone planning-phase popup doesn't also fire.
    const attritionLevel = (state.attritionChanged && state.attritionLevel > 0) ? state.attritionLevel : 0;
    if (attritionLevel) state.attritionChanged = false;
    let action;
    do {
      const wrap = _buildWrapUpContent(steps, roundNum);
      action = await ui.showReplayWrapUp({
        titleHtml: wrap.title, combats: wrap.combats, discoveries: wrap.discoveries,
        loot: wrap.loot, attrition: wrap.attrition, attritionLevel,
        canReplay: roundHistory.length > 0,
      });
      if (action === 'replay') await reReplay();
    } while (action === 'replay');
    _keepTimelineForReview = false;
    ui.hideReplayTimeline?.();
    return action;
  }

  // Game over — dedicated Victory/Defeat MODAL. Snapshot the outcome before the
  // loop: an inline Replay re-animates intermediate rounds and would otherwise
  // clobber state.winner / state.winReason mid-review.
  _keepTimelineForReview = false;
  ui.hideReplayTimeline?.();
  const goWinner = state.winner, goWinReason = state.winReason;
  let action;
  do {
    action = await ui._showResolutionSummary(steps, roundNum, {
      prevScore, prevNodes, humanFaction, fogOfWar,
      gameOver: true, winner: goWinner, winReason: goWinReason,
      hasFullReplay: roundHistory.length > 0,
      isCampaign,
    });
    if (action === 'replay') {
      await reReplay();
    } else if (action === 'replay-full') {
      await replayFull(goWinner, goWinReason);
      return 'replay-full';
    }
  } while (action === 'replay');
  return action;
}

// Initial camera when first entering a level/mission: orient north-up and zoom
// in on the player's main unit (its leader), with that unit selected — i.e. the
// view you'd get from "fit twice" (frame + orient north) followed by
// zoom-to-selection on the leader. North-up is the camera default and frameHexes
// preserves azimuth, so a single zoom-to-unit lands the desired view.
function _focusInitialView(humanFaction) {
  if (!renderer || !state) return;
  const apply = () => {
    if (!renderer || !state) return;
    // A turn-0 conversation owns the screen at mission start (RESOLVING) —
    // re-selecting the hero here would paint planning highlights and yank the
    // camera off the conversation framing. Planning re-frames on entry anyway.
    if (getMode() === AppMode.RESOLVING) return;
    // state.hero / state.witch keyed by faction id (avoids a faction string check).
    const main = state[humanFaction]
      ?? state.entities.find(e => e.alive && e.owner === humanFaction);
    if (!main || !main.alive) return;
    // Tutorial teaches unit selection itself, so don't pre-select there.
    if (ui && !ui.tutorialMode) ui._selectEntity?.(main);
    renderer.frameHexes([main], { maxZoom: 3.5, paddingHexes: 1.5, duration: 550, orientNorth: true });
    redraw();
  };
  // Apply now (renderer usually ready), then again once the lazily-initialised
  // 3D renderer signals ready — otherwise an early frame is dropped (camera not
  // created yet) and the view stays at the default top-down whole-map shot.
  apply();
  if (typeof renderer.whenReady === 'function') renderer.whenReady().then(apply);
}

// Common post-setup view for every local game-entry path (new game, SP/campaign
// resume, campaign mission). Sizes the canvas, then frames the player's main
// unit north-up. Centralised so no entry path can forget the initial view —
// that omission was why loading a game looked different from starting one.
function _enterGameView() {
  requestAnimationFrame(() => {
    if (!renderer || !state) return;
    renderer.resize();
    if (!_autoplay) {
      const humanFaction = !state.heroIsAI ? 'hero' : 'witch';
      _focusInitialView(humanFaction);
    }
    redraw();
  });
}

async function _runLocalResolution(skipSummary = false) {
  if (!state || state.gameOver) return;

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
  // Keep the timeline up after animation for the end-of-turn review (SP human
  // turn, non-autoplay). Cleared once the review/summary is dismissed.
  _keepTimelineForReview = !!(ui && humanFaction && !_autoplay && !skipSummary);
  const preReplayEntities = patchAlive(steps[0]?.entitySnapshot ?? finalEntities);

  // Snapshot node control BEFORE resolution so we can detect changes from unit movement
  const preResEntities = steps[0]?.entitySnapshot ?? state.entities;
  const prevNodes = state.witchObjectives.map(obj => ({
    col: obj.col, row: obj.row, label: obj.label,
    owner: nodeController(obj, preResEntities),
  }));

  // Animate the turn. The Redo control sets playback.restart to replay the
  // turn's animations from the start — reset to pre-resolution and re-run.
  do {
    playback.restart = false;
    await _animateResolutionSteps(steps, finalEntities, redraw, humanFaction, null);
    if (playback.restart) {
      state.entities = preReplayEntities;
      for (const [k, t] of state.tiles) {
        if (t.explored && !preExploredSet.has(k)) t.explored = false;
      }
      redraw();
    }
  } while (playback.restart);

  // Update AI debug panel with resolution outcomes so the user can see
  // which planned actions actually executed vs were skipped/failed
  if (isAIDebugActive()) {
    _updateAIDebugResolutionOutcome(steps);
  }

  // Restore final explored state after animation completes.
  for (const [k, v] of postExplored) {
    const t = state.tiles.get(k);
    if (t) t.explored = v;
  }

  // Notify mission conductor that resolution animation has finished.
  if (_missionConductor) _missionConductor.onResolutionComplete();

  // Add aggregate battle summary to the log before endRound inserts phase entries
  const summaryLines = compileTurnBattleSummary(steps, state.entities, ResEventType, PlanActionType);
  for (const line of summaryLines) state.log.push(line);
  if (summaryLines.length && ui) ui._renderLog();

  // Snapshot score BEFORE endRound so we can detect scoring changes
  const prevScore = { hero: state.nodeScore.hero, witch: state.nodeScore.witch };
  // The phase this round was FOUGHT in — finalizeRound() advances the day
  // cycle, and any re-watch from the review must replay under the round's own
  // phase (lighting + sight ranges) or it won't match the original watch.
  const roundPhase = state.phase;

  // Shared post-resolution finalization (node discovery → control-change log →
  // explored-hex update → endRound). endRound() internally invokes
  // state._waveProcessor (set during mission load) before checkVictory, so
  // triggered wave spawns can pre-empt an otherwise-firing eliminate_all win.
  state.finalizeRound();

  // Show encounter dialogs for survivors spawned at power nodes during endRound
  if (ui && !_autoplay && state.nodeSpawnedSurvivors?.length) {
    for (const s of state.nodeSpawnedSurvivors) {
      await _showDiscovery(s, 'power_node');
    }
  }

  if (ui) await ui._triggerPostRoundEffects();
  redraw();

  // Persist single-player progress to localStorage
  _saveSpGame();

  // Persist campaign mid-mission progress (skip conductor-driven missions like
  // the tutorial; hint-mode conductors ride along normal missions, which save)
  if (_activeCampaign && _activeMissionDef && !state.gameOver &&
      (!_missionConductor || _missionConductor.isHints)) {
    _saveCampaignMission();
  }

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

  // Post-resolution: normal turns end with a wrap-up CARD + review (the timeline
  // stays up; arrows scrub the cards). Game-over keeps its dedicated modal.
  const _reReplay = async () => {
    await withPinnedPhase(state, roundPhase, async () => {
      state.entities = preReplayEntities;
      for (const [k, t] of state.tiles) {
        if (t.explored && !preExploredSet.has(k)) t.explored = false;
      }
      redraw();
      await _animateResolutionSteps(steps, finalEntities, redraw, humanFaction, null);
      for (const [k, v] of postExplored) { const t = state.tiles.get(k); if (t) t.explored = v; }
    });
    redraw();   // final frame back under the live (post-round) phase
  };

  if (!_autoplay && !skipSummary && ui && humanFaction) {
    // Reflect the round-summary phase in the app mode for normal turns (drives
    // keybindings, compass, etc.); game over keeps its terminal Victory/Defeat
    // modal and transitions onward from there.
    if (!state.gameOver) setMode(AppMode.SUMMARY);
    // Finalize game-over immediately — cleanup survives any navigation away.
    if (state.gameOver && !_activeCampaign) {
      _recordLocalGameStats();
      if (_spSaveId) { _deleteSpSave(_spSaveId); _spSaveId = null; }
      _saveCompletedSpGame(state.winner, state.winReason);
    }

    const action = await _runEndOfRoundReview({
      steps, roundNum: state.round - 1, humanFaction, fogOfWar: state.fogOfWar,
      prevScore, prevNodes, isCampaign: !!(_activeCampaign && _activeMissionDef),
      roundHistory: _roundHistory,
      reReplay: _reReplay,
      replayFull: async (winner, winReason) => {
        await _replayFullGame(_roundHistory, winner, winReason,
          state.hero?.displayName ?? 'Hero', state.witch?.displayName ?? 'Witch');
        _doRestart();
      },
    });
    if (action === 'replay-full') return;

    // Animate score bar changes after the review is dismissed.
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
    }
    // Save game-over state — replay mutates `state` with intermediate round data
    const _goStateAP = { gameOver: true, winner: state.winner, winReason: state.winReason };

    let action;
    do {
      action = await ui._showResolutionSummary(steps, state.round - 1, {
        prevScore, prevNodes, humanFaction: null, fogOfWar: 'none',
        gameOver: true, winner: _goStateAP.winner, winReason: _goStateAP.winReason,
        hasFullReplay: _roundHistory.length > 0,
        isCampaign: !!(_activeCampaign && _activeMissionDef),
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
    await playbackDelay(300);
  }
  _startLocalPlanningPhase();
}

/**
 * Re-watch the most recently resolved round inline, mid-planning (offline SP /
 * campaign / hot-seat). The online equivalent is `_replayLastTurnInline`; this
 * is the offline twin (CLAUDE.md guideline 5 — both layers stay in lockstep).
 *
 * Preserves the in-progress plan: we snapshot `_unitPlans` (+ submitted flag and
 * the planning faction/budget), play the stored round's animation, show the same
 * end-of-round wrap-up CARD, then re-enter planning with the plan restored. The
 * player can hit Replay to loop the animation or Continue to drop back into the
 * planning they were in the middle of. Especially handy right after loading a
 * save, where the player wants to see how the board got to its current state.
 */
async function _replayLastRoundInlineLocal() {
  if (!ui || !state || !renderer || isAnimating() || _inlineReplayInFlight) return;
  // Only from live planning — the button lingers through the post-round summary
  // (where _planFaction is null), and re-watching from there would re-enter
  // planning with a null faction.
  if (getMode() !== AppMode.PLANNING || state.gameOver) return;
  const entry = _roundHistory[_roundHistory.length - 1];
  if (!entry) return;
  const steps = typeof entry.steps === 'string' ? JSON.parse(entry.steps) : entry.steps;
  if (!steps?.length) return;

  _inlineReplayInFlight = true;
  try {
    const humanFaction = !state.heroIsAI ? 'hero' : !state.witchIsAI ? 'witch' : null;

    // Preserve the in-progress plan + planning context so we can restore it.
    const savedPlans   = new Map(ui._unitPlans);
    const wasSubmitted = ui._planSubmitted;
    const savedFaction = ui._planFaction;
    const savedBudget  = ui._planBudget;

    // Animate from the round's pre-resolution entities; the live (post-round)
    // entities are the snap-to-final target — same approach as the online twin.
    const liveEntities = state.entities;
    const preData = typeof entry.preState === 'string' ? JSON.parse(entry.preState) : entry.preState;
    const preEntities = patchAlive(steps[0]?.entitySnapshot ?? deserializeState(preData).entities ?? liveEntities);

    ui.exitPlanningMode();
    resetPlayback();
    // Keep the scrub timeline up after the animation so the wrap-up card can be
    // appended to the per-turn cards (matches the normal end-of-round review).
    _keepTimelineForReview = true;

    const playOnce = async () => {
      // Replay under the round's OWN phase (the saved pre-state carries it) —
      // the day cycle has since advanced, and the new phase would change both
      // the lighting and the sight ranges the fog veil / card gates use.
      await withPinnedPhase(state, preData?.phase, async () => {
        state.entities = preEntities;
        redraw();
        await _animateResolutionSteps(steps, liveEntities, redraw, humanFaction, null);
        state.entities = liveEntities;
      });
      redraw();
    };

    let skipped = false;
    try {
      await playOnce();
      skipped = playback.jumpToEnd;
    } finally {
      resetPlayback();
    }

    // Re-watch wrap-up CARD — Replay loops the animation, Continue returns to
    // planning. Skipped entirely if the player hit jump-to-end mid-animation.
    if (!skipped) {
      setMode(AppMode.SUMMARY);
      const wrap = _buildWrapUpContent(steps, entry.roundNum);
      let action;
      do {
        action = await ui.showReplayWrapUp({
          titleHtml: wrap.title, combats: wrap.combats, discoveries: wrap.discoveries,
          loot: wrap.loot, attrition: wrap.attrition, attritionLevel: 0,
          canReplay: true,
        });
        if (action === 'replay') { resetPlayback(); await playOnce(); resetPlayback(); }
      } while (action === 'replay');
    }
    _keepTimelineForReview = false;
    ui.hideReplayTimeline?.();

    // Drop back into the planning we interrupted, plan intact.
    setMode(AppMode.PLANNING);
    ui._hasReplayHistory = _roundHistory.length > 0;
    ui.enterPlanningMode(savedFaction, savedBudget);
    ui._unitPlans = savedPlans;
    ui._refreshPlanOverlay();
    ui._renderPlanPanel();
    if (wasSubmitted) ui.markPlanSubmitted();
  } finally {
    _inlineReplayInFlight = false;
  }
}

/**
 * Fire the visual result animations that follow a battle (HP floaters, death burst).
 * Uses result.damage / result.counterDmg directly so that simultaneous battles in
 * the same step each show only their own damage, not accumulated step damage.
 */
// Dispatch the attacker-side battle animation. Ranged attacks (actor
// range > 1, or the resolver flagged the battleSnap as ranged) fire a
// projectile from attacker → target; everything else keeps the melee
// lunge. Close-range ranged attacks (dist == 1) still use the projectile
// so the visual language stays consistent.
function _playAttackIntroAnim(actorSnap, targetSnap, fromCol, fromRow, toCol, toRow, ranged) {
  const isRanged = !!ranged || (actorSnap?.range ?? 1) > 1;
  if (isRanged) {
    // Range (and the projectile visual) is weapon-derived: the equipped
    // weapon names its projectileType (bolt for bows/firearms, sparkle for
    // the Magic Bolt). Fall back to sparkle for any legacy ranged source.
    const projectileType =
      ITEMS[actorSnap.weapon]?.projectileType ?? 'sparkle';
    renderer.addProjectileAnim(projectileType, fromCol, fromRow, toCol, toRow, {
      owner: actorSnap.owner,
    });
  } else {
    renderer.addLungeAnim(
      actorSnap.id,
      fromCol, fromRow,
      toCol, toRow,
      actorSnap.type, actorSnap.owner, actorSnap.title ?? null,
    );
  }
}

// 3D cinematic combat Continue button — gates the readout fade on a click
// so the player controls how long the totals stay on screen. Passed into
// run3DCombatCardHold (src/combat-cinematic.js) as the button resolver; the
// shared helper owns the show/hide/await-click plumbing.
function _combatContinueBtn() {
  if (typeof document === 'undefined') return null;
  return document.getElementById('combat-continue-btn');
}

// True when survivor/zombie discoveries should use the 3D cinematic discovery
// readout (camera zoom + billboarded card + Continue gate) instead of the 2D
// Encounter Dialog modal: only the 3D renderer, only at cinematic speed, and
// never during autoplay. Matches the `_is3DCinematic && _cinematic` semantics
// used for combat (defined locally inside _animateResolutionSteps), but reads
// only module-level state so the discovery call sites in both
// _runLocalResolution and _animateResolutionSteps can share it.
function _is3DDiscoveryActive() {
  const speed = ui?.speedMode ?? 'cinematic';
  return !_autoplay && !!(renderer?.is3D) && speed === 'cinematic';
}

// Present a survivor/zombie discovery. In 3D cinematic mode this runs the
// billboarded discovery readout; otherwise (2D, fast/vfast, autoplay, or when
// the live entity / standee can't be resolved) it falls back to the legacy
// Encounter Dialog modal. `unitData` is the resolver's encounterSurvivor data
// object (carries `id` linking it to the live entity). Resolves when dismissed.
async function _showDiscovery(unitData, method = 'explore') {
  if (_is3DDiscoveryActive() && unitData?.id != null) {
    const entity = state.entities.find(e => e && e.id === unitData.id) ?? null;
    if (entity) {
      const ran = await runDiscoveryReadout({
        renderer, state, entity,
        text: discoveryText(unitData, method),
        getContinueButton: _combatContinueBtn,
      });
      if (ran) return;
    }
  }
  await new Promise(resolve => ui._showEncounterDialog(unitData, resolve, method));
}

// 3D cinematic combat resolution (G4 Phase 2+3): NO modal dialog in 3D — the
// dice/total read out on billboarded cards above the combatants while the
// attacker's punch is FROZEN mid-strike, then the strike resumes to completion
// and the result floaters play. Mirrors what the modal used to gate, but driven
// purely by the animation queue so resolution still advances.
//
// Sequence: lunge+punch already started by `_playAttackIntroAnim`. Here:
//   1. freeze the punch on its impact frame (holds the strike pose),
//   2. spawn the dice cards above both heads,
//   3. await the card hold+fade (strike stays frozen the whole time),
//   4. resume the punch through to completion,
//   5. play the result floaters and drain them.
// The caller still owns the lunge return (returnAllLungeAnims) afterwards.
async function _run3DCombatCardHold(actorSnap, targetSnap, result, redrawFn) {
  return run3DCombatCardHold({
    renderer, state,
    actorSnap, targetSnap, result, redrawFn,
    getContinueButton: _combatContinueBtn,
    playBattleResultAnims: _playBattleResultAnims,
  });
}

/**
 * Land an HP delta on the DISPLAY entity in the same beat as its floater.
 * During resolution animation `state.entities` holds per-step display clones
 * (the authoritative post-step swap happens later), and the unit icon badge
 * above each unit repaints from `state.entities` every draw — so nudging the
 * clone here makes the icon's HP ring update per ACTION instead of jumping
 * at the end of the TURN. Clamped to [0, maxHp]; overwritten harmlessly by
 * the post-step snapshot swap.
 */
function _applyDisplayHp(entityId, delta) {
  if (!delta) return;
  const e = state?.entities?.find(en => en && en.id === entityId);
  if (!e || e.hp == null) return;
  e.hp = Math.max(0, Math.min(e.maxHp ?? e.hp, e.hp + delta));
}

function _playBattleResultAnims(actorSnap, targetSnap, result, redrawFn) {
  // Single audio hook for every combat display path (2D dialog, fast toast,
  // 3D card-hold, autoplay, replay) — all of them funnel through here.
  audio.playCombat(result);
  // Land every flash/floater on each combatant's LIVE display hex (mid-turn
  // moves have already landed), not its pre-move battle snapshot — otherwise a
  // unit that moved this turn before fighting would show its "-N" over its
  // turn-start hex. Falls back to the snapshot when the entity is gone (a kill
  // didn't move after dying, so the snapshot is its death hex). Matches the
  // defender-cluster + lunge positioning, which also track the live hex.
  const liveActor  = state?.entities?.find(e => e.id === actorSnap.id);
  const liveTarget = state?.entities?.find(e => e.id === targetSnap.id);
  const atkCol = liveActor?.col  ?? actorSnap.col,  atkRow = liveActor?.row  ?? actorSnap.row;
  const tgtCol = liveTarget?.col ?? targetSnap.col, tgtRow = liveTarget?.row ?? targetSnap.row;
  renderer.addAttackAnim(atkCol, atkRow, tgtCol, tgtRow);
  // Pass entityId so the renderer flags the affected standee with
  // `_pendingDespawn`. _syncEntityStandees skips disposal until the "-N"
  // floater finishes rising/fading, so the number reads as floating off a
  // visible unit rather than orphaned in space.
  if (result?.damage) {
    renderer.addHpChangeFlash(tgtCol, tgtRow, -(result.damage), { entityId: targetSnap.id });
    _applyDisplayHp(targetSnap.id, -(result.damage));
  }
  if (result?.counterDmg) {
    renderer.addHpChangeFlash(atkCol, atkRow, -(result.counterDmg), { entityId: actorSnap.id });
    _applyDisplayHp(actorSnap.id, -(result.counterDmg));
  }
  if (result?.fortDamaged) {
    renderer.addFlash(tgtCol, tgtRow, '🏰-1',
      'rgba(120,120,140,0.15)', 1600, 0.65, 'rgba(180,180,200,1)');
    // Apply the fort-level delta now so the hex ring visibly thins out in
    // sync with the floater (fortifyLevel was rewound at the start of
    // _animateResolutionSteps so this step's damage hasn't landed yet).
    const dTile = state.tiles.get(hexKey(tgtCol, tgtRow));
    if (dTile && dTile.fortifyLevel > 0) dTile.fortifyLevel -= 1;
  }
  if (result?.killed) {
    const deadColor = targetSnap.owner === 'hero' ? '#d4a72c' : '#9b59b6';
    renderer.addDeathAnim(tgtCol, tgtRow, deadColor);
    renderer.addFadeOutAnim(targetSnap.id, 600);
  }
  // Brute blast — expanding red ring covering the target hex + 6 neighbours.
  // Mirrors the horn's ring effect; fires before splash floaters so the
  // ring frames the damage tags rather than colliding with them.
  if ((result?.splashRadius ?? 0) > 0 && (result?.splashHexes?.length ?? 0) > 0) {
    renderer.addNodeRevealAnim(
      result.splashHexes, '#c0392b',
      { radiusMultiplier: 3, duration: 900 },
    );
  }
  // Splash damage floaters — splashHits carry the actual (scaled) damage.
  for (const sh of result?.splashHits ?? []) {
    renderer.addHpChangeFlash(sh.col, sh.row, -(sh.damage ?? 1), { entityId: sh.id });
    _applyDisplayHp(sh.id, -(sh.damage ?? 1));
    if (sh.killed) {
      const deadColor = sh.owner === 'hero' ? '#d4a72c' : '#9b59b6';
      renderer.addDeathAnim(sh.col, sh.row, deadColor);
      renderer.addFadeOutAnim(sh.id, 600);
    }
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

/**
 * Check whether a hex (col, row) is within line of sight of any friendly
 * entity in the current step's entity snapshot. Used during resolution
 * animation to decide whether an opponent action should be visible under
 * fog of war.
 *
 * The LOS set is cached on the entity snapshot (via a WeakMap) so this is
 * O(1) on the second and subsequent calls for the same snapshot, even
 * though the underlying LOS pass is O(units × hexes_in_range).
 */
const _losCacheBySnapshot = new WeakMap();
function _isFogVisible(col, row, humanFaction, entities, phase) {
  if (!humanFaction || state.fogOfWar === 'none') return true;
  let perFaction = _losCacheBySnapshot.get(entities);
  if (!perFaction) {
    perFaction = new Map();
    _losCacheBySnapshot.set(entities, perFaction);
  }
  // Keyed by faction AND phase: sight range is phase-dependent, and the same
  // snapshot array is re-evaluated under a different phase when a round is
  // re-watched after the day cycle advanced (withPinnedPhase re-watch paths).
  const cacheKey = `${humanFaction}|${phase}`;
  let set = perFaction.get(cacheKey);
  if (!set) {
    set = computeLineOfSight(
      { entities, tiles: state.tiles, phase },
      humanFaction,
      entities,
    );
    perFaction.set(cacheKey, set);
  }
  return set.has(hexKey(col, row));
}

/**
 * Check node discovery against current entity positions during resolution
 * animation. If a node becomes visible to the human faction for the first
 * time, set its seen flag and trigger a reveal glow animation.
 */
function _updateNodeDiscoveryDuringStep(gs, humanFaction, rend) {
  if (!gs.witchObjectives) return;
  for (const obj of gs.witchObjectives) {
    // Check all factions — update discovery flags as entities move
    for (const fac of allFactions()) {
      const seenKey = fac.getNodeSeenKey();
      if (obj[seenKey]) continue; // already discovered
      const nowSeen = gs.entities.some(e => {
        if (!e.alive || e.owner !== fac.id) return false;
        const range = sightRangeForEntity(e, gs.phase);
        return obj.hexes.some(h =>
          hexDistance(e.col, e.row, h.col, h.row) <= range
          && hasLineOfSight(gs, e.col, e.row, h.col, h.row)
        );
      });
      if (!nowSeen) continue;
      obj[seenKey] = true;
      // Trigger reveal animation if this is the human's faction
      const isHuman = humanFaction === fac.id
        || (!humanFaction && gs.fogOfWar === 'none'); // no fog — show for everyone
      if (isHuman && rend) {
        const nodeColor = obj.color ?? '#8800cc';
        rend.addNodeDiscovered(obj.hexes, nodeColor, 'Power Node Discovered');
      }
    }
  }

  // Mission target hex discovery (reach_hex objective)
  const mt = gs.missionTargetHex;
  if (mt && !mt.seen) {
    const heroFac = allFactions().find(f => f.id === 'hero');
    if (heroFac) {
      const nowSeen = gs.entities.some(e => {
        if (!e.alive || e.owner !== 'hero') return false;
        const range = sightRangeForEntity(e, gs.phase);
        return hexDistance(e.col, e.row, mt.col, mt.row) <= range
          && hasLineOfSight(gs, e.col, e.row, mt.col, mt.row);
      });
      if (nowSeen) {
        mt.seen = true;
        const isHuman = humanFaction === 'hero'
          || (!humanFaction && gs.fogOfWar === 'none');
        if (isHuman && rend) {
          rend.addNodeDiscovered(
            [{ col: mt.col, row: mt.row }], mt.color, 'Objective Discovered',
          );
        }
      }
    }
  }
}

async function _animateResolutionSteps(steps, finalEntities, redrawFn, humanFaction = null, myPlayerId = null) {
  console.log('[animate] _animateResolutionSteps called:', {
    stepsCount: steps.length,
    finalEntitiesCount: finalEntities?.length ?? 0,
    humanFaction, myPlayerId,
    flags: { goBack: playback.goBack, aborted: playback.aborted, jumpToEnd: playback.jumpToEnd, _autoplay },
  });

  // Show the unified replay bar whenever a replay is animating, EXCEPT during
  // full PLAYBACK mode (which shows its own bar via replayFullGame). We detect
  // full PLAYBACK via ui._replayOnControl because the first step animation sets
  // mode to RESOLVING, clobbering getMode()-based checks. In inline mode the bar
  // offers Play(Normal)/Pause/Fast/Camera/Skip; pause/skip drive playback flags.
  const skipHudActive = !_autoplay && ui && !ui._replayOnControl;
  if (skipHudActive) {
    // Start in the player's remembered mode: AutoPlay (continuous) or manual.
    playback.paused = !ui.replayAutoPlay;
    playback.stepRequested = false;
    ui.showInlineReplayHUD?.((action) => {
      switch (action) {
        case 'playpause':
          playback.paused = !playback.paused;
          if (!playback.paused) playback.stepRequested = false;
          ui.replayAutoPlay = !playback.paused;   // remember for next turn
          ui.setReplayTransport(playback.paused);
          break;
        case 'next':
          playback.stepRequested = true;
          break;
        case 'redo':
          // Replay the CURRENT step (round) from its start — not the whole turn.
          playback.replayStep = true;
          break;
      }
    });
    ui.setReplayTransport?.(playback.paused);
  }

  // Replay timeline overlay — built from the same resolved steps, fog-filtered
  // to the viewing faction so it matches the canvas. Shown for both inline and
  // full PLAYBACK replay (full PLAYBACK runs fog-off, so all steps are visible).
  // Patch every snapshot to Entity prototypes BEFORE the digest's fog tests run
  // — _isFogVisible caches the LoS set per snapshot array, so an unpatched
  // snapshot here would bake a scout-less sight range into the cache that the
  // (patched) animation gates then reuse. patchAlive is idempotent; the step
  // loop's per-step patch becomes a no-op.
  let stepDigest = null;
  if (ui && steps.length) {
    for (const s of steps) patchAlive(s.entitySnapshot ?? []);
    patchAlive(finalEntities ?? []);
    stepDigest = buildStepDigest(steps, finalEntities, {
      isVisible: (col, row, ents) => _isFogVisible(col, row, humanFaction, ents, state.phase),
      PlanActionType, ResEventType, viewerFaction: humanFaction,
    });
    ui.showReplayTimeline?.(stepDigest);
  }
  setMode(AppMode.RESOLVING);

  // Shared visibility gate for the on-map animation — identical predicate to the
  // one buildStepDigest used for the cards, so every card has a matching
  // animation (and vice-versa). Union of source/target hex sight + public
  // actions (the horn), with sight computed from `viewEnts` — the POST-step
  // entity list (what the veil shows at the step-boundary hold) — and the
  // viewer's own units always visible. `humanFaction` null (AI-vs-AI / fog
  // off) ⇒ all visible.
  const _evVisible = (ev, ents, viewEnts) => isEventVisible(
    ev, ents,
    (c, r, e) => _isFogVisible(c, r, humanFaction, e, state.phase),
    { PlanActionType, ResEventType, viewerFaction: humanFaction, viewEnts },
  );

  // ── Fortification rewind ─────────────────────────────────────────────
  // state.tiles already carries the post-resolution fortifyLevel by the
  // time we animate.  Snapshot those values so we can restore them at the
  // end, then walk every event to compute the deltas each tile received
  // and subtract them so the ring animation starts at the pre-resolution
  // thickness.  Each fort-mutating event will re-apply its delta live as
  // we animate that step below.
  const postFortMap = new Map();
  const fortDeltasByTile = new Map(); // hexKey → total delta applied during resolution
  for (const [k, t] of state.tiles) postFortMap.set(k, t.fortifyLevel || 0);
  const _bumpDelta = (col, row, delta) => {
    if (!delta) return;
    const k = hexKey(col, row);
    fortDeltasByTile.set(k, (fortDeltasByTile.get(k) || 0) + delta);
  };
  for (const step of steps) {
    const evs = [
      ...(step.heroEvents  ?? []),
      ...(step.witchEvents ?? []),
      ...(step.playerEvents ?? []).flatMap(pe => pe.events ?? []),
    ];
    for (const ev of evs) {
      const r = ev.result;
      if (!r) continue;
      // FORTIFY: +defGain on actor's tile
      if (ev.action?.type === PlanActionType.FORTIFY && r.success) {
        const actorSnap = step.entitySnapshot?.find(e => e.id === ev.action.entityId);
        if (actorSnap) _bumpDelta(actorSnap.col, actorSnap.row, +(r.defGain ?? 1));
      }
      // Battle / guard strike degrading defender's fort: -1
      if (r.fortDamaged && !r.fortAssault) {
        const tSnap = ev.battleSnaps?.targetSnap;
        if (tSnap) _bumpDelta(tSnap.col, tSnap.row, -1);
      }
      // Fort assault: fortLevelAfter - fortLevelBefore (negative delta)
      if (r.fortAssault && r.success) {
        _bumpDelta(r.targetCol, r.targetRow, (r.fortLevelAfter ?? 0) - (r.fortLevelBefore ?? 0));
      }
    }
  }
  // Rewind tiles to pre-resolution fort levels.
  for (const [k, delta] of fortDeltasByTile) {
    const t = state.tiles.get(k);
    if (t) t.fortifyLevel = Math.max(0, (postFortMap.get(k) ?? 0) - delta);
  }

  // 3D combat-presentation (Phase 1): when a step's combat frame is held by
  // `renderer.frameEntities` (non-restoring), this tracks that a hold is live
  // so we can RELEASE it after the loop if the very last step was a battle and
  // nothing else moved the camera before the SUMMARY transition. A non-combat
  // step's own step-level frame releases it naturally (and clears this flag).
  let _heldCombatFrame3D = false;

  // Settle in-flight canvas animations. A NEXT/Redo/skip press HALTS instead:
  // clears all running animations so units snap to their resolved positions and
  // playback jumps ahead immediately.
  const _settleAnims = async () => {
    // Full-skip paths (jump-to-end / stop between rounds) clear outright — the
    // existing safe pattern. NEXT/Redo merely collapse the delays (so the action
    // finishes fast) and let it settle naturally; clearing an in-flight combat
    // animation mid-strike dangles the lunge/punch state and hangs resolution.
    if (playback.jumpToEnd || playback.aborted) {
      renderer.clearAnimations?.();
      return;
    }
    await renderer.waitForAnimations();
  };

  // Per-ACTION manual-step gate: in paused mode every presented action holds
  // for NEXT before the next one plays, so NEXT walks action-by-action rather
  // than turn-by-turn. The gate sits BEFORE each presentation — it only holds
  // once something has actually been shown since the last hold — so the
  // existing step-boundary gate below still owns the pause after a step's
  // FINAL action (and the round loop the round boundary). The simultaneous
  // move phase counts as one presentation: moves play together by design.
  let _presentedSinceGate = false;
  const _actionGate = async () => {
    if (_autoplay || !ui || !_presentedSinceGate) return;
    _presentedSinceGate = false;
    if (!playback.paused) return;
    await _settleAnims();
    ui.setReplayNextReady?.(true);
    while (playback.paused && !playback.stepRequested && !playback.replayStep
           && !playback.restart && !playback.aborted && !playback.goBack && !playback.jumpToEnd) {
      await new Promise(r => setTimeout(r, 50));
    }
    ui.setReplayNextReady?.(false);
    if (!playback.replayStep) playback.stepRequested = false;
  };

  // A discovery (survivor/zombie found via move/explore/horn) is now shown on
  // the timeline card; here we just focus the camera on the new unit (unless the
  // camera is FIXED) and reveal that action's card entry.
  const _showDiscoveryOnCard = async (unitData, stepIdx, actorId) => {
    if (renderer && ui?.replayCameraMode !== 'fixed' && !renderer.suppressAutoFrame) {
      const e = (finalEntities || state.entities)?.find(en => en && en.id === unitData?.id);
      if (e && e.col != null) {
        renderer.frameHexes([{ col: e.col, row: e.row }], { maxZoom: 2.0, paddingHexes: 2.5, duration: 450 });
      }
    }
    ui?.revealReplayEntryOutcome?.(stepIdx, actorId);
    redrawFn();
    await playbackDelay(900);   // hold so the player registers the find
  };

  // Survivor meshes aren't preloaded (the roster is large — see LAZY_RIG_TYPES).
  // We already know which survivors THIS round will reveal, so load their rigs
  // now and await, before the discovery standees are built — that way each shows
  // its own mesh instead of the mannequin stand-in. A 404 resolves harmlessly
  // (the unit keeps the mannequin).
  if (renderer?.preloadEntityRig) {
    const reveals = new Map(); // id → survivor entity (dedupe across steps)
    for (const step of steps) {
      const evs = [
        ...(step.heroEvents   ?? []),
        ...(step.witchEvents  ?? []),
        ...(step.playerEvents ?? []).flatMap(pe => pe.events ?? []),
      ];
      for (const ev of evs) {
        const one  = ev.result?.encounterSurvivor;
        if (one?.id) reveals.set(one.id, one);
        const many = ev.result?.encounterSurvivors;
        if (Array.isArray(many)) for (const m of many) if (m?.id) reveals.set(m.id, m);
      }
    }
    if (reveals.size) {
      await Promise.all([...reveals.values()].map(s => renderer.preloadEntityRig(s)));
    }
  }

  for (let i = 0; i < steps.length; i++) {
    // During replay: if BACK/STOP/REDO was pressed, abort remaining steps immediately
    if (playback.goBack || playback.aborted || playback.jumpToEnd || playback.restart) break;
    const step = steps[i];
    // The step-boundary gate (or the round loop) owned the pause that got us
    // here — the step's first action plays without an extra per-action hold.
    _presentedSinceGate = false;
    // Advance the timeline overlay: slide this step into the leftmost slot.
    ui?.setReplayTimelineStep?.(i);
    // Keep the camera-suppress flag on the renderer we actually frame with, so
    // FIXED never moves regardless of any ui.renderer/renderer instance split.
    if (renderer) {
      const _fixedCam = ui?.replayCameraMode === 'fixed';
      renderer.suppressAutoFrame = _fixedCam;
      if (_fixedCam) renderer._zoomAnim = null;   // cancel any in-flight 2D camera ease
    }
    // Patch the CURRENT step's snapshot so any lookups against it resolve
    // to Entity methods (hasAbility / getAttack / hasTag). _isFogVisible
    // is the hot caller — it receives step.entitySnapshot directly and
    // calls `e.hasAbility('scout')` on each entry, which blew up on the
    // plain-JSON server snapshot before this patch ran (PR #294 online
    // resolution crash).
    patchAlive(step.entitySnapshot);
    // Post-step entities: what the world looks like AFTER this step resolves.
    // Re-parent the post-step snapshot entities to Entity.prototype the first
    // time through. resolver.snapshotEntities emits plain JSON objects; the
    // renderer calls entity methods (hasAbility / getAttack / hasTag / …)
    // when rendering fog of war and unit stats from state.entities during
    // animation. patchAlive is idempotent — subsequent steps that reuse
    // the same snapshot array skip over already-prototyped entities.
    const postEntities = patchAlive(
      i + 1 < steps.length ? steps[i + 1].entitySnapshot : finalEntities,
    );

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
    //
    // step.entitySnapshot is a plain JSON snapshot from resolver.snapshotEntities.
    // Re-parent each display clone to Entity.prototype so the renderer's
    // hasAbility() / getAttack() / getDefense() / hasTag() calls resolve to
    // Entity methods while the state-level swap holds during animation.
    // (Own properties from the spread — including `alive` and `displayName` —
    // shadow the Entity prototype's read-only getters.)
    const displayEntities = step.entitySnapshot.map(e => Object.setPrototypeOf({ ...e }, Entity.prototype));
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

    // ── 3D cinematic combat framing (Phase 1) ────────────────────────────────
    // Cluster this step's visible battles by map proximity so the camera frames
    // each cluster ONCE (via the non-restoring `frameEntities`) and HOLDS across
    // every same-cluster battle. The 2D path is unchanged — gated on `is3D`.
    const _cinematic = !_autoplay && (ui?.speedMode ?? 'cinematic') === 'cinematic';
    const _is3DCinematic = !!(renderer?.is3D) && _cinematic;
    // Default OFF for the move phase so move bump-back lunges keep their
    // built-in framing; flipped ON just before the battle phases below (where
    // main.js owns the rotated, card-aware, AWAITED cluster frame).
    if (renderer) renderer._suppressLungeFraming = false;
    // Same visibility predicate Phase 2 applies per battle (lines below) — so we
    // only cluster battles that will actually be presented to this viewer.
    const _battleShown = (ev) =>
      !!ev.battleSnaps && _evVisible(ev, step.entitySnapshot, postEntities);
    let _combatFrames = null;        // ordered frames from planCombatFrames
    let _eventFrameIndex = null;     // Map<battleEvent, frameIndex>
    let _heldFrameIndex = -1;        // which cluster the camera currently holds
    if (_is3DCinematic) {
      const battleEvents = events.filter(ev =>
        (ev.action.type === PlanActionType.BATTLE_UNIT || ev.action.type === PlanActionType.BATTLE_HEX)
        && ev.battleSnaps && !ev.result?.fortAssault && _battleShown(ev)
      );
      if (battleEvents.length) {
        _combatFrames = planCombatFrames(battleEvents);
        _eventFrameIndex = new Map();
        for (let fi = 0; fi < _combatFrames.length; fi++) {
          for (const ei of _combatFrames[fi].eventIndices) {
            _eventFrameIndex.set(battleEvents[ei], fi);
          }
        }
      }
    }
    // True when this 3D step presents battles — the step-level frame and the
    // per-battle 2D frameHexes are suppressed for it so they don't stomp the
    // held cluster frame.
    const _stepHas3DCombat = !!(_combatFrames && _combatFrames.length);

    // ── Frame camera on this step's actors ──────────────────────────────────
    if (!_autoplay && !_stepHas3DCombat) {
      const _cspd = ui?.speedMode ?? 'cinematic';
      {
        // In cinematic mode, battles get per-battle dialog framing
        // (with insetRight=500). To avoid a "yoyo" (centered frame → dialog
        // reframe), detect the first visible battle and apply the dialog
        // inset directly in this step-level frame, so the camera lands in the
        // final position from the start.
        const hasBattleDialogFraming = (_cspd === 'cinematic');
        let firstBattleTargets = null;
        let firstBattleFrameKey = null;
        if (hasBattleDialogFraming) {
          for (const ev of events) {
            if (ev.action.type !== PlanActionType.BATTLE_UNIT && ev.action.type !== PlanActionType.BATTLE_HEX) continue;
            if (!ev.battleSnaps) continue;
            const { actorSnap, targetSnap } = ev.battleSnaps;
            if (_evVisible(ev, step.entitySnapshot, postEntities) && actorSnap && targetSnap) {
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
            if (snap && _evVisible(ev, step.entitySnapshot, postEntities)) {
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
          renderer.frameHexes(frameTargets, {
            paddingHexes: firstBattleTargets ? 2.5 : 3.0,
            maxZoom:      2.0,
            duration:     250,
          });
          // This step-level move releases any held 3D combat frame (Phase 1):
          // the camera has just panned to a non-combat step's actors.
          _heldCombatFrame3D = false;
          await playbackDelay(_cspd === 'vfast' ? 140 : 280);
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
    // Moves play together, so highlight every move card in this step at once.
    // _stepHasAction tests the digest so the highlight only fires (and clears
    // the prior group) when this phase actually has visible cards to show.
    const _stepHasAction = (t) => !!stepDigest?.[i]?.entries.some(e => e.actionType === t);
    if (_stepHasAction(PlanActionType.MOVE)) ui?.highlightReplayActions?.(i, ['move']);
    let hadMove = false;
    const pendingDialogs = [];

    // Agility resolves the highest-Agility unit's action first within a step. When
    // an attacker out-speeds a FLEEING target, the strike lands while the target
    // is still on its start hex, then the target moves — so we must NOT animate
    // that move first (it would warp the unit back to its start hex for the strike
    // then zip it to its destination). These ids' moves are held until after the
    // battle pass (Phase 1b below). See battle-utils.deferredMoveEntityIds.
    const deferIds = deferredMoveEntityIds(events, step.entitySnapshot, PlanActionType);

    // Collect pre-step snapshots and paths for all move events
    const moveAnims = [];
    const deferredMoveAnims = []; // attacker out-sped a fleeing mover — walk after the battle
    for (const ev of events) {
      const { action, result } = ev;
      if (action.type !== PlanActionType.MOVE) continue;

      const preSnap = step.entitySnapshot?.find(e => e.id === action.entityId);
      // Moves are visible if origin or destination is within sight range.
      const visible = preSnap && _evVisible(ev, step.entitySnapshot, postEntities);

      // Use result.path if available (new path-following move); fall back to single hop
      const path = result?.path?.length > 0
        ? result.path
        : [{ col: action.toCol, row: action.toRow }];

      if (visible) (deferIds.has(action.entityId) ? deferredMoveAnims : moveAnims).push({ ev, preSnap, path });

      if ((!humanFaction || ev.faction === humanFaction) && result?.encounterLog?.length) {
        if (!myPlayerId || preSnap?.ownerId === myPlayerId) {
          pendingDialogs.push({ log: result.encounterLog, encounterUnit: result.encounterSurvivor ?? null, actorId: action.entityId });
        }
      }
    }

    if (moveAnims.length > 0) {
      hadMove = true;
      _presentedSinceGate = true;   // the simultaneous move phase = one ACTION hold
      const _spd = ui?.speedMode ?? 'cinematic';
      const hopDelay = _spd === 'vfast' ? 160 : 320;

      if (renderer?.is3D) {
        // 3D: animate the entire path as ONE move per entity, passing
        // the full waypoint list as a 9th arg so the renderer builds a
        // multi-keyframe polyline (origin → path[0] → … → path[last]).
        // Frames are allocated proportionally to segment lengths so the
        // cone moves at constant ground speed across the polyline —
        // total move duration is MOVE_ANIM_MS regardless of segment
        // count. A 2-hex road = 500ms per segment, a 3-hex horse run =
        // 333ms per segment, etc. addMoveAnim scales walkGroup.speedRatio
        // by totalLen / hexStep so the walk cycle's foot-plant stays
        // accurate across every segment.
        for (const { ev, preSnap, path } of moveAnims) {
          const lastPos = path[path.length - 1];
          const destSlot = ev.result?.slot ?? 0;
          renderer.addMoveAnim(
            ev.action.entityId,
            preSnap.col, preSnap.row,
            lastPos.col, lastPos.row,
            preSnap.type, preSnap.owner,
            preSnap.title ?? null,
            path, // full waypoint list
            preSnap.slot ?? 0, destSlot, // source → destination sub-hex slot
          );
          const ent = displayEntities.find(e => e.id === ev.action.entityId);
          if (ent) { ent.col = lastPos.col; ent.row = lastPos.row; ent.slot = destSlot; }
        }
        state.entities = displayEntities;
        redrawFn();
        if (!_autoplay && hopDelay > 0) await playbackDelay(hopDelay);
      } else {
        // 2D: hop-by-hop animation as before.
        const maxHops = moveAnims.reduce((m, a) => Math.max(m, a.path.length), 0);
        for (let hop = 0; hop < maxHops; hop++) {
          for (const { ev, preSnap, path } of moveAnims) {
            if (hop >= path.length) continue;
            const fromPos = hop === 0 ? preSnap : path[hop - 1];
            const toPos   = path[hop];
            const isLastHop = hop === path.length - 1;
            const destSlot = ev.result?.slot ?? 0;
            // Only the very first point uses the source slot and the very last
            // the destination slot; intermediate hops pass through hex centres.
            const fromSlot = hop === 0 ? (preSnap.slot ?? 0) : 0;
            const toSlot   = isLastHop ? destSlot : 0;
            renderer.addMoveAnim(
              ev.action.entityId,
              fromPos.col, fromPos.row,
              toPos.col, toPos.row,
              preSnap.type, preSnap.owner,
              preSnap.title ?? null,
              null, // no path — 2D animates hops externally
              fromSlot, toSlot,
            );
            const ent = displayEntities.find(e => e.id === ev.action.entityId);
            if (ent) { ent.col = toPos.col; ent.row = toPos.row; ent.slot = toSlot; }
          }
          state.entities = displayEntities;
          redrawFn();
          if (!_autoplay && hopDelay > 0) await playbackDelay(hopDelay);
        }
      }

      // Bounce-back for partial moves: if the unit stopped short due to an
      // enemy or fort wall, play a short lunge toward the blocking hex and
      // slide back so the player sees why the move ended early.
      if (!_autoplay) {
        const _spd2 = ui?.speedMode ?? 'cinematic';
        const bumped = moveAnims.filter(({ ev }) =>
          (ev.result?.blockedBy || ev.result?.blockedByFort)
        );
        if (bumped.length) {
          for (const { ev, preSnap, path } of bumped) {
            const bumpFrom = path.length > 0 ? path[path.length - 1] : preSnap;
            const bumpTo = ev.result.blockedByFort
              ? { col: ev.result.blockedByFort.col, row: ev.result.blockedByFort.row }
              : ev.result.blockedBy
                ? { col: ev.result.blockedBy.col, row: ev.result.blockedBy.row }
                : null;
            if (!bumpTo) continue;
            // Start the bump from the unit's actual slot (its current display
            // slot after the partial move) and stop at the hex boundary.
            const bumpEnt = displayEntities.find(e => e.id === ev.action.entityId);
            const bumpSlot = bumpEnt?.slot ?? ev.result?.slot ?? preSnap.slot ?? 0;
            renderer.addLungeAnim(
              ev.action.entityId,
              bumpFrom.col, bumpFrom.row,
              bumpTo.col, bumpTo.row,
              preSnap.type, preSnap.owner, preSnap.title ?? null,
              bumpSlot, true, // start in slot, stop at the hex boundary
            );
            if (ev.result.blockedByFort) {
              renderer.addFlash(bumpTo.col, bumpTo.row, '🏰',
                'rgba(170,170,175,0.15)', 900, 0.75, 'rgba(200,200,210,1)');
            }
          }
          redrawFn();
          await playbackDelay(_spd2 === 'vfast' ? 140 : 240);
          renderer.returnAllLungeAnims();
          await renderer.waitForAnimations();
          redrawFn();
        }
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

    // ── Fully-blocked moves (ACTION_FAIL): walk to the blocked edge and back ──
    // Animated HERE, as part of the move phase, rather than in a pass after the
    // battles — so a unit that was blocked and then attacked shows its thwarted
    // step BEFORE its strike (the natural plan order), not afterwards. Real
    // moves fired above are still in flight, so awaiting here lets the bump-walk
    // play concurrently with them and finish before the battle phase begins
    // (important: the blocked unit is often the same one that then attacks).
    // 3D only — the 2D editor renderer has no addBumpWalkAnim.
    if (!_autoplay && typeof renderer?.addBumpWalkAnim === 'function') {
      const bumpedIds = [];
      for (const ev of allStepEvents) {
        if (ev.type !== ResEventType.ACTION_FAIL) continue;
        if (ev.action?.type !== PlanActionType.MOVE) continue;
        if (!(ev.blockedBy || ev.blockedByFort)) continue;
        const preSnap = step.entitySnapshot?.find(e => e.id === ev.action.entityId);
        if (!preSnap || !_evVisible(ev, step.entitySnapshot, postEntities)) continue;
        const bumpTo = ev.blockedByFort
          ? { col: ev.blockedByFort.col, row: ev.blockedByFort.row }
          : { col: ev.blockedBy.col, row: ev.blockedBy.row };
        renderer.addBumpWalkAnim(
          ev.action.entityId,
          preSnap.col, preSnap.row,
          bumpTo.col, bumpTo.row,
          preSnap.type, preSnap.owner, preSnap.title ?? null,
          preSnap.slot ?? 0,
        );
        if (ev.blockedByFort) {
          renderer.addFlash(bumpTo.col, bumpTo.row, '🏰',
            'rgba(170,170,175,0.15)', 900, 0.75, 'rgba(200,200,210,1)');
        }
        hadMove = true;
        bumpedIds.push(ev.action.entityId);
      }
      // Await the bump-walks (and any still-in-flight real moves) so the move
      // phase fully settles before battles animate.
      if (bumpedIds.length) {
        _presentedSinceGate = true;   // the bump-walk counts as an ACTION hold
        redrawFn();
        await renderer.waitForAnimations();
        redrawFn();
        // Reveal each blocked move's BLOCKED note now that its bump-walk has
        // played (per-ACTION, not at the end of the TURN).
        for (const id of bumpedIds) ui?.revealReplayEntryOutcome?.(i, id);
      }
    }

    // Update node discovery after moves so nodes become visible mid-animation
    _updateNodeDiscoveryDuringStep(state, humanFaction, renderer);

    const _suppressDialogs = getMode() === AppMode.PLAYBACK || ui?.speedMode === 'vfast';
    if (!_suppressDialogs) {
      for (const entry of pendingDialogs) {
        redrawFn();
        if (entry.encounterUnit) {
          await _showDiscoveryOnCard(entry.encounterUnit, i, entry.actorId);
        } else {
          await new Promise(resolve => ui._showResultDialog(entry.log, resolve));
        }
      }
    }

    // ── Phase 2: battles and summons ──────────────────────────────────────────
    // From here on (battles + guard strikes) the 3D cinematic arm frames the
    // combat cluster itself — rotated so the axis reads left-to-right, zoomed to
    // a card-aware radius, and AWAITED before the lunge — so suppress the
    // lunge's own midpoint reframe. Fast/vfast/autoplay keep their built-in
    // lean-in (flag stays false).
    if (renderer) renderer._suppressLungeFraming = _is3DCinematic;
    let hadBattle = false;
    for (const ev of events) {
      const { action, result, battleSnaps } = ev;
      if (action.type === PlanActionType.BATTLE_UNIT || action.type === PlanActionType.BATTLE_HEX) {
        // Fort assault: BATTLE_HEX that hit a wall instead of a unit.  Handled
        // in its own pass below (no targetSnap → skip the normal battle path).
        if (result?.fortAssault) continue;
        // Show the battle if the viewer can see either combatant's hex — same
        // positional rule the timeline card uses (so card ⟷ animation agree).
        if (battleSnaps && _evVisible(ev, step.entitySnapshot, postEntities)) {
          const { actorSnap, targetSnap } = battleSnaps;
          const isKill = !!result?.killed;
          // Hold for NEXT before this battle if a prior action already played.
          await _actionGate();
          // Highlight this battle's row on the timeline as it begins.
          ui?.highlightReplayEntry?.(i, actorSnap.id);

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

            // ── Step 0 (3D): FRAME first, AWAIT camera arrival, THEN lunge ─────
            // The camera rotates the attacker→target axis to read left-to-right,
            // zooms to a card-aware radius, and pans to the cluster centroid —
            // all BEFORE the strike, so the attack never starts mid-pan. Only
            // re-frame on a NEW cluster; the non-restoring frame persists across
            // same-cluster battles, so we await it only on the change.
            if (speed === 'cinematic' && _stepHas3DCombat && _eventFrameIndex) {
              const fi = _eventFrameIndex.get(ev);
              if (fi != null && fi !== _heldFrameIndex) {
                const cl = _combatFrames[fi];
                await renderer.frameCombatants(cl.ids[0], cl.ids[1], {
                  extraIds: cl.ids.slice(2),
                  padding: 1.15,
                });
                _heldFrameIndex = fi;
              }
              _heldCombatFrame3D = true;
            }

            _playAttackIntroAnim(
              actorSnap, targetSnap,
              lungeFromCol, lungeFromRow,
              lungeToCol, lungeToRow,
              battleSnaps.ranged,
            );
            redrawFn();
            // Ranged attacks travel on their own 320ms timer — give them
            // enough room to visibly land before the impact flash fires in
            // fast/vfast modes (cinematic awaits dialog dismissal anyway).
            const isRangedIntro = !!battleSnaps.ranged || (actorSnap?.range ?? 1) > 1;
            const introDelay = isRangedIntro
              ? (speed === 'vfast' ? 260 : 340)
              : (speed === 'vfast' ? 140 : 280);
            await playbackDelay(introDelay);

            // ── Step 2: Battle hex highlights ────────────────────────────────
            {
              const allyEntities = _getBattleAllyEntities(actorSnap, targetSnap, state.entities);
              renderer.setBattleHighlights(
                [{ col: lungeFromCol, row: lungeFromRow }, { col: lungeToCol, row: lungeToRow }],
                allyEntities.map(e => ({ col: e.col, row: e.row })),
              );
              redrawFn();
            }

            // ── Step 3: Card-hold (3D) / Dialog (2D cinematic) or toast (fast) ─
            if (speed === 'cinematic') {
              if (_stepHas3DCombat && _eventFrameIndex) {
                // 3D: the cluster frame was issued + AWAITED before the lunge
                // (Step 0 above) and HOLDS across same-cluster battles. Here we
                // just run the presentation: NO modal — freeze the strike
                // mid-swing, read the dice cards above both heads, resume the
                // strike, then play the result floaters, all via the anim queue.
                await _run3DCombatCardHold(actorSnap, targetSnap, result, redrawFn);
              } else {
                // 2D: per-battle frameHexes with right-dock inset (unchanged).
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
                // 2D keeps the modal: wait for dismiss, THEN play floaters.
                await new Promise(resolve => {
                  ui._showBattleDialog(actorSnap, targetSnap, result, resolve);
                });
                _playBattleResultAnims(actorSnap, targetSnap, result, redrawFn);
                // Drain all floaters (HP text 1800ms, death burst 600ms) before next battle.
                await renderer.waitForAnimations();
              }
            } else if (speed === 'fast' || speed === 'vfast') {
              // Toast + floater only — no dialog. Shared with the tester via
              // playFastCombatDisplay (src/combat-fast.js). The miss word is
              // picked here (only when needed) so the Math.random() sequence
              // matches the pre-refactor behaviour byte-for-byte.
              const missText = !result.hit
                ? BLOCK_WORD_VARIANTS[Math.floor(Math.random() * BLOCK_WORD_VARIANTS.length)]
                : null;
              await playFastCombatDisplay({
                renderer, state, actorSnap, targetSnap, result,
                playBattleResultAnims: (a, t, r) => _playBattleResultAnims(a, t, r, redrawFn),
                speed, missText,
                playbackDelay,
              });
            }

            // ── Step 4: Clear highlights, animate lunge return ───────────────
            renderer.clearBattleHighlights();
            renderer.returnAllLungeAnims(); // slide entity back rather than snap
            // Let the strike fully settle BEFORE revealing the result (all
            // speeds); a NEXT/Redo press halts and snaps instead of waiting.
            await _settleAnims();
            redrawFn();

          } else {
            // Autoplay: fire all animations immediately without dialogs or lunge.
            _playBattleResultAnims(actorSnap, targetSnap, result, redrawFn);
          }
          // Reveal THIS action's rolls + outcome now that its animation has
          // settled (per-ACTION, not at the end of the TURN).
          ui?.revealReplayEntryOutcome?.(i, actorSnap.id);
          hadBattle = true;
          _presentedSinceGate = true;
        }
      } else if (action.type === PlanActionType.SUMMON) {
        const actorSnap = step.entitySnapshot?.find(e => e.id === action.entityId);
        // Only animate the conjuring if the summoner's hex is in sight (the unit
        // appears on the summoner's own hex) — matches the SUMMON card's gate.
        if (actorSnap && _evVisible(ev, step.entitySnapshot, postEntities)) {
          await _actionGate();
          renderer.addSpawnAnim(actorSnap.col, actorSnap.row, '#b39ddb');
          audio.play('summon');
          hadBattle = true;
          _presentedSinceGate = true;
        }
      }
    }

    // (Fully-blocked moves now animate in the MOVE phase above, before battles —
    // see the addBumpWalkAnim pass there — so a blocked-then-attack unit shows
    // its thwarted step before its strike instead of after.)

    // ── Phase 1b: deferred moves (a faster attacker struck before the flee) ───
    // Held at their start hex through the battle pass (so the strike read on the
    // pre-move hex); now walk them to their destination. Mirrors the MOVE phase's
    // slide; dead units never produce a move so there's nothing to skip here.
    if (deferredMoveAnims.length > 0) {
      await _actionGate();
      hadMove = true;
      _presentedSinceGate = true;
      const _spd = ui?.speedMode ?? 'cinematic';
      const hopDelay = _spd === 'vfast' ? 160 : 320;
      if (renderer?.is3D) {
        for (const { ev, preSnap, path } of deferredMoveAnims) {
          const lastPos = path[path.length - 1];
          const destSlot = ev.result?.slot ?? 0;
          renderer.addMoveAnim(
            ev.action.entityId,
            preSnap.col, preSnap.row,
            lastPos.col, lastPos.row,
            preSnap.type, preSnap.owner, preSnap.title ?? null,
            path, preSnap.slot ?? 0, destSlot,
          );
          const ent = displayEntities.find(e => e.id === ev.action.entityId);
          if (ent) { ent.col = lastPos.col; ent.row = lastPos.row; ent.slot = destSlot; }
        }
        state.entities = displayEntities;
        redrawFn();
        if (!_autoplay && hopDelay > 0) await playbackDelay(hopDelay);
      } else {
        const maxHops = deferredMoveAnims.reduce((m, a) => Math.max(m, a.path.length), 0);
        for (let hop = 0; hop < maxHops; hop++) {
          for (const { ev, preSnap, path } of deferredMoveAnims) {
            if (hop >= path.length) continue;
            const fromPos = hop === 0 ? preSnap : path[hop - 1];
            const toPos   = path[hop];
            const isLastHop = hop === path.length - 1;
            const destSlot = ev.result?.slot ?? 0;
            const fromSlot = hop === 0 ? (preSnap.slot ?? 0) : 0;
            const toSlot   = isLastHop ? destSlot : 0;
            renderer.addMoveAnim(
              ev.action.entityId,
              fromPos.col, fromPos.row, toPos.col, toPos.row,
              preSnap.type, preSnap.owner, preSnap.title ?? null,
              null, fromSlot, toSlot,
            );
            const ent = displayEntities.find(e => e.id === ev.action.entityId);
            if (ent) { ent.col = toPos.col; ent.row = toPos.row; ent.slot = toSlot; }
          }
          state.entities = displayEntities;
          redrawFn();
          if (!_autoplay && hopDelay > 0) await playbackDelay(hopDelay);
        }
      }
      if (!_autoplay) { await _settleAnims(); redrawFn(); }
    }

    // ── Phase 2a: empty-hex attack whiffs (lunge + "no enemy" floater) ───────
    const whiffEvents = allStepEvents.filter(
      ev => ev.type === ResEventType.ACTION_SKIP && ev.whiffTarget && ev.battleSnaps?.actorSnap
    );
    for (const ev of whiffEvents) {
      const { actorSnap } = ev.battleSnaps;
      const { col: tCol, row: tRow } = ev.whiffTarget;

      // Visibility — actor's hex OR the empty target hex (same as the card).
      if (!_evVisible(ev, step.entitySnapshot, postEntities)) continue;
      await _actionGate();

      if (!_autoplay) {
        const speed = ui?.speedMode ?? 'cinematic';

        // Lunge or projectile toward the empty hex — ranged units still
        // fire a shot that whiffs, melee leans in and swings at nothing.
        const actorDisplay = state.entities.find(e => e.id === actorSnap.id);
        const lungeFromCol = actorDisplay?.col ?? actorSnap.col;
        const lungeFromRow = actorDisplay?.row ?? actorSnap.row;
        _playAttackIntroAnim(
          actorSnap, null,
          lungeFromCol, lungeFromRow,
          tCol, tRow,
          ev.battleSnaps?.ranged,
        );
        redrawFn();
        await playbackDelay(speed === 'vfast' ? 140 : 280);

        // Floater on the target hex — "fled!" when the quarry escaped this
        // turn (alive, out of reach), "no enemy" for a plain empty-hex whiff.
        const whiffText = ev.targetFled ? 'fled!' : 'no enemy';
        renderer.addFlash(tCol, tRow, whiffText, 'rgba(100,100,100,0.1)', 1000, 0.65, '#888');
        redrawFn();
        await playbackDelay(speed === 'vfast' ? 200 : 400);

        // Return lunge (projectiles self-clear on impact; this is a no-op for them)
        renderer.returnAllLungeAnims();
        if (speed === 'cinematic') await renderer.waitForAnimations();
        redrawFn();
      }
      // Reveal the whiff's NO TARGET / TARGET FLED note at the end of THIS
      // action, not at the end of the TURN.
      ui?.revealReplayEntryOutcome?.(i, actorSnap.id);
      hadBattle = true;
      _presentedSinceGate = true;
    }

    // ── Phase 2a'': witch fort assaults (siege an empty fortified hex) ──────
    // Lunge toward the wall, show a hit/crush/miss floater, then apply the
    // fort-level drop in sync with the visual so the ring thins out now.
    const fortAssaultEvents = allStepEvents.filter(ev =>
      ev.type === ResEventType.ACTION_OK &&
      ev.result?.fortAssault &&
      ev.battleSnaps?.actorSnap
    );
    for (const ev of fortAssaultEvents) {
      const { actorSnap } = ev.battleSnaps;
      const r = ev.result;
      const tCol = r.targetCol, tRow = r.targetRow;

      if (_evVisible(ev, step.entitySnapshot, postEntities) && !_autoplay) {
        await _actionGate();
        _presentedSinceGate = true;
        const speed = ui?.speedMode ?? 'cinematic';
        const actorDisplay = state.entities.find(e => e.id === actorSnap.id);
        const lungeFromCol = actorDisplay?.col ?? actorSnap.col;
        const lungeFromRow = actorDisplay?.row ?? actorSnap.row;
        renderer.addLungeAnim(
          actorSnap.id,
          lungeFromCol, lungeFromRow,
          tCol, tRow,
          actorSnap.type, actorSnap.owner, actorSnap.title ?? null,
        );
        redrawFn();
        await playbackDelay(speed === 'vfast' ? 140 : 280);

        if (r.hit) {
          const label = r.crush ? '💥 🏰-2' : '🏰-1';
          renderer.addFlash(tCol, tRow, label,
            'rgba(180,100,100,0.18)', 1600, 0.75, 'rgba(230,180,180,1)');
        } else {
          renderer.addFlash(tCol, tRow, 'holds',
            'rgba(170,170,175,0.15)', 1000, 0.65, 'rgba(200,200,210,1)');
        }
        redrawFn();
        await playbackDelay(speed === 'vfast' ? 200 : 400);
        renderer.returnAllLungeAnims();
        if (speed === 'cinematic') await renderer.waitForAnimations();
      }

      // Apply the fort-level delta now (visible even to non-viewer so the
      // authoritative state stays in sync across all observers).
      const tile = state.tiles.get(hexKey(tCol, tRow));
      if (tile) tile.fortifyLevel = r.fortLevelAfter ?? tile.fortifyLevel;
      redrawFn();
      hadBattle = true;
    }

    // ── Phase 2b: guard strike reactions (LEGACY) ────────────────────────────
    // New guard reactions are inserted by the resolver as normal BATTLE_UNIT
    // events and animate in Phase 2 above. This branch only fires for the legacy
    // GUARD_STRIKE event kind still present in pre-existing saved replays.
    const guardStrikeEvents = allStepEvents.filter(ev => ev.type === ResEventType.GUARD_STRIKE);
    for (const ev of guardStrikeEvents) {
      const { result, battleSnaps } = ev;
      if (!battleSnaps) continue;
      const { actorSnap, targetSnap } = battleSnaps;

      // Positional visibility — actor's or target's hex in sight (same as card).
      if (!_evVisible(ev, step.entitySnapshot, postEntities)) continue;
      await _actionGate();
      // Highlight this guard strike's card as it fires.
      ui?.highlightReplayEntry?.(i, actorSnap.id);

      if (!_autoplay) {
        const speed = ui?.speedMode ?? 'cinematic';

        // Guardian snaps toward the target — projectile if ranged, otherwise melee lunge.
        const guardDisplay  = state.entities.find(e => e.id === actorSnap.id);
        const targetDisplay = state.entities.find(e => e.id === targetSnap.id);
        const lungeFromCol = guardDisplay?.col  ?? actorSnap.col;
        const lungeFromRow = guardDisplay?.row  ?? actorSnap.row;
        const lungeToCol   = targetDisplay?.col ?? targetSnap.col;
        const lungeToRow   = targetDisplay?.row ?? targetSnap.row;

        // 3D cinematic: FRAME + AWAIT before the lunge (same as the regular
        // battle arm). Only when this step had no clustered battles to frame —
        // otherwise the held cluster frame already covers these hexes (guard
        // strikes fire at the same positions). Stand-alone guard strikes orient
        // their own attacker→target axis.
        if (speed === 'cinematic' && _is3DCinematic
            && !_stepHas3DCombat && !_heldCombatFrame3D) {
          await renderer.frameCombatants(actorSnap.id, targetSnap.id, { padding: 1.15 });
          _heldCombatFrame3D = true;
        }

        _playAttackIntroAnim(
          actorSnap, targetSnap,
          lungeFromCol, lungeFromRow,
          lungeToCol, lungeToRow,
          battleSnaps.ranged,
        );
        redrawFn();
        await playbackDelay(speed === 'vfast' ? 140 : 280);

        // Battle hex highlights
        renderer.setBattleHighlights(
          [{ col: lungeFromCol, row: lungeFromRow }, { col: lungeToCol, row: lungeToRow }],
          [],  // no allies for guard strikes
        );
        redrawFn();

        if (speed === 'cinematic') {
          if (_is3DCinematic) {
            // 3D: the frame (held cluster frame, or the stand-alone frame issued
            // + AWAITED before the lunge above) is already in place. No 2D inset
            // docking. G4 Phase 3: NO modal — frozen strike + dice cards +
            // resume + floaters, same as the regular battle arm.
            _heldCombatFrame3D = true;
            await _run3DCombatCardHold(actorSnap, targetSnap, result, redrawFn);
          } else {
            // 2D: reuse the same frame-key tracking from Phase 2 so guard strikes
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
            // 2D keeps the modal.
            await new Promise(resolve => {
              ui._showBattleDialog(actorSnap, targetSnap, result, resolve);
            });
            _playBattleResultAnims(actorSnap, targetSnap, result, redrawFn);
            await renderer.waitForAnimations();
          }
        } else {
          // fast / vfast guard-strike display — shared with the regular battle
          // arm and the admin combat tester via playFastCombatDisplay.
          const missText = !result.hit
            ? BLOCK_WORD_VARIANTS[Math.floor(Math.random() * BLOCK_WORD_VARIANTS.length)]
            : null;
          await playFastCombatDisplay({
            renderer, actorSnap, targetSnap, result,
            playBattleResultAnims: (a, t, r) => _playBattleResultAnims(a, t, r, redrawFn),
            speed, missText,
            playbackDelay,
          });
        }

        // Clear highlights, return lunge
        renderer.clearBattleHighlights();
        renderer.returnAllLungeAnims();
        if (speed === 'cinematic') await renderer.waitForAnimations();
        redrawFn();

      } else {
        // Autoplay: fire all animations immediately
        _playBattleResultAnims(actorSnap, targetSnap, result, redrawFn);
      }
      // Reveal this guard strike's rolls + outcome (per-ACTION).
      ui?.revealReplayEntryOutcome?.(i, actorSnap.id);
      hadBattle = true;
      _presentedSinceGate = true;
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

    // Clear loot flashes from previous steps so only this step's explore
    // results are visible (flashes last 1800ms but inter-step delay is <300ms).
    let hadExplore = false;
    const hasExploreEvents = events.some(ev => ev.action?.type === PlanActionType.EXPLORE && ev.result?.log?.length);
    if (hasExploreEvents) renderer.clearFlashes();
    if (_stepHasAction(PlanActionType.EXPLORE)) ui?.highlightReplayActions?.(i, ['explore']);

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
      // Loot flash shows to anyone who can see the explorer (matches the card);
      // the discovery modal stays the finder's own (own faction / controlled unit).
      if (!_evVisible(ev, step.entitySnapshot, postEntities)) continue;
      await _actionGate();
      const actor = explorer;
      if (actor) {
        ui._showLootFlashes(actor, result.lootItems ?? []);
        hadExplore = true;
        _presentedSinceGate = true;
      }
      redrawFn();
      const ownFind = (!humanFaction || ev.faction === humanFaction)
        && (!myPlayerId || actor?.ownerId === myPlayerId);
      if (ownFind && !_suppressDialogs && result.encounterSurvivor) {
        await _showDiscoveryOnCard(result.encounterSurvivor, i, action.entityId);
      }
    }
    // Wait for loot flashes so they're fully visible before the next step
    // starts a new explore and clears them.
    if (hadExplore && !_autoplay) {
      const _espd = ui?.speedMode ?? 'cinematic';
      await playbackDelay(_espd === 'vfast' ? 300 : _espd === 'fast' ? 600 : 1200);
    }

    // ── Phase 3b: Sound Horn — horn flash + survivor encounter ────────────
    if (_stepHasAction(PlanActionType.SOUND_HORN)) ui?.highlightReplayActions?.(i, ['sound-horn']);
    for (const ev of events) {
      const { action, result } = ev;
      if (action.type !== PlanActionType.SOUND_HORN) continue;
      if (!result?.success) continue;
      const actor = step.entitySnapshot?.find(e => e.id === action.entityId);
      if (!actor) continue;
      await _actionGate();
      _presentedSinceGate = true;

      // Frame camera on all hero units — the horn reveals them to the opponent
      if (!_autoplay) {
        const hornTargets = step.entitySnapshot
          .filter(e => e.alive && e.owner === 'hero')
          .map(e => ({ col: e.col, row: e.row }));
        if (hornTargets.length) {
          renderer.frameHexes(hornTargets, { paddingHexes: 3, maxZoom: 1.8, duration: 400 });
          await playbackDelay(420);
        }
      }

      // Gold expanding ring telegraphing the horn pulse. Renderer-agnostic
      // hook — 2D paints a flat node-reveal ring, 3D builds a torus ring
      // that scales outward; see `addSoundHorn` in both renderers.
      renderer.addSoundHorn(actor.col, actor.row, '#d4a72c');
      redrawFn();

      // Wait for the horn animation to finish before showing dialogs
      await renderer.waitForAnimations();

      if (humanFaction && ev.faction !== humanFaction) continue;
      if (myPlayerId && actor?.ownerId !== myPlayerId) continue;

      if (!_suppressDialogs) {
        const survivors = result.encounterSurvivors || (result.encounterSurvivor ? [result.encounterSurvivor] : []);
        if (survivors.length > 0) {
          // Reveal the horn card + pan to each survivor drawn by the call.
          for (const s of survivors) {
            await _showDiscoveryOnCard(s, i, action.entityId);
          }
        } else if (result.log?.length) {
          // No survivor — show the "nothing found" result dialog
          await new Promise(resolve => ui._showResultDialog(result.log, resolve));
        }
      }
    }

    // ── Phase 4: fortify/reinforce visual feedback ────────────────────────
    if (_stepHasAction(PlanActionType.FORTIFY)) ui?.highlightReplayActions?.(i, ['fortify']);
    for (const ev of events) {
      const { action, result } = ev;
      if (action.type !== PlanActionType.FORTIFY || !result?.success) continue;
      const actor = step.entitySnapshot?.find(e => e.id === action.entityId);
      if (!actor) continue;
      // Apply the fort delta live so the ring thickens exactly now — even
      // for opponents / other players (state is authoritative for everyone).
      const actorTile = state.tiles.get(hexKey(actor.col, actor.row));
      if (actorTile) actorTile.fortifyLevel = Math.min(MAX_FORTIFY_LEVEL,
        (actorTile.fortifyLevel || 0) + (result.defGain ?? 1));
      // Surface the +N floater to anyone who can see the fortifying unit.
      if (!_evVisible(ev, step.entitySnapshot, postEntities)) continue;
      await _actionGate();
      const gain = result.defGain ?? 1;
      renderer.addFlash(actor.col, actor.row, `🛡+${gain}`,
        'rgba(100,180,255,0.1)', 1800, 0.72, 'rgba(130,200,255,1)');
      _presentedSinceGate = true;
    }

    // ── Phase 5: heal animation — green glow + HP floater ─────────────
    if (_stepHasAction(PlanActionType.HEAL)) ui?.highlightReplayActions?.(i, ['heal']);
    for (const ev of events) {
      const { action, result } = ev;
      if (action.type !== PlanActionType.HEAL || !result?.success) continue;
      const actor = step.entitySnapshot?.find(e => e.id === action.entityId);
      // Match the HEAL card — only animate when the healer's hex is in sight.
      if (actor && _evVisible(ev, step.entitySnapshot, postEntities)) {
        await _actionGate();
        // `healed` carries the actual (scaled) amount; the fallback covers
        // replays recorded before the field existed.
        const healed = result.healed ?? 2 * DAMAGE_SCALE;
        renderer.addNodeRevealAnim([{ col: actor.col, row: actor.row }], '#44cc66', { radiusMultiplier: 1.5, duration: 1000 });
        renderer.addHpChangeFlash(actor.col, actor.row, healed);
        _applyDisplayHp(actor.id, healed);
        _presentedSinceGate = true;
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
        await playbackDelay(_spd2 === 'vfast' ? (hadMove ? 150 : 125) : hadMove ? 300 : 250);
      }
    } else if (events.length > 0 && !_autoplay) {
      // Non-visual actions (fortify, use_item, etc.) — brief pause so resolution feels deliberate.
      const _spd3 = ui?.speedMode ?? 'cinematic';
      await playbackDelay(_spd3 === 'vfast' ? 75 : 150);
    }

    // The step has fully played out — settle its animations, THEN reveal the
    // dice rolls + outcomes together (hidden until now). NEXT/Redo halts instead.
    if (!_autoplay) await _settleAnims();
    ui?.revealReplayOutcome?.(i);

    // ── Mid-replay conversation interleaving (campaign only) ────────────────
    // Probe area/condition conversation triggers against the post-step entity
    // positions so a conversation plays at the exact step it was earned, as an
    // inserted turn card. The step loop blocks here while the conversation
    // owns the shared NEXT/pause flags; onComplete scripted actions are
    // deferred to the end of the round (state holds display snapshots now).
    // Live resolution only — full PLAYBACK replays a deserialized copy.
    if (_activeMissionDef?.storyTriggers && _activeCampaign
        && !_autoplay && !ui?._replayOnControl
        && !playback.goBack && !playback.aborted && !playback.jumpToEnd && !playback.restart) {
      const convEvents = processStoryTriggers(
        state, _activeMissionDef.storyTriggers, _activeCampaign.storyFlags,
        { only: 'conversation' },
      );
      for (const ev of convEvents) {
        await _playMissionConversation(ev.conversation, { manageHud: false, runOnComplete: false });
      }
    }

    // Mission-logic Show events this TURN triggered (docs/09) — e.g. an Area
    // trigger the unit just stepped onto. The Sim already ran inside resolvePlans;
    // here we present each one at the moment in the replay it fired: a story beat
    // as an inserted turn CARD (not a modal), a conversation as its own card.
    // Skipped on abort / skip-to-end.
    let beatGated = false;
    if (step.logicEvents?.length
        && !playback.aborted && !playback.goBack && !playback.jumpToEnd) {
      beatGated = await _presentStepLogicEvents(step.logicEvents, step.stepIndex);
    }

    // Manual-step gate: in paused mode, hold at this step boundary until NEXT
    // (or PLAY). For inline replay this also gates the final step, so the round
    // summary only appears after a NEXT. For full-game replay the round loop
    // owns the between-round boundary, so we don't double-gate its last step.
    // Only gate on steps that actually rendered a card — fogged/empty steps
    // have no card, so they shouldn't cost the player a NEXT click. In full-game
    // replay the round loop owns the boundary after the last visible step, so we
    // don't double-gate it there.
    // A story-beat card already gated this step on NEXT (its own card), so don't
    // make the player click NEXT a second time at the manual-step gate below.
    const stepHasCard = stepDigest?.[i]?.entries?.length > 0;
    if (!_autoplay && ui && stepHasCard && !beatGated) {
      const fullMode = !!ui._replayOnControl;
      const laterHasCard = stepDigest.slice(i + 1).some(c => c.entries.length > 0);
      if (!(fullMode && !laterHasCard)) {
        // Step finished animating — prompt the player to press NEXT.
        if (playback.paused) ui.setReplayNextReady?.(true);
        while (playback.paused && !playback.stepRequested && !playback.replayStep
               && !playback.restart && !playback.aborted && !playback.goBack && !playback.jumpToEnd) {
          await new Promise(r => setTimeout(r, 50));
        }
        ui.setReplayNextReady?.(false);
        if (!playback.replayStep) playback.stepRequested = false;
      }
    }

    // Redo: replay the CURRENT step from its start. Re-hide its rolls/outcome so
    // they reveal again at the end of the re-run.
    if (playback.replayStep) {
      playback.replayStep = false;
      renderer.clearAnimations?.();
      ui?.hideReplayOutcome?.(i);
      i -= 1;   // the loop's i++ brings us back to this step
    }
  }

  // RELEASE the held 3D combat frame (Phase 1): if the LAST presented step was
  // a battle (or guard strike) and nothing reframed the camera before the
  // SUMMARY transition, pull back to this player's surviving units so the
  // resolution doesn't end clamped on a single skirmish.
  if (_heldCombatFrame3D && renderer?.is3D && !_autoplay
      && !playback.goBack && !playback.aborted && !playback.jumpToEnd) {
    const mine = (finalEntities || [])
      .filter(e => e && e.alive && e.col != null && (
        myPlayerId ? e.ownerId === myPlayerId
                   : (!humanFaction || e.owner === humanFaction)
      ))
      .map(e => ({ col: e.col, row: e.row }));
    if (mine.length) {
      renderer.frameHexes(mine, { paddingHexes: 3, maxZoom: 1.8, duration: 400 });
    } else {
      renderer.frameHexes(
        (finalEntities || []).filter(e => e && e.alive && e.col != null).map(e => ({ col: e.col, row: e.row })),
        { paddingHexes: 3, maxZoom: 1.8, duration: 400 },
      );
    }
    _heldCombatFrame3D = false;
  }

  // Wait for any in-flight canvas animations (node reveals, flashes, etc.)
  // to finish before showing the end-of-turn summary dialog.
  if (!_autoplay && !playback.goBack && !playback.aborted && !playback.jumpToEnd) {
    await renderer.waitForAnimations();
  }

  // Restore the authoritative final state.
  state.entities = finalEntities;
  // Restore post-resolution fortifyLevel values on every tile that was
  // rewound at the start of the animation (covers skipped/aborted playbacks
  // where some step deltas may not have been re-applied live).
  for (const [k, v] of postFortMap) {
    const t = state.tiles.get(k);
    if (t && t.fortifyLevel !== v) t.fortifyLevel = v;
  }
  // Deferred mid-replay conversation actions — now that the authoritative
  // entities are back, the scripted moves/despawns stick. These mutate real
  // game state, so they run even on a skipped/aborted replay (instantly).
  for (const { convDef, skipped } of _pendingConvActions.splice(0)) {
    await runScriptedActions(convDef.onComplete, {
      state, renderer, redraw: redrawFn,
      npcDefs: _activeMissionDef?.npcs ?? [],
      instant: skipped || playback.jumpToEnd || playback.aborted || playback.goBack || _autoplay,
    });
  }
  // Skip the final redraw during replay navigation (caller will render the target preState).
  if (!playback.goBack && !playback.aborted && !playback.jumpToEnd) {
    redrawFn();
  }
  // Inline replay cleanup: hide the SKIP HUD and clear jumpToEnd so the
  // next animation doesn't inherit the flag and auto-skip. Only do this
  // in the inline case — full PLAYBACK's outer loop (src/playback.js)
  // relies on jumpToEnd persisting across the animation call to route
  // the viewer to the end-of-replay hold screen.
  // On a Redo, keep the bar up — the caller immediately re-animates the turn.
  if (skipHudActive && !playback.restart) {
    ui?.hideInlineReplayHUD?.();
    playback.jumpToEnd = false;
    playback.paused = false;          // clear the manual-step hold for next time
    playback.stepRequested = false;
  }
  // Hide the timeline overlay (rebuilt fresh on the next round's animation),
  // unless the caller is keeping it up for the end-of-turn review.
  if (!_keepTimelineForReview) ui?.hideReplayTimeline?.();
  // Mode transition is caller's responsibility
}


// ── Online game init ──────────────────────────────────────────────────────────

let mp = null; // MultiplayerClient instance

// Tell the server when the app is backgrounded so it can send push notifications
// instead of assuming an open WebSocket means the player is paying attention.
onInactiveChange((inactive) => {
  if (!mp) return;
  if (inactive) {
    if (mp.connected) mp.setInactive(true);
  } else {
    if (mp.connected) {
      mp.setInactive(false);
      // Re-assert room focus so presence shows active
      if (mp.roomId) mp._send({ type: 'setRoom', roomId: mp.roomId });
    } else if (mp.active) {
      // Socket died while backgrounded — reconnect
      mp.reconnectNow();
    }
  }
});

// Battle countdown timer (in-game)
let _battleCountdownTimer = null;
function _updateBattleCountdown() {
  const el = document.getElementById('battle-countdown');
  if (!el) return;
  if (!state || state.gameMode !== 'battle' || !state.battleConfig?.endsAt) {
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
  el.textContent = 'Battle ends in ' + _formatTimeRemaining(state.battleConfig.endsAt);
}
function _startBattleCountdownTimer() {
  if (_battleCountdownTimer) clearInterval(_battleCountdownTimer);
  _updateBattleCountdown();
  _battleCountdownTimer = setInterval(_updateBattleCountdown, 60_000);
}
function _stopBattleCountdownTimer() {
  if (_battleCountdownTimer) { clearInterval(_battleCountdownTimer); _battleCountdownTimer = null; }
  const el = document.getElementById('battle-countdown');
  if (el) el.style.display = 'none';
}

function initOnline(mirrorState, myFaction, mpClient) {
  setMode(AppMode.PLANNING);
  state    = mirrorState;
  const canvas = document.getElementById('game-canvas');

  document.getElementById('setup-screen').style.display = 'none';
  document.getElementById('game-screen').style.display  = 'flex';

  if (ui) ui.destroy();

  renderer = new (_pickRenderer())(canvas, state);
  renderer.resize();
  renderer.onImagesLoaded = () => { if (ui) ui._renderTurnInfo(); };
  // Loading overlay + progress bar; reveals the canvas when assets are ready.
  _showLoadingAndReveal(renderer);

  // No local AI — all turns handled server-side
  ui = new UIController(canvas, state, renderer, null, redrawOnline, null, false);
  ui.onQuitToMenu = () => location.reload();
  ui.onResignGame = () => _showResignConfirmation(mpClient);
  ui.onReplayLastTurn = () => {
    if (!_asyncLastRound) return;
    _asyncWatchLastTurn(_asyncLastRound);
  };

  // Show resign option for online games
  const resignBtn = document.getElementById('menu-resign-btn');
  if (resignBtn) resignBtn.style.display = '';

  ui.mp         = mpClient;
  ui.myPlayerId = mpClient.myPlayerId ?? null;
  ui._isAsync   = mpClient.isAsync ?? false;
  ui._players   = (state.players ?? []).map(p => ({ ...p, playerId: p.playerId ?? p.id }));

  // Start battle countdown if in battle mode
  if (state.gameMode === 'battle') _startBattleCountdownTimer();

  // Planning mode entry is handled by the gameJoined handler — it has the
  // correct budget, deadline, and replay data. Don't enter planning here.

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

// ── UI click sounds ───────────────────────────────────────────────────────────
// Every button press and menu selection ticks. Delegated in the capture phase
// so handlers that stopPropagation can't silence it; the same first gesture
// also unlocks the AudioContext (audio.init).

audio.init();
document.addEventListener('click', (e) => {
  if (e.target?.closest?.('button, select, [role="button"]')) audio.play('click');
}, { capture: true, passive: true });
document.addEventListener('change', (e) => {
  if (e.target?.closest?.('select')) audio.play('click');
}, { capture: true, passive: true });

// ── Setup screen ──────────────────────────────────────────────────────────────

const stepMode         = document.getElementById('setup-step-mode');
const stepSinglePlayer = document.getElementById('setup-step-singleplayer');
const stepCampaignSelect = document.getElementById('setup-step-campaign-select');
const stepCampaignSlot = document.getElementById('setup-step-campaign-slot');
const stepCampaignProgress = document.getElementById('setup-step-campaign-progress');
const stepCampaign     = document.getElementById('setup-step-campaign');
const stepDebrief      = document.getElementById('setup-step-debrief');
const stepBattle       = document.getElementById('setup-step-battle');
const stepOnline       = document.getElementById('setup-step-online');
const stepAsync        = document.getElementById('setup-step-async');
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
  // Refresh or tear down the main-menu games list depending on whether we're
  // entering or leaving the mode card.
  if (step === 'mode') {
    // Fire-and-forget — each function handles its own loading/empty states.
    try { _fetchMainMenuGames?.(); } catch {}
    try { _renderReplaysList?.(); } catch {}
  } else {
    _stopMmCountdown?.();
  }

  stepMode          .style.display = step === 'mode'            ? '' : 'none';
  stepSinglePlayer  .style.display = step === 'singleplayer'    ? '' : 'none';
  stepCampaignSelect.style.display = step === 'campaign-select' ? '' : 'none';
  if (stepCampaignSlot) stepCampaignSlot.style.display = step === 'campaign-slot' ? '' : 'none';
  if (stepCampaignProgress) stepCampaignProgress.style.display = step === 'campaign-progress' ? '' : 'none';
  stepCampaign      .style.display = step === 'campaign'        ? '' : 'none';
  stepDebrief       .style.display = step === 'debrief'         ? '' : 'none';
  if (stepBattle) stepBattle.style.display = step === 'battle' ? '' : 'none';
  stepOnline        .style.display = step === 'online'          ? '' : 'none';
  stepAsync         .style.display = step === 'async'           ? '' : 'none';
  stepChangelog     .style.display = step === 'changelog'       ? '' : 'none';
  stepAccount       .style.display = step === 'account'         ? '' : 'none';
  stepWaiting       .style.display = step === 'waiting'         ? '' : 'none';
  stepCreateGame    .style.display = step === 'create-game'     ? '' : 'none';
  stepJoinGame      .style.display = step === 'join-game'       ? '' : 'none';
  stepLobby         .style.display = step === 'lobby'           ? '' : 'none';
  stepAsyncCreate   .style.display = step === 'async-create'    ? '' : 'none';
  stepAsyncCreated  .style.display = step === 'async-created'   ? '' : 'none';
  stepAsyncJoin     .style.display = step === 'async-join'      ? '' : 'none';

  // Move the session bar into the active card so it sits at its bottom
  const _stepEl = {
    'mode': stepMode, 'singleplayer': stepSinglePlayer,
    'campaign-select': stepCampaignSelect, 'campaign-slot': stepCampaignSlot,
    'campaign-progress': stepCampaignProgress, 'campaign': stepCampaign, 'debrief': stepDebrief,
    'online': stepOnline, 'async': stepAsync,
    'changelog': stepChangelog, 'account': stepAccount, 'waiting': stepWaiting,
    'create-game': stepCreateGame, 'join-game': stepJoinGame, 'lobby': stepLobby,
    'async-create': stepAsyncCreate, 'async-created': stepAsyncCreated, 'async-join': stepAsyncJoin,
  }[step];
  const sessionBar = document.getElementById('setup-session-bar');
  if (_stepEl && sessionBar) _stepEl.appendChild(sessionBar);
}

// Whether the user is currently on a sub-screen of the live online or async
// flow. Server errors that arrive on these screens should reset the user back
// to the top-level online/async menu; on any other menu (mode, account,
// changelog, etc.) we leave the user where they are so a silent reconnect
// doesn't kick them out of the menu they were browsing.
function _isOnOnlineFlow() {
  return stepOnline.style.display !== 'none' ||
         stepLobby.style.display !== 'none' ||
         stepCreateGame.style.display !== 'none' ||
         stepJoinGame.style.display !== 'none' ||
         stepWaiting.style.display !== 'none';
}
function _isOnAsyncFlow() {
  return stepAsync.style.display !== 'none' ||
         stepAsyncCreate.style.display !== 'none' ||
         stepAsyncCreated.style.display !== 'none' ||
         stepAsyncJoin.style.display !== 'none';
}

// Current lobby state (pre-game)
let _currentLobby = null;

// ── Welcome screen buttons ────────────────────────────────────────────────────

// Main-menu mode buttons (flattened from the former New Game submenu — they now
// live directly on the welcome card between Active Games and Replays).
document.getElementById('btn-ng-battle')  ?.addEventListener('click', () => _showBattleScreen());
document.getElementById('btn-ng-campaign')?.addEventListener('click', () => {
  // Skip the chapter picker entirely — only Chapter 1 ships, so route the
  // "Campaign" choice straight to its save-slot picker. Chapters 2–4 remain in
  // the registry (disabled) but the chapter-select screen is no longer surfaced.
  const ch1 = getCampaignById('calebs_hollow_prologue');
  if (ch1) _showCampaignSlotScreen(ch1);
  else _showCampaignSelectScreen(); // defensive fallback
});
document.getElementById('btn-ng-vsai')    ?.addEventListener('click', () => _showSinglePlayerScreen());
document.getElementById('btn-ng-online')  ?.addEventListener('click', () => _showOnlineScreen());

document.getElementById('setup-session-name').addEventListener('click', () => { _initAccountPage(); showStep('account'); });
document.getElementById('btn-account-back') .addEventListener('click', () => showStep('mode'));
document.getElementById('btn-changelog-back').addEventListener('click', () => showStep('mode'));
document.getElementById('reconnect-back').addEventListener('click', () => location.reload());

// Initialize persistent session bar on page load
_updateSessionBar();
{
  const sessionBar = document.getElementById('setup-session-bar');
  if (sessionBar) stepMode.appendChild(sessionBar);
}

// On iOS, attempt Game Center auth on launch and use it as the primary identity.
// If GC auth succeeds, connect to the server and authenticate as the GC account,
// replacing any saved session so the push token is linked to the right player.
// The promise is stored so _showAuthDialog can await it instead of racing.
let _gcAuthPromise = null;
if (isNativeMobile) {
  _gcAuthPromise = tryGameCenterAuth().then(gc => {
    if (!gc) return null;
    _gcCredentials = gc;

    // Connect and auth with the server immediately so the session is correct
    const wsUrl = _serverWsUrl();
    if (!mp) {
      mp = _createMpClient();
      mp.connect(wsUrl);
    } else if (!mp.connected) {
      mp.connect(wsUrl);
    }

    return new Promise(resolve => {
      mp._opts._onAuthOk = () => {
        _updateSessionBar();
        resolve(gc);
      };
      mp.authGameCenter({
        gameCenterId: gc.playerId,
        displayName: gc.displayName,
      });
    });
  });
}

// Show admin link for admin users
{
  const _s = loadSession();
  if (_s?.is_admin) {
    const _adminLink = document.getElementById('admin-link');
    if (_adminLink) {
      _adminLink.style.display = '';
    }
  }
}

// AI debug panel collapse toggle
{
  const _collapseBtn = document.getElementById('ai-debug-collapse');
  if (_collapseBtn) {
    _collapseBtn.addEventListener('click', () => {
      const panel = document.getElementById('ai-debug-panel');
      if (panel) {
        panel.classList.toggle('collapsed');
        _collapseBtn.textContent = panel.classList.contains('collapsed') ? '\u25B6' : '\u25C0';
        const wrapper = document.getElementById('canvas-wrapper');
        if (wrapper) wrapper.classList.toggle('ai-debug-open', !panel.classList.contains('collapsed'));
        if (renderer) {
          renderer.insetLeft = panel.classList.contains('collapsed') ? 0 : 260;
          redraw();
        }
      }
    });
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

// ── Electron desktop app integration ─────────────────────────────────────────
// Wires up server settings UI and auto-update notifications when running inside
// the Electron shell.  Entirely inert when loaded in a regular browser.

if (window.electronAPI) {
  // Show the server settings panel and hide the "no options" message
  const settingsPanel = document.getElementById('electron-server-settings');
  const emptyMsg      = document.getElementById('options-empty-msg');
  if (settingsPanel) settingsPanel.style.display = '';
  if (emptyMsg)      emptyMsg.style.display = 'none';

  const urlInput     = document.getElementById('electron-server-url');
  const saveBtn      = document.getElementById('btn-server-save');
  const testBtn      = document.getElementById('btn-server-test');
  const statusSpan   = document.getElementById('server-status');
  const versionLabel = document.getElementById('electron-app-version');

  // Load current server URL into the input
  window.electronAPI.getServerUrl().then(url => {
    if (urlInput) urlInput.value = url || '';
  });

  // Show app version
  window.electronAPI.getVersion().then(ver => {
    if (versionLabel) versionLabel.textContent = `v${ver}`;
  });

  // Save server URL
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const url = urlInput?.value.trim() || '';
      await window.electronAPI.setServerUrl(url);
      if (statusSpan) {
        statusSpan.textContent = 'Saved. Restart the app to apply.';
        statusSpan.style.color = 'var(--accent, #c9a227)';
      }
    });
  }

  // Test connection
  if (testBtn) {
    testBtn.addEventListener('click', async () => {
      const url = urlInput?.value.trim();
      if (!url) {
        if (statusSpan) { statusSpan.textContent = 'Enter a URL first.'; statusSpan.style.color = '#c44'; }
        return;
      }
      if (statusSpan) { statusSpan.textContent = 'Testing...'; statusSpan.style.color = 'var(--muted, #888)'; }
      try {
        const res = await fetch(`${url.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(5000) });
        const data = await res.json();
        if (data.status === 'ok') {
          statusSpan.textContent = `Connected — v${data.version}`;
          statusSpan.style.color = '#4c4';
        } else {
          statusSpan.textContent = 'Unexpected response.';
          statusSpan.style.color = '#c44';
        }
      } catch (err) {
        if (statusSpan) {
          statusSpan.textContent = `Failed: ${err.message}`;
          statusSpan.style.color = '#c44';
        }
      }
    });
  }

  // Auto-update notifications
  const updateBar = document.getElementById('electron-update-bar');
  const updateMsg = document.getElementById('electron-update-msg');

  updateBar?.addEventListener('click', () => {
    window.electronAPI?.restartAndUpdate();
  });

  window.electronAPI.onUpdateAvailable((ver) => {
    if (updateBar && updateMsg) {
      updateMsg.textContent = `Downloading update v${ver}...`;
      updateBar.style.display = '';
      updateBar.style.cursor = 'default';
      updateBar.querySelector('b').style.display = 'none';
    }
  });

  window.electronAPI.onUpdateDownloaded((ver) => {
    if (updateBar && updateMsg) {
      updateMsg.textContent = `Update v${ver} ready.`;
      updateBar.style.display = '';
      updateBar.style.cursor = 'pointer';
      const bold = updateBar.querySelector('b');
      if (bold) bold.style.display = '';
    }
  });
}

// ── Single Player screen ───────────────────────────────────────────────────────

function _showSinglePlayerScreen() {
  showStep('singleplayer');
  _renderSpSaves();
}

document.getElementById('btn-singleplayer-back').addEventListener('click', () => {
  renderer = null; ui = null; state = null;
  showStep('mode');
});

// ── Campaign / Story Mode ─────────────────────────────────────────────────────

let _activeCampaign  = null;  // Campaign instance (persists across missions)
let _activeMissionDef = null; // Current mission definition
let _campaignSelectedMission = null; // Mission ID selected on campaign screen
let _campaignUnlocked = false; // Admin: bypass mission prerequisites
let _activeRosterIndices = []; // Indices into _activeCampaign.roster that are "active" (will deploy)
let _progressPane = 'party';   // Campaign Progress mobile pane toggle: 'party' | 'missions'

// ── Campaign mid-mission save/resume ──────────────────────────────────────────


function _saveCampaignMission() {
  if (!_activeCampaign || !_activeMissionDef || !state) return;
  const key = campaignMissionSaveKey(_activeCampaign.campaignDef.id, _activeMissionDef.id, _activeCampaign.slotIndex);
  const data = {
    campaignId:     _activeCampaign.campaignDef.id,
    saveSlot:       _activeCampaign.saveSlot,
    slotIndex:      _activeCampaign.slotIndex,
    missionId:      _activeMissionDef.id,
    state:          serializeState(state),
    roundHistory:   _roundHistory,
    updatedAt:      Date.now(),
  };
  try { localStorage.setItem(key, JSON.stringify(data)); } catch {}
}


function _resumeCampaignMission(missionId) {
  const slot = _activeCampaign.slotIndex;
  const save = loadCampaignMissionSave(_activeCampaign.campaignDef.id, missionId, slot);
  if (!save) return;

  const missionDef = _activeCampaign.getMissionDef(missionId);
  if (!missionDef) return;

  // Sanity guard — if the mission's hasWitch shape changed since the save was
  // written (e.g. M5 flipped from no-witch to witch in the mission-5-7 rework)
  // the saved state has no witch entity and resume would silently desync from
  // the new mission def. Discard the save and force a fresh start.
  const savedNoWitch = !!save.state?.noWitchMission;
  const expectedNoWitch = !missionDef.hasWitch;
  if (savedNoWitch !== expectedNoWitch) {
    deleteCampaignMissionSave(_activeCampaign.campaignDef.id, missionId, slot);
    return;   // caller's flow will fall through to a fresh _initCampaignMission
  }

  _activeMissionDef = missionDef;
  _gameStartTime = Date.now();
  _spSaveId = null;

  const existingState = deserializeState(save.state);
  // Resuming a campaign mission — ensure the XP/veterancy gate is on even for
  // saves written before isCampaign was serialized.
  existingState.isCampaign = true;
  _roundHistory = save.roundHistory || [];

  // Reconstruct campaign-specific state
  existingState.victoryDelegate = missionDef.objectives ? buildVictoryDelegate(missionDef.objectives) : null;
  if (missionDef.waves) {
    existingState._waveProcessor = () =>
      processWaves(existingState, missionDef.waves, _createEnemyEntity);
  }
  // Re-attach the mission logic engine on resume — _attachMissionLogic feeds the
  // restored runtime state (state._restoredLogicState) back into engine.load().
  if (missionDef.logic) _attachMissionLogic(existingState, missionDef);
  existingState.fogOfWar = existingState.fogOfWar || 'partial';
  if (missionDef.lootOverrides) existingState.lootOverrides = missionDef.lootOverrides;
  if (missionDef.aiBudgetBonus) existingState.campaignAIBudgetBonus = missionDef.aiBudgetBonus;

  // Hide setup, show game
  document.getElementById('setup-screen').style.display = 'none';
  document.getElementById('game-screen').style.display = 'flex';
  const canvas = document.getElementById('game-canvas');

  state = existingState;

  // Set up AI with correct personality
  const AIClass = WITCH_PERSONALITIES[missionDef.aiPersonality] ?? WitchAIEngine;
  witchAI = new AIClass(state, redraw);
  heroAI = null;

  _setupLocalUI(canvas, witchAI, null, false);

  // Hide chronicle by default for story mode
  ui._setChronicleOpen(false);

  // Wire mission info button
  ui.showMissionInfoBtn(true);
  ui.onMissionInfo = () => _showMissionInfoModal();

  // Re-wire micro-lesson hints (round/`when`-anchored, so a resumed game only
  // shows hints still relevant to the current round)
  _setupMissionHints(missionDef);

  redraw();
  _enterGameView();
  _startLocalPlanningPhase();
}

function _showCampaignSelectScreen() {
  const listEl = document.getElementById('campaign-select-list');
  listEl.innerHTML = CAMPAIGNS.map(c => {
    const disabled = c.disabled === true;
    const progress = disabled ? { status: 'new', completed: 0, total: 0 }
                              : Campaign.getAggregateProgress(c);
    const locked = disabled || (c.prerequisiteCampaign
      ? !Campaign.isCampaignCompleted(getCampaignById(c.prerequisiteCampaign))
      : false);
    // Status class is applied when the campaign is playable and has progress.
    const statusClass = (!disabled && !locked && progress.status !== 'new')
      ? ` status-${progress.status}`
      : '';
    const cls = `campaign-select-item${disabled ? ' disabled' : locked ? ' locked' : ''}${statusClass}`;
    const titlePrefix = disabled ? '' : locked ? '🔒 ' : '';
    let statusBadge = '';
    if (disabled) {
      statusBadge = '<div class="campaign-select-badge coming-soon">Coming Soon</div>';
    } else if (locked) {
      statusBadge = '<div class="campaign-select-badge locked-badge">Complete the previous chapter to unlock</div>';
    } else if (progress.status === 'completed') {
      statusBadge = '<div class="campaign-select-badge completed">✓ Completed</div>';
    } else if (progress.status === 'in-progress') {
      const progressText = progress.total > 0
        ? `In Progress — ${progress.completed}/${progress.total} missions`
        : 'In Progress';
      statusBadge = `<div class="campaign-select-badge in-progress">${progressText}</div>`;
    } else {
      statusBadge = '<div class="campaign-select-badge new">New</div>';
    }
    return `<div class="${cls}" data-campaign="${c.id}">
      <div class="campaign-select-title">${titlePrefix}${c.title}</div>
      <div class="campaign-select-desc">${c.description}</div>
      ${statusBadge}
    </div>`;
  }).join('');

  listEl.querySelectorAll('.campaign-select-item:not(.locked):not(.disabled)').forEach(el => {
    el.addEventListener('click', () => {
      const def = getCampaignById(el.dataset.campaign);
      if (def) _showCampaignSlotScreen(def);
    });
  });

  showStep('campaign-select');
}

// ── Save-slot picker ──────────────────────────────────────────────────────────
// Opens after a chapter is chosen, before the mission list. Lets the player
// keep several independent playthroughs of the same campaign (e.g. restart
// Chapter 1 in slot 2 while slot 1 sits mid-campaign).
let _slotPickerCampaignDef = null;

function _showCampaignSlotScreen(campaignDef) {
  _slotPickerCampaignDef = campaignDef;
  const titleEl = document.getElementById('campaign-slot-title');
  if (titleEl) titleEl.textContent = campaignDef.title;
  _renderCampaignSlotList();
  showStep('campaign-slot');
}

function _renderCampaignSlotList() {
  const campaignDef = _slotPickerCampaignDef;
  const listEl = document.getElementById('campaign-slot-list');
  if (!campaignDef || !listEl) return;

  let html = '';
  for (let slot = 1; slot <= CAMPAIGN_SLOT_COUNT; slot++) {
    const info = Campaign.getSlotSummary(campaignDef, slot);
    if (info.used) {
      const when = _timeAgo(Math.floor((info.updatedAt ?? Date.now()) / 1000));
      const progress = info.total > 0 ? ` · ${info.completed}/${info.total} missions` : '';
      html += `<div class="campaign-slot-item used" data-slot="${slot}">
        <div class="campaign-slot-info">
          <div class="campaign-slot-name">Slot ${slot} — ${info.currentMissionTitle}</div>
          <div class="campaign-slot-meta">Updated ${when}${progress}</div>
        </div>
        <div class="campaign-slot-actions">
          <button class="setup-btn primary campaign-slot-continue" data-slot="${slot}">Continue</button>
          <button class="setup-btn campaign-slot-delete" data-slot="${slot}" title="Delete this slot">✕</button>
        </div>
      </div>`;
    } else {
      html += `<div class="campaign-slot-item empty" data-slot="${slot}">
        <div class="campaign-slot-info">
          <div class="campaign-slot-name">Slot ${slot}</div>
          <div class="campaign-slot-meta">Empty</div>
        </div>
        <div class="campaign-slot-actions">
          <button class="setup-btn primary campaign-slot-new" data-slot="${slot}">New Game</button>
        </div>
      </div>`;
    }
  }
  listEl.innerHTML = html;

  listEl.querySelectorAll('.campaign-slot-new').forEach(btn => {
    btn.addEventListener('click', () => {
      const slot = parseInt(btn.dataset.slot, 10);
      // Claim the slot with a fresh progress blob so it reads as "in use".
      new Campaign(campaignDef, slot).save();
      _showCampaignScreen(campaignDef, undefined, slot);
    });
  });
  listEl.querySelectorAll('.campaign-slot-continue').forEach(btn => {
    btn.addEventListener('click', () => {
      _showCampaignScreen(campaignDef, undefined, parseInt(btn.dataset.slot, 10));
    });
  });
  listEl.querySelectorAll('.campaign-slot-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const slot = parseInt(btn.dataset.slot, 10);
      if (!confirm(`Delete Slot ${slot}? All progress, roster survivors, and resources in this slot will be lost. This cannot be undone.`)) return;
      new Campaign(campaignDef, slot).delete();
      for (const m of campaignDef.missions || []) {
        deleteCampaignMissionSave(campaignDef.id, m.id, slot);
      }
      _renderCampaignSlotList();
    });
  });
}

async function _showCampaignScreen(campaignDef, autoMissionId, slotIndex = 1) {
  if (campaignDef) {
    _activeCampaign = new Campaign(campaignDef, slotIndex);
    _activeCampaign.load();
  }
  await _loadCampaignPortraits();

  // Direct-to-briefing paths bypass the Progress landing entirely:
  //  • autoMissionId — "resume next mission" from the main-menu game list
  //  • single-mission campaigns — no list to land on
  if (autoMissionId) {
    showStep('campaign');
    _campaignSelectedMission = autoMissionId;
    _showMissionBriefing(autoMissionId);
    return;
  }
  if (_activeCampaign?.campaignDef?.missions?.length === 1) {
    showStep('campaign');
    const missionId = _activeCampaign.campaignDef.missions[0].id;
    _campaignSelectedMission = missionId;
    _showMissionBriefing(missionId);
    return;
  }

  // Default between-mission landing → the Campaign Progress screen.
  _seedActiveRosterForProgress();
  _progressPane = 'party';
  _renderCampaignProgressScreen();
  showStep('campaign-progress');
}

// ── Campaign Progress screen ────────────────────────────────────────────────
// The between-mission landing: party (left) + mission list (right), with a
// mobile ←/→ pane toggle. Replaces the old per-campaign mission-list view
// (_renderCampaignScreen) for this purpose; the briefing screen it routes into
// is unchanged.

/**
 * Active-squad cap for the Progress screen. The menu is a loadout-management
 * screen, so the whole roster is pickable here — the per-mission cap
 * (maxSurvivorsFromRoster) is applied later in the mission start dialog
 * (_showMissionBriefing / _renderDeployRoster), not on this screen.
 */
function _progressMaxActive() {
  return _progressSquadCap(_activeCampaign?.roster);
}

/** Front-fill the active squad to the cap (called on fresh entry, not re-renders). */
function _seedActiveRosterForProgress() {
  if (!_activeCampaign) { _activeRosterIndices = []; return; }
  const maxActive = _progressMaxActive();
  _activeRosterIndices = _activeCampaign.roster.map((_, i) => i).slice(0, maxActive);
}

function _renderCampaignProgressScreen() {
  if (!_activeCampaign) return;
  const campaignDef = _activeCampaign.campaignDef;
  const titleEl = document.getElementById('campaign-progress-title');
  if (titleEl) titleEl.textContent = campaignDef.title;

  const maxActive = _progressMaxActive();
  // Drop any stale/out-of-range indices, then clamp to the current cap.
  _activeRosterIndices = _activeRosterIndices
    .filter(i => i >= 0 && i < _activeCampaign.roster.length)
    .slice(0, maxActive);

  // Party pane.
  const partyEl = document.getElementById('campaign-progress-party');
  if (partyEl) {
    partyEl.innerHTML = _partyPaneHTML(
      _activeCampaign.heroStats, _activeCampaign.roster,
      _activeRosterIndices, maxActive,
      { resources: _activeCampaign.resources, weapons: _activeCampaign.weapons },
    );
  }

  // Mission pane.
  const missionsEl = document.getElementById('campaign-progress-missions');
  if (missionsEl) {
    const rows = _missionRows(_activeCampaign, _campaignUnlocked);
    missionsEl.innerHTML = _missionListPaneHTML(campaignDef.title, rows);
  }

  // Mobile pane visibility.
  const bodyEl = document.getElementById('campaign-progress-body');
  if (bodyEl) {
    bodyEl.classList.toggle('show-party', _progressPane === 'party');
    bodyEl.classList.toggle('show-missions', _progressPane === 'missions');
  }
  document.querySelectorAll('.cprog-toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.pane === _progressPane);
  });
  document.querySelectorAll('.cprog-dot').forEach(dot => {
    dot.classList.toggle('active', dot.dataset.pane === _progressPane);
  });

  _wireCampaignProgressHandlers();
}

function _wireCampaignProgressHandlers() {
  const maxActive = _progressMaxActive();
  const partyEl = document.getElementById('campaign-progress-party');
  const missionsEl = document.getElementById('campaign-progress-missions');

  // Promote reserve → active (respecting the cap).
  partyEl?.querySelectorAll('.cprog-promote').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      if (_activeRosterIndices.length < maxActive && !_activeRosterIndices.includes(idx)) {
        _activeRosterIndices.push(idx);
        _renderCampaignProgressScreen();
      }
    });
  });
  // Demote active → reserve.
  partyEl?.querySelectorAll('.cprog-demote').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      _activeRosterIndices = _activeRosterIndices.filter(i => i !== idx);
      _renderCampaignProgressScreen();
    });
  });
  // Heal with a herb (data-idx is a roster index or the 'leader' sentinel).
  partyEl?.querySelectorAll('.cprog-heal-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const raw = btn.dataset.idx;
      const target = raw === 'leader' ? 'leader' : parseInt(raw, 10);
      const newHp = _activeCampaign.healUnitWithHerb(target);
      if (newHp != null) _renderCampaignProgressScreen();
    });
  });
  // Equip a carried weapon (data-idx is a roster index or the 'leader'
  // sentinel; data-weapon is the weapon id to equip). Persists via the
  // Campaign helper's save(), then re-renders so the ✓ moves.
  partyEl?.querySelectorAll('.cprog-equip-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const raw = btn.dataset.idx;
      const target = raw === 'leader' ? 'leader' : parseInt(raw, 10);
      const equipped = _activeCampaign.equipWeaponForUnit(target, btn.dataset.weapon);
      if (equipped != null) _renderCampaignProgressScreen();
    });
  });
  // Stow a carried weapon into the shared armory (unit backpack → shared pool).
  partyEl?.querySelectorAll('.cprog-return-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const raw = btn.dataset.idx;
      const target = raw === 'leader' ? 'leader' : parseInt(raw, 10);
      const stowed = _activeCampaign.returnWeaponToInventory(target, btn.dataset.weapon);
      if (stowed != null) _renderCampaignProgressScreen();
    });
  });
  // Equip a weapon from the shared armory onto a unit (shared pool → unit).
  partyEl?.querySelectorAll('.cprog-pool-equip-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const raw = btn.dataset.idx;
      const target = raw === 'leader' ? 'leader' : parseInt(raw, 10);
      const equipped = _activeCampaign.equipFromInventory(target, btn.dataset.weapon);
      if (equipped != null) _renderCampaignProgressScreen();
    });
  });
  // Unequip a unit's equipped weapon into the shared armory, with no
  // replacement (equipped slot → shared pool). Lets the operator rearrange
  // loadouts between missions.
  partyEl?.querySelectorAll('.cprog-unequip-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const raw = btn.dataset.idx;
      const target = raw === 'leader' ? 'leader' : parseInt(raw, 10);
      const res = _activeCampaign.unequipToInventory(target);
      if (res?.success) _renderCampaignProgressScreen();
    });
  });
  // Admin: add a random survivor (mirrors the old screen's testing affordance).
  partyEl?.querySelector('#btn-admin-add-survivor')?.addEventListener('click', () => {
    _activeCampaign.roster.push(snapshotSurvivor(createSurvivor(0, 0, 'hero')));
    _activeCampaign.save();
    _renderCampaignProgressScreen();
  });

  // Launch an available mission via the existing briefing path.
  missionsEl?.querySelectorAll('.cprog-mission.available').forEach(el => {
    el.addEventListener('click', () => {
      _campaignSelectedMission = el.dataset.mission;
      showStep('campaign');
      _showMissionBriefing(_campaignSelectedMission);
    });
  });
}


/**
 * Render the party view with Active/Reserve sections for mission deployment.
 * Active survivors will deploy; reserve stays behind.
 * @param {object} heroStats
 * @param {Array} roster - full campaign roster
 * @param {number} maxActive - max survivors in active group (from mission def)
 */
function _renderDeployRoster(heroStats, roster, maxActive) {
  const rosterEl = document.getElementById('campaign-roster-summary');
  const activeCount = _activeRosterIndices.length;
  const canAddMore = activeCount < maxActive;

  let html = '<div class="campaign-roster-label">Your Party</div>';

  // Paladin (Ishmael Charger) card — always active. Campaign is fixed to
  // the day-side primary faction; no stub picker in campaign mode.
  html += '<div class="campaign-party">';
  const weaponLabel = heroStats.weapon ? ` (${heroStats.weapon.name || heroStats.weapon})` : '';
  html += _campaignCardHTML('Ishmael Charger' + weaponLabel, null, 'paladin', ENTITY_COLOR[EntityType.PALADIN], heroStats.hp, heroStats.maxHp, heroStats.attack, heroStats.defense, null, true);
  html += '</div>';

  if (roster.length === 0) {
    rosterEl.innerHTML = html;
    return;
  }

  // Active section
  if (maxActive > 0) {
    html += `<div class="roster-section-label active-label">Active <span class="roster-count">${activeCount}/${maxActive}</span></div>`;
    if (_activeRosterIndices.length === 0) {
      html += '<div class="roster-empty">No survivors selected</div>';
    }
    for (const idx of _activeRosterIndices) {
      const s = roster[idx];
      if (!s) continue;
      html += _survivorCardHTML(s, idx, { label: '−', cls: 'roster-demote', title: 'Move to reserve' });
    }
  }

  // Reserve section
  const reserveIndices = roster.map((_, i) => i).filter(i => !_activeRosterIndices.includes(i));
  if (reserveIndices.length > 0 || maxActive === 0) {
    html += `<div class="roster-section-label reserve-label">Reserve</div>`;
    for (const idx of reserveIndices) {
      const s = roster[idx];
      if (!s) continue;
      const btn = maxActive > 0 && canAddMore
        ? { label: '+', cls: 'roster-promote', title: 'Move to active' }
        : null;
      html += _survivorCardHTML(s, idx, btn);
    }
  }

  // Admin: add random survivor
  html += `<button id="btn-admin-add-survivor" class="admin-btn admin-add-btn" title="Add random survivor (testing)" style="margin-top:0.3rem">+</button>`;

  rosterEl.innerHTML = html;

  // Wire +/- buttons
  rosterEl.querySelectorAll('.roster-promote').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      if (_activeRosterIndices.length < maxActive && !_activeRosterIndices.includes(idx)) {
        _activeRosterIndices.push(idx);
        _renderDeployRoster(heroStats, roster, maxActive);
      }
    });
  });
  rosterEl.querySelectorAll('.roster-demote').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      _activeRosterIndices = _activeRosterIndices.filter(i => i !== idx);
      _renderDeployRoster(heroStats, roster, maxActive);
    });
  });

  // Admin add survivor
  document.getElementById('btn-admin-add-survivor')?.addEventListener('click', () => {
    const s = createSurvivor(0, 0, 'hero');
    _activeCampaign.roster.push(snapshotSurvivor(s));
    _activeCampaign.save();
    _renderDeployRoster(heroStats, _activeCampaign.roster, maxActive);
  });
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

  // Party roster display (hero + survivors)
  rosterEl.style.display = '';
  const resEntries = Object.entries(_activeCampaign.resources).filter(([,v]) => v > 0);
  const resourcesHtml = resEntries.length
    ? `<div class="campaign-resources">${resEntries.map(([k,v]) => `<span class="cr-item"><span class="cr-icon">${_RESOURCE_ICONS[k] || ''}</span><span class="cr-count">${v}</span><span class="cr-label">${k}</span></span>`).join('')}</div>`
    : '';
  rosterEl.innerHTML =
    `<div class="campaign-roster-label">Your Party <button id="btn-admin-add-survivor" class="admin-btn admin-add-btn" title="Add random survivor (testing)">+</button></div>` +
    _campaignPartyHTML(_activeCampaign.heroStats, _activeCampaign.roster) +
    resourcesHtml;

  document.getElementById('btn-admin-add-survivor')?.addEventListener('click', () => {
    const s = createSurvivor(0, 0, 'hero');
    _activeCampaign.roster.push(snapshotSurvivor(s));
    _activeCampaign.save();
    _renderCampaignScreen();
  });

  // Mission list
  const missions = _activeCampaign.getMissionList();
  const campaignId = _activeCampaign.campaignDef.id;
  listEl.innerHTML = missions.map(m => {
    const unlocked = _campaignUnlocked || m.available;
    const cls = m.completed ? 'campaign-mission completed' : unlocked ? 'campaign-mission available' : 'campaign-mission locked';
    const icon = m.completed ? '✓' : unlocked ? '→' : '🔒';
    const hasSave = loadCampaignMissionSave(campaignId, m.id, _activeCampaign.slotIndex) !== null;
    const statusLabel = m.completed
      ? '<span class="campaign-mission-status">Complete</span>'
      : hasSave
        ? '<span class="campaign-mission-status in-progress">In Progress</span>'
        : '';
    return `<div class="${cls}" data-mission="${m.id}">
      <span class="campaign-mission-icon">${icon}</span>
      <span class="campaign-mission-name">${m.title}</span>
      ${statusLabel}
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
  const rosterEl = document.getElementById('campaign-roster-summary');

  listEl.style.display = 'none';
  navEl.style.display = 'none';
  briefEl.style.display = '';
  // The briefing's deploy roster is rendered below; ensure its host is visible.
  // (Reaching the briefing from the Progress screen bypasses _renderCampaignScreen,
  // which previously un-hid this element.)
  if (rosterEl) rosterEl.style.display = '';

  // The shared header reads "CAMPAIGN" by default; show the chapter title so the
  // briefing isn't unlabeled when entered straight from the Progress screen.
  const titleEl = document.getElementById('campaign-title');
  if (titleEl && _activeCampaign?.campaignDef) titleEl.textContent = _activeCampaign.campaignDef.title;

  document.getElementById('campaign-mission-title').textContent = missionDef.title;
  document.getElementById('campaign-mission-text').textContent = missionDef.briefing;

  // Show Resume/Restart buttons if a mid-mission save exists
  const hasMissionSave = loadCampaignMissionSave(_activeCampaign.campaignDef.id, missionId, _activeCampaign.slotIndex) !== null;
  const startBtn = document.getElementById('btn-start-mission');
  const resumeBtn = document.getElementById('btn-resume-mission');
  const restartBtn = document.getElementById('btn-restart-mission');
  if (hasMissionSave) {
    startBtn.style.display = 'none';
    resumeBtn.style.display = '';
    restartBtn.style.display = '';
  } else {
    startBtn.style.display = '';
    resumeBtn.style.display = 'none';
    restartBtn.style.display = 'none';
  }

  // Objectives — a fully logic-graph-driven mission (docs/09) has no declarative
  // objectives; its briefing text carries the goal, so fall back to a generic line.
  const objEl = document.getElementById('campaign-objectives');
  const winDesc = _objectiveDescription(missionDef.objectives?.win) || 'Complete the mission';
  const loseDesc = _objectiveDescription(missionDef.objectives?.lose) || 'The hero falls';
  objEl.innerHTML = `
    <div class="campaign-obj"><span class="campaign-obj-icon">☀</span> <strong>Victory:</strong> ${winDesc}</div>
    <div class="campaign-obj"><span class="campaign-obj-icon">💀</span> <strong>Defeat:</strong> ${loseDesc}</div>
  `;

  // Switch roster summary into Active/Reserve deploy mode.
  const maxActive = missionDef.maxSurvivorsFromRoster ?? 0;
  // Preserve a squad already chosen on the Progress screen; otherwise default to
  // front-filling the active slots. Either way clamp to this mission's cap and
  // drop any indices that fall outside the current roster.
  _activeRosterIndices = (_activeRosterIndices || [])
    .filter(i => i >= 0 && i < _activeCampaign.roster.length)
    .slice(0, maxActive);
  if (_activeRosterIndices.length === 0) {
    _activeRosterIndices = _activeCampaign.roster.map((_, i) => i).slice(0, maxActive);
  }
  _renderDeployRoster(_activeCampaign.heroStats, _activeCampaign.roster, maxActive);
}


function _showMissionInfoModal() {
  if (!_activeMissionDef) return;
  const def = _activeMissionDef;
  const winDesc = _objectiveDescription(def.objectives?.win);
  const loseObj = def.objectives?.lose;
  const loseDesc = Array.isArray(loseObj)
    ? loseObj.map(o => _objectiveDescription(o)).join('; ')
    : _objectiveDescription(loseObj);
  const text = `${def.briefing}\n\n☀ Victory: ${winDesc}\n💀 Defeat: ${loseDesc}`;
  ui.showStoryModal(def.title, text);
}

function _createEnemyEntity(type, col, row, state = null) {
  switch (type) {
    case 'zombie':     return createZombie(col, row, 'witch', state);
    case 'minion':     return createMinion(col, row, 'witch', state);
    case 'wood_golem': return createWoodGolem(col, row, 'witch', state);
    case 'iron_golem': return createIronGolem(col, row, 'witch', state);
    default:           return createMinion(col, row, 'witch', state);
  }
}

// ── Dev scenario loader (visual testing) ─────────────────────────────────────
// Boot straight into a hand-defined board — small map + unit placements + an
// optional scripted resolution — via `?scenario=<urlencoded-JSON>`, skipping the
// menu, AI, and conversations. Lets a visual change (renderer / replay) be
// verified at a specific board state without playing a whole game. Driven by
// scripts/verify/browser-harness.mjs (`loadScenario`). Definition shape:
//   {
//     cols, rows,                                  // grid (default 9×9 grass)
//     tiles: [{col,row,type:'FOREST'|'ROAD'|…, roadDirs?:['c,r',…]}],  // sparse
//     hero: {col,row}, witch: {col,row}|null,      // leader starts (witch opt.)
//     units: [{ref?, type, owner:'hero'|'witch', col, row, weapon?, level?}],
//     heroPlan/witchPlan: [{ref, move:[c,r]} | {ref, attack:'<ref>'} | {ref, guard:true} | {ref, explore:true}],
//     resolve: bool,                               // animate the scripted turn
//     fog: 'none'|'partial',                       // default 'none'
//   }
function _createScenarioUnit(type, col, row, owner, state) {
  if (owner === 'hero') {
    // createSurvivor's third param is the player UUID, not the faction —
    // recruit explicitly (same as createDiscoveryEntity) or the unit stays
    // neutral and every planned action fails with "Wrong faction."
    const s = createSurvivor(col, row, null, state);
    s.owner = 'hero';
    return s;
  }
  return _createEnemyEntity(type, col, row, state);
}

function _scenarioPlan(planDefs, byRef) {
  const out = [];
  for (const p of planDefs ?? []) {
    const actor = byRef.get(p.ref);
    if (!actor) continue;
    if (Array.isArray(p.move)) {
      out.push({ type: PlanActionType.MOVE, entityId: actor.id, toCol: p.move[0], toRow: p.move[1] });
    } else if (p.attack != null) {
      const target = byRef.get(p.attack);
      if (target) out.push({ type: PlanActionType.BATTLE_UNIT, entityId: actor.id, targetId: target.id });
    } else if (p.guard) {
      out.push({ type: PlanActionType.GUARD, entityId: actor.id });
    } else if (p.explore) {
      // Pair with a tile-level `exploreOverride` for a deterministic loot roll.
      out.push({ type: PlanActionType.EXPLORE, entityId: actor.id });
    }
  }
  return out;
}

function initScenario(def) {
  _autoplay = false;
  _roundHistory = [];
  const canvas = document.getElementById('game-canvas');
  document.getElementById('setup-screen').style.display = 'none';
  document.getElementById('game-screen').style.display  = 'flex';

  const cols = def.cols ?? 9, rows = def.rows ?? 9;
  const mapData = buildMissionMap({
    mode: 'handmade', cols, rows, mapSize: 'skirmish',
    heroStart:  def.hero  ?? { col: 1, row: 1 },
    witchStart: def.witch ?? { col: cols - 2, row: rows - 2 },
    witchObjectives: [],
    tiles: def.tiles ?? [],
  });
  // buildMissionMap doesn't derive forest/bridge blocked slots — do it here so
  // the standee re-slot and capacity gate see the trees the renderer draws.
  for (const t of mapData.tiles.values()) t.blockedSlots = deriveBlockedSlots(t);

  // `pov: 'hero'` marks the hero side human-controlled so fog-of-war has a
  // real observer (card gating + the renderer veil both key off the human
  // faction) — without it both sides are AI and fog is never applied, which
  // makes fog/replay bugs unreproducible in scenario mode.
  state = new GameState(true, def.pov !== 'hero', 'skirmish', null, { ...mapData, noWitch: !def.witch });
  state.fogOfWar = def.fog ?? 'none';

  // Visual-testing hook for the leaders (scenario `units` are witch-side or
  // unrecruited survivors): heroEffects / witchEffects pre-apply status
  // effects to the respective leader, e.g. heroEffects: ['wounded'].
  for (const ef of def.heroEffects ?? []) {
    if (typeof ef === 'string') applyEffect(state.hero, ef);
    else if (ef?.id) applyEffect(state.hero, ef.id, ef);
  }
  for (const ef of def.witchEffects ?? []) {
    if (!state.witch) break;
    if (typeof ef === 'string') applyEffect(state.witch, ef);
    else if (ef?.id) applyEffect(state.witch, ef.id, ef);
  }

  // ref → entity map for plan targeting (leaders are pre-registered).
  const byRef = new Map([['hero', state.hero]]);
  if (state.witch) byRef.set('witch', state.witch);
  for (const u of def.units ?? []) {
    const e = _createScenarioUnit(u.type, u.col, u.row, u.owner ?? 'witch', state);
    if (!e) continue;
    if (u.weapon) e.equipWeapon(u.weapon);
    if (u.level && u.level > 1) applyLevel(e, u.level);
    // Visual-testing hook: pre-apply status effects, e.g. effects:['wounded']
    // or [{ id:'poisoned', duration:2 }].
    for (const ef of u.effects ?? []) {
      if (typeof ef === 'string') applyEffect(e, ef);
      else if (ef?.id) applyEffect(e, ef.id, ef);
    }
    state.entities.push(e);
    assignSlotOnTile(state, e);
    if (u.ref) byRef.set(u.ref, e);
  }

  _setupLocalUI(canvas, null, null, false);  // also drives the loading reveal
  redraw();

  // Dev-loader probe: the browser-verification harness inspects live state
  // (entities, effects, HP) through this handle. Scenario mode only.
  if (typeof window !== 'undefined') window.__scenarioState = state;

  if (def.resolve) {
    state.heroPlan  = _scenarioPlan(def.heroPlan, byRef);
    state.witchPlan = _scenarioPlan(def.witchPlan, byRef);
    // Let the reveal settle, then animate the scripted turn. `summary: true`
    // keeps the end-of-round review (wrap-up card) instead of skipping it —
    // for verifying the wrap-up presentation itself.
    setTimeout(() => {
      _runLocalResolution(!def.summary).catch(e => console.error('scenario resolve error:', e));
    }, 900);
  }
}


/**
 * Build + attach a MissionLogicEngine for a logic-graph mission (docs/09). The
 * engine's WorldContext routes SIM mutations through the real game spawn/victory
 * paths and pushes SHOW/SIM presentation events onto state.logicPresentation,
 * which _startLocalPlanningPhase drains and shows. Restores runtime state from a
 * resumed snapshot (state._restoredLogicState) when present.
 */
function _attachMissionLogic(state, missionDef) {
  const ctx = createGameContext(state, {
    createEnemyFn: _createEnemyEntity,
    emit: (event) => state.logicPresentation.push(event),
    setFlag: (key, value) => { if (_activeCampaign) _activeCampaign.storyFlags[key] = value; },
    getFlag: (key) => _activeCampaign?.storyFlags?.[key],
    getCompletedMissions: () => (_activeCampaign ? [..._activeCampaign.completedMissions] : []),
    random: () => Math.random(),
  });
  const engine = new MissionLogicEngine(missionDef.logic, ctx);
  if (state._restoredLogicState) engine.load(state._restoredLogicState);
  state.attachLogicEngine(engine);
}

function _initCampaignMission(missionDef) {
  _activeMissionDef = missionDef;
  _gameStartTime = Date.now();
  _spSaveId = null; // campaign uses its own save system

  // Persist pre-mission campaign state so defeat can restore from it
  _activeCampaign.save();

  // Build map. JSON missions carry a declarative `map` def (built via
  // buildMissionMap); legacy JS missions reference a builder fn by string key in
  // the campaign's mapBuilders registry. A resolved `mapBuilderFn` (attached by
  // loadMissionJSON) is preferred when present so the call is uniform.
  let mapData;
  if (missionDef.mapBuilderFn) {
    mapData = missionDef.mapBuilderFn();
  } else if (missionDef.map) {
    mapData = buildMissionMap(missionDef.map);
  } else {
    const builder = _activeCampaign.getMapBuilder(missionDef.mapBuilder);
    if (!builder) { console.error('No map builder for', missionDef.mapBuilder); return; }
    mapData = builder();
  }
  mapData.noWitch = !missionDef.hasWitch;
  mapData.disableScoring  = !!missionDef.disableScoring;
  mapData.disableCycleBar = !!missionDef.disableCycleBar;
  mapData.disableScoreWin  = !!missionDef.disableScoreWin;
  if (missionDef.nodeScoreThreshold != null) {
    mapData.nodeScoreThreshold = missionDef.nodeScoreThreshold;
  }
  if (missionDef.maxDiscoverableSurvivors != null) {
    mapData.maxDiscoverableSurvivors = missionDef.maxDiscoverableSurvivors;
  }

  // Hide setup, show game
  document.getElementById('setup-screen').style.display = 'none';
  document.getElementById('game-screen').style.display = 'flex';
  const canvas = document.getElementById('game-canvas');

  // Create game state — conductor-driven missions use witchIsAI=false since
  // the conductor provides scripted witch plans directly.
  const witchIsAI = !missionDef.conductorSteps;
  state = new GameState(witchIsAI, false, missionDef.mapSize, null, mapData);
  state.fogOfWar = missionDef.isTutorial ? 'none' : 'partial';
  // Campaign missions enable XP/veterancy (awardXP gates on this). Set before
  // any planning/resolution so plan-1 onward earns XP. Round-tripped by
  // state-sync so a mid-mission resume keeps the flag.
  state.isCampaign = true;

  // Apply custom phase cycle from mission definition
  if (missionDef.phaseCycle) {
    state.cycleConfig = {
      phases: [...missionDef.phaseCycle.phases],
      loop: missionDef.phaseCycle.loop !== false,
      extraScoringPhases: missionDef.phaseCycle.extraScoringPhases
        ? [...missionDef.phaseCycle.extraScoringPhases] : undefined,
      extendOnWitchScore: missionDef.phaseCycle.extendOnWitchScore
        ? [...missionDef.phaseCycle.extendOnWitchScore] : undefined,
    };
    state.phase = phaseForRound(1, state.cycleConfig);
  }

  // Campaign AI budget bonus for harder waves
  if (missionDef.aiBudgetBonus) {
    state.campaignAIBudgetBonus = missionDef.aiBudgetBonus;
  }

  // Apply per-mission loot table overrides
  if (missionDef.lootOverrides) {
    state.lootOverrides = missionDef.lootOverrides;
  }

  // Set custom victory delegate
  state.victoryDelegate = missionDef.objectives ? buildVictoryDelegate(missionDef.objectives) : null;

  // Install the mission's wave processor (runs inside endRound before
  // checkVictory so triggered spawns can pre-empt a premature win).
  if (missionDef.waves) {
    state._waveProcessor = () =>
      processWaves(state, missionDef.waves, _createEnemyEntity);
  }

  // Attach the mission logic graph engine (docs/09), if the mission opts in.
  // Additive: missions without a `logic` block are unaffected.
  if (missionDef.logic) {
    _attachMissionLogic(state, missionDef);
    state.pumpMissionLogic('missionStart'); // queues intro beats; shown at first planning
  }

  // Inject carried-over hero loadout. A null/absent carried weapon keeps the
  // faction starting weapon (the Paladin's sword) rather than disarming the
  // hero — see applyCarriedHeroLoadout.
  if (_activeCampaign && _activeCampaign.heroStats) {
    applyCarriedHeroLoadout(state.hero, _activeCampaign.heroStats);
  }

  // Inject carried-over resources (replaces faction defaults for campaign)
  if (_activeCampaign) {
    state.inventory.hero = {};
    const res = { ...(_activeCampaign.resources || {}) };
    // Add mission starting resources
    if (missionDef.startingResources) {
      for (const [k, v] of Object.entries(missionDef.startingResources)) {
        res[k] = (res[k] || 0) + v;
      }
    }
    Object.assign(state.inventory.hero, res);
  }

  // Deploy carried-over survivors from roster (uses active/reserve selection)
  if (_activeCampaign && missionDef.maxSurvivorsFromRoster > 0) {
    const toDeploy = _activeRosterIndices.slice(0, missionDef.maxSurvivorsFromRoster);
    // Place survivors at explicit start positions if the mission specifies
    // them; otherwise fall back to neighbors of the hero's start tile.
    const heroStart = mapData.heroStart;
    const explicitSpots = missionDef.survivorStartPositions
      ? [...missionDef.survivorStartPositions]
      : null;
    const neighbors = getNeighbors(heroStart.col, heroStart.row);
    const spots = explicitSpots ?? neighbors;
    for (let i = 0; i < toDeploy.length && i < spots.length; i++) {
      const rosterEntry = _activeCampaign.roster[toDeploy[i]];
      if (!rosterEntry) continue;
      const n = spots[i];
      // Spawn the SPECIFIC roster character (forcedName) so the fresh entity
      // carries that survivor's true level-1 base stats. This is what lets
      // applyLevel below recompute maxHp from the correct base instead of
      // double-boosting an already-leveled snapshot maxHp.
      const s = createSurvivor(n.col, n.row, 'hero', state, rosterEntry.name);
      // Restore stats from roster
      s.name = rosterEntry.name;
      s.title = rosterEntry.title;
      s.bio = rosterEntry.bio;
      s.abilities = Array.isArray(rosterEntry.abilities)
        ? [...rosterEntry.abilities]
        : (rosterEntry.ability ? [rosterEntry.ability] : []);
      s.abilityLabel = rosterEntry.abilityLabel;
      s.color = rosterEntry.color;
      // attack/defense are BASE values (level bonus composes live in
      // getAttack/getDefense), so copying them never double-counts the level.
      s.attack = rosterEntry.attack;
      s.defense = rosterEntry.defense;
      s.weapon = rosterEntry.weapon;
      s.items = { ...rosterEntry.items };
      s.owner = 'hero';
      // Restore veterancy: xp first, then re-level off the fresh base maxHp.
      // applyLevel sets maxHp (and full hp); we then restore the carried,
      // possibly-wounded current HP, clamped to the leveled max.
      s.xp = rosterEntry.xp || 0;
      applyLevel(s, rosterEntry.level || 1);
      if (typeof rosterEntry.hp === 'number') {
        s.hp = Math.min(rosterEntry.hp, s.maxHp);
      }
      state.entities.push(s);
      // Exclude this character from the hidden-survivor discovery pool
      state.markRosterUsedByName(rosterEntry.name);
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
      // Prefer unoccupied explicit start positions; otherwise fall back to
      // neighbors of the hero's start tile.
      const candidates = missionDef.survivorStartPositions
        ? [...missionDef.survivorStartPositions]
        : getNeighbors(heroStart.col, heroStart.row);
      const spots = candidates.filter(
        n => !state.entities.some(e => e.col === n.col && e.row === n.row)
      );
      for (let i = currentCount; i < min && spots.length > 0; i++) {
        const spot = spots.shift();
        const s = createSurvivor(spot.col, spot.row, 'hero', state);
        s.owner = 'hero';
        state.entities.push(s);
        state.addLog(_arrivalMessage(s.name));
      }
    }
  }

  // Pre-place enemy units from mission definition
  if (missionDef.enemyUnits) {
    for (const enemy of missionDef.enemyUnits) {
      const e = _createEnemyEntity(enemy.type, enemy.col, enemy.row, state);
      if (e) {
        // Level scaling first (HP/ATK/DEF), so explicit overrides still win.
        if (enemy.level) applyLevel(e, enemy.level);
        if (enemy.overrides) Object.assign(e, enemy.overrides);
        if (enemy.ref) e.ref = enemy.ref; // bind to an Actor node (OnSpawn/OnDeath)
        state.entities.push(e);
      }
    }
  }

  // Scripted NPCs (conversation participants etc.) — tagged isNpc so planning,
  // the roster, and survivor-count objectives skip them.
  if (missionDef.npcs) {
    for (const npc of missionDef.npcs) spawnNpcEntity(npc, state);
  }
  // Conversation triggers without a `flag` dedupe per attempt via this set —
  // fresh every mission init, so e.g. the intro replays on retry.
  state._firedConversations = new Set();
  // Prefetch conversation markdown + the voice manifest so playback never
  // awaits the network (the manifest also gates the card's voice-mute button).
  if (missionDef.conversations?.length) {
    loadVoiceManifest().catch(() => {});
    Promise.all(missionDef.conversations.map(c => loadConversation(c.file)))
      .catch(err => console.warn('[conversation] prefetch failed:', err));
  }

  // Set up AI — conductor-driven missions don't use witch AI
  if (missionDef.conductorSteps) {
    witchAI = null;
    heroAI  = null;
  } else {
    const AIClass = WITCH_PERSONALITIES[missionDef.aiPersonality] ?? WitchAIEngine;
    witchAI = new AIClass(state, redraw);
    heroAI = null;
  }

  _setupLocalUI(canvas, witchAI, null, false);
  _roundHistory = [];

  // Hide chronicle by default for story mode — less clutter during narrative
  ui._setChronicleOpen(false);

  // ── MissionConductor setup for guided missions ────────────────────────────
  if (missionDef.conductorSteps) {
    // Suppress phase modals and hero auto-select during conducted missions
    ui.tutorialMode = true;

    // Guarantee tutorial-specific map state
    if (missionDef.isTutorial) {
      const houseTile = state.tiles.get(_hexKey(2, 3));
      if (houseTile) houseTile.hiddenSurvivor = true;
    }

    // Wire conductor callbacks into UIController
    ui.onPlanActionAdded = (action) => _missionConductor?.onActionQueued(action);
    ui.onEntitySelected  = (entity) => _missionConductor?.onEntitySelected(entity);

    // Build conductor config with completion callback
    const conductorConfig = {
      ...missionDef.conductorConfig,
      onComplete: () => {
        // Mark mission as complete and return to story mode
        state.winner   = 'hero';
        state.winReason = missionDef.objectives?.win?.reason || 'Mission complete.';
        _activeCampaign.applyMissionResult(missionDef.id, {
          won: true, survivors: [], resources: {},
          heroStats: _activeCampaign.heroStats, flags: {},
        });
        // Clean up game state and return to the campaign Progress landing
        document.getElementById('game-screen').style.display = 'none';
        document.getElementById('setup-screen').style.display = '';
        setMode(AppMode.MENU);
        renderer = null; ui = null; witchAI = null; heroAI = null;
        _missionConductor = null;
        _activeMissionDef = null;
        _showCampaignScreen(_activeCampaign.campaignDef, undefined, _activeCampaign.slotIndex);
      },
    };

    _missionConductor = new MissionConductor(
      state, ui, renderer, redraw,
      missionDef.conductorSteps,
      conductorConfig,
    );

    redraw();
    _enterGameView();

    _missionConductor.start();
    _startLocalPlanningPhase();
    return;
  }

  // Wire mission info button callback
  ui.showMissionInfoBtn(true);
  ui.onMissionInfo = () => _showMissionInfoModal();

  // Micro-lesson hints (MissionConductor in 'hints' mode)
  _setupMissionHints(missionDef);

  // Log victory conditions at mission start
  const winDesc = _objectiveDescription(missionDef.objectives?.win);
  const loseDesc = _objectiveDescription(missionDef.objectives?.lose);
  state.addLog(`═══ ${missionDef.title} ═══`);
  state.addLog(`☀ Victory: ${winDesc}`);
  state.addLog(`💀 Defeat: ${loseDesc}`);

  redraw();
  _enterGameView();
  _startLocalPlanningPhase();
}

/**
 * Wire up a mission's micro-lesson hints (MissionConductor in 'hints' mode).
 * The mission stays fully AI-driven; hints never block input and are
 * suppressed once the mission has been completed (or explicitly skipped).
 */
function _setupMissionHints(missionDef) {
  if (!missionDef.hintSteps || areHintsSuppressed(missionDef.id)) return;
  ui.onPlanActionAdded = (action) => _missionConductor?.onActionQueued(action);
  ui.onEntitySelected  = (entity) => _missionConductor?.onEntitySelected(entity);
  _missionConductor = new MissionConductor(
    state, ui, renderer, redraw,
    missionDef.hintSteps,
    {
      ...missionDef.hintConfig,
      onSkipHints: () => { markHintsSeen(missionDef.id); _missionConductor = null; },
    },
  );
  _missionConductor.start(); // no-op in hints mode; hints fire at planning start
}

function _handleCampaignMissionEnd() {
  if (!_activeCampaign || !_activeMissionDef || !state) return;

  // Delete mid-mission save on completion (win or lose)
  deleteCampaignMissionSave(_activeCampaign.campaignDef.id, _activeMissionDef.id, _activeCampaign.slotIndex);

  // Record campaign-specific stats before cleaning up
  _recordCampaignGameStats();

  const won = state.winner === 'hero';
  const missionDef = _activeMissionDef;

  // Tear down any open micro-lesson hint; a completed mission's hints never
  // re-show on replay.
  if (_missionConductor?.isHints) {
    _missionConductor.destroy();
    if (won) markHintsSeen(missionDef.id);
  }

  let survivors;
  if (won) {
    // Gather surviving survivors for roster (permadeath: dead ones are lost).
    // Roster members who were deployed and died are dropped; undeployed
    // members are preserved; alive deployed members are snapshotted.
    survivors = reconcileRosterAfterMission(_activeCampaign.roster, state.entities);

    _activeCampaign.applyMissionResult(missionDef.id, {
      won,
      survivors,
      resources: { ...state.inventory.hero },
      heroStats: state.hero ? {
        hp: state.hero.hp, maxHp: state.hero.maxHp,
        attack: state.hero.attack, defense: state.hero.defense,
        // Campaign veterancy: carry the hero's earned level + XP forward so
        // applyMissionResult round-trips them into Campaign.heroStats (Phase B
        // fields). Without these the hero's veterancy would silently reset each
        // mission. applyCarriedHeroLoadout re-applies them at the next deploy.
        level: state.hero.level, xp: state.hero.xp,
        weapon: state.hero.weapon, items: { ...state.hero.items },
      } : _activeCampaign.heroStats,
      flags: {},
    });
  } else {
    // Defeat: restore party to pre-mission state (no permadeath, no stat changes)
    survivors = _activeCampaign.roster;
  }

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

  // Heal bonus notice
  if (won && missionDef.healBonus) {
    statsEl.insertAdjacentHTML('afterend',
      `<div class="debrief-heal">✦ Rest bonus: all survivors healed +${missionDef.healBonus} HP</div>`);
  }

  // Roster status — rich party cards
  const rosterEl = document.getElementById('debrief-roster');
  const heroSnap = won && state.hero ? {
    hp: state.hero.hp, maxHp: state.hero.maxHp,
    attack: state.hero.attack, defense: state.hero.defense,
    weapon: state.hero.weapon,
  } : _activeCampaign.heroStats;
  const rosterHeading = won ? 'Surviving Roster' : 'Party Restored';
  rosterEl.innerHTML = `<h3>${rosterHeading}</h3>` +
    _campaignPartyHTML(heroSnap, survivors);

  // Clean up game state
  renderer = null; ui = null; witchAI = null; heroAI = null;
  _missionConductor = null;
  _activeMissionDef = null;

  showStep('debrief');
}

// Campaign event listeners
document.getElementById('btn-campaign-select-back').addEventListener('click', () => showStep('mode'));
// The slot picker is now the campaign entry point (the chapter screen is skipped),
// so backing out of it returns to the main menu.
document.getElementById('btn-campaign-slot-back')  ?.addEventListener('click', () => showStep('mode'));
document.getElementById('btn-campaign-back')   .addEventListener('click', () => {
  if (_activeCampaign) _showCampaignSlotScreen(_activeCampaign.campaignDef);
  else showStep('mode');
});
document.getElementById('btn-briefing-back')   .addEventListener('click', () => {
  // Return to the Progress landing (preserving the squad just chosen) — but if
  // we arrived here via a single-mission campaign there's no landing to show.
  if (_activeCampaign && _activeCampaign.campaignDef.missions.length > 1) {
    _renderCampaignProgressScreen();
    showStep('campaign-progress');
  } else {
    _renderCampaignScreen();
  }
});

// Campaign Progress screen — static nav buttons (wired once).
document.getElementById('btn-campaign-progress-back')?.addEventListener('click', () => {
  if (_activeCampaign) _showCampaignSlotScreen(_activeCampaign.campaignDef);
});
document.getElementById('btn-campaign-progress-startover')?.addEventListener('click', () => {
  if (confirm('Start over? All campaign progress, roster survivors, and resources in this slot will be lost. This cannot be undone.')) {
    const def = _activeCampaign.campaignDef;
    _activeCampaign.delete();
    _showCampaignSlotScreen(def);
  }
});
document.getElementById('btn-campaign-progress-unlock')?.addEventListener('click', () => {
  _campaignUnlocked = !_campaignUnlocked;
  const btn = document.getElementById('btn-campaign-progress-unlock');
  if (btn) btn.textContent = _campaignUnlocked ? '🔒 Lock' : '🔓 Unlock All';
  _renderCampaignProgressScreen();
});
document.querySelectorAll('.cprog-toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    _progressPane = btn.dataset.pane === 'missions' ? 'missions' : 'party';
    _renderCampaignProgressScreen();
  });
});
document.getElementById('btn-delete-campaign')  .addEventListener('click', () => {
  if (confirm('Start over? All campaign progress, roster survivors, and resources will be lost. This cannot be undone.')) {
    const def = _activeCampaign.campaignDef;
    _activeCampaign.delete();
    _showCampaignSlotScreen(def);
  }
});
document.getElementById('btn-start-mission')   .addEventListener('click', () => {
  if (!_campaignSelectedMission) return;
  const missionDef = _activeCampaign.getMissionDef(_campaignSelectedMission);
  if (missionDef) _initCampaignMission(missionDef);
});
document.getElementById('btn-resume-mission')  .addEventListener('click', () => {
  if (!_campaignSelectedMission) return;
  _resumeCampaignMission(_campaignSelectedMission);
});
document.getElementById('btn-restart-mission') .addEventListener('click', () => {
  if (!_campaignSelectedMission) return;
  deleteCampaignMissionSave(_activeCampaign.campaignDef.id, _campaignSelectedMission, _activeCampaign.slotIndex);
  const missionDef = _activeCampaign.getMissionDef(_campaignSelectedMission);
  if (missionDef) _initCampaignMission(missionDef);
});
document.getElementById('btn-admin-unlock')    .addEventListener('click', () => {
  _campaignUnlocked = !_campaignUnlocked;
  const btn = document.getElementById('btn-admin-unlock');
  btn.textContent = _campaignUnlocked ? '🔒 Lock' : '🔓 Unlock All';
  _renderCampaignScreen();
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

// Quick Play faction picker — 6 tiles, grouped by side.
// _qpFactionId is the specific faction the player picked. It maps onto a
// side (day/night) which decides which side-AI to spawn for the opponent.
let _qpFactionId = 'hero';
const _qpFactionTiles = document.querySelectorAll('.qp-faction-picker .qp-faction-btn');
for (const btn of _qpFactionTiles) {
  btn.addEventListener('click', () => {
    _qpFactionId = btn.dataset.faction;
    for (const other of _qpFactionTiles) other.classList.toggle('active', other === btn);
  });
}

// Quick Play start button (always 1v1 vs AI). The faction picker chooses
// the human-controlled faction; the AI plays the side default on the
// opposing side. Stubs are passed through to GameState.swapLeaderToFaction
// so the human's leader gets stub stats.
document.getElementById('btn-start-qp').addEventListener('click', () => {
  const def     = getFaction(_qpFactionId);
  const isDay   = def.side === 'day';
  init(/*witchIsAI*/ isDay, /*heroIsAI*/ !isDay, /*autoplay*/ false, /*humanFactionId*/ _qpFactionId);
});

function _doRestart() {
  // Disconnect from server if in online mode
  if (mp) { mp.disconnect(); mp = null; }

  // Clean up AI debug state
  _clearAIDebug();
  setAIDebugActive(false);

  // Reset game objects so initOnline / init start fresh
  renderer = null;
  ui       = null;
  state    = null;
  witchAI  = null;
  heroAI   = null;
  _activeMissionDef = null;
  _pendingPlanningPhase = null;
  _pendingSubmissions   = [];

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
  if (!state || state.gameOver || _autoplay || !_spSaveId) return;
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

/** Render the in-progress saves list on the vs. AI screen using mm-row style. */
function _renderSpSaves() {
  const list    = document.getElementById('sp-saves-list');
  const section = document.getElementById('mm-sp-section');
  if (!list) return;
  const rows = _localSpRows();
  if (section) section.style.display = rows.length ? '' : 'none';
  _renderMmList(list, rows, {
    emptyHtml: '',
    actionsFor: (row) => [
      {
        icon: '✕',
        title: 'Delete save',
        className: 'mm-action-delete',
        onClick: () => {
          if (!confirm('Delete this saved game? This cannot be undone.')) return;
          _deleteSpSave(row.room_id);
          _renderSpSaves();
        },
      },
    ],
  });
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
  heroAI  = state.heroIsAI  ? new HeroAIEngine(state, redraw)  : null;

  _setupLocalUI(canvas, witchAI, heroAI, false);

  redraw();
  _enterGameView();

  _startLocalPlanningPhase();
}

// ── Active games list — used by the Online screen (filtered mm-row style) ────
//
// Shows the same mm-game-row format as the main menu, filtered to online games
// + battle, with a ✕ resign button per row. Reuses the shared _fetchAllGames
// and _renderMmList helpers.

async function _fetchActiveSaves() {
  const list    = document.getElementById('active-games-list');
  const section = document.getElementById('mp-games-section');
  if (!list) return;

  const session = loadSession();
  if (!session) {
    if (section) section.style.display = 'none';
    return;
  }

  try {
    const { rows } = await _fetchAllGames();
    const filtered = rows.filter(
      (row) => row.kind === 'game' || row.kind === 'battle' || row.kind === 'battle-invite',
    );
    if (section) section.style.display = filtered.length ? '' : 'none';
    _renderMmList(list, rows, {
      filter: (row) => row.kind === 'game' || row.kind === 'battle' || row.kind === 'battle-invite',
      emptyHtml: '',
      actionsFor: (row) => {
        if (row.kind === 'game' && row.room_id) {
          return [{
            icon: '✕',
            title: 'Resign',
            className: 'mm-action-delete',
            onClick: () => _confirmResign(row.room_id),
          }];
        }
        if (row.kind === 'battle' && row.room_id) {
          return [{
            icon: '✕',
            title: 'Quit battle',
            className: 'mm-action-delete',
            onClick: () => {
              if (!confirm('Quit the battle? This cannot be undone.')) return;
              _ensureAuthed(() => mp.resignGame(row.room_id));
              setTimeout(_fetchActiveSaves, 500);
            },
          }];
        }
        return undefined;
      },
    });
  } catch {
    if (section) section.style.display = 'none';
  }
}

function _confirmResign(roomId) {
  if (!confirm('Are you sure you want to resign? This cannot be undone.')) return;
  _ensureAuthed(() => mp.resignGame(roomId));
  // Refresh the list after a short delay
  setTimeout(_fetchActiveSaves, 500);
}

function _confirmResignFromMenu(roomId) {
  if (!confirm('Are you sure you want to resign? This cannot be undone.')) return;
  _ensureAuthed(() => mp.resignGame(roomId));
  setTimeout(_fetchMainMenuGames, 500);
}

/**
 * Show an in-game Yes/No confirmation dialog for resigning.
 * Uses the result-dialog overlay with custom buttons.
 */
function _showResignConfirmation(mpClient) {
  if (!ui) return;
  const dialog = document.getElementById('result-dialog');
  const msgs   = document.getElementById('result-messages');
  const btns   = document.getElementById('result-buttons');
  const hint   = document.getElementById('result-dismiss-hint');
  if (!dialog || !msgs || !btns) return;

  msgs.textContent = 'Are you sure you want to resign?\nThis cannot be undone.';
  if (hint) hint.style.display = 'none';
  const portrait = document.getElementById('result-portrait');
  if (portrait) { portrait.style.display = 'none'; portrait.innerHTML = ''; }

  btns.style.display = '';
  btns.innerHTML = '';

  const dismiss = () => { dialog.style.display = 'none'; };

  const yesBtn = document.createElement('button');
  yesBtn.className = 'setup-btn';
  yesBtn.style.cssText = 'color:#c44;border-color:#c44';
  yesBtn.textContent = 'Yes, Resign';
  yesBtn.addEventListener('click', () => {
    dismiss();
    const roomId = mpClient?.roomId || _asyncRoomId;
    if (roomId && mpClient) mpClient.resignGame(roomId);
  });

  const noBtn = document.createElement('button');
  noBtn.className = 'setup-btn';
  noBtn.textContent = 'Cancel';
  noBtn.addEventListener('click', dismiss);

  btns.appendChild(noBtn);
  btns.appendChild(yesBtn);
  dialog.style.display = 'flex';
}

/**
 * Resign from a local (single-player) game.
 * Shows confirmation dialog, then ends the game as a loss.
 */
function _resignLocalGame(humanFaction) {
  if (!ui || !state || state.gameOver) return;
  const dialog = document.getElementById('result-dialog');
  const msgs   = document.getElementById('result-messages');
  const btns   = document.getElementById('result-buttons');
  const hint   = document.getElementById('result-dismiss-hint');
  if (!dialog || !msgs || !btns) return;

  msgs.textContent = 'Are you sure you want to resign?\nThis cannot be undone.';
  if (hint) hint.style.display = 'none';
  const portrait = document.getElementById('result-portrait');
  if (portrait) { portrait.style.display = 'none'; portrait.innerHTML = ''; }

  btns.style.display = '';
  btns.innerHTML = '';

  const dismiss = () => { dialog.style.display = 'none'; };

  const yesBtn = document.createElement('button');
  yesBtn.className = 'setup-btn';
  yesBtn.style.cssText = 'color:#c44;border-color:#c44';
  yesBtn.textContent = 'Yes, Resign';
  yesBtn.addEventListener('click', () => {
    dismiss();
    const winnerFaction = humanFaction === 'hero' ? 'witch' : 'hero';
    state.winner    = winnerFaction;
    state.winReason = 'You resigned.';
    _saveCompletedSpGame(winnerFaction, state.winReason);
    redraw();
    ui._showResolutionSummary([], state.round, {
      gameOver: true,
      winner: winnerFaction,
      winReason: state.winReason,
      humanFaction,
      hasFullReplay: _roundHistory.length > 0,
    }).then(async (choice) => {
      if (choice === 'replay-full' && _roundHistory.length > 0) {
        await _replayFullGame(_roundHistory, winnerFaction, state.winReason,
          state.hero?.displayName ?? 'Hero', state.witch?.displayName ?? 'Witch',
          () => renderer.draw(state, ui));
      }
      location.reload();
    });
  });

  const noBtn = document.createElement('button');
  noBtn.className = 'setup-btn';
  noBtn.textContent = 'Cancel';
  noBtn.addEventListener('click', dismiss);

  btns.appendChild(noBtn);
  btns.appendChild(yesBtn);
  dialog.style.display = 'flex';
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

function _deleteAsyncGame(roomId) {
  const dialog = document.createElement('div');
  dialog.style.cssText = 'position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55)';
  dialog.innerHTML = `
    <div class="result-card" style="max-width:360px;pointer-events:auto">
      <h2 style="margin-bottom:0.5em">Delete Game</h2>
      <p style="margin-bottom:1.2em">Delete this game? This cannot be undone.</p>
      <div style="display:flex;gap:0.5em;justify-content:center">
        <button class="setup-btn secondary" id="del-cancel-btn">Cancel</button>
        <button class="setup-btn primary" id="del-confirm-btn" style="background:var(--danger,#aa4444)">Delete</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);

  dialog.querySelector('#del-cancel-btn').addEventListener('click', () => dialog.remove());
  dialog.querySelector('#del-confirm-btn').addEventListener('click', () => {
    const session = loadSession();
    if (!session) { dialog.remove(); return; }
    const base = window.BRIMSTONE_SERVER || '';
    fetch(`${base}/api/async-games/${encodeURIComponent(roomId)}?token=${encodeURIComponent(session.token)}`, {
      method: 'DELETE',
    })
      .then(r => r.json())
      .then(res => {
        dialog.remove();
        if (res.ok) {
          _fetchAsyncGames();
          _fetchMainMenuAsyncGames();
        }
      })
      .catch(() => dialog.remove());
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
      // Waiting for opponent — host can plan turn 1 in the meantime
      const planBtnLabel = g.my_plan_submitted ? 'Planned' : 'Plan';
      const planBtnClass = g.my_plan_submitted ? 'secondary' : 'primary';
      entry.innerHTML = `
        <div class="save-entry-info">
          <div class="save-entry-title">${factionSymbol} Waiting for opponent${g.my_plan_submitted ? ' <span class="async-badge async-badge-waiting">Planned</span>' : ''}</div>
          <div class="save-entry-meta">Code: <strong>${_esc(g.code)}</strong>${g.updated_at ? ' · ' + _timeAgo(g.updated_at) : ''}</div>
        </div>
        <button class="setup-btn ${planBtnClass} async-plan-btn">${planBtnLabel}</button>
        <button class="setup-btn secondary async-copy-btn" data-code="${_esc(g.code)}">Copy</button>
      `;
      entry.querySelector('.async-plan-btn').addEventListener('click', () => _openAsyncGame(g.room_id));
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
          <div class="save-entry-meta">${label} · Round ${g.round}${g.updated_at ? ' · ' + _timeAgo(g.updated_at) : ''}</div>
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
          <div class="save-entry-meta">Round ${g.round} · ${phaseLabel}${deadline ? ' · ' + deadline : ''}${g.updated_at ? ' · ' + _timeAgo(g.updated_at) : ''}</div>
        </div>
        ${actionBtn}
      `;
      const btn = entry.querySelector('.async-play-btn, .async-view-btn');
      btn?.addEventListener('click', () => _openAsyncGame(g.room_id));
    }

    // Add delete button to every entry
    const delBtn = document.createElement('button');
    delBtn.className = 'setup-btn secondary async-del-btn';
    delBtn.textContent = '✕';
    delBtn.title = 'Delete game';
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); _deleteAsyncGame(g.room_id); });
    entry.appendChild(delBtn);

    list.appendChild(entry);
  }
}

function _timeRemaining(deadlineUnixSecs) {
  const diff = deadlineUnixSecs - Math.floor(Date.now() / 1000);
  if (diff <= 0) return 'expired';
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  if (d >= 1) return `${d}d ${h}h left`;
  if (h >= 1) return `${h}h ${m}m left`;
  return `${m}m left`;
}

// ── Main menu active games list ─────────────────────────────────────────────
//
// The main menu, vs. AI, Online, and Replays pages all share the same row
// rendering via `_buildMmRow`. `_fetchAllGames` gathers rows from every source
// (local SP saves, campaign missions, online games, battle); callers filter and
// add per-row actions (resign, pin, delete).

let _mmCountdownTimer = null;

function _stopMmCountdown() {
  if (_mmCountdownTimer) {
    clearInterval(_mmCountdownTimer);
    _mmCountdownTimer = null;
  }
}

function _tickMmCountdowns() {
  const nodes = document.querySelectorAll('.mm-countdown[data-deadline]');
  if (!nodes.length) { _stopMmCountdown(); return; }
  for (const el of nodes) {
    const deadline = Number(el.dataset.deadline);
    if (!deadline) continue;
    const text = _timeRemaining(deadline);
    el.textContent = text;
    if (text === 'expired') el.classList.add('expired');
    else el.classList.remove('expired');
  }
}

/**
 * Build a single DOM row element for the shared mm-game-row rendering.
 *
 * @param {Object} row      — normalized row object (see main-menu-games.js)
 * @param {Object} [opts]
 * @param {() => void} [opts.onClick]  — click handler for the row body
 * @param {Array<{icon, title, className?, onClick}>} [opts.actions]  — extra buttons
 */
function _buildMmRow(row, opts = {}) {
  const view = mmFormatRow(row);

  const wrap = document.createElement('div');
  wrap.className = view.classes.join(' ');

  const body = document.createElement('button');
  body.type = 'button';
  body.className = 'mm-game-row-body';

  const line1 = document.createElement('div');
  line1.className = 'mm-game-row-line1';
  const titleSpan = document.createElement('span');
  titleSpan.className = 'mm-game-title';
  titleSpan.textContent = view.title;
  line1.appendChild(titleSpan);

  if (view.showTurnBadge) {
    const badge = document.createElement('span');
    badge.className = 'mm-badge-turn';
    badge.textContent = 'YOUR TURN';
    line1.appendChild(badge);
  }
  if (view.deadline) {
    const cd = document.createElement('span');
    cd.className = 'mm-countdown';
    cd.dataset.deadline = String(view.deadline);
    cd.textContent = _timeRemaining(view.deadline);
    if (cd.textContent === 'expired') cd.classList.add('expired');
    line1.appendChild(cd);
  }

  const line2 = document.createElement('div');
  line2.className = 'mm-game-row-line2';
  line2.textContent = view.meta;

  body.appendChild(line1);
  body.appendChild(line2);
  body.addEventListener('click', opts.onClick || (() => _mmDefaultRowClick(row)));

  wrap.appendChild(body);

  if (opts.actions?.length) {
    const actionsWrap = document.createElement('div');
    actionsWrap.className = 'mm-game-row-actions';
    for (const action of opts.actions) {
      const ab = document.createElement('button');
      ab.type = 'button';
      ab.className = 'mm-action-btn ' + (action.className || '');
      ab.title = action.title || '';
      ab.textContent = action.icon;
      ab.addEventListener('click', (e) => { e.stopPropagation(); action.onClick(); });
      actionsWrap.appendChild(ab);
    }
    wrap.appendChild(actionsWrap);
  }

  return wrap;
}

/**
 * Default click handler for a row — routes based on kind to the right flow.
 */
function _mmDefaultRowClick(row) {
  switch (row.kind) {
    case 'battle':
    case 'battle-invite':
      _showBattleScreen();
      return;
    case 'local-sp':
      if (row._spSave) _resumeSpSave(row._spSave);
      return;
    case 'local-campaign':
      if (row._campaignDef) _showCampaignScreen(row._campaignDef, undefined, row._slotIndex ?? 1);
      return;
    case 'campaign-next':
      if (row._campaignDef) _showCampaignScreen(row._campaignDef, row._nextMissionId, row._slotIndex ?? 1);
      return;
    case 'completed-sp': {
      // Rows carry only lightweight index metadata; the full round data is
      // loaded lazily from localStorage on click.
      const data = row._completedData ?? (row._completedMeta && _loadCompletedSpGame(row._completedMeta.id));
      if (data?.rounds?.length) _startSpReplay(data);
      else alert('Replay data not found.');
      return;
    }
    case 'completed-mp':
      if (row._replayMeta) _mmStartMpReplay(row._replayMeta);
      return;
    case 'game':
    default:
      if (row.room_id) _resumeSave(row.room_id);
      return;
  }
}

/**
 * Return per-row action buttons for the main menu game list.
 * Every action prompts for confirmation with a contextual message.
 */
function _mmGameListActions(row) {
  switch (row.kind) {
    case 'local-sp':
      return [{
        icon: '✕',
        title: 'Delete save',
        className: 'mm-action-delete',
        onClick: () => {
          if (!confirm('Delete this saved game? This cannot be undone.')) return;
          _deleteSpSave(row.room_id);
          _fetchMainMenuGames();
        },
      }];
    case 'local-campaign':
      return [{
        icon: '✕',
        title: 'Abandon mission progress',
        className: 'mm-action-delete',
        onClick: () => {
          if (!confirm('Abandon mission progress? This cannot be undone.')) return;
          if (row._campaignDef && row._missionDef) {
            deleteCampaignMissionSave(row._campaignDef.id, row._missionDef.id, row._slotIndex ?? 1);
          }
          _fetchMainMenuGames();
        },
      }];
    case 'game':
      if (row.room_id) {
        return [{
          icon: '✕',
          title: 'Resign',
          className: 'mm-action-delete',
          onClick: () => { _confirmResignFromMenu(row.room_id); },
        }];
      }
      return undefined;
    case 'battle':
      if (row.room_id) {
        return [{
          icon: '✕',
          title: 'Quit battle',
          className: 'mm-action-delete',
          onClick: () => {
            if (!confirm('Quit the battle? This cannot be undone.')) return;
            _ensureAuthed(() => mp.resignGame(row.room_id));
            setTimeout(_fetchMainMenuGames, 500);
          },
        }];
      }
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Load local SP save rows (from localStorage). Always available, no login.
 */
function _localSpRows() {
  const saves = _loadSpSaves().filter(s => s.id); // skip stale null-id campaign ghosts
  const modeLabels = {
    hero: '⚔ vs AI (Hero)',
    witch: '✦ vs AI (Witch)',
    'two-players': '👥 Two Players',
  };
  return saves.map(s => ({
    kind: 'local-sp',
    room_id: s.id,
    title: modeLabels[s.mode] ?? s.mode,
    round: s.round,
    phase: s.phase,
    action_needed: false,
    turn_deadline: null,
    map_size: s.mapSize ?? 'standard',
    updated_at: s.updatedAt ?? 0,
    is_local: true,
    _spSave: s,
  }));
}

/**
 * Load campaign rows for the game list. Per campaign, each save slot can
 * contribute:
 * 1. Mid-mission saves (kind: 'local-campaign') — a mission is in progress
 * 2. Next-mission entries (kind: 'campaign-next') — slot has progress and a
 *    next mission is available but not yet started
 *
 * The list shows ONE row per campaign — `mmDedupeCampaignRows` keeps the slot
 * touched most recently — so a player with several playthroughs sees the one
 * they were last on, not a wall of near-identical rows.
 */
function _localCampaignRows() {
  const rows = [];
  try {
    for (const camp of CAMPAIGNS) {
      if (camp.disabled) continue;
      const missions = camp.missions || [];

      for (let slot = 1; slot <= CAMPAIGN_SLOT_COUNT; slot++) {
        const hasMidMissionSave = new Set();

        // 1. Scan missions for any that have a mid-mission save file in this slot
        for (const m of missions) {
          const save = loadCampaignMissionSave(camp.id, m.id, slot);
          if (!save) continue;
          hasMidMissionSave.add(m.id);
          rows.push({
            kind: 'local-campaign',
            room_id: `${camp.id}/slot${slot}/${m.id}`,
            title: `📖 ${m.title || m.id}`,
            round: null,
            phase: null,
            action_needed: false,
            turn_deadline: null,
            updated_at: save.updatedAt ? Math.floor(save.updatedAt / 1000) : 0,
            is_local: true,
            _campaignId: camp.id,
            _slotIndex: slot,
            _missionTitle: m.title || m.id,
            _campaignDef: camp,
            _missionDef: m,
          });
        }

        // 2. If this slot has progress and a next mission is available (no mid-
        //    mission save for it), show a "campaign-next" entry so the player
        //    can jump straight to the party select / briefing screen.
        const c = new Campaign(camp, slot);
        if (!c.load()) continue;        // no save → no progress in this slot
        if (c.isComplete()) continue;    // all missions done
        const nextId = c.getNextMission();
        if (!nextId) continue;
        if (hasMidMissionSave.has(nextId)) continue; // already shown above
        const mDef = c.getMissionDef(nextId);
        if (!mDef) continue;
        rows.push({
          kind: 'campaign-next',
          room_id: `${camp.id}/slot${slot}/${nextId}`,
          title: `📖 ${camp.title}`,
          action_needed: false,
          turn_deadline: null,
          updated_at: c.updatedAt ? Math.floor(c.updatedAt / 1000) : 0,
          is_local: true,
          _campaignId: camp.id,
          _slotIndex: slot,
          _campaignDef: camp,
          _missionDef: mDef,
          _nextMissionId: nextId,
          _nextMissionTitle: mDef.title || nextId,
        });
      }
    }
  } catch {}
  return mmDedupeCampaignRows(rows);
}

/**
 * Gather all rows: local SP + campaign + online games + battle. Returns
 * { rows, signedIn, hadOnlineFetch } — caller filters/sorts/renders.
 */
async function _fetchAllGames() {
  const rows = [..._localSpRows(), ..._localCampaignRows()];

  const session = loadSession();
  if (!session) {
    return { rows, signedIn: false, hadOnlineFetch: false };
  }

  const base = window.BRIMSTONE_SERVER || '';
  const token = encodeURIComponent(session.token);

  let games = [];
  let battleStatus = null;
  let hadOnlineFetch = true;
  try {
    const [gamesRes, battleRes] = await Promise.all([
      fetch(`${base}/api/games?token=${token}`).then(r => r.ok ? r.json() : []),
      fetch(`${base}/api/battle-status?token=${token}`).then(r => r.ok ? r.json() : null),
    ]);
    if (Array.isArray(gamesRes)) games = gamesRes;
    battleStatus = battleRes;
  } catch {
    hadOnlineFetch = false;
  }

  for (const s of games) {
    const pps = s.players_per_side ?? 1;
    let title;
    if (pps <= 1) {
      const myFaction = s.hero_player_id === session?.id ? 'hero' : 'witch';
      const oppName = myFaction === 'hero' ? (s.witch_name || 'Witch') : (s.hero_name || 'Hero');
      const sym = myFaction === 'hero' ? '⚔' : '✦';
      title = `${sym} vs ${oppName}`;
    } else {
      title = `${pps}v${pps} Game`;
    }
    rows.push({
      kind: 'game',
      room_id: s.room_id,
      title,
      round: s.round,
      phase: s.phase,
      action_needed: !!s.action_needed,
      turn_deadline: s.turn_deadline,
      players_submitted: s.players_submitted ?? 0,
      players_total: s.players_total ?? 0,
      players_per_side: pps,
      map_size: s.map_size ?? 'standard',
      updated_at: s.updated_at ?? 0,
      status: s.status,
    });
  }

  // Synthesize a battle row if there's an active battle.
  if (battleStatus?.myBattle) {
    const b = battleStatus.myBattle;
    const pps = b.maxPerSide ?? 10;
    const playersCount = (b.players ?? []).filter(p => !p.isAI).length;
    rows.push({
      kind: 'battle',
      room_id: b.roomId,
      title: '⚔✦ Battle for Caleb\'s Hollow',
      round: b.round,
      action_needed: !b.mySubmitted,
      turn_deadline: b.turnDeadline ?? null,
      players_count: playersCount,
      players_per_side: pps,
      updated_at: Math.floor(Date.now() / 1000),
      status: 'playing',
    });
  } else if (battleStatus?.battles?.length) {
    // A battle exists but the user hasn't joined — show as an invite.
    rows.push({
      kind: 'battle-invite',
      room_id: null,
      title: '⚔✦ Battle for Caleb\'s Hollow',
      round: null,
      action_needed: false,
      turn_deadline: null,
      players_per_side: battleStatus.battles[0].maxPerSide ?? 10,
      updated_at: Math.floor(Date.now() / 1000),
      status: 'invite',
    });
  }

  return { rows, signedIn: true, hadOnlineFetch };
}

/**
 * Render a list of mm-rows into a target element, optionally with filter and
 * per-row action buttons. Restarts the countdown timer if any deadlines are
 * present.
 *
 * @param {HTMLElement} listEl
 * @param {Array<Object>} rows
 * @param {Object} [opts]
 * @param {(row: Object) => boolean} [opts.filter]
 * @param {(row: Object) => Array} [opts.actionsFor]
 * @param {number} [opts.maxRows]
 * @param {string} [opts.emptyHtml]
 */
function _renderMmList(listEl, rows, opts = {}) {
  if (!listEl) return;
  const { filter, actionsFor, maxRows, emptyHtml } = opts;
  let filtered = filter ? rows.filter(filter) : rows;
  filtered = mmSortRows(filtered);
  if (maxRows && filtered.length > maxRows) filtered = filtered.slice(0, maxRows);

  listEl.innerHTML = '';
  if (!filtered.length) {
    listEl.innerHTML = emptyHtml || '<p class="mm-games-empty">No games.</p>';
    return;
  }

  for (const row of filtered) {
    const actions = actionsFor ? actionsFor(row) : undefined;
    listEl.appendChild(_buildMmRow(row, { actions }));
  }
}

/**
 * Refresh the main-menu active games list.
 *
 * Local saves + campaign missions are always loaded. Online games are only
 * fetched when signed in; a "sign in to see online games" hint appears below
 * the list when not signed in.
 */
async function _fetchMainMenuGames() {
  const list    = document.getElementById('mm-games-list');
  const section = document.getElementById('mm-games-section');
  if (!list) return;

  const { rows } = await _fetchAllGames();

  // Hide the entire section when there are no games at all. (Signed-out users
  // simply see no online games — the persistent footer "Sign In" button is the
  // single sign-in entry point.)
  if (section) section.style.display = rows.length ? '' : 'none';

  _renderMmList(list, rows, {
    maxRows: 5,
    emptyHtml: '',
    actionsFor: (row) => _mmGameListActions(row),
  });

  // Restart the countdown timer if any visible rows have deadlines
  _stopMmCountdown();
  if (list.querySelector('.mm-countdown[data-deadline]')) {
    _mmCountdownTimer = setInterval(_tickMmCountdowns, 1000);
  }
}

/**
 * Render the Replays section on the main menu. Merges SP local completed games
 * and MP online completed games into a single mm-style list with pin/delete
 * buttons. Lives inline on the welcome card (between the mode buttons and the
 * admin link); called by showStep('mode'). Fire-and-forget — handles its own
 * loading/empty states.
 */
async function _renderReplaysList() {
  const list = document.getElementById('mm-replays-list');
  if (!list) return;
  list.innerHTML = '<p class="mm-games-empty">Loading…</p>';

  const rows = [];

  // Local SP completed games
  try {
    _pruneCompletedSpGames();
    const index = _loadCompletedSpIndex();
    const modeLabels = { hero: '⚔ vs AI', witch: '✦ vs AI', 'two-players': '👥 Two Players' };
    for (const g of index) {
      const winnerLabel = g.winner === 'hero' ? 'Hero wins' : 'Witch wins';
      rows.push({
        kind: 'completed-sp',
        room_id: g.id,
        title: `${modeLabels[g.mode] ?? g.mode} — ${winnerLabel}${g.pinned ? ' 📌' : ''}`,
        win_reason: g.winReason,
        total_rounds: g.totalRounds,
        action_needed: false,
        turn_deadline: null,
        updated_at: g.createdAt ?? 0,
        is_local: true,
        _completedMeta: g,
      });
    }
  } catch {}

  // Online MP completed games (only if signed in)
  const session = loadSession();
  if (session) {
    try {
      const base = window.BRIMSTONE_SERVER || '';
      const res = await fetch(`${base}/api/completed-games?token=${encodeURIComponent(session.token)}`);
      if (res.ok) {
        const games = await res.json();
        for (const g of games) {
          let players = [];
          try { players = JSON.parse(g.players_json || '[]'); } catch {}
          const pps = players.length > 0 ? players.filter(p => p.faction === 'hero').length : 1;
          let myFaction;
          if (players.length > 0) {
            const mySeat = players.find(p => p.playerId === session?.id);
            myFaction = mySeat?.faction ?? 'hero';
          } else {
            myFaction = g.hero_player_id === session?.id ? 'hero' : 'witch';
          }
          const resultLabel = g.winner === myFaction ? 'Victory' : 'Defeat';
          const winnerIcon  = g.winner === 'hero' ? '⚔' : '✦';
          const title = pps > 1
            ? `${winnerIcon} ${pps}v${pps} — ${resultLabel}`
            : `${winnerIcon} ${g.hero_name} vs ${g.witch_name} — ${resultLabel}`;
          rows.push({
            kind: 'completed-mp',
            room_id: g.game_id,
            title: title + (g.pinned ? ' 📌' : ''),
            win_reason: g.win_reason,
            total_rounds: g.total_rounds,
            action_needed: false,
            turn_deadline: null,
            updated_at: g.created_at ?? 0,
            _replayMeta: g,
          });
        }
      }
    } catch {}
  }

  _renderMmList(list, rows, {
    emptyHtml: '<p class="mm-games-empty">No completed games yet — finish a match to see replays here.</p>',
    actionsFor: (row) => {
      if (row.kind === 'completed-sp') {
        const meta = row._completedMeta;
        return [
          {
            icon: meta.pinned ? '📌' : '📎',
            title: meta.pinned ? 'Unpin' : 'Pin to keep',
            onClick: () => { _pinCompletedSpGame(meta.id, !meta.pinned); _renderReplaysList(); },
          },
          {
            icon: '✕',
            title: 'Delete',
            className: 'mm-action-delete',
            onClick: () => { _deleteCompletedSpGame(meta.id); _renderReplaysList(); },
          },
        ];
      }
      if (row.kind === 'completed-mp') {
        const meta = row._replayMeta;
        const base = window.BRIMSTONE_SERVER || '';
        const token = session?.token;
        return [
          {
            icon: meta.pinned ? '📌' : '📎',
            title: meta.pinned ? 'Unpin' : 'Pin to keep',
            onClick: async () => {
              await fetch(
                `${base}/api/completed-games/${encodeURIComponent(meta.game_id)}/pin?token=${encodeURIComponent(token)}`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ pinned: !meta.pinned }),
                }
              );
              _renderReplaysList();
            },
          },
          {
            icon: '✕',
            title: 'Delete',
            className: 'mm-action-delete',
            onClick: async () => {
              await fetch(
                `${base}/api/completed-games/${encodeURIComponent(meta.game_id)}?token=${encodeURIComponent(token)}`,
                { method: 'DELETE' }
              );
              _renderReplaysList();
            },
          },
        ];
      }
      return undefined;
    },
  });
}

/**
 * Start an MP completed-game replay — fetches rounds then plays via playback.
 */
async function _mmStartMpReplay(gameMeta) {
  const session = loadSession();
  if (!session) return;
  const base = window.BRIMSTONE_SERVER || '';
  try {
    const rounds = await fetch(
      `${base}/api/completed-games/${encodeURIComponent(gameMeta.game_id)}/rounds?token=${encodeURIComponent(session.token)}`
    ).then(r => r.json());
    await _startMpReplay(rounds, gameMeta);
  } catch {
    alert('Could not load replay data.');
  }
}

/**
 * Fetch async games that need the player's attention and show them
 * in the main menu notification box.
 */
function _fetchMainMenuAsyncGames() {
  const box  = document.getElementById('menu-async-box');
  const list = document.getElementById('menu-async-list');
  if (!box || !list) return;

  const session = loadSession();
  if (!session) { box.style.display = 'none'; return; }

  const base = window.BRIMSTONE_SERVER || '';
  fetch(`${base}/api/async-games?token=${encodeURIComponent(session.token)}`)
    .then(r => r.json())
    .then(games => {
      // Filter to actionable games: your turn, or waiting games you haven't planned
      const actionable = games.filter(g =>
        (g.status === 'playing' && !g.my_plan_submitted) ||
        (g.status === 'waiting' && !g.my_plan_submitted)
      );
      if (!actionable.length) { box.style.display = 'none'; return; }

      box.style.display = '';
      list.innerHTML = '';
      for (const g of actionable) {
        const factionSymbol = g.my_faction === 'hero' ? '⚔' : '✦';
        const item = document.createElement('div');
        item.className = 'menu-async-item';

        const ago = g.updated_at ? _timeAgo(g.updated_at) : '';
        if (g.status === 'waiting') {
          item.innerHTML = `<span>${factionSymbol} New game — plan your first turn</span>
            <span class="menu-async-deadline">${ago}</span>`;
        } else {
          const deadline = g.turn_deadline ? _timeRemaining(g.turn_deadline) : '';
          item.innerHTML = `<span>${factionSymbol} vs ${_esc(g.opponent_name)}</span>
            <span class="menu-async-deadline">${deadline}${deadline && ago ? ' · ' : ''}${ago}</span>`;
        }
        item.addEventListener('click', () => {
          _ensureAuthed(() => _openAsyncGame(g.room_id));
        });
        list.appendChild(item);
      }
    })
    .catch(() => { box.style.display = 'none'; });
}

/** State for the currently open async game. */
let _asyncRoomId = null;
let _asyncFaction = null;
let _asyncLastRound = null;   // { roundNum, preState, steps, postState }
let _asyncSeenRound = 0;      // round number whose replay the player has already watched

function _openAsyncGame(roomId) {
  _asyncRoomId = roomId;
  requestNotificationPermission();
  _ensureAuthed(() => {
    mp.connectAsync(roomId);
  });
}

// ── Async: connect / state update ──────────────────────────────────────────

function _handleAsyncStateUpdate(msg) {
  // Clean up any stale UI state from a previous connection / interrupted animation
  setMode(AppMode.PLANNING);
  const resultDlg = document.getElementById('result-dialog');
  if (resultDlg) resultDlg.style.display = 'none';
  ui?.exitPlanningMode();

  _asyncRoomId  = msg.roomId;
  _asyncFaction = msg.faction;

  const mirror = MirrorState.fromSnapshot(msg.state);
  mirror.myFaction = msg.faction;

  // Don't set planningPhase yet — we control that explicitly below
  mirror.planningPhase = false;

  // Set up MP client state
  mp.myFaction  = msg.faction;
  mp.myPlayerId = msg.myPlayerId;
  mp.roomId     = msg.roomId;
  mp.active     = true;

  // Store last round replay data (if available).
  // The server state IS the post-resolution state, so use it as postState.
  if (msg.lastRound) {
    _asyncLastRound = {
      roundNum:  msg.lastRound.roundNum,
      preState:  msg.lastRound.preStateJson,
      steps:     JSON.parse(msg.lastRound.stepsJson),
      postState: msg.state,  // server snapshot = post-resolution
    };
  } else {
    _asyncLastRound = null;
  }

  // Init the game view with the server's current (post-resolution) state
  if (!renderer || !ui) {
    try {
      initOnline(mirror, msg.faction, mp);
    } catch (err) {
      console.error('initOnline (async) failed:', err);
      _onlineError(`Failed to load game: ${err.message}`);
      _showAsyncScreen();
      return;
    }
  } else {
    Object.assign(state, mirror);
    state.hero      = mirror.hero;
    state.witch     = mirror.witch;
    state.myFaction = msg.faction;
    redrawOnline();
  }

  _updateAsyncReplayBtn();

  // ── Finished / abandoned games ──
  if (msg.gameStatus === 'finished' || msg.gameStatus === 'abandoned') {
    if (_asyncLastRound && _asyncSeenRound < _asyncLastRound.roundNum) {
      _showAsyncTurnChoice(_asyncLastRound.roundNum, _asyncLastRound, () => {
        const label = msg.winner === msg.faction ? 'Victory' : (msg.winner ? 'Defeat' : 'Game Over');
        ui?._showResultDialog([label, msg.winReason || '']);
      });
    } else {
      const label = msg.winner === msg.faction ? 'Victory' : (msg.winner ? 'Defeat' : 'Game Over');
      ui?._showResultDialog([label, msg.winReason || '']);
    }
    return;
  }

  // Notify if it's the player's turn (plan not yet submitted)
  if (!msg.myPlanSubmitted) {
    const idleOpts = msg.wasIdleLastRound ? { wasIdle: true, faction: _asyncFaction } : undefined;
    notifyRoundReady(mirror.round ?? 1, idleOpts);
  }

  // ── Active game: unseen last round → offer replay before planning ──
  if (_asyncLastRound && _asyncSeenRound < _asyncLastRound.roundNum) {
    _showAsyncTurnChoice(_asyncLastRound.roundNum, _asyncLastRound, () => _enterAsyncPlanning(msg));
  } else {
    _enterAsyncPlanning(msg);
  }
}

// ── Async: planning & waiting ──────────────────────────────────────────────

/** Enter planning mode or show waiting state. */
function _enterAsyncPlanning(msg) {
  if (msg.myPlanSubmitted) {
    // WAIT MODE — show submitted plan in read-only view (same as post-submit in sync MP)
    const budget = msg.myActionsLeft ?? 3;
    ui?.enterPlanningMode(msg.faction, budget, 0);
    // Apply server planStatus so checkmarks show who has submitted
    _applyPlanStatus(msg.planStatus);
    // Load the submitted plan actions into the UI so the player can review them
    if (ui && Array.isArray(msg.myPlanActions) && msg.myPlanActions.length > 0) {
      ui._unitPlans = groupPlanByEntity(msg.myPlanActions);
      ui._refreshPlanOverlay();
      ui._renderPlanPanel();
    }
    // Mark as submitted — puts the panel into read-only "Waiting for opponents…" state
    ui?.markPlanSubmitted();
  } else {
    // PLAN MODE — enter planning, wire submit
    ui?.exitPlanningMode();
    const budget = msg.myActionsLeft ?? 3;
    ui?.enterPlanningMode(msg.faction, budget, 0);
    // Apply server planStatus so checkmarks show who has already submitted
    _applyPlanStatus(msg.planStatus);
    if (ui) ui.onPlanSubmit = (plan) => mp.submitAsyncPlan(msg.roomId, plan);
  }
}

/** Apply planStatus array from the server to the UI player list. */
function _applyPlanStatus(planStatus) {
  if (!ui || !Array.isArray(planStatus)) return;
  for (const ps of planStatus) {
    const p = ui._players?.find(pl => pl.playerId === ps.playerId || pl.id === ps.playerId);
    if (p) p._submitted = !!ps.submitted;
  }
  ui._renderPlayerStatus();
}

function _handleAsyncPlanAccepted(_msg) {
  // Transition to WAIT MODE — keep plan panel visible in read-only state
  ui?.markPlanSubmitted();
}

function _handleAsyncOpponentJoined(msg) {
  if (_asyncRoomId === msg.roomId && mp) {
    mp.connectAsync(msg.roomId);
  }
}

// ── Async: resolution ──────────────────────────────────────────────────────

/**
 * Handle live resolution arriving while connected.
 * The message contains both the pre-state and post-state needed for replay.
 */
function _handleAsyncResolution({ roomId, steps, finalState, finalStateSnapshot, resolvedRound, preStateJson, timedOutPlayerIds }) {
  if (!state || !renderer) return;

  // Store replay data with the raw server snapshot as postState
  _asyncLastRound = {
    roundNum:  resolvedRound,
    preState:  preStateJson,
    steps,
    postState: finalStateSnapshot,
  };
  _updateAsyncReplayBtn();

  // Exit planning UI
  ui?.exitPlanningMode();

  // Show the turn choice dialog. afterFn applies final state + enters planning.
  _showAsyncTurnChoice(resolvedRound, _asyncLastRound, () => {
    // Apply the final (post-resolution) state
    Object.assign(state, finalState);
    state.hero      = finalState.hero;
    state.witch     = finalState.witch;
    state.myFaction = _asyncFaction;
    redrawOnline();

    if (state.gameOver) {
      notifyGameOver(state.winner === _asyncFaction);
      ui?._showResultDialog([
        state.winner === _asyncFaction ? 'Victory' : 'Defeat',
        state.winReason || '',
      ]);
    } else {
      // Enter PLAN MODE for the new round
      const wasIdle = timedOutPlayerIds?.includes(mp?.myPlayerId);
      notifyRoundReady(resolvedRound + 1, wasIdle ? { wasIdle: true, faction: _asyncFaction } : undefined);
      const budget = state.playerActionsLeft?.[mp?.myPlayerId] ??
                     state[_asyncFaction + 'ActionsLeft'] ?? 3;
      ui?.enterPlanningMode(_asyncFaction, budget, 0);
      if (ui) ui.onPlanSubmit = (plan) => mp.submitAsyncPlan(_asyncRoomId, plan);
    }
  });
}

// ── Async: turn choice dialog ──────────────────────────────────────────────

/**
 * Show dialog with two options:
 *  - Watch Last Turn (default): animate like online MP, then call afterFn
 *  - Plan Next Turn: skip straight to afterFn
 */
function _showAsyncTurnChoice(roundNum, lastRound, afterFn) {
  if (!ui) { afterFn(); return; }

  const dialog = document.getElementById('result-dialog');
  const msgs   = document.getElementById('result-messages');
  const hint   = document.getElementById('result-dismiss-hint');
  const btns   = document.getElementById('result-buttons');
  const portrait = document.getElementById('result-portrait');
  if (!dialog) { afterFn(); return; }

  msgs.textContent = `Round ${roundNum} has been resolved.`;
  hint.style.display = 'none';
  if (portrait) { portrait.style.display = 'none'; portrait.innerHTML = ''; }
  btns.innerHTML = '';
  btns.style.display = '';

  const watchBtn = document.createElement('button');
  watchBtn.className = 'setup-btn primary';
  watchBtn.textContent = 'Watch Last Turn';

  const planBtn = document.createElement('button');
  planBtn.className = 'setup-btn secondary';
  planBtn.textContent = 'Plan Next Turn';

  btns.appendChild(watchBtn);
  btns.appendChild(planBtn);
  dialog.style.display = 'flex';

  const dismiss = () => { dialog.style.display = 'none'; };

  watchBtn.addEventListener('click', () => {
    dismiss();
    _asyncSeenRound = roundNum;
    _asyncWatchLastTurn(lastRound).then(afterFn);
  }, { once: true });

  planBtn.addEventListener('click', () => {
    dismiss();
    _asyncSeenRound = roundNum;
    afterFn();
  }, { once: true });
}

/** Show or hide the "Replay Last Turn" button in the game menu. */
function _updateAsyncReplayBtn() {
  const btn = document.getElementById('menu-replay-turn-btn');
  if (!btn) return;
  btn.style.display = _asyncLastRound ? '' : 'none';
}

// ── Async: watch last turn (animation) ─────────────────────────────────────

/**
 * Animate the last resolved round exactly like online MP:
 *  1. Restore pre-resolution state
 *  2. Run _animateResolutionSteps with post-resolution entities as targets
 *  3. Apply post-resolution state
 *  4. Show resolution summary
 *
 * lastRound must contain: { preState, steps, postState, roundNum }
 * where postState is the serialized state AFTER resolution.
 */
async function _asyncWatchLastTurn(lastRound) {
  if (!lastRound || !state || !renderer || !ui) return;

  resetPlayback();

  const { preState, steps, postState } = lastRound;

  // ── Debug: log replay data so we can verify the server is sending actions ──
  const stepsArr = typeof steps === 'string' ? JSON.parse(steps) : steps;
  console.group('[async-replay] Watch Last Turn — data check');
  console.log('roundNum:', lastRound.roundNum);
  console.log('preState present:', !!preState, typeof preState);
  console.log('postState present:', !!postState, typeof postState);
  console.log('steps count:', stepsArr.length);
  for (let i = 0; i < stepsArr.length; i++) {
    const s = stepsArr[i];
    const allEvents = [
      ...(s.heroEvents ?? []),
      ...(s.witchEvents ?? []),
      ...(s.playerEvents ?? []).flatMap(pe => pe.events ?? []),
    ];
    const entityCount = s.entitySnapshot?.length ?? 0;
    console.log(`  step[${i}]: ${allEvents.length} events, ${entityCount} entities in snapshot`, s);
  }
  console.log('replay flags:', { goBack: playback.goBack, aborted: playback.aborted, jumpToEnd: playback.jumpToEnd, mode: getMode(), _autoplay });
  console.groupEnd();

  // Parse the post-resolution state — this is our animation target
  const postResState = MirrorState.fromSnapshot(
    typeof postState === 'string' ? JSON.parse(postState) : postState
  );
  const finalEntities = postResState.entities ?? [];

  console.log('[async-replay] finalEntities count:', finalEntities.length,
    'positions:', finalEntities.slice(0, 4).map(e => `${e.type}@${e.col},${e.row}`));

  // Restore pre-resolution state so the animation starts from the right positions.
  // Must use MirrorState (not deserializeState) because state is a MirrorState in
  // online/async mode — GameState has frozen properties that can't be assigned.
  const preResState = MirrorState.fromSnapshot(
    typeof preState === 'string' ? JSON.parse(preState) : preState
  );
  Object.assign(state, preResState);
  state.hero      = preResState.hero;
  state.witch     = preResState.witch;
  state.myFaction = _asyncFaction;
  redrawOnline();

  console.log('[async-replay] pre-state entities:', state.entities?.slice(0, 4).map(e => `${e.type}@${e.col},${e.row}`));

  // Animate — entities slide from pre-state positions to post-state positions
  await _animateResolutionSteps(stepsArr, finalEntities, redrawOnline, _asyncFaction, mp?.myPlayerId ?? null);
  console.log('[async-replay] animation complete');

  // Apply post-resolution state (phase, round, score, tiles, etc.)
  Object.assign(state, postResState);
  state.hero      = postResState.hero;
  state.witch     = postResState.witch;
  state.myFaction = _asyncFaction;

  await ui._triggerPostRoundEffects();
  redrawOnline();

  // If skip was pressed mid-animation, bail out entirely (skip summary)
  if (playback.jumpToEnd) {
    resetPlayback();
    return;
  }

  // Show resolution summary with replay support
  if (ui && _asyncFaction) {
    setMode(AppMode.RESOLVING);
    let action;
    do {
      action = await ui._showResolutionSummary(stepsArr, lastRound.roundNum ?? (state.round - 1), {
        humanFaction: _asyncFaction,
        fogOfWar: state.fogOfWar,
        gameOver: state.gameOver,
        winner: state.winner,
        winReason: state.winReason,
      });
      if (action === 'replay') {
        // Restore pre-resolution state and re-animate
        const replayPre = MirrorState.fromSnapshot(
          typeof preState === 'string' ? JSON.parse(preState) : preState
        );
        Object.assign(state, replayPre);
        state.hero      = replayPre.hero;
        state.witch     = replayPre.witch;
        state.myFaction = _asyncFaction;
        redrawOnline();
        await _animateResolutionSteps(stepsArr, finalEntities, redrawOnline, _asyncFaction, mp?.myPlayerId ?? null);
        // Restore post-resolution state after replay
        Object.assign(state, postResState);
        state.hero      = postResState.hero;
        state.witch     = postResState.witch;
        state.myFaction = _asyncFaction;
        await ui._triggerPostRoundEffects();
        redrawOnline();
        setMode(AppMode.RESOLVING);
      }
    } while (action === 'replay');
    setMode(AppMode.PLANNING);
  }

  resetPlayback();
}

function _handleAsyncPlanStatus(msg) {
  // Notify when we're the last unsubmitted player ("Waiting on you!")
  if (Array.isArray(msg.planStatus)) {
    const myStatus = msg.planStatus.find(ps => ps.playerId === mp?.myPlayerId);
    const othersAllSubmitted = msg.planStatus
      .filter(ps => ps.playerId !== mp?.myPlayerId)
      .every(ps => ps.submitted);
    if (othersAllSubmitted && myStatus && !myStatus.submitted) {
      notifyWaitingOnYou();
    }
  }
  _applyPlanStatus(msg.planStatus);
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

// ── Full-game replay helpers ─────────────────────────────────────────────────
// Core replay engine lives in ./playback.js; these helpers bridge it to main.js globals.

/** Mutable reference bag passed to replayFullGame so it can swap state/renderer/ui. */
function _replayRefs() { return { state, renderer, ui }; }

/** Wrapper: swapState using the local module globals. */
function _swapState(newState) {
  const refs = { state, renderer, ui };
  swapState(refs, newState);
  state = refs.state;
}

async function _replayFullGame(rounds, winner, winReason, heroName, witchName, redrawFn, opts = {}) {
  const refs = _replayRefs();
  // Wrap the animation function so the module-level `state` stays in sync
  // with refs.state.  playback.js calls swapState(refs, preState) before each
  // round, which updates refs.state / renderer.state / ui.state but can't
  // touch the module-level variable.  _animateResolutionSteps reads/writes
  // that variable directly, so we must sync it before every invocation.
  const syncedAnimateFn = async (...args) => {
    state = refs.state;
    return _animateResolutionSteps(...args);
  };
  await replayFullGame(refs, rounds, winner, winReason, heroName, witchName,
    syncedAnimateFn, redrawFn ?? redraw, opts);
  // Sync module-level state back from refs (replayFullGame swaps it internally)
  state = refs.state;
}

/* The ~220-line _replayFullGame body was extracted to src/playback.js.
   The thin wrapper above delegates to replayFullGame() from that module. */

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
    // Determine player count and title
    let players;
    try { players = JSON.parse(g.players_json || '[]'); } catch { players = []; }
    const pps = players.length > 0
      ? players.filter(p => p.faction === 'hero').length
      : 1;

    let myFaction;
    if (players.length > 0) {
      const mySeat = players.find(p => p.playerId === session?.id);
      myFaction = mySeat?.faction ?? 'hero';
    } else {
      myFaction = g.hero_player_id === session?.id ? 'hero' : 'witch';
    }

    let title;
    if (pps > 1) {
      title = `${pps}v${pps} Game`;
    } else {
      title = `${_esc(g.hero_name)} vs ${_esc(g.witch_name)}`;
    }

    const winnerLabel = g.winner === myFaction ? 'Victory' : 'Defeat';
    const winnerIcon  = g.winner === 'hero' ? '⚔' : '✦';
    const ago = _timeAgo(g.created_at);
    const entry = document.createElement('div');
    entry.className = 'save-entry';
    entry.innerHTML = `
      <div class="save-entry-info">
        <div class="save-entry-title">${winnerIcon} ${title} — ${winnerLabel}</div>
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

    // Convert server round format { round_num, pre_state_json, steps_json, final_entities_json } → replay format
    const replayRounds = rounds.map(r => ({
      roundNum:      r.round_num,
      preState:      r.pre_state_json,
      steps:         r.steps_json,
      finalEntities: r.final_entities_json ? JSON.parse(r.final_entities_json) : undefined,
    }));

    await _replayFullGame(replayRounds, gameMeta.winner, gameMeta.win_reason,
      gameMeta.hero_name, gameMeta.witch_name);

    // Return to online screen after replay
    document.getElementById('setup-screen').style.display = '';
    document.getElementById('game-screen').style.display  = 'none';
    state = null; renderer = null; ui = null;
    _showOnlineScreen();
  });
}

// ── Multiplayer screen ────────────────────────────────────────────────────────

function _showOnlineScreen() {
  if (mp?.connected) mp.clearRoom();
  // Clear game state so the next onState triggers initOnline
  setMode(AppMode.MENU);
  state    = null;
  renderer = null;
  ui       = null;
  document.getElementById('game-screen').style.display  = 'none';
  document.getElementById('setup-screen').style.display = '';
  showStep('online');
  _initMpStep();
  const session = loadSession();
  if (session) {
    _fetchActiveSaves();
    _fetchCompletedGames();
    _updateMultiplayerBadge();
  }
}

function _showAsyncScreen() {
  showStep('async');
  _initAsyncStep();
  const session = loadSession();
  if (session) {
    _fetchAsyncGames();
    _updateMultiplayerBadge();
  }
}

// ── Battle for Caleb's Hollow menu ───────────────────────────────────────────

function _formatTimeRemaining(unixSeconds) {
  const diff = unixSeconds - Math.floor(Date.now() / 1000);
  if (diff <= 0) return 'Ended';
  const days  = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const mins  = Math.floor((diff % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

async function _showBattleScreen() {
  showStep('battle');

  const session    = loadSession();
  const signedOut  = document.getElementById('battle-signed-out');
  const battleInfo = document.getElementById('battle-info');
  const statusLine = document.getElementById('battle-status-line');
  const joinBtn    = document.getElementById('btn-battle-join');
  const spectateBtn = document.getElementById('btn-battle-spectate');

  // Reset dynamic elements
  joinBtn.style.display = 'none';
  spectateBtn.style.display = 'none';
  document.getElementById('battle-my-status').style.display = 'none';
  document.getElementById('battle-game-info').style.display = 'none';
  document.getElementById('battle-players-section').style.display = 'none';

  if (!session) {
    signedOut.style.display = '';
    battleInfo.style.display = 'none';
    return;
  }
  signedOut.style.display = 'none';
  battleInfo.style.display = '';
  statusLine.textContent = 'Loading...';

  let _battleStatus = null;
  try {
    const base = window.BRIMSTONE_SERVER || '';
    const url = session?.token
      ? `${base}/api/battle-status?token=${encodeURIComponent(session.token)}`
      : `${base}/api/battle-status`;
    const res = await fetch(url);
    _battleStatus = await res.json();
    const status = _battleStatus;
    if (!status) {
      statusLine.textContent = 'No active battle right now. A new one will begin soon.';
      return;
    }

    const my = status.myBattle; // player's own battle room, or null

    if (my) {
      // ── Player is in a battle ─────────────────────────────────────────
      statusLine.textContent = '';

      // Game info box — show the player's battle
      const gameInfo = document.getElementById('battle-game-info');
      gameInfo.style.display = '';
      document.getElementById('battle-hero-score').textContent = my.heroScore;
      document.getElementById('battle-witch-score').textContent = my.witchScore;
      const hLabel = my.heroCount === 1 ? 'hero' : 'heroes';
      const wLabel = my.witchCount === 1 ? 'witch' : 'witches';
      const battlesNote = status.totalBattles > 1 ? ` · ${status.totalBattles} battles active` : '';
      document.getElementById('battle-meta-line').textContent =
        `Round ${my.round} · ${my.heroCount} ${hLabel} vs ${my.witchCount} ${wLabel} · Ends in ${_formatTimeRemaining(status.endsAt)}${battlesNote}`;

      // Your status box
      const myBox = document.getElementById('battle-my-status');
      myBox.style.display = '';
      const fIcon = my.myFaction === 'hero' ? '⚔' : '✦';
      const fName = my.myFaction === 'hero' ? 'Hero' : 'Witch';
      document.getElementById('battle-my-faction').innerHTML =
        `<span style="color:var(--${my.myFaction})">${fIcon} Fighting as ${fName}</span>`;
      if (my.mySubmitted) {
        document.getElementById('battle-my-plan-status').innerHTML =
          '<span style="color:var(--green)">✓ Plan submitted</span>';
      } else {
        document.getElementById('battle-my-plan-status').innerHTML =
          '<span style="color:var(--day)">⚠ Plan not yet submitted</span>';
      }
      if (my.turnDeadline) {
        const deadlineEl = document.getElementById('battle-my-deadline');
        const secsLeft = my.turnDeadline - Math.floor(Date.now() / 1000);
        deadlineEl.textContent = '⏱ Deadline in ' + _formatTimeRemaining(my.turnDeadline);
        deadlineEl.style.color = secsLeft <= 1800 ? 'var(--red)' : 'var(--text-dim)';
      }

      // Action buttons
      joinBtn.dataset.roomId = my.roomId;
      spectateBtn.dataset.roomId = my.roomId;
      joinBtn.style.display = '';
      joinBtn.textContent = 'Return to Battle';

      // Player list (collapsible)
      const playersSection = document.getElementById('battle-players-section');
      if (my.players?.length > 0) {
        playersSection.style.display = '';
        const playerData = my.players.map(p => ({
          playerId: p.playerId, name: p.name, faction: p.faction,
          color: p.color,
          isAI: p.isAI, _submitted: p.submitted,
          connected: p.connected, active: p.active,
        }));
        const myPlayerId = mp?.myPlayerId ?? session?.id ?? null;
        const nudgeCtx = myPlayerId ? { myPlayerId, nudgedSet: new Set() } : undefined;
        document.getElementById('battle-players-list').innerHTML = buildPlayerStatusHtml(playerData, nudgeCtx);

        // Wire nudge buttons
        document.getElementById('battle-players-list').addEventListener('click', (e) => {
          const btn = e.target.closest('.nudge-btn[data-nudge-id]');
          if (!btn || btn.disabled) return;
          const targetId = btn.dataset.nudgeId;
          if (mp?.connected) {
            mp.sendNudge(targetId);
            btn.disabled = true;
            btn.classList.add('nudge-sent');
          }
        });
      }
    } else if (status.allFull) {
      // ── All battles are full ──────────────────────────────────────────
      const n = status.totalBattles;
      statusLine.textContent = `${n} battle${n !== 1 ? 's' : ''} in progress — all full`;
      spectateBtn.style.display = '';
      // Pick any room for spectating
      if (status.battles.length > 0) spectateBtn.dataset.roomId = status.battles[0].roomId;
    } else {
      // ── Player can join ───────────────────────────────────────────────
      const n = status.totalBattles;
      const totalPlayers = status.totalHeroes + status.totalWitches;
      if (n > 0) {
        statusLine.textContent = `${n} battle${n !== 1 ? 's' : ''} in progress (${totalPlayers} players) — join a faction!`;
      } else {
        statusLine.textContent = 'Battle in progress — join a faction!';
      }
      // No roomId — server will auto-select the best room
      joinBtn.dataset.roomId = '';
      joinBtn.style.display = '';
      joinBtn.textContent = 'Join the Battle';
    }
  } catch (err) {
    statusLine.textContent = 'Could not load battle status.';
  }

  // Update main menu badge
  const badge = document.getElementById('battle-badge');
  if (badge) {
    if (_battleStatus?.myBattle && !_battleStatus.myBattle.mySubmitted) {
      badge.style.display = '';
      badge.textContent = '!';
    } else {
      badge.style.display = 'none';
    }
  }

  // Past battles (collapsible table, default closed)
  try {
    const historyEl = document.getElementById('battle-history');
    const bodyEl    = document.getElementById('battle-history-body');
    const histRes = await fetch(`${window.BRIMSTONE_SERVER || ''}/api/battle-history${session?.token ? '?token=' + encodeURIComponent(session.token) : ''}`);
    const battles = await histRes.json();
    if (battles && battles.length > 0) {
      historyEl.style.display = '';
      bodyEl.innerHTML = battles.map(b => {
        const date = new Date(b.created_at * 1000).toLocaleDateString();
        const result = b.winner === 'draw' ? 'Draw'
          : (b.winner === 'hero' ? 'Heroes won' : 'Witches won');
        // Color-code rows based on player's faction
        let rowClass = '';
        if (b._myFaction) {
          if (b.winner !== 'draw') {
            rowClass = b.winner === b._myFaction ? 'battle-history-win' : 'battle-history-loss';
          }
        }
        return `<tr class="${rowClass}" style="border-bottom:1px solid rgba(255,255,255,0.04)">
          <td style="padding:0.3rem">${date}</td>
          <td style="padding:0.3rem">${result}</td>
          <td style="padding:0.3rem;text-align:right">${b.total_rounds}</td>
          <td style="padding:0.3rem;text-align:right">
            <a href="/replay?replayGame=${encodeURIComponent(b.game_id)}&source=mp" target="_blank"
               class="setup-btn" style="padding:0.15rem 0.5rem;font-size:0.7rem">Replay</a>
          </td>
        </tr>`;
      }).join('');
    } else {
      historyEl.style.display = 'none';
    }
  } catch { /* ignore */ }
}

// Sign-in button on the battle screen — open the auth dialog and return to
// the battle screen on success (previous behavior routed to Account and
// never came back).
document.getElementById('btn-battle-signin')?.addEventListener('click', () => {
  _showAuthDialog(() => _showBattleScreen());
});

document.getElementById('btn-battle-main')?.addEventListener('click', () => _showBattleScreen());
document.getElementById('btn-battle-back')?.addEventListener('click', () => showStep('mode'));
document.getElementById('btn-battle-join')?.addEventListener('click', function() {
  const roomId = this.dataset.roomId || null;  // empty string → null for auto-select
  // Tear down everything — kill any in-flight reconnect, destroy old UI
  if (ui) ui.destroy();
  state = null; renderer = null; ui = null;
  _stopBattleCountdownTimer();
  document.getElementById('game-screen').style.display = 'none';
  // Disconnect the old mp client entirely to cancel any pending reconnect
  // that could race with joinBattle and create duplicate handlers.
  if (mp) { mp.disconnect(); mp = null; }
  _ensureAuthed(() => {
    mp.joinBattle(roomId);
  });
});
document.getElementById('btn-battle-spectate')?.addEventListener('click', function() {
  const roomId = this.dataset.roomId;
  if (!roomId) return;
  initSpectator(roomId);
});

document.getElementById('btn-online-back').addEventListener('click', () => {
  if (mp) { mp.disconnect(); mp = null; }
  renderer = null; ui = null; state = null;
  showStep('mode');
  _updateMultiplayerBadge();
});
document.getElementById('btn-async-back')?.addEventListener('click', () => {
  showStep('mode');
  _updateMultiplayerBadge();
});
document.getElementById('btn-async-refresh')?.addEventListener('click', () => {
  _fetchAsyncGames();
});

// ── Online flow ───────────────────────────────────────────────────────────────

document.getElementById('btn-cancel-wait').addEventListener('click', () => {
  _showOnlineScreen();
});

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
  showStep('online');
});

document.getElementById('btn-create-game-confirm').addEventListener('click', () => {
  _ensureAuthed(() => {
    const isAsync = document.querySelector('input[name="cg-mode"]:checked')?.value === 'async';
    const timeoutEl = isAsync
      ? document.getElementById('cg-turn-timeout-async')
      : document.getElementById('cg-turn-timeout-live');
    const config = {
      fog:            document.getElementById('cg-fog').value,
      mapSize:        document.getElementById('cg-map-size').value,
      nodeCount:      parseInt(document.getElementById('cg-node-count')?.value ?? '3', 10),
      playersPerSide: parseInt(document.querySelector('input[name="cg-pps"]:checked')?.value ?? '1', 10),
      isPrivate:      document.getElementById('cg-private').checked,
      isAsync,
      turnIntervalMs: parseInt(timeoutEl?.value ?? '90000', 10),
      aiDifficulty:   document.getElementById('cg-ai-difficulty')?.value ?? 'normal',
    };
    mp.createLobby(config);
    // Transition to lobby card happens in onLobbyJoined callback
  });
});

// Mode toggle — swap timeout dropdowns
function _updateCreateGameMode() {
  const isAsync = document.querySelector('input[name="cg-mode"]:checked')?.value === 'async';
  const liveEl  = document.getElementById('cg-turn-timeout-live');
  const asyncEl = document.getElementById('cg-turn-timeout-async');
  if (liveEl)  liveEl.style.display  = isAsync ? 'none' : '';
  if (asyncEl) asyncEl.style.display = isAsync ? '' : 'none';
}

for (const radio of document.querySelectorAll('input[name="cg-mode"]')) {
  radio.addEventListener('change', _updateCreateGameMode);
}

// ── Join Game flow ────────────────────────────────────────────────────────────

document.getElementById('btn-join-game').addEventListener('click', () => {
  _ensureAuthed(() => {
    showStep('join-game');
    _loadPublicLobbies();
  });
});

document.getElementById('btn-join-game-back').addEventListener('click', () => {
  showStep('online');
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

function _getAsyncFaction() {
  const checked = document.querySelector('input[name="async-faction"]:checked');
  return checked ? checked.value : 'hero';
}

document.getElementById('btn-create-async')?.addEventListener('click', () => {
  _ensureAuthed(() => {
    showStep('async-create');
    // Default faction radio to hero
    const heroRadio = document.querySelector('input[name="async-faction"][value="hero"]');
    if (heroRadio) heroRadio.checked = true;
  });
});

document.getElementById('btn-join-async')?.addEventListener('click', () => {
  _ensureAuthed(() => {
    showStep('async-join');
  });
});

document.getElementById('btn-async-create-back')?.addEventListener('click', () => {
  showStep('async');
});

document.getElementById('btn-async-create-go')?.addEventListener('click', () => {
  _ensureAuthed(() => {
    const session = loadSession();
    const base = window.BRIMSTONE_SERVER || '';
    fetch(`${base}/api/async-games`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token:        session.token,
        faction:      _getAsyncFaction(),
        mapSize:      document.getElementById('async-map-size').value,
        fog:          document.getElementById('async-fog').value,
        turnInterval: Number(document.getElementById('async-turn-interval').value),
        inviteeEmail: document.getElementById('async-invitee-email').value.trim(),
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
        // Show invite confirmation if an email was specified
        const inviteMsg = document.getElementById('async-invite-sent');
        const invEmail = document.getElementById('async-invitee-email').value.trim();
        if (invEmail && inviteMsg) {
          inviteMsg.textContent = `Invite sent to ${invEmail}`;
          inviteMsg.style.display = '';
        } else if (inviteMsg) {
          inviteMsg.style.display = 'none';
        }
        // Store roomId so host can open the game to plan
        document.getElementById('btn-async-created-play')?.setAttribute('data-room-id', result.roomId);
      })
      .catch(() => _onlineError('Failed to create async game.'));
  });
});

document.getElementById('btn-async-copy-code')?.addEventListener('click', () => {
  const code = document.getElementById('async-game-code').textContent;
  navigator.clipboard?.writeText(code);
  const btn = document.getElementById('btn-async-copy-code');
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = 'Copy Code'; }, 1500);
});

document.getElementById('btn-async-copy-link')?.addEventListener('click', () => {
  const code = document.getElementById('async-game-code').textContent;
  const inviteUrl = `${_linkOrigin()}#invite=${encodeURIComponent(code)}`;
  navigator.clipboard?.writeText(inviteUrl);
  const btn = document.getElementById('btn-async-copy-link');
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = '📋 Copy Invite Link'; }, 1500);
});

document.getElementById('btn-async-created-done')?.addEventListener('click', () => {
  _showAsyncScreen();
});

document.getElementById('btn-async-created-play')?.addEventListener('click', () => {
  const roomId = document.getElementById('btn-async-created-play').getAttribute('data-room-id');
  if (roomId) _openAsyncGame(roomId);
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
  _ensureAuthed(() => _joinAsyncByCode(code));
});

document.getElementById('btn-async-join-back')?.addEventListener('click', () => {
  showStep('async');
});

/** Join an async game by 6-char code (used by both the UI button and deep links). */
function _joinAsyncByCode(code) {
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
        // Show error in the async join card if visible, otherwise alert
        const err = document.getElementById('async-join-error');
        if (err) {
          err.textContent = result.error;
          err.style.display = '';
          showStep('async-join');
          const input = document.getElementById('async-join-code');
          if (input) input.value = code;
        } else {
          alert(result.error);
        }
        return;
      }
      _openAsyncGame(result.roomId);
    })
    .catch(() => {
      alert('Failed to join async game.');
    });
}

// ── Deep link handling for async games ──────────────────────────────────────

function _checkAsyncDeepLink() {
  const hash = window.location.hash;

  // Unified deep link: #game=<roomId> — resume via unified lobby
  const gameMatch = hash.match(/^#game=(.+)$/);
  if (gameMatch) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    _resumeSave(gameMatch[1]);
    return true;
  }

  // Legacy deep link: #async=<roomId> — route through async UI for backward compat
  const asyncMatch = hash.match(/^#async=(.+)$/);
  if (asyncMatch) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    const roomId = asyncMatch[1];
    _showAsyncScreen();
    setTimeout(() => _openAsyncGame(roomId), 500);
    return true;
  }
  const inviteMatch = hash.match(/^#invite=(.+)$/);
  if (inviteMatch) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    const code = decodeURIComponent(inviteMatch[1]);

    const session = loadSession();
    if (session) {
      // Already signed in — auto-join via lobby code
      _ensureAuthed(() => {
        mp.joinLobby(code);
      });
    } else {
      // Not signed in — show auth dialog, then join
      _showAuthDialog(() => {
        _ensureAuthed(() => {
          mp.joinLobby(code);
        });
      });
    }
    return true;
  }
  return false;
}

// ── Auth dialog callback (hoisted for deep link access) ─────────────────────
let _authDialogCallback = null;

// ── Deep link handling for online game lobbies ───────────────────────────────

function _checkGameDeepLink() {
  const hash = window.location.hash;
  const joinMatch = hash.match(/^#join=([^&]+)(?:&slot=(\d+))?$/);
  if (!joinMatch) return false;

  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  const codeOrId = decodeURIComponent(joinMatch[1]);
  const slotIndex = joinMatch[2] != null ? Number(joinMatch[2]) : undefined;

  // Ensure authenticated, then join the lobby
  const session = loadSession();
  if (session) {
    _ensureAuthed(() => mp.joinLobby(codeOrId, slotIndex));
  } else {
    // No session — show the auth dialog so the user can pick a username first
    _showAuthDialog(() => {
      _ensureAuthed(() => mp.joinLobby(codeOrId, slotIndex));
    });
  }
  return true;
}

// Check on page load (deferred if email_token auth is pending — see bottom of file)
{
  const params = new URLSearchParams(window.location.search);
  if (!params.has('email_token')) {
    _checkGameDeepLink() || _checkAsyncDeepLink();
  }
}

// Handle deep links from push notification taps (sets hash then fires hashchange)
window.addEventListener('hashchange', () => {
  _checkGameDeepLink() || _checkAsyncDeepLink();
});
// Unified main-menu refresh — fetches games + battle status in parallel
// and updates the main menu list + multiplayer/battle badges as side effects.
_fetchMainMenuGames();
// Populate the inline Replays section on first paint (the welcome card is shown
// by default at boot without going through showStep('mode')).
_renderReplaysList();

/** Check if the player needs to submit a battle turn and show badge on main menu. */
async function _updateBattleBadge() {
  const badge = document.getElementById('battle-badge');
  if (!badge) return;
  const session = loadSession();
  if (!session?.token) { badge.style.display = 'none'; return; }
  try {
    const res = await fetch(`${window.BRIMSTONE_SERVER || ''}/api/battle-status?token=${encodeURIComponent(session.token)}`);
    const status = await res.json();
    if (status?.myBattle && !status.myBattle.mySubmitted) {
      badge.style.display = '';
      badge.textContent = '!';
    } else {
      badge.style.display = 'none';
    }
  } catch { badge.style.display = 'none'; }
}

/**
 * Fetch active games count and show a badge on the Multiplayer button
 * if any games are waiting for the player's turn.
 */
function _updateMultiplayerBadge() {
  const badge = document.getElementById('mp-badge');
  if (!badge) return;

  const session = loadSession();
  if (!session) { badge.style.display = 'none'; return; }

  const base = window.BRIMSTONE_SERVER || '';
  fetch(`${base}/api/games?token=${encodeURIComponent(session.token)}`)
    .then(r => r.json())
    .then(saves => {
      const count = saves.filter(s => s.action_needed).length;
      if (count > 0) {
        badge.textContent = String(count);
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
    })
    .catch(() => { badge.style.display = 'none'; });
}

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
    const open   = lobby.slots?.filter(s => s.status === 'empty').length ?? 0;
    const total  = lobby.slots?.length ?? pps * 2;
    const host   = lobby.slots?.find(s => s.playerId === lobby.hostPlayerId)?.name ?? 'Unknown';
    const mapLabel = size.charAt(0).toUpperCase() + size.slice(1);
    const isAsync  = lobby.config?.isAsync;
    const modeLabel = isAsync ? 'Async' : 'Live';

    const inProgress = lobby.roomStatus === 'playing';
    const statusLabel = inProgress ? 'In progress — join now' : `${total - open}/${total} players`;

    const entry = document.createElement('div');
    entry.className = 'save-entry save-entry-joinable';
    entry.innerHTML = `
      <div class="save-entry-info">
        <div class="save-entry-title">⚔ ${_esc(host)}'s game</div>
        <div class="save-entry-meta">${pps}v${pps} · ${_esc(mapLabel)} · ${modeLabel} · ${statusLabel}</div>
      </div>
    `;
    entry.addEventListener('click', () => {
      _ensureAuthed(() => mp.joinLobby(lobby.id));
    });
    list.appendChild(entry);
  }
}

// ── Lobby card ────────────────────────────────────────────────────────────────

const _HERO_PERSONALITIES  = ['balanced', 'aggressive', 'defensive', 'explorer'];
const _WITCH_PERSONALITIES = ['balanced', 'aggressive', 'swarm'];
const _PERSONALITY_LABELS  = {
  balanced: 'Balanced', aggressive: 'Aggressive', defensive: 'Defensive',
  explorer: 'Explorer', swarm: 'Swarm',
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

  // Invite link — use code for private games, room ID for public
  const joinKey = (lobby.isPrivate && lobby.code) ? lobby.code : lobby.id;
  const inviteUrl = new URL(`/join?code=${encodeURIComponent(joinKey)}`, _linkOrigin()).href;
  const copyBtn = document.getElementById('btn-lobby-copy-link');
  const copiedEl = document.getElementById('lobby-link-copied');
  copiedEl.style.display = 'none';
  // Replace button to clear old listeners
  const freshCopyBtn = copyBtn.cloneNode(true);
  copyBtn.parentNode.replaceChild(freshCopyBtn, copyBtn);
  freshCopyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(inviteUrl).then(() => {
      copiedEl.style.display = '';
      setTimeout(() => { copiedEl.style.display = 'none'; }, 2000);
    }).catch(() => {
      // Fallback: select a temporary input
      const tmp = document.createElement('input');
      tmp.value = inviteUrl;
      document.body.appendChild(tmp);
      tmp.select();
      document.execCommand('copy');
      document.body.removeChild(tmp);
      copiedEl.style.display = '';
      setTimeout(() => { copiedEl.style.display = 'none'; }, 2000);
    });
  });

  // Share button (iOS native only) — add/remove dynamically
  const linkWrap = document.getElementById('lobby-invite-link-wrap');
  linkWrap?.querySelector('.lobby-share-btn')?.remove();
  if (isNativeMobile && linkWrap) {
    const shareBtn = document.createElement('button');
    shareBtn.className = 'setup-btn lobby-share-btn';
    shareBtn.style.cssText = 'font-size:0.8rem;margin-left:0.3rem';
    shareBtn.textContent = '↗ Share';
    shareBtn.addEventListener('click', () => {
      shareInvite("Join my game of Caleb's Hollow!", inviteUrl);
    });
    linkWrap.insertBefore(shareBtn, copiedEl);
  }

  // Config summary
  const pps  = lobby.config?.playersPerSide ?? 1;
  const size = lobby.config?.mapSize ?? 'standard';
  const fogMode = lobby.config?.fog ?? 'partial';
  const fog  = fogMode === 'none' ? 'No fog' : `Fog: ${fogMode.charAt(0).toUpperCase() + fogMode.slice(1)}`;
  document.getElementById('lobby-config-summary').textContent =
    `${pps}v${pps} · ${size.charAt(0).toUpperCase() + size.slice(1)} · ${fog}`;

  // Derive state
  const myId          = mp?.player?.id;
  const isHost        = lobby.hostPlayerId === myId;
  const unassigned    = lobby.unassigned || [];
  const meUnassigned  = unassigned.some(u => u.playerId === myId);
  const meInSlot      = lobby.slots.some(s => s.playerId === myId && s.status === 'human');
  const canClaimSlot  = meUnassigned || meInSlot; // can click empty slots to join/switch

  // Slots grid
  const grid = document.getElementById('lobby-slots-grid');
  grid.innerHTML = '';

  // Unassigned players section
  if (unassigned.length > 0) {
    const unassignedSection = document.createElement('div');
    unassignedSection.className = 'lobby-unassigned';
    const names = unassigned.map(u => {
      const isMe = u.playerId === myId;
      return `<span class="lobby-unassigned-chip${isMe ? ' you' : ''}">${_esc(u.name)}${isMe ? ' <em>(you)</em>' : ''}</span>`;
    }).join(' ');
    unassignedSection.innerHTML =
      `<div class="lobby-unassigned-label">Pick a side</div>` +
      `<div class="lobby-unassigned-players">${names}</div>`;
    grid.appendChild(unassignedSection);
  }

  // Side columns. Today each side has one primary faction (Paladin / Witch)
  // — iterate slots by their `side` field, which defaults to 'day' / 'night'
  // via sideOf(faction) when the server builds the slot list.
  const daySlots   = lobby.slots.filter(s => s.side === 'day'   || s.faction === 'hero');
  const nightSlots = lobby.slots.filter(s => s.side === 'night' || s.faction === 'witch');

  const container = document.createElement('div');
  container.className = 'lobby-factions';

  for (const [label, icon, slots] of [['Day Side', '☀', daySlots], ['Night Side', '🌙', nightSlots]]) {
    const col = document.createElement('div');
    col.className = 'lobby-faction-col';
    col.innerHTML = `<div class="lobby-faction-label">${icon} ${label}</div>`;

    for (const slot of slots) {
      const row = document.createElement('div');
      row.className = 'lobby-slot-row';

      if (slot.status === 'human') {
        const isMe = slot.playerId === myId;
        row.innerHTML = `<span class="lobby-slot-name">${_esc(slot.name)}${isMe ? ' <em>(you)</em>' : ''}</span>` +
                        _lobbyFactionTag(slot, isMe);
        if (isMe) row.appendChild(_buildLobbyFactionPicker(lobby, slot));
      } else if (slot.status === 'ai') {
        row.innerHTML = `<span class="lobby-slot-name ai-slot">🤖 ${_esc(slot.name ?? 'AI')}</span>` +
                        _lobbyFactionTag(slot, false);
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
        // empty slot — clickable by current player to claim/switch
        row.innerHTML = `<span class="lobby-slot-name empty-slot">Open</span>`;
        if (canClaimSlot) {
          row.classList.add('claimable');
          row.addEventListener('click', (e) => {
            // Don't trigger when clicking host action buttons inside the row
            if (e.target.closest('.lobby-slot-actions')) return;
            const idx = lobby.slots.indexOf(slot);
            mp.claimSlot(lobby.id, idx);
          });
        }

        // Host actions (invite + AI selector) — shown below the slot row
        if (isHost) {
          const slotActions = document.createElement('div');
          slotActions.className = 'lobby-slot-actions';

          // Invite button
          const inviteBtn = document.createElement('button');
          inviteBtn.className = 'setup-btn secondary lobby-slot-btn';
          inviteBtn.textContent = '✉ Invite';
          inviteBtn.addEventListener('click', () => {
            const slotIdx = lobby.slots.indexOf(slot);
            _showSlotInvitePopup(lobby, slotIdx, slot.faction, inviteBtn);
          });
          slotActions.appendChild(inviteBtn);

          // AI selector
          const personalities = slot.faction === 'witch' ? _WITCH_PERSONALITIES : _HERO_PERSONALITIES;
          const select = document.createElement('select');
          select.className = 'setup-select lobby-personality-select';
          // Hero personalities (except balanced) are temporarily disabled pending tuning.
          select.innerHTML = '<option value="">— AI —</option>' +
            ['random', ...personalities].map(p => {
              const isWitch = slot.faction === 'witch';
              const disabled = !isWitch && p !== 'random' && p !== 'balanced';
              const lbl = p === 'random' ? 'Random' : (_PERSONALITY_LABELS[p] ?? p);
              return `<option value="${p}"${disabled ? ' disabled style="color:#666"' : ''}>${disabled ? `${lbl} (soon)` : lbl}</option>`;
            }).join('');
          select.addEventListener('change', () => {
            if (!select.value) return;
            const idx = lobby.slots.indexOf(slot);
            mp.setSlotAI(lobby.id, idx, select.value);
            select.value = '';
          });
          slotActions.appendChild(select);
          row.appendChild(slotActions);
        }
      }
      col.appendChild(row);
    }
    container.appendChild(col);
  }
  grid.appendChild(container);

  // Buttons — host only
  const startBtn    = document.getElementById('btn-lobby-start');
  const populateBtn = document.getElementById('btn-lobby-populate-ai');
  const hasEmpty    = lobby.slots.some(s => s.status === 'empty');

  if (isHost) {
    startBtn.style.display    = '';
    populateBtn.style.display = '';
    // Disable start/populate while anyone is unassigned
    const blocked = unassigned.length > 0;
    startBtn.disabled    = blocked;
    populateBtn.disabled = blocked;
    populateBtn.title    = blocked ? 'All players must pick a side first' : '';
  } else {
    startBtn.style.display    = 'none';
    populateBtn.style.display = 'none';
  }

  // Hint below the buttons
  let hintEl = document.getElementById('lobby-open-slots-hint');
  if (!hintEl) {
    hintEl = document.createElement('p');
    hintEl.id = 'lobby-open-slots-hint';
    hintEl.className = 'setup-lore';
    hintEl.style.cssText = 'font-size:0.8rem;margin-top:0.5rem;opacity:0.7';
    grid.parentNode.insertBefore(hintEl, grid.nextSibling?.nextSibling);
  }

  if (unassigned.length > 0) {
    hintEl.textContent = 'All players must pick a side before the game can start.';
    hintEl.style.display = '';
  } else if (isHost && hasEmpty) {
    hintEl.textContent = 'You can start now — empty slots stay open for others to join during the first turn. Unclaimed slots become AI at the deadline.';
    hintEl.style.display = '';
  } else if (!isHost) {
    hintEl.textContent = 'Waiting for the host to start the game…';
    hintEl.style.display = '';
  } else {
    hintEl.style.display = 'none';
  }
}

/**
 * Render a compact faction tag next to a seated player's name — shows the
 * picked faction and a "stub" marker when applicable. Rendered read-only
 * for other players' rows; the current player's row also gets a picker
 * dropdown via _buildLobbyFactionPicker().
 */
function _lobbyFactionTag(slot, isMe) {
  // The current player's row renders the <select> picker instead of a tag —
  // skip the registry lookup entirely for the common re-render case.
  if (isMe) return '';
  const def = findFaction(slot.factionId ?? slot.faction);
  if (!def) return '';
  const stub = def.isStub() ? ' <span class="lobby-slot-stub">stub</span>' : '';
  return ` <span class="lobby-slot-faction">${_esc(def.name)}${stub}</span>`;
}

/**
 * Build a <select> element that lets the current player change their
 * faction (same side only) via the setFaction protocol message.
 */
function _buildLobbyFactionPicker(lobby, slot) {
  const factions = getFactionsForSide(slot.side ?? (slot.faction === 'hero' ? 'day' : 'night'));
  const select   = document.createElement('select');
  select.className = 'setup-select lobby-faction-select';
  select.innerHTML = factions.map(f => {
    const selected = f.id === (slot.factionId ?? slot.faction) ? ' selected' : '';
    const stub     = f.isStub() ? ' (stub)' : '';
    return `<option value="${f.id}"${selected}>${_esc(f.name)}${stub}</option>`;
  }).join('');
  select.addEventListener('change', () => {
    if (!select.value) return;
    mp.setFaction(lobby.id, select.value);
  });
  return select;
}

function _showSlotInvitePopup(lobby, slotIndex, faction, anchorEl) {
  // Remove any existing popup
  document.querySelector('.slot-invite-popup')?.remove();

  const joinKey = (lobby.isPrivate && lobby.code) ? lobby.code : lobby.id;
  const deepLink = new URL(`/join?code=${encodeURIComponent(joinKey)}&slot=${slotIndex}`, _linkOrigin()).href;

  const popup = document.createElement('div');
  popup.className = 'slot-invite-popup';

  // -- GC friends section (iOS only, loaded async) --
  let friendsSection = '';
  if (isNativeMobile) {
    friendsSection = '<div class="gc-friends-section"><span class="gc-friends-loading">Loading friends…</span></div>';
  }

  popup.innerHTML = `
    ${friendsSection}
    <input type="email" class="setup-input" placeholder="Email address" autocomplete="email"
           style="font-size:0.8rem;margin:0">
    <div style="display:flex;gap:0.3rem;margin-top:0.3rem">
      <button class="setup-btn primary" style="font-size:0.75rem;flex:1">Send</button>
      <button class="setup-btn" style="font-size:0.75rem;flex:1">Copy Link</button>
      ${isNativeMobile ? '<button class="setup-btn" style="font-size:0.75rem;flex:1">Share</button>' : ''}
    </div>
  `;
  const buttons = popup.querySelectorAll('button');
  const sendBtn = buttons[0];
  const copyBtn = buttons[1];
  const shareBtn = isNativeMobile ? buttons[2] : null;
  const emailInput = popup.querySelector('input');

  sendBtn.addEventListener('click', () => {
    const email = emailInput.value.trim();
    if (!email) return;
    mp.sendSlotInvite(lobby.id, slotIndex, email);
    emailInput.value = '';
    sendBtn.textContent = 'Sent!';
    setTimeout(() => popup.remove(), 1500);
  });

  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(deepLink).catch(() => {});
    copyBtn.textContent = 'Copied!';
    setTimeout(() => popup.remove(), 1500);
  });

  if (shareBtn) {
    shareBtn.addEventListener('click', () => {
      shareInvite("Join my game of Caleb's Hollow!", deepLink);
    });
  }

  anchorEl.parentElement.appendChild(popup);
  emailInput.focus();

  // -- Load GC friends async --
  if (isNativeMobile) {
    _loadFriendsIntoPopup(popup, lobby);
  }

  // Close on outside click
  const dismiss = (e) => {
    if (!popup.contains(e.target) && e.target !== anchorEl) {
      popup.remove();
      document.removeEventListener('click', dismiss);
    }
  };
  setTimeout(() => document.addEventListener('click', dismiss), 0);
}

/** Async helper: fetch GC friends, match against server, render into popup. */
async function _loadFriendsIntoPopup(popup, lobby) {
  const section = popup.querySelector('.gc-friends-section');
  if (!section) return;

  try {
    const gcFriends = await loadGameCenterFriends();
    // If popup was removed while we were loading, bail out
    if (!popup.isConnected) return;

    if (gcFriends.length === 0) {
      section.remove();
      return;
    }

    // Match GC IDs against registered Brimstone players
    const base = window.BRIMSTONE_SERVER || '';
    const session = JSON.parse(localStorage.getItem('brimstone_session') || 'null');
    const res = await fetch(`${base}/api/gc-friends`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-token': session?.token || '' },
      body: JSON.stringify({ gamePlayerIDs: gcFriends.map(f => f.gamePlayerID) }),
    });
    if (!popup.isConnected) return;

    if (!res.ok) { section.remove(); return; }
    const matches = await res.json();
    if (!matches.length) { section.remove(); return; }

    section.innerHTML = '';
    for (const friend of matches) {
      const row = document.createElement('div');
      row.className = 'gc-friend-row';
      row.innerHTML = `<span class="gc-friend-name">${_esc(friend.username)}</span>`;
      const btn = document.createElement('button');
      btn.className = 'setup-btn primary gc-friend-invite-btn';
      btn.textContent = 'Invite';
      btn.addEventListener('click', () => {
        mp.sendFriendInvite(lobby.id, friend.playerId);
        btn.textContent = 'Invited!';
        btn.disabled = true;
      });
      row.appendChild(btn);
      section.appendChild(row);
    }
  } catch {
    section?.remove();
  }
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
  showStep('online');
});

function _initMpStep() {
  const session      = loadSession();
  const signedOut    = document.getElementById('mp-signed-out');
  const actionBtns   = document.getElementById('mp-action-buttons');
  const gamesSection = document.getElementById('mp-games-section');

  if (session) {
    signedOut.style.display    = 'none';
    actionBtns.style.display   = '';
    // mp-games-section visibility is managed by _fetchActiveSaves based on
    // whether the player actually has any active games to show.
  } else {
    signedOut.style.display    = '';
    actionBtns.style.display   = 'none';
    if (gamesSection) gamesSection.style.display = 'none';
  }
  _updateSessionBar();
}

function _initAsyncStep() {
  const session    = loadSession();
  const signedOut  = document.getElementById('async-signed-out');
  const actionBtns = document.getElementById('async-action-buttons');

  if (session) {
    signedOut.style.display  = 'none';
    actionBtns.style.display = '';
  } else {
    signedOut.style.display  = '';
    actionBtns.style.display = 'none';
  }
  _updateSessionBar();
}

// ── Account page ──────────────────────────────────────────────────────────────

async function _initAccountPage() {
  const session = loadSession();
  const signedOut = document.getElementById('acct-signed-out');
  const signedIn  = document.getElementById('acct-signed-in');

  _updateSessionBar();

  if (!session) {
    signedOut.style.display = '';
    signedIn.style.display  = 'none';
    return;
  }

  signedOut.style.display = 'none';
  signedIn.style.display  = '';

  // Username
  const usernameEl = document.getElementById('acct-username');
  usernameEl.textContent = _gcCredentials
    ? session.username + '  (Game Center)'
    : session.username;
  document.getElementById('acct-name-edit').style.display = 'none';
  document.getElementById('acct-name-error').style.display = 'none';
  // Hide edit button for Game Center accounts — name is managed by Apple
  const editNameBtn = document.getElementById('btn-acct-edit-name');
  if (editNameBtn) editNameBtn.style.display = _gcCredentials ? 'none' : '';

  // Email — fetch linked identities
  const emailEl   = document.getElementById('acct-email');
  const linkBtn   = document.getElementById('btn-acct-link-email');
  const emailForm = document.getElementById('acct-email-form');
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
      _updateSessionBar();
      return;
    }
    const emailIdentity = identities.find(i => i.provider === 'email');
    if (emailIdentity) {
      emailEl.textContent = emailIdentity.provider_id;
      linkBtn.style.display = 'none';
    } else {
      emailEl.textContent = 'Not linked';
      linkBtn.style.display = '';
    }

  } catch {
    emailEl.textContent = 'Not linked';
    linkBtn.style.display = '';
  }
}

// ── Auth dialog ──────────────────────────────────────────────────────────────

function _showAuthDialog(onSuccess) {
  // On iOS, wait for the launch GC auth to complete before deciding what to show.
  // This prevents the sign-in dialog from flashing while GC auth is in flight.
  if (_gcAuthPromise) {
    _gcAuthPromise.then(() => {
      if (_gcCredentials) {
        _ensureAuthed(() => {
          _hideAuthDialog();
          if (onSuccess) onSuccess();
        });
      } else {
        _showAuthDialogUI(onSuccess);
      }
    });
    return;
  }
  if (_gcCredentials) {
    _ensureAuthed(() => {
      _hideAuthDialog();
      if (onSuccess) onSuccess();
    });
    return;
  }
  _showAuthDialogUI(onSuccess);
}

function _showAuthDialogUI(onSuccess) {
  _authDialogCallback = onSuccess;
  const dlg = document.getElementById('auth-dialog');
  document.getElementById('auth-username').value = '';
  document.getElementById('auth-email-input').value = '';
  document.getElementById('auth-error').style.display = 'none';
  document.getElementById('auth-email-status').style.display = 'none';

  // Reset the email login section to hidden — it's only revealed when the
  // server reports the username is already linked to an email.
  const emailSection = document.getElementById('auth-email-section');
  if (emailSection) emailSection.style.display = 'none';
  const linkedHint = document.getElementById('auth-linked-hint');
  if (linkedHint) { linkedHint.style.display = 'none'; linkedHint.textContent = ''; }

  dlg.classList.add('visible');
}

/**
 * Reveal the email login section inside the auth dialog. Called when the
 * server reports the chosen username is already linked to an email — the
 * real owner must sign in via magic link instead.
 */
function _revealAuthEmailSection() {
  const emailSection = document.getElementById('auth-email-section');
  if (emailSection) emailSection.style.display = '';
  const linkedHint = document.getElementById('auth-linked-hint');
  if (linkedHint) {
    linkedHint.textContent = 'This username is linked to an email. Use email login below.';
    linkedHint.style.display = '';
  }
  document.getElementById('auth-email-input')?.focus();
}

function _hideAuthDialog() {
  document.getElementById('auth-dialog').classList.remove('visible');
  _authDialogCallback = null;
}

document.getElementById('btn-auth-cancel').addEventListener('click', () => _hideAuthDialog());

document.getElementById('btn-auth-signin').addEventListener('click', () => {
  const errorEl = document.getElementById('auth-error');
  errorEl.style.display = 'none';

  const cb = _authDialogCallback;
  _ensureAuthed(() => {
    _hideAuthDialog();
    if (cb) cb();
  });
});

document.getElementById('btn-auth-email-login').addEventListener('click', async () => {
  const email = document.getElementById('auth-email-input').value.trim();
  if (!email) return;

  const statusEl = document.getElementById('auth-email-status');
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

// Account: sign in via dialog
document.getElementById('btn-acct-signin').addEventListener('click', () => {
  _showAuthDialog(() => _initAccountPage());
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
    const res = await fetch(`${window.BRIMSTONE_SERVER || ''}/api/account/username`, {
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
      _updateSessionBar();
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

document.getElementById('btn-mp-signin').addEventListener('click', () => {
  _showAuthDialog(() => {
    _initMpStep();
    _fetchActiveSaves();
    _fetchCompletedGames();
  });
});

function _signOut() {
  clearSession();
  if (mp) { mp.disconnect(); mp = null; }
  renderer = null; ui = null; state = null;
}

function _updateSessionBar() {
  const session = loadSession();
  const nameEl  = document.getElementById('setup-session-name');
  const btn     = document.getElementById('btn-setup-signout');
  if (session) {
    nameEl.textContent = session.username;
    btn.textContent    = 'Sign Out';
  } else {
    nameEl.textContent = '';
    btn.textContent    = 'Sign In';
  }
}

// ── Persistent sign-out (footer bar) ────────────────────────────────────────

document.getElementById('btn-setup-signout').addEventListener('click', async () => {
  // If not logged in, the button reads "Sign In" — navigate to account page
  if (!loadSession()) { _initAccountPage(); showStep('account'); return; }
  // Warn if the account has no recovery method (no email, no Game Center)
  if (!_gcCredentials) {
    const session = loadSession();
    if (session?.token) {
      try {
        const identities = await fetchIdentities(session.token);
        const hasRecovery = identities?.some(i => i.provider === 'email' || i.provider === 'gamecenter');
        if (!hasRecovery) {
          const confirmed = confirm(
            'Warning: You have no email or Game Center linked to this account. ' +
            'If you sign out, you will lose access to this account permanently.\n\n' +
            'Sign out anyway?'
          );
          if (!confirmed) return;
        }
      } catch { /* offline — proceed with sign-out */ }
    }
  }
  _signOut();
  _updateSessionBar();
  // Refresh whichever screen is visible
  _initMpStep();
  _initAsyncStep();
  _initAccountPage();
  const activeList = document.getElementById('active-games-list');
  if (activeList) activeList.innerHTML = '<p class="mm-games-empty">Sign in to see your active games.</p>';
  const asyncList = document.getElementById('async-games-list');
  if (asyncList) asyncList.innerHTML = '<p class="saves-empty">Sign in to see async games.</p>';
});

// ── Async sign-in ───────────────────────────────────────────────────────────

document.getElementById('btn-async-signin')?.addEventListener('click', () => {
  _showAuthDialog(() => {
    _initAsyncStep();
    _fetchAsyncGames();
  });
});

// (Email login is now handled by the auth dialog)

function _onlineError(msg, raw) {
  // Show error in the auth dialog if visible, otherwise ignore
  const authErr = document.getElementById('auth-error');
  if (authErr) {
    authErr.textContent = msg;
    authErr.style.display = '';
  }
  // Username is linked to an email on another account — reveal the email
  // login section so the real owner can sign in via magic link.
  if (raw?.err_code === 'username_linked') {
    _revealAuthEmailSection();
    return;
  }
  // Legacy string fallback (older server builds / cached PWAs).
  if (msg && msg.includes && msg.includes('already taken')) {
    _revealAuthEmailSection();
  }
}

/** Ensure we have an authenticated MultiplayerClient, then call cb(). */
/** Cached Game Center credentials for use by _ensureAuthed. */
let _gcCredentials = null;

function _ensureAuthed(cb) {
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
    // Already authenticated on a live connection — also link Game Center if available
    if (_gcCredentials) mp.linkGameCenter(_gcCredentials.playerId);
    cb();
    return;
  }

  // Authenticate first, then run cb
  mp._opts._onAuthOk = cb;
  if (session) {
    mp.auth({ token: session.token });
  } else if (_gcCredentials) {
    // No session but Game Center is available — authenticate via Game Center
    mp.authGameCenter({
      gameCenterId: _gcCredentials.playerId,
      displayName: _gcCredentials.displayName,
    });
  } else {
    const nameInput = document.getElementById('auth-username');
    const username = nameInput.value.trim();
    if (username.length < 2) {
      const errorEl = document.getElementById('auth-error');
      errorEl.textContent = 'Enter a username (2+ characters).';
      errorEl.style.display = '';
      return;
    }
    mp.auth({ username });
  }
}

async function _applyOnlinePlanningPhase(payload) {
  if (!ui || !mp) return;
  const { myActionsLeft, heroActionsLeft, witchActionsLeft, players, timeoutMs, submittedPlan, lastReplay, wasIdleLastRound } = payload;

  // Browser notification — calls out idle turn if the player timed out last round
  if (state?.round) {
    notifyRoundReady(state.round, wasIdleLastRound ? { wasIdle: true, faction: mp.myFaction } : undefined);
  }

  // If we have a replay from the last round, play it before entering planning
  const hadReplay = !!lastReplay;
  if (lastReplay) {
    await _playReconnectReplay(lastReplay);
  }

  // Prefer per-player budget; fall back to legacy faction budget for old servers.
  const budget = myActionsLeft ?? getFaction(mp.myFaction).getActionsLeft({ heroActionsLeft, witchActionsLeft });
  if (players) ui._players = players;
  ui._hasReplayHistory = _onlineRoundHistory.length > 0;
  if (ui._planMode && ui._planFaction === mp.myFaction && !ui._planSubmitted) {
    console.log(`[mp] _applyOnlinePlanningPhase: fast path (already planning, budget=${budget} timeoutMs=${timeoutMs})`);
    ui._planBudget = budget;
    if (timeoutMs > 0) ui._startCountdown(timeoutMs);
    ui._renderPlayerStatus();
    ui._renderPlanPanel();
    // Phase info is now in the merged resolution summary — no separate modal
  } else {
    console.log(`[mp] _applyOnlinePlanningPhase: full enter (planMode=${ui._planMode} submitted=${ui._planSubmitted} budget=${budget} timeoutMs=${timeoutMs})`);
    ui.exitPlanningMode();
    ui.enterPlanningMode(mp.myFaction, budget, timeoutMs ?? 0);
  }
  ui.onPlanSubmit = (plan) => mp.submitPlan(plan, state.round);
  ui.onReturnToMenu = () => { location.reload(); };
  ui.onReplayLastTurn = () => _replayLastTurnInline();

  // Restore submitted plan on reconnect — show what was already submitted
  if (submittedPlan != null) {
    // Restore the submitted plan actions (if any) and mark as submitted.
    // An empty plan (submittedPlan = []) is still a valid submission.
    for (const action of submittedPlan) {
      if (action.entityId) {
        if (!ui._unitPlans.has(action.entityId)) ui._unitPlans.set(action.entityId, []);
        ui._unitPlans.get(action.entityId).push(action);
      }
    }
    ui._refreshPlanOverlay();
    ui._renderPlanPanel();
    ui.markPlanSubmitted();
  }
}

/**
 * Replay the last resolved round inline (triggered by header button).
 *
 * Looks up round (state.round - 1) from the client cache; on a miss,
 * fetches it from the server via requestReplay. This guarantees the
 * replay always matches the turn the player is currently waiting to see.
 */
async function _replayLastTurnInline() {
  if (!ui || !state || !renderer || isAnimating() || _inlineReplayInFlight) return;
  const targetRound = state.round - 1;
  if (targetRound < 1) return;

  _inlineReplayInFlight = true;
  try {
    // 1. Look up in cache first
    let entry = _replayCache.get(targetRound);

    // 2. Cache miss → fetch from server
    if (!entry) {
      if (!mp?.roomId) {
        console.warn('[replay] cache miss with no server connection');
        return;
      }
      try {
        entry = await _requestReplayFromServer(mp.roomId, targetRound);
      } catch (err) {
        console.warn('[replay] fetch failed:', err?.message || err);
        return;
      }
    }
    if (!entry || entry.roundNum !== targetRound) {
      console.warn(`[replay] no valid replay for round ${targetRound}`);
      return;
    }

    // Save current plan state so we can restore it after replay
    const savedPlans     = new Map(ui._unitPlans);
    const wasSubmitted   = ui._planSubmitted;
    // Snapshot the countdown deadline BEFORE exitPlanningMode nukes it, so
    // we can restart the countdown with the correct remaining time.
    const savedCountdownEnd = ui._countdownEnd ?? null;

    ui.exitPlanningMode();
    resetPlayback();
    try {
      await _playReconnectReplay({
        roundNum:     entry.roundNum,
        preStateJson: entry.preStateJson,
        stepsJson:    entry.stepsJson,
      });
    } finally {
      resetPlayback();
    }

    // Restore planning mode with the saved plan + remaining countdown time
    const budget = state.playerActionsLeft?.get(mp?.myPlayerId)
      ?? (mp?.myFaction ? getFaction(mp.myFaction).getActionsLeft(state) : state.heroActionsLeft);
    const remainingMs = savedCountdownEnd
      ? Math.max(0, savedCountdownEnd - Date.now())
      : 0;
    ui._hasReplayHistory = _onlineRoundHistory.length > 0;
    ui.enterPlanningMode(mp.myFaction, budget, remainingMs);
    ui.onPlanSubmit = (plan) => mp.submitPlan(plan, state.round);
    ui.onReturnToMenu = () => { location.reload(); };
    ui.onReplayLastTurn = () => _replayLastTurnInline();

    // Restore the plan
    ui._unitPlans = savedPlans;
    ui._refreshPlanOverlay();
    ui._renderPlanPanel();
    if (wasSubmitted) ui.markPlanSubmitted();
  } finally {
    _inlineReplayInFlight = false;
  }
}

/** Play the last round's resolution replay on reconnect. */
async function _playReconnectReplay(replay) {
  if (!ui || !state || !renderer) return;

  const redraw = () => renderer.draw(state, ui);
  const steps = JSON.parse(replay.stepsJson);
  if (!steps?.length) return;

  // Temporarily load the pre-resolution state so the animation starts from the right position
  const preState = JSON.parse(replay.preStateJson);
  const currentEntities = state.entities;
  const preEntities = patchAlive(steps[0]?.entitySnapshot ?? deserializeState(preState).entities ?? currentEntities);

  // Snapshot pre-resolution node state for summary
  const prevNodes = (state.witchObjectives ?? []).map(obj => ({
    col: obj.col, row: obj.row, label: obj.label,
    owner: nodeController(obj, preEntities),
  }));
  const prevScore = { hero: state.nodeScore?.hero ?? 0, witch: state.nodeScore?.witch ?? 0 };

  // Replay under the round's OWN phase (carried by the saved pre-state): the
  // live state's day cycle has already advanced past this round, which would
  // change the lighting and the sight ranges the fog veil / card gates use.
  await withPinnedPhase(state, preState?.phase, async () => {
    state.entities = preEntities;
    redraw();

    // Play the resolution animation
    await _animateResolutionSteps(steps, currentEntities, redraw, mp?.myFaction, mp?.myPlayerId ?? null);

    // Restore the current state
    state.entities = currentEntities;
  });

  // Store in round history for "replay full game"
  // Cache for round-keyed lookup + legacy full-game replay array
  _cacheReplay({
    roundNum:     replay.roundNum,
    preStateJson: replay.preStateJson,
    stepsJson:    replay.stepsJson,
  });

  // If the user hit "skip" mid-animation, bail out: snap to final state and
  // skip the post-round summary entirely.
  if (playback.jumpToEnd) {
    return;
  }

  // Show summary
  await ui._triggerPostRoundEffects();
  redraw();

  if (mp?.myFaction) {
    setMode(AppMode.SUMMARY);
    let action;
    do {
      action = await ui._showResolutionSummary(steps, replay.roundNum, {
        prevScore, prevNodes, humanFaction: mp.myFaction, fogOfWar: state.fogOfWar,
        gameOver: false,
      });
      if (action === 'replay') {
        await withPinnedPhase(state, preState?.phase, async () => {
          state.entities = preEntities;
          redraw();
          await _animateResolutionSteps(steps, currentEntities, redraw, mp.myFaction, mp.myPlayerId ?? null);
          state.entities = currentEntities;
        });
        redraw();
        setMode(AppMode.SUMMARY);
      }
    } while (action === 'replay');
    setMode(AppMode.PLANNING);
    ui._animateScoreBar(prevScore, prevNodes);
  }
}

function _serverWsUrl() {
  // Allow override via global (set by server when serving the page, for production)
  if (window.BRIMSTONE_WS) return window.BRIMSTONE_WS;
  // Electron uses a custom protocol where location.host is "." — never valid for WS.
  // Derive from BRIMSTONE_SERVER if available, otherwise fall back to location.
  if (window.BRIMSTONE_SERVER) {
    try {
      const url = new URL(window.BRIMSTONE_SERVER);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return url.href.replace(/\/$/, '');
    } catch { /* fall through */ }
  }
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}`;
}

function _createMpClient() {
  return new MultiplayerClient({
    onState(mirrorState) {
      console.log(`[mp] onState: reason=${mirrorState._reason ?? '?'} round=${mirrorState.round} planning=${mirrorState.planningPhase} resolving=${mirrorState.resolving} hasUI=${!!ui} hasRenderer=${!!renderer} active=${mp?.active}`);
      if (!renderer || !ui) {
        if (mp?.active) {
          try {
            console.log(`[mp] onState → initOnline (faction=${mp.myFaction})`);
            mirrorState.myFaction = mp.myFaction;
            initOnline(mirrorState, mp.myFaction, mp);
          } catch (err) {
            console.error('initOnline failed:', err);
            _onlineError(`Failed to start game: ${err.message}`);
            _showOnlineScreen();
          }
        } else {
          console.log(`[mp] onState ignored — mp.active is false`);
        }
        return;
      }

      if (shouldBufferMessages()) {
        console.log(`[mp] onState buffered (shouldBuffer=true, mode=${getMode()})`);
        return;
      }

      console.log(`[mp] onState → in-place update`);
      // Already in game — update in-place (keeps renderer pan/zoom)

      // Snapshot entity positions before update so we can animate moves
      const oldPos = new Map();
      for (const e of state.entities) oldPos.set(e.id, { col: e.col, row: e.row, slot: e.slot ?? 0 });

      Object.assign(state, mirrorState);
      state.hero      = mirrorState.hero;
      state.witch     = mirrorState.witch;
      state.myFaction = mp.myFaction; // persist faction for per-player fog of war

      // Animate entities that changed hex position (opponent moves)
      if (!state.gameOver && renderer) {
        for (const e of state.entities) {
          const old = oldPos.get(e.id);
          if (old && (old.col !== e.col || old.row !== e.row)) {
            renderer.addMoveAnim(e.id, old.col, old.row, e.col, e.row, e.type, e.owner, e.title ?? null,
              null, old.slot ?? 0, e.slot ?? 0);
          }
        }
      }

      ui._clearSelection();
      ui._triggerPostRoundEffects();
      redrawOnline();

      // If the game just ended (e.g. resignation), show summary immediately
      if (state.gameOver && !isAnimating()) {
        ui._showResolutionSummary([], state.round, {
          gameOver: true,
          winner: state.winner,
          winReason: state.winReason,
          humanFaction: mp?.myFaction ?? null,
          hasFullReplay: _onlineRoundHistory.length > 0,
        }).then(choice => {
          if (choice === 'restart') location.reload();
        });
      }
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
      _replayCache.clear();
      if (resumed && priorRounds?.length) {
        _onlineRoundHistory = priorRounds.map(r => ({
          roundNum: r.roundNum,
          preState: r.preStateJson,
          steps:    r.stepsJson,
        }));
        // Seed the round-keyed cache from restored rounds.
        for (const r of priorRounds) {
          _replayCache.set({
            roundNum:     r.roundNum,
            preStateJson: r.preStateJson,
            stepsJson:    r.stepsJson,
          });
        }
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
      if (!isInGame()) return;
      if (shouldBufferMessages()) { _pendingSubmissions.push({ playerId, name, faction }); return; }
      if (ui) ui._onPlayerSubmitted(playerId, name, faction);
    },

    onPlayerPresence(players) {
      if (!isInGame()) return;
      if (ui) ui._onPlayerPresence(players);
    },

    onTimerReset(timeoutMs) {
      if (!isInGame()) return;
      if (ui) ui.resetCountdown(timeoutMs);
    },

    onPlayerTakenOver({ playerId, playerName }) {
      if (!isInGame() || !state) return;
      if (!state._takeoverMessages) state._takeoverMessages = [];
      state._takeoverMessages.push(`${playerName} has been taken over by AI`);
    },

    onPlayerResigned({ playerId, playerName }) {
      if (!isInGame() || !state) return;
      if (!state._takeoverMessages) state._takeoverMessages = [];
      state._takeoverMessages.push(`${playerName} resigned — replaced by AI`);
    },

    onNudged(msg) {
      if (!isInGame()) return;
      if (ui) ui._showNudgeToast(msg.fromName ?? 'Someone');
    },

    onNudgeAck(_msg) {
      // No-op — UI already updated optimistically on click
    },

    onGamesUpdate() {
      // Server signals that the player's game list changed (plan submitted, round resolved)
      if (stepOnline.style.display !== 'none') {
        _fetchActiveSaves();
        _updateMultiplayerBadge();
      } else if (stepAsync.style.display !== 'none') {
        _fetchAsyncGames();
        _updateMultiplayerBadge();
      } else {
        _updateMultiplayerBadge();
      }
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

    onDisconnected() {
      const overlay = document.getElementById('reconnect-overlay');
      if (overlay) {
        document.getElementById('reconnect-spinner').style.display = '';
        document.getElementById('reconnect-message').textContent = 'Reconnecting\u2026';
        document.getElementById('reconnect-back').style.display = 'none';
        overlay.style.display = 'flex';
      }
    },

    onReconnected() {
      const overlay = document.getElementById('reconnect-overlay');
      if (overlay) overlay.style.display = 'none';
    },

    onDisconnectFatal(msg) {
      const overlay = document.getElementById('reconnect-overlay');
      if (overlay) {
        document.getElementById('reconnect-spinner').style.display = 'none';
        document.getElementById('reconnect-message').textContent = msg;
        document.getElementById('reconnect-back').style.display = '';
        overlay.style.display = 'flex';
      }
    },

    onHeartbeat({ roomId, round, planningPhase, gameOver, playersReady }) {
      if (!isInGame() || !state || !mp) return;
      if (mp.roomId !== roomId) return;
      // Detect missed state: server is in planning but we're stuck in an old mode
      if (planningPhase && round > state.round && !shouldBufferMessages()) {
        console.log(`[heartbeat] round mismatch: server=${round} client=${state.round} — requesting resync`);
        mp._send({ type: 'requestState' });
      }
      // Detect game over we missed
      if (gameOver && !state.gameOver && !shouldBufferMessages()) {
        console.log('[heartbeat] missed game-over — requesting resync');
        mp._send({ type: 'requestState' });
      }
      // Detect stuck state: server says planning but client never entered planning mode.
      // This can happen if the planningPhase message was lost during a reconnect.
      if (planningPhase && round === state.round && !shouldBufferMessages()
          && ui && !ui._planMode && getMode() === AppMode.PLANNING) {
        console.log('[heartbeat] server in planning but client _planMode is false — requesting resync');
        mp._send({ type: 'requestState' });
      }
      // Reconcile ready indicators from server's authoritative state
      if (planningPhase && round === state.round && !shouldBufferMessages()
          && ui?._planMode && ui._players && playersReady) {
        const readySet = new Set(playersReady);
        let changed = false;
        for (const p of ui._players) {
          const pid = p.playerId ?? p.id;
          const shouldBeReady = readySet.has(pid);
          if (p._submitted !== shouldBeReady) {
            p._submitted = shouldBeReady;
            changed = true;
          }
        }
        if (changed) ui._renderPlayerStatus();
      }
    },

    onPlanningPhase(payload) {
      console.log(`[mp] onPlanningPhase: budget=${payload.myActionsLeft} timeout=${payload.timeoutMs} submittedPlan=${payload.submittedPlan != null ? payload.submittedPlan.length + ' actions' : 'null'} inGame=${isInGame()} hasUI=${!!ui} mode=${getMode()}`);
      if (!isInGame() || !ui || !mp) return;
      if (shouldBufferMessages()) {
        console.log(`[mp] onPlanningPhase → buffered (mode=${getMode()})`);
        _pendingPlanningPhase = payload;
        return;
      }
      _applyOnlinePlanningPhase(payload);
    },

    onOpponentReady() {
      if (!isInGame()) return;
      const statusEl = document.getElementById('plan-status');
      if (statusEl) statusEl.textContent = 'Opponent ready — waiting for resolution…';
    },

    onResolutionComplete({ steps, finalState }) {
      if (!isInGame() || !ui || !renderer) return;
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

      // Keep the replay timeline up after the animation so the end-of-round
      // wrap-up CARD can attach to it (parity with single-player). Game-over
      // hides it and shows the dedicated Victory/Defeat modal instead.
      _keepTimelineForReview = !!(ui && mp?.myFaction);

      _animateResolutionSteps(steps, finalEntities, redrawOnline, mp?.myFaction, mp?.myPlayerId ?? null).then(async () => {
        // Apply full final state (phase, round, score, tiles, etc.) BEFORE summary
        // so the reckoning section can show scoring results.
        Object.assign(state, finalState);
        state.hero      = finalState.hero;
        state.witch     = finalState.witch;
        state.myFaction = mp?.myFaction;

        // Accumulate round for full-game replay + round-keyed cache
        _cacheReplay({
          roundNum:          _onlineRoundNum,
          preStateJson:      _onlinePreStateJson,
          stepsJson:         JSON.stringify(steps),
          finalEntitiesJson: state.gameOver ? JSON.stringify(finalEntities) : undefined,
        });

        // Mirror the same post-resolution side effects as the local path.
        await ui._triggerPostRoundEffects();
        redrawOnline();

        // Show the post-resolution review for human players via the shared
        // _runEndOfRoundReview helper (same card/modal split as offline).
        // Keep mode as SUMMARY for the whole review+replay block so that any
        // incoming onPlanningPhase messages are buffered, not immediately applied.
        if (ui && mp?.myFaction) {
          setMode(AppMode.SUMMARY);

          // Re-run this round's animation from the pre-resolution snapshot,
          // toggling explored flags so newly-revealed hexes fade back in.
          // Shared by both the wrap-up card and the game-over modal's Replay.
          const _reReplayOnline = async () => {
            state.entities = _preReplayEntitiesOnline;
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
            // Re-engage RESOLVING so onPlanningPhase stays buffered during the
            // next review show.
            setMode(AppMode.RESOLVING);
          };

          const action = await _runEndOfRoundReview({
            steps, roundNum: (finalState.round ?? state.round) - 1,
            humanFaction: mp.myFaction, fogOfWar: state.fogOfWar,
            prevScore, prevNodes,
            roundHistory: _onlineRoundHistory,
            reReplay: _reReplayOnline,
            replayFull: async (winner, winReason) => {
              await _replayFullGame(_onlineRoundHistory, winner, winReason,
                state.hero?.displayName ?? 'Hero', state.witch?.displayName ?? 'Witch',
                redrawOnline);
              _doRestart();
            },
          });
          if (action === 'replay-full') return;

          setMode(AppMode.PLANNING);
          // Animate score bar changes after the review is dismissed
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
          // Replay any playerSubmitted messages that arrived during animation.
          // These must be applied AFTER enterPlanningMode resets _submitted flags.
          for (const sub of _pendingSubmissions) {
            if (ui) ui._onPlayerSubmitted(sub.playerId, sub.name, sub.faction);
          }
          _pendingSubmissions = [];
        }
      });
    },

    // ── Unified message handlers ─────────────────────────────────
    onGameJoined(payload) {
      const { mirror, faction, playerId, round, lastRound, players, isBattle, isAsync, gameOver } = payload;
      console.log(`[mp] onGameJoined: faction=${faction} round=${mirror.round} budget=${round.budget} gameOver=${gameOver} hasUI=${!!ui} mode=${ui ? getMode() : 'none'}`);

      // If we're already in-game and animating/viewing a resolution, ignore this
      // message — it's a resync from a heartbeat and the animation will handle
      // the transition back to planning.
      if (ui && renderer && shouldBufferMessages()) {
        console.log(`[mp] onGameJoined: ignored during ${getMode()} — animation/summary in progress`);
        return;
      }

      mirror.myFaction = faction;

      // Initialize or update the game view
      if (!renderer || !ui) {
        try {
          initOnline(mirror, faction, mp);
        } catch (err) {
          console.error('initOnline failed:', err);
          _onlineError(`Failed to start game: ${err.message}`);
          _showOnlineScreen();
          return;
        }
      } else {
        // Already in game — update state in-place (resync)
        Object.assign(state, mirror);
        state.myFaction = faction;
      }

      // Skip replay if we're already in-game at the same round (heartbeat resync)
      const isResync = ui && renderer && state && state.round === mirror.round && ui._planMode;

      // Set up planning mode with the correct budget and deadline
      if (!gameOver) {
        if (players) ui._players = players;
        ui._hasReplayHistory = _onlineRoundHistory.length > 0;

        // Play last round replay if available and this isn't a same-round resync
        if (lastRound && !round.submittedPlan && !isResync) {
          _playReconnectReplay(lastRound).then(() => {
            ui._hasReplayHistory = _onlineRoundHistory.length > 0;
            ui.enterPlanningMode(faction, round.budget, round.deadline ?? 0);
            ui.onPlanSubmit = (plan) => mp.submitPlan(plan, state.round);
            ui.onReturnToMenu = () => { location.reload(); };
            ui.onReplayLastTurn = () => _replayLastTurnInline();
          });
        } else {
          ui.enterPlanningMode(faction, round.budget, round.deadline ?? 0);
          ui.onPlanSubmit = (plan) => mp.submitPlan(plan, state.round);
          ui.onReturnToMenu = () => { location.reload(); };
          ui.onReplayLastTurn = () => _replayLastTurnInline();
        }

        // Restore submitted plan if reconnecting with an already-submitted plan
        if (round.submittedPlan) {
          for (const action of round.submittedPlan) {
            if (action.entityId) {
              if (!ui._unitPlans.has(action.entityId)) ui._unitPlans.set(action.entityId, []);
              ui._unitPlans.get(action.entityId).push(action);
            }
          }
          ui._refreshPlanOverlay();
          ui._renderPlanPanel();
          ui.markPlanSubmitted();
          setMode(AppMode.SUBMITTED);
        }

        // Show who has already submitted
        if (round.playersReady) {
          for (const p of round.playersReady) {
            ui._onPlayerSubmitted?.(p.playerId, p.name, p.faction);
          }
        }
      }

      redrawOnline();
    },

    onRoundResolved(payload) {
      // For now, defer to the legacy onResolutionComplete handler.
      // The roundResolved message carries the same steps + finalState,
      // plus next-round planning data — but the legacy handler already
      // buffers the planningPhase message and applies it after animation.
      // Full integration will be done in a future pass.
      console.log(`[mp] onRoundResolved: round=${payload.finalState?.round} gameOver=${payload.gameOver}`);
      // No-op for now — legacy resolutionComplete + planningPhase handle this
    },

    // ── Async game callbacks ─────────────────────────────────────
    onAsyncStateUpdate(msg) { _handleAsyncStateUpdate(msg); },
    onAsyncPlanAccepted(msg) { _handleAsyncPlanAccepted(msg); },
    onAsyncResolution(msg)  { _handleAsyncResolution(msg); },
    onAsyncPlanStatus(msg)  { _handleAsyncPlanStatus(msg); },
    onAsyncOpponentJoined(msg) { _handleAsyncOpponentJoined(msg); },

    onReplayData(msg)  { _handleReplayData(msg); },
    onReplayError(msg) { _handleReplayError(msg); },

    onError(msg, raw) {
      // Ignore errors after intentional sign-out / disconnect
      if (!mp) return;

      // If we're in-game and the reconnect overlay is visible, this is a
      // fatal reconnection failure (e.g. "Game is no longer active").
      // Wipe clean and return to the menu.
      const reconnOverlay = document.getElementById('reconnect-overlay');
      if (state && reconnOverlay?.style.display !== 'none') {
        reconnOverlay.style.display = 'none';
        _showOnlineScreen();
        _onlineError(msg, raw);
        return;
      }

      // If the auth dialog is visible, show the error in-place without
      // navigating away — keeps the user on their calling screen.
      const authDlg = document.getElementById('auth-dialog');
      if (authDlg?.classList.contains('visible')) {
        _onlineError(msg, raw);
        return;
      }

      // Only show errors on setup screens (pre-game).
      // In-game connection errors are handled by the reconnect overlay.
      if (!state || document.getElementById('setup-screen').style.display !== 'none') {
        // Only navigate when the user is actually on an online/async sub-screen.
        // A silent reconnect that produces a stray error must not yank a user out
        // of an unrelated menu (options, how-to-play, account, mode card, …).
        if (_asyncRoomId || _isOnAsyncFlow()) {
          _showAsyncScreen();
          _onlineError(msg, raw);
        } else if (_isOnOnlineFlow()) {
          _showOnlineScreen();
          _onlineError(msg, raw);
        }
        // Otherwise: swallow the error silently — the user is browsing a
        // non-network menu and shouldn't be teleported away from it.
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

  if (msg.type === 'authOk') {
    // Re-link push token to the current account after every auth
    if (isNativeMobile) refreshPushToken();
    if (this._opts._onAuthOk) {
      const cb = this._opts._onAuthOk;
      this._opts._onAuthOk = null;
      cb();
    }
  }

  if (msg.type === 'authError') {
    // Token no longer valid (e.g. server restarted) — clear session and
    // show the signed-out state so the user can sign in again.
    clearSession();
    if (mp) mp._player = null;
    // Only navigate when the user is on a screen that actually depends on
    // being signed in. On unrelated menus (options, how-to-play, mode card,
    // …) a silent reconnect should not yank them away — just refresh the
    // session bar so they can see they're signed out.
    if (_asyncRoomId || _isOnAsyncFlow()) {
      _showAsyncScreen();
    } else if (_isOnOnlineFlow()) {
      _showOnlineScreen();
    } else {
      _updateSessionBar();
    }
  }
};

// ── Spectator mode ────────────────────────────────────────────────────────────

function initSpectator(roomId) {
  document.body.classList.add('spectator-mode');
  const statusEl = document.getElementById('spectate-status');
  statusEl.style.display = '';
  statusEl.textContent = 'Connecting...';

  const session = JSON.parse(localStorage.getItem('brimstone_session') || 'null');

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = window.BRIMSTONE_WS ?? `${protocol}//${location.host}`;
  const ws = new WebSocket(wsUrl);

  let planningPlayers = [];
  let submittedIds    = new Set();

  ws.addEventListener('open', () => {
    if (!session?.token) {
      statusEl.textContent = 'No session found. Please log in first.';
      ws.close();
      return;
    }
    statusEl.textContent = 'Authenticating...';
    ws.send(JSON.stringify({ type: 'auth', token: session.token }));
  });

  ws.addEventListener('message', e => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'authOk') {
      statusEl.textContent = 'Joining room...';
      ws.send(JSON.stringify({ type: 'adminSpectateRoom', roomId }));
      return;
    }
    if (msg.type === 'authError') {
      statusEl.textContent = 'Auth failed: ' + (msg.message || 'Unknown error');
      ws.close();
      return;
    }
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
    if (ui) ui.destroy();
    const canvas = document.getElementById('game-canvas');
    renderer = new (_pickRenderer())(canvas, mirrorState);
    renderer.resize();
    renderer.onImagesLoaded = () => { if (ui) ui._renderTurnInfo(); };
    ui = new UIController(canvas, mirrorState, renderer, null, () => renderer.draw(), null, false);
    ui.setMode(UIMode.SPECTATOR);
    ui.speedMode = 'fast';
    window.addEventListener('resize', () => { renderer.resize(); renderer.draw(); });
    // Loading overlay + progress bar; reveals the canvas once assets are ready.
    // (Also boots the renderer — draw() no longer triggers init.)
    _showLoadingAndReveal(renderer);
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

// Dev visual-testing harness: ?scenario=<urlencoded JSON> boots a hand-defined
// board (small map + unit placements + optional scripted resolution), skipping
// the menu/AI/conversation. See initScenario + scripts/verify.
const _scenarioParam = new URLSearchParams(location.search).get('scenario');
if (_scenarioParam) {
  try { initScenario(JSON.parse(_scenarioParam)); }
  catch (e) { console.error('Bad ?scenario= JSON:', e); }
}

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

    await _startMpReplay(rounds, meta);
  } catch (e) {
    console.error('Admin replay load error:', e);
    alert('Could not load replay data.');
  }
}

// Auto-login via magic link or invite redirect: ?email_token=<token>
function _handleEmailToken(emailToken) {
  try {
    const _tmpMp = _createMpClient();
    _tmpMp.connect(_serverWsUrl());
    _tmpMp._opts._onAuthOk = () => {
      mp = _tmpMp;
      _updateSessionBar();
      if (!_checkGameDeepLink()) _checkAsyncDeepLink();
      if (!window.location.hash) _showOnlineScreen();
    };
    _tmpMp.auth({ token: emailToken });
  } catch {
    _showOnlineScreen();
  }
}

const _emailToken = checkEmailTokenInUrl();
if (_emailToken) _handleEmailToken(_emailToken);

// Universal Link magic-link sign-in (iOS — dispatched from platform.js)
window.addEventListener('magic-link-token', (e) => _handleEmailToken(e.detail));
