// The bot tour: the horse rides the trail loop through every landmark on autopilot (camp, ford, falls, obelisk,
// ruins, the lone column, the statue head, back to camp), first person, with a first-person and a cinematic
// screenshot at each landmark, and the frame rate over the whole ride.
// node scripts/valley-tour.mjs [outdir] [--speed=10] [--tod=16.6] [--daylen=240] (minutes for a full 24 h day)
import { startValley } from './lib/vharness.mjs';
import fs from 'node:fs';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const out = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'build/tour';
fs.mkdirSync(out, { recursive: true });
const speed = Number(arg('speed', 10));
const h = await startValley({ query: `test=1&mute=1&tod=${arg('tod', '16.2')}&daylen=${arg('daylen', '240')}${process.argv.includes('--uncapped') ? '&fps=0' : ''}` });
const { page } = h;
try {
  const route = await page.evaluate((speed) => {
    const v = window.__valley, T = v.THREE;
    const SPOT = { camp: [112, -52], obelisk: [-372, -452], ruins: [-400, 220], bones: [70, 400], statue: [360, -160] };
    const pts = [];
    for (const path of v.PATHS) for (const [x, z] of path) {
      // waypoints on a landmark's centre (its colliders) go to the spot beside it instead
      let p = [x, z];
      for (const s of v.SITES) if (s.r > 0 && Math.hypot(x - s.p[0], z - s.p[1]) < 4 && SPOT[s.name]) p = SPOT[s.name];
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(last.x - p[0], last.y - p[1]) > 3) pts.push(new T.Vector2(p[0], p[1]));
    }
    // (the route starts at the camp, wherever the game spawns)
    v.ride.place(pts[0].x, pts[0].y, Math.atan2(pts[1].x - pts[0].x, pts[1].y - pts[0].y));
    v.ride.auto = { pts, i: 1, speed, done: false };
    return pts.length;
  }, speed);
  console.log(`[tour] ${route} waypoints at ${speed} m/s`);
  const marks = await page.evaluate(() => window.__valley.valley.landmarks.map((l) => ({ name: l.name, x: l.x, z: l.z })));
  const shot = new Set();
  const t0 = Date.now();
  const fpsLog = [];
  await page.evaluate(() => window.__valley.engine.resetPacing?.());
  let lastStat = Date.now();
  for (;;) {
    await page.waitForTimeout(500);
    const s = await page.evaluate(() => { const r = window.__valley.ride; return { h: window.__valley.tod.hour, x: r.pos.x, z: r.pos.z, done: r.auto.done, i: r.auto.i, n: r.auto.pts.length, sp: r.horse.speed, d: r.depth }; });
    for (const m of marks) {
      if (shot.has(m.name) || Math.hypot(s.x - m.x, s.z - m.z) > (m.name === 'falls' ? 40 : m.name === 'statue' ? 58 : 45)) continue;
      shot.add(m.name);
      // the rider turns their head toward the landmark (within the neck's reach), and the cinematic camera frames it
      // past the horse
      const aim = (m) => { const r = window.__valley.ride; let d = Math.atan2(m.x - r.pos.x, m.z - r.pos.z) - r.horse.heading; d = Math.atan2(Math.sin(d), Math.cos(d)); return d; };
      await page.evaluate(`(() => { const r = window.__valley.ride; const d = (${aim})(${JSON.stringify(m)}); r.lookYaw = Math.max(-1.6, Math.min(1.6, d)); })()`);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${out}/${m.name}-fp.png` });
      await page.evaluate(`(() => { const r = window.__valley.ride; r.setView('cinematic'); r.cine.yaw = (${aim})(${JSON.stringify(m)}); r.cine.dist = 9; r.cine.pitch = 0.16; })()`);
      await page.waitForTimeout(1800);
      await page.screenshot({ path: `${out}/${m.name}-cine.png` });
      await page.evaluate(() => { const r = window.__valley.ride; r.setView('first'); r.lookYaw = 0; r.cine.yaw = 0; r.cine.dist = 6.5; r.cine.pitch = 0.19; });
      console.log(`[tour] ${m.name} at ${((Date.now() - t0) / 1000).toFixed(0)} s (waypoint ${s.i}/${s.n})`);
    }
    if (Date.now() - lastStat > 10000) {
      lastStat = Date.now();
      const st = await page.evaluate(() => window.__valley.stats().fps);
      fpsLog.push(st);
      console.log(`[tour] ${((Date.now() - t0) / 1000).toFixed(0)} s ${s.h.toFixed(2)} h wp ${s.i}/${s.n} pos ${s.x.toFixed(0)},${s.z.toFixed(0)} speed ${s.sp.toFixed(1)} depth ${s.d.toFixed(2)} fps ${st.toFixed(1)}`);
    }
    if (s.done || Date.now() - t0 > Number(arg('limit', 900)) * 1000) break;
  }
  const missed = marks.filter((m) => !shot.has(m.name)).map((m) => m.name);
  const avg = fpsLog.reduce((a, b) => a + b, 0) / Math.max(1, fpsLog.length);
  const jumps = await page.evaluate(() => ({ jumps: window.__valley.ride.jumps, refusals: window.__valley.ride.refusals, done: window.__valley.ride.auto.done }));
  console.log(`[tour] jumps ${jumps.jumps} refusals ${jumps.refusals} route complete ${jumps.done}`);
  console.log(`[tour] done in ${((Date.now() - t0) / 1000).toFixed(0)} s; landmarks ${shot.size}/${marks.length}${missed.length ? ' missed ' + missed.join(',') : ''}; fps avg ${avg.toFixed(1)} min ${Math.min(...fpsLog).toFixed(1)}`);
  fs.writeFileSync(`${out}/tour.json`, JSON.stringify({ speed, landmarks: [...shot], missed, fps: fpsLog, avg, ...jumps }, null, 1));
  h.assertClean();
  await h.teardown(0);
} catch (e) { await h.teardown(1, e); }
