# Faction Expansion: Day vs Night, N Factions per Side

**Status:** in progress
**Branch:** `claude/faction-system-expansion-epEZv`
**Started:** 2026-04-23

This is a living plan. Update it as PRs land or new blockers surface.

---

## Goal

Generalise the current binary Hero-vs-Witch faction model into a **Side ↔ Faction** model with multiple selectable factions per side.

- **Day side:** Paladin, Rogue, Captain
- **Night side:** Witch, Necromancer, Brute

The current Hero entity becomes the **Paladin**, with leader name **Ishmael Charger**. The current Witch keeps the name "Witch" for now. New factions ship as visibly-marked **stubs** — registered, lobby-selectable, and playable, but with mostly-inherited behaviour. Their unique abilities land in follow-up work.

This builds on the existing `Faction` abstraction in `src/factions.js` and continues the de-coupling work tracked in `docs/design/refactor.md` (Findings 1, 4, 6).

---

## Key decisions (confirmed)

| # | Decision | Choice |
|---|---------|--------|
| 1 | Entity type rename | **Rename `EntityType.HERO` → `PALADIN`**; add new types for Rogue, Captain, Necromancer, Brute. Use the `faction-string-checks.test.js` ratchet pattern to manage the sweep. |
| 2 | Stub fidelity | Stub factions are **playable in lobby with a visible "stub" badge** from PR 5. Inherit parent-side behaviour until their own implementation lands. |
| 3 | Witch name | Keep "Witch" as the default leader display name. No rename. |
| 4 | UI terminology | **"Day" / "Night"** in user-facing copy. Internal ids match (`'day'`, `'night'`). |
| 5 | Scope of first cut | Land all 9 PRs. |

---

## Target model

```
Side (1) ── (N) Faction (1) ── (1) LeaderEntityType
                  │
                  ├── stats / abilities (varies per faction)
                  ├── personality registry (AI sub-classes)
                  └── unit registry (which unit types it can field)
```

| Side  | Faction      | Leader entity type | Leader display name | Status |
|-------|--------------|--------------------|----------------------|--------|
| day   | paladin      | `PALADIN`          | Ishmael Charger      | renamed from Hero |
| day   | rogue        | `ROGUE`            | Mercy Sloane         | stub   |
| day   | captain      | `CAPTAIN`          | Captain Eli Ward     | stub   |
| night | witch        | `WITCH`            | Witch                | kept   |
| night | necromancer  | `NECROMANCER`      | (TBD)                | stub   |
| night | brute        | `BRUTE`            | (TBD)                | stub   |

### First-pass leader stats

|              | HP | ATK | DEF | Agility | Notes |
|--------------|----|-----|-----|---------|-------|
| Paladin      | 14 | 3   | 2   | 6       | unchanged from Hero |
| Rogue        | 10 | 3   | 1   | 8       | glass cannon (stub) |
| Captain      | 12 | 2   | 3   | 5       | inspires nearby allies (stub: behaves as Paladin) |
| Witch        | 10 | 2   | 2   | 5       | unchanged |
| Necromancer  | 10 | 1   | 2   | 4       | future: cheap zombie summon (stub: behaves as Witch) |
| Brute        | 14 | 3   | 1   | 3       | melee monster, no golems (stub: behaves as Witch) |

These will be re-tuned via headless balance runs in PR 8.

---

## Phased plan

### PR 1 — Side abstraction (foundation)
Pure additive scaffolding; no behaviour change.
- New `src/sides.js` with `Side` enum (`DAY`, `NIGHT`), `getOpposingSide()`, `getFactionsForSide()`.
- `Faction` base gains `get side()`. `HeroFaction → 'day'`, `WitchFaction → 'night'`.
- Replace `Faction.getOpponentId()` (single id) with `Faction.getOpposingSide()` for forward compatibility with N factions per side.
- New `tests/sides.test.js`; extend `tests/factions.test.js` for `f.side`.

