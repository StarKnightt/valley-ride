/**
 * PLACEHOLDER horse and rider: grey boxes built in code, so the valley boots and rides while the real horse is built
 * in Blender (GAME.md, rounds 2-5). Keeps the interface Ride.ts and the audio read: speed and gait, a stride phase
 * that advances at speed / stride, footfalls per leg, and the markers for the eye, the bit and the reins.
 *
 * The legs swing about the hip and shoulder; the footfall timing is a rough per-gait pattern, not a gait model.
 * Round 2 replaces this file with our rigged horse and its own bone mapping.
 */
import * as THREE from 'three/webgpu';
import { sunLit } from '../core/lighting';

/** ground speeds (m/s) of the gaits, and the stride (m) of one full cycle at each */
export const GAIT = {
  walk: 1.75, trot: 3.9, gallop: 10.0,
  strideWalk: 1.85, strideTrot: 2.5, strideGallop: 3.9,
};
/** gait value from ground speed: 0 walk .. 1 trot .. 2 gallop */
export function gaitOf(speed: number) {
  if (speed <= GAIT.walk) return 0;
  if (speed <= GAIT.trot) return THREE.MathUtils.smoothstep(speed, GAIT.walk, GAIT.trot);
  return 1 + THREE.MathUtils.smoothstep(speed, GAIT.trot, GAIT.gallop);
}

type Leg = 'LF' | 'RF' | 'LH' | 'RH';
const LEGS: Leg[] = ['LF', 'RF', 'LH', 'RH'];
/** footfall phase of each leg at walk, trot, gallop (rough: walk lateral sequence, trot diagonal pairs, gallop 4-beat) */
const PLANT: Record<Leg, [number, number, number]> = {
  LH: [0, 0, 0], LF: [0.25, 0.5, 0.6], RH: [0.5, 0.5, 0.1], RF: [0.75, 0, 0.7],
};
const lerp3 = (a: [number, number, number], g: number) => (g <= 1 ? a[0] + (a[1] - a[0]) * g : a[1] + (a[2] - a[1]) * (g - 1));
const wrap = (x: number) => x - Math.floor(x);

export interface Footfall { leg: Leg; force: number; pos: THREE.Vector3 }

/** body proportions (m): withers ~1.6 m */
const BODY = { len: 1.7, w: 0.55, h: 0.7, legTop: 0.95, legLen: 0.95, legW: 0.13 };

export class Horse {
  /** world placement: position on the ground under the body's centre, heading yaw (forward = +z local) */
  readonly root = new THREE.Group();
  /** pitch/roll on the ground and the gait's bounce, inside root */
  private body = new THREE.Group();
  private phase = 0;
  private legPrev: Record<Leg, number> = { LF: 0, RF: 0, LH: 0, RH: 0 };
  private legPivots = {} as Record<Leg, THREE.Group>;
  private neck = new THREE.Group();
  readonly eye = new THREE.Object3D();
  readonly bitL = new THREE.Object3D();
  readonly bitR = new THREE.Object3D();
  readonly saddleHorn = new THREE.Object3D();
  readonly neckL = new THREE.Object3D();
  readonly neckR = new THREE.Object3D();
  /** hoof markers (world positions = footfalls) */
  hooves = {} as Record<Leg, THREE.Object3D>;
  halfLen = 0.6;
  halfWidth = 0.22;
  heading = 0;
  readonly rider = new THREE.Group();
  /** turn rate (rad/s, + left), set by Ride */
  turnRate = 0;
  /** the jump (set by Ride): airborne, the body's drop (m) and extra pitch (+ nose down) */
  air = false;
  lift = 0;
  jumpPitch = 0;
  pitch = 0;
  roll = 0;
  /** extra head-down/head-up of a refusal, a drink (rad, + nose down) */
  headNod = 0;
  speed = 0;
  gait = 0;
  /** this frame's events for the sound: a hoof stamped (where), a soft snort (the placeholder does neither) */
  stamp: THREE.Vector3 | null = null;
  snort = false;

