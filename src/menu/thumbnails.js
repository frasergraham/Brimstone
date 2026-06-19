// Client-side save-game thumbnails.
//
// A 512×512 top-down, north-up board snapshot is captured at the END OF EACH
// ROUND (see renderer-3d `captureMapThumbnail` + main.js `_captureRoundThumbnail`)
// and stored here in localStorage, keyed by the game's row id (`room_id` — the
// same id the menu lists use). The ledger shows it wherever a saved game appears.
// Fully client-side — no server dependency.

const PREFIX    = 'brimstone-thumb-';
const INDEX_KEY = 'brimstone-thumb-index';   // MRU-ordered ids, for pruning
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
  _saveIndex(_loadIndex().filter((x) => x !== id));
}
