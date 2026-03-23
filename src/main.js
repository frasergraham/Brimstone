// Entry point: wires all modules, setup screen flow, resize
import { GameState, Player } from './game.js';
import { Renderer }          from './renderer.js';
import { UIController }      from './ui.js';
import { WitchAI, HeroAI }   from './ai.js';
import { hexToPixel }        from './hex.js';
import { MultiplayerClient, MirrorState, loadSession, clearSession } from './multiplayer.js';
import { VERSION }           from './version.js';
import { resolvePlans, ResEventType } from '../server/resolver.js';
import { PlanActionType }    from './planner.js';

// Stamp version into both badges
document.getElementById('version-badge').textContent = `v${VERSION}`;
document.getElementById('game-version').textContent  = `v${VERSION}`;

let state, renderer, ui, witchAI, heroAI;
let _autoplay = false;

// ── Local game init ───────────────────────────────────────────────────────────

function init(witchIsAI, heroIsAI, autoplay = false) {
  _autoplay = autoplay;
  const canvas = document.getElementById('game-canvas');

  document.getElementById('setup-screen').style.display  = 'none';
  document.getElementById('game-screen').style.display   = 'flex';

  state    = new GameState(witchIsAI, heroIsAI);
  // Allow global fog-of-war override from the setup screen checkbox.
  const fogChk = document.getElementById('chk-fog-of-war');
  if (fogChk && !fogChk.checked) state.fogOfWar = false;
  renderer = new Renderer(canvas, state);
  renderer.resize();

  const thinkDelay = autoplay ? 0 : undefined;
  witchAI = witchIsAI ? new WitchAI(state, redraw, thinkDelay) : null;
  heroAI  = heroIsAI  ? new HeroAI(state, redraw, thinkDelay)  : null;

  ui = new UIController(canvas, state, renderer, witchAI, redraw, heroAI, autoplay);

  const battleCallback = (actorSnap, targetSnap, result) =>
    new Promise(resolve => ui._showBattleDialog(actorSnap, targetSnap, result, resolve));

  if (witchAI) witchAI.onBattleResult = battleCallback;
  if (heroAI)  heroAI.onBattleResult  = battleCallback;

  redraw();

  requestAnimationFrame(() => {
    const wrapper = document.getElementById('canvas-wrapper');
    if (!wrapper) return;
    const hero = state.hero;
    const { x, y } = hexToPixel(hero.col, hero.row, renderer.hexSize);
    const cx = x + renderer._padX;
    const cy = y + renderer._padY;
    renderer._panX = wrapper.clientWidth  / 2 - cx;
    renderer._panY = wrapper.clientHeight / 2 - cy;
    renderer._clampPan();
    redraw();
  });

  _startLocalPlanningPhase();
}

function redraw() {
  renderer.draw();
  if (ui) ui._updateSidebar?.();
  if (state?.gameOver) showGameOver();
}

