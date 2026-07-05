# Brimstone — Godot Migration Plan

**Status:** proposed · **Date:** 2026-07-05 · **Owner:** Fraser
**Companion reading:** the functional spec in [`spec/`](../../spec/README.md) — this plan does not
duplicate it. Every work package below cites the spec sections and source files an implementing
agent must read first.

---

## 1. Goal & guiding idea

Replace the browser/JS **game client and rules engine** with a native **Godot 4** application,
while keeping the existing **Node server, database, and wire protocol** untouched during the
migration. The spec's central architectural fact makes this tractable
(spec 01 §0.2):

> The authority resolves each round once and ships `steps[]` + the serialized final state.
> **Everyone else replays the recorded events — clients never re-run the resolver online.**

Consequences we exploit:

1. **Online first-class from day one, cheaply.** A Godot client that can (a) speak the existing
   WebSocket/REST protocol and (b) *replay* a step stream is a full online client — it needs zero
   resolution logic to interoperate with the current server and current web players.
2. **The full rules-engine port is only needed for offline authority** (vs-AI, hot-seat, campaign,
   AI-vs-AI). That port has an objective, machine-checkable acceptance bar: the conformance harness
   in §4.
3. **Content stays shared.** Campaign missions are already JSON; entity/item/ability tables will be
   exported to JSON consumed by both engines. Assets are already glTF (`assets/**/*.glb`), which
   Godot imports natively.

### Explicitly out of scope (stays as-is, in JS)

| Component | Why it stays |
|---|---|
| `server.js`, `server/**` (lobby, resolver, DB, auth, saves, async games, push, admin API) | The Godot client talks to it over the existing protocol (spec 01 §11). Rewriting the server is a separate, optional future project (§9). |
| `admin.html`, `admin-tools.html`, Caleb's Studio, `src/renderer.js` (Canvas 2D) | Internal tools. The Mission Editor writes JSON the Godot game reads — no coupling to the client stack. |
| `scripts/headless.js` & friends (JS side) | Remain the **reference implementation** for conformance and balance until Phase 3 ships Godot equivalents; kept even after, as the oracle. |
| The web client (`index.html`, `src/main.js`, `src/ui*.js`, `renderer-3d.js`) | Kept **frozen but running** until Phase 7 sign-off; it is the cross-play test partner and the behavioral oracle. Do not delete during migration. |

---

## 2. Key decisions (make these first — Phase 0 gates on them)

Each has a recommendation; an agent should treat the recommendation as the default and only
escalate if it hits a hard blocker.

### D1 — Engine version: **Godot 4.5.x, pinned**
Pin the exact minor version in `godot/README.md` and CI. Do not float. Upgrades are a deliberate,
single-commit event with full test + conformance rerun.

### D2 — Language: **GDScript throughout** (C# fallback only if D2-check fails)
One language keeps the agent workflow simple and every export target (iOS/Android/desktop) on the
best-supported path. The rules engine is turn-based and small — performance is only a question for
the balance simulator. **D2-check (run at end of Phase 1):** `godot --headless` must complete 500
AI-vs-AI standard games in under ~30 minutes on a dev laptop. If it can't, port only the
engine+AI core to C# as a shared assembly; UI stays GDScript. Do not pre-emptively choose C#.

### D3 — Repo layout: **in-repo `godot/` directory**, not a new repository
The conformance harness needs the JS reference, the fixtures, and the Godot port in one checkout
and one CI run. Layout:

```
godot/
  project.godot
  engine/        # scene-free rules engine (RefCounted classes, zero Node/scene deps)
  ai/            # scene-free AI (mirrors src/ai*.js structure)
  net/           # WebSocket client, protocol types, mirror state
  game/          # scenes: board, entities, camera, replay presentation
  ui/            # scenes: Ledger/setup, HUD, overlays, dialogs, toasts
  data/          # symlink/committed copy of exported JSON tables (see D5)
  tests/         # gdUnit4 suites, incl. conformance runner
  tools/         # headless entry scripts (balance sim, combat sim, fixtures)
```

