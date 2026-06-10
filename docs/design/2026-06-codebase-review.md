# Codebase & Game Design Review — June 2026

A holistic evaluation of Brimstone's code robustness and game design, produced from
three deep review passes (game design, code robustness, player experience / AI /
multiplayer). Items marked **[scheduled]** are being implemented on the
`claude/codebase-game-design-review-d922nv` branch; everything else is recorded
here as future work.

## Verdict

Brimstone has an unusually strong foundation: a clean four-layer architecture with
strict separation of concerns, well-balanced asymmetric factions (51.6% / 48.4%
over 500 headless games), a principled non-cheating 5-stage AI pipeline,
deterministic seeded map generation, and a 4,700-assertion test suite that runs in
under a minute with no build step.

The two biggest gaps:

1. **The decision space collapses after ~round 12.** Once nodes are claimed and
   forts are up, the optimal play for both sides is largely repetition until one
   side reaches 4 points. The early game (explore, recruit, contest nodes) is the
   best part of the game; the late game needs a mechanic that keeps positions
   contestable.
2. **The experience layer is unfinished.** The game is fully silent (no
   `AudioContext`/`new Audio` anywhere in `src/`), combat is a black box at
   decision time (no odds preview before committing an attack), mechanics like
   gang-up advantage and phase bonuses are undocumented in-game, and there are no
   difficulty tiers for new players.

On the code side, the architecture is sound but four robustness issues stand out,
all in the online path.

## Code findings

### High priority

- **Server trusts client plans** **[scheduled]** — `handleSubmitPlan()`
  (`server/lobby.js`) checks only `Array.isArray(plan)` before queuing. Neither
  `validatePlanAction()` (`src/planner.js`) nor the action budget is enforced
  server-side, so a modified client can submit arbitrary, over-budget, or
  malformed actions. The resolver re-checks legality of most actions at execution
  time, but budget is not enforced there, and malformed actions can throw inside
  resolution (see next item).
- **Resolution errors hang the room** **[scheduled]** — in `_executeResolution()`
  (`server/lobby.js`), a throw from `resolvePlansMP()` is caught and `steps` is
  set to `[]`, but the (possibly half-mutated) state is then finalized and
  broadcast as if the round resolved. There is no rollback even though a
  pre-resolution snapshot (`preStateJson`) is taken on the line above for replay
  purposes.
- **State-sync silently drops new fields** **[scheduled]** —
  `server/state-sync.js` serializes a hand-maintained list of ~40 fields. A new
  `GameState` field that isn't added there is silently lost in online games and
  resumes (acknowledged in CLAUDE.md Guideline 5). Nothing automated catches
  this.
- **Postgres suite is not in CI** **[manual step — see below]** —
  `.github/workflows/test.yml` runs `npm test` (SQLite) only;
  `tests/db-postgres.test.js` self-skips without `PG_TEST_URL`, so the
  Guideline-6 parity rule is enforced only by review. Workflow files cannot be
  pushed from this automation session (the OAuth token lacks the `workflow`
  scope), so apply this by hand — add the following job to
  `.github/workflows/test.yml`:

  ```yaml
  test-postgres:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: brimstone_test
          POSTGRES_PASSWORD: brimstone_test
          POSTGRES_DB: brimstone_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U brimstone_test"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      # pg-native (optionalDependency) needs libpq headers to build.
      - run: sudo apt-get update && sudo apt-get install -y libpq-dev
      - run: npm ci
      - run: node --test tests/db-postgres.test.js
        env:
          PG_TEST_URL: postgresql://brimstone_test:brimstone_test@localhost:5432/brimstone_test
  ```

### Medium priority (future work)

- **God files** — `src/renderer-3d.js` (18,748 lines), `src/main.js` (8,182),
  `src/ui.js` (5,755), `server/lobby.js` (4,050). `lobby.js` mixes room
  lifecycle, AI orchestration, resolution, and persistence and has no dedicated
  test file. Suggested splits: renderer-3d by concern (lights / geometry /
  materials / animation), lobby into room-lifecycle / AI-orchestration /
  persistence, campaign conductor out of main.js.
- **No linting or static analysis** — no ESLint config; the codebase is
  disciplined by convention only.
- **Terminology drift** — the resolver/UI still call a TURN a "step"
  (`stepIndex`, `steps[]`), per the glossary note in CLAUDE.md; a deliberate
  rename would help new contributors.
- **Magic numbers** — combat constants, AI weights, and phase tuning values are
  scattered across modules; a constants module would make tuning passes safer.

## Game design findings

### Strengths to preserve

- The asymmetric faction design is the heart of the game: hero income (survivors)
  vs witch income (summons), day/night phase pressure, and node scoring create
  genuinely different play patterns per side.
- The simultaneous-plan/lockstep-resolve loop avoids first-mover advantage and
  makes online async play natural.
- The AI plays by the same rules as the player (same `actions.js` entry points,
  fog of war respected) — keep this property through any difficulty work.

### Gaps

- **Combat opacity** **[scheduled]** — the dice math in
  `Entity.resolveCombat()` is deterministic and enumerable, but the player never
  sees odds before committing. A hit/crush/counter percentage preview turns
  attacks from gambles into decisions.
- **No difficulty tiers** **[scheduled]** — a single AI strength gates new
  players out and bores veterans. Online AI fill-in additionally forces the
  `balanced` personality only (`_randomPersonality()` in `server/lobby.js`).
- **No audio** **[scheduled]** — even minimal synthesized feedback (hit, crush,
  death, summon, phase change, scoring, victory) substantially improves feel.
- **Hero recruitment snowball** **[scheduled: graveyard spawns]** — survivor
  recruitment compounds: each survivor found makes the next easier to reach and
  protect, while the witch's summons cost actions every time. Chosen fix:
  graveyard tiles passively spawn a witch-owned zombie on a fixed cadence with a
  cap, mirroring hero income without touching hero-side rules.
- **Late-game stagnation** (deferred — option not yet chosen) — candidate hooks:
  (a) fortification decay per cycle, (b) rare loot appearing in later cycles,
  (c) a rotating double-value node per cycle.
- **Day-side content thinner than night-side** (deferred) — see
  `docs/design/faction-expansion.md`: Captain summoning Soldiers, Necromancer
  cheap zombies, per-faction unique abilities.
- **Asymmetric fog in human-vs-AI** (deferred) — the human always sees
  everything while the AI respects fog; a symmetric-fog option would sharpen the
  scouting game.

## Retention / meta (deferred)

Game stats (winner, rounds, kills, personalities, win reason) are already
recorded per game — a public leaderboard, ELO/ranked, public spectating, replay
export/share, and achievements are all data-ready. Campaign chapters 2–4 are
stubbed/disabled.

## Scheduled work (this branch)

| # | Item | Area |
|---|------|------|
| 1 | Server-side plan validation + budget enforcement | server/lobby.js |
| 2 | Resolution error recovery via pre-round snapshot | server/lobby.js |
| 3 | State-sync schema-guard test | tests/ |
| 4 | Postgres service in CI | .github/workflows |
| 5 | Combat odds preview | src/entities.js, src/ui.js |
| 6 | Tooltips (phase bar, actions, battle dialog) | src/ui.js, index.html |
| 7 | AI difficulty tiers + re-enabled online personalities | src/ai.js, both orchestrators |
| 8 | Synthesized Web Audio SFX | src/audio.js (new) |
| 9 | Witch graveyard passive zombie spawns | src/game.js, balance-validated |
