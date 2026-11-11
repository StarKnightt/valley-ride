"""
tack_mesh.py - the horse's tack, shaped to the horse's own surface at rest: an English saddle (seat, pommel, cantle,
flaps), the pad under it, the girth, and a bridle (crownpiece, browband, cheekpieces, noseband, bit rings).

Every piece is a slab laid on the horse: for a grid of positions round the barrel (or the head), a ray from outside
finds the horse's skin, and the piece's two faces sit at two offsets above it. So the tack fits this horse and cannot
sink into it at rest; rider_rig.py gives each piece the skin weights of the horse under it, so it moves with the
horse's skin in the gallop.

Object "tack" (one mesh, a material slot per kind: leather, pad, metal), collection "tack_parts" for the pieces.
"""
import bpy, bmesh, math, json, os, sys
from mathutils import Vector, Matrix

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else 'F:/valley-ride/tools/blender/rider')
import importlib, rlib
importlib.reload(rlib)
from rlib import log, obj_from_bmesh, collection, remove, horse, horse_bvh, J, REPO

V = Vector
DESIGN = json.load(open(os.path.join(REPO, 'tools', 'blender', 'horse', 'gallop.design.json'), encoding='utf8'))
MK = DESIGN['rest']['markers']


def S(p, lat=0.0):
    return V((lat, -p[0], p[1]))


def sm(x, a, b):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def barrel_centre(y):
    """the barrel's axis under the saddle: the body's middle height at y"""
    return V((0.0, y, 1.33))


def surface(bvh, centre, d, reach=1.2):
    """the horse's skin seen from outside along -d toward centre: (point, normal)"""
    o = centre + d * reach
    hit, n, _, _ = bvh.ray_cast(o, -d, reach * 2)
    if hit is None:
        return centre + d * 0.25, d
    return hit, n


# The tack's texture (rider_bake.tack_materials) is two panels side by side: the pad's quilting on the left half, a
# leather panel (grain, a row of stitching inside its edge) on the right. A slab's grid is laid across its panel;
# straps and rods take the plain middle of the leather.
PLAIN = (0.75, 0.5)


def panel_uv(kind, a, b):
    return ((0.01 if kind == 'pad' else 0.51) + 0.48 * a, 0.01 + 0.98 * b)


def slab(name, coll, grid, lo, hi, kind):
    """grid: rows of (point on the skin, outward normal, keep) -> a closed slab between offsets lo and hi along the
    normal; cells whose four corners are kept become faces; the open border is closed with walls"""
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new('UVMap')
    uvs = {}
    R, C = len(grid), len(grid[0])
    top = [[None] * C for _ in range(R)]
    bot = [[None] * C for _ in range(R)]
    for i in range(R):
        for j in range(C):
            p, n, k = grid[i][j]
            if k:
                hi_ = hi(i, j) if callable(hi) else hi
                top[i][j] = bm.verts.new(hi_ if isinstance(hi_, Vector) else p + n * hi_)   # (a Vector: the top's own place)
                bot[i][j] = bm.verts.new(p + n * lo)
                uvs[top[i][j]] = uvs[bot[i][j]] = panel_uv(kind, j / (C - 1), i / (R - 1))
    edges = {}
    def quad(a, b, c, d):
        try:
            bm.faces.new((a, b, c, d))
        except ValueError:
            pass
    for i in range(R - 1):
        for j in range(C - 1):
            q = [(i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)]
            if all(top[a][b] for a, b in q):
                quad(*[top[a][b] for a, b in q])
                quad(*[bot[a][b] for a, b in reversed(q)])
                for k in range(4):
                    e = tuple(sorted((q[k], q[(k + 1) % 4])))
                    edges[e] = edges.get(e, 0) + 1
    for (a, b), cnt in edges.items():
        if cnt == 1:
            quad(top[a[0]][a[1]], top[b[0]][b[1]], bot[b[0]][b[1]], bot[a[0]][a[1]])
    for f in bm.faces:
        for lp in f.loops:
            lp[uvl].uv = uvs[lp.vert]
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = obj_from_bmesh(bm, name, coll)
    ob['kind'] = kind
    return ob


