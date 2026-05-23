// Unified hex-overlay descriptor + layer/Y policy. Foundation for collapsing
// the renderer's scattered highlight systems behind one upsert-by-id model.
// See docs/05-game-systems.md (rendering) and the migration plan.

import { hexKey } from './hex.js';

/** Z-order of overlay layers, low to high. */
export const LAYERS = Object.freeze([
  'objective-tint',
  'fill',
  'plan-line',
  'outline',
  'selection',
  'objective-ring',
  'highlight-disc',
  'plan-arrow',
  'flash',
  'spotlight',
]);

/** Per-layer 3D Y elevation band. Per-overlay Y nests within [min, max]. */
export const Y_TABLE = Object.freeze({
  'objective-tint': { min: 0.030, max: 0.045 },
  'fill':           { min: 0.060, max: 0.075 },
  'plan-line':      { min: 0.080, max: 0.095 },
  'outline':        { min: 0.100, max: 0.115 },
  'selection':      { min: 0.120, max: 0.135 },
  'objective-ring': { min: 0.140, max: 0.155 },
  'highlight-disc': { min: 0.160, max: 0.175 },
  'plan-arrow':     { min: 0.180, max: 0.195 },
  'flash':          { min: 0.220, max: 0.235 },
  'spotlight':      { min: 0.240, max: 0.255 },
});

/** Y elevation for an overlay in `layer`, nested by index, clamped to the band. */
export function yForLayer(layer, nestedIndex = 0) {
  const band = Y_TABLE[layer];
  if (!band) throw new Error(`yForLayer: unknown layer "${layer}"`);
  return Math.min(band.min + nestedIndex * 0.005, band.max);
}

/** Overlay shapes the renderer knows how to build. */
export const OVERLAY_KINDS = Object.freeze([
  'fill',
  'outline',
  'ring-pulse',
  'symbol',
  'plan-arrow',
  'spotlight',
  'flash',
]);

/** Normalise a hex entry (string key or {col,row}) to a hex key string. */
function toHexKey(h) {
  if (typeof h === 'string') return h;
  return hexKey(h.col, h.row);
}

/**
 * Build a frozen overlay descriptor. Validates kind/layer/id and normalises
 * hexes to a Set<string> (or, for plan-arrow, path to an ordered Array<string>).
 * @returns {{ id, kind, layer, hexes:Set<string>, path?:string[], style, animation?, meta? }}
 */
export function makeOverlay({ id, kind, layer, hexes, style, animation, meta, path }) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('makeOverlay: id must be a non-empty string');
  }
  if (!OVERLAY_KINDS.includes(kind)) {
    throw new Error(`makeOverlay: unknown kind "${kind}"`);
  }
  if (!LAYERS.includes(layer)) {
    throw new Error(`makeOverlay: unknown layer "${layer}"`);
  }

  const descriptor = {
    id,
    kind,
    layer,
    style: Object.freeze({ ...(style ?? {}) }),
  };

  if (kind === 'plan-arrow') {
    const arr = Array.isArray(path) ? path.map(toHexKey) : [];
    descriptor.path = Object.freeze(arr);
    descriptor.hexes = Object.freeze(new Set(arr));
  } else {
    const src = hexes instanceof Set ? Array.from(hexes) : (hexes ?? []);
    descriptor.hexes = Object.freeze(new Set(src.map(toHexKey)));
  }

  if (animation) descriptor.animation = Object.freeze({ ...animation });
  if (meta) descriptor.meta = Object.freeze({ ...meta });

  return Object.freeze(descriptor);
}

/** Stable id order for reconstituting the (read-only, legacy) flat
 *  `highlightHexes` array from the overlay map. The colour-sniffing *setter*
 *  was retired in PR 2 — ui.js now writes these ids directly via setOverlay —
 *  so this list is only consumed by the deprecated getter below. */
const HIGHLIGHT_IDS = Object.freeze([
  'move-targets', 'battle-targets', 'battle-hex-targets', 'guard-zone', 'misc-highlights',
]);

