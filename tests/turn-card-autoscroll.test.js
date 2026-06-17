// Tests for the turn-card auto-scroll decision helpers in src/ui-render.js.
//
// Long turn cards (busy resolution rounds in big games) are CSS-scrollable.
// As resolution advances, the UI auto-scrolls the active action into the upper
// portion of the card — UNLESS the player has just scrolled manually, in which
// case it stands down so we don't yank the card away while they're reading.
//
// The decision logic is DOM-free (caller feeds it timestamps + boolean flags),
// so unit tests can pin down the contract without any browser harness.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TurnCardAutoScroll,
  TURN_CARD_AUTOSCROLL_SUSPEND_MS,
  shouldAutoScrollToActive,
  computeFadeFlags,
} from '../src/ui-render.js';

describe('TurnCardAutoScroll', () => {
  test('fresh controller is not suspended — the player has never scrolled', () => {
    const c = new TurnCardAutoScroll();
    assert.equal(c.isSuspended(1_000_000), false);
    assert.equal(c.shouldAutoScroll(1_000_000), true);
  });

  test('a manual scroll suspends auto-scroll for the configured window', () => {
    const c = new TurnCardAutoScroll({ windowMs: 4000 });
    c.notifyUserScroll(10_000);
    assert.equal(c.isSuspended(10_000), true);          // immediately suspended
    assert.equal(c.isSuspended(13_999), true);          // still inside window
    assert.equal(c.isSuspended(14_000), false);         // window elapsed exactly
    assert.equal(c.isSuspended(20_000), false);         // and well past it
  });

  test('each scroll resets the suspend timer — repeated user scrolls keep it suspended', () => {
    const c = new TurnCardAutoScroll({ windowMs: 4000 });
    c.notifyUserScroll(10_000);
    // ... the player keeps wheel-scrolling every second ...
    c.notifyUserScroll(11_000);
    c.notifyUserScroll(12_000);
    c.notifyUserScroll(13_000);
    // 4s after the FIRST scroll would have expired (14_000), but the LAST one
    // (13_000) extends the window to 17_000.
    assert.equal(c.isSuspended(14_000), true,  'still suspended — last scroll resets the timer');
    assert.equal(c.isSuspended(16_999), true,  'still inside the reset window');
    assert.equal(c.isSuspended(17_000), false, 'window elapsed from the last scroll');
  });

  test('reset() forgets any prior manual scroll (fresh-round mount path)', () => {
    const c = new TurnCardAutoScroll({ windowMs: 4000 });
    c.notifyUserScroll(10_000);
    assert.equal(c.isSuspended(11_000), true);
    c.reset();
    assert.equal(c.isSuspended(11_000), false, 'reset clears the suspend');
    assert.equal(c.isSuspended(20_000), false);
  });

  test('shouldAutoScroll is the inverse of isSuspended', () => {
    const c = new TurnCardAutoScroll({ windowMs: 4000 });
    c.notifyUserScroll(10_000);
    assert.equal(c.shouldAutoScroll(11_000), false);
    assert.equal(c.shouldAutoScroll(20_000), true);
  });

  test('exported default suspend window is the documented N seconds', () => {
    // Operator-tunable knob; the default is the value used when no override is
    // passed at construction. Pinning it down so a casual change is flagged.
    assert.equal(typeof TURN_CARD_AUTOSCROLL_SUSPEND_MS, 'number');
    assert.ok(TURN_CARD_AUTOSCROLL_SUSPEND_MS >= 1500 && TURN_CARD_AUTOSCROLL_SUSPEND_MS <= 10_000,
      `suspend window ${TURN_CARD_AUTOSCROLL_SUSPEND_MS}ms should be in a sane player-comfort range`);
    // When constructed with no opts the default is what's documented.
    const c = new TurnCardAutoScroll();
    c.notifyUserScroll(0);
    assert.equal(c.isSuspended(TURN_CARD_AUTOSCROLL_SUSPEND_MS - 1), true);
    assert.equal(c.isSuspended(TURN_CARD_AUTOSCROLL_SUSPEND_MS),     false);
  });
});

