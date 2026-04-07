# Game Systems

## Entity System

Defined in `src/entities.js`. All units share a common `Entity` class with type-specific factory functions.

### Entity Types & Base Stats

```
                    ┌──────────────────────┐
                    │   Entity (base class) │
                    │   id, type, owner,    │
                    │   ownerId, col, row,  │
                    │   hp, maxHp, attack,  │
                    │   defense, weapon,    │
                    │   items, guarding     │
                    └──────────┬───────────┘
                               │
        ┌──────────┬───────────┼───────────┬──────────┐
        │          │           │           │          │
   ┌────┴────┐ ┌───┴───┐ ┌────┴────┐ ┌────┴───┐ ┌───┴────────┐
   │  HERO   │ │ WITCH │ │SURVIVOR │ │ ZOMBIE │ │  SUMMONED  │
   │ 14/3/2  │ │ 10/2/2│ │  4/1/1  │ │ 2/2/0  │ │            │
   └─────────┘ └───────┘ └─────────┘ └────────┘ │ Minion 2/1/0│
                                                  │ WGolem 3/2/3│
        Hero faction                Neutral       │ IGolem 5/3/2│
                                                  └─────────────┘
                                                   Witch faction
```

| Type | HP | ATK | DEF | Faction | Created by |
|------|----|-----|-----|---------|------------|
| Hero | 14 | 3 | 2 | Hero | Game start |
| Witch | 10 | 2 | 2 | Witch | Game start |
| Survivor | 4 | 1 | 1 | Hero | Exploration / Sound Horn |
| Zombie | 2 | 2 | 0 | Neutral | Exploration (graveyard) |
| Minion | 2 | 1 | 0 | Witch | Summon (no resource cost) |
| Wood Golem | 3 | 2 | 3 | Witch | Summon (2 wood) |
| Iron Golem | 5 | 3 | 2 | Witch | Summon (2 metal) |

### Survivor Abilities

Each survivor has a unique ability from the `SurvivorAbility` enum:

| Ability | Effect |
|---------|--------|
| `FORTIFY_DOUBLE` | Wood fortification gives double bonus |
| `HEAL` | Heal co-located hero +1 HP (costs 1 action) |
| `BRAWLER` | +1 attack bonus in combat |
| `STURDY` | +1 defense bonus |
| `HERBALIST` | +1 herbs on exploration |
| `INSPIRE` | Give co-located hero +1 ATK (costs 1 action) |
| `RALLY` | Give co-located hero +1 action (costs 1 action) |
| `SCOUT` | +1 sight range |

### Entity Ownership

Every entity has two ownership fields:
- `owner` — faction string: `'hero'` or `'witch'` (or `null` for zombies)
- `ownerId` — player UUID linking to a specific human/AI player in N-player games

This separation allows the system to check faction-level rules (combat eligibility) while also tracking per-player budget and planning.

---

## Combat System

Defined in `Entity.resolveCombat()` in `src/entities.js`.

### Combat Resolution Flow

```
                    ATTACKER                    DEFENDER
                       │                           │
            attack stat + d6                 defense stat + d6
          + weapon bonus                   + weapon bonus
          + phase bonus (witch @ night)    + fortification bonus
          + gang-up bonus (extra d3s)      + ally bonus (extra d3s)
          + staff bonus (vs undead)        - fatigue penalty
                       │                           │
                       └──────────┬────────────────┘
                                  │
                            compare totals
                                  │
                    ┌─────────────┼──────────────┐
                    │             │              │
              ATK ≥ 2×DEF    ATK > DEF     DEF ≥ 2×ATK
                    │             │              │
              CRUSH (2 dmg)  HIT (1 dmg)   COUNTER (1 dmg
              + splash       to defender    to attacker
              to hex                        + splash)
```

### Modifiers

