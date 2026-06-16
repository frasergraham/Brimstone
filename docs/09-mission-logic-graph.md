# 09 — Mission Logic Graph (event → action system)

> Status: **implemented end-to-end.** The engine (`src/mission-logic/`) is wired
> into the live game loop (GameState `pumpMissionLogic` + `endRound`, the
> GameState-backed `game-context.js`, `state-sync` `logicState`, and `main.js`
> attach/drain/resume), the node-graph editor ships as the **Logic** tab in the
> Mission Editor, the **Campaign Progression** tool ships as the **Campaign** tab,
> and rich unlock criteria (§5.5) are honored by `campaign.js`. The engine is a
> guarded no-op for non-logic games, so it is byte-identical for normal/online
> play. The old mission fields (`storyTriggers`, `waves`,
> `conversations[].onComplete`, `objectives.win/lose`) **remain the live runtime**
> for shipped missions until each is flipped to graph-driven — we keep both. Full
> suite green (5353 tests); editor + campaign tab browser-verified.

This is Brimstone's in-game logic system: a single, data-driven, Unreal-Blueprint-
style **event → action graph** that replaces every bespoke way the game currently
triggers scripted things (story beats, conversations, spawns, area triggers, turn/
phase events, win/lose). One mission owns **one graph**. The graph is evaluated on
the authority and emits a stream of presentation instructions that the render/UI
layer interprets — the logic and the presentation are fully decoupled.

---

## 1. Core invariants (do not violate)

These four are load-bearing. The whole design — and online/offline parity, replay,
spectate, and reconnect — depends on them.

1. **Sealed resolution.** A round's resolution is a pure function of
   `(state, plans, seed)`. Nothing observed *during* a round's replay can mutate
   game state. Replay is reproduction, never authorship. The graph engine runs
   *inside* this sealed function, so its Sim nodes inherit the property.

2. **Graph runs on the authority.** There is one authority per game that owns the
   canonical `GameState`: offline (campaign) it is the local client itself; online
   it is the server. The engine is shared, DOM-free code (`src/mission-logic/`),
   instantiated wherever `resolvePlans()` runs. "Resolver vs client" is a false
   split offline — they are the same process.

3. **Sim / Show split.** Every node is one of two execution classes:
   - **Sim** nodes mutate authoritative `GameState` (through `actions.js`-style
     mutators), deterministically. They must read **only** `(state, plans, seed)`.
   - **Show** nodes are pure presentation (conversation, toast, camera, voice).
     They never touch state; they emit presentation events onto the step stream
     that clients animate at their own pace.
   Pause / resume / animation speed / who-dismisses-first are **presentation only**
   and can never affect logic.

4. **Interactivity is a plan action.** If we ever add player choices (branching
   dialogue, "defend or flee"), the choice does **not** branch a round's replay.
   It is captured as input at a planning gate and expressed as a **plan action**,
   submitted through the channel that already exists. The game waits on a human in
   exactly one place — plan submission — and the graph adds no new wait. Online
   therefore needs **no new synchronization primitive**.

**Enforceable rule for the engine:** during resolution, Sim nodes may read only
`(state, plans, seed)` and produce `(state mutations, presentation events)`. They
may never read live input, wall-clock, animation progress, or any client-local
state. Honor this and online stops being a special case.

---

## 2. Concepts

### 2.1 Two kinds of pins

Like Unreal Blueprints, the graph separates **execution flow** from **data flow**:

- **Exec pins** (`──▶`) carry a *pulse*: "when this fires, run the next node."
- **Data pins** (`┄┄▶`) carry a *typed value*: entity ref, hex, int, bool, faction,
  string.

This split is what lets a freshly-spawned NPC flow as **data** into a conversation's
role binding (a live wire), instead of the static `bindings` map missions use today.

### 2.2 Node kinds

| Kind | Symbol | Has exec in? | Role |
|------|--------|--------------|------|
| Event   | `‹EVENT›` | no  | graph entry point, fired by the game |
| Actor   | `‹ACTOR›` | no  | a placed unit / hex-region; exposes lifecycle events |
| Flow    | `‹FLOW›`  | yes | sequence / branch / gate / loop / counter |
| Pure    | `‹PURE›`  | n/a | filter / compare / get-state — pulled for data, no exec |
| Sim     | `‹SIM›`   | yes | mutates authoritative game state |
| Show    | `‹SHOW›`  | yes | presentation only (client) |
| Outcome | `‹OUT›`   | yes | win / lose / objective state |

### 2.3 Fire-and-animate vs interactive

