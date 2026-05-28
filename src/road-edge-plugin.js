// Tiny Babylon MaterialPluginBase that breaks up the road ribbon's lateral
// alpha edge with world-space value noise — so the road dissolves into the
// terrain along a wavy, organic boundary instead of two clean parallel lines.
//
// Reads the road's `vDiffuseUV.y` (0..1 across the ribbon width; 0.5 = centre,
// 0/1 = outer rim) and the fragment's world XZ. Computes a lateral fade from
// centre to rim, then jitters the fade thresholds with a noise sample so the
// boundary undulates along the road's length. Multiplies into gl_FragColor.a
// at CUSTOM_FRAGMENT_MAIN_END (post-lighting, post-everything — works
// regardless of whether the road material is StandardMaterial or PBR).
//
// Tunables (uniforms): uNoiseFreq (noise cell size in world units),
// uEdgeJitter (±ratio added to the fade thresholds), uFadeStart / uFadeEnd
// (the lateral fade band; 0 = centre, 1 = rim).

export function makeRoadEdgePlugin(BABYLON) {
  if (!BABYLON || typeof BABYLON.MaterialPluginBase !== 'function') return null;

  class RoadEdgePlugin extends BABYLON.MaterialPluginBase {
    constructor(material) {
      super(material, 'RoadEdge', 260, { ROAD_EDGE: false });
      this._enabled = false;
      this.uNoiseFreq  = 0.6;  // ≈ one noise cell per ~1.7 world units (hex pitch)
      this.uEdgeJitter = 0.22; // ±22% of the fade band wiggle
      this.uFadeStart  = 0.55; // lateral position where alpha starts dropping
      this.uFadeEnd    = 0.95; // lateral position where alpha hits zero
      // Slow colour variation along the road — lighter/darker patches like
      // real dirt path, breaks up the uniform tinted ribbon.
      this.uColorFreq  = 0.18; // ≈ one cell per ~5-6 world units
      this.uColorAmp   = 0.20; // ±20% brightness modulation
    }

    get isEnabled() { return this._enabled; }
    set isEnabled(v) {
      const b = !!v;
      if (b === this._enabled) return;
      this._enabled = b;
      this._enable(b);
      if (typeof this.markAllDefinesAsDirty === 'function') {
        this.markAllDefinesAsDirty();
      } else if (this._material && typeof this._material.markAsDirty === 'function'
                 && BABYLON.Material) {
        this._material.markAsDirty(BABYLON.Material.AllDirtyFlag ?? 0x7fffffff);
      }
    }

    prepareDefines(defines) { defines.ROAD_EDGE = this._enabled; }
    getClassName() { return 'RoadEdgePlugin'; }

    getUniforms() {
      return {
        ubo: [
          { name: 'uNoiseFreq',  size: 1, type: 'float' },
          { name: 'uEdgeJitter', size: 1, type: 'float' },
          { name: 'uFadeStart',  size: 1, type: 'float' },
          { name: 'uFadeEnd',    size: 1, type: 'float' },
          { name: 'uColorFreq',  size: 1, type: 'float' },
          { name: 'uColorAmp',   size: 1, type: 'float' },
        ],
        fragment: `#ifdef ROAD_EDGE
          uniform float uNoiseFreq;
          uniform float uEdgeJitter;
          uniform float uFadeStart;
          uniform float uFadeEnd;
          uniform float uColorFreq;
          uniform float uColorAmp;
        #endif`,
      };
    }

    bindForSubMesh(uniformBuffer) {
      if (!this._enabled) return;
      uniformBuffer.updateFloat('uNoiseFreq',  this.uNoiseFreq);
      uniformBuffer.updateFloat('uEdgeJitter', this.uEdgeJitter);
      uniformBuffer.updateFloat('uFadeStart',  this.uFadeStart);
      uniformBuffer.updateFloat('uFadeEnd',    this.uFadeEnd);
      uniformBuffer.updateFloat('uColorFreq',  this.uColorFreq);
      uniformBuffer.updateFloat('uColorAmp',   this.uColorAmp);
    }

    getCustomCode(shaderType) {
      if (shaderType === 'vertex') {
        // Carry our OWN uv varying (`vRoadUv`) rather than relying on
        // Babylon's `vDiffuseUV` — that's only declared when the standard
        // material's `MATERIAL_DIFFUSE_TEXTURE` define is on, which races
        // async texture loads. The `uv` attribute is declared file-scope by
        // Babylon whenever a UV vertex buffer is bound (road ribbons always
        // set one), so reading it in MAIN_END is safe.
        return {
          CUSTOM_VERTEX_DEFINITIONS: `#ifdef ROAD_EDGE
            varying vec3 vRoadWorldXZ;
            varying vec2 vRoadUv;
          #endif`,
          CUSTOM_VERTEX_MAIN_END: `#ifdef ROAD_EDGE
            vRoadWorldXZ = worldPos.xyz;
            vRoadUv = uv;
          #endif`,
        };
      }
      if (shaderType === 'fragment') {
        return {
          CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef ROAD_EDGE
            varying vec3 vRoadWorldXZ;
            varying vec2 vRoadUv;
            float re_hash2(vec2 p){ return fract(sin(p.x*127.1 + p.y*311.7) * 43758.5453); }
            float re_noise(vec2 p){
              vec2 i = floor(p); vec2 f = fract(p);
              vec2 u = f * f * (3.0 - 2.0 * f);
              float a = re_hash2(i);
              float b = re_hash2(i + vec2(1.0, 0.0));
              float c = re_hash2(i + vec2(0.0, 1.0));
              float d = re_hash2(i + vec2(1.0, 1.0));
              return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
            }
          #endif`,
          // vRoadUv.y is the ribbon's lateral coordinate (0/1 = outer rim,
          // 0.5 = centre). |y-0.5|*2 = "distance from centre line", 0..1.
          // World-XZ noise jitters the fade thresholds along the road's length
          // so the boundary wavers instead of running clean and parallel.
          CUSTOM_FRAGMENT_MAIN_END: `#ifdef ROAD_EDGE
            float lateral = abs(vRoadUv.y - 0.5) * 2.0;
            float n = re_noise(vRoadWorldXZ.xz * uNoiseFreq);
            float jitter = (n - 0.5) * uEdgeJitter;
            float fade = 1.0 - smoothstep(uFadeStart + jitter,
                                          uFadeEnd   + jitter, lateral);
            gl_FragColor.a *= fade;
            // Slow lighter/darker patches along the road's length — gives the
            // ribbon a worn-dirt feel instead of a uniform tint.
            float cN = re_noise(vRoadWorldXZ.xz * uColorFreq);
            float cMod = 1.0 + (cN - 0.5) * 2.0 * uColorAmp;
            gl_FragColor.rgb *= cMod;
          #endif`,
        };
      }
      return null;
    }
  }
  return RoadEdgePlugin;
}

/** Attach the RoadEdgePlugin to one material in-place. Idempotent — silently
 *  skips if the plugin is already attached or if Babylon's plugin base is
 *  absent (test stubs). Returns the plugin (or null). */
export function attachRoadEdgeToMaterial(BABYLON, material) {
  if (!material) return null;
  if (material.pluginManager?._plugins?.some?.((p) =>
    (p.name || p.getClassName?.())?.toLowerCase?.().includes('roadedge'))) return null;
  const PluginClass = makeRoadEdgePlugin(BABYLON);
  if (!PluginClass) return null;
  const plugin = new PluginClass(material);
  plugin.isEnabled = true;
  return plugin;
}