def barrel_grid(bvh, ys, thetas, keep=lambda y, t: True):
    """rows over y, columns over theta (degrees from the top, + toward the horse's left)"""
    g = []
    for y in ys:
        row = []
        for t in thetas:
            a = math.radians(t)
            d = V((math.sin(a), 0.0, math.cos(a)))
            p, n = surface(bvh, barrel_centre(y), d)
            row.append((p, n, keep(y, t)))
        g.append(row)
    return g


def lin(a, b, n):
    return [a + (b - a) * i / (n - 1) for i in range(n)]


def tube(name, coll, pts, r, kind, n=8, flat=1.0, up=V((0, 0, 1))):
    """a strap or a rod along pts: radius r (flat < 1: a strap, wider than thick, its width along up x tangent)"""
    bm = bmesh.new()
    rings = []
    for i, p in enumerate(pts):
        t = (pts[min(len(pts) - 1, i + 1)] - pts[max(0, i - 1)]).normalized()
        s = t.cross(up)
        if s.length < 1e-4:
            s = t.cross(V((1, 0, 0)))
        s.normalize()
        f = t.cross(s).normalized()
        ring = []
        for k in range(n):
            a = 2 * math.pi * k / n
            ring.append(bm.verts.new(p + s * (r * math.cos(a)) + f * (r * flat * math.sin(a))))
        rings.append(ring)
    for a, b in zip(rings, rings[1:]):
        for k in range(n):
            bm.faces.new((a[k], a[(k + 1) % n], b[(k + 1) % n], b[k]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    uvl = bm.loops.layers.uv.new('UVMap')
    for f in bm.faces:
        for lp in f.loops:
            lp[uvl].uv = PLAIN
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = obj_from_bmesh(bm, name, coll)
    ob['kind'] = kind
    return ob


def param_grid(bvh, rows, cols, at):
    """a grid whose every point is placed by at(u, v) -> (y, theta deg), u, v in 0..1: the outline is exact"""
    g = []
    for i in range(rows):
        row = []
        for j in range(cols):
            y, t = at(i / (rows - 1), j / (cols - 1))
            a = math.radians(t)
            d = V((math.sin(a), 0.0, math.cos(a)))
            p, n = surface(bvh, barrel_centre(y), d)
            row.append((p, n, True))
        g.append(row)
    return g


def build():
    arm, body = horse()
    bvh = horse_bvh()
    coll = collection('tack_parts', fresh=True)
    # ---- the pad: a cream jump numnah, forward-cut like the flap it lies under, a hand larger all round
    def pad_at(u, v):
        t = -80 + 160 * u
        k = abs(t) / 80
        front = -0.34 - 0.07 * sm(k, 0.25, 0.8) + 0.05 * sm(k, 0.85, 1.0)
        back = 0.17 - 0.10 * sm(k, 0.55, 1.0)
        return front + (back - front) * v, t
    slab('pad', coll, param_grid(bvh, 36, 22, pad_at), 0.002, 0.009, 'pad')
    # ---- the saddle: a close-contact jumping saddle (refs/rider: modern-gallop-side-01, modern-canter-side-02).
    # The seat is a dish from a low pommel arch over the withers back to a cantle that stands higher than the pommel;
    # its top is drawn as heights above the ground along the horse's midline (the back under it rises to the withers,
    # so a thickness over the skin would make the pommel a lump), and across it falls away to a thin edge that lies
    # on the flaps. In plan it is narrow at the twist and round behind.
    Y0, Y1 = -0.31, 0.118
    # (heights over the skin of the back on the midline, not over the ground: the saddle is slim on any back)
    OVER = [(-0.31, 0.020), (-0.29, 0.038), (-0.26, 0.044), (-0.21, 0.038), (-0.14, 0.033), (-0.07, 0.031), (0.0, 0.036), (0.05, 0.048), (0.085, 0.064), (0.104, 0.070), (0.113, 0.064), (0.118, 0.044)]
    def spine_z(y):
        return surface(bvh, barrel_centre(y), V((0.0, 0.0, 1.0)))[0].z
    # (the withers stand up in front: the pommel clears them by its arch, so its height is taken over the back just
    # behind them)
    PROFILE = [(y, spine_z(max(y, -0.27)) + t) for y, t in OVER]
    def top_z(y):
        for (ya, za), (yb, zb) in zip(PROFILE, PROFILE[1:]):
            if y <= yb:
                t = sm(y, ya, yb)
                return za + (zb - za) * t
        return PROFILE[-1][1]
    def seat_at(u, v):
        # the back corners rounded: the cantle's rim is an arc
        k = abs(2 * u - 1)
        y = Y0 + (Y1 - Y0) * v - 0.085 * (k ** 2.2) * sm(v, 0.45, 1.0)
        half = 12 + 24 * sm(y, -0.28, 0.0)
        return y, half * (2 * u - 1)
    R_, C_ = 29, 30
    seat_grid = param_grid(bvh, R_, C_, seat_at)
    def seat_hi(i, j):
        # the top between the two edges of its row (each lying 16 mm over the skin): domed up to the midline's
        # height; round the cantle the rim stays up almost to the edge
        u, v = 2 * (i / (R_ - 1)) - 1, j / (C_ - 1)
        k = abs(u)
        (pa, na, _), (pb, nb, _) = seat_grid[0][j], seat_grid[R_ - 1][j]
        ea, eb = pa + na * 0.013, pb + nb * 0.013
        e = ea.lerp(eb, (u + 1) / 2)
        y = seat_grid[i][j][0].y
        rim = sm(v, 0.62, 0.95)
        shape = (1 - k ** 2.3) * (1 - rim) + (1 - k ** 4) * rim
        z = e.z + max(0.0, top_z(y) - e.z) * shape
        return Vector((e.x, y, z))
    slab('seat', coll, seat_grid, 0.009, seat_hi, 'leather')
    # ---- the flaps: forward-cut, from under the seat's edge down past the knee, the front edge swept forward and
    # padded into a knee roll, the corners round; u down the barrel, v front to back
    FR, FC = 24, 22
    for sg in (1, -1):
        def flap_at(u, v, sg=sg):
            t = 20 + 64 * u
            front = -0.265 - 0.085 * sm(u, 0.0, 0.55) + 0.05 * sm(u, 0.72, 1.0)
            back = 0.0 - 0.04 * u - 0.07 * sm(u, 0.75, 1.0)
            return front + (back - front) * v, sg * t
        def flap_hi(i, j):
            u, v = i / (FR - 1), j / (FC - 1)
            roll = 0.007 * (1 - sm(v, 0.05, 0.20)) * sm(u, 0.12, 0.28) * (1 - sm(u, 0.78, 0.95))
            edge = min(sm(v, 0.0, 0.05), sm(1 - v, 0.0, 0.05), sm(1 - u, 0.0, 0.04))
            return 0.0105 + (0.0035 + roll) * edge
        slab(f'flap{sg}', coll, param_grid(bvh, FR, FC, flap_at), 0.009, flap_hi, 'leather')
    # ---- the girth: a band round the belly just ahead of her lower leg (refs/rider: modern-gallop-side-01), its
    # ends up under the flaps
    def girth_at(u, v):
        return -0.305 + 0.06 * v, 62 + 236 * u
    slab('girth', coll, param_grid(bvh, 64, 4, girth_at), 0.001, 0.005, 'leather')
    # ---- the bridle
    bridle(coll)
    log('tack parts:', len(coll.objects))


def head_loop(bvh, centre, axis_a, axis_b, n=28, off=0.004, arc=(0, 360)):
    """points on the head's skin round a centre, in the plane of axis_a, axis_b (from outside, inward)"""
    pts = []
    for k in range(n):
        a = math.radians(arc[0] + (arc[1] - arc[0]) * k / (n - 1 if arc != (0, 360) else n))
        d = (axis_a * math.cos(a) + axis_b * math.sin(a)).normalized()
        o = centre + d * 0.5
        hit, nrm, _, _ = bvh.ray_cast(o, -d, 1.0)
        if hit is not None and (hit - centre).length < 0.3:
            pts.append(hit + nrm * off)
    return pts


def bridle(coll):
    """placed along the horse's head bone (poll pivot -> muzzle): the crownpiece just behind the ears, the browband in
    front of them, cheekpieces down the cheeks to the bit rings at the corners of the mouth, the noseband two
    fingers below the cheekbone"""
    bvh = horse_bvh()
    arm, _ = horse()
    hb = arm.data.bones['head']
    h0, h1 = hb.head_local.copy(), hb.tail_local.copy()
    ax = (h1 - h0).normalized()                           # down the face
    side = V((1, 0, 0))
    up = side.cross(ax).normalized()                      # square to the face, toward the forehead / poll's top
    if up.z < 0:
        up = -up
    L = (h1 - h0).length
    at = lambda s_: h0 + ax * (s_ * L)
    muzzle = S(MK['muzzle']['pos'])
    bit = muzzle + V((0, 0.12, 0.04))                     # as Horse.ts pins bitL / bitR (0.12 back, 0.04 up)
    # crownpiece: a band over the poll behind the ears, tilted back (it lies in the hollow behind them)
    tilt = (ax * 0.35 + up).normalized()
    crown = head_loop(bvh, at(-0.04), side, (up - ax * 0.25).normalized(), n=26, arc=(-12, 192))
    tube('crown', coll, crown, 0.011, 'leather', flat=0.35, up=ax)
    # browband: across the forehead, in front of the ears
    brow = head_loop(bvh, at(0.12), side, up, n=20, arc=(22, 158))
    tube('browband', coll, brow, 0.009, 'leather', flat=0.35, up=ax)
    # noseband: round the nose a little over half way down
    nose = head_loop(bvh, at(0.60), side, up, n=34, arc=(0, 360))
    tube('noseband', coll, nose + [nose[0]], 0.010, 'leather', flat=0.35, up=ax)
    for sg in (1, -1):
        ends = [p for p in crown if p.x * sg > 0]
        top = min(ends, key=lambda p: p.z)               # the crownpiece's lower end on this side
        ring = V((sg * 0.058, bit.y, bit.z))
        pts = []
        for k in range(12):
            q = top.lerp(ring, k / 11)
            o = V((sg * 0.35, q.y, q.z))
            hit, nrm, _, _ = bvh.ray_cast(o, V((-sg, 0, 0)), 0.36)
            if k < 11 and hit is not None and hit.x * sg > 0 and (hit - q).length < 0.14:
                pts.append(hit + nrm * 0.005)
            else:
                pts.append(q)
        tube(f'cheek{sg}', coll, pts, 0.010, 'leather', flat=0.35, up=V((1, 0, 0)))
        ringpts = []
        for k in range(17):
            a_ = 2 * math.pi * k / 16
            ringpts.append(ring + V((0, 0.028 * math.cos(a_), 0.028 * math.sin(a_))))
        tube(f'bitring{sg}', coll, ringpts, 0.004, 'metal', n=6, up=V((1, 0, 0)))
    # the mouthpiece through the mouth, ring to ring
    tube('mouthpiece', coll, [V((-0.058, bit.y, bit.z)), V((0.058, bit.y, bit.z))], 0.005, 'metal', n=6)


def join():
    """the pieces as one mesh "tack", with a material slot per kind"""
    coll = bpy.data.collections['tack_parts']
    remove('tack')
    mats = {}
    for kind in ('leather', 'pad', 'metal'):
        m = bpy.data.materials.get('tack_' + kind) or bpy.data.materials.new('tack_' + kind)
        mats[kind] = m
    bm = bmesh.new()
    order = ['leather', 'pad', 'metal']
    for o in coll.objects:
        k = o.get('kind', 'leather')
        b = bmesh.new()
        b.from_mesh(o.data)
        for f in b.faces:
            f.material_index = order.index(k)
        me = bpy.data.meshes.new('tmp')
        b.to_mesh(me)
        b.free()
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
    ob = obj_from_bmesh(bm, 'tack')
    for k in order:
        ob.data.materials.append(mats[k])
    for p in ob.data.polygons:
        p.use_smooth = True
    coll.hide_viewport = True
    log('tack:', len(ob.data.polygons), 'faces')
    return ob


if __name__ == '__main__' and globals().get('RUN', True):
    build()
    join()