/** One-shot guard so a stray legacy `renderer.highlightHexes = [...]` write
 *  warns once instead of spamming the console every frame. */
let _warnedHighlightSetter = false;

/** Parse a "col,row" hex key back to numeric coords. */
function parseHexKey(key) {
  const [col, row] = key.split(',').map(Number);
  return { col, row };
}

/**
 * The unified overlay API as plain methods (use `this`). Shared between the
 * renderer prototypes (via `Object.assign(<Renderer>.prototype, OVERLAY_METHODS)`
 * — so the static interface-conformance test sees them on the prototype) and
 * plain test doubles (via `installOverlayShims`). One source of truth, no drift.
 */
export const OVERLAY_METHODS = Object.freeze({
  setOverlay(id, overlay) {
    if (overlay == null) { this._overlays.delete(id); return; }
    if (!Object.isFrozen(overlay) || typeof overlay.kind !== 'string') {
      throw new Error('setOverlay: overlay must be produced by makeOverlay()');
    }
    this._overlays.set(id, overlay);
  },

  getOverlay(id) {
    return this._overlays.get(id) ?? null;
  },

  removeOverlay(id) {
    this._overlays.delete(id);
  },

  clearOverlaysByLayer(layer) {
    for (const [id, ov] of this._overlays) {
      if (ov.layer === layer) this._overlays.delete(id);
    }
  },

  setSelection({ entityId = null, hex = null } = {}) {
    this._selection = { entityId, hex };
    if (!hex) {
      this._overlays.delete('selection');
    } else {
      this.setOverlay('selection', makeOverlay({
        id: 'selection', kind: 'outline', layer: 'selection',
        hexes: [hex],
        // Default palette matches the 2D `_drawOutline(glow=true)` selected-hex
        // look: yellow, 2px stroke, glow halo. When `meta.entityId` resolves to
        // a unit the renderers override `color` per-entity (player / faction
        // tint) at draw time — see the 'selection' layer loops in renderer.js
        // and renderer-3d.js. Resolution stays in the renderers because the
        // player-colour map + faction palette live there, not here.
        style: { color: '#f5c842', alpha: 1, strokeWidth: 2, glow: true },
        meta: entityId != null ? { entityId } : undefined,
      }));
    }
    // Single observer hook: ui.js registers one subscriber to toggle the
    // `.plan-unit-selected` class on the plan-panel block. Fired after the
    // overlay + `_selection` are updated so the callback sees fresh state.
    this.onSelectionChange?.({ entityId, hex });
  },

  setHover(hex) {
    this._hover = hex ?? null;
    if (!hex) { this._overlays.delete('hover'); return; }
    this.setOverlay('hover', makeOverlay({
      id: 'hover', kind: 'outline', layer: 'selection',
      hexes: [hex],
      style: { color: 'rgba(255,255,255,0.3)', alpha: 1, strokeWidth: 1, glow: false },
    }));
  },
});

/**
 * Initialise the overlay state (`_overlays` / `_selection` / `_hover`), copy the
 * overlay methods onto plain test doubles (renderer instances already inherit
 * them from the prototype), and define the legacy READ-ONLY `highlightHexes`
 * compat getter. Idempotent — safe to call more than once per instance, even
 * with live overlays in between (verified by a unit test in overlays.test.js).
 *
 * The `selectedHex` / `selectedEntityId` / `hoveredHex` field proxies were
 * retired in PR 3 — all selection / hover state now flows through
 * `setSelection({ entityId, hex })` / `setHover(hex)` and is read off
 * `this._selection` / `this._hover` directly.
 */
