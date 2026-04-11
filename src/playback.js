// Playback engine — full-game replay with play/pause/ff/back/stop.
//
// Owns the _playback state object and the main replay loop.
// Extracted from main.js to reduce the file's responsibility count.
//
// Usage:
//   import { playback, resetPlayback, replayFullGame, playbackDelay, swapState, patchAlive } from './playback.js';

import { AppMode, getMode, setMode } from './app-mode.js';
import { deserializeState } from '../server/state-sync.js';

// ── Playback state ──────────────────────────────────────────────────────────
// Only meaningful when getMode() === AppMode.PLAYBACK.

export const playback = {
  aborted:      false,
  paused:       false,
  goBack:       false,   // false | 'curr' | 'prev'
  atRoundStart: false,   // true while paused at the pre-animation point of a round
  speedMult:    0.5,     // 0.5=play, 1.0=ff, 4.0=vff
  jumpToEnd:    false,   // skip to final game state
};

export function resetPlayback() {
  playback.aborted = false;
  playback.paused = false;
  playback.goBack = false;
  playback.atRoundStart = false;
  playback.speedMult = 0.5;
  playback.jumpToEnd = false;
}

/** Ensure plain-object entities have `alive` (omitted by serializeState, needed by renderer). */
export function patchAlive(entities) {
  for (const e of entities) {
    if (e.alive === undefined) e.alive = e.hp > 0;
  }
  return entities;
}

/**
 * Replace the module-level state and update all references (renderer, UI).
 * Caller passes the mutable refs object so this module doesn't hold globals.
 */
export function swapState(refs, newState) {
  refs.state = newState;
  if (refs.renderer) refs.renderer.state = newState;
  if (refs.ui) refs.ui.state = newState;
}

/**
 * Delay utility that respects playback pause/abort/speed flags.
 *
 * Outside PLAYBACK mode, behaves as a plain setTimeout — UNLESS `jumpToEnd`
 * or `aborted` is set (e.g. inline "Replay last turn" has a skip button),
 * in which case we still poll so the skip takes effect mid-delay.
 */
export function playbackDelay(ms) {
  const inPlayback = getMode() === AppMode.PLAYBACK;
  if (!inPlayback && !playback.jumpToEnd && !playback.aborted) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // During replay: poll every ≤50 ms so pause/abort/back take effect immediately.
  const effective = playback.speedMult > 0 ? ms / playback.speedMult : ms;
  return new Promise(resolve => {
    let remaining = effective;
    let last = Date.now();
    function tick() {
      if (playback.aborted || playback.goBack || playback.jumpToEnd) { resolve(); return; }
      if (!playback.paused) {
        const now = Date.now();
        remaining -= (now - last);
        last = now;
      } else {
        last = Date.now(); // don't count paused time toward remaining
      }
      if (remaining <= 0) { resolve(); return; }
      setTimeout(tick, Math.min(50, remaining));
    }
    tick();
  });
}

/**
 * Replay all rounds of a completed game in sequence.
 *
 * @param {Object}   refs       — { state, renderer, ui } mutable reference bag
 * @param {Array}    rounds     — [{ roundNum, preState, steps, finalEntities? }]
 * @param {string}   winner
 * @param {string}   winReason
 * @param {string}   heroName
 * @param {string}   witchName
 * @param {Function} animateStepsFn — the _animateResolutionSteps function from main.js
 * @param {Function} [redrawFn] — defaults to () => refs.renderer?.draw(refs.state)
 * @param {Object}   [opts]
 * @param {number}   [opts.startIndex=0]  - Round index to start replay at.
 * @param {string}   [opts.stopLabel]     - Custom label for the stop button (e.g. "Plan").
 * @param {boolean}  [opts.autoPlay=false] - Start playing immediately instead of paused.
 */