function showGameOver() {
  const el = document.getElementById('game-over');
  if (!el || el.dataset.shown) return;
  el.dataset.shown = '1';

  const banner = state.winner === 'hero'
    ? '☀ The Hero Triumphs!'
    : '🌙 The Witch Prevails!';
  const reason = state.winReason
    || (state.winner === 'hero'
        ? 'The hero has vanquished the witch! Salem is saved!'
        : 'The witch has won. Darkness falls over Salem forever…');

  el.style.display = 'flex';
  el.querySelector('.winner-text').innerHTML =
    `<div class="winner-banner">${banner}</div><div class="winner-reason">${reason}</div>`;
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

async function _runLocalResolution() {
  if (!state || state.gameOver) { showGameOver(); return; }

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

  const humanFaction = !state.heroIsAI ? 'hero' : !state.witchIsAI ? 'witch' : null;
  await _animateResolutionSteps(steps, finalEntities, redraw, humanFaction);

  state.endRound();
  redraw();

  if (state.gameOver) { showGameOver(); return; }

  if (_autoplay) {
    await _delay(300);
  }
  _startLocalPlanningPhase();
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
async function _animateResolutionSteps(steps, finalEntities, redrawFn, humanFaction = null) {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    // Post-step entities: what the world looks like AFTER this step resolves.
    const postEntities = i + 1 < steps.length ? steps[i + 1].entitySnapshot : finalEntities;

    const events = [
      ...(step.heroEvents  ?? []),
      ...(step.witchEvents ?? []),
    ].filter(ev => ev.type === ResEventType.ACTION_OK);

    // ── Phase 1: animate moves for both factions simultaneously ──────────────
    let hadMove = false;
    const pendingDialogs = [];

    for (const ev of events) {
      const { action, result } = ev;
      if (action.type !== PlanActionType.MOVE) continue;

      // Look up pre-step position from this step's snapshot
      const preSnap = step.entitySnapshot?.find(e => e.id === action.entityId);
      const isOpponent = humanFaction && ev.faction !== humanFaction;
      if (preSnap && !(isOpponent && state.fogOfWar)) {
        renderer.addMoveAnim(
          action.entityId,
          preSnap.col, preSnap.row,
          action.toCol, action.toRow,
          preSnap.type, preSnap.owner,
        );
        hadMove = true;
      }

      if ((!humanFaction || ev.faction === humanFaction) && result?.encounterLog?.length) {
        pendingDialogs.push(result.encounterLog);
      }
    }

    // Switch to post-step entity state — when move anims expire the entities
    // are already at their destinations, so no position snap-back occurs.
    state.entities = postEntities;
    redrawFn();

    if (!_autoplay && hadMove) await _delay(520); // slightly longer than anim duration (480ms)
    for (const log of pendingDialogs) {
      redrawFn();
      await new Promise(resolve => ui._showResultDialog(log, resolve));
    }

    // ── Phase 2: battles and summons ──────────────────────────────────────────
    let hadBattle = false;
    for (const ev of events) {
      const { action, result, battleSnaps } = ev;
      if (action.type === PlanActionType.BATTLE_UNIT || action.type === PlanActionType.BATTLE_HEX) {
        // Show dialog if: no fog, human's own action, or human's unit is involved.
        const showDialog = !humanFaction || !state.fogOfWar || ev.faction === humanFaction
          || (battleSnaps && (
               battleSnaps.targetSnap?.owner === humanFaction ||
               battleSnaps.actorSnap?.owner  === humanFaction
             ));
        if (battleSnaps && showDialog) {
          const { actorSnap, targetSnap } = battleSnaps;
          renderer.addAttackAnim(actorSnap.col, actorSnap.row, targetSnap.col, targetSnap.row);
          redrawFn();
          await new Promise(resolve => {
            ui._showBattleDialog(actorSnap, targetSnap, result, resolve);
          });
          hadBattle = true;
        }
      } else if (action.type === PlanActionType.SUMMON) {
        renderer.addFlash(action.toCol, action.toRow, '☠', 'rgba(155,89,182,0.85)', 1200);
        hadBattle = true;
      }
    }

    // ── Phase 3: explore results (human faction only) ─────────────────────────
    for (const ev of events) {
      const { action, result } = ev;
      if (action.type !== PlanActionType.EXPLORE) continue;
      if (result?.log?.length && (!humanFaction || ev.faction === humanFaction)) {
        redrawFn();
        await new Promise(resolve => ui._showResultDialog(result.log, resolve));
        hadBattle = true;
      }
    }

    if (hadMove || hadBattle) {
      redrawFn();
      if (!_autoplay) await _delay(hadMove ? 300 : 250);
    } else if (events.length > 0 && !_autoplay) {
      // Non-visual actions (fortify, use_item, etc.) — brief pause so resolution feels deliberate.
      await _delay(150);
    }
  }

  // Restore the authoritative final state and do one last draw.
  state.entities = finalEntities;
  redrawFn();
}

function _delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ── Online game init ──────────────────────────────────────────────────────────

let mp = null; // MultiplayerClient instance

function initOnline(mirrorState, myFaction, mpClient) {
  state    = mirrorState;
  const canvas = document.getElementById('game-canvas');

  document.getElementById('setup-screen').style.display = 'none';
  document.getElementById('game-screen').style.display  = 'flex';

  renderer = new Renderer(canvas, state);
  renderer.resize();

  // No local AI — all turns handled server-side
  ui = new UIController(canvas, state, renderer, null, redrawOnline, null, false);
  ui.mp = mpClient;

  // Show opponent name / online status
  _updateOnlineStatus(mpClient);

  redrawOnline();

  requestAnimationFrame(() => {
    const wrapper = document.getElementById('canvas-wrapper');
    if (!wrapper) return;
    const hero = state.hero;
    if (!hero) return;
    const { x, y } = hexToPixel(hero.col, hero.row, renderer.hexSize);
    renderer._panX = wrapper.clientWidth  / 2 - (x + renderer._padX);
    renderer._panY = wrapper.clientHeight / 2 - (y + renderer._padY);
    renderer._clampPan();
    redrawOnline();
  });
}

function redrawOnline() {
  if (!renderer) return;
  renderer.draw();
  if (ui) ui._updateSidebar?.();
  if (state?.gameOver) showGameOver();
}

function _updateOnlineStatus(mpClient) {
  const el = document.getElementById('online-status');
  if (!el) return;
  const faction = mpClient.myFaction;
  const symbol  = faction === 'hero' ? '⚔' : '✦';
  el.textContent = `${symbol} Online — Playing as ${faction === 'hero' ? 'Hero' : 'Witch'}`;
  el.style.display = '';
}

// ── Window resize ─────────────────────────────────────────────────────────────

window.addEventListener('resize', () => {
  if (!renderer) return;
  renderer.resize();
  redraw();
});

// ── Setup screen ──────────────────────────────────────────────────────────────

const stepMode    = document.getElementById('setup-step-mode');
const stepSide    = document.getElementById('setup-step-side');
const stepOnline  = document.getElementById('setup-step-online');
const stepWaiting = document.getElementById('setup-step-waiting');

function showStep(step) {
  stepMode   .style.display = step === 'mode'    ? '' : 'none';
  stepSide   .style.display = step === 'side'    ? '' : 'none';
  stepOnline .style.display = step === 'online'  ? '' : 'none';
  stepWaiting.style.display = step === 'waiting' ? '' : 'none';
}

// ── Local mode buttons ────────────────────────────────────────────────────────

document.getElementById('btn-vs-ai')    .addEventListener('click', () => showStep('side'));
document.getElementById('btn-vs-human') .addEventListener('click', () => init(false, false));
document.getElementById('btn-autoplay') .addEventListener('click', () => init(true, true, true));
document.getElementById('btn-back')     .addEventListener('click', () => showStep('mode'));

document.getElementById('btn-play-hero') .addEventListener('click', () => init(true,  false));
document.getElementById('btn-play-witch').addEventListener('click', () => init(false, true));

document.getElementById('btn-restart').addEventListener('click', () => {
  const el = document.getElementById('game-over');
  if (el) { el.style.display = 'none'; delete el.dataset.shown; }

  // Disconnect from server if in online mode
  if (mp) { mp.disconnect(); mp = null; }
  document.getElementById('online-status').style.display = 'none';

  // Reset game objects so initOnline / init start fresh
  renderer = null;
  ui       = null;
  state    = null;
  witchAI  = null;
  heroAI   = null;

  if (_autoplay) {
    init(true, true, true);
  } else {
    showStep('mode');
    document.getElementById('setup-screen').style.display = 'flex';
    document.getElementById('game-screen').style.display  = 'none';
  }
});

// ── Leaderboard ───────────────────────────────────────────────────────────────

document.getElementById('btn-leaderboard').addEventListener('click', () => {
  document.getElementById('leaderboard-overlay').style.display = 'flex';
  _fetchLeaderboard();
});

document.getElementById('leaderboard-close').addEventListener('click', () => {
  document.getElementById('leaderboard-overlay').style.display = 'none';
});

document.getElementById('leaderboard-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('leaderboard-overlay')) {
    document.getElementById('leaderboard-overlay').style.display = 'none';
  }
});

