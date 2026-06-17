// Tests for the conversation playback orchestrator (src/conversation-player.js)
// against stub ui/renderer/state: NEXT steps dialog lines, the finished card
// gates on CONTINUE before resolving (mission-intro/turn-0 case), SKIP falls
// straight through, and planning chrome is dropped before presentation.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { playConversation, conversationReadingMs, awaitConversationLineEnd } from '../src/conversation-player.js';
import { playback, resetPlayback } from '../src/playback.js';
import { AppMode, setMode, getMode } from '../src/app-mode.js';

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

function stubRenderer() {
  return {
    is3D: true,
    suppressAutoFrame: false,
    bubbles: [],
    frameCalls: [],
    showSpeechBubble(anchor, name, text) {
      const b = { anchor, name, text, disposed: false };
      this.bubbles.push(b);
      return { dispose: () => { b.disposed = true; } };
    },
    clearSpeechBubbles() { this.bubbles.forEach(b => { b.disposed = true; }); },
    speechBubbleFrameExtent() { return 2; },
    async frameEntities(ids, opts) { this.frameCalls.push({ ids, opts }); return true; },
    addMoveAnim() {},
    async waitForAnimations() {},
  };
}

function stubUi() {
  return {
    calls: [],
    cardStates: [],
    cardHandlers: null,
    replayAutoPlay: false,        // manual mode: NEXT drives lines
    replayCameraMode: 'follow',
    exitPlanningMode() { this.calls.push('exitPlanningMode'); },
    showInlineReplayHUD(handler) { this.calls.push('showHUD'); this.hudHandler = handler; },
    hideInlineReplayHUD() { this.calls.push('hideHUD'); },
    setReplayTransport() {},
    setReplayNextReady() {},
    showReplayTimeline() { this.calls.push('showTimeline'); },
    hideReplayTimeline() { this.calls.push('hideTimeline'); },
    setConversationCardState(key, cardState, handlers) {
      this.cardStates.push(cardState);
      this.cardHandlers = handlers;
    },
    arrowCalls: [],
    showOffscreenArrow(col, row) { this.arrowCalls.push({ col, row }); },
    hideOffscreenArrow() {},
  };
}

function fixture() {
  const hero = { id: 'e1', type: 'paladin', title: 'Paladin', alive: true, col: 2, row: 7 };
  const npc = { id: 'e2', type: 'survivor', name: 'John', alive: true, col: 3, row: 6, isNpc: true, npcId: 'john' };
  return {
    convo: {
      id: 'intro', title: 'Test', roles: ['hero', 'innkeeper'],
      lines: [{ role: 'hero', text: 'Hi.' }, { role: 'innkeeper', text: 'Run!' }],
    },
    participants: new Map([['hero', hero], ['innkeeper', npc]]),
    state: { entities: [hero, npc], hero },
  };
}

/** Pump playback.stepRequested until the predicate holds (NEXT presses). */
async function pumpNext(until, max = 100) {
  for (let i = 0; i < max && !until(); i++) {
    playback.stepRequested = true;
    await _sleep(60);
  }
}

