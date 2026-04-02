/**
 * multiplayer.js — Client-side WebSocket connection and MirrorState.
 *
 * MirrorState is a plain-object reconstruction of GameState from a server
 * snapshot. It has the same properties and stub methods that UIController
 * and getValidActions() rely on, but all mutations go through the server.
 */
import { setMapDimensions } from './hex.js';

// ── Reconnect constants ──────────────────────────────────────────────────────

const RECONNECT_BASE_MS   = 3000;
const RECONNECT_MAX_TRIES = 3;

// ── MirrorEntity ─────────────────────────────────────────────────────────────

const _DISPLAY_NAMES = {
  hero:       'The Hero',
  witch:      'The Witch',
  survivor:   'Survivor',
  zombie:     'Zombie',
  minion:     'Minion',
  wood_golem: 'Wood Golem',
  iron_golem: 'Iron Golem',
};

class MirrorEntity {
  static from(data) {
    const e = Object.assign(new MirrorEntity(), data);
    return e;
  }

  get alive()       { return this.hp > 0; }
  get displayName() { return this.name || _DISPLAY_NAMES[this.type] || this.type; }

  // Stub mutators — server owns all mutations
  takeDamage(amount) { this.hp = Math.max(0, this.hp - amount); return !this.alive; }
  heal(amount)       { this.hp = Math.min(this.maxHp, this.hp + amount); }
  resetTurn()        { this.actedThisTurn = false; this.attackBonus = 0; this.defenseBonus = 0; }
  equipWeapon()      { /* server handles */ }
}

// ── MirrorState ───────────────────────────────────────────────────────────────

export class MirrorState {
  static fromSnapshot(snap) {
    // Restore global map dimensions so the renderer sizes correctly.
    if (snap.mapCols && snap.mapRows) setMapDimensions(snap.mapCols, snap.mapRows);

    const s = new MirrorState();
    s.phase                = snap.phase;
    s.round                = snap.round;
    s.activePlayer         = snap.activePlayer;
    s.actionsLeft          = snap.actionsLeft;
    s.witchIsAI            = snap.witchIsAI;
    s.heroIsAI             = snap.heroIsAI;
    s.fogOfWar             = typeof snap.fogOfWar === 'boolean'
      ? (snap.fogOfWar ? 'partial' : 'none')
      : (snap.fogOfWar ?? 'none');
    s.exploredHexes = {
      hero:  new Set(snap.exploredHexes?.hero  ?? []),
      witch: new Set(snap.exploredHexes?.witch ?? []),
    };
    s._winner              = snap.winner;
    s.winReason            = snap.winReason;
    s.attritionLevel       = snap.attritionLevel;
    s.nodeScore            = snap.nodeScore;
    s.log                  = snap.log;
    s.witchObjectives      = snap.witchObjectives;
    s.inventory            = snap.inventory;
    s.postRoundEvents      = snap.postRoundEvents || [];
    s.nodeSpawnedSurvivors = snap.nodeSpawnedSurvivors || [];
    s.planningPhase        = snap.planningPhase   ?? false;
    s.resolving            = snap.resolving       ?? false;
    s.heroReady            = snap.heroReady       ?? false;
    s.witchReady           = snap.witchReady      ?? false;
    s.heroActionsLeft      = snap.heroActionsLeft  ?? 0;
    s.witchActionsLeft     = snap.witchActionsLeft ?? 0;
    s.players              = (snap.players ?? []).map(p => ({ ...p }));

    // Reconstruct tiles as a Map keyed by "col,row"
    s.tiles = new Map();
    for (const t of snap.tiles) {
      // roadDirs arrives as a plain array; restore it to a Set so the renderer
      // can spread it with [...tile.roadDirs] without throwing.
      t.roadDirs = new Set(t.roadDirs || []);
      s.tiles.set(t.key, t);
    }

    // Reconstruct entities with MirrorEntity methods
    s.entities = snap.entities.map(e => MirrorEntity.from(e));
    s.hero  = s.entities.find(e => e.id === snap.heroId)  || null;
    s.witch = s.entities.find(e => e.id === snap.witchId) || null;

    return s;
  }

  get actionsAvailable() { return this.actionsLeft; }
  get gameOver()         { return this._winner !== null; }
  get winner()           { return this._winner; }

  // Stub methods — server owns the state
  addLog()       { /* no-op */ }
  spendAction()  { /* no-op */ }
  checkVictory() { /* no-op */ }
}

// ── MultiplayerClient ─────────────────────────────────────────────────────────

