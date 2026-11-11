// Valley Ride played through from the title to the summit, from the running game with its own camera and interface,
// at the game's own light (golden hour at the start, sunset at the summit). The rider is driven only through the
// player's input (W, Shift, A/D steering toward the trail ahead, Space for a log), never the autopilot.
//
//   node scripts/game-clips.mjs [outDir]
//     -> start.mp4   20 s: the title, the keys, the gallop to the first checkpoint
//     -> summit.mp4  15 s: the last of the climb, the fire, the halt and "valley crossed"
//     -> closeup.jpg      a sunset frame of her and the horse up close by the fire
import fs from 'node:fs';
import path from 'node:path';
import { startValley } from './lib/vharness.mjs';
import { holdCamera } from './lib/ridercam.mjs';
import { recorder } from './lib/clip.mjs';

const outDir = process.argv[2] ?? 'build/game-clips';
fs.mkdirSync(outDir, { recursive: true });
const h = await startValley({ query: 'test=1' });
const { page } = h;
const { record, killAll } = recorder(page);

/** in the page: steer for the trail 22 m ahead of the nearest point on the route, at a gallop, jumping logs */
const drive = () => page.evaluate(() => {
  const v = window.__valley, ride = v.ride, route = v.ROUTE;
  clearInterval(window.__drv);
  window.__drv = setInterval(() => {
    if (v.game.state === 'finish') { v.input.scripted = null; clearInterval(window.__drv); return; }
    const p = ride.pos;
    // nearest point on the route, then 22 m on along it
    let best = Infinity, bi = 0, bu = 0;
    for (let i = 0; i + 1 < route.length; i++) {
      const [ax, az] = route[i], [bx, bz] = route[i + 1];
      const L = Math.hypot(bx - ax, bz - az), tx = (bx - ax) / L, tz = (bz - az) / L;
      const u = Math.max(0, Math.min(L, (p.x - ax) * tx + (p.z - az) * tz));
      const d = Math.hypot(ax + tx * u - p.x, az + tz * u - p.z);
      if (d < best) { best = d; bi = i; bu = u; }
    }
    let i = bi, u = bu + 22;
    while (i + 1 < route.length) {
      const L = Math.hypot(route[i + 1][0] - route[i][0], route[i + 1][1] - route[i][1]);
      if (u <= L || i + 2 >= route.length) { u = Math.min(u, L); break; }
      u -= L; i++;
    }
    const [ax, az] = route[i], [bx, bz] = route[i + 1];
    const L = Math.hypot(bx - ax, bz - az);
    const tx = ax + (bx - ax) * (u / L), tz = az + (bz - az) * (u / L);
    const want = Math.atan2(tx - p.x, tz - p.z);
    let dh = want - ride.horse.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    const fw = new v.THREE.Vector3(Math.sin(ride.horse.heading), 0, Math.cos(ride.horse.heading));
    const jump = !ride.jump && ride.logAhead(fw);
    v.input.scripted = { t: 1, intent: { moveY: 1, sprint: true, moveX: Math.max(-1, Math.min(1, -dh * 2.2)), jump } };
  }, 50);
});

try {
  const state = () => page.evaluate(() => {
    const v = window.__valley, f = v.ROUTE[v.ROUTE.length - 1];
    return { st: v.game.state, next: v.game.next, t: v.game.time, x: v.ride.pos.x, z: v.ride.pos.z, sp: v.ride.horse.speed, hour: v.tod.hour, fire: Math.hypot(v.ride.pos.x - f[0], v.ride.pos.z - f[1]) };
  });
  // ---- start: the title over the valley, the keys, then away to the first lantern
  await page.evaluate(() => window.__valley.game.intro());
  await record(path.join(outDir, 'start.mp4'), 20, async () => {
    await page.waitForTimeout(3600);
    await drive();
  });
  let s = await state();
  console.log(`[game] after the start clip: checkpoint ${s.next}/4, ${s.sp.toFixed(1)} m/s, hour ${s.hour.toFixed(2)}`);
  // ---- on up the valley (not recorded) to the last of the climb
  const t0 = Date.now();
  while ((s = await state()).fire > 30 && Date.now() - t0 < 240000) {
    await page.waitForTimeout(500);
    if ((Date.now() - t0) % 15000 < 500) console.log(`[game] ${s.x.toFixed(0)},${s.z.toFixed(0)} checkpoint ${s.next}/4 ${s.sp.toFixed(1)} m/s, ${s.fire.toFixed(0)} m to the fire`);
  }
  if (s.fire > 30) throw new Error(`the ride did not reach the summit: stuck at ${s.x.toFixed(0)},${s.z.toFixed(0)}`);
  console.log(`[game] near the summit: checkpoint ${s.next}/4, ${s.t.toFixed(0)} s riding, hour ${s.hour.toFixed(2)}`);
  // ---- the summit
  let cardAt = -1;
  const r0 = Date.now();
  await record(path.join(outDir, 'summit.mp4'), 15, async () => {
    // (note when "valley crossed" comes up, so the clip is known to hold it)
    while (Date.now() - r0 < 14500 && cardAt < 0) {
      if (await page.evaluate(() => window.__valley.game.ended)) cardAt = (Date.now() - r0) / 1000;
      else await page.waitForTimeout(200);
    }
  });
  console.log(`[game] "valley crossed" at ${cardAt.toFixed(1)} s into the summit clip`);
  if (cardAt < 0 || cardAt > 12) throw new Error('the end card did not come up in time for the summit clip');
  s = await state();
  console.log(`[game] end: ${s.st}, ride time ${s.t.toFixed(1)} s, ${s.sp.toFixed(2)} m/s, ${s.fire.toFixed(1)} m from the fire, hour ${s.hour.toFixed(2)}`);
  if (s.st !== 'finish') throw new Error('the ride did not finish');
  // ---- a sunset frame of her and the horse up close, the fire beside them
  await page.evaluate(() => { window.__valley.gameUI.hidden = true; });
  await holdCamera(page, { bearing: 48, height: 2.6, dist: 5.2, fov: 36, look: 1.5 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(outDir, 'closeup.jpg'), quality: 92, type: 'jpeg' });
  console.log(`[game] ${path.join(outDir, 'closeup.jpg')}; render ${(await page.evaluate(() => window.__valley.stats().fps)).toFixed(0)} fps`);
  h.assertClean();
  await h.teardown(0);
} catch (e) {
  killAll();
  await h.teardown(1, e);
}