describe('playConversation — turn-0 intro flow', () => {
  test('hides planning chrome, steps lines via NEXT, gates on CONTINUE', async () => {
    resetPlayback();
    setMode(AppMode.MENU);
    const ui = stubUi();
    const renderer = stubRenderer();
    const { convo, participants, state } = fixture();

    let resolved = false;
    const done = playConversation({
      convo, participants, state, renderer, ui, manageHud: true,
    }).then(r => { resolved = true; return r; });

    await _sleep(80);
    assert.ok(ui.calls.includes('exitPlanningMode'), 'planning chrome dropped');
    assert.equal(getMode(), AppMode.RESOLVING, 'presents inside RESOLVING');
    assert.equal(ui.cardStates.at(-1), 'playing');

    // NEXT through both dialog lines.
    await pumpNext(() => ui.cardStates.includes('done'));
    assert.equal(renderer.bubbles.length, 2, 'one bubble per line');
    playback.stepRequested = false;

    // Finished: card shows done with REPLAY + CONTINUE; player not released yet.
    assert.equal(ui.cardStates.at(-1), 'done');
    assert.equal(typeof ui.cardHandlers.onContinue, 'function', 'CONTINUE offered');
    await _sleep(150);
    assert.equal(resolved, false, 'holds until CONTINUE');
    assert.ok(!ui.calls.includes('hideTimeline'), 'card stays up during the hold');

    // CONTINUE dismisses the card and resolves.
    ui.cardHandlers.onContinue();
    const result = await done;
    assert.equal(result.skipped, false);
    assert.ok(ui.calls.includes('hideTimeline'), 'timeline dismissed on CONTINUE');
    assert.ok(ui.calls.includes('hideHUD'));
    assert.ok(renderer.bubbles.every(b => b.disposed), 'no leaked bubbles');
  });

  test('onComplete walk-off runs only AFTER CONTINUE — NPC still present during the REPLAY hold', async () => {
    resetPlayback();
    setMode(AppMode.MENU);
    const ui = stubUi();
    const renderer = stubRenderer();
    const { convo, participants, state } = fixture();
    const convDef = {
      id: 'intro',
      onComplete: [
        { action: 'move', npc: 'john', path: [{ col: 2, row: 5 }] },
        { action: 'despawn', npc: 'john' },
      ],
    };

    const done = playConversation({
      convo, participants, state, renderer, ui, convDef,
      manageHud: true, runOnComplete: true,
    });

    await pumpNext(() => ui.cardStates.includes('done'));
    playback.stepRequested = false;

    // Give a buggy pre-CONTINUE walk-off (move + 200ms despawn hold) time to
    // land. The NPC must still be on the map while the card offers
    // REPLAY/CONTINUE — otherwise REPLAY re-runs with the speaker gone.
    await _sleep(400);
    assert.ok(state.entities.some(e => e.npcId === 'john'),
      'NPC still on the map during the REPLAY/CONTINUE hold');

    ui.cardHandlers.onContinue();
    await done;
    assert.ok(!state.entities.some(e => e.npcId === 'john'),
      'walk-off ran after CONTINUE dismissed the card');
  });

  test('SKIP falls straight through to resolution (no CONTINUE hold)', async () => {
    resetPlayback();
    setMode(AppMode.MENU);
    const ui = stubUi();
    const renderer = stubRenderer();
    const { convo, participants, state } = fixture();

    const done = playConversation({
      convo, participants, state, renderer, ui, manageHud: true,
    });
    await _sleep(80);
    ui.cardHandlers.onSkip();   // card SKIP button
    const result = await done;
    assert.equal(result.skipped, true);
    assert.ok(ui.calls.includes('hideTimeline'));
  });

  test('mid-replay (manageHud: false) offers no CONTINUE and resolves on its own', async () => {
    resetPlayback();
    setMode(AppMode.RESOLVING);
    playback.paused = true;
    const ui = stubUi();
    const renderer = stubRenderer();
    const { convo, participants, state } = fixture();

    let resolved = false;
    const done = playConversation({
      convo, participants, state, renderer, ui, manageHud: false, runOnComplete: false,
    }).then(r => { resolved = true; return r; });

    await pumpNext(() => resolved);
    await done;
    assert.equal(ui.cardHandlers.onContinue, undefined, 'no CONTINUE mid-replay');
    assert.ok(!ui.calls.includes('hideTimeline'), 'live timeline left for the step loop');
    assert.ok(!ui.calls.includes('showHUD'), 'reuses the step loop HUD');
    resetPlayback();
  });
});

describe('playConversation — per-line camera framing', () => {
  test('follow cam reframes the SPEAKER before every line (not once)', async () => {
    resetPlayback();
    setMode(AppMode.MENU);
    const ui = stubUi();                 // replayCameraMode: 'follow'
    const renderer = stubRenderer();
    const { convo, participants, state } = fixture();

    const done = playConversation({ convo, participants, state, renderer, ui, manageHud: true });
    await pumpNext(() => ui.cardStates.includes('done'));
    playback.stepRequested = false;

    // One frame call per line, each focused on that line's speaker entity.
    assert.equal(renderer.frameCalls.length, 2, 'reframed once per line, not once total');
    assert.deepEqual(renderer.frameCalls[0].ids, ['e1'], 'line 1 frames the hero speaker');
    assert.deepEqual(renderer.frameCalls[1].ids, ['e2'], 'line 2 frames the NPC speaker');
    assert.ok(renderer.frameCalls[0].opts?.cardExtent >= 2, 'reserves bubble headroom');
    assert.equal(ui.arrowCalls.length, 0, 'no off-screen arrow in follow mode');

    ui.cardHandlers.onContinue?.();
    await done;
  });

  test('fixed cam does NOT reframe — points an off-screen arrow at each speaker', async () => {
    resetPlayback();
    setMode(AppMode.MENU);
    const ui = stubUi();
    ui.replayCameraMode = 'fixed';       // player took camera control
    const renderer = stubRenderer();
    const { convo, participants, state } = fixture();

    const done = playConversation({ convo, participants, state, renderer, ui, manageHud: true });
    await pumpNext(() => ui.cardStates.includes('done'));
    playback.stepRequested = false;

    assert.equal(renderer.frameCalls.length, 0, 'fixed camera is never reframed');
    assert.equal(ui.arrowCalls.length, 2, 'an arrow points at each line\'s speaker');
    assert.deepEqual(ui.arrowCalls[0], { col: 2, row: 7 }, 'arrow at the hero');
    assert.deepEqual(ui.arrowCalls[1], { col: 3, row: 6 }, 'arrow at the NPC');

    ui.cardHandlers.onContinue?.();
    await done;
  });
});

