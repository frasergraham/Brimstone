// Autoplay gating for authored story beats — the narrative twin of
// combat-cinematic.js.
//
// A story beat (an authored title/text card surfaced by a mission's story
// triggers or its mission-logic graph) is content the player is meant to read.
// When resolution is auto-advancing there is no human pressing NEXT, so a beat
// would otherwise be SKIPPED (AI-vs-AI autoplay never enters the pre-planning
// story sequence) or FLASHED past (the replay "AutoPlay" toggle leaves the
// playback loop un-paused, so the mid-replay beat card's NEXT-gate is a no-op).
//
// This module holds each beat on screen for a readable minimum dwell, mirroring
// the combat cinematic's Continue gate (same startContinueCountdown drives the
// button countdown so the two cinematics behave identically): the beat auto-
// advances once the dwell elapses, while a watching operator may dismiss it
// sooner — whichever comes first.

import { startContinueCountdown } from './combat-cinematic.js';

// Minimum time (ms) a story beat stays on screen while resolution is auto-
// advancing. Sensible reading time for a short authored card. Tunable — dial it
// up for slower readers, down for snappier auto-runs.
export const STORY_BEAT_MIN_DWELL_MS = 4000;

/**
 * How long to hold a story beat before auto-advancing, given the current
 * playback state. Returns `minDwellMs` whenever resolution is auto-advancing
 * (so the beat is readable), or 0 when a human is stepping manually — in which
 * case the caller keeps the normal NEXT-gate instead of a timed hold.
 *
 *   - autoplay (AI-vs-AI): always auto-advancing → hold.
 *   - replay "AutoPlay" toggle on: playback is NOT paused → hold.
 *   - manual stepping: playback IS paused → 0 (gate on NEXT).
 *
 * @param {object}  o
 * @param {boolean} o.autoplay  the AI-vs-AI `_autoplay` game flag
 * @param {boolean} o.paused    the playback manual-step pause flag
 * @param {number}  [o.minDwellMs]
 * @returns {number} ms to hold (0 ⇒ no timed hold; gate on NEXT)
 */
export function storyBeatHoldMs({ autoplay, paused, minDwellMs = STORY_BEAT_MIN_DWELL_MS }) {
  return (autoplay || !paused) ? minDwellMs : 0;
}

/**
 * Gate a presented story-beat card (one with a Continue button, e.g. the story
 * modal) during autoplay. Resolves when the beat has been readable long enough:
 * a countdown labels the button "Continue (N)" and auto-clicks at 0, and a
 * manual click resolves sooner — whichever comes first. With no button it falls
 * back to a plain dwell.
 *
 * Mirrors combat-cinematic's continue-gate wiring (build a promise, race the
 * operator's click against the auto-click countdown, clean up either way).
 *
 * @param {HTMLButtonElement|null} button  the Continue button (or null)
 * @param {object}  [opts]
 * @param {number}  [opts.minDwellMs]
 * @param {Function}[opts.delayFn]          (ms)=>Promise — no-button fallback / tests
 * @param {Function}[opts.startCountdownFn] injectable startContinueCountdown
 * @param {object}  [opts.countdownOpts]    forwarded to startContinueCountdown (test timers)
 * @returns {Promise<void>}
 */
export function runStoryBeatGate(button, {
  minDwellMs = STORY_BEAT_MIN_DWELL_MS,
  delayFn,
  startCountdownFn = startContinueCountdown,
  countdownOpts,
} = {}) {
  const delay = delayFn || ((ms) => new Promise(r => setTimeout(r, ms)));
  if (!button) return delay(minDwellMs);
  return new Promise(resolve => {
    let cancelCountdown = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (cancelCountdown) { cancelCountdown(); cancelCountdown = null; }
      button.removeEventListener('click', onClick);
      resolve();
    };
    const onClick = () => finish();
    button.addEventListener('click', onClick);
    cancelCountdown = startCountdownFn(button, finish, {
      totalSec: Math.max(1, Math.round(minDwellMs / 1000)),
      ...(countdownOpts ?? {}),
    });
  });
}
