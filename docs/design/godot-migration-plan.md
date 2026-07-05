# Brimstone — Godot Migration Plan

**Status:** proposed · **Rev 2, 2026-07-05** · **Owner:** Fraser
**Rev 2 change:** no rules-engine port. The existing JS engine ships inside the Godot app via an
embedded JS runtime; Godot is presentation/input only. This removed the old Phases 1–3 (GDScript
engine + AI port + headless tooling) and the heavyweight conformance harness. Rev 1 is in git
history as the fallback strategy (§10).

**Companion reading:** the functional spec in [`spec/`](../../spec/README.md) — this plan does not
duplicate it. Every work package cites the spec sections and source files an implementing agent
must read first.

---

## 1. Goal & guiding idea

Replace the browser presentation layer with a native **Godot 4** application while **retaining the
existing JavaScript game code — engine, AI, resolver, serialization, mission logic — verbatim**,
running inside a JS runtime embedded in the Godot app. The Node server, database, and wire
protocol stay untouched.

Two facts make this the natural shape:

1. **The authority/replay model** (spec 01 §0.2): the authority resolves each round once and ships
   `steps[]` + the serialized final state; every other participant *replays* the recorded events
   and never re-runs the resolver. A client therefore never needs resolution logic — it needs a
   protocol client and a replayer.
