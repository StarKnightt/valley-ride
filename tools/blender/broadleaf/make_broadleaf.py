"""
make_broadleaf.py - procedural broadleaf (oak / cottonwood) trees for Valley Ride (Blender 5.1, headless).

Sibling of tools/blender/pines/make_pines.py: same stages, same GLB writer and attribute layout, same texture
forms. Everything is generated here: the leaf-cluster atlas (modelled leaves on twigs rendered orthographically),
the bark texture set, the tree skeletons (scaffold limbs + space colonisation inside a lumpy crown envelope,
pipe-model radii), three LODs per tree as GLB, and Eevee check renders.

Run (Git Bash):
  MSYS_NO_PATHCONV=1 nice -n 10 E:/blender/blender-5.1.2-windows-x64/blender.exe -b -t 6 \
      --python-exit-code 1 --python F:/valley-ride/tools/blender/broadleaf/make_broadleaf.py -- \
      --stage all [--trees a,b] [--allow-software]
Stages: atlas, bark, trees, render, all (= atlas,bark,trees,render). Comma lists allowed.
Contact sheet: python F:/valley-ride/tools/blender/broadleaf/make_broadleaf_sheet.py (system python + PIL).

GLB layout (one mesh, nodes[0] = "<id>_LOD<k>", one primitive per material):
  materials: broadleaf_bark, broadleaf_needles (the game treats /needle/ as foliage cards)
  POSITION f32x3, NORMAL f32x3, TEXCOORD_0 f32x2 (glTF v-down),
  COLOR_0 f32x4 (R = baked AO, G = B = A = 0),
  _WIND  f32x4 (x branch bend 0 base..1 tip, y leaf flutter 0 bark..1 card tip,
               z per-limb phase 0..1, w trunk height weight (y/H)^1.5)
  indices uint16 / uint32, non-interleaved, no compression. Y up, metres, origin at the trunk base.
Textures (WebP, out/textures): broadleaf_leaves_{c,n,m}.webp, broadleaf_bark_{c,n,m}.webp
  leaves_m: R AO, G roughness, B 0, A translucency
  bark_m:   R AO, G roughness, B metallic(0), A 1
Bark atlas: 4 vertical strips (u 0-.25 oak trunk, .25-.5 cottonwood trunk, .5-.75 smooth young bark,
  .75-1 branch bark), each periodic in u inside its strip and tileable in v.
Leaf atlas: 2 cols x 2 rows of 1024x1024 cells (0 oak cluster, 1 oak dense, 2 cottonwood spray, 3 cottonwood
  dense), twig base at the cell's left edge, twig axis along +u through the cell's vertical centre.
"""
import bpy, sys, os, re, math, json, struct, time
import numpy as np

ROOT = os.environ.get('VALLEY_WORK', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'build', 'blender')).replace(os.sep, '/') + '/broadleaf'
OUT = ROOT + '/out'
TEXD = OUT + '/textures'
TMP = ROOT + '/tmp'
RND = ROOT + '/renders'
for _d in (OUT, TEXD, TMP, RND):
    os.makedirs(_d, exist_ok=True)

ATLAS = 2048
CELL_W, CELL_H = 0.9, 0.9          # physical size (m) of one atlas cell when modelled
NCOLS, NROWS = 2, 2
Yv = np.array([0, 1.0, 0])

def log(*a):
    print('[broadleaf]', *a, flush=True)

# --------------------------------------------------------------------------- args
def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    a = {'stage': 'all', 'trees': 'a,b', 'allow_software': False, 'views': ''}
    i = 0
    while i < len(argv):
        k = argv[i]
        if k == '--allow-software':
            a['allow_software'] = True; i += 1; continue
        a[k.lstrip('-').replace('-', '_')] = argv[i + 1]; i += 2
    st = a['stage'].split(',')
    if 'all' in st:
        st = ['atlas', 'bark', 'trees', 'render']
    a['stages'] = st
    a['tree_list'] = a['trees'].split(',')
    return a

ARGS = parse_args()

# --------------------------------------------------------------------------- GPU
_GPU_OK = False
def gpu_check():
    """Must be called after the first Eevee render of the process (context exists then)."""
    global _GPU_OK
    if _GPU_OK:
        return
    import gpu
    r = gpu.platform.renderer_get()
    log('[gpu]', gpu.platform.backend_type_get(), '|', r, '|', gpu.platform.vendor_get())
    if re.search(r'swiftshader|llvmpipe|software|basic render|warp|microsoft', r, re.I):
        if not ARGS['allow_software']:
            raise SystemExit('CPU rasteriser in use: ' + r)
        log('WARNING software renderer allowed by --allow-software')
    _GPU_OK = True

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    return sc

# --------------------------------------------------------------------------- math
def nrm(v):
    v = np.asarray(v, dtype=np.float64)
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.maximum(n, 1e-12)

def frame(d):
    d = nrm(d)
    a = np.array([0., 0., 1.]) if abs(d[2]) < 0.9 else np.array([0., 1., 0.])
    u = nrm(np.cross(d, a)); w = np.cross(d, u)
    return u, w

def rot_about(v, axis, ang):
    axis = nrm(axis); c, s = math.cos(ang), math.sin(ang)
    return v * c + np.cross(axis, v) * s + axis * np.dot(axis, v) * (1 - c)

def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)

def lerp(a, b, t):
    return a + (b - a) * t

# =========================================================================== ATLAS
LEAF_TOP = np.array([0.150, 0.215, 0.075])      # sRGB, deep summer green
LEAF_OLIVE = np.array([0.205, 0.235, 0.085])    # olive cast
LEAF_YOUNG = np.array([0.260, 0.330, 0.105])    # fresh shoot leaves
LEAF_UNDER = np.array([0.300, 0.350, 0.205])    # pale undersides (leaves turned over)
LEAF_DRY = np.array([0.300, 0.290, 0.120])      # the odd yellowing leaf
TWIG_COL = np.array([0.215, 0.170, 0.125])

class Acc:
    def __init__(s):
        s.V = []; s.F = []; s.col = []; s.m = []
    def v(s, p, c, m):
        s.V.append(p); s.col.append(c); s.m.append(m); return len(s.V) - 1

def add_twig(acc, pts, radii, col, ao=0.55, sides=6):
    rings = []
    n = len(pts)
    for i in range(n):
        d = pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]
        u, w = frame(d)
        ring = []
        for j in range(sides):
            a = j * 2 * math.pi / sides
            ring.append(acc.v(pts[i] + (u * math.cos(a) + w * math.sin(a)) * radii[i],
                              col * (0.9 + 0.1 * math.cos(a)), (ao, 0.85, 0.08)))
        rings.append(ring)
    for i in range(n - 1):
        a, b = rings[i], rings[i + 1]
        for j in range(sides):
            j2 = (j + 1) % sides
            acc.F.append((a[j], a[j2], b[j2], b[j]))

def shoot_path(base, d, L, curve, rng, n=10, zcurve=0.0):
    pts = [np.array(base, dtype=np.float64)]
    d = nrm(d)
    ds = L / (n - 1)
    for i in range(1, n):
        d = nrm(rot_about(d, np.array([0, 0, 1.]), curve / (n - 1)) + np.array([0, 0, zcurve / (n - 1)]))
        d = nrm(d + rng.normal(0, 0.03, 3) * np.array([1, 1, 0.5]))
        pts.append(pts[-1] + d * ds)
    return np.array(pts)

def path_sample(pts, s):
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    cs = np.concatenate([[0], np.cumsum(seg)])
    s = min(max(s, 0), cs[-1] - 1e-9)
    i = int(np.searchsorted(cs, s, side='right') - 1)
    i = min(i, len(seg) - 1)
    t = (s - cs[i]) / max(seg[i], 1e-12)
    return pts[i] + (pts[i + 1] - pts[i]) * t, nrm(pts[i + 1] - pts[i]), cs[-1]

def leaf_halfwidth(shape, t, ph):
    """half width of the blade / blade length at t (0 petiole .. 1 tip)"""
    t = min(max(t, 0.0), 1.0)
    if shape == 'oak':          # white-oak: obovate with 3-4 rounded lobes a side
        env = math.sin(math.pi * t ** 0.8) ** 0.85
        lob = 0.5 + 0.5 * abs(math.sin(math.pi * (3.4 * t + ph))) ** 0.35
        m = smoothstep(0.1, 0.28, t) * (1 - smoothstep(0.9, 1.0, t))
        return 0.42 * env * lerp(1.0, lob, m)
    env = math.sin(math.pi * t) ** 0.55 * (1 - 0.5 * t)      # cottonwood / aspen: broad deltoid-round
    return 0.60 * env

def add_leaf(acc, rng, base, d, b, n, L, shape, col, trans, fold, curl):
    R = 16 if shape == 'oak' else 10
    cols = (-1.0, -0.5, 0.0, 0.5, 1.0)
    ph = rng.uniform(0, 1); ph2 = ph + rng.normal(0, 0.07)
    rough = 0.5 + rng.uniform(0, 0.15)
    rows = []
    for k in range(R + 1):
        t = k / R
        wl = leaf_halfwidth(shape, t, ph) * L; wr = leaf_halfwidth(shape, t, ph2) * L
        ring = []
        for c in cols:
            w = (wl if c < 0 else wr) * c
            z = fold * abs(w) + curl * L * t * t
            p = base + d * t * L + b * w + n * z
            cc = col * (1.12 if c == 0 else (0.9 if abs(c) == 1 else 1.0))
            ring.append(acc.v(p, np.clip(cc, 0, 1), (1.0, rough, trans)))
        rows.append(ring)
    for k in range(R):
        a, bb = rows[k], rows[k + 1]
        for j in range(len(cols) - 1):
            acc.F.append((a[j], a[j + 1], bb[j + 1], bb[j]))

def leaf_frame(psi, e, roll):
    d = np.array([math.cos(e) * math.cos(psi), math.cos(e) * math.sin(psi), math.sin(e)])
    b0 = np.array([-math.sin(psi), math.cos(psi), 0.])
    b = rot_about(b0, d, roll)
    n = np.cross(d, b)
    return d, b, n

