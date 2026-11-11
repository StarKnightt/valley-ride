"""
rider_hair.py - her hair, as cards like the horse's mane and tail (object "rider_hair", material rider_hair,
alpha-tested strands drawn by rider_bake.hair_texture).

Blonde, pulled back into a ponytail (refs/rider: hair-*):
  scalp     cards from her own hairline (the edge of the base mesh's scalp region) back over the head into the tie,
            two layers deep, each lifted a few millimetres off the skin, so the head has hair with depth and an edge
            of strands - not a painted cap
  ponytail  a bundle of cards from the tie, out behind the head and down between the shoulder blades, fanning and
            thinning to its tips; rider_rig weights it down four bones that the runtime springs move
  loose     a few fine strands at the temples, in front of the ears and at the nape

Each vertex carries hair_t (0 root .. 1 tip; along the bundle for the ponytail) and hair_kind (0 ponytail, 1 on the
head) for the rig. UVs: one of 8 columns of the strand texture per card, v = 1 at the root.
"""
import bpy, bmesh, math, os, sys, random
from mathutils import Vector, Quaternion
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else 'F:/valley-ride/tools/blender/rider')
import importlib, rlib
importlib.reload(rlib)
from rlib import log, remove, obj_from_bmesh, catmull, pony_points

V = Vector
COLS = 8
SCALP_STRANDS, PONY_STRANDS, CLUMPS = 480, 220, 88
EDGE_COLS, STRAND_COL, PONY_STRAND_COL, PONY_COLS, PONY_IN, WISP_COL = (0, 1), 2, 3, (4, 5), 6, 7
# texture columns: the hairline's cards; single strands over the scalp; single strands of the ponytail; the
# ponytail's locks, and those inside the bundle (in its own shade); loose strands