| Modifier | Source | Effect |
|----------|--------|--------|
| **Phase bonus** | Night phase | Witch units +1 ATK |
| **Gang-up** | Multiple attackers on same hex | +1d3 per additional ally |
| **Fortification** | Building fortified 1-4 | +1 DEF per level |
| **Staff weapon** | Equipped staff | +2 ATK vs undead entities |
| **Guard stance** | GUARD action | Reactive counter-attacks on adjacent moves |
| **Fatigue** | Multiple battles per round | -1 per additional battle |

### Guard Strikes

When a unit moves adjacent to a guarding enemy, the guard gets a free reactive attack:

```
Guard at hex A (charges: 2)
                                    Enemy moves to adjacent hex B
  ┌───┐   ┌───┐                        │
  │ G │───│ → │ ← enemy               Trigger: _checkGuardStrikes()
  └───┘   └───┘                         │
                                    Guard spends 1 charge
                                    Free resolveCombat(guard, enemy)
                                    Remaining charges: 1
```

---

## Action System

Defined in `src/actions.js`. All actions follow the same pattern:

```javascript
execute*(state, actor, ...params) → { success, log, cost }
```

The caller then calls `state.spendAction(result.cost)` to deduct from the budget.

### Action Types

```
┌─────────────────────────────────────────────────────────────┐
│                     ALL ACTIONS                              │
├──────────────┬──────────────────────────────────────────────┤
│ MOVEMENT     │ MOVE — adjacent hex (1 AP, road discount)    │
│              │        range 2 with horse                    │
├──────────────┼──────────────────────────────────────────────┤
│ EXPLORATION  │ EXPLORE — reveal tile contents (1 AP)        │
│              │ SOUND_HORN — reveal hero, recruit (1 AP+food)│
├──────────────┼──────────────────────────────────────────────┤
│ COMBAT       │ BATTLE — attack adjacent/co-located (1 AP)   │
│              │ BATTLE_HEX — blind attack in fog (1 AP)      │
├──────────────┼──────────────────────────────────────────────┤
│ DEFENSE      │ FORTIFY — build defense (+1-2 DEF) (1 AP)    │
│              │ GUARD — stance with counter-attacks (1 AP)    │
├──────────────┼──────────────────────────────────────────────┤
│ ECONOMY      │ SUMMON — witch creates unit (1 AP)           │
│              │ HEAL — use herbs (+2 HP) (1 AP)              │
│              │ USE_ITEM — food/silver/scripture (0 AP)       │
│              │ EQUIP_WEAPON — sword/axe/bow/etc (0 AP)      │
│              │ USE_ABILITY — survivor special (0-1 AP)       │
└──────────────┴──────────────────────────────────────────────┘
```

### Movement & Pathfinding

`getReachableHexes()` uses Dijkstra with terrain-weighted costs:

| Terrain | Movement cost |
|---------|--------------|
| Road / Bridge | 1 |
| Grass / Dirt / Building | 2 |
| Forest | 2 |
| River | Impassable |

A horse doubles movement range (2 hexes instead of 1).

### Visibility & Fog of War

```
sightRange(phase, isScout):
  DAY   → 3 hexes (+1 if scout)
  DAWN  → 2 hexes (+1 if scout)
  DUSK  → 2 hexes (+1 if scout)
  NIGHT → 1 hex   (+1 if scout)
```

Fog of war is active when any side is AI-controlled. Each faction sees only hexes within sight range of their units. AI log messages are replaced with atmospheric fog messages.

### Survivor Discovery

When exploring or moving through buildings, there's a chance to find hidden survivors:

```
Base chance:  DAY 50% | DAWN/DUSK 35% | NIGHT 25%

Diminishing returns:  chance × (1 - 0.10 × activeSurvivors)
                      minimum multiplier: 0 (at 10+ survivors)
```

---

## Tile & Resource System

### Tile Types

```
┌─────────────────────────────────────────────┐
│  TERRAIN          │  SPECIAL                │
│  ───────          │  ───────                │
│  GRASS            │  ROAD (connects tiles)  │
│  FOREST           │  BRIDGE (over river)    │
│  DIRT             │  RIVER (impassable)     │
│  BUILDING (13     │                         │
│   subtypes)       │                         │
└─────────────────────────────────────────────┘
```

