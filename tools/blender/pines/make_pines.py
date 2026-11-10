"""
make_pines.py - procedural pine trees for Valley Ride (Blender 5.1, headless).

Everything is generated here: the needle sprig atlas (modelled needles rendered
orthographically), the bark texture set, the tree skeletons, three LODs per tree as
GLB (hand-written writer, exact attribute layout), and Eevee check renders.

Run (Git Bash):
  MSYS_NO_PATHCONV=1 nice -n 10 E:/blender/blender-5.1.2-windows-x64/blender.exe -b -t 6 \
      --python-exit-code 1 --python F:/valley-ride/tools/blender/pines/make_pines.py -- \
      --stage all [--trees a,b,c] [--allow-software]
Stages: atlas, bark, trees, render, all (= atlas,bark,trees,render). Comma lists allowed.

GLB layout (one mesh, nodes[0] = "<id>_LOD<k>", one primitive per material):
  materials: bark_pine, needles
  POSITION f32x3, NORMAL f32x3, TEXCOORD_0 f32x2 (glTF v-down),
  COLOR_0 f32x4 (R = baked AO, G = B = A = 0),
  _WIND  f32x4 (x branch bend 0 base..1 tip, y needle flutter 0 bark..1 card tip,
               z per-branch phase 0..1, w trunk height weight (y/H)^1.5)
  indices uint16 / uint32, non-interleaved, no compression.
Textures (WebP, out/textures): pine_needles_{c,n,m}.webp, pine_bark_{c,n,m}.webp
  needles_m: R AO, G roughness, B 0, A translucency
  bark_m:    R AO, G roughness, B metallic(0), A 1
Bark atlas: 4 vertical strips (u 0-.25 lodgepole, .25-.5 ponderosa, .5-.75 spruce,
  .75-1 branch bark), each periodic in u inside its strip and tileable in v.
Needle atlas: 2 cols x 4 rows of 1024x512 cells, twig base at the cell's left edge,
  twig axis along +u through the cell's vertical centre.
"""
import bpy, sys, os, re, math, json, struct, time
import numpy as np

ROOT = os.environ.get('VALLEY_WORK', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'build', 'blender')).replace(os.sep, '/') + '/pines'
OUT = ROOT + '/out'
TEXD = OUT + '/textures'
TMP = ROOT + '/tmp'
RND = ROOT + '/renders'
for _d in (OUT, TEXD, TMP, RND):
    os.makedirs(_d, exist_ok=True)

ATLAS = 2048
CELL_W, CELL_H = 0.8, 0.4          # physical size (m) of one atlas cell when modelled
NCOLS, NROWS = 2, 4

def log(*a):
    print('[pines]', *a, flush=True)

# --------------------------------------------------------------------------- args
def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    a = {'stage': 'all', 'trees': 'a,b,c', 'allow_software': False, 'views': ''}
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
NEEDLE_COL = np.array([0.180, 0.255, 0.180])     # sRGB, dark blue-green
NEEDLE_OLD = np.array([0.250, 0.255, 0.150])     # olive older needles
NEEDLE_NEW = np.array([0.340, 0.420, 0.200])     # new growth
TWIG_COL = np.array([0.245, 0.170, 0.115])

class Acc:
    def __init__(s):
        s.V = []; s.F = []; s.col = []; s.m = []
    def v(s, p, c, m):
        s.V.append(p); s.col.append(c); s.m.append(m); return len(s.V) - 1

def add_needle(acc, rng, base, d, L, r, col, ao0, trans, bend):
    """Tapered 3-sided needle, 3 segments, slightly curved."""
    u, w = frame(d)
    ph = rng.uniform(0, 2 * math.pi)
    rings = []
    for k in range(4):
        t = k / 3.0
        c = base + d * L * t + bend * L * t * t
        if k == 3:
            m = (ao0 * 1.0, 0.5, trans)
            rings.append([acc.v(c, col, m)])
            break
        rr = r * (1 - 0.55 * t)
        ring = []
        m = (ao0 * (0.62 + 0.38 * t), 0.55 - 0.08 * t, trans * (0.55 + 0.45 * t))
        for j in range(3):
            a = ph + j * 2 * math.pi / 3
            ring.append(acc.v(c + (u * math.cos(a) + w * math.sin(a)) * rr, col, m))
        rings.append(ring)
    for k in range(2):
        a, b = rings[k], rings[k + 1]
        for j in range(3):
            j2 = (j + 1) % 3
            acc.F.append((a[j], a[j2], b[j2], b[j]))
    a, tip = rings[2], rings[3][0]
    for j in range(3):
        acc.F.append((a[j], a[(j + 1) % 3], tip))

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

def needle_colour(rng, t, tip_light, newgrowth_from=0.84):
    c = NEEDLE_COL * rng.uniform(0.80, 1.14) + rng.normal(0, 0.008, 3)
    if rng.random() < 0.10 and t < 0.5:
        c = lerp(c, NEEDLE_OLD, rng.uniform(0.4, 0.9))
    if tip_light and t > newgrowth_from:
        c = lerp(c, NEEDLE_NEW, smoothstep(newgrowth_from, 1.0, t) * rng.uniform(0.6, 1.0))
    return np.clip(c, 0, 1)

def pine_sprig(rng, P):
    acc = Acc()
    L = P['L']
    shoots = []
    main = shoot_path([0, 0, 0], [1, rng.uniform(-0.05, 0.05), 0], L, rng.uniform(-0.18, 0.18), rng)
    shoots.append((main, P['r0'], P['nstart'], 1.0))
    for f in range(P['forks']):
        t = rng.uniform(0.22, 0.5)
        base, tan, S = path_sample(main, t * L)
        sgn = 1 if (f % 2 == 0) else -1
        ang = math.radians(rng.uniform(*P['fork_ang'])) * sgn
        d = rot_about(tan, np.array([0, 0, 1.]), ang)
        sp = shoot_path(base, d, L * (1 - t) * rng.uniform(0.62, 0.85), -sgn * rng.uniform(0.0, 0.35), rng)
        shoots.append((sp, P['r0'] * 0.62, max(0.05, P['nstart'] - 0.12), 0.85))
    for pts, r0, ns, lscale in shoots:
        n = len(pts)
        add_twig(acc, pts, np.linspace(r0, r0 * 0.4, n), TWIG_COL)
        _, _, S = path_sample(pts, 0)
        s = ns * S
        while s < S * 0.995:
            p, tan, _ = path_sample(pts, s)
            t = s / S
            u, w = frame(tan)
            phi = rng.uniform(0, 2 * math.pi)
            for k in range(P['fasc']):
                ph = phi + rng.normal(0, 0.22)
                th = math.radians(rng.uniform(*P['theta'])) * (1 - 0.55 * t ** 3)
                radial = u * math.cos(ph) + w * math.sin(ph)
                d = nrm(tan * math.cos(th) + radial * math.sin(th))
                Ln = P['nl'] * lscale * rng.uniform(0.82, 1.1) * (0.55 + 0.45 * min(1, (1 - t) * 6 + 0.25))
                col = needle_colour(rng, t, P['tip_light'])
                bend = radial * rng.uniform(0.05, 0.22) + rng.normal(0, 0.05, 3)
                add_needle(acc, rng, p, d, Ln, P['nr'], col, 0.55 + 0.45 * t, 0.75, bend)
            s += P['spacing'] * rng.uniform(0.7, 1.3)
        # terminal bud brush: a few needles pointing forward
        p, tan, _ = path_sample(pts, S)
        u, w = frame(tan)
        for k in range(P['fasc'] * 3):
            ph = rng.uniform(0, 2 * math.pi)
            th = math.radians(rng.uniform(8, 30))
            d = nrm(tan * math.cos(th) + (u * math.cos(ph) + w * math.sin(ph)) * math.sin(th))
            add_needle(acc, rng, p - tan * 0.01, d, P['nl'] * lscale * rng.uniform(0.45, 0.7), P['nr'],
                       needle_colour(rng, 1.0, P['tip_light']), 1.0, 0.8, rng.normal(0, 0.04, 3))
    return acc

