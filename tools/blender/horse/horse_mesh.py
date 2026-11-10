"""
horse_mesh.py - the horse's surface, built around the rest skeleton of gallop.design.json.

Stages (set STAGES before exec, or pass after `--`): parts, high, low, hair
  parts: closed shells lofted along the skeleton: trunk, neck, head, four legs with their joints and tendons, and
         the muscle masses of a thoroughbred (shoulder, triceps, forearm, gluteals, quadriceps, hamstrings, gaskin),
         each sunk most of the way into the form it sits on. Collection "horse_parts".
  high:  the union of the shells as one watertight surface (voxel remesh on the joined shells), smoothed where the
         masses meet, with colour and roughness attributes for the bay coat. Object "horse_high".
  low:   the game mesh: horse_high decimated to the triangle budget, unwrapped. Object "horse".
  hair:  mane, forelock and tail as card strips (their own mesh and material, alpha-tested). Object "horse_hair".

Voxel remeshing and decimation run on the CPU (OpenVDB / BMesh have no GPU path); they take seconds.
"""
import bpy, bmesh, math, sys, os, random
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else 'F:/valley-ride/tools/blender/horse')
import importlib, hlib
importlib.reload(hlib)
from hlib import S, Rest, lerp, perp, log, design, obj_from_bmesh, collection, remove, activate, tail_points, ear_points, chest_origin, neck_lines, neck_side

TRI_BUDGET = 14000
HAIR_BUDGET = 2000
STAGES = globals().get('STAGES') or (sys.argv[sys.argv.index('--') + 1].split(',') if '--' in sys.argv else ['parts', 'high', 'low', 'hair'])
R = Rest(design())
V = Vector


# ----------------------------------------------------------------------------- lofting
def ring(bm, c, u, v, n=20, p=1.0):
    out = []
    for i in range(n):
        t = 2 * math.pi * i / n
        cu, sv = math.cos(t), math.sin(t)
        out.append(bm.verts.new(c + u * math.copysign(abs(cu) ** p, cu) + v * math.copysign(abs(sv) ** p, sv)))
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


def resample(rows, n):
    """Catmull-Rom through rows of numbers, n rows out"""
    out = []
    m = len(rows)
    for k in range(n):
        t = k / (n - 1) * (m - 1)
        i = min(m - 2, int(t))
        f = t - i
        p0, p1, p2, p3 = rows[max(0, i - 1)], rows[i], rows[i + 1], rows[min(m - 1, i + 2)]
        out.append(tuple(0.5 * ((2 * b) + (-a + c) * f + (2 * a - 5 * b + 4 * c - d) * f * f + (-a + 3 * b - 3 * c + d) * f ** 3) for a, b, c, d in zip(p0, p1, p2, p3)))
    return out


def tube(name, coll, stations, n=18, p=1.0, smooth=0):
    """stations: (x, y, lateral, half fore-aft, half lateral[, axis x, axis y]); rings stand across the path (or the
    given axis). smooth > 0 resamples the stations to that many rings."""
    rows = [tuple(st[:5]) + (tuple(st[5:7]) if len(st) > 5 else (0.0, 0.0)) for st in stations]
    if smooth:
        rows = resample(rows, smooth)
    bm = bmesh.new()
    rings = []
    for i, st in enumerate(rows):
        c = V((st[0], st[1]))
        if abs(st[5]) + abs(st[6]) > 0.3:
            ax = V((st[5], st[6])).normalized()
        else:
            p0, p1 = rows[max(0, i - 1)], rows[min(len(rows) - 1, i + 1)]
            ax = (V((p1[0], p1[1])) - V((p0[0], p0[1]))).normalized()
        rings.append(ring(bm, S(c, st[2]), V((1, 0, 0)) * st[4], S(perp(ax)) * st[3], n, p))
    skin(bm, rings)
    return finish(bm, name, coll)


def ellipsoid(name, coll, c, lat, axis, ra, rb, rl, seg=20, rings_=12):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings_, radius=1.0)
    ax = V(axis).normalized()
    M = Matrix((S(ax) * ra, S(perp(ax)) * rb, V((1, 0, 0)) * rl)).transposed().to_4x4()
    M.translation = S(c, lat)
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
    return finish(bm, name, coll)