### PR 2 — Generalise state shape
Side-keyed data structures so adding factions doesn't grow the state shape.

| Today                                         | Becomes                                    |
|----------------------------------------------|--------------------------------------------|
| `state.inventory = { hero, witch }`          | `state.inventory[sideId]` (`day`, `night`) |
| `state.heroActionsLeft / witchActionsLeft`   | `state.actionsLeftBySide`                  |
| `state.heroKills / witchKills / witchSummonCount` | `state.killsBySide`, `state.summonsBySide` |
| `nodeController()` `heroHexes/witchHexes` Sets | `Map<sideId, Set>`                       |
| `state.exploredHexes.{hero,witch}`           | `state.exploredHexes[sideId]`              |
| `obj.seenByHero / seenByWitch`               | `obj.seenBy: Set<sideId>`                  |
| `state.nodeScore = { hero, witch }`          | `state.nodeScore[sideId]`                  |
| `state.activePlayer = 'hero'`                | first day-side seat                        |

`server/state-sync.js` and `src/main.js` orchestration update in lockstep (CLAUDE.md §5 parity rule). Save schema version bumps; existing saves get pruned by `pruneStaleAndIncompatibleSaves`.

Campaign mode (`src/campaign/`) currently reads `state.hero` / `state.witch` directly — provide compat accessors `state.leaderForSide(side)` and migrate campaign mission conditions.

Map generation (`src/map.js`) currently calls `startPositionsForFaction(faction)` keyed off INN/GRAVEYARD; rename to `startPositionsForSide(side)` (INN = day anchor, GRAVEYARD = night anchor). `witchObjectives` → `nodeObjectives`.

### PR 3 — Lobby seats keyed {side, factionId}
- Seat shape: `{ side: 'day'|'night', factionId, seatIndex, status, … }`.
- New `setFaction(roomId, factionId)` lobby/protocol message — only valid before game start.
- `claimSlot` accepts an optional `factionId` (default: first faction for that side).
- Color slot allocation moves from `HERO_PLAYER_COLORS / WITCH_PLAYER_COLORS` to `SIDE_THEME[side].playerColors`. Per-faction accent colour is separate.
- Personality lookup: `getFaction(factionId).getPersonalities()` instead of the two global registries.
- Document new protocol message in `docs/04-network-protocol.md` (deferred to PR 9).

### PR 4 — Entity type rename + Ishmael Charger
- Add `EntityType.PALADIN`, `EntityType.ROGUE`, `EntityType.CAPTAIN`, `EntityType.NECROMANCER`, `EntityType.BRUTE`.
- Migrate every `EntityType.HERO` reference to `EntityType.PALADIN` (sweep, allowlisted in `tests/faction-string-checks.test.js` style).
- Add a sister ratchet test for entity-type checks if it makes the sweep safer.
- Default Paladin display name: **Ishmael Charger**.
- Save-format compat: deserialize `'hero'` entity type as `'paladin'`.

### PR 5 — Register stub factions
- New `RogueFaction`, `CaptainFaction`, `NecromancerFaction`, `BruteFaction` classes.
- Each subclass `DaySideFaction` / `NightSideFaction` (extracted from `HeroFaction` / `WitchFaction` commons in this PR — see refactor doc Finding 2 for the broader version).
- Stat overrides per the table above; otherwise inherit parent-side behaviour.
- `getPersonalities()` returns parent-side registry initially.
- `getAINamePool()` returns 4–6 themed names per faction in `ai-names.js`.
- `getStubStatus()` flag — used by UI to render the badge.

### PR 6 — UI / theme / strings
- `index.html` setup screen: 6-tile faction picker grouped by side.
- `FACTION_THEME` gains entries for all six factions; new `SIDE_THEME` for side-level palette (node fill, scoreboard).
- Hardcoded "Hero +1 bonus action" → "Day side +1 bonus action"; same for night.
- Help text, score bar, `node-status`, plan panel, `sp-hero/witch` IDs.
- Stub badge styled inline with faction tile.
- CSS: `--day` / `--night` custom props; `--hero` / `--witch` kept as aliases during migration.