export class MultiplayerClient {
  /**
   * @param {object}   opts
   * @param {string}   opts.serverUrl   WebSocket URL of the game server
   * @param {Function} opts.onState     Called with (MirrorState) on each state update
   * @param {Function} opts.onBattle    Called with (actorSnap, targetSnap, result) for battle dialog
   * @param {Function} opts.onMatchFound  Called with ({roomId, faction, opponentName, aiOpponent})
   * @param {Function} opts.onLeaderboard Called with (entries[])
   * @param {Function} opts.onError     Called with (message)
   * @param {Function} opts.onOpponentDisconnected  Called with (graceMs)
   * @param {Function} opts.onOpponentReconnected
   * @param {Function} opts.onOpponentJoined  Called with (opponentName)
   * @param {Function} opts.onOpponentForfeited
   * @param {Function} opts.onInQueue   Called with (position)
   * @param {Function} opts.onPlanningPhase Called with ({heroActionsLeft, witchActionsLeft, timeoutMs})
   * @param {Function} opts.onOpponentReady   Called with no args — opponent locked in their plan
   * @param {Function} opts.onResolutionComplete  Called with ({steps, finalState: MirrorState})
   */
  constructor(opts) {
    this._opts      = opts;
    this._ws        = null;
    this._player    = null;  // { id, username, token, wins, losses, draws }
    this.myFaction  = null;  // 'hero' | 'witch'
    this.myPlayerId = null;  // player UUID (from matchFound)
    this.roomId     = null;
    this._lobbyId   = null;  // current lobby room ID (pre-game)
    this.active     = false; // true once in a game room
    this._queue     = [];    // buffered outgoing messages before connection
    this._pendingBattle = null; // battle result waiting to be shown after server state arrives
    this._reconnectAttempt = 0;
    this._reconnectTimer   = null;
    this._boundOnClose     = null; // stored so we can removeEventListener before replacing the WS
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get player()   { return this._player; }
  get connected(){ return this._ws?.readyState === 1; }

  connect(serverUrl) {
    // Detach the old close listener before closing so it doesn't trigger _scheduleReconnect
    if (this._ws) {
      if (this._boundOnClose) this._ws.removeEventListener('close', this._boundOnClose);
      this._ws.close();
    }
    this._boundOnClose = () => this._onClose();
    this._ws = new WebSocket(serverUrl);

    this._ws.addEventListener('open',    () => this._onOpen());
    this._ws.addEventListener('message', e  => this._onMessage(e));
    this._ws.addEventListener('close',   this._boundOnClose);
    this._ws.addEventListener('error',   () => this._opts.onError?.('Connection error.'));
  }

  disconnect() {
    this.active = false;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._reconnectAttempt = 0;
    this._ws?.close();
  }

  /** Authenticate — pass token for returning players, username for new ones. */
  auth({ username, token, roomId } = {}) {
    this._send({ type: 'auth', username, token, roomId });
  }

  /** Create a new game lobby. config: { fog, mapSize, playersPerSide, isPrivate } */
  createLobby(config = {}) { this._send({ type: 'createLobby', ...config }); }

  /** Join a lobby by room ID (public) or 6-char code (private). */
  joinLobby(codeOrId)      { this._send({ type: 'joinLobby', codeOrId }); }

  /** Request the list of open public lobbies. */
  browseLobby()            { this._send({ type: 'browseLobby' }); }

  /** Host: assign AI to a slot. personality: key or 'random'. */
  setSlotAI(roomId, slotIndex, personality) {
    this._send({ type: 'setSlotAI', roomId, slotIndex, personality });
  }

  /** Host: remove AI from a slot. */
  removeSlotAI(roomId, slotIndex) {
    this._send({ type: 'removeSlotAI', roomId, slotIndex });
  }

  /** Host: fill all empty slots with AI. personality: key or 'random'. */
  fillAllWithAI(roomId, personality = 'random') {
    this._send({ type: 'fillAllWithAI', roomId, personality });
  }

  /** Host: start the game once all slots are filled. */
  startGame(roomId) { this._send({ type: 'startGame', roomId }); }

  /** Leave the lobby before the game starts. */
  leaveLobby(roomId) { this._send({ type: 'leaveLobby', roomId }); }

  requestLeaderboard() { this._send({ type: 'requestLeaderboard' }); }

  sendAction(actionType, params = {}) {
    this._send({ type: 'action', actionType, ...params });
  }

  sendEndTurn() {
    this._send({ type: 'endTurn' });
  }

  /** Submit the player's plan for the current round. */
  submitPlan(plan) {
    this._send({ type: 'submitPlan', plan });
  }

  /** Request the server to restore a saved game by its room ID. */
  resumeSave(roomId) {
    this._send({ type: 'resumeSave', roomId });
  }

  // ── Async game methods ─────────────────────────────────────────────────────

  /** Connect to an async game to view state and/or submit a plan. */
  connectAsync(roomId) {
    this._asyncRoomId = roomId;
    this._send({ type: 'connectAsync', roomId });
  }

  /** Submit a plan for the current async round. */
  submitAsyncPlan(roomId, plan) {
    this._send({ type: 'submitAsyncPlan', roomId, plan });
  }

  /** Disconnect from an async game session. */
  disconnectAsync() {
    this._asyncRoomId = null;
    this._send({ type: 'disconnectAsync' });
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _send(obj) {
    const str = JSON.stringify(obj);
    if (this._ws?.readyState === 1) {
      this._ws.send(str);
    } else {
      this._queue.push(str);
    }
  }

  _onOpen() {
    this._reconnectAttempt = 0;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    // Flush queued messages
    for (const str of this._queue) this._ws.send(str);
    this._queue = [];
  }

  _onClose() {
    if (this.active) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._reconnectAttempt >= RECONNECT_MAX_TRIES) {
      this._opts.onError?.('Unable to reconnect. Please refresh the page.');
      this._reconnectAttempt = 0;
      return;
    }
    const delay   = RECONNECT_BASE_MS * (2 ** this._reconnectAttempt);
    const attempt = this._reconnectAttempt + 1;
    this._opts.onError?.(`Disconnected. Reconnecting (${attempt}/${RECONNECT_MAX_TRIES}) in ${delay / 1000}s…`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectAttempt++;
      this._reconnect();
    }, delay);
  }

