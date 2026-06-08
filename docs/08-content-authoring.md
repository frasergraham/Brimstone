# Content Authoring — How to Add Content

The units/items/abilities refactor (Phases 1–6, landed in PR #294) made content additions data-driven. For common content additions, the following one-file (or near-one-file) edits are sufficient — `src/actions.js`, `server/resolver.js`, and `server/state-sync.js` should not need touches.

## New survivor

Append an entry to `SURVIVOR_ROSTER` in `src/content/survivors.js`:

```js
{
  name: 'Eliza Stone',
  title: 'Mason',
  bio: 'Cut stone blocks by hand until the world ended.',
  maxHp: 5, attack: 2, defense: 2,
  ability: SurvivorAbility.FORTIFY_DOUBLE,
  abilityLabel: 'Mason — fortifies a building to full strength with just Wood',
},
```

Optionally add a colour slot to `SURVIVOR_COLORS` above. Base stats are **pre-passive** — if the survivor has `BRAWLER` (+1 ATK) or `STURDY` (+1 DEF), write the un-baked number; `getAttack()` / `getDefense()` compose the passive at call time via `ABILITIES[id].statMods`.

## New weapon

Append an entry to `ITEMS` in `src/items.js`:

```js
spear: {
  id: 'spear',
  kind: 'weapon',
  slot: 'weapon',
  statMods: { attack: 1, defense: 1 },
  label: '🗡 Spear (+1 ATK, +1 DEF)',
  // optional conditional bonus via combatTriggers:
  combatTriggers: [
    { when: 'attack', ifDefenderHasAnyTag: ['construct'], advantage: 1 },
  ],
},
```

Add the id to any loot tables in `src/loot.config.js` that should roll it.

## New ability

Append an entry to `ABILITIES` in `src/abilities.js`:

- **Passive with stat bonus:** `{ id, kind: 'passive', label, description, statMods: { attack: 1 } }` — composed automatically by `Entity.getAttack()` / `getDefense()`.
- **Active:** `{ id, kind: 'active', label, description, validate(state, actor), execute(state, actor) }` — `validate` is called by `_buildAbilityActions` to decide whether the button shows; `execute` runs when the plan step resolves and returns `{ success, log, cost, budgetBonus? }`.

Then reference the id from a roster entry's `ability:` field (or push it onto a faction's `innateLeaderAbilities` for leader-only abilities).

## New unit type

1. Add the `EntityType` constant in `src/entities.js`.
2. Add a `UNIT_TYPES[key]` entry in `src/unit-types.js` with `baseStats`, `agility`, `color`, `tags`. Tags drive combat triggers (e.g. staff-vs-undead) and AI filtering — pick from `['living', 'leader', 'day-leader', 'night-leader', 'undead', 'minion', 'construct', 'summoned', 'soldier', ...]` or add a new one.
3. Add a factory wrapper in `src/entities.js`:
   ```js
   export function createSoldier(col, row, ownerId = null, state = null) {
     return new Entity(EntityType.SOLDIER, 'hero', col, row, ownerId, state);
   }
   ```
4. Add a glyph entry to the three `GLYPHS` maps in `src/ui.js` and the `entityGlyph` switch in `src/renderer.js`.

Combat, pathfinding, serialization, and plan-action validation flow through the generic machinery — no action/resolver/state-sync edits needed.

### Giving a unit type a 3D model (rig cascade)

The 3D renderer resolves each unit's mesh by convention — **no renderer edits**:

1. `assets/models/<type>-idle.glb` — if present it's loaded as that type's rig (e.g. `zombie-idle.glb` for `EntityType.ZOMBIE`). Must be a Mixamo-rigged glb whose bones are named `mixamorig:*` so the shared walk/run/attack clip bank retargets onto it.
2. Otherwise the unit clones the shared **`mannequin-idle.glb`** — a blank humanoid the renderer tints to the owner's player colour.
3. If neither loads, the cone+sphere **pawn** stands in.

`EntityType.PALADIN` (the hero) keeps its dedicated `paladin-idle.glb` path (the only rig wired for walk/run/punch today); other rigs play their embedded idle. To add a character rig, drop the source FBX in `assets/source/characters/` and run `node scripts/convert-character-fbx.js` (see that script for texture-strip vs. -cap options). Cascade logic + tint live in `src/renderer-3d.js` (`fallbackRigCandidates`, `_loadFallbackRig`, `_buildRigClone`).

## New faction

