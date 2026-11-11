"""
rider_rig.py - the rider's skeleton, her skin weights, the gallop she rides, and the export.

The skeleton is built on rlib.J (her riding pose is her rest pose). The rig object rides on the horse's 'back' bone
(bone parent, at rest exactly where she was built), so her seat cannot drift off the saddle: the pelvis is fixed to
the back, and everything else is placed from it:

  legs   2-bone IK to a target at the stirrup, fixed on the saddle: the foot stays in the iron, heel down (the
         foot keeps its rest angle to the saddle), the lower leg swings a centimetre or two with the stride
  hands  2-bone IK to a target that follows the horse's mouth half way (the bit moves with the head and neck, the
         elbows give), so the rein stays in a soft contact
  trunk  spine, neck and head take back part of the back's pitch, a little late: the hips go with the horse, the
         shoulders and head stay steadier in the world (refs/rider: the Muybridge riders' heads barely nod while
         the saddle rocks)

"ride" is baked from those constraints (visual keys) at the gallop's 240 keys per stride (frames 0..240 at 240 fps,
like the horse's "gallop": the clip's time is the stride phase). The ponytail and the top's hem are not keyed: the
runtime springs move them (src/valley/ride/Rider.ts).

Then: the clearance through the stride (her skin against the horse and the tack, every 8th key), and the export
(build/blender/rider/rider.raw.glb: her rig unparented at the origin, her body, hair and stirrups, and the tack on
"tack_rig", a copy of the horse's skeleton the runtime rebinds to the horse's own bones by name).

STAGES: rig, skin, anim, check, export
"""
import bpy, bmesh, math, os, sys
import numpy as np
from mathutils import Vector, Matrix, Quaternion
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else 'F:/valley-ride/tools/blender/rider')
import importlib, rlib
importlib.reload(rlib)
from rlib import log, J, pony_points, inside, activate, remove, horse, WORK

V = Vector
N = 240
STAGES = globals().get('STAGES') or ['rig', 'skin', 'anim', 'check', 'export']


def lerp(a, b, t):
    return a + (b - a) * t


# ----------------------------------------------------------------------------- the skeleton
PONY = pony_points()
HEM = {'hem.B': (J['hemB.a'], J['hemB.b']), 'hem.F': (J['hemF.a'], J['hemF.b'])}


def pole(a, m, b, dist):
    """a pole target in the plane of a limb (a, the middle joint m, b), out from m away from the line a-b"""
    ab = (b - a).normalized()
    foot = a + ab * (m - a).dot(ab)
    return m + (m - foot).normalized() * dist


def bone_table():
    """name: (head, tail, parent, deform, radius of the flesh round it)"""
    T = {
        'root': (J['seat'], J['seat'] + V((0, 0, 0.06)), None, False, 0),
        'hips': (J['hips'], J['spine1'], 'root', True, 0.12),
        'spine1': (J['spine1'], J['spine2'], 'hips', True, 0.10),
        'spine2': (J['spine2'], J['chest'], 'spine1', True, 0.10),
        'chest': (J['chest'], J['neck'], 'spine2', True, 0.10),
        'neck': (J['neck'], J['head'], 'chest', True, 0.05),
        'head': (J['head'], J['crown'], 'neck', True, 0.08),
    }
    for s in 'LR':
        g = lambda k: J[f'{k}.{s}']
        T.update({
            f'clav.{s}': (g('clav'), g('shoulder'), 'chest', True, 0.05),
            f'upperarm.{s}': (g('shoulder'), g('elbow'), f'clav.{s}', True, 0.045),
            f'forearm.{s}': (g('elbow'), g('wrist'), f'upperarm.{s}', True, 0.035),
            f'hand.{s}': (g('wrist'), g('knuckle'), f'forearm.{s}', True, 0.035),
            f'grip.{s}': (g('grip'), g('grip') + (g('knuckle') - g('wrist')).normalized() * 0.03, f'hand.{s}', False, 0),
            f'thigh.{s}': (g('hip'), g('knee'), 'hips', True, 0.08),
            f'shin.{s}': (g('knee'), g('ankle'), f'thigh.{s}', True, 0.05),
            f'foot.{s}': (g('ankle'), g('ball'), f'shin.{s}', True, 0.04),
            # IK targets and poles (not deforming), on the saddle
            f'foot_ik.{s}': (g('ankle'), g('ball'), 'root', False, 0),
            f'knee_pole.{s}': (pole(g('hip'), g('knee'), g('ankle'), 0.4), pole(g('hip'), g('knee'), g('ankle'), 0.4) + V((0, 0, 0.06)), 'root', False, 0),
            f'hand_ik.{s}': (g('wrist'), g('knuckle'), 'root', False, 0),
            f'elbow_pole.{s}': (pole(g('shoulder'), g('elbow'), g('wrist'), 0.3), pole(g('shoulder'), g('elbow'), g('wrist'), 0.3) + V((0, 0, 0.06)), 'root', False, 0),
            # the stirrup leather from the bar to the iron's eye, and the iron under the ball of the foot
            f'leather.{s}': (g('bar'), g('eye'), 'root', True, 0),
            f'iron.{s}': (g('eye'), g('tread'), f'leather.{s}', True, 0),
        })
    for i in range(len(PONY) - 1):
        T[f'pony{i + 1}'] = (PONY[i], PONY[i + 1], 'head' if i == 0 else f'pony{i}', True, 0)
    for k, (h, t) in HEM.items():
        T[k] = (h, t, 'spine1', True, 0)
    return T


