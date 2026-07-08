---
name: pre-push
description: Run the full pre-push gate for the current diff — tests, then conditionally the visual, balance, parity, and docs checks that CLAUDE.md Guidelines 1–8 require for the kinds of files touched
user-invocable: true
---

# Pre-Push Gate

Walk CLAUDE.md's guidelines as an actual checklist against the current diff.
Each gate is conditional on what the diff touches — decide from
`git diff dev...HEAD --stat` (or `git diff HEAD --stat` for uncommitted
work), run what applies, skip what doesn't, and say which gates were skipped
and why.

## 1. Tests — always

```bash
npm test
```

Also `npm run test:ui` if the diff touches `src/ui*.js`, `index.html`,
`tests/ui/`, or overlay/HUD behavior. Do not push on red; if a pre-existing
test broke, fix it — never skip or delete it. New logic in the diff with no
accompanying test is itself a gate failure (Guideline 1), except for
visual-only changes.

## 2. Visual verification — if the diff is visual work

Trigger: any change to `src/renderer-3d.js`, `src/renderer.js`, `src/ui*.js`,
replay/conversation presentation, `styles.css`, or `index.html`.

→ Invoke the **`verifier-browser`** skill: run the real game headless,
capture before/after screenshots, and actually read them.

## 3. Balance validation — if the diff touches gameplay

Trigger: combat, actions, phase effects, entity stats, AI, loot, or map
generation (`src/actions.js`, `src/entities.js`, `src/game.js`,
`src/unit-types.js`, `src/items.js`, `src/loot.config.js`, `src/map.js`,
`src/ai*.js`, `src/hero-ai-engine.js`, `server/resolver.js`).

→ Invoke the **`balance-check`** skill and put its summary in the commit
message.

## 4. Parity audit — if the diff touches state, db, or orchestration

Trigger: new fields on GameState/Entity/Tile; anything under `server/db/`;
orchestration changes in `src/main.js` or `server/lobby.js`.

→ Invoke the **`parity-check`** skill (state-sync serialization,
SQLite↔Postgres pairing, offline↔online mirroring).

## 5. Emoji guard — if the diff adds player-facing strings

`node --test tests/no-ui-emoji.test.js`. Any new color emoji in UI strings
must be converted to `ICON.<name>` (see the `add-icon` skill).

## 6. Docs currency — if the diff changes structure

Update the matching `docs/` file when the diff: adds/removes modules (→ 02),
changes state-machine transitions (→ 03), adds WebSocket message types
(→ 04), modifies the DB schema (→ 07), changes AI goals/pipeline (→ 06), or
adds entity/action types (→ 05). Bug fixes, tuning constants, and CSS need no
doc updates.

## 7. Voiceover freshness — if the diff edits voiced text

Tutorial/hint bodies or conversation `.md` changed → the voice manifest is
stale; invoke the **`voiceover-regen`** skill (the tutorial test will fail
on a stale manifest anyway, but regeneration needs a TTS API key, so flag it
early).

## Output

A short table: each gate → **PASS** / **SKIPPED (reason)** / **FAIL (what to
fix)**. Only after every applicable gate passes: push with
`git push -u origin <branch>`.
