// Babylon MaterialPluginBase for the river water surface. Two problems it
// solves that a plain StandardMaterial bumpTexture can't:
//
//  1. SEAMS — a per-tile bump UV resets at every tile boundary, so the ripple
//     pattern visibly jumps. This samples the ripple normal from WORLD XZ, so
//     the ripple field is continuous across every tile (no seam).
//  2. VARIATION — it samples the SAME normal map TWICE at different world
//     scales and scrolls each at a different speed/phase, then blends them, so
//     the chop never reads as one repeating grating.
//
// The blended tangent-space normal is converted to world space (the surface is
// flat at the water Y, so tangent = +X, bitangent = +Z, up = +Y) and overrides
// `normalW` before the lights — the StandardMaterial's own specular/diffuse/
// fresnel then ripple. It also folds in the fog veil (per-vertex `aFog` ×
// `uFogDarken`) so the water dims with its banks WITHOUT per-tile material
// clones.
//
// `makeWaterRipplePlugin(BABYLON)` is a factory so the module imports cleanly in
// node tests (no global BABYLON).

export const WATER_RIPPLE_DEFAULTS = Object.freeze({
  uRippleScaleA: 2.5,   // channel-UV → ripple tiling (layer A)
  uRippleScaleB: 4.3,   // layer B — finer, scrolls at a different speed for variation
  uRippleStrength: 0.5, // how hard the ripples tilt the normal (glint amount)
});

export function makeWaterRipplePlugin(BABYLON) {
  if (!BABYLON || typeof BABYLON.MaterialPluginBase !== 'function') return null;

  class WaterRipplePlugin extends BABYLON.MaterialPluginBase {
    constructor(material) {
      super(material, 'WaterRipple', 220, { WATER_RIPPLE: false });
      this._enabled = false;
      this.rippleNrm = null;
      this.uRippleScaleA = WATER_RIPPLE_DEFAULTS.uRippleScaleA;
      this.uRippleScaleB = WATER_RIPPLE_DEFAULTS.uRippleScaleB;
      this.uRippleStrength = WATER_RIPPLE_DEFAULTS.uRippleStrength;
      this.uRippleOffA = [0, 0]; // scroll offsets (renderer advances per frame)
      this.uRippleOffB = [0, 0];
      this.uFogDarken = 1.0;     // 1 = clear; renderer lowers per phase
    }

    get isEnabled() { return this._enabled; }
    set isEnabled(v) {
      const b = !!v;
      if (b === this._enabled) return;
      this._enabled = b;
      this._enable(b);
      if (typeof this.markAllDefinesAsDirty === 'function') {
        this.markAllDefinesAsDirty();
      } else if (this._material && typeof this._material.markAsDirty === 'function' && BABYLON.Material) {
        this._material.markAsDirty(BABYLON.Material.AllDirtyFlag ?? 0x7fffffff);
      }
    }

    prepareDefines(defines) { defines.WATER_RIPPLE = this._enabled; }
    getClassName() { return 'WaterRipplePlugin'; }

    getAttributes(attributes) {
      if (!this._enabled) return;
      // Custom name (NOT 'uv') — the core StandardMaterial already declares `uv`
      // for the opacity texture, and redeclaring it breaks the shader.
      attributes.push('aRipUV');
      attributes.push('aFog');
      attributes.push('aEdgeAlpha');
    }

    getSamplers(samplers) {
      if (!this._enabled) return;
      samplers.push('rippleNrm');
    }

    getUniforms() {
      return {
        ubo: [
          { name: 'uRippleScaleA', size: 1, type: 'float' },
          { name: 'uRippleScaleB', size: 1, type: 'float' },
          { name: 'uRippleStrength', size: 1, type: 'float' },
          { name: 'uRippleOffA', size: 2, type: 'vec2' },
          { name: 'uRippleOffB', size: 2, type: 'vec2' },
          { name: 'uWaterFogDarken', size: 1, type: 'float' },
        ],
        fragment: `#ifdef WATER_RIPPLE
          uniform float uRippleScaleA;
          uniform float uRippleScaleB;
          uniform float uRippleStrength;
          uniform vec2 uRippleOffA;
          uniform vec2 uRippleOffB;
          uniform float uWaterFogDarken;
        #endif`,
      };
    }

    bindForSubMesh(uniformBuffer) {
      if (!this._enabled) return;
      uniformBuffer.updateFloat('uRippleScaleA', this.uRippleScaleA);
      uniformBuffer.updateFloat('uRippleScaleB', this.uRippleScaleB);
      uniformBuffer.updateFloat('uRippleStrength', this.uRippleStrength);
      uniformBuffer.updateFloat2('uRippleOffA', this.uRippleOffA[0], this.uRippleOffA[1]);
      uniformBuffer.updateFloat2('uRippleOffB', this.uRippleOffB[0], this.uRippleOffB[1]);
      uniformBuffer.updateFloat('uWaterFogDarken', this.uFogDarken);
      if (this.rippleNrm) uniformBuffer.setTexture('rippleNrm', this.rippleNrm);
    }

    getCustomCode(shaderType) {
      if (shaderType === 'vertex') {
        return {
          CUSTOM_VERTEX_DEFINITIONS: `#ifdef WATER_RIPPLE
            attribute vec2 aRipUV;
            attribute float aFog;
            attribute float aEdgeAlpha;
            varying vec2 vRipUV;
            varying float vRipFog;
            varying float vRipEdge;
          #endif`,
          CUSTOM_VERTEX_MAIN_END: `#ifdef WATER_RIPPLE
            vRipUV = aRipUV;
            vRipFog = aFog;
            vRipEdge = aEdgeAlpha;
          #endif`,
        };
      }
      if (shaderType === 'fragment') {
        return {
          CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef WATER_RIPPLE
            varying vec2 vRipUV;
            varying float vRipFog;
            varying float vRipEdge;
            uniform sampler2D rippleNrm;
          #endif`,
          // Override the shading normal from two ripple layers sampled on the
          // channel-aligned UV (U = arc DOWN the brook, made continuous across
          // tiles by the caller, so the chop flows along the current AND has no
          // seam). The two layers scroll at different speeds for variation.
          CUSTOM_FRAGMENT_BEFORE_LIGHTS: `#ifdef WATER_RIPPLE
            vec3 nA = texture2D(rippleNrm, vRipUV * uRippleScaleA + uRippleOffA).xyz * 2.0 - 1.0;
            vec3 nB = texture2D(rippleNrm, vRipUV * uRippleScaleB + uRippleOffB).xyz * 2.0 - 1.0;
            vec3 tn = nA + nB; // blend the two tangent-space ripple normals
            // Flat water surface: tangent=+X (U/down-stream), bitangent=+Z, up=+Y.
            normalW = normalize(vec3(tn.x * uRippleStrength, tn.z, tn.y * uRippleStrength));
          #endif`,
          // Fog veil — darken the final lit colour by the per-vertex fog weight
          // (keeps the surface translucent, just dark). Then fade the whole
          // surface out (alpha) by the per-vertex edge-alpha so the river
          // DISSOLVES into the border forest like the ground around it.
          CUSTOM_FRAGMENT_MAIN_END: `#ifdef WATER_RIPPLE
            gl_FragColor.rgb *= mix(1.0, uWaterFogDarken, vRipFog);
            gl_FragColor.a *= vRipEdge;
          #endif`,
        };
      }
      return null;
    }
  }

  return WaterRipplePlugin;
}
