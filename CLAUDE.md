# Brimstone — Claude Context

## Project Overview

Browser-based, turn-based hex-grid strategy game set in cursed colonial New England (Salem). Two asymmetric factions — **Hero** vs **Witch** — fight across a procedurally-generated map.

**Win conditions:**
- Hero: slay the Witch, or hold more Power Nodes at enough dawn/dusk scoring checkpoints (first to 3 cumulative score points).
- Witch: slay the Hero, or seize all 3 Power Nodes, or accumulate 3 node-score points.

**Game modes:** Human vs AI, Two Players, AI vs AI auto-play.

No build step. No dependencies. Pure vanilla JS ES modules, HTML5 Canvas, plain CSS.

---

## Git

**Active branch:** `claude/hex-game-framework-3U13Q`
**Push command:** `git push -u origin claude/hex-game-framework-3U13Q`

---

## Run Commands

```bash
npm run dev    # Dev server via npx serve (port 3000)
npm start      # Python HTTP server fallback

node scripts/headless.js [count]     # AI-vs-AI balance testing (default 1000 games)
node scripts/combat-sim.js [rounds]  # Combat stats report (default 100 samples)
```

---

## Directory Structure

```
index.html          # Single-page shell with all UI overlay elements
styles.css          # Dark gothic theme; CSS custom properties on :root
src/
  main.js           # Entry point — wires all modules, setup screen flow, resize
  game.js           # GameState class: tiles, entities, phase cycle, turn/victory logic
  entities.js       # Entity class + factory functions; static resolveCombat()
  actions.js        # All action validation (getValidActions) and execution functions
  map.js            # Procedural map generator (river, buildings, roads, MST, forests)
  renderer.js       # Canvas 2D renderer — multi-pass, zoom/pan, fog, animations
  ui.js             # UIController — DOM events, click routing, popups, dialogs
  ai.js             # WitchAI and HeroAI — async turn-taking with BFS pathfinding
  tiles.js          # Tile/Building/Resource/Weapon enums, colors, icons, rollLoot()
  hex.js            # Pure hex math: offset↔axial, neighbors, distance, range, pixel
  loot.config.js    # Externalized weighted loot tables (primary tuning file)
scripts/
  headless.js       # Headless AI-vs-AI runner (imports src/ directly, no DOM)
  combat-sim.js     # Scenario matrix: hit rates, crush rates, expected damage
```

---

## Architecture

**Strict separation of concerns:**
- `game.js` — owns state; no rendering or DOM.
- `renderer.js` — reads state, draws canvas; zero state mutations.
- `actions.js` — all game-logic mutations as pure functions `(state, actor, ...)`. Both UI and AI call these same functions.
- `ui.js` — sole file touching DOM; bridges user input → actions.
- `ai.js` — calls the same `execute*` functions from `actions.js` as the UI.

**Key patterns:**
- All type constants use `Object.freeze()` enums.
- `state.tiles` is a `Map<"col,row", Tile>` — O(1) lookup by hex key via `hexKey(col, row)`.
- Dead entities removed by filter: `state.entities = state.entities.filter(e => e.id !== dead.id)`.
- Execute functions return `{ success, log, cost }`; caller calls `state.spendAction(result.cost)`.
- AI turns are `async/await` with `THINK_DELAY_MS = 600` (0 in autoplay).
- Headless scripts import `src/` directly — all game logic is DOM/Canvas-free.

---

## Rendering System

**Hex type:** Pointy-top, odd-r offset storage (13 cols × 11 rows).
**Canvas:** Fills wrapper div. Hex size computed to fit grid; centered via `_padX`/`_padY`.
**Zoom:** 0.5×–4.0×. Desktop: scroll wheel + drag. Mobile: pinch + single-finger drag.

**Draw order (each frame):**
1. Black background `#0d1117`
2. `ctx.save()` + apply zoom/pan transform
3. Pass 1: terrain tiles (grass, forest, dirt; road/river/bridge tiles draw grass base)
4. River layer: quadratic bezier curves at ~52% hex width; extends off-screen at endpoints
5. Road layer: bezier strips (straight-through / dead-end / junction); bridge water + wood railings on top
6. Pass 2: building tiles (drawn over roads)
7. Fog of war: 70% black overlay on hexes outside human player's sight
8. Objective glows: radial purple gradient at Power Node positions (always visible)
9. Objective symbols: `⛧` glyph + label
10. Unit presence outlines: orange (hero side) or purple (witch side)
11. Highlight hexes: green (move), red (battle)
12. Selected hex: gold outline
13. Hovered hex: white semi-transparent outline
14. Entity stacks: colored circles with glyph, HP bar, weapon dot, ability dot; `+N` badge for overflow
15. Damage flash: fading red hex overlay + rising damage text
16. `ctx.restore()`

**Entity glyphs/colors:** ⚔ Hero (gold), ✦ Witch (purple), ☺ Survivor (green), † Zombie (olive), ☠ Minion (red), 🪵 Wood Golem (brown), ⚙ Iron Golem (blue-grey).

---

## Game Mechanics

### Phase Cycle (8 rounds per cycle)
`DAWN (1) → DAY (3) → DUSK (1) → NIGHT (3)`

| Phase | Effect |
|-------|--------|
| Dawn  | Hero +1 action; attrition level +1 (cap 3); tiles reset unexplored; node scoring |
| Day   | Hero +1 ATK; witch undead/golems in open take `attritionLevel` damage |
| Dusk  | No bonus; node scoring |
| Night | Witch +1 ATK; survivors in open take `attritionLevel` damage |