  async load() {
    const grey = sunLit(new THREE.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 0.85 }));
    const dark = sunLit(new THREE.MeshStandardMaterial({ color: 0x5a5a5a, roughness: 0.85 }));
    const box = (w: number, h: number, d: number, m: THREE.Material) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      mesh.castShadow = mesh.receiveShadow = true;
      return mesh;
    };
    const { len, w, h, legTop, legLen, legW } = BODY;
    const barrel = box(w, h, len, grey);
    barrel.position.y = legTop + h / 2 - 0.1;
    this.body.add(barrel);
    // legs: pivots at the shoulder and hip, the leg hanging below, a hoof marker at its foot
    for (const leg of LEGS) {
      const piv = new THREE.Group();
      const x = (leg[0] === 'L' ? 1 : -1) * (w / 2 - legW / 2);
      const z = (leg[1] === 'F' ? 1 : -1) * (len / 2 - 0.15);
      piv.position.set(x, legTop, z);
      const m = box(legW, legLen, legW, dark);
      m.position.y = -legLen / 2;
      const hoof = new THREE.Object3D();
      hoof.position.y = -legLen;
      piv.add(m, hoof);
      this.body.add(piv);
      this.legPivots[leg] = piv;
      this.hooves[leg] = hoof;
    }
    // neck and head, pivoting at the withers
    this.neck.position.set(0, legTop + h - 0.05, len / 2 - 0.1);
    const neckBox = box(0.26, 0.8, 0.3, grey);
    neckBox.position.set(0, 0.32, 0.18);
    neckBox.rotation.x = 0.55;
    const head = box(0.24, 0.24, 0.55, grey);
    head.position.set(0, 0.62, 0.52);
    head.rotation.x = 0.35;
    this.neck.add(neckBox, head);
    this.body.add(this.neck);
    // markers: the bit either side of the mouth, the reins on the neck
    this.bitL.position.set(0.12, 0.5, 0.75);
    this.bitR.position.set(-0.12, 0.5, 0.75);
    this.neckL.position.set(0.1, 0.4, 0.25);
    this.neckR.position.set(-0.1, 0.4, 0.25);
    this.neck.add(this.bitL, this.bitR, this.neckL, this.neckR);
    // rider: a seated column of boxes over the middle of the back
    const backY = legTop + h - 0.1;
    const seat = box(0.42, 0.18, 0.45, dark);
    seat.position.set(0, backY + 0.09, -0.05);
    const torso = box(0.38, 0.62, 0.24, grey);
    torso.position.set(0, backY + 0.5, -0.12);
    const rHead = box(0.2, 0.24, 0.22, grey);
    rHead.position.set(0, backY + 0.95, -0.1);
    for (const s of [1, -1]) {
      const legM = box(0.12, 0.6, 0.14, dark);
      legM.position.set(s * (w / 2 + 0.08), backY - 0.2, 0.0);
      this.rider.add(legM);
    }
    this.rider.add(seat, torso, rHead);
    this.body.add(this.rider);
    this.eye.position.set(0, backY + 0.9, -0.05);
    this.saddleHorn.position.set(0, backY + 0.2, 0.25);
    this.body.add(this.eye, this.saddleHorn);
    this.root.add(this.body);
    this.root.updateMatrixWorld(true);
    this.halfLen = len / 2 + 0.05;
    this.halfWidth = w / 2;
    console.info(`[horse] placeholder: grey boxes, half length ${this.halfLen.toFixed(2)} m`);
  }

  /** advance the gait by dt at the current speed; returns the footfalls that landed this frame */
  update(dt: number, groundPitch: number, groundRoll: number): Footfall[] {
    const g = (this.gait = gaitOf(this.speed));
    const stride = g <= 1 ? GAIT.strideWalk + (GAIT.strideTrot - GAIT.strideWalk) * g : GAIT.strideTrot + (GAIT.strideGallop - GAIT.strideTrot) * (g - 1);
    const move = THREE.MathUtils.smoothstep(this.speed, 0.05, 0.7);
    this.phase = wrap(this.phase + (this.speed / stride) * dt * (this.air ? 0.35 : 1));
    const swing = move * (0.35 + 0.15 * g);
    const out: Footfall[] = [];
    this.root.updateMatrixWorld(true);
    for (const leg of LEGS) {
      const c = wrap(this.phase - lerp3(PLANT[leg], g));
      this.legPivots[leg].rotation.x = this.air ? (leg[1] === 'F' ? -0.6 : 0.6) : swing * Math.cos(c * Math.PI * 2);
      if (move > 0.3 && !this.air && this.legPrev[leg] > 0.75 && c < 0.25) {
        out.push({ leg, force: 0.35 + 0.65 * Math.min(1, this.speed / GAIT.gallop) + (leg.endsWith('F') ? 0.1 : 0), pos: this.hooves[leg].getWorldPosition(new THREE.Vector3()) });
      }
      this.legPrev[leg] = c;
    }
    const ph = this.phase * Math.PI * 2;
    const bounce = move * (0.02 + 0.04 * g) * Math.abs(Math.cos(ph * (g < 1.5 ? 2 : 1)));
    const k = 1 - Math.exp(-dt * 6);
    this.pitch += (groundPitch - this.pitch) * k;
    this.roll += (groundRoll - this.roll) * k;
    this.root.rotation.set(0, this.heading, 0);
    this.body.position.y = bounce * (this.air ? 0.2 : 1) + this.lift;
    this.body.rotation.set(this.pitch + this.jumpPitch, 0, this.roll, 'YXZ');
    this.neck.rotation.x = this.headNod + move * 0.12 * Math.sin(ph + 2.0) * Math.max(0, g - 1);
    return out;
  }

  get stridePhase() { return this.phase; }
}