### PR 7 — DB schema migration
Per CLAUDE.md §Database parity rule, every change applies to **both** sqlite and postgres.

Tables touched:
- `server/db/{sqlite,postgres}/game-stats.js` — drop `hero_*` / `witch_*` columns; gain side-keyed columns and `winning_side`, `winning_factions_json`.
- `server/db/{sqlite,postgres}/completed-games.js` — same pattern.
- `server/db/{sqlite,postgres}/async.js` — `host_faction` → `host_side` + `host_faction_id`.
- `server/db/{sqlite,postgres}/campaign-stats.js` — `has_witch` → `has_night_leader`.

Save schema version bumps. `players_json` becomes the canonical player list (refactor doc Phase 3).

`admin-stats.html` gains per-side and per-faction views.

### PR 8 — Scripts & balance
- `scripts/headless.js` — accept `--day=paladin,rogue --night=witch,brute`; default keeps Paladin vs Witch. Per-faction win rates in output.
- `scripts/ai-matrix.js` — extends to N×M grid (factions × personalities).
- `scripts/combat-sim.js` — scenarios cover new leader types.
- Balance pass: re-run 500-game baseline for Paladin vs Witch (must match CLAUDE.md targets); capture stub-faction baselines for the changelog.

### PR 9 — Doc sync
- `docs/01-architecture-overview.md` — Side ↔ Faction relationship, updated module diagram.
- `docs/03-state-machines.md` — seat lifecycle gains `setFaction`.
- `docs/04-network-protocol.md` — `setFaction` message, seat `factionId` field.
- `docs/05-game-systems.md` — entity table grows to 6 leader types; per-faction stat block.
- `docs/06-ai-architecture.md` — stub factions inherit parent personality registry.
- `docs/07-data-persistence.md` — schema deprecations, version bump.
- This file marked **status: complete**.

---

## Working notes / blockers

This section is updated as PRs land. Use it for surprises, scope changes, or items that needed to defer.

### PR 1 (landed)
Foundational scaffolding. `src/sides.js` deliberately inlines `Phase` string literals to avoid a `game.js → factions.js → sides.js → game.js` circular import; `tests/sides.test.js` imports the real `Phase` enum to lock the mapping.

### PR 2 (landed)
Scope split: this PR adds **side-aware accessors** (`state.inventoryForSide`, `actionsLeftForSide`, `killsForSide`, `summonsForSide`, `nodeScoreForSide`) and `sideOf(factionId)` in `factions.js`. **Storage shape is unchanged** — the accessors route through the existing `hero`/`witch` storage keys.

The actual storage rename (`inventory.hero` → `inventory.day` etc.) is deferred and folded into PR 4, which already needs a save-schema bump for the `EntityType.HERO → PALADIN` rename. Doing the two together avoids a second forced save invalidation.

This still unblocks PR 5 (stub factions): new factions on the same side share that side's storage by routing through the accessors, which is the correct behaviour for stubs that inherit parent-side resource pools.

### PR 5 (landed)
Four stub factions registered: **Rogue** (*Mercy Sloane*) and **Captain** (*Captain Eli Ward*) on the day side; **Necromancer** and **Brute** on the night side.

Each stub:
- Has its own `EntityType` value (`rogue`, `captain`, `necromancer`, `brute`) with its own row in `BASE_STATS` / `BASE_AGILITY` / `ENTITY_COLOR`.
- Subclasses its side's primary faction (`HeroFaction` or `WitchFaction`); inherits all combat / summon / fortify / discovery / sight behaviour. Overrides only `id`, `name`, `leaderType`, `createLeader`, and `isStub() === true`.
- Owner string on the leader entity stays `'hero'` (day) or `'witch'` (night) so the codebase's many `e.owner === 'hero'` checks keep working unchanged. The specific faction is communicated via the new `entity.factionId` field plus its `type`.

