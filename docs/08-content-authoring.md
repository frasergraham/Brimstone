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
  category: 'melee',          // 'melee' | 'ranged' — gates Faction.canEquipWeaponItem
  statMods: { attack: 1, defense: 1 },
  label: '🗡 Spear (+1 ATK, +1 DEF)',
  // optional conditional bonus via combatTriggers:
  combatTriggers: [
    { when: 'attack', ifDefenderHasAnyTag: ['construct'], advantage: 1 },
  ],
},
```

Optional weapon fields:
- `damage: { count, sides, flat }` (or a plain number for fixed damage) — per-hit damage rolled each attack; tier × this roll (hit 1×, crush 2×, great crush 3×). Omit to inherit `DEFAULT_ATTACK_DAMAGE` (2D6). Anchor means near `DAMAGE_SCALE` (~7); premiums sit ~10–11. Rolled via `getWeaponDamage`/`rollDamage` — see docs/05.
- `range: N` — grants the wielder attack range N (default 1 = melee). **Range is weapon-derived** — units have no innate range, so a `range`-bearing weapon turns *any* equip-capable wielder into a ranged attacker (`Entity.getRange()`). Ranged attacks use a distinct rule set (no gang-up, no counter, forest cover, range falloff) — see docs/05.
- `projectileType: 'bolt' | 'sparkle'` — replay animation for ranged shots.
- `wielderFactions: ['witch','necromancer']` — restrict equipping to those faction ids (Magic Bolt). Omit for an unrestricted weapon.
- `noLoot: true` — exclude from loot (issued as starting gear only); don't add it to any loot table.

Add the id to any loot tables in `src/loot.config.js` that should roll it (skip for `noLoot` weapons). To make a faction leader **start** with the weapon, override `get innateLeaderWeapon()` on the `Faction` subclass in `src/factions.js`.

**Premium / late-game tier.** To gate a strong weapon so it only drops later, add it to a loot table at low weight *and* add `weaponId: minRound` to `LOOT_TIER_GATE` in `src/loot.config.js`. `_effectiveLoot` (`src/actions.js`) filters gated entries out until `state.round` reaches the threshold. A mission can still force one in early via a full-table `lootOverrides` entry (that path bypasses the gate).

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

**Custom-upload characters (Scenario → Blender → Mixamo):** a custom mesh that round-trips through Mixamo picks up a cm/m unit mismatch that FBX2glTF bakes into a ×100 scale node (it has no unit flag), so it FAILs `check-rig.js` on scale. Convert those through **Blender** instead, which bakes scale + axis correctly across the skin: `Blender --background --python scripts/fbx-to-glb-blender.py -- <in.fbx> <out.glb>`, then re-apply the skin PNG (Mixamo drops textures on re-rig) and `check-rig.js` it. Stock Mixamo-library characters (mannequin/zombie) don't hit this and convert cleanly via `convert-character-fbx.js`.

**Validate a rig before adding it:** `npm run validate:rigs` (or `node scripts/check-rig.js <file>`) checks every character `.glb` in `assets/models/` against the Mixamo-standard convention — ×1 scale (no compensation node), feet at Y=0, Hips at standing height, `mixamorig:` bone names — and reports PASS/WARN/FAIL with the metric that's off. The converter runs it automatically after each conversion. A model that FAILs still renders (the renderer normalises per-rig), but off-convention exports force fudging and tend to pop/float/sink as animations play — fix the export, don't special-case the code.

Cascade rigs play their embedded **idle** and **walk** (the shared `walking.glb` clip retargets onto each rig by bone name, swapping in while the unit is mid-move); run/punch stay paladin-only for now. `EntityType.PALADIN` (the hero) keeps its dedicated `paladin-idle.glb` path. To add a character rig, drop the source FBX in `assets/source/characters/` and run `node scripts/convert-character-fbx.js` (see that script for texture-strip vs. -cap options) — it also normalises Mixamo bone names so the clip bank retargets cleanly. Cascade logic + tint + walk retarget live in `src/renderer-3d.js` (`fallbackRigCandidates`, `_loadFallbackRig`, `_buildRigClone`, `_retargetWalkOntoRig`, `_maybeToggleFallbackRigAnimation`).

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

### Procedural "vs AI" missions (no authored map)

A mission can be a **plain skirmish vs the witch AI** — no painted tiles, no logic graph — defined purely by a seeded procedural map plus the standard victory. The map sub-object carries `mode: "procedural"` with `seed` (fixed for a reproducible map, or omit for random), `mapSize`, and `nodeCount`; `buildMissionMap` calls `generateMap(seed, mapSize, nodeCount)` and the GameState spins up exactly like a Human-vs-AI game. Wire the standard victory through the delegate and set the points goal with `nodeScoreThreshold`:

```json
{
  "schema": 1, "id": "village_marsh_end", "hasWitch": true,
  "aiPersonality": "balanced", "nodeScoreThreshold": 3,
  "map": { "mode": "procedural", "seed": 31001, "mapSize": "skirmish", "nodeCount": 2 },
  "objectives": {
    "win":  [ { "type": "slay_witch" }, { "type": "control_nodes" } ],
    "lose": [ { "type": "hero_killed" }, { "type": "witch_score_threshold", "points": 3 } ]
  }
}
```

`control_nodes` returns the `DEFERRED` sentinel from the delegate, so the built-in node-score victory (first to `nodeScoreThreshold`) and leader-death win run normally — the objectives just make "slay the witch OR win on points" explicit. Keep scoring **on** (`disableScoring` omitted/false). The five Chapter-1 villages (`Ch1V1`–`Ch1V5`) are the worked examples; pick seeds whose Power-node clusters are triangles (the `tests/campaign-missions-567.test.js` invariant) — some seeds place a linear cluster near a border.

### Dynamic witch difficulty (`aiBudgetBonus`)

`aiBudgetBonus` (extra witch actions/turn) is normally a static integer, but it may instead be a rule that scales with campaign progress, resolved at mission launch by `effectiveAiBudgetBonus(missionDef, campaign)` (`src/campaign/campaign.js`):

```json
"aiBudgetBonus": { "type": "missing_wins", "of": ["village_marsh_end", "..."], "target": 5 }
```

→ bonus = `max(0, target − (wins among "of"))`. The Long Watch (`Ch1M6`) uses this: it unlocks on a `{ "unlock": { "anyOf": { "count": 3, "of": [villages] } } }` gate (win any 3 of the 5 — `completedMissions` tracks **wins only**), and the witch's bonus eases the more villages were cleared (3 won → +2, 4 → +1, 5 → +0). `unlock` is AND-ed with the legacy `requires`; see `src/campaign/unlock.js` for the full criteria grammar.

### Shelving a mission (`disabled`)

To take a mission out of play **without deleting its JSON**, set `"disabled": true` at the top level of the mission file. A disabled mission is COMPLETELY ignored by game logic — it never appears as a playable/next mission, it's skipped by progression (excluded from `getMissionCount`/`getCompletedCount`/`isComplete` totals), and any `requires`/`unlock`/`anyOf` dependency that points at it is treated as **already satisfied** (so downstream missions still unlock and the chain never soft-locks). If the campaign's `firstMission` is the disabled one, a fresh campaign opens on the first *playable* mission instead. The campaign viewer still **lists** the mission, greyed and non-selectable, so the shelving is visible rather than a silent gap. All gameplay enumeration funnels through `Campaign.playableMissions()` (`src/campaign/campaign.js`); the viewer reads the full `getMissionList()` (each row carries a `disabled` flag). The current shipped example is `tutorial.json` (Mission 0).

**Enemy unit levels (difficulty ramp):** any `enemyUnits[]` or `waves[].units[]`
spec accepts an optional `"level": N` (integer ≥1). At spawn, `applyLevel` scales
the unit's HP/ATK/DEF by the Standard curve (HP ×(1+0.5·(L−1)), +1 ATK/level,
+1 DEF every 2 levels) — e.g. `{ "type": "zombie", "level": 3, ... }` is a 28-HP
atk4/def1 "Zombie L3". Levels do **not** change weapon damage. Explicit
`overrides` (e.g. a fixed `maxHp`) still win over the level scaling, and apply on
top of it. Use levels to ramp difficulty without new unit types; use `overrides`
for one-off tweaks (e.g. a deliberately *weakened* tutorial enemy).

**Three fields are string keys, not data:**
- `storyTriggers[].condition` → a named predicate in `src/campaign/condition-registry.js` (`CONDITIONS`). Add a new condition there (`(state) => boolean`, no mutation) before referencing it.
- `conductor.scriptKey` → `{ steps, config }` in `src/campaign/conductor-scripts.js` (e.g. `"tutorial"`, whose imperative scripting stays in `src/tutorial/tutorial-config.js` — the registry only aggregates it). A conductor *owns* the mission: scripted opponent plans, forced dice, gated progression, completion = victory.
- `hints.scriptKey` → micro-lesson hints resolved through the same registry (scripts live in `src/campaign/hint-scripts.js`). See "Micro-lesson hints" below.

### Micro-lesson hints (teaching inside a normal mission)

Chapter 1 missions teach one or two mechanics each (fortify, equip, gang-up, node bonus…) via **hint scripts** — `MissionConductor` running in `'hints'` mode. Unlike a conducted mission, the mission stays fully AI-driven (waves, story triggers, saves, objectives all work normally); hints are one-shot tooltips that never block the map or the submit button.

To add hints to a mission:
1. Define `{ steps, config }` in `src/campaign/hint-scripts.js` and register the key in its `HINT_SCRIPTS` export (aggregated into `CONDUCTOR_SCRIPTS`). `config.mode` must be `'hints'`.
2. Reference it from the mission JSON: `"hints": { "scriptKey": "ch1m3" }`.
3. Anchor each step either by round (`config.roundStepMap[round]`, keyed by `state.round`, 1 = first planning round) or by a `when: (state) => boolean` predicate for loot/state-dependent lessons (e.g. "a pack weapon exists" → equip lesson). Each hint fires at most once per mission attempt.
4. Step shape matches the tutorial (`tutorial-config.js` documents every field). Gated steps (`action_queued` / `entity_selected` triggers, optionally narrowed by `entityType`) dismiss when the action happens or when the plan is submitted; `click` steps show a "Got it" button.

Rules enforced by the step lint in `tests/tutorial.test.js`: bodies ≤230 chars (teach by doing, not reading), blocking `click`/`complete` dialogs centered, every action-gated tutorial step carries a spotlight `arrow` (the direction the arrow *points*; it sits opposite, aimed at the target), element selectors must exist in `index.html`.

Hints are suppressed after the mission is completed or the player clicks "Skip hints" (localStorage, `markHintsSeen`/`areHintsSuppressed` in `src/mission-conductor.js`) — replays stay clean.

**Voiceover:** steps are narrated from `assets/voice/<scriptKey>/<stepId>.mp3` when present (config `voiceKey` names the directory), in the `narrator` voice. See "Voiceover (narration audio)" below for the shared generator/registry/mute used by tutorial steps *and* conversation lines.

**Validation:** the editor runs the assembled JSON through `loadMissionJSON` / `validateMissionJSON` before download. The four hardening checks: (1) tiles in-bounds, (2) `objectives.win`/`lose` types in `KNOWN_OBJECTIVE_TYPES` (mirrors the 17-case switch in `buildVictoryDelegate`, `src/campaign/campaign.js`), (3) handmade maps define their starts, (4) `map.roadSeed` carried verbatim for regen determinism. The editor *also* runs the save-time `validateBuildingFootprints` (separate from the runtime checks, kept out of `validateMissionJSON` for backward compat) — it rejects any building with an empty `footprintHexes` or a footprint whose `buildingFootprintOf` doesn't back-point to its entrance (broken pair).

**Register it:** add the mission's `{ id, campaignId, title, file }` to `MIGRATED_MISSIONS` in `src/campaign/mission-catalog.js` and drop the file in `src/campaign/missions/` as `<file>.json` (bundled missions use the `ChXMY` naming, e.g. `Ch1M6.json`; the mission `id` inside the JSON stays stable since saves/stats reference it). It's loaded at module init (node via `fs`, browser via same-origin `fetch`) under a top-level `await`, so importers see a populated registry.

**Difficulty check:** run `node scripts/headless-campaign.js <missionId> 50` to AI-play the mission and estimate win rates before shipping it.

**Mission map image:** the menu shows a top-down board image on each mission card — the live saved thumbnail when a mission is in progress, else a fixed pre-generated image committed under `assets/mission-maps/<file>.jpg` (keyed by the mission's `file` basename, resolved by `fixedMissionImage()` in `mission-catalog.js`). Generate (or regenerate after a map change) with `node scripts/gen-mission-thumbnails.mjs` (all missions) or `node scripts/gen-mission-thumbnails.mjs <missionId>` (one) — it drives the real 3D renderer in headless Chromium and captures via the same `captureMapThumbnail()` path the in-game thumbnails use (needs the global Playwright/Chromium from the `verifier-browser` skill). Commit the generated `.jpg` alongside the mission JSON.

## Conversations (campaign cutscenes)

A conversation is an in-world dialog between two bound characters, presented through the replay machinery: the camera frames the participants (in FIXED camera mode it stays put — billboard bubbles still render in-world, with an edge arrow when off-screen), dialog appears as speech-bubble billboards above the speakers, a 💬 turn card joins the replay timeline (SKIP while playing → REPLAY when done, plus a **CONTINUE** button on round-boundary/intro conversations that dismisses the card and opens planning), and the replay **NEXT** button steps dialog lines. Intro conversations present as a "turn 0 resolution" — planning chrome is hidden (`ui.exitPlanningMode`) and the app holds in RESOLVING until CONTINUE.

**1. Write the markdown** in `src/campaign/conversations/<file>.md` (hand-authored — the editor only references the file id). Format (`src/campaign/conversation-parser.js`):

```markdown
---
id: ch1m1-intro
title: A Voice at the Inn Door
roles: hero, innkeeper
---

