# Brimstone Units / Items / Abilities Refactor

## Context

Today's implementation of unit stats, equipment, and abilities is scattered across many files. A quick audit found:

- **`Entity`** is a single class but per-type behavior is gated by type / leader checks in 15+ sites across `src/actions.js`, `src/factions.js`, `src/planner.js`, `src/ui.js`, `src/renderer.js`, `src/hero-ai-engine.js`, and the combat resolver itself.
- **Survivor stats** (`SURVIVOR_ROSTER`, `src/entities.js:85–249`) *replace* the base stats row, and passive abilities like BRAWLER (+1 ATK) and STURDY (+1 DEF) are **baked into the roster numbers** rather than applied at runtime. `BASE_STATS[SURVIVOR]` is dead data.
- **Weapons** have consistent basic bonuses via `WEAPON_STATS` (`src/tiles.js:48–64`), but the one conditional weapon effect (staff vs undead/minions/golems) is hardcoded inside `Entity.resolveCombat()` at `src/entities.js:432`.
- **Abilities** are a single string (`entity.ability`) per survivor. Each of the 8 abilities is referenced in 3–8 scattered sites. There is no unified ability abstraction — each ability is a one-off check at whatever phase consumes it.
- **Leader action gates** (`SOUND_HORN` day-side, `SUMMON` night-side) at `src/actions.js:334` and `:345` are double-layered: `isLeaderType(actor.type) && actor.owner === 'hero'|'witch'`. The `owner` string is the legacy pre-faction-expansion discriminator and is now redundant with faction data already on the entity (`factionId`) and actor-side.
- **Items** use mixed inventory keys (`'weapon:sword'`, `'silver'`, `'food'`, `'horse'`) and their effects are implemented in different files: silver in `executeUseItem`, food as `budgetBonus` return, horse in `planner.js`.

Adding a new survivor, weapon, or ability today requires edits in 4–10 files.

**Goal:** make unit types, equipment, and abilities data-driven so adding new content is a one-file change. Achieve the spirit of "everything is a unit; specials layer on top" through data composition rather than class inheritance.

## Relationship to faction expansion

The Day vs Night / N-factions-per-side refactor (`docs/design/faction-expansion.md`) landed the scaffolding for six factions (Paladin, Rogue, Captain, Witch, Necromancer, Brute) — but lists **"faction-unique abilities for Rogue/Captain/Necromancer/Brute"** as explicit follow-up, one per faction. Today the four stub factions inherit their parent side's behaviour wholesale because there's no per-faction extensibility point for "this leader can do X that that leader can't".

This refactor provides that extensibility point. Once `ABILITIES` is a registry and leaders carry `abilities: string[]`, a stub graduates by adding one entry to its `Faction.innateLeaderAbilities` getter plus (optionally) a new registry entry. No combat-resolver, action-dispatcher, or AI-engine edits required.

Calibration anchors (line numbers valid against `origin/dev` @ 7e23c9b):
- `EntityType.HERO` is a legacy alias for `PALADIN` — the plan uses `PALADIN` throughout. Save-format value is `'paladin'`; `SAVE_VERSION=2` migrates v1 `'hero'` → `'paladin'`. Phase 4 bumps to `SAVE_VERSION=3`.
- `state.swapLeaderToFaction(side, factionId)` (`src/game.js`) is the in-place leader-stats swap for stub factions. Post-refactor it becomes "re-read the `UNIT_TYPES` descriptor + refresh `abilities`" — data-driven, no per-faction if/else.

## Design

### Core entity
- Keep a single `Entity` class. Back it with a `UNIT_TYPES` registry (`src/unit-types.js`) keyed by `EntityType`, returning `{ baseStats: {maxHp, attack, defense}, agility, tags: ['undead'|'construct'|'living'|'leader'], innateAbilities: string[] }`.
- Entity constructor reads the descriptor; `BASE_STATS` and `BASE_AGILITY` tables move into it.
- Add `entity.tags` and `entity.hasTag(tag)` — replaces the hardcoded `ZOMBIE|MINION|WOOD_GOLEM|IRON_GOLEM` check in `resolveCombat`.

### Items (`src/items.js`)
One registry for every item:
```
{
  id, kind: 'weapon'|'consumable'|'mount'|'accessory',
  slot: 'weapon'|'mount'|null,
  statMods: { attack: +2, defense: 0, moveRange: 0, ... },
  grantsAbilities: string[],
  onUse: (state, actor) => ({ success, log, budgetBonus, cost }),   // consumables
  combatTriggers: [ { when, ifDefenderHasTag, advantage } ],        // weapons
  label,
}
```
- Absorbs `WEAPON_STATS` and `WEAPON_LABEL` from `src/tiles.js`.
- Staff's anti-undead bonus becomes `ITEMS.staff.combatTriggers = [{ when:'attack', ifDefenderHasTag:'undead', advantage:+1 }]`.
- Silver, food: `kind: 'consumable'` with `onUse` handlers.
- Horse: `kind: 'mount'`, `statMods: { moveRange: +1 }`. The `planner.js:278–282` horse check becomes `entity.getMoveRange()`.
- Inventory keys flatten: `'weapon:sword'` → `'sword'`. Kind comes from the registry, not the key.

