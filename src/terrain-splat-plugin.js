// Babylon MaterialPluginBase that turns a StandardMaterial into a terrain
// texture-splatting shader: per-fragment it blends three tiling greyscale
// DETAIL textures (grass/dirt/forest) by per-vertex weights (`aSplat`),
// multiplies by a procedural COLOR map (value noise × per-channel tint), and
// applies the fog veil on the TEXEL side so it survives the diffuse-lighting
// clamp.
//
// CRITICAL — fog & detail darkening live in CUSTOM_FRAGMENT_UPDATE_DIFFUSE,
// where the shader establishes `baseColor` (the diffuse texel). Overwriting
// `baseColor.rgb` there places the splat result OUTSIDE the lighting clamp
// (finalDiffuse = clamp(diffuseBase*diffuseColor + vAmbientColor, 0,1) *
// baseColor.rgb), so at bright phases (lightAccum saturates to 1.0) the fog
// dimming still reads — the same property the fog-texture-level fix relies on.
//
// The detail UV is derived in-shader from world XZ (no `uv` attribute needed),
// which dodges the `vDiffuseUV`-absent-without-diffuseTexture pitfall.
//
// `makeTerrainSplatPlugin(BABYLON)` is a factory so this module imports cleanly
// in node tests (no global BABYLON); the class is only constructed when a real
// Babylon namespace is handed in.

import { DEFAULT_TERRAIN_TINTS } from './terrain-splat.js';

// Default starting uniform values — tuned in stage D against the detail maps
// (greyscale means ~0.4, so detail strength/brightness keep the colour from
// being crushed). Exported so the renderer + admin lighting page share them.
export const SPLAT_UNIFORM_DEFAULTS = Object.freeze({
  // World-units → detail-texture UV. ~0.5 means a detail tile repeats every
  // ~2 world units (a hex radius is 1), so the grain reads at the default zoom.
  uDetailUvScale: 0.5,
  // Contrast on the (mean-centred) detail texel before it modulates colour.
  // Bumped from 1.35 → 2.0 so the photographic grain bites visibly.
  uDetailStrength: 2.0,
  // Floor brightness the darkest detail texel maps to. 0.35 lets detail darken
  // colour to ~35% (up from 0.62's near-mild 38% wash) — much more visible bite.
  uDetailBright: 0.35,
  // Splat weight sharpening: pow(w, k) then renormalize before the per-channel
  // blend. k=1 = pure interpolation (full-hex soft blend); k=3 keeps the rim
  // midpoint at [0.5,0.5] (edge-symmetric, no seams) but pushes most of the
  // transition close to the boundary so terrain edges read crisper.
  uSplatSharpness: 3.0,
  // Procedural-colour variation: ±40% lightness wobble, cells ~4 world-units
  // wide. Tuned to break up the "all-green grass" / "all-brown dirt" flatness.
  uColVarAmp: 0.40,
  uColVarFreq: 0.25,
});

// GLSL value-noise + procedural-colour helper, mirroring `valueNoise2D` /
// `proceduralTerrainColor` in terrain-splat.js (visually, not bit-for-bit —
// hardware sin precision differs). Injected into the fragment definitions.
const PROC_COLOR_GLSL = `
float ts_hash2(vec2 p){ return fract(sin(p.x*127.1 + p.y*311.7)*43758.5453); }
float ts_noise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  float a = ts_hash2(i);
  float b = ts_hash2(i + vec2(1.0, 0.0));
  float c = ts_hash2(i + vec2(0.0, 1.0));
  float d = ts_hash2(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// Variation multiplier — noise depends only on world XZ (not tint), so compute
// once per fragment instead of once per channel.
float ts_variation(vec2 xz){
  float n = ts_noise(xz * uColVarFreq);
  return 1.0 + (n - 0.5) * 2.0 * uColVarAmp;
}
`;

/** Build (and return) the TerrainSplatPlugin class bound to a Babylon
 *  namespace. Returns null when no usable MaterialPluginBase is present. */
