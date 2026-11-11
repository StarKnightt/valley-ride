"""
rider_body.py - the rider herself: an adult woman, in the gallop seat on the horse.

Her body is the MakeHuman base mesh (through MPFB 2, the Blender extension; base mesh, shape targets, rig and weights
are CC0 - credit in refs/rider/README.md), shaped by its macro and detail targets: female, mid twenties, an athletic
rider's build. Nothing here is sculpted by hand or generated: every number is a target weight or a measurement.

  human   the base mesh with its targets, and MPFB's "game engine" rig and weights (standing, arms out)
  cut     her clothes from the base mesh's own bodysuit layer ("helper-tights": it follows the body's shape and
          carries the rig's weights): a fitted top, denim shorts, tall riding boots - each a shell lifted off the
          skin with a hem that stands off it; the skin they cover is removed; her eyes from the eye helpers
  pose    into the gallop seat (rlib.SEAT) on the horse at rest: pelvis, spine, legs round the barrel, arms to the
          reins, the fingers closed round them. Then the pose is frozen: it becomes her rest pose
  fit     her seat, thighs and calves pressed onto the saddle and the horse's side (flesh flattens where it bears)
  joints  her joints in that pose -> joints.json (rider_rig builds her skeleton on them)

The object is "rider" (materials: rider_skin, rider_cloth, rider_eye), still carrying MPFB's vertex groups;
rider_rig.skin_body maps them onto her own bones.

STAGES: human, cut, pose, fit, joints
"""
import bpy, bmesh, math, os, sys, json
from mathutils import Vector, Matrix, Quaternion
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else 'F:/valley-ride/tools/blender/rider')
import importlib, rlib
importlib.reload(rlib)
from rlib import log, SEAT, JFILE, inside, remove, activate, horse, horse_bvh, obj_from_bmesh

V = Vector
STAGES = globals().get('STAGES') or ['human', 'cut', 'pose', 'fit', 'joints']

# ----------------------------------------------------------------------------- who she is
MACRO = dict(gender=0.0, age=0.5, muscle=0.66, weight=0.40, proportions=0.80, height=0.55, cupsize=0.46, firmness=0.80)
RACE = {'asian': 0.0, 'caucasian': 1.0, 'african': 0.0}
# detail targets (MPFB's own names), weights 0..1
DETAILS = {
    'head-oval': 0.6, 'head-fat-decr': 0.2,
    'chin-jaw-drop-decr': 0.25, 'chin-width-decr': 0.45, 'chin-bones-decr': 0.25,
    'l-cheek-bones-incr': 0.35, 'r-cheek-bones-incr': 0.35, 'l-cheek-volume-decr': 0.3, 'r-cheek-volume-decr': 0.3,
    'nose-scale-horiz-decr': 0.4, 'nose-point-up': 0.25, 'nose-volume-decr': 0.3, 'nose-hump-decr': 0.3, 'nose-width3-decr': 0.3,
    'mouth-lowerlip-volume-decr': 0.08, 'mouth-upperlip-volume-incr': 0.1, 'mouth-angles-up': 0.5, 'mouth-scale-horiz-incr': 0.1,
    'l-eye-scale-incr': 0.1, 'r-eye-scale-incr': 0.1, 'l-eye-corner2-up': 0.2, 'r-eye-corner2-up': 0.2,
    'l-eye-height2-decr': 0.3, 'r-eye-height2-decr': 0.3,
    'eyebrows-angle-up': 0.2,
    'measure-waist-circ-decr': 0.3, 'stomach-tone-incr': 0.6, 'torso-vshape-decr': 0.2,
    'l-upperarm-shoulder-muscle-incr': 0.3, 'r-upperarm-shoulder-muscle-incr': 0.3,
    'l-upperleg-muscle-incr': 0.4, 'r-upperleg-muscle-incr': 0.4, 'l-lowerleg-muscle-incr': 0.35, 'r-lowerleg-muscle-incr': 0.35,
    'measure-neck-circ-decr': 0.7, 'neck-scale-horiz-decr': 0.4, 'neck-scale-depth-decr': 0.3, 'neck-double-decr': 0.5,
}

# her clothes, on the standing body
TOP, SHORTS, BOOTS = 1, 2, 3           # face layer 'part': 0 skin, 1.. clothes, 4 eye, 5 eyelashes
EYE, LASH = 4, 5
SLEEVE = 0.0                            # the top's sleeve along the upper arm (0: a tank top's armhole)
ARMHOLE = 0.072                         # (a tank top) the armhole: a tube of this radius round the arm
NECK_R = 0.098                          # the neckline: a sphere round a point in front of the neck's base
BACK_W = 0.058                          # half the width of the scoop at the back, between the straps
SHORTS_LEG = 0.30                       # the shorts' leg, as a share of the thigh
THICK = {TOP: 0.0028, SHORTS: 0.0036, BOOTS: 0.0050}
FLARE = {TOP: 0.004, SHORTS: 0.005, BOOTS: 0.003}
IRON_W, IRON_H = 0.122, 0.135           # the stirrup iron: inside width at the tread, height to the eye
MASKS = ('lips', 'scalp', 'ears', 'fingernails', 'nipple')
# Per vertex of a garment, on the standing body (rider_bake draws seams, pockets, ribs and creases from them at the
# texture's resolution): c_p which garment; c_e metres inside its nearest edge; c_w metres below the waistband's top
# (shorts), above the hem (top), above the sole (boots); c_s, c_c the sine and cosine of the angle round the trunk
# (or round the shin: boots), 0 = front; c_x metres left of the midline; c_h metres above the leg's hem (shorts),
# below the boot's top (boots)
CLOTH_FIELDS = ('c_p', 'c_e', 'c_w', 'c_s', 'c_c', 'c_x', 'c_h')