def build_rig():
    horse()
    remove('rider_rig')
    arm_data = bpy.data.armatures.new('rider_rig')
    rig = bpy.data.objects.new('rider_rig', arm_data)
    bpy.context.scene.collection.objects.link(rig)
    activate(rig)
    bpy.ops.object.mode_set(mode='EDIT')
    T = bone_table()
    eb = {}
    for name, (h, t, parent, deform, r) in T.items():
        b = arm_data.edit_bones.new(name)
        b.head, b.tail = h, t
        b.use_deform = deform
        eb[name] = b
    for name, (h, t, parent, deform, r) in T.items():
        if parent:
            eb[name].parent = eb[parent]
            eb[name].use_connect = False
    # rolls: the joints hinge about sensible axes (the knee and elbow about their own side axes)
    for name, b in eb.items():
        b.align_roll(V((1, 0, 0)) if abs((b.tail - b.head).normalized().x) < 0.9 else V((0, 0, 1)))
    bpy.ops.object.mode_set(mode='OBJECT')
    rig.show_in_front = True
    for pb in rig.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    log('rig:', len(arm_data.bones), 'bones,', sum(b.use_deform for b in arm_data.bones), 'deforming')
    return rig


# ----------------------------------------------------------------------------- skin weights
def seg_dist(P, a, b):
    ab = b - a
    t = np.clip(((P - a) @ ab) / max(ab @ ab, 1e-12), 0, 1)
    return np.linalg.norm(P - (a + t[:, None] * ab), axis=1), t


def assign(ob, names, W, rig):
    ob.vertex_groups.clear()
    groups = [ob.vertex_groups.new(name=n) for n in names]
    # at most 4 influences, normalised
    idx = np.argsort(-W, axis=1)[:, :4]
    for v in range(len(W)):
        ws = W[v, idx[v]]
        s = ws.sum()
        for j, w in zip(idx[v], ws):
            if w / s > 0.01:
                groups[j].add([v], float(w / s), 'REPLACE')
    for m in list(ob.modifiers):
        if m.type == 'ARMATURE':
            ob.modifiers.remove(m)
    m = ob.modifiers.new('rig', 'ARMATURE')
    m.object = rig
    ob.parent = rig
    ob.matrix_parent_inverse = rig.matrix_world.inverted()


# MPFB's "game engine" rig's vertex groups (the body came with them, rider_body) -> her bones. Her skeleton stands
# on that rig's joints in the riding pose (joints.json), so the weights mean the same thing here.
GROUPS = {'Root': 'hips', 'pelvis': 'hips', 'spine_01': 'spine1', 'spine_02': 'spine2', 'spine_03': 'chest', 'neck_01': 'neck', 'head': 'head'}
for s_, S_ in (('l', 'L'), ('r', 'R')):
    GROUPS.update({f'clavicle_{s_}': f'clav.{S_}', f'upperarm_{s_}': f'upperarm.{S_}', f'lowerarm_{s_}': f'forearm.{S_}', f'hand_{s_}': f'hand.{S_}',
                   f'thigh_{s_}': f'thigh.{S_}', f'calf_{s_}': f'shin.{S_}', f'foot_{s_}': f'foot.{S_}', f'ball_{s_}': f'foot.{S_}'})
    for finger in ('thumb', 'index', 'middle', 'ring', 'pinky'):
        for i in (1, 2, 3):
            GROUPS[f'{finger}_0{i}_{s_}'] = f'hand.{S_}'      # the fist is closed in her rest pose and stays closed


