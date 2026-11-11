/**
 * Valley Ride as a little game: a title over the first view and a hint of the keys, four lantern checkpoints along
 * the trail to the summit, and the summit's campfire at sunset where the ride ends ("valley crossed", the time, ride
 * again). No fail state, no score.
 *
 * Design brief: you ride a horse across one valley to a fire on the ridge at sunset. The verb is riding (pace,
 * steering, the odd jump); the objective is the next lantern down the trail, always in view of the one before; the
 * pressure is only your own wish to keep a good pace, and the reward is the light: the sun lowers as you climb, so
 * the summit is always reached at sunset. Restart is one click.
 *
 * Update order (main.ts): Input.read -> Game.update (may hold the horse still at the end) -> Ride.update.
 */
import type * as THREE from 'three/webgpu';
import type { Intent } from '../player/Input';
import type { Ride } from '../ride/Ride';
import type { AudioSystem } from '../audio/Audio';
import type { TimeOfDay } from '../sky/TimeOfDay';
import type { GameUI } from '../ui/GameUI';
import type { Checkpoints } from './Checkpoints';
import { ROUTE, SUMMIT_FIRE, type V2 } from '../world/layout';
import { chime, finale } from './sounds';

export type GameState = 'title' | 'ride' | 'finish';

/** the light of the ride: golden hour at the start, the sun on the horizon at the summit */
const HOUR_START = 16.95, HOUR_END = 17.42;
/** the ride ends this close to the fire: the horse eases down and walks in, and halts this far short of it */
const FINISH_R = 20, STAND_R = 9;
/** a checkpoint counts this close to its centre (the lanterns stand 3.4 m either side) */
const PASS_R = 11;

export interface GameDeps {
  ride: Ride; audio: AudioSystem; tod: TimeOfDay; ui: GameUI; cps: Checkpoints;
  /** the game owns the hour (off when the URL sets one: the test harness) */
  driveTime: boolean;
  spawn: { x: number; z: number; yaw: number };
  /** the summit fire (world position) */
  fire: THREE.Vector3;
}

export class Game {
  state: GameState = 'title';
  /** riding time (s): from the first step to the summit */
  time = 0;
  next = 0;
  progress = 0;
  private clock = 0;
  private titleOn = true;
  private started = false;
  private arrivedT = -1;
  private ended = false;
  private hintT = -1;
  private segLen: number[] = [];
  private total = 0;
  private stillIntent: Intent = { moveX: 0, moveY: 0, lookX: 0, lookY: 0, sprint: false, jump: false, walk: false, zoom: 0, up: 0 };

  constructor(private d: GameDeps) {
    for (let i = 0; i + 1 < ROUTE.length; i++) {
      const l = Math.hypot(ROUTE[i + 1][0] - ROUTE[i][0], ROUTE[i + 1][1] - ROUTE[i][1]);
      this.segLen.push(l);
      this.total += l;
    }
    d.ui.onRideAgain = () => this.rideAgain();
    window.addEventListener('keydown', (e) => { if (e.code === 'Enter' && this.ended) this.rideAgain(); });
    if (d.driveTime) { d.tod.frozen = true; d.tod.setHour(HOUR_START); }
  }

  get checkpointCount() { return this.d.cps.points.length; }

