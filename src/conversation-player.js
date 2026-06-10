// Conversation playback orchestrator — presents a campaign conversation
// through the replay machinery: a conversation turn card (SKIP while playing,
// REPLAY when done), the camera framing the participants (unless the player
// has FIXED camera — then in-world bubbles + an off-screen edge arrow), dialog
// as persistent billboard speech bubbles, and the replay NEXT button stepping
// dialog lines.
//
// Entirely a client-side presentation layer: no resolver or state-sync
// involvement. Works both pre-planning (round-boundary story triggers — it
// raises its own replay HUD) and mid-replay (interleaved between resolution
// steps — the step loop's HUD stays up and this consumes the shared playback
// flags, so NEXT naturally advances dialog lines while the step loop is
// blocked awaiting us).

import { playback, playbackDelay } from './playback.js';
import { AppMode, setMode } from './app-mode.js';
import { buildConversationDigest } from './replay-timeline.js';
import { runScriptedActions } from './campaign/scripted-actions.js';

/** Auto-advance hold for one dialog line — long enough to read, capped. */
export function conversationReadingMs(text) {
  return Math.max(1600, Math.min(6000, 400 + String(text ?? '').length * 40));
}

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Display name for a speaking entity (roster name > title > type). */
function speakerName(entity) {
  return entity?.name ?? entity?.title ?? entity?.displayName ?? entity?.type ?? '';
}

/**
 * Play a conversation.
 *
 * @param {object} opts
 *   convo        — parsed conversation ({ id, title, roles, lines }).
 *   participants — Map<role, entity> from bindParticipants().
 *   convDef      — mission `conversations[]` entry (for onComplete actions).
 *   npcDefs      — mission `npcs[]` defs (spawn actions).
 *   state, renderer, ui, redraw — the usual client refs.
 *   manageHud    — true (default) when no replay is running: raises the inline
 *                  replay HUD + its own timeline. false mid-replay: inserts a
 *                  card into the live timeline and reuses the existing HUD.
 *   runOnComplete — false to skip convDef.onComplete (mid-replay defers it
 *                  until the authoritative entities are restored).
 * @returns {Promise<{ skipped: boolean }>}
 */