def build_hair():
    J = rlib.load_joints()
    body = bpy.data.objects['rider']
    remove('rider_hair')
    rnd = random.Random(7)
    c, tie = J['skull'], J['tie']
    up = (J['crown'] - J['head']).normalized()
    # (her head alone: a ray toward the skull's centre from below would find her neck and shoulders first)
    hb = bmesh.new()
    hb.from_mesh(body.data)
    bmesh.ops.delete(hb, geom=[v for v in hb.verts if (v.co - c).length > 0.125], context='VERTS')
    tree = BVHTree.FromBMesh(hb)

    def scalp(d, lift):
        """the point on her head along d from the skull's centre, lifted off the skin"""
        hit, n, _, _ = tree.ray_cast(c + d * 0.3, -d, 0.35)
        if hit is None:
            hit = tree.find_nearest(c + d * 0.095)[0]
        return hit + d * lift

    # ---- her hairline: the edge of the scalp region, in order, at an even spacing
    sc = body.data.attributes['m_scalp'].data
    me = body.data
    on = [sc[v.index].value > 0.5 for v in me.vertices]
    count = {}
    for p in me.polygons:
        if all(on[v] for v in p.vertices):
            for a, b in p.edge_keys:
                count[(a, b)] = count.get((a, b), 0) + 1
    nxt = {}
    for (a, b), k in count.items():
        if k == 1:
            nxt.setdefault(a, []).append(b)
            nxt.setdefault(b, []).append(a)
    start = max(nxt, key=lambda i: -me.vertices[i].co.y)        # the middle of the forehead is furthest forward
    loop, prev = [start], None
    while True:
        cand = [i for i in nxt[loop[-1]] if i != prev]
        if not cand or cand[0] == start:
            break
        prev = loop[-1]
        loop.append(cand[0])
        if len(loop) > 2000:
            break
    line = [me.vertices[i].co.copy() for i in loop]
    length = sum((a - b).length for a, b in zip(line, line[1:] + line[:1]))
    SP = 0.0105
    roots, acc, want = [], 0.0, 0.0
    for a, b in zip(line, line[1:] + line[:1]):
        seg = (b - a).length
        while want <= acc + seg:
            roots.append(a.lerp(b, (want - acc) / max(seg, 1e-9)))
            want += SP
        acc += seg
    log(f'hairline: {length:.2f} m round, {len(roots)} roots')

    bm = bmesh.new()
    uv = bm.loops.layers.uv.new('UVMap')
    bm.verts.layers.float.new('hair_t')
    bm.verts.layers.float.new('hair_kind')
    t_l, k_l = bm.verts.layers.float['hair_t'], bm.verts.layers.float['hair_kind']
    normals = []

    def card(points, widths, across, kind, col, ts=None, nrm=None, strand=False, vs=None):
        """a ribbon through points; across[i]: its width's direction; nrm[i]: its shading normal (outward)"""
        n = len(points)
        rows = []
        for i, (p, w) in enumerate(zip(points, widths)):
            a = across[i] if isinstance(across, list) else across
            l, r = bm.verts.new(p - a * w), bm.verts.new(p + a * w)
            for v in (l, r):
                v[t_l] = ts[i] if ts else i / (n - 1)
                v[k_l] = kind
                normals.append(nrm[i] if nrm else V((0, 0, 1)))
            rows.append((l, r))
        if strand:
            # one strand: a single line of its column of the texture (its own tone, root to tip)
            u0 = u1 = (col + rnd.uniform(0.08, 0.92)) / COLS
        else:
            u0, u1 = col / COLS + 0.006, (col + 1) / COLS - 0.006
            if rnd.random() < 0.5:
                u0, u1 = u1, u0
        for i in range(n - 1):
            (a0, b0), (a1, b1) = rows[i], rows[i + 1]
            f = bm.faces.new((a0, b0, b1, a1))
            va, vb = (vs[i], vs[i + 1]) if vs else (i / (n - 1), (i + 1) / (n - 1))
            for lp, (u, vv) in zip(f.loops, ((u0, va), (u1, va), (u1, vb), (u0, vb))):
                lp[uv].uv = (u, 1 - vv)

    # ---- over the scalp into the tie: from each root the hair runs round the head (the shortest way on a sphere
    # about the skull's centre) to the tie. First a layer of cards: the hair's body and its hairline. Then strands
    # (fine ribbons, like the horse's mane) lying over the cards, each from its own place on the head with its own
    # slight wander and lift - what the eye reads as hair
    dt = (tie - c).normalized()
    SEG = 9

    def path(r, s0, s1, lift_more, sway, n):
        dr = (r - c).normalized()
        q = dr.rotation_difference(dt)
        pts, nr, ss = [], [], []
        for k in range(n):
            s = s0 + (s1 - s0) * k / (n - 1)
            d = Quaternion().slerp(q, s) @ dr
            # (a little off the straight way, so the hair does not all meet in one seam)
            d = (d + d.cross(dt) * sway * math.sin(math.pi * s)).normalized()
            lift = 0.0025 + 0.007 * math.sin(math.pi * min(1, s * 1.1)) ** 0.8 + lift_more(s)
            p = scalp(d, lift)
            if s > 0.82:
                p = p.lerp(tie, (s - 0.82) / 0.18)
            pts.append(p)
            nr.append(d)
            ss.append(s)
        acr = []
        for k in range(n):
            tg = (pts[min(n - 1, k + 1)] - pts[max(0, k - 1)]).normalized()
            a = tg.cross(nr[k])
            acr.append(a.normalized() if a.length > 1e-6 else V((1, 0, 0)))
        return pts, acr, nr, ss

    for i, r in enumerate(roots):
        # (each card starts a little before or behind its neighbours: the hairline is not a row of steps)
        pts, acr, nr, ss = path(r, rnd.uniform(0.0, 0.035), 1.0, lambda s: rnd.uniform(0, 0.001), rnd.uniform(-0.05, 0.05), SEG)
        widths = [SP * 0.95 * (1 - 0.72 * (k / (SEG - 1)) ** 1.6) for k in range(SEG)]
        card(pts, widths, acr, 1, rnd.choice(EDGE_COLS), nrm=nr)
    # a second shell of locks over the first: hair reads as clumps, each from its own place behind the hairline and
    # of its own width (hair-groom: clumps before strands, no uniform card width)
    for i in range(CLUMPS):
        j = rnd.randrange(len(roots))
        r = roots[j].lerp(roots[(j + 1) % len(roots)], rnd.random())
        pts, acr, nr, ss = path(r, rnd.uniform(0.10, 0.5), 1.0, lambda s: 0.003 + rnd.uniform(0, 0.001), rnd.uniform(-0.07, 0.07), SEG)
        w0 = SP * rnd.uniform(0.45, 1.3)
        card(pts, [w0 * (1 - 0.6 * (k / (SEG - 1)) ** 1.6) for k in range(SEG)], acr, 1, rnd.choice(EDGE_COLS), nrm=nr)     # (the texture that fades in strand by strand)
    n_cards = len(bm.faces)
    NS = 7
    for i in range(SCALP_STRANDS):
        j = rnd.randrange(len(roots))
        r = roots[j].lerp(roots[(j + 1) % len(roots)], rnd.random())
        s0 = 0.0 if rnd.random() < 0.55 else rnd.uniform(0.0, 0.6)     # most from the hairline, the rest from further in
        s1 = 1.0 if rnd.random() < 0.8 else rnd.uniform(0.6, 0.95)
        up_ = rnd.uniform(0.0012, 0.0055)
        stray = rnd.uniform(0.0, 0.006) if rnd.random() < 0.12 else 0.0   # a few stand off the rest
        pts, acr, nr, ss = path(r, s0, s1, lambda s: up_ + stray * math.sin(math.pi * (s - s0) / max(1e-6, s1 - s0)), rnd.uniform(-0.09, 0.09), NS)
        hw = rnd.uniform(0.0007, 0.0012)
        widths = [hw * (1 - 0.5 * (k / (NS - 1)) ** 2) for k in range(NS)]
        card(pts, widths, acr, 1, STRAND_COL, nrm=nr, strand=True, vs=ss)
    # ---- the hairline itself: short fine hairs from just outside the hair's edge, swept back with the rest - the
    # edge is a thinning of hair onto the forehead, temples and nape, never a line (refs/rider: face-threequarter-01,
    # hair-ponytail-behind-01)
    for j in range(len(roots)):
        for _ in range(4):
            r = roots[j].lerp(roots[(j + 1) % len(roots)], rnd.random())
            dr = (r - c).normalized()
            out = (dr - dt * dr.dot(dt)).normalized()                # away from the tie, on the head
            r2 = scalp((dr + out * rnd.uniform(0.0, 0.035)).normalized(), 0.0)
            pts, acr, nr, ss = path(r2, 0.0, rnd.uniform(0.07, 0.22), lambda s: rnd.uniform(0.0003, 0.0018), rnd.uniform(-0.25, 0.25), 5)
            hw = rnd.uniform(0.00035, 0.0007)
            card(pts, [hw * (1 - 0.7 * k / 4) for k in range(5)], acr, 1, STRAND_COL, nrm=nr, strand=True, vs=ss)
    n_scalp = len(bm.faces)
    n_strands = n_scalp - n_cards

    # ---- the ponytail: cards round the bundle's line, the outer ones fanning, inner ones filling its core
    line = [V(p) for p in catmull([tuple(p) for p in pony_points()], 11)]
    NP = len(line)
    NCARD = 48
    for i in range(NCARD):
        ang = 2 * math.pi * i / NCARD * 3.0 + rnd.uniform(-0.3, 0.3)       # (three turns: neighbours in the list lie apart)
        depth = rnd.uniform(0.15, 1.0) ** 0.6                              # through the bundle, most of them outside
        ln = rnd.uniform(0.62, 1.0)
        twist = rnd.uniform(-0.9, 0.9)
        wave, wph = rnd.uniform(0.0, 0.007), rnd.uniform(0, 6.28)          # each lock has its own slight wave
        tilt = rnd.uniform(-0.5, 0.5)
        pts, acr, nr, ts = [], [], [], []
        for k in range(NP):
            s = k / (NP - 1) * ln
            f = s * (NP - 1)
            j = min(NP - 2, int(f))
            p = line[j].lerp(line[j + 1], f - j)
            tg = (line[j + 1] - line[j]).normalized()
            e1 = tg.cross(V((1, 0, 0))).normalized()
            e2 = tg.cross(e1).normalized()
            a_ = ang + twist * s
            rad = e1 * math.cos(a_) + e2 * math.sin(a_)
            R = (0.006 + 0.026 * math.sin(math.pi * min(1.0, s * 1.5) * 0.5) ** 0.8) * (1 - 0.5 * max(0.0, s - 0.55) / 0.45) * depth
            side_ = tg.cross(rad).normalized()
            pts.append(p + rad * R + side_ * (wave * math.sin(s * 9 + wph) * s))
            a2 = (side_ + rad * tilt).normalized()
            acr.append(a2)
            # lit as part of the bundle, but each lock a little its own way (its face's normal mixed in)
            nr.append((rad * 0.65 + tg.cross(a2).normalized() * (0.35 if tg.cross(a2).dot(rad) > 0 else -0.35)).normalized())
            ts.append(s)
        w0 = rnd.uniform(0.0045, 0.0085)
        widths = [w0 * (0.55 + 0.45 * math.sin(math.pi * min(1.0, k / (NP - 1) * 1.8) * 0.5)) * (1 - 0.45 * (k / (NP - 1)) ** 2) for k in range(NP)]
        card(pts, widths, acr, 0, rnd.choice(PONY_COLS) if depth > 0.62 else PONY_IN, ts=ts, nrm=nr)
    for i in range(PONY_STRANDS):
        ang = rnd.uniform(0, 2 * math.pi)
        depth = rnd.uniform(0.2, 1.12)
        ln = rnd.uniform(0.6, 1.04)
        twist = rnd.uniform(-1.2, 1.2)
        wave, wph = rnd.uniform(0.002, 0.014), rnd.uniform(0, 6.28)
        lock = rnd.randrange(7)                                    # strands of a lock wave together and part from the others
        wph = lock * 0.9 + rnd.uniform(-0.25, 0.25)
        part = rnd.uniform(0.0, 0.03)
        pts, acr, nr, ts = [], [], [], []
        for k in range(NP):
            s = min(1.0, k / (NP - 1) * ln)
            f = s * (NP - 1)
            j = min(NP - 2, int(f))
            p = line[j].lerp(line[j + 1], f - j)
            tg = (line[j + 1] - line[j]).normalized()
            e1 = tg.cross(V((1, 0, 0))).normalized()
            e2 = tg.cross(e1).normalized()
            a_ = ang + twist * s
            rad = e1 * math.cos(a_) + e2 * math.sin(a_)
            R = (0.006 + 0.027 * math.sin(math.pi * min(1.0, s * 1.5) * 0.5) ** 0.8) * (1 - 0.5 * max(0.0, s - 0.55) / 0.45) * depth
            side_ = tg.cross(rad).normalized()
            pts.append(p + rad * (R + part * s * s) + side_ * (wave * math.sin(s * 8 + wph) * s))
            acr.append(side_)
            nr.append(rad)
            ts.append(s)
        hw = rnd.uniform(0.0007, 0.0012)
        card(pts, [hw * (1 - 0.6 * (k / (NP - 1)) ** 2) for k in range(NP)], acr, 0, PONY_STRAND_COL, ts=ts, nrm=nr, strand=True, vs=[k / (NP - 1) for k in range(NP)])
    n_pony = len(bm.faces) - n_scalp

    # ---- loose strands: at the temples and in front of the ears they fall down and a little forward along the
    # face; at the nape a few short ones escape downward
    side = V((1, 0, 0))
    fwd = up.cross(side).normalized()
    if fwd.y > 0:
        fwd = -fwd
    for li, r in enumerate(roots):
        d = (r - c).normalized()
        lat, hgt, front = d.dot(side), d.dot(up), d.dot(fwd)
        temple = abs(lat) > 0.55 and front > 0.15 and hgt > -0.2
        nape = hgt < -0.45 and front < -0.2
        if not ((temple and li % 2 == 0) or (nape and li % 4 == 0)):
            continue
        L = rnd.uniform(0.05, 0.10) if temple else rnd.uniform(0.025, 0.05)
        sg = 1 if lat > 0 else -1
        out = (d * 0.35 + fwd * (0.25 if temple else -0.1)).normalized()
        pts, nr = [], []
        for k in range(6):
            s = k / 5
            p = r + d * 0.004 + (-up * (s * L) + out * (0.012 * math.sin(s * 2.2)) + side * sg * (0.006 * s * s) + fwd * (0.010 * s * s if temple else 0))
            pts.append(p)
            nr.append((d + out).normalized())
        acr = [(pts[min(5, k + 1)] - pts[max(0, k - 1)]).normalized().cross(nr[k]).normalized() for k in range(6)]
        card(pts, [0.0045 * (1 - 0.5 * k / 5) for k in range(6)], acr, 1, WISP_COL, nrm=nr)
    n_loose = len(bm.faces) - n_scalp - n_pony
    bm.verts.index_update()
    ob = obj_from_bmesh(bm, 'rider_hair')
    for p in ob.data.polygons:
        p.use_smooth = True
    # the cards are lit as the hair's volume, not as flat ribbons: their normals point out of the head / the bundle
    ob.data.normals_split_custom_set_from_vertices([tuple(n) for n in normals])
    m = bpy.data.materials.get('rider_hair') or bpy.data.materials.new('rider_hair')
    ob.data.materials.append(m)
    log(f'hair: {n_cards} card quads and {SCALP_STRANDS} strands over the scalp, {n_pony} quads in the ponytail ({PONY_STRANDS} strands), {n_loose} loose; {2 * len(ob.data.polygons)} triangles')
    return ob


if __name__ == '__main__':
    build_hair()
