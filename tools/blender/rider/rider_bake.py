"""
rider_bake.py - the rider's textures and materials (Cycles on the RTX 4060, asserted by rlib.gpu_cycles).

Her surface is painted per vertex from what the mesh knows (the base mesh's own regions: lips, scalp, ears, nails;
the garment each face belongs to; her joints), given its fine grain by procedural detail in the bake materials, and
baked onto her own UVs:

  rider_skin_c   2048  skin: tone, the flush of cheeks, nose, ears, knees, elbows and knuckles, lips, lids and lash
                       lines, the hair's roots on the scalp; then her brows, drawn hair by hair onto the texture
  rider_skin_orm 1024  occlusion (baked, the horse and saddle in the scene), roughness, metal 0
  rider_cloth_c  2048  the ribbed top, the denim (washed, flecked, worn paler where it bears), the boots' leather
  rider_cloth_n  2048  the folds a seated, forward-folded body puts in them, the rib, the weave, the boots' creases
  rider_cloth_orm 1024
  rider_eye      256   an eye: sclera, iris, pupil (numpy)
  rider_hair     1024  strands for the hair cards, 8 columns (numpy): dark roots to pale tips

The tack and the stirrups get plain materials: leather, the saddle pad, steel.
"""
import bpy, bmesh, os, sys, math
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else 'F:/valley-ride/tools/blender/rider')
import importlib, rlib
importlib.reload(rlib)
from rlib import log, gpu_cycles, activate, WORK

V = Vector
TOP, SHORTS, BOOTS, EYE, LASHES = 1, 2, 3, 4, 5

# linear colours
SKIN = (0.44, 0.265, 0.17)             # a light skin with some sun on it
FLUSH = (0.50, 0.22, 0.17)
LIP = (0.40, 0.19, 0.16)
LID = (0.40, 0.235, 0.17)
LASH = (0.075, 0.048, 0.03)
SOCKET = (0.42, 0.24, 0.20)
NAIL = (0.56, 0.36, 0.30)
ROOT = (0.15, 0.105, 0.055)             # the hair's roots, on the scalp under the cards
BROW = (0.27, 0.20, 0.12)
TOP_C = (0.66, 0.64, 0.60)              # an off-white ribbed tank top
DENIM = (0.058, 0.098, 0.19)
DENIM_WORN = (0.19, 0.27, 0.40)
THREAD = (0.42, 0.27, 0.11)           # the jeans' stitching
BOOT = (0.040, 0.022, 0.013)
SOLE = (0.012, 0.011, 0.010)
HAIR_ROOT, HAIR_MID, HAIR_TIP = (0.21, 0.155, 0.08), (0.47, 0.37, 0.20), (0.60, 0.50, 0.30)


def image(name, size, data=False, alpha=False, floats=False):
    im = bpy.data.images.get(name)
    if im and (tuple(im.size) != tuple(size) or im.is_float != floats):
        bpy.data.images.remove(im)
        im = None
    if not im:
        im = bpy.data.images.new(name, size[0], size[1], alpha=alpha, float_buffer=floats)
    im.colorspace_settings.name = 'Non-Color' if data else 'sRGB'
    return im


def save(im):
    im.filepath_raw = os.path.join(WORK, im.name + '.png')
    im.file_format = 'PNG'
    im.save()


def gauss(d, s):
    return np.exp(-(d / s) ** 2)


def smooth(x, a, b):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


# ----------------------------------------------------------------------------- UVs
def unwrap():
    """skin keeps the base mesh's UVs; the clothes get their own layout; each eye is seen from the front"""
    ob = bpy.data.objects['rider']
    J = rlib.load_joints()
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    part = bm.faces.layers.int['part']
    uv = bm.loops.layers.uv.active
    side = V((1, 0, 0))
    hup = (J['crown'] - J['head']).normalized()
    hfwd = hup.cross(side).normalized()
    hfwd = hfwd if hfwd.y < 0 else -hfwd
    # her gaze: ahead to where she is going, lifted from the face's own forward (her head is tipped down a little)
    gaze = (hfwd * 0.45 + V((0, -1, 0)) * 0.55).normalized()
    up = gaze.cross(side).normalized()
    up = up if up.z > 0 else -up
    for sg in (1, -1):
        fs = [f for f in bm.faces if f[part] == EYE and f.calc_center_median().x * sg > 0]
        vs = {v for f in fs for v in f.verts}
        c = sum((v.co for v in vs), V()) / len(vs)
        r = max((v.co - c).length for v in vs)
        for f in fs:
            for lp in f.loops:
                d = lp.vert.co - c
                lp[uv].uv = (0.5 + d.dot(side) / (2 * r) * 0.98, 0.5 + d.dot(up) / (2 * r) * 0.98)
    # the eyelash strips (the base mesh's own): each across one half of the lash texture - the upper lid's on the
    # left half, the lower's on the right - with its roots (the edge on the lid) at v = 1
    eyes_c = {}
    for sg in (1, -1):
        ps = [v.co for f in bm.faces if f[part] == EYE for v in f.verts if v.co.x * sg > 0]
        eyes_c[sg] = sum(ps, V()) / len(ps)
    seen = set()
    for f0 in [f for f in bm.faces if f[part] == LASHES]:
        if f0 in seen:
            continue
        isl, stack = [], [f0]
        seen.add(f0)
        while stack:
            g = stack.pop()
            isl.append(g)
            for v in g.verts:
                for h in v.link_faces:
                    if h[part] == LASHES and h not in seen:
                        seen.add(h)
                        stack.append(h)
        loops = [lp for f in isl for lp in f.loops]
        us, vs_ = [lp[uv].uv.x for lp in loops], [lp[uv].uv.y for lp in loops]
        u0, u1, v0, v1 = min(us), max(us), min(vs_), max(vs_)
        cen = sum((lp.vert.co for lp in loops), V()) / len(loops)
        ec = eyes_c[1 if cen.x > 0 else -1]
        upper = (cen - ec).dot(hup) > 0
        # which edge is the root: the one nearer the eye
        near = [lp for lp in loops if (lp[uv].uv.y - v0) / (v1 - v0) < 0.5]
        far = [lp for lp in loops if (lp[uv].uv.y - v0) / (v1 - v0) >= 0.5]
        dn = sum((lp.vert.co - ec).length for lp in near) / max(1, len(near))
        df = sum((lp.vert.co - ec).length for lp in far) / max(1, len(far))
        for lp in loops:
            a_ = (lp[uv].uv.x - u0) / (u1 - u0)
            b_ = (lp[uv].uv.y - v0) / (v1 - v0)
            root = (1 - b_) if dn < df else b_
            lp[uv].uv = ((0.02 + 0.46 * a_) + (0.0 if upper else 0.5), 0.02 + 0.96 * root)
    bm.to_mesh(me)
    bm.free()
    activate(ob)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='DESELECT')
    bpy.ops.object.mode_set(mode='OBJECT')
    pa = np.zeros(len(me.polygons), dtype=np.int32)
    me.attributes['part'].data.foreach_get('value', pa)
    sel = (pa >= TOP) & (pa <= BOOTS)
    me.polygons.foreach_set('select', sel)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.006, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    # ---- the skin's atlas, repacked for where she is looked at: her face keeps its texels, the rest of her skin
    # (smooth, a few tones) takes a third of that: most of the texture is her face
    bm = bmesh.new()
    bm.from_mesh(me)
    part = bm.faces.layers.int['part']
    uv = bm.loops.layers.uv.active
    skull = J['skull']
    key = lambda lp: (round(lp[uv].uv.x, 5), round(lp[uv].uv.y, 5))
    seen, islands = set(), []
    for f in bm.faces:
        if f[part] != 0 or f in seen:
            continue
        isl, stack = [], [f]
        seen.add(f)
        while stack:
            g = stack.pop()
            isl.append(g)
            for lp in g.loops:
                for o in lp.edge.link_loops:
                    h = o.face
                    if h in seen or h[part] != 0:
                        continue
                    if key(lp) in {key(l) for l in h.loops}:      # (joined in UV space too)
                        seen.add(h)
                        stack.append(h)
        islands.append(isl)
    for isl in islands:
        cen = sum((f.calc_center_median() for f in isl), V()) / len(isl)
        face_ = (cen - skull).length < 0.13 and (cen - skull).dot(hfwd) > -0.02
        k = 1.0 if face_ else 0.34
        loops = [lp for f in isl for lp in f.loops]
        c = sum((lp[uv].uv for lp in loops), Vector((0, 0))) / len(loops)
        for lp in loops:
            lp[uv].uv = c + (lp[uv].uv - c) * k
    bm.to_mesh(me)
    bm.free()
    me.polygons.foreach_set('select', pa == 0)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.hide(unselected=True)             # (only the skin's islands are packed: the clothes and eyes keep theirs)
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.pack_islands(rotate=False, margin=0.003)
    bpy.ops.mesh.reveal()
    bpy.ops.object.mode_set(mode='OBJECT')
    log(f'unwrapped: {len(islands)} skin islands repacked for the face, clothes on their own layout, eyes from the front')


