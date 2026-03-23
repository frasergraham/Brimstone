// Entry point: wires all modules, setup screen flow, resize
import { GameState, Player } from './game.js';
import { Renderer }          from './renderer.js';
import { UIController }      from './ui.js';
import { WitchAI, HeroAI }   from './ai.js';
import { hexToPixel }        from './hex.js';
import { MultiplayerClient, MirrorState, loadSession, clearSession } from './multiplayer.js';
import { VERSION }           from './version.js';

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
  ui.refresh();

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
      Object.assign(state, mirrorState);
      state.hero  = mirrorState.hero;
      state.witch = mirrorState.witch;
      ui._clearSelection();
      ui._triggerHazardFlashes();
      redrawOnline();
      if (state.gameOver) showGameOver();
    },

    onBattle(actorSnap, targetSnap, result, afterDismiss) {
      if (ui) {
        ui._showBattleDialog(actorSnap, targetSnap, result, afterDismiss);
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
