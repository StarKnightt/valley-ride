// The rider as the game renders her, at the full gallop in the open meadow: her face close up, the side view, from
// behind and a front three-quarter - at midday and at sunset. Real runtime, real ride (scripted gallop).
//
//   node scripts/rider-shots.mjs [out] [views] [lights]     -> <out>/{meadow,sunset}-{face,profile,side,behind,quarter}.png, <out>/sheet.png
import fs from 'node:fs';
import sharp from 'sharp';
import { startValley } from './lib/vharness.mjs';
import { gallopInMeadow, holdCamera } from './lib/ridercam.mjs';

const out = process.argv[2] ?? 'build/rider-shots';
// (a quick look while working: only some views / lights, e.g.  node scripts/rider-shots.mjs out face,side meadow)
const onlyViews = process.argv[3]?.split(','), onlyLights = process.argv[4]?.split(',');
fs.mkdirSync(out, { recursive: true });
const LIGHTS = [{ name: 'meadow', hour: 12.3 }, { name: 'sunset', hour: 17.45 }];
const VIEWS = [
  { name: 'face', bearing: -32, height: 0.02, dist: 1.25, fov: 22, at: 'head' },
  { name: 'profile', bearing: -90, height: 0.0, dist: 1.6, fov: 24, at: 'head' },
  { name: 'side', bearing: -90, height: 1.7, dist: 7.5, fov: 30, at: 'rider' },
  { name: 'behind', bearing: 158, height: 2.3, dist: 4.6, fov: 34, at: 'rider' },
  { name: 'quarter', bearing: -40, height: 1.9, dist: 4.2, fov: 30, at: 'rider' },
];

const h = await startValley({ query: 'test=1&mute=1&freeze=1&hud=0&tod=12' });
const { page } = h;
try {
  const tiles = [];
  for (const light of LIGHTS.filter((l) => !onlyLights || onlyLights.includes(l.name))) {
    for (const view of VIEWS.filter((v) => !onlyViews || onlyViews.includes(v.name))) {
      // (each view from the same stretch of meadow: placed again, up to the gallop, then the shot)
      await gallopInMeadow(page, light.hour);
      await holdCamera(page, view);
      await page.waitForTimeout(5200);
      const f = `${out}/${light.name}-${view.name}.png`;
      await page.screenshot({ path: f });
      const st = await page.evaluate(() => ({ speed: window.__valley.ride.horse.speed, fps: window.__valley.stats().fps }));
      console.log(`[shots] ${f} (speed ${st.speed.toFixed(1)} m/s, fps ${st.fps.toFixed(0)})`);
      tiles.push({ f, label: `${light.name} · ${view.name}` });
    }
  }
  h.assertClean();
  const TW = 768, TH = 432, COLS = onlyViews ? onlyViews.length : VIEWS.length, comps = [];
  for (const [i, t] of tiles.entries()) {
    const left = (i % COLS) * TW, top = Math.floor(i / COLS) * TH;
    comps.push({ input: await sharp(t.f).resize(TW, TH).toBuffer(), left, top });
    comps.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="28"><rect width="200" height="28" fill="rgba(0,0,0,0.55)"/><text x="8" y="20" font-family="Arial" font-size="16" fill="#fff">${t.label}</text></svg>`), left, top });
  }
  await sharp({ create: { width: COLS * TW, height: Math.ceil(tiles.length / COLS) * TH, channels: 3, background: '#111' } }).composite(comps).png().toFile(`${out}/sheet.png`);
  console.log(`[shots] ${out}/sheet.png`);
  await h.teardown(0);
} catch (e) {
  await h.teardown(1, e);
}