describe('shouldAutoScrollToActive', () => {
  test('green-light when there is an active row and no manual scroll', () => {
    assert.equal(shouldAutoScrollToActive({ suspended: false, collapsed: false, hasActive: true }), true);
  });

  test('stands down while a recent manual scroll suspends auto-scroll', () => {
    assert.equal(shouldAutoScrollToActive({ suspended: true,  collapsed: false, hasActive: true }), false);
  });

  test('stands down for collapsed cards — only the active row shows, scroll would just jump', () => {
    assert.equal(shouldAutoScrollToActive({ suspended: false, collapsed: true,  hasActive: true }), false);
  });

  test('no-op when no row is acting yet (between actions)', () => {
    assert.equal(shouldAutoScrollToActive({ suspended: false, collapsed: false, hasActive: false }), false);
  });

  test('default opts behave as the happy path (active + not suspended + expanded)', () => {
    assert.equal(shouldAutoScrollToActive({}), true);
    assert.equal(shouldAutoScrollToActive(), true);
  });

  test('suspended beats collapsed beats hasActive — short-circuit order does not leak', () => {
    // No matter the other flags, a suspended player wins (don't fight them).
    assert.equal(shouldAutoScrollToActive({ suspended: true, collapsed: true, hasActive: false }), false);
    assert.equal(shouldAutoScrollToActive({ suspended: true, collapsed: false, hasActive: true }), false);
    // Collapsed + active still false (collapsed shows just the active row).
    assert.equal(shouldAutoScrollToActive({ suspended: false, collapsed: true, hasActive: true }), false);
  });
});

// ── computeFadeFlags ─────────────────────────────────────────────────────────
//
// The fade mask on turn cards should appear only when content is actually
// clipped above or below the visible viewport. A card that fits entirely on
// screen MUST get no fade — otherwise readable text dims for no reason
// (operator-reported regression, 2026-06-17).

describe('computeFadeFlags', () => {
  test('card content fits entirely → no fade either edge', () => {
    assert.deepEqual(
      computeFadeFlags({ scrollTop: 0, clientHeight: 400, scrollHeight: 300 }),
      { top: false, bottom: false },
    );
    assert.deepEqual(
      computeFadeFlags({ scrollTop: 0, clientHeight: 400, scrollHeight: 400 }),
      { top: false, bottom: false },
    );
  });

  test('content overflows, scrolled to top → bottom fade only', () => {
    assert.deepEqual(
      computeFadeFlags({ scrollTop: 0, clientHeight: 400, scrollHeight: 800 }),
      { top: false, bottom: true },
    );
  });

  test('mid-scroll → both fades', () => {
    assert.deepEqual(
      computeFadeFlags({ scrollTop: 200, clientHeight: 400, scrollHeight: 800 }),
      { top: true, bottom: true },
    );
  });

  test('content overflows, scrolled to bottom → top fade only', () => {
    assert.deepEqual(
      computeFadeFlags({ scrollTop: 400, clientHeight: 400, scrollHeight: 800 }),
      { top: true, bottom: false },
    );
  });

  test('1px tolerance absorbs sub-pixel offsets at the bottom edge', () => {
    // Smooth scroll lands at 399.7 against scrollHeight 800; treat as bottom.
    assert.deepEqual(
      computeFadeFlags({ scrollTop: 399.7, clientHeight: 400, scrollHeight: 800 }),
      { top: true, bottom: false },
    );
  });

  test('defaults — empty input behaves as a non-overflowing empty card', () => {
    assert.deepEqual(computeFadeFlags(), { top: false, bottom: false });
    assert.deepEqual(computeFadeFlags({}), { top: false, bottom: false });
  });
});
