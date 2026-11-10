/**
 * The horse: our own model and rig (tools/blender/horse, built into public/assets/horse/horse.glb), and its gallop,
 * authored against Muybridge's plate (tools/gait/design-gallop.ts, GALLOP-TEST.md).
 *
 * The gallop clip is one stride long and its time is the stride phase, so the gait is driven by distance: the phase
 * advances by ground speed / stride length, and a planted hoof stays planted at any speed. Only the gallop exists
 * so far (walk, trot and canter are Round 4): below gallop speed the same cycle plays at the slower phase rate, and
 * near a standstill it fades to the standing pose.
 *
 * The rider is still a placeholder (grey boxes on the horse's back) until Round 5.
 */
import * as THREE from 'three/webgpu';
import { loadGLTF } from '../core/Assets';
import { sunLit } from '../core/lighting';

/** ground speeds (m/s) of the gaits; the stride (m) of one full gallop cycle comes with the model (horse.json) */
export const GAIT = {
  walk: 1.75, trot: 3.9, gallop: 10.0,
  strideGallop: 6.0,
};
/** gait value from ground speed: 0 walk .. 1 trot .. 2 gallop */
export function gaitOf(speed: number) {
  if (speed <= GAIT.walk) return 0;
  if (speed <= GAIT.trot) return THREE.MathUtils.smoothstep(speed, GAIT.walk, GAIT.trot);
  return 1 + THREE.MathUtils.smoothstep(speed, GAIT.trot, GAIT.gallop);
}

export type Leg = 'LF' | 'RF' | 'LH' | 'RH';
export const LEGS: Leg[] = ['LF', 'RF', 'LH', 'RH'];
const wrap = (x: number) => x - Math.floor(x);

export interface Footfall { leg: Leg; force: number; pos: THREE.Vector3 }

/**
 * The joints the gallop test (GALLOP-TEST.md) reads, by name. Trunk: withers, croup, poll, muzzle, and the pelvis
 * (croup -> buttock) and thorax (withers -> girth) axes for the spine angle. Per leg (LF, RF, LH, RH): the top joint
 * (shoulder | hip), then elbow | stifle, knee | hock, fetlock, and the hoof at the sole's toe. Each is a point fixed
 * to one bone of the rig: horse.json lists the bone and where the point is at rest.
 */
export const TRUNK_JOINTS = ['withers', 'croup', 'poll', 'muzzle', 'buttock', 'girth'] as const;
export const FORE_JOINTS = ['shoulder', 'elbow', 'knee', 'fetlock', 'hoof'] as const;
export const HIND_JOINTS = ['hip', 'stifle', 'hock', 'fetlock', 'hoof'] as const;
export function gateJointNames(): string[] {
  const out: string[] = [...TRUNK_JOINTS];
  for (const leg of LEGS) for (const j of leg[1] === 'F' ? FORE_JOINTS : HIND_JOINTS) out.push(`${leg}_${j}`);
  return out;
}

interface HorseMeta {
  lead: 'L' | 'R'; stride: number; period: number; speed: number; keysPerStride: number; triangles: number; hairTriangles: number; bones: number;
  /** the hindquarters' corrective shapes: morph target name -> weight at each gallop key (stride phase k / n) */
  correctives?: Record<string, number[]>;
  /** model space at rest: x left, y up, z forward, the ground at y = 0 */
  markers: Record<string, { bone: string; at: [number, number, number] }>;
}

/**
 * The mane and tail's own motion on top of the clip: each hair bone's tip is a damped spring chasing where the clip
 * puts it, in the horse's frame, so the gallop's bounce and pitch swing the hair a beat late and settle; the hair
 * streams back with speed and swings out on a turn. Each bone turns at most maxDeg off the clip's pose, and a child
 * follows its parent's turn before it is solved itself (chains are listed root first).
 */
