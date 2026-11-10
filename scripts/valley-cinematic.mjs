// The cinematic: rendered frame by frame (the engine in manual mode, stepped exactly 1/60 s per frame, each frame the
// mean of `accum` jittered renders), so it is smooth at 60 fps whatever the GPU's load. A scripted camera per shot
// (the game's test camera hook, run after the ride's), a time-lapse clock across the whole film, the horse on the
// game's own autopilot. The game's sound calls (hooves, splashes, the jump) are logged per frame for the soundtrack,
// which an offline mixer can build (none is kept in this repo yet).
//   node scripts/valley-cinematic.mjs [--preview] [--only=meadow,forest] [--every=30] [--accum=4]
import { startValley } from './lib/vharness.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const preview = process.argv.includes('--preview');
const only = arg('only', '');
const every = Number(arg('every', 30));
const accum = Number(arg('accum', preview ? 0 : 4));
const WORK = 'build/cine';
const prevDir = `${WORK}/prev`;
fs.mkdirSync(prevDir, { recursive: true });
fs.mkdirSync(`${WORK}/frames`, { recursive: true });
const FPS = 60;
// frames kept for review (global seconds)
const KEEP = { 1.5: 'hero-sunset', 8.5: 'meadow-sunrise', 19.75: 'forest-jump', 31: 'river-crossing', 58: 'statue-orbit', 84: 'night-moon' };

const h = await startValley({ query: `capture=1&accum=${accum}&hud=0&tod=16.62` });
const { page } = h;
let ff = null;
process.on('exit', () => { try { ff?.kill(); } catch {} });
try {
  await page.evaluate(PAGE, { only });
  const total = await page.evaluate(() => window.__cine.total());
  const nFrames = Math.round(total * FPS);
  console.log(`[cine] ${total.toFixed(2)} s, ${nFrames} frames, accum ${accum}, ${preview ? 'preview' : 'full'}`);
  const cdp = await page.context().newCDPSession(page);
  if (!preview) {
    ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', 'pipe:0',
      '-c:v', 'h264_nvenc', '-preset', 'p7', '-tune', 'hq', '-rc', 'vbr', '-cq', '16', '-b:v', '0', '-maxrate', '90M', '-bufsize', '180M',
      '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', '120', '-bf', '3', `${WORK}/video.mp4`], { stdio: ['pipe', 'inherit', 'inherit'] });
    ff.on('error', (e) => { throw e; });
  }
  const log = [];
  const t0 = Date.now();
  const keepAt = new Map(Object.entries(KEEP).map(([s, n]) => [Math.round(Number(s) * FPS), n]));
  for (let f = 0; f < nFrames; f++) {
    const st = await page.evaluate(() => window.__cine.step());
    log.push(st);
    const want = !preview || f % every === 0;
    if (want) {
      const shot = await cdp.send('Page.captureScreenshot', preview
        ? { format: 'jpeg', quality: 80, clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 0.5 } }
        : { format: 'png', optimizeForSpeed: true });
      const buf = Buffer.from(shot.data, 'base64');
      if (preview) fs.writeFileSync(`${prevDir}/${String(f).padStart(5, '0')}-${st.shot}.jpg`, buf);
      else {
        if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
        if (keepAt.has(f)) fs.writeFileSync(`${WORK}/frames/${String(f / FPS).padStart(4, '0')}s-${keepAt.get(f)}.png`, buf);
      }
    }
    if (f % 300 === 0) console.log(`[cine] frame ${f}/${nFrames} ${st.shot} tod ${st.tod.toFixed(2)} speed ${st.sp.toFixed(1)} ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  fs.writeFileSync(`${WORK}/log${preview ? '-prev' : ''}.json`, JSON.stringify(log));
  if (ff) { ff.stdin.end(); await new Promise((r) => ff.on('close', r)); ff = null; }
  h.assertClean();
  console.log(`[cine] done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  await h.teardown(0);
} catch (e) { await h.teardown(1, e); }