def spruce_spray(rng, P):
    acc = Acc()
    L = P['L']
    main = shoot_path([0, 0, 0], [1, rng.uniform(-0.04, 0.04), 0], L, rng.uniform(-0.15, 0.15), rng, n=12)
    twigs = [(main, 0.0055, 0.0022)]
    _, _, S = path_sample(main, 0)
    s = 0.05 * S; side = 1 if rng.random() < 0.5 else -1
    while s < 0.9 * S:
        t = s / S
        base, tan, _ = path_sample(main, s)
        ang = math.radians(rng.uniform(*P['side_ang'])) * side
        d = rot_about(tan, np.array([0, 0, 1.]), ang)
        d = nrm(d + np.array([0, 0, rng.uniform(-0.1, 0.1)]))
        Ls = P['side_len'] * (1 - 0.6 * t) * rng.uniform(0.7, 1.12)
        sp = shoot_path(base, d, Ls, -side * rng.uniform(0.1, 0.45), rng, n=7)
        twigs.append((sp, 0.003, 0.0012))
        if Ls > 0.11:
            s2 = 0.3 * Ls; sd2 = 1
            while s2 < 0.85 * Ls:
                b2, t2, _ = path_sample(sp, s2)
                d2 = rot_about(t2, np.array([0, 0, 1.]), math.radians(rng.uniform(40, 60)) * sd2)
                sp2 = shoot_path(b2, d2, Ls * rng.uniform(0.22, 0.35), 0, rng, n=5)
                twigs.append((sp2, 0.0018, 0.001))
                s2 += rng.uniform(0.035, 0.06); sd2 = -sd2
        side = -side
        s += rng.uniform(*P['side_dy'])
    for pts, r0, r1 in twigs:
        add_twig(acc, pts, np.linspace(r0, r1, len(pts)), TWIG_COL, sides=5)
        _, _, S = path_sample(pts, 0)
        tipl = P['tip_light'] and rng.random() < 0.75
        s = 0.004
        while s < S:
            p, tan, _ = path_sample(pts, s)
            u, w = frame(tan)       # u lies in spray plane (z=0 normal), w ~ z
            ph = rng.uniform(0, 2 * math.pi)
            radial = nrm(u * math.cos(ph) + w * math.sin(ph) * P['flat'])
            th = math.radians(rng.uniform(*P['theta']))
            d = nrm(tan * math.cos(th) + radial * math.sin(th))
            t_new = 1.0 if (S - s) < 0.04 else 0.0
            col = needle_colour(rng, 0.5 + 0.5 * t_new, tipl, newgrowth_from=0.9)
            if t_new and tipl:
                col = lerp(col, NEEDLE_NEW * rng.uniform(0.9, 1.1), 0.7)
            add_needle(acc, rng, p, d, P['nl'] * rng.uniform(0.8, 1.15), P['nr'], col,
                       0.6 + 0.4 * (s / S), 0.7, rng.normal(0, 0.06, 3))
            s += P['spacing'] * rng.uniform(0.75, 1.25)
    return acc

CELL_DEFS = [
    # 0: lodgepole sprig A - 2 forks, bottlebrush shoots
    ('pine', dict(L=0.70, r0=0.0085, forks=2, fork_ang=(16, 30), nstart=0.14, fasc=2, theta=(26, 58),
                  nl=0.10, nr=0.0019, spacing=0.0042, tip_light=False)),
    # 1: lodgepole sprig B - dense (also LOD fill), new growth candles
    ('pine', dict(L=0.70, r0=0.0085, forks=3, fork_ang=(14, 30), nstart=0.12, fasc=2, theta=(26, 60),
                  nl=0.105, nr=0.002, spacing=0.0033, tip_light=True)),
    # 2: ponderosa tuft A - long needles in threes, pom-pom tips
    ('pine', dict(L=0.66, r0=0.012, forks=1, fork_ang=(12, 22), nstart=0.22, fasc=3, theta=(22, 52),
                  nl=0.19, nr=0.0021, spacing=0.0055, tip_light=False)),
    # 3: ponderosa tuft B - dense (LOD fill), light tips
    ('pine', dict(L=0.66, r0=0.012, forks=2, fork_ang=(12, 24), nstart=0.2, fasc=3, theta=(22, 52),
                  nl=0.19, nr=0.0022, spacing=0.0042, tip_light=True)),
    # 4: spruce spray A
    ('spruce', dict(L=0.74, side_ang=(48, 66), side_len=0.19, side_dy=(0.032, 0.045), flat=0.55,
                    theta=(45, 70), nl=0.036, nr=0.0016, spacing=0.0021, tip_light=False)),
    # 5: spruce spray B - new growth tips
    ('spruce', dict(L=0.74, side_ang=(45, 62), side_len=0.18, side_dy=(0.034, 0.048), flat=0.55,
                    theta=(45, 70), nl=0.035, nr=0.0016, spacing=0.0021, tip_light=True)),
    # 6: spruce spray C - narrow, longer side twigs swept forward
    ('spruce', dict(L=0.74, side_ang=(32, 48), side_len=0.22, side_dy=(0.034, 0.048), flat=0.5,
                    theta=(45, 72), nl=0.036, nr=0.0016, spacing=0.0021, tip_light=False)),
    # 7: spruce dense spray (LOD fill)
    ('spruce', dict(L=0.74, side_ang=(48, 64), side_len=0.21, side_dy=(0.026, 0.036), flat=0.6,
                    theta=(48, 72), nl=0.038, nr=0.0017, spacing=0.0019, tip_light=True)),
]

def cell_uv(i):
    col, row = i % NCOLS, i // NCOLS
    return col / NCOLS, row / NROWS, 1.0 / NCOLS, 1.0 / NROWS   # u0, v0 (top), du, dv