**Hard rule mirroring the existing architecture:** nothing under `godot/engine/` or `godot/ai/`
may reference `Node`, scenes, viewports, input, or wall-clock time. This is the Godot analogue of
"DOM-free shared code" and is what makes headless simulation and server-reuse possible. Add a CI
grep-guard test for it (like `tests/no-ui-emoji.test.js` guards emoji).

### D4 — Server strategy: **keep the Node server**; Godot is a protocol-compatible client
Online play, async games, persistence, auth, push, leaderboard, and admin all keep working with
zero server changes, and web↔Godot **cross-play** works throughout the transition. A Godot-based
(or other) server rewrite is deferred to §9.

### D5 — Data tables: **export JS tables to canonical JSON**, consumed by both engines
`src/unit-types.js`, `src/items.js`, `src/abilities.js`, `src/factions.js`, `src/loot.config.js`,
`src/content/` (survivor roster), and the key constants (spec 01 §13) become build-exported JSON
under `data/tables/`. The JS game keeps its modules as-is (no churn to live code); a new
`scripts/export-data-tables.mjs` dumps them, a guard test fails if the committed JSON is stale.
Godot loads only the JSON. Campaign missions (`src/campaign/missions/*.json`) are consumed
directly — no conversion.

### D6 — Web platform: **Godot does not target the browser** in this migration
The existing web client remains the browser offering until a deliberate later decision. Godot's
web export is not required to pass any phase.

---

## 3. Phase map & dependency graph

```
Phase 0  Foundations (project skeleton, CI, guards)
Phase 0R Reference-side prep (seeded RNG in JS, fixture generator, data export)   ← JS work
   │
   ├────────────► Phase 1  Rules engine port (engine/)      ── conformance L1+L2
   │                   │
   │                   ├──► Phase 2  AI port (ai/)          ── conformance L2-AI + L3
   │                   │        └──► Phase 3  Headless balance tooling
   │                   │
   └──► Phase 4  Client shell, board & presentation (game/, ui/)   ── needs only replay (L1)
                 │
                 ├──► Phase 5  Online client (net/)          ── cross-play vs Node server
                 ├──► Phase 6  Campaign & mission-logic graph
                 └──► Phase 7  Platforms & release (iOS/Android/desktop)
Phase 8  Docs, guardrails, sunset decisions (continuous, finalized last)
```

Parallelism for a fleet of agents: after Phase 0/0R land, **Phase 1 and Phase 4 proceed in
parallel** (Phase 4 needs only the serialized-state reader and step replayer, both early Phase 1
deliverables). Phase 2 starts when Phase 1's resolver passes L1. Phases 5 and 6 are independent
of each other.

---

## 4. The conformance harness (the acceptance bar for everything)

This is the heart of the plan. Because resolution is intentionally **not** seeded in production
(spec 01 §0.2), we define three graded conformance levels. Fixtures are generated by the JS
reference (Phase 0R) and stored under `tests/conformance-fixtures/` as JSONL:
`{ seed, preState, plans, steps, finalState }` per round, across many full games and map sizes.

**Level 1 — Replay conformance (MUST pass; gates Phases 1, 4, 5).**
Feed a fixture's `preState` + `steps[]` into the Godot replayer; the resulting state must
deep-equal `finalState` (structural compare of `serializeState` shape — key sets, values;
order-insensitive for `tiles`/`entities` arrays sorted by key/id; exact integer match, 1e-9
tolerance for floats). This proves the state model, serialization, and event-application logic
without touching RNG. It is also *exactly* what the online client does in production.