def skin_body(rig):
    ob = bpy.data.objects['rider']
    T = bone_table()
    names = [n for n, v in T.items() if v[3] and not n.startswith(('leather', 'iron', 'pony'))]
    col = {n: j for j, n in enumerate(names)}
    me = ob.data
    gname = {g.index: g.name for g in ob.vertex_groups}
    if not any(n in GROUPS for n in gname.values()):
        raise SystemExit('rider has no MPFB vertex groups: run rider_body first (cut, pose, fit)')
    W = np.zeros((len(me.vertices), len(names)))
    for v in me.vertices:
        for g in v.groups:
            to = GROUPS.get(gname[g.group])
            if to:
                W[v.index, col[to]] += g.weight
    lost = W.sum(1) < 1e-6
    if lost.any():
        raise SystemExit(f'{int(lost.sum())} rider vertices carry no bone weight')
    W = W / W.sum(1, keepdims=True)
    # the top's hem: the band above its lower edge, front and back, gives part of its weight to the hem bones
    hb = np.zeros(len(me.vertices))
    me.attributes['hemband'].data.foreach_get('value', hb)
    for n, sgn in (('hem.F', 1), ('hem.B', -1)):
        w = np.clip(hb * sgn, 0, 1) * 0.6
        W *= (1 - w)[:, None]
        W[:, col[n]] += w
    assign(ob, names, W, rig)
    log('body weights:', len(W), 'vertices,', len(names), "bones (from the base mesh's own weights)")


def skin_hair(rig):
    ob = bpy.data.objects['rider_hair']
    me = ob.data
    names = ['head'] + [f'pony{i + 1}' for i in range(len(PONY) - 1)]
    n = len(me.vertices)
    t = np.zeros(n)
    k = np.zeros(n)
    me.attributes['hair_t'].data.foreach_get('value', t)
    me.attributes['hair_kind'].data.foreach_get('value', k)
    W = np.zeros((n, len(names)))
    segs = len(PONY) - 1
    for v in range(n):
        if k[v] > 0.5:
            W[v, 0] = 1
        else:
            x = t[v] * segs                   # along the bundle
            i = min(segs - 1, int(x))
            f = x - i
            W[v, 1 + i] += 1 - f * 0.5
            if i + 1 < segs:
                W[v, 2 + i] += f * 0.5
            if x < 0.4:
                W[v, 0] += 1 - x / 0.4        # the tie is on the head
    assign(ob, names, W, rig)


def skin_leathers(rig):
    ob = bpy.data.objects['leathers']
    T = bone_table()
    names = ['leather.L', 'iron.L', 'leather.R', 'iron.R']
    P = np.array([v.co[:] for v in ob.data.vertices])
    W = np.zeros((len(P), 4))
    for j, nm in enumerate(names):
        h, t = T[nm][0], T[nm][1]
        d, _ = seg_dist(P, np.array(h[:]), np.array(t[:]))
        W[:, j] = 1.0 / (d + 0.004) ** 6
    assign(ob, names, W, rig)


