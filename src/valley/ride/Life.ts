/**
 * Round 19: the small life of a horse and rider standing still (and a little of it on the move). Nothing loops: every
 * motion is a random target eased toward, or a random event at a random interval with its own size and length.
 *
 * The horse's rig has no ear or rib bones, so the breath (the barrel swelling) and the ear flicks are vertex groups
 * classified once at load from the posed mesh and moved in its vertex shader; the rider's long hair has no bones either
 * and sways the same way (classified by its pale blonde in the texture, below the head).
 */
import * as THREE from 'three/webgpu';
import { attribute, float, normalLocal, positionLocal, sin, uniform, vec3, type N } from '../core/tsl';

/** a value that eases toward a random target, re-drawn at random intervals */
export class Wander {
  v = 0;
  private target = 0;
  private t = 0;
  constructor(private lo: number, private hi: number, private tMin: number, private tMax: number, private rate: number, private restP = 0) {}
  step(dt: number) {
    this.t -= dt;
    if (this.t <= 0) {
      // (restP: the chance a new target is the centre: a look round, then back to the front)
      this.target = Math.random() < this.restP ? 0 : this.lo + Math.random() * (this.hi - this.lo);
      this.t = this.tMin + Math.random() * (this.tMax - this.tMin);
    }
    this.v += (this.target - this.v) * (1 - Math.exp(-dt * this.rate));
    return this.v;
  }
}

/** an event at random intervals: a smooth 0 -> amp -> 0 bump of random length and size (and sign) */
export class Pulse {
  v = 0;
  /** true on the frame the bump ends (a stamp lands) */
  ended = false;
  sign = 1;
  private wait: number;
  private u = -1;
  private dur = 0.3;
  private amp = 1;
  constructor(private iMin: number, private iMax: number, private dMin: number, private dMax: number, private aMin = 0.6, private aMax = 1, private signed = false) {
    this.wait = iMin * 0.3 + Math.random() * (iMax - iMin);
  }
  step(dt: number, rateK = 1) {
    this.ended = false;
    if (this.u < 0) {
      this.wait -= dt * rateK;
      if (this.wait <= 0) {
        this.u = 0;
        this.dur = this.dMin + Math.random() * (this.dMax - this.dMin);
        this.amp = this.aMin + Math.random() * (this.aMax - this.aMin);
        this.sign = this.signed && Math.random() < 0.5 ? -1 : 1;
      }
      this.v = 0;
      return 0;
    }
    this.u += dt / this.dur;
    if (this.u >= 1) {
      this.u = -1;
      this.ended = true;
      this.wait = this.iMin + Math.random() * (this.iMax - this.iMin);
      this.v = 0;
      return 0;
    }
    this.v = Math.sin(Math.PI * this.u) * this.amp * this.sign;
    return this.v;
  }
  /** 0..1 through the bump, or -1 between bumps */
  get phase() { return this.u; }
}

export const lifeU = {
  /** the horse's breath, -1..1 */
  breath: uniform(0),
  earL: uniform(0),
  earR: uniform(0),
  time: uniform(0),
  /** the wind in her hair: the air, plus the ride */
  hairWind: uniform(0.3),
};

/** a glTF standard material as a node material (so its vertices can be moved), same maps and values */
export function toNodeMaterial(src: THREE.MeshStandardMaterial) {
  const m = new THREE.MeshStandardNodeMaterial();
  const keys = ['name', 'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'aoMapIntensity', 'emissiveMap', 'emissiveIntensity',
    'roughness', 'metalness', 'side', 'alphaTest', 'transparent', 'opacity', 'envMapIntensity', 'vertexColors', 'normalMapType', 'flatShading', 'alphaMap'] as const;
  const s = src as unknown as Record<string, unknown>, d = m as unknown as Record<string, unknown>;
  for (const k of keys) if (s[k] !== undefined) d[k] = s[k];
  m.color.copy(src.color);
  m.emissive.copy(src.emissive);
  m.normalScale.copy(src.normalScale);
  return m;
}

const sstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * The horse's barrel (for the breath) and ears (for the flicks), from the mesh as posed now, in the horse's root frame
 * (+z forward, +x its left, y up). `poll`: the poll bone there. Sets a `life` attribute and the material's vertices.
 */
