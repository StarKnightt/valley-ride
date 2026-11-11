// Time of day check: the game as a player opens it (HUD on), the four times switched ten rounds in a row (the buttons
// and the T key alternately), each blend timed frame by frame; then a ride at night from the spawn to the first
// checkpoint. Fails on a page error, a frame over 50 ms, a shader compile during a switch, under 50 fps, or the
// checkpoint not reached.
//   node scripts/test-tod.mjs
import { startValley } from './lib/vharness.mjs';
import fs from 'node:fs';

const OUT = 'build/tod-check';
fs.mkdirSync(OUT, { recursive: true });
const h = await startValley({ query: 'mute=1' });
const { page } = h;
const fail = [];
try {
  // per-frame wall time of the game's own loop
  await page.evaluate(() => {
    const e = window.__valley.engine;
    window.__ft = [];
    let last = performance.now(), f = e.frame;
    const tick = () => {
      if (e.frame !== f) { const now = performance.now(); window.__ft.push(now - last); last = now; f = e.frame; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.waitForTimeout(5000); // the title card, then the ride
  // a player's first key starts the sound (main.ts startAudio: a one-off of a few tens of ms); they ride before they
  // reach for the clock, so the first gesture comes before the switches are timed
  await page.keyboard.press('ShiftLeft');
  await page.waitForTimeout(500);
  const names = ['morning', 'noon', 'sunset', 'night'];
  const all = [];
  for (let round = 0; round < 10; round++) {
    for (const name of names) {
      const c0 = await page.evaluate(() => { window.__ft.length = 0; return window.__valley.engine.stats().pipelines.compiled; });
      if (round % 2 === 0) await page.click(`#gu-time button[data-t=${name}]`);
      else await page.keyboard.press('KeyT');
      await page.waitForTimeout(2600);
      const r = await page.evaluate(() => ({ ft: window.__ft.slice(), hour: window.__valley.tod.hour, sweeping: window.__valley.tod.sweeping, compiled: window.__valley.engine.stats().pipelines.compiled, pick: window.__valley.gameUI.timePick }));
      const max = Math.max(...r.ft), at = r.ft.indexOf(max), avg = r.ft.reduce((a, b) => a + b, 0) / r.ft.length;
      all.push(...r.ft);
      const line = `[tod] round ${round + 1} ${name}: ${r.pick} hour ${r.hour.toFixed(2)}, ${r.ft.length} frames, ${(1000 / avg).toFixed(0)} fps, max ${max.toFixed(1)} ms (frame ${at}), shaders compiled ${r.compiled - c0}`;
      console.log(line);
      if (r.pick !== name) fail.push(`round ${round + 1}: pressed ${name}, got ${r.pick}`);
      if (r.sweeping) fail.push(`round ${round + 1} ${name}: still blending after 2.6 s`);
      if (max > 50) fail.push(`round ${round + 1} ${name}: a ${max.toFixed(0)} ms frame`);
      if (r.compiled > c0) fail.push(`round ${round + 1} ${name}: ${r.compiled - c0} shaders compiled during the switch`);
      if (round === 0) await page.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 80 });
    }
  }
  const avgAll = all.reduce((a, b) => a + b, 0) / all.length;
  console.log(`[tod] 40 switches: ${(1000 / avgAll).toFixed(0)} fps average, worst frame ${Math.max(...all).toFixed(1)} ms`);
  if (1000 / avgAll < 50) fail.push(`switching: ${(1000 / avgAll).toFixed(0)} fps`);

  // the ride at night: from the spawn along the trail to the first checkpoint, at a gallop on the autopilot
  await page.evaluate(() => {
    const v = window.__valley, T = v.THREE;
    v.game.rideAgain();
    const pts = v.ROUTE.slice(0, 3).map(([x, z]) => new T.Vector2(x, z));
    v.ride.auto = { pts, i: 1, speed: 10, done: false };
    window.__ft.length = 0;
  });
  const t0 = Date.now();
  let st;
  for (;;) {
    await page.waitForTimeout(500);
    st = await page.evaluate(() => ({ next: window.__valley.game.next, night: window.__valley.tod.night, hour: window.__valley.tod.hour, p: [window.__valley.ride.pos.x, window.__valley.ride.pos.z] }));
    if (st.next >= 1 || Date.now() - t0 > 40000) break;
  }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/night-checkpoint.jpg`, type: 'jpeg', quality: 85 });
  const ride = await page.evaluate(() => window.__ft.slice());
  const rAvg = ride.reduce((a, b) => a + b, 0) / ride.length;
  console.log(`[tod] night ride: checkpoint ${st.next >= 1 ? 'reached' : 'NOT reached'} in ${((Date.now() - t0) / 1000).toFixed(0)} s at hour ${st.hour.toFixed(2)} (night ${st.night.toFixed(2)}), ${(1000 / rAvg).toFixed(0)} fps, worst frame ${Math.max(...ride).toFixed(1)} ms`);
  if (st.next < 1) fail.push('night ride: the first checkpoint was not reached');
  if (st.night < 0.99) fail.push('night ride: not night');
  if (1000 / rAvg < 50) fail.push(`night ride: ${(1000 / rAvg).toFixed(0)} fps`);
  if (Math.max(...ride) > 50) fail.push(`night ride: a ${Math.max(...ride).toFixed(0)} ms frame`);
  h.assertClean();
  if (fail.length) { console.log('[tod] FAIL\n  ' + fail.join('\n  ')); await h.teardown(1); }
  console.log('[tod] PASS');
  await h.teardown(0);
} catch (e) { await h.teardown(1, e); }
