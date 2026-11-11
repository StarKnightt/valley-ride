/**
 * Valley sound (Island's mixer, re-voiced): looping ambience layers mixed every frame from where the listener is and
 * what the world is doing (wind in the open and through the pines, meadow and forest birds by day, crickets at
 * night, the river along its banks, the riffle at the fords, the falls, the campfire), and the horse: hoofbeats
 * fired by the gait's own footfalls (a synthesised knock of hoof on ground layered over the ground's sample, pitched
 * down), the rush of air and the drum of the gallop, breathing and snorts. Files stream in after the valley is up.
 */
import * as THREE from 'three/webgpu';
import type { Heightfield } from '../world/Heightfield';

const BASE = './assets/audio/';

interface Layer { name: string; files: string[]; gain: GainNode; src: AudioBufferSourceNode | null; target: number; level: number; max: number }

export type Ground = 'grass' | 'dirt' | 'stone' | 'water' | 'forest';
const GROUND_FILES: Record<Ground, string[]> = {
  grass: ['step_grass_1', 'step_grass_2', 'step_grass_3', 'step_grass_4'],
  forest: ['step_leaves_1', 'step_leaves_2', 'step_leaves_3', 'step_leaves_4'],
  dirt: ['step_gravel_1', 'step_gravel_2', 'step_gravel_3', 'step_gravel_4'],
  stone: ['step_stone_1', 'step_stone_2', 'step_stone_3', 'step_stone_4'],
  water: ['step_water_1', 'step_water_2', 'step_water_3', 'step_water_4'],
};
/** how hard a hoof rings on each ground (the synthesised knock) */
const KNOCK: Record<Ground, number> = { grass: 0.35, forest: 0.3, dirt: 0.75, stone: 1.0, water: 0.15 };

export class AudioSystem {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private bus!: GainNode;
  private layers: Layer[] = [];
  private buffers = new Map<string, AudioBuffer>();
  private loading = new Set<string>();
  private noise: AudioBuffer | null = null;
  muted = false;
  hoofs = 0;
  private started = false;
  readonly fallsPos = new THREE.Vector3();
  readonly campPos = new THREE.Vector3();
  /** ford centres (the riffle) */
  fords: THREE.Vector3[] = [];
  private nextLark = 8;
  private nextSnort = 12;
  private breathT = 0;

  constructor(private hf: Heightfield) {}

  start() {
    if (this.started) return;
    this.started = true;
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    this.bus = this.ctx.createGain();
    this.bus.connect(comp).connect(this.master).connect(this.ctx.destination);
    const n = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const L = (name: string, files: string[], max: number) => {
      const gain = this.ctx!.createGain();
      gain.gain.value = 0;
      gain.connect(this.bus);
      this.layers.push({ name, files, gain, src: null, target: 0, level: 0, max });
    };
    L('wind', ['amb_wind'], 0.45);
    L('pines', ['amb_wind_pines'], 0.5);
    L('birds', ['amb_forest_birds_morning'], 0.5);
    L('meadow', ['amb_birds'], 0.32);
    L('night', ['amb_night_crickets'], 0.5);
    L('river', ['amb_river_calm'], 0.55);
    L('riffle', ['amb_river_riffle'], 0.6);
    L('falls', ['amb_waterfall'], 1.0);
    L('fire', ['amb_campfire'], 0.5);
    // the rush of air past the ears at speed (the wind loop again, its own gain, band-passed later by speed)
    L('rush', ['amb_wind'], 0.75);
    for (const l of this.layers) this.load(l.files[0]).then((b) => b && this.loop(l, b));
    for (const list of Object.values(GROUND_FILES)) for (const f of list) this.load(f);
    for (const f of ['splash_big', 'splash_small', 'sfx_bird_meadowlark_01', 'sfx_bird_meadowlark_02', 'sfx_owl_hoot_01', 'sfx_owl_hoot_02']) this.load(f);
  }