def skin_tack():
    """the tack on a copy of the horse's skeleton (tack_rig): the bridle takes the horse's own weights where it lies;
    the saddle mostly goes with the back bone, so the seat under her is rigid with her"""
    arm, body = horse()
    tack = bpy.data.objects['tack']
    remove('tack_rig')
    tr = arm.copy()
    tr.data = arm.data.copy()
    tr.name = tr.data.name = 'tack_rig'
    tr.animation_data_clear()
    bpy.context.scene.collection.objects.link(tr)
    tr.data.pose_position = 'REST'
    tack.vertex_groups.clear()
    for m in list(tack.modifiers):
        tack.modifiers.remove(m)
    arm.data.pose_position = 'REST'          # (the transfer reads the horse's evaluated surface: at rest)
    bpy.context.view_layer.update()
    dt = tack.modifiers.new('wt', 'DATA_TRANSFER')
    dt.object = body
    dt.use_vert_data = True
    dt.data_types_verts = {'VGROUP_WEIGHTS'}
    dt.vert_mapping = 'POLYINTERP_NEAREST'
    dt.layers_vgroup_select_src = 'ALL'
    dt.layers_vgroup_select_dst = 'NAME'
    activate(tack)
    bpy.ops.object.modifier_apply(modifier='wt')
    me = tack.data
    names = [g.name for g in tack.vertex_groups]
    W = np.zeros((len(me.vertices), len(names)))
    for v in me.vertices:
        for g in v.groups:
            W[v.index, g.group] = g.weight
    if 'back' not in names:
        tack.vertex_groups.new(name='back')
        names.append('back')
        W = np.hstack([W, np.zeros((len(W), 1))])
    P = np.array([v.co[:] for v in me.vertices])
    W = W / np.maximum(W.sum(1, keepdims=True), 1e-12)
    saddle = (P[:, 2] > 1.2) & (P[:, 1] > -0.75) & (P[:, 1] < 0.3)
    # the seat and the flaps, under her, go with the back as she does (the pad's edges keep a little of the skin's
    # own motion, so the horse's shoulder never comes through it)
    seat_flap = saddle & (np.abs(P[:, 0]) < 0.33) & (P[:, 1] > -0.62) & (P[:, 1] < 0.12) & (P[:, 2] > 1.22)
    rigid = np.where(seat_flap, 1.0, np.where(saddle, 0.75, 0.0))
    W = W * (1 - rigid[:, None])
    W[:, names.index('back')] += rigid
    deform = {b.name for b in arm.data.bones if b.use_deform}
    for j, n in enumerate(names):
        # (not the mane's, the ears' or the tail's bones: they swing on springs at runtime, and leather does not)
        if n not in deform or n.startswith(('mane', 'ear', 'tail')):
            W[:, j] = 0
    # the bridle is on the skull: all of it on the head bone
    if 'head' not in names:
        tack.vertex_groups.new(name='head')
        names.append('head')
        W = np.hstack([W, np.zeros((len(W), 1))])
    bridle = P[:, 1] < -0.95
    W[bridle] = 0
    W[bridle, names.index('head')] = 1.0
    lost = W.sum(1) < 1e-6
    W[lost, names.index('back')] = 1.0
    W = W / np.maximum(W.sum(1, keepdims=True), 1e-12)
    assign(tack, names, W, tr)
    arm.data.pose_position = 'POSE'
    # in Blender the tack goes with the horse's own rig (export() puts it on tack_rig)
    next(m for m in tack.modifiers if m.type == 'ARMATURE').object = arm
    log('tack on tack_rig:', len(me.vertices), 'vertices')
    return tr


# ----------------------------------------------------------------------------- the ride
def back_mat(arm, rest):
    pb = arm.pose.bones['back']
    if rest:
        m = arm.data.bones['back'].matrix_local.copy()
    else:
        m = pb.matrix.copy()
    return arm.matrix_world @ m


def ride_on_back(rig, arm):
    """parent the rig to the horse's back bone, where it is at rest"""
    arm.data.pose_position = 'REST'
    bpy.context.view_layer.update()
    rig.parent = arm
    rig.parent_type = 'BONE'
    rig.parent_bone = 'back'
    b = arm.data.bones['back']
    m = b.matrix_local.copy()
    m.translation = b.tail_local
    rig.matrix_parent_inverse = (arm.matrix_world @ m).inverted()
    rig.matrix_basis = Matrix.Identity(4)
    arm.data.pose_position = 'POSE'
    bpy.context.view_layer.update()


def add_ik(rig):
    for s in 'LR':
        for chain, tgt, pole, end in (('shin', 'foot_ik', 'knee_pole', 'foot'), ('forearm', 'hand_ik', 'elbow_pole', 'hand')):
            pb = rig.pose.bones[f'{chain}.{s}']
            for c in list(pb.constraints):
                pb.constraints.remove(c)
            c = pb.constraints.new('IK')
            c.name = 'ik'
            c.target, c.subtarget = rig, f'{tgt}.{s}'
            c.pole_target, c.pole_subtarget = rig, f'{pole}.{s}'
            c.chain_count = 2
            c.use_tail = True
            c.use_stretch = False
            e = rig.pose.bones[f'{end}.{s}']
            for c2 in list(e.constraints):
                e.constraints.remove(c2)
            c2 = e.constraints.new('COPY_TRANSFORMS')
            c2.target, c2.subtarget = rig, f'{tgt}.{s}'
            c2.name = 'end'
        # the IK's tail is at the target's head: the targets' heads are the ankle and the wrist
        for chain, pole in (('shin', 'knee_pole'), ('forearm', 'elbow_pole')):
            fit_pole_angle(rig, rig.pose.bones[f'{chain}.{s}'].constraints['ik'], f'{chain}.{s}')