def build_atlas_mesh():
    allV, allF, allC, allM = [], [], [], []
    off = 0
    for i, (kind, P) in enumerate(CELL_DEFS):
        rng = np.random.default_rng(1000 + i)
        acc = pine_sprig(rng, P) if kind == 'pine' else spruce_spray(rng, P)
        V = np.array(acc.V)
        # fit into the cell: base at x=0, |y| <= half cell height
        margin = 0.012
        sx = (CELL_W - margin) / max(V[:, 0].max(), 1e-6)
        sy = (CELL_H / 2 - margin) / max(np.abs(V[:, 1]).max(), 1e-6)
        sc = min(1.0, sx, sy)
        V *= sc
        V[:, 0] -= V[:, 0].min() - 0.001
        col, row = i % NCOLS, i // NCOLS
        V[:, 0] += col * CELL_W
        V[:, 1] += -(row + 0.5) * CELL_H
        log(f'cell {i} {kind}: {len(acc.F)} faces, needles~{len(acc.F)//9}, fit scale {sc:.3f}')
        allV.append(V); allC.append(np.array(acc.col)); allM.append(np.array(acc.m))
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
    # premultiplication check (Blender float buffers are premultiplied)
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
    wgt = np.clip((alpha - 0.02) * 2.2, 0, 1)        # texels >~0.47 alpha keep own colour
    col = pushpull(straight(passes['col']), wgt)
    nraw = straight(passes['normal']) * 2 - 1
    nraw = nrm(nraw)
    nraw[..., 2] = np.abs(nraw[..., 2])
    flat = np.array([0, 0, 1.0])
    nmap = nrm(lerp(flat, nraw, 0.6))
    nmap = nrm(pushpull(nmap, wgt))
    mm = pushpull(straight(passes['m']), wgt)
    a8 = np.clip(alpha, 1.0 / 255, 1.0)              # never exactly 0: WebP would zero RGB under alpha 0
    cov = (alpha > 0.5).mean()
    log(f'atlas coverage (alpha>0.5): {cov*100:.1f}%')
    for i in range(len(CELL_DEFS)):
        u0, v0, du, dv = cell_uv(i)
        y0, x0 = int(v0 * ATLAS), int(u0 * ATLAS)
        cc = (alpha[y0:y0 + int(dv * ATLAS), x0:x0 + int(du * ATLAS)] > 0.5).mean()
        log(f'  cell {i} coverage {cc*100:.1f}%')
    save_image(f'{TEXD}/pine_needles_c.webp', np.dstack([col, a8]))
    save_image(f'{TEXD}/pine_needles_n.webp', np.dstack([nmap * 0.5 + 0.5, np.ones_like(alpha)]))
    m_out = np.dstack([mm[..., 0], mm[..., 1], np.zeros_like(alpha), np.clip(mm[..., 2], 1.0 / 255, 1)])
    save_image(f'{TEXD}/pine_needles_m.webp', m_out)
    np.save(f'{TMP}/atlas_alpha.npy', alpha.astype(np.float16))
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
    if kind == 'ponderosa':
        warp = (fft_noise(h, w, 40, 25, rng) * 14, fft_noise(h, w, 40, 25, rng) * 10)
        F1, F2, ID = worley(h, w, 14, 7, rng, warp)
        e = F2 - F1
        fis = 1 - smoothstep(1.0, 9.0, e)
        # flaky sub-scales on each plate
        f1, f2, id2 = worley(h, w, 64, 20, rng, (warp[0] * 0.3, warp[1] * 0.3))
        flake = smoothstep(0.0, 4.0, f2 - f1)
        n1 = fft_noise(h, w, 30, 30, rng); n2 = fft_noise(h, w, 3, 3, rng)
        hgt = (0.62 + 0.12 * n1 + 0.10 * flake + 0.04 * n2) * (1 - fis) + fis * (0.05 + 0.03 * n2)
        pid = np.random.default_rng(7).uniform(0, 1, 14 * 7)[ID]
        sid = np.random.default_rng(8).uniform(0, 1, 64 * 20)[id2]
        plate = lerp(srgb(0.40, 0.235, 0.14), srgb(0.33, 0.27, 0.23), (pid * 0.6 + 0.4 * sid)[..., None])
        plate = lerp(plate, srgb(0.50, 0.34, 0.23), (smoothstep(0.75, 1.0, sid) * 0.6)[..., None])
        plate *= (0.82 + 0.18 * flake)[..., None]
        fisc = srgb(0.07, 0.05, 0.04)
        col = lerp(plate, fisc, smoothstep(0.15, 0.85, fis)[..., None])
        strength = 7.0
    elif kind == 'lodgepole':
        warp = (fft_noise(h, w, 12, 8, rng) * 5, fft_noise(h, w, 12, 8, rng) * 4)
        F1, F2, ID = worley(h, w, 56, 22, rng, warp)
        fis = 1 - smoothstep(0.3, 2.6, F2 - F1)
        n1 = fft_noise(h, w, 20, 14, rng); n2 = fft_noise(h, w, 2, 2, rng)
        hgt = (0.6 + 0.12 * n1 + 0.1 * smoothstep(0, 8, F2 - F1) + 0.05 * n2) * (1 - 0.8 * fis)
        pid = np.random.default_rng(9).uniform(0, 1, 56 * 22)[ID]
        base = lerp(srgb(0.34, 0.27, 0.22), srgb(0.40, 0.36, 0.32), pid[..., None])
        base = lerp(base, srgb(0.42, 0.24, 0.15), (smoothstep(0.85, 1.0, pid) * 0.7)[..., None])
        col = lerp(base * (0.85 + 0.1 * n1[..., None]), srgb(0.10, 0.08, 0.07), (fis * 0.85)[..., None])
        strength = 3.0
    elif kind == 'spruce':
        warp = (fft_noise(h, w, 10, 10, rng) * 4, fft_noise(h, w, 10, 10, rng) * 4)
        F1, F2, ID = worley(h, w, 52, 24, rng, warp)
        fis = 1 - smoothstep(0.3, 2.2, F2 - F1)
        dome = 1 - smoothstep(0, 14, F1)
        n1 = fft_noise(h, w, 24, 24, rng); n2 = fft_noise(h, w, 2, 2, rng)
        hgt = (0.45 + 0.3 * dome + 0.1 * n1 + 0.04 * n2) * (1 - 0.8 * fis)
        pid = np.random.default_rng(10).uniform(0, 1, 52 * 24)[ID]
        base = lerp(srgb(0.30, 0.24, 0.20), srgb(0.38, 0.30, 0.25), pid[..., None])
        base = lerp(base, srgb(0.40, 0.25, 0.17), (smoothstep(0.7, 1.0, pid) * 0.6)[..., None])
        col = lerp(base * (0.8 + 0.2 * dome[..., None]), srgb(0.09, 0.07, 0.06), (fis * 0.8)[..., None])
        strength = 3.0
    else:  # branch bark
        warp = (fft_noise(h, w, 10, 6, rng) * 4, fft_noise(h, w, 10, 6, rng) * 3)
        F1, F2, ID = worley(h, w, 64, 12, rng, warp)
        fis = 1 - smoothstep(0.2, 1.8, F2 - F1)
        n1 = fft_noise(h, w, 16, 12, rng); n2 = fft_noise(h, w, 2, 2, rng)
        hgt = (0.6 + 0.1 * n1 + 0.04 * n2) * (1 - 0.6 * fis)
        col = lerp(srgb(0.30, 0.25, 0.21) * (0.9 + 0.12 * n1[..., None]), srgb(0.12, 0.09, 0.08), (fis * 0.7)[..., None])
        strength = 2.0
    hgt = np.clip(hgt, 0, 1).astype(np.float32)
    dx = (np.roll(hgt, -1, 1) - np.roll(hgt, 1, 1)) * 0.5
    dy = (np.roll(hgt, -1, 0) - np.roll(hgt, 1, 0)) * 0.5      # +row = image down
    n = nrm(np.dstack([-dx * strength, dy * strength, np.ones_like(hgt)]))
    cav = hgt - blur_periodic(hgt, 10)
    ao = np.clip(0.5 + 0.5 * smoothstep(0.0, 0.6, hgt) + cav * 1.2, 0.15, 1)
    rough = np.clip(0.80 + 0.17 * (1 - hgt), 0, 1)
    return np.clip(col, 0, 1), n, ao, rough