function _fetchLeaderboard() {
  const content = document.getElementById('leaderboard-content');
  content.innerHTML = '<p class="lb-loading">Loading…</p>';

  // Use REST endpoint — works regardless of WS connection state
  const base = window.BRIMSTONE_SERVER || '';
  fetch(`${base}/api/leaderboard`)
    .then(r => r.json())
    .then(entries => _renderLeaderboard(entries))
    .catch(() => { content.innerHTML = '<p class="lb-loading">Could not load (offline mode).</p>'; });
}

function _renderLeaderboard(entries) {
  const content = document.getElementById('leaderboard-content');
  if (!entries.length) {
    content.innerHTML = '<p class="lb-loading">No games recorded yet.</p>';
    return;
  }
  let html = `<table class="lb-table">
    <thead><tr><th>#</th><th>Player</th><th>W</th><th>L</th><th>D</th><th>Win%</th></tr></thead><tbody>`;
  entries.forEach((e, i) => {
    html += `<tr>
      <td class="lb-rank">${i + 1}</td>
      <td class="lb-name">${_esc(e.username)}</td>
      <td class="lb-w">${e.wins}</td>
      <td class="lb-l">${e.losses}</td>
      <td class="lb-d">${e.draws}</td>
      <td class="lb-pct">${e.win_pct}%</td>
    </tr>`;
  });
  html += '</tbody></table>';
  content.innerHTML = html;
}

