# Game Systems

## Entity System

Defined in `src/entities.js`. All units share a common `Entity` class with type-specific factory functions.

### Sides & Factions

Brimstone has two opposing **Sides** — Day and Night — and multiple **Factions** per side. Each side owns the day/night phase cycle, scoring, and team allocation; factions vary the leader stats, abilities, AI personalities, and unit roster within a side.

| Side  | Faction      | Leader entity type | Leader display name | Status |
|-------|--------------|--------------------|---------------------|--------|
| day   | hero (Paladin) | `PALADIN`        | Ishmael Charger     | primary |
| day   | rogue        | `ROGUE`            | Mercy Sloane        | distinct (starts with a bow → range 3, +1 sight, no melee weapons, no Sound Horn) |
| day   | captain      | `CAPTAIN`          | Captain Eli Ward    | stub (inherits Paladin behaviour) |
| night | witch        | `WITCH`            | The Witch           | primary |
| night | necromancer  | `NECROMANCER`      | The Necromancer     | distinct (undead-only RAISE DEAD summons, POSSESS, TELEPORT) |
| night | brute        | `BRUTE`            | The Brute           | distinct (heavy tank, cheap minions, splash blast every hit, knockback, friendly-fire off) |

Stub factions are registered with their own `EntityType`, base stats, and default leader name. They are subclasses of their side's primary faction (`HeroFaction` or `WitchFaction`) and inherit all combat / summon / fortify / discovery / sight behaviour.

The Rogue is no longer a stub — `RogueFaction` overrides:
- `getSightRange` — paladin formula + 1 in every phase
- `canEquipWeaponItem` — only `category === 'ranged'` items (bow, crossbow, musket, pistol, sling)
- `innateLeaderAbilities` — empty (no Sound Horn)
- `modifyLootRoll` — re-rolls `'nothing'` so exploration always finds something
- `onAfterMoveStep` — auto-detects survivors in adjacent building tiles

Her 3-hex ranged attack now comes from her **starting bow** (range is weapon-derived; `projectileType` lives on the weapon), not an innate unit-type range.

The Brute is also no longer a stub — `BruteFaction` overrides:
- `getSummonOptions` / `getMinionCost` — minions only (no golems), and at a 1-resource discount (witch pays 2)
- `onAfterMoveStep` — same building-tile scan as the rogue, but `WitchFaction.createDiscoveryEntity` raises a zombie instead of recruiting a survivor
- `crushSplashRadius` — `1`; the splash blast extends outward to the 6 hexes around the target
- `splashesOnEveryHit` — `true`; the blast fires on any melee hit, not just crushes
- `splashSparesAllies` — `true`; witch-side units on splash hexes take no damage (and no knockback)
- `splashKnockback` — `true`; surviving splashed bystanders are pushed one hex outward from the target when the destination is open

