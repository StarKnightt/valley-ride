// The hero looks: sunrise, golden hour and sunset from the same places, first person and cinematic, plus fireflies
// at dusk and the photo-mode view. Writes PNGs to <out> and contact sheets (scripts/sheet.py).
// node scripts/valley-hours.mjs [out]
import { startValley } from './lib/vharness.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const out = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'build/hours';
fs.mkdirSync(out, { recursive: true });
// places: horse position, heading toward a target (world x,z), the view
const PLACES = [
  { name: 'meadow', at: [60, 120], toward: [-150, -628], view: 'first' },
  { name: 'statue', at: [362, -164], toward: [392, -196], view: 'first', pitch: 0.12 },
  { name: 'ruins', at: [-398, 228], toward: [-432, 186], view: 'first' },
  { name: 'river', at: [10, -40], toward: [-120, -300], view: 'cinematic', cyaw: -0.6 },
];
const HOURS = [['sunrise', 6.7], ['golden', 16.75], ['sunset', 17.5]];
const h = await startValley({ query: 'test=1&mute=1&freeze=1&tod=6.7' });
const { page } = h;
try {
  const files = {};
  for (const [hn, hour] of HOURS) for (const p of PLACES) {
    await page.evaluate(({ p, hour }) => {
      const v = window.__valley;
      v.tod.setHour(hour);
      const yaw = Math.atan2(p.toward[0] - p.at[0], p.toward[1] - p.at[1]);
      v.ride.auto = null;
      v.ride.place(p.at[0], p.at[1], yaw);
      v.ride.lookYaw = 0;
      v.ride.lookPitch = p.pitch ?? -0.21;
      v.ride.setView(p.view);
      if (p.cyaw !== undefined) v.ride.cine.yaw = p.cyaw;
      v.ride.cine.dist = p.dist ?? 6.5;
    }, { p, hour });
    await page.waitForTimeout(2600);
    const f = `${out}/${hn}-${p.name}.png`;
    await page.screenshot({ path: f });
    (files[hn] ??= []).push([`${hn} · ${p.name}`, f]);
    console.log('[hours]', f);
  }
  // fireflies at dusk over the meadow by the river
  await page.evaluate(() => { const v = window.__valley; v.tod.setHour(19.9); v.ride.place(30, 60, -2.2); v.ride.setView('first'); v.ride.lookPitch = -0.05; });
  await page.waitForTimeout(2600);
  await page.screenshot({ path: `${out}/dusk-fireflies.png` });
  h.assertClean();
  const sheet = (name, list) => execFileSync('python', ['scripts/sheet.py', `${out}/${name}`, '4', ...list.map(([l, f]) => `${l}=${f}`)], { stdio: 'inherit' });
  sheet('sheet-sunrise-golden-sunset.png', [...files.sunrise, ...files.golden, ...files.sunset]);
  await h.teardown(0);
} catch (e) { await h.teardown(1, e); }