export function makeTerrainSplatPlugin(BABYLON) {
  if (!BABYLON || typeof BABYLON.MaterialPluginBase !== 'function') return null;

  class TerrainSplatPlugin extends BABYLON.MaterialPluginBase {
    constructor(material) {
      // priority 200 (after core), define gate TERRAIN_SPLAT, add to plugin list.
      super(material, 'TerrainSplat', 200, { TERRAIN_SPLAT: false });
      this._enabled = false;

      // Detail textures + tints/uniforms — wired by the renderer after build.
      this.detailGrass = null;
      this.detailDirt = null;
      this.detailForest = null;
      this.tints = DEFAULT_TERRAIN_TINTS.map((t) => t.slice());
      this.uDetailUvScale = SPLAT_UNIFORM_DEFAULTS.uDetailUvScale;
      this.uDetailStrength = SPLAT_UNIFORM_DEFAULTS.uDetailStrength;
      this.uDetailBright = SPLAT_UNIFORM_DEFAULTS.uDetailBright;
      this.uSplatSharpness = SPLAT_UNIFORM_DEFAULTS.uSplatSharpness;
      this.uFogDarken = 1.0; // 1 = no fog dim; renderer lowers per phase
      this.uColVarAmp = SPLAT_UNIFORM_DEFAULTS.uColVarAmp;
      this.uColVarFreq = SPLAT_UNIFORM_DEFAULTS.uColVarFreq;
    }

    get isEnabled() { return this._enabled; }
    set isEnabled(v) {
      const b = !!v;
      if (b === this._enabled) return;
      this._enabled = b;
      // _enable registers/unregisters the plugin with the material's plugin
      // manager so getCustomCode/getUniforms/etc. are invoked on (re)compile.
      this._enable(b);
      // Force a define recompile when toggled after first compile. The method
      // name varies across Babylon builds (this vendored one lacks
      // `markAllDefinesAsDirty`), so probe both and fall back to the material's
      // dirty flag. Harmless at build time (first compile runs prepareDefines
      // anyway) — load-bearing only for a live toggle.
      if (typeof this.markAllDefinesAsDirty === 'function') {
        this.markAllDefinesAsDirty();
      } else if (this._material && typeof this._material.markAsDirty === 'function'
                 && BABYLON.Material) {
        this._material.markAsDirty(BABYLON.Material.AllDirtyFlag ?? 0x7fffffff);
      }
    }

    prepareDefines(defines /* , scene, mesh */) {
      defines.TERRAIN_SPLAT = this._enabled;
    }

    getClassName() { return 'TerrainSplatPlugin'; }

    getAttributes(attributes) {
      if (!this._enabled) return;
      attributes.push('aSplat');
      attributes.push('aFog');
      attributes.push('aEdgeAlpha');
    }

    getSamplers(samplers) {
      if (!this._enabled) return;
      samplers.push('detailGrass', 'detailDirt', 'detailForest');
    }

    getUniforms() {
      return {
        ubo: [
          { name: 'uDetailUvScale', size: 1, type: 'float' },
          { name: 'uDetailStrength', size: 1, type: 'float' },
          { name: 'uDetailBright', size: 1, type: 'float' },
          { name: 'uSplatSharpness', size: 1, type: 'float' },
          { name: 'uFogDarken', size: 1, type: 'float' },
          { name: 'uColVarAmp', size: 1, type: 'float' },
          { name: 'uColVarFreq', size: 1, type: 'float' },
          { name: 'uColTint0', size: 3, type: 'vec3' },
          { name: 'uColTint1', size: 3, type: 'vec3' },
          { name: 'uColTint2', size: 3, type: 'vec3' },
        ],
        fragment: `#ifdef TERRAIN_SPLAT
          uniform float uDetailUvScale;
          uniform float uDetailStrength;
          uniform float uDetailBright;
          uniform float uSplatSharpness;
          uniform float uFogDarken;
          uniform float uColVarAmp;
          uniform float uColVarFreq;
          uniform vec3 uColTint0;
          uniform vec3 uColTint1;
          uniform vec3 uColTint2;
        #endif`,
      };
    }

    bindForSubMesh(uniformBuffer /* , scene, engine, subMesh */) {
      if (!this._enabled) return;
      uniformBuffer.updateFloat('uDetailUvScale', this.uDetailUvScale);
      uniformBuffer.updateFloat('uDetailStrength', this.uDetailStrength);
      uniformBuffer.updateFloat('uDetailBright', this.uDetailBright);
      uniformBuffer.updateFloat('uSplatSharpness', this.uSplatSharpness);
      uniformBuffer.updateFloat('uFogDarken', this.uFogDarken);
      uniformBuffer.updateFloat('uColVarAmp', this.uColVarAmp);
      uniformBuffer.updateFloat('uColVarFreq', this.uColVarFreq);
      const t = this.tints;
      uniformBuffer.updateFloat3('uColTint0', t[0][0], t[0][1], t[0][2]);
      uniformBuffer.updateFloat3('uColTint1', t[1][0], t[1][1], t[1][2]);
      uniformBuffer.updateFloat3('uColTint2', t[2][0], t[2][1], t[2][2]);
      if (this.detailGrass) uniformBuffer.setTexture('detailGrass', this.detailGrass);
      if (this.detailDirt) uniformBuffer.setTexture('detailDirt', this.detailDirt);
      if (this.detailForest) uniformBuffer.setTexture('detailForest', this.detailForest);
    }

    getCustomCode(shaderType) {
      if (shaderType === 'vertex') {
        return {
          CUSTOM_VERTEX_DEFINITIONS: `#ifdef TERRAIN_SPLAT
            attribute vec3 aSplat;
            attribute float aFog;
            attribute float aEdgeAlpha;
            varying vec3 vSplat;
            varying float vFog;
            varying float vEdgeAlpha;
            varying vec3 vWorldXZ;
          #endif`,
          CUSTOM_VERTEX_MAIN_END: `#ifdef TERRAIN_SPLAT
            vSplat = aSplat;
            vFog = aFog;
            vEdgeAlpha = aEdgeAlpha;
            vWorldXZ = worldPos.xyz;
          #endif`,
        };
      }
      if (shaderType === 'fragment') {
        return {
          CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef TERRAIN_SPLAT
            varying vec3 vSplat;
            varying float vFog;
            varying float vEdgeAlpha;
            varying vec3 vWorldXZ;
            uniform sampler2D detailGrass;
            uniform sampler2D detailDirt;
            uniform sampler2D detailForest;
            ${PROC_COLOR_GLSL}
          #endif`,
          CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `#ifdef TERRAIN_SPLAT
            // Normalize the interpolated weights, then sharpen with pow(w, k)
            // so transitions stay edge-symmetric (rim midpoints unchanged) but
            // the dominant channel takes more of the hex interior — visibly
            // narrower bleed than pure linear interpolation.
            vec3 w = vSplat / max(dot(vSplat, vec3(1.0)), 1e-4);
            w = pow(max(w, vec3(0.0)), vec3(uSplatSharpness));
            w = w / max(dot(w, vec3(1.0)), 1e-4);
            vec2 duv = vWorldXZ.xz * uDetailUvScale;
            float detail = w.x * texture2D(detailGrass, duv).r
                         + w.y * texture2D(detailDirt, duv).r
                         + w.z * texture2D(detailForest, duv).r;
            detail = mix(uDetailBright, 1.0,
                         clamp((detail - 0.5) * uDetailStrength + 0.5, 0.0, 1.0));
            // Blend the three tints, then apply the single per-fragment
            // variation multiplier — collapses three value-noise calls into one
            // (4 vs 12 sin-based hashes per fragment). Saves serious GPU on the
            // ground mesh, which covers most of the screen.
            float varM = ts_variation(vWorldXZ.xz);
            vec3 tintBlend = w.x * uColTint0 + w.y * uColTint1 + w.z * uColTint2;
            vec3 col = clamp(tintBlend * varM, 0.0, 1.0);
            vec3 texel = col * detail;
            texel *= mix(1.0, uFogDarken, vFog);
            // Per-vertex edge alpha → DITHERED discard, so the border-forest
            // band fades smoothly at the outer rings instead of a binary
            // cutoff, while keeping the splat ground in the opaque pass (so
            // the road/river transparent ribbons keep their render order).
            // For each fragment, compare a world-XZ hash to the vertex alpha:
            // at vEdgeAlpha=0.2, ~80% of fragments discard; at 0.5, ~50%; at
            // 1.0, none. The eye averages the dither into a smooth dissolve
            // at viewing distance, and the wilderness cones on top mask most
            // of the noise pattern. Playable verts always carry alpha=1.0.
            if (vEdgeAlpha < 0.999) {
              float dither = ts_hash2(floor(vWorldXZ.xz * 24.0));
              if (dither > vEdgeAlpha) discard;
            }
            baseColor = vec4(texel, 1.0);
          #endif`,
        };
      }
      return null;
    }
  }

  return TerrainSplatPlugin;
}
