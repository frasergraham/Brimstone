// Shared voiceover (spoken narration) audio: one mute concept across tutorial /
// hint narration AND campaign conversation dialog, plus a small play/stop
// helper both use.
//
// "Voiceover" here means spoken narration ONLY — muting it never touches the
// game's SFX or music (those live in audio.js). A single localStorage flag
// (`bs_voice_muted`) drives every 🔊/🔇 button, so the toggle on a conversation
// bubble and the one on the tutorial tooltip always agree. The state is read
// through to localStorage on every call (no cached copy) so buttons created at
// different times never disagree, and the one-time migration from the old
// tutorial-only key happens transparently.
//
// Browser-only effects degrade to no-ops under node/headless (no Audio, maybe
// no localStorage), so the module imports cleanly in tests.

const VOICE_MUTED_KEY = 'bs_voice_muted';
// Predecessor key (tutorial narration only) — read as a fallback so a player
// who muted narration before this unification stays muted.
const LEGACY_TUTORIAL_KEY = 'bs_tutorial_voice_muted';

function _get(key) {
  try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
}
function _set(key, value) {
  try { globalThis.localStorage?.setItem(key, value); } catch { /* private mode etc. */ }
}

/** True when spoken narration is muted. Read-through (no cached state). */
export function isVoiceMuted() {
  const cur = _get(VOICE_MUTED_KEY);
  if (cur != null) return cur === '1';
  return _get(LEGACY_TUTORIAL_KEY) === '1';   // migrate the old tutorial-only flag
}

/** Set the narration mute flag; stops any clip in flight when muting. */
export function setVoiceMuted(muted) {
  _set(VOICE_MUTED_KEY, muted ? '1' : '0');
  if (muted) stopVoice();
}

/** Flip the narration mute flag and return the new state. */
export function toggleVoiceMuted() {
  const next = !isVoiceMuted();
  setVoiceMuted(next);
  return next;
}

// The single narration clip in flight. Narration never overlaps itself —
// starting a new clip (or muting) stops the previous one.
let _current = null;

/** Stop whatever narration clip is currently playing. */
export function stopVoice() {
  if (_current) {
    try { _current.pause(); } catch { /* already stopped */ }
    _current = null;
  }
}

/**
 * Play one narration clip by URL. No-op (returns null) when muted, when Audio
 * is unavailable (node/headless), or with no URL. A missing file fails silently
 * via the error listener, so partial clip generation is always safe.
 * @returns {HTMLAudioElement|null}
 */
export function playVoiceClip(url) {
  stopVoice();
  if (isVoiceMuted() || typeof Audio !== 'function' || !url) return null;
  const audio = new Audio(url);
  audio.addEventListener('error', () => { /* missing clip = silent */ });
  _current = audio;
  audio.play?.().catch(() => { /* autoplay restriction before first gesture */ });
  return audio;
}

// ── Clip availability (the generated manifest) ──────────────────────────────────
//
// assets/voice/manifest.json lists every clip that was actually generated. The
// UI consults it so a 🔊/🔇 mute button only appears where there's narration to
// mute, and playback only requests clips that exist (no 404 churn). Until the
// manifest is loaded — or when there's no audio at all — every check returns
// false, so the safe default is "no audio".

let _clipIds = null; // Set<string> of generated clip ids, or null until loaded

/**
 * Load + cache the voice manifest (once). Browser-only fetch; resolves to an
 * empty set on any failure (no audio shipped) so callers never throw.
 * @returns {Promise<Set<string>>}
 */
export async function loadVoiceManifest(base = 'assets/voice') {
  if (_clipIds) return _clipIds;
  let obj = {};
  try {
    if (typeof fetch === 'function') {
      const res = await fetch(`${base}/manifest.json`);
      if (res.ok) obj = await res.json();
    }
  } catch { obj = {}; }
  _clipIds = new Set(Object.keys(obj));
  return _clipIds;
}

/** True when a specific clip id (e.g. "conv/ch1m1-intro/0") was generated. */
export function hasVoiceClip(id) {
  return !!_clipIds && _clipIds.has(id);
}

/** True when ANY line of a conversation has a generated clip. */
export function hasConversationVoice(convId) {
  if (!_clipIds) return false;
  const prefix = `conv/${convId}/`;
  for (const id of _clipIds) if (id.startsWith(prefix)) return true;
  return false;
}

/** Test/seed hook — set the cached clip-id set directly. */
export function setVoiceManifestIds(ids) {
  _clipIds = new Set(ids ?? []);
}

// ── Mute-button icon ────────────────────────────────────────────────────────────
//
// Monochrome inline SVG (inherits the button's text colour via currentColor) —
// unicode speaker symbols are emoji-presentation and render inconsistently. The
// muted variant is the same speaker with a diagonal slash through it. Shared by
// the conversation-card button and the tutorial-tooltip button so they match.
// Standard Material "volume_up" / "volume_off" 24px silhouettes.

const VOICE_ICON_ON =
  'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 '
  + '2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 '
  + '7-4.49 7-8.77s-2.99-7.86-7-8.77z';
const VOICE_ICON_OFF =
  'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 '
  + '.94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 '
  + '5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 '
  + '1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z';

/** Inline monochrome speaker glyph (muted = with a diagonal slash). */
export function voiceMuteIconHtml(muted) {
  return `<svg class="vo-icon" viewBox="0 0 24 24" width="1em" height="1em" `
    + `fill="currentColor" aria-hidden="true"><path d="${muted ? VOICE_ICON_OFF : VOICE_ICON_ON}"/></svg>`;
}