def stage_bark():
    t0 = time.time()
    H, W = 2048, 512
    kinds = ['lodgepole', 'ponderosa', 'spruce', 'branch']
    C = np.zeros((H, 4 * W, 3), np.float32); N = C.copy(); AO = np.zeros((H, 4 * W), np.float32); R = AO.copy()
    for k, kind in enumerate(kinds):
        c, n, ao, r = bark_strip(kind, H, W, np.random.default_rng(50 + k))
        C[:, k * W:(k + 1) * W] = c; N[:, k * W:(k + 1) * W] = n
        AO[:, k * W:(k + 1) * W] = ao; R[:, k * W:(k + 1) * W] = r
        log('bark strip', kind, f'{time.time()-t0:.1f}s')
    one = np.ones((H, 4 * W), np.float32)
    save_image(f'{TEXD}/pine_bark_c.webp', np.dstack([C, one]))
    save_image(f'{TEXD}/pine_bark_n.webp', np.dstack([N * 0.5 + 0.5, one]))
    save_image(f'{TEXD}/pine_bark_m.webp', np.dstack([AO, R, np.zeros_like(AO), one]))

BARK_STRIP = {'lodgepole': 0, 'ponderosa': 1, 'spruce': 2, 'branch': 3}
def strip_u(k):
    e = 0.75 / ATLAS
    return k * 0.25 + e, (k + 1) * 0.25 - e

# =========================================================================== TREES
SPECIES = {
    'a': dict(id='pine_a', kind='pine', H=24.0, r0=0.24, flare=0.35, bend=0.22, crown0=0.54,
              wh_dy=(0.34, 0.66), wh_n=(4, 6), skip=0.2, Lmax=3.3, Lmin=0.55, Lexp=0.75, Lrand=(0.5, 1.25),
              elev=(-18, 32), elev_rand=12, droop=0.30, upturn=0.40, sec_dy=(0.16, 0.3), sec_ang=(30, 62),
              sec_up=(0.0, 0.45), sec_len=(0.3, 0.55), sec_cap=1.1, tuft=(0.62, 0.92), tuft_dy=(0.12, 0.2), cells=(0, 1), dense=1,
              stubs=34, stub_from=2.5, br_r=(0.016, 0.018), bark='lodgepole', trunk_sides=14, gaps=2, cluster=(2, 3)),
    'b': dict(id='pine_b', kind='pine', H=28.0, r0=0.44, flare=0.45, bend=0.55, crown0=0.45,
              wh_dy=(0.5, 1.15), wh_n=(3, 5), skip=0.22, Lmax=5.4, Lmin=0.8, Lexp=0.55, Lrand=(0.45, 1.2),
              elev=(-22, 38), elev_rand=14, droop=0.55, upturn=1.05, sec_dy=(0.24, 0.42), sec_ang=(28, 58),
              sec_up=(0.25, 0.75), sec_len=(0.35, 0.6), sec_cap=1.8, tuft=(0.85, 1.25), tuft_dy=(0.17, 0.27), cells=(2, 3), dense=3,
              stubs=22, stub_from=4.0, br_r=(0.02, 0.026), bark='ponderosa', trunk_sides=16, gaps=3, cluster=(2, 4)),
    'c': dict(id='pine_c', kind='spruce', H=20.0, r0=0.27, flare=0.4, bend=0.15, crown0=3.0 / 20.0,
              wh_dy=(0.34, 0.52), wh_n=(4, 6), skip=0.14, Lmax=3.6, Lmin=0.35, Lexp=1.0, Lrand=(0.78, 1.12),
              elev=(-32, 12), elev_rand=8, droop=0.55, upturn=0.45, sec_dy=(0.2, 0.32), sec_ang=(48, 72),
              sec_up=(-0.25, 0.05), sec_len=(0.3, 0.55), sec_cap=1.1, tuft=(0.62, 0.92), tuft_dy=(0.2, 0.3), cells=(4, 5, 6), dense=7,
              stubs=14, stub_from=1.2, br_r=(0.012, 0.01), bark='spruce', trunk_sides=12, gaps=3, cluster=(1, 1)),
}

class Trunk:
    def __init__(s, P, rng):
        s.P = P; s.H = P['H']; s.r0 = P['r0']
        s.ph = rng.uniform(0, 2 * math.pi, 8)
    def center(s, y):
        t = np.clip(y / s.H, 0, 1); b = s.P['bend']; ph = s.ph
        x = b * (math.sin(t * 2.3 + ph[0]) - math.sin(ph[0]) + 0.35 * (math.sin(t * 6.1 + ph[1]) - math.sin(ph[1])))
        z = b * (math.sin(t * 1.9 + ph[2]) - math.sin(ph[2]) + 0.35 * (math.sin(t * 5.3 + ph[3]) - math.sin(ph[3])))
        return np.array([x, y, z])
    def radius(s, y):
        t = np.clip(y / s.H, 0, 1)
        r = s.r0 * (1 - t) ** 0.9 + 0.012 * (1 - t) + 0.006
        return r * (1 + s.P['flare'] * math.exp(-max(y, 0) / 0.6))

class Branch:
    def __init__(s, pts, radii, bw, phase, level, parent=None):
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

