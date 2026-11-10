"""
horse_bake.py - the horse's textures, baked from "horse_high" onto the UVs of "horse" with Cycles on the GPU.

  horse_c.png   colour (sRGB): the coat's colour attribute, shaded a little by ambient occlusion, with a fine grain
  horse_n.png   tangent-space normal: the smooth surface the game mesh was reduced from
  horse_orm.png R occlusion, G roughness, B metallic (0): linear

The bake is ray tracing: it must run on the RTX card (OptiX or CUDA). The script enables only that device, prints
it, and stops if Cycles would fall back to the CPU. Pass ALLOW_CPU = True to bake on a machine with no GPU.
"""
import bpy, sys, os
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else 'F:/valley-ride/tools/blender/horse')
import importlib, hlib
importlib.reload(hlib)
from hlib import log, activate, WORK

SIZE = globals().get('SIZE', 2048)
ALLOW_CPU = globals().get('ALLOW_CPU', False)
TEX = os.path.join(WORK, 'tex')
os.makedirs(TEX, exist_ok=True)


def gpu_cycles(scene):
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
    try:
        scene.render.engine = 'CYCLES'
    except TypeError as e:
        raise SystemExit('Cycles is not available: ' + str(e))
    if chosen:
        scene.cycles.device = 'GPU'
        log('[gpu] Cycles on', chosen[0], chosen[1])
    elif ALLOW_CPU:
        scene.cycles.device = 'CPU'
        log('[gpu] WARNING: no GPU for Cycles, baking on the CPU (ALLOW_CPU)')
    else:
        raise SystemExit('no OptiX / CUDA device for Cycles: refusing to bake on the CPU')
    if scene.cycles.device != 'GPU' and not ALLOW_CPU:
        raise SystemExit('Cycles fell back to the CPU')


def image(name, colour):
    im = bpy.data.images.get(name)
    if im:
        bpy.data.images.remove(im)
    im = bpy.data.images.new(name, SIZE, SIZE, alpha=False, float_buffer=not colour)
    im.colorspace_settings.name = 'sRGB' if colour else 'Non-Color'
    return im


def emit_material(name, attr, is_color):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    a = nt.nodes.new('ShaderNodeAttribute')
    a.attribute_name = attr
    nt.links.new(a.outputs['Color' if is_color else 'Fac'], em.inputs['Color'])
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    return m


def bake():
    scene = bpy.context.scene
    high, low = bpy.data.objects['horse_high'], bpy.data.objects['horse']
    gpu_cycles(scene)
    scene.cycles.samples = 16
    scene.cycles.use_denoising = False
    scene.render.bake.use_selected_to_active = True
    scene.render.bake.cage_extrusion = 0.02
    scene.render.bake.max_ray_distance = 0.06
    scene.render.bake.margin = 16
    # the game mesh's material: one image node, the bake target
    mat = bpy.data.materials.get('horse') or bpy.data.materials.new('horse')
    mat.use_nodes = True
    low.data.materials.clear()
    low.data.materials.append(mat)
    nt = mat.node_tree
    tgt = next((n for n in nt.nodes if n.type == 'TEX_IMAGE' and n.label == 'bake'), None) or nt.nodes.new('ShaderNodeTexImage')
    tgt.label = 'bake'
    nt.nodes.active = tgt
    high.hide_render = False
    high.hide_set(False)
    # nothing but the two meshes may be in the rays' way (the shells the surface was made from sit just inside it)
    for o in bpy.data.objects:
        if o not in (high, low):
            o.hide_render = True
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    high.select_set(True)
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    arm = low.find_armature()
    pos = arm.data.pose_position if arm else None
    if arm:
        arm.data.pose_position = 'REST'
    # the bake is of the rest shape: any shape key (the hindquarters' correctives) off for it
    keys = low.data.shape_keys
    held = {k.name: k.value for k in keys.key_blocks} if keys else {}
    for k in (keys.key_blocks if keys else []):
        if k != keys.reference_key:
            k.value = 0.0
    out = {}
    def run(name, colour, kind, mat_high=None, **kw):
        im = image(name, colour)
        tgt.image = im
        if mat_high:
            high.data.materials.clear()
            high.data.materials.append(mat_high)
        bpy.ops.object.bake(type=kind, **kw)
        px = np.empty(SIZE * SIZE * 4, dtype=np.float32)
        im.pixels.foreach_get(px)
        out[name] = px.reshape(SIZE, SIZE, 4)
        log('baked', name)
        return im
    run('bake_col', True, 'EMIT', emit_material('bake_col', 'Col', True))
    run('bake_rough', False, 'EMIT', emit_material('bake_rough', 'rough', False))
    scene.cycles.samples = 64
    run('bake_ao', False, 'AO')
    scene.cycles.samples = 16
    nim = run('bake_n', False, 'NORMAL', normal_space='TANGENT')
    if arm:
        arm.data.pose_position = pos
    for k in (keys.key_blocks if keys else []):
        if k != keys.reference_key:
            k.value = held[k.name]
    # compose: colour with a little occlusion and a fine grain along the body; occlusion / roughness / metal
    col, ao, rough = out['bake_col'][..., :3], out['bake_ao'][..., 0], out['bake_rough'][..., 0]
    rng = np.random.default_rng(7)
    grain = rng.random((SIZE, SIZE), dtype=np.float32)
    for _ in range(2):
        grain = (grain + np.roll(grain, 1, 0) + np.roll(grain, 1, 1) + np.roll(grain, -1, 0)) / 4
    grain = (grain - grain.mean()) / (grain.std() + 1e-6)
    # muscle shading: occlusion darkens the hollows between the forms and lets their crowns stand a little lighter
    a = np.clip(ao, 0, 1)
    shade = (0.42 + 0.68 * a ** 1.5) * (1 + 0.012 * grain)
    def save(name, arr, colour):
        im = image(name, colour)
        full = np.ones((SIZE, SIZE, 4), dtype=np.float32)
        full[..., :arr.shape[2]] = arr
        im.pixels.foreach_set(full.ravel())
        im.filepath_raw = os.path.join(TEX, name + '.png')
        im.file_format = 'PNG'
        im.save()
        im.pack()
        return im
    c = save('horse_c', np.clip(col * shade[..., None], 0, 1), True)
    orm = save('horse_orm', np.stack([np.clip(ao, 0, 1), np.clip(rough + 0.03 * grain, 0.05, 1), np.zeros_like(ao)], -1), False)
    n = save('horse_n', out['bake_n'][..., :3], False)
    for k in ('bake_col', 'bake_rough', 'bake_ao', 'bake_n'):
        bpy.data.images.remove(bpy.data.images[k])
    # the game material: glTF's metal-rough layout
    nt.nodes.clear()
    o = nt.nodes.new('ShaderNodeOutputMaterial')
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(b.outputs['BSDF'], o.inputs['Surface'])
    tc = nt.nodes.new('ShaderNodeTexImage'); tc.image = c
    to = nt.nodes.new('ShaderNodeTexImage'); to.image = orm
    tn = nt.nodes.new('ShaderNodeTexImage'); tn.image = n
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(tc.outputs['Color'], b.inputs['Base Color'])
    nt.links.new(to.outputs['Color'], sep.inputs['Color'])
    nt.links.new(sep.outputs['Green'], b.inputs['Roughness'])
    nt.links.new(sep.outputs['Blue'], b.inputs['Metallic'])
    nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    hair_material()
    high.hide_render = True
    high.hide_set(True)
    try:
        scene.render.engine = 'BLENDER_EEVEE'
    except TypeError:
        pass
    log('textures in', TEX)