// ------------------------------------------------------------------------------------------------ the page side
function PAGE({ only }) {
  const v = window.__valley, T = v.THREE, ride = v.ride, hz = ride.horse, eng = v.engine;
  const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
  const gy = (x, z) => v.hf.height(x, z);
  const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const lerp = (a, b, k) => a + (b - a) * k;
  const DT = 1 / 60;
  eng.manual = true;

  // the time-lapse: hour by film second, a monotone cubic through the knots (no jumps, no sudden changes of pace)
  const K = [[3, 6.4], [16, 7.35], [26, 9.4], [38, 14.6], [48, 16.45], [63, 17.3], [73, 17.85], [87, 20.4]];
  const slopes = (() => {
    const n = K.length, d = [], m = [];
    for (let i = 0; i < n - 1; i++) d.push((K[i + 1][1] - K[i][1]) / (K[i + 1][0] - K[i][0]));
    m.push(d[0]);
    for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (2 * d[i - 1] * d[i]) / (d[i - 1] + d[i]));
    m.push(d[n - 2]);
    return m;
  })();
  const todAt = (t) => {
    if (t <= K[0][0]) return K[0][1];
    if (t >= K[K.length - 1][0]) return K[K.length - 1][1];
    let i = 0;
    while (t > K[i + 1][0]) i++;
    const [x0, y0] = K[i], [x1, y1] = K[i + 1], hh = x1 - x0, s = (t - x0) / hh;
    const h00 = 2 * s ** 3 - 3 * s ** 2 + 1, h10 = s ** 3 - 2 * s ** 2 + s, h01 = -2 * s ** 3 + 3 * s ** 2, h11 = s ** 3 - s ** 2;
    return h00 * y0 + h10 * hh * slopes[i] + h01 * y1 + h11 * hh * slopes[i + 1];
  };

  // the horse as the camera sees it: rendered position, heading, its forward, left and up
  const H = { p: V(), f: V(), l: V(), up: V(0, 1, 0) };
  const horseNow = () => {
    hz.root.getWorldPosition(H.p);
    const hd = hz.heading;
    H.f.set(Math.sin(hd), 0, Math.cos(hd));
    H.l.set(Math.cos(hd), 0, -Math.sin(hd));
    return H;
  };
  const along = (pts, d) => {
    // a point d metres along a polyline (pts [[x,z]...])
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1], L = Math.hypot(bx - ax, bz - az);
      if (d <= L || i + 2 === pts.length) { const k = d / L; return V(ax + (bx - ax) * k, 0, az + (bz - az) * k); }
      d -= L;
    }
  };
  // a camera behind a wall or a column comes in along the ray from the subject, short of it
  const clear = (from, want) => {
    const d = want.clone().sub(from), L = d.length();
    d.normalize();
    const hit = v.colliders.raycast(from, d, L);
    return hit < L ? from.clone().addScaledVector(d, Math.max(2.2, hit - 0.8)) : want;
  };
  const ground = (p, y) => p.setY(Math.max(gy(p.x, p.z), v.hf.waterLevel(p.x, p.z)) + y);

  const go = (pts, speed, back = 0) => {
    const [a, b] = pts;
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
    const sx = a[0] - (dx / L) * back, sz = a[1] - (dz / L) * back;
    ride.place(sx, sz, Math.atan2(dx, dz));
    hz.speed = speed;
    ride.auto = { pts: [new T.Vector2(sx, sz), ...pts.map(([x, z]) => new T.Vector2(x, z))], i: 1, speed, done: false };
    ride.bestD = 1e9; ride.stuck = 0;
    ride.setView('cinematic');
    ride.cine.yaw = 0;
  };

  // ---------------------------------------------------------------- the shots
  // each: dur (s), pre (s of pre-roll before the first frame, the gait and camera settled), setup(), cam(u) -> {pos, tgt,
  // fov, kp, kt} or null (the game's own chase camera), tod (fixed hour) or the film clock
  const SHOTS = [];
  const add = (s) => SHOTS.push(s);

  // 0. the hero frame: the sunset trail (rdr r8), the game's own chase camera
  add({ name: 'hero', dur: 3, pre: 1.6, tod: 16.62,
    setup() { go([[405, 600], [125, 498]], 1.75, 6); },
    cam: () => null,
    fade: (u) => Math.max(1 - u / 0.5, ss(2.55, 3.0, u)) });

  // 1. the golden meadow at sunrise: a crane high over the meadow ahead, down to a low track beside the gallop
  const M = [[272, -520], [258, -900]];
  add({ name: 'meadow', dur: 13, pre: 1.2,
    setup() { go(M, 10, 0); },
    cam(u) {
      const h = horseNow();
      const A = along(M, 78).addScaledVector(h.l, 22); ground(A, 9);
      const B = h.p.clone().addScaledVector(h.l, 6.5).addScaledVector(h.f, 1.5); ground(B, 1.15);
      const w = ss(1.5, 8, u);
      return { pos: A.lerp(B, w), tgt: h.p.clone().addScaledVector(h.f, 2.5 * w).setY(h.p.y + 1.35), fov: lerp(38, 40, w), kp: lerp(2, 4, w), kt: 6 };
    },
    fade: (u) => 1 - ss(0, 0.5, u) });

  // 2. the forest edge: the camera beside the log, panning with the gallop, the jump across the frame; then behind
  const LOG = V(-111, 0, -138), Fd = V(24, 0, 90).normalize(), Fp = V(Fd.z, 0, -Fd.x);
  add({ name: 'forest', dur: 10, pre: 1.0,
    setup() { go([[-111 - Fd.x * 46, -138 - Fd.z * 46], [-104, -110], [-30, -56]], 10, 0); },
    cam(u) {
      const h = horseNow();
      const s = h.p.clone().sub(LOG).dot(Fd);
      const C = LOG.clone().addScaledVector(Fp, 9).addScaledVector(Fd, 3 + THREE_clamp(s, -40, 40) * 0.3); ground(C, 2.1);
      const B = h.p.clone().addScaledVector(h.f, -8).addScaledVector(Fp, 3); ground(B, 2.3);
      const w = ss(6.2, 9.6, u);
      return { pos: C.lerp(B, w), tgt: h.p.clone().addScaledVector(h.f, 2 * w).setY(h.p.y + 1.25), fov: 40, kp: 3, kt: 7 };
    } });

  // 3. the river crossing: a low track on the bank side, from ahead of the horse round to its shoulder, water level
  const R = [[2, -28.5], [38, -20], [62, -26], [96, -44]];
  add({ name: 'river', dur: 12, pre: 1.0,
    setup() { go(R, 5, 0); },
    cam(u) {
      const h = horseNow();
      const B = h.p.clone().addScaledVector(h.l, -5.8).addScaledVector(h.f, lerp(4.5, 0.2, ss(0, 12, u))); ground(B, 0.85);
      return { pos: B, tgt: h.p.clone().addScaledVector(h.f, 1.2).setY(h.p.y + 1.1), fov: 42, kp: 3, kt: 6 };
    } });

  // 4. the ruins and the archways, golden hour: south of the horse, the arches behind it
  const RU = [[-430.5, 171.8], [-432, 186], [-416, 214], [-392, 232], [-360, 250]];
  add({ name: 'ruins', dur: 10, pre: 1.0,
    setup() { go(RU, 3.4, 0); },
    cam(u) {
      const h = horseNow();
      const B = h.p.clone().add(V(lerp(-4, 1.5, ss(0, 10, u)), 0, -9.5)); ground(B, 1.6);
      return { pos: clear(h.p.clone().setY(h.p.y + 1.6), B), tgt: h.p.clone().add(V(0, 1.6, 6)), fov: 44, kp: 2.5, kt: 4 };
    } });

  // 5. the crowned statue at sunset: a slow orbit about it, the horse trotting past in the foreground
  const S = V(392, 0, -196);
  add({ name: 'statue', dur: 15, pre: 1.0,
    setup() { go([[402, -134], [380, -170], [373, -198], [378, -228]], 4.5, 0); },
    cam(u) {
      const h = horseNow();
      // (a slow orbit round her as she passes the statue: from ahead-left to behind-left, the crowned head beyond her)
      const a = lerp(1.0, -0.75, ss(-1, 16, u));
      const off = h.l.clone().multiplyScalar(Math.cos(a) * 10).addScaledVector(h.f, Math.sin(a) * 10);
      const C = h.p.clone().add(off); ground(C, 2.0 + 1.2 * ss(0, 15, u));
      const st = S.clone(); ground(st, 7);
      return { pos: C, tgt: h.p.clone().setY(h.p.y + 1.4).lerp(st, 0.22), fov: 46, kp: 2.5, kt: 3 };
    } });

  // 6. sunset, high and wide: the gallop toward the low sun and the camp, the camera high behind it
  add({ name: 'highwide', dur: 10, pre: 1.0,
    setup() { go([[338, -168], [270, -130], [200, -96], [128, -70]], 10, 0); },
    cam(u) {
      const h = horseNow();
      // (a crane high over the trees, drifting after her)
      const f0 = V(270 - 338, 0, -130 + 168).normalize();
      const C = V(338, 0, -168).addScaledVector(f0, -16 + u * 3.5); ground(C, 34 + u * 0.6);
      return { pos: C, tgt: h.p.clone().addScaledVector(h.f, 24).setY(h.p.y + 1), fov: 50, kp: 2, kt: 2.5 };
    } });

  // 7. into the night meadow, toward the moon and the fireflies: the camera eases to a stop and lets her ride away
  add({ name: 'night', dur: 14, pre: 1.0,
    setup() { go([[170, -14], [420, -40]], 6, 0); },
    cam(u) {
      const h = horseNow();
      const B = h.p.clone().addScaledVector(h.f, -6.5).addScaledVector(h.l, 2.2); ground(B, 1.7);
      // (aimed between her and the moon, so both stay in the frame)
      const toH = h.p.clone().setY(h.p.y + 1.4).sub(cam.pos).normalize();
      const aim = toH.multiplyScalar(0.5).addScaledVector(v.tod.moon, 0.5).normalize();
      return { pos: B, tgt: cam.pos.clone().addScaledVector(aim, 30), fov: 54, kp: 4 * (1 - ss(4, 10, u)) + 0.001, kt: 2.5 };
    },
    fade: (u) => ss(11.2, 14, u) });

  function THREE_clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }

  const list = only ? SHOTS.filter((s) => only.split(',').includes(s.name)) : SHOTS;
  // film start time of each shot (the clock is the full film's, even when previewing a subset)
  let acc = 0; for (const s of SHOTS) { s.t0 = acc; acc += s.dur; }

  // the fade: a black sheet over the canvas
  const fade = document.createElement('div');
  fade.style.cssText = 'position:fixed;inset:0;background:#000;opacity:0;pointer-events:none;z-index:99999';
  document.body.appendChild(fade);

  // the camera: after the ride's, eased toward the shot's want
  const cam = { pos: V(), tgt: V(), fov: 40, ready: false, on: false };
  let cur = null, u = 0;
  window.__camHook = (c) => {
    if (!cur) return;
    const w = cur.cam(Math.max(0, u));
    if (!w) { cam.on = false; return; }
    cam.on = true;
    if (!cam.ready) { cam.pos.copy(w.pos); cam.tgt.copy(w.tgt); cam.fov = w.fov; cam.ready = true; }
    cam.pos.lerp(w.pos, 1 - Math.exp(-DT * w.kp));
    cam.tgt.lerp(w.tgt, 1 - Math.exp(-DT * w.kt));
    cam.fov += (w.fov - cam.fov) * (1 - Math.exp(-DT * 2));
    // never under the ground or the water
    cam.pos.y = Math.max(cam.pos.y, gy(cam.pos.x, cam.pos.z) + 0.5, v.hf.waterLevel(cam.pos.x, cam.pos.z) + 0.35);
    c.position.copy(cam.pos);
    c.lookAt(cam.tgt);
    if (Math.abs(c.fov - cam.fov) > 1e-3) { c.fov = cam.fov; c.updateProjectionMatrix(); }
  };

  // the game's sound calls, logged per frame
  const A = v.audio, events = [];
  for (const k of ['hoof', 'splash', 'jumpSnort', 'landThud', 'saddleCreak', 'breath', 'softSnort', 'snort', 'nicker']) {
    const f = A[k].bind(A);
    A[k] = (...a) => { events.push([k, ...a.map((x) => (x && x.isVector3 ? [+x.x.toFixed(2), +x.y.toFixed(2), +x.z.toFixed(2)] : x))]); return f(...a); };
  }

  let si = -1;
  const startShot = () => {
    si++;
    cur = list[si];
    u = -cur.pre;
    cam.ready = false;
    const hour = cur.tod ?? todAt(cur.t0);
    v.tod.setHour(hour);
    cur.setup();
    // the pre-roll: the gait, the dust, the camera and the world's streaming all settled at the new place
    while (u < 0) { v.tod.setHour(cur.tod ?? todAt(cur.t0)); eng.stepOnce(DT); u += DT; }
    u = 0;
  };
  window.__cine = {
    total: () => list.reduce((a, s) => a + s.dur, 0),
    step() {
      if (!cur || u >= cur.dur - 1e-6) startShot();
      const t = cur.t0 + u;
      const hour = cur.tod ?? todAt(t);
      v.tod.setHour(hour);
      fade.style.opacity = String(cur.fade ? Math.max(0, Math.min(1, cur.fade(u))) : 0);
      events.length = 0;
      eng.stepOnce(DT);
      horseNow();
      const out = { shot: cur.name, t: +t.toFixed(4), u: +u.toFixed(4), tod: hour, sp: hz.speed, gait: hz.gait, depth: ride.depth ?? 0,
        jump: !!ride.jump, p: [+H.p.x.toFixed(2), +H.p.y.toFixed(2), +H.p.z.toFixed(2)], cam: cam.pos.toArray().map((x) => +x.toFixed(2)),
        night: v.tod.night, ev: events.slice(), fade: +fade.style.opacity };
      u += DT;
      return out;
    },
  };
}