def grow_path(p0, d0, L, step, droop, upturn, noise, rng, up_bias=0.0):
    n = max(2, int(math.ceil(L / step)))
    ds = L / n
    pts = [np.array(p0, float)]; d = nrm(d0)
    Y = np.array([0, 1., 0])
    for i in range(n):
        t = (i + 1) / n
        d = nrm(d + (-Y * droop * (1 - t) * 0.9 + Y * upturn * t ** 2 + Y * up_bias) * ds
                + rng.normal(0, noise, 3) * ds)
        if pts[-1][1] + d[1] * ds < 0.6 and d[1] < 0:      # never droop into the ground
            d = nrm(np.array([d[0], 0.15, d[2]]))
        pts.append(pts[-1] + d * ds)
    return np.array(pts)

class Anchor:
    __slots__ = ('p', 'd', 'size', 'cell', 'phase', 'bw', 'clump', 'kind', 'r', 'side', 'cross')
    def __init__(s, **k):
        for a, b in k.items():
            setattr(s, a, b)

def build_skeleton(key):
    P = SPECIES[key]
    rng = np.random.default_rng({'a': 11, 'b': 22, 'c': 33}[key])
    tr = Trunk(P, rng)
    H = P['H']; y0 = P['crown0'] * H
    branches = []; anchors = []
    Yv = np.array([0, 1., 0])
    gap_az = rng.uniform(0, 2 * math.pi, P['gaps']); gap_h = rng.uniform(y0, H * 0.9, P['gaps'])
    def in_gap(az, y):
        for a, hgt in zip(gap_az, gap_h):
            da = abs((az - a + math.pi) % (2 * math.pi) - math.pi)
            if da < 0.75 and abs(y - hgt) < (2.2 if P['kind'] == 'pine' else 1.4):
                return True
        return False
    def add_cluster(p, d, n, size_rng, phase, bw, clump_c):
        for k in range(n):
            dd = d if k == 0 else nrm(rot_about(d, nrm(np.cross(d, rng.normal(0, 1, 3))), math.radians(rng.uniform(18, 40))))
            if P['kind'] == 'pine':
                dd = nrm(dd + Yv * rng.uniform(0.05, 0.4) * (P['upturn']))
            sz = rng.uniform(*size_rng) * (1 if k == 0 else rng.uniform(0.75, 0.95))
            anchors.append(Anchor(p=p - dd * sz * 0.12, d=dd, size=sz, cell=int(rng.choice(P['cells'])), phase=phase,
                                  bw=bw, clump=clump_c, kind='tuft', r=rng.random(), side=None, cross=None))
    # ---- whorls
    y = y0 + rng.uniform(0, P['wh_dy'][0])
    whorl_i = 0
    while y < H - 0.35:
        q = (y - y0) / (H - y0)
        nb = int(rng.integers(P['wh_n'][0], P['wh_n'][1] + 1))
        az0 = rng.uniform(0, 2 * math.pi)
        for b in range(nb):
            if rng.random() < P['skip']:
                continue
            az = az0 + b * 2 * math.pi / nb + rng.normal(0, 0.3)
            yb = y + rng.normal(0, 0.1 if P['kind'] == 'spruce' else 0.18)
            if yb >= H - 0.3:
                continue
            if in_gap(az, yb):
                continue
            Lb = (P['Lmin'] + (P['Lmax'] - P['Lmin']) * (1 - q) ** P['Lexp']) * rng.uniform(*P['Lrand'])
            if key == 'b' and rng.random() < 0.12:
                Lb *= 0.45     # occasional short broken limb
            el = math.radians(lerp(P['elev'][0], P['elev'][1], q) + rng.normal(0, P['elev_rand']))
            d0 = np.array([math.cos(el) * math.cos(az), math.sin(el), math.cos(el) * math.sin(az)])
            c = tr.center(yb); rt = tr.radius(yb)
            p0 = c + np.array([math.cos(az), 0, math.sin(az)]) * rt * 0.5
            pts = grow_path(p0, d0, Lb, 0.3, P['droop'] * (0.6 + 0.8 * (1 - q)), P['upturn'] * rng.uniform(0.5, 1.3),
                            0.35, rng)
            rb0 = min(0.5 * rt, P['br_r'][0] + P['br_r'][1] * Lb)
            tt = np.linspace(0, 1, len(pts))
            radii = rb0 * (1 - tt) ** 0.85 + 0.006
            bw = tt ** 1.5
            phase = rng.random()
            br = Branch(pts, radii, bw, phase, 1)
            branches.append(br)
            # secondaries
            s = br.L * rng.uniform(0.15, 0.3); side = 1 if rng.random() < 0.5 else -1
            while s < br.L * 0.9:
                p, d, r, w = br.at(s)
                lat = nrm(np.cross(d, Yv)) * side
                if np.linalg.norm(np.cross(d, Yv)) < 1e-3:
                    lat = nrm(np.cross(d, np.array([1., 0, 0]))) * side
                a = math.radians(rng.uniform(*P['sec_ang']))
                d2 = nrm(d * math.cos(a) + lat * math.sin(a) + Yv * rng.uniform(*P['sec_up']))
                L2 = min(P['sec_cap'], max(0.22, (br.L - s) * rng.uniform(*P['sec_len']) + 0.15))
                if P['kind'] == 'spruce':
                    L2 = min(P['sec_cap'], (0.25 + 0.45 * (br.L - s) / max(br.L, 0.1) * min(br.L, 2.5) * 0.5) * rng.uniform(0.75, 1.2))
                p2 = grow_path(p, d2, L2, 0.35, P['droop'] * 0.4, P['upturn'] * 0.5, 0.5, rng)
                t2 = np.linspace(0, 1, len(p2))
                r2 = min(0.7 * r, 0.008 + 0.012 * L2) * (1 - t2) ** 0.8 + 0.004
                bw2 = w + (1 - w) * t2
                sb = Branch(p2, r2, bw2, phase, 2)
                branches.append(sb)
                if P['kind'] == 'pine':
                    tip, td, _, tw = sb.at(sb.L)
                    nclu = int(rng.integers(P['cluster'][0], P['cluster'][1] + 1))
                    add_cluster(tip, td, nclu, P['tuft'], phase, tw, tip - td * 0.3 - Yv * 0.15)
                    # side tufts along the outer part of the secondary (needles live on the last years' growth)
                    sq = sb.L * rng.uniform(0.25, 0.4); sd = 1
                    while sq < sb.L - 0.15:
                        pm, dm, _, wm = sb.at(sq)
                        latm = nrm(np.cross(dm, Yv)) * sd
                        dd = nrm(dm + latm * rng.uniform(0.5, 1.1) + Yv * rng.uniform(0.1, 0.6))
                        add_cluster(pm, dd, int(rng.integers(1, 3)), (P['tuft'][0] * 0.8, P['tuft'][1] * 0.9), phase, wm,
                                    pm - dm * 0.2 - Yv * 0.15)
                        sq += rng.uniform(*P['tuft_dy']); sd = -sd
                else:
                    ss = rng.uniform(0.0, 0.12); sd = 1 if rng.random() < 0.5 else -1
                    while ss < sb.L:
                        pp, dd, _, ww = sb.at(ss)
                        last = ss + 0.2 > sb.L
                        if last:
                            pp, dd, _, ww = sb.at(sb.L * 0.9)
                        ang = 0 if last else math.radians(rng.uniform(25, 50)) * sd
                        dv = nrm(rot_about(dd, Yv, ang) + Yv * rng.uniform(-0.25, 0.05))
                        sz = rng.uniform(*P['tuft'])
                        anchors.append(Anchor(p=pp, d=dv, size=sz, cell=int(rng.choice(P['cells'])), phase=phase,
                                              bw=ww, clump=pp - Yv * 0.45, kind='spray', r=rng.random(),
                                              side=sd, cross=rng.random() < 0.4))
                        if last:
                            break
                        ss += rng.uniform(0.11, 0.18); sd = -sd
                s += rng.uniform(*P['sec_dy']); side = -side
            # tip of main branch
            tip, td, _, tw = br.at(br.L)
            if P['kind'] == 'pine':
                add_cluster(tip, nrm(td + Yv * 0.25), int(rng.integers(2, 4)), P['tuft'], phase, tw, tip - td * 0.35 - Yv * 0.15)
                sq = br.L * 0.55; sd = 1
                while sq < br.L - 0.25:
                    pm, dm, _, wm = br.at(sq)
                    latm = nrm(np.cross(dm, Yv)) * sd
                    dd = nrm(dm * 0.6 + latm * rng.uniform(0.4, 1.0) + Yv * rng.uniform(0.2, 0.7))
                    add_cluster(pm, dd, 1, P['tuft'], phase, wm, pm - Yv * 0.2)
                    sq += rng.uniform(*P['tuft_dy']) * 1.3; sd = -sd
            else:
                ss = br.L * 0.3
                while ss < br.L:
                    pp, dd, _, ww = br.at(ss)
                    sd = 1 if rng.random() < 0.5 else -1
                    dv = nrm(rot_about(dd, Yv, math.radians(rng.uniform(10, 35)) * sd) + Yv * rng.uniform(-0.1, 0.1))
                    anchors.append(Anchor(p=pp, d=dv, size=rng.uniform(*P['tuft']) * 1.05, cell=int(rng.choice(P['cells'])),
                                          phase=phase, bw=ww, clump=pp - Yv * 0.45, kind='spray', r=rng.random(),
                                          side=sd, cross=rng.random() < 0.5))
                    ss += rng.uniform(0.15, 0.24)
                anchors.append(Anchor(p=tip - td * 0.1, d=nrm(td + Yv * 0.2), size=rng.uniform(*P['tuft']), cell=int(rng.choice(P['cells'])),
                                      phase=phase, bw=tw, clump=tip - Yv * 0.45, kind='spray', r=rng.random(), side=1, cross=True))
        # interwhorl small branches on spruce
        whorl_i += 1
        y += rng.uniform(*P['wh_dy'])
    # ---- leader tufts at the top
    top = tr.center(H)
    if P['kind'] == 'pine':
        add_cluster(top - Yv * 0.3, Yv, 4, (P['tuft'][0] * 0.9, P['tuft'][1]), rng.random(), 0.3, top - Yv * 0.6)
    else:
        for k in range(5):
            dd = nrm(Yv * 2.5 + rng.normal(0, 0.35, 3))
            anchors.append(Anchor(p=top - Yv * (0.15 + 0.25 * k), d=dd, size=rng.uniform(*P['tuft']) * 0.9, cell=int(rng.choice(P['cells'])),
                                  phase=rng.random(), bw=0.3, clump=top - Yv * 0.8, kind='spray', r=rng.random(), side=1, cross=True))
    # ---- dead stubs below the crown (no foliage)
    for i in range(P['stubs']):
        yb = rng.uniform(P['stub_from'], y0 + 0.5)
        az = rng.uniform(0, 2 * math.pi)
        el = math.radians(rng.uniform(-35, 5))
        Lb = rng.uniform(0.15, 0.9) * (1.6 if key == 'b' else 1.0)
        d0 = np.array([math.cos(el) * math.cos(az), math.sin(el), math.cos(el) * math.sin(az)])
        c = tr.center(yb); rt = tr.radius(yb)
        pts = grow_path(c + np.array([math.cos(az), 0, math.sin(az)]) * rt * 0.5, d0, Lb, 0.3, 0.2, 0.0, 0.6, rng)
        tt = np.linspace(0, 1, len(pts))
        branches.append(Branch(pts, (0.012 + 0.012 * Lb) * (1 - 0.8 * tt) + 0.002, tt * 0.6, rng.random(), 3))
    log(f'{P["id"]} skeleton: {len(branches)} branches, {len(anchors)} foliage anchors')
    return dict(P=P, trunk=tr, branches=branches, anchors=anchors)

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