**Level 2 — Seeded resolution conformance (MUST pass for the engine port; gates Phase 1→2).**
With the same seeded PRNG (see below) threaded through both engines, Godot's
`resolve_plans(preState, plans, seed)` must emit step events and a final state deep-equal to the
JS reference's seeded run. This requires the port to consume dice in the **same order** as the JS
resolver — i.e., a faithful, call-order-preserving port of `server/resolver.js`, `src/actions.js`,
and `Entity.resolveCombat()`. **PRNG: mulberry32** — 32-bit integer math implementable identically
in JS (`Math.imul`) and GDScript; one shared test vector file proves the two implementations match
before anything else is compared.
*Level 2-AI:* same idea for plan generation — hero AI is already deterministic (spec 02 §10);
the witch's `genBuildArmy` random picks must go through the seeded hook.

**Level 3 — Statistical conformance (gates Phase 2/3).**
With live (unseeded) RNG, the Godot engine must reproduce the reference's distributions:
combat-sim hit/crush/counter rates within ±2pp of `node scripts/combat-sim.js 200` output, and
500-game headless win rates within ±4pp of the JS baseline (Hero ≈43% / Witch ≈57%, mean ≈22
rounds — spec 02 §12), plus all balance targets from spec 01 §13.

**Rule for agents:** a work package is not done until its stated conformance level passes in CI.
When Godot and JS disagree, **the JS code is the oracle** (the spec itself defers to code —
spec README "Authority of this spec vs. the codebase").

---

## 5. Phase work packages

Each WP is written as a hand-off brief: *Read first* (spec/docs), *Source of truth* (JS files),
*Deliverables*, *Done when*. Sizes: S (≤1 day-equivalent), M (a few days), L (a week+).

### Phase 0 — Foundations

**WP-0.1 · Godot project skeleton + CI (M)**
*Read first:* this document §2–4; `docs/01-architecture-overview.md`.
*Deliverables:* `godot/` per D3; gdUnit4 installed; a trivial engine class + test; GitHub Actions
job that runs `godot --headless` imports + tests on every PR touching `godot/`; the
scene-free grep-guard for `engine/` and `ai/` (D3); `godot/README.md` documenting the pinned
version, how to run tests, and the D2-check procedure.
*Done when:* CI is green on a PR that adds a failing-then-fixed sample test.

**WP-0.2 · Coding conventions & agent working agreements (S)**
*Deliverables:* `godot/CONVENTIONS.md` — naming (snake_case mirroring of JS identifiers with a
JS→GDScript mapping note per file header), typed GDScript everywhere, no `randi()`/`randf()` in
`engine/`/`ai/` (all randomness through the injected RNG object), how to cite the JS source line
being ported, and the conformance rule from §4. Extend the repo `CLAUDE.md` with a short
"Godot port" section pointing here.
*Done when:* reviewed and merged; CLAUDE.md updated.

### Phase 0R — Reference-side prep (JS codebase work)

**WP-0R.1 · Seeded RNG threading in the JS engine, behind a flag (M)**
*Read first:* spec 01 §0.2; spec 02 §10.
*Source of truth:* `state.nextDie(sides)` hook in `src/game.js`; `Math.random` call sites in
`server/resolver.js`, `src/actions.js`, `src/entities.js` (combat, target pick, loot), and witch
`genBuildArmy` in `src/ai-engine.js`.
*Deliverables:* a `--seed` mode (default off — production behavior byte-identical) that routes
every resolution- and AI-randomness call through mulberry32; a JS↔GDScript shared PRNG test-vector
file; unit tests proving two seeded runs of the same round are identical.
*Done when:* `npm test` green; a seeded headless game replays identically twice; **unseeded
behavior provably unchanged** (existing balance smoke within noise).

**WP-0R.2 · Conformance fixture generator (M)**
*Deliverables:* `scripts/gen-conformance-fixtures.mjs` — runs seeded games across all map sizes,
1v1 and NvN, campaign and standard, dumping the §4 JSONL corpus (target: ≥50 games, ≥1000
rounds); a fixture-schema doc; fixtures committed (or CI-regenerated) under
`tests/conformance-fixtures/`.
*Done when:* JS itself passes L1/L2 against its own fixtures (self-check harness), proving the
comparator and fixtures are sound before any Godot code exists.

