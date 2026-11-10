"""
horse_mesh.py - the horse's surface, built around the rest skeleton of gallop.design.json.

Stages (set STAGES before exec, or pass after `--`): parts, high, low
  parts: closed shells lofted along the skeleton: trunk, neck, head, four legs, muscle masses, ears, eyes, mane,
         forelock, tail. Collection "horse_parts".
  high:  the union of the shells as one watertight surface (voxel remesh on the joined shells), lightly smoothed,
         with a colour attribute for the coat, points, hooves, mane, tail and eyes. Object "horse_high".
  low:   the game mesh: horse_high decimated to the triangle budget, mirrored cleanly, unwrapped. Object "horse".

Voxel remeshing and decimation run on the CPU (OpenVDB / BMesh have no GPU path); they take seconds.
"""
import bpy, bmesh, math, sys, os
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else 'F:/valley-ride/tools/blender/horse')
import importlib, hlib
importlib.reload(hlib)
from hlib import S, Rest, lerp, perp, log, design, obj_from_bmesh, collection, remove, activate

TRI_BUDGET = 14000
STAGES = globals().get('STAGES') or (sys.argv[sys.argv.index('--') + 1].split(',') if '--' in sys.argv else ['parts', 'high', 'low'])
R = Rest(design())


# ----------------------------------------------------------------------------- lofting
def ring(bm, c, u, v, n=20, p=1.0):
    """n verts on a superellipse centred at c with half axes u, v (Blender vectors); p < 1 squares it off"""
    out = []
    for i in range(n):
        t = 2 * math.pi * i / n
        cu, sv = math.cos(t), math.sin(t)
        a = math.copysign(abs(cu) ** p, cu)
        b = math.copysign(abs(sv) ** p, sv)
        out.append(bm.verts.new(c + u * a + v * b))
    return out


def skin(bm, rings, cap0=True, cap1=True):
    n = len(rings[0])
    for a, b in zip(rings, rings[1:]):
        for i in range(n):
            bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
    if cap0:
        bm.faces.new(list(reversed(rings[0])))
    if cap1:
        bm.faces.new(rings[-1])


def finish(bm, name, coll):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return obj_from_bmesh(bm, name, coll)


def tube(name, coll, stations, n=18, p=1.0):
    """stations: (side-view centre, lateral offset, half fore-aft, half lateral[, side-view axis]); rings stand
    across the path (or across the given axis)"""
    bm = bmesh.new()
    rings = []
    for i, st in enumerate(stations):
        c, lat, a, b = st[0], st[1], st[2], st[3]
        if len(st) > 4 and st[4] is not None:
            ax = Vector(st[4]).normalized()
        else:
            p0 = stations[max(0, i - 1)][0]
            p1 = stations[min(len(stations) - 1, i + 1)][0]
            ax = (Vector(p1) - Vector(p0)).normalized()
        across = perp(ax)
        rings.append(ring(bm, S(c, lat), Vector((1, 0, 0)) * b, S(across) * a, n, p))
    skin(bm, rings)
    return finish(bm, name, coll)


def ellipsoid(name, coll, c, lat, axis, ra, rb, rl, seg=20, rings_=12):
    """centre (side view), lateral offset, the long axis (side view), radii along it, across it, and lateral"""
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings_, radius=1.0)
    ax = Vector(axis).normalized()
    ex, ey, el = S(ax), S(perp(ax)), Vector((1, 0, 0))
    M = Matrix((ex * ra, ey * rb, el * rl)).transposed().to_4x4()
    M.translation = S(c, lat)
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
    return finish(bm, name, coll)


def resample(rows, n):
    """Catmull-Rom through rows of numbers (the first column is the running position), n rows out"""
    out = []
    m = len(rows)
    for k in range(n):
        t = k / (n - 1) * (m - 1)
        i = min(m - 2, int(t))
        f = t - i
        p0, p1, p2, p3 = rows[max(0, i - 1)], rows[i], rows[i + 1], rows[min(m - 1, i + 2)]
        out.append(tuple(0.5 * ((2 * b) + (-a + c) * f + (2 * a - 5 * b + 4 * c - d) * f * f + (-a + 3 * b - 3 * c + d) * f ** 3) for a, b, c, d in zip(p0, p1, p2, p3)))
    return out