  /** per frame, before the ride: returns the intent the ride should use */
  update(dt: number, it: Intent, t: number): Intent {
    const { ride, ui, cps, tod } = this.d;
    this.clock += dt;
    const moving = Math.abs(it.moveY) > 0.1 || Math.abs(it.moveX) > 0.1 || it.jump || it.sprint;
    // ---- the opening: the title, then the keys
    ui.showTitle(this.titleOn && this.clock > 0.4 && this.clock < 3.6);
    if (this.clock >= 3.6) this.titleOn = false;
    if (this.state === 'title' && this.clock > 3.0) { this.state = 'ride'; this.hintT = 0; ui.showHint(true); }
    if (this.hintT >= 0) {
      this.hintT += dt;
      // (it stays at least a moment, then goes with the first input, or by itself after a while)
      if ((moving && this.hintT > 1.2) || this.hintT > 8) { ui.showHint(false); this.hintT = -1; }
    }
    const p = ride.pos;
    if (!this.started && ride.horse.speed > 0.5) this.started = true;
    if (this.started && this.state !== 'finish') this.time += dt;
    // ---- the checkpoints, in order (riding past one further on counts the ones before it too)
    if (this.state !== 'finish') {
      for (let i = this.next; i < cps.points.length; i++) {
        const [cx, cz] = cps.points[i];
        if (Math.hypot(p.x - cx, p.z - cz) < PASS_R) {
          for (let j = this.next; j <= i; j++) cps.pass(j);
          this.next = i + 1;
          ui.toast(`checkpoint ${this.next}/${cps.points.length}`);
          this.sfx(chime);
          break;
        }
      }
      this.progress = Math.max(this.progress, this.along(p.x, p.z));
      if (Math.hypot(p.x - SUMMIT_FIRE[0], p.z - SUMMIT_FIRE[1]) < FINISH_R) {
        this.state = 'finish';
        this.arrivedT = this.clock;
        for (let j = this.next; j < cps.points.length; j++) cps.pass(j);
        this.next = cps.points.length;
        this.progress = 1;
        ui.showHint(false);
        this.hintT = -1;
        // (the end shot: the fire and the horse and rider side by side, the valley below in the setting sun)
        ride.endFocus = this.d.fire;
      }
    }
    cps.update(dt, t);
    ui.update(dt);
    // ---- the light follows the ride: the sun sinks as the summit nears
    if (this.d.driveTime) {
      const want = HOUR_START + (HOUR_END - HOUR_START) * this.progress;
      tod.setHour(tod.hour + (want - tod.hour) * (1 - Math.exp(-dt * 0.6)));
    }
    // ---- the end: the horse eased to a halt by the fire, then the card
    if (this.state === 'finish') {
      const fx = this.d.fire.x - p.x, fz = this.d.fire.z - p.z, fd = Math.hypot(fx, fz);
      const walkIn = !this.ended && fd > STAND_R && this.clock - this.arrivedT < 20;
      if (!this.ended && !walkIn && ride.horse.speed < 0.3 && this.clock - this.arrivedT > 1.0) {
        this.ended = true;
        ui.showEnd(this.time);
        this.sfx(finale);
        if (document.pointerLockElement) document.exitPointerLock();
      }
      // (the last few metres at a walk, steering for the fire; then the reins go quiet)
      let dh = Math.atan2(fx, fz) - ride.horse.heading;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      this.stillIntent.moveY = walkIn ? 1 : 0;
      this.stillIntent.moveX = walkIn ? Math.max(-1, Math.min(1, -dh * 2.2)) : 0;
      this.stillIntent.lookX = it.lookX;
      this.stillIntent.lookY = it.lookY;
      this.stillIntent.zoom = it.zoom;
      return this.stillIntent;
    }
    return it;
  }

  /** the opening again from the start (the title, then the keys) */
  intro() {
    this.clock = 0;
    this.titleOn = true;
    this.state = 'title';
    this.hintT = -1;
    this.d.ui.showHint(false);
  }

  rideAgain() {
    const { ride, ui, cps, tod, spawn } = this.d;
    ride.place(spawn.x, spawn.z, spawn.yaw);
    cps.reset();
    ui.showEnd(null);
    this.state = 'ride';
    this.next = 0;
    this.progress = 0;
    this.time = 0;
    this.started = false;
    this.ended = false;
    this.arrivedT = -1;
    this.hintT = 0;
    ui.showHint(true);
    if (this.d.driveTime) tod.setHour(HOUR_START);
  }

  /** how far along the route (0..1) the nearest point to (x, z) is, if near it */
  private along(x: number, z: number) {
    let best = Infinity, s = 0, acc = 0;
    for (let i = 0; i + 1 < ROUTE.length; i++) {
      const a: V2 = ROUTE[i], b: V2 = ROUTE[i + 1], L = this.segLen[i];
      const tx = (b[0] - a[0]) / L, tz = (b[1] - a[1]) / L;
      const u = Math.max(0, Math.min(L, (x - a[0]) * tx + (z - a[1]) * tz));
      const d = Math.hypot(a[0] + tx * u - x, a[1] + tz * u - z);
      if (d < best) { best = d; s = acc + u; }
      acc += L;
    }
    return best < 80 ? s / this.total : this.progress;
  }

  private sfx(f: (ctx: AudioContext, out: AudioNode) => void) {
    const a = this.d.audio;
    if (a.ctx && !a.muted) f(a.ctx, a.sfxOut());
  }
}
