// ═══════════════════════════════════════════════════════════════════════════
// Mission editor — canvas pan / zoom / paint input wiring
// ─────────────────────────────────────────────────────────────────────────────
// The 2D editor draws through the SAME `Renderer` the game uses (src/renderer.js),
// which already implements transform-aware zoom (`setZoom`), pan (`_panX/_panY`
// + `_clampPan`) and the inverse `canvasToHex()`. This module wires those
// existing capabilities to the editor canvas: mouse-wheel / pinch to zoom,
// drag to pan, and a single left click to paint — WITHOUT re-implementing any
// transform maths.
//
// The pure helpers (pointerToCanvas / isPanDrag / hexFromPointer) are split out
// so the click→hex correctness under a non-default zoom + pan can be unit-tested
// against a real Renderer with no browser (see editor-canvas-input.test.js).
// ═══════════════════════════════════════════════════════════════════════════

// A drag must travel beyond this many CSS px before it counts as a pan gesture
// rather than a paint click. Mirrors ui.js's 5px drag-vs-click threshold so the
// editor feels identical to the in-game canvas.
export const PAN_DRAG_THRESHOLD_PX = 5;

// Wheel notch → zoom multiplier. One notch zooms in/out by this factor.
export const WHEEL_ZOOM_STEP = 1.1;

/**
 * Scale a pointer's client (CSS-pixel) coordinates into canvas backing-store
 * coordinates using the element's bounding rect. Returns null when the rect has
 * no area (canvas not laid out yet) so callers can bail safely.
 */
export function pointerToCanvas(clientX, clientY, rect, canvas) {
  if (!rect || !rect.width || !rect.height) return null;
  return {
    x: (clientX - rect.left) * (canvas.width / rect.width),
    y: (clientY - rect.top) * (canvas.height / rect.height),
  };
}

/**
 * Map a pointer (client coords) to a hex via the renderer's transform-aware
 * `canvasToHex()`. Because canvasToHex inverts the current zoom + pan, the hex
 * returned is correct under any view transform — provided we hand it canvas
 * backing-store coords (NOT raw client coords). Returns null if the canvas has
 * no layout yet.
 */
export function hexFromPointer(renderer, clientX, clientY, rect, canvas) {
  const pt = pointerToCanvas(clientX, clientY, rect, canvas);
  if (!pt) return null;
  return renderer.canvasToHex(pt.x, pt.y);
}

/**
 * True once a drag has travelled far enough to count as a pan (so the trailing
 * "click" must NOT paint a tile). dx/dy are in CSS px relative to the press.
 */
export function isPanDrag(dx, dy, threshold = PAN_DRAG_THRESHOLD_PX) {
  return Math.hypot(dx, dy) > threshold;
}

/**
 * Attach pan + zoom + paint controls to a 2D editor canvas backed by `renderer`.
 *
 *  • left-drag (beyond threshold) → pan (renderer._panX/_panY + _clampPan)
 *  • mouse wheel                  → zoom toward the cursor (renderer.setZoom)
 *  • one-finger drag (touch)      → pan; two-finger → pinch zoom
 *  • plain left click / tap       → onPaint(hex)   (suppressed after a pan)
 *
 * @param {HTMLCanvasElement} canvas
 * @param {import('../renderer.js').Renderer} renderer
 * @param {object} cb
 * @param {(hex:{col:number,row:number}) => void} cb.onPaint  fired on a non-drag click/tap
 * @param {(pt:{x:number,y:number}) => boolean} [cb.onCanvasClick] fired with canvas
 *        backing-store coords on a non-drag click/tap BEFORE onPaint; return true to
 *        consume the click (e.g. it hit an on-canvas control) and suppress painting.
 * @param {() => void} [cb.onRedraw]                          redraw after pan/zoom
 * @returns {() => void} detach — removes every listener it added
 */
