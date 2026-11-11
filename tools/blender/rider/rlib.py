"""
Shared helpers for the rider build (Blender 5.1): the gallop seat she is posed into and her joints in it, the
horse's surface for fitting, the GPU check for Cycles.

Coordinates are the horse build's: Blender world, X = the horse's left, -Y = forward, Z = up, metres, ground at 0,
the horse at its rest pose (tools/blender/horse). The rider's body is a human base mesh (rider_body) posed once into
the pose she rides in and frozen there, so her rest pose is the riding pose and the gallop only moves her a little
off it.
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else 'F:/valley-ride/tools/blender/rider'
REPO = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
WORK = os.path.join(REPO, 'build', 'blender', 'rider')
HORSE_BLEND = os.path.join(REPO, 'build', 'blender', 'horse', 'horse.blend')
os.makedirs(WORK, exist_ok=True)
V = Vector


def log(*a):
    print('[rider]', *a, flush=True)


# ----------------------------------------------------------------------------- the gallop seat, and her joints in it
# The seat she is posed into (rider_body.pose), in the horse's frame. Measured on refs/rider (modern-gallop-side-01,
# modern-canter-side-02, the Muybridge plates) over gauntlet rounds 3-5: the pelvis down in the deepest part of the
# saddle's seat, the trunk folded ~30 deg forward from the hips with the lumbar spine taking the bend and the head
# carried up, looking ahead; the thigh ~58 deg below the horizontal (side view) and round the flap, the knee against
# it; the lower leg ~24 deg behind the vertical with the calf on the horse's side, so the ball of the foot in the
# iron comes under her seat, heel below it; the fists low over the withers, a hand's width apart.
SEAT = {
    'pelvis': (0.0, -0.055, 1.780),        # the hip centre (the pelvis bone's head); its height comes from the saddle:
    'sit': 0.078,                          # ... this far over the seat's top (flesh and cloth pressed under her)
    'pelvis_tilt': 12.0,                   # degrees forward
    'spine': (7.0, 6.0, 5.0),              # more, at each of the three spine joints: 30 in all
    'neck': -8.0, 'head': -15.0,           # the head back up
    'knee_out': 0.286,                     # the knee joint's distance from the horse's midline
    'thigh_drop': 58.0,                    # the thigh below the horizontal, seen from the side
    'shin': (-0.036, 0.150, -0.366),       # knee -> ankle, a direction
    'toe_out': 12.0, 'heel_down': 20.0,
    'wrist': (0.110, -0.490, 1.800),
    'elbow_hint': (0.45, 0.35, -1.0),      # which way the elbow points: down, a little out and back
    'bar': (0.120, -0.275, 1.660),         # the stirrup bar on the saddle
}

JFILE = os.path.join(HERE, 'joints.json')


def load_joints():
    """her joints in the riding pose, written by rider_body.joints() from the posed body"""
    import json
    if not os.path.exists(JFILE):
        return {}
    return {k: V(v) for k, v in json.load(open(JFILE, encoding='utf8')).items()}


J = load_joints()


def pony_points():
    """the ponytail's line: from the tie at the back of the crown, out behind the head and down between the shoulder
    blades (it hangs; the head's tilt carries its root)"""
    tie, head, crown = J['tie'], J['head'], J['crown']
    up = (crown - head).normalized()
    back = V((0, 1, 0))
    back = (back - up * back.dot(up)).normalized()
    down = V((0, 0, -1))
    pts = [tie]
    for along, d in ((0.055, (back * 0.9 + up * 0.25)), (0.075, (back * 0.55 + down * 0.8)), (0.085, (back * 0.2 + down)), (0.085, (back * 0.08 + down))):
        pts.append(pts[-1] + d.normalized() * along)
    return pts


# ----------------------------------------------------------------------------- objects
def obj_from_bmesh(bm, name, coll=None):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    (coll or bpy.context.scene.collection).objects.link(ob)
    return ob


def collection(name, fresh=False):
    c = bpy.data.collections.get(name)
    if c and fresh:
        for o in list(c.objects):
            bpy.data.objects.remove(o, do_unlink=True)
    if not c:
        c = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(c)
    return c


def remove(name):
    o = bpy.data.objects.get(name)
    if o:
        bpy.data.objects.remove(o, do_unlink=True)


def activate(ob):
    for o in list(bpy.context.view_layer.objects):
        try:
            o.select_set(False)
        except (RuntimeError, AttributeError):
            pass
    ob.hide_set(False)
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob


def horse():
    """the horse's rig and body, appended from the horse build's .blend if they are not in the scene"""
    if not bpy.data.objects.get('horse_rig'):
        with bpy.data.libraries.load(HORSE_BLEND, link=False) as (src, dst):
            dst.objects = [n for n in src.objects if n in ('horse_rig', 'horse', 'horse_hair')]
        for o in dst.objects:
            if o:
                bpy.context.scene.collection.objects.link(o)
        log('horse appended from', HORSE_BLEND)
    return bpy.data.objects['horse_rig'], bpy.data.objects['horse']


def horse_bvh(pose=False):
    """the horse's surface as a BVH (rest pose unless pose=True: the current frame)"""
    arm, body = horse()
    old = arm.data.pose_position
    arm.data.pose_position = 'POSE' if pose else 'REST'
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    bvh = BVHTree.FromObject(body, dg)
    arm.data.pose_position = old
    bpy.context.view_layer.update()
    return bvh


def crossings(tree, p, d, reach=4.0):
    n, o = 0, p.copy()
    for _ in range(64):
        hit, _, _, _ = tree.ray_cast(o, d, reach)
        if hit is None:
            break
        n += 1
        o = hit + d * 1e-5
    return n


_D1, _D2 = V((0.31, 0.17, 0.935)).normalized(), V((-0.27, -0.41, -0.87)).normalized()


def inside(tree, p):
    """p is inside the closed surface in tree (an odd number of crossings, both ways agreeing). The tack's parts are
    thin closed shells: the sign of the nearest face's normal is not a safe test there, the parity of crossings is."""
    return crossings(tree, p, _D1) % 2 == 1 and crossings(tree, p, _D2) % 2 == 1


# ----------------------------------------------------------------------------- lofting
def frames(points, side_hint):
    """per point: tangent, side (the hint made square to the tangent), front (tangent x side)"""
    out = []
    n = len(points)
    for i in range(n):
        t = (points[min(n - 1, i + 1)] - points[max(0, i - 1)]).normalized()
        h = side_hint[i] if isinstance(side_hint, list) else side_hint
        s = (h - t * h.dot(t)).normalized()
        f = t.cross(s).normalized()
        out.append((t, s, f))
    return out


def catmull(pts, n):
    """n points through a Catmull-Rom spline of pts (tuples of floats or Vectors packed as tuples)"""
    m = len(pts)
    out = []
    for k in range(n):
        t = k / (n - 1) * (m - 1)
        i = min(m - 2, int(t))
        f = t - i
        p0, p1, p2, p3 = pts[max(0, i - 1)], pts[i], pts[i + 1], pts[min(m - 1, i + 2)]
        out.append(tuple(0.5 * ((2 * b) + (-a + c) * f + (2 * a - 5 * b + 4 * c - d) * f * f + (-a + 3 * b - 3 * c + d) * f ** 3)
                         for a, b, c, d in zip(p0, p1, p2, p3)))
    return out


def loft(name, coll, stations, side=V((1, 0, 0)), n=20, p=1.0, smooth=0, caps=True, front_bias=None):
    """
    A closed tube through stations (centre Vector, half-width along side, half-depth along front[, front offset]).
    front is tangent x side; for a body part running up with side = +X, front is -Y (forward). front_bias shifts a
    ring's centre along front (a calf's bulge behind the shin, a belly's in front).
    """
    rows = [tuple(c) + (rs, rf, (st[3] if len(st) > 3 else 0.0)) for st in stations for c, rs, rf in [st[:3]]]
    if smooth:
        rows = catmull(rows, smooth)
    pts = [V(r[:3]) for r in rows]
    fr = frames(pts, side)
    bm = bmesh.new()
    rings = []
    for (t, s, f), r, c in zip(fr, rows, pts):
        rs, rf, off = r[3], r[4], r[5]
        cc = c + f * off
        ring = []
        for i in range(n):
            a = 2 * math.pi * i / n
            ca, sa = math.cos(a), math.sin(a)
            ring.append(bm.verts.new(cc + s * (rs * math.copysign(abs(ca) ** p, ca)) + f * (rf * math.copysign(abs(sa) ** p, sa))))
        rings.append(ring)
    for a, b in zip(rings, rings[1:]):
        for i in range(n):
            bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
    if caps:
        bm.faces.new(list(reversed(rings[0])))
        bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return obj_from_bmesh(bm, name, coll)


def ellipsoid(name, coll, c, axes, radii, seg=24, rings=14):
    """axes: three orthonormal Vectors, radii along them"""
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=1.0)
    M = Matrix((axes[0] * radii[0], axes[1] * radii[1], axes[2] * radii[2])).transposed()
    for v in bm.verts:
        v.co = c + M @ v.co
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return obj_from_bmesh(bm, name, coll)


# ----------------------------------------------------------------------------- Cycles on the GPU
def gpu_cycles(scene, allow_cpu=False):
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.get_devices()
    chosen = None
    for kind in ('OPTIX', 'CUDA'):
        try:
            prefs.compute_device_type = kind
        except TypeError:
            continue
        prefs.get_devices()
        devs = [d for d in prefs.devices if d.type == kind]
        if devs:
            for d in prefs.devices:
                d.use = d.type == kind
            chosen = (kind, [d.name for d in devs])
            break
    scene.render.engine = 'CYCLES'
    if chosen:
        scene.cycles.device = 'GPU'
        log('[gpu] Cycles on', chosen[0], chosen[1])
    elif allow_cpu:
        scene.cycles.device = 'CPU'
        log('[gpu] WARNING: no GPU for Cycles, on the CPU')
    else:
        raise SystemExit('no OptiX / CUDA device for Cycles: refusing to run on the CPU')
