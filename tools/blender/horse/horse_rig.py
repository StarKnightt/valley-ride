"""
horse_rig.py - the armature (from the rest pose of gallop.design.json) and the skin weights of "horse" and
"horse_hair".

39 deform bones: chest (root), back, loin, pelvis, neck1-3, head, ear.L/R, tail1-4, mane1-3, and per leg scapula,
humerus, radius, cannonF, pasternF, hoofF | femur, tibia, cannonH, pasternH, hoofH. Every bone of the gallop turns
about the lateral axis, so each is rolled to carry that axis as its local X.
Body weights: bone heat, smoothed over the surface (so the trunk bends as a whole and keeps its volume where the
back, loin, pelvis and thighs meet), at most 4 bones per vertex, normalised; hooves and ears rigid to their bone.
Hair weights: each strip follows the neck or tail bone under its root, its free length the mane / tail bones.
`volume_report()` poses the gallop's keys and prints how far the body's volume strays from its rest volume.
"""
import bpy, bmesh, math, sys, os
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else 'F:/valley-ride/tools/blender/horse')
import importlib, hlib
importlib.reload(hlib)
from hlib import S, Rest, log, design, remove, activate, tail_points, ear_points, neck_lines, perp, apply_pose, key_rot, HALF_BONES

MAX_BONES, MAX_INFLUENCES = 60, 4
MANE_T = (0.12, 0.31, 0.5, 0.69, 0.88)
TRUNK_PASSES = globals().get('TRUNK_PASSES', 14)
SHARE_MIN = globals().get('SHARE_MIN', 0.15)
SCAP_MAX = globals().get('SCAP_MAX', 0.5)
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
        eb.align_roll(X.cross((tail - head).normalized()))   # local X = the lateral axis
        if parent:
            eb.parent = arm.edit_bones[parent]
        eb.use_connect = False
        return eb

    for b in R.d['rest']['bones']:
        sg = -1 if b['name'].endswith('.R') else 1
        bone(b['name'], b['parent'], S(b['head'], sg * b['lat'][0]), S(b['tail'], sg * b['lat'][1]))
    # half-way bones over the hips and shoulders: each lies on its bone and turns half as far from the parent
    for name, (_, child, parent) in HALF_BONES.items():
        c = arm.edit_bones[child]
        bone(name, parent, c.head.copy(), c.tail.copy())
    tp = tail_points(R)
    for i in range(4):
        bone(f'tail{i + 1}', 'pelvis' if i == 0 else f'tail{i}', S(tp[i + 1]), S(tp[i + 2]))
    for sg, sd in ((1, 'L'), (-1, 'R')):
        a, b, _, _ = ear_points(R, sg)
        bone(f'ear.{sd}', 'head', a, b)
    crest, _, _ = neck_lines(R)
    for i, t in enumerate(MANE_T):
        tang = (crest(t + 0.03) - crest(t - 0.03)).normalized()
        bone(f'mane{i + 1}', f'neck{min(3, 1 + (i * 3) // 5)}', S(crest(t), -0.03), S(crest(t) - perp(tang) * 0.2, -0.03))
    bpy.ops.object.mode_set(mode='OBJECT')
    n = len(arm.bones)
    log('armature:', n, 'bones (all deform)')
    assert n <= MAX_BONES
    return ob


def bind(mesh, arm_ob):
    for m in list(mesh.modifiers):
        mesh.modifiers.remove(m)
    for g in list(mesh.vertex_groups):
        mesh.vertex_groups.remove(g)
    mesh.parent = arm_ob
    mod = mesh.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm_ob
    for b in arm_ob.data.bones:
        mesh.vertex_groups.new(name=b.name)


def write_weights(mesh, W):
    """W: per vertex {bone: weight}; keeps the strongest MAX_INFLUENCES, normalised"""
    gi = {g.name: g for g in mesh.vertex_groups}
    for vi, w in enumerate(W):
        top = sorted(w.items(), key=lambda kv: -kv[1])[:MAX_INFLUENCES]
        s = sum(x for _, x in top)
        for k, x in top:
            if x / s > 1e-4:
                gi[k].add([vi], x / s, 'REPLACE')