# ----------------------------------------------------------------------------- the parts
def build_parts():
    coll = collection('horse_parts', fresh=True)
    V = Vector
    chest0 = R.head('chest') + V((0.2, 0.32))           # the chest frame's origin (the withers' base)
    j3 = R.head('pelvis')
    girth, withers, croup, buttock = R.mk('girth'), R.mk('withers'), R.mk('croup'), R.mk('buttock')
    gb = girth[1] - chest0[1] - 0.02                     # the sternum line
    top_w = withers[1] - chest0[1]
    top_c = croup[1] - j3[1]
    rear = buttock[0] - j3[0]

    # --- trunk: sections across the body from the breast to the buttocks: (x, top, bottom, half width, how high the
    # widest point sits 0..1). Deep through the girth, tucked up at the flank, round over the quarters.
    mid = lerp(chest0, j3, 0.5)
    cy, py = chest0[1], j3[1]
    T = [
        (chest0[0] + 0.335, cy - 0.33, cy - 0.5, 0.05, 0.5),
        (chest0[0] + 0.31, cy - 0.22, cy + gb + 0.13, 0.13, 0.5),
        (chest0[0] + 0.24, cy - 0.1, cy + gb + 0.05, 0.19, 0.5),
        (chest0[0] + 0.12, cy + top_w - 0.05, cy + gb + 0.01, 0.225, 0.48),
        (chest0[0] + 0.0, cy + top_w + 0.004, cy + gb, 0.245, 0.45),
        (chest0[0] - 0.16, cy + top_w - 0.03, cy + gb - 0.004, 0.268, 0.43),
        (chest0[0] - 0.36, cy + top_w - 0.085, cy + gb + 0.01, 0.288, 0.42),
        (mid[0], lerp(cy + top_w - 0.105, py + top_c - 0.07, 0.5), cy + gb + 0.045, 0.292, 0.43),
        (j3[0] + 0.33, py + top_c - 0.075, py - 0.565, 0.278, 0.46),
        (j3[0] + 0.14, py + top_c - 0.035, py - 0.5, 0.268, 0.52),
        (croup[0] + 0.02, py + top_c + 0.004, py - 0.45, 0.275, 0.55),
        (lerp(croup[0], j3[0] + rear, 0.45), py + top_c - 0.035, py - 0.45, 0.265, 0.55),
        (lerp(croup[0], j3[0] + rear, 0.8), py + top_c - 0.12, py - 0.45, 0.225, 0.52),
        (j3[0] + rear - 0.01, py + top_c - 0.24, py - 0.43, 0.15, 0.5),
        (j3[0] + rear - 0.05, py + top_c - 0.33, py - 0.4, 0.06, 0.5),
    ]
    bm = bmesh.new()
    rings = []
    for x, top, bot, hw, wz in resample(T, 44):
        zc = lerp(bot, top, wz)
        r = []
        n = 32
        for i in range(n):
            t = 2 * math.pi * i / n
            cu, sv = math.cos(t), math.sin(t)
            a = math.copysign(abs(cu) ** 0.9, cu)
            b = math.copysign(abs(sv) ** 0.9, sv)
            # the top is narrower than the belly: the back's ridge
            w = hw * (0.8 + 0.2 * (1.0 - sv) ** 0.7) if sv > 0 else hw
            r.append(bm.verts.new(Vector((w * a, -x, zc + (top - zc if sv > 0 else zc - bot) * b))))
        rings.append(r)
    skin(bm, list(reversed(rings)))
    finish(bm, 'trunk', coll)

    # --- neck: between a crest line and an underline, withers to poll
    atlas, hd = R.head('head'), (R.tail('head') - R.head('head')).normalized()
    hu = perp(hd)
    top0, top1 = chest0 + V((0.05, top_w - 0.005)), atlas + hd * -0.02 + hu * 0.07
    bot0, bot1 = chest0 + V((0.33, -0.45)), atlas + hd * 0.07 + hu * -0.175
    crest = lambda t: lerp(top0, top1, t) + perp((top1 - top0).normalized()) * (0.045 * math.sin(math.pi * min(1, max(0, t))) ** 1.2)
    under = lambda t: lerp(bot0, bot1, t) + perp((bot1 - bot0).normalized()) * (0.03 * math.sin(math.pi * min(1, max(0, t))))
    bm = bmesh.new()
    rings = []
    for t in [-0.12 + 1.16 * k / 23 for k in range(24)]:
        a, b = crest(t), under(t)
        c, half = (a + b) / 2, (a - b) / 2
        hw = lerp(0.2, 0.082, min(1, max(0, t)) ** 0.7)
        r = []
        n = 22
        for i in range(n):
            ang = 2 * math.pi * i / n
            cu, sv = math.cos(ang), math.sin(ang)
            # narrow along the crest, full low down
            w = hw * (0.62 + 0.38 * (1 - max(0, sv)) ** 0.8)
            r.append(bm.verts.new(S(c + half * sv, w * cu)))
        rings.append(r)
    skin(bm, rings)
    finish(bm, 'neck', coll)

    # --- head: sections along the head bone (x towards the muzzle, y towards the forehead)
    k = (R.tail('head') - R.head('head')).length / 0.6
    Hs = [(-0.07, 0.03, -0.1, 0.045), (-0.02, 0.07, -0.16, 0.08), (0.05, 0.088, -0.2, 0.1), (0.13, 0.092, -0.21, 0.107), (0.22, 0.083, -0.185, 0.098),
          (0.32, 0.068, -0.14, 0.078), (0.42, 0.056, -0.11, 0.064), (0.5, 0.05, -0.105, 0.064), (0.56, 0.043, -0.1, 0.064), (0.6, 0.02, -0.085, 0.052), (0.622, -0.01, -0.06, 0.03)]
    Hs = resample(Hs, 26)
    bm = bmesh.new()
    rings = []
    for x, top, bot, hw in Hs:
        c = atlas + hd * (x * k) + hu * ((top + bot) / 2)
        r = []
        n = 20
        for i in range(n):
            ang = 2 * math.pi * i / n
            cu, sv = math.cos(ang), math.sin(ang)
            a = math.copysign(abs(cu) ** 0.8, cu)
            b = math.copysign(abs(sv) ** 0.8, sv)
            w = hw * (0.8 + 0.2 * (1 - max(0, sv)))
            r.append(bm.verts.new(S(c + hu * ((top - bot) / 2 * b), w * a)))
        rings.append(r)
    skin(bm, rings)
    finish(bm, 'head', coll)
    for sg, sd in ((1, 'L'), (-1, 'R')):
        # ears: cones leaning out and a little forward; eyes: slight bulges; jowls
        base = atlas + hd * 0.005 + hu * 0.07
        tip = base + hu * 0.165 + hd * -0.01
        bm = bmesh.new()
        r0 = ring(bm, S(base, sg * 0.058), Vector((1, 0, 0)) * 0.034, S(hd) * 0.04, 12)
        r1 = ring(bm, S(lerp(base, tip, 0.55), sg * 0.075), Vector((1, 0, 0)) * 0.026, S(hd) * 0.034, 12)
        r2 = ring(bm, S(tip, sg * 0.085), Vector((1, 0, 0)) * 0.004, S(hd) * 0.006, 12)
        skin(bm, [r0, r1, r2])
        finish(bm, f'ear.{sd}', coll)
        ellipsoid(f'eye.{sd}', coll, atlas + hd * 0.125 * k + hu * 0.028, sg * 0.089, hd, 0.03, 0.024, 0.02, 14, 10)
        ellipsoid(f'jowl.{sd}', coll, atlas + hd * 0.11 * k + hu * -0.1, sg * 0.055, hd, 0.11, 0.095, 0.05, 14, 10)

    # --- legs
    def fore(sd, sg):
        sh, el, kn, fe, co, toe = R.head(f'humerus.{sd}'), R.head(f'radius.{sd}'), R.head(f'cannonF.{sd}'), R.head(f'pasternF.{sd}'), R.head(f'hoofF.{sd}'), R.tail(f'hoofF.{sd}')
        up = V((0, 1))
        st = [
            (lerp(el, sh, 0.45) + V((0.02, 0)), sg * 0.165, 0.125, 0.082),
            (el + V((0.03, 0.0)), sg * 0.162, 0.105, 0.072),
            (lerp(el, kn, 0.22) + V((0.015, 0)), sg * 0.156, 0.083, 0.06),
            (lerp(el, kn, 0.55), sg * 0.146, 0.062, 0.049),
            (lerp(el, kn, 0.85), sg * 0.138, 0.049, 0.043),
            (kn + V((0.004, 0)), sg * 0.135, 0.054, 0.049),
            (lerp(kn, fe, 0.2), sg * 0.134, 0.042, 0.04),
            (lerp(kn, fe, 0.5), sg * 0.132, 0.033, 0.03),
            (lerp(kn, fe, 0.85), sg * 0.13, 0.036, 0.033),
            (fe + V((0.0, 0.0)), sg * 0.13, 0.047, 0.041),
            (lerp(fe, co, 0.6), sg * 0.13, 0.037, 0.036),
            (V((toe[0] - 0.062, 0.078)), sg * 0.13, 0.051, 0.05, (0.25, -1)),
            (V((toe[0] - 0.064, 0.03)), sg * 0.13, 0.062, 0.057, (0, -1)),
            (V((toe[0] - 0.066, 0.0)), sg * 0.13, 0.066, 0.06, (0, -1)),
        ]
        tube(f'fore.{sd}', coll, st)
        scap = R.head(f'scapula.{sd}')
        ellipsoid(f'shoulder.{sd}', coll, lerp(scap, sh, 0.55), sg * 0.15, sh - scap, 0.3, 0.17, 0.075)
        ellipsoid(f'arm.{sd}', coll, lerp(sh, el, 0.5) + V((-0.05, 0.02)), sg * 0.155, el - sh, 0.23, 0.15, 0.08)
        ellipsoid(f'breast.{sd}', coll, sh + V((0.0, -0.05)), sg * 0.065, V((0.25, -1)), 0.16, 0.085, 0.085)

    def hind(sd, sg):
        hp, sf, hk, fe, co, toe = R.head(f'femur.{sd}'), R.head(f'tibia.{sd}'), R.head(f'cannonH.{sd}'), R.head(f'pasternH.{sd}'), R.head(f'hoofH.{sd}'), R.tail(f'hoofH.{sd}')
        back = perp((hk - sf).normalized()) * -1 if (hk - sf)[1] < 0 else perp((hk - sf).normalized())
        st = [
            (lerp(hp, sf, 0.45), sg * 0.17, 0.13, 0.085),
            (lerp(hp, sf, 0.75), sg * 0.19, 0.14, 0.09),
            (sf + V((-0.035, -0.01)), sg * 0.195, 0.125, 0.085),
            (lerp(sf, hk, 0.3) + V((-0.012, 0)), sg * 0.187, 0.097, 0.067),
            (lerp(sf, hk, 0.65), sg * 0.175, 0.066, 0.05),
            (lerp(sf, hk, 0.9) + V((0.005, 0)), sg * 0.167, 0.054, 0.043),
            (hk + V((0.016, -0.012)), sg * 0.165, 0.062, 0.046),
            (lerp(hk, fe, 0.18) + V((0.006, 0)), sg * 0.162, 0.044, 0.037),
            (lerp(hk, fe, 0.5), sg * 0.157, 0.035, 0.031),
            (lerp(hk, fe, 0.85), sg * 0.152, 0.037, 0.033),
            (fe, sg * 0.15, 0.048, 0.041),
            (lerp(fe, co, 0.6), sg * 0.15, 0.038, 0.036),
            (V((toe[0] - 0.06, 0.078)), sg * 0.15, 0.05, 0.049, (0.3, -1)),
            (V((toe[0] - 0.062, 0.03)), sg * 0.15, 0.06, 0.055, (0, -1)),
            (V((toe[0] - 0.064, 0.0)), sg * 0.15, 0.064, 0.058, (0, -1)),
        ]
        tube(f'hind.{sd}', coll, st)
        ellipsoid(f'haunch.{sd}', coll, lerp(hp, sf, 0.4) + V((-0.06, 0.05)), sg * 0.16, sf - hp + V((-0.1, 0)), 0.37, 0.28, 0.13)
        ellipsoid(f'gaskin.{sd}', coll, lerp(sf, hk, 0.28) + V((-0.02, 0)), sg * 0.185, hk - sf, 0.24, 0.105, 0.072)

    for sg, sd in ((1, 'L'), (-1, 'R')):
        fore(sd, sg)
        hind(sd, sg)

    # --- mane (a slab down the off side of the neck), forelock, tail
    bm = bmesh.new()
    rings = []
    for t in (0.03, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1.0):
        c = crest(t)
        n_ = perp((crest(min(1.02, t + 0.05)) - crest(max(0, t - 0.05))).normalized())
        hang = 0.085 + 0.07 * math.sin(math.pi * t) ** 0.7
        hwn = lerp(0.17, 0.068, t ** 0.8) * 0.62
        r = []
        for i in range(12):
            ang = 2 * math.pi * i / 12
            r.append(bm.verts.new(S(c + n_ * (0.022 - hang + hang * math.sin(ang) * 1.0), -hwn * 0.55 - 0.012 - 0.03 * (1 - math.sin(ang)) * 0.5 + 0.016 * math.cos(ang))))
        rings.append(r)
    skin(bm, rings)
    finish(bm, 'mane', coll)
    ellipsoid('forelock', coll, atlas + hd * 0.05 + hu * 0.088, -0.01, hd, 0.085, 0.022, 0.04, 14, 8)
    t0 = V((j3[0] + rear - 0.0, j3[1] + top_c - 0.2))
    pts = [t0 + V((0.06, 0.03)), t0 + V((-0.07, -0.02)), t0 + V((-0.2, -0.14)), t0 + V((-0.27, -0.38)), t0 + V((-0.29, -0.66)), t0 + V((-0.3, -0.88))]
    rad = [0.04, 0.047, 0.062, 0.07, 0.052, 0.015]
    tube('tail', coll, [(p, 0.0, r, r * 0.92) for p, r in zip(pts, rad)], n=14)
    log('parts:', len(coll.objects))
    return {'tail': [list(p) for p in pts]}