The default is **fire-and-animate**: the authority computes the whole result the
instant a trigger fires and emits an ordered presentation-event list; the client
plays it at any pace. A latent node's `Done` pin (e.g. `Start Conversation`) is a
**presentation sequencing marker**, not a logic barrier — the engine continues down
`Done` immediately in logic terms; the client just animates the downstream events
after the conversation is dismissed. **All current Brimstone content is
fire-and-animate.** Only a future **interactive** node (a player choice) is a real
barrier, and per invariant 4 it routes through plan submission.

---

## 3. Runtime model

```
        AUTHORITY  (offline: the local client itself · online: the server)
        ┌──────────────────────────────────────────────────────────────┐
plans ─▶ │ resolvePlans() ──emits──▶ MissionEvents bus                    │
        │     │   (kill · damage · entered-hex · round · phase)          │
        │     ▼                                                          │
        │  steps[] ◀──append── MissionLogicEngine: drain SIM reactions    │
        │                      (spawn · despawn · set-flag · win/lose)    │
        │                      at step-end / endRound                     │
        └───────────────┬──────────────────────────────────────────────┘
                        │ step stream  (carries SHOW events too)
                        ▼
        PRESENTATION  (always the client)
        ┌──────────────────────────────────────────────────────────────┐
        │ animate steps · play SHOW / latent nodes (conversation)        │
        │ latent "Done" ─▶ offline: continue in-process                  │
        │                ─▶ online:  same step stream, client paces it    │
        └──────────────────────────────────────────────────────────────┘
```

- The game already has the fire points: `effects.dispatchTrigger` (kill/damage),
  area-entry detection mid-resolution, `endRound` (round/phase), `checkVictory`.
  We re-route those to publish onto **one `MissionEvents` bus**; the engine
  subscribes. Nothing about *when* things fire changes — only the sink is unified.
- **Drain discipline (protects determinism):** the resolver *enqueues* events
  during a step; the engine *reacts* at step boundaries / `endRound`, appending new
  steps. This is exactly why `processWaves()` already defers spawns to `endRound`
  instead of spawning mid-move. Sim reactions drain at step/round boundaries; Show
  reactions drain in the client loop (where `processStoryTriggers` already fires
  area conversations mid-replay).
- The engine returns an **ordered presentation-event list** — the "turn action
  data" the render/UI layer consumes. Emission order = traversal order =
  presentation order.

### 3.1 Engine runtime state (must serialize)

Per invariant + Guideline 5/6, the engine's mutable runtime state goes into
`state-sync.js` and saves, or online/resume silently drops it:

```
logicState = {
  firedOnce: [nodeId, …],        // DoOnce gates that have fired
  counters:  { nodeId: int },    // Counter nodes
  variables: { varId: value },   // mission-scoped vars (campaign flags persist separately)
}
```

With fire-and-animate there is **no in-flight continuation to serialize** — the
authority's state is always current the instant a trigger fires. (Only a future
interactive node introduces a pending-input state, which is identical to the
existing "waiting for plan submission" state.)

### 3.2 Determinism

Random / weighted nodes draw from the **seeded game RNG** (`ctx.random()`), never
`Math.random`/`Date`. Exec fan-out from a single pin runs in stable edge order;
prefer an explicit `Sequence` node when order matters.

---

## 4. Node catalog

Grouped by kind, each mapped to the mechanism it replaces. Nodes marked **✓** are
implemented in the first engine slice; the rest are catalogued for the editor and
land as missions need them.

### ‹EVENT› — graph entry points (fired by the game)
| Node | Outputs | Replaces |
|---|---|---|
| **On Mission Start** ✓ | exec | briefing + `round:1` triggers |
| **On Round Start** ✓ | exec; data: round, phase | `storyTrigger type:round`, `wave round:N` |
| **On Phase** ✓ | exec; data: phase | `endRound` phase change, node scoring |
| **On Day / Cycle N** | exec; data: cycle | attrition-by-cycle schedule |
| **On Kill Count** ✓ | exec; data: killer | `wave trigger:hero_kills count:N` |
| **On Node Control Changed** | exec; data: node, owner | node scoring / control-change log |
| **On Survivor Discovered** | exec; data: survivor | hidden-survivor reveal |
| **On Resource Threshold** | exec | `gather_and_survive` |
| **On Custom Event** (named) | exec; data: payload | *new* — decouples graphs |