Subclass `HeroFaction` or `WitchFaction` in `src/factions.js`, override `id` / `name` / `leaderType` / `_buildLeader`, register in the `FACTIONS` map, and add a leader factory in `src/entities.js`. If the faction has unique leader abilities, override `innateLeaderAbilities` to return the parent list plus the new ids — `Faction.createLeader()` pushes them onto the entity automatically. See `RogueFaction` / `CaptainFaction` in `factions.js` for the minimal stub pattern.

## New mission (JSON)

Campaign missions are **data-driven JSON** under `src/campaign/missions/*.json` (`schema: 1`). The format is **offline/campaign-only** — there is no server path and no online parity to keep (don't touch `server/`). Author missions in the **Mission Editor**, not by hand-writing tiles.

**Author via the editor** at `/admin/tools` (start the dev server, then the **Mission Editor** tab):
- Paint the map: terrain, buildings, resources, hidden survivors; place hero/witch starts and Power Nodes; place enemy units.
- Each building is a **two-hex compound** — a passable entrance (carries the `building`, loot, fortify, hidden-survivor, `roadDirs`) plus one impassable, sight-blocking **footprint** hex that holds the rendered model. Placing a building auto-claims an eligible adjacent footprint (`footprintHexes` on the entrance → a non-resource, non-road, non-river, in-bounds neighbour that back-points via `buildingFootprintOf`). Press **R** to rotate the footprint through the other eligible neighbours (hovered building, else last-placed). See `docs/05-game-systems.md` → "Building Footprints".
- Set extra road-node waypoints, then **Regenerate Roads** — roads (`ROAD`/`BRIDGE` + `roadDirs`) are *derived* from the road-node set (buildings & bridges are implicit nodes). On a handmade map the editor snapshots the derived `roadDirs` back into the tiles (no load-time regen).
- Author story triggers (round# or area hexes, with an optional `condition` from the registry), waves, objectives, briefing/victory/defeat text, phaseCycle, resources/rewards via the forms.
- **Preview in 3D** (hands the built `GameState` to `Renderer3D`), then **download** the JSON.

**Schema & loader:** see `src/campaign/missions/Ch1M6.json` for the canonical example, `docs/design/campaign-mission-editor.md` for the full spec, and `docs/07-data-persistence.md` → "JSON Mission Format". The `map` sub-object (`mode: "handmade"` | `"procedural"`) is built by `buildMissionMap` (`src/campaign/mission-map.js`); everything else mirrors the runtime mission shape verbatim.

**Two fields are string keys, not data:**
- `storyTriggers[].condition` → a named predicate in `src/campaign/condition-registry.js` (`CONDITIONS`). Add a new condition there (`(state) => boolean`, no mutation) before referencing it.
- `conductor.scriptKey` → `{ steps, config }` in `src/campaign/conductor-scripts.js` (e.g. `"tutorial"`, whose imperative scripting stays in `src/tutorial/tutorial-config.js` — the registry only aggregates it).

**Validation:** the editor runs the assembled JSON through `loadMissionJSON` / `validateMissionJSON` before download. The four hardening checks: (1) tiles in-bounds, (2) `objectives.win`/`lose` types in `KNOWN_OBJECTIVE_TYPES` (mirrors the 17-case switch in `buildVictoryDelegate`, `src/campaign/campaign.js`), (3) handmade maps define their starts, (4) `map.roadSeed` carried verbatim for regen determinism. The editor *also* runs the save-time `validateBuildingFootprints` (separate from the runtime checks, kept out of `validateMissionJSON` for backward compat) — it rejects any building with an empty `footprintHexes` or a footprint whose `buildingFootprintOf` doesn't back-point to its entrance (broken pair).

**Register it:** add the mission's `{ id, campaignId, title, file }` to `MIGRATED_MISSIONS` in `src/campaign/mission-catalog.js` and drop the file in `src/campaign/missions/` as `<file>.json` (bundled missions use the `ChXMY` naming, e.g. `Ch1M6.json`; the mission `id` inside the JSON stays stable since saves/stats reference it). It's loaded at module init (node via `fs`, browser via same-origin `fetch`) under a top-level `await`, so importers see a populated registry.

**Difficulty check:** run `node scripts/headless-campaign.js <missionId> 50` to AI-play the mission and estimate win rates before shipping it.

> **Admin tooling:** `/admin/tools` (`admin-tools.html`) is the unified **Caleb's Hollow Tools** page — **Assets** (Babylon 3D model browser) | **Lighting** (Renderer3D tuner) | **Mission Editor** tabs, each lazy-initialised on first activation.
