// fps breakdown: toggles systems off one at a time in first person at the camp (1080p)
import { startValley } from './lib/vharness.mjs';
const h = await startValley({ query: 'test=1&mute=1&freeze=1&tod=9.2' + (process.argv.find((a) => a.startsWith('--q='))?.replace('--q=', '&') ?? '') });
const { page } = h;
try {
  const measure = async (tag, setup) => {
    await page.evaluate(setup);
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.__valley.engine.resetPacing?.());
    await page.waitForTimeout(3000);
    const s = await page.evaluate(() => { const st = window.__valley.stats(); return { fps: st.fps, cpu: st.cpu.avg, gpu: st.gpu.avg, p95: st.frame.p95 }; });
    console.log(`[perf] ${tag.padEnd(14)} fps ${s.fps.toFixed(1)}  frame p95 ${s.frame?.toFixed?.(1) ?? s.p95.toFixed(1)} ms  cpu ${s.cpu.toFixed(1)}  gpu ${s.gpu.toFixed(1)}`);
  };
  const V = 'window.__valley';
  const vis = (path, on) => `(() => { const v = window.__valley; ${path}.visible = ${on}; })()`;
  const reset = `(() => { const v = window.__valley; v.valley.grass.group.visible = true; v.valley.veg.group.visible = true; v.valley.group.visible = true; v.ride.horse.root.visible = true; v.scene.traverse(o => { if (o.isDirectionalLight) o.castShadow = true; }); })()`;
  // (at the camp, whatever the game's spawn)
  await page.evaluate(() => { const v = window.__valley; v.ride.place(112, -52, -2.3 + Math.PI); v.ride.setView('first'); });
  await measure('warmup', () => {});
  await measure('all', () => {});
  await measure('-grass', reset + ';' + vis('v.valley.grass.group', false));
  await measure('-veg', reset + ';' + vis('v.valley.veg.group', false));
  await measure('-props', reset + ';' + vis('v.valley.group', false));
  await measure('-horse', reset + ';' + vis('v.ride.horse.root', false));
  await measure('-shadows', reset + `;window.__valley.scene.traverse(o => { if (o.isDirectionalLight) o.castShadow = false; })`);
  await measure('-vegshadow', reset + `;window.__valley.valley.veg.group.traverse(o => { if (o.isMesh) o.castShadow = false; })`);
  await measure('-clouds?', reset + `;window.__valley.scene.traverse(o => { if (/cloud/i.test(o.name)) o.visible = false; })`);
  await measure('all again', reset + `;window.__valley.valley.veg.group.traverse(o => { if (o.isMesh && /_l[01]_/.test(o.name)) o.castShadow = true; })`);
  void V;
  await h.teardown(0);
} catch (e) { await h.teardown(1, e); }