function _esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Online flow ───────────────────────────────────────────────────────────────

document.getElementById('btn-online').addEventListener('click', () => {
  showStep('online');
  _initOnlineStep();
});

document.getElementById('btn-online-back').addEventListener('click', () => {
  if (mp) { mp.disconnect(); mp = null; }
  renderer = null; ui = null; state = null;
  showStep('mode');
});

document.getElementById('btn-cancel-wait').addEventListener('click', () => {
  if (mp) { mp.leaveQueue(); }
  showStep('online');
});

document.getElementById('btn-join-room').addEventListener('click', () => {
  const form = document.getElementById('join-room-form');
  form.style.display = form.style.display === 'none' ? '' : 'none';
});

document.getElementById('btn-join-room-confirm').addEventListener('click', () => {
  const code = document.getElementById('room-code-input').value.trim().toUpperCase();
  if (code.length !== 6) { _onlineError('Enter a 6-letter room code.'); return; }
  _ensureAuthed(() => mp.joinRoom(code));
});

document.getElementById('btn-quick-match').addEventListener('click', () => {
  _ensureAuthed(() => {
    showStep('waiting');
    document.getElementById('waiting-subtitle').textContent = 'Searching for an opponent…';
    document.getElementById('waiting-message').textContent  = 'Searching for a worthy opponent in Salem… (AI fills in after 5s)';
    document.getElementById('waiting-room-code').style.display = 'none';
    mp.joinQueue();
  });
});

document.getElementById('btn-play-ai-online').addEventListener('click', () => {
  _ensureAuthed(() => {
    showStep('waiting');
    document.getElementById('waiting-subtitle').textContent = 'Starting game vs AI…';
    document.getElementById('waiting-message').textContent  = 'Summoning your opponent from the dark…';
    document.getElementById('waiting-room-code').style.display = 'none';
    mp.playAI();
  });
});

document.getElementById('btn-create-room').addEventListener('click', () => {
  _ensureAuthed(() => {
    showStep('waiting');
    document.getElementById('waiting-subtitle').textContent = 'Creating private room…';
    document.getElementById('waiting-message').textContent  = 'Waiting for your opponent to join…';
    document.getElementById('waiting-room-code').style.display = 'none';
    mp.createRoom();
  });
});

// Room code display (received after createRoom)
document.addEventListener('brimstone:roomCode', e => {
  const { code } = e.detail;
  document.getElementById('waiting-room-code').style.display = '';
  document.getElementById('waiting-code-display').textContent = code;
});

function _initOnlineStep() {
  const session = loadSession();
  const sessionInfo = document.getElementById('online-session-info');
  const nameForm    = document.getElementById('online-name-form');
  const subtitle    = document.getElementById('online-subtitle');

  if (session) {
    document.getElementById('online-session-name').textContent = session.username;
    // Will be filled once we have stats from server
    sessionInfo.style.display = '';
    nameForm.style.display    = 'none';
    subtitle.textContent      = 'Ready to play';
  } else {
    sessionInfo.style.display = 'none';
    nameForm.style.display    = '';
    subtitle.textContent      = 'Choose your name to begin';
  }

  document.getElementById('online-name-error').style.display = 'none';
}

document.getElementById('btn-change-name').addEventListener('click', () => {
  clearSession();
  document.getElementById('online-session-info').style.display = 'none';
  document.getElementById('online-name-form').style.display    = '';
  document.getElementById('online-subtitle').textContent       = 'Choose a new name';
  if (mp) { mp.disconnect(); mp = null; }
  renderer = null; ui = null; state = null;
});

