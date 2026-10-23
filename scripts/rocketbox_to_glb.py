# Rocketbox avatar FBX + Rocketbox clip FBXs -> one skinned GLB (Draco + WebP), for the hangar crew.
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P scripts/rocketbox_to_glb.py -- \
#       AVATAR_DIR OUT.glb PREVIEW_DIR idle=m_idle_neutral_01.max.fbx walk=m_walk_neutral_01.max.fbx ...
#
# AVATAR_DIR is a Microsoft-Rocketbox avatar folder (Export/<name>.fbx + Textures/*.tga), clips come from
# Assets/Animations/... in https://github.com/microsoft/Microsoft-Rocketbox (MIT). The clip rigs' rest pose
# is not the avatar's bind pose, so motion is retargeted (armature-space rotations + root transform, baked),
# root motion is flattened (the game moves people), textures go to 1024 px, specular maps are dropped.
# PREVIEW_DIR gets a few workbench frames per clip to eyeball the result.
import bpy, sys, os, math
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
avatar_dir, out_glb, preview_dir, *clip_args = argv
clips = [a.split("=", 1) for a in clip_args]
name = os.path.basename(avatar_dir.rstrip("/"))
tex_dir = os.path.join(avatar_dir, "Textures")
work = os.path.join(preview_dir, name + "_tex")
os.makedirs(work, exist_ok=True)
os.makedirs(preview_dir, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 30
bpy.ops.import_scene.fbx(filepath=os.path.join(avatar_dir, "Export", name + ".fbx"), use_anim=False)
arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
mesh_objs = [o for o in bpy.data.objects if o.type == "MESH"]
for o in list(bpy.data.objects):
    if o.type == "EMPTY":
        bpy.data.objects.remove(o, do_unlink=True)
for a in list(bpy.data.actions):
    bpy.data.actions.remove(a)
if arm.animation_data:
    arm.animation_data.action = None
rest = {b.name: b.matrix_local.copy() for b in arm.data.bones}

# --- materials: relink the textures that shipped, drop the rest, 1024 px, opaque
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
        is_normal = "normal" in base.lower()
        img.colorspace_settings.name = "Non-Color" if is_normal else "sRGB"
        if max(img.size) > 1024:
            img.scale(1024, 1024)
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
        head = "head" in m.name.lower()
        bsdf.inputs["Roughness"].default_value = 0.58 if head else 0.82
        if "Specular IOR Level" in bsdf.inputs:
            bsdf.inputs["Specular IOR Level"].default_value = 0.35
    # drop orphan nodes left by the specular map
    for n in list(nt.nodes):
        if n.type in ("NORMAL_MAP", "BUMP") and not n.inputs[-1].is_linked and not any(l.from_node == n for l in nt.links):
            nt.nodes.remove(n)
    try:
        m.surface_render_method = "DITHERED"
    except Exception:
        m.blend_method = "OPAQUE"

# --- clips
def fcurves_of(act):
    out = []
    for L in act.layers:
        for st in L.strips:
            for cb in st.channelbags:
                out += list(cb.fcurves)
    return out

ad = arm.animation_data or arm.animation_data_create()
made = []

def retarget(src, f0, f1, clip):
    """Bake src's motion onto the avatar: armature-space bone rotations + the root transform.
    The clip rigs' rest pose differs from the avatar's bind pose, so curves can't be copied as-is."""
    oc = arm.constraints.new("COPY_TRANSFORMS")
    oc.target = src
    for pb in arm.pose.bones:
        if pb.name in src.pose.bones:
            c = pb.constraints.new("COPY_ROTATION")
            c.target = src
            c.subtarget = pb.name
            c.target_space = "POSE"
            c.owner_space = "POSE"
    bpy.context.view_layer.objects.active = arm
    for o in bpy.context.view_layer.objects:
        o.select_set(o == arm)
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.select_all(action="SELECT")
    bpy.ops.nla.bake(frame_start=f0, frame_end=f1, step=1, only_selected=False, visual_keying=True,
                     clear_constraints=True, clear_parents=False, use_current_action=False, bake_types={"POSE", "OBJECT"})
    bpy.ops.object.mode_set(mode="OBJECT")
    for pb in arm.pose.bones:
        for c in list(pb.constraints):
            pb.constraints.remove(c)
    for c in list(arm.constraints):
        arm.constraints.remove(c)
    act = arm.animation_data.action
    arm.animation_data.action = None
    act.name = clip
    act.use_fake_user = True
    return act

for clip, path in clips:
    objs0 = set(bpy.data.objects)
    acts0 = set(bpy.data.actions)
    bpy.ops.import_scene.fbx(filepath=path, use_anim=True)
    new = set(bpy.data.objects) - objs0
    src = next(o for o in new if o.type == "ARMATURE")
    sact = src.animation_data.action
    # ground speed of the root (m/s) before it is flattened, so the game can match feet to motion
    ends = {}
    for fc in fcurves_of(sact):
        if fc.data_path == "location" and fc.array_index in (0, 1) and len(fc.keyframe_points) > 1:
            k0, k1 = fc.keyframe_points[0].co, fc.keyframe_points[-1].co
            ends[fc.array_index] = (k1[1] - k0[1], k1[0] - k0[0])
    if ends:
        frames = max(df for _, df in ends.values()) or 1
        dist = math.hypot(*(dv for dv, _ in ends.values()))
        print("ROOTSPEED", clip, "%.3f m over %d frames = %.3f m/s" % (dist, frames, dist / frames * scene.render.fps))
    # in place: no horizontal root motion (the game moves the people)
    for fc in fcurves_of(sact):
        if fc.data_path == "location" and fc.array_index in (0, 1):
            for k in fc.keyframe_points:
                k.co[1] = 0.0
                k.handle_left[1] = 0.0
                k.handle_right[1] = 0.0
            fc.update()
    f0, f1 = int(sact.frame_range[0]), int(sact.frame_range[1])
    act = retarget(src, f0, f1, clip)
    for o in new:
        bpy.data.objects.remove(o, do_unlink=True)
    for a in set(bpy.data.actions) - acts0:
        if a != act:
            bpy.data.actions.remove(a)
    made.append(act)
    print("CLIP", clip, tuple(act.frame_range), "fcurves", len(fcurves_of(act)))

# --- previews: a few frames of each clip, workbench with textures
cam_data = bpy.data.cameras.new("cam")
cam = bpy.data.objects.new("cam", cam_data)
scene.collection.objects.link(cam)
cam.location = Vector((2.6, -3.6, 1.25))
cam.rotation_euler = (math.radians(86), 0, math.radians(35))
cam_data.lens = 40
scene.camera = cam
scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.color_type = "TEXTURE"
scene.display.shading.light = "STUDIO"
scene.render.resolution_x = 360
scene.render.resolution_y = 480
scene.render.image_settings.file_format = "PNG"
for act in made:
    ad.action = act
    if hasattr(ad, "action_slot") and act.slots:
        ad.action_slot = act.slots[0]
    f0, f1 = int(act.frame_range[0]), int(act.frame_range[1])
    for i, f in enumerate([f0, f0 + (f1 - f0) // 3, f0 + (2 * (f1 - f0)) // 3]):
        scene.frame_set(f)
        scene.render.filepath = os.path.join(preview_dir, "%s_%s_%d.png" % (name, act.name, i))
        bpy.ops.render.render(write_still=True)
ad.action = None
scene.collection.objects.unlink(cam)

# --- NLA tracks = glTF animations
for act in made:
    tr = ad.nla_tracks.new()
    tr.name = act.name
    st = tr.strips.new(act.name, int(act.frame_range[0]), act)
    if hasattr(st, "action_slot") and act.slots:
        st.action_slot = act.slots[0]
    tr.mute = False

h = max((o.dimensions.z for o in mesh_objs), default=0)
print("HEIGHT", round(h, 3))

props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
want = dict(
    filepath=out_glb,
    export_format="GLB",
    use_selection=False,
    export_yup=True,
    export_apply=False,
    export_animations=True,
    export_animation_mode="NLA_TRACKS",
    export_force_sampling=True,
    export_optimize_animation_size=True,
    export_frame_step=1,
    export_skins=True,
    export_morph=False,
    export_cameras=False,
    export_lights=False,
    export_draco_mesh_compression_enable=True,
    export_draco_mesh_compression_level=6,
    export_image_format="WEBP",
    export_image_quality=82,
    export_extras=False,
)
skipped = [k for k in want if k not in props]
print("SKIPPED_OPTS", skipped)
bpy.ops.export_scene.gltf(**{k: v for k, v in want.items() if k in props})
print("WROTE", out_glb, os.path.getsize(out_glb))
