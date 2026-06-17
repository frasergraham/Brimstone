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

import { playback } from './playback.js';
import { AppMode, setMode } from './app-mode.js';
import { buildConversationDigest } from './replay-timeline.js';
import { runScriptedActions } from './campaign/scripted-actions.js';
import { playVoiceClip, stopVoice, loadVoiceManifest, hasVoiceClip, hasConversationVoice } from './voiceover.js';

/** Auto-advance hold for one dialog line — long enough to read, capped. */
export function conversationReadingMs(text) {
  return Math.max(1600, Math.min(6000, 400 + String(text ?? '').length * 40));
}

/**
 * Safety ceiling for a single line's voice-aware auto-advance. Even a clip that
 * never reports `ended` (stalled download, autoplay-blocked before the first
 * gesture) can't hold the conversation open longer than this. Lines are short,
 * so real narration finishes well under it; operator-tunable.
 */
export const CONVERSATION_HOLD_CEILING_MS = 30000;

/**
 * Auto-advance hold for ONE conversation line that respects spoken narration.
 *
 * Advances at max(reading-time floor, clip end): a long clip is never cut off
 * mid-sentence, while a fast / short / missing / failed / muted clip still falls
 * back to the reading floor (so a quick clip can't beat the reader). Bounded by
 * a ceiling so a clip that never reports `ended` can't hang the auto-advance.
 * The skip flag (card SKIP / replay NEXT / jump-to-end) collapses it at once.
 *
 * @param {HTMLAudioElement|null} audio  clip handle from playVoiceClip (null when muted/headless/no clip)
 * @param {string} text                  the line text (drives the reading floor)
 * @param {object} [o]
 *   o.shouldStop — () => boolean : collapse the hold now (default: never)
 *   o.sleep      — async (ms)    : poll tick (test seam; default real timer)
 *   o.floorMs    — number        : reading-floor override (test seam / speed-scaled floor)
 *   o.ceilingMs  — number        : safety-ceiling override (test seam)
 * @returns {Promise<void>}
 */
export async function awaitConversationLineEnd(audio, text, o = {}) {
  const shouldStop = o.shouldStop ?? (() => false);
  const sleep      = o.sleep ?? _sleep;
  const floorMs    = o.floorMs ?? conversationReadingMs(text);
  const ceilingMs  = o.ceilingMs ?? CONVERSATION_HOLD_CEILING_MS;

  // With no audio (muted / headless / clip absent) the reading floor alone
  // governs. A clip's `ended` is the natural gate; its `error` (missing/broken
  // file) means "no narration to wait for" — also fall back to the floor.
  let clipDone = !audio;
  if (audio) {
    if (audio.ended) clipDone = true;
    audio.addEventListener?.('ended', () => { clipDone = true; });
    audio.addEventListener?.('error', () => { clipDone = true; });
  }

  // Advance only once BOTH the reading floor has elapsed AND the clip has
  // finished — i.e. max(floor, clip length) — bounded by the ceiling.
  let waited = 0;
  while (!shouldStop()) {
    if ((waited >= floorMs && clipDone) || waited >= ceilingMs) break;
    await sleep(50);
    waited += 50;
  }
}

/**
 * URL of the narration clip for one conversation line. Stable: keyed by the
 * conversation's id and the line's positional index, namespaced under `conv/`
 * so it never collides with tutorial/hint clips. Generated (per-speaker voice)
 * by scripts/generate-voiceover.mjs; a missing file plays silently.
 */
