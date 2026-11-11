/**
 * The horse standing still: layers of small motion on top of the clip, each on its own clock so nothing lines up or
 * loops. Weighted by how still the horse is (0 at a trot and up: the gallop the gallop test measures is untouched).
 *
 * - breathing: the barrel swells and settles (a morph target added at load: the rig has no ribs), slow at rest, deep and
 *   quick for a while after a hard gallop
 * - ears: each turns and flicks on its own (ear bones)
 * - tail: a swish now and then, a wave running down it (tail bones; the hair springs carry it on)
 * - head: lowers to graze-height and lifts again over tens of seconds; now and then a snort (a toss) or a shake
 * - hind legs: after a while the horse rests one hind leg, tipped on the toe, hip dropped, and later shifts to the other
 *
 * Every layer is a turn on top of what the clip wrote this frame (Horse.pose resets every bone each frame first).
 */
import * as THREE from 'three/webgpu';
import { Pulse, Wander } from './Life';

const sstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);

export class HorseIdle {
  private bone: (n: string) => THREE.Bone;
  /** the barrel's breath: the morph slots on the body mesh */
  private breathSlots: { inf: number[]; slot: number }[] = [];
  private breathPh = Math.random() * 6;
  /** how blown the horse is (0 rested .. 1 just pulled up from a gallop) */
  blown = 0;
  private earTurn = [new Wander(-0.25, 0.9, 1.5, 6, 3.5, 0.45), new Wander(-0.25, 0.9, 1.8, 7, 3.5, 0.45)];
  private earFlick = [new Pulse(2.5, 9, 0.18, 0.32, 0.6, 1), new Pulse(2.5, 9, 0.18, 0.32, 0.6, 1)];
  private swish = new Pulse(3, 11, 0.9, 1.5, 0.6, 1, true);
  private headDown = new Wander(0, 1, 7, 18, 0.55, 0.45);
  private headYaw = new Wander(-0.18, 0.18, 4, 11, 0.8, 0.3);
  private toss = new Pulse(9, 22, 0.55, 0.8, 0.7, 1);
  private shake = new Pulse(18, 40, 0.9, 1.2, 0.8, 1);
  /** resting a hind leg: -1 the left, 1 the right, 0 square; eased */
  private rest = 0;
  private restWant = 0;
  private restT = 6 + Math.random() * 6;
  /** each side's resting-leg pose: bone -> its turn from rest (local) */
  private legRest: Record<'L' | 'R', { bone: THREE.Bone; off: THREE.Quaternion }[]> = { L: [], R: [] };
  private t = 0;
  /** true on the frame a snort or a shake starts (for the sound) */
  snorted = false;
  private q = new THREE.Quaternion();
  private q2 = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private id = new THREE.Quaternion();

  constructor(private root: THREE.Object3D, bones: Map<string, THREE.Bone>) {
    this.bone = (n: string) => {
      const b = bones.get(THREE.PropertyBinding.sanitizeNodeName(n));
      if (!b) throw new Error(`horse.glb has no bone ${n}`);
      return b;
    };
  }

  /** a turn of a bone about an axis of the horse's own frame (root), carried into the bone's parent frame */
  private turn(b: THREE.Bone, axis: THREE.Vector3, angle: number) {
    if (angle === 0) return;
    b.parent!.updateWorldMatrix(true, false);
    this.root.getWorldQuaternion(this.q2);
    b.parent!.getWorldQuaternion(this.q);
    this.v.copy(axis).applyQuaternion(this.q2).applyQuaternion(this.q.invert());
    b.quaternion.premultiply(this.q.setFromAxisAngle(this.v, angle));
  }

