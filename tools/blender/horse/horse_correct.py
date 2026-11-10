"""
horse_correct.py - corrective shapes for the hindquarters in the gallop (run after horse_anim has keyed the gallop).

With the hind leg brought under the body (the gathered phase, the thigh flexed 45-60 deg on the pelvis), linear blend
skinning swells the back of the thigh into a round ball hanging between the point of buttock and the hock: the skin
there sits between the pelvis and the femur, and the blend of the two pulls it out and down. A real horse's hamstring
line stays a long, near-straight line from the point of buttock to the back of the hock.

For each hind leg, in each frame of the gallop, the skinned surface behind and below that line (the chord from the
point of buttock to the back of the gaskin) is pulled most of the way back to it, smoothly. That correction, taken
back through the skinning into the rest pose, is one shape key per side ("gatherL", "gatherR"), sized at the frame
that needs it most; every frame's weight is the least-squares fit of that frame's correction onto the key. The weights
(one per key of the gallop) go to correctives.json, and the runtime sets the morph weights from the stride phase
(src/valley/ride/Horse.ts). The gallop and its joints are untouched: the gallop test does not see a shape key.

Prints the volume of the hindquarter (behind the hip) at the worst frames, before and after.
"""
import bpy, sys, os, json, math
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else 'F:/valley-ride/tools/blender/horse')
import importlib, hlib
importlib.reload(hlib)
from hlib import log, design, Rest, S, HERE

KEEP = globals().get('KEEP', 0.15)      # how much of the overhang past the hamstring line is kept
D = design()
R = Rest(D)
N = D['keys']['n']


def smooth(x, a, b):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def skin_data(mesh, arm):
    """rest coordinates, and the weights as a dense (verts x deform bones) matrix"""
    V = np.array([v.co[:] for v in mesh.data.vertices], dtype=np.float64)
    names = [b.name for b in arm.data.bones if b.use_deform]
    col = {n: i for i, n in enumerate(names)}
    gname = {g.index: g.name for g in mesh.vertex_groups}
    W = np.zeros((len(V), len(names)))
    for v in mesh.data.vertices:
        for g in v.groups:
            n = gname[g.group]
            if n in col:
                W[v.index, col[n]] += g.weight
    s = W.sum(1, keepdims=True)
    W = W / np.where(s > 0, s, 1)
    return V, W, names


def bone_mats(arm, names):
    """skinning matrices (4x4) of the current pose, mesh and armature both at the origin"""
    return np.array([np.array(arm.pose.bones[n].matrix @ arm.data.bones[n].matrix_local.inverted()) for n in names])


def skin(V, W, M):
    """LBS: posed points, and each vertex's blended 3x3"""
    A = np.einsum('vb,bij->vij', W, M)                     # (v,4,4)
    P = np.einsum('vij,vj->vi', A[:, :3, :3], V) + A[:, :3, 3]
    return P, A[:, :3, :3]


def at_bone(arm, bone, p_rest):
    m = arm.pose.bones[bone].matrix @ arm.data.bones[bone].matrix_local.inverted()
    return np.array(m @ Vector(p_rest))