def leaf_colour(rng, young, P):
    c = P['col'] * rng.uniform(0.80, 1.16) + rng.normal(0, 0.006, 3)
    c = lerp(c, LEAF_OLIVE, rng.uniform(0, 0.55))
    r = rng.random()
    if r < 0.05:
        c = lerp(c, LEAF_DRY, rng.uniform(0.4, 0.8))
    elif r < 0.15:
        c = LEAF_UNDER * rng.uniform(0.85, 1.1)
    if young and r >= 0.15:
        c = lerp(c, LEAF_YOUNG, rng.uniform(0.3, 0.8))
    return np.clip(c, 0, 1)

def put_leaf(acc, rng, P, at, psi, z, young, scale=1.0, pet=None):
    """leaf on a petiole from `at`, pointing at angle psi in the cell plane"""
    L = P['leaf'] * rng.uniform(0.75, 1.15) * scale
    e = rng.uniform(*P['elev'])
    roll = rng.normal(0, 0.45)
    d, b, n = leaf_frame(psi + rng.normal(0, 0.12), e, roll)
    pl = pet if pet is not None else rng.uniform(*P['petiole'])
    p0 = np.array(at, float) + np.array([0, 0, z])
    if pl > 0.012:
        pp = np.array([p0, p0 + d * pl * 0.5 + np.array([0, 0, 0.004]), p0 + d * pl])
        add_twig(acc, pp, np.array([0.0018, 0.0014, 0.0011]), TWIG_COL * 1.15, sides=3)
    add_leaf(acc, rng, p0 + d * pl, d, b, n, L, P['shape'], leaf_colour(rng, young, P), 0.72,
             rng.uniform(0.12, 0.35), rng.uniform(-0.25, 0.15))

def leaf_cluster(rng, P):
    acc = Acc()
    L = P['L']
    main = shoot_path([0, 0, 0], [1, rng.uniform(-0.06, 0.06), 0], L, rng.uniform(-0.25, 0.25), rng, n=9)
    shoots = [(main, P['r0'], 1.0)]
    _, _, S = path_sample(main, 0)
    s = S * P['fork_from']; sgn = 1 if rng.random() < 0.5 else -1
    while s < S * 0.82:
        base, tan, _ = path_sample(main, s)
        ang = math.radians(rng.uniform(*P['fork_ang'])) * sgn
        d = rot_about(tan, np.array([0, 0, 1.]), ang)
        Ls = (S - s) * rng.uniform(0.5, 0.8) + 0.05
        sp = shoot_path(base, d, Ls, -sgn * rng.uniform(0.0, 0.45), rng, n=7)
        shoots.append((sp, P['r0'] * 0.62, 0.85))
        if Ls > 0.3 and P['sub']:
            b2, t2, _ = path_sample(sp, Ls * 0.45)
            d2 = rot_about(t2, np.array([0, 0, 1.]), -math.radians(rng.uniform(30, 50)) * sgn)
            shoots.append((shoot_path(b2, d2, Ls * 0.45, 0, rng, n=5), P['r0'] * 0.4, 0.7))
        s += rng.uniform(*P['fork_dy']); sgn = -sgn
    for pts, r0, sc in shoots:
        add_twig(acc, pts, np.linspace(r0, r0 * 0.45, len(pts)), TWIG_COL, sides=5)
        _, _, S2 = path_sample(pts, 0)
        tip, tan, _ = path_sample(pts, S2)
        psi0 = math.atan2(tan[1], tan[0])
        young = rng.random() < 0.35
        if P['shape'] == 'oak':
            # oak: leaves crowd into rosettes at the shoot tips, a few more along the last year's growth
            nr = int(rng.integers(*P['rosette']))
            for k in range(nr):
                psi = psi0 + (k / max(nr - 1, 1) - 0.5) * 2 * math.radians(P['spread']) + rng.normal(0, 0.2)
                put_leaf(acc, rng, P, tip, psi, rng.uniform(-0.01, 0.05), young, sc)
            s2 = S2 * P['along_from']; sd = 1
            while s2 < S2 * 0.9:
                p, t2, _ = path_sample(pts, s2)
                psi = math.atan2(t2[1], t2[0]) + sd * math.radians(rng.uniform(40, 80))
                put_leaf(acc, rng, P, p, psi, rng.uniform(-0.03, 0.03), False, sc * 0.85)
                s2 += P['leaf_dy'] * rng.uniform(0.7, 1.3); sd = -sd
        else:
            # cottonwood / aspen: alternate leaves on long flat petioles all along the shoot
            s2 = S2 * P['along_from']; sd = 1 if rng.random() < 0.5 else -1
            while s2 < S2:
                p, t2, _ = path_sample(pts, s2)
                psi = math.atan2(t2[1], t2[0]) + sd * math.radians(rng.uniform(35, 85))
                put_leaf(acc, rng, P, p, psi, rng.uniform(-0.03, 0.04), young and s2 > 0.7 * S2, sc)
                s2 += P['leaf_dy'] * rng.uniform(0.7, 1.3); sd = -sd
            for k in range(int(rng.integers(2, 4))):
                put_leaf(acc, rng, P, tip, psi0 + rng.normal(0, 0.5), rng.uniform(0, 0.05), young, sc * 0.8)
    return acc

CELL_DEFS = [
    # 0: oak cluster - forked twig with tip rosettes
    dict(shape='oak', L=0.62, r0=0.0075, fork_from=0.12, fork_ang=(28, 55), fork_dy=(0.06, 0.1), sub=True,
         rosette=(6, 9), spread=80, along_from=0.2, leaf_dy=0.035, leaf=0.115, petiole=(0.005, 0.015),
         elev=(-0.1, 0.5), col=LEAF_TOP),
    # 1: oak dense (LOD fill)
    dict(shape='oak', L=0.62, r0=0.0075, fork_from=0.08, fork_ang=(25, 55), fork_dy=(0.045, 0.07), sub=True,
         rosette=(7, 11), spread=90, along_from=0.12, leaf_dy=0.028, leaf=0.12, petiole=(0.005, 0.015),
         elev=(-0.1, 0.5), col=LEAF_TOP * 0.97),
    # 2: cottonwood spray
    dict(shape='round', L=0.62, r0=0.0065, fork_from=0.15, fork_ang=(30, 55), fork_dy=(0.07, 0.11), sub=True,
         rosette=(0, 1), spread=0, along_from=0.08, leaf_dy=0.03, leaf=0.08, petiole=(0.025, 0.05),
         elev=(-0.15, 0.45), col=LEAF_TOP * np.array([1.05, 1.06, 1.0])),
    # 3: cottonwood dense (LOD fill)
    dict(shape='round', L=0.62, r0=0.0065, fork_from=0.1, fork_ang=(28, 55), fork_dy=(0.05, 0.08), sub=True,
         rosette=(0, 1), spread=0, along_from=0.05, leaf_dy=0.024, leaf=0.085, petiole=(0.025, 0.05),
         elev=(-0.15, 0.45), col=LEAF_TOP * np.array([1.03, 1.04, 1.0])),
]

def cell_uv(i):
    col, row = i % NCOLS, i // NCOLS
    return col / NCOLS, row / NROWS, 1.0 / NCOLS, 1.0 / NROWS   # u0, v0 (top), du, dv

def build_atlas_mesh():
    allV, allF, allC, allM = [], [], [], []
    off = 0
    for i, P in enumerate(CELL_DEFS):
        rng = np.random.default_rng(2000 + i)
        acc = leaf_cluster(rng, P)
        V = np.array(acc.V); M = np.array(acc.m, float)
        # AO inside the cluster: leaves low in the stack and near the cluster's core are shaded
        leaf = M[:, 2] > 0.3
        z = V[:, 2]; zlo, zhi = np.percentile(z[leaf], 5), np.percentile(z[leaf], 97)
        cxy = V[leaf, :2].mean(0); rr = np.linalg.norm(V[:, :2] - cxy, axis=1); rmax = np.percentile(rr[leaf], 95)
        ao = (0.5 + 0.5 * smoothstep(zlo, zhi, z)) * (0.78 + 0.22 * smoothstep(0.1 * rmax, rmax, rr))
        M[leaf, 0] = ao[leaf]
        M[~leaf, 0] = 0.5 * (0.8 + 0.2 * smoothstep(0.1 * rmax, rmax, rr[~leaf]))
        margin = 0.012
        V[:, 0] -= V[:, 0].min() - 0.001
        sx = (CELL_W - margin) / max(V[:, 0].max(), 1e-6)
        sy = (CELL_H / 2 - margin) / max(np.abs(V[:, 1]).max(), 1e-6)
        sc = min(1.6, sx, sy)      # clusters are scaled to fill their cell
        V *= sc
        V[:, 0] -= V[:, 0].min() - 0.001
        col, row = i % NCOLS, i // NCOLS
        V[:, 0] += col * CELL_W
        V[:, 1] += -(row + 0.5) * CELL_H
        log(f'cell {i} {P["shape"]}: {len(acc.F)} faces, leaves~{len(acc.F)//(64 if P['shape']=='oak' else 40)}, fit scale {sc:.3f}')
        allV.append(V); allC.append(np.array(acc.col)); allM.append(M)
        allF.extend([tuple(x + off for x in f) for f in acc.F])
        off += len(V)
    return np.concatenate(allV), allF, np.concatenate(allC), np.concatenate(allM)

def mesh_from(name, V, F):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in V], [], F)
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob

def set_point_color(me, name, rgb):
    a = me.attributes.new(name, 'FLOAT_COLOR', 'POINT')
    rgba = np.concatenate([rgb, np.ones((len(rgb), 1))], 1).astype(np.float32)
    a.data.foreach_set('color', rgba.ravel())

def emission_material(name, kind):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree; nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission'); em.inputs['Strength'].default_value = 1.0
    if kind == 'normal':
        g = nt.nodes.new('ShaderNodeNewGeometry')
        mul = nt.nodes.new('ShaderNodeVectorMath'); mul.operation = 'MULTIPLY_ADD'
        mul.inputs[1].default_value = (0.5, 0.5, 0.5); mul.inputs[2].default_value = (0.5, 0.5, 0.5)
        nt.links.new(g.outputs['Normal'], mul.inputs[0])
        nt.links.new(mul.outputs[0], em.inputs['Color'])
    else:
        at = nt.nodes.new('ShaderNodeAttribute'); at.attribute_type = 'GEOMETRY'
        at.attribute_name = kind
        nt.links.new(at.outputs['Color'], em.inputs['Color'])
    nt.links.new(em.outputs[0], out.inputs['Surface'])
    return m