// (the springs' own frequency must sit well above the stride's, about 11 rad/s at the gallop: a tail tuned near it
// resonates and whips 70+ degrees off the clip; at 20 rad/s it still lags 30 degrees behind the clip's fast swings and
// flicks the tip forward under the body. ~30 rad/s, well damped: a lag of about ten degrees, a beat late, settling.)
const HAIR = {
  tail: { bones: ['tail1', 'tail2', 'tail3', 'tail4'], k: 900, zeta: 0.6, stream: 0.5, lift: 0.2, maxDeg: 42, swing: 0.05 },
  mane: { bones: ['mane1', 'mane2', 'mane3', 'mane4', 'mane5'], k: 1000, zeta: 0.6, stream: 0.4, lift: 0.0, maxDeg: 34, swing: 0.035 },
};
interface HairBone { bone: THREE.Bone; tail: THREE.Vector3; p: THREE.Vector3; v: THREE.Vector3; cfg: (typeof HAIR)['tail']; ready: boolean }

/** stress poses for the rig check (gait lab): each bone's turn in degrees on top of its parent's, about the lateral
 * axis (+ = clockwise seen from the horse's right side: nose down, a leg's lower end back) or the vertical */
export const STRESS_POSES: Record<string, { label: string; lateral?: Record<string, number>; yaw?: Record<string, number>; lift?: number }> = {
  rest: { label: 'Rest' },
  folded: {
    label: 'Legs folded', lift: 0.3,
    lateral: { humerus: 15, radius: -60, cannonF: 125, pasternF: 60, hoofF: 30, femur: -35, tibia: 75, cannonH: -95, pasternH: 70, hoofH: 30 },
  },
  extended: {
    label: 'Legs extended', lift: 0.15,
    lateral: { scapula: -12, humerus: -35, radius: -10, pasternF: -15, back: 3, loin: 5, pelvis: 8, femur: 45, tibia: 20, cannonH: 25, pasternH: 25 },
  },
  neckDown: { label: 'Neck down', lateral: { neck1: 38, neck2: 28, neck3: 22, head: 18 } },
  neckTurned: { label: 'Neck turned', yaw: { neck1: 22, neck2: 24, neck3: 22, head: 14 } },
  rear: {
    label: 'Rear', lift: 0.55,
    lateral: { chest: -48, loin: -8, pelvis: -10, neck1: 18, head: 14, humerus: 20, radius: -55, cannonF: 95, pasternF: 40, femur: 55, tibia: -10, cannonH: 10 },
  },
  spineFlexed: { label: 'Spine flexed', lift: 0.1, lateral: { back: -4, loin: -12, pelvis: -22, femur: 22, tibia: -10, neck1: 10 } },
};

export class Horse {
  /** world placement: position on the ground under the body's centre, heading yaw (forward = +z local) */
  readonly root = new THREE.Group();
  /** pitch/roll on the ground and the jump's lift, inside root; the gallop's own bounce is in the clip */
  private body = new THREE.Group();
  private phase = 0;
  private wasDown: Record<Leg, boolean> = { LF: true, RF: true, LH: true, RH: true };
  readonly eye = new THREE.Object3D();
  readonly bitL = new THREE.Object3D();
  readonly bitR = new THREE.Object3D();
  readonly saddleHorn = new THREE.Object3D();
  readonly neckL = new THREE.Object3D();
  readonly neckR = new THREE.Object3D();
  /** hoof markers at the soles' toes (world positions = footfalls) */
  hooves = {} as Record<Leg, THREE.Object3D>;
  halfLen = 1.2;
  halfWidth = 0.3;
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
  /** this frame's events for the sound: a hoof stamped (where), a soft snort */
  stamp: THREE.Vector3 | null = null;
  snort = false;
  /** the gallop's lead: the side whose fore lands last */
  lead: 'L' | 'R' = 'R';
  /** markers for the gallop test's joints (gateJoints) */
  private gate = new Map<string, THREE.Object3D>();
  private bones = new Map<string, THREE.Bone>();
  private restQ = new Map<string, THREE.Quaternion>();
  private restP = new Map<string, THREE.Vector3>();
  private mixer!: THREE.AnimationMixer;
  private gallop!: THREE.AnimationAction;
  private model!: THREE.Object3D;
  private head: THREE.Bone | null = null;
  private stress: string | null = null;
  meta!: HorseMeta;
  private v = new THREE.Vector3();
  private q = new THREE.Quaternion();
  /** corrective morphs: the meshes' influence arrays and, per target, its slot and per-key weights */
  private morphs: { influences: number[]; slot: number; table: number[] }[] = [];
  private hair: HairBone[] = [];
  /** the hair's dynamics off (the gait lab's still captures, the stress poses) */
  hairStill = false;

