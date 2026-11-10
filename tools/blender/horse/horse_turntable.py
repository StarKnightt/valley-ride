"""
horse_turntable.py - a turntable of the finished horse (the game mesh with its baked textures, rest pose), rendered
with EEVEE on the GPU: 96 frames to build/blender/horse/turntable/. scripts/horse-turntable.mjs encodes them with
NVENC into tools/blender/horse/turntable.mp4 and makes the contact sheet turntable.jpg.

The renderer is read back after the first frame and printed; a software rasteriser stops the run
(ALLOW_SOFTWARE = True to opt out on a machine with no GPU).
"""
import bpy, math, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else 'F:/valley-ride/tools/blender/horse')
import importlib, hlib
importlib.reload(hlib)
from hlib import log, WORK

FRAMES = globals().get('FRAMES', 96)
ALLOW_SOFTWARE = globals().get('ALLOW_SOFTWARE', False)
OUT = os.path.join(WORK, 'turntable')
os.makedirs(OUT, exist_ok=True)


def run():
    scene = bpy.context.scene
    horse, arm = bpy.data.objects['horse'], bpy.data.objects['horse_rig']
    saved = dict(fps=scene.render.fps, start=scene.frame_start, end=scene.frame_end, cam=scene.camera, pose=arm.data.pose_position)
    arm.data.pose_position = 'REST'
    hair = bpy.data.objects.get('horse_hair')
    for o in bpy.data.objects:
        o.hide_render = o not in (horse, arm, hair)
    made = []
    def add(ob):
        scene.collection.objects.link(ob)
        made.append(ob)
        return ob
    cam = add(bpy.data.objects.new('tt_cam', bpy.data.cameras.new('tt_cam')))
    cam.data.lens = 60
    pivot = add(bpy.data.objects.new('tt_pivot', None))
    pivot.location = (0, 0, 1.0)
    cam.parent = pivot
    cam.location = (0, -9.4, 0.45)
    cam.rotation_euler = (math.radians(86), 0, 0)
    sun = add(bpy.data.objects.new('tt_sun', bpy.data.lights.new('tt_sun', 'SUN')))
    sun.data.energy = 3.2
    sun.rotation_euler = (math.radians(52), 0, math.radians(35))
    fill = add(bpy.data.objects.new('tt_fill', bpy.data.lights.new('tt_fill', 'SUN')))
    fill.data.energy = 0.9
    fill.rotation_euler = (math.radians(70), 0, math.radians(215))
    me = bpy.data.meshes.new('tt_floor')
    me.from_pydata([(-6, -6, 0), (6, -6, 0), (6, 6, 0), (-6, 6, 0)], [], [(0, 1, 2, 3)])
    floor = add(bpy.data.objects.new('tt_floor', me))
    fm = bpy.data.materials.new('tt_floor')
    fm.use_nodes = True
    b = next(n for n in fm.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = (0.36, 0.33, 0.27, 1)
    b.inputs['Roughness'].default_value = 0.9
    me.materials.append(fm)
    world = scene.world or bpy.data.worlds.new('tt_world')
    scene.world = world
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs['Color'].default_value = (0.62, 0.66, 0.72, 1)
    bg.inputs['Strength'].default_value = 0.55
    try:
        scene.render.engine = 'BLENDER_EEVEE'
    except TypeError:
        scene.render.engine = 'BLENDER_EEVEE_NEXT'
    scene.camera = cam
    scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = 1280, 720, 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.film_transparent = False
    checked = False
    for f in range(FRAMES):
        pivot.rotation_euler = (0, 0, 2 * math.pi * f / FRAMES)
        scene.render.filepath = os.path.join(OUT, f'{f:04d}.png')
        bpy.ops.render.render(write_still=True)
        if not checked:
            import gpu
            r = gpu.platform.renderer_get()
            log('[gpu]', gpu.platform.backend_type_get(), '|', r, '|', gpu.platform.vendor_get())
            if re.search(r'swiftshader|llvmpipe|software|basic render|warp|microsoft', r, re.I) and not ALLOW_SOFTWARE:
                raise SystemExit('CPU rasteriser in use: ' + r)
            checked = True
    for ob in made:
        d = ob.data
        bpy.data.objects.remove(ob, do_unlink=True)
    arm.data.pose_position = saved['pose']
    scene.camera = saved['cam']
    log('turntable:', FRAMES, 'frames in', OUT)


if globals().get('RUN', True):
    run()