### Abilities (`src/abilities.js`)
One registry for every ability (survivor, faction, or item-granted):
```
{
  id, label, kind: 'passive'|'active',
  statMods: { attack, defense, sightRange, moveRange, agility },
  onExplore|onFortify|... : (state, actor, ctx) => delta,           // passive hooks
  actionCost: 0|1, resourceCost: { food: 1 } | null,                // active
  targeting: 'self'|'leader-same-hex'|'adjacent-enemy'|null,
  validate: (state, actor) => boolean,
  execute: (state, actor, target) => ({ success, log, cost, budgetBonus }),
}
```
- `entity.ability: string` → `entity.abilities: string[]` (allows multiple).
- BRAWLER / STURDY / SCOUT become passive `statMods` entries. BRAWLER and STURDY un-bake from roster numbers — Thomas Putnam's base attack drops from 3 → 2, and the +1 is re-added via the passive at runtime. **Effective stats stay identical.**
- HERBALIST → passive with `onExplore: (s,a) => ({ items: { herbs: +1 } })`.
- FORTIFY_DOUBLE → passive with `onFortify: (s,a) => ({ levelMultiplier: 2 })`.
- HEAL / INSPIRE / RALLY → active entries; generic dispatcher in `executeUseAbility` iterates `actor.abilities` and delegates.
- **Faction-innate abilities:** add `Faction.innateLeaderAbilities` as an abstract getter. Default impls on `DaySideFaction` / `NightSideFaction` return `['sound_horn']` and `['summon']` respectively. Concrete per-faction classes (Rogue, Captain, Necromancer, Brute) override when they grow unique abilities; stubs inherit parent defaults. Leader constructors (`createLeader`) push the faction's innate abilities into `entity.abilities`. The `isLeaderType(actor.type) && actor.owner === 'hero'|'witch'` gates at `src/actions.js:334,345` **disappear** — action availability becomes `actor.hasAbility('sound_horn' | 'summon')`.

### Stat layer
Add getters on `Entity`:
- `getAttack()`, `getDefense()`, `getSightRange(phase)`, `getMoveRange()`, `getAgility()`.
- Each composes: `baseStat + sum(passive-ability statMods) + sum(equipped-item statMods) + transient (attackBonus|defenseBonus)`.
- `entity.attack`/`entity.defense` stay as the **immutable base stat** after construction. `equipWeapon` stops mutating them — it only sets `entity.equipped.weapon`.
- Keep using JS methods, not getter properties — `attackBonus` as a mutable field is the reason (getter conflict).

### What this buys
- Adding a new survivor: one entry in `src/content/survivors.js`.
- Adding a new weapon: one entry in `src/items.js`.
- Adding a new ability: one entry in `src/abilities.js` + (maybe) attaching it to roster entries.
- Adding a new unit type: one entry in `src/unit-types.js` + (maybe) a factory wrapper.
- Zero edits to `actions.js`, `resolver.js`, `ai-engine.js`, `hero-ai-engine.js`, `renderer.js`, `ui.js`, or combat logic for pure content additions.

## Migration phases

Each phase leaves tests green; each is an independent PR.

**Phase 1 — Registries (no behavior change).** Create `src/unit-types.js`, `src/items.js`, `src/abilities.js`. Populate from existing constants. Existing code still reads old tables. Existing `BASE_STATS` / `WEAPON_STATS` become re-exports from the new modules (bridge).

**Phase 2 — Stat getters; migrate readers.** Add `getAttack/Defense/SightRange/MoveRange/Agility` returning current values (parity). Migrate every `entity.attack` / `.defense` / `.ability === ...` / `.weapon === ...` read, subsystem by subsystem: `planner.js` → `actions.js` → `ai-engine.js` → `hero-ai-engine.js` → `renderer.js` → `ui.js` → `ui-render.js`. Add `entity.hasAbility(id)` / `entity.abilities` (initially wrapping the single `.ability` field).

**Phase 3 — Equipment becomes runtime composition.** `equipWeapon` stops mutating `attack`/`defense`; `getAttack()` composes from `ITEMS[equipped.weapon].statMods`. Staff-vs-undead moves from `resolveCombat` to `ITEMS.staff.combatTriggers`; `resolveCombat` iterates triggers. Add `entity.tags` + `hasTag('undead')`. Inventory keys flatten (`'weapon:sword'` → `'sword'`). `snapEntity` emits both raw and effective stats.

**Phase 4 — Abilities become multi + runtime passives.** Swap `ability: string` → `abilities: string[]`. Un-bake BRAWLER/STURDY from roster numbers (adjust base stats down by the passive amount). `_buildAbilityAction` becomes a loop over `actor.abilities`; `executeUseAbility` becomes a dispatcher to `ABILITIES[id].execute`. Audit every survivor's effective stats vs. today (`tests/entities.test.js`) — parity is required.

