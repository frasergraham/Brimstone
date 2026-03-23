/**
 * multiplayer.js — Client-side WebSocket connection and MirrorState.
 *
 * MirrorState is a plain-object reconstruction of GameState from a server
 * snapshot. It has the same properties and stub methods that UIController
 * and getValidActions() rely on, but all mutations go through the server.
 */

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
    const s = new MirrorState();
    s.phase                = snap.phase;
    s.round                = snap.round;
    s.activePlayer         = snap.activePlayer;
    s.actionsLeft          = snap.actionsLeft;
    s.witchIsAI            = snap.witchIsAI;
    s.heroIsAI             = snap.heroIsAI;
    s.fogOfWar             = snap.fogOfWar;
    s._winner              = snap.winner;
    s.winReason            = snap.winReason;
    s.witchSummonsThisTurn = snap.witchSummonsThisTurn;
    s.attritionLevel       = snap.attritionLevel;
    s.nodeScore            = snap.nodeScore;
    s.log                  = snap.log;
    s.witchObjectives      = snap.witchObjectives;
    s.inventory            = snap.inventory;
    s.lastNightDamage      = snap.lastNightDamage || [];
    s.lastDayDamage        = snap.lastDayDamage   || [];
    s.lastHazardLog        = snap.lastHazardLog   || [];

    // Reconstruct tiles as a Map keyed by "col,row"
    s.tiles = new Map();
    for (const t of snap.tiles) s.tiles.set(t.key, t);

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
  endTurn()      { /* intercepted by multiplayer layer */ }
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
   */
  constructor(opts) {
    this._opts     = opts;
    this._ws       = null;
    this._player   = null;  // { id, username, token, wins, losses, draws }
    this.myFaction = null;  // 'hero' | 'witch'
    this.roomId    = null;
    this.active    = false; // true once in a game room
    this._queue    = [];    // buffered outgoing messages before connection
    this._pendingBattle = null; // battle result waiting to be shown after server state arrives
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get player()   { return this._player; }
  get connected(){ return this._ws?.readyState === 1; }

  connect(serverUrl) {
    if (this._ws) this._ws.close();
    this._ws = new WebSocket(serverUrl);

    this._ws.addEventListener('open',    () => this._onOpen());
    this._ws.addEventListener('message', e  => this._onMessage(e));
    this._ws.addEventListener('close',   () => this._onClose());
    this._ws.addEventListener('error',   () => this._opts.onError?.('Connection error.'));
  }

  disconnect() {
    this.active = false;
    this._ws?.close();
  }

  /** Authenticate — pass token for returning players, username for new ones. */
  auth({ username, token, roomId } = {}) {
    this._send({ type: 'auth', username, token, roomId });
  }

  joinQueue()  { this._send({ type: 'joinQueue'  }); }
  leaveQueue() { this._send({ type: 'leaveQueue' }); }

  createRoom() { this._send({ type: 'createRoom' }); }
  joinRoom(code) { this._send({ type: 'joinRoom', code }); }

  requestLeaderboard() { this._send({ type: 'requestLeaderboard' }); }

  sendAction(actionType, params = {}) {
    this._send({ type: 'action', actionType, ...params });
  }

  sendEndTurn() {
    this._send({ type: 'endTurn' });
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
    // Flush queued messages
    for (const str of this._queue) this._ws.send(str);
    this._queue = [];
  }

  _onClose() {
    if (this.active) {
      this._opts.onError?.('Disconnected from server. Attempting to reconnect…');
      // Reconnect after 3s
      setTimeout(() => this._reconnect(), 3000);
    }
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
    this._route(msg);
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
          }));
        } catch {}
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

      case 'roomCode':
        // Private room created — show code to user via lobby UI
        document.dispatchEvent(new CustomEvent('brimstone:roomCode', {
          detail: { code: msg.code, roomId: msg.roomId }
        }));
        break;

      case 'opponentJoined':
        this._opts.onOpponentJoined?.(msg.opponentName);
        break;

      case 'matchFound':
        this.myFaction = msg.faction;
        this.roomId    = msg.roomId;
        this.active    = true;
        // Register roomId with server so it can route actions to us
        this._send({ type: 'setRoom', roomId: msg.roomId });
        this._opts.onMatchFound?.(msg);
        break;

      case 'reconnected':
        this.myFaction = msg.faction;
        this.roomId    = msg.roomId;
        this.active    = true;
        this._send({ type: 'setRoom', roomId: msg.roomId });
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
