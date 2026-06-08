# State Machines

Brimstone uses three interlocking state machines: the **App Mode** (UI lifecycle), the **Phase Cycle** (game time), and the **Turn Lifecycle** (planning → resolution → scoring).

---

## 1. App Mode State Machine

Defined in `src/app-mode.js`. Controls what the player sees and what inputs are accepted.

### States

| Mode | Description |
|------|-------------|
| `MENU` | Browsing menus, lobby, game list. Game callbacks are no-ops. |
| `PLANNING` | In a game, building a plan (not yet submitted). |
| `SUBMITTED` | Plan locked, waiting for opponents. |
| `RESOLVING` | Watching turn resolution animation (current round). |
| `SUMMARY` | Post-resolution summary dialog. |
| `PLAYBACK` | Full-game replay viewer (completed games only). |
| `SPECTATING` | Read-only live game view. |

### Transition Diagram

```
                    ┌──────────────────────────────────────────────┐
                    │                                              │
                    ▼                                              │
               ┌────────┐   initOnline() /          ┌──────────┐  │
               │  MENU  │──_startLocalPlanning()───→│ PLANNING │  │
               └────────┘                           └────┬─────┘  │
                 ▲    │                                  │         │
                 │    │ initSpectator()        plan submitted      │
                 │    │                                  │         │
                 │    ▼                                  ▼         │
                 │  ┌────────────┐              ┌───────────┐     │
                 │  │ SPECTATING │              │ SUBMITTED │     │
                 │  └────────────┘              └─────┬─────┘     │
                 │                                    │           │
                 │                        all plans received      │
                 │                                    │           │
                 │                                    ▼           │
                 │                             ┌───────────┐      │
                 │         ┌───────────────────│ RESOLVING │──────┘
                 │         │  inline replay    └─────┬─────┘  game over,
                 │         │  finishes               │        exit
                 │         │                animation done
                 │         │                         │
                 │         │                         ▼
                 │         │                   ┌─────────┐
                 │         └───────────────────│ SUMMARY │
                 │                             └────┬────┘
                 │                                  │
                 │              ┌────────────────────┼────────────┐
                 │              │                    │            │
                 │         dismiss to           re-watch     full replay
                 │         next round            round       (game over)
                 │              │                    │            │
                 │              ▼                    ▼            ▼
                 │         ┌──────────┐      ┌───────────┐ ┌──────────┐
                 │         │ PLANNING │      │ RESOLVING │ │ PLAYBACK │
                 │         └──────────┘      └───────────┘ └────┬─────┘
                 │                                              │
                 │              replay ends or stopped           │
                 └──────────────────────────────────────────────┘
```

### Key Helper Functions

```javascript
getMode()              // Current AppMode value
setMode(newMode)       // Transition + fire listeners
onModeChange(fn)       // Register (newMode, oldMode) callback
isInGame()             // true when NOT MENU or SPECTATING
isAnimating()          // true when RESOLVING or PLAYBACK
shouldBufferMessages() // true when RESOLVING, SUMMARY, or PLAYBACK
```

### Rules

- **`main.js` owns all transitions** — `ui.js` reads the mode but never calls `setMode()`.
- **Message buffering** — During RESOLVING, SUMMARY, or PLAYBACK, incoming server WebSocket messages are queued and replayed when the player returns to PLANNING or MENU.
- **Playback sub-state** — `_playback` object in `main.js` holds pause/abort/speed flags, only meaningful during PLAYBACK mode.

---

## 2. Phase Cycle (Game Time)

Defined in `src/game.js`. Controls day/night rhythm, scoring checkpoints, and faction bonuses.

### Cycle Structure

One full cycle = **8 rounds**:

```
Round:  0       1       2       3       4       5       6       7       0 ...
Phase:  DAWN    DAY     DAY     DAY     DUSK    NIGHT   NIGHT   NIGHT   DAWN ...
        ├─1r─┤  ├──────3 rounds──────┤  ├─1r─┤  ├──────3 rounds──────┤
        score                           score
```

### Phase Diagram

```
        ┌───────────────────────────────────────────┐
        │                                           │
        ▼                                           │
   ┌─────────┐    after 1    ┌─────────┐            │
   │  DAWN   │──────────────→│   DAY   │            │
   │ (score) │   round       │ 3 rounds│            │
   └─────────┘               └────┬────┘            │
                                  │ after 3          │
                                  │ rounds           │
                                  ▼                  │
                             ┌─────────┐             │
                             │  DUSK   │             │
                             │ (score) │             │
                             └────┬────┘             │
                                  │ after 1          │
                                  │ round            │
                                  ▼                  │
                             ┌─────────┐             │
                             │  NIGHT  │─────────────┘
                             │ 3 rounds│  after 3 rounds
                             └─────────┘
```

### Phase Effects

| Phase | Duration | Hero bonus | Witch bonus | Scoring? |
|-------|----------|------------|-------------|----------|
| **DAWN** | 1 round | +1 action budget | — | Yes (node majority) |
| **DAY** | 3 rounds | +1 action budget | — | No |
| **DUSK** | 1 round | — | — | Yes (node majority) |
| **NIGHT** | 3 rounds | — | +1 action budget, combat bonus | No |

### Scoring at Dawn/Dusk

At each DAWN and DUSK checkpoint:
1. Count faction control per Power Node (presence = control)
2. **Sweep check**: if one faction holds all 3 nodes → instant win
3. **Majority**: faction with more nodes scores 1 point
4. **First to 3 points wins** (equivalently, 4 points in the code but initial state starts at 1)

---

## 3. Turn Lifecycle

Each round follows a strict planning → resolution → post-round sequence.