### ‹ACTOR› — placed units & regions (bound by id to the world editor)
| Node | Outputs | Replaces |
|---|---|---|
| **Actor** (one unit) | OnSpawn, OnDeath, OnDamaged, OnDealtKill, OnMoved, OnTurnEnd; data: entity | `effects.dispatchTrigger`, leader-death scatter |
| **Actor Class** (e.g. any zombie) | same, matched by type | — |
| **Faction** (Hero/Witch) ✓ | OnAnyUnitDeath, OnLeaderDead, OnUnitCountBelow | `eliminate_all`, `hero_killed`, `slay_witch` |
| **Area Trigger** (hex set) ✓ | OnEnter, OnExit; data: unit, hex | `storyTrigger type:area`, `wave trigger:area` |

### ‹FLOW›
| Node | Behavior | Replaces |
|---|---|---|
| **Sequence** ✓ | one in → Then 0…N in order | implicit `onComplete` ordering |
| **Branch (If)** ✓ | bool → True / False | objective predicate checks |
| **Do Once / Do N** ✓ | gate fires once (or N times) | `_firedWaves`/`_firedConversations`/`flag` dedup |
| **Gate** | open/close an exec path | conductor `canSubmitPlan` |
| **Delay (N rounds)** *(latent)* | wait then fire | generalizes absolute `round:N` |
| **For Each** ✓ | iterate a list, body per item | multi-unit `wave.units[]` |
| **Counter** ✓ | +1 per pulse, fire at threshold | `heroKills`, `witchSummonCount` |
| **Merge / Any** | N exec ins → 1 out | — |

### ‹PURE› — filters / comparisons / getters (no exec)
| Node | Output | Replaces |
|---|---|---|
| **Filter: Is Hero / Faction / Type** ✓ | bool | the sketch's "Is Hero" |
| **Condition (named predicate)** ✓ | bool | `condition-registry.js` |
| **Compare** (`≥ ≤ == > <`) ✓ | bool | effects condition DSL |
| **Get Entity Property** ✓ | hp / pos / faction / alive | `entity.*` reads |
| **Get Game State** ✓ | round / phase / kills / nodeControl / resources | `state.*` reads |
| **AND / OR / NOT** ✓ | bool | conjunctive `requires`, multi-`lose` |
| **Random / Weighted Pick** *(seeded)* | branch or value | `spawnAt` random, loot tables |

### ‹SIM› — authoritative state actions
| Node | Effect | Replaces |
|---|---|---|
| **Spawn Unit(s)** ✓ | type, pos, overrides, level | `wave.units[]`, `resolveSpawnPosition` |
| **Despawn / Remove** ✓ | remove entity | `onComplete despawn`, leader cleanup |
| **Move Unit** *(latent)* | scripted path, Done | `onComplete move` |
| **Damage / Heal / Kill** | apply HP delta | `healBonus`, attrition |
| **Apply Effect / Status** | stun/buff | `effects.js` apply |
| **Set Tile / Reveal / Fortify** | mutate map, lift fog | tile mutations, fog reveal |
| **Grant Reward / Resource / Item** | add resources/items | `rewards`, loot |
| **Recruit Survivor** | add to roster | `npc.survivorName` |
| **Set Variable / Flag** ✓ | write mission var / story flag | `storyFlags`, dedup flags |

### ‹SHOW› — presentation (client-only; latent where noted)
| Node | Effect | Replaces |
|---|---|---|
| **Start Conversation** ✓ *(latent)* | bind roles → entities, play markdown, Done | `conversations[]` + `conversation-player.js` |
| **Story Beat / Toast** ✓ | title + text | `storyTrigger` text triggers |
| **Camera / Focus / Spotlight** | pan/highlight | tutorial spotlight |
| **Play Voice / SFX** | audio cue | voiceover `voiceKey` |

### ‹OUT›
| Node | Effect | Replaces |
|---|---|---|
| **Win / Lose Mission** ✓ | end with reason | `objectives.win/lose`, `checkVictory` |
| **Objective: Set / Complete / Fail** | drive a live checklist | implicit objective state |
| **Win/Lose When ___** ✓ | wrap a `(state)→bool` objective spec verbatim | the 13 `KNOWN_OBJECTIVE_TYPES` |

> `Win/Lose When` deliberately wraps the **existing** objective spec (`{ type, … }`)
> and delegates to the current victory logic, so migration is lossless and we don't
> reimplement 13 objective types up front.

---

## 5. Worked diagrams

Legend: `──▶` exec · `┄┄▶` data · `└─ Done ─▶` latent continuation.

