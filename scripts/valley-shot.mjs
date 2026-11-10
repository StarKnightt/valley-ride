// Valley screenshots: node scripts/valley-shot.mjs <outdir> name=cam:x,y,z,tx,ty,tz@tod ...
// (tod: hour or preset). Frozen clock; waits for the frame to settle before each shot.
import { startValley } from './lib/vharness.mjs';
import fs from 'node:fs';

const [out = 'build/shots', ...specs] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
fs.mkdirSync(out, { recursive: true });
const shots = specs.map((s) => {
  const [name, rest] = s.split('=');
  const [cam, tod = 'sunrise'] = rest.split('@');
  return { name, cam: cam.split(',').map(Number), tod };
});
const h = await startValley({ query: 'freeze=1&mute=1&hud=0' });
try {
  const { page } = h;
  for (const s of shots) {
    await page.evaluate(({ cam, tod }) => {
      const v = window.__valley;
      const P = { sunrise: 6.55, morning: 8.5, noon: 12.3, golden: 16.6, sunset: 17.42, dusk: 18.6, night: 22.5 };
      v.tod.setHour(typeof P[tod] === 'number' ? P[tod] : Number(tod));
      v.rig.set({ pos: cam.slice(0, 3), target: cam.slice(3) });
    }, s);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${out}/${s.name}.png` });
    const st = await page.evaluate(() => window.__valley.stats());
    console.log(`[shot] ${s.name} fps ${st.fps.toFixed(1)}`);
  }
  h.assertClean();
  await h.teardown(0);
} catch (e) {
  await h.teardown(1, e);
}