def correction(arm, V, W, names, P, side):
    """the posed correction (v,3) for one hind leg in the current pose"""
    sg = 1.0 if side == 'L' else -1.0
    col = {n: i for i, n in enumerate(names)}
    # which vertices: the leg's thigh and gaskin and the pelvis's skin on that side, above the hock
    leg = W[:, col[f'femur.{side}']] + W[:, col[f'femurHalf.{side}']] + W[:, col[f'tibia.{side}']] + W[:, col['pelvis']]
    hock_z = S(R.head('cannonH.L'))[2]                      # (rest: both sides alike)
    mask = smooth(leg, 0.35, 0.8) * smooth(sg * V[:, 0], -0.03, 0.05) * smooth(V[:, 2], hock_z + 0.02, hock_z + 0.14)
    # the hamstring line: point of buttock (on the pelvis) to the back of the gaskin above the hock (on the tibia)
    lat = 0.09 * sg
    B = at_bone(arm, 'pelvis', S(R.mk('buttock'), lat))
    th, tt = R.head('tibia.L'), R.tail('tibia.L')
    g = th + (tt - th) * 0.72
    ax = (tt - th).normalized()
    back = Vector((-ax[1], ax[0])) if (-ax[1]) < 0 else Vector((ax[1], -ax[0]))   # perpendicular, toward the tail (-x)
    G = at_bone(arm, f'tibia.{side}', S(g + back * 0.075, 0.16 * sg))
    # in the side plane (Blender Y, Z): chord B -> G, the outward normal away from the leg's front
    b2, g2 = B[1:], G[1:]
    c = g2 - b2
    L = np.linalg.norm(c)
    u = c / L
    n = np.array([-u[1], u[0]])
    stifle = at_bone(arm, f'tibia.{side}', S(R.mk(f'{side}H_stifle'), 0.2 * sg))[1:]
    if np.dot(stifle - b2, n) > 0:
        n = -n                                              # outward: away from the stifle
    q = P[:, 1:] - b2
    t = q @ u / L
    d = q @ n
    over = np.maximum(d, 0)
    # keep KEEP of the overhang, softly (a little overhang is the muscle's own round)
    kept = KEEP * over + (1 - KEEP) * 0.012 * (1 - np.exp(-over / 0.012))
    along = smooth(t, -0.05, 0.12) * (1 - smooth(t, 0.85, 1.02))
    pull = (over - kept) * mask * along
    out = np.zeros_like(P)
    out[:, 1:] = -pull[:, None] * n[None, :]
    # spread over the surface, so neighbours move together (a pull along one normal, vertex by vertex, folds the skin
    # where the overhang starts)
    out = relax(out, SMOOTH_ITERS)
    # the volume taken off the overhang goes back into the thigh's own face, in front of the line (where the muscle
    # is): an outward push along the skin's normal, sized so the body's volume is what it was before the pull
    inside = np.maximum(-d, 0)
    band = mask * along * smooth(inside, 0.0, 0.05) * (1 - smooth(inside, 0.16, 0.3)) * smooth(sg * V[:, 0], 0.04, 0.12)
    Nv, Av = vertex_normals(P)
    push = relax(band[:, None] * Nv, SMOOTH_ITERS)
    lost = -(out * Av).sum()                                  # volume change of the pull (first order), negative
    gain = (push * Av).sum()
    if gain > 1e-9 and lost > 0:
        out = out + push * (lost / gain)
    return out


def vertex_normals(P):
    """posed unit vertex normals, and the area vectors (area-weighted normal / 3) that give dVolume = sum(dP . A)"""
    t = _TRIS
    a, b, c = P[t[:, 0]], P[t[:, 1]], P[t[:, 2]]
    fn = np.cross(b - a, c - a) / 2                            # area-weighted face normals
    A = np.zeros_like(P)
    for k in range(3):
        np.add.at(A, t[:, k], fn / 3)
    Nv = A / np.maximum(np.linalg.norm(A, axis=1, keepdims=True), 1e-12)
    return Nv, A


SMOOTH_ITERS = globals().get('SMOOTH_ITERS', 25)
_EDGES = None


def relax(F, iters):
    """Laplacian smoothing of a per-vertex field over the mesh's edges"""
    a, b = _EDGES
    deg = np.bincount(a, minlength=len(F)) + np.bincount(b, minlength=len(F))
    deg = np.maximum(deg, 1)[:, None]
    for _ in range(iters):
        acc = np.zeros_like(F)
        np.add.at(acc, a, F[b])
        np.add.at(acc, b, F[a])
        F = 0.5 * F + 0.5 * acc / deg
    return F


_TRIS = None


