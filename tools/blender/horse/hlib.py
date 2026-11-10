"""
Shared helpers for the horse build scripts (Blender 5.1). The horse is designed in the side view
(tools/gait/design-gallop.ts -> gallop.design.json): x forward, y up, metres, ground at y = 0, plus a lateral offset.
In Blender that is X = left, -Y = forward, Z = up, which the glTF exporter turns into the runtime's +Z forward, +Y up.
"""
import bpy, bmesh, json, math, os
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
WORK = os.path.join(REPO, 'build', 'blender', 'horse')
os.makedirs(WORK, exist_ok=True)


def log(*a):
    print('[horse]', *a, flush=True)


def design():
    with open(os.path.join(HERE, 'gallop.design.json'), encoding='utf8') as f:
        return json.load(f)


def S(p, lat=0.0):
    """side-view point (x forward, y up) and a lateral offset (left +) -> Blender"""
    return Vector((lat, -p[0], p[1]))


class Rest:
    """the rest pose: bone heads and tails in the side view, by name"""

    def __init__(self, d):
        self.d = d
        self.bones = {b['name']: b for b in d['rest']['bones']}
        self.markers = d['rest']['markers']

    def head(self, n):
        return Vector(self.bones[n]['head'])

    def tail(self, n):
        return Vector(self.bones[n]['tail'])

    def mk(self, n):
        return Vector(self.markers[n]['pos'])


def lerp(a, b, t):
    return a + (b - a) * t


def perp(v):
    """a side-view vector turned 90 degrees counter-clockwise (forward -> up)"""
    return Vector((-v[1], v[0]))


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
        if o is not None and o.name in bpy.context.view_layer.objects:
            try:
                o.select_set(False)
            except RuntimeError:
                pass
    ob.hide_set(False)
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob


def purge():
    for coll in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials, bpy.data.images, bpy.data.actions):
        for b in list(coll):
            if b.users == 0:
                coll.remove(b)


def tail_points(R):
    """the tail's centre line in the side view: dock, then the hair falling behind the hocks"""
    j3, croup, buttock = R.head('pelvis'), R.mk('croup'), R.mk('buttock')
    t0 = Vector((buttock[0], croup[1] - 0.15))
    return [t0 + Vector(o) for o in ((0.07, 0.04), (0.0, -0.01), (-0.06, -0.11), (-0.1, -0.36), (-0.12, -0.68), (-0.13, -1.0))]


def ear_points(R, sg):
    """an ear's base and tip (Blender space) on the side sg (+1 left)"""
    atlas, hd = R.head('head'), (R.tail('head') - R.head('head')).normalized()
    hu = perp(hd)
    base = atlas + hd * 0.005 + hu * 0.07
    tip = base + hu * 0.165 + hd * -0.01
    return S(base, sg * 0.058), S(tip, sg * 0.085), base, tip


def pose_matrices(arm_ob, rot, chest=None):
    """
    Armature-space pose matrices for side-view rotations: rot[bone] is the bone's turn from rest, counter-clockwise
    in the side view (forward towards up), absolute (not relative to its parent); chest is the root bone's head in
    the side view. Bones not in rot follow their parent rigidly. Returns {bone: (pose matrix, basis matrix)}.
    """
    out = {}
    for b in arm_ob.data.bones:  # parents come first
        Mr = b.matrix_local
        par = b.parent
        if par is None:
            head = S(chest) if chest is not None else Mr.translation.copy()
        else:
            Pp, _ = out[par.name]
            head = Pp @ par.matrix_local.inverted() @ Mr.translation
        if b.name in rot:
            Rm = Matrix.Rotation(-rot[b.name], 4, 'X') @ Mr.to_3x3().to_4x4()
        elif par is not None:
            Rm = (out[par.name][0] @ par.matrix_local.inverted() @ Mr).to_3x3().to_4x4()
        else:
            Rm = Mr.to_3x3().to_4x4()
        Mp = Rm.copy()
        Mp.translation = head
        if par is None:
            basis = Mr.inverted() @ Mp
        else:
            basis = (par.matrix_local.inverted() @ Mr).inverted() @ (out[par.name][0].inverted() @ Mp)
        out[b.name] = (Mp, basis)
    return out


