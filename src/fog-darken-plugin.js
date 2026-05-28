// Tiny reusable Babylon MaterialPluginBase that multiplies the final fragment
// colour by a per-instance attribute (`fogDarken`, stride 1). Used by GLB
// building instances so each instance can dim independently — hardware
// instances share the template material, so we can't toggle the material's
// diffuse without dimming every building at once; instanced buffers are the
// per-instance escape hatch.
//
// Why CUSTOM_FRAGMENT_MAIN_END rather than CUSTOM_FRAGMENT_UPDATE_DIFFUSE:
// glTF-loaded materials are often PBRMaterial (not StandardMaterial), and the
// `baseColor`-mid-pipeline hook used by the terrain splat plugin is
// StandardMaterial-specific. CUSTOM_FRAGMENT_MAIN_END is the final hook
// injected after lighting on BOTH material families — multiplying gl_FragColor
// there is universal AND inherently outside the lighting clamp (the same
// property that makes the fog veil read at bright phases).

export function makeFogDarkenPlugin(BABYLON) {
  if (!BABYLON || typeof BABYLON.MaterialPluginBase !== 'function') return null;

  class FogDarkenPlugin extends BABYLON.MaterialPluginBase {
    constructor(material) {
      super(material, 'FogDarken', 250, { FOG_DARKEN: false });
      this._enabled = false;
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

    prepareDefines(defines) { defines.FOG_DARKEN = this._enabled; }
    getClassName() { return 'FogDarkenPlugin'; }

    getAttributes(attributes) {
      if (!this._enabled) return;
      attributes.push('fogDarken');
    }

    // No samplers; no uniforms (per-instance attribute carries the value).
    getUniforms() { return null; }

    getCustomCode(shaderType) {
      if (shaderType === 'vertex') {
        return {
          CUSTOM_VERTEX_DEFINITIONS: `#ifdef FOG_DARKEN
            attribute float fogDarken;
            varying float vFogDarken;
          #endif`,
          CUSTOM_VERTEX_MAIN_END: `#ifdef FOG_DARKEN
            vFogDarken = fogDarken;
          #endif`,
        };
      }
      if (shaderType === 'fragment') {
        return {
          CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef FOG_DARKEN
            varying float vFogDarken;
          #endif`,
          // Final-stage multiply: post-lighting, post-everything. Universal
          // across StandardMaterial / PBRMaterial — both end with
          // #include<customFragmentMainEnd>. Survives any lighting clamp by
          // construction (clamp already happened upstream).
          CUSTOM_FRAGMENT_MAIN_END: `#ifdef FOG_DARKEN
            gl_FragColor.rgb *= vFogDarken;
          #endif`,
        };
      }
      return null;
    }
  }
  return FogDarkenPlugin;
}

/** Attach the FogDarkenPlugin to one material in instance-attribute mode and
 *  return it (or null if Babylon's plugin base isn't available). Idempotent —
 *  re-attaching to a material that already carries the plugin is a no-op.
 *  Walks MultiMaterial.subMaterials so a glTF model with multiple submesh
 *  materials gets the plugin on each. */
export function attachFogDarkenToMaterial(BABYLON, material) {
  if (!material) return null;
  // MultiMaterial → recurse into subMaterials.
  if (Array.isArray(material.subMaterials)) {
    const attached = [];
    for (const sub of material.subMaterials) {
      const p = attachFogDarkenToMaterial(BABYLON, sub);
      if (p) attached.push(p);
    }
    return attached.length ? attached : null;
  }
  // Already attached?
  if (material.pluginManager?._plugins?.some?.((p) =>
    (p.name || p.getClassName?.())?.toLowerCase?.().includes('fogdarken'))) return null;
  const PluginClass = makeFogDarkenPlugin(BABYLON);
  if (!PluginClass) return null;
  const plugin = new PluginClass(material);
  plugin.isEnabled = true;
  return plugin;
}