def render_exr(sc, path):
    sc.render.filepath = path
    s = sc.render.image_settings
    s.file_format = 'OPEN_EXR'; s.color_depth = '32'; s.color_mode = 'RGBA'
    bpy.ops.render.render(write_still=True)
    gpu_check()

def load_pixels(path):
    img = bpy.data.images.load(path, check_existing=False)
    img.colorspace_settings.name = 'Non-Color'
    w, h = img.size
    arr = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(arr)
    bpy.data.images.remove(img)
    return arr.reshape(h, w, 4)[::-1].copy()      # top-down

def save_image(path, arr, quality=100):
    """arr: (H,W,4) float 0..1, top-down, values written raw (no colour transform)."""
    h, w = arr.shape[:2]
    img = bpy.data.images.new('tmp_save', w, h, alpha=True, float_buffer=False)
    img.colorspace_settings.name = 'Non-Color'
    img.alpha_mode = 'STRAIGHT'
    img.pixels.foreach_set(np.ascontiguousarray(arr[::-1], dtype=np.float32).ravel())
    img.filepath_raw = path
    img.file_format = 'WEBP' if path.endswith('.webp') else 'PNG'
    img.save(filepath=path, quality=quality)
    bpy.data.images.remove(img)
    log('wrote', path, os.path.getsize(path) // 1024, 'KB')

def pushpull(col, w):
    """Fill colour where weight w is low from the surrounding valid colour (pyramid fill).
    Texels with w=1 keep their colour exactly. Needs power-of-two square input."""
    pc = [col * w[..., None]]; pw = [w.astype(np.float32)]
    while pc[-1].shape[0] > 1:
        c = pc[-1]; ww = pw[-1]; h, wd = ww.shape
        c2 = c.reshape(h // 2, 2, wd // 2, 2, -1).sum((1, 3))
        w2 = ww.reshape(h // 2, 2, wd // 2, 2).sum((1, 3))
        s = np.minimum(w2, 1.0) / np.maximum(w2, 1e-8)
        pc.append(c2 * s[..., None]); pw.append(np.minimum(w2, 1.0))
    cur = pc[-1] / np.maximum(pw[-1], 1e-8)[..., None]
    for lvl in range(len(pc) - 2, -1, -1):
        up = np.repeat(np.repeat(cur, 2, 0), 2, 1)
        cur = pc[lvl] + (1 - pw[lvl])[..., None] * up
    return cur

def stage_atlas():
    t0 = time.time()
    sc = reset_scene()
    V, F, C, M = build_atlas_mesh()
    ob = mesh_from('atlas', V, F)
    me = ob.data
    set_point_color(me, 'col', C)
    set_point_color(me, 'm', M)
    me.shade_smooth()
    log('atlas mesh', len(V), 'verts', len(F), 'faces', f'{time.time()-t0:.1f}s')
    cam_d = bpy.data.cameras.new('cam'); cam_d.type = 'ORTHO'; cam_d.ortho_scale = NCOLS * CELL_W
    cam_d.clip_start = 0.1; cam_d.clip_end = 20
    cam = bpy.data.objects.new('cam', cam_d); sc.collection.objects.link(cam)
    cam.location = (NCOLS * CELL_W / 2, -NROWS * CELL_H / 2, 5.0)
    sc.camera = cam
    SS = 2
    sc.render.resolution_x = ATLAS * SS; sc.render.resolution_y = ATLAS * SS
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = True
    sc.render.filter_size = 1.0
    sc.eevee.taa_render_samples = 16
    sc.view_settings.view_transform = 'Standard'
    passes = {}
    for kind in ('col', 'normal', 'm'):
        me.materials.clear(); me.materials.append(emission_material('em_' + kind, kind))
        p = f'{TMP}/atlas_{kind}.exr'
        render_exr(sc, p)
        a = load_pixels(p)
        a = a.reshape(ATLAS, SS, ATLAS, SS, 4).mean((1, 3))   # box downsample (premultiplied)
        passes[kind] = a
        log('pass', kind, f'{time.time()-t0:.1f}s')
    alpha = passes['col'][..., 3]
    edge = (alpha > 0.08) & (alpha < 0.4)
    inner = alpha > 0.99
    rgb_edge = passes['col'][..., :3][edge].max(1).mean()
    rgb_in = passes['col'][..., :3][inner].max(1).mean()
    premul = abs(rgb_edge / alpha[edge].mean() - rgb_in) < abs(rgb_edge - rgb_in)
    log(f'premul check: edge {rgb_edge:.3f} inner {rgb_in:.3f} -> premultiplied={premul}')
    def straight(a):
        rgb = a[..., :3]
        if premul:
            rgb = rgb / np.maximum(a[..., 3:4], 1e-6)
        return np.clip(rgb, 0, 1)
    wgt = np.clip((alpha - 0.02) * 2.2, 0, 1)
    col = pushpull(straight(passes['col']), wgt)
    nraw = straight(passes['normal']) * 2 - 1
    nraw = nrm(nraw)
    nraw[..., 2] = np.abs(nraw[..., 2])
    flat = np.array([0, 0, 1.0])
    nmap = nrm(lerp(flat, nraw, 0.6))
    nmap = nrm(pushpull(nmap, wgt))
    mm = pushpull(straight(passes['m']), wgt)
    a8 = np.clip(alpha, 1.0 / 255, 1.0)
    cov = (alpha > 0.5).mean()
    log(f'atlas coverage (alpha>0.5): {cov*100:.1f}%')
    for i in range(len(CELL_DEFS)):
        u0, v0, du, dv = cell_uv(i)
        y0, x0 = int(v0 * ATLAS), int(u0 * ATLAS)
        cc = (alpha[y0:y0 + int(dv * ATLAS), x0:x0 + int(du * ATLAS)] > 0.5).mean()
        log(f'  cell {i} coverage {cc*100:.1f}%')
    save_image(f'{TEXD}/broadleaf_leaves_c.webp', np.dstack([col, a8]))
    save_image(f'{TEXD}/broadleaf_leaves_n.webp', np.dstack([nmap * 0.5 + 0.5, np.ones_like(alpha)]))
    m_out = np.dstack([mm[..., 0], mm[..., 1], np.zeros_like(alpha), np.clip(mm[..., 2], 1.0 / 255, 1)])
    save_image(f'{TEXD}/broadleaf_leaves_m.webp', m_out)
    log('atlas done', f'{time.time()-t0:.1f}s')

# =========================================================================== BARK
def fft_noise(h, w, sy, sx, rng):
    n = rng.standard_normal((h, w)).astype(np.float32)
    fy = np.fft.fftfreq(h)[:, None]; fx = np.fft.fftfreq(w)[None, :]
    g = np.exp(-2 * np.pi ** 2 * ((fy * sy) ** 2 + (fx * sx) ** 2))
    r = np.fft.ifft2(np.fft.fft2(n) * g).real
    return ((r - r.mean()) / (r.std() + 1e-8)).astype(np.float32)

def worley(h, w, gh, gw, rng, warp=None):
    """Periodic (toroidal) Worley noise on a jittered grid. Returns F1, F2, cell id."""
    cy, cx = h / gh, w / gw
    jy = rng.uniform(0.1, 0.9, (gh, gw)); jx = rng.uniform(0.1, 0.9, (gh, gw))
    Y = np.broadcast_to(np.arange(h, dtype=np.float32)[:, None] + 0.5, (h, w)).copy()
    X = np.broadcast_to(np.arange(w, dtype=np.float32)[None, :] + 0.5, (h, w)).copy()
    if warp is not None:
        Y += warp[0]; X += warp[1]
    ci = np.floor(Y / cy).astype(np.int64); cj = np.floor(X / cx).astype(np.int64)
    F1 = np.full((h, w), 1e9, np.float32); F2 = F1.copy(); ID = np.zeros((h, w), np.int64)
    asp = cy / cx
    for oy in range(-2, 3):
        for ox in range(-2, 3):
            ni = ci + oy; nj = cj + ox
            mi = ni % gh; mj = nj % gw
            py = (ni + jy[mi, mj]) * cy; px = (nj + jx[mi, mj]) * cx
            d = np.sqrt(((Y - py) / asp) ** 2 + (X - px) ** 2).astype(np.float32)
            m1 = d < F1; m2 = (~m1) & (d < F2)
            F2 = np.where(m1, F1, np.where(m2, d, F2))
            ID = np.where(m1, mi * gw + mj, ID)
            F1 = np.where(m1, d, F1)
    return F1, F2, ID

def blur_periodic(a, s):
    h, w = a.shape
    fy = np.fft.fftfreq(h)[:, None]; fx = np.fft.fftfreq(w)[None, :]
    g = np.exp(-2 * np.pi ** 2 * ((fy * s) ** 2 + (fx * s) ** 2))
    return np.fft.ifft2(np.fft.fft2(a) * g).real.astype(np.float32)

def bark_strip(kind, h, w, rng):
    srgb = lambda *c: np.array(c, np.float32)
    if kind == 'oak':
        # blocky grey-brown plates split by deep dark furrows, a little green lichen in the cracks
        warp = (fft_noise(h, w, 18, 12, rng) * 7, fft_noise(h, w, 18, 12, rng) * 5)
        F1, F2, ID = worley(h, w, 30, 13, rng, warp)
        fis = 1 - smoothstep(1.0, 7.0, F2 - F1)
        f1, f2, id2 = worley(h, w, 110, 26, rng, (warp[0] * 0.4, warp[1] * 0.4))
        crack = 1 - smoothstep(0.0, 2.2, f2 - f1)
        n1 = fft_noise(h, w, 24, 24, rng); n2 = fft_noise(h, w, 3, 3, rng); n3 = fft_noise(h, w, 90, 60, rng)
        hgt = (0.66 + 0.10 * n1 + 0.04 * n2 - 0.16 * crack) * (1 - fis) + fis * (0.05 + 0.03 * n2)
        pid = np.random.default_rng(7).uniform(0, 1, 30 * 13)[ID]
        plate = lerp(srgb(0.27, 0.25, 0.22), srgb(0.38, 0.355, 0.32), pid[..., None])
        plate *= (0.86 + 0.12 * n1)[..., None]
        lichen = (smoothstep(0.7, 1.6, n3) * 0.55)[..., None]
        plate = lerp(plate, srgb(0.30, 0.33, 0.22), lichen)
        fisc = srgb(0.07, 0.06, 0.05)
        col = lerp(plate, fisc, smoothstep(0.12, 0.8, fis)[..., None])
        col = lerp(col, fisc * 1.5, (crack * 0.45)[..., None])
        strength = 7.0
    elif kind == 'cottonwood':
        # long interlacing grey ridges, deep narrow furrows
        warp = (fft_noise(h, w, 40, 9, rng) * 8, fft_noise(h, w, 34, 7, rng) * 9)
        F1, F2, ID = worley(h, w, 14, 19, rng, warp)
        fis = 1 - smoothstep(1.0, 7.0, F2 - F1)
        n1 = fft_noise(h, w, 30, 8, rng); n2 = fft_noise(h, w, 3, 3, rng); n3 = fft_noise(h, w, 120, 50, rng)
        ridge = smoothstep(0, 18, F2 - F1)
        hgt = (0.5 + 0.25 * ridge + 0.08 * n1 + 0.04 * n2) * (1 - 0.9 * fis)
        pid = np.random.default_rng(8).uniform(0, 1, 14 * 19)[ID]
        base = lerp(srgb(0.36, 0.345, 0.32), srgb(0.47, 0.455, 0.42), pid[..., None])
        base *= (0.85 + 0.15 * ridge + 0.06 * n1)[..., None]
        base = lerp(base, srgb(0.32, 0.30, 0.25), (smoothstep(0.5, 1.5, n3) * 0.5)[..., None])
        col = lerp(base, srgb(0.09, 0.08, 0.07), smoothstep(0.1, 0.85, fis)[..., None])
        strength = 5.0
    elif kind == 'smooth':
        # young limbs: smooth grey with horizontal lenticel dashes and faint rings
        n1 = fft_noise(h, w, 18, 18, rng); n2 = fft_noise(h, w, 2, 2, rng)
        lent = fft_noise(h, w, 1.6, 7.0, rng)
        dash = smoothstep(2.0, 2.8, lent)
        hgt = 0.6 + 0.05 * n1 + 0.02 * n2 - 0.12 * dash
        col = lerp(srgb(0.36, 0.345, 0.31), srgb(0.44, 0.425, 0.385), (0.5 + 0.25 * n1)[..., None])
        col = lerp(col, srgb(0.17, 0.15, 0.13), (dash * 0.75)[..., None])
        strength = 1.5
    else:  # branch bark: finer ridges
        warp = (fft_noise(h, w, 10, 6, rng) * 4, fft_noise(h, w, 10, 6, rng) * 3)
        F1, F2, ID = worley(h, w, 48, 12, rng, warp)
        fis = 1 - smoothstep(0.3, 2.4, F2 - F1)
        n1 = fft_noise(h, w, 16, 12, rng); n2 = fft_noise(h, w, 2, 2, rng)
        hgt = (0.6 + 0.1 * n1 + 0.04 * n2) * (1 - 0.65 * fis)
        pid = np.random.default_rng(10).uniform(0, 1, 48 * 12)[ID]
        base = lerp(srgb(0.29, 0.27, 0.24), srgb(0.37, 0.35, 0.31), pid[..., None]) * (0.9 + 0.1 * n1[..., None])
        col = lerp(base, srgb(0.10, 0.085, 0.07), (fis * 0.75)[..., None])
        strength = 2.5
    hgt = np.clip(hgt, 0, 1).astype(np.float32)
    dx = (np.roll(hgt, -1, 1) - np.roll(hgt, 1, 1)) * 0.5
    dy = (np.roll(hgt, -1, 0) - np.roll(hgt, 1, 0)) * 0.5      # +row = image down
    n = nrm(np.dstack([-dx * strength, dy * strength, np.ones_like(hgt)]))
    cav = hgt - blur_periodic(hgt, 10)
    ao = np.clip(0.5 + 0.5 * smoothstep(0.0, 0.6, hgt) + cav * 1.2, 0.15, 1)
    rough = np.clip(0.80 + 0.17 * (1 - hgt), 0, 1)
    return np.clip(col, 0, 1), n, ao, rough

BARK_KINDS = ['oak', 'cottonwood', 'smooth', 'branch']
BARK_STRIP = {k: i for i, k in enumerate(BARK_KINDS)}

def stage_bark():
    t0 = time.time()
    H, W = 2048, 512
    C = np.zeros((H, 4 * W, 3), np.float32); N = C.copy(); AO = np.zeros((H, 4 * W), np.float32); R = AO.copy()
    for k, kind in enumerate(BARK_KINDS):
        c, n, ao, r = bark_strip(kind, H, W, np.random.default_rng(60 + k))
        C[:, k * W:(k + 1) * W] = c; N[:, k * W:(k + 1) * W] = n
        AO[:, k * W:(k + 1) * W] = ao; R[:, k * W:(k + 1) * W] = r
        log('bark strip', kind, f'{time.time()-t0:.1f}s')
    one = np.ones((H, 4 * W), np.float32)
    save_image(f'{TEXD}/broadleaf_bark_c.webp', np.dstack([C, one]))
    save_image(f'{TEXD}/broadleaf_bark_n.webp', np.dstack([N * 0.5 + 0.5, one]))
    save_image(f'{TEXD}/broadleaf_bark_m.webp', np.dstack([AO, R, np.zeros_like(AO), one]))

def strip_u(k):
    e = 0.75 / ATLAS
    return k * 0.25 + e, (k + 1) * 0.25 - e

# =========================================================================== TREES
SPECIES = {
    # wide spreading lone-meadow oak: short thick trunk forking low into heavy limbs, broad lumpy dome
    'a': dict(id='oak_a', H=14.0, seed=101, r0=0.50, tip_r=0.011, pipe_e=2.35, flare=0.6, trunk_sides=16,
              fork_y=2.4, crown_base=3.0, n_attr=3800, shell=1.6, di=2.4, dk=0.55, D=0.33, trop=0.05,
              bark_big='oak', bark_mid='branch', bark_small='branch', cells=(0, 0, 1), dense=1,
              anchors=4100, size=(1.05, 1.4)),
    # taller narrower cottonwood: leader to the top, limbs all the way up, irregular crown
    'b': dict(id='oak_b', H=18.0, seed=202, r0=0.40, tip_r=0.010, pipe_e=2.3, flare=0.5, trunk_sides=14,
              fork_y=3.8, crown_base=4.3, n_attr=3000, shell=1.4, di=2.1, dk=0.5, D=0.32, trop=0.16,
              bark_big='cottonwood', bark_mid='branch', bark_small='smooth', cells=(2, 2, 3), dense=3,
              anchors=3500, size=(0.95, 1.3)),
}

# ---- crown envelope: smooth union of ellipsoids, cut flat-ish at the crown base
def ell_sdf(P, c, r):
    q = (P - c) / r
    k0 = np.linalg.norm(q, axis=-1); k1 = np.linalg.norm(q / r, axis=-1)
    return k0 * (k0 - 1) / np.maximum(k1, 1e-9)

def smin(a, b, k):
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1)
    return lerp(b, a, h) - k * h * (1 - h)

def env_sdf(E, P, parts=False):
    P = np.atleast_2d(P)
    ds = [ell_sdf(P, c, r) for c, r in E['blobs']]
    d = ds[0]
    for x in ds[1:]:
        d = smin(d, x, E['k'])
    d = np.maximum(d, (E['ybase'] - P[:, 1]) * 1.0)
    return (d, np.array(ds)) if parts else d

def env_grad(E, P):
    e = 0.06; g = np.zeros_like(P)
    for a in range(3):
        o = np.zeros(3); o[a] = e
        g[:, a] = env_sdf(E, P + o) - env_sdf(E, P - o)
    return nrm(g)

def make_envelope(key, rng):
    P = SPECIES[key]; H = P['H']
    blobs = []
    if key == 'a':
        c0 = np.array([0.0, 8.4, 0.0]); r0 = np.array([7.4, 4.9, 7.2])
        blobs.append((c0, r0))
        n = 17
        for i in range(n):
            az = i * 2.39996 + rng.normal(0, 0.25)
            el = math.radians(lerp(-12, 72, (i + 0.5) / n) + rng.normal(0, 6))
            dirn = np.array([math.cos(el) * math.cos(az), math.sin(el), math.cos(el) * math.sin(az)])
            rs = rng.uniform(2.3, 3.4)
            c = c0 + dirn * r0 * rng.uniform(0.70, 0.84)
            blobs.append((c, np.array([rs, rs * 0.82, rs])))
        ybase = P['crown_base']
    else:
        c0 = np.array([0.25, 11.2, -0.1]); r0 = np.array([3.2, 6.2, 3.0])
        blobs.append((c0, r0))
        n = 10
        for i in range(n):
            az = i * 2.39996 + rng.normal(0, 0.4)
            el = math.radians(lerp(-35, 65, (i + 0.5) / n) + rng.normal(0, 14))
            dirn = np.array([math.cos(el) * math.cos(az), math.sin(el), math.cos(el) * math.sin(az)])
            rs = rng.uniform(1.8, 2.9)
            c = c0 + dirn * r0 * rng.uniform(0.8, 1.08)
            blobs.append((c, np.array([rs, rs * 0.85, rs])))
        # an irregular side lobe and a leaning top
        blobs.append((c0 + np.array([3.6, -3.0, 1.2]), np.array([2.4, 1.9, 2.2])))
        blobs.append((c0 + np.array([-2.8, -0.8, -2.0]), np.array([2.0, 1.7, 1.9])))
        blobs.append((c0 + np.array([-0.9, 5.2, 0.6]), np.array([1.9, 1.7, 1.9])))
        ybase = P['crown_base']
    E = dict(blobs=blobs, k=1.1, ybase=ybase)
    # scale vertically about the crown base so the envelope top sits at H - 0.45 (cards add the rest)
    S = sample_inside(E, 20000, rng, shell=99)
    top = S[:, 1].max()
    s = (H - 0.45 - ybase) / (top - ybase)
    E['blobs'] = [(np.array([c[0], ybase + (c[1] - ybase) * s, c[2]]), r * np.array([1, s, 1])) for c, r in blobs]
    S = sample_inside(E, 20000, rng, shell=99)
    log(f'{P["id"]} envelope: top {S[:,1].max():.2f} base {S[:,1].min():.2f} '
        f'width x {np.ptp(S[:,0]):.2f} z {np.ptp(S[:,2]):.2f}')
    return E

def env_bbox(E):
    lo = np.min([c - r for c, r in E['blobs']], 0); hi = np.max([c + r for c, r in E['blobs']], 0)
    lo[1] = max(lo[1], E['ybase'])
    return lo, hi

def sample_inside(E, n, rng, shell):
    lo, hi = env_bbox(E)
    out = []; got = 0
    while got < n:
        P = rng.uniform(lo, hi, (n * 3, 3))
        d = env_sdf(E, P)
        keep = (d < 0) & (rng.random(len(P)) < np.where(-d < shell, 1.0, 0.1))
        out.append(P[keep]); got += keep.sum()
    return np.concatenate(out)[:n]

# ---- node tree
class NTree:
    def __init__(s):
        s.pos = []; s.par = []; s.scaf = []; s.ch = []
    def add(s, p, parent, scaf):
        s.pos.append(np.array(p, float)); s.par.append(parent); s.scaf.append(scaf); s.ch.append([])
        if parent >= 0:
            s.ch[parent].append(len(s.pos) - 1)
        return len(s.pos) - 1
    def add_path(s, pts, parent, scaf=True):
        idx = [parent]
        for p in pts[1:]:
            idx.append(s.add(p, idx[-1], scaf))
        return idx

def grow_path(p0, d0, L, step, droop, upturn, noise, rng, up_bias=0.0):
    n = max(2, int(math.ceil(L / step)))
    ds = L / n
    pts = [np.array(p0, float)]; d = nrm(d0)
    for i in range(n):
        t = (i + 1) / n
        d = nrm(d + (-Yv * droop * (1 - t) * 0.9 + Yv * upturn * t ** 2 + Yv * up_bias) * ds
                + rng.normal(0, noise, 3) * ds)
        if pts[-1][1] + d[1] * ds < 0.6 and d[1] < 0:
            d = nrm(np.array([d[0], 0.15, d[2]]))
        pts.append(pts[-1] + d * ds)
    return np.array(pts)

def build_scaffold(key, rng):
    P = SPECIES[key]; T = NTree()
    root = T.add([0, 0, 0], -1, True)
    if key == 'a':
        yf = P['fork_y']
        lean = np.array([rng.normal(0, 0.12), 0, rng.normal(0, 0.12)])
        ys = np.linspace(0, yf, 8)
        pts = np.array([lean * (y / yf) ** 1.5 + np.array([0.04 * math.sin(y * 2.1), y, 0.04 * math.cos(y * 1.7)]) for y in ys])
        tr = T.add_path(pts, root)
        fork = tr[-1]; fp = T.pos[fork]
        az0 = rng.uniform(0, 2 * math.pi)
        nl = 4
        for i in range(nl):
            az = az0 + i * 2 * math.pi / nl + rng.normal(0, 0.3)
            el = math.radians(rng.uniform(30, 48))
            d0 = np.array([math.cos(el) * math.cos(az), math.sin(el), math.cos(el) * math.sin(az)])
            L = rng.uniform(5.2, 6.6)
            pts = grow_path(fp + d0 * 0.05, d0, L, 0.35, 0.16, 0.08, 0.22, rng)
            idx = T.add_path(np.vstack([fp, pts]), fork)
            # heavy limbs fork again part way out
            for f in range(2):
                k = int(len(idx) * rng.uniform(0.35, 0.65))
                dd = nrm(T.pos[idx[k + 1]] - T.pos[idx[k]])
                sg = 1 if f == 0 else -1
                d1 = nrm(rot_about(dd, Yv, sg * rng.uniform(0.5, 0.9)) + Yv * rng.uniform(0.15, 0.5))
                p2 = grow_path(T.pos[idx[k]], d1, rng.uniform(2.6, 4.0), 0.35, 0.15, 0.1, 0.25, rng)
                T.add_path(p2, idx[k])
        # central upright limb filling the top of the dome
        d0 = nrm(Yv * 3 + rng.normal(0, 0.3, 3))
        pts = grow_path(fp, d0, 5.5, 0.35, 0.0, 0.0, 0.25, rng)
        T.add_path(pts, fork)
    else:
        H = P['H']; top = H - 4.6
        ph = rng.uniform(0, 2 * math.pi, 4)
        def cen(y):
            t = y / H
            return np.array([0.35 * (math.sin(t * 2.4 + ph[0]) - math.sin(ph[0])), y,
                             0.3 * (math.sin(t * 2.0 + ph[1]) - math.sin(ph[1]))])
        ys = np.arange(0, top + 1e-6, 0.4)
        tr = T.add_path(np.array([cen(y) for y in ys]), root)
        # codominant fork near the top of the bole
        kf = int(np.searchsorted(ys, 9.8))
        d0 = nrm(Yv * 2.6 + np.array([math.cos(ph[2]), 0, math.sin(ph[2])]))
        T.add_path(grow_path(T.pos[tr[kf]], d0, 5.4, 0.35, 0.0, 0.05, 0.2, rng), tr[kf])
        nlimb = 10
        for i in range(nlimb):
            q = i / (nlimb - 1)
            y = lerp(3.9, top - 0.5, q) + rng.normal(0, 0.25)
            k = int(np.clip(np.searchsorted(ys, y), 1, len(ys) - 1))
            az = i * 2.39996 + rng.normal(0, 0.35)
            el = math.radians(rng.uniform(32, 55))
            d0 = np.array([math.cos(el) * math.cos(az), math.sin(el), math.cos(el) * math.sin(az)])
            L = lerp(4.0, 2.2, q) * rng.uniform(0.8, 1.2)
            T.add_path(grow_path(T.pos[tr[k]], d0, L, 0.35, 0.12, 0.25, 0.25, rng), tr[k])
    log(f'{P["id"]} scaffold: {len(T.pos)} nodes')
    return T

def colonize(key, T, E, rng):
    from mathutils.kdtree import KDTree
    P = SPECIES[key]
    A = sample_inside(E, P['n_attr'], rng, P['shell'])
    alive = np.ones(len(A), bool)
    di, dk, D = P['di'], P['dk'], P['D']
    elig = [i for i in range(len(T.pos)) if T.pos[i][1] > E['ybase'] - 1.2]
    for it in range(260):
        idx = np.nonzero(alive)[0]
        if len(idx) == 0:
            break
        kd = KDTree(len(elig))
        for j, i in enumerate(elig):
            kd.insert(T.pos[i], j)
        kd.balance()
        accum = {}
        for ai in idx:
            co, j, dist = kd.find(A[ai])
            if dist is not None and dist <= di:
                n = elig[j]
                v = (A[ai] - T.pos[n]) / max(dist, 1e-6)
                accum[n] = accum.get(n, 0) + v
        if not accum:
            break
        new = []
        for n, v in accum.items():
            dv = nrm(nrm(v) + Yv * P['trop'] + rng.normal(0, 0.12, 3))
            dup = False
            for c in T.ch[n]:
                if np.dot(nrm(T.pos[c] - T.pos[n]), dv) > 0.97:
                    dup = True; break
            if dup:
                continue
            new.append(T.add(T.pos[n] + dv * D, n, False))
        if not new:
            break
        elig += new
        kdn = KDTree(len(new))
        for j, i in enumerate(new):
            kdn.insert(T.pos[i], j)
        kdn.balance()
        for ai in idx:
            co, j, dist = kdn.find(A[ai])
            if dist is not None and dist < dk:
                alive[ai] = False
    log(f'{P["id"]} colonised: {len(T.pos)} nodes after {it+1} iterations, {alive.sum()} attractors left')

def finish_tree(key, T, rng):
    """smooth, pipe-model radii, path length, chains"""
    P = SPECIES[key]
    n = len(T.pos)
    pos = np.array(T.pos)
    # smooth colonised nodes (keep the scaffold)
    for _ in range(3):
        new = pos.copy()
        for i in range(n):
            if T.scaf[i] or T.par[i] < 0 or not T.ch[i]:
                continue
            new[i] = 0.5 * pos[i] + 0.25 * pos[T.par[i]] + 0.25 * np.mean([pos[c] for c in T.ch[i]], 0)
        pos = new
    rp = np.full(n, P['tip_r']); e = P['pipe_e']
    hops = np.zeros(n, int)
    for i in range(n - 1, -1, -1):
        if T.ch[i]:
            rp[i] = sum(rp[c] ** e for c in T.ch[i]) ** (1 / e)
            hops[i] = min(hops[c] for c in T.ch[i]) + 1
    g = math.log(P['r0'] / P['tip_r']) / math.log(rp[0] / P['tip_r'])
    r = P['tip_r'] * (rp / P['tip_r']) ** g
    # path length from the root
    pl = np.zeros(n)
    for i in range(1, n):
        pl[i] = pl[T.par[i]] + np.linalg.norm(pos[i] - pos[T.par[i]])
    s0 = P['fork_y']
    bw = np.clip((pl - s0) / (pl.max() - s0), 0, 1) ** 1.3
    # chains: follow the thickest child; the others start new chains
    chains = []
    stack = [(0, -1, 0, rng.random(), True)]
    while stack:
        s, parent, level, phase, is_trunk = stack.pop()
        idx = [parent] if parent >= 0 else []
        cur = s
        if parent >= 0 and r[s] > 0.07:
            phase = rng.random()
        while True:
            idx.append(cur)
            ch = T.ch[cur]
            if not ch:
                break
            main = max(ch, key=lambda c: r[c])
            for c in ch:
                if c != main:
                    stack.append((c, cur, level + 1, phase, False))
            cur = main
        chains.append(dict(idx=idx, level=level, phase=phase, trunk=is_trunk, r0=r[idx[1] if len(idx) > 1 and parent >= 0 else idx[0]]))
    log(f'{P["id"]}: {n} nodes, {len(chains)} chains, trunk r {r[0]:.3f}, tips {int((hops == 0).sum())}, g {g:.2f}')
    return dict(pos=pos, r=r, bw=bw, hops=hops, chains=chains, pl=pl)

class Branch:
    def __init__(s, pts, radii, bw, phase, level):
        s.pts = np.array(pts); s.radii = np.array(radii); s.bw = np.array(bw)
        s.phase = phase; s.level = level
        seg = np.linalg.norm(np.diff(s.pts, axis=0), axis=1)
        s.cs = np.concatenate([[0], np.cumsum(seg)]); s.L = s.cs[-1]
    def at(s, sdist):
        sdist = min(max(sdist, 0), s.L - 1e-9)
        i = min(int(np.searchsorted(s.cs, sdist, side='right') - 1), len(s.pts) - 2)
        t = (sdist - s.cs[i]) / max(s.cs[i + 1] - s.cs[i], 1e-12)
        p = s.pts[i] + (s.pts[i + 1] - s.pts[i]) * t
        d = nrm(s.pts[i + 1] - s.pts[i])
        r = s.radii[i] + (s.radii[i + 1] - s.radii[i]) * t
        bw = s.bw[i] + (s.bw[i + 1] - s.bw[i]) * t
        return p, d, r, bw

class Anchor:
    __slots__ = ('p', 'd', 'size', 'cell', 'phase', 'bw', 'clump', 'r', 'n')
    def __init__(s, **k):
        for a, b in k.items():
            setattr(s, a, b)

def build_skeleton(key):
    P = SPECIES[key]
    rng = np.random.default_rng(P['seed'])
    E = make_envelope(key, rng)
    T = build_scaffold(key, rng)
    colonize(key, T, E, rng)
    F = finish_tree(key, T, rng)
    pos, r, bw = F['pos'], F['r'], F['bw']
    branches = []
    node_phase = np.zeros(len(pos))
    for c in F['chains']:
        idx = c['idx']
        if len(idx) < 2:
            continue
        pts = pos[idx]; rad = r[idx].copy(); w = bw[idx].copy()
        if c['trunk']:
            w *= 0.4
        rad[0] = min(rad[0], rad[1] * 1.05) if not c['trunk'] else rad[0]
        br = Branch(pts, rad, w, c['phase'], c['level'])
        br.trunk = c['trunk']; br.r0 = rad[1] if not c['trunk'] else rad[0]
        rb = br.r0
        br.strip = P['bark_big'] if (c['trunk'] or rb >= 0.12) else (P['bark_mid'] if rb >= 0.035 else P['bark_small'])
        branches.append(br)
        node_phase[idx[1:]] = c['phase']
    # foliage anchors on the twig ends
    cand = [i for i in range(len(pos)) if F['hops'][i] <= 4 and r[i] < 0.05 and T.par[i] >= 0]
    cand = np.array(cand)
    sd = env_sdf(E, pos[cand])
    w = np.where(-sd < 2.4, 1.0 + 2.0 * smoothstep(-2.0, 0.0, sd), 0.08)
    nsel = P['anchors']
    sel = rng.choice(len(cand), nsel, replace=nsel > len(cand), p=w / w.sum())
    sel = cand[sel]
    dup = np.zeros(nsel, bool); seen = set()
    for k, i in enumerate(sel):
        dup[k] = i in seen; seen.add(i)
    G = env_grad(E, pos[sel])
    _, parts = env_sdf(E, pos[sel], parts=True)
    owner = parts.argmin(0)
    anchors = []
    for k, i in enumerate(sel):
        gdir = nrm(pos[i] - pos[T.par[i]])
        d = nrm(0.45 * gdir + 0.55 * G[k] + rng.normal(0, 0.3, 3))
        pk = pos[i] + (rng.normal(0, 0.35, 3) if dup[k] else 0)
        anchors.append(Anchor(p=pk, d=d, size=rng.uniform(*P['size']), cell=int(rng.choice(P['cells'])),
                              phase=node_phase[i], bw=bw[i], clump=E['blobs'][owner[k]][0], r=rng.random(), n=G[k]))
    log(f'{P["id"]} skeleton: {len(branches)} branches, {len(anchors)} foliage anchors (from {len(cand)} candidates)')
    return dict(P=P, E=E, branches=branches, anchors=anchors, H=P['H'])

# --------------------------------------------------------------------------- geometry
class Geo:
    def __init__(s):
        s.P = []; s.N = []; s.UV = []; s.W = []; s.I = []; s.n = 0; s.meta = []
    def add(s, P, N, UV, W, I, meta=None):
        s.P.append(P); s.N.append(N); s.UV.append(UV); s.W.append(W)
        s.I.append(I + s.n); s.n += len(P)
        if meta is not None:
            s.meta.append(meta)
    def arrays(s):
        if not s.P:
            return None
        return dict(P=np.concatenate(s.P), N=np.concatenate(s.N), UV=np.concatenate(s.UV),
                    W=np.concatenate(s.W), I=np.concatenate(s.I))

def emit_tube(geo, G, us, vs, bw, phase):
    """G: (K,S,3) ring grid. us: (u0,u1). vs: (K,) v coords. bw: (K,) bend weights."""
    K, S = G.shape[:2]
    dth = np.roll(G, -1, 1) - np.roll(G, 1, 1)
    dax = np.empty_like(G)
    dax[1:-1] = G[2:] - G[:-2]; dax[0] = G[1] - G[0]; dax[-1] = G[-1] - G[-2]
    N = nrm(np.cross(dth, dax))
    cen = G.mean(1, keepdims=True)
    if np.sum(N * (G - cen)) < 0:
        N = -N
    Gs = np.concatenate([G, G[:, :1]], 1); Ns = np.concatenate([N, N[:, :1]], 1)
    u = np.linspace(us[0], us[1], S + 1)
    UV = np.stack(np.broadcast_arrays(u[None, :], np.asarray(vs)[:, None]), -1)
    W = np.zeros((K, S + 1, 4))
    W[..., 0] = np.asarray(bw)[:, None]; W[..., 2] = phase
    k = np.arange(K - 1)[:, None]; j = np.arange(S)[None, :]
    a = k * (S + 1) + j; b = a + 1; c = a + (S + 1); d = c + 1
    I = np.stack([a, c, b, b, c, d], -1).reshape(-1, 3)   # CCW seen from outside
    geo.add(Gs.reshape(-1, 3), Ns.reshape(-1, 3), UV.reshape(-1, 2), W.reshape(-1, 4), I)
    return (K - 1) * S * 2

def ring_frames(pts):
    """parallel-transport frames along a polyline"""
    n = len(pts)
    T = nrm(np.array([pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)] for i in range(n)]))
    u, _ = frame(T[0])
    U = [u]
    for i in range(1, n):
        u = U[-1] - T[i] * np.dot(U[-1], T[i])
        U.append(nrm(u))
    U = np.array(U); Wv = np.cross(T, U)
    return T, U, Wv