  private async load(name: string): Promise<AudioBuffer | null> {
    if (this.buffers.has(name)) return this.buffers.get(name)!;
    if (this.loading.has(name) || !this.ctx) return null;
    this.loading.add(name);
    try {
      const r = await fetch(`${BASE}${name}.ogg`);
      if (!r.ok) return null;
      const b = await this.ctx.decodeAudioData(await r.arrayBuffer());
      this.buffers.set(name, b);
      return b;
    } catch {
      return null;
    } finally {
      this.loading.delete(name);
    }
  }

  private loop(l: Layer, b: AudioBuffer) {
    if (!this.ctx) return;
    const src = this.ctx.createBufferSource();
    src.buffer = b;
    src.loop = true;
    src.connect(l.gain);
    src.start(0, Math.random() * b.duration);
    l.src = src;
  }

  /** where the game's own synthesised sounds go (the same bus and compressor as the rest) */
  sfxOut(): AudioNode {
    return this.bus;
  }

  mute(m: boolean) {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05);
  }

  /** per frame: listener pose and the mix. `speed` is the horse's ground speed (m/s), `gallop` 0..1 */
  update(dt: number, camera: THREE.Camera, w: { night: number; hour: number; wind: number; speed: number; gallop: number }) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const p = camera.position;
    const lis = ctx.listener;
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    const t = ctx.currentTime;
    if (lis.positionX) {
      lis.positionX.setTargetAtTime(p.x, t, 0.05);
      lis.positionY.setTargetAtTime(p.y, t, 0.05);
      lis.positionZ.setTargetAtTime(p.z, t, 0.05);
      lis.forwardX.setTargetAtTime(fwd.x, t, 0.05);
      lis.forwardY.setTargetAtTime(fwd.y, t, 0.05);
      lis.forwardZ.setTargetAtTime(fwd.z, t, 0.05);
      lis.upX.value = 0;
      lis.upY.value = 1;
      lis.upZ.value = 0;
    }
    const hf = this.hf;
    const forest = hf.forest(p.x, p.z);
    const day = 1 - w.night;
    const water = Math.max(0, hf.shoreDist(p.x, p.z));
    const dFalls = p.distanceTo(this.fallsPos);
    const dFire = p.distanceTo(this.campPos);
    let dFord = 1e9;
    for (const f of this.fords) dFord = Math.min(dFord, Math.hypot(p.x - f.x, p.z - f.z));
    const ground = p.y - hf.height(p.x, p.z);
    const set = (name: string, v: number) => {
      const l = this.layers.find((x) => x.name === name);
      if (l) l.target = THREE.MathUtils.clamp(v, 0, 1) * l.max;
    };
    const chorus = Math.exp(-(((w.hour - 6.3) / 0.9) ** 2)) + 0.4 * Math.exp(-(((w.hour - 18.4) / 0.6) ** 2));
    set('wind', (0.35 + 0.45 * w.wind) * (1 - forest * 0.5) + 0.3 * THREE.MathUtils.smoothstep(ground, 5, 60));
    set('pines', forest * (0.5 + 0.5 * w.wind));
    set('birds', Math.min(1, day * 0.6 + chorus) * (0.2 + 0.8 * forest));
    set('meadow', Math.min(1, day * 0.7 + chorus * 0.5) * (1 - forest) * 0.8);
    set('night', w.night * 0.9);
    set('river', THREE.MathUtils.clamp(1 - water / 60, 0, 1) ** 1.5 * (dFalls > 60 ? 1 : 0.4));
    set('riffle', THREE.MathUtils.clamp(1 - dFord / 55, 0, 1) ** 1.3);
    set('falls', THREE.MathUtils.clamp(1 - dFalls / 230, 0, 1) ** 1.6);
    set('fire', THREE.MathUtils.clamp(1 - dFire / 30, 0, 1) ** 1.5 * (0.5 + 0.5 * w.night));
    set('rush', THREE.MathUtils.smoothstep(w.speed, 4, 13) * (0.4 + 0.6 * w.gallop));
    const k = 1 - Math.exp(-dt * 2.5);
    for (const l of this.layers) {
      l.level += (l.target - l.level) * k;
      l.gain.gain.setTargetAtTime(this.muted ? 0 : l.level, t, 0.08);
    }
    // the odd meadowlark over the open grass by day, an owl at night; the horse snorts now and then, breathes hard at
    // a gallop
    this.nextLark -= dt;
    if (this.nextLark < 0) {
      this.nextLark = 9 + Math.random() * 16;
      if (day > 0.5 && forest < 0.4) this.play(`sfx_bird_meadowlark_0${1 + Math.floor(Math.random() * 2)}`, 0.22, 1, 0, p.clone().add(new THREE.Vector3((Math.random() - 0.5) * 80, 2, (Math.random() - 0.5) * 80)));
      else if (w.night > 0.7 && Math.random() < 0.5) this.play(`sfx_owl_hoot_0${1 + Math.floor(Math.random() * 2)}`, 0.2, 1, 0, p.clone().add(new THREE.Vector3(60, 10, -40)));
    }
    this.nextSnort -= dt;
    if (this.nextSnort < 0) {
      this.nextSnort = 14 + Math.random() * 22;
      if (w.speed < 3) this.snort();
    }
    if (w.gallop > 0.5) {
      this.breathT -= dt;
      if (this.breathT < 0) {
        this.breathT = 0.95 + Math.random() * 0.1;
        this.breath(0.12 * w.gallop);
      }
    }
  }

  private play(name: string, gain: number, rate = 1, delay = 0, pos?: THREE.Vector3, lowpass?: number) {
    const ctx = this.ctx;
    const b = this.buffers.get(name);
    if (!ctx || !b || this.muted) return;
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    let node: AudioNode = src;
    if (lowpass) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lowpass;
      node.connect(f);
      node = f;
    }
    node.connect(g);
    if (pos) {
      const pn = ctx.createPanner();
      pn.panningModel = 'equalpower';
      pn.refDistance = 2;
      pn.positionX.value = pos.x;
      pn.positionY.value = pos.y;
      pn.positionZ.value = pos.z;
      g.connect(pn).connect(this.bus);
    } else g.connect(this.bus);
    src.start(ctx.currentTime + delay);
  }

  /** a filtered noise burst: the synthesised parts of the horse */
  private burst(dur: number, gain: number, f0: number, f1: number, q: number, attack = 0.004, pos?: THREE.Vector3) {
    const ctx = this.ctx;
    if (!ctx || !this.noise || this.muted) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g);
    if (pos) {
      const pn = ctx.createPanner();
      pn.panningModel = 'equalpower';
      pn.refDistance = 2;
      pn.positionX.value = pos.x;
      pn.positionY.value = pos.y;
      pn.positionZ.value = pos.z;
      g.connect(pn).connect(this.bus);
    } else g.connect(this.bus);
    src.start(t, Math.random() * 1.5, dur + 0.05);
  }

  /** one hoof striking the ground: `force` 0..1 grows with the gait */
  hoof(ground: Ground, force: number, pos: THREE.Vector3) {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    this.hoofs++;
    const list = GROUND_FILES[ground];
    this.play(list[Math.floor(Math.random() * list.length)], 0.25 + 0.4 * force, 0.62 + Math.random() * 0.1, 0, pos);
    const k = KNOCK[ground];
    // the knock: a short hollow click, a dull thud under it (the weight), louder at speed
    this.burst(0.05, 0.25 * k * (0.5 + force), 1700 + Math.random() * 500, 700, 6, 0.002, pos);
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(95 + Math.random() * 15, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16 * (0.35 + force), t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    o.connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + 0.16);
    if (ground === 'water') this.play(Math.random() < 0.3 + force * 0.4 ? 'splash_small' : list[0], 0.25 + 0.35 * force, 0.9 + Math.random() * 0.2, 0, pos);
  }

  snort() {
    this.burst(0.42, 0.18, 900, 380, 1.2, 0.03);
    setTimeout(() => this.burst(0.25, 0.1, 700, 300, 1.4, 0.02), 450);
  }

  breath(gain: number) {
    this.burst(0.32, gain, 600, 300, 0.9, 0.06);
  }

  splash(strength: number, pos: THREE.Vector3) {
    this.play(strength > 0.6 ? 'splash_big' : 'splash_small', 0.4 + strength * 0.5, 0.9 + Math.random() * 0.2, 0, pos);
  }

  /** the whistle-call answer and the like: a short soft nicker */
  nicker() {
    for (let i = 0; i < 4; i++) setTimeout(() => this.burst(0.09, 0.08, 520, 420, 4, 0.01), i * 85);
  }

  // ---- round 19: the jump's voice and the standing horse's small sounds

  /** take-off: a sharp blown snort through the nostrils, and now and then a short whinny over it */
  jumpSnort(pos?: THREE.Vector3) {
    this.burst(0.16, 0.3, 1500, 520, 1.6, 0.008, pos);
    setTimeout(() => this.burst(0.12, 0.16, 1150, 460, 1.8, 0.006, pos), 120 + Math.random() * 60);
    if (Math.random() < 0.55) this.whinny(0.06 + Math.random() * 0.03, 0.06);
  }

  /** a short whinny: a voiced squeal that rises, wavers and falls away */
  whinny(gain: number, delay = 0) {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const t = ctx.currentTime + delay, dur = 0.5 + Math.random() * 0.25;
    const f0 = 600 + Math.random() * 140;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.linearRampToValueAtTime(f0 * 1.9, t + dur * 0.22);
    o.frequency.linearRampToValueAtTime(f0 * 1.55, t + dur * 0.6);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.75, t + dur);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 9 + Math.random() * 4;
    const lg = ctx.createGain();
    lg.gain.value = f0 * 0.07;
    lfo.connect(lg).connect(o.frequency);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.04);
    g.gain.setValueAtTime(gain, t + dur * 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(bp).connect(g).connect(this.bus);
    o.start(t);
    lfo.start(t);
    o.stop(t + dur + 0.05);
    lfo.stop(t + dur + 0.05);
  }

  /** landing: the whole weight coming down, a deep thud with the ground's shudder under it */
  landThud(impact: number, pos?: THREE.Vector3) {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const k = 0.5 + 0.5 * impact;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(72 + Math.random() * 10, t);
    o.frequency.exponentialRampToValueAtTime(32, t + 0.3);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.42 * k, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    o.connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + 0.36);
    this.burst(0.2, 0.3 * k, 240, 90, 0.9, 0.003, pos);
    this.burst(0.06, 0.12 * k, 1300, 600, 4, 0.002, pos);
  }

  /** the saddle taking her weight: a run of dry leather creaks */
  saddleCreak(gain = 0.1) {
    let at = 60 + Math.random() * 40;
    const n = 5 + Math.floor(Math.random() * 5);
    for (let i = 0; i < n; i++) {
      const f = 900 + Math.random() * 700;
      const d = 0.03 + Math.random() * 0.04, gg = gain * (0.6 + Math.random() * 0.6), q = 10 + Math.random() * 6;
      setTimeout(() => this.burst(d, gg, f, f * (0.75 + Math.random() * 0.2), q, 0.004), at);
      at += 25 + Math.random() * 60;
    }
  }

  /** standing: a soft snort, sometimes a second, smaller puff after it */
  softSnort(pos?: THREE.Vector3) {
    this.burst(0.3 + Math.random() * 0.15, 0.06 + Math.random() * 0.04, 750 + Math.random() * 200, 320, 1.3, 0.025, pos);
    if (Math.random() < 0.4) setTimeout(() => this.burst(0.18, 0.04, 650, 300, 1.4, 0.02, pos), 380 + Math.random() * 120);
  }

  state() {
    return {
      running: this.ctx?.state ?? 'none',
      muted: this.muted,
      layers: Object.fromEntries(this.layers.map((l) => [l.name, { gain: +l.level.toFixed(3), loaded: !!l.src }])),
      hoofs: this.hoofs,
      buffers: this.buffers.size,
    };
  }
}