def hind_volume(mesh, P):
    """the closed body's volume (the divergence theorem over its triangles)"""
    global _TRIS
    if _TRIS is None:
        me = mesh.data
        me.calc_loop_triangles()
        t = np.empty(len(me.loop_triangles) * 3, dtype=np.int64)
        me.loop_triangles.foreach_get('vertices', t)
        _TRIS = t.reshape(-1, 3)
    a, b, c = P[_TRIS[:, 0]], P[_TRIS[:, 1]], P[_TRIS[:, 2]]
    return float(np.einsum('ij,ij->i', a, np.cross(b, c)).sum() / 6)


def build():
    mesh, arm = bpy.data.objects['horse'], bpy.data.objects['horse_rig']
    scene = bpy.context.scene
    V, W, names = skin_data(mesh, arm)
    global _EDGES
    ev = np.empty(len(mesh.data.edges) * 2, dtype=np.int64)
    mesh.data.edges.foreach_get('vertices', ev)
    _EDGES = (ev[0::2], ev[1::2])
    hind_volume(mesh, V)                                      # (builds the triangle list)
    rest_keys = mesh.data.shape_keys
    if rest_keys:
        mesh.shape_key_clear()
    corr = {'L': [], 'R': []}
    posed = []
    for f in range(N):
        scene.frame_set(f)
        M = bone_mats(arm, names)
        P, A = skin(V, W, M)
        Ainv = np.linalg.inv(A)
        for side in 'LR':
            dP = correction(arm, V, W, names, P, side)
            corr[side].append(np.einsum('vij,vj->vi', Ainv, dP))   # back into the rest pose
        posed.append((P, A))
    mesh.shape_key_add(name='Basis', from_mix=False)
    table = {}
    for side in 'LR':
        C = np.array(corr[side])                                  # (frames, v, 3)
        mag = np.sqrt((C ** 2).sum((1, 2)))
        fstar = int(mag.argmax())
        K = C[fstar]
        w = np.clip((C * K[None]).sum((1, 2)) / (K * K).sum(), 0, 1.25)
        kb = mesh.shape_key_add(name=f'gather{side}', from_mix=False)
        kb.value = 0.0      # (a new key comes in at 1 here: left on, the next bake would bake the corrected shape at rest)
        co = V + K
        kb.data.foreach_set('co', co.astype(np.float32).ravel())
        table[f'gather{side}'] = [round(float(x), 4) for x in w]
        resid = np.sqrt(((C - w[:, None, None] * K[None]) ** 2).sum((1, 2))) / np.maximum(mag, 1e-9)
        log(f'gather{side}: sized at frame {fstar}, largest pull {np.linalg.norm(K, axis=1).max() * 100:.1f} cm, '
            f'{int((np.linalg.norm(K, axis=1) > 0.002).sum())} vertices; weight max {w.max():.2f} mean {w.mean():.2f}; '
            f'fit residual at the heaviest frames {np.median(resid[w > 0.5]) if (w > 0.5).any() else 0:.2f}')
    # the hindquarter's volume, rest and the three most gathered frames, before and after
    v0 = hind_volume(mesh, V)
    wsum = np.array(table['gatherL']) + np.array(table['gatherR'])
    KL = np.array([k.co[:] for k in mesh.data.shape_keys.key_blocks['gatherL'].data]) - V
    KR = np.array([k.co[:] for k in mesh.data.shape_keys.key_blocks['gatherR'].data]) - V
    for f in np.argsort(-wsum)[:3]:
        P, A = posed[f]
        after = P + np.einsum('vij,vj->vi', A, table['gatherL'][f] * KL + table['gatherR'][f] * KR)
        log(f'body volume at frame {f}: {hind_volume(mesh, P) / v0 * 100:.1f}% of rest before, {hind_volume(mesh, after) / v0 * 100:.1f}% after')
    with open(os.path.join(HERE, 'correctives.json'), 'w', encoding='utf8') as fh:
        json.dump({'note': 'morph weights per gallop key (frame k of N = stride phase k/N), from horse_correct.py', 'n': N, 'weights': table}, fh)
    log('correctives.json written')
    scene.frame_set(0)


if __name__ == '__main__' and globals().get('RUN', True):
    build()