# ----------------------------------------------------------------------------- the parts
def build_parts():
    coll = collection('horse_parts', fresh=True)
    coll.hide_viewport = False
    chest0 = chest_origin(R)
    j3 = R.head('pelvis')
    girth, withers, croup, buttock = R.mk('girth'), R.mk('withers'), R.mk('croup'), R.mk('buttock')
    sh, el = R.head('humerus.L'), R.head('radius.L')
    hp, sf = R.head('femur.L'), R.head('tibia.L')
    wy, cy_ = withers[1], croup[1]
    belly = girth[1] - 0.025                      # the sternum line at the girth
    breast = sh[0] + 0.07                        # the front of the chest, just ahead of the points of the shoulders
    rear = buttock[0] - 0.025

    # --- trunk: sections across the body from the breast to the buttocks: (x, top, bottom, half width, how high the
    # widest point sits 0..1). A thoroughbred: high withers, deep through the girth, a short level back, the
    # underline running up to a tucked flank, a long sloping croup.
    wx = withers[0]
    L = wx - croup[0]
    T = [
        (breast + 0.01, lerp(belly, wy, 0.66), lerp(belly, wy, 0.42), 0.05, 0.5),
        (breast - 0.02, lerp(belly, wy, 0.78), lerp(belly, wy, 0.27), 0.13, 0.5),
        (breast - 0.09, lerp(belly, wy, 0.88), lerp(belly, wy, 0.12), 0.185, 0.5),
        (wx + 0.1, wy - 0.01, belly + 0.012, 0.215, 0.48),
        (wx, wy + 0.03, belly - 0.004, 0.228, 0.45),
        (wx - 0.14 * L, wy + 0.005, belly - 0.012, 0.248, 0.43),
        (wx - 0.3 * L, wy - 0.04, belly + 0.0, 0.262, 0.42),
        (wx - 0.47 * L, wy - 0.06, belly + 0.035, 0.266, 0.42),
        (wx - 0.63 * L, lerp(wy - 0.065, cy_ - 0.03, 0.6), belly + 0.08, 0.256, 0.45),
        (wx - 0.79 * L, cy_ - 0.03, belly + 0.14, 0.244, 0.5),
        (wx - 0.92 * L, cy_ - 0.015, belly + 0.19, 0.27, 0.54),
        (croup[0], cy_ - 0.008, belly + 0.21, 0.285, 0.56),
        (lerp(croup[0], rear, 0.4), cy_ - 0.03, belly + 0.2, 0.28, 0.55),
        (lerp(croup[0], rear, 0.75), cy_ - 0.085, belly + 0.19, 0.245, 0.52),
        (rear + 0.02, cy_ - 0.165, belly + 0.2, 0.17, 0.5),
        (rear - 0.03, cy_ - 0.31, belly + 0.23, 0.06, 0.5),
    ]
    bm = bmesh.new()
    rings = []
    for x, top, bot, hw, wz in resample(T, 48):
        zc = lerp(bot, top, wz)
        r = []
        n = 32
        for i in range(n):
            t = 2 * math.pi * i / n
            cu, sv = math.cos(t), math.sin(t)
            a = math.copysign(abs(cu) ** 0.92, cu)
            b = math.copysign(abs(sv) ** 0.92, sv)
            w = hw * (0.74 + 0.26 * (1.0 - sv) ** 0.7) if sv > 0 else hw   # narrower over the spine
            r.append(bm.verts.new(V((w * a, -x, zc + (top - zc if sv > 0 else zc - bot) * b))))
        rings.append(r)
    skin(bm, list(reversed(rings)))
    finish(bm, 'trunk', coll)

    # --- neck: between an arched crest and the underline, set on high from the withers and the breast
    crest, under, hwf = neck_lines(R)
    bm = bmesh.new()
    rings = []
    for t in [-0.14 + 1.2 * k / 25 for k in range(26)]:
        a, b = crest(t), under(t)
        c, half = (a + b) / 2, (a - b) / 2
        hw = hwf(t)
        r = []
        n = 24
        for i in range(n):
            ang = 2 * math.pi * i / n
            cu, sv = math.cos(ang), math.sin(ang)
            w = hw * (0.55 + 0.45 * (1 - max(0, sv)) ** 0.8)   # a narrow crest, full below
            r.append(bm.verts.new(S(c + half * sv, w * cu)))
        rings.append(r)
    skin(bm, rings)
    finish(bm, 'neck', coll)

    # --- head: sections along the head bone (x towards the muzzle, y towards the forehead): a flat forehead, a
    # straight face, deep jaw, a fine square muzzle
    atlas, hd = R.head('head'), (R.tail('head') - R.head('head')).normalized()
    hu = perp(hd)
    HK = 1.08                                       # (the head a little larger than the bone alone gives)
    k = (R.tail('head') - R.head('head')).length / 0.6 * 1.03
    Hs = [(-0.07, 0.03, -0.09, 0.04), (-0.02, 0.068, -0.15, 0.075), (0.05, 0.086, -0.195, 0.097), (0.13, 0.09, -0.205, 0.104), (0.22, 0.082, -0.19, 0.096),
          (0.32, 0.07, -0.15, 0.078), (0.42, 0.058, -0.112, 0.063), (0.5, 0.052, -0.102, 0.061), (0.56, 0.047, -0.1, 0.063), (0.6, 0.026, -0.086, 0.053), (0.622, -0.008, -0.06, 0.032)]
    bm = bmesh.new()
    rings = []
    for x, top, bot, hw in resample([(x_, t_ * HK, b_ * HK, w_ * HK) for x_, t_, b_, w_ in Hs], 28):
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
        a_, b_, base, tip = ear_points(R, sg)
        bm = bmesh.new()
        r0 = ring(bm, S(base, sg * 0.055), V((1, 0, 0)) * 0.03, S(hd) * 0.036, 12)
        r1 = ring(bm, S(lerp(base, tip, 0.5), sg * 0.07), V((1, 0, 0)) * 0.024, S(hd) * 0.032, 12)
        r2 = ring(bm, S(tip, sg * 0.082), V((1, 0, 0)) * 0.004, S(hd) * 0.006, 12)
        skin(bm, [r0, r1, r2])
        finish(bm, f'ear.{sd}', coll)
        ellipsoid(f'eye.{sd}', coll, atlas + hd * 0.13 * k + hu * 0.032, sg * 0.094 * HK, hd, 0.019, 0.017, 0.014, 14, 10)
        ellipsoid(f'brow.{sd}', coll, atlas + hd * 0.115 * k + hu * 0.062, sg * 0.08 * HK, hd, 0.06, 0.024, 0.034, 12, 8)
        ellipsoid(f'jowl.{sd}', coll, atlas + hd * 0.1 * k + hu * -0.125, sg * 0.06 * HK, hd, 0.125, 0.115, 0.048, 16, 12)
        ellipsoid(f'nostril.{sd}', coll, atlas + hd * 0.565 * k + hu * 0.0, sg * 0.04 * HK, hd, 0.035, 0.026, 0.024, 10, 8)
        ellipsoid(f'chin.{sd}', coll, atlas + hd * 0.54 * k + hu * -0.1, sg * 0.022, hd, 0.045, 0.025, 0.032, 10, 8)

    # --- legs
    def fore(sd, sg):
        sh, el, kn, fe, co, toe = (R.head(f'{b}.{sd}') for b in ('humerus', 'radius', 'cannonF', 'pasternF', 'hoofF', 'hoofF'))
        toe = R.tail(f'hoofF.{sd}')
        d = (kn - el).normalized(); f = perp(d) * -1 if perp(d)[0] < 0 else perp(d)      # forward of the forearm
        dc = (fe - kn).normalized(); fc = perp(dc) * -1 if perp(dc)[0] < 0 else perp(dc)
        P = lambda a, b, t, off=0.0, fw=f: tuple(lerp(a, b, t) + fw * off)
        st = [
            P(sh, el, 0.05, 0.0) + (sg * 0.11, 0.06, 0.04),
            P(sh, el, 0.4, 0.02) + (sg * 0.135, 0.1, 0.06),
            P(sh, el, 0.7, 0.025) + (sg * 0.15, 0.125, 0.072),
            P(sh, el, 1.0, 0.03) + (sg * 0.152, 0.118, 0.07),
            P(el, kn, 0.14, 0.026) + (sg * 0.15, 0.106, 0.066),      # the forearm's muscle, fullest just below the elbow
            P(el, kn, 0.34, 0.018) + (sg * 0.146, 0.087, 0.058),
            P(el, kn, 0.6, 0.006) + (sg * 0.141, 0.06, 0.046),
            P(el, kn, 0.82, 0.0) + (sg * 0.137, 0.044, 0.04),
            P(el, kn, 0.92, 0.005) + (sg * 0.136, 0.056, 0.056),      # the knee: broad and flat in front
            P(el, kn, 1.0, 0.005) + (sg * 0.135, 0.06, 0.058),
            P(kn, fe, 0.08, 0.003, fc) + (sg * 0.135, 0.052, 0.052),
            P(kn, fe, 0.22, 0.004, fc) + (sg * 0.134, 0.027, 0.027),  # the cannon bone; the tendon is its own form behind
            P(kn, fe, 0.5, 0.004, fc) + (sg * 0.132, 0.025, 0.025),
            P(kn, fe, 0.8, 0.003, fc) + (sg * 0.131, 0.027, 0.027),
            P(kn, fe, 0.94, -0.004, fc) + (sg * 0.13, 0.043, 0.038),  # the fetlock
            P(kn, fe, 1.03, -0.006, fc) + (sg * 0.13, 0.045, 0.039),
            tuple(lerp(fe, co, 0.45)) + (sg * 0.13, 0.034, 0.033),    # the pastern
            tuple(lerp(fe, co, 0.85)) + (sg * 0.13, 0.036, 0.036),
        ]
        tube(f'fore.{sd}', coll, st, smooth=40)
        hoof(f'hoofF.{sd}', toe, sg * 0.13, 0.057)
        # the tendons behind the cannon stand off the bone, the pisiform behind the knee, the ergot behind the fetlock
        tube(f'tendonF.{sd}', coll, [tuple(lerp(kn, fe, t) - fc * o) + (sg * 0.132, r, r * 0.85) for t, o, r in ((0.06, 0.022, 0.016), (0.3, 0.033, 0.014), (0.6, 0.034, 0.014), (0.92, 0.03, 0.018))], n=10)
        ellipsoid(f'pisiform.{sd}', coll, kn - fc * 0.035 + V((0, 0.02)), sg * 0.135, dc, 0.035, 0.022, 0.024, 12, 8)
        ellipsoid(f'ergotF.{sd}', coll, fe - fc * 0.03 + V((0, 0.005)), sg * 0.13, dc, 0.03, 0.024, 0.026, 12, 8)
        scap = R.head(f'scapula.{sd}')
        sd_ = (sh - scap).normalized()
        # the shoulder: the blade's muscles lying flat along the scapula, the point of the shoulder, the triceps behind
        ellipsoid(f'shoulder.{sd}', coll, lerp(scap, sh, 0.52) + perp(sd_) * 0.01, sg * 0.128, sd_, 0.27, 0.125, 0.075)
        ellipsoid(f'triceps.{sd}', coll, lerp(sh, el, 0.55) + V((-0.12, 0.06)), sg * 0.145, V((0.8, -1)), 0.23, 0.13, 0.08)

    def hind(sd, sg):
        hp, sf, hk, fe, co = (R.head(f'{b}.{sd}') for b in ('femur', 'tibia', 'cannonH', 'pasternH', 'hoofH'))
        toe = R.tail(f'hoofH.{sd}')
        d = (hk - sf).normalized(); f = perp(d) * -1 if perp(d)[0] < 0 else perp(d)
        dc = (fe - hk).normalized(); fc = perp(dc) * -1 if perp(dc)[0] < 0 else perp(dc)
        P = lambda a, b, t, off=0.0, fw=f: tuple(lerp(a, b, t) + fw * off)
        st = [
            P(hp, sf, 0.5, -0.02) + (sg * 0.165, 0.14, 0.085),
            P(hp, sf, 0.85, -0.025) + (sg * 0.178, 0.13, 0.082),
            P(sf, hk, 0.06, -0.04) + (sg * 0.18, 0.145, 0.082),
            P(sf, hk, 0.28, -0.03) + (sg * 0.176, 0.125, 0.072),
            P(sf, hk, 0.55, -0.014) + (sg * 0.17, 0.09, 0.056),
            P(sf, hk, 0.8, 0.0) + (sg * 0.166, 0.058, 0.042),
            P(sf, hk, 0.95, 0.008) + (sg * 0.165, 0.052, 0.043),      # the hock: deep, flat-sided
            P(sf, hk, 1.02, 0.012) + (sg * 0.165, 0.056, 0.045),
            P(hk, fe, 0.1, 0.008, fc) + (sg * 0.163, 0.048, 0.04),
            P(hk, fe, 0.22, 0.002, fc) + (sg * 0.161, 0.036, 0.031),
            P(hk, fe, 0.5, -0.001, fc) + (sg * 0.157, 0.033, 0.027),
            P(hk, fe, 0.8, -0.002, fc) + (sg * 0.153, 0.035, 0.029),
            P(hk, fe, 0.94, -0.004, fc) + (sg * 0.151, 0.044, 0.038),
            P(hk, fe, 1.03, -0.006, fc) + (sg * 0.15, 0.046, 0.039),
            tuple(lerp(fe, co, 0.45)) + (sg * 0.15, 0.035, 0.033),
            tuple(lerp(fe, co, 0.85)) + (sg * 0.15, 0.036, 0.036),
        ]
        tube(f'hind.{sd}', coll, st, smooth=40)
        hoof(f'hoofH.{sd}', toe, sg * 0.15, 0.055)
        tube(f'tendonH.{sd}', coll, [tuple(lerp(hk, fe, t) - fc * o) + (sg * 0.158, r, r * 0.9) for t, o, r in ((0.0, 0.03, 0.016), (0.3, 0.028, 0.013), (0.6, 0.027, 0.013), (0.9, 0.024, 0.016))], n=10)
        # the point of the hock, with the Achilles tendon running up to the gaskin; the ergot
        ellipsoid(f'hockpoint.{sd}', coll, hk - fc * 0.055 + V((0, 0.04)), sg * 0.165, V((0.1, 1)), 0.06, 0.03, 0.024, 12, 8)
        tube(f'achilles.{sd}', coll, [tuple(lerp(hk - fc * 0.05 + V((0, 0.05)), lerp(sf, hk, 0.45) - f * 0.06, t)) + (sg * 0.168, 0.016, 0.014) for t in (0, 0.5, 1)], n=10)
        ellipsoid(f'ergotH.{sd}', coll, fe - fc * 0.03 + V((0, 0.005)), sg * 0.15, dc, 0.03, 0.024, 0.026, 12, 8)
        # the quarters: gluteals over the croup, the quadriceps down the front of the thigh to the stifle, the
        # hamstrings from the point of the buttock down the back of the thigh
        ellipsoid(f'buttock.{sd}', coll, buttock + V((0.06, -0.02)), sg * 0.1, V((0.2, -1)), 0.16, 0.1, 0.1, 14, 10)
        ellipsoid(f'thigh.{sd}', coll, lerp(hp, sf, 0.5) + V((-0.03, 0.03)), sg * 0.155, sf - hp + V((-0.05, 0)), 0.34, 0.23, 0.115)
        ellipsoid(f'quad.{sd}', coll, lerp(hp, sf, 0.62) + V((0.07, 0.03)), sg * 0.165, sf - hp, 0.2, 0.075, 0.075, 14, 10)
        ellipsoid(f'ham.{sd}', coll, lerp(buttock, lerp(sf, hk, 0.6), 0.5) + V((0.0, 0)), sg * 0.13, lerp(sf, hk, 0.6) - buttock, 0.36, 0.085, 0.085)
        ellipsoid(f'stifle.{sd}', coll, sf + V((0.02, 0.02)), sg * 0.18, V((0.3, -1)), 0.075, 0.05, 0.045, 12, 8)

    def hoof(name, toe, lat, hw):
        """a hoof on the ground: the wall sloping back from the toe at about 50 degrees, wider at the ground, heels behind"""
        st = [
            (toe[0] - 0.075, 0.1, lat, 0.04, 0.04, 0.25, -1.0),
            (toe[0] - 0.072, 0.082, lat, 0.047, 0.047, 0.3, -1.0),       # the coronet
            (toe[0] - 0.068, 0.05, lat, 0.057, hw * 0.93, 0.0, -1.0),
            (toe[0] - 0.066, 0.02, lat, 0.064, hw, 0.0, -1.0),
            (toe[0] - 0.066, 0.0, lat, 0.066, hw + 0.002, 0.0, -1.0),
        ]
        tube(name, coll, st, n=16)

    for sg, sd in ((1, 'L'), (-1, 'R')):
        fore(sd, sg)
        hind(sd, sg)

    # --- the dock of the tail (the hair is cards)
    tp = tail_points(R)
    tube('dock', coll, [(tp[0][0], tp[0][1], 0.0, 0.045, 0.045), (tp[1][0], tp[1][1], 0.0, 0.04, 0.042), (tp[2][0], tp[2][1], 0.0, 0.03, 0.032), (lerp(tp[2], tp[3], 0.4)[0], lerp(tp[2], tp[3], 0.4)[1], 0.0, 0.012, 0.014)], n=12)
    log('parts:', len(coll.objects))


