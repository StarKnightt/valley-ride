// Before / after crops of the horse from scripts/ride-look.mjs runs: each place and angle, the horse cut out of both
// shots at the same box (found from the after shot's framing: the camera follows the horse, so the box is fixed).
//   node scripts/ride-look-pair.mjs build/ride-look/before build/ride-look/after build/ride-look/compare.png
import sharp from 'sharp';

const [A, B, out] = process.argv.slice(2);
const SHOTS = ['forest-back', 'forest-side', 'meadow-back', 'meadow-side', 'sunset-back', 'sunset-side'];
// the horse's box in a 1920x1080 frame, per angle (the cinematic camera holds the horse in the same place)
const BOX = { back: { left: 560, top: 520, width: 480, height: 400 }, side: { left: 240, top: 470, width: 720, height: 500 } };
const TH = 400, comps = [];
let y = 0, W = 0;
for (const s of SHOTS) {
  const box = BOX[s.split('-')[1]];
  const tw = Math.round((box.width / box.height) * TH);
  for (const [i, dir] of [A, B].entries()) {
    comps.push({ input: await sharp(`${dir}/${s}.png`).extract(box).resize(tw, TH).toBuffer(), left: i * (tw + 8), top: y });
    comps.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="260" height="28"><rect width="260" height="26" fill="rgba(0,0,0,0.6)"/><text x="7" y="19" font-family="Arial" font-size="16" fill="#fff">${s} · ${i ? 'after' : 'before'}</text></svg>`), left: i * (tw + 8), top: y });
  }
  W = Math.max(W, 2 * tw + 8);
  y += TH + 8;
}
const buf = await sharp({ create: { width: W, height: y, channels: 3, background: '#111' } }).composite(comps).png().toBuffer();
await sharp(buf).toFile(out);
console.log('[pair]', out);