def apply_pose(arm_ob, rot, chest=None):
    M = pose_matrices(arm_ob, rot, chest)
    for pb in arm_ob.pose.bones:
        pb.rotation_mode = 'QUATERNION'
        pb.matrix_basis = M[pb.name][1]
    return M


def chest_origin(R):
    """the chest frame's origin (the base of the withers), side view"""
    return R.head('chest') + Vector((0.2, 0.32))


def neck_lines(R):
    """the neck's crest and underline (functions of t, 0 at the withers .. 1 at the poll) and its half width"""
    import math
    chest0 = chest_origin(R)
    top_w = R.mk('withers')[1] - chest0[1]
    atlas, hd = R.head('head'), (R.tail('head') - R.head('head')).normalized()
    hu = perp(hd)
    top0, top1 = chest0 + Vector((0.0, top_w + 0.005)), atlas + hd * -0.03 + hu * 0.08
    bot0, bot1 = R.head('humerus.L') + Vector((0.05, 0.03)), atlas + hd * 0.075 + hu * -0.165
    nt, nb = perp((top1 - top0).normalized()), perp((bot1 - bot0).normalized())
    cl = lambda t: min(1.0, max(0.0, t))
    crest = lambda t: lerp(top0, top1, t) + nt * (0.075 * math.sin(math.pi * cl(t) ** 0.8) ** 1.1)
    under = lambda t: lerp(bot0, bot1, t) + nb * (0.06 * math.sin(math.pi * cl(t) ** 1.3))
    hw = lambda t: lerp(0.19, 0.07, cl(t) ** 0.7)
    return crest, under, hw


def neck_side(R, t, depth):
    """half width of the neck at a depth below the crest at t (the neck's section is narrow at the crest)"""
    import math
    crest, under, hw = neck_lines(R)
    half = (crest(t) - under(t)).length / 2
    sv = max(-1.0, min(1.0, 1 - depth / max(half, 1e-6)))
    w = hw(t) * (0.55 + 0.45 * (1 - max(0.0, sv)) ** 0.8)
    return w * math.sqrt(max(0.0, 1 - sv * sv))


HALF_BONES = {f'{child}Half.{sd}': (parent if '.' not in parent else None, f'{child}.{sd}', parent.replace('*', sd))
              for sd in ('L', 'R') for child, parent in (('femur', 'pelvis'), ('humerus', 'scapula.*'))}


def key_rot(D, k):
    """
    Every bone's turn from rest (side view, absolute) at key k of the designed gallop: the design's own bones, the
    half-way bones that carry the muscle over the hips and shoulders (half the turn between a bone and its parent),
    and what the plate does not show, on the stride's period: the tail carried out behind and streaming with a wave
    running down it, the mane lifting off the neck and falling back, the ears laid back.
    """
    import math
    K = D['keys']
    n = K['n']
    k %= n
    rot = {b: K['rot'][b][k] for b in K['rot']}
    for name, (_, child, parent) in HALF_BONES.items():
        rot[name] = (rot[child] + rot[parent]) / 2
    ph = 2 * math.pi * k / n
    pel = rot['pelvis']
    for i, (base, amp) in enumerate(((-22, 5), (-36, 11), (-30, 18), (-20, 26))):
        rot[f'tail{i + 1}'] = pel + math.radians(base + amp * math.sin(ph - 1.15 * i - 0.6) + 0.35 * amp * math.sin(2 * ph - 0.8 * i))
    for i in range(5):
        nk = rot[f'neck{min(3, 1 + (i * 3) // 5)}']
        rot[f'mane{i + 1}'] = nk + math.radians(-26 - (16 + 3 * i) * math.sin(ph - 1.3 * i + 0.4) - 10 * math.sin(2 * ph + 2.1 * i))
    for sd in ('L', 'R'):
        rot[f'ear.{sd}'] = rot['head'] + math.radians(-20 + 4 * math.sin(ph + (0.5 if sd == 'L' else 1.3)))
    return rot
