// Client-side save-game thumbnails.
//
// A 512×512 top-down, north-up board snapshot is captured at the END OF EACH
// ROUND (see renderer-3d `captureMapThumbnail` + main.js `_captureRoundThumbnail`)
// and stored here in localStorage, keyed by the game's row id (`room_id` — the
// same id the menu lists use). The ledger shows it wherever a saved game appears.
// Fully client-side — no server dependency.

import { fixedMissionImage } from '../campaign/mission-catalog.js';

const PREFIX       = 'brimstone-thumb-';
const STATS_PREFIX = 'brimstone-stats-';      // tiny round-end stats snapshot (online + local)
const INDEX_KEY    = 'brimstone-thumb-index';   // MRU-ordered ids, for pruning
const MAX_THUMBS = 24;                        // ~24 × <100KB JPEG keeps us well under quota

function _loadIndex() {
  try { return JSON.parse(localStorage.getItem(INDEX_KEY) || '[]'); } catch { return []; }
}
function _saveIndex(idx) {
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(idx)); } catch {}
}

/** Store a thumbnail (a data URL) for `id`, pruning the least-recently-saved
 *  beyond MAX_THUMBS. Survives a QuotaExceeded by dropping the oldest and
 *  retrying once. */
export function saveThumb(id, dataURL) {
  if (!id || !dataURL) return;
  let idx = _loadIndex().filter((x) => x !== id);
  idx.unshift(id);
  while (idx.length > MAX_THUMBS) {
    const drop = idx.pop();
    try { localStorage.removeItem(PREFIX + drop); } catch {}
    try { localStorage.removeItem(STATS_PREFIX + drop); } catch {}
  }
  try {
    localStorage.setItem(PREFIX + id, dataURL);
  } catch {
    // Out of space — evict the oldest thumbnail and try once more.
    const drop = idx.pop();
    if (drop) { try { localStorage.removeItem(PREFIX + drop); } catch {} }
    try { localStorage.setItem(PREFIX + id, dataURL); } catch { _saveIndex(idx); return; }
  }
  _saveIndex(idx);
}

/** Return the stored thumbnail data URL for `id`, or null. */
export function loadThumb(id) {
  if (!id) return null;
  try { return localStorage.getItem(PREFIX + id); } catch { return null; }
}

/** Forget the thumbnail for `id` (call when its save is deleted). */
export function deleteThumb(id) {
  if (!id) return;
  try { localStorage.removeItem(PREFIX + id); } catch {}
  try { localStorage.removeItem(STATS_PREFIX + id); } catch {}
  _saveIndex(_loadIndex().filter((x) => x !== id));
}

/** Store the round-end stats snapshot for `id` (round/phase/score/kills/participants/
 *  nodes) — the data the game-detail overlay needs for games whose state we don't
 *  keep locally (online). Pruned alongside the thumbnail. */
export function saveStats(id, stats) {
  if (!id || !stats) return;
  try { localStorage.setItem(STATS_PREFIX + id, JSON.stringify(stats)); } catch {}
}

/** Read the stored stats snapshot for `id`, or null. */
export function loadStats(id) {
  if (!id) return null;
  try { return JSON.parse(localStorage.getItem(STATS_PREFIX + id) || 'null'); } catch { return null; }
}

/**
 * Resolve the map image to show on a campaign mission card. An in-progress
 * mission has a live saved thumbnail (captured at round-end, keyed by its row id
 * `<campaignId>/slot<N>/<missionId>`) — show that, exactly like a skirmish. A
 * not-yet-started (or never-played) mission has no saved thumbnail, so fall back
 * to the mission's fixed pre-generated map image (a committed static asset). An
 * unknown mission still resolves to a deterministic `assets/mission-maps/<id>.png`
 * path (the browser <img>/CSS background simply renders nothing if it 404s) — the
 * caller never gets null, so a card always has an image source.
 *
 * @param {string} missionId — mission id (resolves the fixed image).
 * @param {string} rowId     — the campaign row id used to key the live thumbnail.
 * @returns {string} a data-URL (saved thumb) or an asset path (fixed image).
 */
export function missionThumb(missionId, rowId) {
  return loadThumb(rowId) ?? fixedMissionImage(missionId);
}