# ----------------------------------------------------------------------------- the union
COAT = (0.19, 0.075, 0.03)       # bay
COAT_LIGHT = (0.3, 0.14, 0.06)   # flank, elbow, stifle, muzzle edge: the lighter hair of a bay
POINTS = (0.022, 0.018, 0.017)   # black points: lower legs, muzzle, ear rims
HOOF = (0.03, 0.027, 0.025)
EYE = (0.008, 0.006, 0.006)


def build_high(voxel=0.006):
    parts = [o for o in bpy.data.collections['horse_parts'].objects]
    bpy.data.collections['horse_parts'].hide_viewport = False
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
    # blend the shells into one another. How much depends on the part: the trunk and quarters a lot (the muscle
    # masses must read as forms under one skin, not as lumps), the neck and upper legs some, the lower legs and the
    # head hardly at all (their joints, tendons and features are the detail).
    knee = max(R.head('cannonF.L')[1], R.head('cannonH.L')[1])
    headx = -(R.head('neck3')[0] + 0.05)
    body = [v for v in bm.verts if v.co.z > knee + 0.3 and v.co.y > headx]
    upper = [v for v in bm.verts if v.co.z > knee + 0.08 and v.co.y > headx]
    for _ in range(5):
        bmesh.ops.smooth_vert(bm, verts=bm.verts, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    for _ in range(5):
        bmesh.ops.smooth_vert(bm, verts=upper, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    for _ in range(30):
        bmesh.ops.smooth_vert(bm, verts=body, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    for v in bm.verts:
        if v.co.z < 0.004:
            v.co.z = 0.0
    bm.to_mesh(high.data)
    bm.free()
    # colour: a bay. Black points below the knees and hocks and on the muzzle and ear rims, a darker topline, lighter
    # hair in the flanks, behind the elbows and round the muzzle's edge; the eyes dark and wet; the hooves horn
    trees = {}
    for o in parts:
        key = o.name.split('.')[0]
        if key in ('eye', 'dock', 'nostril') or key.startswith('hoof'):
            b = bmesh.new()
            b.from_mesh(o.data)
            trees.setdefault('hoof' if key.startswith('hoof') else key, []).append((BVHTree.FromBMesh(b), b))
    def near(key, p, d):
        return any(t.find_nearest(p, d)[0] is not None for t, _ in trees.get(key, []))
    col = high.data.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
    rough = high.data.attributes.new('rough', 'FLOAT', 'POINT')
    muzzle = S(R.mk('muzzle'))
    kneeF, hock = R.head('cannonF.L')[1], R.head('cannonH.L')[1]
    flank = S((lerp(R.mk('croup'), R.mk('withers'), 0.3)[0], R.mk('girth')[1] + 0.2))
    elbow = S(R.head('radius.L'))
    ear_tips = [ear_points(R, sg)[1] for sg in (1, -1)]
    mix = lambda a, b, t: tuple(a[i] + (b[i] - a[i]) * t for i in range(3))
    def sm(x, a, b):
        t = max(0.0, min(1.0, (x - a) / (b - a)))
        return t * t * (3 - 2 * t)
    topz = R.mk('withers')[1]
    for i, v in enumerate(high.data.vertices):
        p = v.co
        c, r = COAT, 0.58
        c = mix(c, (0.1, 0.038, 0.017), sm(p.z, topz - 0.3, topz + 0.02) * 0.75 * sm(-abs(p.x), -0.24, -0.04))   # topline
        c = mix(c, COAT_LIGHT, (1 - sm((V((abs(p.x), p.y, p.z)) - V((abs(flank.x) + 0.25, flank.y, flank.z))).length, 0.1, 0.42)) * 0.5)
        c = mix(c, COAT_LIGHT, (1 - sm((V((abs(p.x), p.y, p.z)) - V((0.2, elbow.y + 0.12, elbow.z + 0.05))).length, 0.05, 0.25)) * 0.4)
        c = mix(c, COAT_LIGHT, sm(-p.z, -(R.mk('girth')[1] + 0.12), -(R.mk('girth')[1] - 0.02)) * 0.35 * sm(p.z, kneeF + 0.25, kneeF + 0.4))
        legz = kneeF if p.y < 0 else hock
        # (the black comes in gradually and unevenly up the leg, higher at the back and inside)
        wob = 0.05 * math.sin(p.x * 31 + p.y * 17) + 0.04 * math.sin(p.y * 43 + p.z * 9)
        c = mix(c, POINTS, 1 - sm(p.z + wob, legz - 0.2, legz + 0.6) ** 0.65)
        dm = (p - muzzle).length
        c = mix(c, COAT_LIGHT, (1 - sm(dm, 0.12, 0.26)) * 0.35)
        c = mix(c, POINTS, (1 - sm(dm, 0.06, 0.2)) * 0.92)
        for e in ear_tips:
            c = mix(c, POINTS, (1 - sm((p - e).length, 0.02, 0.09)) * 0.8)
        if near('hoof', p, 0.007) and p.z < 0.09:
            c, r = mix(HOOF, (0.06, 0.052, 0.047), 0.5 * (1 + math.sin(p.z * 420)) * 0.3), 0.38
        if near('eye', p, 0.004):
            c, r = EYE, 0.1
        elif near('dock', p, 0.006):
            c = mix(c, POINTS, 0.6)
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
    nm = sum(1 for e in bm.edges if not e.is_manifold)
    bm.to_mesh(low.data)
    bm.free()
    for a in list(low.data.color_attributes):
        low.data.color_attributes.remove(a)
    if low.data.attributes.get('rough'):
        low.data.attributes.remove(low.data.attributes['rough'])
    for p in low.data.polygons:
        p.use_smooth = True
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.004, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    log('low:', len(low.data.vertices), 'verts', len(low.data.polygons), 'tris', 'non-manifold edges', nm)
    assert len(low.data.polygons) <= TRI_BUDGET, 'over the triangle budget'
    return low


# ----------------------------------------------------------------------------- mane, forelock and tail: cards
def build_hair():
    """
    Strips of hair: each a ribbon of quads from root to tip, unwrapped onto one column of the strand texture
    (u across the strip, v from root 0 to tip 1), carrying the bone it should follow per row in two attributes
    ("hair_root": 0 mane, 1 forelock, 2 tail; "hair_t": 0 at the root .. 1 at the tip; "hair_s": where along the
    crest or the tail it grows). horse_rig.py turns those into weights.
    """
    remove('horse_hair')
    rng = random.Random(11)
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new('UVMap')
    f_root = bm.verts.layers.float.new('hair_root')
    f_t = bm.verts.layers.float.new('hair_t')
    f_s = bm.verts.layers.float.new('hair_s')
    COLS = 8

    def strip(points, widths, across, kind, s):
        """points: Blender-space centre line root -> tip; across: unit vector(s) the strip is wide along"""
        col = rng.randrange(COLS)
        prev = None
        n = len(points)
        for i, (p, w) in enumerate(zip(points, widths)):
            a = across[i] if isinstance(across, list) else across
            l, r = bm.verts.new(p - a * w / 2), bm.verts.new(p + a * w / 2)
            for v in (l, r):
                v[f_root], v[f_t], v[f_s] = kind, i / (n - 1), s
            if prev:
                f = bm.faces.new((prev[0], prev[1], r, l))
                v0, v1 = (i - 1) / (n - 1), i / (n - 1)
                for lp, (uu, vv) in zip(f.loops, ((0, v0), (1, v0), (1, v1), (0, v1))):
                    lp[uv].uv = ((col + 0.06 + 0.88 * uu) / COLS, 0.03 + 0.94 * (1 - vv))   # (inset: the texture wraps)
            prev = (l, r)

    crest, under, hwf = neck_lines(R)
    # the mane: lying down the off (right) side of the neck from the crest, longest in the middle of the neck
    NM = 60
    for k in range(NM):
        t = 0.05 + 0.92 * (k + rng.uniform(-0.3, 0.3)) / (NM - 1)
        c = crest(t)
        tang = (crest(min(1.03, t + 0.03)) - crest(max(0, t - 0.03))).normalized()
        down = perp(tang) * -1
        Lh = (0.12 + 0.1 * math.sin(math.pi * t) ** 0.7) * rng.uniform(0.75, 1.25)
        back = rng.uniform(-0.015, 0.02)
        pts, wd = [], []
        ROWS = 5
        for i in range(ROWS + 1):
            u = i / ROWS
            d = Lh * u
            side = -(neck_side(R, t, max(0.012, d)) + 0.008 + 0.012 * u) if i else -0.004
            pts.append(S(c + down * (d - 0.012) - tang * back * u, side))
            wd.append(0.042 * (1 - 0.45 * u))
        strip(pts, wd, S(tang), 0.0, t)
    # the forelock: from the poll forward and down between the ears
    atlas, hd = R.head('head'), (R.tail('head') - R.head('head')).normalized()
    hu = perp(hd)
    for k in range(8):
        lat = (k - 2.5) * 0.014
        Lh = rng.uniform(0.2, 0.27)
        pts = [S(atlas + hd * (-0.01 + Lh * u) + hu * (0.085 - 0.012 * u * u * 4 + 0.012 * math.sin(u * 3)), lat * (1 + 0.6 * u)) for u in (0, 0.25, 0.5, 0.75, 1)]
        strip(pts, [0.03 * (1 - 0.4 * u) for u in (0, 0.25, 0.5, 0.75, 1)], V((1, 0, 0)), 1.0, 1.0)
    # the tail: from the dock, a full skirt of strips falling to the hocks
    tp = tail_points(R)
    path = lambda u: tp[1] + (tp[2] - tp[1]) * min(1, u * 3) if u < 1 / 3 else (lerp(tp[2], tp[3], (u - 1 / 3) * 3) if u < 2 / 3 else lerp(tp[3], tp[5], (u - 2 / 3) * 3))
    NT = 46
    for k in range(NT):
        ang = 2 * math.pi * (k + rng.uniform(-0.3, 0.3)) / NT
        start = rng.uniform(0.0, 0.14)
        Lk = rng.uniform(0.8, 1.0)
        pts, wd, acr = [], [], []
        ROWS = 8
        for i in range(ROWS + 1):
            u = start + (Lk - start) * i / ROWS
            c = path(u)
            tg = (path(min(1, u + 0.05)) - path(max(0, u - 0.05))).normalized()
            n2 = perp(tg)
            rad = (0.02 + 0.085 * math.sin(math.pi * min(1, u * 1.15)) ** 0.8 * (0.7 + 0.3 * rng.random())) * (1.0 if k % 3 else 0.45)
            off = S(n2) * (math.cos(ang) * rad) + V((1, 0, 0)) * (math.sin(ang) * rad * 0.8)
            pts.append(S(c) + off)
            acr.append((V((1, 0, 0)) * math.cos(ang) - S(n2) * math.sin(ang)).normalized())
            wd.append(0.085 * (1 - 0.45 * (i / ROWS) ** 2))
        strip(pts, wd, acr, 2.0, 0.0)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    tris = sum(len(f.verts) - 2 for f in bm.faces)
    hair = obj_from_bmesh(bm, 'horse_hair')
    for p in hair.data.polygons:
        p.use_smooth = True
    log('hair:', tris, 'triangles in', NM + 6 + NT, 'strips')
    assert tris <= HAIR_BUDGET
    return hair


if 'parts' in STAGES:
    build_parts()
if 'high' in STAGES:
    build_high()
if 'low' in STAGES:
    build_low()
if 'hair' in STAGES:
    build_hair()