export function attachEditorCanvasControls(canvas, renderer, { onPaint, onCanvasClick, onHover, onRedraw } = {}) {
  const ac = new AbortController();
  const sig = { signal: ac.signal };
  const redraw = () => { try { onRedraw?.(); } catch { /* ignore */ } };
  const hover = (hex) => { try { onHover?.(hex); } catch { /* ignore */ } };

  // ── Mouse: drag-to-pan, wheel-to-zoom, click-to-paint ───────────────────
  let down = null;        // { x, y } at mousedown (client coords)
  let didDrag = false;

  canvas.addEventListener('mousedown', (e) => {
    if (renderer.viewLocked) return;
    down = { x: e.clientX, y: e.clientY };
    didDrag = false;
    canvas.style.cursor = 'grabbing';
  }, sig);

  canvas.addEventListener('mousemove', (e) => {
    if (!down) {
      // Not pressed → a plain hover. Report the hex under the cursor so the
      // editor can preview (e.g. the building-footprint ghost overlay).
      if (onHover) {
        const rect = canvas.getBoundingClientRect();
        const pt = pointerToCanvas(e.clientX, e.clientY, rect, canvas);
        hover(pt ? renderer.canvasToHex(pt.x, pt.y) : null);
      }
      return;
    }
    const dx = e.clientX - down.x;
    const dy = e.clientY - down.y;
    if (!isPanDrag(dx, dy)) return;
    didDrag = true;
    renderer._zoomAnim = null; // cancel any auto-framing on manual pan
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / (rect.width || 1);
    const scaleY = canvas.height / (rect.height || 1);
    renderer._panX += dx * scaleX;
    renderer._panY += dy * scaleY;
    renderer._clampPan();
    down = { x: e.clientX, y: e.clientY };
    redraw();
  }, sig);

  // Release on document so a drag that ends off-canvas still clears state.
  document.addEventListener('mouseup', () => {
    if (down) { down = null; canvas.style.cursor = ''; }
  }, sig);

  // Clear the hover preview when the cursor leaves the canvas.
  canvas.addEventListener('mouseleave', () => hover(null), sig);

  canvas.addEventListener('click', (e) => {
    if (didDrag) { didDrag = false; return; } // a pan, not a paint
    const rect = canvas.getBoundingClientRect();
    const pt = pointerToCanvas(e.clientX, e.clientY, rect, canvas);
    if (!pt) return;
    if (onCanvasClick?.(pt)) return; // consumed by an on-canvas control (e.g. resize button)
    const hex = renderer.canvasToHex(pt.x, pt.y);
    if (hex) onPaint?.(hex);
  }, sig);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (renderer.viewLocked) return;
    const rect = canvas.getBoundingClientRect();
    const pt = pointerToCanvas(e.clientX, e.clientY, rect, canvas);
    if (!pt) return;
    const factor = e.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP;
    renderer.setZoom(renderer.zoomLevel * factor, pt.x, pt.y);
    redraw();
  }, { passive: false, ...sig });

  // ── Touch: one-finger pan / tap-to-paint, two-finger pinch-zoom ──────────
  let touchStart = null;   // { x, y } for one-finger drag tracking
  let touchDidDrag = false;
  let pinchDist = 0;

  const dist2 = (t) => Math.hypot(
    t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY,
  );

  canvas.addEventListener('touchstart', (e) => {
    if (renderer.viewLocked) return;
    if (e.touches.length === 1) {
      touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      touchDidDrag = false;
    } else if (e.touches.length === 2) {
      pinchDist = dist2(e.touches);
      touchStart = null; // a second finger cancels any pending paint
    }
  }, sig);

  canvas.addEventListener('touchmove', (e) => {
    if (renderer.viewLocked) return;
    if (e.touches.length === 2 && pinchDist > 0) {
      e.preventDefault();
      const newDist = dist2(e.touches);
      const rect = canvas.getBoundingClientRect();
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const pt = pointerToCanvas(midX, midY, rect, canvas);
      if (pt) renderer.setZoom(renderer.zoomLevel * (newDist / pinchDist), pt.x, pt.y);
      pinchDist = newDist;
      redraw();
    } else if (e.touches.length === 1 && touchStart) {
      const dx = e.touches[0].clientX - touchStart.x;
      const dy = e.touches[0].clientY - touchStart.y;
      if (!isPanDrag(dx, dy)) return;
      e.preventDefault();
      touchDidDrag = true;
      renderer._zoomAnim = null;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / (rect.width || 1);
      const scaleY = canvas.height / (rect.height || 1);
      renderer._panX += dx * scaleX;
      renderer._panY += dy * scaleY;
      renderer._clampPan();
      touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      redraw();
    }
  }, { passive: false, ...sig });

  canvas.addEventListener('touchend', (e) => {
    // A clean one-finger tap (no drag, no pinch) paints — unless it hits an
    // on-canvas control (resize button), which consumes the tap first.
    if (touchStart && !touchDidDrag && e.changedTouches.length) {
      const rect = canvas.getBoundingClientRect();
      const t = e.changedTouches[0];
      const pt = pointerToCanvas(t.clientX, t.clientY, rect, canvas);
      if (pt && !onCanvasClick?.(pt)) {
        const hex = renderer.canvasToHex(pt.x, pt.y);
        if (hex) onPaint?.(hex);
      }
    }
    if (e.touches.length === 0) { touchStart = null; touchDidDrag = false; pinchDist = 0; }
  }, sig);

  return () => ac.abort();
}