### 5.1 The canonical example (hero enters → talk → spawn zombies)
```
‹ACTOR› Area Trigger "Clearing"
  └ On Enter ──▶ ‹PURE› Filter "Is Hero?"        ⟨reads: entered-unit ┄┄from trigger⟩
                    └ Pass ──┬──▶ ‹SIM› Spawn NPC "Dave"  ──▶ outputs ⟨dave⟩┄┐
                             │                                               ┊
                             └──▶ ‹SHOW› Start Conversation                  ┊
                                      roles: { hero, npc ← ⟨dave⟩ } ◀┄┄┄┄┄┄┄┄┘
                                      └ Done ──▶ ‹SIM› Despawn "Dave"
                                                  └──▶ ‹SIM› Spawn Zombies ×3
```

### 5.2 Ch1M1 "The Awakening" (round + kill + area + faction win/lose)
```
‹EVENT› On Mission Start ──▶ ‹SHOW› Start Conversation "ch1m1_intro" {hero, innkeeper}
‹EVENT› On Round Start (4) ──▶ ‹FLOW› Do Once ──▶ ‹SHOW› Story Beat "The Witching Hour"
‹EVENT› On Kill Count (Hero ≥3) ──▶ ‹FLOW› Do Once ──▶ ‹SIM› Spawn "wood_golem" @near_hero
‹ACTOR› Area "Second Clearing" ─On Enter─▶ ‹FLOW› Do Once ─┬─▶ ‹SHOW› Beat "The Witch Flees"
                                                          └─▶ ‹SIM› Spawn ×N "wood_golem"
‹ACTOR› Witch Faction ─On All Units Dead─▶ ‹OUT› Win  "The golem shatters…"
‹ACTOR› Hero  Faction ─On Leader Dead────▶ ‹OUT› Lose (hero_killed)
```
Note: the "Witch Flees" beat + cover-spawn — two disjoint JSON entries sharing a hex
list today — collapse into **one** Area node firing two actions.

### 5.3 Ch1M3 "The First Night" (phase + survive)
```
‹EVENT› On Round Start (1) ──▶ ‹SIM› Spawn ×2 zombie
‹EVENT› On Round Start (3) ──▶ ‹SIM› Spawn ×3 zombie
‹EVENT› On Phase = DAWN ──▶ ‹FLOW› Branch ⟨Survivors alive ≥ 2?⟩
                               ├ True  ──▶ ‹OUT› Win  "…held out until dawn."
                               └ False ──▶ ‹OUT› Lose "Dawn came too late…"
‹ACTOR› Hero Faction ─On Leader Dead─▶ ‹OUT› Lose (hero_killed)
```

### 5.4 Latent choreography (conversation onComplete)
```
‹SHOW› Start Conversation "ch1m1_intro"
  └ Done ──▶ ‹SIM·latent› Move NPC "innkeeper_john" {2,5}→{2,4}
                 └ Done ──▶ ‹SIM› Despawn NPC "innkeeper_john"
```

### 5.5 Campaign progression (separate tool)
```
tutorial ─▶ prologue ─▶ gathering_survivors ─▶ first_night ─▶ river_crossing ─┐
                                                                              ├(AND)▶ witchs_trail
                                            …            ─▶ long_watch ───────┘
   unlock criteria: Mission Completed · Has Item · XP/Level ≥ N · Story Flag  (AND/OR/NOT/anyOf)
   reward payload : grant resources · grant/equip item · recruit survivor · heal ·
                    set story flag · mark next-mission-unlocked
```
Missions are nodes; edges are unlock dependencies. Double-click a mission node →
opens it in the mission logic editor.

**`anyOf` — "any N of" threshold.** Alongside `all` (AND), `any` (OR) and `not`,
an unlock criterion may be `{ anyOf: { count: N, of: [entry, …] } }`: the gate
opens when at least `count` of the listed entries evaluate true. It's the
threshold generalisation of `any` (OR is "any 1 of"). Each entry is either a bare
mission-id string (shorthand for `{ missionDone: id }`) or a full nested criterion,
so the canonical "complete any 3 of these 5 optional missions" gate is just:

```jsonc
"unlock": { "anyOf": { "count": 3, "of": ["mA", "mB", "mC", "mD", "mE"] } }
```

Edge cases: `count` defaults to 1 (≡ OR); `count ≤ 0` is always satisfied (no
entries required); `count > of.length` is never satisfied (threshold unreachable).
Evaluator, ref-collection and validation live in `src/campaign/unlock.js`; the
Campaign Progression card summarises it as `any N of (…)`.

---

## 6. JSON format

The graph lives **inside the mission JSON** under a new `logic` block (additive;
old fields keep working):

