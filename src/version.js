// Single source of truth for the build version.
// Bump this with every commit.
export const VERSION = '1.3.32';

// Save format version — only bump when state-sync schema changes break
// compatibility with existing saves.  Unrelated patches/features keep the
// same SAVE_VERSION so in-progress games survive server restarts.
export const SAVE_VERSION = 1;

// Unique build identifier — appends Railway's commit SHA when deployed.
// Falls back to plain VERSION in local dev and in-browser (where process is
// undefined).  Save compatibility checks should always use VERSION (semver).
const _sha = (typeof process !== 'undefined' && process.env?.RAILWAY_GIT_COMMIT_SHA) || '';
export const BUILD_VERSION = _sha ? `${VERSION}+${_sha.slice(0, 8)}` : VERSION;
