/**
 * The horse's mane as strands, over the mesh's mane cards: ~1000 thin ribbons rooted along the neck's crest,
 * falling to the off (right) side and following the neck's swell, a forelock at the poll. Each strand is a 3-4 mm ribbon of 6 segments: root darker, tips lighter and
 * finer, a hair's specular sheen (low roughness along the strand), and per strand a tint, a length and a phase.
 *
 * The strands are rebuilt in the frames of the neck bones (each strand on the bone nearest its root), so they ride
 * the neck's pump at the gallop; in the shader they sway with the wind and stream back with the horse's speed
 * (world-space offsets, carried into each bone's frame).
 */
import * as THREE from 'three/webgpu';
import {
  Fn, attribute, float, mix, modelWorldMatrixInverse, positionLocal, sin, uniform, vec3, vec4, smoothstep, type N,
} from '../core/tsl';
import { sunLit } from '../core/lighting';

export const maneU = { time: uniform(0), flow: uniform(0), gust: uniform(0) };

interface Strand { root: THREE.Vector3; pts: THREE.Vector3[]; bone: number; tint: number; phase: number }

/**
 * crest: the neck's top line in the horse-root frame from the withers to the poll (sorted withers -> poll);
 * width(z): the neck's half width below the crest at that point; bones: neck bones to hang the strands on.
 */
