// Single source of truth for the build version.
// Bump this with every commit.
export const VERSION = '1.3.9';

// Unique build identifier — appends Railway's commit SHA when deployed.
// Falls back to plain VERSION in local dev and in-browser (where process is
// undefined).  Save compatibility checks should always use VERSION (semver).
const _sha = (typeof process !== 'undefined' && process.env?.RAILWAY_GIT_COMMIT_SHA) || '';
export const BUILD_VERSION = _sha ? `${VERSION}+${_sha.slice(0, 8)}` : VERSION;