export function installOverlayShims(target) {
  // Idempotent: a second call must not wipe an existing overlay map / selection.
  if (!target._overlays) target._overlays = new Map();
  if (!target._selection) target._selection = { entityId: null, hex: null };
  if (target._hover === undefined) target._hover = null;

  // Renderer instances already carry these on their prototype (assigned at
  // module load); only plain test doubles need them copied onto the object.
  if (typeof target.setOverlay !== 'function') Object.assign(target, OVERLAY_METHODS);

  // ── Legacy compat field. `highlightHexes` is READ-ONLY: ui.js writes overlays
  // directly via setOverlay() (PR 2). The setter is a deprecated no-op that
  // warns once if any straggler still assigns to it. ──
  Object.defineProperty(target, 'highlightHexes', {
    configurable: true,
    enumerable: true,
    get() {
      const out = [];
      for (const id of HIGHLIGHT_IDS) {
        const ov = this._overlays.get(id);
        if (!ov) continue;
        const color = ov.style?.color;
        for (const key of Array.from(ov.hexes).sort()) {
          const { col, row } = parseHexKey(key);
          out.push({ col, row, color });
        }
      }
      return out;
    },
    set(_list) {
      if (!_warnedHighlightSetter) {
        _warnedHighlightSetter = true;
        console.warn(
          'renderer.highlightHexes is deprecated and no longer writable — ' +
          'use setOverlay(id, makeOverlay({...})) instead. Ignoring assignment.',
        );
      }
    },
  });
}

/**
 * Pure animation curve for a `ring-pulse` overlay. Given an `animation`
 * descriptor (`{ kind, startedAtMs, durationMs, loop?, maxScale? }`) and the
 * current wall-clock `nowMs`, returns the per-frame `{ radiusScale, alpha,
 * done }` the renderer applies to a ring mesh. Babylon-free so the curve is
 * unit-testable:
 *
 *  • `expand` — radius grows 1 → `maxScale` (default 2) while alpha fades 1 → 0
 *    (node-reveal + death-burst look).
 *  • `pulse`  — radius static; alpha oscillates 0 → 1 → 0 via a sine over the
 *    duration (held-node controller ring).
 *  • `fade`   — radius static; alpha decays 1 → 0 then `done` flips true so the
 *    caller removes the overlay (one-shot).
 *
 * A null/absent animation is the static case: full alpha, unit radius, never
 * done. `loop:true` wraps the phase so the curve repeats instead of completing.
 */
export function ringPulseState(animation, nowMs) {
  if (!animation) return { radiusScale: 1, alpha: 1, done: false };
  const {
    kind, startedAtMs = 0, durationMs = 1, loop = false, maxScale = 2,
  } = animation;
  const raw = (nowMs - startedAtMs) / Math.max(1, durationMs);
  const t = loop ? ((raw % 1) + 1) % 1 : Math.min(1, Math.max(0, raw));
  const done = !loop && raw >= 1;
  switch (kind) {
    case 'expand':
      return { radiusScale: 1 + t * (maxScale - 1), alpha: Math.max(0, 1 - t), done };
    case 'pulse':
      return { radiusScale: 1, alpha: 0.5 + 0.5 * Math.sin(t * Math.PI * 2), done };
    case 'fade':
      return { radiusScale: 1, alpha: Math.max(0, 1 - t), done };
    default:
      return { radiusScale: 1, alpha: 1, done };
  }
}

/**
 * Stable cache key for a renderer overlay material, keyed by colour + alpha +
 * glow. Two overlays whose `(rgb, alpha, glow)` match resolve to the same key
 * (and therefore share one StandardMaterial in the renderer's per-kind cache);
 * any difference yields a distinct key. Colours are rounded to 3 decimals so
 * floating-point dust doesn't fragment the cache. `rgb` is a `[r,g,b]` triple
 * in 0..1.
 */
export function overlayMaterialKey(rgb, alpha = 1, glow = false) {
  const [r = 0, g = 0, b = 0] = rgb ?? [];
  return `${r.toFixed(3)},${g.toFixed(3)},${b.toFixed(3)}|${alpha}|${glow ? 1 : 0}`;
}

/** JSON.stringify with object keys sorted, for stable signatures. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** Stable diff key for an overlay — identical for equal content regardless of
 *  input ordering. */
export function overlaySignature(overlay) {
  const hexSig = overlay.path
    ? overlay.path.join('>')
    : Array.from(overlay.hexes).sort().join('|');
  return `${overlay.kind}${overlay.layer}${hexSig}${stableStringify(overlay.style ?? {})}${stableStringify(overlay.animation ?? null)}`;
}