export async function replayFullGame(refs, rounds, winner, winReason, heroName, witchName, animateStepsFn, redrawFn, opts = {}) {
  const { ui, renderer } = refs;
  if (!rounds.length || !ui || !renderer) return null;
  const draw = redrawFn ?? (() => renderer.draw(refs.state));

  resetPlayback();
  playback.paused = !opts.autoPlay;
  setMode(AppMode.PLAYBACK);
  const savedSpeedMode = ui.speedMode;
  ui.speedMode = 'fast';

  // Control callback wired to HUD buttons
  ui.showReplayHUD(rounds.length, (action) => {
    switch (action) {
      case 'play':
        playback.speedMult = 0.5; playback.paused = false;
        ui.setReplayPlayState('play');
        break;
      case 'ff':
        playback.speedMult = 1.0; playback.paused = false;
        ui.setReplayPlayState('ff');
        break;
      case 'vff':
        playback.speedMult = 4.0; playback.paused = false;
        ui.setReplayPlayState('vff');
        break;
      case 'pause':
        playback.paused = true;
        ui.setReplayPlayState('pause');
        break;
      case 'back':
        playback.paused = true;
        playback.goBack = playback.atRoundStart ? 'prev' : 'curr';
        ui.setReplayPlayState('pause');
        break;
      case 'end':
        playback.jumpToEnd = true; playback.paused = false;
        break;
      case 'stop':
        if (opts.stopLabel) {
          playback.aborted = true; playback.paused = false;
        } else {
          playback.paused = true;
          ui.setReplayPlayState('pause');
          ui.showReplayExitDialog().then(choice => {
            if (choice === 'exit') {
              playback.aborted = true; playback.paused = false;
            }
          });
        }
        break;
    }
  });
  if (opts.stopLabel) {
    const stopBtn = document.getElementById('replay-stop-btn');
    if (stopBtn) { stopBtn.textContent = opts.stopLabel; stopBtn.title = opts.stopLabel; }
  }
  if (!opts.autoPlay) {
    ui.setReplayPlayState('pause');
  }

  let lastSteps    = null;
  let lastRoundNum = 0;
  let lastPreState = null;

  let _startFrom = opts.startIndex ?? 0;

  // Outer loop: re-entered when BACK is pressed at the end-of-replay hold screen
  replayOuter: while (true) {
    for (let i = _startFrom; i < rounds.length; i++) {
      if (playback.aborted) break;

      // Jump to end: restore final game state and skip to end-of-replay hold
      if (playback.jumpToEnd) {
        playback.jumpToEnd = false;
        const lastRound = rounds[rounds.length - 1];
        const lastData = typeof lastRound.preState === 'string'
          ? JSON.parse(lastRound.preState) : lastRound.preState;
        const lastState = deserializeState(lastData);
        renderer.clearAnimations();
        swapState(refs, lastState);
        if (!opts.stopLabel) refs.state.fogOfWar = 'none';
        if (lastRound.finalEntities) {
          const finals = lastRound.finalEntities;
          for (const e of refs.state.entities) {
            const f = finals.find(fe => fe.id === e.id);
            if (f) {
              delete f.alive;
              delete f.displayName;
              Object.assign(e, f);
            }
          }
        }
        draw();
        ui.updateReplayHUD();
        break;
      }

      const round = rounds[i];
      const preStateData = typeof round.preState === 'string'
        ? JSON.parse(round.preState)
        : round.preState;
      const preState = deserializeState(preStateData);

      renderer.clearAnimations();
      swapState(refs, preState);
      if (!opts.stopLabel) refs.state.fogOfWar = 'none';
      draw();

      // At round start: accept BACK / PAUSE before animation begins
      playback.atRoundStart = true;
      while (playback.paused && !playback.aborted && !playback.goBack && !playback.jumpToEnd) {
        await new Promise(r => setTimeout(r, 50));
      }
      playback.atRoundStart = false;
      if (playback.aborted) break;
      if (playback.jumpToEnd) continue;

      if (playback.goBack) {
        const toPrev = playback.goBack === 'prev';
        playback.goBack = false;
        i = Math.max(-1, toPrev ? i - 2 : i - 1);
        continue;
      }

      // Show hazard flashes from the previous round's endRound() before animating
      if (preState.postRoundEvents?.some(ev => ev.flash)) {
        ui._triggerPostRoundEffects();
        await playbackDelay(600);
        if (playback.aborted) break;
      }

      ui.updateReplayHUD();

      // Get final entities (start of next round = end of this round)
      let finalEntities;
      if (i + 1 < rounds.length) {
        const nextData = typeof rounds[i + 1].preState === 'string'
          ? JSON.parse(rounds[i + 1].preState)
          : rounds[i + 1].preState;
        finalEntities = patchAlive(nextData.entities ?? preState.entities);
      } else {
        finalEntities = patchAlive(round.finalEntities ?? preState.entities);
      }

      const stepsRaw = typeof round.steps === 'string' ? JSON.parse(round.steps) : round.steps;
      lastSteps    = stepsRaw;
      lastRoundNum = typeof round.roundNum === 'number' ? round.roundNum : i + 1;
      lastPreState = preState;

      await animateStepsFn(stepsRaw, finalEntities, draw, null, null);

      if (playback.aborted) break;
      if (playback.jumpToEnd) continue;

      if (playback.goBack) {
        const toPrev = playback.goBack === 'prev';
        playback.goBack = false;
        i = Math.max(-1, toPrev ? i - 2 : i - 1);
        continue;
      }

      // Brief inter-round pause
      if (i < rounds.length - 1) {
        await playbackDelay(300);
        if (playback.goBack) {
          const toPrev = playback.goBack === 'prev';
          playback.goBack = false;
          i = Math.max(-1, toPrev ? i - 2 : i - 1);
          continue;
        }
      }
    }

    _startFrom = 0;

    if (playback.aborted) break replayOuter;

    // End-of-replay hold: pause and wait for STOP or BACK
    playback.paused       = true;
    playback.atRoundStart = true;
    ui.setReplayPlayState('pause');

    while (!playback.aborted && !playback.goBack) {
      await new Promise(r => setTimeout(r, 50));
    }
    playback.atRoundStart = false;

    if (playback.aborted) break replayOuter;

    if (playback.goBack) {
      const toPrev = playback.goBack === 'prev';
      playback.goBack = false;
      _startFrom = toPrev ? Math.max(0, rounds.length - 2) : Math.max(0, rounds.length - 1);
      continue replayOuter;
    }

    break replayOuter;
  }

  // Restore stop button label if it was customised
  if (opts.stopLabel) {
    const stopBtn = document.getElementById('replay-stop-btn');
    if (stopBtn) { stopBtn.textContent = '■'; stopBtn.title = 'Stop'; }
  }
  ui.hideReplayHUD();
  setMode(AppMode.MENU);
  resetPlayback();
  ui.speedMode = savedSpeedMode;
}