# comments and blank lines are ignored
hero: [cheerful] Dialog text. Indented or un-prefixed lines
  continue the previous line.
innkeeper: A reply.
```

Roles are **slots** — the mission binds them to live entities at trigger time. The on-screen speaker **name** comes from the bound entity (roster name → title → type), not the role — so naming the hero "Ishmael" or an NPC "Innkeeper" is done on the entity, not in the markdown.

**Emotion & delivery — inline audio tags.** Square-bracket cues like `[cheerful]`, `[sighs]`, `[whispers]`, `[cautious]`, `[sorrowful]`, `[surprised]` are **ElevenLabs v3 audio tags**: they steer the generated narration's tone moment-to-moment (placed anywhere, even mid-line) and are **stripped from the displayed text** by the parser (kept as the line's `ttsText` for the generator only). Most reliable are recognised cues — emotions (`[sad]`, `[angry]`, `[excited]`, `[sarcastic]`, `[curious]`), non-verbals (`[laughs]`, `[sighs]`, `[clears throat]`, `[scoffs]`), and delivery (`[whispers]`, `[shouts]`, `[slowly]`); free-form directions work but less consistently, and a tag only lands if the voice can plausibly do it (a calm voice won't `[shout]`). Punctuation still matters — `…` adds a beat, CAPS adds emphasis. Tags only reach v3-backed clips: **conversation lines** generate on `eleven_v3`, while narrator/hint **steps** stay on `eleven_multilingual_v2` (tags there are stripped, never spoken).

**2. Declare it in the mission JSON** (all validated by `validateMissionJSON`):

```json
"npcs": [{ "id": "innkeeper_john", "survivorName": "John O'Connor", "displayTitle": "Innkeeper", "col": 3, "row": 6 }],
"conversations": [{
  "id": "ch1m1_intro", "file": "ch1m1-intro",
  "bindings": { "hero": "hero", "innkeeper": "npc:innkeeper_john" },
  "onComplete": [
    { "action": "move", "npc": "innkeeper_john", "path": [{"col": 2, "row": 5}] },
    { "action": "despawn", "npc": "innkeeper_john" }
  ]
}],
"storyTriggers": [{ "type": "round", "round": 1, "conversation": "ch1m1_intro" }]
```

- **Bindings grammar** (`src/campaign/conversation-registry.js`): `"hero"` (the leader), `"npc:<npcId>"` (a scripted NPC from `npcs[]`), `"survivor:<Name>"` (a live roster survivor by name). If any role can't be bound at trigger time (e.g. the NPC died), the conversation is skipped with a console warning.
- **Triggers** reuse the storyTrigger gating (`round`/`area`/`condition`). A trigger carries either a `conversation` id **or** `title`/`text` — never both. Round-boundary conversations play before planning opens; **area triggers interleave mid-replay** at the exact resolution step they're satisfied, inserting their card into the live timeline.
- **Dedup:** a conversation trigger **without** a `flag` replays on every mission attempt (per-attempt `state._firedConversations`); add a `flag` to make it once-per-campaign via `storyFlags`.

**Scripted NPC actions** (`src/campaign/scripted-actions.js`) drive cutscene behavior — usable in a conversation's `onComplete` list, run sequentially:

| Action | Fields | Effect |
|--------|--------|--------|
| `spawn` | `npc`, `col`, `row` | Create the NPC (def from `npcs[]`) at a hex |
| `move` | `npc`, `path: [{col,row},…]` | Walk the NPC along the path (animated) |
| `despawn` | `npc` | Remove the NPC from the map |
| `wait` | `ms` | Pause between actions |

Scripted NPCs (`npcs[]`) spawn at mission init as hero-owned survivors tagged `isNpc` — view-only in game (not plannable, never join the roster, excluded from survivor-count objectives), and the tag survives save/resume via state-sync. Playback orchestration lives in `src/conversation-player.js`.

The Mission Editor's Timeline tab has an **NPCs & Conversations** lane for the JSON side (NPC defs, conversation defs, and a Conversation select on trigger cards); the markdown itself stays hand-authored.

## Voiceover (narration audio)

One generator narrates both tutorial/hint **steps** and conversation **lines**:

- **Voices** live in `src/campaign/voices.js` — each entry pairs a TTS timbre (`openaiVoice` / `elevenVoiceId`) with a **`description` prompt** that shapes delivery (passed to OpenAI as `instructions`). The description is the tracked source of truth: it's folded into each clip's manifest hash, so editing a voice or its prompt regenerates exactly the clips that use it. Conversation lines pick a voice by **role name** (`hero`, `innkeeper`, `witch`, …, else `default`); steps use `narrator`. Give a role its own voice by adding a same-named entry to `VOICES`.
- **Clips:** steps → `assets/voice/<scriptKey>/<stepId>.mp3`; conversation lines → `assets/voice/conv/<convId>/<lineIndex>.mp3`. Generate with `node scripts/generate-voiceover.mjs` (`--dry-run` lists work; needs `ELEVENLABS_API_KEY` or `OPENAI_API_KEY`). The run is incremental (hash-gated) and prunes orphaned clips. Missing clips are always silent no-ops, so partial generation is safe. A test (`tests/tutorial.test.js` → "voiceover manifest") fails if any clip's text/voice drifts from `manifest.json`.
- **Models & audio tags:** conversation lines generate on **`eleven_v3`** (so inline `[audio tags]` add emotion — see Conversations above); tutorial/hint steps stay on **`eleven_multilingual_v2`**. The model is folded into the clip hash, so the two never collide — but **v3 needs a paid ElevenLabs plan** (a free-plan key returns HTTP 402 on v3). After editing a conversation's `.md`, re-run the generator to (re)make its v3 clips; until then those lines play silently. Per-model voice settings live in `scripts/generate-voiceover.mjs` (`ELEVEN_SETTINGS`): v3 uses "Natural" stability (0.5) + a little `style` so it stays responsive to tags without drifting.
- **Playback + mute:** `src/voiceover.js` owns one VO-only mute (localStorage `bs_voice_muted`) shared by the tutorial tooltip's 🔊 button and a matching button on the conversation card header — muting narration never touches SFX/music. The conductor and `conversation-player.js` both play through it.

> **Admin tooling:** `/admin/tools` (`admin-tools.html`) is the unified **Caleb's Hollow Tools** page — **Assets** (Babylon 3D model browser) | **Lighting** (Renderer3D tuner) | **Mission Editor** tabs, each lazy-initialised on first activation.
