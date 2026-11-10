// Ride check: first person and a side view of the horse standing, walking, trotting, galloping.
// node scripts/ride-test.mjs [outdir]
import { startValley } from './lib/vharness.mjs';
import fs from 'node:fs';

const out = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'build/ride';
fs.mkdirSync(out, { recursive: true });
const h = await startValley({ query: 'test=1&mute=1&freeze=1&tod=9.2' });
const { page } = h;
const ev = (f, a) => page.evaluate(f, a);
try {
  const log = await ev(() => window.__valley.ride.horse.root.position.toArray());
  console.log('[ride] horse at', log.map((x) => x.toFixed(1)).join(' '));
  const ride = async (intent, secs) => {
    await ev(({ intent, secs }) => { window.__valley.input.scripted = { t: secs, intent }; }, { intent, secs });
    await page.waitForTimeout(secs * 1000);
  };
  const side = async (name) => {
    await ev(() => {
      const v = window.__valley, r = v.ride, p = r.horse.root.position, hd = r.horse.heading;
      const lx = Math.cos(hd), lz = -Math.sin(hd);
      v.rig.set({ pos: [p.x + lx * 5.5, p.y + 1.6, p.z + lz * 5.5], target: [p.x, p.y + 1.0, p.z] });
      v.setPosed(true);
    });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${out}/${name}-side.png` });
    await ev(() => window.__valley.setPosed(false));
  };
  const fp = async (name) => { await page.waitForTimeout(300); await page.screenshot({ path: `${out}/${name}-fp.png` }); };
  const state = async (tag) => {
    const s = await ev(() => { const r = window.__valley.ride; return { speed: r.horse.speed, gait: r.horse.gait, depth: r.depth, slope: r.slope, fps: window.__valley.stats().fps }; });
    console.log(`[ride] ${tag} speed ${s.speed.toFixed(2)} gait ${s.gait.toFixed(2)} depth ${s.depth.toFixed(2)} slope ${s.slope.toFixed(2)} fps ${s.fps.toFixed(1)}`);
  };
  await page.waitForTimeout(1500);
  await fp('0-stand'); await side('0-stand'); await state('stand');
  await ride({ moveY: 1 }, 3.5); await state('walk');
  await ev(() => { window.__valley.input.scripted = { t: 10, intent: { moveY: 1 } }; });
  await fp('1-walk'); await side('1-walk');
  await ride({ moveY: 1, sprint: true }, 0.9); await state('trot');
  await ev(() => { window.__valley.input.scripted = { t: 10, intent: { moveY: 1, sprint: true } }; });
  await page.waitForTimeout(1200);
  await fp('2-trot-pre');
  await page.waitForTimeout(3000); await state('gallop');
  await fp('3-gallop'); await side('3-gallop');
  await ev(() => window.__valley.ride.setView('cinematic'));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/4-cine.png` });
  h.assertClean();
  await h.teardown(0);
} catch (e) {
  await h.teardown(1, e);
}