export function conversationClipUrl(convId, lineIndex, base = 'assets/voice') {
  return `${base}/conv/${convId}/${lineIndex}.mp3`;
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

  // Learn which clips actually exist before building the card — drives both the
  // card's voice-mute button (shown only with narration) and per-line playback
  // (only request clips that were generated, no 404 churn).
  await loadVoiceManifest();
  const hasVoice = hasConversationVoice(convo.id);

  // Record per-line presentation data up front — the REPLAY re-run must work
  // even after a participant despawned (bubbles fall back to the hex).
  const lineRecords = convo.lines.map((l, idx) => {
    const e = participants.get(l.role) ?? null;
    const clipId = `conv/${convo.id}/${idx}`;
    return {
      text: l.text,
      name: speakerName(e),
      entityId: e?.id ?? null,
      col: e?.col ?? null,
      row: e?.row ?? null,
      // Per-speaker narration clip for this line (voice picked by role at
      // generation time). Only set when the clip was actually generated.
      clipUrl: hasVoiceClip(clipId) ? conversationClipUrl(convo.id, idx) : null,
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
  const digest = buildConversationDigest(convo, participants, { hasVoice });
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
  // Framing happens per-line inside _presentLines (not once here) so the active
  // bubble stays fully visible and close enough to read even if the camera
  // drifts between lines — unless the player has taken FIXED camera control.

  // ── Snapshot prior facings so we can restore them when the card dismisses.
  // Conversation orientation is a *presentation pose* — once the player
  // continues, units that aren't acting this round should NOT stay frozen
  // mid-look across the map. A subsequent move/lunge re-asserts facing on its
  // own; this snapshot covers the units that don't act. Captured BEFORE the
  // first line orients so the saved yaws are pre-conversation. No-op when the
  // renderer doesn't expose captureFacings (e.g. headless tests, 2D editor). */
  const priorFacings = renderer?.captureFacings?.(participantIds) ?? null;

  // ── Dialog lines ───────────────────────────────────────────────────────────
  let presenting = true;
  try {
    await _presentLines(lineRecords, { state, renderer, ui, skipFlag, participantIds, centroid });
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
      await _presentLines(lineRecords, {
        state, renderer, ui,
        skipFlag: () => replaySkipped,
        autoOnly: true,   // no HUD guaranteed up — just timed auto-advance
        participantIds, centroid,
      });
    } finally {
      renderer?.clearSpeechBubbles?.();
      ui?.hideOffscreenArrow?.();
      showDone();
      replaying = false;
    }
  }
  showDone();

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

  // ── Restore prior facings ─────────────────────────────────────────────────
  // Conversation pose is dismissed: any participant that isn't about to MOVE
  // or attack would otherwise stay frozen staring at its conversation partner
  // (a real bug for units that don't act this round). The onComplete walk-off
  // below issues its own facing through addMoveAnim, so this is harmless for
  // units that DO act — it gets stomped by their move's _faceModelInstant.
  // No-op when capture was a no-op (no renderer hook, or no models loaded). */
  if (priorFacings) renderer?.restoreFacings?.(priorFacings);

  // ── onComplete scripted actions (e.g. the NPC walks away) ─────────────────
  // AFTER the CONTINUE gate and card teardown: the conversation card should
  // only do the conversation — while it holds on REPLAY/CONTINUE the
  // participants are all still on the map, so a REPLAY re-run looks right.
  // The walk-off plays once the player releases the card.
  if (runOnComplete && convDef?.onComplete?.length) {
    await runScriptedActions(convDef.onComplete, {
      state, renderer, redraw, npcDefs, instant: skipFlag(),
    });
  }
  return { skipped: skipFlag() };
}

/**
 * Frame THIS line so its bubble is fully visible and close enough to read —
 * unless the player has taken FIXED camera control, in which case we leave the
 * camera put and just point an off-screen arrow at the speaker. Re-reads the
 * camera mode every line so a mid-conversation pan (which flips replay camera to
 * FIXED) immediately stops the auto-framing.
 *
 * Follow cam frames the live SPEAKER (closest, follows who's talking), with
 * headroom reserved for the bubble; it falls back to all participants, then to
 * the speaker's recorded hex if that entity has despawned.
 */
async function _frameConversationStep(line, { renderer, ui, participantIds, centroid }) {
  if (!renderer) return;
  const loc = (line?.col != null) ? { col: line.col, row: line.row } : centroid;
  const fixedCam = ui?.replayCameraMode === 'fixed' || !!renderer.suppressAutoFrame;
  if (fixedCam) {
    if (loc) ui?.showOffscreenArrow?.(loc.col, loc.row);
    return;
  }
  ui?.hideOffscreenArrow?.();
  // Reserve headroom for the bubble above the speaker (bubbles are ~3 world
  // units wide/tall) so the dialog never clips off the edge of the screen.
  const cardExtent = renderer.speechBubbleFrameExtent?.() ?? 0;
  let framed = false;
  if (line?.entityId != null && renderer.frameEntities) {
    framed = await renderer.frameEntities([line.entityId], { padding: 1.8, cardExtent });
  }
  if (!framed && renderer.frameEntities && participantIds?.length) {
    framed = await renderer.frameEntities(participantIds, { padding: 1.8, cardExtent });
  }
  if (!framed && renderer.frameHexes && loc) {
    renderer.frameHexes([loc], { paddingHexes: 3, maxZoom: 2.0, duration: 400 });
  }
}

/** Show each line as a persistent bubble; advance via NEXT / auto / skip. */
async function _presentLines(lineRecords, { state, renderer, ui, skipFlag, autoOnly = false, participantIds = [], centroid = null }) {
  let bubble = null;
  try {
    for (const line of lineRecords) {
      if (skipFlag()) break;
      if (!renderer?.showSpeechBubble) {
        // 2D / headless fallback: blocking modal per line (renderer.js is
        // editor-only now, so no bespoke 2D bubble work).
        playVoiceClip(line.clipUrl);
        await ui?.showStoryModal?.(line.name, line.text);
        continue;
      }
      // Turn the active speaker to face the rest of the group and the listeners
      // to face the speaker — a short interpolated pivot so the scene reads as
      // people looking at one another rather than staring past each other. Pure
      // render side-effect, fire-and-forget so the bubble/camera don't wait on
      // it. No-ops for a lone participant ("the world" / narration beat), a line
      // with no bound entity, or a model that hasn't loaded yet.
      if (line.entityId != null) {
        renderer.orientConversation?.(line.entityId, participantIds);
      }
      // Re-assert the camera frame for THIS line before the bubble appears, so a
      // camera drift since the last line can't leave the bubble off-screen.
      await _frameConversationStep(line, { renderer, ui, participantIds, centroid });
      bubble?.dispose();
      bubble = _showLine(line, { state, renderer });
      // Start this speaker's narration in step with the bubble. playVoiceClip
      // self-gates on the shared VO mute and stops the previous line's clip.
      // The handle drives the voice-aware auto-advance below (null when muted /
      // headless / no clip).
      const clip = playVoiceClip(line.clipUrl);
      if (autoOnly) {
        // REPLAY re-run: timed hold that waits out the narration, not just the
        // reading estimate, so a long clip isn't cut off mid-sentence.
        await awaitConversationLineEnd(clip, line.text, { shouldStop: skipFlag });
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
        // Auto-play: hold for max(reading time, narration length) so a long clip
        // is never cut off; NEXT / SKIP / jump collapse the hold. The reading
        // floor honors the replay speed multiplier (audio can't be sped up, so
        // the clip's end stays a hard gate).
        const floorMs = conversationReadingMs(line.text);
        await awaitConversationLineEnd(clip, line.text, {
          floorMs: playback.speedMult > 0 ? floorMs / playback.speedMult : floorMs,
          shouldStop: () => skipFlag() || playback.stepRequested
                            || playback.restart || playback.replayStep,
        });
        playback.stepRequested = false;
      }
    }
  } finally {
    bubble?.dispose();
    stopVoice();   // narration never outlives the dialog it belongs to
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