### Action Economy
- **Hero:** 3 base + 1 in DAY/DAWN + up to 2 extra from survivors.
- **Witch:** 4 base + 1 in NIGHT + 1 per 2 minions (cap +4).

### Actions
| Action | Cost | Notes |
|--------|------|-------|
| Move | 1 | 2 hexes with horse; cannot cross rivers except bridges |
| Explore | 1 | Reveals loot via weighted tables; HERBALIST also yields Herbs |
| Battle | 1 | Adjacent or co-located; dice-based with phase/ally/fortify bonuses |
| Fortify | 1 | Hero only; 1 Wood → +1 DEF (or +2 with FORTIFY_DOUBLE); 1 Metal → +2 DEF; max level 4 |
| Summon | 1 | Witch only, once/turn; Metal → Iron Golem, Wood → Wood Golem, other → Minion |
| Use Item | 0–1 | Herbs (free, heal 2), Food (1 action, +1 action), Silver (free, +1 ATK), Scripture (free, ward) |
| Equip Weapon | 0 | Free; moves weapon to equipped slot |
| Use Ability | 0–1 | HEAL (1), INSPIRE (free), RALLY (free) |

### Combat Formula
```
attackRoll  = d6 + attack + attackBonus + phaseBonus + staffBonus + Σ(gang-up d3s)
defenseRoll = d6 + defense + defenseBonus + fortBonus  + Σ(ally-def d3s)
hit         = attackRoll > defenseRoll
crush       = attackRoll >= 2 × defenseRoll  → 2 damage
counter     = defenseRoll >= 2 × attackRoll  → 1 damage to attacker
```
Gang-up d3: attacker has ≥1 ally adjacent to defender. Ally-def d3: defender has ≥1 ally adjacent to attacker.

### Entity Stats
| Type | HP | ATK | DEF |
|------|----|-----|-----|
| Hero | 10 | 3 | 2 |
| Witch | 10 | 2 | 2 |
| Survivor | 2–4 | 1–3 | 2–3 |
| Zombie | 2 | 2 | 0 |
| Minion | 2 | 1 | 0 |
| Wood Golem | 4 | 2 | 3 |
| Iron Golem | 6 | 3 | 4 |

### Fog of War
Active when any side is AI-controlled. Hero-side sight: 3 in DAY, 2 in DAWN/DUSK, 1 in NIGHT. SCOUT survivors add +1. AI logs replaced with atmospheric fog messages when active.

### Rest Healing
Hero ends turn in INN/CHURCH: +3 HP. Any other building: +1 HP. Power Node: +1 HP (including NIGHT).

### Node Scoring
Each dawn and dusk: whoever holds more nodes scores 1 point. Sweep all 3 at any checkpoint = instant win. First to 3 cumulative points wins.

---

## Map Generation

Seeded, procedural. Sequence:
1. Fill 13×11 with grass.
2. Carve a meandering single-tile river (cols 2–10, random drift).
3. INN + GRAVEYARD in opposite corners; scatter remaining buildings in clusters (65% clustering).
4. MST (Kruskal's) of all buildings; BFS road paths between edges; up to 4 river-crossing bridges.
5. Forest clusters from 12 seed positions (70% primary / 40% secondary spread).
6. 10 dirt patches for texture.
7. 3 Power Nodes (minimum separation, no buildings).
8. Hero starts at INN, Witch at GRAVEYARD.
9. 12 hidden survivors (10 in buildings, 2 on terrain) flagged as `tile.hiddenSurvivor = true`.

---

## Key Tunable Constants

| Constant | File | Default | Purpose |
|----------|------|---------|---------|
| `MAP_COLS`, `MAP_ROWS` | `hex.js` | 13, 11 | Grid dimensions |
| `HEX_SIZE` | `hex.js` | 30 | Base hex radius (px) |
| `CYCLE_LENGTH` | `game.js` | 8 | Rounds per day/night cycle |
| `THINK_DELAY_MS` | `ai.js` | 600 | AI action delay (ms) |
| `CLUSTER_CHANCE` | `map.js` | 0.65 | Building clustering probability |

Loot tables: edit `src/loot.config.js` — weights are relative integers; valid types: `wood`, `metal`, `herbs`, `food`, `silver`, `scripture`, `weapon:sword/axe/shield/bow/staff/dagger`, `horse`, `nothing`.

---

## Survivor Roster (12 characters, drawn without replacement per game)

| Name | Role | Ability |
|------|------|---------|
| John O'Connor | Innkeeper | FORTIFY_DOUBLE |
| Mary Quinn | Nurse | HEAL |
| Thomas Putnam | Blacksmith | BRAWLER |
| Abigail Foster | Herbalist | HERBALIST |
| Samuel Cooper | Militia Sergeant | INSPIRE |
| Father Crane | Parish Priest | RALLY |
| Hannah Marsh | Baker | STURDY |
| Ezra Boone | Trapper | SCOUT |
| Constance Bell | Schoolteacher | HERBALIST |
| Isaac Graves | Gravedigger | STURDY |
| Patience Cole | Midwife | HEAL |
| Silas Holt | Farmhand | BRAWLER |

---

## Coordinate System

Tiles stored and iterated in **offset coordinates** `(col, row)`, keyed as `"col,row"` strings.
All hex math (distance, range, neighbors) converts to/from **axial** internally.
`hexKey(col, row)` centralizes the string key format.

---

## CSS Conventions

All palette colors defined as CSS custom properties on `:root`: `--bg`, `--hero`, `--witch`, `--day`, `--night`, etc. Dark gothic theme: deep purples, aged golds, desaturated greens. Canvas colors in `tiles.js`/`entities.js` mirror these variables manually.