def tube_branch(geo, br, sides, step, flare=0.0):
    L = br.L
    nseg = max(1, int(round(L / step)))
    ss = np.linspace(0, L, nseg + 1)
    if flare > 0:      # trunk: dense rings in the root flare, one ring below ground
        ss = np.unique(np.concatenate([[0.0, 0.12, 0.3, 0.55, 0.9], ss[ss > 1.2]]))
    samp = [br.at(s) for s in ss]
    pts = np.array([x[0] for x in samp]); rad = np.array([x[2] for x in samp]); bw = np.array([x[3] for x in samp])
    if flare > 0:
        pts = np.vstack([pts[:1] - Yv * 0.25, pts]); rad = np.concatenate([rad[:1], rad])
        bw = np.concatenate([bw[:1], bw]); ss = np.concatenate([[-0.25], ss])
    T, U, Wv = ring_frames(pts)
    ang = np.linspace(0, 2 * math.pi, sides, endpoint=False)
    if flare > 0:
        y = pts[:, 1]
        amp = flare * 0.55 * np.exp(-np.maximum(y, 0) / 0.5)
        lobes = np.maximum(0, np.cos(5 * ang[None, :] + 1.3 + 0.6 * np.sin(2 * ang[None, :]))) ** 3 - 0.2
        rr = (rad * (1 + flare * np.exp(-np.maximum(y, 0) / 0.6)))[:, None] * (1 + amp[:, None] * lobes)
    else:
        rr = np.repeat(rad[:, None], sides, 1)
    G = pts[:, None, :] + (U[:, None, :] * np.cos(ang)[None, :, None] + Wv[:, None, :] * np.sin(ang)[None, :, None]) * rr[..., None]
    circ = 2 * math.pi * max(br.r0, 0.01)
    vs = -ss / (circ * 4.0 * (0.8 if flare > 0 else 1.0))
    return emit_tube(geo, G, strip_u(BARK_STRIP[br.strip]), vs, bw, br.phase)