2. **The shared engine is already DOM-free** (spec 01 §0.1): `src/game.js`, `actions.js`,
   `entities.js`, `planner.js`, `src/ai*.js`, `server/resolver.js`, `server/state-sync.js`,
   `src/mission-logic/` run headless today (that's how `scripts/headless.js` works). Pure ES
   modules — `Map`/`Set`/`JSON`/`Math` — nothing that needs a browser or Node API. They run
   unmodified in any embedded ES2020+ runtime.

So the architecture is: **one protocol, two transports.**

```
                Godot (GDScript)                        Authority
  ┌──────────────────────────────────────┐
  │ scenes: board, HUD, planning UI,     │   ONLINE    ┌─────────────────────┐
  │ replay presentation, camera, input   │◄───────────►│ Node server (as-is) │
  │                                      │  WebSocket  └─────────────────────┘
  │  protocol client (one code path)     │
  │        │                             │
  │        ▼ local transport (bridge)    │   OFFLINE   ┌─────────────────────┐
  │ ┌──────────────────────────────────┐ │◄───────────►│ offline host:        │
  │ │ embedded JS runtime (in-process) │ │  fn call    │ src/offline-host.js  │
  │ │  · offline host = local authority│ │             │ + the whole shared   │
  │ │  · planning queries (both modes) │ │             │   engine, verbatim   │
  │ └──────────────────────────────────┘ │             └─────────────────────┘
  └──────────────────────────────────────┘
```

The embedded runtime is present in **all** modes, not just offline:

- **Offline** (vs-AI, hot-seat, AI-vs-AI, campaign): the embedded engine *is* the authority — it
  runs `GameState`, `resolvePlans`, the AI pipelines, and the mission-logic graph, exactly as
  `src/main.js` does in the browser today.
- **Online**: the Node server remains the authority; the embedded engine serves **planning-time
  queries** — `validatePlanAction`, `computeGhostState`, action budgets, movement ranges, combat
  odds previews (spec 01 §8.9) — against the read-only mirror state, exactly the role the shared
  code plays in the web client's online mode today.

Consequence: **zero game rules are ever implemented in GDScript.** No port, no dual maintenance,
no statistical conformance problem. Parity between web client, Godot client, and server is
parity by construction — same files.

### What this deletes from the migration (vs. the Rev 1 port plan)

- The GDScript engine port, AI port, and Godot headless balance tooling (old Phases 1–3, ~10
  large work packages).
- The three-level conformance harness and fixture corpus as an *acceptance bar* (a small
  runtime-parity smoke suite remains — §4).
- The data-table JSON export (Godot queries the engine for catalogs instead — D5).
- The permanent "JS first, then port" parity guideline — there is nothing to port.

### Explicitly out of scope (stays as-is, in JS)

| Component | Why it stays |
|---|---|
| `server.js`, `server/**` (lobby, resolver, DB, auth, saves, async, push, admin API) | Godot talks to it over the existing protocol (spec 01 §11). Server rewrite deferred (§10). |
| `src/` shared engine + AI + mission logic | **The point of Rev 2** — it ships verbatim inside the Godot app. |
| `scripts/headless.js`, `combat-sim.js`, `ai-matrix.js`, `headless-campaign.js` | Balance tooling keeps running on Node against the same code the Godot app embeds. Guideline 3 continues unchanged. |
| `admin.html`, `admin-tools.html`, Caleb's Studio, `src/renderer.js` (Canvas 2D) | Internal authoring tools; the Mission Editor's JSON output is consumed by the embedded engine directly. |
| The web client (`index.html`, `src/main.js`, `src/ui*.js`, `renderer-3d.js`) | Kept running until Phase 6 sign-off; it is the cross-play test partner and the behavioral reference for the Godot UI. |

---

## 2. Key decisions (make these first — Phase 0 gates on them)

Each has a recommendation; agents treat the recommendation as the default and escalate only on a
hard blocker.

### D1 — Engine version: **Godot 4.5.x, pinned**
Pin the exact minor version in `godot/README.md` and CI. Upgrades are a deliberate single-commit
event with full test rerun.

### D2 — JS runtime: **in-process via GDExtension; QuickJS-NG everywhere, JavaScriptCore optional on Apple**
The decision that replaces Rev 1's GDScript-vs-C# question.

- **In-process, not a sidecar.** A bundled Node/Bun sidecar process would let us run the server
  code literally — but **iOS forbids spawning child processes**, so a sidecar can never ship the
  mobile builds. In-process embedding works on every target. (Sidecar remains a fine *dev-time*
  trick — see WP-2.5.)
- **QuickJS-NG** as the baseline backend: small (~1 MB), C, ES2023-capable, trivially embeddable
  via GDExtension, identical behavior on all platforms, and App Store–compatible (interpreted,
  bundled-only code — App Review Guideline 2.5.2 concerns *downloaded* code; all our JS ships in
  the app bundle and we must never eval anything fetched at runtime).
- **JavaScriptCore** (the system framework) as an optional Apple-platform backend behind the same
  bridge interface if QuickJS perf ever matters there. Not required to ship.
- **Evaluate, don't assume, third-party plugins** (e.g. the GodotJS project) in the Phase-2 spike:
  our bridge surface is deliberately tiny (strings in, strings out — §3), so a hand-rolled
  QuickJS GDExtension of a few hundred lines may be less risk than a large dependency.
- **Performance gate (D2-check, end of Phase 2):** one full AI round — both faction pipelines
  plan + `resolvePlans` + `finalizeRound` on a Standard map — must complete in **< 2 s** on the
  slowest target device (measure on real iPhone/Android hardware), run off the main thread so
  frames never hitch. Turn-based cadence makes this generous; QuickJS is typically 10–30×
  slower than V8 and a round is milliseconds in V8. If the gate fails: JSC on Apple, and
  profile/precompile (QuickJS bytecode) elsewhere.

### D3 — Repo layout: **in-repo `godot/` directory**, not a new repository
The embedded engine is *this repo's* `src/`; the Godot app must build from the same checkout so
client and engine can never skew. Layout:

```
godot/
  project.godot
  bridge/        # GDExtension source (QuickJS embedding) + jsruntime.gd wrapper
  net/           # protocol client + the two transports (WebSocket, local bridge)
  game/          # scenes: board, entities, camera, replay presentation
  ui/            # scenes: Ledger/setup, HUD, overlays, dialogs, toasts
  tests/         # gdUnit4 suites, incl. bridge/protocol contract tests
  tools/         # verify harness (screenshots), build scripts
```

JS-side additions live in `src/` beside the code they orchestrate:
`src/offline-host.js` (Phase 1) and `scripts/bundle-embedded.mjs` (D4).

**Hard rule:** no game rules in GDScript. `godot/game/` and `godot/ui/` may *read* serialized
state and step events and may *ask* the bridge; they may never compute a rule outcome
themselves. Add a review checklist item and keep the rule in `godot/CONVENTIONS.md` — this is
the Godot analogue of "ui.js only reads state".

### D4 — Embedded bundle: **esbuild-bundle the engine for embedding only; the web game stays no-build**
`scripts/bundle-embedded.mjs` rolls `src/offline-host.js` and its import graph into one ES module
(`godot/bridge/engine.bundle.mjs`) consumed by the runtime, stamped with `src/version.js`
`VERSION`/`SAVE_VERSION`. The browser game keeps loading raw ES modules exactly as today — the
bundler is a packaging step for the Godot app, not a build step for the project. CI regenerates
the bundle and fails if it drifts from committed source.

### D5 — Static content for UI: **query the engine, don't duplicate**
Item names, ability tooltips, unit stats, survivor bios, faction data, icon assignments: the
Godot UI gets them from bridge catalog queries (`getCatalog('items')`, …) answered by the very
modules that define them (`src/items.js`, `src/abilities.js`, `src/unit-types.js`,
`src/factions.js`, `src/content/`). No JSON export, no second copy. Campaign mission JSON is
read from the app bundle by Godot and *passed into* the engine (the engine never touches the
filesystem — §3).

### D6 — Server strategy: **keep the Node server**; Godot is a protocol-compatible client
Online play, async games, persistence, auth, push, leaderboard, admin all keep working with zero
server changes, and web↔Godot cross-play works throughout the transition.

### D7 — Web platform: **Godot does not target the browser** in this migration
The existing web client remains the browser offering until a deliberate later decision.

---

## 3. The bridge & the offline host (the load-bearing design)

### 3.1 One protocol, two transports

The Godot protocol client is written once against the message catalogue in spec 01 §11.5 (plus
§11.2 submit, §11.3 step payloads, §11.6 heartbeat/resync). Transports:

- **`WSTransport`** — WebSocket to the Node server (online). Byte-identical to what the web
  client sends today.
- **`LocalTransport`** — same JSON messages exchanged with `src/offline-host.js` running in the
  embedded runtime (offline).

`src/offline-host.js` is a new JS module that wraps what `src/main.js` does today around a game —
create `GameState` from setup config or a save, run `startPlanning`, accept `submitPlan`, drive
AI seats, call `resolvePlans` + `finalizeRound`, emit `planningPhase`/`roundResolved`/`gameState`
messages, pump the mission-logic engine, expose save/load via `serializeState` — but speaks
*messages* instead of touching the DOM. It is, deliberately, a tiny in-process re-expression of
the server's room loop (spec 01 §11.4) minus rooms/sockets/DB.

**Refactor rule:** `src/main.js` must be refactored to *consume* `offline-host.js` for its local
game loop (rather than the host being a copy of main.js logic). That keeps a single offline
orchestration layer for web and Godot — Guideline 5's two-orchestrator model stays two, not
three. The refactor is validated by the existing `npm test` + `tests/ui` suites and a headless
smoke; it is the one piece of churn to live code in this plan, and it's Phase 1's core.

### 3.2 Planning queries (both modes)

A small request/response surface on the same transport, used by the planning UI:

`validatePlanAction`, `computeGhostState`, `getActionBudget`, `getMoveRange`, `getCombatPreview`
(spec 01 §8.9 exact odds), `getCatalog(kind)` (D5), `getSaveSlots`/`save`/`load` (offline),
plus tutorial/hint state. Offline these run against the authoritative local state; online they
run against the **read-only mirror state** (spec 03 §0) which the embedded engine maintains by
deserializing server snapshots and replaying step streams — the same job `src/multiplayer.js`
does in the browser. Mirror mutators stay no-ops.

### 3.3 The bridge itself

Deliberately minimal, so the GDExtension stays small and swappable across JS backends:

- `eval_module(source)` once at boot (the D4 bundle), then a single entry object with
  `post(jsonString)` → optional `jsonString` reply, plus a host-registered callback for
  engine-initiated messages (resolution ready, AI submitted, logic events).
- Host shims injected by the bridge: `console.*` → Godot log; a monotonic clock; **no**
  filesystem, **no** network, **no** timers with side effects inside the engine (the host drives
  ticks). Asset/mission JSON is read by Godot and passed in as message payloads.
- Runs on a **worker thread**; GDScript talks to it via a thread-safe queue. AI planning for a
  round must never block a frame.
- RNG: the engine keeps using `Math.random` (QuickJS provides it). The `state.nextDie` seeded
  hook (spec 01 §0.2) is used by the parity smoke tests below, never in production.

### 3.4 Validation strategy (replaces Rev 1's conformance harness)

1. **`npm test` is still the engine's test suite** — unchanged, it tests the exact code being
   embedded.
2. **Runtime-parity smoke (small but real):** thread a seeded PRNG flag through resolution and AI
   randomness (the `state.nextDie` hook + `genBuildArmy` — spec 02 §10), then run N seeded rounds
   in Node and in the embedded QuickJS and require identical serialized output. This catches
   *JS-engine* behavior differences (sort stability, number formatting, locale) — the only class
   of divergence left once the code is shared. Runs in CI via a QuickJS CLI; on-device as a debug
   menu action.
3. **Protocol contract tests:** golden-file tests asserting `LocalTransport` message shapes equal
   the server's (spec 01 §11.1–11.3 shapes), so the one protocol client is honest.
4. **Balance:** Guideline 3 continues verbatim on Node — the embedded engine is the same code, so
   headless results transfer by identity, not by statistics.

---

## 4. Phase map & dependency graph

```
Phase 0  Foundations (Godot skeleton, CI, conventions)
Phase 1  JS-side: offline host extraction + protocol/query surface     ← JS work, main.js refactor
Phase 2  Runtime embedding (GDExtension spike → bridge → parity smoke)
   │
   ├──► Phase 3  Client shell, board, UI, planning, replay presentation
   │        ├──► Phase 4  Online client (WSTransport, lobby, auth, async, spectate)
   │        └──► Phase 5  Campaign presentation
   └────────────► Phase 6  Platforms & release (iOS/Android/desktop)
Phase 7  Docs & guardrails (continuous, finalized last)
```

Parallelism for a fleet of agents: Phases 1 and 0 are independent. Phase 2's GDExtension spike
(WP-2.1) can start against a stub bundle before Phase 1 finishes. Phase 3 begins as soon as
WP-2.2 gives it a working `LocalTransport`; Phases 4 and 5 are independent of each other.

---

## 5. Phase work packages

Each WP is a hand-off brief: *Read first* (spec/docs), *Source of truth* (JS files),
*Deliverables*, *Done when*. Sizes: S (≤1 day-equivalent), M (a few days), L (a week+).

### Phase 0 — Foundations

**WP-0.1 · Godot project skeleton + CI (M)**
*Read first:* this doc §2–3; `docs/01-architecture-overview.md`.
*Deliverables:* `godot/` per D3; gdUnit4; CI job running `godot --headless` import + tests on PRs
touching `godot/`; a placeholder bridge test. `godot/README.md`: pinned version, how to build the
GDExtension, how to run tests.
*Done when:* CI green on a PR that adds a failing-then-fixed sample test.

**WP-0.2 · Conventions & agent working agreements (S)**
*Deliverables:* `godot/CONVENTIONS.md` — typed GDScript, scene/UI naming per CLAUDE.md
"UI Terminology", the **no-rules-in-GDScript** rule (D3) with examples of "read/ask" vs
"compute", icon-font usage (Guideline 8 carries over — never emoji), how to cite the web-client
behavior being mirrored. Extend repo `CLAUDE.md` with a short "Godot client" section pointing
here.
*Done when:* reviewed and merged; CLAUDE.md updated.

### Phase 1 — JS side: the offline host (this is JS work in `src/`)

**WP-1.1 · Extract `src/offline-host.js` and refactor `main.js` onto it (L)**
*Read first:* §3.1 above; spec 01 §10 (round lifecycle), §11.4 (the server's loop — the shape to
mirror); `docs/03-state-machines.md`.
*Source of truth:* `src/main.js` (local resolution loop, AI seat driving, campaign attach/drain/
resume, save/load), `src/game.js`, `server/resolver.js`.
*Deliverables:* message-driven host module (DOM-free, timer-free — host ticks are driven by the
caller); `main.js` refactored to consume it; message-shape golden tests (§3.4 item 3).
*Done when:* `npm test` + `npm run test:ui` green; `node scripts/headless.js 100 standard`
within noise of baseline; a browser smoke game plays normally (verifier-browser skill,
Guideline 7).

**WP-1.2 · Planning-query surface (M)**
*Read first:* §3.2; spec 03 §5 (what the planning UI needs); spec 01 §8.9.
*Source:* `src/planner.js` (`validatePlanAction`, `computeGhostState`), `src/ui.js`
(`_getProjectedPos` — multi-move chaining), combat odds code.
*Deliverables:* request/response messages on the host (and a thin online variant that answers
against mirror state); catalog queries (D5).
*Done when:* unit tests cover every query against fixture states; web client optionally consumes
nothing (no web churn required beyond WP-1.1).

**WP-1.3 · Embedded bundle + seeded parity hooks (M)**
*Read first:* D4; §3.4 item 2; spec 01 §0.2, spec 02 §10.
*Deliverables:* `scripts/bundle-embedded.mjs` (esbuild, single ESM artifact, version-stamped);
CI staleness check; the flag-gated seeded-RNG threading (default off, unseeded behavior
byte-identical — prove with existing tests + a balance smoke); a Node-side runner that executes N
seeded rounds via the bundle for the parity suite.
*Done when:* bundle loads and plays a full AI-vs-AI game under plain Node *and* under the QuickJS
CLI (`qjs`), seeded runs identical across both.

### Phase 2 — Runtime embedding (`godot/bridge/`)

**WP-2.1 · Embedding spike & backend decision (M)**
*Read first:* D2. Evaluate hand-rolled QuickJS-NG GDExtension vs. an existing plugin, on the
tiny §3.3 surface, building for desktop + one mobile target.
*Deliverables:* a decision memo appended to this document; the chosen skeleton merged.
*Done when:* `eval_module` + `post()` round-trips JSON on desktop and on an iOS or Android build.

**WP-2.2 · The bridge, worker thread, shims, `LocalTransport` (L)**
*Read first:* §3.3. *Source:* the WP-1.3 bundle.
*Deliverables:* GDExtension binding running the engine on a worker thread; `jsruntime.gd` +
`net/local_transport.gd` exposing the message API to GDScript; console/clock shims; clean
startup/shutdown/restart (new game = fresh realm); error surfacing (JS exception → Godot log +
recoverable UI state).
*Done when:* a headless Godot test boots the bundle, starts an AI-vs-AI game through
`LocalTransport`, and runs it to completion; the runtime-parity smoke (§3.4) passes in CI
against the embedded backend.

**WP-2.3 · D2-check on hardware (S)** — measure the per-round budget (D2) on the slowest real
target devices; record results in `godot/README.md`; escalate per D2 only if the gate fails.

**WP-2.4 · Save/load & campaign persistence through the bridge (M)**
*Source:* localStorage save slots in the web client, `src/version.js` SAVE_VERSION rules,
campaign saves. Godot owns the files (user://), the engine owns the format (`serializeState`).
*Done when:* a save written by the web client loads in Godot and vice versa (same
`SAVE_VERSION` semantics — this is cross-client compatibility for free, verify it anyway).

**WP-2.5 · Dev-mode sidecar (S, optional but recommended)** — a debug flag that points
`LocalTransport`'s messages at a local Node process running the same host module instead of the
embedded runtime. Gives breakpoint-level debugging of engine code under Godot on desktop.
Never ships in release builds.

### Phase 3 — Client shell, board & presentation (`godot/game/`, `godot/ui/`)

Needs WP-2.2 (`LocalTransport`). All UI text uses the icon font, never emoji (Guideline 8).

**WP-3.1 · App-mode state machine & scene shell (M)**
*Read first:* spec 03 §2; `docs/03-state-machines.md`. *Source:* `src/app-mode.js`, `main.js`
mode transitions.
*Deliverables:* mode enum + single owner (mirroring "main.js owns all setMode transitions; UI
only reads"), scene routing MENU↔game.

**WP-3.2 · Board rendering: hexes, terrain, buildings, entities (L)**
*Read first:* spec 03 §7 (the renderer contract — *what* is drawn); spec 01 §2.4 (sub-hex
slots). *Source:* `src/renderer-3d.js` for visual reference (materials, `PHASE_LIGHT_CONFIG`
phase lighting), `assets/**/*.glb` (native glTF import).
*Deliverables:* scenes rendering a deserialized `GameState`: tile meshes, roads/rivers, buildings
with footprints, entity models with the existing animation clips, fog-of-war, phase lighting,
node/objective markers.
*Done when:* screenshot review (WP-3.7 harness) of the same save rendered web vs Godot shows
matching board *content* (same information, not pixel parity).

**WP-3.3 · Camera & input (M)** — *Read first:* spec 03 §6. *Source:* `src/keybindings.js`,
camera code in `renderer-3d.js`. Pan/zoom/rotate, touch gestures, keyboard map.

**WP-3.4 · HUD, overlays, dialogs, toasts (L)**
*Read first:* spec 03 §4 — the complete surface catalog, canonical names per CLAUDE.md.
*Source:* `index.html`, `src/ui.js`/`ui-*.js` (behavior), `styles.css` (gothic look).
*Deliverables:* Control-node equivalents of every cataloged surface; a Theme resource;
`BrimstoneIcons` (`assets/fonts/brimstone-icons.woff2`, PUA U+E000–E0FF — Godot 4 loads WOFF2)
as a theme font fallback; extend `scripts/gen-icons.mjs` to also emit `godot/ui/icons.gd`.

**WP-3.5 · Planning interactions (L)**
*Read first:* spec 03 §5 — selection, radial Action Popup, ghost overlay + multi-move chaining,
Cancel Bar/targeting, Plan Panel & submit. All rule answers come from WP-1.2 queries over the
transport — the UI computes nothing (D3 rule).
*Done when:* a full offline vs-AI game is playable end-to-end in Godot.

**WP-3.6 · Resolution/replay presentation (L)**
*Read first:* spec 03 §8 — the Sim/Show split invariant, resolution animation, combat cinematic,
Round Summary, full-game PLAYBACK; `docs/09-mission-logic-graph.md` invariants (presentation
consumes the step stream; animation speed/pauses can never affect logic — the bridge makes this
structural: logic literally lives on the other side).
*Done when:* recorded step streams (from offline host and from server captures) drive the full
animated presentation; conversations' Show events render (see WP-5.1 for campaign content).

**WP-3.7 · Godot visual-verification harness (M)** — the Godot analogue of the
`verifier-browser` skill (Guideline 7 must survive). `godot/tools/verify.gd` boots a scripted
scenario, steps modes, captures viewport screenshots to a directory; CI-runnable with a software
Vulkan driver (lavapipe) or local GPU. Documented as `.claude/skills/verifier-godot/`.
*Done when:* it reproduces the screenshot set illustrating spec 03. Land this **before** the big
UI packages so their "done when" can require screenshots.

**WP-3.8 · Voiceover & audio (S)** — `assets/voice/manifest.json` + mp3s play from the bundle
(icon-stripping for TTS already happens at generation time); SFX/music hookup.

### Phase 4 — Online client (`godot/net/`)

**WP-4.1 · WSTransport & mirror wiring (L)**
*Read first:* spec 01 §11.2–11.6; `docs/04-network-protocol.md`. *Source:* `src/multiplayer.js`
(`MirrorState`/`MirrorEntity` — read-only; mutators are no-ops).
*Deliverables:* WebSocket transport covering the full message catalogue; snapshots/steps fed to
the embedded mirror (§3.2) so planning queries work online; heartbeat mismatch → `requestState`
resync; reconnection.
*Done when:* a scripted Godot client completes full games against the real local Node server
(`npm run dev`), **including a mixed game with one web client and one Godot client** — cross-play
is the acceptance test. `scripts/headless-mp-net.js` patterns can drive the server side.

**WP-4.2 · Lobby / matchmaking / seats UI (M)** — *Read first:* spec 03 §3 (Ledger flow, online
cards), spec 01 §11.4. Create/join/claim/faction/AI-fill/start against the live server.

**WP-4.3 · Auth, magic-link, sessions (M)** — *Read first:* spec 01 §11.7–11.8;
`docs/07-data-persistence.md`. *Source:* `server/auth.js`, `server/magic-link.js`. Needs OS
deep-link registration in the Godot app (per-platform; coordinate with WP-6.1/6.2).

**WP-4.4 · Spectator & async correspondence games (M)** — *Read first:* spec 03 §9. *Source:*
`server/async-game*.js` client-visible flows.

### Phase 5 — Campaign presentation

The campaign *logic* — mission JSON, registry, conductor, unlock criteria, the mission-logic
graph engine, waves, custom victory — already runs inside the embedded host (it's the same
`src/campaign/` + `src/mission-logic/` code, exercised via WP-1.1). This phase is presentation.

**WP-5.1 · Mission map, briefings, conversations, progression UI (L)**
*Read first:* `docs/08-content-authoring.md`, `docs/09-mission-logic-graph.md`; spec 03 §8.6
(conversations). *Source:* campaign screens in the web client.
*Deliverables:* mission-map screen with `requires`/`unlock` gating states (queried from the
host), briefing/debrief, conversation presentation for Show events, campaign save slots
(WP-2.4).
*Done when:* the shipped campaign is playable start-to-finish in Godot;
`node scripts/headless-campaign.js --all` (Node-side, unchanged) still gauges difficulty for the
identical logic.

### Phase 6 — Platforms & release

**WP-6.1 · iOS export (L)** — replaces the Capacitor wrapper. Export template, signing,
deep-links (WP-4.3), push via an APNs Godot plugin against the existing `server/push.js`
endpoints. **App Review note:** all JS is bundled and interpreted in-process; add a release-build
assertion that the bridge refuses to evaluate anything not baked into the app (2.5.2 hygiene).
TestFlight build.
**WP-6.2 · Android export (M)** — same, with FCM plugin.
**WP-6.3 · Desktop export (S)** — macOS/Windows, replaces the Electron game wrapper (Caleb's
Studio stays).
**WP-6.4 · Release integration (M)** — wire Godot builds (incl. the D4 bundle step) into
`scripts/release.js`; version/save-compat stamped from `src/version.js`; side-by-side period with
the web client on the same server; exit criteria for making Godot the default client (crash-free
rate, cross-play bug count, telemetry via `server/game-stats.js`, which is already
client-agnostic).

### Phase 7 — Docs & guardrails (continuous; finalized last)

- Update `docs/01`–`04` with the Godot client architecture and the bridge (Guideline 4); add
  `docs/10-godot-client.md` (bridge API reference, transport/message contract, threading model).
- Extend `CLAUDE.md`: godot/ layout, the no-rules-in-GDScript rule, "engine changes are JS
  changes" (one place, both clients — Guidelines 1–3, 5 apply exactly as today, and any change to
  the host/bridge message surface must update both transports + golden tests), verifier-godot
  skill, bundle-regeneration requirement.
- Sunset decisions: retiring the web client (not before Godot has been default for a full release
  cycle); whether `index.html`/`ui.js` stay as a thin support/debug client.

---

## 6. Module mapping

| Today (JS) | In the Godot app | Phase |
|---|---|---|
| `src/game.js`, `actions.js`, `entities.js`, `planner.js`, `hex.js`, `map.js`, `tiles.js`, `items.js`, `abilities.js`, `unit-types.js`, `factions.js`, `loot.config.js`, `content/` | **Verbatim**, inside the embedded runtime (D4 bundle) | 1–2 |
| `server/resolver.js`, `server/state-sync.js` | **Verbatim**, inside the bundle (offline authority + mirror) | 1–2 |
| `src/ai.js`, `ai-engine.js`, `hero-ai-engine.js` | **Verbatim**, inside the bundle | 1–2 |
| `src/campaign/`, `src/mission-logic/`, `src/tutorial/` | **Verbatim**, inside the bundle | 1, 5 |
| `src/main.js` (local game loop) | Extracted → `src/offline-host.js` (shared by web client and bundle) | 1.1 |
| `src/multiplayer.js` | Split: socket handling → `godot/net/ws_transport.gd`; mirror upkeep → embedded engine | 4.1 |
| `src/app-mode.js`, `main.js` (mode orchestration) | `godot/game/app.gd` | 3.1 |
| `src/renderer-3d.js` | `godot/game/board/*` scenes | 3.2 |
| `index.html`, `styles.css`, `src/ui.js`/`ui-*.js` | `godot/ui/*` scenes + Theme | 3.4/3.5 |
| `src/keybindings.js` | `godot/game/input/*` | 3.3 |
| — (new) | `godot/bridge/` GDExtension + `engine.bundle.mjs` | 2 |
| `scripts/headless*.js`, `combat-sim.js`, `ai-matrix.js` | Unchanged, on Node (Guideline 3) | — |

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Engine code turns out to touch a browser/Node API** somewhere (a stray `fetch`, `localStorage`, `setTimeout`) | WP-1.3's "runs under `qjs` CLI" gate finds every one before any Godot work depends on it; fixes are small injections through the host boundary. |
| **`main.js` refactor destabilizes the live web game** | It's the one live-code churn, isolated in WP-1.1, guarded by the full existing test suites, headless balance smoke, and verifier-browser screenshots (Guidelines 2, 3, 7). |
| **QuickJS too slow on low-end phones** | D2-check on real hardware at Phase 2 with a pre-agreed escalation path (JSC on Apple, bytecode precompile, worker-thread already assumed). Turn-based cadence makes failure unlikely. |
| **JS-engine behavior differences (Node vs QuickJS)** — sort stability, number→string formatting, locale | Seeded runtime-parity smoke in CI (§3.4.2) pins Node ≡ embedded output; divergences fixed in engine code (e.g. explicit comparators), which also hardens the web game. |
| **Bridge threading bugs** (UI reading state mid-mutation) | State never shared by reference: everything crosses as JSON messages; the worker owns the realm; GDScript owns parsed copies. Enforced by the bridge API shape itself. |
| **App Store rejection over embedded JS** | Bundled-only, interpreted code is squarely allowed (2.5.2 targets *downloaded* code); release-build assertion that nothing external is ever evaluated; JSC backend available as the maximally-conservative Apple fallback. |
| **Third-party JS-runtime plugin becomes a liability** | WP-2.1 spike explicitly weighs hand-rolled (tiny surface) vs plugin; the §3.3 interface keeps backends swappable either way. |
| **Rules creep into GDScript over time** | D3 hard rule + conventions doc + review checklist; planning UI is forced through the query surface because GDScript has no rules code to call. |
| **Push/deep-link plugins on mobile are flaky** | Isolated WPs (4.3, 6.1, 6.2) with no engine coupling; worst case they ship after the client itself. |

---

## 8. How to hand this to agents

- **One WP = one agent brief.** Each WP names its *read-first* spec sections, *source-of-truth*
  files, deliverables, and a checkable "done when". Paste the WP text plus §2 (decisions) and §3
  (bridge design) into the agent's prompt.
- **Skill split:** Phase 1 WPs are JS work in `src/` (agents need the existing CLAUDE.md
  guidelines — tests-first, balance smoke, browser verification). Phase 2 is C/GDExtension
  systems work. Phases 3–5 are Godot scene/UI work against a stable transport.
- **Sequencing:** 0 and 1 in parallel; 2.1 may start early against a stub bundle; 2.2 unlocks the
  Phase 3 fleet; 4 and 5 fan out independently after 3.5/3.6.
- **Escalation rule:** an agent that hits a rules question in Godot work does not answer it in
  GDScript — it either finds the answer in a query response or files the missing query as a
  Phase-1 follow-up.

---

## 9. What changed from Rev 1 (for the record)

Rev 1 (git history) planned a full GDScript port of the engine and AI, gated by a three-level
conformance harness (replay / seeded-resolution / statistical) with generated fixture corpora.
Rev 2 replaces all of that with runtime embedding: the port surface went from "every rule, every
goal formula, every serialization allowlist" to "one GDExtension + one refactor of `main.js`".
The conformance idea survives only as the small seeded runtime-parity smoke (§3.4.2). The Rev 1
plan remains the documented fallback if embedding fails a gate that cannot be engineered around
(none is currently foreseen — D2's performance gate has generous headroom for a turn-based game).

## 10. Deferred / future (explicitly not in this migration)

- **Server rewrite** — unchanged from Rev 1: the wire contract (spec 01 §11) keeps it swappable
  later; embedding makes it *less* likely to ever be needed, since the server already runs the
  same code the app ships.
- **Godot web export** (D7).
- **Retiring the Canvas 2D renderer / admin tools** — they keep authoring the JSON content both
  clients consume.
- **Retiring the web client** — a Phase-7 exit-criteria decision, not a migration deliverable.