function _onlineError(msg) {
  const el = document.getElementById('online-name-error');
  el.textContent    = msg;
  el.style.display  = '';
}

/** Ensure we have an authenticated MultiplayerClient, then call cb(). */
function _ensureAuthed(cb) {
  const nameInput = document.getElementById('online-username');
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
            showStep('online');
          }
        }
        return;
      }
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
            renderer.addMoveAnim(e.id, old.col, old.row, e.col, e.row, e.type, e.owner);
          }
        }
      }

      ui._clearSelection();
      ui._triggerHazardFlashes();
      redrawOnline();
      if (state.gameOver) showGameOver();
      else ui._maybeShowNoActionsDialog();
    },

    onBattle(actorSnap, targetSnap, result, afterDismiss) {
      // Flash attacker + defender hexes before showing the dialog
      if (renderer && state) {
        const actor  = state.entities.find(e => e.id === actorSnap.id);
        const target = state.entities.find(e => e.id === targetSnap.id);
        if (actor && target) {
          renderer.addAttackAnim(actor.col, actor.row, target.col, target.row);
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

    onMatchFound({ roomId, faction, opponentName, aiOpponent }) {
      document.getElementById('waiting-subtitle').textContent =
        `Matched! You play ${faction === 'hero' ? 'Hero ⚔' : 'Witch ✦'}`;
      document.getElementById('waiting-message').textContent =
        `Opponent: ${opponentName}${aiOpponent ? ' (AI)' : ''}. Starting game…`;
      // Game starts when first stateUpdate arrives → onState handles initOnline
    },

    onLeaderboard(entries) {
      _renderLeaderboard(entries);
    },

    onInQueue(position) {
      document.getElementById('waiting-message').textContent =
        `In queue (position ${position}). An AI will fill in after 5 seconds if no one is found.`;
    },

    onOpponentJoined(name) {
      document.getElementById('waiting-message').textContent =
        `${name} joined! Starting game…`;
    },

    onOpponentDisconnected(graceMs) {
      const secs = Math.round(graceMs / 1000);
      const el = document.getElementById('online-status');
      if (el) el.textContent = `⚠ Opponent disconnected. Waiting ${secs}s for reconnect…`;
    },

    onOpponentReconnected() {
      if (mp) _updateOnlineStatus(mp);
    },

    onPlanningPhase({ heroActionsLeft, witchActionsLeft }) {
      if (!ui || !mp) return;
      const budget = mp.myFaction === 'hero' ? heroActionsLeft : witchActionsLeft;
      ui.exitPlanningMode();
      ui.enterPlanningMode(mp.myFaction, budget);
      ui.onPlanSubmit = (plan) => mp.submitPlan(plan);
    },

    onOpponentReady() {
      const statusEl = document.getElementById('plan-status');
      if (statusEl) statusEl.textContent = 'Opponent ready — waiting for resolution…';
    },

    onResolutionComplete({ steps, finalState }) {
      if (!ui || !renderer) return;
      ui.exitPlanningMode();

      const currentEntities = state.entities; // restored by animation; then overwritten by finalState
      _animateResolutionSteps(steps, currentEntities, redrawOnline, mp?.myFaction).then(() => {
        // Apply final state (next stateUpdate from server will match, so no double anim)
        Object.assign(state, finalState);
        state.hero      = finalState.hero;
        state.witch     = finalState.witch;
        state.myFaction = mp?.myFaction;

        redrawOnline();
        if (state.gameOver) showGameOver();
      });
    },

    onError(msg) {
      // During auth phase, show error in the lobby
      if (!state || document.getElementById('setup-screen').style.display !== 'none') {
        _onlineError(msg);
        showStep('online');
      } else {
        // In-game error — flash in status bar
        const el = document.getElementById('online-status');
        if (el) { el.textContent = `⚠ ${msg}`; }
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
    // show the name-entry form so the error label inside it is visible
    clearSession();
    if (mp) mp._player = null;
    document.getElementById('online-session-info').style.display = 'none';
    document.getElementById('online-name-form').style.display    = '';
    showStep('online');
  }
};
