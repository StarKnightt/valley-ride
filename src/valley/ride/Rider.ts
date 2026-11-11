/**
 * The rider: our own model and rig (tools/blender/rider, built into public/assets/rider/rider.glb), and the tack.
 *
 * She was built seated on the horse at rest, and her rig rides on the horse's back bone: Horse.rider is pinned there
 * (at rest it is the model's own frame), so where the saddle goes she goes, and nothing can drift. Her clip "ride" is
 * one gallop stride long, like the horse's, and plays at the horse's stride phase with the same weight as the gallop:
 * her pelvis goes with the back, her feet stay in the irons, her hands follow the bit, her trunk and head take back
 * part of the back's pitch (tools/blender/rider/rider_rig.py, where the clearance to the horse and the tack is checked
 * over the whole stride).
 *
 * On top of the clip: springs on the ponytail and the top's hem, chasing where the clip puts them in the horse's frame
 * (the stride's bounce and pitch drive them; speed streams the ponytail back).
 *
 * She is alive on top of that (alive(), each frame after the clip): she breathes, blinks at random every few
 * seconds, squints when she faces a low sun, smiles a little now and then, and turns her head to look at the valley.
 * The face's three shapes (blink, squint, smile) are morph targets made in tools/blender/rider/rider_rig.py.
 *
 * Standing still she sits up out of the gallop seat and lives a little more: looks out at the valley, glances down at
 * the horse, now and then pats its neck (the right rein passed to her left fist) or slides a hand along the reins to
 * take them up; her hands stay on the reins through all of it by two-bone IK on each arm, and the wind moves her
 * ponytail.
 *
 * The tack (saddle, pad, girth, bridle) comes on a copy of the horse's skeleton and is rebound to the horse's own
 * bones by name.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { loadGLTF } from '../core/Assets';
import { sunLit } from '../core/lighting';
import { Q } from '../core/quality';
import { cameraPosition, clamp, dFdx, dFdy, dot, float, normalize, normalWorld, positionWorld, pow, smoothstep, texture, uv, vec3 } from '../core/tsl';
import { atmo } from '../sky/Atmosphere';
import { glbU } from '../veg/glb';
import { wetness } from '../world/weatherUniforms';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { normalViewGeometry } = TSLTyped as any;

const wrap = (x: number) => x - Math.floor(x);
const SKIN_SCATTER = 0.10;

type Spring = { k: number; zeta: number; maxDeg: number; stream: number; lift: number; wind?: number };
const SPRINGS: Record<string, { bones: string[] } & Spring> = {
  // ~3.2 Hz against a 2.4 Hz stride: it swings and lags the head's bounce without running away
  // (it trails back and down behind her and swings with each stride; it does not stand out stiff)
  pony: { bones: ['pony1', 'pony2', 'pony3', 'pony4'], k: 300, zeta: 0.24, maxDeg: 46, stream: 0.2, lift: 0, wind: 0.22 },
  hem: { bones: ['hemF', 'hemB'], k: 900, zeta: 0.45, maxDeg: 9, stream: 0.08, lift: 0 },
};

type Arm = { up: THREE.Bone; fo: THREE.Bone; hand: THREE.Bone; at: THREE.Vector3; q: THREE.Quaternion; want: THREE.Vector3 };
const q5 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (10 - 15 * x + 6 * x * x));

type SpringBone ={ bone: THREE.Bone; rest: THREE.Quaternion; tail: THREE.Vector3; p: THREE.Vector3; v: THREE.Vector3; cfg: Spring; ready: boolean };

export class Rider {
  /** the rider's whole model (her rig, body, hair, stirrups), inside Horse.rider */
  readonly model = new THREE.Group();
  /** where her fists close on the reins (the reins end here) */
  gripL: THREE.Object3D | null = null;
  gripR: THREE.Object3D | null = null;
  private mixer!: THREE.AnimationMixer;
  private ride!: THREE.AnimationAction;
  private springs: SpringBone[] = [];
  // ---- her own life: the bones it turns (with their rest), her face's morph targets, and where each is in its cycle
  private life: { bone: THREE.Bone; rest: THREE.Quaternion }[] = [];
  private lifeBone: Record<string, THREE.Bone> = {};
  private faces: THREE.Mesh[] = [];
  private t = Math.random() * 10;
  private blinkAt = 2;
  private blink = 0;
  private look = { yaw: 0, want: 0, until: 3, pitch: 0 };
  private lookPitch = 0;
  private smile = 0.15;
  private squint = 0;
  private v = new THREE.Vector3();
  // ---- at rest: sitting up, the arms on IK, what her hands are doing
  /** what the clip last wrote to the bones the layers turn (the mixer skips unchanged values: Horse.clipQ) */
  private clipQ = new Map<THREE.Bone, THREE.Quaternion>();
  private arm = {} as Record<'L' | 'R', Arm>;
  private upright = 0;
  private act: { kind: 'pat' | 'adjust'; t: number; dur: number } | null = null;
  private actIn = 6 + Math.random() * 5;
  /** 0..1: how much of the right rein is in her left fist (while her right hand pats the neck) */
  reinTransfer = 0;
  private gust = 0;
  private gustV = 0;
  private wq = new THREE.Quaternion();
  private wv = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private ikv = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private ikq = [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()];

  /**
   * group: Horse.rider (pinned to the back bone, at rest in the model's own frame at `seat`); horseModel: the horse's
   * glTF scene; horseBones: its bones by name
   */
  async load(group: THREE.Object3D, seat: THREE.Vector3Like, horseModel: THREE.Object3D, horseBones: Map<string, THREE.Bone>) {
    const gltf = await loadGLTF('assets/rider/rider.glb');
    const scene = gltf.scene;
    const tack: THREE.SkinnedMesh[] = [];
    const bones = new Map<string, THREE.Bone>();
    let tris = 0;
    scene.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isMesh) {
        m.castShadow = m.receiveShadow = true;
        m.frustumCulled = false; // (the bound is the rest pose's)
        const mat = sunLit(m.material as THREE.MeshStandardNodeMaterial);
        // the baked occlusion is the ORM texture's red channel (it dims ambient light only, as it should)
        if ((mat.name === 'rider_skin' || mat.name === 'rider_cloth') && mat.roughnessMap) mat.aoMap = mat.roughnessMap;
        if (mat.name === 'rider_cloth' && mat.map) {
          // her top: the same cut, in a deep forest green that never reads as skin in any light. The top is the
          // texture's pale, unsaturated cloth (the breeches are denim blue, the boots near black): that part takes
          // the green, keeping the knit's own shading
          const c = texture(mat.map, uv()).rgb;
          const lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
          const sat = c.x.max(c.y).max(c.z).sub(c.x.min(c.y).min(c.z));
          const topK = smoothstep(0.12, 0.3, lum).mul(float(1).sub(smoothstep(0.05, 0.12, sat)));
          mat.colorNode = TSLTyped.mix(c, vec3(0.018, 0.05, 0.026).mul(lum.div(0.5).sqrt()), topK);
        }
        if (mat.name === 'rider_lash') {
          mat.side = THREE.DoubleSide;
          mat.alphaTest = 0.4;
          mat.alphaToCoverage = Q.msaa > 1;
          m.castShadow = false;
        }
        if (mat.name === 'rider_skin' && mat.map) {
          // light in skin: it is not a hard surface - sunlight scatters under it and comes out past the shadow's
          // edge, redder. Without it the turn from light to shade is a hard line and her eye sockets are black
          // under a high sun. A wrapped diffuse term over what the lit one gives, tinted (no subsurface pass here)
          const L = normalize(atmo.sunDir);
          const ndl = dot(normalWorld, L);
          const wrap = clamp(ndl.add(0.55).div(1.55), 0, 1).sub(clamp(ndl, 0, 1)).max(0);
          const day = smoothstep(-0.05, 0.15, L.y);
          mat.emissiveNode = texture(mat.map, uv()).rgb.mul(vec3(glbU.sunColor)).mul(vec3(1.0, 0.5, 0.36)).mul(wrap.mul(day).mul(SKIN_SCATTER));
        }
        if (mat.name === 'rider_hair') {
          // hair cards: strands on alpha, seen from both sides. Their normals point out of the head and the
          // ponytail's bundle (tools/blender/rider/rider_hair.py) and are used as they are on both faces, so a card
          // seen from behind is lit like the hair it is part of; alpha to coverage under MSAA gives strand edges
          mat.side = THREE.DoubleSide;
          mat.alphaTest = 0.36;
          mat.alphaToCoverage = Q.msaa > 1;
          mat.normalNode = normalViewGeometry;
          // a hair's own highlight: light glances off a strand in a cone about its length, so the sun lays a soft
          // band across the hair where the strands lie square to the half-way direction (Kajiya and Kay), not a
          // round glint - it is what makes cards read as hair. The strand's direction is the cards' v (from the
          // screen-space change of position against that of uv)
          const L = normalize(atmo.sunDir);
          const along = normalize(dFdx(positionWorld).mul(dFdy(uv().y)).sub(dFdy(positionWorld).mul(dFdx(uv().y))));
          const half = normalize(L.add(normalize(cameraPosition.sub(positionWorld))));
          const th = dot(along, half);
          const band = pow(clamp(float(1).sub(th.mul(th)), 0, 1), 30);
          const lit = clamp(dot(normalWorld, L).mul(0.65).add(0.35), 0, 1).mul(smoothstep(-0.05, 0.15, L.y));
          mat.emissiveNode = vec3(glbU.sunColor).mul(vec3(1.0, 0.88, 0.66)).mul(band.mul(lit).mul(0.045));
          m.castShadow = false;       // (a card's shadow is a slab's, on her own neck)
        }
        tris += (m.geometry.index?.count ?? m.geometry.attributes.position.count) / 3;
        // the tack's parts (one per material) are skinned to the horse's skeleton's copy
        if ((m as THREE.SkinnedMesh).isSkinnedMesh && m.skeleton.bones.some((b) => b.name === 'pelvis')) tack.push(m);
      }
      if ((o as THREE.Bone).isBone) bones.set(o.name, o as THREE.Bone);
    });
    if (!tack.length) throw new Error('rider.glb has no tack on the horse skeleton copy');
    // ---- the tack onto the horse's own skeleton (same bone names, same rest): attached mode cancels the mesh's own
    // matrix, so its vertices follow the horse's bones from the model's rest frame
    const copyRoot = tack[0].skeleton.bones[0];
    for (const t of tack) {
      const sk = t.skeleton;
      const mapped = sk.bones.map((b) => {
        // (the loader suffixes names her rig shares with the horse's skeleton: chest -> chest_1)
        const hb = horseBones.get(b.name) ?? horseBones.get(b.name.replace(/_\d+$/, ''));
        if (!hb) throw new Error(`the tack is skinned to ${b.name}, which the horse does not have`);
        return hb;
      });
      t.bind(new THREE.Skeleton(mapped, sk.boneInverses.map((m) => m.clone())), new THREE.Matrix4());
      t.removeFromParent();
      horseModel.add(t);
    }
    // (the copy of the horse's skeleton is not needed any more)
    let top: THREE.Object3D = copyRoot;
    while (top.parent && top.parent !== scene) top = top.parent;
    top.removeFromParent();
    // ---- her: in the horse model's frame, carried by the back bone
    this.model.add(scene);
    this.model.position.set(-seat.x, -seat.y, -seat.z);
    group.add(this.model);
    const clip = gltf.animations.find((a) => a.name === 'ride');
    if (!clip) throw new Error('rider.glb has no ride clip');
    // the springs own the ponytail and the hem: no clip tracks on them
    const sprung = new Set(Object.values(SPRINGS).flatMap((s) => s.bones));
    clip.tracks = clip.tracks.filter((tr) => !sprung.has(tr.name.split('.')[0]));
    this.mixer = new THREE.AnimationMixer(scene);
    this.ride = this.mixer.clipAction(clip);
    this.ride.setLoop(THREE.LoopRepeat, Infinity);
    this.ride.play();
    for (const name of ['spine2', 'chest', 'neck', 'head', 'clavL', 'clavR']) {
      const b = bones.get(name);
      if (!b) throw new Error(`rider.glb has no bone ${name}`);
      this.life.push({ bone: b, rest: b.quaternion.clone() });
      this.lifeBone[name] = b;
    }
    const sp1 = bones.get('spine1');
    if (!sp1) throw new Error('rider.glb has no bone spine1');
    this.lifeBone.spine1 = sp1;
    for (const sd of ['L', 'R'] as const) {
      const g = (n: string) => { const b = bones.get(n + sd); if (!b) throw new Error(`rider.glb has no bone ${n}${sd}`); return b; };
      this.arm[sd] = { up: g('upperarm'), fo: g('forearm'), hand: g('hand'), at: new THREE.Vector3(), q: new THREE.Quaternion(), want: new THREE.Vector3() };
    }
    for (const b of [...Object.values(this.lifeBone), ...Object.values(this.arm).flatMap((a) => [a.up, a.fo, a.hand])]) this.clipQ.set(b, b.quaternion.clone());
    scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.morphTargetDictionary && 'blink' in m.morphTargetDictionary) this.faces.push(m); });
    if (!this.faces.length) throw new Error('rider.glb has no face morph targets (blink, squint, smile)');
    this.gripL = bones.get('gripL') ?? null;
    this.gripR = bones.get('gripR') ?? null;
    if (!this.gripL || !this.gripR) throw new Error('rider.glb has no grip bones');
    for (const cfg of Object.values(SPRINGS)) {
      let len = 0.08;
      for (const name of cfg.bones) {
        const b = bones.get(name);
        if (!b) throw new Error(`rider.glb has no bone ${name}`);
        const child = b.children.find((c) => (c as THREE.Bone).isBone) as THREE.Bone | undefined;
        if (child) len = child.position.length();
        this.springs.push({ bone: b, rest: b.quaternion.clone(), tail: new THREE.Vector3(0, len, 0), p: new THREE.Vector3(), v: new THREE.Vector3(), cfg, ready: false });
      }
    }
    console.info(`[rider] our model: ${tris} triangles (with the tack), ${bones.size} bones; clip "ride" ${clip.duration.toFixed(3)} s = one stride`);
  }

  /** the clip at the horse's stride phase, weighted like the horse's gallop */
  pose(phase: number, w: number) {
    if (!this.mixer) return;
    this.ride.time = wrap(phase) * this.ride.getClip().duration;
    this.ride.setEffectiveWeight(w);
    // (alive() and the arms' IK turn these on top of the clip: back to what the clip last wrote before it runs again)
    for (const [b, q] of this.clipQ) b.quaternion.copy(q);
    this.mixer.update(0);
    for (const [b, q] of this.clipQ) q.copy(b.quaternion);
    // (no clip tracks on the sprung bones: back to rest, so step() turns them from where the clip carries them)
    for (const s of this.springs) s.bone.quaternion.copy(s.rest);
  }

  /** how far her right hand is into a pat of the neck, 0..1 */
  private patShare() {
    const a = this.act;
    if (!a || a.kind !== 'pat') return 0;
    return q5(a.t / 0.85) * (1 - q5((a.t - (a.dur - 0.8)) / 0.8));
  }

  /** standing, now and then: a pat on the neck, or the reins taken up a little */
  private actions(dt: number, rest: number) {
    if (this.act) {
      this.act.t += dt;
      if (this.act.t >= this.act.dur) this.act = null;
    } else if (rest > 0.95) {
      this.actIn -= dt;
      if (this.actIn <= 0) {
        this.act = Math.random() < 0.55 ? { kind: 'pat', t: 0, dur: 3.0 + Math.random() * 0.8 } : { kind: 'adjust', t: 0, dur: 1.5 + Math.random() * 0.4 };
        this.actIn = 9 + Math.random() * 12;
      }
    } else this.actIn = Math.max(this.actIn, 3);
    // (moving off ends it: the hand goes back to the reins with the pat's own ease)
    if (this.act && rest < 0.9 && this.act.t < this.act.dur - 0.8) this.act.t = this.act.dur - 0.8;
    // the right rein goes over to her left fist before the right hand leaves it
    this.reinTransfer = Math.min(1, this.patShare() * 4);
  }

  /** the wrists back to where the clip holds them on the reins (or patting, or taking the reins up), by IK */
  private hands(frame: THREE.Object3D, patAt: THREE.Object3D | null) {
    const [fwd, up, left, g] = this.wv;
    this.model.updateMatrixWorld(true);
    frame.getWorldQuaternion(this.wq);
    fwd.set(0, 0, 1).applyQuaternion(this.wq); up.set(0, 1, 0).applyQuaternion(this.wq); left.set(1, 0, 0).applyQuaternion(this.wq);
    const R = this.arm.R, L = this.arm.L, a = this.act;
    // sitting up, her hands come back and up off the forward seat's long reach, over the withers (the reins let out)
    const u = this.upright;
    R.want.copy(R.at).addScaledVector(fwd, -0.13 * u).addScaledVector(up, 0.04 * u);
    L.want.copy(L.at).addScaledVector(fwd, -0.13 * u).addScaledVector(up, 0.04 * u);
    if (a?.kind === 'adjust') {
      // the left hand slides forward along the reins and closes again; the right comes in to meet it
      const s = Math.sin(Math.PI * Math.min(1, a.t / a.dur)) ** 2;
      L.want.addScaledVector(fwd, 0.07 * s).addScaledVector(up, 0.015 * s);
      R.want.addScaledVector(left, 0.035 * s).addScaledVector(fwd, 0.02 * s);
    }
    const p = this.patShare();
    if (a && p > 0 && patAt) {
      // the right hand onto the crest of the neck: a few soft pats
      patAt.getWorldPosition(g).addScaledVector(up, 0.07).addScaledVector(fwd, -0.05).addScaledVector(left, -0.02);
      const on = a.t > 0.85 && a.t < a.dur - 0.8 ? 1 : 0;
      g.addScaledVector(up, 0.035 * on * Math.max(0, Math.sin((a.t - 0.85) * Math.PI * 2 * 1.6)));
      R.want.lerp(g, p);
      // (the left fist, holding both reins now, comes a little toward the middle)
      L.want.addScaledVector(left, -0.03 * p);
    }
    this.ik(L);
    this.ik(R);
  }

  /** two bones, shoulder to wrist: the elbow stays in the plane it bends in now; the fist keeps the clip's turn */
  private ik(a: Arm) {
    const [A, Bp, C, T, n, elbow, wrist] = this.ikv;
    a.up.getWorldPosition(A); a.fo.getWorldPosition(Bp); a.hand.getWorldPosition(C);
    if (C.distanceToSquared(a.want) < 1e-8) return;
    const l1 = Bp.distanceTo(A), l2 = C.distanceTo(Bp);
    T.copy(a.want).sub(A);
    const dl = THREE.MathUtils.clamp(T.length(), Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
    T.normalize();
    n.copy(Bp).sub(A);
    n.addScaledVector(T, -n.dot(T));
    if (n.lengthSq() < 1e-10) return;
    n.normalize();
    const cosA = (l1 * l1 + dl * dl - l2 * l2) / (2 * l1 * dl), sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    elbow.copy(A).addScaledVector(T, l1 * cosA).addScaledVector(n, l1 * sinA);
    wrist.copy(A).addScaledVector(T, dl);
    const [q, wq, pq] = this.ikq;
    const turnTo = (b: THREE.Bone, from: THREE.Vector3, to: THREE.Vector3) => {
      q.setFromUnitVectors(from.normalize(), to.normalize());
      b.getWorldQuaternion(wq).premultiply(q);
      b.parent!.getWorldQuaternion(pq).invert();
      b.quaternion.copy(pq.multiply(wq));
      b.updateMatrixWorld(true);
    };
    turnTo(a.up, Bp.sub(A), C.copy(elbow).sub(A));
    a.hand.getWorldPosition(C);
    turnTo(a.fo, C.sub(elbow), Bp.copy(wrist).sub(elbow));
    a.fo.getWorldQuaternion(wq).invert();
    a.hand.quaternion.copy(wq.multiply(a.q));
    a.hand.updateMatrixWorld(true);
  }

  /**
   * Her own life, on top of the clip (her bones point along their own +y with z across her: a turn about y is a
   * look to the side, about z a nod).
   */
  private alive(dt: number, frame: THREE.Object3D, effort: number, rest: number) {
    this.t += dt;
    const B = this.lifeBone;
    // standing: up out of the forward seat, the eyes kept level (+z folds her forward); leaning in to pat the neck
    this.upright += (rest - this.upright) * (1 - Math.exp(-dt * 1.8));
    const u = this.upright, lean = this.patShare() * 0.16;
    B.spine1.rotateZ(-0.12 * u + lean * 0.3);
    B.spine2.rotateZ(-0.11 * u + lean * 0.4);
    B.chest.rotateZ(-0.10 * u + lean * 0.3);
    B.neck.rotateZ(0.15 * u - lean * 0.4);
    B.head.rotateZ(0.12 * u - lean * 0.4);
    // breathing: the chest lifts and the shoulders with it, faster and deeper the harder she rides
    const breath = Math.sin(this.t * Math.PI * 2 / (3.4 - 1.6 * effort));
    const deep = 0.010 + 0.012 * effort;
    B.spine2.rotateZ(-deep * 0.5 * breath);
    B.chest.rotateZ(deep * breath);
    B.clavL.rotateX(deep * 0.8 * breath);
    B.clavR.rotateX(deep * 0.8 * breath);
    // looking about: mostly ahead; every few seconds a look to one side at the valley, held, then back
    // standing she looks further and longer, out over the valley, and now and then down at the horse
    const L = this.look;
    if (this.t > L.until) {
      const away = L.want === 0 && L.pitch === 0 && Math.random() < 0.6 + 0.2 * rest;
      const down = away && rest > 0.8 && Math.random() < 0.3;
      L.want = down ? (Math.random() < 0.5 ? -1 : 1) * (0.1 + 0.2 * Math.random()) : away ? (Math.random() < 0.5 ? -1 : 1) * (0.35 + (0.4 + 0.45 * rest) * Math.random()) : 0;
      L.pitch = down ? 0.3 + 0.15 * Math.random() : away ? -0.06 + 0.1 * Math.random() : 0;
      L.until = this.t + (down ? 1.2 + 1.2 * Math.random() : away ? 1.8 + (1.6 + 2.5 * rest) * Math.random() : 3 + 5 * Math.random());
    }
    // (patting the neck she watches her hand: down and to the right)
    const pat = this.patShare();
    const wantYaw = L.want * (1 - pat) - 0.3 * pat, wantPitch = L.pitch * (1 - pat) + 0.38 * pat;
    L.yaw += (wantYaw - L.yaw) * (1 - Math.exp(-dt * 3.2));
    this.lookPitch += (wantPitch - this.lookPitch) * (1 - Math.exp(-dt * 3));
    const nod = 0.012 * Math.sin(this.t * 0.9) + this.lookPitch;
    B.neck.rotateY(L.yaw * 0.45);
    B.head.rotateY(L.yaw * 0.55);
    B.neck.rotateZ(nod * 0.45);
    B.head.rotateZ(nod * 0.55);
    // blinking: every 2-6 s, 0.15 s shut and open; a look to the side often starts with one
    if (this.t > this.blinkAt) { this.blink = 0.16; this.blinkAt = this.t + 2 + 4 * Math.random(); }
    this.blink = Math.max(0, this.blink - dt);
    const lid = this.blink > 0 ? Math.sin(Math.PI * (1 - this.blink / 0.16)) : 0;
    // squinting into a low sun she is facing; a slight smile that comes and goes, more when she looks at the valley
    const sun = atmo.sunDir.value as THREE.Vector3;
    const fwd = this.v.set(0, 0, 1).transformDirection(frame.matrixWorld).applyAxisAngle(THREE.Object3D.DEFAULT_UP, L.yaw);
    const facing = Math.max(0, fwd.x * sun.x + fwd.z * sun.z) * Math.max(0, 1 - Math.abs(sun.y - 0.25) / 0.6);
    this.squint += (0.10 + 0.5 * facing - this.squint) * (1 - Math.exp(-dt * 2));
    const glad = 0.14 + 0.16 * (0.5 + 0.5 * Math.sin(this.t * 0.31)) + 0.3 * Math.min(1, Math.abs(L.yaw) / 0.4);
    this.smile += (glad - this.smile) * (1 - Math.exp(-dt * 1.5));
    for (const m of this.faces) {
      const d = m.morphTargetDictionary!, w = m.morphTargetInfluences!;
      w[d.blink] = lid;
      w[d.squint] = this.squint * (1 - lid);
      w[d.smile] = this.smile;
    }
  }

  /** the ponytail and hem springs, after pose(); frame: the horse's root (its own frame, heading and all) */
  step(dt: number, frame: THREE.Object3D, speedShare: number, still: boolean, rest = 0, patAt: THREE.Object3D | null = null) {
    if (!this.springs.length) return;
    if (still || dt <= 0) { for (const s of this.springs) s.ready = false; return; }
    const h1 = Math.min(dt, 0.1);
    // where the clip holds her wrists (on the reins), before anything turns her trunk
    for (const a of Object.values(this.arm)) { a.hand.getWorldPosition(a.at); a.hand.getWorldQuaternion(a.q); }
    this.actions(h1, rest);
    this.alive(h1, frame, speedShare, rest);
    this.hands(frame, patAt);
    // the wind in her ponytail, gusting, in the horse's frame
    // (smooth gusts: three slow waves that never line up)
    this.gustV += h1;
    this.gust = 0.5 * Math.sin(this.gustV * 0.71) + 0.3 * Math.sin(this.gustV * 1.93 + 1.1) + 0.2 * Math.sin(this.gustV * 3.7 + 2.3);
    const wd = wetness.windDir.value as THREE.Vector2, ws = wetness.wind.value as number;
    const windL = this.wv[4].set(wd.x, 0, wd.y).applyQuaternion(frame.getWorldQuaternion(this.wq).invert()).multiplyScalar(ws * (0.6 + 0.6 * this.gust));
    const inv = frame.matrixWorld.clone().invert();
    const fq = frame.getWorldQuaternion(new THREE.Quaternion());
    const head = new THREE.Vector3(), want = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
    const pq = new THREE.Quaternion(), bq = new THREE.Quaternion(), turn = new THREE.Quaternion();
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = Math.min(dt, 0.1) / steps;
    for (const s of this.springs) {
      const { bone, cfg } = s;
      bone.updateWorldMatrix(true, false);
      head.setFromMatrixPosition(bone.matrixWorld).applyMatrix4(inv);
      want.copy(s.tail).applyMatrix4(bone.matrixWorld).applyMatrix4(inv);
      const len = s.tail.length();
      want.z -= cfg.stream * speedShare * len;      // (the horse's frame: +z forward)
      want.y += cfg.lift * speedShare * len;
      if (cfg.wind) want.addScaledVector(windL, cfg.wind * len);
      if (!s.ready) { s.p.copy(want); s.v.set(0, 0, 0); s.ready = true; }
      // (standing, the ponytail settles: more damping than the gallop's lively swing)
      const c = 2 * (cfg.zeta + 0.3 * this.upright) * Math.sqrt(cfg.k);
      for (let i = 0; i < steps; i++) {
        a.copy(want).sub(s.p).multiplyScalar(cfg.k).addScaledVector(s.v, -c);
        s.v.addScaledVector(a, h);
        s.p.addScaledVector(s.v, h);
        b.copy(s.p).sub(head).setLength(len);
        s.p.copy(head).add(b);
      }
      a.copy(want).sub(head).normalize();
      b.copy(s.p).sub(head).normalize();
      turn.setFromUnitVectors(a, b);
      const ang = 2 * Math.acos(Math.min(1, Math.abs(turn.w)));
      const max = THREE.MathUtils.degToRad(cfg.maxDeg);
      if (ang > max) turn.slerp(pq.identity(), 1 - max / ang);
      turn.premultiply(fq).multiply(fq.clone().invert());
      bone.parent!.getWorldQuaternion(pq);
      bone.getWorldQuaternion(bq);
      bone.quaternion.copy(pq.invert().multiply(turn).multiply(bq));
      bone.updateMatrixWorld(true);
    }
  }
}