  /**
   * At load, with the rig at rest: the barrel's breath morph on the body mesh (its sides and belly between the elbows
   * and the stifles; before the corrective morphs are collected, which hold their own slots), and the resting hind
   * leg's pose for each side, solved so the toe stays on the ground.
   */
  setup(body: THREE.SkinnedMesh, markers: Record<string, { at: [number, number, number] }>, toe: (leg: 'LH' | 'RH') => THREE.Vector3) {
    // ---- breath
    this.root.updateMatrixWorld(true);
    // (the mesh is quantized: its positions reach the model's metres only through the skin - the dequantizing scale and
    // offset are folded into the bones' inverse bind matrices - so each vertex goes through its own blend of its bones'
    // matrices, at rest, and the morph's offset comes back through that blend's inverse)
    body.skeleton.update();
    const rootInv = this.root.matrixWorld.clone().invert();
    const pre = rootInv.multiply(body.matrixWorld).multiply(body.bindMatrixInverse);
    const boneM = body.skeleton.bones.map((b, j) => new THREE.Matrix4().multiplyMatrices(b.matrixWorld, body.skeleton.boneInverses[j]));
    const si = body.geometry.getAttribute('skinIndex'), sw = body.geometry.getAttribute('skinWeight');
    const Mv = new THREE.Matrix4(), acc = new THREE.Matrix4(), tmp = new THREE.Matrix4(), N = new THREE.Matrix3(), Minv = new THREE.Matrix3();
    const scale = 1;
    const g = body.geometry, pos = g.getAttribute('position'), nor = g.getAttribute('normal');
    const zF = markers.LF_elbow.at[2] - 0.08, zB = markers.LH_stifle.at[2] + 0.12;
    const yLo = markers.girth.at[1] - 0.05, yHi = markers.withers.at[1] - 0.22;
    const d = new Float32Array(pos.count * 3);
    const p = new THREE.Vector3(), n = new THREE.Vector3();
    let count = 0;
    for (let i = 0; i < pos.count; i++) {
      acc.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
      for (let k = 0; k < 4; k++) {
        const wk = sw.getComponent(i, k);
        if (wk > 0) { tmp.copy(boneM[si.getComponent(i, k)]); for (let e = 0; e < 16; e++) acc.elements[e] += tmp.elements[e] * wk; }
      }
      const M = Mv.multiplyMatrices(pre, acc).multiply(body.bindMatrix);
      p.fromBufferAttribute(pos, i).applyMatrix4(M);
      n.fromBufferAttribute(nor, i).applyMatrix3(N.getNormalMatrix(M)).normalize();
      Minv.setFromMatrix4(M).invert();
      // the ribs swell outward and the belly a little down; the back above the ribs stays
      const w = sstep(zB, zB + 0.18, p.z) * (1 - sstep(zF - 0.18, zF, p.z)) * sstep(yLo - 0.08, yLo + 0.06, p.y) * (1 - sstep(yHi - 0.15, yHi, p.y)) * (0.35 + 0.65 * Math.min(1, Math.abs(n.x) + Math.max(0, -n.y)));
      if (w <= 0) continue;
      count++;
      // (relative morph, in the mesh's own frame: the normal back out of the root frame)
      n.multiplyScalar(w / scale).applyMatrix3(Minv);
      d[i * 3] = n.x; d[i * 3 + 1] = n.y; d[i * 3 + 2] = n.z;
    }
    const ma = g.morphAttributes;
    const breath = new THREE.BufferAttribute(d, 3);
    breath.name = 'breath';
    (ma.position ??= []).push(breath);
    if (ma.normal) ma.normal.push(new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3));
    g.morphTargetsRelative = true;
    if (!body.morphTargetInfluences) { body.morphTargetInfluences = []; body.morphTargetDictionary = {}; }
    body.morphTargetDictionary!.breath = body.morphTargetInfluences.length;
    body.morphTargetInfluences.push(0);
    this.breathSlots.push({ inf: body.morphTargetInfluences, slot: body.morphTargetDictionary!.breath });

