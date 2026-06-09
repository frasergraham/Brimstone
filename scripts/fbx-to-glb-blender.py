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
#       --python scripts/fbx-to-glb-blender.py -- <input.fbx> <output.glb> \
#       [--tris N] [--weld TOL] [--no-weld] [--flat]
#
# WELD + SMOOTH (default on)
# --------------------------
# The Scenario -> Blender -> Mixamo round-trip exports the mesh as a TRIANGLE
# SOUP: every face carries its own 3 verts with custom split normals (exactly
# 3 verts/tri — e.g. 40k tris = 120k verts). That single fact causes three
# problems: (1) faceted shading, (2) a bloated glTF (the exporter can't share
# verts), and (3) Decimate Collapse tears HOLES because there's no shared
# topology to collapse across.
#
# The fix, applied before any decimation:
#   1. merge-by-distance weld (TOL, metric metres) — stitches the soup back
#      into a manifold so verts are shared and the collapse decimates cleanly;
#   2. clear the custom split normals + shade smooth — gives BLENDED vertex
#      normals (smooth shading) and lets the exporter share verts (small file).
# Vertex groups / deform weights are preserved throughout, so the skin survives.
#
# Defaults ON with TOL=1e-4. Override the tolerance with --weld TOL, disable the
# weld with --no-weld, or keep the original faceted split normals with --flat
# (weld only, no smoothing).
#
# --tris N  optionally decimate the (welded) mesh down to ~N triangles — use it
#   when a Scenario export comes in denser than the standee budget (~20k tris).
#   Collapse keeps the deform weights so the armature still drives the result.
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

# Weld (merge-by-distance) tolerance applied BEFORE decimation. Defaults on so
# the soup is stitched into a manifold; --weld overrides the tolerance,
# --no-weld disables it. --flat keeps the original faceted split normals
# (weld only); by default we clear them and shade smooth for blended normals.
weld_tol = 1e-4
if "--weld" in argv:
    weld_tol = float(argv[argv.index("--weld") + 1])
elif "--no-weld" in argv:
    weld_tol = None
flat_shade = "--flat" in argv

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

# Weld the triangle soup into a manifold, then blend the normals. Without this
# the mesh is split on every face: faceted shading, a bloated glTF (no shared
# verts), and Decimate Collapse tears holes (no shared topology to collapse
# across). Merge-by-distance stitches the coincident verts; clearing the custom
# split normals + shade smooth gives blended vertex normals and lets the
# exporter share verts. Vertex groups / deform weights are preserved.
if weld_tol:
    for obj in [o for o in bpy.context.scene.objects if o.type == 'MESH']:
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        before = len(obj.data.vertices)
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        try:
            bpy.ops.mesh.remove_doubles(threshold=weld_tol)
        except Exception as e:  # operator missing/renamed → bmesh fallback
            print("remove_doubles op note:", e)
            import bmesh
            bm = bmesh.from_edit_mesh(obj.data)
            bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=weld_tol)
            bmesh.update_edit_mesh(obj.data)
        bpy.ops.mesh.normals_make_consistent(inside=False)  # recalc outside
        bpy.ops.object.mode_set(mode='OBJECT')
        after = len(obj.data.vertices)
        if not flat_shade:
            # Drop the faceted custom split normals → blended vertex normals.
            try:
                bpy.ops.mesh.customdata_custom_splitnormals_clear()
            except Exception as e:
                print("clear split normals note:", e)
            # Blender < 4.1 gated smooth shading behind auto_smooth; turning it
            # off (when the attr exists) lets shade_smooth blend across faces.
            if hasattr(obj.data, "use_auto_smooth"):
                obj.data.use_auto_smooth = False
            bpy.ops.object.shade_smooth()
        print("WELD %s: %d -> %d verts (tol %g)%s" % (
            obj.name, before, after, weld_tol,
            "" if flat_shade else " + blended normals"))

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