def mpfb():
    import addon_utils
    if not addon_utils.check('bl_ext.blender_org.mpfb')[1]:
        bpy.ops.preferences.addon_enable(module='bl_ext.blender_org.mpfb')
    from bl_ext.blender_org.mpfb.services.humanservice import HumanService
    from bl_ext.blender_org.mpfb.services.targetservice import TargetService
    return HumanService, TargetService


def human():
    HumanService, TargetService = mpfb()
    for n in ('Human', 'Human.rig'):
        remove(n)
    d = TargetService.get_default_macro_info_dict()
    d.update(MACRO)
    d['race'] = dict(RACE)
    b = HumanService.create_human(mask_helpers=False, detailed_helpers=True, extra_vertex_groups=True, feet_on_ground=True, scale=0.1, macro_detail_dict=d)
    for name, w in DETAILS.items():
        TargetService.load_target(b, TargetService.target_full_path(name), weight=w, name=name)
    rig = HumanService.add_builtin_rig(b, 'game_engine', import_weights=True)
    TargetService.bake_targets(b)
    b.name, rig.name = 'Human', 'Human.rig'
    log('human:', len(b.data.vertices), 'vertices,', f'{b.dimensions.z:.3f} m tall;', len(rig.data.bones), 'bones')
    return b, rig