def emit_card(geo, base, d, side, Lc, cell, phase, bw, meta, segs=1, droop=0.0):
    """card along d from base (twig end at the cell's left edge), width Lc * cell aspect across `side`"""
    u0, v0, du, dv = cell_uv(cell)
    e = 1.5 / ATLAS
    w = Lc * CELL_H / CELL_W
    P = []; UV = []; Wd = []
    for i in range(segs + 1):
        t = i / segs
        c = base + d * Lc * t - Yv * droop * Lc * t * t
        for sgn, vv in ((1, v0 + e), (-1, v0 + dv - e)):
            P.append(c + side * sgn * w * 0.5)
            UV.append((u0 + e + (du - 2 * e) * t, vv))
            Wd.append((min(1.0, bw + 0.12 * Lc * t), t, phase, 0.0))
    P = np.array(P); UV = np.array(UV); Wd = np.array(Wd)
    I = []
    for i in range(segs):
        a = 2 * i; b = a + 1; c = a + 2; dd = a + 3
        I += [(a, b, c), (b, dd, c)]
    geo.add(P, np.zeros_like(P), UV, Wd, np.array(I), meta)
    return 2 * segs

LOD_CFG = {
    0: dict(trunk_sides=None, min_r=0.02, min_L=0.4, steps=(0.4, 0.7, 1.0), sides=(12, 8, 6, 4, 3, 3),
            keep=1.0, scale=1.0, cards=2, use_dense=False, inset=0.0),
    1: dict(trunk_sides=10, min_r=0.034, min_L=0.6, steps=(0.8, 1.2, 1.8), sides=(8, 6, 5, 4, 3, 3),
            keep=0.42, scale=1.42, cards=2, use_dense=True, inset=0.3),
    2: dict(trunk_sides=7, min_r=0.085, min_L=1.0, steps=(2.5, 3.5, 5.0), sides=(5, 4, 4, 3, 3, 3),
            keep=0.13, scale=2.5, cards=2, use_dense=True, inset=0.7),
}