The Captain is also no longer a stub — `CaptainFaction` overrides:
- `canSummon` / `getSummonOptions` — **CALL REINFORCEMENTS**: one action + 2 food spawns **2 Soldiers** on/next to the captain (shares the SUMMON plumbing; `executeSummon` has a soldier branch)
- `canMarch` — **MARCH** (`PlanActionType.MARCH`): the captain moves and every friendly soldier on his starting hex moves with him for one action; overflow passengers (destination at capacity) stay behind
- `canBuildSiege` — **BUILD_SIEGE** (`PlanActionType.BUILD_SIEGE`): 4 wood + 1 metal places an immobile **Catapult** (innate `catapult_stone` weapon, range 4) on an adjacent hex
- `baseBudget` 4 / `actionCap` 8 — bigger action economy (budgets resolve through the live leader's concrete faction, see `budgetFactionFor` in game.js)
- `survivorFindMultiplier` — 0.4; hidden survivors are much harder for the captain to stumble on (move/explore discovery only — Sound Horn remains a deliberate, full-strength recruit tool)
- Personally weaker than the paladin (70 HP / base ATK 1 + sword) — he wins through troops.

The **immobile** unit tag (`UNIT_TYPES[type].tags` → `isImmobileType()`) is a general mechanic introduced with the catapult: immobile units never get MOVE (or a March pickup) in `getValidActions`, `executeMove` refuses them, and `validatePlanAction` rejects queued moves.

Splash damage scales with the attacker's roll margin: `clamp(floor(margin / 3), 1, 3) × DAMAGE_SCALE`. Crushing blows additionally apply the **wounded** effect to surviving targets — that's a universal rule (any attacker), not a brute-only one.

The Necromancer is also no longer a stub — `NecromancerFaction` deals exclusively with the undead:
- `getSummonOptions` — **RAISE DEAD** replaces the witch's summon list entirely: ZOMBIE (raise a corpse) + SKELETON (fresh conjuration); never golems or minions
- `getMinionCost` — `1` of any resource (brute-style cheap chaff; the all-14-HP roster has no golem top-end to pay for)
- `innateLeaderAbilities` — `['summon', 'possess', 'teleport']`
- **Death-location ledger** — every entity death (combat kill, counter kill, splash, DOT tick, night attrition) is recorded to `state.deathLocations` via `state.recordDeathLocation()` (`{ id, type, owner, ownerId, col, row, round }`, serialized by state-sync). A ZOMBIE summon consumes the nearest unconsumed, non-leader corpse within 3 hexes and raises the zombie **at its death hex**; with no corpse in reach it degrades to a skeleton. Leaders are recorded but can never be raised.
- **Skeleton conjuration** — a SKELETON summon lands on a seeded-random open hex within 2 of the caster (`state.nextDie` over a fixed-order candidate list — sealed-resolution safe).
- **POSSESS** (`PlanActionType.POSSESS`, `executePossess`) — seize an enemy **non-leader** unit within 2 hexes. Applies the `possessed` effect (duration 2, source = possessor's ownerId): resolving in round N leaves it active through round N+1's planning and resolution, expiring at N+1's end. While possessed, only the possessor may command the unit — the shared gate is `canCommandEntity()` (`src/effects.js`), consulted by `planner.validatePlan`, `resolver.runAction`, and the offline UI's selection path.
- **TELEPORT** (`PlanActionType.TELEPORT`, `executeTeleport`) — inaccurate warp: the player picks a center hex up to 4 away; the landing clump = center + neighbors filtered to passable/unoccupied (`getTeleportClump`), and resolution picks one member with `state.nextDie`.

`Faction` exposes the hooks (`canEquipWeaponItem`, `modifyLootRoll`, `applyExploreLootBonus`, `onAfterMoveStep`, `getSightRange`, `crushSplashRadius`, `splashesOnEveryHit`, `splashSparesAllies`, `splashKnockback`, `getMinionCost`) on the base class; future factions plug in by overriding only what they need.

### Weapons, range & equipping

Weapons live in the **per-unit** backpack (`entity.items`), a dict-of-objects map `{ id: { count, equipped? } }`; the wielded weapon is the entry tagged `{ equipped: true }` (resolved via `getEquippedWeaponId()`, not a separate `entity.weapon` slot). **Range is entirely weapon-derived — units have no innate range.** `Entity.getRange()` reads `ITEMS[equippedWeaponId].range` (default 1 for melee/unarmed), so *any* equip-capable unit that wields a ranged weapon becomes ranged (a looted bow turns a melee survivor into a 3-hex archer). There is no denormalized `entity.range` cache — `getRange()` composes range from the equipped weapon on demand.

Roster (`src/items.js`):

| Weapon | Category | Stats | Range |
|--------|----------|-------|-------|
| Sword | melee | +2 ATK | 1 |
| Axe | melee | +1 ATK / +1 DEF | 1 |
| Shield | melee | +2 DEF | 1 |
| Staff | melee | +1 ATK (+adv vs undead) | 1 |
| Dagger | melee | +1 ATK | 1 |
| Bow | ranged | — | 3 |
| Crossbow | ranged | +1 ATK | 2 |
| Musket | ranged | +2 ATK | 2 |
| Flintlock pistol | ranged | +1 ATK | 2 |
| Sling | ranged | — | 2 |
| Magic Bolt | ranged | +1 ATK | 2 |

`category` (`'melee' | 'ranged'`) + `wielderFactions` gate equipping via `Faction.canEquipWeaponItem(itemId)`: the Rogue refuses melee weapons; **Magic Bolt** is `wielderFactions: ['witch','necromancer']` only and is flagged `noLoot` (issued as starting gear, never dropped). Firearms drop in armory-type buildings (blacksmith/watchtower for muskets, house/town_hall for pistols/slings).

**Starting weapons** are issued at leader creation via `Faction.innateLeaderWeapon` (Paladin → sword, Rogue → bow, Witch/Necromancer → Magic Bolt; Captain/Brute unarmed). `swapLeaderToFaction` transfers the new faction's starting weapon.

**Equipping** is a **free action (0 AP), capped at once per round per unit** (`entity.equippedThisRound`, reset in `resetTurn()`; enforced in `executeUseItem` and surfaced/disabled in the action popup).

See `src/sides.js` for the Side enum and `src/factions.js` for the Faction registry.

### Entity Types & Base Stats

```
                    ┌──────────────────────┐
                    │   Entity (base class) │
                    │   id, type, owner,    │
                    │   ownerId, factionId, │
                    │   col, row,           │
                    │   hp, maxHp, attack,  │
                    │   defense, weapon,    │
                    │   items, guarding     │
                    └──────────┬───────────┘
                               │
   ┌──────────┬─────────┬──────┴───────┬─────────┬─────────┐
   │ DAY-SIDE │   NPCs  │  NIGHT-SIDE  │ NEUTRAL │SUMMONED │
   │ Paladin  │Survivor │  Witch       │ Zombie  │ Minion  │
   │ 14/3/2   │  4/1/1  │  10/2/2      │  2/2/0  │ 2/1/0   │
   │ Rogue    │         │  Necromancer │         │ WGolem  │
   │ 10/3/1   │         │  10/1/2      │         │ 3/2/3   │
   │ Captain  │         │  Brute       │         │ IGolem  │
   │ 12/2/3   │         │  18/4/3      │         │ 5/3/2   │
   └──────────┘         └──────────────┘         └─────────┘
```

| Type | HP | ATK | DEF | Side | Created by |
|------|----|-----|-----|------|------------|
| Paladin (default day leader) | 14 | 3 | 2 | day | Game start |
| Rogue (stub) | 10 | 3 | 1 | day | Game start (when picked) |
| Captain | 10 | 1 | 2 | day | Game start (when picked) |
| Witch (default night leader) | 10 | 2 | 2 | night | Game start |
| Necromancer | 10 | 1 | 2 | night | Game start (when picked) |
| Brute        | 18 | 4 | 3 | night | Game start (when picked) |
| Survivor | 4 | 1 | 1 | day (after recruit) | Exploration / Sound Horn |
| Zombie | 2 | 2 | 0 | night (after raise) | Exploration / graveyard passive spawn / necromancer RAISE DEAD |
| Skeleton | 2 | 1 | 1 | night | Necromancer summon (1 any resource; seeded-random hex within 2) |
| Minion | 2 | 1 | 0 | night | Summon (no resource cost) |
| Wood Golem | 3 | 2 | 3 | night | Summon (2 wood) |
| Iron Golem | 5 | 3 | 2 | night | Summon (2 metal) |
| Soldier | 2 | 1 | 1 | day | Call Reinforcements (2 food → 2 soldiers, captain only) |
| Catapult | 4 | 2 | 1 | day | Build Siege (4 wood + 1 metal, captain only); immobile, range 4 |

**HP note:** the HP values above are the *logical* base; actual `maxHp` in code
is each value **× `DAMAGE_SCALE` (7)** (paladin 98, zombie 14…) — see the combat
section. ATK/DEF are unscaled.

**Graveyard passive spawns** (standard games only): at the end of every full
day-cycle (8 rounds), each graveyard raises one free witch-owned zombie,
capped at 2 concurrent witch zombies. Implemented in
`WitchFaction.applyEndOfRoundEffects` (`src/factions.js`); battle mode and
campaign missions are exempt. Mirrors hero survivor income to soften the
recruitment snowball.

### Unit Levels

Every entity has a `level` (≥1, default 1) that scales its **intrinsic stats —
HP, ATK, DEF — not its weapon damage** (damage stays weapon-driven; a higher
level lands more/bigger crushes, which multiply the rolled weapon damage). Used
by campaign authoring to ramp difficulty without new unit types (Zombie L1/L2/L3).
"Standard" curve (constants in `src/balance.js`):

| | formula | L1 | L2 | L3 |
|---|---|---|---|---|
| HP | `× (1 + 0.5·(L−1))` | ×1 | ×1.5 | ×2.0 |
| ATK | `+ (L−1)` | +0 | +1 | +2 |
| DEF | `+ floor((L−1)/2)` | +0 | +0 | +1 |

`applyLevel(entity, level)` (`src/entities.js`) sets `level` and rescales `maxHp`
(idempotent — snapshots the L1 base); the ATK/DEF bonus composes live in
`getAttack()`/`getDefense()`. `level` serializes via `server/state-sync.js` and
shows in the unit's `displayName` ("Zombie L2"). Authored on mission unit specs —
see `docs/08`. (Regular-mode XP/veterancy is not wired yet; the API is ready for it.)

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

Every entity has three ownership-related fields:
- `owner` — side-default faction string: `'hero'` (day) or `'witch'` (night), or `null` for neutral entities. Stub-faction leaders also carry `'hero'` / `'witch'` here so the codebase's existing owner checks keep working.
- `ownerId` — player UUID linking to a specific human/AI player in N-player games.
- `factionId` — the specific faction this entity represents (e.g. `'rogue'` for a stub-faction leader; equals `owner` for default leaders).

This separation lets the system check side-level rules (combat eligibility, scoring) via `owner`, per-player budget and planning via `ownerId`, and faction-specific behaviour via `factionId`.

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
          ┌──────────┬────────┼────────┬──────────────┐
          │          │        │        │              │
    ATK ≥ 3×DEF  ATK ≥ 2×DEF  │   ATK > DEF      DEF ≥ 2×ATK
          │          │        │        │              │
   GREAT CRUSH    CRUSH       │      HIT          COUNTER
    (3× roll)    (2× roll)    │   (1× roll)     (1× roll to
   + splash      + splash     │   to defender    attacker
   to hex        to hex                          + splash)
```

**Weapon damage rolls.** A landed hit deals **crush tier × the attacker's
weapon damage roll**. Each weapon carries a `damage` spec in `src/items.js` —
either a fixed number or a dice roll `{ count, sides, flat }` (e.g. sword 2D6,
musket 2D8, dagger 1D10); unarmed falls back to `DEFAULT_ATTACK_DAMAGE` (2D6).
`rollDamage()` (`src/entities.js`) rolls it through `state.nextDie` so it's
deterministic under forced dice / replay / online. Crush multiplies the rolled
amount (hit 1×, crush 2×, great crush 3×); ranged attacks never crush (always
1×). A counter is one 1× roll of the defender's weapon.

**HP / damage scale.** All HP totals and every flat HP delta (heals, DOTs,
night attrition) are multiplied by `DAMAGE_SCALE` (=7, `src/balance.js`). 7 is
the mean of the 2D6 baseline attack, so the average hits-to-kill is unchanged
from the pre-dice era while combat gains roll variance. Damage is applied as a
**single blow**, so a defender's `wounded` (+1D6 damage taken, rolled through
the deterministic die stream) lifts the whole strike *once*. Splash damage is
`clamp(floor(margin/3), 1, 3) × DAMAGE_SCALE`. Both crush tiers apply `wounded`
to a surviving target — it lasts **one round**, so the follow-up tax must be
cashed in immediately.

### Modifiers

| Modifier | Source | Effect |
|----------|--------|--------|
| **Phase bonus** | Night phase | Witch units +1 ATK |
| **Gang-up** | Allies adjacent to the target | +1d3 per additional ally (capped at 3). Counted by each ally's **end-of-turn** position — an ally moving out of range this same turn no longer flanks; one moving into range does (`combatHexKey` + the resolver's `_turnEndPositions`) |
| **Fortification** | Building fortified 1-4 | +1 DEF per level |
| **Staff weapon** | Equipped staff | +2 ATK vs undead entities |
| **Guard stance** | GUARD action | Free reactive strike when an enemy acts in reach (ranged units shoot, see below) |
| **Fatigue** | Multiple battles per round | -1 per additional battle |
| **Range falloff** | Ranged attack at distance | -`floor((dist-1)/2)` ATK — 0 at dist 1-2, -1 at 3-4, -2 at 5-6 |

Ranged attacks (`getRange() > 1`, e.g. witch range 2, rogue range 3) use a distinct
rule set: no gang-up, no crushing blows, no splash, **no counter-attack**, the
defender gains +1 DEF in forest cover, point-blank (dist ≤ 1) shots fire at
disadvantage, and the range-falloff penalty above scales with distance.

### Guard Strikes

When an enemy acts within a guarding unit's reach, the guard spends one charge on a
free reactive attack (`_checkGuardStrikes` in `server/resolver.js`):

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

**Reach by guard type:**
- **Melee guard** (`getRange() <= 1`): reacts to enemies in the 6 adjacent hexes.
- **Ranged guard / opportunity shot** (`getRange() > 1`): a guard strike is a
  DIRECT attack, so its reach is `min(attackRange, sightRange)` — capped by the
  unit's own phase-dependent sight distance — **and** gated by a clear line of
  sight to the trigger hex. A unit can only strike what it can see; it never
  fires into fog. (The blind `BATTLE_HEX` action is the separate exception that
  ignores LOS but still respects range.) The shot obeys the ranged rule set — no
  crush, no counter, forest cover for the target, distance falloff, and
  point-blank disadvantage. So a guarding witch (range 2, sight 5) fires up to 2
  hexes away; a guarding rogue (range 3) reaches 3 hexes by day but only what her
  night sight (3) allows after dark.

The 3D renderer (`renderer-3d.js`, the in-game renderer — the 2D `renderer.js`
backs only the editor/admin tools) paints the guard zone as an **orange exterior
perimeter outline** around the covered hexes, reusing the power-node outer-edge
walk (internal shared edges skipped). It uses the same `min(range, sight)` + LOS
reach so the outline matches where shots actually fire, and is drawn both while
planning — previewed at the unit's projected hex the moment a GUARD action is
queued (from `planGhostSteps`) — and during resolution playback for units in
guard stance (fogged units skipped so a hidden enemy guard isn't revealed).

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
│              │ MARCH — captain + co-located soldiers (1 AP) │
├──────────────┼──────────────────────────────────────────────┤
│ EXPLORATION  │ EXPLORE — reveal tile contents (1 AP)        │
│              │ SOUND_HORN — reveal hero, recruit (1 AP+food)│
├──────────────┼──────────────────────────────────────────────┤
│ COMBAT       │ BATTLE — attack adjacent/co-located (1 AP)   │
│              │ BATTLE_HEX — blind attack in fog (1 AP)      │
├──────────────┼──────────────────────────────────────────────┤
│ NECROMANCER  │ POSSESS — seize enemy unit 1 round (1 AP)    │
│              │ TELEPORT — inexact warp, center ≤4 (1 AP)    │
├──────────────┼──────────────────────────────────────────────┤
│ DEFENSE      │ FORTIFY — build defense (+1-2 DEF) (1 AP)    │
│              │ GUARD — stance with reactive strikes (1 AP)   │
├──────────────┼──────────────────────────────────────────────┤
│ ECONOMY      │ SUMMON — witch unit / captain soldiers (1 AP)│
│              │ BUILD_SIEGE — captain catapult (1 AP+res)    │
│              │ HEAL — use herbs (+2D10 HP) (1 AP)           │
│              │ USE_ITEM — food/silver/scripture (0 AP)       │
│              │ EQUIP_WEAPON — from pack (0 AP, 1×/round)    │
│              │ USE_ABILITY — survivor special (0-1 AP)       │
└──────────────┴──────────────────────────────────────────────┘
```

### Movement & Pathfinding

`getReachableHexes()` uses Dijkstra with terrain-weighted costs:

| Terrain | Movement cost |
|---------|--------------|
| Road / Bridge | 1 |
| Grass / Dirt / Building entrance | 2 |
| Forest | 2 |
| River | Impassable |
| Building footprint | Impassable (capacity 0) |

A building occupies two hexes: a passable **entrance** (cost 2, like grass) and an impassable **footprint** (`tileTotalCapacity()` returns 0). See [Building Footprints](#building-footprints).

A horse doubles movement range (2 hexes instead of 1).

### Sub-hex slots & capacity

Every hex has **7 placement slots** — `0` = centre, `1..6` = the spot adjacent to each of the 6 faces (aligned to `getNeighbors` direction order; mapping in `src/hex-slots.js`). Slots serve two purposes:

- **Placement (rendering).** Each entity carries an authoritative `entity.slot` (game state, serialized). It is assigned at every placement seam — `executeMove`, `executeSummon`, survivor discovery — by `assignSlotOnTile()`, which calls `pickUnitSlot()` to take the lowest free, non-blocked slot (centre preferred). Both renderers read `entity.slot` for intra-hex placement, and move animations slide from the source slot to the destination slot (`executeMove` returns the new `slot`) instead of snapping through the hex centre.
- **Capacity (gameplay).** A tile's `blockedSlots` (ids `1..6`) mark spots made unusable by static features. They are derived once at map-gen by `deriveBlockedSlots()`:
  - **Forest** — `treeCountForTile` trees on outer slots, kept **off the road entry/exit faces** (and off the building slot on a building-on-forest tile). Forest capacity is unchanged from before (still sourced from `treeCountForTile`).
  - **Bridge** — **all** non-road outer slots are blocked (only the centre + the road-axis faces stay usable), so a 2-road bridge caps at 3 units instead of 7.

`tileCapacityRemaining()` subtracts building (3), trees, **and** bridge blocked-slots from `TILE_CAPACITY` (7); a tile with no remaining capacity blocks movement in and through it (`isTileFullForMove`).

### Visibility & Fog of War

```
Hero sightRange(phase, isScout):
  DAY   → 6 hexes (+1 if scout)
  DAWN  → 4 hexes (+1 if scout)
  DUSK  → 4 hexes (+1 if scout)
  NIGHT → 3 hexes (+1 if scout)

Witch sightRange:
  always → 5 hexes
```

Vision is **line-of-sight**: each unit's view is gated by `computeLineOfSight` (`src/actions.js`), which walks a hex line from the unit to each candidate hex inside its base range. The single blocker rule is `blocksLineOfSight(tile)` in `src/tiles.js`, which returns true for **building footprint** hexes (`isBuildingFootprint`) and **forest** tiles (`isForestCover` — base material is forest, regardless of any path/structure on top). The blocker itself is visible; hexes beyond it are not. Note the footprint/entrance asymmetry: the impassable footprint hex blocks vision (it carries the rendered model — the "wall"), while the **building entrance is transparent** to LOS (you can see across a doorway). The 2D renderer (`renderer._buildFogVisibleHexes`), 3D renderer (`buildFogVisibleSet`), explored-hex memory (`GameState.updateExploredHexes`), and Hero-AI fog awareness all delegate to this single helper via `_isLosBlocker` (`src/actions.js`).

Fog of war is active when any side is AI-controlled. Each faction sees only hexes within line of sight of their units. AI log messages are replaced with atmospheric fog messages.

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

### Building Footprints

A building is a **two-hex compound**, not a single tile:

| Role | Passable? | LOS | Carries the model? | Actions target it? |
|------|-----------|-----|--------------------|--------------------|
| **Entrance** | yes (cost 2) | transparent | no | yes — explore, battle, fortify, loot, hidden-survivor, and road-through (`roadDirs`) all live here |
| **Footprint** | no — `tileTotalCapacity()` returns 0 | blocks (`blocksLineOfSight`) | yes — the rendered building sits here | no |

The entrance hex is the canonical "building tile": it keeps the `building` enum, the loot/explore/fortify behaviour, the hidden survivor, and any `roadDirs` connectivity. The footprint hex is a pure obstacle — impassable, sight-blocking, and where the artwork is drawn.

**Tile fields** (`src/tiles.js`, on every `Tile`):

- `footprintHexes: string[]` — on the **entrance** tile; `"col,row"` keys of its footprint hex(es). `[]` means legacy/unmigrated (still a valid 1-hex building).
- `buildingFootprintOf: "col,row" | null` — on each **footprint** tile, the back-pointer to its entrance. `null` everywhere else.

MVP places **one** footprint per building, but the schema is `string[]` and the predicates iterate, so N-hex buildings are already supported.

**Predicates** (all in `src/tiles.js`, the single source of truth):

| Predicate | True when |
|-----------|-----------|
| `isBuildingEntrance(tile)` | `hasBuilding(tile)` **and** non-empty `footprintHexes` |
| `isBuildingFootprint(tile)` | `buildingFootprintOf != null` |
| `isBuildingTile(tile)` | entrance **or** footprint |
| `blocksLineOfSight(tile)` | footprint **or** forest cover (entrance does **not** block) |

**Eligibility helper** (`src/building-footprint.js`) — shared by procgen, the auto-migration in `state-sync`, the one-shot mission migration, and the editor:

- `eligibleFootprintNeighbors(state, col, row, opts)` — neighbours of the entrance in odd-r direction order `0..5` that may become a footprint. Excludes: off-map hexes, river (base or path), bridge and **road** paths (a road footprint would sever the MST road network), hexes already carrying a building, hexes already claimed as a footprint, and power-node hexes.
- `pickFootprintNeighbor(state, col, row, rand, opts)` — picks one, **scoring** the eligible candidates so the impassable hex lands where it does least harm (lower penalty = better): a heavy penalty for sitting on a **river bank** (would starve a future bridge approach), a penalty for being a **local cut-vertex** (pinching a movement corridor, via a bounded radius-2 connectivity check), and a mild penalty for **clustering** against other buildings/footprints (which tends to form walls). It then takes the lowest-penalty candidate(s): with no `rand` it is **deterministic** (the best candidate in direction order); with a `rand()` function it tie-breaks randomly within the best-scoring bucket (one `rand()` draw, so seeded maps stay reproducible). The clustering term also incidentally frees later buildings' neighbours, making placement rollbacks rare. As defence-in-depth, `_pickRiverCrossings` (`src/map.js`) excludes footprint hexes when choosing bridge banks so a crossing is never starved of a usable approach.

**Renderer relocation** (shared constants/helpers in `src/building-render.js`, consumed by both `src/renderer.js` and `src/renderer-3d.js`):

- The building art is drawn on the **footprint** hex, then nudged `BUILDING_ENTRANCE_NUDGE = 0.15` of the way back toward the entrance (`buildingNudgedPosition`) so it visibly leans toward its door.
- It is rotated to **face the entrance** (`buildingFacingYaw`).
- An implicit **door-stub road** is drawn from the entrance toward the footprint edge (`doorStubDirection`) **regardless of `roadDirs`** — render-only, the tile's `roadDirs` are never modified.
- 3D models are normalized to roughly one hex of ground via `TARGET_BUILDING_GROUND_SPAN = 1.0` (operator-dialable).

### Resources

| Resource | Effect | Shared? |
|----------|--------|---------|
| **Herbs** | Heal 2D10 HP (1 action, personal) | No |
| **Food** | +1 action point | Yes (faction pool) |
| **Wood** | Fortify +1 DEF, or summon Wood Golem | Yes |
| **Metal** | Reinforce +2 DEF, or summon Iron Golem | Yes |
| **Silver** | +1 ATK next battle | Yes |
| **Scripture** | Ward off witch unit +1 hex | Yes |

Shared faction resources live in `state.inventory.hero` / `state.inventory.witch`, keyed by `ResourceType` id in the **dict-of-objects** shape `{ id: { count } }` — the same shape as entity backpacks (`entity.items`) and the campaign armory (`Campaign.weapons`). Mutate them through the shared free functions in `src/entities.js` (`addItemInItems`, `removeItemInItems`, `getItemCountOf`, `totalItemCount`), never by raw indexing, so all three inventory surfaces stay consistent. (The campaign's between-mission `Campaign.resources` is the one exception — it persists as a flat `{ id: N }` numeric map and is normalized/flattened at the `main.js` boundary when injected into / snapshotted out of the live faction inventory.)

### Weapons

Each weapon carries a `damage` spec (fixed or dice) rolled per hit — see the
Combat section. ATK/DEF are `statMods`. Full table in `src/items.js`.

| Weapon | ATK | DEF | Damage | Special |
|--------|-----|-----|--------|---------|
| Sword | +2 | — | 2D6 | — |
| Axe | +1 | +1 | 1D12+1 | swingy |
| Dagger | +1 | — | 1D10 | fast |
| Staff | +1 | — | 2D6 | +adv vs undead |
| Shield | — | +2 | 2D6 | — |
| Bow / Sling | +0/+0 | — | 2D4 | ranged (no crush) |
| Crossbow / Pistol | +1 | — | 1D10 | ranged |
| Musket | +2 | — | 2D8 | ranged, prize drop |

**Premium tier** (rarer, gated to later rounds via `LOOT_TIER_GATE` in
`src/loot.config.js`, enforced in `_effectiveLoot`, `src/actions.js`):

| Weapon | ATK | DEF | Damage | Gate round |
|--------|-----|-----|--------|-----------|
| Great Sword | +3 | — | 3D6 (~10.5) | 8 |
| Long Rifle | +3 | — | 2D8+2 (~11), range 3 | 9 |
| War Hammer | +2 | +1 | 1D12+4 (~10.5) | 10 |

Premiums sit on the blacksmith / watchtower tables at low weight; before their
gate round `_effectiveLoot` filters them out so they can't roll. A mission can
force one in earlier via a full-table `lootOverrides` entry (author opt-in).

---

## Map Generation

Defined in `src/map.js`. Seeded procedural generation.

### Map Sizes

| Size | Dimensions | Use case |
|------|-----------|----------|
| Skirmish | 10×10 | Quick games |
| Standard | 14×14 | Default |
| Regional | 19×19 | Large games |
| Campaign | 23×23 | Epic games |
| Battle | 42×42 | The Battle for Caleb's Hollow (also selectable) |

### Generation Pipeline

```
1. GRASS FILL          Fill all hexes with grass
       │
2. RIVER               Generate river path across map
       │
3. BUILDINGS           Place INN (hero start) + GRAVEYARD (witch start) on
       │                OPPOSITE river banks, far enough apart to be out of
       │                sight at game start (hex distance > START_SIGHT_CLEARANCE;
       │                seeded-random, _pickFactionStarts). Tiny maps fall back to
       │                the most-distant opposite-bank pair, then legacy corners.
       │                Cluster remaining buildings nearby
       │                Two-pass footprint materialization (see below)
       │
4. ROAD NETWORK        MST connecting all buildings (src/road-network.js)
       │                Add bridges where roads cross river
       │                Bridge audit: every BRIDGE ends with exactly 2 road
       │                links (normalize >2 to one opposite-bank span, revert
       │                unreached/one-sided crossings) — assertMapInvariants()
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

### Two-Pass Building Materialization (`src/map.js`)

Because every building now needs an adjacent impassable footprint (see [Building Footprints](#building-footprints)), step 3 materializes buildings in two passes with rollback:

- **Pass 1** — materialize each entrance on cleared ground (GRASS or DIRT, `BUILDING_GRASS_CHANCE = 0.4`), snapshotting the prior tile state (`base`, `structure`, `path`, `building`, `fortifyLevel`, `footprintHexes`, `buildingFootprintOf`) for possible rollback.
- **Pass 2** — claim one footprint per entrance via `pickFootprintNeighbor()` and write the `buildingFootprintOf` back-pointer. If a building is wedged with **no eligible neighbour** (river/edge/other buildings on all sides), the whole placement is **rolled back** from its snapshot and dropped — rolled-back placements are filtered out (and removed from their village group) **before** the road network is generated, so roads never route to a building that no longer exists.

The MST router treats footprints as a soft obstacle (`FOOTPRINT_ROAD_PENALTY = 50` in `bfsPath`) rather than a hard block, so roads detour around building footprints when a cheaper path exists but can still cross one if forced.

### Shared Road Builder (`src/road-network.js`)

The MST road logic used to be duplicated in `src/map.js` (the procedural generator) and in the hand-rolled campaign map builders. The genuinely shared primitives now live in `src/road-network.js`:

- `buildMST(nodes)` — Kruskal's minimum spanning tree over a list of `{col,row}` nodes, weighted by hex distance.
- `placeRoadPath(tiles, path, roadTiles, opts)` — lay a single BFS path onto the tile map: GRASS/DIRT/FOREST → ROAD, optionally RIVER → BRIDGE (up to a budget), recording symmetric `roadDirs` links between consecutive tiles.
- `buildRoadNetwork(tiles, nodes, rand, maxBridges)` — the simple MST-over-nodes composition (Kruskal → BFS per edge → convert crossed RIVER tiles to BRIDGE) used by the bespoke mission maps.

`map.js` keeps its own two-tier orchestration (spokes/trunk, pre-selected river crossings, redundant-edge skipping) but composes it from these primitives. The two original copies were *materially different algorithms* (map.js routes with `blockRiver=true` and pre-places bridges at chosen crossings; the campaign builder routes with `blockRiver=false` and converts whatever RIVER tiles a path crosses into bridges) — the module preserves **both** behaviours so map output stays byte-for-byte identical at each call site.

### Campaign Mission Maps (`src/campaign/mission-map.js`)

Campaign missions no longer build their maps with bespoke imperative `buildXMap()` functions. `buildMissionMap(mapDef)` turns a declarative `map` sub-object (from a JSON mission def — see [07-data-persistence.md](07-data-persistence.md#json-mission-format-offlinecampaign)) into the same shape `generateMap()` returns: `{ tiles, heroStart, witchStart, witchObjectives, mapSize, survivorCounts, cols, rows }`. Two modes:

- **`handmade`** — a full explicit tile list (a lossless snapshot of a bespoke map). Starts from a grass grid, then field-merges each tile def (enum strings resolved to enum values, `roadDirs` array → `Set`). Derived `roadDirs` are persisted in the def, so roads load **without** a regen.
- **`procedural`** — a seeded `generateMap()` base plus an `overlay` that replaces individual tiles, edits the road-node set, and applies start / hidden-survivor / objective deltas. After the overlay, roads are **re-derived** from the node set via `rederiveRoads()`.

**Road-graph model.** The source of truth for connectivity is the **road-node set**. Buildings and bridges are *implicitly* nodes (unioned in last, so an over-eager `remove` can never strip a structural node); the overlay's `roadNodes.add`/`remove` toggle extra waypoints. Roads (`ROAD`/`BRIDGE` tile types + `roadDirs`) are *derived*. `rederiveRoads()` clears existing ROAD tiles back to GRASS, keeps BRIDGE crossings, and lays a fresh MST over the node set.

> **Divergence from the design doc, documented as built:** the runtime road regen (`rederiveRoads`) uses a **flat MST over all nodes** (`buildMST` + `placeRoadPath` with `convertRiverToBridge:false`), *not* map.js's two-tier spoke/trunk model. It creates no new bridges, so bridges only ever sit over the river crossings the base map already placed. This is aesthetic-only and intentional. It also means handmade maps persist their derived `roadDirs` losslessly (no load-time regen), while procedural maps re-derive on every build.

### Mission Editor (`/admin/tools`)

The data-driven format is authored through the **Caleb's Hollow Tools** page (`admin-tools.html`, served at `/admin/tools`), a tabbed shell with **Assets | Lighting | Mission Editor** tabs (each canvas lazy-inits on first activation). The Mission Editor uses the same 2D `Renderer` the game uses:

- `src/tools/mission-editor.js` — the DOM-free controller: owns the working `mapDef`, the sibling `enemyUnits` list, and the `meta` block (everything else in the mission JSON); exposes pure tool functions (`paintTile`, `setBuilding`, `togglePowerNode`, `regenerateHandmadeRoads`, …), an undo stack, and `assembleMission`/`populateFromMission` (lossless inverses).
- `src/tools/mission-editor-ui.js` — the canvas + palette wiring (click → `renderer.canvasToHex` → tool → redraw) and the authoring forms. A **"Preview in 3D"** button hands the built `GameState` to `Renderer3D`.

Authored JSON is validated through `loadMissionJSON` before download. See [07-data-persistence.md](07-data-persistence.md#json-mission-format-offlinecampaign) for the schema and loader, and [docs/design/campaign-mission-editor.md](design/campaign-mission-editor.md) for the full spec.

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