def skin_body(arm_ob):
    mesh = bpy.data.objects['horse']
    for m in list(mesh.modifiers):
        mesh.modifiers.remove(m)
    for g in list(mesh.vertex_groups):
        mesh.vertex_groups.remove(g)
    mesh.parent = None
    # bone heat from the body's own bones (the mane's bones hang outside the body and would only confuse it)
    hair_bones = [b for b in arm_ob.data.bones if b.name.startswith('mane') or 'Half' in b.name]
    for b in hair_bones:
        b.use_deform = False
    activate(arm_ob)
    mesh.select_set(True)
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    for b in hair_bones:
        b.use_deform = True
    me = mesh.data
    names = {g.index: g.name for g in mesh.vertex_groups}
    W = [{names[g.group]: g.weight for g in v.groups if g.weight > 1e-4} for v in me.vertices]
    unweighted = sum(1 for w in W if not w)
    assert unweighted == 0, f'{unweighted} vertices without weights (bone heat failed)'
    # rigid parts: hooves below the coronet, ears above their base
    rigid = {}
    for sd, sg in (('L', 1), ('R', -1)):
        for k, lat in (('hoofF', 0.13), ('hoofH', 0.15)):
            t = R.tail(f'{k}.{sd}')
            c = S((t[0] - 0.066, 0.0), sg * lat)
            for v in me.vertices:
                p = v.co
                if p.z < 0.075 and (Vector((p.x, p.y, 0)) - Vector((c.x, c.y, 0))).length < 0.1:
                    rigid[v.index] = f'{k}.{sd}'
        a, b, _, _ = ear_points(R, sg)
        ab = b - a
        for v in me.vertices:
            t = (v.co - a).dot(ab) / ab.length_squared
            if t > 0.3 and (v.co - (a + ab * t)).length < 0.05:
                rigid[v.index] = f'ear.{sd}'
    # the big joints: a thigh or an upper arm carried wholly by its bone swings its muscle through the trunk and the
    # body loses a tenth of its volume. The mass over a joint belongs partly to the trunk side: the bone's share
    # grows from little at the hip / shoulder to all of it near the stifle / elbow.
    sm01 = lambda x: max(0.0, min(1.0, x)) ** 2 * (3 - 2 * max(0.0, min(1.0, x)))
    for name, (_, bone_, parent) in HALF_BONES.items():
        b = arm_ob.data.bones[bone_]
        h, ax = b.head_local, (b.tail_local - b.head_local)
        for vi, w in enumerate(W):
            x = w.pop(name, 0.0) + w.get(bone_, 0.0)
            if x <= 0:
                continue
            t = (me.vertices[vi].co - h).dot(ax) / ax.length_squared
            u = sm01((t - 0.08) / 0.75)
            if bone_.startswith('femur'):
                # the buttock and the hamstring behind the thigh bone stay with the pelvis: only the stifle travels
                rearness = max(0.0, min(1.0, (me.vertices[vi].co.y - h.y - 0.02) / 0.16))
                u *= 1 - 0.7 * rearness * max(0.0, 1 - t)   # the bone's own from a third of the way down; the joint itself shared
            w[bone_] = x * max(0.0, 2 * u - 1)
            w[name] = x * (1 - abs(2 * u - 1))
            w[parent] = w.get(parent, 0.0) + x * max(0.0, 1 - 2 * u)
            if w[bone_] <= 0:
                del w[bone_]
        # and the trunk's own skin near the joint leans on the half-way bone a little
    # smooth the weights over the surface: more over the trunk and quarters, where a hard boundary between the
    # loin, the pelvis and the thighs is what pinches the rump when the back flexes
    nb = [[] for _ in me.vertices]
    for e in me.edges:
        a, b = e.vertices
        nb[a].append(b)
        nb[b].append(a)
    knee = max(R.head('cannonF.L')[1], R.head('cannonH.L')[1])
    def passes(v):
        z = me.vertices[v].co.z
        return TRUNK_PASSES if z > knee + 0.25 else (min(4, TRUNK_PASSES) if z > knee else 1)
    for it in range(10):
        Wn = []
        for vi, w in enumerate(W):
            if vi in rigid or it >= passes(vi):
                Wn.append(w)
                continue
            acc = dict(w)
            for j in nb[vi]:
                for k, x in W[j].items():
                    acc[k] = acc.get(k, 0.0) + x / len(nb[vi])
            Wn.append({k: x / 2 for k, x in acc.items()})
        W = Wn
    for vi, b in rigid.items():
        W[vi] = {b: 1.0}
    worst = max(len(w) for w in W)
    for g in list(mesh.vertex_groups):
        mesh.vertex_groups.remove(g)
    for b in arm_ob.data.bones:
        mesh.vertex_groups.new(name=b.name)
    write_weights(mesh, W)
    used = {names_ for w in W for names_ in w}
    log('skin:', len(me.vertices), 'verts; influences before the limit up to', worst, '; body bones unused', [b.name for b in arm_ob.data.bones if b.name not in used and not b.name.startswith('mane')])
    return mesh