**WP-0R.3 · Data-table export (M)** — implements D5.
*Source of truth:* the modules listed in D5; spec 01 §5–7, §13.
*Deliverables:* `scripts/export-data-tables.mjs`; committed `data/tables/*.json`; staleness guard
test; short format doc.
*Done when:* guard test green; a spot-check confirms every constant in spec 01 §13 appears in the
export.

### Phase 1 — Rules engine port (`godot/engine/`)

All WPs here: scene-free GDScript; every class documents which JS file/function it ports.
The JS reference is the oracle; the spec is the map.

**WP-1.1 · Hex math, coordinates, map sizes (S)**
*Read first:* spec 01 §2. *Source:* `src/hex.js`.
*Done when:* ported unit tests (from `tests/`) green; axial/offset conversions match JS on a
generated grid of test vectors.

**WP-1.2 · Tiles, terrain, buildings, fortification model (M)**
*Read first:* spec 01 §4. *Source:* `src/tiles.js`, tile logic in `src/game.js`.
*Done when:* tile serialization round-trips the fixture tile shapes exactly (L1 subset).

**WP-1.3 · Entities, stats, items/abilities/effects, factions (L)**
*Read first:* spec 01 §5–7, §0.4 (`DAMAGE_SCALE`). *Source:* `src/entities.js`,
`src/unit-types.js` + the D5 JSON tables, `src/items.js`, `src/abilities.js`, `src/factions.js`.
*Done when:* entity serialization round-trips fixtures (L1 subset); derived-stat accessors match
JS on table-driven test vectors (levels, weapons, effects).

**WP-1.4 · Combat (M)**
*Read first:* spec 01 §8 — all of it, including ranged, splash, fort erosion/assault, exact odds.
*Source:* `Entity.resolveCombat()` in `src/entities.js`.
*Done when:* seeded combat vectors (generated by WP-0R.1) match exactly (L2 subset); unseeded
distributions match `combat-sim` within ±2pp (L3 subset).

**WP-1.5 · Map generation (M)**
*Read first:* spec 01 §3. *Source:* `src/map.js`.
Map gen **is** seeded in production (`state.mapSeed`) — so this must match JS **exactly** for a
given seed once the PRNG is shared.
*Done when:* for N seeds × 4 sizes, Godot's generated tile array deep-equals the JS reference's.

**WP-1.6 · Actions (L)**
*Read first:* spec 01 §9 (every subsection). *Source:* `src/actions.js` — "single source of truth
for rules"; port function-by-function, preserving `{success, log, cost}` result shapes and RNG
call order.
*Done when:* L2 passes on all fixture rounds that contain each action type (the fixture generator
must assert coverage of every `PlanActionType`).

**WP-1.7 · GameState, planner, resolver, round lifecycle (L)**
*Read first:* spec 01 §10 — the resolution algorithm, `drainOneStep`, guard strikes, phase cycle,
`endRound`/`finalizeRound`, counters. *Source:* `src/game.js`, `src/planner.js`
(`validatePlanAction`, `computeGhostState`), `server/resolver.js` (`resolvePlans` and
`resolvePlansMP` — port both).
*Done when:* **Level 2 passes on the full fixture corpus**, including NvN fixtures.

**WP-1.8 · Serialization + step replayer (M)** — *start early; Phase 4/5 depend on it.*
*Read first:* spec 01 §11.1, §11.3, §12. *Source:* `server/state-sync.js`
(`serializeState`/`deserializeState`), `_serializeEvents` allowlist in `server/lobby.js`.
*Deliverables:* `serialize_state()`/`deserialize_state()` producing/consuming the exact wire
shape; a replayer that applies a `steps[]` stream to a deserialized state.
*Done when:* **Level 1 passes on the full corpus**; a schema test guards the tile/entity
allowlists like the JS one does.