export function horseLife(mesh: THREE.SkinnedMesh, root: THREE.Object3D, poll: THREE.Vector3) {
  root.updateMatrixWorld(true);
  mesh.skeleton.update();
  const toRoot = root.matrixWorld.clone().invert().multiply(mesh.matrixWorld);
  const scale = new THREE.Vector3().setFromMatrixScale(toRoot).x;
  const meshFromRoot = toRoot.clone().invert();
  const pos = mesh.geometry.getAttribute('position');
  const life = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3();
  let nB = 0, nL = 0, nR = 0;
  for (let i = 0; i < pos.count; i++) {
    mesh.getVertexPosition(i, p);
    p.applyMatrix4(toRoot);
    // the barrel's sides between the elbows and the stifles, below the saddle
    const barrel = sstep(0.08, 0.2, Math.abs(p.x)) * sstep(0.8, 0.98, p.y) * (1 - sstep(1.3, 1.45, p.y)) * sstep(-0.75, -0.5, p.z) * (1 - sstep(0.15, 0.35, p.z));
    // the ears: above the poll, the tips moving most
    const near = Math.abs(p.z - poll.z) < 0.22 ? 1 : 0;
    const ear = near * sstep(poll.y + 0.03, poll.y + 0.2, p.y);
    life[i * 3] = barrel;
    life[i * 3 + 1] = p.x > poll.x ? ear : 0;
    life[i * 3 + 2] = p.x > poll.x ? 0 : ear;
    if (barrel > 0.5) nB++;
    if (ear > 0.3) { if (p.x > poll.x) nL++; else nR++; }
  }
  mesh.geometry.setAttribute('life', new THREE.BufferAttribute(life, 3));
  // the horse's back (ears flick back) in the mesh's own frame, and metres in its units
  const back = new THREE.Vector3(0, 0, -1).transformDirection(meshFromRoot);
  const k = 1 / scale;
  const m = mesh.material as THREE.MeshStandardNodeMaterial;
  const L = attribute('life', 'vec3');
  const backN = vec3(back.x, back.y, back.z);
  m.positionNode = positionLocal
    .add(normalLocal.mul(lifeU.breath.mul(L.x).mul(0.011 * k)))
    .add(backN.mul(lifeU.earL.mul(L.y).add(lifeU.earR.mul(L.z)).mul(0.08 * k)));
  return { barrel: nB, earL: nL, earR: nR };
}

/**
 * Her hair: the texels of pale blonde in her texture, below the crown of her head, sway in the wind and the ride, more
 * toward the ends. `side`/`back` are the horse's left and back in the rider mesh's frame.
 */
export function riderHair(mesh: THREE.SkinnedMesh, side: THREE.Vector3, back: THREE.Vector3, headY: number) {
  const mat = mesh.material as THREE.MeshStandardNodeMaterial;
  const img = mat.map?.image as (CanvasImageSource & { width: number; height: number }) | undefined;
  if (!img?.width) return 0;
  const W = img.width, H = img.height;
  const cv = new OffscreenCanvas(W, H);
  const cx = cv.getContext('2d')!;
  cx.drawImage(img, 0, 0);
  const px = cx.getImageData(0, 0, W, H).data;
  const uv = mesh.geometry.getAttribute('uv'), pos = mesh.geometry.getAttribute('position');
  const hair = new Float32Array(pos.count);
  let n = 0;
  for (let i = 0; i < pos.count; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    const x = Math.min(W - 1, Math.max(0, Math.floor((u - Math.floor(u)) * W)));
    const y = Math.min(H - 1, Math.max(0, Math.floor((v - Math.floor(v)) * H)));
    const o = (y * W + x) * 4, r = px[o], g = px[o + 1], b = px[o + 2];
    const lum = 0.3 * r + 0.55 * g + 0.15 * b;
    // platinum blonde: light, yellowish, not the pink of skin nor a white cloth
    const blonde = lum > 135 && r - g < 24 && g - b > 6 && g - b < 80 ? 1 : 0;
    // below the crown, more toward the ends
    const w = blonde * sstep(headY + 0.1, headY - 0.45, pos.getY(i));
    hair[i] = w;
    if (w > 0.2) n++;
  }
  mesh.geometry.setAttribute('hair', new THREE.BufferAttribute(hair, 1));
  const h = attribute('hair', 'float');
  const t = lifeU.time;
  const y = positionLocal.y;
  const sideN = vec3(side.x, side.y, side.z), backN = vec3(back.x, back.y, back.z);
  // two slow sways that never line up, a faster ripple down the strands, streaming back with the wind and the ride
  const lat: N = sin(t.mul(1.37).add(y.mul(5.0))).mul(0.6).add(sin(t.mul(0.53).add(1.7)).mul(0.4));
  const str: N = sin(t.mul(2.3).add(y.mul(7.0))).mul(0.3).add(0.7);
  mat.positionNode = positionLocal
    .add(sideN.mul(lat.mul(h).mul(lifeU.hairWind.mul(0.022).add(0.006))))
    .add(backN.mul(str.mul(h).mul(lifeU.hairWind.mul(0.05))));
  void float;
  return n;
}
