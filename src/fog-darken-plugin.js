// Babylon MaterialPluginBase that darkens GLB building fragments that fall on a
// fogged hex — WITHOUT touching the per-instance data path that doomed the May
// attempt.
//
// ── Why this works where the old plugin didn't ───────────────────────────────
// The previous FogDarkenPlugin carried the dim factor in a *per-instance vertex
// attribute* (`registerInstancedBuffer` + `gl_FragColor.rgb *= vFogDarken`).
// Hardware instances of a glTF-imported (PBR, multi-submesh) mesh did not
// propagate that attribute reliably through Babylon's instancing pipeline, so
// every building rendered the uninitialised value → all-black.
//
// This rewrite removes attributes entirely. The fog state travels as a GLOBAL
// UNIFORM: a flat array of fogged-tile world XZ centres (`fogTiles`) plus a
// count. Every fragment compares its own world XZ (`vFogWorldXZ`, derived in the
// vertex shader from `worldPos`, which Babylon always computes in main) against
// the list and darkens when it lands inside a fogged tile's radius. Uniforms are
// shared by every instance of the template material, but the per-fragment world
// position is genuinely per-instance, so each building dims based on WHERE it
// stands — exactly the per-instance effect we wanted, via a data path
// instancing can't break.
//
// Injection point: CUSTOM_FRAGMENT_MAIN_END — the final post-lighting hook,
// present on BOTH StandardMaterial and PBRMaterial (both end with
// `#include<customFragmentMainEnd>`). Multiplying `gl_FragColor.rgb` there is
// inherently outside the lighting clamp (the same property the terrain fog veil
// relies on), so the dimming reads even at bright phases when lightAccum
// saturates to 1.0.
//
// `makeFogDarkenPlugin(BABYLON)` is a factory so this module imports cleanly in
// node tests (no global BABYLON); the class is only constructed when a real
// Babylon namespace is handed in.

// Hard cap on simultaneously-fogged building tiles tracked by the shader. The
// uniform array is sized to this; extra fogged buildings beyond the cap simply
// render un-dimmed (logged by the renderer). 32 comfortably covers every map
// size's building count on the fogged side.
export const MAX_FOG_TILES = 32;

// Default tuning — operator-dialable via the renderer (visual-iteration mode).
//   • amount: final-colour multiplier at a fully-fogged fragment. 0.40 matches
//     FOG_HIDDEN_DARKEN, the "occluded read" floor the terrain/road veil uses.
//   • radius: tolerance for matching an instance's own world translation to
//     a fogged-building entry. The values are emitted exactly equal from
//     `buildFoggedBuildingTileList`, so 0.5 is generous slack for float
//     precision while staying well under the ~1.5wu hex pitch (so a
//     neighbouring building's centre can never match).
export const FOG_BUILDING_DARKEN_DEFAULT = 0.40;
export const FOG_BUILDING_RADIUS_DEFAULT = 0.5;

/** Build (and return) the FogDarkenPlugin class bound to a Babylon namespace.
 *  Returns null when no usable MaterialPluginBase is present. */