def fit_pole_angle(rig, c, bone):
    """the pole angle that leaves the rest pose where it was built"""
    want = rig.data.bones[bone].head_local.copy()
    best = (1e9, 0)
    for deg in range(-180, 180, 3):
        c.pole_angle = math.radians(deg)
        bpy.context.view_layer.update()
        e = (rig.pose.bones[bone].head - want).length
        if e < best[0]:
            best = (e, deg)
    for d in np.arange(best[1] - 3, best[1] + 3, 0.25):
        c.pole_angle = math.radians(d)
        bpy.context.view_layer.update()
        e = (rig.pose.bones[bone].head - want).length
        if e < best[0]:
            best = (e, d)
    c.pole_angle = math.radians(best[1])
    bpy.context.view_layer.update()
    log(f'pole {bone}: {best[1]:.2f} deg, joint off its build by {best[0] * 1000:.1f} mm at rest')


def armature_axis_rot(rig, bone, axis, angle):
    """a pose-bone quaternion that turns the bone by angle about an axis given in the rig's space"""
    rest = rig.data.bones[bone].matrix_local.to_3x3()
    R = Matrix.Rotation(angle, 3, axis)
    return (rest.inverted() @ R @ rest).to_quaternion()


TRUNK = [('spine1', 0.12), ('spine2', 0.14), ('chest', 0.14), ('neck', 0.18), ('head', 0.22)]   # share of the back's pitch taken back
LAG = 18          # keys (of 240) the trunk's answer comes after the back's motion
HANDS = 0.35      # how much of the bit's motion across the rein's line the hands follow (along it: all)


def key_ride(rig, arm):
    scene = bpy.context.scene
    scene.render.fps = N
    scene.frame_start, scene.frame_end = 0, N
    for pb in rig.pose.bones:
        pb.matrix_basis = Matrix.Identity(4)
    # the back's pitch (about the horse's side axis, in the back's own frame) and the bit's motion, per key
    rest_inv = back_mat(arm, True).inverted()
    head_rest = arm.data.bones['head'].matrix_local.copy()
    # the bit: the centre of each bit ring (tack_mesh), on the head at rest
    bit_rest = {}
    for s in 'LR':
        o = bpy.data.objects['bitring1' if s == 'L' else 'bitring-1']
        bit_rest[s] = o.matrix_world @ (sum((v.co for v in o.data.vertices), V()) / len(o.data.vertices))
    pitch, bit = [], []
    for f in range(N + 1):
        scene.frame_set(f)
        B = back_mat(arm, False)
        R = (rest_inv @ B).to_3x3()        # the back's turn from rest, in the back's rest frame
        fwd = R @ V((0, -1, 0))
        pitch.append(math.atan2(fwd.z, -fwd.y))     # + nose up
        Hm = arm.matrix_world @ arm.pose.bones['head'].matrix @ head_rest.inverted()
        # the bit in the rider's frame (the rig rides on the back: its frame is B @ rest_inv)
        to_rig = (B @ rest_inv).inverted()
        bit.append({s: to_rig @ (Hm @ bit_rest[s]) - bit_rest[s] for s in 'LR'})
    pitch = np.array(pitch)
    log(f'back pitch over the stride: {math.degrees(pitch.min()):.1f} .. {math.degrees(pitch.max()):.1f} deg')
    mean_bit = {s: sum((b[s] for b in bit), V()) / len(bit) for s in 'LR'}
    for f in range(N + 1):
        scene.frame_set(f)
        late = pitch[(f - LAG) % N]
        for name, share in TRUNK:
            pb = rig.pose.bones[name]
            pb.rotation_quaternion = armature_axis_rot(rig, name, V((1, 0, 0)), late * share)
            pb.keyframe_insert('rotation_quaternion', frame=f)
        for s in 'LR':
            h = rig.pose.bones[f'hand_ik.{s}']
            # the rein keeps its length: along its own line (bit to fist) the fist goes all the way with the bit,
            # across it only a part (the elbow opens and closes; the rein neither slackens nor stretches)
            d0 = bit[f][s] - mean_bit[s]
            u = (bit_rest[s] + mean_bit[s] - rig.data.bones[f'hand_ik.{s}'].head_local).normalized()
            d = u * d0.dot(u) + (d0 - u * d0.dot(u)) * HANDS
            d.z = max(d.z, -0.03)             # (the fists stay over the withers, not in them)
            h.location = rig.data.bones[f'hand_ik.{s}'].matrix_local.to_3x3().inverted() @ d
            h.keyframe_insert('location', frame=f)
            ft = rig.pose.bones[f'foot_ik.{s}']
            ph = 2 * math.pi * f / N
            ft.location = rig.data.bones[f'foot_ik.{s}'].matrix_local.to_3x3().inverted() @ V((0, 0.012 * math.sin(ph + 0.6), 0.006 * math.sin(2 * ph)))
            ft.keyframe_insert('location', frame=f)
    log('keyed the trunk, hands and feet over', N + 1, 'keys')


