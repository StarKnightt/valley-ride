/**
 * Riding: the controls, the horse's motion over the ground, the cameras and the small things that make it feel
 * physical (reins, hoof dust, splashes, hoofbeats).
 *
 *   W walk · Shift trot (hold it: gallop) · S rein in / back up · A/D steer in arcs
 *   mouse looks; past the neck's reach the horse turns toward the look
 *   C cinematic camera behind the horse · P photo mode (free camera, UI hidden) · T time of day
 *
 * Momentum: speed eases toward the gait asked for; uphill the horse slows, on a cliff-steep face it stops and won't
 * go on; it wades through shallow water (slower, splashing) and refuses water deeper than its chest. Natural
 * boundaries only: the valley's walls are too steep to climb, the river's gorge too deep to ford.
 */
import { effectMRT } from '../core/fx';
import * as THREE from 'three/webgpu';
import { Fn, attribute, float, vec3, vec4, uv, length, smoothstep, mix, positionView, screenUV, max, abs, sin, fract } from '../core/tsl';
import { particleSky } from '../sky/Atmosphere';
import { sceneViewDepth } from '../core/depth';
import { sunLit } from '../core/lighting';
import type { Heightfield } from '../world/Heightfield';
import { STEP_UP, type Colliders } from '../world/Colliders';
import type { Intent } from '../player/Input';
import { Horse, GAIT, type Footfall } from './Horse';
import type { AudioSystem, Ground } from '../audio/Audio';
import type { Valley } from '../world/Valley';

export type View = 'first' | 'cinematic' | 'photo';

const DEG = Math.PI / 180;
/** how far the rider's head turns from the horse's heading before the horse turns with it */
const LOOK_LIMIT = 105 * DEG;
/** first person: a ~60 degree vertical view (RDR2-REFERENCE.md), opening a little at the gallop */
const FOV = 62;
/** the chase camera's vertical FOV (RDR2's riding camera reads at ~55-60) */
const CINE_FOV = 56;
/** the jump: the gather (s), the take-off's vertical speed (m/s: ~0.85 m of lift, 0.84 s in the air), the absorb (s) */
const CROUCH = 0.17, LIFT = 4.1, LAND = 0.38;

export class Ride {
  readonly horse = new Horse();
  view: View = 'first';
  /** 0..1: how much of the gait's motion reaches the first-person camera (settings slider) */
  bob = 0.6;
  /** look, relative to the heading */
  lookYaw = 0;
  lookPitch = -3.5 * DEG;
  private wantSpeed = 0;
  private shiftHeld = 0;
  private yawRate = 0;
  private refuse = 0;
  private refuseCool = 0;
  private camSmooth = new THREE.Vector3();
  private camVel = new THREE.Vector3();
  readonly cine = { yaw: 0, pitch: 4 * DEG, dist: 5.2, pos: new THREE.Vector3(), ready: false };
  /** the game's end shot: the fire the ride ended at (null: the player's camera). The camera eases round to frame
   * the fire and the horse side by side, looking out past them over the brow to the valley below */
  endFocus: THREE.Vector3 | null = null;
  private endTarget = new THREE.Vector3();
  private endV = new THREE.Vector3();
  private endInit = false;
  private fov = FOV;
  private reins: THREE.Mesh;
  private reinPos: Float32Array;
  private dust: Puffs;
  private eyeW = new THREE.Vector3();
  private fw = new THREE.Vector3();
  private probe = new THREE.Vector3();
  private v = new THREE.Vector3();
  /** autopilot (the bot tour): world waypoints and the gait to ride them at */
  auto: { pts: THREE.Vector2[]; i: number; speed: number; done: boolean; onReach?: (i: number) => void } | null = null;
  inWater = 0;
  private stuck = 0;
  private bestD = 1e9;
  depth = 0;
  slope = 0;
  /** last grounded position, for the harness */
  readonly pos = new THREE.Vector3();
  frozen = false;
  /** the camera belongs to someone else (photo mode, a harness pose): the ride leaves it alone */
  camOff = false;