  _reconnect() {
    if (!this._player) return;
    const url = this._ws?.url;
    if (!url) return;
    this.connect(url);
    // Re-authenticate and attempt to rejoin room
    this.auth({ token: this._player.token, roomId: this.roomId });
  }

  _onMessage(event) {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    try {
      this._route(msg);
    } catch (err) {
      console.error('Multiplayer _route error:', err);
      this._opts.onError?.(`Client error: ${err.message}`);
    }
  }

  _route(msg) {
    switch (msg.type) {

      case 'authOk':
        this._player = msg.player;
        // Persist session to localStorage
        try {
          localStorage.setItem('brimstone_session', JSON.stringify({
            id:       msg.player.id,
            username: msg.player.username,
            token:    msg.player.token,
            is_admin: msg.player.is_admin || false,
          }));
        } catch {}
        // If we were in an async game, re-connect to it after re-auth
        if (this._asyncRoomId) {
          this.connectAsync(this._asyncRoomId);
        }
        break;

      case 'authError':
        this._opts.onError?.(msg.message);
        break;

      case 'leaderboard':
        this._opts.onLeaderboard?.(msg.entries);
        break;

      case 'inQueue':
        this._opts.onInQueue?.(msg.position);
        break;

      case 'lobbyJoined':
        this._lobbyId = msg.lobby?.id ?? null;
        this._opts.onLobbyJoined?.(msg.lobby);
        break;

      case 'lobbyUpdate':
        this._opts.onLobbyUpdate?.(msg.lobby);
        break;

      case 'lobbyList':
        this._opts.onLobbyList?.(msg.rooms);
        break;

      case 'opponentJoined':
        this._opts.onOpponentJoined?.(msg.opponentName);
        break;

      case 'matchFound':
        this.myFaction  = msg.faction;
        this.myPlayerId = msg.myPlayerId ?? null;
        this.roomId     = msg.roomId;
        this.active     = true;
        // Register roomId with server so it can route actions to us
        this._send({ type: 'setRoom', roomId: msg.roomId });
        this._opts.onMatchFound?.(msg);
        break;

      case 'reconnected':
        this.myFaction  = msg.faction;
        this.myPlayerId = msg.myPlayerId ?? null;
        this.roomId     = msg.roomId;
        this.active     = true;
        this._send({ type: 'setRoom', roomId: msg.roomId });
        break;

      case 'playerSubmitted':
        this._opts.onPlayerSubmitted?.(msg);
        break;

      case 'stateUpdate':
      case 'actionResult': {
        const mirror = MirrorState.fromSnapshot(msg.state);
        // If a battle result is pending, deliver it before the state update
        if (this._pendingBattle) {
          const { actorSnap, targetSnap, result } = this._pendingBattle;
          this._pendingBattle = null;
          this._opts.onBattle?.(actorSnap, targetSnap, result, () => {
            this._opts.onState?.(mirror);
          });
        } else {
          this._opts.onState?.(mirror);
        }
        break;
      }

      case 'battleResult':
        // Store until the accompanying stateUpdate arrives
        this._pendingBattle = msg;
        break;

      case 'opponentDisconnected':
        this._opts.onOpponentDisconnected?.(msg.graceMs);
        break;

      case 'opponentReconnected':
        this._opts.onOpponentReconnected?.();
        break;

      case 'opponentForfeited':
        this._opts.onError?.('Your opponent forfeited. You win!');
        this.active = false;
        break;

      case 'planningPhase':
        this._opts.onPlanningPhase?.(msg);
        break;

      case 'opponentReady':
        this._opts.onOpponentReady?.();
        break;

      case 'timerReset':
        this._opts.onTimerReset?.(msg.timeoutMs);
        break;

      case 'resolutionComplete': {
        const mirror = MirrorState.fromSnapshot(msg.finalState);
        this._opts.onResolutionComplete?.({ steps: msg.steps, finalState: mirror });
        break;
      }

      // ── Async game messages ─────────────────────────────────────
      case 'asyncStateUpdate':
        this._opts.onAsyncStateUpdate?.(msg);
        break;

      case 'asyncPlanStatus':
        this._opts.onAsyncPlanStatus?.(msg);
        break;

      case 'asyncPlanAccepted':
        this._opts.onAsyncPlanAccepted?.(msg);
        break;

      case 'asyncOpponentJoined':
        this._opts.onAsyncOpponentJoined?.(msg);
        break;

      case 'asyncResolution': {
        const mirror = MirrorState.fromSnapshot(msg.finalState);
        this._opts.onAsyncResolution?.({
          roomId: msg.roomId, steps: msg.steps, finalState: mirror,
          finalStateSnapshot: msg.finalState,
          resolvedRound: msg.resolvedRound, preStateJson: msg.preStateJson,
        });
        break;
      }

      case 'error':
      case 'actionError':
        this._opts.onError?.(msg.message);
        break;

      default:
        break;
    }
  }
}