**Phase 5 — Faction-inherent abilities; collapse leader-type gates.** `DaySideFaction.innateLeaderAbilities → ['sound_horn']`; `NightSideFaction.innateLeaderAbilities → ['summon']`. Leader `createLeader()` pushes these into `entity.abilities`. Replace the two `isLeaderType(actor.type) && actor.owner === 'hero'|'witch'` checks at `src/actions.js:334,345` with `actor.hasAbility('summon' | 'sound_horn')`. SOUND_HORN / SUMMON executors become registry entries. The `FORTIFY`, `HEAL` plan action types stay (needed for wire compat) but their `execute*` becomes a one-line delegate to `ABILITIES[id].execute`.

**Phase 6 — Content expansion proof.** Split `SURVIVOR_ROSTER` into `src/content/survivors.js`. Add one new survivor and one new weapon end-to-end without editing `actions.js`, `entities.js`, or `resolver.js`. If the refactor worked, this is a one-file change per item. Update `CLAUDE.md` with a "how to add content" section.

## Save compatibility

Existing hibernated multiplayer saves store `attack: 3` for BRAWLER survivors (baked). Rather than writing a migration shim, **extend the incompatible-save pruner** in `server/saves.js` (`pruneStaleAndIncompatibleSaves`) to drop all saves produced before the refactor version bump. `SAVE_VERSION` bumps `2 → 3` with the Phase 4 PR (the one that un-bakes the stats); also bump `src/version.js`. Active multiplayer players lose in-progress games; acceptable per user decision.

## Files

**Create**
- `src/unit-types.js` — `UNIT_TYPES` registry
- `src/items.js` — `ITEMS` registry (absorbs `WEAPON_STATS`, `WEAPON_LABEL`)
- `src/abilities.js` — `ABILITIES` registry + `dispatchActive()`, `applyPassiveHooks()` helpers
- `src/content/survivors.js` — roster, moved from `src/entities.js`
- `tests/registries.test.js` — schema & parity check vs legacy tables
- `tests/stat-composition.test.js` — effective-stat math across abilities + items
- `tests/ability-registry.test.js` — active dispatcher + passive hooks
- `tests/item-registry.test.js` — combat-trigger iteration (staff vs undead, future triggers)

**Modify**
- `src/entities.js` — Entity class slimmed; `equipWeapon` no longer mutates base stats; stat getters; `tags`, `abilities[]`, `hasAbility`, `hasTag`; `resolveCombat` iterates item triggers
- `src/tiles.js` — remove `WEAPON_STATS`, `WEAPON_LABEL` (re-export from `items.js` for one release then delete)
- `src/actions.js` — drop type gates on SUMMON/SOUND_HORN; `_buildAbilityAction` loops `actor.abilities`; `executeUseAbility` dispatches via registry; `executeUseItem` dispatches via `ITEMS[id].onUse`
- `src/planner.js` — `snapEntity` emits effective stats; horse check via `getMoveRange()`; drop `EntityType` import if possible
- `src/factions.js` — add `innateLeaderAbilities` getter on `Faction` (abstract), default impls on `DaySideFaction` / `NightSideFaction`, overridable on concrete stubs (Rogue, Captain, Necromancer, Brute) when they grow unique abilities
- `server/state-sync.js` — flat inventory keys; `abilities[]` round-trip (no migration shim — old saves pruned)
- `server/saves.js` — extend pruner to drop pre-refactor saves
- `src/version.js` — bump in Phase 4 PR
- `src/hero-ai-engine.js`, `src/ai-engine.js` — ability checks via `hasAbility`; stats via getters
- `src/renderer.js`, `src/ui.js`, `src/ui-render.js` — stat displays use getters; ability labels from registry
- `server/resolver.js` — delegate `executeFortify` / `executeHeal` through ability registry

**Delete**
- Legacy `BASE_STATS`, `BASE_AGILITY`, `WEAPON_STATS`, `WEAPON_LABEL` re-exports after one release.

## Verification

After each phase:
1. `npm test` — all existing + new tests green.
2. `node scripts/combat-sim.js 200` — hit / crush / counter rates within ±1% of pre-refactor baseline (the one published in `CLAUDE.md`).
3. `node scripts/headless.js 500 standard` — Hero/Witch win rates stay within the 38–62% band; mean rounds within ±2 of 21.9.
4. `node scripts/headless.js 100 standard --players 2` — 2v2 parity check.
5. `node scripts/ai-matrix.js 50` — no personality pair swings >15% from baseline.

After Phase 5:
- Manual smoke: start an offline Hero-vs-AI game. Verify survivor abilities (SCOUT sight, HEAL action, RALLY +1 budget) all still work. Verify sound horn and summon still appear for their respective leaders.
- Manual online: start a 2v2 room, submit plans, confirm resolution is identical to pre-refactor behavior.

After Phase 6:
- The new survivor and new weapon appear in-game without any edits to `src/entities.js`, `src/actions.js`, or `server/resolver.js` in the diff. That is the acceptance criterion for the refactor.