describe('conversationReadingMs', () => {
  // The floor was 1600ms — that produced a ~1s "dead air" gap after short
  // narration clips (e.g. "Run!") and made autoplay feel sluggish between
  // dialog lines. Tighten the floor toward 300–500ms so short beats step
  // briskly while long lines still get the per-character read time.
  test('floor for a very short line is snappy (<= 500ms), not a ~1s wait', () => {
    const floor = conversationReadingMs('');
    assert.ok(floor <= 500, `floor too long: ${floor}ms`);
    assert.ok(floor >= 250, `floor too short to read at all: ${floor}ms`);
  });
  test('ceiling stays at 6s for long lines', () => {
    assert.equal(conversationReadingMs('x'.repeat(500)), 6000);
  });
  test('long lines still get per-character reading time', () => {
    // A roughly 30-char line should give the reader at least 1s.
    assert.ok(conversationReadingMs('x'.repeat(30)) >= 1000);
    // A ~80-char line should give the reader well over 2s.
    assert.ok(conversationReadingMs('x'.repeat(80)) >= 2000);
  });
});

// A minimal HTMLAudioElement stand-in: records listeners, lets the test fire
// `ended` / `error` on a real timer to drive the auto-advance gate.
function fakeAudio() {
  const listeners = {};
  const a = {
    ended: false,
    addEventListener(ev, fn) { (listeners[ev] ||= []).push(fn); },
    fire(ev) {
      if (ev === 'ended') a.ended = true;
      (listeners[ev] || []).forEach(fn => fn());
    },
  };
  return a;
}

describe('awaitConversationLineEnd — auto-advance respects narration length', () => {
  // The core bug: autoplay advanced after the text-based reading estimate even
  // when the spoken clip ran longer, cutting the sentence off. Advance must wait
  // until max(reading floor, clip end).
  test('a long clip holds until audio.ended — not the shorter reading floor', async () => {
    const audio = fakeAudio();
    setTimeout(() => audio.fire('ended'), 350);   // clip outlives the floor
    const t0 = Date.now();
    await awaitConversationLineEnd(audio, 'short line', { floorMs: 150 });
    const dt = Date.now() - t0;
    assert.ok(dt >= 320, `expected to wait for audio end (~350ms), advanced at ${dt}ms`);
  });

  test('a fast clip still holds for the reading floor (max, not the clip end)', async () => {
    const audio = fakeAudio();
    setTimeout(() => audio.fire('ended'), 80);    // clip ends well before the floor
    const t0 = Date.now();
    await awaitConversationLineEnd(audio, 'a much longer line of dialog', { floorMs: 350 });
    const dt = Date.now() - t0;
    assert.ok(dt >= 320, `expected to hold for the reading floor (~350ms), advanced at ${dt}ms`);
  });

  test('no clip (muted / headless) advances at the reading floor', async () => {
    const t0 = Date.now();
    await awaitConversationLineEnd(null, 'x', { floorMs: 150, ceilingMs: 5000 });
    const dt = Date.now() - t0;
    assert.ok(dt >= 130 && dt < 400, `expected ~150ms floor, advanced at ${dt}ms`);
  });

  test('a failed clip (error event, never ends) falls back to the reading floor', async () => {
    const audio = fakeAudio();
    setTimeout(() => audio.fire('error'), 80);    // missing file: only `error` fires
    const t0 = Date.now();
    await awaitConversationLineEnd(audio, 'x', { floorMs: 150, ceilingMs: 5000 });
    const dt = Date.now() - t0;
    assert.ok(dt >= 130 && dt < 500, `expected reading-floor fallback (~150ms), advanced at ${dt}ms`);
  });

  test('shouldStop (SKIP / NEXT) collapses even a long voice hold', async () => {
    const audio = fakeAudio();   // never fires ended → a 5s+ hold without the skip
    let stop = false;
    setTimeout(() => { stop = true; }, 120);
    const t0 = Date.now();
    await awaitConversationLineEnd(audio, 'x', { floorMs: 5000, shouldStop: () => stop });
    const dt = Date.now() - t0;
    assert.ok(dt >= 100 && dt < 400, `expected NEXT/SKIP to collapse the hold, advanced at ${dt}ms`);
  });

  test('a stalled clip that never ends is bounded by the ceiling', async () => {
    const audio = fakeAudio();   // neither `ended` nor `error` ever fires
    const t0 = Date.now();
    await awaitConversationLineEnd(audio, 'x', { floorMs: 100, ceilingMs: 250 });
    const dt = Date.now() - t0;
    assert.ok(dt >= 230 && dt < 500, `expected ceiling backstop (~250ms), advanced at ${dt}ms`);
  });
});
