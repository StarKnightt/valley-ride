"""
horse_anim.py - keys the gallop on "horse_rig" from the designed stride (gallop.design.json, keys) and exports the GLB.

The action "gallop" runs frames 0..N at N frames per second, so one second of the clip is one stride and the clip's
time is the stride phase; frame N repeats frame 0, so it loops. N = 240 keys per stride: the test samples a stride
240 times, and with a key per sample the linear interpolation between keys adds no acceleration of its own.
The tail and ears, which the plate does not show, get a small motion of their own on the same period.

Then horse_correct.py measures the hindquarters' corrective shape keys on the keyed gallop (exported as morph targets,
weighted at runtime from the stride phase: correctives.json).

Export: build/blender/horse/horse.raw.glb (mesh, skin, shape keys, textures, the gallop clip). tools/build-horse.ts turns it
into public/assets/horse/horse.glb (meshopt, KTX2).
"""
import bpy, math, sys, os
from mathutils import Matrix

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else 'F:/valley-ride/tools/blender/horse')
import importlib, hlib
importlib.reload(hlib)
from hlib import log, design, activate, pose_matrices, key_rot, WORK

D = design()
KEYS = D['keys']
N = KEYS['n']


def key_gallop():
    arm = bpy.data.objects['horse_rig']
    scene = bpy.context.scene
    old = bpy.data.actions.get('gallop')
    if old:
        bpy.data.actions.remove(old)
    act = bpy.data.actions.new('gallop')
    arm.animation_data_create()
    arm.animation_data.action = act
    # the channels, through whichever action API this Blender has
    if hasattr(act, 'slots'):
        slot = act.slots.new(id_type='OBJECT', name='horse_rig')
        layer = act.layers.new('gallop')
        strip = layer.strips.new(type='KEYFRAME')
        bag = strip.channelbag(slot, ensure=True)
        arm.animation_data.action_slot = slot
        new_fc = lambda path, idx, grp: bag.fcurves.new(path, index=idx, group_name=grp)
    else:
        new_fc = lambda path, idx, grp: act.fcurves.new(path, index=idx, action_group=grp)
    bones = [b.name for b in arm.data.bones]
    quat = {b: [] for b in bones}
    loc = []
    for k in range(N + 1):
        kk = k % N
        rot = key_rot(D, kk)
        M = pose_matrices(arm, rot, KEYS['chest'][kk])
        for b in bones:
            q = M[b][1].to_quaternion()
            if quat[b] and quat[b][-1].dot(q) < 0:
                q.negate()
            quat[b].append(q)
        loc.append(M['chest'][1].translation.copy())
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    def write(path, idx, grp, vals):
        fc = new_fc(path, idx, grp)
        fc.keyframe_points.add(N + 1)
        co = [0.0] * (2 * (N + 1))
        co[0::2] = [float(k) for k in range(N + 1)]
        co[1::2] = vals
        fc.keyframe_points.foreach_set('co', co)
        fc.keyframe_points.foreach_set('interpolation', [1] * (N + 1))  # LINEAR
        fc.update()
    for b in bones:
        for i in range(4):
            write(f'pose.bones["{b}"].rotation_quaternion', i, b, [q[i] for q in quat[b]])
    for i in range(3):
        write('pose.bones["chest"].location', i, 'chest', [v[i] for v in loc])
    scene.render.fps = N
    scene.render.fps_base = 1.0
    scene.frame_start, scene.frame_end = 0, N
    scene.frame_set(0)
    log('gallop:', N + 1, 'keys on', len(bones), 'bones; one stride =', KEYS['period'], 's at', KEYS['speed'], 'm/s, stride', KEYS['stride'], 'm')


def export_glb():
    arm, mesh = bpy.data.objects['horse_rig'], bpy.data.objects['horse']
    hair = bpy.data.objects.get('horse_hair')
    for o in list(bpy.context.view_layer.objects):
        try:
            o.select_set(False)
        except RuntimeError:
            pass
    for o in [arm, mesh] + ([hair] if hair else []):
        o.hide_set(False)
        o.select_set(True)
    bpy.context.view_layer.objects.active = arm
    arm.data.pose_position = 'POSE'
    out = os.path.join(WORK, 'horse.raw.glb')
    want = dict(
        filepath=out, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
        export_skins=True, export_animations=True, export_animation_mode='ACTIONS', export_force_sampling=True,
        export_frame_range=True, export_frame_step=1, export_optimize_animation_size=False, export_anim_single_armature=True,
        export_def_bones=False, export_influence_nb=4, export_all_influences=False, export_tangents=True, export_normals=True,
        export_texcoords=True, export_materials='EXPORT', export_image_format='AUTO', export_cameras=False, export_lights=False,
        export_morph=True, export_morph_normal=True, export_morph_tangent=False, export_morph_animation=False,
        export_rest_position_armature=True, export_extras=False, export_reset_pose_bones=True,
    )
    props = {p.identifier for p in bpy.ops.export_scene.gltf.get_rna_type().properties}
    dropped = [k for k in want if k not in props]
    if dropped:
        log('exporter has no option', dropped)
    bpy.ops.export_scene.gltf(**{k: v for k, v in want.items() if k in props})
    log('exported', out, os.path.getsize(out), 'bytes')


if globals().get('RUN', True):
    key_gallop()
    # the hindquarters' corrective shapes are measured on the keyed gallop (horse_correct.py)
    import horse_correct
    importlib.reload(horse_correct)
    horse_correct.build()
    export_glb()