  constructor(private hf: Heightfield, private colliders: Colliders, private scene: THREE.Scene, private audio: AudioSystem | null, private valley: Valley | null) {
    // reins: leather straps rebuilt each frame - one from each bit ring back along the neck into her fist, and the
    // bight (the spare loop that joins them) from fist to fist, hanging down the horse's off shoulder
    const SEG = 18, SIDES = 4, STRAPS = 3;
    this.reinPos = new Float32Array(STRAPS * (SEG + 1) * SIDES * 3);
    const idx: number[] = [];
    for (let r = 0; r < STRAPS; r++) for (let i = 0; i < SEG; i++) for (let s = 0; s < SIDES; s++) {
      const a = (r * (SEG + 1) + i) * SIDES, b = a + SIDES;
      const s1 = (s + 1) % SIDES;
      idx.push(a + s, b + s, a + s1, a + s1, b + s, b + s1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.reinPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    // (round 16: thin dark leather straps. The mid brown read as orange bars in a low sun, so it is a dark worn
    // leather now, matte with only a little sheen)
    const m = sunLit(new THREE.MeshStandardNodeMaterial({ color: 0x3a2413, roughness: 0.6, side: THREE.DoubleSide }));
    this.reins = new THREE.Mesh(g, m);
    this.reins.frustumCulled = false;
    this.reins.castShadow = true;
    scene.add(this.reins);
    this.dust = new Puffs(scene);
  }

  async load(spawn: { x: number; z: number; yaw: number }) {
    await this.horse.load();
    this.scene.add(this.horse.root);
    this.place(spawn.x, spawn.z, spawn.yaw);
  }

  place(x: number, z: number, yaw: number) {
    this.endFocus = null;
    this.endInit = false;
    this.cine.yaw = 0;
    this.cine.pitch = 4 * DEG;
    this.cine.dist = 5.2;
    this.horse.heading = yaw;
    this.horse.speed = 0;
    this.wantSpeed = 0;
    this.pos.set(x, this.hf.height(x, z), z);
    this.prevPos.copy(this.pos);
    this.hd = this.prevHd = yaw;
    this.jump = null;
    this.acc = 0;
    this.horse.root.position.copy(this.pos);
    this.cine.ready = false;
    this.camSmooth.set(0, 0, 0);
  }

  private fwd(out = this.v) {
    return out.set(Math.sin(this.horse.heading), 0, Math.cos(this.horse.heading));
  }

  /** what a hoof stands on at (x, z): the terrain, or a prop's walkable top (a floor slab, low rubble) within a step
   *  of where the horse is now (round 16: it only ever read the terrain, so it sank into the ruins' floor) */
  groundAt(x: number, z: number) {
    const t = this.hf.height(x, z);
    const s = this.colliders.surfaceAt(x, z, this.pos.y + STEP_UP);
    return s && s.y > t ? s.y : t;
  }

  /** the ground under the four hooves: centre height, pitch (+ nose down) and roll */
  private ground(x: number, z: number, h: number) {
    const fx = Math.sin(h), fz = Math.cos(h), L = this.horse.halfLen, W = this.horse.halfWidth;
    const lx = fz, lz = -fx; // left
    const hf = { height: (px: number, pz: number) => this.groundAt(px, pz) };
    const F = hf.height(x + fx * L, z + fz * L), B = hf.height(x - fx * L, z - fz * L);
    const Lh = hf.height(x + lx * W, z + lz * W), Rh = hf.height(x - lx * W, z - lz * W);
    const C = hf.height(x, z);
    // the body rides on the hooves: the mean of the pairs, never below the centre ground by more than a little
    const y = Math.max((F + B) / 2, C - 0.08);
    return { y, pitch: Math.atan2(B - F, 2 * L), roll: Math.atan2(Lh - Rh, 2 * W) * 0.8 };
  }

  private acc = 0;
  private prevPos = new THREE.Vector3();
  private rp = new THREE.Vector3();
  private prevHd = 0;
  /** the simulated heading (horse.heading is the rendered one, interpolated between simulation steps) */
  private hd = 0;
  private gr = { y: 0, pitch: 0, roll: 0 };
  private lookSteer = 0;
  private jumpPrev = false;
  /** the jump: crouch (gathering), air (the arc: height above the ground track, vertical speed), land (the absorb) */
  jump: { st: 'crouch' | 'air' | 'land'; t: number; y: number; vy: number; v0: number } | null = null;
  /** jumps landed, logs refused (for the harness) */
  jumps = 0;
  refusals = 0;
  /** logs the horse took off over: passable until it is well clear of them (a slow jump lands the hind legs over) */
  private cleared = new Set<unknown>();
  private dip = 0;
  private dipV = 0;

  /** Space: gather, leap, land. Only from the ground and out of deep water */
  startJump() {
    if (this.jump || this.depth > 0.35 || this.frozen) return false;
    this.jump = { st: 'crouch', t: 0, y: 0, vy: 0, v0: 0 };
    return true;
  }

  /**
   * One frame: the look and the buttons per frame; the horse's motion in fixed 1/120 s steps (so the speed, the
   * steering and the ground following do not depend on the frame time); the horse, the cameras and the effects drawn
   * at the position interpolated between the last two steps (no judder when the frame rate and the step disagree).
   */
  update(dt: number, it: Intent, t: number, camera: THREE.PerspectiveCamera) {
    const horse = this.horse;
    dt = Math.min(dt, 0.1);
    this.lookSteer = 0;
    // look (first person): free within the neck's reach, then the horse turns toward it
    if (this.view === 'first') {
      this.lookYaw -= it.lookX;
      this.lookPitch = THREE.MathUtils.clamp(this.lookPitch - it.lookY, -62 * DEG, 50 * DEG);
      if (Math.abs(this.lookYaw) > LOOK_LIMIT) {
        const over = this.lookYaw - Math.sign(this.lookYaw) * LOOK_LIMIT;
        this.lookYaw -= over;
        this.lookSteer = -Math.sign(over) * Math.min(1, Math.abs(over) * 40);
      }
      // (the look drifts back toward the heading once the horse is moving and the mouse rests)
      if (Math.abs(it.lookX) < 1e-4 && horse.speed > GAIT.trot) this.lookYaw *= Math.exp(-dt * 0.25);
    } else if (this.view === 'cinematic' && this.endFocus) {
      // (the end shot is placed in render, below)
    } else if (this.view === 'cinematic') {
      this.cine.yaw -= it.lookX;
      this.cine.pitch = THREE.MathUtils.clamp(this.cine.pitch + it.lookY * 0.8, -5 * DEG, 50 * DEG);
      this.cine.dist = THREE.MathUtils.clamp(this.cine.dist + it.zoom * 0.8, 5, 16);
    }

    if (it.jump && !this.jumpPrev && this.view !== 'photo' && !(this.auto && !this.auto.done)) this.startJump();
    this.jumpPrev = it.jump;
    const H = 1 / 120;
    this.acc += dt;
    let n = 0;
    while (this.acc >= H) {
      this.prevPos.copy(this.pos);
      this.prevHd = this.hd;
      this.sim(H, it, t);
      this.acc -= H;
      if (++n >= 12) { this.acc = 0; break; }
    }
    const al = this.acc / H;
    const rp = this.rp.lerpVectors(this.prevPos, this.pos, al);
    let dhd = this.hd - this.prevHd;
    dhd = Math.atan2(Math.sin(dhd), Math.cos(dhd));
    horse.heading = this.prevHd + dhd * al;
    horse.root.position.copy(rp);
    const j = this.jump;
    horse.root.position.y += j ? j.y : 0;
    // the jump's body: gathered low on the hocks, nose up off the ground, nose down to the landing, the absorb
    horse.air = !!j && j.st === 'air';
    if (!j) { horse.lift = 0; horse.jumpPitch = 0; }
    else if (j.st === 'crouch') { const k = THREE.MathUtils.smoothstep(j.t, 0, CROUCH); horse.lift = -0.13 * k; horse.jumpPitch = -0.07 * k; }
    else if (j.st === 'air') { horse.lift = 0; horse.jumpPitch = -0.24 * THREE.MathUtils.clamp(j.vy / j.v0, -1, 1); }
    else { const u = j.t / LAND; horse.lift = -0.12 * Math.sin(Math.PI * Math.min(1, u)); horse.jumpPitch = 0.08 * (1 - u); }
    horse.headNod = this.refuse * 0.25 * Math.sin(t * 9);
    const falls: Footfall[] = horse.update(dt, this.gr.pitch, this.gr.roll);
    // (round 19) standing: a stamped forehoof, a soft snort every few seconds
    if (horse.stamp) this.audio?.hoof(this.groundKind(horse.stamp.x, horse.stamp.z), 0.45, horse.stamp);
    if (horse.snort) this.audio?.softSnort(horse.bitL.getWorldPosition(new THREE.Vector3()));
    this.render(dt, t, camera, falls, rp);
  }

  private sim(dt: number, it: Intent, t: number) {
    const horse = this.horse;
    horse.heading = this.hd;
    void t;
    // ---------------------------------------------------------------- asks
    let throttle = 0, steer = 0;
    if (this.auto && !this.auto.done) {
      const a = this.auto;
      const p = a.pts[a.i];
      const dx = p.x - this.pos.x, dz = p.y - this.pos.z, d = Math.hypot(dx, dz);
      if (d < 7) {
        a.onReach?.(a.i);
        a.i++;
        // (progress is measured to the new waypoint from the next frame on)
        this.bestD = 1e9;
        this.stuck = 0;
        if (a.i >= a.pts.length) a.done = true;
      } else {
        // stuck on something (a trunk, a refusal): no progress toward the waypoint for a few seconds, skip on
        if (d > this.bestD - 0.3) this.stuck += dt; else { this.stuck = 0; this.bestD = d; }
        if (this.stuck > 5) {
          console.warn(`[ride] autopilot skipped waypoint ${a.i} at ${this.pos.x.toFixed(0)},${this.pos.z.toFixed(0)}`);
          a.i++;
          this.stuck = 0;
          this.bestD = 1e9;
          if (a.i >= a.pts.length) a.done = true;
        }
      }
      const want = Math.atan2(dx, dz);
      let dh = want - horse.heading;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      steer = THREE.MathUtils.clamp(-dh * 2.2, -1, 1);
      // obstacle avoidance: feel ahead along three bearings and lean toward the clearer one
      const blocked = (ang: number) => {
        let n = 0;
        for (const r of [3, 6, 9]) {
          const hx = this.pos.x + Math.sin(horse.heading + ang) * r, hz = this.pos.z + Math.cos(horse.heading + ang) * r;
          this.probe.set(hx, this.pos.y, hz);
          if (this.colliders.resolve(this.probe, 0.9)) n += 10 - r;
        }
        return n;
      };
      const c = blocked(0);
      if (c > 0) {
        const l = blocked(0.55), r = blocked(-0.55);
        // (+ heading turns left)
        steer = THREE.MathUtils.clamp(steer + (l <= r ? -1 : 1) * Math.min(1, c / 8), -1, 1);
      }
      if (!this.jump && this.logAhead(this.fw.set(Math.sin(horse.heading), 0, Math.cos(horse.heading)))) this.startJump();
      // (a hairpin is taken at a walk, a bend at a canter)
      this.wantSpeed = a.done ? 0 : a.speed * (Math.abs(dh) > 1.6 ? 0.17 : Math.abs(dh) > 0.9 ? 0.45 : 1);
    } else if (!this.frozen && this.view !== 'photo') {
      throttle = it.moveY;
      steer = it.moveX;
      if (it.sprint) this.shiftHeld += dt; else this.shiftHeld = 0;
      if (throttle < -0.1) this.wantSpeed = -0.9;
      else if (this.shiftHeld > 0) this.wantSpeed = this.shiftHeld > 1.1 ? GAIT.gallop : GAIT.trot;
      else if (throttle > 0.1) this.wantSpeed = GAIT.walk;
      else this.wantSpeed = 0;
    } else this.wantSpeed = 0;

    steer += this.lookSteer;

    // ---------------------------------------------------------------- the ground ahead
    // (its own vector: this.v is the move's scratch below)
    const f = this.fwd(this.fw);
    const ahead = 2.6 + horse.speed * 0.35;
    const gNow = this.groundAt(this.pos.x, this.pos.z);
    const gAhead = this.groundAt(this.pos.x + f.x * ahead, this.pos.z + f.z * ahead);
    const grade = (gAhead - gNow) / ahead;
    this.slope = grade;
    this.depth = Math.max(0, this.hf.depth(this.pos.x, this.pos.z));
    const depthAhead = Math.max(0, this.hf.depth(this.pos.x + f.x * (this.horse.halfLen + 1.2), this.pos.z + f.z * (this.horse.halfLen + 1.2)));
    this.inWater = THREE.MathUtils.smoothstep(this.depth, 0.05, 0.4);
    let cap = GAIT.gallop;
    // uphill: slower; very steep: a walk; a cliff: stop
    // (a steep trail is a steady trot: 0.2 -> 6.2 m/s, 0.35 -> 3.4, 0.45 -> 2.2)
    if (grade > 0) cap = Math.min(cap, GAIT.gallop * Math.max(0.2, 1 - grade * 1.9));
    // a scramble: a slow walk; past ~38 degrees (crags, the falls step, the mountain walls) the horse will not go
    if (grade > 0.55) cap = Math.min(cap, 1.2);
    const cliff = grade > 0.78;
    const deep = depthAhead > 1.0 && this.wantSpeed > 0;
    if (this.inWater > 0) cap = Math.min(cap, THREE.MathUtils.lerp(GAIT.gallop, 3.0, this.inWater));
    let target = Math.min(this.wantSpeed, cap);
    if ((cliff || deep) && this.wantSpeed > 0) {
      target = 0;
      if (this.refuseCool <= 0 && horse.speed > 0.4) {
        this.refuse = 1;
        this.refuseCool = 3;
        this.audio?.snort();
      }
    }
    this.refuseCool -= dt;
    this.refuse = Math.max(0, this.refuse - dt * 0.8);
    // momentum: gentle to build, firmer to rein in (and quick when refusing)
    // (reining in eases off as the horse slows: firm from the gallop, then a soft last stride or two into the halt,
    // not a constant braking that stops dead)
    const acc = target > horse.speed ? (horse.speed < GAIT.trot ? 1.6 : 2.4) : (cliff || deep ? 7 : Math.min(2.3, 0.15 + 0.9 * (horse.speed - target)));
    const air = this.jump?.st === 'air';
    // (in the air the speed carries: no push, no braking)
    if (!air) horse.speed += THREE.MathUtils.clamp(target - horse.speed, -acc * dt, acc * dt);
    // steering in arcs: the rate eases in, smaller at speed (a galloping horse turns wide)
    const maxRate = THREE.MathUtils.lerp(0.95, 0.5, Math.min(1, Math.abs(horse.speed) / GAIT.gallop));
    this.yawRate += (-steer * maxRate * (air ? 0.25 : 1) - this.yawRate) * (1 - Math.exp(-dt * 4));
    horse.heading += this.yawRate * dt;
    horse.turnRate = this.yawRate;
    this.lookYaw -= this.yawRate * dt * 0; // (the look stays relative to the horse)

    // ---------------------------------------------------------------- move
    const step = horse.speed * dt;
    const nx = this.pos.x + f.x * step, nz = this.pos.z + f.z * step;
    this.v.set(nx, gNow, nz);
    // the body, and the chest a body-length ahead, kept off trunks, walls and boulders
    const before = this.v.clone();
    this.colliders.resolve(this.v, 0.75);
    const chest = new THREE.Vector3(this.v.x + f.x * horse.halfLen, gNow, this.v.z + f.z * horse.halfLen);
    const c0 = chest.clone();
    if (this.colliders.resolve(chest, 0.45)) this.v.add(chest.sub(c0));
    const pushed = this.v.distanceTo(before);
    if (pushed > step * 0.6 && horse.speed > 0.5) horse.speed *= Math.exp(-dt * 3);
    // natural walls only: the valley rim and the gorge are steep enough that the slope check stops the horse
    // first; this keeps a runaway frame from leaving the baked square
    const r = Math.hypot(this.v.x, this.v.z);
    if (r > 990) this.v.multiplyScalar(990 / r);
    const ox = this.pos.x, oz = this.pos.z;
    this.pos.x = this.v.x;
    this.pos.z = this.v.z;
    this.logCheck(f, ox, oz);
    const gr = this.ground(this.pos.x, this.pos.z, horse.heading);
    // the body's height eases over bumps (no hard steps), faster when climbing so hooves never sink
    // (a real step up, onto a slab: the body follows at once, the hooves never sink into the stone)
    const ky = 1 - Math.exp(-dt * (gr.y > this.pos.y + 0.15 ? 40 : gr.y > this.pos.y ? 14 : 9));
    this.pos.y += (gr.y - this.pos.y) * ky;
    this.gr = gr;
    this.hd = horse.heading;
    this.jumpStep(dt);
  }

  private render(dt: number, t: number, camera: THREE.PerspectiveCamera, falls: Footfall[], rp: THREE.Vector3) {
    const horse = this.horse;

    // ---------------------------------------------------------------- hooves: sound, dust, splashes
    for (const ff of falls) {
      const d = this.hf.depth(ff.pos.x, ff.pos.z);
      const ground: Ground = d > 0.04 ? 'water' : this.groundKind(ff.pos.x, ff.pos.z);
      this.audio?.hoof(ground, ff.force, ff.pos);
      if (ground === 'water') {
        this.dust.emit(ff.pos.x, this.hf.waterLevel(ff.pos.x, ff.pos.z), ff.pos.z, 'splash', ff.force);
        if (ff.force > 0.6) this.audio?.splash(ff.force * 0.6, ff.pos);
      } else if (ground === 'dirt' && horse.speed > GAIT.trot) {
        // (dust only off bare dirt: a hoof on turf throws up next to none)
        this.dust.emit(ff.pos.x, ff.pos.y, ff.pos.z, 'dust', ff.force);
      }
    }
    this.dust.update(dt, camera);

    // ---------------------------------------------------------------- cameras
    // the landing's dip: a damped spring kicked by the impact
    this.dipV += (-this.dip * 90 - this.dipV * 13) * dt;
    this.dip += this.dipV * dt;
    horse.root.updateMatrixWorld(true);
    horse.eye.getWorldPosition(this.eyeW);
    const gallop = Math.max(0, horse.gait - 1);
    if (this.camOff) {
      // (nothing: photo mode or a posed camera)
    } else if (this.view === 'first') {
      // the eye rides the saddle; the head-bob setting blends it with a steadied copy (a rider's neck absorbs most)
      if (this.camSmooth.lengthSq() === 0) this.camSmooth.copy(this.eyeW);
      const ks = 1 - Math.exp(-dt * 7);
      this.camSmooth.x = this.eyeW.x;
      this.camSmooth.z = this.eyeW.z;
      this.camVel.y += ((this.eyeW.y - this.camSmooth.y) * 60 - this.camVel.y * 14) * dt;
      this.camSmooth.y += this.camVel.y * dt;
      this.camSmooth.y += (this.eyeW.y - this.camSmooth.y) * ks * 0.15;
      const b = this.bob;
      camera.position.set(this.eyeW.x, THREE.MathUtils.lerp(this.camSmooth.y, this.eyeW.y, b) + this.dip, this.eyeW.z);
      const yaw = horse.heading + Math.PI + this.lookYaw;
      const pitch = this.lookPitch - (horse.pitch * 0.55 + (horse.gait > 1 ? Math.sin(horse.stridePhase * Math.PI * 2 + 0.6) * 0.03 * gallop : 0)) * b;
      camera.rotation.set(pitch, yaw, -horse.roll * 0.25 * b, 'YXZ');
      // (her hands on the reins are not good enough up close: no hands in first person, NEXT4 §4)
      horse.rider.visible = false;
      this.reins.visible = true;
    } else if (this.view === 'cinematic' && this.endFocus) {
      // the end shot: from the midpoint of the horse and the fire, the camera stands off the line between them at an
      // angle (on the side that looks west, toward the sun and the valley below), a little above, looking at the
      // middle; it eases there from wherever the chase camera was
      const f = this.endFocus, c = this.cine;
      const mx = (rp.x + f.x) / 2, mz = (rp.z + f.z) / 2;
      let ux = f.x - rp.x, uz = f.z - rp.z;
      const ul = Math.hypot(ux, uz) || 1;
      ux /= ul; uz /= ul;
      const sp = Math.max(6.5, ul * 0.55 + 4.5);
      // (the view runs from the camera toward the middle, along -r: the side whose view looks most toward the valley's
      // middle, out over the brow and down, with the low sun behind the camera)
      const vl = Math.hypot(mx, mz) || 1, vx = -mx / vl, vz = -mz / vl;
      let best = -Infinity, ox = 0, oz = 0;
      for (const a of [-1.0, 1.0]) {
        const rx = ux * Math.cos(a) - uz * Math.sin(a), rz = ux * Math.sin(a) + uz * Math.cos(a);
        const out = -(rx * vx + rz * vz);
        if (out > best) { best = out; ox = rx; oz = rz; }
      }
      const want = this.endV.set(mx + ox * sp, 0, mz + oz * sp);
      want.y = Math.max(this.hf.height(want.x, want.z) + 2.1, (rp.y + f.y) / 2 + 2.3);
      if (!c.ready) { c.pos.copy(camera.position); c.ready = true; }
      if (!this.endInit) {
        // (from where the chase camera was looking, so the turn is one smooth move)
        const fw0 = this.fwd(this.fw);
        this.endTarget.set(rp.x + fw0.x * 2.5, rp.y + 2.2, rp.z + fw0.z * 2.5);
        this.endInit = true;
      }
      c.pos.lerp(want, 1 - Math.exp(-dt * 0.9));
      c.pos.y = Math.max(c.pos.y, this.hf.height(c.pos.x, c.pos.z) + 1.2);
      this.endTarget.x += (mx - this.endTarget.x) * (1 - Math.exp(-dt * 2));
      this.endTarget.z += (mz - this.endTarget.z) * (1 - Math.exp(-dt * 2));
      this.endTarget.y += ((rp.y + f.y) / 2 + 1.3 - this.endTarget.y) * (1 - Math.exp(-dt * 2));
      camera.position.copy(c.pos);
      camera.lookAt(this.endTarget);
      horse.rider.visible = true;
      this.reins.visible = true;
    } else if (this.view === 'cinematic') {
      const c = this.cine;
      const yaw = horse.heading + Math.PI + c.yaw;
      // the chase framing of RDR2-REFERENCE.md: ~2 m up and a few metres off the tail, looking a little down past the
      // horse; at the gallop the camera drops and trails a little farther
      const gal = THREE.MathUtils.smoothstep(horse.speed, GAIT.trot, GAIT.gallop);
      const dist = c.dist + gal * 1.1, pitch = c.pitch - gal * 2 * DEG;
      const want = new THREE.Vector3(
        rp.x - Math.sin(yaw + Math.PI) * dist * Math.cos(pitch),
        rp.y + 1.75 + Math.sin(pitch) * dist,
        rp.z - Math.cos(yaw + Math.PI) * dist * Math.cos(pitch));
      // never under the ground or inside a wall: pulled in along the ray from the horse
      const from = new THREE.Vector3(rp.x, rp.y + 1.6, rp.z);
      const dir = want.clone().sub(from);
      const len = dir.length();
      dir.normalize();
      const hit = this.colliders.raycast(from, dir, len);
      if (hit < len) want.copy(from).addScaledVector(dir, Math.max(2.5, hit - 0.6));
      for (let s = 0.25; s <= 1.0001; s += 0.25) {
        const px = from.x + (want.x - from.x) * s, pz = from.z + (want.z - from.z) * s;
        const gy = this.hf.height(px, pz) + 0.9, wy = from.y + (want.y - from.y) * s;
        if (wy < gy) want.y += (gy - wy) / s;
      }
      want.y = Math.max(want.y, this.hf.height(want.x, want.z) + 1.0, this.hf.waterLevel(want.x, want.z) + 0.6);
      if (!c.ready) { c.pos.copy(want); c.ready = true; }
      c.pos.lerp(want, 1 - Math.exp(-dt * 5));
      c.pos.y = Math.max(c.pos.y, this.hf.height(c.pos.x, c.pos.z) + 0.8);
      camera.position.copy(c.pos);
      camera.position.y += this.dip * 0.7;
      const fw = this.fwd(this.fw);
      camera.lookAt(rp.x + fw.x * 2.5, rp.y + 2.2, rp.z + fw.z * 2.5);
      horse.rider.visible = true;
      this.reins.visible = true;
    }
    // FOV kick at the gallop
    const wantFov = this.view === 'photo' ? camera.fov : (this.view === 'first' ? FOV : CINE_FOV) + (this.view === 'first' ? 9 : 4) * gallop * Math.min(1, horse.speed / GAIT.gallop);
    if (this.view !== 'photo' && !this.camOff) {
      this.fov += (wantFov - this.fov) * (1 - Math.exp(-dt * 2.5));
      if (Math.abs(camera.fov - this.fov) > 0.01) { camera.fov = this.fov; camera.updateProjectionMatrix(); }
    }
    this.updateReins(t);
    this.audioFx(dt);
  }

  /** the jump's clock: gather, take off, the arc over the ground track, touch down with dust and a camera dip */
  private jumpStep(dt: number) {
    const j = this.jump;
    if (!j) return;
    j.t += dt;
    if (j.st === 'crouch') {
      if (j.t >= CROUCH) {
        j.st = 'air'; j.t = 0;
        // (a standing horse still springs forward a little; at speed it leaps long)
        j.v0 = j.vy = LIFT * (this.horse.speed < 2 ? 0.8 : 1);
        for (const L of this.valley?.jumpLogs ?? []) if ((this.pos.x - L.x) ** 2 + (this.pos.z - L.z) ** 2 < 25) this.cleared.add(L);
        this.horse.speed = Math.max(this.horse.speed, this.horse.speed < 0.5 ? 2.2 : 4.6);
        // (round 19) take-off: a snort (and now and then a whinny)
        this.audio?.breath(0.4);
        this.audio?.jumpSnort(this.horse.bitL.getWorldPosition(new THREE.Vector3()));
      }
    } else if (j.st === 'air') {
      j.y += j.vy * dt;
      j.vy -= 9.8 * dt;
      if (j.y <= 0 && j.vy < 0) {
        const impact = Math.min(1, -j.vy / LIFT);
        j.st = 'land'; j.t = 0; j.y = 0;
        this.jumps++;
        this.dipV -= 1.5 * impact;
        const h = this.horse;
        for (const leg of ['LF', 'RF', 'LH', 'RH'] as const) {
          const p = h.hooves[leg].getWorldPosition(new THREE.Vector3());
          const wet = this.hf.depth(p.x, p.z) > 0.04;
          if (wet || this.groundKind(p.x, p.z) === 'dirt') this.dust.emit(p.x, wet ? this.hf.waterLevel(p.x, p.z) : this.hf.height(p.x, p.z), p.z, wet ? 'splash' : 'dust', 1);
          if (leg.endsWith('H')) this.audio?.hoof(wet ? 'water' : this.groundKind(p.x, p.z), 1, p);
        }
        // (round 19) the landing: a heavy thud, and the saddle's leather creaking under her
        this.audio?.landThud(impact, h.hooves.LF.getWorldPosition(new THREE.Vector3()));
        this.audio?.saddleCreak(0.08 + 0.06 * impact);
        // (a heavy landing scrubs a little speed)
        h.speed *= 0.9;
      }
    } else if (j.t >= LAND) this.jump = null;
  }

  /** the fore and aft ends of the body against every log near by: too low to clear it, the horse stops short */
  private logCheck(f: THREE.Vector3, ox: number, oz: number) {
    const logs = this.valley?.jumpLogs;
    if (!logs) return;
    const h = this.horse, clear = this.jump?.st === 'air' ? this.jump.y : 0;
    // (on landing from a jump the hind legs come down over the log just cleared: a slow jump's arc is shorter than the
    // horse, and the walk tour's horse "refused" a log it was already over. A log taken off over stays passable until
    // the horse is clear of it.)
    for (const L of logs) {
      const dx = this.pos.x - L.x, dz = this.pos.z - L.z;
      if (this.cleared.has(L)) { if (dx * dx + dz * dz > 36) this.cleared.delete(L); else continue; }
      if (dx * dx + dz * dz > 144) continue;
      const u = dx * L.ax + dz * L.az;
      if (Math.abs(u) > L.half + 0.3) continue;
      // across the log (along the trail): the body from its tail to its chest
      const nx = -L.az, nz = L.ax;
      const w = dx * nx + dz * nz, fw = (f.x * nx + f.z * nz) * h.halfLen;
      const wa = w - fw, wb = w + fw, lo = Math.min(wa, wb), hi = Math.max(wa, wb);
      const touch = hi > -(L.r + 0.2) && lo < L.r + 0.2;
      // (tucked, the hooves clear ~0.3 m under the belly line)
      if (touch && clear + 0.32 < L.top) {
        this.pos.x = ox; this.pos.z = oz;
        if (h.speed > 0.6 && this.refuseCool <= 0) { this.refuse = 1; this.refuseCool = 2.5; this.refusals++; this.audio?.snort(); }
        h.speed = Math.min(h.speed, 0.3);
        return;
      }
    }
  }

  /** a log across the way ahead, at the distance a jump at this speed should leave from (the bot's eye) */
  private logAhead(f: THREE.Vector3) {
    const logs = this.valley?.jumpLogs;
    if (!logs) return false;
    const h = this.horse, v = Math.max(h.speed, 4.6);
    const want = v * (CROUCH + 0.1) + 0.45;
    for (const L of logs) {
      const dx = this.pos.x - L.x, dz = this.pos.z - L.z;
      if (dx * dx + dz * dz > 400) continue;
      const nx = -L.az, nz = L.ax;
      const fx = dx + f.x * h.halfLen, fz = dz + f.z * h.halfLen;
      const w = fx * nx + fz * nz, rate = f.x * nx + f.z * nz;
      // approaching (the gap closing), and the line of travel meets the log within its length
      if (w * rate >= 0 || Math.abs(rate) < 0.3) continue;
      const gap = Math.abs(w) - L.r;
      const tHit = Math.abs(w) / Math.abs(rate);
      const u = (fx + f.x * tHit) * L.ax + (fz + f.z * tHit) * L.az;
      if (Math.abs(u) > L.half + 0.2) continue;
      if (gap / Math.abs(rate) < want && gap > -0.1) return true;
    }
    return false;
  }

  private groundKind(x: number, z: number): Ground {
    if (!this.valley) return 'grass';
    const m = this.valley.mask(x, z);
    if (m.rock > 0.5) return 'stone';
    if (m.dirt > 0.35) return 'dirt';
    if (m.forest > 0.5) return 'forest';
    return 'grass';
  }

  private breathT = 0;
  private audioFx(dt: number) {
    if (!this.audio) return;
    // gallop breathing: one breath a stride
    const g = Math.max(0, this.horse.gait - 1);
    if (g > 0.4) {
      this.breathT -= dt;
      if (this.breathT <= 0) { this.audio.breath(0.3 + 0.5 * g); this.breathT = 1 / Math.max(0.8, this.horse.speed / 3.9); }
    }
  }

  private hands = new THREE.Vector3();
  private rt = new THREE.Vector3();
  private rw = new THREE.Vector3();
  private rk = new THREE.Vector3();
  private rpv = new THREE.Vector3();
  private nk = new THREE.Vector3();
  private cp = new THREE.Vector3();
  private curve = new THREE.CatmullRomCurve3([new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], false, 'centripetal');
  private bl = new THREE.Vector3();
  private up = new THREE.Vector3();
  private br = new THREE.Vector3();
  private updateReins(t: number) {
    const h = this.horse;
    h.bitL.getWorldPosition(this.bl);
    h.bitR.getWorldPosition(this.br);
    // (without her model's grips: a guess from the rider's eye, a forearm ahead and a little more below)
    h.eye.getWorldPosition(this.hands);
    const f = this.fwd(new THREE.Vector3());
    const left = new THREE.Vector3(f.z, 0, -f.x);
    this.hands.addScaledVector(f, 0.36).add(new THREE.Vector3(0, -0.42 + 0.012 * Math.sin(t * 2.1), 0));
    const gl = h.person.gripL ? h.person.gripL.getWorldPosition(new THREE.Vector3()) : this.hands.clone().addScaledVector(left, 0.07);
    const gr = h.person.gripR ? h.person.gripR.getWorldPosition(new THREE.Vector3()) : this.hands.clone().addScaledVector(left, -0.07);
    // (while her right hand pats the neck, the right rein is in her left fist)
    if (h.person.reinTransfer > 0) gr.lerp(this.v.copy(gl).addScaledVector(left, -0.025), h.person.reinTransfer);
    // a rein is a flat strap 21 mm wide and 4 mm thick (rubber-grip reins); seen from the side it shows its width
    const SEG = 18, SIDES = 4, HW = 0.0105, HT = 0.002;
    const P = this.reinPos;
    const tan = this.rt, wid = this.rw, thk = this.rk, prev = this.rpv;
    let o = 0;
    for (let r = 0; r < 3; r++) {
      let sag = 0;
      if (r < 2) {
        // one line from the bit ring to her fist, bowed a finger's width out round the neck. Her hands go with the
        // bit (the clip: tools/blender/rider/rider_rig.py), so the rein keeps its length: a light, steady contact
        const a = r === 0 ? this.bl : this.br, b = r === 0 ? gl : gr;
        sag = 0.006;
        this.curve.points[0].copy(a);
        this.curve.points[1].copy(a).lerp(b, 0.34).addScaledVector(left, r === 0 ? 0.022 : -0.022);
        this.curve.points[2].copy(a).lerp(b, 0.68).addScaledVector(left, r === 0 ? 0.018 : -0.018);
        this.curve.points[3].copy(b);
        thk.copy(left);
      } else {
        // the bight: out of the top of each fist, over to the off side and down the shoulder, swinging with the stride
        const sw = 0.02 * Math.sin(h.stridePhase * Math.PI * 4);
        this.curve.points[0].copy(gl).add(this.up.set(0, 0.03, 0));
        this.curve.points[1].copy(gl).lerp(gr, 0.5).add(this.up.set(0, 0.035, 0)).addScaledVector(f, 0.02);
        this.curve.points[2].copy(gr).addScaledVector(left, -0.085).add(this.up.set(0, -0.15 + sw, 0)).addScaledVector(f, 0.05);
        this.curve.points[3].copy(gr).add(this.up.set(0, 0.03, 0));
        thk.copy(f);
      }
      for (let i = 0; i <= SEG; i++) {
        const s = i / SEG;
        this.curve.getPoint(s, this.cp);
        this.cp.y -= sag * 4 * s * (1 - s);
        if (i === 0) { this.curve.getPoint(1 / SEG, prev); tan.copy(prev).sub(this.cp); } else tan.copy(this.cp).sub(prev);
        prev.copy(this.cp);
        tan.normalize();
        wid.crossVectors(tan, r < 2 ? left : f).normalize();
        thk.crossVectors(wid, tan).normalize();
        for (let k = 0; k < SIDES; k++) {
          const w = (k === 0 || k === 3 ? -1 : 1) * HW, hh = (k < 2 ? -1 : 1) * HT;
          P[o++] = this.cp.x + wid.x * w + thk.x * hh;
          P[o++] = this.cp.y + wid.y * w + thk.y * hh;
          P[o++] = this.cp.z + wid.z * w + thk.z * hh;
        }
      }
    }
    const attr = this.reins.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
    this.reins.geometry.computeVertexNormals();
    this.reins.geometry.computeBoundingSphere();
  }

  setView(v: View) {
    this.view = v;
    this.cine.ready = false;
    this.camSmooth.set(0, 0, 0);
  }
}

/**
 * hoof dust and splashes: a pool of small billboards simulated on the CPU. Dust is a soft round puff facing the
 * camera. Spray is water: droplets and torn sheets thrown up by the hoof, each quad stretched along its velocity as
 * seen on screen (the streak a droplet leaves in a 1/30 s exposure), mostly see-through with a bright edge where it
 * catches the sky, breaking into beads along its length, and gone in a fraction of a second.
 */
class Puffs {
  private N = 240;
  private mesh: THREE.InstancedMesh;
  private data: THREE.InstancedBufferAttribute;
  private p: Float32Array; // x y z vx vy vz age life size kind(0 dust, 1 droplet, 2 sheet)
  private next = 0;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private t = new THREE.Vector3();
  private ax = new THREE.Vector3();
  private ay = new THREE.Vector3();
  private az = new THREE.Vector3();
  private w = new THREE.Vector3();
  private v = new THREE.Vector3();
  private camUp = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    const g = new THREE.PlaneGeometry(1, 1);
    this.data = new THREE.InstancedBufferAttribute(new Float32Array(this.N * 4), 4);
    this.data.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('pData', this.data);
    const m = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, roughness: 1 });
    // x: opacity, y: kind (0 dust, 1 spray), z: a per-particle seed, w: 1 for a torn sheet, 0 for droplets
    const d = attribute('pData', 'vec4');
    const sprayK = d.y, sheetK = d.w;
    const r = length(uv().sub(0.5)).mul(2);
    const gap = max(sceneViewDepth(screenUV).sub(positionView.z.negate()), 0);
    // dust: a round, soft puff that also fades where it meets the ground behind it (soft particles: no hard line where
    // the quad cuts the trail)
    const dust = float(1).sub(smoothstep(0.0, 1, r)).pow(1.6).mul(smoothstep(0, 0.7, gap));
    // spray: a streak along the quad's v (the velocity), thin across it, its ends tapered
    const ac = abs(uv().x.sub(0.5)).mul(2), al = uv().y.sub(0.5).mul(2);
    const tail = smoothstep(1, 0.15, abs(al));
    // droplets: two or three beads strung along the streak (where it runs thick), on a faint thread between them
    const beads = smoothstep(0.55, 0.95, sin(al.mul(mix(float(5), float(9), fract(d.z.mul(7.31)))).add(d.z.mul(40))).mul(0.5).add(0.5));
    const dropA = smoothstep(1, 0.25, ac).mul(tail).mul(mix(float(0.35), float(1), beads));
    // a torn sheet: wider and fainter, its edge frayed into fingers
    const fray = smoothstep(0.2, 0.8, sin(uv().x.mul(17).add(d.z.mul(23))).mul(0.5).add(0.5));
    const sheetA = smoothstep(1, 0.4, ac).mul(tail).mul(mix(float(0.45), float(1), fray)).mul(0.55);
    const sprayA = mix(dropA, sheetA, sheetK).mul(smoothstep(0, 0.12, gap));
    const alpha = mix(dust, sprayA, sprayK).mul(d.x);
    // water is clear: what a droplet shows is the sky it reflects and the glint of the sun (the lighting model's,
    // on a smooth surface), so a faint grey-white body with the sky's light added, brightest at its rim
    const rim = smoothstep(0.2, 0.9, ac);
    const col = mix(vec3(0.24, 0.22, 0.19), vec3(0.55, 0.6, 0.62), sprayK);
    m.colorNode = Fn(() => vec4(col, 1))();
    m.roughnessNode = mix(float(1), float(0.25), sprayK);
    m.opacityNode = alpha;
    // (the AO's normal target is not blended: a puff writes the world's up there, and hides the occlusion under it
    // by its opacity, or each quad shows as a square: core/fx.ts)
    m.mrtNode = effectMRT(alpha.mul(mix(float(1), float(0.3), sprayK)));
    m.emissiveNode = particleSky().mul(sprayK).mul(mix(float(0.35), float(0.7), rim));
    sunLit(m);
    this.mesh = new THREE.InstancedMesh(g, m, this.N);
    // (in the trees' shadow the dust is too: lit only by the sky there)
    this.mesh.receiveShadow = true;
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    scene.add(this.mesh);
    this.p = new Float32Array(this.N * 10);
  }

  emit(x: number, y: number, z: number, kind: 'dust' | 'splash', force: number) {
    // a splash: a dozen droplets and a couple of torn sheets (each a few centimetres, not a ball of white)
    const n = kind === 'dust' ? 2 : 14;
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.N;
      const o = i * 10, a = Math.random() * Math.PI * 2;
      if (kind === 'dust') {
        // (a thin skin of dust kicked low along the ground, not a ball)
        const sp = 0.3 + Math.random() * 0.3;
        this.p.set([x + Math.cos(a) * 0.1, y + 0.03, z + Math.sin(a) * 0.1, Math.cos(a) * sp, 0.08 + Math.random() * 0.1, Math.sin(a) * sp, 0,
          1.2 + Math.random() * 0.8, 0.28 + 0.2 * force, 0], o);
        continue;
      }
      const sheet = k < 2;
      const sp = sheet ? 0.4 + Math.random() * 0.6 * force : 0.5 + Math.random() * 1.6 * force;
      const up = sheet ? 0.9 + Math.random() * 1.0 * force : 1.2 + Math.random() * 2.6 * force;
      const r0 = 0.06 + Math.random() * 0.1;
      this.p.set([x + Math.cos(a) * r0, y + 0.03, z + Math.sin(a) * r0, Math.cos(a) * sp, up, Math.sin(a) * sp, 0,
        sheet ? 0.3 + Math.random() * 0.15 : 0.35 + Math.random() * 0.35,
        sheet ? 0.14 + 0.1 * force : 0.035 + Math.random() * 0.035, sheet ? 2 : 1], o);
    }
  }

  update(dt: number, camera: THREE.Camera) {
    const P = this.p, D = this.data.array as Float32Array;
    this.camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    let n = 0;
    for (let i = 0; i < this.N; i++) {
      const o = i * 10;
      if (P[o + 7] <= 0) continue;
      P[o + 6] += dt;
      const age = P[o + 6], life = P[o + 7];
      if (age >= life) { P[o + 7] = 0; continue; }
      const kind = P[o + 9];
      const spray = kind > 0.5;
      P[o] += P[o + 3] * dt; P[o + 1] += P[o + 4] * dt; P[o + 2] += P[o + 5] * dt;
      if (spray) {
        P[o + 4] -= 9.8 * dt;
        // (a sheet tears apart against the air: it slows and spreads)
        if (kind > 1.5) { P[o + 3] *= Math.exp(-dt * 2); P[o + 5] *= Math.exp(-dt * 2); }
      } else { P[o + 3] *= Math.exp(-dt * 1.5); P[o + 5] *= Math.exp(-dt * 1.5); P[o + 4] *= Math.exp(-dt * 2); }
      const u = age / life;
      this.t.set(P[o], P[o + 1], P[o + 2]);
      if (spray) {
        // stretched along the velocity as the camera sees it, facing the camera
        this.w.copy(this.t).sub(camera.position).normalize();
        this.v.set(P[o + 3], P[o + 4], P[o + 5]);
        this.ay.copy(this.v).addScaledVector(this.w, -this.v.dot(this.w));
        const vs = this.ay.length();
        if (vs > 1e-3) this.ay.multiplyScalar(1 / vs); else this.ay.copy(this.camUp);
        this.ax.crossVectors(this.w, this.ay).normalize();
        this.az.crossVectors(this.ax, this.ay);
        const sheet = kind > 1.5;
        const wid = P[o + 8] * (sheet ? 1 + u * 1.5 : 1);
        // (the streak a 1/30 s exposure draws, at least a round bead)
        const len = Math.max(wid * (sheet ? 0.8 : 1.6), vs * (sheet ? 0.035 : 0.045) + wid);
        this.m4.makeBasis(this.ax.multiplyScalar(wid), this.ay.multiplyScalar(len), this.az);
        this.m4.setPosition(this.t);
      } else {
        const size = P[o + 8] * (1 + u * 1.6);
        this.q.copy(camera.quaternion);
        this.m4.compose(this.t, this.q, this.s.set(size, size, size));
      }
      this.mesh.setMatrixAt(n, this.m4);
      D[n * 4] = spray
        ? (kind > 1.5 ? 0.45 : 0.85) * Math.min(1, u * 8) * (1 - u) * (1 - u)
        : 0.09 * Math.sin(Math.PI * Math.min(1, u * 1.4 + 0.05)) * (1 - u);
      D[n * 4 + 1] = spray ? 1 : 0;
      D[n * 4 + 2] = (i * 0.618034) % 1;
      D[n * 4 + 3] = kind > 1.5 ? 1 : 0;
      n++;
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.data.needsUpdate = true;
  }
}
