// The trailer: ~25 s, 1920x1080, 60 fps. Rendered frame by frame in headless Chrome on the GPU (the engine in manual
// mode, stepped exactly 1/60 s per frame, each frame the mean of `accum` jittered renders), piped as PNG to NVENC.
// The soundtrack is the game's own AudioSystem rendered offline: every frame's listener pose and mix inputs and every
// sound call (hooves, breath, snorts) are logged during the picture pass, then replayed at their exact frame times
// into an OfflineAudioContext, and muxed with the picture.
//   node scripts/trailer.mjs [--preview] [--only=gallop,summit] [--every=20] [--accum=4] [--out=E:/Final-Video/x.mp4]
import { startValley } from './lib/vharness.mjs';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=') ?? d;
const preview = process.argv.includes('--preview');
const only = arg('only', '');
const every = Number(arg('every', 20));
const accum = Number(arg('accum', preview ? 0 : 4));
const OUT = arg('out', 'E:/Final-Video/valley-ride-cinematic.mp4');
const WORK = 'build/trailer';
const prevDir = `${WORK}/prev`;
fs.rmSync(prevDir, { recursive: true, force: true });
fs.mkdirSync(prevDir, { recursive: true });
const FPS = 60;

const h = await startValley({ query: `capture=1&accum=${accum}&hud=0&tod=16.95` });
const { page } = h;
let ff = null;
process.on('exit', () => { try { ff?.kill(); } catch {} });
try {
  await page.evaluate(PAGE, { only });
  const total = await page.evaluate(() => window.__cine.total());
  const nFrames = Math.round(total * FPS);
  console.log(`[trailer] ${total.toFixed(2)} s, ${nFrames} frames, accum ${accum}, ${preview ? 'preview' : 'full'}`);
  const cdp = await page.context().newCDPSession(page);
  if (!preview) {
    ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', 'pipe:0',
      '-c:v', 'h264_nvenc', '-preset', 'p7', '-tune', 'hq', '-rc', 'vbr', '-cq', '16', '-b:v', '0', '-maxrate', '90M', '-bufsize', '180M',
      '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
      '-g', '120', '-bf', '3', '-r', String(FPS), `${WORK}/video.mp4`], { stdio: ['pipe', 'inherit', 'inherit'] });
    ff.on('error', (e) => { throw e; });
  }
  // (the first shot's set-up and pre-roll before the loop, and a throwaway capture: the first one can be stale)
  await page.evaluate(() => window.__cine.prime());
  await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 10 });
  const log = [];
  const t0 = Date.now();
  for (let f = 0; f < nFrames; f++) {
    const st = await page.evaluate(() => window.__cine.step());
    log.push(st);
    if (!preview || f % every === 0) {
      const shot = await cdp.send('Page.captureScreenshot', preview
        ? { format: 'jpeg', quality: 82, clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 0.5 } }
        : { format: 'png', optimizeForSpeed: true });
      const buf = Buffer.from(shot.data, 'base64');
      if (preview) fs.writeFileSync(`${prevDir}/${String(f).padStart(4, '0')}-${st.shot}.jpg`, buf);
      else if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    }
    if (f % 120 === 0) console.log(`[trailer] frame ${f}/${nFrames} ${st.shot} u ${st.u.toFixed(2)} speed ${st.sp.toFixed(1)} ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  fs.writeFileSync(`${WORK}/log${preview ? '-prev' : ''}.json`, JSON.stringify(log));
  if (ff) { ff.stdin.end(); await new Promise((r) => ff.on('close', r)); ff = null; }
  h.assertClean();
  console.log(`[trailer] picture done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

  if (!preview) {
    // ---- the soundtrack: the game's AudioSystem in an OfflineAudioContext, the log replayed frame by frame
    const wav = await page.evaluate(SOUND, { log, total, fps: FPS });
    fs.writeFileSync(`${WORK}/audio.wav`, Buffer.from(wav, 'base64'));
    console.log(`[trailer] soundtrack rendered (${(wav.length * 0.75 / 1e6).toFixed(1)} MB)`);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    const mux = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', `${WORK}/video.mp4`, '-i', `${WORK}/audio.wav`,
      '-map', '0:v', '-map', '1:a', '-c:v', 'copy',
      '-af', `afade=t=in:d=0.08,afade=t=out:st=${(total - 1.6).toFixed(2)}:d=1.6,loudnorm=I=-18:TP=-1.5:LRA=11`,
      '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-shortest', '-movflags', '+faststart', OUT], { stdio: 'inherit' });
    if (mux.status !== 0) throw new Error('mux failed');
    console.log(`[trailer] wrote ${OUT}`);
  }
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
  // (no title, no hint, no finish card, no checkpoint chime: only the lanterns' glow keeps running)
  v.game.update = (dt, it, t) => { v.cps.update(dt, t); return it; };
  v.gameUI.hidden = true;
  v.gameUI.showHint(false);

  // the horse as the camera sees it: its ground point (no gait bob: the camera rides smooth), heading, forward, left
  const H = { p: V(), g: V(), f: V(), l: V(), r: V() };
  const horseNow = () => {
    hz.root.getWorldPosition(H.p);
    H.g.set(H.p.x, gy(H.p.x, H.p.z), H.p.z);
    const hd = hz.heading;
    H.f.set(Math.sin(hd), 0, Math.cos(hd));
    H.l.set(Math.cos(hd), 0, -Math.sin(hd));
    H.r.copy(H.l).negate();
    return H;
  };
  const az = (deg) => V(Math.sin(deg * Math.PI / 180), 0, Math.cos(deg * Math.PI / 180));
  const ground = (p, y) => p.setY(Math.max(gy(p.x, p.z), v.hf.waterLevel(p.x, p.z)) + y);

  const go = (pts, speed, back = 0) => {
    const [a, b] = pts;
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
    const sx = a[0] - (dx / L) * back, sz = a[1] - (dz / L) * back;
    ride.place(sx, sz, Math.atan2(dx, dz));
    hz.speed = speed;
    ride.auto = { pts: [new T.Vector2(sx, sz), ...pts.map(([x, z]) => new T.Vector2(x, z))], i: 1, speed, done: false };
    ride.bestD = 1e9; ride.stuck = 0;
    ride.endFocus = null;
    ride.setView('cinematic');
    ride.cine.yaw = 0;
    hz.person.gaze = null;
  };

  // ---------------------------------------------------------------- the shots
  // each: dur, pre (pre-roll: the gait, the camera and the world's streaming settled), tod, setup(), tick(u) before the
  // step, cam(u) -> { pos, tgt, fov, kp, kt, range, bokeh } (kp/kt 0: exact, no easing; one stage, never stacked)
  const SHOTS = [];
  const add = (s) => SHOTS.push(s);

  // 1+2. the gallop: locked low beside them, backlit, the long lens; then the camera lets go, pulls out and rises
  // over the meadow to show the valley round them
  const G = [[-400, -160], [-372, -60], [-394, 40]];
  add({ name: 'gallop', dur: 8, pre: 1.2, tod: 16.95,
    setup() { go(G, 10, 13); },
    cam(u) {
      const h = horseNow();
      const w = ss(3.2, 8.0, u);
      const A = h.g.clone().addScaledVector(h.l, 4.6).addScaledVector(h.f, 0.9 + 0.5 * ss(0, 3, u)); ground(A, 1.0);
      const B = h.g.clone().addScaledVector(h.l, 5).addScaledVector(h.f, -26); B.y = h.g.y + 22;
      const ta = h.g.clone().addScaledVector(h.f, 0.45).setY(h.g.y + 1.45);
      const tb = h.g.clone().addScaledVector(h.f, 60).addScaledVector(h.r, 2).setY(h.g.y - 7);
      // (the aim leaves her later than the camera does, so she stays in the frame all through the move)
      return { pos: A.lerp(B, w), tgt: ta.lerp(tb, ss(4.4, 8.0, u)), fov: lerp(34, 58, w), kp: 0, kt: 0, range: lerp(3, 80, w), bokeh: lerp(5, 0, ss(3.2, 6, u)) };
    } });

  // 3. backlit: down the forest path from the spawn, into the low sun, the camera low behind
  add({ name: 'forest', dur: 4, pre: 1.0, tod: 17.0,
    setup() { go([[-60, 390], [-170, 350]], 6.5, 7); },
    cam(u) {
      const h = horseNow();
      const B = h.g.clone().addScaledVector(h.f, -lerp(7.4, 5.6, u / 4)).addScaledVector(h.l, 1.5); ground(B, 1.3);
      return { pos: B, tgt: h.g.clone().addScaledVector(h.f, 30).setY(h.g.y + 2.6), fov: 46, kp: 0, kt: 0, range: 10, bokeh: 2.5 };
    } });

  // 4. the lanterns: a still camera past the first checkpoint, the gallop through the pair toward it, a pan after
  const CP = V(-170, 0, 350), dL = -113.2 * Math.PI / 180;
  const cf = V(Math.sin(dL), 0, Math.cos(dL)), cp = V(Math.cos(dL), 0, -Math.sin(dL));
  let passed = false;
  add({ name: 'lanterns', dur: 3.6, pre: 1.0, tod: 17.1,
    setup() { v.cps.reset(); passed = false; go([[-147.4, 358.2], [-170, 350], [-270, 300]], 10, 10); },
    tick() { const h = horseNow(); if (!passed && Math.hypot(h.p.x - CP.x, h.p.z - CP.z) < 3.5) { passed = true; v.cps.pass(0); } },
    cam(u) {
      const h = horseNow();
      const C = CP.clone().addScaledVector(cf, 7).addScaledVector(cp, 5.0); ground(C, 1.25);
      const mid = CP.clone(); ground(mid, 1.9);
      const tgt = mid.lerp(h.g.clone().setY(h.g.y + 1.4), ss(0.4, 3.0, u));
      return { pos: C, tgt, fov: 36, kp: 0, kt: 0, range: 8, bokeh: 2.5 };
    } });

  // 5a. the climb at sunset: low at the side of the steep trail, the sun behind them
  add({ name: 'climb', dur: 3.4, pre: 1.0, tod: 17.3,
    setup() { go([[-437, -290], [-430, -360], [-406, -386]], 6, 6); },
    cam(u) {
      const h = horseNow();
      const C = h.g.clone().addScaledVector(h.r, 8.5).addScaledVector(h.f, lerp(2.5, -0.5, u / 3.4)); C.y = Math.max(gy(C.x, C.z) + 1.5, h.g.y + 0.9);
      return { pos: C, tgt: h.g.clone().addScaledVector(h.f, 1.0).setY(h.g.y + 1.5), fov: 38, kp: 0, kt: 0, range: 8, bokeh: 2.5 };
    } });

  // 5b. the summit: in at a trot, down to a walk past the fire, the halt; she looks out over the valley into the
  // sunset and the camera drifts slowly back
  const F = v.valley.firePos.clone();
  // (the camera looks along az -60: the low sun 46 deg off to the right, its glow at the frame's edge; the fire in the
  // left foreground; she halts 9 m ahead, facing away, and turns her head right to the sunset)
  const dS = az(-60), lS = V(dS.z, 0, -dS.x);
  const P = F.clone().addScaledVector(az(-30), -5.5).addScaledVector(dS, 9);
  const S0 = P.clone().addScaledVector(dS, -12);
  add({ name: 'summit', dur: 6.6, pre: 0.8, tod: 17.42,
    setup() { go([[S0.x, S0.z], [P.x + dS.x * 2.8, P.z + dS.z * 2.8]], 3.9, 3.1); },
    tick(u) {
      if (ride.auto) ride.auto.speed = lerp(3.9, 1.75, ss(1.0, 2.6, u));
      hz.person.gaze = u > 3.0 ? { yaw: -0.55, pitch: 0.04 } : null;
    },
    cam(u) {
      const h = horseNow();
      const C = h.g.clone().addScaledVector(dS, -(8.5 + 0.45 * u)).addScaledVector(lS, 0.8); ground(C, 2.0 + 0.1 * u);
      return { pos: C, tgt: h.g.clone().addScaledVector(dS, 12).setY(h.g.y + 0.6), fov: 36, kp: 0, kt: 0, range: 25, bokeh: 1.2 };
    },
    fade: (u) => ss(5.2, 6.6, u) });

  const list = only ? SHOTS.filter((s) => only.split(',').includes(s.name)) : SHOTS;
  let acc = 0; for (const s of list) { s.t0 = acc; acc += s.dur; }

  // the fade: a black sheet over the canvas (only the last shot uses it)
  const fade = document.createElement('div');
  fade.style.cssText = 'position:fixed;inset:0;background:#000;opacity:0;pointer-events:none;z-index:99999';
  document.body.appendChild(fade);

  // the camera: after the ride's, the shot's want, eased only where the shot asks for it
  const cam = { pos: V(), tgt: V(), fov: 40, ready: false };
  const toS = V();
  let cur = null, u = 0;
  window.__camHook = (c) => {
    if (!cur) return;
    const w = cur.cam(Math.max(0, u));
    if (!cam.ready || !w.kp) cam.pos.copy(w.pos); else cam.pos.lerp(w.pos, 1 - Math.exp(-DT * w.kp));
    if (!cam.ready || !w.kt) cam.tgt.copy(w.tgt); else cam.tgt.lerp(w.tgt, 1 - Math.exp(-DT * w.kt));
    cam.fov = w.fov; cam.ready = true;
    // never under the ground or the water
    cam.pos.y = Math.max(cam.pos.y, gy(cam.pos.x, cam.pos.z) + 0.5, v.hf.waterLevel(cam.pos.x, cam.pos.z) + 0.35);
    c.position.copy(cam.pos);
    c.lookAt(cam.tgt);
    if (Math.abs(c.fov - cam.fov) > 1e-3) { c.fov = cam.fov; c.updateProjectionMatrix(); }
    // the lens: sharp on her (the distance along the view to the rider), the rest falling off by the shot's range
    c.getWorldDirection(toS);
    const d = H.p.clone().setY(H.p.y + 1.6).sub(cam.pos).dot(toS);
    eng.lens.focus.value = Math.max(1, d);
    eng.lens.range.value = w.range;
    eng.lens.bokeh.value = w.bokeh;
  };

  // the game's sound: every call and the per-frame mix inputs, logged for the offline soundtrack
  const A = v.audio, events = [];
  const vec = (x) => (x && x.isVector3 ? { v: [+x.x.toFixed(3), +x.y.toFixed(3), +x.z.toFixed(3)] } : x);
  for (const k of ['hoof', 'splash', 'jumpSnort', 'landThud', 'saddleCreak', 'breath', 'softSnort', 'snort', 'nicker', 'whinny']) {
    const f = A[k].bind(A);
    A[k] = (...a) => { events.push([k, ...a.map(vec)]); return f(...a); };
  }
  let mix = null;
  const upd = A.update.bind(A), dir = V();
  A.update = (dt, camera, w) => {
    camera.getWorldDirection(dir);
    mix = { p: camera.position.toArray().map((x) => +x.toFixed(3)), d: dir.toArray().map((x) => +x.toFixed(4)), w: { ...w } };
    return upd(dt, camera, w);
  };

  let si = -1;
  const startShot = () => {
    si++;
    cur = list[si];
    u = -cur.pre;
    cam.ready = false;
    v.tod.setHour(cur.tod);
    cur.setup();
    while (u < 0) { v.tod.setHour(cur.tod); cur.tick?.(Math.max(0, u)); eng.stepOnce(DT); u += DT; }
    u = 0;
  };
  window.__cine = {
    total: () => list.reduce((a, s) => a + s.dur, 0),
    async prime() { startShot(); for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r)); },
    async step() {
      if (!cur || u >= cur.dur - 1e-6) startShot();
      v.tod.setHour(cur.tod);
      fade.style.opacity = String(cur.fade ? Math.max(0, Math.min(1, cur.fade(u))) : 0);
      cur.tick?.(u);
      events.length = 0;
      eng.stepOnce(DT);
      horseNow();
      const out = { shot: cur.name, u: +u.toFixed(4), sp: hz.speed, p: [+H.p.x.toFixed(2), +H.p.y.toFixed(2), +H.p.z.toFixed(2)],
        mix, ev: events.slice(), fade: +fade.style.opacity };
      u += DT;
      // (the canvas reaches the compositor at the next frame: wait for it, or every capture is one step late)
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return out;
    },
  };
}