def sides_for(r, S):
    for th, s in zip((0.2, 0.1, 0.05, 0.03, 0.018), S):
        if r >= th:
            return s
    return S[-1]

def build_lod(sk, lod):
    P = sk['P']; cfg = LOD_CFG[lod]; E = sk['E']
    bark = Geo(); ndl = Geo()
    tris_b = 0
    for br in sk['branches']:
        if br.trunk:
            tris_b += tube_branch(bark, br, cfg['trunk_sides'] or P['trunk_sides'], cfg['steps'][0] * 0.8, flare=P['flare'])
            continue
        if br.r0 < cfg['min_r'] or br.L < cfg['min_L']:
            continue
        st = cfg['steps'][0] if br.r0 >= 0.1 else (cfg['steps'][1] if br.r0 >= 0.04 else cfg['steps'][2])
        tris_b += tube_branch(bark, br, sides_for(br.r0, cfg['sides']), st)
    rng = np.random.default_rng(77 + lod)
    tris_n = 0
    for a in sk['anchors']:
        if a.r >= cfg['keep']:
            continue
        Lc = a.size * cfg['scale']
        cell = a.cell
        if cfg['use_dense'] and rng.random() < 0.6:
            cell = P['dense']
        centre = a.p - a.n * cfg['inset']
        u, w = frame(a.d)
        ph0 = rng.uniform(0, math.pi)
        n = cfg['cards']
        for k in range(n):
            ang = ph0 + k * math.pi / n + rng.normal(0, 0.2)
            side = u * math.cos(ang) + w * math.sin(ang)
            dk = nrm(rot_about(a.d, side, rng.normal(0, 0.25)))
            L = Lc * rng.uniform(0.88, 1.06)
            base = centre - dk * L * 0.5
            tris_n += emit_card(ndl, base, dk, side, L, cell, a.phase, a.bw, (a.clump, a.n))
    B = bark.arrays(); Nd = ndl.arrays()
    # crown-oriented normals for cards: envelope gradient (lumps included) + the lump's own centre
    clumps = np.concatenate([np.repeat(m[0][None, :], len(p), 0) for m, p in zip(ndl.meta, ndl.P)])
    G = env_grad(E, Nd['P'])
    Nd['N'] = nrm(0.5 * G + 0.5 * nrm(Nd['P'] - clumps) + np.array([0, 0.12, 0]))
    for g in (B, Nd):
        g['W'][:, 3] = np.clip(g['P'][:, 1] / sk['H'], 0, 1) ** 1.5
    log(f'{P["id"]} LOD{lod}: bark {tris_b} tris, leaves {tris_n} tris, total {tris_b + tris_n}')
    return B, Nd

