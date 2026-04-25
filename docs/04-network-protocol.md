# Network Protocol & Multiplayer Architecture

## Transport

- **WebSocket** (via `ws` library) for real-time game protocol
- **HTTP REST** (Express) for metadata, leaderboard, config, admin
- All messages are JSON-encoded strings
- Server listens on port 3000 (configurable via `PORT` env var)

## Connection Lifecycle

```
Client                                          Server
  │                                               │
  │──── WS connect ──────────────────────────────→│
  │                                               │ clientState(ws) created
  │                                               │
  │──── { type: 'auth', token/username } ────────→│
  │                                               │ registerOrLogin()
  │←─── { type: 'authOk', player } ──────────────│
  │                                               │ _registerPlayerWs()
  │                                               │
  │     ... game messages ...                     │
  │                                               │
  │──── WS close ────────────────────────────────→│
  │                                               │ handleDisconnect()
  │                                               │ _unregisterPlayerWs()
  │                                               │ start grace period (60s)
```

## Client State

Each WebSocket connection has a `clientState` object on the server:

```javascript
{
  player: null,           // Player record (after auth)
  roomId: null,           // Active game room (if any)
  asyncRoomId: null,      // Async game session (if any)
  spectatingRooms: Set(), // Admin spectator subscriptions
  inactive: false         // App backgrounded (mobile)
}
```

## Message Protocol

### Authentication

```
CLIENT → SERVER                          SERVER → CLIENT
─────────────────                        ─────────────────
auth                                     authOk
  { username, token, roomId? }             { player }
                                         authError
authGameCenter                             { message }
  { gameCenterId, displayName }
                                         reconnected
linkGameCenter                             { faction, myPlayerId, roomId }
  { gameCenterId }
```

### Lobby & Matchmaking

```
CLIENT → SERVER                          SERVER → CLIENT
─────────────────                        ─────────────────
createLobby                              lobbyJoined
  { fog, mapSize, playersPerSide,          { lobby }
    isPrivate }
                                         lobbyUpdate
joinLobby                                  { lobby }
  { codeOrId }
                                         lobbyList
browseLobby                                { rooms[] }
  (no params)
                                         matchFound
joinGame                                   { roomId, faction, myPlayerId,
  { codeOrId }                               players[], aiOpponent, isAsync }

claimSlot                                opponentJoined
  { roomId, slotIndex,                     { opponentName }
    factionId? }
                                         (factionId optional; defaults to
                                          the slot's side primary. Must
                                          match the slot's side or it is
                                          silently ignored.)
setFaction
  { roomId, factionId }
                                         (Pre-game only. Must be a faction
                                          on the same Side as the seat. A
                                          cross-side switch returns an
                                          'error' message.)

setSlotAI
  { roomId, slotIndex, personality }

removeSlotAI
  { roomId, slotIndex }

fillAllWithAI
  { roomId, personality? }

startGame
  { roomId }

leaveLobby
  { roomId }

sendSlotInvite
  { roomId, slotIndex, email }
```

**Lobby slot fields.** Every `slot` in `lobbyJoined` / `lobbyUpdate` carries:

| Field       | Type        | Notes |
|-------------|-------------|-------|
| `faction`   | `'hero'\|'witch'` | Legacy primary key; today the slot's side default. |
| `side`      | `'day'\|'night'`  | Forward-looking — derived via `sideOf(faction)`. |
| `factionId` | string      | The specific faction id occupying the seat (defaults to `faction`; mutated by `setFaction`). |
| other       | seatIndex, status, playerId, name, personality, … (unchanged) |

### Game Flow

```
CLIENT → SERVER                          SERVER → CLIENT
─────────────────                        ─────────────────
                                         planningPhase
                                           { heroActionsLeft, witchActionsLeft,
                                             timeoutMs }

submitPlan                               playerSubmitted
  { roomId, plan[] }                       { playerId }

                                         opponentReady
                                           (no payload)

                                         timerReset
                                           { timeoutMs }

                                         resolutionComplete
                                           { steps[], finalState }

                                         stateUpdate
                                           { state, reason }

requestState                             (triggers stateUpdate response)
  (no params)

setRoom
  { roomId }   (null to clear)
```

