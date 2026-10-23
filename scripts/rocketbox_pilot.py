# Rocketbox avatar FBX -> first-person pilot body GLB (skinned, no clips).
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P scripts/rocketbox_pilot.py -- AVATAR_DIR OUT.glb
#
# Seen from inside its own head, a crowd avatar needs a few changes:
#   - the hands are cut off at the cuff (the game's rigged flight gloves sit there)
#   - the head becomes its own mesh ("pilot_head") so the game can keep it as a shadow caster only
#   - one Catmull-Clark level on the body, so forearms half a metre from the eye read round, not faceted
#     (vertex groups are interpolated by the modifier, applied ahead of the armature)
#   - textures stay at full 2048 px
import bpy, bmesh, sys, os, re

argv = sys.argv[sys.argv.index("--") + 1:]
avatar_dir, out_glb = argv[:2]
name = os.path.basename(avatar_dir.rstrip("/"))
tex_dir = os.path.join(avatar_dir, "Textures")
work = os.path.join(os.path.dirname(os.path.abspath(out_glb)), "_pilot_tex")
os.makedirs(work, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=os.path.join(avatar_dir, "Export", name + ".fbx"), use_anim=False)
arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
for o in list(bpy.data.objects):
    if o.type == "EMPTY":
        bpy.data.objects.remove(o, do_unlink=True)
for a in list(bpy.data.actions):
    bpy.data.actions.remove(a)
if arm.animation_data:
    arm.animation_data.action = None
body = next(o for o in bpy.data.objects if o.type == "MESH")

# --- materials: full-res textures, no specular maps, opaque
for m in bpy.data.materials:
    if not m.use_nodes:
        continue
    nt = m.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    for n in list(nt.nodes):
        if n.type != "TEX_IMAGE" or not n.image:
            continue
        base = os.path.basename(bpy.path.abspath(n.image.filepath))
        src = os.path.join(tex_dir, base)
        if not os.path.exists(src):
            print("DROP", m.name, base)
            nt.nodes.remove(n)
            continue
        img = bpy.data.images.load(src)
        img.colorspace_settings.name = "Non-Color" if "normal" in base.lower() else "sRGB"
        out = os.path.join(work, os.path.splitext(base)[0] + ".png")
        img.save(filepath=out)
        img.filepath = out
        img.file_format = "PNG"
        img.reload()
        img.alpha_mode = "NONE"
        n.image = img
        print("TEX", m.name, base, tuple(img.size))
    if bsdf:
        for l in list(nt.links):
            if l.to_node == bsdf and l.to_socket.name in ("Alpha", "Specular IOR Level", "Specular Tint", "Roughness", "Metallic"):
                nt.links.remove(l)
        bsdf.inputs["Alpha"].default_value = 1.0
        bsdf.inputs["Metallic"].default_value = 0.0
        bsdf.inputs["Roughness"].default_value = 0.58 if "head" in m.name.lower() else 0.84
        if "Specular IOR Level" in bsdf.inputs:
            bsdf.inputs["Specular IOR Level"].default_value = 0.3
    for n in list(nt.nodes):
        if n.type in ("NORMAL_MAP", "BUMP") and not n.inputs[-1].is_linked and not any(l.from_node == n for l in nt.links):
            nt.nodes.remove(n)

# --- cut the hands off: a clean plane across each forearm, CUT up from the wrist joint,
# so the sleeve ends in a straight ring the game's glove gauntlet can flare over
CUT = 0.03
bm = bmesh.new()
bm.from_mesh(body.data)
dl = bm.verts.layers.deform.active
inv = body.matrix_world.inverted()
cut_local = CUT / body.matrix_world.to_scale()[0]


def dominant(v):
    w = v[dl]
    return max(w.items(), key=lambda kv: kv[1])[0] if len(w) else -1


before = len(bm.faces)
for side in "LR":
    hand = arm.data.bones[f"Bip01 {side} Hand"]
    fore = arm.data.bones[f"Bip01 {side} Forearm"]
    wrist = inv @ (arm.matrix_world @ hand.head_local)
    elbow = inv @ (arm.matrix_world @ fore.head_local)
    d = (wrist - elbow).normalized()
    groups = {g.index for g in body.vertex_groups if re.search(rf"Bip01 {side} (Forearm|ForeTwist|Hand|Finger)", g.name)}
    faces = [f for f in bm.faces if all(dominant(v) in groups for v in f.verts)]
    edges = {e for f in faces for e in f.edges}
    verts = {v for f in faces for v in f.verts}
    bmesh.ops.bisect_plane(bm, geom=list(verts) + list(edges) + faces, plane_co=wrist - d * cut_local, plane_no=d, clear_outer=True)
loose = [v for v in bm.verts if not v.link_faces]
bmesh.ops.delete(bm, geom=loose, context="VERTS")
bm.to_mesh(body.data)
print("HANDS_CUT faces", before - len(bm.faces))
bm.free()

# --- head to its own object
bpy.context.view_layer.objects.active = body
for o in bpy.context.view_layer.objects:
    o.select_set(o == body)
head_idx = [i for i, m in enumerate(body.data.materials) if m and "head" in m.name.lower()]
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="DESELECT")
bpy.ops.object.mode_set(mode="OBJECT")
for p in body.data.polygons:
    p.select = p.material_index in head_idx
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.separate(type="SELECTED")
bpy.ops.object.mode_set(mode="OBJECT")
head = next(o for o in bpy.data.objects if o.type == "MESH" and o != body)
head.name = "pilot_head"
body.name = "pilot_body"
for o in (body, head):
    o.data.name = o.name
    # drop material slots the object no longer uses
    used = {p.material_index for p in o.data.polygons}
    for i in reversed(range(len(o.data.materials))):
        if i not in used:
            o.active_material_index = i
            bpy.context.view_layer.objects.active = o
            bpy.ops.object.material_slot_remove()

# --- one subdivision level on the body, ahead of the armature
bpy.context.view_layer.objects.active = body
sub = body.modifiers.new("subd", "SUBSURF")
sub.levels = 1
sub.render_levels = 1
sub.uv_smooth = "PRESERVE_BOUNDARIES"
while body.modifiers.find("subd") > 0:
    bpy.ops.object.modifier_move_up(modifier="subd")
bpy.ops.object.modifier_apply(modifier="subd")
bpy.ops.object.shade_smooth()
for o in (body, head):
    print("MESH", o.name, "verts", len(o.data.vertices), "faces", len(o.data.polygons))

props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
want = dict(
    filepath=out_glb,
    export_format="GLB",
    use_selection=False,
    export_yup=True,
    export_apply=False,
    export_animations=False,
    export_skins=True,
    export_morph=False,
    export_cameras=False,
    export_lights=False,
    export_draco_mesh_compression_enable=True,
    export_draco_mesh_compression_level=6,
    export_image_format="WEBP",
    export_image_quality=85,
    export_extras=False,
)
bpy.ops.export_scene.gltf(**{k: v for k, v in want.items() if k in props})
print("WROTE", out_glb, os.path.getsize(out_glb))