# ----------------------------------------------------------------------------- the union
COAT = (0.2, 0.085, 0.036)     # bay
POINTS = (0.035, 0.028, 0.026)  # black points: lower legs, muzzle, mane, tail
HOOF = (0.11, 0.095, 0.085)
EYE = (0.01, 0.008, 0.008)


def build_high(voxel=0.007):
    parts = [o for o in bpy.data.collections['horse_parts'].objects]
    remove('horse_high')
    bm = bmesh.new()
    for o in parts:
        bm.from_mesh(o.data)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    high = obj_from_bmesh(bm, 'horse_high')
    activate(high)
    high.data.remesh_voxel_size = voxel
    high.data.remesh_voxel_adaptivity = 0.0
    bpy.ops.object.voxel_remesh()
    bm = bmesh.new()
    bm.from_mesh(high.data)
    # blend the shells into one another: lightly everywhere, more over the trunk and quarters (above the knees and
    # hocks, behind the head), where the muscle masses meet
    knee = max(R.head('cannonF.L')[1], R.head('cannonH.L')[1]) + 0.2
    headx = -(R.head('neck3')[0])
    body = [v for v in bm.verts if v.co.z > knee and v.co.y > headx]
    for _ in range(4):
        bmesh.ops.smooth_vert(bm, verts=bm.verts, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    for _ in range(36):
        bmesh.ops.smooth_vert(bm, verts=body, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    # the soles stay flat on the ground
    for v in bm.verts:
        if v.co.z < 0.004:
            v.co.z = 0.0
    bm.to_mesh(high.data)
    bm.free()
    # colour: which shell a point came from, then the coat's own markings
    trees = {}
    for o in parts:
        key = o.name.split('.')[0]
        if key in ('mane', 'forelock', 'tail', 'eye'):
            b = bmesh.new()
            b.from_mesh(o.data)
            trees.setdefault(key, []).append((BVHTree.FromBMesh(b), b))
    def near(key, p, d):
        return any(t.find_nearest(p, d)[0] is not None for t, _ in trees.get(key, []))
    col = high.data.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
    rough = high.data.attributes.new('rough', 'FLOAT', 'POINT')
    muzzle = S(R.mk('muzzle'))
    knee_z = min(R.head('cannonF.L')[1], R.head('cannonH.L')[1])
    mix = lambda a, b, t: tuple(a[i] + (b[i] - a[i]) * t for i in range(3))
    sm = lambda x, a, b: max(0.0, min(1.0, (x - a) / (b - a))) ** 2 * (3 - 2 * max(0.0, min(1.0, (x - a) / (b - a))))
    for i, v in enumerate(high.data.vertices):
        p = v.co
        c, r = COAT, 0.62
        # a darker dorsal line and legs shading to black below the knees and hocks; lighter belly and flanks
        c = mix(c, (0.27, 0.13, 0.06), sm(-p.z, -1.25, -0.85) * 0.5)
        c = mix(c, POINTS, 1 - sm(p.z, knee_z - 0.12, knee_z + 0.22))
        c = mix(c, POINTS, (1 - sm((p - muzzle).length, 0.07, 0.2)) * 0.85)
        if p.z < 0.07 and abs(p.x) > 0.05:
            c, r = HOOF, 0.42
        elif p.z < 0.085 and abs(p.x) > 0.05:
            c = mix(HOOF, c, sm(p.z, 0.07, 0.085))
        if near('eye', p, 0.004):
            c, r = EYE, 0.12
        elif near('mane', p, 0.006) or near('forelock', p, 0.006) or near('tail', p, 0.008):
            c, r = POINTS, 0.5
        col.data[i].color = (c[0], c[1], c[2], 1.0)
        rough.data[i].value = r
    for _, b in sum(trees.values(), []):
        b.free()
    log('high:', len(high.data.vertices), 'verts', len(high.data.polygons), 'faces')
    return high


# ----------------------------------------------------------------------------- the game mesh
def build_low():
    high = bpy.data.objects['horse_high']
    remove('horse')
    low = high.copy()
    low.data = high.data.copy()
    low.name = low.data.name = 'horse'
    bpy.context.scene.collection.objects.link(low)
    activate(low)
    tris = sum(len(p.vertices) - 2 for p in low.data.polygons)
    m = low.modifiers.new('dec', 'DECIMATE')
    m.ratio = (TRI_BUDGET - 250) / tris
    m.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier='dec')
    bm = bmesh.new()
    bm.from_mesh(low.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0005)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=0.0002)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    for v in bm.verts:
        if v.co.z < 0.003:
            v.co.z = 0.0
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(low.data)
    bm.free()
    for a in list(low.data.color_attributes):
        low.data.color_attributes.remove(a)
    if low.data.attributes.get('rough'):
        low.data.attributes.remove(low.data.attributes['rough'])
    for p in low.data.polygons:
        p.use_smooth = True
    # unwrap: islands by angle, packed with a margin that survives mip 4 of a 2K map
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.004, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    nm = sum(1 for e in _edges_nonmanifold(low))
    log('low:', len(low.data.vertices), 'verts', len(low.data.polygons), 'tris', 'non-manifold edges', nm)
    assert len(low.data.polygons) <= TRI_BUDGET, 'over the triangle budget'
    return low


def _edges_nonmanifold(ob):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    out = [e for e in bm.edges if not e.is_manifold]
    n = len(out)
    bm.free()
    return range(n)


if 'parts' in STAGES:
    INFO = build_parts()
if 'high' in STAGES:
    build_high()
if 'low' in STAGES:
    build_low()
