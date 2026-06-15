// ═══════════════════════════════════════════════════════════════════════════
// Shared pan/zoom for the node-graph editors (logic graph + campaign DAG)
// ─────────────────────────────────────────────────────────────────────────────
// Turns a scroll viewport into an infinite pannable/zoomable canvas. The caller
// gives a `viewport` (clips, position:relative) and a `world` element holding the
// nodes; this applies a CSS `translate()+scale()` transform to `world`, pans on
// background-drag, and zooms toward the cursor on wheel. Edges are drawn on a
// SCREEN-SPACE SVG (sibling of `world`, not transformed), so the caller redraws
// them from getBoundingClientRect()-based pin centers (which already reflect the
// transform) — keeping edge stroke widths crisp at any zoom. `onChange` fires
// after every pan/zoom so the caller can redraw edges.
// ═══════════════════════════════════════════════════════════════════════════

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.5;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * @param {HTMLElement} viewport - the clipping container (position:relative, overflow:hidden)
 * @param {HTMLElement} world - the transformed layer that holds the node cards
 * @param {object} opts
 * @param {string} opts.nodeSelector - CSS selector for node cards (pan only starts off a node)
 * @param {() => void} opts.onChange - called after every pan/zoom (redraw edges)
 * @returns {{ view, apply, getZoom, screenPoint, reset }}
 */
export function createPanZoom(viewport, world, { nodeSelector, onChange } = {}) {
  const view = { panX: 0, panY: 0, zoom: 1 };

  const apply = () => {
    world.style.transformOrigin = '0 0';
    world.style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`;
    onChange?.();
  };

  // ── pan: drag on empty background ───────────────────────────────────────────
  viewport.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (nodeSelector && e.target.closest?.(nodeSelector)) return; // dragging a node, not the canvas
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ox = view.panX, oy = view.panY;
    viewport.style.cursor = 'grabbing';
    const move = (m) => { view.panX = ox + (m.clientX - sx); view.panY = oy + (m.clientY - sy); apply(); };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); viewport.style.cursor = ''; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  // ── zoom: wheel toward the cursor ───────────────────────────────────────────
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const cr = viewport.getBoundingClientRect();
    const cx = e.clientX - cr.left, cy = e.clientY - cr.top;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    // Keep the world point under the cursor fixed across the zoom.
    const wx = (cx - view.panX) / view.zoom;
    const wy = (cy - view.panY) / view.zoom;
    view.panX = cx - wx * next;
    view.panY = cy - wy * next;
    view.zoom = next;
    apply();
  }, { passive: false });

  /** A mouse event's position in viewport screen-space (for the SVG edge layer). */
  const screenPoint = (m) => {
    const cr = viewport.getBoundingClientRect();
    return { x: m.clientX - cr.left, y: m.clientY - cr.top };
  };

  const reset = () => { view.panX = 0; view.panY = 0; view.zoom = 1; apply(); };

  apply();
  return { view, apply, getZoom: () => view.zoom, screenPoint, reset };
}
