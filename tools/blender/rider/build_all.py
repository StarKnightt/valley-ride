"""
build_all.py - the rider from the base mesh to build/blender/rider/rider.raw.glb, in the open Blender (through the
MCP): the tack, her body in the gallop seat (rider_body), her hair (rider_hair), her rig, ride and clearance
(rider_rig), her textures (rider_bake), the export; then build/blender/rider/rider.blend. Then: pnpm build:rider.

  exec(compile(open(f).read(), f, 'exec'), {'__name__': '__main__', '__file__': f})      (f = this file)
  SKIP_HUMAN=True keeps the standing human already in the scene (its targets are the slow part to load)
"""
import bpy, os

HERE = os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else 'F:/valley-ride/tools/blender/rider'


def run(name, **g):
    f = os.path.join(HERE, name)
    exec(compile(open(f, encoding='utf8').read(), f, 'exec'), {'__name__': '__main__', '__file__': f, **g})


scene = bpy.context.scene
scene.frame_set(0)
arm = bpy.data.objects.get('horse_rig')
if arm:
    arm.data.pose_position = 'REST'        # she and the tack are fitted to the horse at rest
old = bpy.data.objects.get('rider_rig')
if old and old.animation_data:
    old.animation_data.action = None
run('tack_mesh.py')
body = ['cut', 'pose', 'fit', 'joints']
run('rider_body.py', STAGES=body if (globals().get('SKIP_HUMAN') and bpy.data.objects.get('Human')) else ['human'] + body)
run('rider_hair.py')
bpy.data.objects['horse_rig'].data.pose_position = 'POSE'
run('rider_rig.py', STAGES=['rig', 'skin', 'anim', 'check'])
run('rider_bake.py')
run('rider_rig.py', STAGES=['faces', 'export'])
for n in ('rider_rig', 'horse_rig', 'tack_rig', 'rider_bones', 'Human', 'Human.rig'):
    o = bpy.data.objects.get(n)
    if o:
        o.hide_set(True)
        o.hide_render = True
if bpy.data.collections.get('tack_parts'):
    bpy.data.collections['tack_parts'].hide_render = True
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, '..', '..', '..', 'build', 'blender', 'rider', 'rider.blend'), copy=True)
