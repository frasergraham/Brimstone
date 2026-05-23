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

/** Colour-prefix → overlay id/style buckets for the legacy `highlightHexes`
 *  setter. The 2D/3D draw code historically distinguished move/battle/etc.
 *  hexes purely by the rgba string ui.js wrote; this preserves that mapping. */
const HIGHLIGHT_BUCKETS = [
  { id: 'move-targets',       prefix: 'rgba(60,220,80',  color: 'rgba(60,220,80,0.22)',  alpha: 0.22 },
  { id: 'battle-targets',     prefix: 'rgba(220,60,60',  color: 'rgba(220,60,60,0.55)',  alpha: 0.55 },
  { id: 'battle-hex-targets', prefix: 'rgba(220,120,40', color: 'rgba(220,120,40,0.50)', alpha: 0.50 },
  { id: 'guard-zone',         prefix: 'rgba(230,160,60', color: 'rgba(230,160,60,0.18)', alpha: 0.18 },
];
const MISC_HIGHLIGHT_ID = 'misc-highlights';
/** Stable id order for reconstituting the flat `highlightHexes` array. */
const HIGHLIGHT_IDS = Object.freeze([...HIGHLIGHT_BUCKETS.map(b => b.id), MISC_HIGHLIGHT_ID]);

/** Parse a "col,row" hex key back to numeric coords. */
function parseHexKey(key) {
  const [col, row] = key.split(',').map(Number);
  return { col, row };
}

/**
 * Install the unified overlay API + legacy compat accessors onto a renderer
 * (or a test double). Must run before any `this.highlightHexes = …` /
 * `this.selectedHex = …` constructor assignments so they route through the
 * proxy setters. Idempotent enough for one call per instance.
 */
export function installOverlayShims(target) {
  target._overlays = new Map();
  target._selection = { entityId: null, hex: null };
  target._hover = null;
  target._highlightHexes = [];

  target.setOverlay = function (id, overlay) {
    if (overlay == null) { this._overlays.delete(id); return; }
    if (!Object.isFrozen(overlay) || typeof overlay.kind !== 'string') {
      throw new Error('setOverlay: overlay must be produced by makeOverlay()');
    }
    this._overlays.set(id, overlay);
  };

  target.removeOverlay = function (id) {
    this._overlays.delete(id);
  };

  target.clearOverlaysByLayer = function (layer) {
    for (const [id, ov] of this._overlays) {
      if (ov.layer === layer) this._overlays.delete(id);
    }
  };

  target.setSelection = function ({ entityId = null, hex = null } = {}) {
    this._selection = { entityId, hex };
    if (!hex) { this._overlays.delete('selection'); return; }
    this.setOverlay('selection', makeOverlay({
      id: 'selection', kind: 'outline', layer: 'selection',
      hexes: [hex], style: { glow: true },
      meta: entityId != null ? { entityId } : undefined,
    }));
  };

  target.setHover = function (hex) {
    this._hover = hex ?? null;
    if (!hex) { this._overlays.delete('hover'); return; }
    this.setOverlay('hover', makeOverlay({
      id: 'hover', kind: 'outline', layer: 'selection',
      hexes: [hex], style: { glow: false },
    }));
  };

  // ── Legacy compat: four fields that existing draw code reads/writes. ──
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
    set(list) {
      for (const id of HIGHLIGHT_IDS) this._overlays.delete(id);
      this._highlightHexes = Array.isArray(list) ? list : [];
      const buckets = new Map();
      for (const h of this._highlightHexes) {
        if (typeof h?.col !== 'number' || typeof h?.row !== 'number') continue;
        const color = h.color ?? '';
        const def = HIGHLIGHT_BUCKETS.find(b => color.startsWith(b.prefix));
        const id = def ? def.id : MISC_HIGHLIGHT_ID;
        if (!buckets.has(id)) buckets.set(id, { hexes: [], color: def ? def.color : color, alpha: def?.alpha });
        buckets.get(id).hexes.push({ col: h.col, row: h.row });
      }
      for (const [id, b] of buckets) {
        const style = b.alpha != null ? { color: b.color, alpha: b.alpha } : { color: b.color };
        this.setOverlay(id, makeOverlay({ id, kind: 'fill', layer: 'highlight-disc', hexes: b.hexes, style }));
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