def tube_branch(geo, br, sides, step, strip, min_seg=1):
    L = br.L
    nseg = max(min_seg, int(round(L / step)))
    ss = np.linspace(0, L, nseg + 1)
    samp = [br.at(s) for s in ss]
    pts = np.array([x[0] for x in samp]); rad = np.array([x[2] for x in samp]); bw = np.array([x[3] for x in samp])
    T, U, Wv = ring_frames(pts)
    ang = np.linspace(0, 2 * math.pi, sides, endpoint=False)
    G = pts[:, None, :] + (U[:, None, :] * np.cos(ang)[None, :, None] + Wv[:, None, :] * np.sin(ang)[None, :, None]) * rad[:, None, None]
    circ = 2 * math.pi * max(rad[0], 0.01)
    vs = -ss / (circ * 4.0)
    return emit_tube(geo, G, strip_u(BARK_STRIP['branch']), vs, bw, br.phase)

def tube_trunk(geo, tr, sides, ystep, P):
    H = tr.H
    ys = [-0.25, 0.0, 0.12, 0.3, 0.55, 0.9]
    ys = [y for y in ys if y < 1.0 or ystep < 1.0]
    if ystep > 2.0:
        ys = [-0.25, 0.25, 0.9]
    y = 1.4
    while y < H - 0.2:
        ys.append(y); y += ystep
    ys.append(H)
    ys = np.array(ys)
    ang = np.linspace(0, 2 * math.pi, sides, endpoint=False)
    rng = np.random.default_rng(5)
    lobe_ph = rng.uniform(0, 2 * math.pi)
    G = []
    for yy in ys:
        c = tr.center(yy); r = tr.radius(yy)
        amp = P['flare'] * 0.55 * math.exp(-max(yy, 0) / 0.45)
        lobes = np.maximum(0, np.cos(5 * ang + lobe_ph + 0.6 * np.sin(2 * ang))) ** 3 - 0.2
        rr = r * (1 + amp * lobes)
        G.append(c[None, :] + np.stack([np.cos(ang) * rr, np.zeros_like(ang), np.sin(ang) * rr], -1))
    G = np.array(G)
    circ0 = 2 * math.pi * tr.radius(1.3)
    vs = -ys / (circ0 * 4.0 * 0.8)
    return emit_tube(geo, G, strip_u(BARK_STRIP[P['bark']]), vs, np.zeros(len(ys)), 0.0)