  async load() {
    const [gltf, meta] = await Promise.all([loadGLTF('assets/horse/horse.glb'), fetch('./assets/horse/horse.json').then((r) => r.json() as Promise<HorseMeta>)]);
    this.meta = meta;
    this.lead = meta.lead;
    GAIT.strideGallop = meta.stride;
    const model = (this.model = gltf.scene);
    let tris = 0;
    model.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isMesh) {
        m.castShadow = m.receiveShadow = true;
        m.frustumCulled = false; // (the bound is the rest pose's; the gallop reaches past it)
        sunLit(m.material as THREE.Material);
        tris += (m.geometry.index?.count ?? m.geometry.attributes.position.count) / 3;
      }
      if ((o as THREE.Bone).isBone) { this.bones.set(o.name, o as THREE.Bone); this.restQ.set(o.name, o.quaternion.clone()); this.restP.set(o.name, o.position.clone()); }
    });
    this.body.add(model);
    this.root.add(this.body);
    this.root.updateMatrixWorld(true);
    const bone = (name: string) => {
      const b = this.bones.get(THREE.PropertyBinding.sanitizeNodeName(name));
      if (!b) throw new Error(`horse.glb has no bone ${name}`);
      return b;
    };
    /** a point fixed to a bone, given where it is in model space at rest */
    const pin = (o: THREE.Object3D, boneName: string, at: THREE.Vector3Like) => {
      const b = bone(boneName);
      o.position.copy(b.worldToLocal(this.v.set(at.x, at.y, at.z).clone()));
      b.add(o);
      return o;
    };
    for (const [name, m] of Object.entries(meta.markers)) {
      const o = pin(new THREE.Object3D(), m.bone, { x: m.at[0], y: m.at[1], z: m.at[2] });
      this.gate.set(name, o);
    }
    for (const leg of LEGS) this.hooves[leg] = this.gate.get(`${leg}_hoof`)!;
    this.head = bone('head');
    // where the rider sits and looks from, the bit and the reins
    const w = meta.markers.withers.at, mz = meta.markers.muzzle.at, pl = meta.markers.poll.at;
    pin(this.eye, 'back', { x: 0, y: w[1] + 0.72, z: w[2] - 0.42 });
    pin(this.saddleHorn, 'back', { x: 0, y: w[1] + 0.02, z: w[2] - 0.22 });
    pin(this.bitL, 'head', { x: 0.045, y: mz[1] + 0.04, z: mz[2] - 0.12 });
    pin(this.bitR, 'head', { x: -0.045, y: mz[1] + 0.04, z: mz[2] - 0.12 });
    pin(this.neckL, 'neck2', { x: 0.09, y: (w[1] + pl[1]) / 2, z: (w[2] + pl[2]) / 2 });
    pin(this.neckR, 'neck2', { x: -0.09, y: (w[1] + pl[1]) / 2, z: (w[2] + pl[2]) / 2 });
    // PLACEHOLDER rider: a seated column of grey boxes on the back (Round 5 replaces it)
    const grey = sunLit(new THREE.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 0.85 }));
    const dark = sunLit(new THREE.MeshStandardMaterial({ color: 0x5a5a5a, roughness: 0.85 }));
    const box = (bw: number, bh: number, bd: number, m: THREE.Material, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), m);
      mesh.position.set(x, y, z);
      mesh.castShadow = mesh.receiveShadow = true;
      this.rider.add(mesh);
    };
    box(0.42, 0.16, 0.45, dark, 0, 0.06, 0);
    box(0.38, 0.6, 0.24, grey, 0, 0.45, -0.06);
    box(0.2, 0.24, 0.22, grey, 0, 0.9, -0.04);
    for (const s of [1, -1]) box(0.12, 0.6, 0.14, dark, s * 0.34, -0.25, 0.05);
    pin(this.rider, 'back', { x: 0, y: w[1] - 0.06, z: w[2] - 0.42 });
    this.rider.quaternion.copy(bone('back').getWorldQuaternion(this.q).invert());

    const clip = gltf.animations.find((a) => a.name === 'gallop');
    if (!clip) throw new Error('horse.glb has no gallop clip');
    this.mixer = new THREE.AnimationMixer(model);
    this.gallop = this.mixer.clipAction(clip);
    this.gallop.setLoop(THREE.LoopRepeat, Infinity);
    this.gallop.play();
    // the corrective shapes of the hindquarters, weighted by the stride phase
    model.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isMesh || !m.morphTargetDictionary || !m.morphTargetInfluences) return;
      for (const [name, table] of Object.entries(meta.correctives ?? {})) {
        const slot = m.morphTargetDictionary[name];
        if (slot !== undefined) this.morphs.push({ influences: m.morphTargetInfluences, slot, table });
      }
    });
    if (meta.correctives && this.morphs.length !== Object.keys(meta.correctives).length) throw new Error('horse.glb is missing a corrective morph target');
    // the hair springs: a bone's tail in its own frame is its child's position (bones point along their own +y; the
    // last bone of a chain takes its parent's length)
    for (const cfg of Object.values(HAIR)) {
      let len = 0.22;
      for (const name of cfg.bones) {
        const b = bone(name);
        const child = b.children.find((c) => (c as THREE.Bone).isBone) as THREE.Bone | undefined;
        if (child) {
          len = child.position.length();
          if (child.position.y / len < 0.98) throw new Error(`hair bone ${name} does not point along +y (its child is at ${child.position.toArray()})`);
        }
        this.hair.push({ bone: b, tail: new THREE.Vector3(0, len, 0), p: new THREE.Vector3(), v: new THREE.Vector3(), cfg, ready: false });
      }
    }
    this.halfLen = (mz[2] - meta.markers.buttock.at[2]) / 2 - 0.25;
    this.halfWidth = 0.3;
    this.pose(0, 0);
    console.info(`[horse] our model: ${tris} triangles, ${this.bones.size} bones; gallop stride ${meta.stride.toFixed(2)} m, ${meta.keysPerStride} keys, lead ${meta.lead}`);
  }

  /** the rig at a stride phase, the gallop weighted w (the rest is the standing pose) */
  private pose(phase: number, w: number) {
    this.gallop.time = wrap(phase) * this.gallop.getClip().duration;
    this.gallop.setEffectiveWeight(w);
    this.mixer.update(0);
    if (this.headNod && this.head) this.head.quaternion.multiply(this.q.setFromAxisAngle(this.v.set(1, 0, 0), this.headNod));
    for (const m of this.morphs) {
      const n = m.table.length, x = wrap(phase) * n, i = Math.floor(x) % n, f = x - Math.floor(x);
      m.influences[m.slot] = (m.table[i] + (m.table[(i + 1) % n] - m.table[i]) * f) * w;
    }
  }

  /**
   * The mane and tail springs (HAIR), after the clip has posed the rig. In the horse's own frame (root): the clip's
   * motion of the hair's roots (the gallop's bounce and pitch) drives them; speed streams them back, a turn swings
   * them out.
   */
  private hairStep(dt: number) {
    if (!this.hair.length) return;
    if (this.hairStill || dt <= 0) { for (const h of this.hair) h.ready = false; return; }
    const sp = Math.min(1, this.speed / GAIT.gallop);
    const rootInv = this.root.matrixWorld.clone().invert();
    const head = new THREE.Vector3(), want = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
    const pq = new THREE.Quaternion(), bq = new THREE.Quaternion(), turn = new THREE.Quaternion();
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = Math.min(dt, 0.1) / steps;
    for (const hb of this.hair) {
      const { bone, cfg } = hb;
      bone.updateWorldMatrix(true, false);
      // where the clip puts the bone's tail, and its root, in the horse's frame
      head.setFromMatrixPosition(bone.matrixWorld).applyMatrix4(rootInv);
      want.copy(hb.tail).applyMatrix4(bone.matrixWorld).applyMatrix4(rootInv);
      const len = hb.tail.length();
      // speed streams the hair back (and lifts the tail); a turn swings it to the outside (+x is the horse's left)
      want.z -= cfg.stream * sp * len;
      want.y += cfg.lift * sp * len;
      want.x -= cfg.swing * this.turnRate * this.speed;
      if (!hb.ready) { hb.p.copy(want); hb.v.set(0, 0, 0); hb.ready = true; }
      const c = 2 * cfg.zeta * Math.sqrt(cfg.k);
      for (let s = 0; s < steps; s++) {
        a.copy(want).sub(hb.p).multiplyScalar(cfg.k).addScaledVector(hb.v, -c);
        hb.v.addScaledVector(a, h);
        hb.p.addScaledVector(hb.v, h);
        // (a hair is as long as it is)
        b.copy(hb.p).sub(head).setLength(len);
        hb.p.copy(head).add(b);
      }
      // turn the bone from the clip's direction toward the spring's, at most maxDeg
      a.copy(want).sub(head).normalize();
      b.copy(hb.p).sub(head).normalize();
      turn.setFromUnitVectors(a, b);
      const ang = 2 * Math.acos(Math.min(1, Math.abs(turn.w)));
      const max = THREE.MathUtils.degToRad(cfg.maxDeg);
      if (ang > max) turn.slerp(pq.identity(), 1 - max / ang);
      // (the turn is in the horse's frame: carry it into the bone's parent)
      this.root.getWorldQuaternion(pq);
      turn.premultiply(pq).multiply(pq.clone().invert());       // root frame -> world
      bone.parent!.getWorldQuaternion(pq);
      bone.getWorldQuaternion(bq);
      bone.quaternion.copy(pq.invert().multiply(turn).multiply(bq));
      bone.updateMatrixWorld(true);
    }
  }

  /** advance the gait by dt at the current speed; returns the footfalls that landed this frame */
  update(dt: number, groundPitch: number, groundRoll: number): Footfall[] {
    this.gait = gaitOf(this.speed);
    const out: Footfall[] = [];
    if (this.stress) return out;
    const move = THREE.MathUtils.smoothstep(this.speed, 0.05, 1.0);
    this.phase = wrap(this.phase + (this.speed / GAIT.strideGallop) * dt * (this.air ? 0.35 : 1));
    const k = 1 - Math.exp(-dt * 6);
    this.pitch += (groundPitch - this.pitch) * k;
    this.roll += (groundRoll - this.roll) * k;
    this.root.rotation.set(0, this.heading, 0);
    this.body.position.y = this.lift;
    this.body.rotation.set(this.pitch + this.jumpPitch, 0, this.roll, 'YXZ');
    this.pose(this.phase, move);
    this.root.updateMatrixWorld(true);
    this.hairStep(dt);
    // footfalls: a toe coming down onto the ground (in the horse's own frame: the terrain's tilt is the body's)
    this.body.updateMatrixWorld(true);
    for (const leg of LEGS) {
      const h = this.hooves[leg];
      const y = this.body.worldToLocal(h.getWorldPosition(this.v)).y;
      const down = y < 0.015;
      if (down && !this.wasDown[leg] && move > 0.3 && !this.air) {
        out.push({ leg, force: 0.35 + 0.65 * Math.min(1, this.speed / GAIT.gallop) + (leg.endsWith('F') ? 0.1 : 0), pos: h.getWorldPosition(new THREE.Vector3()) });
      }
      this.wasDown[leg] = down;
    }
    return out;
  }

  get stridePhase() { return this.phase; }

  /** back to the start of a stride (the gait lab records from a known state) */
  resetGait() {
    this.phase = 0;
    this.stress = null;
    for (const leg of LEGS) this.wasDown[leg] = true;
    this.pitch = this.roll = this.lift = this.jumpPitch = this.headNod = 0;
    this.air = false;
    for (const h of this.hair) h.ready = false;
    this.body.position.set(0, 0, 0);
    this.body.rotation.set(0, 0, 0);
    this.pose(0, THREE.MathUtils.smoothstep(this.speed, 0.05, 1.0));
  }

  /** world positions of the gallop test's joints (gateJointNames), read from the current pose */
  gateJoints(): Record<string, THREE.Vector3> {
    this.root.updateMatrixWorld(true);
    const out: Record<string, THREE.Vector3> = {};
    for (const [k, o] of this.gate) out[k] = o.getWorldPosition(new THREE.Vector3());
    return out;
  }

  /** hold a stress pose of the rig (gait lab, Round 2's check); null goes back to the gait */
  setStressPose(name: string | null) {
    this.stress = name;
    this.gallop.setEffectiveWeight(0);
    this.mixer.update(0);
    for (const m of this.morphs) m.influences[m.slot] = 0;
    for (const h of this.hair) h.ready = false;
    for (const [n, b] of this.bones) { b.quaternion.copy(this.restQ.get(n)!); b.position.copy(this.restP.get(n)!); }
    this.body.position.set(0, 0, 0);
    this.body.rotation.set(0, 0, 0);
    const p = name ? STRESS_POSES[name] : null;
    if (!p) return;
    this.body.position.y = p.lift ?? 0;
    this.root.updateMatrixWorld(true);
    const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0);
    const turn = (key: string, deg: number, axis: THREE.Vector3) => {
      for (const [n, b] of this.bones) {
        if (n !== key && n !== `${key}L` && n !== `${key}R`) continue;
        // a turn about a model-space axis, carried into the bone's parent frame (parents first: the map is in
        // hierarchy order)
        b.parent!.updateWorldMatrix(true, false);
        const pq = b.parent!.getWorldQuaternion(new THREE.Quaternion());
        const rq = this.root.getWorldQuaternion(new THREE.Quaternion());
        const ax = axis.clone().applyQuaternion(rq).applyQuaternion(pq.invert());
        b.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(ax, THREE.MathUtils.degToRad(deg)));
      }
    };
    for (const [n] of this.bones) {
      const key = n.replace(/[LR]$/, '');
      const lat = p.lateral?.[n] ?? p.lateral?.[key], yaw = p.yaw?.[n] ?? p.yaw?.[key];
      if (lat !== undefined) turn(n, lat, X);
      if (yaw !== undefined) turn(n, yaw, Y);
    }
    // the half-way bones over the hips and shoulders turn half as far as the bone they lie on
    for (const [n, b] of this.bones) {
      const m = /^(femur|humerus)Half([LR])$/.exec(n);
      if (!m) continue;
      const c = this.bones.get(`${m[1]}${m[2]}`)!;
      const dq = this.restQ.get(c.name)!.clone().invert().multiply(c.quaternion);
      b.quaternion.copy(this.restQ.get(n)!).multiply(new THREE.Quaternion().slerp(dq, 0.5));
    }
    this.root.updateMatrixWorld(true);
  }
}