def leg_depth(body, hb, side_sign, weights_mask, mw):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = body.evaluated_get(dg)
    me = ev.to_mesh()
    deep = 0.0
    for i in weights_mask:
        p = mw @ me.vertices[i].co
        for t in hb:
            hit, nrm, _, d = t.find_nearest(p, 0.06)
            if hit is not None and inside(t, p):
                deep = max(deep, d)
    ev.to_mesh_clear()
    return deep


def clear_legs(rig, arm, step=4, passes=5):
    """where the horse's shoulder swells into her leg (late in the stride, the foreleg reaching), the knee gives:
    the leg turns out about the hip-ankle line (its pole moves out) and the foot comes out a little, by as much as
    the skin went in, until it is clear; then the offsets are smoothed round the stride"""
    scene = bpy.context.scene
    body = bpy.data.objects['rider']
    horse_body = bpy.data.objects['horse']
    leg_bones = {'L': ['thigh.L', 'shin.L', 'foot.L'], 'R': ['thigh.R', 'shin.R', 'foot.R']}
    gi = {g.name: g.index for g in body.vertex_groups}
    masks = {s: [v.index for v in body.data.vertices if any(g.group in (gi.get(b) for b in leg_bones[s]) and g.weight > 0.3 for g in v.groups)] for s in 'LR'}
    frames = list(range(0, N, step))
    out = {s: np.zeros(len(frames)) for s in 'LR'}
    def apply(s, fi, f, x):
        sg = 1 if s == 'L' else -1
        for name, k in ((f'knee_pole.{s}', 1.0), (f'foot_ik.{s}', 0.4)):
            pb = rig.pose.bones[name]
            base = BASE[name][f]
            pb.location = base + rig.data.bones[name].matrix_local.to_3x3().inverted() @ V((sg * x * k, 0, 0))
            pb.keyframe_insert('location', frame=f)
    BASE = {}
    for s in 'LR':
        for name in (f'knee_pole.{s}', f'foot_ik.{s}'):
            BASE[name] = {}
            for f in range(N + 1):
                scene.frame_set(f)
                BASE[name][f] = rig.pose.bones[name].location.copy()
    for p in range(passes):
        worst = 0
        for fi, f in enumerate(frames):
            scene.frame_set(f)
            dg = bpy.context.evaluated_depsgraph_get()
            hb = [BVHTree.FromObject(horse_body, dg), BVHTree.FromObject(bpy.data.objects['tack'], dg)]
            for s in 'LR':
                d = leg_depth(body, hb, 1, masks[s], body.matrix_world)
                if d > 0.002:
                    out[s][fi] = min(out[s][fi] + (d + 0.004) * 1.6, 0.05)
                    apply(s, fi, f, out[s][fi])
                worst = max(worst, d)
        log(f'legs clearance pass {p}: deepest {worst * 1000:.1f} mm; pole offsets up to {max(out["L"].max(), out["R"].max()) * 100:.1f} cm')
        if worst < 0.002:
            break
    # smooth round the stride and key every frame
    for s in 'LR':
        x = out[s]
        for _ in range(3):
            x = np.maximum(x, (np.roll(x, 1) + x + np.roll(x, -1)) / 3)
        for f in range(N + 1):
            t = (f % N) / step
            i = int(t) % len(frames)
            u = t - int(t)
            apply(s, i, f, x[i] * (1 - u) + x[(i + 1) % len(frames)] * u)