def emit_card(geo, base, d, side, Lc, cell, phase, bw, segs=1, droop=0.0, meta=None):
    """card along d from base, width Lc/2 across `side`. segs subdivisions along length."""
    u0, v0, du, dv = cell_uv(cell)
    e = 1.5 / ATLAS
    w = Lc * 0.5
    rows = segs + 1
    P = []; UV = []; Wd = []
    for i in range(rows):
        t = i / segs
        c = base + d * Lc * t + np.array([0, -1.0, 0]) * droop * Lc * t * t
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
    0: dict(trunk_ystep=0.6, trunk_sides=None, main_sides=5, main_step=0.5, sec_sides=4, sec_step=0.6,
            sec_min_r=0.0, keep=1.0, scale=1.0, pine_cards=3, spray_segs=2, cross=True, use_dense=False,
            stubs=True, main_min_r=0.0),
    1: dict(trunk_ystep=1.4, trunk_sides=9, main_sides=4, main_step=0.8, sec_sides=3, sec_step=1.2,
            sec_min_r=0.0105, keep=0.42, scale=1.42, pine_cards=2, spray_segs=1, cross=True, use_dense=True,
            stubs=True, main_min_r=0.0),
    2: dict(trunk_ystep=3.5, trunk_sides=6, main_sides=3, main_step=3.0, sec_sides=3, sec_step=9,
            sec_min_r=99, keep=0.16, scale=2.15, pine_cards=2, spray_segs=1, cross=False, use_dense=True,
            stubs=False, main_min_r=0.032),
}

def crown_profile(sk):
    """crown radius per height from foliage anchors (for crown-oriented normals and AO)"""
    tr = sk['trunk']; H = tr.H
    bins = np.zeros(int(H) + 2)
    for a in sk['anchors']:
        tip = a.p + a.d * a.size
        for p in (a.p, tip):
            c = tr.center(p[1]); r = math.hypot(p[0] - c[0], p[2] - c[2])
            i = int(np.clip(p[1], 0, H))
            bins[i] = max(bins[i], r)
    # smooth & fill
    b = np.maximum(bins, 0.4)
    b = np.convolve(np.pad(b, 2, mode='edge'), np.ones(5) / 5, mode='valid')
    ys = np.array([a.p[1] for a in sk['anchors']])
    yc = 0.5 * (ys.min() + H); ry = 0.5 * (H - ys.min()) + 0.5
    return b, yc, ry

def crown_normal(sk, P, clump):
    tr = sk['trunk']; prof, yc, ry = sk['profile']
    out = np.empty_like(P)
    for i, p in enumerate(P):
        c = tr.center(p[1]); R = prof[int(np.clip(p[1], 0, len(prof) - 1))]
        o = np.array([(p[0] - c[0]) / R, (p[1] - yc) / ry * 0.9 + 0.12, (p[2] - c[2]) / R])
        out[i] = o
    nc = nrm(out)
    nk = nrm(P - clump)
    return nrm(0.6 * nc + 0.4 * nk + np.array([0, 0.12, 0]))

def build_lod(sk, lod):
    P = sk['P']; cfg = LOD_CFG[lod]; tr = sk['trunk']
    bark = Geo(); ndl = Geo()
    tris_b = tube_trunk(bark, tr, cfg['trunk_sides'] or P['trunk_sides'], cfg['trunk_ystep'], P)
    for br in sk['branches']:
        if br.level == 1:
            if br.radii[0] < cfg['main_min_r']:
                continue
            step = cfg['main_step'] if lod < 2 else br.L / (1 if br.L < 2.5 else 2)
            tris_b += tube_branch(bark, br, cfg['main_sides'], step, 'branch', 1)
        elif br.level == 2:
            if lod == 2 or br.radii[0] < cfg['sec_min_r']:
                continue
            if P['kind'] == 'spruce' and br.L < 0.8 or br.L < 0.45:
                continue
            sides = cfg['sec_sides'] if br.radii[0] > 0.016 else 3
            tris_b += tube_branch(bark, br, sides, cfg['sec_step'], 'branch', 1)
        elif br.level == 3 and cfg['stubs']:
            tris_b += tube_branch(bark, br, 3, 0.5, 'branch', 1)
    rng = np.random.default_rng(77 + lod)
    tris_n = 0
    Yv = np.array([0, 1.0, 0])
    for a in sk['anchors']:
        if a.r >= cfg['keep']:
            continue
        Lc = a.size * cfg['scale'] * (0.93 if P['kind'] == 'spruce' and lod > 0 else 1.0)
        cell = a.cell
        if cfg['use_dense'] and rng.random() < (0.35 if P['kind'] == 'spruce' else 0.6):
            cell = P['dense']
        base = a.p - a.d * Lc * 0.04
        if a.kind == 'tuft':
            u, w = frame(a.d)
            ph0 = rng.uniform(0, math.pi)
            n = cfg['pine_cards']
            for k in range(n):
                ang = ph0 + k * math.pi / n + rng.normal(0, 0.15)
                side = u * math.cos(ang) + w * math.sin(ang)
                # tilt each card's axis a little so the crossed set is not a symmetric star
                dk = nrm(rot_about(a.d, side, rng.normal(0, 0.2)))
                tris_n += emit_card(ndl, base, dk, side, Lc * rng.uniform(0.85, 1.05), cell, a.phase, a.bw, 1, 0.0, meta=a.clump)
        else:
            side0 = nrm(np.cross(a.d, Yv)) if np.linalg.norm(np.cross(a.d, Yv)) > 1e-3 else np.array([1., 0, 0])
            tilt = math.radians(rng.uniform(-22, 22))
            side = rot_about(side0, a.d, tilt)
            droop = 0.18 if lod == 0 else 0.1
            tris_n += emit_card(ndl, base, a.d, side, Lc, cell, a.phase, a.bw, cfg['spray_segs'], droop, meta=a.clump)
            if cfg['cross'] and a.cross or lod == 2:
                side2 = rot_about(side0, a.d, tilt + math.radians(rng.uniform(65, 85)))
                tris_n += emit_card(ndl, base, a.d, side2, Lc * 0.9, cell, a.phase, a.bw, 1, 0.0, meta=a.clump)
    B = bark.arrays(); Nd = ndl.arrays()
    # crown-oriented normals for cards
    clumps = np.concatenate([np.repeat(m[None, :], len(p), 0) for m, p in zip(ndl.meta, ndl.P)])
    Nd['N'] = crown_normal(sk, Nd['P'], clumps)
    for g in (B, Nd):
        g['W'][:, 3] = np.clip(g['P'][:, 1] / tr.H, 0, 1) ** 1.5
    log(f'{P["id"]} LOD{lod}: bark {tris_b} tris, needles {tris_n} tris, total {tris_b + tris_n}')
    return B, Nd