**WP-1.9 · D2-check (S)** — run the 500-game perf check from D2; record the result in
`godot/README.md`; escalate to the C# fallback only if it fails.

### Phase 2 — AI port (`godot/ai/`)

**WP-2.1 · PlanSimState + budget + combat EV model (M)**
*Read first:* spec 02 §3–5. *Source:* `src/ai.js`.
*Done when:* EV estimates match JS on table-driven vectors.

**WP-2.2 · Witch pipeline (L)** — *Read first:* spec 02 §6. *Source:* `src/ai-engine.js`.
**WP-2.3 · Hero pipeline (L)** — *Read first:* spec 02 §7. *Source:* `src/hero-ai-engine.js`.
*Done when (both):* Level 2-AI — seeded plan generation from fixture states produces identical
`PlanAction[]` to the JS reference (hero must match even unseeded, per spec 02 §10).

**WP-2.4 · Personalities, fog handling, NvN coordination (M)**
*Read first:* spec 02 §8–9, §11. *Source:* registries in `src/ai.js`.
*Done when:* registry tables match the D5 export; NvN claimed-node sharing verified on NvN
fixtures.

**WP-2.5 · Balance validation (M)** — full **Level 3**: Godot headless 500-game runs (needs
WP-3.1) hit every target in spec 01 §13 and land within ±4pp of the JS baseline, for standard 1v1
and `--players 2`. Document results in `docs/06-ai-architecture.md` as a new "Godot port
baseline" subsection.

### Phase 3 — Headless tooling (`godot/tools/`)

**WP-3.1 · Balance/sim runners (M)** — Godot-headless equivalents of `scripts/headless.js`
(count/size/`--players N`), `combat-sim.js`, `ai-matrix.js`, `headless-campaign.js`, with the
same report formats so baselines are comparable side-by-side. CI smoke: 25 games per PR touching
`engine/` or `ai/`.
*Done when:* outputs are diffable against the JS scripts' reports and Phase 2.5 used them.

### Phase 4 — Client shell, board & presentation (`godot/game/`, `godot/ui/`)

Needs only WP-1.8 (deserialize + replay). All UI text uses the icon font, never emoji
(Guideline 8 carries over).

