// Round 2's check: the horse in rest pose and six stress poses on a turntable, in the real runtime (the gait lab),
// rendered on the GPU (adapter asserted and printed by the harness). Writes gate/rig-check.png and prints the
// triangle and bone counts against the budget.
//   node scripts/rig-check.mjs
import fs from 'node:fs';
import sharp from 'sharp';
import { startValley } from './lib/vharness.mjs';

const BUDGET = { triangles: 14000, bones: 60 };
fs.mkdirSync('gate', { recursive: true });
const h = await startValley({ page: 'gait-lab.html', global: '__gaitlab', width: 1280, height: 720 });
try {
  const info = await h.page.evaluate(() => window.__gaitlab.rig('rest', -Math.PI / 2));
  const ANG = [-Math.PI / 2, -Math.PI / 4, 0.35, Math.PI / 2 + 0.6, Math.PI + 0.5];
  const TW = 512, TH = 288, comps = [];
  for (let r = 0; r < info.poses.length; r++) for (let c = 0; c < ANG.length; c++) {
    await h.page.evaluate(([id, a]) => window.__gaitlab.rig(id, a), [info.poses[r], ANG[c]]);
    comps.push({ input: await sharp(await h.page.screenshot()).resize(TW, TH).toBuffer(), left: c * TW, top: r * TH });
    if (c === 0) comps.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${TW}" height="28"><rect width="170" height="26" fill="rgba(0,0,0,0.6)"/><text x="8" y="18" font-family="Arial" font-size="15" fill="#fff">${info.poses[r]}</text></svg>`), left: 0, top: r * TH });
  }
  await sharp({ create: { width: ANG.length * TW, height: info.poses.length * TH, channels: 3, background: '#1d1b18' } }).composite(comps).png().toFile('gate/rig-check.png');
  const ok = info.triangles <= BUDGET.triangles && info.bones <= BUDGET.bones;
  console.log(`[rig] triangles ${info.triangles} / ${BUDGET.triangles}, bones ${info.bones} / ${BUDGET.bones}: ${ok ? 'inside budget' : 'OVER BUDGET'}`);
  console.log('[rig] sheet: gate/rig-check.png');
  h.assertClean();
  await h.teardown(ok ? 0 : 1);
} catch (e) {
  await h.teardown(1, e);
}
