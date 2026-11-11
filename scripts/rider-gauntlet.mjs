// The rider's gauntlet: our render of her at the gallop beside a real reference frame of a rider (refs/rider), for a
// blind judge who is asked which is real. Real runtime, real ride (scripted gallop), the meadow at midday.
//
// Both images of a pair get the same treatment: cropped round the rider (head to stirrup, the same share of the frame),
// resized to the same height, JPEG at the same quality, set side by side in a random order. The order goes to
// key.json beside the pairs (the judge is never shown it).
//
//   node scripts/rider-gauntlet.mjs <loop> <round>     -> build/gauntlet/<loop>/round-<n>/{pair-*.jpg, key.json}
import fs from 'node:fs';
import sharp from 'sharp';
import { startValley } from './lib/vharness.mjs';
import { gallopInMeadow, holdCamera } from './lib/ridercam.mjs';

const loop = process.argv[2] ?? 'loop', round = Number(process.argv[3] ?? 1);
const out = `build/gauntlet/${loop}/round-${round}`;
fs.mkdirSync(out, { recursive: true });
const H = 640, SHARE = 0.84, ASPECT = 0.85;   // crop: the rider spans SHARE of its height; width = ASPECT x height

// the real frames, and where the rider is in each (head to stirrup), by view; a round uses the next one of each
const REFS = {
  side: [
    { file: 'modern-gallop-side-01.jpg', box: [760, 140, 1250, 985] },
    { file: 'modern-canter-side-02.jpg', box: [870, 165, 1180, 880] },
  ],
  quarter: [
    { file: 'modern-canter-frontquarter-01.jpg', box: [765, 160, 1080, 1030] },
    { file: 'video-barrel-percheron-f03.jpg', box: [295, 145, 425, 455] },
  ],
  face: [
    { file: 'face-threequarter-01.jpg', box: [690, 120, 1680, 1440] },
    { file: 'face-front-01.jpg', box: [857, 55, 1371, 686] },
    { file: 'face-profile-01.jpg', box: [843, 151, 1735, 1029] },
  ],
  behind: [
    { file: 'behind-gallop-rearquarter-01.jpg', box: [822, 41, 1521, 1048] },
    { file: 'behind-canter-rearquarter-01.jpg', box: [645, 115, 1160, 773] },
  ],
};
// our camera for each view, held rigidly on the horse (scripts/lib/ridercam.mjs), on a long lens like the
// photographs', so her crop is at the frame's own resolution; what is cropped round: her whole figure (head to
// stirrup) or her head
const VIEWS = {
  side: { bearing: -90, height: 1.75, dist: 6.0, fov: 24, at: 'rider', look: 1.6, crop: 'rider' },
  quarter: { bearing: -38, height: 1.85, dist: 6.4, fov: 23, at: 'rider', look: 1.6, crop: 'rider' },
  face: { bearing: -32, height: 0.02, dist: 1.6, fov: 14, at: 'head', crop: 'head' },
  behind: { bearing: 150, height: 2.1, dist: 6.4, fov: 24, at: 'rider', look: 1.6, crop: 'rider' },
};

/** the crop round a rider box [x0, y0, x1, y1] by the rule above, clamped to the image */
function cropOf(box, W, Hh) {
  const [x0, y0, x1, y1] = box;
  const h = Math.min(Hh, (y1 - y0) / SHARE), w = Math.min(W, h * ASPECT);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const left = Math.round(Math.max(0, Math.min(W - w, cx - w / 2))), top = Math.round(Math.max(0, Math.min(Hh - h, cy - h / 2)));
  return { left, top, width: Math.round(w), height: Math.round(h) };
}
async function prepared(src, box) {
  const m = await sharp(src).metadata();
  return sharp(src).extract(cropOf(box, m.width, m.height)).resize({ height: H, width: Math.round(H * ASPECT), fit: 'fill' }).jpeg({ quality: 82 }).toBuffer();
}