```jsonc
"logic": {
  "version": 1,
  "variables": [
    { "id": "v_seen_intro", "name": "seenIntro", "type": "bool",
      "scope": "campaign", "initial": false }
  ],
  "nodes": [
    { "id": "n1", "type": "onAreaEnter", "params": { "hexes": [{ "col": 9, "row": 6 }] },
      "x": 40,  "y": 40 },
    { "id": "n2", "type": "filterIsFaction", "params": { "faction": "hero" }, "x": 240, "y": 40 },
    { "id": "n3", "type": "spawnUnits",
      "params": { "units": [{ "type": "zombie", "spawnAt": { "col": 11, "row": 6 } }] },
      "x": 440, "y": 40 }
  ],
  "edges": [
    { "from": { "node": "n1", "pin": "onEnter" }, "to": { "node": "n2", "pin": "in" },     "kind": "exec" },
    { "from": { "node": "n1", "pin": "unit"    }, "to": { "node": "n2", "pin": "entity" }, "kind": "data" },
    { "from": { "node": "n2", "pin": "pass"    }, "to": { "node": "n3", "pin": "in" },     "kind": "exec" }
  ]
}
```

- `params` carry node config (round number, hex set, unit specs, conversation id,
  objective spec, …).
- `x`/`y` are editor layout only — the runtime ignores them.
- Engine runtime state is serialized **separately** in the save / state-sync as
  `logicState` (§3.1), not in the authored mission file.

---

## 7. Migration

We **keep the old fields** until the graph path is proven (user-confirmed). The
adoption path:

1. `missionToGraph(missionDef)` (`src/mission-logic/migrate.js`) converts each
   `storyTrigger` / `wave` / `objective` into a small node cluster so no content is
   hand-rewritten. (First slice covers: storyTriggers round/area, waves
   round/hero_kills/area, objectives win/lose via `Win/Lose When`.)
2. The editor renders/edits the `logic` graph; **Save to repo** writes it back into
   the mission JSON via `window.studioAPI.writeFile` (offline, file-only).
3. During the transition the runtime continues reading the **old** fields. When the
   engine is wired into the game loop and at parity, a mission is flipped to
   graph-driven and its legacy fields are dropped (per-mission, reversible).

---

## 8. Editor (Caleb's Studio)

Two **linked views of one mission file**, offline / file-only via the existing
`window.studioAPI` bridge (`readFile`/`writeFile`/`listDir` — no server):

- **World/Map editor** (existing hex canvas) — placing a unit or running
  "Make Trigger" on selected hexes creates the bound `Actor` / `Area Trigger` node;
  deleting a placed entity warns about dangling node references.
- **Logic graph canvas** (new) — node palette, exec/data wiring. No graph library
  exists in the repo today (only Babylon + node-canvas), so this is a small bespoke
  SVG/Canvas widget — the one genuinely new piece of UI.

A separate **Campaign Progression** graph tool (§5.5) edits the cross-mission
unlock graph and reward payloads; double-clicking a mission opens its logic graph.

---

## 9. Built vs. deferred

**Built (this initiative):** engine + node catalog + migration; live integration
(GameState `pumpMissionLogic` at missionStart/roundStart/postResolution + the
`endRound` hook; `game-context.js` routing spawns/objectives through real game
logic; `state-sync` `logicState`; `json-mission` `logic`/`unlock` validation;
`main.js` attach/drain/resume); the **Logic** editor tab; rich **unlock** criteria
(§5.5) in `campaign.js`; the **Campaign Progression** tool. All tested + browser-
verified.

**Deferred:**
- **Conductor / tutorial** stays the escape hatch (`MissionConductor`: forced dice,
  scripted witch plans). `Tutorial Hint` / `Force Dice` / `Scripted Plan` become
  node types later.
- **Online narrative.** The rich graph is campaign-first (single-player); the
  engine attaches on the offline authority path. Sim-only graphs would run
  server-side today-style; interactive nodes, if ever added, route through plan
  submission (invariant 4) — no new primitive. Server-side attach in `lobby.js` is
  the remaining wiring when online logic missions are wanted.
- **Mid-step area precision.** `areaEnter`/`areaExit` fire at round boundaries
  (enter/exit transitions), not mid-resolution-step. Fine for current content;
  thread through the resolver step loop if a mission needs sub-turn precision.
- **Flip shipped missions to graph-driven.** The migration + both runtimes coexist;
  flipping a mission (dropping its legacy fields) is a per-mission follow-up.
- **"Open in Logic editor"** from the Campaign tab currently switches to the
  Mission Editor tab; auto-loading that specific mission is a small enhancement.