# ----------------------------------------------------------------------------- paint
def paint():
    """per vertex: Col (linear colour), rough, and for the clothes fold (how deep the folds are here), foldc (the
    coordinate the folds run across, metres), fleck (how much the weave shows)"""
    ob = bpy.data.objects['rider']
    J = rlib.load_joints()
    me = ob.data
    n = len(me.vertices)
    P = np.zeros(n * 3)
    me.vertices.foreach_get('co', P)
    P = P.reshape(-1, 3)
    pa = np.zeros(len(me.polygons), dtype=np.int32)
    me.attributes['part'].data.foreach_get('value', pa)
    vpart = np.zeros(n, dtype=np.int32)
    for p in me.polygons:
        for v in p.vertices:
            vpart[v] = pa[p.index]
    def attr(name):
        a = np.zeros(n)
        me.attributes[name].data.foreach_get('value', a)
        return a
    lips, scalp, ears, nails = attr('m_lips'), attr('m_scalp'), attr('m_ears'), attr('m_fingernails')
    j = lambda k: np.array(J[k])
    dist = lambda k: np.linalg.norm(P - j(k), axis=1)
    up = np.array((J['crown'] - J['head']).normalized())
    fwd = np.cross(up, np.array((1.0, 0, 0)))
    fwd = fwd if fwd[1] < 0 else -fwd
    col = np.tile(np.array(SKIN), (n, 1))
    rough = np.full(n, 0.62)
    fold, foldc, fleck = np.zeros(n), np.zeros(n), np.zeros(n)
    mix = lambda c, to, t: c + (np.array(to) - c) * np.clip(t, 0, 1)[:, None]
    skin = vpart == 0
    # ---- her eyes' places: each eye's centre and radius
    eyes = []
    for sg in (1, -1):
        m = (vpart == EYE) & (P[:, 0] * sg > 0)
        c = P[m].mean(0)
        eyes.append((sg, c, np.linalg.norm(P[m] - c, axis=1).max()))
    # ---- the flush: cheeks, the nose's tip, chin, ears; knees, elbows, knuckles, the shoulders' tops
    flush = np.zeros(n)
    for sg, c, r in eyes:
        cheek = c - up * 0.040 + np.array((sg * 0.022, 0, 0)) + fwd * 0.004
        flush += 0.75 * gauss(np.linalg.norm(P - cheek, axis=1), 0.024)
    mid = (eyes[0][1] + eyes[1][1]) / 2
    nose = mid - up * 0.034 + fwd * 0.034
    flush += 0.55 * gauss(np.linalg.norm(P - nose, axis=1), 0.013)
    flush += 0.25 * gauss(np.linalg.norm(P - (mid - up * 0.088 + fwd * 0.012), axis=1), 0.016)
    flush += 0.5 * ears
    for S in 'LR':
        flush += 0.5 * gauss(dist(f'knee.{S}'), 0.055) + 0.4 * gauss(dist(f'elbow.{S}'), 0.04) + 0.45 * gauss(dist(f'knuckle.{S}'), 0.03)
        flush += 0.22 * gauss(np.linalg.norm(P - (j(f'shoulder.{S}') + np.array((0, 0, 0.035))), axis=1), 0.05)
    col = np.where(skin[:, None], mix(col, FLUSH, flush * 0.7), col)
    # ---- lips, nails, the scalp under the hair
    col = np.where(skin[:, None], mix(col, LIP, lips * 0.72), col)
    rough = np.where(skin, rough - 0.2 * lips - 0.22 * nails, rough)
    col = np.where(skin[:, None], mix(col, NAIL, nails * 0.8), col)
    # (the scalp's edge softened over a few rings of vertices: roots thin out into the forehead, they do not stop
    # at a line)
    ev = np.zeros(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get('vertices', ev)
    ea, eb = ev[0::2], ev[1::2]
    deg = np.bincount(ea, minlength=n) + np.bincount(eb, minlength=n)
    soft = scalp.copy()
    for _ in range(3):
        acc = np.bincount(ea, weights=soft[eb], minlength=n) + np.bincount(eb, weights=soft[ea], minlength=n)
        soft = 0.4 * soft + 0.6 * acc / np.maximum(deg, 1)
    soft = np.maximum(scalp * 0.92, soft) * skin
    col = np.where(skin[:, None], mix(col, ROOT, soft), col)
    rough = np.where(skin, rough + 0.25 * soft, rough)
    # ---- the eyes' sockets: the skin that lies on the eyeball is the socket's inside; the lids' edges round it
    # carry the lashes (the upper lid's darker and thicker), the lids themselves are a little deeper in tone
    for sg, c, r in eyes:
        d = np.linalg.norm(P - c, axis=1)
        inside_ = skin & (d < r + 0.0009)
        rel = (P - c) @ up
        lash = skin & (d >= r + 0.0009) & (d < r + 0.0042) & (((P - c) @ fwd) > 0.004)
        lid = skin & (d < r + 0.013) & (((P - c) @ fwd) > 0.0)
        col = np.where(lid[:, None], mix(col, LID, np.full(n, 0.12) * smooth(r + 0.013 - d, 0, 0.008) * (0.25 + 0.75 * (rel > 0.002))), col)
        col = np.where(lash[:, None], mix(col, LASH, np.where(rel > 0.0, 0.85, 0.16)), col)
        col = np.where(inside_[:, None], np.array(SOCKET), col)
    # ---- the clothes
    top, shorts, boots = vpart == TOP, vpart == SHORTS, vpart == BOOTS
    hips, chest = j('hips'), j('chest')
    trunk = (j('neck') - hips) / np.linalg.norm(j('neck') - hips)
    h = (P - hips) @ trunk
    col[top] = TOP_C
    rough[top] = 0.82
    fleck[top] = 0.25
    foldc[top] = h[top]
    hb = np.abs(attr('hemband'))
    front = ((P - hips) @ fwd) > -0.02
    # folded forward from the hips: the top gathers in creases across the belly and waist, fading up the ribs
    fold[top] = (0.05 + 0.55 * np.clip(1 - (h - 0.08) / 0.16, 0, 1) * np.where(front, 1.0, 0.3))[top]
    col[shorts] = DENIM
    rough[shorts] = 0.78
    fleck[shorts] = 1.0
    # denim wears paler where it bears and rubs: the thighs' tops, the seat, the hems
    for S in 'LR':
        hp, kn = j(f'hip.{S}'), j(f'knee.{S}')
        ax = (kn - hp) / np.linalg.norm(kn - hp)
        t = (P - hp) @ ax
        radial = P - hp - t[:, None] * ax
        rd = np.linalg.norm(radial, axis=1) + 1e-9
        sidem = shorts & ((P[:, 0] > 0) == (S == 'L'))
        topside = np.clip((radial @ (fwd * 0.5 + np.array((0, 0, 1.0)) * 0.8)) / rd, 0, 1)
        wear = 0.42 * topside * smooth(t, 0.02, 0.10)
        col = np.where(sidem[:, None], mix(col, DENIM_WORN, wear), col)
        # the whiskers: creases fanning from the hip's fold across the lap
        crease = np.linalg.norm(P - (hp + fwd * 0.06 + np.array((0, 0, 0.03))), axis=1)
        foldc = np.where(sidem, crease, foldc)
        fold = np.where(sidem, 0.06 + 0.6 * np.clip(1 - crease / 0.13, 0, 1), fold)
    for S in 'LR':
        m = boots & ((P[:, 0] > 0) == (S == 'L'))
        an, kn = j(f'ankle.{S}'), j(f'knee.{S}')
        ax = (kn - an) / np.linalg.norm(kn - an)
        t = (P - an) @ ax
        foldc = np.where(m, t, foldc)
        fold = np.where(m, 0.03 + 0.7 * gauss(t - 0.03, 0.045), fold)
        sole = m & (((P - j(f'tread.{S}')) @ -np.array((J[f'eye.{S}'] - J[f'tread.{S}']).normalized())) > -0.012)
        col[m] = BOOT
        rough[m] = 0.36
        col[sole] = SOLE
        rough[sole] = 0.8
    # freckles: over the nose and the cheeks under the eyes (the bake material scatters them where this is high)
    frk = gauss(np.linalg.norm(P - (mid - up * 0.03 + fwd * 0.02), axis=1), 0.05) * skin
    for name, kind, data in (('Col', 'color', col), ('rough', 'f', rough), ('fold', 'f', fold), ('foldc', 'f', foldc), ('fleck', 'f', fleck), ('freckle', 'f', frk)):
        if kind == 'color':
            a = me.color_attributes.get(name) or me.color_attributes.new(name, 'FLOAT_COLOR', 'POINT')
            a.data.foreach_set('color', np.hstack([data, np.ones((n, 1))]).astype(np.float32).ravel())
        else:
            a = me.attributes.get(name) or me.attributes.new(name, 'FLOAT', 'POINT')
            a.data.foreach_set('value', data.astype(np.float32))
    log('painted', n, 'vertices')


# ----------------------------------------------------------------------------- materials
def nodes_for(name):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for x in list(nt.nodes):
        nt.nodes.remove(x)
    return m, nt


def N(nt, kind, **props):
    x = nt.nodes.new(kind)
    for k, v in props.items():
        setattr(x, k, v)
    return x


def math_(nt, op, a, b=None, c=None):
    x = N(nt, 'ShaderNodeMath', operation=op)
    for i, v in enumerate((a, b, c)):
        if v is None:
            continue
        if isinstance(v, (int, float)):
            x.inputs[i].default_value = v
        else:
            nt.links.new(v, x.inputs[i])
    return x.outputs[0]


def ramp(nt, x, a, b):
    """0 below a, 1 above b, a straight line between"""
    t = math_(nt, 'DIVIDE', math_(nt, 'SUBTRACT', x, a), b - a)
    return math_(nt, 'MINIMUM', math_(nt, 'MAXIMUM', t, 0.0), 1.0)


def source_materials():
    """the materials the bake reads: painted attributes with procedural grain. Returns per material the sockets
    (colour, roughness) and the node tree"""
    out = {}
    # ---- skin: the paint, mottled a little (blood near the surface), with the fine unevenness of skin
    m, nt = nodes_for('rider_skin_src')
    o = N(nt, 'ShaderNodeOutputMaterial')
    b = N(nt, 'ShaderNodeBsdfPrincipled')
    ca = N(nt, 'ShaderNodeAttribute', attribute_name='Col')
    ra = N(nt, 'ShaderNodeAttribute', attribute_name='rough')
    tc = N(nt, 'ShaderNodeTexCoord')
    n1 = N(nt, 'ShaderNodeTexNoise')
    n1.inputs['Scale'].default_value = 55
    n1.inputs['Detail'].default_value = 4
    n2 = N(nt, 'ShaderNodeTexNoise')
    n2.inputs['Scale'].default_value = 420
    n2.inputs['Detail'].default_value = 2
    nt.links.new(tc.outputs['Object'], n1.inputs['Vector'])
    nt.links.new(tc.outputs['Object'], n2.inputs['Vector'])
    red = N(nt, 'ShaderNodeMixRGB', blend_type='MULTIPLY')
    red.inputs['Color2'].default_value = (1.10, 0.86, 0.84, 1)
    nt.links.new(math_(nt, 'MULTIPLY', n1.outputs['Fac'], 0.8), red.inputs['Fac'])
    nt.links.new(ca.outputs['Color'], red.inputs['Color1'])
    grain = N(nt, 'ShaderNodeMixRGB', blend_type='MULTIPLY')
    grain.inputs['Fac'].default_value = 1.0
    val = N(nt, 'ShaderNodeCombineColor')
    g = math_(nt, 'ADD', math_(nt, 'MULTIPLY', n2.outputs['Fac'], 0.12), 0.94)
    for i in range(3):
        nt.links.new(g, val.inputs[i])
    nt.links.new(red.outputs[0], grain.inputs['Color1'])
    nt.links.new(val.outputs[0], grain.inputs['Color2'])
    # freckles: small soft spots of deeper tone, uneven in size and strength, where 'freckle' is high
    fk = N(nt, 'ShaderNodeAttribute', attribute_name='freckle')
    vor = N(nt, 'ShaderNodeTexVoronoi')
    vor.inputs['Scale'].default_value = 520
    vor.inputs['Randomness'].default_value = 1.0
    pick = N(nt, 'ShaderNodeTexNoise')
    pick.inputs['Scale'].default_value = 140
    nt.links.new(tc.outputs['Object'], vor.inputs['Vector'])
    nt.links.new(tc.outputs['Object'], pick.inputs['Vector'])
    spot = math_(nt, 'MULTIPLY', math_(nt, 'SUBTRACT', 1.0, ramp(nt, vor.outputs['Distance'], 0.12, 0.42)), ramp(nt, pick.outputs['Fac'], 0.5, 0.68))
    frk = N(nt, 'ShaderNodeMixRGB', blend_type='MULTIPLY')
    frk.inputs['Color2'].default_value = (0.62, 0.43, 0.32, 1)
    nt.links.new(math_(nt, 'MULTIPLY', math_(nt, 'MULTIPLY', spot, fk.outputs['Fac']), 1.0), frk.inputs['Fac'])
    nt.links.new(grain.outputs[0], frk.inputs['Color1'])
    nt.links.new(frk.outputs[0], b.inputs['Base Color'])
    nt.links.new(ra.outputs['Fac'], b.inputs['Roughness'])
    nt.links.new(b.outputs[0], o.inputs['Surface'])
    out['rider_skin'] = (m, frk.outputs[0], ra.outputs['Fac'])
    # ---- cloth: drawn from its baked coordinates (cloth_textures); here only something to hold the bake's targets
    m, nt = nodes_for('rider_cloth_src')
    o = N(nt, 'ShaderNodeOutputMaterial')
    b = N(nt, 'ShaderNodeBsdfPrincipled')
    nt.links.new(b.outputs[0], o.inputs['Surface'])
    out['rider_cloth'] = (m, None, None)
    # ---- the eyes are drawn, not baked
    m, nt = nodes_for('rider_eye_src')
    o = N(nt, 'ShaderNodeOutputMaterial')
    b = N(nt, 'ShaderNodeBsdfPrincipled')
    nt.links.new(b.outputs[0], o.inputs['Surface'])
    out['rider_eye'] = (m, None, None)
    m, nt = nodes_for('rider_lash_src')
    o = N(nt, 'ShaderNodeOutputMaterial')
    b = N(nt, 'ShaderNodeBsdfPrincipled')
    nt.links.new(b.outputs[0], o.inputs['Surface'])
    out['rider_lash'] = (m, None, None)
    return out


def game_material(name, c, n=None, orm=None, rough=0.5):
    m, nt = nodes_for(name)
    o = N(nt, 'ShaderNodeOutputMaterial')
    b = N(nt, 'ShaderNodeBsdfPrincipled')
    tc = N(nt, 'ShaderNodeTexImage', image=c)
    nt.links.new(tc.outputs['Color'], b.inputs['Base Color'])
    if n:
        tn = N(nt, 'ShaderNodeTexImage', image=n)
        nm = N(nt, 'ShaderNodeNormalMap')
        nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    if orm:
        to = N(nt, 'ShaderNodeTexImage', image=orm)
        sep = N(nt, 'ShaderNodeSeparateColor')
        nt.links.new(to.outputs['Color'], sep.inputs['Color'])
        nt.links.new(sep.outputs['Green'], b.inputs['Roughness'])
        nt.links.new(sep.outputs['Blue'], b.inputs['Metallic'])
    else:
        b.inputs['Roughness'].default_value = rough
    nt.links.new(b.outputs[0], o.inputs['Surface'])
    return m


# ----------------------------------------------------------------------------- bake
def bake():
    scene = bpy.context.scene
    gpu_cycles(scene)
    ob = bpy.data.objects['rider']
    rig, horse_rig = bpy.data.objects['rider_rig'], bpy.data.objects['horse_rig']
    was = (rig.data.pose_position, horse_rig.data.pose_position)
    rig.data.pose_position = horse_rig.data.pose_position = 'REST'
    for o in bpy.data.objects:
        o.hide_render = o.name not in ('rider', 'horse', 'tack')        # (the occlusion sees the horse and saddle she sits on)
    bpy.context.view_layer.update()
    src = source_materials()
    img = {
        'rider_skin': {'c': image('rider_skin_c', (2048, 2048)), 'ao': image('rider_skin_ao', (1024, 1024), data=True), 'r': image('rider_skin_r', (1024, 1024), data=True), 'n': image('rider_skin_n', (64, 64), data=True)},
        'rider_cloth': {'c': image('rider_eye_scratch', (16, 16), data=True), 'ao': image('rider_cloth_ao', (512, 512), data=True), 'r': image('rider_eye_scratch', (16, 16), data=True), 'n': image('rider_eye_scratch', (16, 16), data=True)},
        'rider_eye': {k: image('rider_eye_scratch', (16, 16), data=True) for k in ('c', 'ao', 'r', 'n')},
        'rider_lash': {k: image('rider_eye_scratch', (16, 16), data=True) for k in ('c', 'ao', 'r', 'n')},
    }
    CS = 1024                                      # the clothes' textures
    targets = {}
    slots = [s.name for s in ob.material_slots]
    for i, name in enumerate(('rider_skin', 'rider_cloth', 'rider_eye', 'rider_lash')):
        m = src[name][0]
        ob.material_slots[i].material = m
        t = N(m.node_tree, 'ShaderNodeTexImage')
        m.node_tree.nodes.active = t
        targets[name] = t
    activate(ob)
    def aim(k):
        for name, t in targets.items():
            t.image = img[name][k]
    scene.render.bake.use_selected_to_active = False
    scene.render.bake.margin = 16
    scene.cycles.samples = 8
    aim('c')
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'})
    log('baked colour')
    aim('n')
    bpy.ops.object.bake(type='NORMAL', normal_space='TANGENT')
    log('baked normals')
    scene.cycles.samples = 96
    aim('ao')
    bpy.ops.object.bake(type='AO')
    log('baked occlusion')
    # roughness: each material's emission shows its roughness for one pass
    scene.cycles.samples = 4
    undo = []
    for name, (m, csock, rsock) in src.items():
        if rsock is None:
            continue
        nt = m.node_tree
        o = next(x for x in nt.nodes if x.type == 'OUTPUT_MATERIAL')
        keep = o.inputs['Surface'].links[0].from_socket
        em = N(nt, 'ShaderNodeEmission')
        nt.links.new(rsock, em.inputs['Color'])
        nt.links.new(em.outputs[0], o.inputs['Surface'])
        undo.append((nt, o, keep, em))
    aim('r')
    bpy.ops.object.bake(type='EMIT')
    for nt, o, keep, em in undo:
        nt.links.new(keep, o.inputs['Surface'])
        nt.nodes.remove(em)
    log('baked roughness')
    # ---- the clothes' own coordinates, three at a time as an emission's colour (+1: nothing below zero is lost)
    fields = []
    cm = src['rider_cloth'][0]
    nt = cm.node_tree
    o = next(x for x in nt.nodes if x.type == 'OUTPUT_MATERIAL')
    keep = o.inputs['Surface'].links[0].from_socket
    em = N(nt, 'ShaderNodeEmission')
    comb = N(nt, 'ShaderNodeCombineColor')
    nt.links.new(comb.outputs[0], em.inputs['Color'])
    nt.links.new(em.outputs[0], o.inputs['Surface'])
    atts = [N(nt, 'ShaderNodeAttribute') for _ in range(3)]
    for i, at in enumerate(atts):
        nt.links.new(math_(nt, 'ADD', at.outputs['Fac'], 1.0), comb.inputs[i])
    for k, names in enumerate((('c_e', 'c_w', 'c_x'), ('c_s', 'c_c', 'c_p'), ('c_h', 'fold', 'foldc'))):
        for at, nm in zip(atts, names):
            at.attribute_name = nm
        fim = image(f'rider_cloth_f{k}', (CS, CS), data=True, floats=True)
        for name, t in targets.items():
            t.image = fim if name == 'rider_cloth' else img['rider_eye']['c']
        bpy.ops.object.bake(type='EMIT')
        arr = np.empty(CS * CS * 4, dtype=np.float32)
        fim.pixels.foreach_get(arr)
        fields.append(arr.reshape(CS, CS, 4)[..., :3] - 1.0)
        bpy.data.images.remove(fim)
    nt.links.new(keep, o.inputs['Surface'])
    log('baked the clothes\' coordinates')
    # ---- colour x a share of the occlusion (creases read at any light); ORM
    final = {}
    for name in ('rider_skin',):
        c, ao, r = img[name]['c'], img[name]['ao'], img[name]['r']
        A = np.array(ao.pixels[:], dtype=np.float32).reshape(ao.size[1], ao.size[0], 4)
        R = np.array(r.pixels[:], dtype=np.float32).reshape(r.size[1], r.size[0], 4)
        # (ORM: occlusion, roughness, metal 0 - at a quarter of the colour's size)
        O = np.ones_like(A)
        O[..., 0] = A[..., 0]
        O[..., 1] = R[..., 0]
        O[..., 2] = 0.0
        O = O.reshape(ao.size[1] // 2, 2, ao.size[0] // 2, 2, 4).mean((1, 3))
        orm = image(name + '_orm', (ao.size[0] // 2, ao.size[1] // 2), data=True)
        orm.pixels.foreach_set(np.ascontiguousarray(O, dtype=np.float32).ravel())
        C = np.array(c.pixels[:], dtype=np.float32).reshape(c.size[1], c.size[0], 4)
        final[name] = (c, C, orm)
    brows(ob, final['rider_skin'][1])
    for name, (c, C, orm) in final.items():
        c.pixels.foreach_set(C.ravel())
        save(c)
        save(orm)
    # ---- the clothes
    ao = img['rider_cloth']['ao']
    A = np.empty(ao.size[0] * ao.size[1] * 4, dtype=np.float32)
    ao.pixels.foreach_get(A)
    A = A.reshape(ao.size[1], ao.size[0], 4)[..., 0]
    A = np.repeat(np.repeat(A, CS // ao.size[1], axis=0), CS // ao.size[0], axis=1)
    Cc, Nc, Oc = cloth_textures(fields, A, cloth_texel(ob, CS))
    cloth = {}
    for nm, arr, data in (('rider_cloth_c', Cc, False), ('rider_cloth_n', Nc, True), ('rider_cloth_orm', Oc, True)):
        im = image(nm, (arr.shape[1], arr.shape[0]), data=data)
        im.pixels.foreach_set(np.ascontiguousarray(arr, dtype=np.float32).ravel())
        save(im)
        cloth[nm] = im
    eye = eye_texture()
    # ---- the game's materials
    mats = {
        'rider_skin': game_material('rider_skin', final['rider_skin'][0], None, final['rider_skin'][2]),
        'rider_cloth': game_material('rider_cloth', cloth['rider_cloth_c'], cloth['rider_cloth_n'], cloth['rider_cloth_orm']),
        'rider_eye': game_material('rider_eye', eye, None, None, rough=0.12),
        'rider_lash': lash_material(),
    }
    for i, name in enumerate(('rider_skin', 'rider_cloth', 'rider_eye', 'rider_lash')):
        ob.material_slots[i].material = mats[name]
    for m, _, _ in src.values():
        bpy.data.materials.remove(m)
    # (the paint has done its work: as a colour attribute it would be exported and multiplied into the texture)
    for a in list(ob.data.color_attributes):
        ob.data.color_attributes.remove(a)
    for o in bpy.data.objects:
        o.hide_render = False
    rig.data.pose_position, horse_rig.data.pose_position = was
    log('textures saved to', WORK)


def cloth_texel(ob, size):
    """metres per texel of the clothes' layout (one density throughout: rider_bake.unwrap)"""
    me = ob.data
    uv = me.uv_layers.active.data
    pa = me.attributes['part'].data
    a3 = a2 = 0.0
    for p in me.polygons:
        if TOP <= pa[p.index].value <= BOOTS:
            a3 += p.area
            us = [uv[l].uv for l in p.loop_indices]
            a2 += abs(sum(us[i].x * us[(i + 1) % len(us)].y - us[(i + 1) % len(us)].x * us[i].y for i in range(len(us)))) / 2
    return math.sqrt(a3 / a2) / size


def cloth_textures(fields, AO, mpp):
    """her clothes, drawn at the texture's resolution from each garment's own coordinates (rider_body.CLOTH_FIELDS,
    and the folds' places from paint()): colour, a height in metres -> the normal map, roughness.
    refs/rider: clothes-denim-shorts-closeup-01, clothes-tee-denim-shorts-01, clothes-tank-leaning-01, boots-stirrup-*"""
    (e, w, x), (sn, cs, pid), (hh, fold, foldc) = (tuple(F[..., i] for i in range(3)) for F in fields)
    pid = np.rint(pid)
    az = np.arctan2(sn, cs)                         # 0 front, +-pi behind
    aa = np.abs(az)
    Hh, Ww = e.shape
    col = np.zeros((Hh, Ww, 3), np.float32)
    hgt = np.zeros((Hh, Ww), np.float32)
    rough = np.full((Hh, Ww), 0.8, np.float32)
    px = max(mpp, 1e-4)
    line = lambda f, f0, half=None: np.clip(1 - np.abs(f - f0) / (half or 1.3 * px), 0, 1)
    sharp = lambda t: t * np.abs(t)                 # creases are sharper than a sine
    C = lambda c: np.array(c, np.float32)
    lay = lambda c, to, t: c + (C(to) - c) * np.clip(t, 0, 1)[..., None]

    # ------------------------------------------------------------------ the denim shorts
    S = pid == SHORTS
    arc = az * 0.17                                 # metres round the hips
    dash = np.sin(arc * 2 * np.pi / 0.0065) > -0.25 # stitches
    twill = 0.5 + 0.5 * np.sin((arc + w) * 2 * np.pi / 0.005)
    slub = np.sin(arc * 2 * np.pi / 0.013 + 3 * np.sin(w * 60)) * np.sin(w * 2 * np.pi / 0.09 + arc * 30)
    c = C(DENIM)[None, None] * (0.80 + 0.20 * twill)[..., None] * (1 + 0.10 * slub)[..., None]
    h = np.zeros_like(w)                            # (the weave is finer than the normal map: colour only)
    # worn paler where it bears and rubs: the thighs' fronts, the seat
    wear = 0.55 * gauss(aa - 0.45, 0.38) * smooth(w, 0.07, 0.19) + 0.4 * gauss(aa - 2.55, 0.42) * gauss(w - 0.17, 0.07)
    c = lay(c, DENIM_WORN, wear * (0.75 + 0.25 * twill))
    # whiskers and creases from the hips' folds (she is sitting): ridges rubbed pale, valleys dark
    wv = sharp(np.sin(foldc * 2 * np.pi / 0.026 + 2.2 * np.sin(az * 3 + 1) + 1.3 * np.sin(w * 45)))
    h += 0.0030 * fold * wv
    c = c * (1 + 0.38 * fold * wv)[..., None]
    stitch = np.zeros_like(w)
    groove = np.zeros_like(w)
    # the waistband, its belt loops
    band = w < 0.036
    h += 0.0009 * band
    stitch += (line(w, 0.005) + line(w, 0.031)) * dash
    groove += line(w, 0.0365, 1.6 * px)
    for a0 in (0.42, -0.42, 1.75, -1.75, np.pi):
        d = np.abs(np.angle(np.exp(1j * (az - a0)))) * 0.17
        loop = (d < 0.0075) & (w < 0.045)
        h += 0.0018 * loop
        c = c * (1 - 0.3 * line(d, 0.0085, 0.002) * (w < 0.047))[..., None]
    # side seams (felled: a raised lap with two rows of stitching), centre back, the yoke, the fly
    sd = (aa - np.pi / 2) * 0.17
    lap = (np.abs(sd) < 0.006) & ~band
    h += 0.0007 * lap
    stitch += (line(sd, -0.0045) + line(sd, 0.0045)) * dash * ~band
    c = lay(c, DENIM_WORN, 0.45 * line(sd, 0.0, 0.011) * ~band)
    cb = (np.pi - aa) * 0.17
    groove += line(cb, 0.0, 1.5 * px) * ~band
    stitch += line(cb, 0.005) * dash * ~band
    yoke = 0.078 - 0.03 * (np.pi - aa) / (np.pi / 2)
    back = aa > np.pi / 2
    groove += line(w, yoke, 1.5 * px) * back
    stitch += (line(w, yoke + 0.004) + line(w, yoke + 0.009)) * dash * back
    front = aa < np.pi / 2
    groove += line(arc, 0.0, 1.5 * px) * front * ~band
    fly = np.where(w < 0.13, 0.032, 0.032 * np.sqrt(np.clip(1 - ((w - 0.13) / 0.035) ** 2, 0, 1)))
    stitch += (line(arc, fly) + line(arc, fly - 0.005)) * dash * front * (w > 0.036) * (w < 0.166)
    # the front pockets' openings (a curve from the waistband to the side seam), the back patch pockets
    fp = np.sqrt(((np.pi / 2 - aa) * 0.17 / 0.085) ** 2 + ((w - 0.036) / 0.075) ** 2)
    fpm = front & ~band & (aa > 0.45)
    stitch += (line(fp, 1.0, 0.022) + line(fp, 1.07, 0.022)) * dash * fpm
    h += 0.0008 * (fp > 1.0) * (fp < 1.4) * fpm
    c = c * (1 - 0.3 * line(fp, 0.965, 0.03) * fpm)[..., None]
    qx = np.abs(x) - 0.082
    bottom = 0.205 - 0.38 * np.abs(qx)
    d = np.minimum(np.minimum(0.058 - np.abs(qx), w - 0.085), (bottom - w) * 0.93)
    pk = back & (d > 0)
    h += 0.0009 * pk
    stitch += (line(d, 0.004) + line(d, 0.009)) * dash * back
    c = c * (1 - 0.32 * line(d, -0.002, 0.0035) * back)[..., None]
    c = lay(c, DENIM_WORN, 0.35 * line(d, 0.0015, 0.004) * back)
    # the legs' hems: turned up once, their raw edges frayed pale
    cuff = hh < 0.022
    h += 0.0016 * cuff
    c = lay(c, DENIM_WORN, 0.55 * cuff)
    stitch += line(hh, 0.017) * dash
    groove += line(hh, 0.0225, 1.6 * px)
    c = lay(c, (0.5, 0.52, 0.5), 0.6 * (hh < 0.0035) * (np.sin(arc * 2 * np.pi / 0.004 + 9 * np.sin(arc * 300)) > -0.2))
    c = lay(c, THREAD, np.minimum(stitch, 1))
    c = c * (1 - 0.5 * np.clip(groove, 0, 1))[..., None]
    h += 0.0004 * np.clip(stitch, 0, 1) - 0.0007 * np.clip(groove, 0, 1)
    col[S], hgt[S], rough[S] = c[S], h[S], 0.8

    # ------------------------------------------------------------------ the top: a fine rib knit, bound edges
    T = pid == TOP
    rib = np.cos(az * 170)
    c = C(TOP_C)[None, None] * (0.94 + 0.06 * rib)[..., None]
    h = np.zeros_like(w)                            # (so is the rib)
    # folded forward from the hips it gathers across the belly and waist; the gathers read by their shade
    wv = sharp(np.sin(foldc * 2 * np.pi / 0.036 + 2.5 * np.sin(az * 2 + 0.5) + 1.5 * np.sin(az * 5 + foldc * 20)))
    h += 0.0065 * fold * wv
    c = c * (1 + 0.11 * fold * wv)[..., None]
    # pulled taut from the straps over the bust: faint lines of tension down from the shoulders
    pull = smooth(w, 0.24, 0.40) * (aa < 1.3)
    tv = np.sin(az * 46 + 6 * w)
    h += 0.0007 * pull * tv
    c = c * (1 + 0.05 * pull * tv)[..., None]
    bind = e < 0.011
    h += 0.0009 * bind - 0.0006 * line(e, 0.0115, 1.5 * px)
    c = c * (1 - 0.22 * line(e, 0.0125, 0.0022))[..., None] * (1 - 0.04 * bind)[..., None]
    col[T], hgt[T], rough[T] = c[T], h[T], 0.86

    # ------------------------------------------------------------------ the boots: polished leather, creased at the ankle
    B = pid == BOOTS
    grain = np.sin(az * 3 + w * 22) * np.sin(az * 5 - w * 31)
    c = C(BOOT)[None, None] * (1 + 0.16 * grain)[..., None]
    crease = gauss(w - 0.125, 0.042)
    wv = sharp(np.sin(w * 2 * np.pi / 0.016 + 1.8 * np.sin(az * 2) + az))
    h = 0.0032 * crease * wv
    c = c * (1 + 0.55 * crease * wv)[..., None]
    r = 0.30 + 0.14 * crease
    # the seam up the back, the bound top, the sole and its welt
    bs = (np.pi - aa) * 0.05
    h -= 0.0006 * line(bs, 0.0, 1.5 * px) * (w > 0.035)
    c = c * (1 - 0.35 * line(bs, 0.0, 1.5 * px) * (w > 0.035))[..., None]
    top_ = hh < 0.018
    h += 0.0010 * top_ - 0.0006 * line(hh, 0.0185, 1.5 * px)
    c = c * (1 - 0.3 * line(hh, 0.0195, 0.002))[..., None]
    sole = w < 0.021
    c = np.where(sole[..., None], C(SOLE)[None, None], c)
    c = lay(c, (0.16, 0.11, 0.06), 0.7 * line(w, 0.0235) * (np.sin(az * 90) > -0.3))
    h -= 0.0012 * line(w, 0.0215, 1.6 * px)
    r = np.where(sole, 0.8, r)
    col[B], hgt[B], rough[B] = c[B], h[B], r[B]

    gy, gx = np.gradient(hgt, px)                   # rows are v, columns u
    gx, gy = np.clip(gx, -1.6, 1.6), np.clip(gy, -1.6, 1.6)
    nrm = np.dstack([-gx, -gy, np.ones_like(hgt)])
    nrm /= np.linalg.norm(nrm, axis=2, keepdims=True)
    Cc = np.dstack([np.clip(col, 0, 1), np.ones_like(hgt)])
    Nc = np.dstack([nrm * 0.5 + 0.5, np.ones_like(hgt)])
    r2 = rough.reshape(Hh // 4, 4, Ww // 4, 4).mean((1, 3))
    a2 = AO.reshape(Hh // 4, 4, Ww // 4, 4).mean((1, 3))
    Oc = np.dstack([a2, r2, np.zeros_like(r2), np.ones_like(r2)])
    log(f'clothes drawn: {mpp * 1000:.2f} mm per texel; shorts {int(S.sum())} texels, top {int(T.sum())}, boots {int(B.sum())}')
    return Cc, Nc, Oc


def brows(ob, C):
    """her eyebrows, hair by hair, onto the skin's colour texture: each hair a short stroke on the face's surface
    (found by a ray from in front of it), mapped to the texture through the face's UVs"""
    J = rlib.load_joints()
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    part = bm.faces.layers.int['part']
    uv = bm.loops.layers.uv.active
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f[part] != 0], context='FACES')
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.faces.ensure_lookup_table()
    tree = BVHTree.FromBMesh(bm)
    up = (J['crown'] - J['head']).normalized()
    side = V((1, 0, 0))
    fwd = up.cross(side).normalized()
    fwd = fwd if fwd.y < 0 else -fwd
    eyes = []
    for sg in (1, -1):
        ps = [v.co for p in me.polygons if me.attributes['part'].data[p.index].value == EYE for v in (me.vertices[i] for i in p.vertices) if v.co.x * sg > 0]
        eyes.append((sg, sum(ps, V()) / len(ps)))
    H, W = C.shape[:2]
    rng = np.random.default_rng(4)
    def to_uv(p):
        hit, n, fi, d = tree.ray_cast(p + fwd * 0.12, -fwd, 0.3)
        if hit is None:
            return None
        f = bm.faces[fi]
        a, b, c = (lp.vert.co for lp in f.loops)
        ua, ub, uc = (lp[uv].uv for lp in f.loops)
        v0, v1, v2 = b - a, c - a, hit - a
        d00, d01, d11, d20, d21 = v0.dot(v0), v0.dot(v1), v1.dot(v1), v2.dot(v0), v2.dot(v1)
        den = d00 * d11 - d01 * d01
        if abs(den) < 1e-18:
            return None
        v = (d11 * d20 - d01 * d21) / den
        w = (d00 * d21 - d01 * d20) / den
        q = ua * (1 - v - w) + ub * v + uc * w
        return q.x * W, q.y * H
    count = 0
    for sg, c in eyes:
        # the brow's line over the eye: from near the nose, rising to its arch two thirds out, then down its tail
        def line(t):
            x = -0.017 + 0.046 * t
            z = 0.0215 + 0.0075 * math.sin(min(1.0, t / 0.68) * math.pi / 2) - 0.0075 * max(0.0, (t - 0.68) / 0.32) ** 1.5
            return x, z
        for _ in range(420):
            t = rng.uniform(0, 1)
            x, z = line(t)
            thick = 0.0019 * (1 - 0.7 * t ** 1.5) + 0.0004
            off = rng.uniform(-1, 1) * thick
            # hairs lean outward along the brow, the inner ones standing more upright
            # fine hairs lying along the brow: nearly upright only at its inner end, then with its line
            slope = math.degrees(math.atan2(line(min(1, t + 0.05))[1] - line(max(0, t - 0.05))[1], 0.0046))
            ang = math.radians(max(slope + 8, 62 - 85 * min(1.0, t * 2.2))) + rng.normal(0, 0.08)
            L = rng.uniform(0.004, 0.0075) * (1 - 0.3 * t)
            x0, z0 = x, z + off
            pts = []
            for s in np.linspace(0, 1, 7):
                p = c + side * (sg * (x0 + math.cos(ang) * L * s)) + up * (z0 + math.sin(ang) * L * s - 0.0012 * s * s)
                q = to_uv(p)
                if q:
                    pts.append((q, s))
            a0 = rng.uniform(0.09, 0.26) * (1 - 0.45 * abs(off) / thick)
            for (qx, qy), s in pts:
                xi, yi = int(qx), int(qy)
                for dy in (0, 1):
                    for dx in (0, 1):
                        if 0 <= yi + dy < H and 0 <= xi + dx < W:
                            wgt = (1 - abs(qx - xi - dx)) * (1 - abs(qy - yi - dy)) * a0 * (1 - 0.6 * s)
                            C[yi + dy, xi + dx, :3] = C[yi + dy, xi + dx, :3] * (1 - wgt) + np.array(BROW) * wgt
            count += 1
    bm.free()
    log('brows:', count, 'hairs drawn')


def lash_material():
    """her eyelashes: fine dark hairs on alpha for the base mesh's lash strips (rider_bake.unwrap: the upper lid's
    strip on the left half, the lower's on the right; roots at the top)"""
    W, H = 128, 64
    rng = np.random.default_rng(6)
    y, x = np.mgrid[0:H, 0:W].astype(np.float32)
    t = y / (H - 1)                                   # 0 root .. 1 tip (row 0 is flipped to the top below)
    alpha = np.zeros((H, W), np.float32)
    for half, count, length, lean in ((0, 30, (0.6, 1.0), 9.0), (1, 15, (0.3, 0.55), 5.0)):
        x0 = half * W / 2
        for k in range(count):
            cx0 = x0 + 3 + (W / 2 - 6) * (k + rng.uniform(0.2, 0.8)) / count
            ln = rng.uniform(*length)
            sway = (cx0 - (x0 + W / 4)) / (W / 4) * lean + rng.uniform(-2, 2)   # they fan out from the lid's middle
            cx = cx0 + sway * t * t
            wd = 0.8 * np.clip(1 - (t / ln) ** 1.5, 0, 1)
            alpha = np.maximum(alpha, np.clip(wd - np.abs(x - cx) + 0.5, 0, 1) * (t <= ln))
        alpha = np.maximum(alpha, (t < 0.04) * (x >= x0 + 2) * (x < x0 + W / 2 - 2) * 1.0)       # the lash line
    rgba = np.zeros((H, W, 4), np.float32)
    rgba[..., :3] = np.array(LASH)
    rgba[..., 3] = alpha
    im = image('rider_lash', (W, H), alpha=True)
    im.alpha_mode = 'STRAIGHT'
    im.pixels.foreach_set(np.ascontiguousarray(rgba[::-1]).ravel())
    save(im)
    m, nt = nodes_for('rider_lash')
    o = N(nt, 'ShaderNodeOutputMaterial')
    b = N(nt, 'ShaderNodeBsdfPrincipled')
    tx = N(nt, 'ShaderNodeTexImage', image=im)
    nt.links.new(tx.outputs['Color'], b.inputs['Base Color'])
    nt.links.new(tx.outputs['Alpha'], b.inputs['Alpha'])
    b.inputs['Roughness'].default_value = 0.5
    nt.links.new(b.outputs[0], o.inputs['Surface'])
    return m


def eye_texture():
    """one eye seen from the front (rider_bake.unwrap projects each eyeball that way): sclera, a grey-blue iris with
    its fibres and darker rim, the pupil; the lids' shadow at the top"""
    S = 256
    y, x = np.mgrid[0:S, 0:S].astype(np.float32)
    u, v = (x + 0.5) / S - 0.5, (y + 0.5) / S - 0.5
    r = np.hypot(u, v)
    a = np.arctan2(v, u)
    rng = np.random.default_rng(2)
    img = np.zeros((S, S, 4), np.float32)
    sclera = np.array([0.72, 0.69, 0.66]) * (1 - 0.45 * smooth(r, 0.22, 0.48))[..., None] + np.array([0.10, -0.02, -0.03]) * smooth(r, 0.3, 0.5)[..., None]
    IR, PU = 0.172, 0.060
    fib = sum(np.sin(a * k + rng.uniform(0, 6)) * w for k, w in ((37, 0.5), (61, 0.3), (17, 0.4), (89, 0.25)))
    t = np.clip(r / IR, 0, 1)
    iris = (np.array([0.10, 0.22, 0.30])[None, None] * (0.75 + 0.22 * fib[..., None]) * (1 - 0.55 * smooth(t, 0.72, 1.0))[..., None]
            + np.array([0.20, 0.16, 0.06])[None, None] * (1 - smooth(t, 0.36, 0.62))[..., None] * 0.55)
    k = smooth(r, IR - 0.012, IR + 0.006)[..., None]
    c = iris * (1 - k) + sclera * k
    c = c * smooth(r, PU - 0.006, PU + 0.008)[..., None] + np.array([0.01, 0.01, 0.012]) * (1 - smooth(r, PU - 0.006, PU + 0.008))[..., None]
    c *= (1 - 0.55 * smooth(v, 0.04, 0.30))[..., None]          # the upper lid's shadow
    # the sky in her eye: a small window of light on the cornea, up and to one side of the pupil
    hl = np.exp(-(((u - 0.05) / 0.014) ** 2 + ((v - 0.045) / 0.010) ** 2))
    c = c * (1 - 0.8 * hl[..., None]) + np.array([1.0, 1.0, 1.0]) * 0.8 * hl[..., None]
    img[..., :3] = np.clip(c, 0, 1)
    img[..., 3] = 1
    im = image('rider_eye', (S, S))
    im.pixels.foreach_set(img.ravel())
    save(im)
    return im


# ----------------------------------------------------------------------------- hair strands
HAIR_COLS = 8


def hair_texture():
    """strands on alpha, one column per card (rider_hair): columns 0-3 for the scalp's cards (dense: the strands of a
    lock lying together, frayed along both sides so neighbours mesh), 2 and 3 for single strands (over the scalp, in
    the ponytail), 4-6 for the ponytail's locks (they separate and thin to their tips), 7 for loose strands (a few
    fine hairs). Dark at the roots, palest at the tips."""
    W, H = 512, 1024
    rng = np.random.default_rng(11)
    cw = W // HAIR_COLS
    px = cw / 128                                  # (strand sizes below are in 128ths of a column)
    rgba = np.zeros((H, W, 4), np.float32)
    yy = np.linspace(0, 1, H, dtype=np.float32)[:, None]            # 0 root .. 1 tip
    xx = np.arange(cw, dtype=np.float32)[None, :]
    root, mid, tip = (np.array(c, dtype=np.float32) for c in (HAIR_ROOT, HAIR_MID, HAIR_TIP))
    for c in range(HAIR_COLS):
        scalp, pony = c < 4, 4 <= c < 7
        edge_card = c < 2                              # a card that starts at the hairline (2, 3: the layer over them)
        nstr = 260 if scalp else 34 if pony else 7
        alpha = np.zeros((H, cw), np.float32)
        tone = np.ones((H, cw), np.float32)
        for _ in range(nstr):
            x0 = rng.uniform(6 * px, cw - 6 * px) if not scalp else rng.uniform(0, cw)
            wv = (rng.uniform(0.5, 1.3) if scalp else rng.uniform(1.4, 4.2) if pony else rng.uniform(0.8, 1.3)) * px
            ln = 1.0 if scalp else rng.uniform(0.55, 1.0) if pony else rng.uniform(0.7, 1.0)
            drift = (rng.uniform(-5, 5) if scalp else rng.uniform(-14, 14)) * px
            sway = rng.uniform(0.5, 3.5) * px * np.sin(yy * rng.uniform(3, 9) + rng.uniform(0, 6))
            cx = x0 + drift * yy + sway
            taper = np.clip(1 - (yy / ln) ** 3, 0, 1) if not scalp else 1.0
            a = np.clip((wv * taper - np.abs(xx - cx)) / max(px, 0.5) + 0.5, 0, 1) * (yy <= ln)
            # fine hair: the strands differ a little in tone, none stands out as a stripe
            t = rng.uniform(0.9, 1.1) if scalp else rng.uniform(0.82, 1.16)
            tone = np.where(a > alpha * 0.999, t, tone)
            alpha = np.maximum(alpha, a)
        if scalp:
            # (and a soft sheen that wanders along the lock, so a card is not one flat tone)
            tone = tone * (1 + 0.05 * np.sin(yy * rng.uniform(5, 9) + rng.uniform(0, 6)))
        if scalp:
            # a lock: solid along its middle, its sides frayed into single strands
            edge = np.minimum(xx, cw - 1 - xx) / (cw * 0.5)
            alpha = np.maximum(alpha * (0.35 + 0.65 * smooth(edge, 0.0, 0.5)), smooth(edge, 0.30, 0.62) * 0.96)
            alpha *= (rng.uniform(0, 1, (1, cw)) < smooth(edge, 0.0, 0.34) + 0.25)
            if edge_card:
                # the hairline: every hair starts at its own place, the finest first
                # (a soft ramp, not a row of teeth: the single strands laid over it make the hairline)
                start = rng.uniform(0.0, 1.0, (1, cw)) ** 2 * 0.025
                alpha *= smooth(yy - start, 0.0, 0.07)
            else:
                # a lock of the layer above: it comes out of the hair under it, strand by strand
                start = rng.uniform(0.0, 0.30, (1, cw))
                alpha *= smooth(yy - start, 0.0, 0.05)
        elif pony:
            alpha = np.maximum(alpha, np.clip(1 - yy / 0.10, 0, 1) * ((xx > 3) & (xx < cw - 3)))     # bound together at the tie
        alpha[-6:, :] = 0 if not scalp else alpha[-6:, :]
        # root to tip: the hairline's cards run roots -> lengths; the ponytail lengths -> tips
        if edge_card:
            g = smooth(yy, 0.0, 0.10)
            base = (root * 0.35 + mid * 0.65) * (1 - g) + mid * g
        elif scalp:
            base = mid * np.ones_like(yy)
        elif pony:
            g = smooth(yy, 0.2, 1.0)
            base = mid * (1 - g) + tip * g
        else:
            g = smooth(yy, 0.0, 0.6)
            base = (root * 0.3 + mid * 0.7) * (1 - g) + tip * g
        if c in (2, 3):
            # single strands (rider_hair): each takes one line of this column - opaque, a tone of its own, dark at
            # the hairline (2) or paling to the tip, where it thins out (3)
            tone = np.repeat(rng.uniform(0.80, 1.22, (1, cw)), H, axis=0)
            alpha = np.ones((H, cw), np.float32)
            if c == 2:
                g = smooth(yy, 0.0, 0.10)
                base = (root * 0.6 + mid * 0.4) * (1 - g) + mid * g
            else:
                g = smooth(yy, 0.2, 1.0)
                base = mid * (1 - g) + tip * g
                alpha = alpha * (1 - smooth(yy, 0.93, 1.0))
        colr = base[:, None, :] * tone[..., None] * (0.55 if c == 6 else 1.0)       # (6: locks inside the ponytail)
        rgba[:, c * cw:(c + 1) * cw, :3] = np.clip(colr, 0, 1)
        rgba[:, c * cw:(c + 1) * cw, 3] = alpha
    rgba = rgba[::-1]                              # image row 0 is the bottom: roots are at uv v = 1 (rider_hair)
    im = image('rider_hair', (W, H), alpha=True)
    im.alpha_mode = 'STRAIGHT'
    im.pixels.foreach_set(np.ascontiguousarray(rgba).ravel())
    save(im)
    m, nt = nodes_for('rider_hair')
    o = N(nt, 'ShaderNodeOutputMaterial')
    b = N(nt, 'ShaderNodeBsdfPrincipled')
    t = N(nt, 'ShaderNodeTexImage', image=im)
    nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
    nt.links.new(t.outputs['Alpha'], b.inputs['Alpha'])
    b.inputs['Roughness'].default_value = 0.48
    nt.links.new(b.outputs[0], o.inputs['Surface'])
    try:
        m.blend_method = 'CLIP'
    except Exception:
        pass
    ob = bpy.data.objects['rider_hair']
    ob.data.materials.clear()
    ob.data.materials.append(m)
    log('hair texture drawn')


def tack_materials():
    """the tack's texture and materials. One small texture, two panels (tack_mesh.panel_uv): the saddle pad's
    quilting and bound edge on the left; on the right a leather panel - grain, a darker burnished edge, a row of
    stitching inside it, a little wear in its middle (refs/rider: saddle-jumping-side-01, saddle-jumping-rider-leg-*)"""
    W, H = 512, 256
    rng = np.random.default_rng(8)
    y, x = np.mgrid[0:H, 0:W].astype(np.float32)
    b = (y + 0.5) / H
    img = np.zeros((H, W, 4), np.float32)
    img[..., 3] = 1
    # ---- the pad: a navy quilted numnah, diamonds ~4 cm, stitching sunk, a bound edge
    a = np.clip((x + 0.5) / (W / 2), 0, 1)
    d1 = np.abs(((a * 11 + b * 22) % 1.0) - 0.5) * 2
    d2 = np.abs(((a * 11 - b * 22) % 1.0) - 0.5) * 2
    groove = np.maximum(1 - d1 / 0.16, 1 - d2 / 0.16).clip(0, 1)
    puff = np.minimum(d1, d2)                                     # 0 at a seam .. towards the middle of a diamond
    edge = np.minimum(np.minimum(a, 1 - a) * 2.0, np.minimum(b, 1 - b))   # (the panel is twice as long as wide)
    pad = np.array((0.075, 0.105, 0.25), np.float32)[None, None] * (0.80 + 0.35 * puff - 0.35 * groove)[..., None]
    bind = edge < 0.022
    pad = np.where(bind[..., None], np.array((0.10, 0.125, 0.26), np.float32)[None, None] * (0.85 + 0.15 * np.sin((a + b) * 900))[..., None], pad)
    pad *= (1 - 0.45 * np.clip(1 - np.abs(edge - 0.026) / 0.004, 0, 1))[..., None]
    # ---- the leather panel
    a2 = np.clip((x + 0.5 - W / 2) / (W / 2), 0, 1)
    grain = rng.uniform(0.0, 1.0, (H // 4, W // 4)).astype(np.float32)
    grain = np.repeat(np.repeat(grain, 4, axis=0), 4, axis=1)
    grain = (grain + np.roll(grain, 2, 0) + np.roll(grain, 2, 1) + np.roll(np.roll(grain, 2, 0), 2, 1)) / 4
    e2 = np.minimum(np.minimum(a2, 1 - a2), np.minimum(b, 1 - b))
    wear = np.exp(-(((a2 - 0.5) / 0.3) ** 2 + ((b - 0.5) / 0.3) ** 2))
    lea = np.array((0.060, 0.030, 0.015), np.float32)[None, None] * (0.86 + 0.28 * grain + 0.30 * wear)[..., None]
    lea *= (1 - 0.45 * np.clip(1 - e2 / 0.018, 0, 1))[..., None]            # the burnished edge
    stitch = np.clip(1 - np.abs(e2 - 0.045) / 0.006, 0, 1) * (np.sin((a2 + b) * 520) > -0.2) * (np.abs(a2 - 0.5) + np.abs(b - 0.5) > 0.12)
    lea = lea * (1 - stitch[..., None]) + np.array((0.34, 0.24, 0.13), np.float32)[None, None] * stitch[..., None]
    img[..., :3] = np.where((x < W / 2)[..., None], pad, lea)
    im = image('rider_tack', (W, H))
    im.pixels.foreach_set(np.ascontiguousarray(np.clip(img, 0, 1)).ravel())
    save(im)
    for name, rough in (('tack_leather', 0.36), ('tack_pad', 0.9)):
        m, nt = nodes_for(name)
        o = N(nt, 'ShaderNodeOutputMaterial')
        bs = N(nt, 'ShaderNodeBsdfPrincipled')
        tx = N(nt, 'ShaderNodeTexImage', image=im)
        nt.links.new(tx.outputs['Color'], bs.inputs['Base Color'])
        bs.inputs['Roughness'].default_value = rough
        nt.links.new(bs.outputs[0], o.inputs['Surface'])
    m = bpy.data.materials.get('tack_metal') or bpy.data.materials.new('tack_metal')
    m.use_nodes = True
    bs = next(x_ for x_ in m.node_tree.nodes if x_.type == 'BSDF_PRINCIPLED')
    bs.inputs['Base Color'].default_value = (0.42, 0.42, 0.44, 1.0)        # stainless steel, not chrome
    bs.inputs['Roughness'].default_value = 0.48
    bs.inputs['Metallic'].default_value = 1.0
    log('tack texture drawn, materials set')


if __name__ == '__main__':
    tack_materials()
    hair_texture()
    unwrap()
    paint()
    bake()