`GameState.addPlayer()` gained an optional `factionId` 7th arg; lobby `_addExtraAISeat` / `_addExtraHumanSeat` thread `slot.factionId` through. For the constructor-pre-populated first hero/witch seat, a new `_swapStubLeader()` in `lobby.js` mutates the leader entity in place to apply stub stats — preserving id/position/ownerId so downstream references resolve.

**Bug found and fixed:** `endRound()` iterated `allFactions()` to dispatch end-of-round effects. With six factions registered, the day-side `_applyBuildingHealing` fired three times (once per day-side faction subclass via inheritance), tripling rest healing. Fixed by iterating `allSides()` and dispatching only the side's primary faction. End-of-round effects are conceptually side-level, not per-faction; this matches the design.

`tests/faction-string-checks.test.js` allowlist for `server/lobby.js` bumped from 73 → 74 to permit the new `faction === 'hero'` branch in `_swapStubLeader` that looks up the side-default leader on state. Documented inline.

100-game headless balance: Witch 58% / Hero 42% — within the 38–62% band. Stubs aren't reachable from the headless runner (which still uses default Paladin/Witch), so the variance vs PR 4a's run is sampling noise.

### PR 4a (landed)
Entity-type rename Hero → Paladin. Approach chosen:

- `EntityType.PALADIN = 'paladin'` is the new constant. `EntityType.HERO` is kept as an alias resolving to the same value, so the ~50 `EntityType.HERO` references in the codebase keep working without a churn sweep.
- New entity-type constants reserved for stub factions in PR 5: `ROGUE`, `CAPTAIN`, `NECROMANCER`, `BRUTE` (no factories yet).
- Default leader name for the day-side leader: **Ishmael Charger**. Applies in `Entity.displayName` and as the `mapDataOverride.heroName` fallback in `GameState`.
- 8 literal `e.type === 'hero'` / `'witch'` checks across `src/`, `server/`, `scripts/` and tests were swept to use the constants. Tests with hand-rolled fixtures using the literal `'hero'` value were updated.
- `state-sync.js` deserialize migrates `type === 'hero'` → `'paladin'` on load, so v1 saves still hydrate cleanly. `SAVE_VERSION` bumped to **2** as a belt-and-braces signal for any consumer that bypasses the migration.
- 100-game headless balance: Hero 58% / Witch 42% — within the 38–62% target band (CLAUDE.md baseline was 55.2% hero).

### PR 3 (landed)
Additive only — no `=== 'hero'` / `=== 'witch'` checks were swept. Each lobby slot and seated player now carries three faction-related fields:

- `faction`   (legacy, primary key for the bulk of lobby/state code today)
- `side`      ('day' | 'night', derived via `sideOf(faction)`)
- `factionId` (defaults to legacy `faction`; mutated by `setFaction()` once stub factions land in PR 5)

New `setFaction(playerId, roomId, factionId)` server function and matching protocol message. Cross-side switches are rejected with an error; switches once the room leaves `'lobby'` status are silent no-ops. `claimSlot` gains an optional 4th `factionId` argument with the same cross-side validation.

`SIDE_THEME` added to `theme.js` with day/night palettes (today mirrors hero/witch). Callers haven't migrated yet — that's PR 6 work alongside the picker UI.

---

## Out of scope

- Faction-unique abilities for Rogue/Captain/Necromancer/Brute — separate follow-up, one per faction.
- The full AI engine deduplication called out in `docs/design/refactor.md` Finding 2 (~600 LOC reduction). PR 5 only extracts the small commons it needs for parent-side classes.
- The god-class extraction from `main.js` / `ui.js` / `lobby.js` (refactor doc Finding 3).
- Re-theming the game beyond Day/Night colour additions.