export async function playConversation(opts) {
  const {
    convo, participants, convDef = null, npcDefs = [],
    state, renderer = null, ui = null, redraw = () => {},
    manageHud = true, runOnComplete = true,
  } = opts;

  let skipped = false;
  const skipFlag = () => skipped || playback.jumpToEnd || playback.aborted || playback.goBack;

  // Record per-line presentation data up front — the REPLAY re-run must work
  // even after a participant despawned (bubbles fall back to the hex).
  const lineRecords = convo.lines.map(l => {
    const e = participants.get(l.role) ?? null;
    return {
      text: l.text,
      name: speakerName(e),
      entityId: e?.id ?? null,
      col: e?.col ?? null,
      row: e?.row ?? null,
    };
  });
  const participantIds = [...participants.values()].map(e => e.id);
  const centroid = (() => {
    const ents = [...participants.values()];
    if (!ents.length) return null;
    return {
      col: Math.round(ents.reduce((s, e) => s + e.col, 0) / ents.length),
      row: Math.round(ents.reduce((s, e) => s + e.row, 0) / ents.length),
    };
  })();

  // ── HUD (round-boundary only — mid-replay reuses the step loop's bar) ──────
  const prevStepRequested = playback.stepRequested;
  if (manageHud && ui) {
    // Fresh presentation: stale flags from a previous replay (skip/abort/back)
    // would otherwise blow through every line gate and dump the player into
    // planning with the card still up.
    playback.aborted = false;
    playback.goBack = false;
    playback.jumpToEnd = false;
    playback.restart = false;
    playback.replayStep = false;
    // Turn-0 resolution presentation: the conversation plays as a replay, not
    // over the planning chrome — drop any plan panel/selection and enter
    // RESOLVING before the first bubble appears.
    ui.exitPlanningMode?.();
    setMode(AppMode.RESOLVING);
    playback.paused = !ui.replayAutoPlay;
    playback.stepRequested = false;
    ui.showInlineReplayHUD?.((action) => {
      switch (action) {
        case 'playpause':
          playback.paused = !playback.paused;
          if (!playback.paused) playback.stepRequested = false;
          ui.replayAutoPlay = !playback.paused;
          ui.setReplayTransport(playback.paused);
          break;
        case 'next':
          playback.stepRequested = true;
          break;
      }
    });
    ui.setReplayTransport?.(playback.paused);
  }

  // ── Turn card ──────────────────────────────────────────────────────────────
  const digest = buildConversationDigest(convo, participants);
  const cardKey = digest[0].stepIndex;
  if (ui) {
    if (manageHud) ui.showReplayTimeline?.(digest);
    else ui.insertReplayTimelineCol?.(digest[0]);
    ui.setConversationCardState?.(cardKey, 'playing', { onSkip: () => { skipped = true; } });
  }

  // ── Camera ─────────────────────────────────────────────────────────────────
  // The 3D renderer boots lazily (Babylon + assets behind the loading
  // overlay). showSpeechBubble silently no-ops until the scene exists, so a
  // mission-intro conversation racing the load would lose its first line(s) —
  // wait for the renderer before presenting anything.
  if (renderer?.whenReady) await renderer.whenReady();
  const fixedCam = ui?.replayCameraMode === 'fixed' || !!renderer?.suppressAutoFrame;
  await _frameOrArrow({ renderer, ui, fixedCam, participantIds, centroid });

  // ── Dialog lines ───────────────────────────────────────────────────────────
  let presenting = true;
  try {
    await _presentLines(lineRecords, { state, renderer, ui, skipFlag });
  } finally {
    presenting = false;
    renderer?.clearSpeechBubbles?.();
    ui?.hideOffscreenArrow?.();
  }

  // ── Finished: flip the card to REPLAY (+ CONTINUE for turn-0 intros) ──────
  let replaying = false;
  let continueRequested = false;
  const showDone = () => {
    ui?.setConversationCardState?.(cardKey, 'done', {
      onReplay: replayPresentation,
      // Turn-0/round-boundary conversations gate on an explicit CONTINUE so
      // the player controls when the card dismisses and planning opens.
      // Mid-replay conversations omit it — the round resumes on its own.
      onContinue: manageHud ? () => { continueRequested = true; } : undefined,
    });
  };
  async function replayPresentation() {
    if (replaying || presenting) return;
    replaying = true;
    let replaySkipped = false;
    ui?.setConversationCardState?.(cardKey, 'playing', { onSkip: () => { replaySkipped = true; } });
    try {
      await _frameOrArrow({ renderer, ui, fixedCam: ui?.replayCameraMode === 'fixed', participantIds, centroid });
      await _presentLines(lineRecords, {
        state, renderer, ui,
        skipFlag: () => replaySkipped,
        autoOnly: true,   // no HUD guaranteed up — just timed auto-advance
      });
    } finally {
      renderer?.clearSpeechBubbles?.();
      ui?.hideOffscreenArrow?.();
      showDone();
      replaying = false;
    }
  }
  showDone();

  // ── onComplete scripted actions (e.g. the NPC walks away) ─────────────────
  if (runOnComplete && convDef?.onComplete?.length) {
    await runScriptedActions(convDef.onComplete, {
      state, renderer, redraw, npcDefs, instant: skipFlag(),
    });
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  if (manageHud && ui) {
    // Hold the finished card on screen until the player taps CONTINUE (NEXT
    // works too). A SKIP carries the same intent — fall straight through.
    if (!skipFlag()) {
      ui.setReplayNextReady?.(true);
      while (!continueRequested && !playback.stepRequested
             && !playback.jumpToEnd && !playback.aborted) {
        await _sleep(50);
      }
      ui.setReplayNextReady?.(false);
      playback.stepRequested = false;
      // A REPLAY re-run may still be presenting when CONTINUE lands — let it
      // settle so its finally block doesn't repaint a dismissed card.
      while (replaying) await _sleep(50);
    }
    ui.hideReplayTimeline?.();
    ui.hideInlineReplayHUD?.();
    playback.jumpToEnd = false;
    playback.paused = false;
    playback.stepRequested = false;
  } else {
    // Mid-replay: don't leak a NEXT press consumed (or set) by the dialog into
    // the step loop's gate.
    playback.stepRequested = prevStepRequested;
  }
  return { skipped: skipFlag() };
}

/** Frame the participants (follow cam) or point at them (fixed cam). */
async function _frameOrArrow({ renderer, ui, fixedCam, participantIds, centroid }) {
  if (!renderer) return;
  if (!fixedCam) {
    if (renderer.frameEntities) {
      await renderer.frameEntities(participantIds, { padding: 1.3 });
    } else if (renderer.frameHexes && centroid) {
      renderer.frameHexes([centroid], { paddingHexes: 3, maxZoom: 2.0, duration: 400 });
    }
  } else if (centroid) {
    // Camera stays put — if the conversation is off-screen, show the edge arrow.
    ui?.showOffscreenArrow?.(centroid.col, centroid.row);
  }
}

/** Show each line as a persistent bubble; advance via NEXT / auto / skip. */
async function _presentLines(lineRecords, { state, renderer, ui, skipFlag, autoOnly = false }) {
  let bubble = null;
  try {
    for (const line of lineRecords) {
      if (skipFlag()) break;
      if (!renderer?.showSpeechBubble) {
        // 2D / headless fallback: blocking modal per line (renderer.js is
        // editor-only now, so no bespoke 2D bubble work).
        await ui?.showStoryModal?.(line.name, line.text);
        continue;
      }
      bubble?.dispose();
      bubble = _showLine(line, { state, renderer });
      if (autoOnly) {
        await _autoHold(conversationReadingMs(line.text), skipFlag);
        continue;
      }
      if (playback.paused) {
        // Manual mode: NEXT = next line of dialog.
        ui?.setReplayNextReady?.(true);
        while (playback.paused && !playback.stepRequested && !skipFlag()) {
          await _sleep(50);
        }
        ui?.setReplayNextReady?.(false);
        playback.stepRequested = false;
      } else {
        // Auto-play: hold long enough to read; NEXT collapses the hold.
        await playbackDelay(conversationReadingMs(line.text));
        playback.stepRequested = false;
      }
    }
  } finally {
    bubble?.dispose();
  }
}

/** Spawn one line's bubble — above the live entity, or its recorded hex. */
function _showLine(line, { state, renderer }) {
  const live = line.entityId != null
    && state?.entities?.some(e => e.id === line.entityId && e.alive !== false);
  const anchor = live ? line.entityId : { col: line.col, row: line.row };
  if (!live && line.col == null) return null;
  return renderer.showSpeechBubble(anchor, line.name, line.text);
}

/** Plain timed hold that still honors the skip flag (REPLAY re-runs). */
async function _autoHold(ms, skipFlag) {
  let remaining = ms;
  while (remaining > 0 && !skipFlag()) {
    await _sleep(Math.min(50, remaining));
    remaining -= 50;
  }
}