// ------------------------------------------------------------------------------------------------ the soundtrack
async function SOUND({ log, total, fps }) {
  const v = window.__valley, T = v.THREE;
  const rate = 48000;
  const ctx = new OfflineAudioContext(2, Math.ceil((total + 0.25) * rate), rate);
  const Sys = v.audio.constructor;
  const a = new Sys(v.hf);
  a.fallsPos.copy(v.audio.fallsPos);
  a.fords = v.audio.fords.map((p) => p.clone());
  a.campPos.copy(v.valley.firePos);
  a.start(ctx);
  await a.loaded();
  // (the game's update reads the camera's position and direction only)
  const camera = { position: new T.Vector3(), d: new T.Vector3(), getWorldDirection(o) { return o.copy(this.d); } };
  const arg = (x) => (x && typeof x === 'object' && x.v ? new T.Vector3(...x.v) : x);
  const dt = 1 / fps;
  log.forEach((st, f) => {
    ctx.suspend(f * dt).then(() => {
      if (st.mix) {
        camera.position.fromArray(st.mix.p);
        camera.d.fromArray(st.mix.d);
        a.update(dt, camera, st.mix.w);
      }
      for (const [k, ...args] of st.ev) a[k](...args.map(arg));
      ctx.resume();
    });
  });
  const buf = await ctx.startRendering();
  // 16-bit PCM WAV
  const n = buf.length, ch = 2, bytes = 44 + n * ch * 2;
  const out = new DataView(new ArrayBuffer(bytes));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, bytes - 8, true); str(8, 'WAVE'); str(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true); out.setUint32(24, rate, true);
  out.setUint32(28, rate * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
  str(36, 'data'); out.setUint32(40, n * ch * 2, true);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  for (let i = 0, o = 44; i < n; i++, o += 4) {
    out.setInt16(o, Math.max(-1, Math.min(1, L[i])) * 32767, true);
    out.setInt16(o + 2, Math.max(-1, Math.min(1, R[i])) * 32767, true);
  }
  const u8 = new Uint8Array(out.buffer);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
