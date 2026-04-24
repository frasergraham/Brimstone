// Single source of truth for the build version.
// Bump this with every commit.
export const VERSION = '1.3.35';

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
export const SAVE_VERSION = 3;

// Unique build identifier — appends Railway's commit SHA when deployed.
// Falls back to plain VERSION in local dev and in-browser (where process is
// undefined).  Save compatibility checks should always use VERSION (semver).
const _sha = (typeof process !== 'undefined' && process.env?.RAILWAY_GIT_COMMIT_SHA) || '';
export const BUILD_VERSION = _sha ? `${VERSION}+${_sha.slice(0, 8)}` : VERSION;
