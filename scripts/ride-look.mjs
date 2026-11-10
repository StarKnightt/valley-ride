// The horse as the player sees it: third person, riding at a walk, in the forest (shade), the open meadow (midday
// sun) and at sunset (golden light). Two angles per place (three-quarter from behind, and the side). Real runtime,
// real ride (scripted input), clock frozen per place. Writes <out>/<place>-<angle>.png and <out>/sheet.png.
//   node scripts/ride-look.mjs [out]
import fs from 'node:fs';
import sharp from 'sharp';
import { startValley } from './lib/vharness.mjs';

const out = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'build/ride-look';
fs.mkdirSync(out, { recursive: true });
const h = await startValley({ query: 'test=1&mute=1&freeze=1&hud=0&tod=12' });
const { page } = h;
const ev = (f, a) => page.evaluate(f, a);
try {
  // the forest spot: under the trees (the trails keep out of the forest), on gentle ground, nearest the camp, facing
  // along the slope's contour
  const forest = await ev(() => {
    const v = window.__valley, hf = v.hf;
    let best = null;
    for (let x = -600; x <= 600; x += 6) for (let z = -700; z <= 600; z += 6) {
      const f = hf.forest(x, z);
      if (f < 0.75) continue;
      const gx = (hf.height(x + 3, z) - hf.height(x - 3, z)) / 6, gz = (hf.height(x, z + 3) - hf.height(x, z - 3)) / 6;
      if (Math.hypot(gx, gz) > 0.12) continue;
      const d = Math.hypot(x - 112, z + 52);
      if (!best || d < best.d) best = { d, f, at: [x, z], toward: [x - gz * 100 + 0.01, z + gx * 100] };
    }
    return best;
  });
  console.log('[look] forest spot', forest.at.map((x) => x.toFixed(0)).join(','), 'density', forest.f.toFixed(2));
  const PLACES = [
    { name: 'forest', hour: 10.5, at: forest.at, toward: forest.toward },
    { name: 'meadow', hour: 12.3, at: [60, 120], toward: [-150, -628] },
    { name: 'sunset', hour: 17.45, at: [60, 120], toward: [-150, -628] },
  ];
  // camera yaw relative to the horse's heading (0 = straight behind), pitch, distance
  const ANGLES = [{ name: 'back', yaw: 0.55, pitch: 0.2, dist: 6.5 }, { name: 'side', yaw: 1.45, pitch: 0.12, dist: 6.5 }];
  const tiles = [];
  for (const p of PLACES) {
    await ev(({ p }) => {
      const v = window.__valley;
      v.tod.setHour(p.hour);
      v.ride.auto = null;
      v.ride.place(p.at[0], p.at[1], Math.atan2(p.toward[0] - p.at[0], p.toward[1] - p.at[1]));
      v.ride.setView('cinematic');
    }, { p });
    for (const a of ANGLES) {
      // walk on, settle the camera, then shoot mid-stride
      await ev(({ a }) => {
        const v = window.__valley;
        v.input.scripted = { t: 30, intent: { moveY: 1 } };
        v.ride.cine.yaw = a.yaw; v.ride.cine.pitch = a.pitch; v.ride.cine.dist = a.dist;
      }, { a });
      await page.waitForTimeout(3200);
      const f = `${out}/${p.name}-${a.name}.png`;
      await page.screenshot({ path: f });
      const st = await ev(() => { const r = window.__valley.ride; return { speed: r.horse.speed, fps: window.__valley.stats().fps }; });
      console.log(`[look] ${f} speed ${st.speed.toFixed(2)} m/s fps ${st.fps.toFixed(1)}`);
      tiles.push({ f, label: `${p.name} · ${a.name}` });
    }
  }
  h.assertClean();
  const TW = 960, TH = 540, comps = [];
  for (const [i, t] of tiles.entries()) {
    comps.push({ input: await sharp(t.f).resize(TW, TH).toBuffer(), left: (i % 2) * TW, top: Math.floor(i / 2) * TH });
    comps.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="220" height="30"><rect width="220" height="28" fill="rgba(0,0,0,0.55)"/><text x="8" y="20" font-family="Arial" font-size="17" fill="#fff">${t.label}</text></svg>`), left: (i % 2) * TW, top: Math.floor(i / 2) * TH });
  }
  await sharp({ create: { width: 2 * TW, height: Math.ceil(tiles.length / 2) * TH, channels: 3, background: '#111' } }).composite(comps).png().toFile(`${out}/sheet.png`);
  console.log(`[look] ${out}/sheet.png`);
  await h.teardown(0);
} catch (e) {
  await h.teardown(1, e);
}
