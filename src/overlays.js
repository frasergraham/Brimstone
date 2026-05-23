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
    if (!hex) { this._overlays.delete('selection'); return; }
    this.setOverlay('selection', makeOverlay({
      id: 'selection', kind: 'outline', layer: 'selection',
      hexes: [hex], style: { glow: true },
      meta: entityId != null ? { entityId } : undefined,
    }));
  },

  setHover(hex) {
    this._hover = hex ?? null;
    if (!hex) { this._overlays.delete('hover'); return; }
    this.setOverlay('hover', makeOverlay({
      id: 'hover', kind: 'outline', layer: 'selection',
      hexes: [hex], style: { glow: false },
    }));
  },
});

/**
 * Initialise the overlay state (`_overlays` / `_selection` / `_hover`), copy the
 * overlay methods onto plain test doubles (renderer instances already inherit
 * them from the prototype), and define the legacy `highlightHexes` /
 * `selectedHex` / `selectedEntityId` / `hoveredHex` compat accessors. Must run
 * before any `this.selectedHex = …` constructor assignment so those route
 * through the proxy. Idempotent — safe to call more than once per instance.
 */
export function installOverlayShims(target) {
  // Idempotent: a second call must not wipe an existing overlay map / selection.
  if (!target._overlays) target._overlays = new Map();
  if (!target._selection) target._selection = { entityId: null, hex: null };
  if (target._hover === undefined) target._hover = null;

  // Renderer instances already carry these on their prototype (assigned at
  // module load); only plain test doubles need them copied onto the object.
  if (typeof target.setOverlay !== 'function') Object.assign(target, OVERLAY_METHODS);

  // ── Legacy compat fields. `highlightHexes` is now READ-ONLY: ui.js writes
  // overlays directly via setOverlay() (PR 2). The setter is a deprecated
  // no-op that warns once if any straggler still assigns to it. selectedHex /
  // selectedEntityId / hoveredHex remain live proxies until PR 3. ──
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

  Object.defineProperty(target, 'selectedHex', {
    configurable: true,
    enumerable: true,
    get() { return this._selection?.hex ?? null; },
    set(value) { this.setSelection({ entityId: this._selection?.entityId ?? null, hex: value }); },
  });

  Object.defineProperty(target, 'selectedEntityId', {
    configurable: true,
    enumerable: true,
    get() { return this._selection?.entityId ?? null; },
    set(value) { this.setSelection({ entityId: value, hex: this._selection?.hex ?? null }); },
  });

  Object.defineProperty(target, 'hoveredHex', {
    configurable: true,
    enumerable: true,
    get() { return this._hover ?? null; },
    set(value) { this.setHover(value); },
  });
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