# --------------------------------------------------------------------------- AO
def build_bvh(B, Nd):
    from mathutils.bvhtree import BVHTree
    V = np.concatenate([B['P'], Nd['P']])
    I = np.concatenate([B['I'], Nd['I'] + len(B['P'])])
    return BVHTree.FromPolygons([tuple(v) for v in V], [tuple(int(x) for x in t) for t in I], all_triangles=True)

def bake_ao(sk, bvh, g, is_leaf):
    from mathutils import Vector
    E = sk['E']
    rng = np.random.default_rng(3)
    dirs = nrm(rng.normal(0, 1, (14, 3)))
    dirs[:, 1] = np.abs(dirs[:, 1]) * 0.8 + 0.2       # mostly upper hemisphere (sky)
    dirs = nrm(dirs)
    P = g['P']; N = g['N']
    sd = env_sdf(E, P)
    depth = np.clip(-sd, 0, 6)
    Gy = env_grad(E, P)[:, 1]
    if is_leaf:
        _, parts = env_sdf(E, P, parts=True)
        lump = parts[1:].min(0) if len(parts) > 1 else parts[0]
        analytic = np.clip(1.0 - 0.15 * depth, 0.35, 1) * (0.68 + 0.32 * smoothstep(-0.8, 0.6, Gy))
        analytic *= 0.62 + 0.38 * smoothstep(-1.6, 0.1, lump)      # shaded creases between the lumps
    else:
        analytic = np.clip(0.95 - 0.10 * depth, 0.4, 1) * np.where(sd < 0, 0.8, 1.0)
        analytic = analytic * (0.7 + 0.3 * smoothstep(0, 2.5, P[:, 1]))
    ao = np.empty(len(P))
    for i in range(len(P)):
        o = Vector(P[i]) + Vector(N[i]) * 0.03
        hits = 0
        for d in dirs:
            dv = Vector(nrm(d + N[i] * 0.6))
            h = bvh.ray_cast(o + dv * 0.05, dv, 3.5)
            if h[0] is not None:
                hits += 1
        ao[i] = np.clip(analytic[i] * (1 - 0.6 * hits / len(dirs)), 0.06, 1.0)
    return ao

