---
name: parity-check
description: Audit the current diff for the repo's silent-failure parity rules — new state fields missing from state-sync serialization, SQLite/Postgres db changes not landed in pairs, and offline (main.js) orchestration changes not mirrored online (lobby.js)
---

# Parity Audit

Brimstone has three parity rules (CLAUDE.md Guidelines 5 & 6) whose violations
do NOT fail `npm test` — they silently break online mode or the Postgres
backend in production. This skill audits the working diff for all three.

Get the diff first: `git diff dev...HEAD --stat` (or `git diff HEAD` for
uncommitted work), then apply each check below to the touched files.

## Check 1 — state-sync serialization

**Trigger:** the diff adds a field to `GameState`, `Entity`, or `Tile`
(look for new `this.<field> =` assignments in `src/game.js`,
`src/entities.js`, `src/tiles.js`, or new fields written by `src/actions.js`).

**Rule:** every persistent field must be added to `serializeState()` AND
restored in `deserializeState()` in `server/state-sync.js`, or online games
and save/resume silently drop it.

For each new field:
1. `grep -n "<field>" server/state-sync.js` — it must appear in both the
   serialize and deserialize halves (`deserializeState` starts around line 242).
2. Tile fields are a hand-written allowlist guarded by
   `tests/state-sync-schema-guard.test.js` — new tile fields must be added to
   the guard's allowlist too.
3. Run `node --test tests/state-sync*.test.js` to confirm.

Fields that are genuinely derived/transient (getters, render caches) are
exempt — but say so explicitly in the audit output rather than skipping
silently.

## Check 2 — SQLite ↔ Postgres pairing

**Trigger:** the diff touches anything under `server/db/sqlite/` or
`server/db/postgres/`.

**Rule:** the two backends are intentionally duplicated; a change to
`server/db/sqlite/<domain>.js` must land with the matching change to
`server/db/postgres/<domain>.js` in the SAME commit (and vice versa).

1. List touched files in each dir; flag any domain file changed on one side
   only. (Exception: changes commented as genuinely SQLite-only, e.g. legacy
   migration blocks — verify the comment exists.)
2. Schema changes go through `server/db/schema.js` (SQLite DDL is the source
   of truth; Postgres DDL is derived). Direct DDL edits elsewhere are a flag.
3. Remind about dialect traps when reviewing the Postgres side: `$1`
   placeholders, `EXTRACT(EPOCH FROM NOW())::BIGINT`, `CITEXT` not
   `COLLATE NOCASE`, `GREATEST()` not scalar `MAX()`, `RETURNING 1` where
   `.changes` is read.
4. Tests:
   ```bash
   npm test                                                          # SQLite
   PG_TEST_URL=postgresql://… node --test tests/db-postgres.test.js  # Postgres (skipped if unset)
   ```
   If `PG_TEST_URL` is not available in this environment, state that the
   Postgres suite was NOT run — don't imply it passed.

## Check 3 — offline/online orchestration mirroring

**Trigger:** the diff changes game-flow orchestration in `src/main.js`
(local resolution loop, planning flow, AI wiring, round lifecycle).

**Rule:** `src/main.js` (offline) and `server/lobby.js` (online) are parallel
orchestration layers. Rule changes in shared code (`actions.js`, `game.js`,
`entities.js`, `planner.js`, `server/resolver.js`, `ai.js`) apply to both
automatically — but changes to the orchestration itself must be applied to
both files.

1. For each orchestration change in `main.js`, find the corresponding code
   path in `lobby.js` (or vice versa) and confirm it was updated or is
   genuinely N/A (e.g. purely-local UI concerns).
2. After parity-sensitive changes, run:
   ```bash
   node scripts/headless.js 100 standard --players 2
   ```

## Output

Report one verdict per check: **PASS**, **N/A** (with the reason), or
**FAIL** with the exact missing counterpart (file + what to add). A FAIL on
any check means do not push until fixed.