def hair_material():
    """the strand texture of the mane and tail cards (8 columns of strands, root at the top, alpha thinning to the
    tips) and their material"""
    hair = bpy.data.objects.get('horse_hair')
    if not hair:
        return
    Wd, Hd, COLS = 512, 512, 8
    rng = np.random.default_rng(3)
    rgba = np.zeros((Hd, Wd, 4), dtype=np.float32)
    cw = Wd // COLS
    yy = np.linspace(0, 1, Hd, dtype=np.float32)[:, None]            # 0 root .. 1 tip
    xx = np.arange(cw, dtype=np.float32)[None, :]
    for c in range(COLS):
        alpha = np.zeros((Hd, cw), dtype=np.float32)
        tone = np.zeros((Hd, cw), dtype=np.float32)
        for _ in range(17):
            x0 = rng.uniform(3, cw - 3)
            wv = rng.uniform(1.2, 2.6)
            ln = rng.uniform(0.55, 1.0)
            drift = rng.uniform(-5, 5)
            sway = rng.uniform(1, 3) * np.sin(yy * rng.uniform(4, 9) + rng.uniform(0, 6))
            cx = x0 + drift * yy + sway
            wid = wv * np.clip(1 - (yy / ln) ** 3, 0, 1)
            a = np.clip((wid - np.abs(xx - cx)) / 1.2 + 0.5, 0, 1) * (yy < ln) * (yy < 0.97) * (np.abs(xx - cw / 2) < cw / 2 - 2)
            t = rng.uniform(0.6, 1.25)
            tone = np.where(a > alpha, t, tone)
            alpha = np.maximum(alpha, a)
        alpha = np.maximum(alpha, np.clip(1 - yy / 0.07, 0, 1) * ((xx > 3) & (xx < cw - 3)))   # solid at the root
        alpha[-8:, :] = 0
        col = np.array([0.03, 0.024, 0.022], dtype=np.float32)[None, None, :] * (0.7 + 0.5 * tone[..., None]) * (1 + 0.5 * yy[..., None])
        rgba[:, c * cw:(c + 1) * cw, :3] = col
        rgba[:, c * cw:(c + 1) * cw, 3] = alpha
    # (opaque colour everywhere, so mips do not bleed black into the strands' edges)
    im = bpy.data.images.get('horse_hair')
    if im:
        bpy.data.images.remove(im)
    im = bpy.data.images.new('horse_hair', Wd, Hd, alpha=True)
    im.colorspace_settings.name = 'sRGB'
    im.alpha_mode = 'STRAIGHT'
    im.pixels.foreach_set(np.ascontiguousarray(rgba[::-1]).ravel())
    im.filepath_raw = os.path.join(TEX, 'horse_hair.png')
    im.file_format = 'PNG'
    im.save()
    im.pack()
    mat = bpy.data.materials.get('horse_hair') or bpy.data.materials.new('horse_hair')
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    o = nt.nodes.new('ShaderNodeOutputMaterial')
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    t = nt.nodes.new('ShaderNodeTexImage')
    t.image = im
    nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
    nt.links.new(t.outputs['Alpha'], b.inputs['Alpha'])
    b.inputs['Roughness'].default_value = 0.8
    nt.links.new(b.outputs['BSDF'], o.inputs['Surface'])
    mat.use_backface_culling = False
    for attr, val in (('blend_method', 'CLIP'), ('surface_render_method', 'DITHERED')):
        try:
            setattr(mat, attr, val)
        except (AttributeError, TypeError):
            pass
    hair.data.materials.clear()
    hair.data.materials.append(mat)
    log('hair texture', Wd, 'x', Hd)


if globals().get('RUN', True):
    bake()