# ----------------------------------------------------------------------------- clothes
def cut():
    src, rig = bpy.data.objects['Human'], bpy.data.objects['Human.rig']
    remove('rider')
    ob = src.copy()
    ob.data = src.data.copy()
    ob.name = ob.data.name = 'rider'
    bpy.context.scene.collection.objects.link(ob)
    for m in list(ob.modifiers):
        if m.type != 'ARMATURE':
            ob.modifiers.remove(m)
    ob.data.materials.clear()                             # (before the faces get their slots: clearing resets them)
    for n in ('rider_skin', 'rider_cloth', 'rider_eye', 'rider_lash'):
        ob.data.materials.append(bpy.data.materials.get(n) or bpy.data.materials.new(n))
    gname = {g.index: g.name for g in ob.vertex_groups}
    bone = {b.name: b for b in rig.data.bones}
    H = lambda n: bone[n].head_local
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.verts.layers.deform.verify()
    bm.faces.layers.int.new('part')
    bm.verts.layers.float.new('hemband')                # the top's lower edge: + front, - back, 0 elsewhere
    # (a new layer moves the others: the handles are taken once all exist)
    for n in MASKS:
        bm.verts.layers.float.new('m_' + n)               # the base mesh's own regions, kept for her textures
    for n in CLOTH_FIELDS:
        bm.verts.layers.float.new(n)                      # each garment's own coordinates, for its seams and weave
    dl, part, hem = bm.verts.layers.deform.active, bm.faces.layers.int['part'], bm.verts.layers.float['hemband']
    gidx = {g.name: g.index for g in ob.vertex_groups}
    for n in MASKS:
        lay = bm.verts.layers.float['m_' + n]
        for v in bm.verts:
            v[lay] = v[dl].get(gidx[n], 0.0)
    bm.verts.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    kind, dom = {}, {}
    for v in bm.verts:
        gs = {gname[i]: w for i, w in v[dl].items()}
        kind[v.index] = ('body' if 'body' in gs else 'tights' if 'helper-tights' in gs else 'eye' if ('helper-l-eye' in gs or 'helper-r-eye' in gs)
                         else 'lash' if any(n.startswith(('helper-l-eyelashes', 'helper-r-eyelashes')) for n in gs) else None)
        ws = [(w, n) for n, w in gs.items() if n in bone]
        dom[v.index] = max(ws)[1] if ws else None

    waist = H('spine_01').z + 0.045                       # the shorts' waistband's top
    top_hem = waist - 0.035                               # the top hangs over it
    boot_top = H('calf_l').z - 0.055                      # just under the knee
    neck_c = H('neck_01') + V((0, -0.075, 0.045))
    nape, nape_n = H('neck_01') + V((0, 0.05, -0.012)), V((0, -0.36, 0.93)).normalized()

    def along(p, a, b):
        return (p - H(a)).dot((H(b) - H(a)).normalized()) / (H(b) - H(a)).length

    # each garment: which bones' skin it may lie on, and how far inside its edge a point is (metres, + inside)
    def gate(part_, d, s):
        if part_ == BOOTS:
            return d in (f'calf_{s}', f'foot_{s}', f'ball_{s}')
        if part_ == SHORTS:
            return d in ('pelvis', 'spine_01', 'spine_02', f'thigh_{s}')
        return d in ('pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', f'clavicle_{s}', f'upperarm_{s}')

    def depth(part_, p, s):
        if part_ == BOOTS:
            return boot_top - p.z
        if part_ == SHORTS:
            return min(waist - p.z, (SHORTS_LEG - along(p, f'thigh_{s}', f'calf_{s}')) * (H(f'calf_{s}') - H(f'thigh_{s}')).length)
        # the neckline: a scoop in front (a sphere before the neck's base); behind, between the straps, a line
        # across the top of the shoulder blades (below a plane that falls forward from the nape). The straps
        # themselves run on over the shoulders either side of it
        g = min(p.z - top_hem, (p - neck_c).length - NECK_R, max((nape - p).dot(nape_n), abs(p.x) - BACK_W))
        a, b_ = H(f'upperarm_{s}'), H(f'lowerarm_{s}')
        if SLEEVE > 0:
            return min(g, (SLEEVE - along(p, f'upperarm_{s}', f'lowerarm_{s}')) * (b_ - a).length)
        # a tank top's armhole: where the trunk meets a tube round the arm
        u = (b_ - a).normalized()
        q = p - (a - u * 0.015)
        t = max(0.0, q.dot(u))
        return min(g, (q - u * t).length - ARMHOLE)

    side = lambda p: 'l' if p.x > 0 else 'r'
    shells = {TOP: [], SHORTS: [], BOOTS: []}
    kill = []
    for f in bm.faces:
        ks = {kind[v.index] for v in f.verts}
        c = f.calc_center_median()
        ds = [dom[v.index] for v in f.verts if dom[v.index]]
        d = max(ds, key=ds.count) if ds else None
        if ks == {'body'}:
            if any(all(gate(p, dom[v.index], side(v.co)) and depth(p, v.co, side(v.co)) > 0.022 for v in f.verts) for p in shells):
                kill.append(f)
        elif ks == {'tights'}:
            for p in shells:
                if gate(p, d, side(c)) and depth(p, c, side(c)) > 0:
                    shells[p].append(f)
            kill.append(f)
        elif ks == {'eye'}:
            f[part] = EYE
        elif ks == {'lash'}:
            f[part] = LASH
        else:
            kill.append(f)
    made = {}
    for p, fs in shells.items():
        ret = bmesh.ops.duplicate(bm, geom=fs)
        made[p] = [g for g in ret['geom'] if isinstance(g, bmesh.types.BMFace)]
        for f in made[p]:
            f[part] = p
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')

    # ---- each garment: finer, lifted off the skin, its surface evened (cloth bridges what the skin dips into), its
    # openings standing off the body with an edge of their own thickness
    for p in (TOP, SHORTS, BOOTS):
        fs = [f for f in bm.faces if f[part] == p]
        es = list({e for f in fs for e in f.edges})
        bmesh.ops.subdivide_edges(bm, edges=es, cuts=1, use_grid_fill=True, smooth=1.0)
        fs = [f for f in bm.faces if f[part] == p]
        vs = list({v for f in fs for v in f.verts})
        rim = [e for e in {e for f in fs for e in f.edges} if len(e.link_faces) == 1]
        rim_v = {v for e in rim for v in e.verts}
        rim_set = set(rim)
        # the edge is cut where the garment ends, not where the mesh's faces happened to: the rim slides onto it
        for _ in range(3):
            for v in rim_v:
                sd = side(v.co)
                g = depth(p, v.co, sd)
                h = 0.002
                gr = V(((depth(p, v.co + V((h, 0, 0)), sd) - depth(p, v.co - V((h, 0, 0)), sd)), (depth(p, v.co + V((0, h, 0)), sd) - depth(p, v.co - V((0, h, 0)), sd)),
                        (depth(p, v.co + V((0, 0, h)), sd) - depth(p, v.co - V((0, 0, h)), sd)))) / (2 * h)
                gr -= v.normal * gr.dot(v.normal)                # along the surface
                if gr.length > 0.2:
                    step = -g * gr / gr.length_squared
                    v.co += step if step.length < 0.02 else step.normalized() * 0.02
            for _ in range(2):
                new = {v: sum((e.other_vert(v).co for e in v.link_edges if e in rim_set), V()) / max(1, sum(e in rim_set for e in v.link_edges)) for v in rim_v}
                for v, c_ in new.items():
                    v.co = v.co.lerp(c_, 0.35)
        # ---- the garment's own coordinates (while it still lies on the standing body)
        fl = {n: bm.verts.layers.float[n] for n in CLOTH_FIELDS}
        low = min(v.co.z for v in vs)
        for v in vs:
            sd = side(v.co)
            sgn = 1 if sd == 'l' else -1
            v[fl['c_p']] = p
            v[fl['c_e']] = depth(p, v.co, sd)
            v[fl['c_x']] = v.co.x
            if p == BOOTS:
                ax_ = H(f'calf_{sd}')
                dx, dy = sgn * (v.co.x - ax_.x), -(v.co.y - ax_.y)
                v[fl['c_w']], v[fl['c_h']] = v.co.z - low, boot_top - v.co.z
            else:
                ax_ = H('spine_02' if p == TOP else 'pelvis')
                dx, dy = v.co.x, -(v.co.y - ax_.y)
                v[fl['c_w']] = (v.co.z - top_hem) if p == TOP else (waist - v.co.z)
                v[fl['c_h']] = (SHORTS_LEG - along(v.co, f'thigh_{sd}', f'calf_{sd}')) * (H(f'calf_{sd}') - H(f'thigh_{sd}')).length if p == SHORTS else 0.0
            r_ = math.hypot(dx, dy) or 1.0
            v[fl['c_s']], v[fl['c_c']] = dx / r_, dy / r_
        bm.normal_update()
        for v in vs:
            v.co += v.normal * THICK[p]
        inner = [v for v in vs if v not in rim_v]
        for _ in range({TOP: 4, SHORTS: 3, BOOTS: 2}[p]):
            bmesh.ops.smooth_vert(bm, verts=inner, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
        bm.normal_update()
        for v in inner:
            v.co += v.normal * THICK[p] * 0.5               # (what the evening took back)
        # the openings: the rim and the ring behind it stand off
        ring2 = {e.other_vert(v) for v in rim_v for e in v.link_edges} - rim_v
        for v in rim_v:
            v.co += v.normal * FLARE[p]
        for v in ring2:
            v.co += v.normal * FLARE[p] * 0.45
        if p == TOP:
            for v in vs:
                t = max(0.0, 1 - (v.co.z - top_hem) / 0.07)
                if t > 0:
                    v[hem] = t * (1 if v.co.y < H('spine_01').y - 0.02 else -1)
        # the edge's thickness: the rim turned in toward the skin
        bm.normal_update()
        nrm = {v: v.normal.copy() for v in rim_v}
        ret = bmesh.ops.extrude_edge_only(bm, edges=rim)
        for g in ret['geom']:
            if isinstance(g, bmesh.types.BMVert):
                # (a new vertex has no normal yet: its source on the rim, across the new side face, has)
                src_v = next(e.other_vert(g) for e in g.link_edges if e.other_vert(g) in nrm)
                for lay in fl.values():
                    g[lay] = src_v[lay]
                g.co -= nrm[src_v] * (THICK[p] + FLARE[p] + 0.0015)
            elif isinstance(g, bmesh.types.BMFace):
                g[part] = p
    # ---- the boots: a sole and a low heel under the foot
    sole_z = min(v.co.z for f in bm.faces if f[part] == BOOTS for v in f.verts)
    for s, sg in (('l', 1), ('r', -1)):
        heel_y, toe_y = H(f'foot_{s}').y + 0.045, H(f'ball_{s}').y - 0.07
        for v in {v for f in bm.faces if f[part] == BOOTS for v in f.verts if v.co.x * sg > 0}:
            low = max(0.0, 1 - (v.co.z - sole_z) / 0.022)
            if low > 0:
                t = (v.co.y - toe_y) / (heel_y - toe_y)        # 0 toe .. 1 heel
                v.co.z -= low * (0.008 + 0.014 * (1 if t > 0.68 else 0))
    bm.normal_update()
    for f in bm.faces:
        f.material_index = 0 if f[part] == 0 else 2 if f[part] == EYE else 3 if f[part] == LASH else 1
        f.smooth = True
    bm.to_mesh(ob.data)
    bm.free()
    tris = lambda mi: sum(len(p.vertices) - 2 for p in ob.data.polygons if p.material_index == mi)
    log(f'cut: skin {tris(0)} tris, clothes {tris(1)}, eyes {tris(2)}')
    return ob


# ----------------------------------------------------------------------------- the gallop seat
def upd():
    bpy.context.view_layer.update()


def set_rot(pb, R):
    """the bone's orientation in the rig's space (its head stays where its parents put it)"""
    M = R.to_4x4()
    M.translation = pb.matrix.translation
    pb.matrix = M
    upd()


def turn(pb, R):
    set_rot(pb, R @ pb.matrix.to_3x3())


def aim(pb, d):
    """the smallest turn that points the bone along d"""
    y = pb.matrix.to_3x3().col[1].normalized()
    turn(pb, y.rotation_difference(V(d).normalized()).to_matrix())


def twist_about(q, axis):
    """the part of rotation q that is a twist about axis"""
    axis = axis.normalized()
    v = V((q.x, q.y, q.z))
    t = Quaternion((q.w, *(axis * v.dot(axis))))
    return t.normalized() if t.magnitude > 1e-9 else Quaternion()


def RX(deg):
    return Matrix.Rotation(math.radians(deg), 3, 'X')


def pose():
    # (on a copy of the standing rig, "rider_bones": freezing the pose rewrites its rest)
    src, ob = bpy.data.objects['Human.rig'], bpy.data.objects['rider']
    remove('rider_bones')
    rig = src.copy()
    rig.data = src.data.copy()
    rig.name = rig.data.name = 'rider_bones'
    bpy.context.scene.collection.objects.link(rig)
    ob.parent = None
    for m in ob.modifiers:
        if m.type == 'ARMATURE':
            m.object = rig
    arm = bpy.data.objects['horse_rig']
    arm.data.pose_position = 'REST'
    P = rig.pose.bones
    for pb in P:
        pb.rotation_mode = 'QUATERNION'
        pb.matrix_basis = Matrix.Identity(4)
    upd()
    rest = {b.name: b.matrix_local.to_3x3() for b in rig.data.bones}
    rhead = {b.name: b.head_local.copy() for b in rig.data.bones}
    # ---- pelvis into the saddle, the trunk folded forward from the hips, the head carried up
    M = (RX(SEAT['pelvis_tilt']) @ rest['pelvis']).to_4x4()
    # (her hip centre a seated pelvis' height over the saddle's seat, wherever the saddle puts that)
    at = V(SEAT['pelvis'])
    tack = BVHTree.FromObject(bpy.data.objects['tack'], bpy.context.evaluated_depsgraph_get())
    top = tack.ray_cast(V((0, at.y, at.z + 0.3)), V((0, 0, -1)), 0.8)[0]
    if top is None:
        raise SystemExit('no saddle under her seat')
    at.z = top.z + SEAT['sit']
    M.translation = at
    P['pelvis'].matrix = M
    upd()
    for n, a in zip(('spine_01', 'spine_02', 'spine_03'), SEAT['spine']):
        turn(P[n], RX(a))
    turn(P['neck_01'], RX(SEAT['neck']))
    turn(P['head'], RX(SEAT['head']))
    for s, sg in (('l', 1), ('r', -1)):
        # ---- the leg: the knee out round the flap, the lower leg back along the horse's side, heel down
        hip = P[f'thigh_{s}'].head.copy()
        L = P[f'thigh_{s}'].length
        dx = SEAT['knee_out'] - abs(hip.x)
        side = math.sqrt(L * L - dx * dx)
        a = math.radians(SEAT['thigh_drop'])
        knee = hip + V((sg * dx, -math.cos(a) * side, -math.sin(a) * side))
        sh = V(SEAT['shin']).normalized()
        sh.x *= sg
        aim(P[f'thigh_{s}'], knee - hip)
        # the knee's hinge square to the leg's plane
        hinge = (P[f'thigh_{s}'].matrix.to_3x3() @ rest[f'thigh_{s}'].inverted()) @ V((1, 0, 0))
        n = (knee - hip).cross(sh).normalized()
        if n.dot(hinge) < 0:
            n = -n
        ax = (knee - hip).normalized()
        h2, n2 = (hinge - ax * hinge.dot(ax)).normalized(), (n - ax * n.dot(ax)).normalized()
        turn(P[f'thigh_{s}'], h2.rotation_difference(n2).to_matrix())
        aim(P[f'calf_{s}'], sh)
        want = Matrix.Rotation(math.radians(sg * SEAT['toe_out']), 3, 'Z') @ RX(-SEAT['heel_down']) @ rest[f'foot_{s}']
        q = (want @ P[f'foot_{s}'].matrix.to_3x3().inverted()).to_quaternion()
        turn(P[f'calf_{s}'], Quaternion().slerp(twist_about(q, sh), 0.5).to_matrix())
        set_rot(P[f'foot_{s}'], want)
        # ---- the arm to the rein: two bones to the wrist, the elbow hanging; the fist upright (thumb on top,
        # knuckles forward, a little in), the forearm sharing the hand's turn
        S = P[f'upperarm_{s}'].head.copy()
        W = V(SEAT['wrist'])
        W.x *= sg
        la, lb = P[f'upperarm_{s}'].length, P[f'lowerarm_{s}'].length
        dv = W - S
        d = min(dv.length, la + lb - 0.004)
        u = dv.normalized()
        x = (la * la - lb * lb + d * d) / (2 * d)
        hint = V(SEAT['elbow_hint'])
        hint.x *= sg
        pl = (hint - u * hint.dot(u)).normalized()
        E = S + u * x + pl * math.sqrt(max(0.0, la * la - x * x))
        aim(P[f'upperarm_{s}'], E - S)
        aim(P[f'lowerarm_{s}'], W - P[f'lowerarm_{s}'].head)
        def frame(f, a_):
            f = f.normalized()
            z = f.cross(a_).normalized()
            return Matrix((f, z.cross(f), z)).transposed()
        f0 = rhead[f'middle_01_{s}'] - rhead[f'hand_{s}']
        a0 = rhead[f'pinky_01_{s}'] - rhead[f'index_01_{s}']
        F0 = frame(f0, a0)
        Ft = frame(V((-sg * 0.22, -1.0, -0.18)), V((sg * 0.10, 0.10, -1.0)))
        want = Ft @ F0.inverted() @ rest[f'hand_{s}']
        q = (want @ P[f'hand_{s}'].matrix.to_3x3().inverted()).to_quaternion()
        fa = (W - P[f'lowerarm_{s}'].head).normalized()
        turn(P[f'lowerarm_{s}'], Quaternion().slerp(twist_about(q, fa), 0.7).to_matrix())
        set_rot(P[f'hand_{s}'], want)
        # ---- the fingers closed round the rein. They curl about the line of the knuckles, toward the palm (the
        # nails are on the other side)
        Rh = P[f'hand_{s}'].matrix.to_3x3() @ rest[f'hand_{s}'].inverted()
        ax = (Rh @ a0).normalized()
        z0 = f0.normalized().cross(a0.normalized())
        gi = ob.vertex_groups['fingernails'].index
        nails = [v.co for v in bpy.data.objects['Human'].data.vertices if v.co.x * sg > 0 and any(g.group == gi for g in v.groups)]
        dorsal = (sum(nails, V()) / len(nails) - (rhead[f'middle_03_{s}'] + rhead[f'ring_03_{s}']) / 2).dot(z0)
        sign = -1 if dorsal > 0 else 1                 # (turning the finger's line toward the palm side)
        for finger, curl in (('index', (56, 82, 48)), ('middle', (62, 86, 50)), ('ring', (66, 88, 50)), ('pinky', (70, 88, 50))):
            for i, c in enumerate(curl):
                turn(P[f'{finger}_0{i + 1}_{s}'], Matrix.Rotation(math.radians(sign * c), 3, ax))
        # the thumb down along the top of the fist, its tip on the index finger
        fw = (Rh @ f0).normalized()
        turn(P[f'thumb_01_{s}'], Matrix.Rotation(math.radians(-sign * 22), 3, ax))
        turn(P[f'thumb_01_{s}'], Matrix.Rotation(math.radians(sg * sign * 30), 3, fw))
        for i, c in ((2, 22), (3, 30)):
            pb = P[f'thumb_0{i}_{s}']
            bend = pb.matrix.to_3x3().col[1].cross(fw.cross(ax)).normalized()
            turn(pb, Matrix.Rotation(math.radians(c), 3, bend))
    # ---- frozen: the mesh takes the pose (joints kept round by a corrective smooth), the rig rests in it
    activate(ob)
    cs = ob.modifiers.new('cs', 'CORRECTIVE_SMOOTH')
    cs.rest_source = 'ORCO'
    cs.iterations = 12
    cs.factor = 0.6
    cs.smooth_type = 'LENGTH_WEIGHTED'
    cs.use_pin_boundary = True
    # (not the hands: a closed fist's fingers are sharp folds, and smoothing them makes them boneless)
    grp = ob.vertex_groups.new(name='cs')
    hand = {g.index for g in ob.vertex_groups if g.name.startswith(('hand_', 'thumb_', 'index_', 'middle_', 'ring_', 'pinky_'))}
    for v in ob.data.vertices:
        w = sum(g.weight for g in v.groups if g.group in hand)
        grp.add([v.index], max(0.0, 1.0 - 2.5 * w), 'REPLACE')
    cs.vertex_group = 'cs'
    for m in list(ob.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)
    activate(rig)
    bpy.ops.object.mode_set(mode='POSE')
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    m = ob.modifiers.new('rig', 'ARMATURE')
    m.object = rig
    log('posed into the gallop seat; hip centre', tuple(round(c, 3) for c in rig.data.bones['pelvis'].head_local))


# ----------------------------------------------------------------------------- pressed onto the saddle and the horse
def press_out(bm, standoff):
    """where her surface is inside the horse or the tack it goes outward from the barrel's axis (off the horse, out
    over the flap) until it is out, plus standoff - flesh and cloth flattened where they bear; the neighbours follow
    a little so the contact is a flattened patch, not a crease"""
    arm = bpy.data.objects['horse_rig']
    was = arm.data.pose_position
    arm.data.pose_position = 'REST'
    bpy.context.view_layer.update()
    fit = [BVHTree.FromObject(bpy.data.objects['tack'], bpy.context.evaluated_depsgraph_get()), horse_bvh()]
    arm.data.pose_position = was
    bpy.context.view_layer.update()
    tack_t = fit[0]
    moved, deepest = 0, 0.0
    disp = {}
    for v in bm.verts:
        if v.co.z > 1.95 or not any(t.find_nearest(v.co, 0.07)[0] is not None for t in fit):
            continue
        out = V((v.co.x, 0.0, v.co.z - 1.33)).normalized()
        def bad(p):
            if any(inside(t, p) for t in fit):
                return True
            # under a layer of the tack (between the flap and the horse): the leg belongs outside the flap
            return p.z < 1.68 and tack_t.ray_cast(p, out, 0.05)[0] is not None
        if not bad(v.co):
            continue
        p = v.co.copy()
        for k in range(40):
            p = p + out * 0.003
            if not bad(p):
                break
        p = p + out * standoff
        disp[v.index] = p - v.co
        deepest = max(deepest, (p - v.co).length)
        v.co = p
        moved += 1
    bm.verts.ensure_lookup_table()
    for _ in range(3):
        add = {}
        for v in bm.verts:
            if v.index in disp:
                continue
            ds = [disp[e.other_vert(v).index] for e in v.link_edges if e.other_vert(v).index in disp]
            if ds:
                add[v.index] = sum(ds, V()) / len(v.link_edges) * 0.6
        for i, d in add.items():
            bm.verts[i].co += d
            disp[i] = d
    return moved, deepest


def fit():
    ob = bpy.data.objects['rider']
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.verts.ensure_lookup_table()
    n, deep = press_out(bm, 0.003)
    bm.normal_update()
    bm.to_mesh(ob.data)
    bm.free()
    log(f'fit: {n} vertices pressed out of the horse and the saddle, the deepest by {deep * 1000:.0f} mm')


# ----------------------------------------------------------------------------- her joints
def joints():
    rig, ob = bpy.data.objects['rider_bones'], bpy.data.objects['rider']
    B = rig.data.bones
    H, T = (lambda n: B[n].head_local.copy()), (lambda n: B[n].tail_local.copy())
    dg = bpy.context.evaluated_depsgraph_get()
    tree = BVHTree.FromObject(ob, dg)
    arm = bpy.data.objects['horse_rig']
    arm.data.pose_position = 'REST'
    bpy.context.view_layer.update()
    tack = BVHTree.FromObject(bpy.data.objects['tack'], bpy.context.evaluated_depsgraph_get())
    J = {}
    hips = H('pelvis')
    seat_hit = tack.ray_cast(V((0, hips.y, hips.z)), V((0, 0, -1)), 0.4)[0]
    J['seat'] = V((0, hips.y, seat_hit.z if seat_hit else hips.z - 0.09))
    J['hips'], J['spine1'], J['spine2'], J['chest'] = hips, H('spine_01'), H('spine_02'), H('spine_03')
    J['neck'], J['head'] = H('neck_01'), H('head')
    up = (T('head') - H('head')).normalized()
    top = max((v.co for v in ob.data.vertices), key=lambda c: (c - H('head')).dot(up))
    J['crown'] = H('head') + up * (top - H('head')).dot(up)
    # the ponytail's tie: on the scalp at the back of the crown
    back = V((0, 1, 0))
    back = (back - up * back.dot(up)).normalized()
    c = H('head') + up * 0.105 + back * 0.012
    d = (back * 0.96 + up * 0.28).normalized()
    hit = tree.ray_cast(c + d * 0.4, -d, 0.6)[0]
    if hit is None:
        raise SystemExit('no scalp behind the crown: the head is not where the rig says')
    J['tie'] = hit + d * 0.014
    J['skull'] = c
    for s, S in (('l', 'L'),):
        J[f'clav.{S}'], J[f'shoulder.{S}'], J[f'elbow.{S}'], J[f'wrist.{S}'] = H(f'clavicle_{s}'), H(f'upperarm_{s}'), H(f'lowerarm_{s}'), H(f'hand_{s}')
        J[f'knuckle.{S}'] = H(f'middle_01_{s}')
        # where the rein lies in the closed fist: between the palm and the curled fingers
        J[f'grip.{S}'] = (H(f'middle_01_{s}') + H(f'ring_01_{s}') + T(f'middle_02_{s}') + T(f'ring_02_{s}')) / 4
        J[f'hip.{S}'], J[f'knee.{S}'], J[f'ankle.{S}'], J[f'ball.{S}'], J[f'toe.{S}'] = H(f'thigh_{s}'), H(f'calf_{s}'), H(f'foot_{s}'), H(f'ball_{s}'), T(f'ball_{s}')
        # the sole under the ball of the foot (the iron's tread bears there), and the heel's corner
        fw = (T(f'ball_{s}') - H(f'foot_{s}'))
        sole_n = (B[f'foot_{s}'].matrix_local.to_3x3() @ V((0, 0, 1)))
        dn = V((0, 0, -1))
        dn = (dn - fw.normalized() * dn.dot(fw.normalized())).normalized()
        hit = tree.ray_cast(H(f'ball_{s}') + dn * 0.2, -dn, 0.3)[0]
        J[f'tread.{S}'] = hit + dn * 0.004
        heel0 = H(f'foot_{s}') - fw.normalized() * 0.04
        hit = tree.ray_cast(heel0 + dn * 0.25, -dn, 0.4)[0]
        J[f'heel.{S}'] = hit
        # the stirrup bar: under the saddle's skirt at SEAT['bar'], on the saddle wherever that is (the leather
        # comes out from under the seat's edge, it does not stand above it)
        bar = V(SEAT['bar'])
        hit_ = tack.ray_cast(V((bar.x, bar.y, bar.z + 0.4)), V((0, 0, -1)), 0.8)[0]
        J[f'bar.{S}'] = V((bar.x, bar.y, hit_.z - 0.012)) if hit_ is not None else bar
        # the iron stands on the sole: its eye (where the leather ends) above the tread, square to the foot
        across = fw.cross(dn).normalized()
        J[f'eye.{S}'] = J[f'tread.{S}'] - dn * IRON_H
        J[f'iron_x.{S}'] = J[f'tread.{S}'] + across * (IRON_W / 2)      # (one end of the tread: the iron's width axis)
    # the top's hem, front and back: a short bone each, down to the edge
    hb = ob.data.attributes['hemband'].data
    for name, sign in (('hemF', 1), ('hemB', -1)):
        edge = [v.co for v in ob.data.vertices if hb[v.index].value * sign > 0.8 and abs(v.co.x) < 0.07]
        above = [v.co for v in ob.data.vertices if 0.05 < hb[v.index].value * sign < 0.3 and abs(v.co.x) < 0.07]
        J[f'{name}.b'] = sum(edge, V()) / len(edge)
        J[f'{name}.a'] = sum(above, V()) / len(above)
        for k in ('a', 'b'):
            J[f'{name}.{k}'].x = 0
    for k in list(J):
        if k.endswith('.L'):
            J[k[:-2] + '.R'] = V((-J[k].x, J[k].y, J[k].z))
    json.dump({k: [round(c, 5) for c in v] for k, v in J.items()}, open(JFILE, 'w', encoding='utf8'), indent=1)
    sit = (J['crown'] - J['seat']).length
    log(f'joints: {len(J)} -> {os.path.basename(JFILE)}; seat to crown {sit:.3f} m, thigh {(J["knee.L"] - J["hip.L"]).length:.3f}, shin {(J["ankle.L"] - J["knee.L"]).length:.3f}, '
        f'upper arm {(J["elbow.L"] - J["shoulder.L"]).length:.3f}, forearm {(J["wrist.L"] - J["elbow.L"]).length:.3f}')
    return J


# ----------------------------------------------------------------------------- the stirrup leathers and irons
def build_leathers():
    """each leather from its bar under the saddle's skirt down the flap (her leg lies over it) to the iron's eye; the
    iron a steel arch standing on her boot's sole, its tread under the ball of her foot (refs/rider: boots-*,
    modern-gallop-side-01)"""
    Jn = rlib.load_joints()
    remove('leathers')
    bm = bmesh.new()
    mats = {}
    def tube(pts, w, th, mat, closed=False):
        """a strap or bar along pts: half-width w across (in the plane the path turns in), half-thickness th"""
        rings = []
        n = len(pts)
        for i, p in enumerate(pts):
            a, b = pts[(i - 1) % n if closed else max(0, i - 1)], pts[(i + 1) % n if closed else min(n - 1, i + 1)]
            t = (b - a).normalized()
            s_ = t.cross(tube.flat).normalized()
            f_ = t.cross(s_).normalized()
            rings.append([bm.verts.new(p + s_ * (w * x) + f_ * (th * y)) for x, y in ((-1, -0.6), (-0.6, -1), (0.6, -1), (1, -0.6), (1, 0.6), (0.6, 1), (-0.6, 1), (-1, 0.6))])
        pairs = list(zip(rings, rings[1:])) + ([(rings[-1], rings[0])] if closed else [])
        for a, b in pairs:
            for k in range(8):
                f = bm.faces.new((a[k], a[(k + 1) % 8], b[(k + 1) % 8], b[k]))
                f.material_index = mat
        if not closed:
            bm.faces.new(list(reversed(rings[0]))).material_index = mat
            bm.faces.new(rings[-1]).material_index = mat
    arm = bpy.data.objects['horse_rig']
    arm.data.pose_position = 'REST'
    bpy.context.view_layer.update()
    tack = BVHTree.FromObject(bpy.data.objects['tack'], bpy.context.evaluated_depsgraph_get())
    skin_ = horse_bvh()
    for S, sg in (('L', 1), ('R', -1)):
        bar, eye, tread, end = Jn[f'bar.{S}'], Jn[f'eye.{S}'], Jn[f'tread.{S}'], Jn[f'iron_x.{S}']
        ax = (end - tread).normalized()                      # across the foot
        up = (eye - tread).normalized()
        fw = ax.cross(up).normalized()
        # ---- the leather: on the flap's surface down to its lower edge, then free to the eye
        pts = []
        for k in range(14):
            q = bar.lerp(eye, k / 13)
            # it lies on whatever is under it: the flap, and below the flap the horse's own side (it showed as
            # missing: it ran inside the barrel)
            for tree_, off in ((tack, 0.004), (skin_, 0.007)):
                hit = tree_.ray_cast(V((sg * 0.7, q.y, q.z)), V((-sg, 0, 0)), 0.8)[0]
                if hit is not None and abs(hit.x) + off > abs(q.x):
                    q = V((hit.x + sg * off, q.y, q.z))
            pts.append(q)
        tube.flat = V((sg, 0, 0))
        tube(pts, 0.015, 0.003, 0)
        # ---- the iron: the arch (a flattened steel bar) from one end of the tread over the foot to the other, a
        # small loop for the leather at its top, the tread a plate with a pad
        hw = IRON_W / 2
        arch = []
        for k in range(21):
            a = math.pi * k / 20
            # straight sides for the lower half, a round top
            x = -math.cos(a)
            y = math.sin(a) ** 0.55
            arch.append(tread + ax * (hw * (x if abs(x) < 0.999 else math.copysign(1, x)) * (0.82 + 0.18 * (1 - y))) + up * (IRON_H * 0.93 * y))
        tube.flat = fw
        tube(arch, 0.0075, 0.013, 1)
        loop = [eye + ax * (0.016 * math.cos(a)) + up * (0.010 * math.sin(a) - 0.004) for a in (2 * math.pi * k / 10 for k in range(10))]
        tube(loop, 0.0028, 0.006, 1, closed=True)
        tube.flat = up
        tube([tread - ax * (hw + 0.006), tread + ax * (hw + 0.006)], 0.030, 0.006, 1)
        tube([tread - ax * (hw - 0.012) + up * 0.004, tread + ax * (hw - 0.012) + up * 0.004], 0.022, 0.003, 0)   # the tread's pad
    uvl = bm.loops.layers.uv.new('UVMap')              # (plain leather: the middle of the tack texture's leather panel)
    for f in bm.faces:
        for lp in f.loops:
            lp[uvl].uv = (0.75, 0.5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = obj_from_bmesh(bm, 'leathers')
    for n in ('tack_leather', 'tack_metal'):
        ob.data.materials.append(bpy.data.materials.get(n) or bpy.data.materials.new(n))
    for p in ob.data.polygons:
        p.use_smooth = False
    log('leathers and irons:', len(ob.data.polygons), 'faces')
    return ob


if __name__ == '__main__':
    horse()
    if 'human' in STAGES:
        human()
    if 'cut' in STAGES:
        cut()
    if 'pose' in STAGES:
        pose()
    if 'fit' in STAGES:
        fit()
    if 'joints' in STAGES:
        joints()
        build_leathers()
