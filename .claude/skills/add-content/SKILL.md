---
name: add-content
description: Add game content — survivor, weapon, ability, unit type, faction, or campaign mission — following the data-driven recipes in docs/08, with the right registration, validation, and difficulty checks per type
argument-hint: [survivor|weapon|ability|unit-type|faction|mission]
---

# Adding Content

Content additions are data-driven and usually one-file edits. The per-type
recipes live in **`docs/08-content-authoring.md`** — read the relevant
section first, then follow the checklist below. If your change needs edits to
`src/actions.js`, `server/resolver.js`, or `server/state-sync.js`, stop:
either the content type isn't as data-driven as assumed or the approach is
wrong — re-read the doc before proceeding.

## Where each type lives

| Type | Primary file | Doc section |
|------|--------------|-------------|
| Survivor | `src/content/` roster | "New survivor" |
| Weapon | `src/items.js` (+ `src/loot.config.js` for drop weighting) | "New weapon" |
| Ability | `src/abilities.js` | "New ability" |
| Unit type | `src/unit-types.js` (+ rig cascade for a 3D model) | "New unit type" |
| Faction | `src/factions.js` | "New faction" |
| Mission | `src/campaign/missions/*.json` + registry | "New mission (JSON)" |

## Universal checklist

1. Read the matching `docs/08-content-authoring.md` section and follow its
   recipe exactly — it covers fields, icons, and gotchas per type.
2. Player-facing strings: **no color emoji** — use `ICON.<name>` from
   `src/icons.js` (see the `add-icon` skill if a new glyph is needed).
3. Write tests for any new logic (Guideline 1); pure data rows piggyback on
   the existing table-driven tests — run them to confirm the new row is picked
   up.
4. `npm test` and `npm run validate` before pushing.
5. If the content changes combat math or drop rates (new weapon stats, unit
   stats, loot weights), run the **`balance-check`** skill.

## Mission-specific rules

- Missions are authored in the Mission Editor (`/admin/tools`, or Caleb's
  Studio) — **never hand-write tile arrays**. Save writes round-trip-faithful
  JSON into `src/campaign/missions/`.
- Register the mission in `src/campaign/campaign-registry.js`; gate it with
  `requires` (legacy) and/or `unlock` (rich AND/OR/NOT criteria).
- New scripted logic should use the mission logic graph (`logic` block,
  `docs/09-mission-logic-graph.md`) — respect its four invariants (sealed
  resolution, authority-side graph, Sim/Show split, interactivity as a plan
  action). Legacy fields (`storyTriggers`, `waves`, `objectives.win/lose`)
  remain live for shipped missions; don't half-migrate one.
- Gauge difficulty with the AI conductor:
  ```bash
  node scripts/headless-campaign.js <missionId> 20
  ```
  A mission the AI wins ~0% or ~100% of the time needs tuning
  (`aiBudgetBonus` is the dial for dynamic witch difficulty).
- Conversations: authored as `.md` (see doc §"Conversations"); new or edited
  voiced lines require the **`voiceover-regen`** skill.

## Unit-type 3D models

A new unit type without a model falls back to an existing rig. Giving it a
real model is the "rig cascade" in doc §"New unit type" —
`scripts/check-rig.js` (`npm run validate:rigs`) validates the result.