### Turn Flow Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                         PLANNING PHASE                           │
│                                                                  │
│  state.startPlanning()                                           │
│    ├── Reset plans, ready flags                                  │
│    ├── Calculate action budgets (base + faction + node bonuses)  │
│    └── Set planningPhase = true                                  │
│                                                                  │
│  Each player independently builds PlanAction[] queue             │
│  (Human via UI drag/click, AI via generatePlan())                │
│                                                                  │
│  state.submitPlan(faction, plan) / submitPlayerPlan(id, plan)    │
│    └── When all sides ready → resolving = true                   │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                       RESOLUTION PHASE                           │
│                                                                  │
│  resolvePlans() / resolvePlansMP()                               │
│    ├── Group plans into per-entity queues                        │
│    ├── For each step index (0, 1, 2, ...):                       │
│    │     ├── For each unit with queued actions:                   │
│    │     │     ├── Execute one action (drainOneStep)             │
│    │     │     ├── If budget exhausted → try consuming FOOD      │
│    │     │     ├── ACTION_OK / ACTION_SKIP / ACTION_FAIL         │
│    │     │     └── Check guard strikes from adjacent enemies     │
│    │     └── Snapshot entity positions                           │
│    └── Continue until all queues empty                           │
│                                                                  │
│  Output: StepRecord[] (events + snapshots per step)              │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                      ANIMATION PHASE                             │
│                                                                  │
│  _animateResolutionSteps(steps)                                  │
│    ├── For each step: interpolate positions, play FX             │
│    └── Pause between steps for readability                       │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                       POST-ROUND PHASE                           │
│                                                                  │
│  state.endRound()                                                │
│    ├── Apply faction end-of-round effects                        │
│    ├── Increment round counter                                   │
│    ├── Recalculate phase from round number                       │
│    ├── Apply post-round effects (hazards, attrition)             │
│    ├── At DAWN/DUSK: check node objectives → score points        │
│    └── checkVictory()                                            │
│         ├── Custom delegate (campaign missions)                  │
│         ├── Leader elimination                                   │
│         └── Node control conditions                              │
│                                                                  │
│  If gameOver → show results, record stats                        │
│  If not → back to PLANNING PHASE                                 │
└──────────────────────────────────────────────────────────────────┘
```

### Resolution Detail: drainOneStep

```
drainOneStep(state, queue, budget):
  while queue has actions AND budget > 0:
    action = queue.shift()

    validate action against current state
      ├── target dead/gone?  → SKIP (free, try next action)
      ├── out of range?      → FAIL (stop inner loop)
      └── valid              → execute

    execute action via actions.js
      ├── success → ACTION_OK, budget -= cost
      │             check guard strikes from adjacent enemies
      └── failure → ACTION_FAIL

    if budget == 0 AND queue not empty:
      try consume 1 FOOD for +1 action (FOOD_CONSUMED event)
```

### Budget Calculation

```
Base budget:     3 actions

Hero bonuses:    +1 if DAWN or DAY phase
                 +1 per survivor (cap +5)
                 Hard cap: 8

Witch bonuses:   +1 if NIGHT phase
                 +1 per unit (cap +3)
                 Hard cap: 10

Node bonus:      +1 per controlled Power Node (both factions)

Multiplayer:     Budget split proportionally by owned entity count
```

---

## 4. Victory Conditions

Checked after each round in priority order:

```
checkVictory():
  1. Custom delegate?     → Campaign mission-specific conditions
  2. Leader eliminated?   → Faction with dead leader loses
  3. Score threshold?     → First to 4 scoring points wins (DAWN/DUSK only)
```

> **Note:** the legacy "node sweep" instant win (holding *all* Power Nodes at
> dawn/dusk) was removed — it was too easy to stumble into accidentally.
> Holding all nodes now simply scores the majority point like any other lead.

### Win Reasons

| Reason | Trigger |
|--------|---------|
| `HERO_SLAIN` | All hero leaders eliminated |
| `WITCH_SLAIN` | All witch leaders eliminated |
| `SCORE_HERO` | Hero reaches 4 scoring points |
| `SCORE_WITCH` | Witch reaches 4 scoring points |

---

## 5. Planning System Sub-State

The planning system in `src/planner.js` manages how players build their action queues.

### PlanActionType Enum

| Type | Cost | Description |
|------|------|-------------|
| `MOVE` | 1 | Move to adjacent hex |
| `BATTLE_UNIT` | 1 | Attack specific entity (skips if target dead) |
| `BATTLE_HEX` | 1 | Attack whatever is on a hex (skips if empty) |
| `EXPLORE` | 1 | Reveal tile contents |
| `FORTIFY` | 1 | Build fortification |
| `SUMMON` | 1 | Summon minion/golem (witch only) |
| `HEAL` | 1 | Use herbs to restore HP |
| `USE_ITEM` | 0 | Consume food/silver/scripture |
| `EQUIP_WEAPON` | 0 | Equip weapon (free action) |
| `USE_ABILITY` | 0-1 | Survivor special ability |
| `GUARD` | 1 | Defensive stance with reactive counter-attacks |
| `SOUND_HORN` | 1 | Reveal hero position, recruit survivors (hero only) |

### Ghost State Projection

During planning, `computeGhostState(state, plan)` projects where entities will be after each planned step. This allows multi-move chaining — the UI shows dashed arrows with numbered badges showing the projected path.

```
Current state          Plan: [MOVE→A, MOVE→B, EXPLORE]
     ●                       ●─ ─ ─►①─ ─ ─►②
  (entity)                   ghost   ghost   ghost
                             arrow   arrow   explore
```

The renderer draws these projections via `_drawPlanOverlay()`, and `ui.js` uses `_getProjectedPos(entityId)` to enable clicking on projected positions for the next action.