### Player Interaction

```
CLIENT → SERVER                          SERVER → CLIENT
─────────────────                        ─────────────────
nudge                                    nudged
  { targetPlayerId }                       { fromPlayerId, fromName, roomId }

                                         nudgeAck
                                           { targetPlayerId }

resignGame                               playerResigned
  { roomId }                               { playerId, playerName }

                                         playerTakenOver
                                           { playerId }

                                         opponentDisconnected
                                         opponentReconnected
                                         opponentForfeited

                                         playerPresence
                                           { players[] }
```

### Async (Play-by-Mail) Games

```
CLIENT → SERVER                          SERVER → CLIENT
─────────────────                        ─────────────────
connectAsync                             asyncStateUpdate
  { roomId }                               { roomId, state, faction,
                                             myPlayerId, round, phase,
submitAsyncPlan                              turnDeadline, myPlanSubmitted,
  { roomId, plan }                           myPlanActions, planStatus[],
                                             lastRound, myActionsLeft, ... }
disconnectAsync
                                         asyncPlanAccepted
                                           { roomId }

                                         asyncPlanStatus
                                           { roomId, planStatus[] }

                                         asyncOpponentJoined
                                           { roomId, opponentName }
```

### Heartbeat & State Sync

```
Server sends every 15 seconds to clients in active games:

  { type: 'heartbeat',
    roomId, round, planningPhase,
    gameOver, playersReady[] }

Client compares against local state.
On mismatch → sends { type: 'requestState' }
Server responds with full state via resumeGame().
```

### Control Messages

```
CLIENT → SERVER                          SERVER → CLIENT
─────────────────                        ─────────────────
setInactive                              error
  { inactive: boolean }                    { message }

                                         actionError
                                           { message }

                                         gamesUpdate
                                           (triggers REST fetch)
```

## Room Lifecycle

```
┌───────────────────────────────────────────────────────────────┐
│                        LOBBY PHASE                            │
│                                                               │
│  createLobby() → room created with slots                     │
│  Players join → fill hero/witch team slots                    │
│  Host can: setSlotAI, removeSlotAI, fillAllWithAI             │
│  Host clicks startGame() when all slots filled                │
│                                                               │
│  Status: 'lobby'                                              │
└───────────────────────────────┬───────────────────────────────┘
                                │ startGame()
                                ▼
┌───────────────────────────────────────────────────────────────┐
│                       PLAYING PHASE                           │
│                                                               │
│  ┌─────────────────────────────────────────────────┐          │
│  │  Planning → Submit → Resolve → Post-Round ──┐   │          │
│  │       ▲                                     │   │          │
│  │       └─────────────────────────────────────┘   │          │
│  └─────────────────────────────────────────────────┘          │
│                                                               │
│  Auto-save after each round                                   │
│  AI fills in for disconnected players                         │
│  Heartbeat every 15s for state sync                           │
│                                                               │
│  Status: 'playing'                                            │
└────────────────────┬──────────────────┬───────────────────────┘
                     │                  │
              victory condition    all humans
              met                  disconnect
                     │                  │
                     ▼                  ▼
┌────────────────────────┐  ┌───────────────────────┐
│      GAME OVER         │  │     HIBERNATION       │
│                        │  │                       │
│  Record stats          │  │  Save state to DB     │
│  Save completed game   │  │  Remove from memory   │
│  Update leaderboard    │  │  Background deadline   │
│  Cleanup room          │  │  checker resolves     │
└────────────────────────┘  │  expired turns        │
                            │                       │
                            │  Player reconnects →  │
                            │  recover from DB      │
                            └───────────────────────┘
```

## Reconnection Flow

### Client Side (`src/multiplayer.js`)