**WP-4.1 · App-mode state machine & scene shell (M)**
*Read first:* spec 03 §2; `docs/03-state-machines.md`. *Source:* `src/app-mode.js`, `src/main.js`
mode transitions.
*Deliverables:* the mode enum + owner (mirroring "main.js owns all setMode transitions; UI only
reads"), scene routing MENU↔game.

**WP-4.2 · Board rendering: hexes, terrain, buildings, entities (L)**
*Read first:* spec 03 §7 (renderer interface — the contract of *what* is drawn); spec 01 §2.4
(sub-hex slots). *Source:* `src/renderer-3d.js` for visual reference (materials, layout,
`PHASE_LIGHT_CONFIG` phase lighting), `assets/**/*.glb`.
*Deliverables:* Godot scene rendering a deserialized `GameState` — tile meshes, roads/rivers,
buildings with footprints, entity models with idle/walk animations (the existing glb clips),
fog-of-war, phase lighting, node/objective markers.
*Done when:* screenshot review (see WP-4.8 harness) of the same save rendered in web vs Godot
shows matching board content (not pixel-identical — same information).

**WP-4.3 · Camera & input (M)** — *Read first:* spec 03 §6; source `src/keybindings.js` and
camera code in `renderer-3d.js`. Pan/zoom/rotate, touch gestures (pinch/drag), keyboard map.

**WP-4.4 · HUD, overlays, dialogs, toasts (L)**
*Read first:* spec 03 §4 — the complete surface catalog, using the canonical UI names (CLAUDE.md
"UI Terminology"). *Source:* `index.html` + `src/ui.js`/`ui-*.js` for behavior; `styles.css` for
the gothic look.
*Deliverables:* Godot Control-node equivalents of every cataloged surface; a Theme resource
implementing the dark-gothic style; `BrimstoneIcons` (`assets/fonts/brimstone-icons.woff2`, PUA
U+E000–E0FF — Godot 4 loads WOFF2) wired as a theme font fallback; extend
`scripts/gen-icons.mjs` to also emit `godot/ui/icons.gd`.

**WP-4.5 · Planning interactions (L)**
*Read first:* spec 03 §5 — selection, the radial Action Popup, ghost overlay + multi-move
chaining, Cancel Bar/targeting, Plan Panel & submit. *Source:* `src/ui.js` (`_getProjectedPos`),
`src/planner.js` (`computeGhostState` — already ported in WP-1.7; the UI consumes it).
*Done when:* a full offline vs-AI game is playable end-to-end using engine from Phase 1 + AI from
Phase 2.

**WP-4.6 · Resolution/replay presentation (L)**
*Read first:* spec 03 §8 — the Sim/Show split invariant, resolution animation, combat cinematic,
Round Summary, full-game PLAYBACK. The invariant is load-bearing (CLAUDE.md "Mission Logic Graph
invariants"): presentation *consumes* the step stream and never mutates game state; animation
speed/pauses can never affect logic.
*Done when:* replaying fixture step streams drives the full animated presentation; L1 still
passes on the state the presentation layer read from.

**WP-4.7 · Conversations & voiceover (M)** — *Read first:* spec 03 §8.6. *Source:* conversation
presentation in the web client; `assets/voice/manifest.json` + mp3s. Icons stripped from voiced
text is already handled at generation time — the Godot client just plays manifest audio.

**WP-4.8 · Godot visual-verification harness (M)** — the Godot analogue of the
`verifier-browser` skill (Guideline 7 must survive the migration). A `godot/tools/verify.gd`
entry that boots the game with a scripted scenario, steps through modes, and captures viewport
screenshots (`get_viewport().get_texture().get_image()`) to a directory; runs under CI with a
software Vulkan driver (lavapipe) or a local GPU. Document as `.claude/skills/verifier-godot/`.
*Done when:* it can reproduce the screenshot set used in spec 03's illustrations.

### Phase 5 — Online client (`godot/net/`)

**WP-5.1 · Protocol client & mirror state (L)**
*Read first:* spec 01 §11.2–11.6 (submit payload, step payload, room lifecycle, WS catalogue,
heartbeat/resync); `docs/04-network-protocol.md`. *Source:* `src/multiplayer.js`
(`MirrorState`/`MirrorEntity` — mirror mutators are **no-ops**, read-only by design).
*Deliverables:* WebSocket client covering the full message catalogue; heartbeat mismatch →
`requestState` resync; reconnection.
*Done when:* a scripted Godot client completes full games against the real local Node server
(`npm run dev`), including a mixed game with one web client and one Godot client
(cross-play is the acceptance test). `scripts/headless-mp-net.js` patterns can drive the server
side.

**WP-5.2 · Lobby / matchmaking / seats UI (M)** — *Read first:* spec 03 §3 (Ledger flow, online
cards) + spec 01 §11.4. Create/join/claim/faction/AI-fill/start against the live server.

**WP-5.3 · Auth, magic-link, sessions (M)** — *Read first:* spec 01 §11.7–11.8;
`docs/07-data-persistence.md`. *Source:* `server/auth.js`, `server/magic-link.js`. Needs OS
deep-link registration in the Godot app for the magic-link token (per-platform, coordinate with
WP-7.1/7.2).

**WP-5.4 · Spectator & async correspondence games (M)** — *Read first:* spec 03 §9. *Source:*
`server/async-game*.js` client-visible flows.

### Phase 6 — Campaign & mission-logic graph

**WP-6.1 · Mission loading & campaign flow (M)**
*Read first:* `docs/08-content-authoring.md`, `docs/09-mission-logic-graph.md` §unlock.
*Source:* `src/campaign/` (registry, mission-map, conductor), missions JSON (loaded verbatim).
Includes the mission map screen, `requires`/`unlock` gating, briefings.

**WP-6.2 · Mission-logic graph engine (L)**
*Read first:* `docs/09-mission-logic-graph.md` — the four invariants are non-negotiable, and the
Sim/Show split maps 1:1 onto the engine/presentation boundary this plan already enforces.
*Source:* `src/mission-logic/`, `pumpMissionLogic` wiring in `src/game.js`/`src/main.js`,
`logicState` in `server/state-sync.js`.
*Done when:* L1/L2 conformance extended with campaign fixtures (WP-0R.2 already generates them);
the legacy mission fields (`storyTriggers`, `waves`, `objectives.win/lose`) are ported too — they
are still the live runtime for shipped missions.

**WP-6.3 · Campaign saves & progression (M)** — *Source:* `server/campaign-saves.js` endpoints +
local save slots; `src/version.js` `SAVE_VERSION` compatibility rules apply unchanged (a Godot
client must load a save written by the web client and vice versa — that's L1 in disguise).

### Phase 7 — Platforms & release

**WP-7.1 · iOS export (L)** — replaces the Capacitor wrapper. Export template, signing,
deep-links (WP-5.3), push notifications via an APNs Godot plugin talking to the existing
`server/push.js` registration endpoints. TestFlight build.
**WP-7.2 · Android export (M)** — same, with FCM plugin.
**WP-7.3 · Desktop export (S)** — macOS/Windows, replaces Electron (`electron/main` game wrapper
only — Caleb's Studio stays).
**WP-7.4 · Release integration (M)** — wire Godot builds into `scripts/release.js`
(version stamped from `src/version.js` so save-compat checks share one source of truth);
side-by-side availability period: web client and Godot builds both live against the same server;
define the exit criteria for making Godot the default client (crash-free rate, cross-play parity
bug count, balance-neutral telemetry via `server/game-stats.js` which records client-agnostic
stats already).

### Phase 8 — Docs & guardrails (continuous; finalized last)

- Update `docs/01`, `02`, `03`, `04` with the Godot module graph and client architecture
  (Guideline 4); add `docs/10-godot-architecture.md`.
- Extend `CLAUDE.md`: the godot/ layout, the conformance rule ("JS is the oracle"), the
  scene-free rule for `engine/`/`ai/`, the verifier-godot skill, and a new parity guideline —
  **until the web client is sunset, rule changes must land in `src/` (JS) first, regenerate
  fixtures, then port** (this replaces nothing; Guidelines 5 and 6 continue to apply to the
  server).
- Sunset decisions: when/if to retire the web client and the JS engine as oracle (not before the
  Godot client has been default for a full release cycle).

---

## 6. Module mapping (JS → Godot)

| JS (oracle) | Godot | Phase |
|---|---|---|
| `src/hex.js` | `engine/hex.gd` | 1.1 |
| `src/tiles.js` | `engine/tiles.gd` | 1.2 |
| `src/entities.js` | `engine/entity.gd`, `engine/combat.gd` | 1.3/1.4 |
| `src/unit-types.js`, `items.js`, `abilities.js`, `factions.js`, `loot.config.js`, `content/` | `data/tables/*.json` (shared) + `engine/tables.gd` loader | 0R.3/1.3 |
| `src/map.js` | `engine/map_gen.gd` | 1.5 |
| `src/actions.js` | `engine/actions.gd` | 1.6 |
| `src/game.js`, `src/planner.js`, `server/resolver.js` | `engine/game_state.gd`, `engine/planner.gd`, `engine/resolver.gd` | 1.7 |
| `server/state-sync.js`, `_serializeEvents` | `engine/state_sync.gd`, `engine/replayer.gd` | 1.8 |
| `src/ai.js`, `ai-engine.js`, `hero-ai-engine.js` | `ai/*.gd` (same file split) | 2 |
| `src/app-mode.js`, `src/main.js` (orchestration) | `game/app.gd` | 4.1 |
| `src/renderer-3d.js` | `game/board/*` scenes | 4.2 |
| `src/ui.js`, `ui-*.js`, `index.html`, `styles.css` | `ui/*` scenes + Theme | 4.4/4.5 |
| `src/multiplayer.js` | `net/client.gd`, `net/mirror_state.gd` | 5.1 |
| `src/campaign/`, `src/mission-logic/` | `game/campaign/*`, `engine/mission_logic/*` | 6 |
| `scripts/headless.js` et al. | `tools/*.gd` | 3 |

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **RNG call-order drift** makes L2 unachievable for some path | Port resolver/actions call-order-faithfully with per-function JS line citations; if a specific site proves intractable, document it and downgrade that path to L1+L3 with sign-off — never silently. |
| **JS semantics leak into the port** (object key iteration order, `sort()` stability, float formatting, `null` vs missing key) | Comparator is structural and order-insensitive where the spec allows; fixture self-check (WP-0R.2) shakes out comparator bugs before Godot exists; conventions doc lists known trap patterns. |
| **GDScript too slow for 500-game sims** | D2-check with the pre-agreed C#-core fallback; decision is data-driven, made once, at a defined gate. |
| **Seeding work destabilizes the live JS game** | WP-0R.1 is flag-gated, default off; unseeded path byte-identical; balance smoke before merge. |
| **Godot visual work goes unverified** (Guideline 7 erodes) | WP-4.8 harness is a Phase-4 deliverable *before* the big UI packages land, and every visual WP's "done when" requires screenshots. |
| **Web/Godot rule divergence during the long transition** | Phase 8 parity guideline: JS first → regenerate fixtures → port; CI runs conformance on every `engine/`/`ai/` PR. |
| **Push/deep-link plugins on mobile are flaky** | They are isolated WPs (5.3, 7.1, 7.2) with no engine coupling; worst case ships later than the client itself. |
| **Save/version skew between clients** | One `SAVE_VERSION` source (`src/version.js`) exported via D5; cross-client save load is an explicit acceptance test (WP-6.3). |

---

## 8. How to hand this to agents

- **One WP = one agent brief.** Each WP above already names its *read-first* spec sections,
  *source-of-truth* files, deliverables, and a machine-checkable "done when". Paste the WP text,
  plus §2 (decisions) and §4 (conformance), into the agent's prompt.
- **Sequencing:** run Phase 0 + 0R first (0R WPs are JS work — different skill set, same repo).
  Then fan out: {1.1, 1.2, 1.3, 1.5} in parallel → {1.4, 1.6} → 1.7 → 1.8 unlocks Phase 4/5
  agents while Phase 2 agents proceed.
- **Every engine/AI PR must show its conformance-level result in the PR description**, the way
  gameplay PRs today must show balance-run output (Guideline 3).
- **Escalation rule:** an agent that cannot make Godot match the JS oracle documents the exact
  divergence (fixture id, field, values) in the PR rather than "fixing" the fixture or loosening
  the comparator.

---

## 9. Deferred / future (explicitly not in this migration)

- **Server rewrite** (Godot headless server, or reusing `engine/` server-side). Only worth
  revisiting after the Godot client is the default and if Node maintenance becomes a burden; the
  wire contract in spec 01 §11 makes it swappable later.
- **Godot web export** (D6).
- **Retiring the Canvas 2D renderer / admin tools** — they serve the Mission Editor and Studio,
  which keep authoring the shared JSON content for both clients.
- **Cross-host reproducible online play** (seeded production resolution) — the seeded plumbing
  from WP-0R.1 makes this possible someday, but changing the production authority model is out of
  scope.
