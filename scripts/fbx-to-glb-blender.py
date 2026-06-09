# fbx-to-glb-blender.py — convert a rigged character FBX to glTF via Blender,
# baking all transforms so the result is clean metric Y-up (the convention the
# rig cascade + check-rig.js expect).
#
# WHY BLENDER INSTEAD OF FBX2glTF
# -------------------------------
# FBX is centimetres, glTF is metres. For a custom mesh that took a round trip
# (Scenario -> Blender -> Mixamo), the FBX carries a unit mismatch that FBX2glTF
# preserves as a x100 compensation node (FBX2glTF has no unit/scale flag). The
# convert-character-fbx.js / FBX2glTF path works for stock Mixamo characters but
# leaves that x100 on custom uploads. Blender absorbs the cm on import, and
# transform_apply BAKES scale + axis into the geometry + skin (it handles the
# skinned case correctly), so the glTF export comes out x1, feet-at-origin,
# Y-up -- no compensation node, no rotation-node Z-up.
#
# USAGE
#   /Applications/Blender.app/Contents/MacOS/Blender --background \
#       --python scripts/fbx-to-glb-blender.py -- <input.fbx> <output.glb> [--tris N]
#
# --tris N  optionally decimate the mesh down to ~N triangles. Use this when a
#   Scenario export comes in denser than the standee budget (the shipped rigs
#   sit around 20k tris). The look-preserving glTF simplifier (simplify-glb.js)
#   CAN'T touch these meshes — they carry split/faceted normals on every face,
#   so meshoptimizer sees all-seam topology and collapses nothing. Blender's
#   Decimate (Collapse) works on the raw geometry regardless, and preserves the
#   vertex-group weights so the skin survives.
#
# Then re-apply the skin if needed (Mixamo can drop textures on re-rig) and
# validate:
#   node scripts/check-rig.js <output.glb>

import bpy
import sys

argv = sys.argv[sys.argv.index("--") + 1:]
fbx_in, glb_out = argv[0], argv[1]
target_tris = None
if "--tris" in argv:
    target_tris = int(argv[argv.index("--tris") + 1])

# Empty scene, import the FBX (Blender absorbs the FBX cm units here).
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=fbx_in)

# Bake scale + axis into the mesh + armature data, not onto nodes. This is the
# step that drops the x100 and the rotation-node Z-up; Blender applies it
# correctly across the skin.
bpy.ops.object.select_all(action='SELECT')
try:
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
except Exception as e:  # log + continue; export is still useful
    print("transform_apply note:", e)

# Optional decimation to the standee budget. Collapse keeps deform weights, so
# the armature still drives the simplified mesh. Applied per-mesh, leaving the
# Armature modifier intact.
if target_tris:
    for obj in [o for o in bpy.context.scene.objects if o.type == 'MESH']:
        tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
        if tris <= target_tris:
            print("DECIMATE skip %s: %d <= %d" % (obj.name, tris, target_tris))
            continue
        ratio = target_tris / tris
        bpy.context.view_layer.objects.active = obj
        mod = obj.modifiers.new(name="Decimate", type='DECIMATE')
        mod.decimate_type = 'COLLAPSE'
        mod.ratio = ratio
        bpy.ops.object.modifier_apply(modifier=mod.name)
        after = sum(len(p.vertices) - 2 for p in obj.data.polygons)
        print("DECIMATE %s: %d -> %d tris (ratio %.3f)" % (obj.name, tris, after, ratio))

# Export metric Y-up glTF with the animation.
bpy.ops.export_scene.gltf(
    filepath=glb_out, export_format='GLB',
    export_yup=True, export_animations=True, use_selection=False,
)
print("EXPORTED", glb_out)