export function makeFogDarkenPlugin(BABYLON) {
  if (!BABYLON || typeof BABYLON.MaterialPluginBase !== 'function') return null;

  class FogDarkenPlugin extends BABYLON.MaterialPluginBase {
    constructor(material) {
      // priority 250 (after core + splat), define gate FOG_DARKEN.
      super(material, 'FogDarken', 250, { FOG_DARKEN: false });
      this._enabled = false;

      // Flat XZ pairs (length 2*MAX_FOG_TILES). Unused slots park at a far
      // sentinel so even when `fogCount` over-reports they never match a
      // fragment. Babylon's updateUniformArray takes this tight layout and
      // applies the std140 vec2→vec4 padding internally.
      this.fogTiles = new Float32Array(MAX_FOG_TILES * 2).fill(1e8);
      this.fogCount = 0;
      this.fogDarkenAmount = FOG_BUILDING_DARKEN_DEFAULT;
      this.fogTileRadius = FOG_BUILDING_RADIUS_DEFAULT;
    }

    get isEnabled() { return this._enabled; }
    set isEnabled(v) {
      const b = !!v;
      if (b === this._enabled) return;
      this._enabled = b;
      // _enable registers/unregisters the plugin with the material's plugin
      // manager so getCustomCode/getUniforms/etc. fire on (re)compile.
      this._enable(b);
      // Force a define recompile when toggled after first compile. The method
      // name varies across Babylon builds (this vendored one lacks
      // `markAllDefinesAsDirty`), so probe both and fall back to the material's
      // dirty flag — mirrors the terrain splat plugin.
      if (typeof this.markAllDefinesAsDirty === 'function') {
        this.markAllDefinesAsDirty();
      } else if (this._material && typeof this._material.markAsDirty === 'function'
                 && BABYLON.Material) {
        this._material.markAsDirty(BABYLON.Material.AllDirtyFlag ?? 0x7fffffff);
      }
    }

    prepareDefines(defines /* , scene, mesh */) {
      defines.FOG_DARKEN = this._enabled;
    }

    getClassName() { return 'FogDarkenPlugin'; }

    getUniforms() {
      return {
        ubo: [
          // vec2[N] array: stride 2, arraySize MAX_FOG_TILES. Babylon lays it
          // out std140 (each element padded to a vec4) automatically.
          { name: 'fogTiles', size: 2, type: 'vec2', arraySize: MAX_FOG_TILES },
          { name: 'fogCount', size: 1, type: 'float' },
          { name: 'fogDarkenAmount', size: 1, type: 'float' },
          { name: 'fogTileRadius', size: 1, type: 'float' },
        ],
        // Inline uniform declarations live with the custom-code DEFINITIONS
        // blocks below (CUSTOM_VERTEX_DEFINITIONS / CUSTOM_FRAGMENT_DEFINITIONS)
        // rather than here — `getUniforms()`'s vertex/fragment strings get
        // injected AFTER the custom-code MAIN_END use sites on some browsers
        // (Safari WebKit notably, see comment further down). Keeping the
        // declarations at the top of each stage's shader source guarantees
        // declaration-before-use on every spec-conformant assembler.
      };
    }

    bindForSubMesh(uniformBuffer /* , scene, engine, subMesh */) {
      if (!this._enabled) return;
      uniformBuffer.updateArray('fogTiles', this.fogTiles);
      uniformBuffer.updateFloat('fogCount', this.fogCount);
      uniformBuffer.updateFloat('fogDarkenAmount', this.fogDarkenAmount);
      uniformBuffer.updateFloat('fogTileRadius', this.fogTileRadius);
    }

    getCustomCode(shaderType) {
      if (shaderType === 'vertex') {
        return {
          // `vFogDk` is the building-level fog verdict (0 or 1), computed once
          // per VERTEX from the instance's own world translation. Every vertex
          // of the same building gets the same value → the varying is uniform
          // across the building, producing a flat darken instead of a circular
          // spotlight at the building's centre.
          //
          // Uniforms are declared HERE (top of vertex shader) rather than in
          // getUniforms().vertex because that block injects AFTER the
          // CUSTOM_VERTEX_MAIN_END use site on Safari (and order isn't
          // guaranteed on other browsers either — Babylon's assembler doesn't
          // promise injection order across the two slots). The Standard +
          // PBR vertex shaders both emit CUSTOM_VERTEX_DEFINITIONS near the
          // top, well before main(), so the uniform handles resolve when the
          // loop in CUSTOM_VERTEX_MAIN_END references them.
          CUSTOM_VERTEX_DEFINITIONS: `#ifdef FOG_DARKEN
            #define MAX_FOG_TILES ${MAX_FOG_TILES}
            uniform vec2 fogTiles[MAX_FOG_TILES];
            uniform float fogCount;
            uniform float fogTileRadius;
            varying float vFogDk;
          #endif`,
          // `finalWorld` is declared unconditionally in Babylon's vertex main
          // (Standard + PBR; for hardware-instances it's the per-instance
          // matrix). Column 3's xz IS the building's world XZ translation —
          // the exact value `buildFoggedBuildingTileList` emits into the
          // uniform — so a hit is essentially an equality test, not a "is the
          // pixel near the building" smoothstep. Tight `fogTileRadius` (<<
          // hex pitch) avoids false positives on neighbours.
          CUSTOM_VERTEX_MAIN_END: `#ifdef FOG_DARKEN
            vec2 instCentre = vec2(finalWorld[3].x, finalWorld[3].z);
            float dk = 0.0;
            for (int i = 0; i < MAX_FOG_TILES; i++) {
              if (float(i) >= fogCount) break;
              if (distance(instCentre, fogTiles[i]) < fogTileRadius) { dk = 1.0; break; }
            }
            vFogDk = dk;
          #endif`,
        };
      }
      if (shaderType === 'fragment') {
        return {
          // Uniforms + #define live HERE (CUSTOM_FRAGMENT_DEFINITIONS,
          // top of fragment) rather than in getUniforms().fragment: Safari
          // WebKit's WebGL2 shader assembler injects getUniforms's fragment
          // block AFTER custom-code MAIN_END, so a use site in MAIN_END
          // would see `fogDarkenAmount` as undeclared on Safari. (Chrome
          // happens to interleave them in the right order — both are
          // spec-conformant.) `varying float vFogDk` declares the verdict
          // produced in the vertex stage.
          CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef FOG_DARKEN
            #define MAX_FOG_TILES ${MAX_FOG_TILES}
            uniform float fogDarkenAmount;
            varying float vFogDk;
          #endif`,
          // Final post-lighting multiply. `vFogDk` is constant per building
          // (vertex-shader verdict), so no spatial gradient — the whole
          // building darkens uniformly. `mix(1.0, fogDarkenAmount, dk)` =>
          // unfogged buildings are untouched (dk=0 → ×1.0).
          CUSTOM_FRAGMENT_MAIN_END: `#ifdef FOG_DARKEN
            gl_FragColor.rgb *= mix(1.0, fogDarkenAmount, vFogDk);
          #endif`,
        };
      }
      return null;
    }
  }

  return FogDarkenPlugin;
}

/** Attach the FogDarkenPlugin to a material (recursing into a MultiMaterial's
 *  subMaterials so a glTF model with per-submesh materials gets it on each).
 *  Returns a flat array of the attached plugin instances (empty if Babylon's
 *  plugin base is unavailable). Idempotent — a material that already carries the
 *  plugin returns its existing instance rather than double-attaching. */
export function attachFogDarkenToMaterial(BABYLON, material) {
  if (!material) return [];
  // MultiMaterial → recurse into subMaterials, flatten.
  if (Array.isArray(material.subMaterials)) {
    const out = [];
    for (const sub of material.subMaterials) out.push(...attachFogDarkenToMaterial(BABYLON, sub));
    return out;
  }
  // Already attached? Return the live instance so the renderer keeps tracking it.
  const existing = material.pluginManager?._plugins?.find?.((p) =>
    (p.name || p.getClassName?.())?.toLowerCase?.().includes('fogdarken'));
  if (existing) return [existing];
  const PluginClass = makeFogDarkenPlugin(BABYLON);
  if (!PluginClass) return [];
  const plugin = new PluginClass(material);
  plugin.isEnabled = true;
  return [plugin];
}
