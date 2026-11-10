"""
horse_rig.py - the armature (from the rest pose of gallop.design.json) and the skin weights of "horse".

36 deform bones: chest (root), back, loin, pelvis, neck1-3, head, ear.L/R, tail1-4, and per leg scapula, humerus,
radius, cannonF, pasternF, hoofF | femur, tibia, cannonH, pasternH, hoofH. Every bone of the gallop turns about
the lateral axis, so each is rolled to carry that axis as its local X.
Weights: bone heat, then at most 4 bones per vertex, normalised; hooves, eyes and ears rigid to their bone.
"""
import bpy, bmesh, math, sys, os
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else 'F:/valley-ride/tools/blender/horse')
import importlib, hlib
importlib.reload(hlib)
from hlib import S, Rest, log, design, remove, activate, tail_points, ear_points

MAX_BONES, MAX_INFLUENCES = 60, 4
R = Rest(design())


def build_armature():
    remove('horse_rig')
    arm = bpy.data.armatures.new('horse_rig')
    ob = bpy.data.objects.new('horse_rig', arm)
    bpy.context.scene.collection.objects.link(ob)
    activate(ob)
    bpy.ops.object.mode_set(mode='EDIT')
    X = Vector((1, 0, 0))

    def bone(name, parent, head, tail):
        eb = arm.edit_bones.new(name)
        eb.head, eb.tail = head, tail
        # local X = the lateral axis: Z = X x Y
        eb.align_roll(X.cross((tail - head).normalized()))
        if parent:
            eb.parent = arm.edit_bones[parent]
        eb.use_connect = False
        return eb

    for b in R.d['rest']['bones']:
        sg = -1 if b['name'].endswith('.R') else 1
        bone(b['name'], b['parent'], S(b['head'], sg * b['lat'][0]), S(b['tail'], sg * b['lat'][1]))
    tp = tail_points(R)
    for i in range(4):
        bone(f'tail{i + 1}', 'pelvis' if i == 0 else f'tail{i}', S(tp[i + 1]), S(tp[i + 2]))
    for sg, sd in ((1, 'L'), (-1, 'R')):
        a, b, _, _ = ear_points(R, sg)
        bone(f'ear.{sd}', 'head', a, b)
    bpy.ops.object.mode_set(mode='OBJECT')
    n = len(arm.bones)
    log('armature:', n, 'bones (all deform)')
    assert n <= MAX_BONES
    return ob


def skin(arm_ob):
    mesh = bpy.data.objects['horse']
    for m in list(mesh.modifiers):
        mesh.modifiers.remove(m)
    for g in list(mesh.vertex_groups):
        mesh.vertex_groups.remove(g)
    mesh.parent = None
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    mesh.select_set(True)
    arm_ob.select_set(True)
    bpy.context.view_layer.objects.active = arm_ob
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    me = mesh.data
    gi = {g.name: g.index for g in mesh.vertex_groups}
    names = {g.index: g.name for g in mesh.vertex_groups}
    # rigid parts
    hoofs = {}
    for sd, sg in (('L', 1), ('R', -1)):
        for k in ('hoofF', 'hoofH'):
            t = R.tail(f'{k}.{sd}')
            hoofs[f'{k}.{sd}'] = S((t[0] - 0.064, 0.0), sg * (0.13 if k == 'hoofF' else 0.15))
    ears = {f'ear.{sd}': ear_points(R, sg) for sd, sg in (('L', 1), ('R', -1))}
    unweighted = 0
    worst = 0
    for v in me.vertices:
        w = {names[g.group]: g.weight for g in v.groups if g.weight > 1e-4}
        p = v.co
        for hn, c in hoofs.items():
            d = (Vector((p.x, p.y, 0)) - Vector((c.x, c.y, 0))).length
            if p.z < 0.07 and d < 0.1:
                w = {hn: 1.0}
            elif p.z < 0.1 and d < 0.1:
                t = (p.z - 0.07) / 0.03
                w = {k: x * t for k, x in w.items()}
                w[hn] = w.get(hn, 0) + (1 - t) * max(1e-3, sum(w.values()) / max(t, 1e-3))
        for en, (a, b, _, _) in ears.items():
            ab = b - a
            t = (p - a).dot(ab) / ab.length_squared
            if t > 0.25 and (p - (a + ab * t)).length < 0.05:
                w = {en: 1.0}
        if not w:
            unweighted += 1
            continue
        top = sorted(w.items(), key=lambda kv: -kv[1])[:MAX_INFLUENCES]
        s = sum(x for _, x in top)
        worst = max(worst, len(w))
        for g in v.groups:
            mesh.vertex_groups[g.group].remove([v.index])
        for k, x in top:
            mesh.vertex_groups[gi[k]].add([v.index], x / s, 'REPLACE')
    used = {names[g.group] for v in me.vertices for g in v.groups}
    empty = [b.name for b in arm_ob.data.bones if b.name not in used]
    log('skin:', len(me.vertices), 'verts; unweighted', unweighted, '; bones with no vertex', empty, '; influences before the limit up to', worst)
    assert unweighted == 0, 'vertices without weights (bone heat failed)'
    return mesh


if globals().get('RUN', True):
    arm_ob = build_armature()
    skin(arm_ob)
