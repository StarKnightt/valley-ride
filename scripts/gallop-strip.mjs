// The gallop as plain pictures: 12 moments of one stride, side view, from the real runtime (the gait lab's recorded
// stride), no overlays. For looking at the horse itself: the body's volume, the legs, the mane and tail in motion.
// Writes gate/gallop-strip.png. Rendered on the GPU (the harness asserts and prints the adapter).
//   node scripts/gallop-strip.mjs
import fs from 'node:fs';
import sharp from 'sharp';
import { startValley } from './lib/vharness.mjs';

fs.mkdirSync('gate', { recursive: true });
const h = await startValley({ page: 'gait-lab.html', global: '__gaitlab', width: 1920, height: 1080 });
try {
  const n = await h.page.evaluate(() => window.__gaitlab.rec.perStride);
  const N = 12, COLS = 4, TW = 640, TH = 420, comps = [];
  await h.page.evaluate(() => window.__gaitlab.capture(0, 0));
  for (let k = 0; k < N; k++) {
    const i = Math.round((k * n) / N);
    const cap = await h.page.evaluate((i) => window.__gaitlab.capture(i, 0), i);
    const P = cap.ours, cx = (P.withers[0] + P.croup[0]) / 2, cy = (P.withers[1] + P.croup[1]) / 2;
    const L = Math.hypot(P.withers[0] - P.croup[0], P.withers[1] - P.croup[1]);
    const w = 3.5 * L, hh = (w * TH) / TW;
    const clip = { x: Math.max(0, cx - 0.52 * w), y: Math.max(0, cy - 0.36 * hh), width: w, height: hh };
    clip.width = Math.min(clip.width, cap.W - clip.x); clip.height = Math.min(clip.height, cap.H - clip.y);
    const shot = await sharp(await h.page.screenshot({ clip })).resize(TW, TH, { fit: 'contain', background: '#d8ccb2' }).toBuffer();
    comps.push({ input: shot, left: (k % COLS) * TW, top: Math.floor(k / COLS) * TH });
    comps.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="150" height="26"><rect width="150" height="24" fill="rgba(0,0,0,0.55)"/><text x="6" y="17" font-family="Arial" font-size="14" fill="#fff">phase ${(i / n).toFixed(2)}</text></svg>`), left: (k % COLS) * TW, top: Math.floor(k / COLS) * TH });
  }
  await sharp({ create: { width: COLS * TW, height: Math.ceil(N / COLS) * TH, channels: 3, background: '#1d1b18' } }).composite(comps).png().toFile('gate/gallop-strip.png');
  console.log('[strip] gate/gallop-strip.png');
  h.assertClean();
  await h.teardown(0);
} catch (e) {
  await h.teardown(1, e);
}
