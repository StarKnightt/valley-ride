/**
 * The horse: our own model and rig (tools/blender/horse, built into public/assets/horse/horse.glb), and its gallop,
 * authored against Muybridge's plate (tools/gait/design-gallop.ts, GALLOP-TEST.md).
 *
 * The gallop clip is one stride long and its time is the stride phase, so the gait is driven by distance: the phase
 * advances by ground speed / stride length, and a planted hoof stays planted at any speed. Only the gallop exists
 * so far (walk, trot and canter are Round 4): below gallop speed the same cycle plays at the slower phase rate, and
 * near a standstill it fades to the standing pose.
 *
 * The rider (Rider.ts) sits in Horse.rider, pinned to the back bone; her clip plays at the same stride phase.
 */
import * as THREE from 'three/webgpu';
import { loadGLTF } from '../core/Assets';
import { sunLit } from '../core/lighting';
import { float, max, texture, uv, vec3 } from '../core/tsl';
import { Rider } from './Rider';
import { HorseIdle } from './HorseIdle';

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
/** samples per stride of the gallop for the blend into the standing pose (the clip's own key count) */
const BLEND_KEYS = 240;

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
  /** the rider herself (her model, clip and springs), inside rider */
  readonly person = new Rider();
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
  /** standing still: breath, ears, tail, head, a resting hind leg (HorseIdle) */
  private idle!: HorseIdle;
  /** what the clip last wrote to each bone: the mixer skips a bone whose value has not changed since the frame before,
   *  so the layers turned on top (idle, hair springs, nod) are taken off again before it runs */
  private clipQ = new Map<THREE.Bone, THREE.Quaternion>();
  private blend: { bone: THREE.Bone; rest: THREE.Quaternion; axis: THREE.Vector3; theta: Float32Array }[] = [];
  private chestBone!: THREE.Bone;
  private chestTrack!: Float32Array;
  private clipP = new THREE.Vector3();
  /** how still the horse is: 0 moving .. 1 standing */
  stillness = 1;
  /** a point on the crest of the neck in front of the withers, on its right: where she pats it */
  readonly patR = new THREE.Object3D();

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
        const mat = sunLit(m.material as THREE.MeshStandardNodeMaterial);
        if (mat.name === 'horse' && mat.map) {
          // a deep red-brown bay in every light: the baked coat is a mid brown that a low sun pushed to orange, and its
          // sheen read as plastic. Darker and redder in the albedo (the black points stay black), and a satin coat
          // rather than a gloss
          mat.colorNode = texture(mat.map, uv()).rgb.mul(vec3(0.44, 0.3, 0.3));
          if (mat.roughnessMap) mat.roughnessNode = max(texture(mat.roughnessMap, uv()).g, float(0.62));
        }
        if (mat.name === 'horse_hair' && mat.map) {
          // the mane and tail: black, and a little fuller at the cut
          mat.colorNode = texture(mat.map, uv()).rgb.mul(0.35);
          mat.alphaTest = 0.3;
        }
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
    // the rider's frame: on the back bone, at rest the model's own frame moved to the seat
    pin(this.rider, 'back', { x: 0, y: w[1] - 0.06, z: w[2] - 0.42 });
    this.rider.quaternion.copy(bone('back').getWorldQuaternion(this.q).invert());

    const clip = gltf.animations.find((a) => a.name === 'gallop');
    if (!clip) throw new Error('horse.glb has no gallop clip');
    this.mixer = new THREE.AnimationMixer(model);
    this.gallop = this.mixer.clipAction(clip);
    this.gallop.setLoop(THREE.LoopRepeat, Infinity);
    this.gallop.play();
    // the gallop sampled once per bone as its lateral angle off rest, unwrapped round the stride (pose(): the blend
    // into the standing pose). Every bone of this rig turns about the lateral axis only
    this.chestBone = bone('chest');
    this.chestTrack = new Float32Array(BLEND_KEYS * 3);
    const samples = new Map<THREE.Bone, THREE.Quaternion[]>();
    for (let k = 0; k < BLEND_KEYS; k++) {
      this.gallop.time = (k / BLEND_KEYS) * clip.duration;
      this.mixer.update(0);
      for (const b of this.bones.values()) { if (!samples.has(b)) samples.set(b, []); samples.get(b)!.push(b.quaternion.clone()); }
      this.chestBone.position.toArray(this.chestTrack, k * 3);
    }
    for (const [b, qs] of samples) {
      const rest = this.restQ.get(b.name)!, ri = rest.clone().invert();
      const d = qs.map((q) => ri.clone().multiply(q));
      const big = d.reduce((m, x) => (1 - Math.abs(x.w) > 1 - Math.abs(m.w) ? x : m), d[0]);
      const axis = new THREE.Vector3(big.x, big.y, big.z);
      if (axis.lengthSq() < 1e-10) continue;
      axis.normalize();
      const raw = d.map((x) => 2 * Math.atan2(x.x * axis.x + x.y * axis.y + x.z * axis.z, x.w));
      // (anchored where the bone is nearest rest, unwrapped from there round the stride)
      let k0 = 0;
      raw.forEach((v, k) => { if (Math.abs(Math.atan2(Math.sin(v), Math.cos(v))) < Math.abs(Math.atan2(Math.sin(raw[k0]), Math.cos(raw[k0])))) k0 = k; });
      const theta = new Float32Array(BLEND_KEYS);
      let prev = Math.atan2(Math.sin(raw[k0]), Math.cos(raw[k0]));
      for (let s = 0; s < BLEND_KEYS; s++) {
        const k = (k0 + s) % BLEND_KEYS;
        prev += Math.atan2(Math.sin(raw[k] - prev), Math.cos(raw[k] - prev));
        theta[k] = prev;
      }
      this.blend.push({ bone: b, rest, axis, theta });
    }
    for (const b of this.bones.values()) { b.quaternion.copy(this.restQ.get(b.name)!); b.position.copy(this.restP.get(b.name)!); }
    this.clipP = this.restP.get('chest')!.clone();
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
    // standing still: the idle layers (the breath morph, the resting hind legs solved at rest)
    let body: THREE.SkinnedMesh | null = null;
    model.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh && o.name === 'horse') body = o as THREE.SkinnedMesh; });
    if (!body) throw new Error('horse.glb has no body mesh "horse"');
    this.idle = new HorseIdle(this.root, this.bones);
    model.traverse((o) => { const sm = o as THREE.SkinnedMesh; if (sm.isSkinnedMesh && (sm.material as THREE.Material).name === 'horse_hair') mirrorMane(sm, this.root); });
    this.idle.setup(body, meta.markers, (leg) => this.hooves[leg].getWorldPosition(new THREE.Vector3()).applyMatrix4(this.root.matrixWorld.clone().invert()));
    for (const b of this.bones.values()) this.clipQ.set(b, b.quaternion.clone());
    pin(this.patR, 'neck1', { x: -0.085, y: w[1] + 0.06, z: w[2] + 0.17 });
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
    // the rider last: her rig sits inside the horse's model (on the back bone) and shares bone names with it (head,
    // neck, chest), so the horse's clip has to be bound to its own bones before hers are in the tree
    await this.person.load(this.rider, { x: 0, y: w[1] - 0.06, z: w[2] - 0.42 }, model, this.bones);
    this.halfLen = (mz[2] - meta.markers.buttock.at[2]) / 2 - 0.25;
    this.halfWidth = 0.3;
    this.pose(0, 0);
    console.info(`[horse] our model: ${tris} triangles, ${this.bones.size} bones; gallop stride ${meta.stride.toFixed(2)} m, ${meta.keysPerStride} keys, lead ${meta.lead}`);
  }

  /** the rig at a stride phase, the gallop weighted w (the rest is the standing pose) */
  private pose(phase: number, w: number) {
    this.gallop.time = wrap(phase) * this.gallop.getClip().duration;
    this.gallop.setEffectiveWeight(1);
    for (const [b, q] of this.clipQ) b.quaternion.copy(q);
    this.chestBone.position.copy(this.clipP);
    this.mixer.update(0);
    // below full weight the blend toward the standing pose is taken on each bone's own lateral angle, not by the
    // mixer: a hoof turns up to ~190 degrees off rest in the stride, and the mixer's shortest-way blend would flip it
    if (w < 1) {
      const x = wrap(phase) * BLEND_KEYS, i = Math.floor(x) % BLEND_KEYS, f = x - Math.floor(x), j = (i + 1) % BLEND_KEYS;
      for (const bl of this.blend) {
        const th = bl.theta[i] + (bl.theta[j] - bl.theta[i]) * f;
        bl.bone.quaternion.copy(bl.rest).multiply(this.q.setFromAxisAngle(bl.axis, th * w));
      }
      const c = this.chestBone.position, R = this.restP.get(this.chestBone.name)!;
      c.set(this.chestTrack[i * 3] + (this.chestTrack[j * 3] - this.chestTrack[i * 3]) * f, this.chestTrack[i * 3 + 1] + (this.chestTrack[j * 3 + 1] - this.chestTrack[i * 3 + 1]) * f, this.chestTrack[i * 3 + 2] + (this.chestTrack[j * 3 + 2] - this.chestTrack[i * 3 + 2]) * f);
      c.lerpVectors(R, c, w);
    }
    for (const [b, q] of this.clipQ) q.copy(b.quaternion);
    this.clipP.copy(this.chestBone.position);
    if (this.headNod && this.head) this.head.quaternion.multiply(this.q.setFromAxisAngle(this.v.set(1, 0, 0), this.headNod));
    this.person.pose(phase, w);
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
    // the gallop's cycle slows with the speed (a planted hoof stays planted) and blends into the standing pose as it
    // does, so by the time the cycle is slow the horse is mostly standing; the idle layers come in under a walk
    const move = THREE.MathUtils.smoothstep(this.speed, 0.15, 3.2);
    this.stillness = 1 - THREE.MathUtils.smoothstep(this.speed, 0.05, 2.2);
    this.phase = wrap(this.phase + (this.speed / GAIT.strideGallop) * dt * (this.air ? 0.35 : 1));
    const k = 1 - Math.exp(-dt * 6);
    this.pitch += (groundPitch - this.pitch) * k;
    this.roll += (groundRoll - this.roll) * k;
    this.root.rotation.set(0, this.heading, 0);
    this.body.position.y = this.lift;
    this.body.rotation.set(this.pitch + this.jumpPitch, 0, this.roll, 'YXZ');
    this.pose(this.phase, move);
    this.idle.step(dt, this.air ? 0 : this.stillness, Math.min(1, this.speed / GAIT.gallop));
    this.snort = this.idle.snorted;
    this.root.updateMatrixWorld(true);
    this.hairStep(dt);
    this.person.step(dt, this.root, Math.min(1, this.speed / GAIT.gallop), this.hairStill, this.air ? 0 : this.stillness, this.patR);
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
    this.person.step(0, this.root, 0, true, 0, this.patR);
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

/**
 * The mane's cards all lie down the off (right) side of the neck, so from the near side the horse showed only a thin
 * line on its crest. A copy of every mane card mirrored across the neck's midplane (the horse is symmetric about
 * x = 0 at rest) puts the black mane on both sides. Same bones and weights, so it moves with the neck and the mane
 * springs. The geometry is quantized: positions reach metres only through the skin, so each vertex goes through its
 * own blend of its bones' rest matrices, is mirrored there, and comes back through the inverse.
 */
function mirrorMane(hair: THREE.SkinnedMesh, root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  hair.skeleton.update();
  const g = hair.geometry;
  const bones = hair.skeleton.bones;
  const maneBone = bones.map((b) => /^(mane|neck)/.test(b.name));
  const pre = root.matrixWorld.clone().invert().multiply(hair.matrixWorld).multiply(hair.bindMatrixInverse);
  const boneM = bones.map((b, j) => new THREE.Matrix4().multiplyMatrices(b.matrixWorld, hair.skeleton.boneInverses[j]));
  const si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight'), pos = g.getAttribute('position');
  const n0 = pos.count;
  const isMane = new Uint8Array(n0);
  for (let i = 0; i < n0; i++) {
    let ok = true, any = false;
    for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > 0) { any = true; if (!maneBone[si.getComponent(i, k)]) ok = false; }
    isMane[i] = ok && any ? 1 : 0;
  }
  const idx = g.index!;
  const tris: number[] = [];
  for (let t = 0; t < idx.count; t += 3) {
    const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
    if (isMane[a] && isMane[b] && isMane[c]) tris.push(a, b, c);
  }
  const used = [...new Set(tris)];
  const map = new Map(used.map((v, k) => [v, n0 + k]));
  const n1 = n0 + used.length;
  // every attribute as plain floats (getComponent un-normalizes, which is what the shader sees)
  const out: Record<string, THREE.BufferAttribute> = {};
  for (const [name, a] of Object.entries(g.attributes) as [string, THREE.BufferAttribute][]) {
    const sz = a.itemSize;
    const arr = name === 'skinIndex' ? new Uint16Array(n1 * sz) : new Float32Array(n1 * sz);
    for (let i = 0; i < n0; i++) for (let c = 0; c < sz; c++) arr[i * sz + c] = a.getComponent(i, c);
    for (const [k, v] of used.entries()) for (let c = 0; c < sz; c++) arr[(n0 + k) * sz + c] = a.getComponent(v, c);
    out[name] = new THREE.BufferAttribute(arr, sz);
  }
  const acc = new THREE.Matrix4(), M = new THREE.Matrix4(), Mi = new THREE.Matrix4(), N = new THREE.Matrix3(), Ni = new THREE.Matrix3();
  const p = new THREE.Vector3(), v3 = new THREE.Vector3();
  const P = out.position, Nn = out.normal, T = out.tangent;
  for (const [k, v] of used.entries()) {
    acc.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    for (let q = 0; q < 4; q++) {
      const w = sw.getComponent(v, q);
      if (w > 0) { const e = boneM[si.getComponent(v, q)].elements; for (let x = 0; x < 16; x++) acc.elements[x] += e[x] * w; }
    }
    M.multiplyMatrices(pre, acc).multiply(hair.bindMatrix);
    Mi.copy(M).invert();
    const j = n0 + k;
    p.fromBufferAttribute(P, j).applyMatrix4(M);
    p.x = -p.x;
    p.applyMatrix4(Mi);
    P.setXYZ(j, p.x, p.y, p.z);
    N.getNormalMatrix(M); Ni.copy(N).invert();
    if (Nn) { v3.fromBufferAttribute(Nn, j).applyMatrix3(N); v3.x = -v3.x; v3.applyMatrix3(Ni).normalize(); Nn.setXYZ(j, v3.x, v3.y, v3.z); }
    if (T) {
      v3.set(T.getX(j), T.getY(j), T.getZ(j)).transformDirection(M); v3.x = -v3.x; v3.transformDirection(Mi);
      T.setXYZW(j, v3.x, v3.y, v3.z, -T.getW(j));
    }
  }
  const ng = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(out)) ng.setAttribute(name, a);
  const I: number[] = [];
  for (let t = 0; t < idx.count; t++) I.push(idx.getX(t));
  // (mirrored: the winding turns over)
  for (let t = 0; t < tris.length; t += 3) I.push(map.get(tris[t])!, map.get(tris[t + 2])!, map.get(tris[t + 1])!);
  ng.setIndex(I);
  for (const gr of g.groups) ng.addGroup(gr.start, gr.count, gr.materialIndex);
  if (g.groups.length) ng.addGroup(idx.count, I.length - idx.count, g.groups[0].materialIndex);
  ng.boundingSphere = g.boundingSphere; ng.boundingBox = g.boundingBox;
  hair.geometry = ng;
  g.dispose();
  console.info(`[horse] mane mirrored to the near side: ${tris.length / 3} triangles`);
}
