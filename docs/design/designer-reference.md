# Brimstone — Designer Reference

A reference for game/mission designers. Everything here can be done by editing
data files and small content modules — **no changes to core engine code (game.js,
actions.js, resolver.js, state-sync.js, renderer.js) are required**.

If a section says "core code change required", that's a flag that the design
needs to be reshaped into one of the data-driven hooks below, OR raised as a
real engineering ticket.

---

## 1. The seven content registries

All content lives in seven flat data files. Add an entry, the engine picks it up.

| File | What it defines | Add by |
|------|------------------|--------|
| `src/content/survivors.js` | Survivor roster (named NPCs) | Append to `SURVIVOR_ROSTER` |
| `src/items.js` | Weapons & equippable items | Append to `ITEMS` |
| `src/abilities.js` | Survivor / leader abilities | Append to `ABILITIES` |
| `src/effects.js` | Time-bound buffs/debuffs | Append to `EFFECTS` |
| `src/unit-types.js` | Per-unit stats, tags, agility, range | Append to `UNIT_TYPES` |
| `src/factions.js` | Factions (Hero, Witch, Rogue…) | Subclass `Faction`, register |
| `src/loot.config.js` | Building & terrain loot tables | Edit weights / add lines |

Combat resolution, pathfinding, serialization, plan-action validation, AI, and
rendering all consume these registries — adding an entry never requires
touching `actions.js` or `resolver.js`.

---

## 2. Survivors

Append to `SURVIVOR_ROSTER` in `src/content/survivors.js`:

```js
{
  name: 'Eliza Stone',
  title: 'Mason',
  bio: 'Cut stone blocks by hand until the world ended.',
  maxHp: 5, attack: 2, defense: 2,
  ability: SurvivorAbility.FORTIFY_DOUBLE,
  abilityLabel: 'Mason — fortifies a building to full strength with just Wood',
}
```

Stats are **pre-passive**: if `ability` is `BRAWLER` (+1 ATK) or `STURDY`
(+1 DEF), write the un-baked number — `Entity.getAttack()` / `getDefense()`
compose the passive at call time.

The hidden-survivor system on the map draws random entries from this roster.
Discovery is gated by `state.maxDiscoverableSurvivors` (per-mission cap) and
the faction's `canDiscoverNPCs()` check.

`SURVIVOR_COLORS` — distinct unit-circle / plan-arrow colours. Add a new
hex code if the roster grows beyond the existing palette.

---

## 3. Items (weapons, equipment)

Append to `ITEMS` in `src/items.js`:

```js
spear: {
  id: 'spear',
  kind: 'weapon',         // 'weapon' currently the only kind
  slot: 'weapon',         // entity.weapon slot
  category: 'melee',      // 'melee' | 'ranged' — gates per-faction
  statMods: { attack: 1, defense: 1 },
  label: '🗡 Spear (+1 ATK, +1 DEF)',
}
```

### Conditional bonuses (combat triggers)

```js
combatTriggers: [
  { when: 'attack', ifDefenderHasAnyTag: ['construct'], advantage: 1 },
]
```

Trigger fields:
- `when`: `'attack'` (item-holder is attacking) or `'defend'`
- `ifDefenderHasAnyTag` / `ifAttackerHasAnyTag`: matches against
  `UNIT_TYPES[type].tags` of the opposing entity
- `advantage`: extra advantage dice; `flat`: flat damage modifier

Common tags to target: `'living'`, `'undead'`, `'construct'`, `'minion'`,
`'summoned'`, `'leader'`, `'soldier'`, `'day-leader'`, `'night-leader'`.

### Wiring up to loot

After adding an item, give it a place to drop in `src/loot.config.js`. Without
a loot-table entry, the item exists but nothing in the world spawns it.

---

## 4. Abilities

Append to `ABILITIES` in `src/abilities.js`. Three kinds:

### Passive with stat bonus

```js
{ id: 'eagle_eye', kind: 'passive',
  label: 'Eagle Eye', description: '+1 attack range',
  statMods: { range: 1 } }    // composed by Entity.getRange()
```

Available stat fields: `attack`, `defense`, `range`, `agility`.

### Passive with trigger