const h = await startValley({ query: 'test=1&mute=1&freeze=1&hud=0&tod=12' });
const { page } = h;
const ev = (f, a) => page.evaluate(f, a);
try {
  const key = {};
  for (const [view, cam] of Object.entries(VIEWS)) {
    await gallopInMeadow(page, 12.3);
    await holdCamera(page, cam);
    await page.waitForTimeout(5200);
    // the shot, and where she is in it (her head's crown to her stirrup irons, her hands), on the same frame
    const shot = `${out}/ours-${view}-full.png`;
    const measure = () => ev((crop) => {
      const v = window.__valley, THREE = v.THREE, horse = v.ride.horse, cam = v.camera;
      const scene = horse.person.model;
      horse.root.updateMatrixWorld(true);
      const at = (name, local) => {
        let b = null;
        scene.traverse((o) => { if (o.name === name) b = o; });
        if (!b) throw new Error(`no bone ${name}`);
        return b.localToWorld(new THREE.Vector3(...local));
      };
      const pts = crop === 'head'
        ? [at('head', [0, 0.17, 0]), at('head', [0, -0.07, 0]), at('head', [0.09, 0.05, 0]), at('head', [-0.09, 0.05, 0]), at('head', [0, 0.05, 0.11]), at('head', [0, 0.05, -0.11])]
        : [at('head', [0, 0.17, 0]), at('ironL', [0, 0.16, 0]), at('ironR', [0, 0.16, 0]), at('gripL', [0, 0, 0]), at('gripR', [0, 0, 0]), at('hips', [0, 0, 0])];
      const W = innerWidth * devicePixelRatio, Hh = innerHeight * devicePixelRatio;
      const s = pts.map((p) => { const q = p.clone().project(cam); return [(q.x + 1) / 2 * W, (1 - q.y) / 2 * Hh]; });
      return [Math.min(...s.map((p) => p[0])), Math.min(...s.map((p) => p[1])), Math.max(...s.map((p) => p[0])), Math.max(...s.map((p) => p[1]))];
    }, cam.crop);
    // (the frame runs on between the measure and the shot: the box is the union of one before and one after)
    const b0 = await measure();
    await page.screenshot({ path: shot });
    const b1 = await measure();
    const box = [Math.min(b0[0], b1[0]), Math.min(b0[1], b1[1]), Math.max(b0[2], b1[2]), Math.max(b0[3], b1[3])];
    const ref = REFS[view][(round - 1) % REFS[view].length];
    const ours = await prepared(shot, box);
    const real = await prepared(`refs/rider/${ref.file}`, ref.box);
    const oursLeft = Math.random() < 0.5;
    const [a, b] = oursLeft ? [ours, real] : [real, ours];
    const W = Math.round(H * ASPECT), GAP = 24;
    const label = (t) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="60" height="44"><rect width="60" height="44" fill="#000"/><text x="18" y="33" font-family="Arial" font-size="30" fill="#fff">${t}</text></svg>`);
    const f = `${out}/pair-${view}.jpg`;
    await sharp({ create: { width: 2 * W + GAP, height: H, channels: 3, background: '#000' } })
      .composite([{ input: a, left: 0, top: 0 }, { input: b, left: W + GAP, top: 0 }, { input: label('A'), left: 0, top: 0 }, { input: label('B'), left: W + GAP, top: 0 }])
      .jpeg({ quality: 90 }).toFile(f);
    key[view] = { ours: oursLeft ? 'A' : 'B', real: ref.file, ourBox: box.map((x) => Math.round(x)) };
    const st = await ev(() => ({ speed: window.__valley.ride.horse.speed, fps: window.__valley.stats().fps }));
    console.log(`[gauntlet] ${f} (speed ${st.speed.toFixed(1)} m/s, fps ${st.fps.toFixed(0)})`);
  }
  fs.writeFileSync(`${out}/key.json`, JSON.stringify(key, null, 1));
  h.assertClean();
  await h.teardown(0);
} catch (e) {
  await h.teardown(1, e);
}
