/**
 * Reveal coordinator for the shared loading overlay.
 *
 * Several init paths drive the SAME `#loading-overlay` + `#game-canvas`:
 * `_setupLocalUI` (local), `initOnline` (online), `_initSpectatorUI`
 * (spectator). They are fire-and-forget and not awaited, so two can run
 * concurrently — the everyday trigger is a double-tap on "Start" (each tap
 * runs `init()` → a fresh renderer → a fresh reveal), but any re-entry of an
 * init path does it.
 *
 * Both reveals then race over the one overlay. Whichever renderer's assets
 * settle first fades the scene in; the slower one — still mid-load — re-shows
 * the overlay over the just-revealed scene with the stale label of whatever
 * its last asset happened to be (typically "forest", the heaviest GLB load).
 * The player sees: "the scene comes in and then it goes back to the loading
 * screen for forest."
 *
 * `makeShowLoadingAndReveal()` returns a `showLoadingAndReveal(renderer)`
 * bound to a monotonic token. Each invocation claims the latest token; only
 * the most-recent claimant is allowed to drive the shared overlay/canvas
 * (progress bar, fade-in, and the deferred hide). A superseded reveal becomes
 * a no-op on the shared DOM, so the overlay reveals exactly once — for the
 * renderer the game actually ends up using (the last init wins).
 *
 * Dependencies are injected so the coordinator is unit-testable without a DOM:
 *   - `doc`      — defaults to `globalThis.document`
 *   - `raf`      — requestAnimationFrame; defaults to the global (or setTimeout)
 *   - `setTimer` — setTimeout for the fade-out hide; defaults to the global
 *   - `hideDelayMs` — overlay hide delay after the fade starts (350ms = fade-out
 *                     300ms + a small margin so opacity has reached 0)
 */
export function makeShowLoadingAndReveal({ doc, raf, setTimer, hideDelayMs = 350 } = {}) {
  const getDoc = () => doc ?? (typeof document !== 'undefined' ? document : null);
  const requestFrame = raf
    ?? ((cb) => (typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(cb)
      : setTimeout(cb, 16)));
  const schedule = setTimer ?? ((cb, ms) => setTimeout(cb, ms));

  // Monotonic reveal token. Incremented on every call; a reveal only touches
  // the shared overlay while its token is still the latest one issued.
  let latestToken = 0;

  return async function showLoadingAndReveal(renderer) {
    const myToken = ++latestToken;
    const isCurrent = () => myToken === latestToken;

    const document = getDoc();
    const overlay = document?.getElementById('loading-overlay');
    const canvas  = document?.getElementById('game-canvas');
    const fill    = overlay?.querySelector('.loading-bar-fill');
    const label   = overlay?.querySelector('.loading-label');

    if (overlay) {
      overlay.hidden = false;
      overlay.classList.remove('fading-out');
    }
    canvas?.classList.remove('canvas-ready');
    if (fill) fill.style.width = '0%';

    renderer.onProgress = (progress01, what) => {
      // A superseded renderer's load must not drive the shared progress bar.
      if (!isCurrent()) return;
      if (fill && typeof progress01 === 'number') {
        const pct = Math.max(0, Math.min(100, Math.round(progress01 * 100)));
        fill.style.width = `${pct}%`;
      }
      if (label && what) label.textContent = `Loading ${what}…`;
    };

    try {
      renderer.beginLoad();
      await renderer.whenReady();
    } catch (err) {
      console.warn('[main] asset load failed; revealing scene anyway:', err);
    }

    // A newer reveal claimed the overlay while we were loading — leave the
    // shared DOM entirely to it. This is the guard that stops a slower, stale
    // reveal from re-covering an already-revealed scene.
    if (!isCurrent()) return;

    // Draw the first full-quality frame while the overlay still covers it, then
    // wait one animation frame so the canvas has painted before the fade-in.
    try { renderer.draw(); } catch { /* draw is defensive — ignore */ }
    await new Promise((r) => requestFrame(r));
    if (!isCurrent()) return;

    canvas?.classList.add('canvas-ready'); // 400ms fade-in
    if (overlay) {
      overlay.classList.add('fading-out');  // 300ms fade-out
      schedule(() => {
        if (!isCurrent()) return;
        overlay.hidden = true;
        overlay.classList.remove('fading-out');
      }, hideDelayMs);
    }
  };
}