def bake_ride(rig):
    activate(rig)
    bpy.ops.object.mode_set(mode='POSE')
    bpy.ops.nla.bake(frame_start=0, frame_end=N, step=1, only_selected=False, visual_keying=True, clear_constraints=True,
                     clear_parents=False, use_current_action=False, bake_types={'POSE'})
    bpy.ops.object.mode_set(mode='OBJECT')
    act = rig.animation_data.action
    old = bpy.data.actions.get('ride')
    if old and old != act:
        bpy.data.actions.remove(old)
    act.name = 'ride'
    # the springs own the ponytail and the hem: no keys there
    log('baked "ride":', act.name)


# ----------------------------------------------------------------------------- clearance through the stride
def check(step=4):
    """how far her skin goes into the horse, and into the tack (the tack on the horse's own bones here, as at runtime),
    over the stride"""
    body = bpy.data.objects['rider']
    tack = bpy.data.objects['tack']
    scene = bpy.context.scene
    res = {'horse': [], 'tack': []}
    for f in range(0, N, step):
        scene.frame_set(f)
        dg = bpy.context.evaluated_depsgraph_get()
        trees = {'horse': BVHTree.FromObject(bpy.data.objects['horse'], dg), 'tack': BVHTree.FromObject(tack, dg)}
        ev = body.evaluated_get(dg)
        me = ev.to_mesh()
        mw = body.matrix_world
        for k, t in trees.items():
            deep, n = 0.0, 0
            for v in me.vertices:
                p = mw @ v.co
                hit, nrm, _, d = t.find_nearest(p, 0.05)
                if hit is not None and d > 0.004 and inside(t, p):
                    n += 1
                    deep = max(deep, d)
            res[k].append((deep, n, f))
        ev.to_mesh_clear()
    for k, w in res.items():
        w.sort(reverse=True)
        log(f'into the {k} (> 4 mm), worst keys:', ', '.join(f'key {f}: {n} verts, {d * 1000:.0f} mm' for d, n, f in w[:3]))
    scene.frame_set(0)
    return res


# ----------------------------------------------------------------------------- her face moves
def expressions():
    """shape keys on her face for the runtime (src/valley/ride/Rider.ts): blink (the upper lids, with their lashes,
    down over the eyes), squint (the lower lids up, the upper a third down), smile (the mouth's corners out and up,
    the cheeks lifted a little)"""
    ob = bpy.data.objects['rider']
    me = ob.data
    if me.shape_keys:
        ob.shape_key_clear()
    P = [v.co.copy() for v in me.vertices]
    pa = me.attributes['part'].data
    vpart = [0] * len(P)
    for p in me.polygons:
        for v in p.vertices:
            vpart[v] = pa[p.index].value
    lips = me.attributes['m_lips'].data
    up = (J['crown'] - J['head']).normalized()
    side = V((1, 0, 0))
    fwd = up.cross(side).normalized()
    fwd = fwd if fwd.y < 0 else -fwd
    blink, squint, smile = {}, {}, {}
    for sg in (1, -1):
        eye = [P[i] for i in range(len(P)) if vpart[i] == 4 and P[i].x * sg > 0]
        c = sum(eye, V()) / len(eye)
        r = max((p - c).length for p in eye)
        cand = []
        for i, p in enumerate(P):
            if vpart[i] in (0, 5) and p.x * sg > 0:
                q = p - c
                if q.length < r + 0.014 and q.dot(fwd) > 0.002:
                    lat, e, f_ = q.dot(side), q.dot(up), q.dot(fwd)
                    cand.append((i, lat, math.atan2(e, f_), math.hypot(e, f_), q.length))
        mid = [(phi, d) for i, lat, phi, rad, d in cand if abs(lat) < 0.006 and d < r + 0.002 and vpart[i] == 0]
        phi_u = min(phi for phi, d in mid if phi > 0.02)          # the upper lid's edge, the lower's
        phi_l = max(phi for phi, d in mid if phi < 0.02)
        phi_top = phi_u + 0.8
        for i, lat, phi, rad, d in cand:
            w = max(0.0, 1 - (abs(lat) / (r * 1.08)) ** 3)        # the corners stay
            def at(ph):
                rr = max(rad, math.sqrt(max((r + 0.0009) ** 2 - lat * lat, 0.0)))
                return c + side * lat + up * (rr * math.sin(ph)) + fwd * (rr * math.cos(ph))
            if phi_u - 0.02 <= phi <= phi_top:
                t = (phi - phi_u) / (phi_top - phi_u)
                closed = (phi_l + 0.03) + max(0.0, t) * (phi_top - phi_l - 0.03)
                blink[i] = at(phi + (closed - phi) * w)
                squint[i] = at(phi + (closed - phi) * w * 0.3)
            elif phi_l - 0.5 <= phi <= phi_l + 0.02 and vpart[i] == 0 or (vpart[i] == 5 and phi < phi_u - 0.02):
                t = max(0.0, 1 - (phi_l - phi) / 0.5)
                squint[i] = at(phi + 0.14 * t * w)
        # the mouth's corner on this side
        corner = max((P[i] for i in range(len(P)) if lips[i].value > 0.5 and vpart[i] == 0), key=lambda p: p.x * sg)
        cheek = corner + up * 0.032 + side * (sg * 0.018)
        for i, p in enumerate(P):
            if vpart[i] != 0 or p.x * sg <= 0:
                continue
            d = (p - corner).length
            dc = (p - cheek).length
            if d < 0.045 or dc < 0.05:
                w = math.exp(-(d / 0.015) ** 2)
                wc = math.exp(-(dc / 0.022) ** 2)
                smile[i] = p + (side * (sg * 0.0038) + up * 0.0042 - fwd * 0.0018) * w + (up * 0.0016 + fwd * 0.0008) * wc
    ob.shape_key_add(name='Basis')
    for name, D in (('blink', blink), ('squint', squint), ('smile', smile)):
        k = ob.shape_key_add(name=name)
        for i, p in D.items():
            k.data[i].co = p
        k.value = 0.0
    log(f'expressions: blink {len(blink)} vertices, squint {len(squint)}, smile {len(smile)}')