def skin_hair(arm_ob):
    hair = bpy.data.objects.get('horse_hair')
    if not hair:
        return
    bind(hair, arm_ob)
    me = hair.data
    kind, ht, hs = (me.attributes[n].data for n in ('hair_root', 'hair_t', 'hair_s'))
    sm = lambda x: max(0.0, min(1.0, x)) ** 2 * (3 - 2 * max(0.0, min(1.0, x)))
    W = []
    for v in me.vertices:
        k, t, s = round(kind[v.index].value), ht[v.index].value, hs[v.index].value
        w = {}
        if k == 0:      # mane: the neck bone under the root, then the mane bone over the free length
            f = max(0.0, min(4.0, (s - 0.12) / 0.19))      # 0 at the first mane bone .. 4 at the last
            i0 = min(3, int(f))
            fr = f - i0
            free = sm(t * 1.15) * 0.9
            for i, x in ((i0, 1 - fr), (i0 + 1, fr)):
                nk = f'neck{min(3, 1 + (i * 3) // 5)}'
                w[nk] = w.get(nk, 0) + x * (1 - free)
                w[f'mane{i + 1}'] = w.get(f'mane{i + 1}', 0) + x * free
        elif k == 1:    # forelock
            w['head'] = 1.0
        else:           # tail: down the tail's bones
            f = max(0.0, min(3.0, t * 3.4 - 0.2))
            i0 = min(2, int(f))
            fr = f - i0
            w[f'tail{i0 + 1}'] = 1 - fr
            w[f'tail{i0 + 2}'] = fr
        W.append({k_: x for k_, x in w.items() if x > 1e-4})
    write_weights(hair, W)
    log('hair skinned:', len(me.vertices), 'verts')


def volume_report(arm_ob, step=6):
    """the body's volume over the gallop's keys, relative to rest"""
    D = R.d
    mesh = bpy.data.objects['horse']
    dg = bpy.context.evaluated_depsgraph_get()
    def vol():
        dg.update()
        ev = mesh.evaluated_get(dg)
        bm = bmesh.new()
        bm.from_mesh(ev.to_mesh())
        v = bm.calc_volume(signed=True)
        bm.free()
        ev.to_mesh_clear()
        return abs(v)
    for pb in arm_ob.pose.bones:
        pb.matrix_basis.identity()
    bpy.context.view_layer.update()
    v0 = vol()
    lo, hi, klo, khi = 1e9, 0, 0, 0
    for k in range(0, D['keys']['n'], step):
        apply_pose(arm_ob, key_rot(D, k), D['keys']['chest'][k])
        bpy.context.view_layer.update()
        r = vol() / v0
        if r < lo: lo, klo = r, k
        if r > hi: hi, khi = r, k
    for pb in arm_ob.pose.bones:
        pb.matrix_basis.identity()
    bpy.context.view_layer.update()
    log(f'volume over the gallop: rest {v0:.4f} m^3; lowest {lo * 100:.1f}% (key {klo}), highest {hi * 100:.1f}% (key {khi})')
    return lo, hi


if globals().get('RUN', True):
    arm_ob = build_armature()
    skin_body(arm_ob)
    skin_hair(arm_ob)
    volume_report(arm_ob)
