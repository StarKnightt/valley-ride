"""
build_all.py - the whole horse, from tools/blender/horse/gallop.design.json to build/blender/horse/horse.raw.glb.

In Blender (the MCP session, or headless):
  blender -b --python tools/blender/horse/build_all.py
Stages, in order: horse_mesh (parts, high, low), horse_rig, horse_bake (Cycles on the GPU), horse_anim (keys the
gallop, exports the GLB), horse_turntable (EEVEE on the GPU). Then, in the repo:
  npx tsx tools/build-horse.ts          -> public/assets/horse/horse.glb, horse.json
  node scripts/horse-turntable.mjs      -> tools/blender/horse/turntable.mp4, turntable.jpg
The .blend is saved next to the output (build/blender/horse/horse.blend); everything in it is rebuilt by this
script, so it is not kept in the repository.
"""
import bpy, os, time

HERE = os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else 'F:/valley-ride/tools/blender/horse'
SKIP = globals().get('SKIP', ())
t0 = time.time()
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
for name in ('horse_mesh', 'horse_rig', 'horse_bake', 'horse_anim', 'horse_turntable'):
    if name in SKIP:
        continue
    f = os.path.join(HERE, name + '.py').replace(os.sep, '/')
    g = {'__name__': '__main__', '__file__': f}
    c = bpy.data.collections.get('horse_parts')
    if c:
        c.hide_viewport = False
    exec(compile(open(f, encoding='utf8').read(), f, 'exec'), g)
    print(f'[horse] {name} done at {time.time() - t0:.1f} s', flush=True)
c = bpy.data.collections.get('horse_parts')
if c:
    c.hide_viewport = True
h = bpy.data.objects.get('horse_high')
if h:
    h.hide_set(True)
out = os.path.join(HERE, '..', '..', '..', 'build', 'blender', 'horse', 'horse.blend')
bpy.ops.wm.save_as_mainfile(filepath=os.path.normpath(out), check_existing=False)
print('[horse] saved', os.path.normpath(out), flush=True)
