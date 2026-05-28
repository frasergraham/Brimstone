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

import {
  DEFAULT_TERRAIN_TINTS,
  DEFAULT_COLOR_VARIATION,
} from './terrain-splat.js';

// Default starting uniform values — tuned in stage D against the detail maps
// (greyscale means ~0.4, so detail strength/brightness keep the colour from
// being crushed). Exported so the renderer + admin lighting page share them.
export const SPLAT_UNIFORM_DEFAULTS = Object.freeze({
  // World-units → detail-texture UV. ~0.5 means a detail tile repeats every
  // ~2 world units (a hex radius is 1), so the grain reads at the default zoom.
  uDetailUvScale: 0.5,
  // Contrast on the (mean-centred) detail texel before it modulates colour.
  uDetailStrength: 1.35,
  // Floor brightness the darkest detail texel maps to (so detail darkens but
  // never crushes the colour to black).
  uDetailBright: 0.62,
  uColVarAmp: DEFAULT_COLOR_VARIATION.amp,
  uColVarFreq: DEFAULT_COLOR_VARIATION.freq,
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
vec3 ts_procColor(vec3 tint, vec2 xz){
  float n = ts_noise(xz * uColVarFreq);
  float m = 1.0 + (n - 0.5) * 2.0 * uColVarAmp;
  return clamp(tint * m, 0.0, 1.0);
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
            varying vec3 vSplat;
            varying float vFog;
            varying vec3 vWorldXZ;
          #endif`,
          CUSTOM_VERTEX_MAIN_END: `#ifdef TERRAIN_SPLAT
            vSplat = aSplat;
            vFog = aFog;
            vWorldXZ = worldPos.xyz;
          #endif`,
        };
      }
      if (shaderType === 'fragment') {
        return {
          CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef TERRAIN_SPLAT
            varying vec3 vSplat;
            varying float vFog;
            varying vec3 vWorldXZ;
            uniform sampler2D detailGrass;
            uniform sampler2D detailDirt;
            uniform sampler2D detailForest;
            ${PROC_COLOR_GLSL}
          #endif`,
          CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `#ifdef TERRAIN_SPLAT
            vec3 w = vSplat / max(dot(vSplat, vec3(1.0)), 1e-4);
            vec2 duv = vWorldXZ.xz * uDetailUvScale;
            float detail = w.x * texture2D(detailGrass, duv).r
                         + w.y * texture2D(detailDirt, duv).r
                         + w.z * texture2D(detailForest, duv).r;
            detail = mix(uDetailBright, 1.0,
                         clamp((detail - 0.5) * uDetailStrength + 0.5, 0.0, 1.0));
            vec3 col = w.x * ts_procColor(uColTint0, vWorldXZ.xz)
                     + w.y * ts_procColor(uColTint1, vWorldXZ.xz)
                     + w.z * ts_procColor(uColTint2, vWorldXZ.xz);
            vec3 texel = col * detail;
            texel *= mix(1.0, uFogDarken, vFog);
            baseColor = vec4(texel, 1.0);
          #endif`,
        };
      }
      return null;
    }
  }

  return TerrainSplatPlugin;
}