```js
{ id: 'berserker', kind: 'passive',
  label: 'Berserker', description: 'Frenzy after 2nd kill',
  triggers: [
    { on: 'kill', condition: 'killsThisRound>=2', apply: 'frenzied' },
  ] }
```

Trigger events: `'kill'`, `'damaged'`, `'damaged-fatal'`, `'round-end'`.
`condition` is either a small DSL (`field op number`) or a JS predicate
function `(actor, payload) => bool`. `apply` names an effect from `EFFECTS`.

### Active

```js
{ id: 'heal', kind: 'active',
  label: 'Heal', description: 'Heals leader on same hex',
  validate(state, actor) { ... return bool },
  execute(state, actor)  { ... return { success, log, cost, budgetBonus? } },
}
```

`validate` decides whether the action button shows up (called by
`_buildAbilityActions`). `execute` runs at plan-resolution. Return a `cost` in
action points (or `0` for free actions); return `budgetBonus: N` to grant the
leader N extra actions this turn.

Some passives (HERBALIST, FORTIFY_DOUBLE, SCOUT) live as inline gates at the
call site rather than via hooks — when in doubt, follow the existing pattern
of the closest analogue.

---

## 5. Effects (buffs / debuffs)

Append to `EFFECTS` in `src/effects.js`. Effects are time-bound; abilities are
permanent. Use effects for "wounded for 3 rounds", "inspired this turn",
"cursed for the rest of the mission".

```js
poisoned: {
  id: 'poisoned',
  label: 'Poisoned', icon: '☠',
  description: '−1 DEF; takes 1 damage at end of round',
  statMods:    { defense: -1 },         // composed via Entity getters
  damageMods:  { takenFlat: 1 },        // +N to incoming damage
  combatMods:  { incomingAtkAdvantage: 1 }, // attackers get +1 advantage
  rangeMod:    1,                       // +N to attack range
  blocksActions: true,                  // stunned-style
  blocksHeal:    true,                  // cursed-style
  onRoundEnd:    'damageOne',           // tick DOT (× stacks)
  defaultDuration: 3,                   // number | 'mission' | 'permanent'
  triggers: [ ... ],                    // same shape as ability triggers
}
```

### Duration semantics
- **Number** — decrements at end of round, drops at 0
- `'mission'` — persists till mission ends, dropped at next deployment
- `'permanent'` — never expires; campaign-persisted; prefer pushing onto
  `entity.abilities[]` for truly permanent traits

### Applying effects from elsewhere

```js
import { applyEffect } from './effects.js';
applyEffect(target, 'wounded');                          // default duration
applyEffect(target, 'poisoned', { duration: 5, source: actor });
applyEffect(target, 'inspired', { stack: true });        // stack instead of refresh
```

Triggers (`apply: 'wounded'`) call this for you.

---

## 6. Unit types

Append to `UNIT_TYPES` in `src/unit-types.js`:

```js
soldier: {
  baseStats: { maxHp: 2, attack: 1, defense: 1 },
  agility: 5,
  range: 1,                       // 1 = melee; >1 = ranged
  projectileType: 'bolt',         // animation key (ranged only)
  color: '#3f78c4',
  tags: ['living', 'soldier', 'summoned'],
}
```

Then, for a *new* unit type, add 4 places (mostly mechanical):

1. `EntityType` constant in `src/entities.js`
2. Factory function (e.g. `createSoldier(col, row, ownerId, state)`)
3. Glyph entry in the three `GLYPHS` maps (`src/ui.js`)
4. Glyph case in `src/renderer.js`'s `entityGlyph` switch

Combat, pathfinding, serialization, AI, and plan validation flow through the
generic machinery — no `actions.js` / `resolver.js` / `state-sync.js` edits.

For *new variants of an existing unit* (e.g. an "elite zombie" with stat
overrides), don't add a unit type — use mission `enemyUnits[].overrides` (§9).

### Tags — the contract

Tags are how items, abilities, and effects target unit kinds without needing
to know specific types. Pick tags that describe the unit semantically:

| Tag | Semantic |
|-----|----------|
| `living` | Vulnerable to attrition, can be healed |
| `undead` | Staff advantage; raised from dead |
| `construct` | Golems; immune to bleeding/poison narratively |
| `minion` | Summoned witch unit |
| `summoned` | Any summoned unit (minion, golem, soldier) |
| `leader` | Faction leader; scatter rule applies on death |
| `day-leader` / `night-leader` | Side-specific leader behaviours |
| `soldier` | Day-side summoned grunt |

Add new tags freely — just decide if any combat trigger / AI filter should
read them.

---

## 7. Factions

Subclass `Faction` (or `HeroFaction` / `WitchFaction` for stubs) in
`src/factions.js`, register, and add a leader factory.

Minimal stub:

```js
export class CaptainFaction extends HeroFaction {
  get id()         { return 'captain'; }
  get name()       { return 'Captain'; }
  get leaderType() { return EntityType.CAPTAIN; }
  isStub()         { return true; }
  _buildLeader(col, row, ownerId, state) {
    return createCaptain(col, row, ownerId, state);
  }
}
```

Then:
1. Instantiate and add to `FACTIONS` in `factions.js`
2. Add a leader factory in `src/entities.js` (and a `UNIT_TYPES` entry)

### The Faction hooks you can override

A faction is a behaviour palette. Override only what differs from the
side default. Highlights:

| Hook | Purpose |
|------|--------|
| `actionCap`, `unitBonusCap`, `baseBudget`, `isFavorablePhase` | Action economy |
| `canFortify`, `canSummon`, `canUseItems`, `canAssaultFortifications`, `isBlockedByWalls` | Available action gates |
| `getSummonOptions(inv)` | Summonable units & their costs |
| `getPhaseCombatBonus(phase)`, `getDefenseFatigue(n)` | Combat modifiers |
| `applyEndOfRoundEffects(state)` | Healing, spawns, attrition |
| `createDiscoveryEntity` / `buildDiscoveryResult` | What's behind a hidden tile |
| `canEquipHorse`, `canEquipWeapon`, `canEquipWeaponItem(id)` | Gear gates |
| `canExplore(entity)`, `canDiscoverNPCs()` | Explore semantics |
| `getStartingResources()` | Inventory at game start |
| `modifyLootRoll`, `applyExploreLootBonus` | Per-faction loot mods (rogue's reroll, agility bonus) |
| `onAfterMoveStep(state, actor, col, row)` | Post-move hook (rogue's auto-reveal) |
| `getSightRange(phase, hasScout)` | Fog-of-war range |
| `innateLeaderAbilities` | Ability ids automatically pushed onto leaders |
| `getPersonalities()`, `getAINamePool()` | AI registry & names |

Each existing faction is a working example — `RogueFaction` shows the most
distinct overrides (range, melee ban, sight bonus, on-move reveal).

---

## 8. Loot tables

`src/loot.config.js` — buildings and terrain. Weights are relative integers.

```js
blacksmith: [
  { type: 'sword',  weight: 20 },
  { type: 'metal',  weight: 26 },
  { type: 'nothing', weight: 5 },
]
```

Valid `type` strings:
- Resources: `wood`, `metal`, `herbs`, `food`, `silver`, `scripture`
- Weapons: any id in `ITEMS` (kind=weapon)
- Special: `horse`, `nothing`

Buildings keyed by `BuildingType`; terrain keyed by `TileType`
(`grass` | `forest` | `road`).

### Per-mission loot overrides

Set `lootOverrides` on a mission def (§9):

```js
lootOverrides: {
  remove: ['horse'],                      // strip from every table
  buildings: {
    barn: [{ type: 'wood', weight: 60 }, // full table override
           { type: 'food', weight: 35 },
           { type: 'nothing', weight: 5 }],
  },
}
```

`remove` filters every default table; `buildings.<key>` / `terrain.<key>`
fully replace a single table.

---

## 9. Missions

A mission is one entry in a campaign's `MISSIONS` array. The mission def is
read by `src/main.js` and `src/campaign/campaign.js` to assemble victory
delegates, wave processors, and pre-placed enemies.

### Mission schema (every field optional except `id`, `mapBuilder`, `objectives`)

```js
{
  id:       'first_night',
  title:    'The First Night',
  chapter:  1,
  briefing:    'Story text shown before mission starts.',
  victoryText: 'Shown on win.',
  defeatText:  'Shown on loss (or null for unlosable).',

  // ── Map ─────────────────────────────────────────────────
  mapBuilder: 'first_night',          // key into campaignDef.mapBuilders
  mapSize:    'standard',             // skirmish|standard|regional|campaign|battle|tutorial

  // ── Phase cycle (overrides the default DAWN/DAY/DUSK/NIGHT loop) ─
  phaseCycle: {
    phases: ['dusk','night','night','night','night','night','dawn'],
    loop: false,                      // false = phase clamps to last entry
    extraScoringPhases: ['night'],    // bonus scoring checkpoints
    extendOnWitchScore:  ['night'],   // each witch score appends another phase
  },

  // ── Faction / AI ────────────────────────────────────────
  hasWitch:        true,              // false = no witch leader spawned
  disableScoring:  true,              // turn off dawn/dusk node scoring entirely
  disableNodeSweep: true,             // 3-of-3 node sweep no longer auto-wins
  disableScoreWin:  true,             // first-to-N points win disabled
  isTutorial:      false,             // suppresses fog & some UI
  aiPersonality:   'aggressive',      // see §10
  heroPersonality: 'witch_hunter',    // headless-only override (campaign UI ignores)
  aiBudgetBonus:   2,                 // +N to witch's per-turn action budget

  // ── Pre-placed forces ───────────────────────────────────
  enemyUnits: [
    { type: 'zombie', col: 6, row: 3 },
    { type: 'wood_golem', col: 5, row: 4,
      overrides: { maxHp: 2, hp: 2, attack: 1, defense: 1 } },
  ],

  // ── Waves (triggered reinforcements) ────────────────────
  waves: [
    { round: 3, units: [{ type: 'zombie', spawnAt: 'graveyard' }] },
    { id: 'golem-awakens', trigger: 'hero_kills', count: 3,
      units: [{ type: 'wood_golem', spawnAt: 'near_hero',
                spawnLog: '🗿 A golem lurches out!' }] },
    { id: 'witch-flees', trigger: 'area',
      hexes: [{ col: 9, row: 6 }, ...],
      units: [{ type: 'wood_golem', spawnAt: { col: 11, row: 6 } }] },
  ],

  // ── Hero party / roster ─────────────────────────────────
  maxSurvivorsFromRoster:   2,        // pull from campaign roster
  missionSurvivors:         1,        // spawn this many fresh roster picks
  minSurvivors:             2,        // auto-fill if below
  maxSurvivors:             5,        // auto-cull if above
  maxDiscoverableSurvivors: 1,        // hidden-tile cap
  survivorStartPositions: [           // override neighbor-of-hero default
    { col: 3, row: 6 }, { col: 1, row: 6 },
  ],

  // ── Resources / rewards / healing ───────────────────────
  startingResources: { wood: 3, metal: 1 },
  rewards:           { wood: 2, metal: 1, food: 2 },   // applied on win
  healBonus:         3,                                 // +N HP to party post-mission

  // ── Loot overrides (§8) ─────────────────────────────────
  lootOverrides: { remove: ['horse'], buildings: { barn: [...] } },

  // ── Story triggers (one-shot dialogs) ───────────────────
  storyTriggers: [
    { type: 'round', round: 1, title: 'Darkness Falls',
      text: '...', flag: 'first_night_start' },
    { type: 'area', hexes: [{ col: 4, row: 7 }],
      title: 'Sanctuary', text: '...', flag: 'found_apothecary' },
    { type: 'round', round: 4, condition: notHoldingAllNodes,
      title: 'The Hour Wears On', text: '...', flag: 'remind_4' },
  ],

  // ── Win / lose conditions (§11) ─────────────────────────
  objectives: { win: {...}, lose: {...} },

  // ── Progression ─────────────────────────────────────────
  requires: ['gathering_survivors'],  // prereq mission ids
}
```

### Spawn-position descriptors (`spawnAt`)

| Descriptor | Behaviour |
|------------|-----------|
| `{ col, row }` | Exact hex |
| `'graveyard'` | Random graveyard tile |
| `'map_edge'` | Random passable outer-edge tile |
| `'near_hero'` | Annulus 2–3 hexes from hero (fallback 1–4) |

### Wave triggers

| Trigger | Fires when |
|---------|-----------|
| `round: N` | Round N reached (default if no `trigger:` field) |
| `trigger: 'hero_kills', count: N` | Once, when `state.heroKills` ≥ N |
| `trigger: 'area', hexes: [...]` | Once, when hero stands on any listed hex |

`id` is the dedup key for one-shot triggers — set it explicitly when stacking
similar waves so they don't fire the same trigger twice.

### Story triggers — the same shape, but for narrative dialogs

`storyTriggers[]` use the same `type: 'round'` / `type: 'area'` shapes plus an
optional `condition: (state) => bool` predicate (the flag is only consumed
when the predicate passes — so a reminder can fire on a later round if the
condition wasn't met earlier).

---

## 10. AI personalities

Two registries — `WITCH_PERSONALITIES` and `HERO_PERSONALITIES` — keyed by
config name. Add an entry to `PERSONALITY_CONFIGS` (witch, in `ai-engine.js`)
or `HERO_PERSONALITY_CONFIGS` (hero, in `hero-ai-engine.js`):

```js
node_denier: Object.freeze({
  goalWeights: Object.freeze({
    [HeroGoal.EXPLORE]:       0.3,
    [HeroGoal.CONTROL_NODES]: 2.2,
    [HeroGoal.PROTECT_HERO]:  0.4,
    [HeroGoal.HUNT_WITCH]:    0.2,
  }),
  engageFloor:     'suicidal',          // 'favorable' | 'unfavorable' | 'suicidal'
  shelterThreshold: 0.15,
  fortifyCapDay:    1,
  fortifyCapNight:  2,
  campaignOnly:     true,                // hides from balance grid
}),
```

Witch goals: `BUILD_ARMY`, `CONTROL_NODES`, `DEFEND_WITCH`, `HUNT_HEROES`.
Hero goals: `EXPLORE`, `CONTROL_NODES`, `PROTECT_HERO`, `HUNT_WITCH`.

Reference missions in `aiPersonality` / `heroPersonality` by config name.
`campaignOnly: true` keeps the personality out of the `ai-matrix.js` balance
grid (use it for asymmetric, mission-specific behaviours).

---

## 11. Win / lose conditions

`objectives.win` and `objectives.lose` are each a single condition object or
an array. **Lose conditions are checked first**; first match wins (within
each list).

### Win conditions

| `type` | Triggers when |
|--------|---------------|
| `eliminate_all` | All enemies of `targetFaction` (default `'witch'`) dead |
| `survive_rounds` | `state.round > rounds` |
| `reach_hex` | Hero on `{col, row}` |
| `slay_witch` | Witch faction eliminated |
| `gather_and_survive` | ≥ `survivors` survivors AND (≥ `kills` heroKills OR phase = `phaseFallback`) |
| `survive_with_party` | Phase = `phase` AND ≥ `survivors` survivors |
| `all_party_at_hexes` | Every living hero-faction party member on a listed `hexes[]` entry |
| `witch_denied_nodes` | Phase = `phase` AND witch holds 0 power nodes |
| `hero_holds_all_nodes` | Phase = `phase` AND hero holds every node |
| `control_nodes` | Defers to standard scoring |
| `conductor_complete` | Defers — used by tutorial conductor missions |

### Lose conditions

| `type` | Triggers when |
|--------|---------------|
| `hero_killed` | Hero faction eliminated |
| `rounds_exceeded` | `state.round > rounds` |
| `phase_without_survivors` | Phase = `phase` AND survivors < `survivors` |
| `survivors_below` | Survivor count < `count` (any time) |
| `witch_holds_node` | Phase = `phase` AND witch holds ≥ 1 node |
| `witch_score_threshold` | `state.nodeScore.witch ≥ points` |

Every condition takes an optional `reason` (display string).

Adding a new condition is a small core-code edit — `_checkWinCondition` /
`_checkLoseCondition` in `src/campaign/campaign.js`. Prefer composing
existing conditions where possible.

---

## 12. Maps

Two ways to build a map.

### A) Procedural — `src/map.js`

`MAP_SIZES` defines `skirmish` (9×9), `standard` (13×13), `regional` (17×17),
`campaign` (21×21), `battle` (42×42), and `tutorial`. Configurable per size:
`cols/rows`, `villages[]`, `forestSeeds[]`, `nodeCount{Min,Max}`,
`survivorCounts`, `bridgeMax`, `minBridges`. Use these for sandbox / non-story
games.

### B) Hand-built mission map — a function in `campaigns/<campaign>.js`

Mission map builders return:

```js
{
  tiles,                    // Map<"col,row", Tile>
  witchObjectives,          // [{ col, row, label, hexes[], color, seenByHero, seenByWitch, prevCtrl }]
  heroStart,                // {col, row}
  witchStart,               // {col, row}
  mapSize,                  // budget profile, even for hand-built maps
  survivorCounts,           // { buildings, terrain }
  cols, rows,
  noWitch,                  // optional — suppresses witch spawn
  targetHex,                // optional — for reach_hex displays
}
```

Helpers in `calebs-hollow-prologue.js` are copy-paste building blocks:
`makeTiles`, `setBuilding`, `setResource`, `setHiddenSurvivor`, `carveRiver`,
`growForests`, `scatterDirt`, `buildRoadNetwork`. Use a fixed `rng(seed)` for
deterministic layouts.

Register the builder in the campaign def's `MAP_BUILDERS` map and reference
it by key in the mission's `mapBuilder` field.

---

## 13. Tutorials & guided missions — the MissionConductor

For step-by-step guided missions, set `conductorSteps` and `conductorConfig`
on the mission def. The MissionConductor (`src/mission-conductor.js`) drives
a tooltip overlay that gates progression on player actions, blocks the
submit button until expected steps are reached, and supplies a scripted
opponent plan.

### Step shape

```js
{
  id: 'select-hero',
  title: 'Your Hero',
  body: 'Click the ⚔ Paladin to select him.',
  trigger: { type: 'entity_selected', entityType: EntityType.PALADIN },
  spotlight: { type: 'hex', col: 2, row: 7 },
  tooltipPos: 'bottom-right',
}
```

### Triggers (how a step advances)

| `trigger` | Advances when |
|-----------|---------------|
| `'click'` | Player clicks "Got it →" |
| `'auto'` | After resolution + ~900ms |
| `'complete'` | Final-step button (label via `buttonLabel`) |
| `{ type: 'entity_selected', entityType }` | Player selected that unit type |
| `{ type: 'action_queued', actionType }` | Plan queued matching `PlanActionType` |
| `{ type: 'plan_submitted' }` | Plan submitted (also unblocks submit) |

### Spotlights

```js
spotlight: { type: 'hex',     col, row }                       // hex glow
spotlight: { type: 'element', selector: '#plan-tab', arrow: 'up' } // CSS+arrow
```

### Conductor config (passed via `mission.conductorConfig`)

```js
{
  roundStepMap: { 0: 'welcome', 1: 'after-round-1' },     // jump on planning start
  witchPlanProvider: (round, state, currentStep) => PlanAction[],
  forcedDice: [{ round: 2, dice: [6, 1] }],               // deterministic battles
  maxPlanningRounds: 3,                                   // stop entering planning after N
}
```

A complete worked example lives in `src/tutorial/tutorial-config.js`. The
Prologue campaign (`src/campaign/campaigns/prologue.js`) wires it into a
single mission with `isTutorial: true` and `objectives.win: { type:
'conductor_complete', ... }`.

---

## 14. Campaigns

A campaign is a single-default-export object in `src/campaign/campaigns/`:

```js
export default {
  id: 'calebs_hollow_prologue',
  title: "Chapter 1 — Welcome to Caleb's Hollow",
  description: '...',
  missions: MISSIONS,
  mapBuilders: MAP_BUILDERS,           // { mapBuilderKey: () => mapData }
  firstMission: 'prologue',
  prerequisiteCampaign: null,          // gates the whole chapter
};
```

Then add to `CAMPAIGNS[]` in `src/campaign/campaign-registry.js`. Save data
versioning lives in `Campaign.SAVE_VERSION` — bump it and add a `_migrate`
case if you change save shape (e.g. inserting a new mission between existing
ones).

### Mission progression
- `mission.requires: ['prereq_id', ...]` — gates the mission until prereqs done
- Default progression is `getNextMission()` — first unlocked, uncompleted mission
- Permadeath: dead deployed survivors are removed from the roster on win

### Carry-over between missions
- Hero stats (`hp`, `weapon`, `items`) — auto-carried
- Resources — auto-carried, plus `mission.startingResources` and `mission.rewards`
- Roster (alive survivors with their items / effects-with-`'permanent'`-duration)
- `storyFlags` — set by triggers; readable by future mission triggers via
  `condition: (state) => state.storyFlags?.foo`

---

## 15. Post-round effects pipeline

Every round, after plan resolution and before victory check, a registered
chain of post-round effect functions runs (`src/post-round-effects.js`). Two
shipped: `night-attrition` (survivors caught outside take cycle-scaled
damage) and `status-effects` (DOT ticks + duration decrement).

### Adding a new post-round effect

```js
import { registerPostRoundEffect, PostRoundEventType } from './post-round-effects.js';

registerPostRoundEffect('blood-moon', (state) => {
  if (state.cycle < 3) return [];
  return state.entities.filter(e => e.alive && e.owner === 'witch')
    .map(e => ({
      type: PostRoundEventType.DAMAGE, /* ... */
      text: `🌑 ${e.displayName} stirs under the blood moon.`,
    }));
});
```

Each effect returns a flat array of event objects. `text` is auto-logged.
Useful for: weather hazards, faction-wide buffs by cycle, scripted plot
ticks.

---

## 16. What you CAN'T do without core code changes

If your design needs any of these, it's a code ticket — flag it early:

- **New plan-action types** — `MOVE`, `BATTLE_*`, `EXPLORE`, `FORTIFY`,
  `SUMMON`, `USE_ITEM`, `EQUIP_WEAPON`, `USE_ABILITY`, `GUARD`, `SOUND_HORN`
  are the closed set. New verbs touch `planner.js`, `actions.js`,
  `resolver.js`, AI plan generators.
- **New objective / win-condition types** — extend
  `_checkWinCondition` / `_checkLoseCondition` in `campaign.js`.
- **New combat-trigger event types** — beyond `attack`/`defend` for items and
  `kill`/`damaged`/`damaged-fatal`/`round-end` for abilities.
- **New side beyond Day/Night** — `sides.js` is binary; multi-side requires
  rework.
- **Changes to fog-of-war rules, action budget formula, scoring cadence** —
  core engine.
- **New tile types** — terrain set is closed (`grass`, `forest`, `dirt`,
  `road`, `river`, `bridge`, `building`); a new type touches map gen,
  pathfinding, rendering, passability.

For everything else, the seven registries plus mission defs plus
MissionConductor cover it.

---

## 17. Quick reference — "where do I start?"

| I want to… | Start here |
|------------|-----------|
| Add a survivor | `src/content/survivors.js` |
| Add a weapon | `src/items.js` + `src/loot.config.js` |
| Add an ability | `src/abilities.js` (+ optionally a survivor entry) |
| Add a buff/debuff | `src/effects.js` |
| Add a unit type | `src/unit-types.js` + 4 plumbing edits (§6) |
| Add a mission | New entry in a campaign's `MISSIONS[]` |
| Add a campaign | New file in `src/campaign/campaigns/`, register in registry |
| Add a guided tutorial | `conductorSteps` + `conductorConfig` on a mission |
| Tune drop rates | `src/loot.config.js` (or `lootOverrides` per-mission) |
| Reskin a faction | Subclass `HeroFaction` / `WitchFaction`, register |
| Add an AI personality | `PERSONALITY_CONFIGS` in `ai-engine.js` or `hero-ai-engine.js` |
| Add a recurring round-end effect | `registerPostRoundEffect()` |

---

## 18. Validation checklist for new content

Before merging:

- [ ] `npm test` passes
- [ ] If gameplay-affecting: `node scripts/headless.js 500 standard` win
      rates within 38–62% target band
- [ ] If a new mission: walk through it once locally
- [ ] If a new unit/ability/effect: at least one test or simulation pass
- [ ] If saved-state shape changes: bump `SAVE_VERSION` and add a migration
- [ ] If touching online-mode-relevant fields: check `server/state-sync.js`
      serialization round-trips