export function buildMane(crest: THREE.Vector3[], halfW: (i: number, depth: number) => number, bones: THREE.Object3D[], rootFrame: THREE.Object3D) {
  const rng = mulberry(4711);
  const strands: Strand[] = [];
  const N = 1000;
  const side = -1; // falls to the horse's right (root x is the left)
  const bonePos = bones.map((b) => rootFrame.worldToLocal(b.getWorldPosition(new THREE.Vector3())));
  for (let k = 0; k < N; k++) {
    // along the crest; the forelock is the last 6%
    const u = rng();
    const fi = u * (crest.length - 1), i0 = Math.floor(fi), i1 = Math.min(crest.length - 1, i0 + 1);
    const root = crest[i0].clone().lerp(crest[i1], fi - i0);
    root.x += (rng() - 0.5) * 0.035;
    root.y -= 0.012;
    const forelock = u > 0.94;
    // longest at mid neck, short at the withers, the forelock long down the face
    const L = forelock ? 0.22 + rng() * 0.12 : (0.12 + 0.3 * Math.sin(Math.min(1, u / 0.9) * Math.PI) ** 0.7) * (0.75 + rng() * 0.45);
    const pts: THREE.Vector3[] = [];
    const lean = 0.35 + rng() * 0.5, back = 0.02 + rng() * 0.05;
    const flip = !forelock && rng() < 0.08 ? -1 : 1; // a few strands fall the near side
    for (let s = 0; s <= 6; s++) {
      const t = s / 6;
      const p = root.clone();
      if (forelock) {
        // down the face, forward of the ears
        p.y -= L * t;
        p.z += 0.07 * t + 0.03 * Math.sin(t * Math.PI);
        p.x += (rng() - 0.5) * 0.01 * t;
      } else {
        // up and over the crest, then down the side, kept just off the swelling neck
        const drop = L * t ** 1.15;
        const out = Math.max(halfW(i0, drop) + 0.012, 0.03 * Math.sin(t * Math.PI * 0.6)) * Math.min(1, t * 3.2) * lean + 0.01 * t;
        p.x += side * flip * (out + 0.02 * Math.sin(t * Math.PI));
        p.y -= drop - 0.025 * Math.sin(Math.min(1, t * 2.5) * Math.PI);
        p.z -= back * t;
      }
      pts.push(p);
    }
    // the bone nearest the root (the neck chain plus the withers' spine bone)
    let bi = 0, bd = Infinity;
    for (let b = 0; b < bonePos.length; b++) { const d = bonePos[b].distanceToSquared(root); if (d < bd) { bd = d; bi = b; } }
    strands.push({ root, pts, bone: bi, tint: 0.82 + rng() * 0.26, phase: rng() });
  }

  const mat = sunLit(new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide }));
  const md = attribute('md', 'vec3'); // s along the strand, tint, phase
  const s = md.x;
  // a hair's colour: off-white, greyer at the root, a cream cast at the tips
  const col = mix(vec3(0.42, 0.41, 0.4), vec3(0.8, 0.78, 0.74), smoothstep(0, 0.5, s)).mul(md.y);
  mat.colorNode = vec4(col, 1);
  mat.roughnessNode = float(0.36);
  // wind and speed, in the world: a sway across and a stream back (upward a little at the gallop), weighted to the tips
  const w = s.mul(s);
  const t = maneU.time;
  const sway = sin(t.mul(2.3).add(md.z.mul(6.28))).mul(0.012).add(sin(t.mul(7.1).add(md.z.mul(31))).mul(0.004).mul(maneU.flow.add(0.3)));
  // (the stream back and up in the horse's own frame: its forward and up carried into each bone's frame at load)
  const fwd = attribute('fw', 'vec3'), upL = attribute('up', 'vec3');
  const local: N = fwd.mul(maneU.flow.mul(-0.13).sub(maneU.gust.mul(0.02))).add(upL.mul(maneU.flow.mul(0.05)));
  const world: N = vec3(sway.mul(0.6), 0, sway);
  mat.positionNode = Fn(() => positionLocal.add(local.mul(w)).add(modelWorldMatrixInverse.mul(vec4(world.mul(w), 0)).xyz))();

  const meshes: THREE.Mesh[] = [];
  for (let b = 0; b < bones.length; b++) {
    const mine = strands.filter((q) => q.bone === b);
    if (!mine.length) continue;
    const pos: number[] = [], nrm: number[] = [], mdA: number[] = [], fwA: number[] = [], idx: number[] = [];
    const inv = bones[b].matrixWorld.clone().invert().multiply(rootFrame.matrixWorld);
    const nInv = new THREE.Matrix3().getNormalMatrix(inv);
    // the horse's forward and up (1 m) in this bone's frame (the bone's scale included)
    const lin = new THREE.Matrix3().setFromMatrix4(inv);
    const fwL = new THREE.Vector3(0, 0, 1).applyMatrix3(lin), upLv = new THREE.Vector3(0, 1, 0).applyMatrix3(lin);
    const upA: number[] = [];
    for (const q of mine) {
      const base = pos.length / 3;
      for (let k = 0; k < q.pts.length; k++) {
        const p = q.pts[k], t = k / (q.pts.length - 1);
        const a = q.pts[Math.max(0, k - 1)], c = q.pts[Math.min(q.pts.length - 1, k + 1)];
        const tan = c.clone().sub(a).normalize();
        // the ribbon's width along the neck (z), its face to the side
        const across = new THREE.Vector3(0, 0, 1).addScaledVector(tan, -tan.z).normalize();
        const n = tan.clone().cross(across).normalize();
        const hw = 0.0019 * (1 - 0.75 * t);
        for (const sg of [-1, 1]) {
          const v = p.clone().addScaledVector(across, sg * hw).applyMatrix4(inv);
          pos.push(v.x, v.y, v.z);
          const nn = n.clone().applyMatrix3(nInv).normalize();
          nrm.push(nn.x, nn.y, nn.z);
          mdA.push(t, q.tint, q.phase);
          fwA.push(fwL.x, fwL.y, fwL.z);
          upA.push(upLv.x, upLv.y, upLv.z);
        }
        if (k > 0) { const o = base + (k - 1) * 2; idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('md', new THREE.Float32BufferAttribute(mdA, 3));
    g.setAttribute('fw', new THREE.Float32BufferAttribute(fwA, 3));
    g.setAttribute('up', new THREE.Float32BufferAttribute(upA, 3));
    g.setIndex(idx);
    const m = new THREE.Mesh(g, mat);
    m.name = `mane-${b}`;
    m.frustumCulled = false;
    m.castShadow = false;
    m.receiveShadow = true;
    bones[b].add(m);
    meshes.push(m);
  }
  return { meshes, count: strands.length };
}

function mulberry(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