// ── Session helpers ───────────────────────────────────────────────────────────

/** Load a saved session from localStorage, or null. */
export function loadSession() {
  try {
    const raw = localStorage.getItem('brimstone_session');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Clear the saved session (logout). */
export function clearSession() {
  try { localStorage.removeItem('brimstone_session'); } catch {}
}

// ── Email auth helpers ───────────────────────────────────────────────────────

/**
 * Request a magic link to link an email to the current account.
 * @param {string} token  - The player's session token
 * @param {string} email  - Email address to link
 * @returns {Promise<{ok: boolean, message?: string, error?: string}>}
 */
export async function requestLinkEmail(token, email) {
  try {
    const res = await fetch(`${window.BRIMSTONE_SERVER || ''}/auth/link-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, email }),
    });
    return await res.json();
  } catch {
    return { ok: false, error: 'Network error. Please try again.' };
  }
}

/**
 * Request a magic link to log in from a new device.
 * @param {string} email  - Email address associated with the account
 * @returns {Promise<{ok: boolean, message?: string, error?: string}>}
 */
export async function requestEmailLogin(email) {
  try {
    const res = await fetch(`${window.BRIMSTONE_SERVER || ''}/auth/login-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    return await res.json();
  } catch {
    return { ok: false, error: 'Network error. Please try again.' };
  }
}

/**
 * Fetch the player's linked identities.
 * @param {string} token  - The player's session token
 * @returns {Promise<Array|null>} Array of identities, or null if the token was rejected (401).
 */
export async function fetchIdentities(token) {
  try {
    const res = await fetch(`/api/identities?token=${encodeURIComponent(token)}`);
    if (res.status === 401) return null;
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

/**
 * Check for an email_token in the URL (from magic link redirect).
 * If found, authenticate with it and strip the param from the URL.
 * @returns {string|null} The session token from the URL, or null.
 */
export function checkEmailTokenInUrl() {
  const params = new URLSearchParams(window.location.search);
  const emailToken = params.get('email_token');
  if (!emailToken) return null;

  // Strip the token from the URL without reloading
  params.delete('email_token');
  const newUrl = params.toString()
    ? `${window.location.pathname}?${params}`
    : window.location.pathname;
  window.history.replaceState({}, '', newUrl);

  return emailToken;
}