### Building Types (13)

Town Hall, Church, Inn, Blacksmith, Graveyard, Mill, Dock, House, Barn, Watchtower, Apothecary, Storehouse, Stable

Each building type has different loot tables when explored (weighted random from `loot.config.js`).

### Resources

| Resource | Effect | Shared? |
|----------|--------|---------|
| **Herbs** | Heal 2 HP (1 action, personal) | No |
| **Food** | +1 action point | Yes (faction pool) |
| **Wood** | Fortify +1 DEF, or summon Wood Golem | Yes |
| **Metal** | Reinforce +2 DEF, or summon Iron Golem | Yes |
| **Silver** | +1 ATK next battle | Yes |
| **Scripture** | Ward off witch unit +1 hex | Yes |

### Weapons

| Weapon | ATK | DEF | Special |
|--------|-----|-----|---------|
| Sword | +2 | — | — |
| Axe | +1 | +1 | — |
| Bow | +1 | — | — |
| Shield | — | +2 | — |
| Staff | +1 | — | +2 vs undead |
| Dagger | +1 | — | — |

---

## Map Generation

Defined in `src/map.js`. Seeded procedural generation.

### Map Sizes

| Size | Dimensions | Use case |
|------|-----------|----------|
| Skirmish | 9×7 | Quick games |
| Standard | 13×11 | Default |
| Regional | 17×15 | Large games |
| Campaign | 21×19 | Epic games |

### Generation Pipeline

```
1. GRASS FILL          Fill all hexes with grass
       │
2. RIVER               Generate river path across map
       │
3. BUILDINGS           Place INN + GRAVEYARD in opposite corners
       │                Cluster remaining buildings nearby
       │
4. ROAD NETWORK        MST connecting all buildings
       │                Add bridges where roads cross river
       │
5. FOREST CLUSTERS     Seed forest patches (proportional to map size)
       │
6. DIRT PATCHES         Scatter dirt terrain
       │
7. POWER NODES         Place 3 objective nodes (balanced spacing)
       │
8. STARTING POSITIONS  Hero and Witch spawn points (opposite sides)
       │                generateMultipleStarts() for N-player
       │
9. HIDDEN SURVIVORS    Place discoverable survivors in buildings
```

### Coordinate System

- **Storage:** Odd-r offset coordinates `(col, row)`
- **Keys:** String `"col,row"` via `hexKey(col, row)` for O(1) map lookup
- **Math:** Converted to/from axial coordinates internally for distance/neighbor calculations
- **Rendering:** Pointy-top hex grid via `hexToPixel()` / `pixelToHex()`

```
Offset grid (odd-r):        Axial conversion:
  (0,0) (1,0) (2,0)          offsetToAxial(col, row) → (q, r)
    (0,1) (1,1) (2,1)        axialToOffset(q, r) → (col, row)
  (0,2) (1,2) (2,2)
```

---

## Rendering System

Defined in `src/renderer.js`. Pure Canvas 2D — reads state, draws frames, never mutates state.

### Draw Order (back to front)

```
1.  Terrain base (grass, forest, dirt, building fills)
2.  River (bezier curves)
3.  Roads and bridges
4.  Building icons
5.  Fog of war overlay
6.  Objective glows and Power Node symbols
7.  Unit selection outlines (per-player colors)
8.  Highlight hexes (valid moves, attack targets)
9.  Entity stacks (glyphs, HP bars, status icons)
10. Damage flash effects
11. Plan ghost overlay (dashed arrows, numbered badges)
12. Animation layer (move interpolation, attack FX)
```

### Camera Controls

| Feature | Input | Range |
|---------|-------|-------|
| Zoom | Mouse wheel / pinch | 0.5x — 4.0x |
| Pan | Mouse drag / touch drag | Bounded to map |
| Auto-center | Click unit | Smooth scroll to entity |