# --------------------------------------------------------------------------- GLB
def write_glb(path, name, prims):
    binb = bytearray(); bviews = []; accs = []
    def add(arr, comp, typ, target, minmax=False):
        while len(binb) % 4:
            binb.append(0)
        off = len(binb); b = arr.tobytes(); binb.extend(b)
        bv = {'buffer': 0, 'byteOffset': off, 'byteLength': len(b)}
        if target:
            bv['target'] = target
        bviews.append(bv)
        cnt = arr.shape[0] if arr.ndim > 1 else arr.size
        acc = {'bufferView': len(bviews) - 1, 'componentType': comp, 'count': int(cnt), 'type': typ}
        if minmax:
            acc['min'] = [float(x) for x in arr.min(0)]; acc['max'] = [float(x) for x in arr.max(0)]
        accs.append(acc); return len(accs) - 1
    mats = [
        {'name': 'broadleaf_bark', 'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 1], 'metallicFactor': 0.0, 'roughnessFactor': 1.0}},
        {'name': 'broadleaf_needles', 'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 1], 'metallicFactor': 0.0, 'roughnessFactor': 1.0},
         'alphaMode': 'MASK', 'alphaCutoff': 0.5, 'doubleSided': True},
    ]
    gprims = []
    for g, mi in prims:
        if g is None:
            continue
        n = len(g['P'])
        col = np.zeros((n, 4), np.float32); col[:, 0] = g['AO']
        attrs = {
            'POSITION': add(g['P'].astype(np.float32), 5126, 'VEC3', 34962, True),
            'NORMAL': add(nrm(g['N']).astype(np.float32), 5126, 'VEC3', 34962),
            'TEXCOORD_0': add(g['UV'].astype(np.float32), 5126, 'VEC2', 34962),
            'COLOR_0': add(col, 5126, 'VEC4', 34962),
            '_WIND': add(np.clip(g['W'], 0, 1).astype(np.float32), 5126, 'VEC4', 34962),
        }
        I = g['I'].astype(np.uint16 if n < 65536 else np.uint32).ravel()
        ii = add(I, 5123 if n < 65536 else 5125, 'SCALAR', 34963)
        gprims.append({'attributes': attrs, 'indices': ii, 'material': mi, 'mode': 4})
    while len(binb) % 4:
        binb.append(0)
    js = {'asset': {'version': '2.0', 'generator': 'valley-ride make_broadleaf.py'},
          'scene': 0, 'scenes': [{'nodes': [0]}],
          'nodes': [{'name': name, 'mesh': 0}],
          'meshes': [{'name': name, 'primitives': gprims}],
          'materials': mats, 'accessors': accs, 'bufferViews': bviews,
          'buffers': [{'byteLength': len(binb)}]}
    jb = json.dumps(js, separators=(',', ':')).encode()
    while len(jb) % 4:
        jb += b' '
    total = 12 + 8 + len(jb) + 8 + len(binb)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(jb), 0x4E4F534A)); f.write(jb)
        f.write(struct.pack('<II', len(binb), 0x004E4942)); f.write(binb)
    log('wrote', path, os.path.getsize(path) // 1024, 'KB')

def stage_trees(keys):
    import pickle
    for key in keys:
        t0 = time.time()
        sk = build_skeleton(key)
        lods = {lod: build_lod(sk, lod) for lod in (0, 1, 2)}
        bvh = build_bvh(*lods[0])
        for lod, (B, Nd) in lods.items():
            B['AO'] = bake_ao(sk, bvh, B, False)
            Nd['AO'] = bake_ao(sk, bvh, Nd, True)
            name = f'{sk["P"]["id"]}_LOD{lod}'
            write_glb(f'{OUT}/{sk["P"]["id"]}_lod{lod}.glb', name, [(B, 0), (Nd, 1)])
            with open(f'{TMP}/{sk["P"]["id"]}_lod{lod}.pkl', 'wb') as f:
                pickle.dump((B, Nd, sk['P']['H']), f)
        log(f'{sk["P"]["id"]} done {time.time()-t0:.1f}s')

# =========================================================================== RENDER
def load_tex(name, noncolor):
    img = bpy.data.images.load(f'{TEXD}/{name}.webp', check_existing=True)
    if noncolor:
        img.colorspace_settings.name = 'Non-Color'
    img.alpha_mode = 'STRAIGHT'
    return img

def tree_material(kind):
    m = bpy.data.materials.new(kind)
    m.use_nodes = True
    nt = m.node_tree; nt.nodes.clear(); L = nt.links.new
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    pr = nt.nodes.new('ShaderNodeBsdfPrincipled')
    uv = nt.nodes.new('ShaderNodeUVMap'); uv.uv_map = 'UVMap'
    leaf = 'needle' in kind
    pre = 'broadleaf_leaves' if leaf else 'broadleaf_bark'
    tc = nt.nodes.new('ShaderNodeTexImage'); tc.image = load_tex(pre + '_c', False)
    tn = nt.nodes.new('ShaderNodeTexImage'); tn.image = load_tex(pre + '_n', True)
    tm = nt.nodes.new('ShaderNodeTexImage'); tm.image = load_tex(pre + '_m', True)
    for t in (tc, tn, tm):
        L(uv.outputs[0], t.inputs[0]); t.interpolation = 'Linear'
    at = nt.nodes.new('ShaderNodeAttribute'); at.attribute_type = 'GEOMETRY'; at.attribute_name = 'ao'
    aomix = nt.nodes.new('ShaderNodeMix'); aomix.data_type = 'FLOAT'
    aomix.inputs['A'].default_value = 1.0; aomix.inputs['Factor'].default_value = 0.65
    L(at.outputs['Fac'], aomix.inputs['B'])
    mul = nt.nodes.new('ShaderNodeMix'); mul.data_type = 'RGBA'; mul.blend_type = 'MULTIPLY'
    mul.inputs['Factor'].default_value = 1.0
    L(tc.outputs['Color'], mul.inputs['A'])
    comb = nt.nodes.new('ShaderNodeCombineColor')
    for c in ('Red', 'Green', 'Blue'):
        L(aomix.outputs['Result'], comb.inputs[c])
    L(comb.outputs[0], mul.inputs['B'])
    L(mul.outputs['Result'], pr.inputs['Base Color'])
    sep = nt.nodes.new('ShaderNodeSeparateColor'); L(tm.outputs['Color'], sep.inputs[0])
    L(sep.outputs['Green'], pr.inputs['Roughness'])
    nm = nt.nodes.new('ShaderNodeNormalMap'); nm.uv_map = 'UVMap'
    L(tn.outputs['Color'], nm.inputs['Color']); L(nm.outputs[0], pr.inputs['Normal'])
    if leaf:
        pr.inputs['Specular IOR Level'].default_value = 0.05
        tl = nt.nodes.new('ShaderNodeBsdfTranslucent')
        tint = nt.nodes.new('ShaderNodeMix'); tint.data_type = 'RGBA'; tint.blend_type = 'MULTIPLY'
        tint.inputs['Factor'].default_value = 1.0; tint.inputs['B'].default_value = (0.9, 1.0, 0.45, 1)
        L(mul.outputs['Result'], tint.inputs['A']); L(tint.outputs['Result'], tl.inputs['Color'])
        fac = nt.nodes.new('ShaderNodeMath'); fac.operation = 'MULTIPLY'; fac.inputs[1].default_value = 0.22
        L(tm.outputs['Alpha'], fac.inputs[0])
        mx = nt.nodes.new('ShaderNodeMixShader'); L(fac.outputs[0], mx.inputs[0])
        L(pr.outputs[0], mx.inputs[1]); L(tl.outputs[0], mx.inputs[2])
        tr = nt.nodes.new('ShaderNodeBsdfTransparent')
        # alpha MASK at 0.5 like the game
        thr = nt.nodes.new('ShaderNodeMath'); thr.operation = 'GREATER_THAN'; thr.inputs[1].default_value = 0.5
        L(tc.outputs['Alpha'], thr.inputs[0])
        mx2 = nt.nodes.new('ShaderNodeMixShader'); L(thr.outputs[0], mx2.inputs[0])
        L(tr.outputs[0], mx2.inputs[1]); L(mx.outputs[0], mx2.inputs[2])
        L(mx2.outputs[0], out.inputs['Surface'])
        m.surface_render_method = 'DITHERED'
        try:
            m.use_transparent_shadow = True
        except Exception:
            pass
        m.use_backface_culling = False
    else:
        L(pr.outputs[0], out.inputs['Surface'])
    return m

def make_tree_object(name, B, Nd):
    V = []; I = []; UV = []; N = []; AO = []; MI = []
    off = 0
    for mi, g in enumerate((B, Nd)):
        V.append(g['P']); N.append(g['N']); UV.append(g['UV']); AO.append(g['AO'])
        I.append(g['I'] + off); MI.append(np.full(len(g['I']), mi)); off += len(g['P'])
    V = np.concatenate(V); N = nrm(np.concatenate(N)); UV = np.concatenate(UV); AO = np.concatenate(AO)
    I = np.concatenate(I); MI = np.concatenate(MI)
    tozup = lambda a: np.stack([a[:, 0], -a[:, 2], a[:, 1]], -1)
    me = bpy.data.meshes.new(name)
    me.from_pydata(tozup(V).tolist(), [], I.tolist())
    me.polygons.foreach_set('material_index', MI.astype(np.int32))
    uvl = me.uv_layers.new(name='UVMap')
    luv = UV[I.ravel()].copy(); luv[:, 1] = 1 - luv[:, 1]
    uvl.data.foreach_set('uv', luv.astype(np.float32).ravel())
    a = me.attributes.new('ao', 'FLOAT', 'POINT'); a.data.foreach_set('value', AO.astype(np.float32))
    me.shade_smooth()
    me.normals_split_custom_set_from_vertices(tozup(N).tolist())
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    me.materials.append(bpy.data.materials.get('broadleaf_bark') or tree_material('broadleaf_bark'))
    me.materials.append(bpy.data.materials.get('broadleaf_needles') or tree_material('broadleaf_needles'))
    return ob

def setup_render_scene():
    sc = reset_scene()
    w = bpy.data.worlds.new('sky'); sc.world = w; w.use_nodes = True
    nt = w.node_tree; nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputWorld'); bg = nt.nodes.new('ShaderNodeBackground')
    tc = nt.nodes.new('ShaderNodeTexCoord'); sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    nt.links.new(tc.outputs['Generated'], sep.inputs[0])
    nt.links.new(sep.outputs['Z'], ramp.inputs[0])
    ramp.color_ramp.elements[0].position = 0.5; ramp.color_ramp.elements[0].color = (0.75, 0.80, 0.85, 1)
    ramp.color_ramp.elements[1].position = 0.75; ramp.color_ramp.elements[1].color = (0.25, 0.42, 0.80, 1)
    nt.links.new(ramp.outputs[0], bg.inputs['Color']); bg.inputs['Strength'].default_value = 0.7
    nt.links.new(bg.outputs[0], out.inputs['Surface'])
    bpy.ops.mesh.primitive_plane_add(size=4000)
    g = bpy.context.active_object
    gm = bpy.data.materials.new('ground'); gm.use_nodes = True
    p = gm.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = (0.11, 0.13, 0.045, 1); p.inputs['Roughness'].default_value = 1
    g.data.materials.append(gm)
    sun_d = bpy.data.lights.new('sun', 'SUN'); sun_d.energy = 5.0; sun_d.color = (1.0, 0.9, 0.76)
    sun_d.angle = math.radians(1.0)
    sun = bpy.data.objects.new('sun', sun_d); sc.collection.objects.link(sun)
    cam_d = bpy.data.cameras.new('cam'); cam_d.sensor_fit = 'VERTICAL'; cam_d.clip_end = 3000
    cam = bpy.data.objects.new('cam', cam_d); sc.collection.objects.link(cam); sc.camera = cam
    sc.eevee.taa_render_samples = 64
    sc.render.film_transparent = False
    sc.view_settings.view_transform = 'AgX'
    sc.render.image_settings.file_format = 'PNG'
    return sc, sun, cam

def aim(ob, loc, target):
    from mathutils import Vector
    ob.location = loc
    ob.rotation_mode = 'QUATERNION'
    ob.rotation_quaternion = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y')

def set_sun(sun, az_deg, el_deg):
    from mathutils import Vector
    a, e = math.radians(az_deg), math.radians(el_deg)
    to_sun = Vector((math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), math.sin(e)))
    sun.rotation_mode = 'QUATERNION'
    sun.rotation_quaternion = to_sun.to_track_quat('Z', 'Y')

def stage_render(keys):
    import pickle
    sc, sun, cam = setup_render_scene()
    for key in keys:
        tid = SPECIES[key]['id']
        objs = {}
        for lod in (0, 1, 2):
            with open(f'{TMP}/{tid}_lod{lod}.pkl', 'rb') as f:
                B, Nd, H = pickle.load(f)
            objs[lod] = make_tree_object(f'{tid}_{lod}', B, Nd)
        def show(lod):
            for k, o in objs.items():
                o.hide_render = (k != lod)
        # camera on -Y looking toward +Y. sun azimuth 0 = behind the tree (back light), 180 = behind the camera
        fit = 2 * math.degrees(math.atan(0.62 * H / 45.0))
        views = [
            ('lod0', 0, 45.0, 1.7, 0.5 * H, fit, 640, 640, (215, 38)),
            ('lod1', 1, 45.0, 1.7, 0.5 * H, fit, 640, 640, (215, 38)),
            ('lod2', 2, 45.0, 1.7, 0.5 * H, fit, 640, 640, (215, 38)),
            ('back', 0, 45.0, 1.7, 0.5 * H, fit, 640, 640, (20, 14)),
            ('near', 0, 11.0, 1.7, 0.55 * H, 68, 640, 640, (215, 38)),
            ('far0', 0, 150.0, 1.7, 0.5 * H, 2 * math.degrees(math.atan(0.62 * H / 150.0)), 160, 160, (215, 38)),
            ('far2', 2, 150.0, 1.7, 0.5 * H, 2 * math.degrees(math.atan(0.62 * H / 150.0)), 160, 160, (215, 38)),
        ]
        only = ARGS['views'].split(',') if ARGS['views'] else None
        for (vn, lod, dist, ch, th, fov, rx, ry, sunp) in views:
            if only and vn not in only:
                continue
            show(lod)
            sc.render.resolution_x = rx; sc.render.resolution_y = ry
            cam.data.angle_y = math.radians(fov)
            aim(cam, (0, -dist, ch), (0, 0, th))
            set_sun(sun, *sunp)
            sc.render.filepath = f'{RND}/{tid}_{vn}.png'
            t0 = time.time()
            bpy.ops.render.render(write_still=True)
            gpu_check()
            log('render', tid, vn, f'{time.time()-t0:.1f}s')
        for o in objs.values():
            bpy.data.objects.remove(o)

# =========================================================================== main
def main():
    t0 = time.time()
    keys = ARGS['tree_list']
    log('stages', ARGS['stages'], 'trees', keys)
    if 'atlas' in ARGS['stages']:
        stage_atlas()
    if 'bark' in ARGS['stages']:
        stage_bark()
    if 'trees' in ARGS['stages']:
        stage_trees(keys)
    if 'render' in ARGS['stages']:
        stage_render(keys)
    log(f'all done {time.time()-t0:.1f}s')

if not os.environ.get('BROADLEAF_NOMAIN'):
    main()