```
WebSocket closes unexpectedly
  │
  ▼
_scheduleReconnect()
  │
  ├── Attempt 1: wait 3s → connect + auth(token, roomId)
  ├── Attempt 2: wait 6s → connect + auth(token, roomId)
  └── Attempt 3: wait 12s → connect + auth(token, roomId)
       │
       ├── Success → onReconnected() callback
       │              flush queued messages
       │
       └── All failed → onReconnectFailed() callback
                        show "connection lost" UI
```

### Server Side (`server/lobby.js`)

```
handleDisconnect(playerId, roomId):
  │
  ├── Mark seat offline
  ├── Broadcast 'opponentDisconnected'
  └── Start 60s grace period
       │
       ├── Player reconnects within grace:
       │     handleReconnect(playerId, roomId, ws)
       │       ├── Find seat by playerId
       │       ├── If seat was AI-replaced → swap back to human
       │       ├── Attach new WebSocket
       │       ├── Send 'reconnected' + full state
       │       └── Broadcast 'opponentReconnected'
       │
       └── Grace expires + 2 missed deadlines:
             _checkTimeoutTakeovers()
               ├── Replace seat with AI
               └── Broadcast 'playerTakenOver'
```

## MirrorState (Client-Side State)

In online mode, the client doesn't run `GameState` — it holds a read-only `MirrorState`:

```
┌─────────────────────────────────────────┐
│              MirrorState                 │
│                                         │
│  Deserialized from server snapshot      │
│  Same field names as GameState          │
│  Methods are stubs (no-ops):            │
│    addLog(), spendAction(), etc.        │
│                                         │
│  entities[] → MirrorEntity instances    │
│    Same fields as Entity                │
│    Methods are stubs                    │
│    Computed: .alive, .displayName       │
│                                         │
│  Used by:                               │
│    renderer.js → reads for drawing      │
│    ui.js → reads for click handling     │
│    planner.js → reads for validation    │
└─────────────────────────────────────────┘
```

## Online Game Flow (Complete Sequence)

```
Player A (Hero)                Server                    Player B (Witch)
    │                            │                            │
    │── createLobby ────────────→│                            │
    │←── lobbyJoined ────────────│                            │
    │                            │                            │
    │                            │←──── joinLobby ────────────│
    │←── lobbyUpdate ────────────│──── lobbyJoined ──────────→│
    │                            │                            │
    │── startGame ──────────────→│                            │
    │←── matchFound ─────────────│──── matchFound ───────────→│
    │                            │                            │
    │    ┌───────── Round Loop ──┼──────────────────┐         │
    │    │                       │                  │         │
    │←───┼── planningPhase ──────│── planningPhase ─┼────────→│
    │    │                       │                  │         │
    │────┼── submitPlan ────────→│                  │         │
    │←───┼── playerSubmitted ────│── opponentReady ─┼────────→│
    │    │                       │                  │         │
    │    │                       │←── submitPlan ───┼─────────│
    │←───┼── opponentReady ──────│── playerSubmitted┼────────→│
    │    │                       │                  │         │
    │    │              resolvePlansMP()             │         │
    │    │                       │                  │         │
    │←───┼── resolutionComplete ─│── resolutionComplete ─────→│
    │    │                       │                  │         │
    │    │         state.endRound() + save           │         │
    │    │                       │                  │         │
    │    └───────────────────────┼──────────────────┘         │
    │                            │                            │
    │←── stateUpdate (gameOver) ─│── stateUpdate (gameOver) ─→│
```

## REST API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | No | Service health check |
| GET | `/api/config` | No | Game mode configuration |
| GET | `/api/leaderboard` | No | Top 20 players |
| GET | `/api/games` | Token | Player's active games |
| GET | `/api/saves` | Token | Legacy alias for `/api/games` |
| GET | `/api/async-games` | Token | Player's async games |
| GET | `/api/environments` | No | Railway environment discovery |
| GET | `/admin/api/game-stats/*` | Admin | Aggregate game analytics |

## CORS Policy

Allows origins:
- `capacitor://localhost` (iOS native shell)
- `http://localhost` (local development)