# ----------------------------------------------------------------------------- export
def export():
    rig = bpy.data.objects['rider_rig']
    tr = bpy.data.objects['tack_rig']
    scene = bpy.context.scene
    scene.frame_set(0)
    # off the horse: the rig at the origin (its keys are its own bones', relative to the rig)
    mw = Matrix.Identity(4)
    rig.parent = None
    rig.matrix_world = mw
    tack_mod = next(m for m in bpy.data.objects['tack'].modifiers if m.type == 'ARMATURE')
    tack_mod.object = tr
    objs = [rig, tr] + [bpy.data.objects[n] for n in ('rider', 'rider_hair', 'leathers', 'tack')]
    for o in list(bpy.context.view_layer.objects):
        try:
            o.select_set(False)
        except (RuntimeError, AttributeError):
            pass
    for o in objs:
        o.hide_set(False)
        o.select_set(True)
    bpy.context.view_layer.objects.active = rig
    out = os.path.join(WORK, 'rider.raw.glb')
    want = dict(
        filepath=out, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
        export_skins=True, export_animations=True, export_animation_mode='ACTIVE_ACTIONS', export_force_sampling=True,
        export_frame_range=True, export_frame_step=1, export_optimize_animation_size=False, export_anim_single_armature=False,
        export_def_bones=False, export_influence_nb=4, export_all_influences=False, export_tangents=True, export_normals=True,
        export_texcoords=True, export_materials='EXPORT', export_image_format='AUTO', export_cameras=False, export_lights=False,
        export_morph=True, export_morph_normal=False, export_morph_tangent=False, export_rest_position_armature=True, export_extras=True, export_reset_pose_bones=True,
        export_attributes=False,
    )
    props = {p.identifier for p in bpy.ops.export_scene.gltf.get_rna_type().properties}
    bpy.ops.export_scene.gltf(**{k: v for k, v in want.items() if k in props})
    log('exported', out, os.path.getsize(out), 'bytes')
    # back on the horse
    tack_mod.object = bpy.data.objects['horse_rig']
    ride_on_back(rig, bpy.data.objects['horse_rig'])


if __name__ == '__main__':
    arm, body = horse()
    if 'rig' in STAGES:
        rig = build_rig()
    rig = bpy.data.objects['rider_rig']
    if 'skin' in STAGES:
        rig.data.pose_position = 'REST'
        skin_body(rig)
        skin_hair(rig)
        skin_leathers(rig)
        skin_tack()
        rig.data.pose_position = 'POSE'
    if 'anim' in STAGES:
        if rig.animation_data:
            rig.animation_data.action = None
        ride_on_back(rig, arm)
        add_ik(rig)
        key_ride(rig, arm)
        clear_legs(rig, arm)
        bake_ride(rig)
    if 'check' in STAGES:
        check()
    if 'faces' in STAGES:
        expressions()
    if 'export' in STAGES:
        export()
