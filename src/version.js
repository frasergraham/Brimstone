// Single source of truth for the build version.
// Bump this with every commit.
export const VERSION = '1.8.0';

// Save format version — only bump when state-sync schema changes break
// compatibility with existing saves.  Unrelated patches/features keep the
// same SAVE_VERSION so in-progress games survive server restarts.
//
// v2 (2026-04): EntityType.HERO renamed to PALADIN (value 'hero' → 'paladin').
//               state-sync deserialize re-keys old entities, so v1 saves
//               will hydrate cleanly, but a fresh SAVE_VERSION ensures any
//               consumer that bypasses the migration sees an explicit bump.
// v3 (2026-04): Phase 3 of the units/items/abilities refactor.
//               equipWeapon no longer mutates entity.attack / entity.defense
//               (the bonus composes at call time via ITEMS[weapon].statMods)
//               and weapon inventory keys flattened from 'weapon:sword' to
//               'sword'. Pre-v3 saves would double-count the weapon bonus on
//               reload and carry invalid inventory keys; they're pruned by
//               server.saves.pruneStaleAndIncompatibleSaves on boot.
// v4 (2026-04): Phase 4 of the units/items/abilities refactor.
//               Entity.ability (singular string) was promoted to
//               Entity.abilities (string[]) and the BRAWLER / STURDY
//               passives were un-baked from SURVIVOR_ROSTER base stats
//               (getAttack() / getDefense() compose the +1 from
//               ABILITIES[id].statMods at call time). Pre-v4 saves would
//               double-count the passive on reload and lack the new
//               abilities array; pruned on boot.
// v5 (2026-05): P1 of the layered tile-model refactor. Each tile snapshot now
//               carries explicit base/structure/path layers (in addition to the
//               derived `type`) so the new layer accessors (baseOf/pathOf/
//               structureOf) work on resumed tiles — required for road-over-
//               forest and the upcoming P2/P3/P4 readers. Pre-v5 saves lack the
//               layer fields; deserialize derives them from `type`, but per the
//               locked operator decision old in-flight online games are dropped
//               rather than shimmed, so the bump prunes them on boot.
// v6 (2026-05): P0/P1 of the building-footprint rework. Each tile snapshot now
//               carries footprintHexes (on entrances) + buildingFootprintOf (on
//               footprint hexes). Buildings become 2-hex compounds: a passable
//               entrance plus one impassable footprint hex. deserialize
//               auto-migrates pre-v6 saves (each building picks one eligible
//               adjacent hex deterministically), so old saves still hydrate —
//               the bump is a belt-and-braces signal for bypass consumers.
// v7 (2026-06): Phase 1 of the inventory refactor. The equipped weapon moved
//               from the top-level `weapon` string slot INTO `items`, tagged
//               `{ equipped: true }`, and backpack entries changed shape from
//               `{ id: count }` to `{ id: { count, equipped? } }`. The
//               denormalized `range` cache is gone (getRange() composes it).
//               deserialize auto-migrates pre-v7 saves (folds `weapon` into the
//               items dict, normalizes counts), so old saves still hydrate.
// v8 (2026-06): Phase 2 of the inventory refactor. The shared faction
//               inventories (state.inventory.hero/witch) flattened from a flat
//               `{ id: N }` numeric map to the SAME dict-of-objects shape as
//               entity backpacks and the campaign armory (`{ id: { count: N } }`),
//               so the entities.js item helpers operate on all three. deserialize
//               auto-migrates pre-v8 saves (normalizeItems folds numeric →
//               { count }), chaining after the v6→v7 entity migration.
export const SAVE_VERSION = 8;

// Unique build identifier — appends Railway's commit SHA when deployed.
// Falls back to plain VERSION in local dev and in-browser (where process is
// undefined).  Save compatibility checks should always use VERSION (semver).
const _sha = (typeof process !== 'undefined' && process.env?.RAILWAY_GIT_COMMIT_SHA) || '';
export const BUILD_VERSION = _sha ? `${VERSION}+${_sha.slice(0, 8)}` : VERSION;