    // ---- the resting hind leg: the stifle forward, the hock and fetlock flexed, the hoof tipped onto its toe; the
    // hock's and the hoof's turns solved (Newton) so the toe stays on the ground a few cm ahead of where it stood
    for (const sd of ['L', 'R'] as const) {
      const leg = `${sd}H` as const;
      const chain = ['pelvis', `femur.${sd}`, `tibia.${sd}`, `cannonH.${sd}`, `pasternH.${sd}`, `hoofH.${sd}`].map((n) => this.bone(n));
      const rest = chain.map((b) => b.quaternion.clone());
      const t0 = toe(leg).clone();
      const want = new THREE.Vector3(t0.x, t0.y, t0.z + 0.07);
      const set = (x: number[]) => {
        chain.forEach((b, i) => b.quaternion.copy(rest[i]));
        // (the pelvis drops on the resting side: a turn about the forward axis)
        this.turn(chain[0], Z, (sd === 'L' ? -1 : 1) * 0.035);
        this.turn(chain[1], X, -0.1);        // stifle forward
        this.turn(chain[2], X, x[0]);        // gaskin
        this.turn(chain[3], X, x[1]);        // cannon
        this.turn(chain[4], X, 0.35);        // fetlock flexed
        this.turn(chain[5], X, x[2]);        // the hoof onto its toe
        this.root.updateMatrixWorld(true);
        return toe(leg);
      };
      // the hoof's sole tilted ~30 degrees toe-down: measured by the hoof bone's direction against its rest
      const hoofB = chain[5];
      const restDir = new THREE.Vector3(0, 1, 0).applyQuaternion(hoofB.getWorldQuaternion(new THREE.Quaternion())).clone();
      const tilt = () => {
        const dnow = new THREE.Vector3(0, 1, 0).applyQuaternion(hoofB.getWorldQuaternion(new THREE.Quaternion()));
        return Math.atan2(dnow.y, Math.hypot(dnow.z, dnow.x)) - Math.atan2(restDir.y, Math.hypot(restDir.z, restDir.x));
      };
      const f = (x: number[]) => { const tp = set(x); return [tp.y - want.y, tp.z - want.z, Math.abs(tilt()) - 0.5]; };
      let x = [0.1, -0.2, -0.3];
      for (let it = 0; it < 30; it++) {
        const r = f(x), Jm: number[][] = [[], [], []];
        for (let j = 0; j < 3; j++) { const xh = x.slice(); xh[j] += 1e-3; const rh = f(xh); for (let i = 0; i < 3; i++) Jm[i][j] = (rh[i] - r[i]) / 1e-3; }
        const dx = solve3(Jm, r.map((v) => -v));
        if (!dx) break;
        x = x.map((v, i) => v + Math.max(-0.2, Math.min(0.2, dx[i])));
        if (Math.hypot(...r) < 1e-4) break;
      }
      const err = f(x);
      this.legRest[sd] = chain.map((b, i) => ({ bone: b, off: rest[i].clone().invert().multiply(b.quaternion) }));
      chain.forEach((b, i) => b.quaternion.copy(rest[i]));
      this.root.updateMatrixWorld(true);
      console.info(`[horse] resting ${leg}: toe off by ${(Math.hypot(err[0], err[1]) * 1000).toFixed(1)} mm, hoof tipped ${(Math.abs(err[2] + 0.5) * 57.3).toFixed(0)} deg (gaskin ${(x[0] * 57.3).toFixed(0)}, cannon ${(x[1] * 57.3).toFixed(0)}, hoof ${(x[2] * 57.3).toFixed(0)} deg)`);
    }
    console.info(`[horse] idle: breath on ${count} vertices`);
  }

  /** after the clip has posed the rig; w: how still the horse is (0..1), effort: the gallop's share of speed */
  step(dt: number, w: number, effort: number) {
    this.snorted = false;
    this.t += dt;
    // blown: rises at the gallop, eases off over a minute or so at rest
    this.blown = Math.min(1, this.blown + dt * effort * effort * 0.12);
    this.blown *= Math.exp(-dt * (1 - effort) / 22);
    // breath: 12 a minute at rest, up to 40 blown; deeper blown. Always on (it is under the saddle at the gallop too)
    this.breathPh += dt * (0.2 + 0.47 * this.blown) * Math.PI * 2;
    const br = Math.sin(this.breathPh) + 0.25 * Math.sin(2 * this.breathPh + 0.8);
    for (const s of this.breathSlots) s.inf[s.slot] = (0.006 + 0.008 * this.blown) * (0.5 + 0.5 * br);
    if (w <= 0) return;

    // ---- head: down toward the grass and back up over tens of seconds; a little look about; a toss with a snort,
    // now and then a shake of the whole head and neck
    const down = this.headDown.step(dt) * w * (1 - this.blown * 0.6);
    const yaw = this.headYaw.step(dt) * w;
    const was = this.toss.phase < 0 && this.shake.phase < 0;
    const toss = this.toss.step(dt) * w;
    const shake = this.shake.step(dt) * w;
    // (a snort as a toss or a shake starts)
    if (was && (this.toss.phase >= 0 || this.shake.phase >= 0)) this.snorted = w > 0.5;
    const shakeYaw = shake * 0.22 * Math.sin(this.t * 2 * Math.PI * 3.2);
    const [n1, n2, n3, hd] = ['neck1', 'neck2', 'neck3', 'head'].map((n) => this.bone(n));
    this.turn(n1, X, 0.42 * down - 0.05 * toss);
    this.turn(n2, X, 0.22 * down);
    this.turn(n3, X, 0.1 * down - 0.08 * toss);
    this.turn(hd, X, -0.08 * down - 0.22 * toss + 0.03 * Math.sin(this.t * 0.37));
    this.turn(n1, Y, yaw * 0.4);
    this.turn(n2, Y, yaw * 0.3 + shakeYaw * 0.3);
    this.turn(n3, Y, yaw * 0.3 + shakeYaw * 0.5);
    this.turn(hd, Z, shakeYaw * 0.9);

    // ---- ears: each turns on its own (forward .. out and back), flicks back now and then; the shake rattles them
    (['L', 'R'] as const).forEach((sd, i) => {
      const e = this.bone(`ear.${sd}`);
      const turn = this.earTurn[i].step(dt), flick = this.earFlick[i].step(dt);
      this.turn(e, Y, (sd === 'L' ? 1 : -1) * turn * 0.7 * w);
      this.turn(e, X, (-0.55 * flick - 0.15 * Math.max(0, turn) - 0.4 * shake) * w);
    });

    // ---- tail: a swish to one side and back, the wave reaching the tip a beat late
    this.swish.step(dt);
    const ph = this.swish.phase;
    for (let i = 0; i < 4; i++) {
      const u = ph < 0 ? -1 : ph * 1.25 - i * 0.08;
      const s = u > 0 && u < 1 ? Math.sin(Math.PI * u) * Math.sin(Math.PI * u) : 0;
      this.turn(this.bone(`tail${i + 1}`), Y, this.swish.sign * s * (0.22 + 0.1 * i) * w);
    }

    // ---- hind legs: rest one, after a while shift to the other (or stand square)
    this.restT -= dt;
    if (this.restT <= 0) {
      this.restWant = this.restWant !== 0 && Math.random() < 0.35 ? 0 : this.restWant === 0 ? (Math.random() < 0.5 ? -1 : 1) : -this.restWant;
      this.restT = 9 + Math.random() * 14;
    }
    // (only once the horse has stood a moment; eased over a second and a half)
    const goal = w > 0.97 ? this.restWant : 0;
    this.rest += THREE.MathUtils.clamp(goal - this.rest, -dt / 1.6, dt / 1.6);
    const r = this.rest;
    if (r !== 0) {
      const k = sstep(0, 1, Math.abs(r)) * w;
      for (const { bone, off } of this.legRest[r < 0 ? 'L' : 'R']) bone.quaternion.multiply(this.q.slerpQuaternions(this.id, off, k));
    }
  }
}

function solve3(A: number[][], b: number[]) {
  const m = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-9) return null;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < 3; r++) if (r !== c) { const f = m[r][c] / m[c][c]; for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k]; }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}
