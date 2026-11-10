// probe the ground at a point: heights around, depth, colliders hit, slope along a heading
import { startValley } from './lib/vharness.mjs';
const [x, z, tx, tz] = process.argv.slice(2).map(Number);
const h = await startValley({ query: 'test=1&mute=1&freeze=1' });
try {
  const r = await h.page.evaluate(({ x, z, tx, tz }) => {
    const v = window.__valley, hf = v.hf, T = v.THREE;
    const out = { h: hf.height(x, z), depth: hf.depth(x, z), shore: hf.shoreDist(x, z), steps: [] };
    const L = Math.hypot(tx - x, tz - z), dx = (tx - x) / L, dz = (tz - z) / L;
    for (let s = -4; s <= 16; s += 2) {
      const px = x + dx * s, pz = z + dz * s, p = new T.Vector3(px, hf.height(px, pz), pz);
      const q = p.clone();
      const hit = v.colliders.resolve(q, 0.75);
      out.steps.push(`${s}: h ${hf.height(px, pz).toFixed(2)} d ${hf.depth(px, pz).toFixed(2)} ${hit ? `push ${q.distanceTo(p).toFixed(2)}` : ''}`);
    }
    const seen = new Set();
    out.obs = [];
    for (const b of v.colliders.grid.values()) for (const o of b.obs) {
      if (seen.has(o)) continue; seen.add(o);
      const d = Math.hypot(o.x - x, o.z - z) - o.r;
      if (d < 6) out.obs.push(`${o.kind} at ${o.x.toFixed(1)},${o.z.toFixed(1)} r ${o.r.toFixed(2)} hx ${o.hx.toFixed(2)} hz ${o.hz.toFixed(2)} gap ${d.toFixed(2)}`);
    }
    return out;
  }, { x, z, tx, tz });
  console.log(JSON.stringify(r, null, 1));
  await h.teardown(0);
} catch (e) { await h.teardown(1, e); }