# --------------------------------------------------------------------------- AO
def build_bvh(B, Nd):
    from mathutils.bvhtree import BVHTree
    V = np.concatenate([B['P'], Nd['P']])
    I = np.concatenate([B['I'], Nd['I'] + len(B['P'])])
    return BVHTree.FromPolygons([tuple(v) for v in V], [tuple(int(x) for x in t) for t in I], all_triangles=True)

def bake_ao(sk, bvh, g, is_needle):
    from mathutils import Vector
    tr = sk['trunk']; prof, yc, ry = sk['profile']; H = tr.H
    rng = np.random.default_rng(3)
    dirs = nrm(rng.normal(0, 1, (14, 3)))
    dirs[:, 1] = np.abs(dirs[:, 1]) * 0.8 + 0.2       # mostly upper hemisphere (sky)
    dirs = nrm(dirs)
    P = g['P']; N = g['N']
    ao = np.empty(len(P))
    # cache per unique rounded position
    for i in range(len(P)):
        p = P[i]
        c = tr.center(p[1]); R = prof[int(np.clip(p[1], 0, len(prof) - 1))]
        rad = math.hypot(p[0] - c[0], p[2] - c[2]) / R
        depth = np.clip(rad, 0, 1.2)
        vert = np.clip((p[1] - (yc - ry)) / (2 * ry), 0, 1)
        analytic = 0.30 + 0.55 * depth ** 0.8 + 0.25 * vert
        hits = 0
        o = Vector(p) + Vector(N[i]) * 0.03
        for d in dirs:
            dv = Vector(nrm(d + N[i] * 0.6))
            h = bvh.ray_cast(o + dv * 0.05, dv, 3.5)
            if h[0] is not None:
                hits += 1
        ray = 1 - 0.6 * hits / len(dirs)
        a = analytic * ray
        if not is_needle and p[1] < 3.0:
            a *= 0.7 + 0.3 * smoothstep(0, 2.5, p[1])
        ao[i] = np.clip(a, 0.06, 1.0)
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
        {'name': 'bark_pine', 'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 1], 'metallicFactor': 0.0, 'roughnessFactor': 1.0}},
        {'name': 'needles', 'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 1], 'metallicFactor': 0.0, 'roughnessFactor': 1.0},
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
    js = {'asset': {'version': '2.0', 'generator': 'valley-ride make_pines.py'},
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
        sk['profile'] = crown_profile(sk)
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
    pre = 'pine_needles' if kind == 'needles' else 'pine_bark'
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
    if kind == 'needles':
        pr.inputs['Specular IOR Level'].default_value = 0.08
        tl = nt.nodes.new('ShaderNodeBsdfTranslucent')
        tint = nt.nodes.new('ShaderNodeMix'); tint.data_type = 'RGBA'; tint.blend_type = 'MULTIPLY'
        tint.inputs['Factor'].default_value = 1.0; tint.inputs['B'].default_value = (0.9, 1.0, 0.45, 1)
        L(mul.outputs['Result'], tint.inputs['A']); L(tint.outputs['Result'], tl.inputs['Color'])
        tm_a = tm.outputs['Alpha']
        fac = nt.nodes.new('ShaderNodeMath'); fac.operation = 'MULTIPLY'; fac.inputs[1].default_value = 0.22
        L(tm_a, fac.inputs[0])
        mx = nt.nodes.new('ShaderNodeMixShader'); L(fac.outputs[0], mx.inputs[0])
        L(pr.outputs[0], mx.inputs[1]); L(tl.outputs[0], mx.inputs[2])
        tr = nt.nodes.new('ShaderNodeBsdfTransparent')
        mx2 = nt.nodes.new('ShaderNodeMixShader'); L(tc.outputs['Alpha'], mx2.inputs[0])
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
    me.materials.append(bpy.data.materials.get('bark_pine') or tree_material('bark_pine'))
    me.materials.append(bpy.data.materials.get('needles') or tree_material('needles'))
    return ob

def setup_render_scene():
    from mathutils import Vector
    sc = reset_scene()
    w = bpy.data.worlds.new('sky'); sc.world = w; w.use_nodes = True
    nt = w.node_tree; nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputWorld'); bg = nt.nodes.new('ShaderNodeBackground')
    tc = nt.nodes.new('ShaderNodeTexCoord'); sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    nt.links.new(tc.outputs['Generated'], sep.inputs[0])
    nt.links.new(sep.outputs['Z'], ramp.inputs[0])
    ramp.color_ramp.elements[0].position = 0.5; ramp.color_ramp.elements[0].color = (0.95, 0.62, 0.36, 1)
    ramp.color_ramp.elements[1].position = 0.75; ramp.color_ramp.elements[1].color = (0.22, 0.38, 0.75, 1)
    nt.links.new(ramp.outputs[0], bg.inputs['Color']); bg.inputs['Strength'].default_value = 0.6
    nt.links.new(bg.outputs[0], out.inputs['Surface'])
    # ground
    bpy.ops.mesh.primitive_plane_add(size=4000)
    g = bpy.context.active_object
    gm = bpy.data.materials.new('ground'); gm.use_nodes = True
    p = gm.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = (0.055, 0.06, 0.025, 1); p.inputs['Roughness'].default_value = 1
    g.data.materials.append(gm)
    sun_d = bpy.data.lights.new('sun', 'SUN'); sun_d.energy = 6.0; sun_d.color = (1.0, 0.72, 0.45)
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
        # camera looks along +Y (blender) toward the tree; sun behind the tree = +Y side
        views = [
            ('near', 0, 8.0, 1.7, 0.84 * H, 50, 720, 960, (12, 7)),
            ('mid', 0, 40.0, 1.7, 0.5 * H, 42, 720, 960, (12, 7)),
            ('midfront', 0, 40.0, 1.7, 0.5 * H, 42, 720, 960, (160, 14)),
            ('l0_60', 0, 60.0, 1.7, 0.5 * H, 2 * math.degrees(math.atan(480 / 2 / 15.6 / 60)), 360, 480, (12, 7)),
            ('l1_60', 1, 60.0, 1.7, 0.5 * H, 2 * math.degrees(math.atan(480 / 2 / 15.6 / 60)), 360, 480, (12, 7)),
            ('l1_200', 1, 200.0, 1.7, 0.5 * H, 2 * math.degrees(math.atan(200 / 2 / 4.7 / 200)), 150, 200, (12, 7)),
            ('l2_200', 2, 200.0, 1.7, 0.5 * H, 2 * math.degrees(math.atan(200 / 2 / 4.7 / 200)), 150, 200, (12, 7)),
            ('l0_200', 0, 200.0, 1.7, 0.5 * H, 2 * math.degrees(math.atan(200 / 2 / 4.7 / 200)), 150, 200, (12, 7)),
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

if not os.environ.get('PINES_NOMAIN'):
    main()
