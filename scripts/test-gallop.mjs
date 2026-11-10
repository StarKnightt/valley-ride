// The gallop test (GALLOP-TEST.md): `pnpm test:gallop`.
// Opens the gait lab, which records one stride of the horse through the real gait code (Engine.stepOnce, 240 samples
// per stride, and 1/60 s steps), then computes every check here in node from those joint positions (CPU, the same
// gallop.ts the lab uses), prints PASS / FAIL per check and exits non-zero on any failure. Writes
// gate/gallop-sheet.png: each Muybridge frame beside our pose at its aligned phase, rendered on the GPU.
// Run with tsx (the analysis is TypeScript): node --import tsx scripts/test-gallop.mjs
import fs from 'node:fs';
import sharp from 'sharp';
import { startValley } from './lib/vharness.mjs';
import { analyse, ROLES } from '../src/gaitlab/gallop.ts';

const OUT = 'gate';
fs.mkdirSync(OUT, { recursive: true });
const h = await startValley({ page: 'gait-lab.html', global: '__gaitlab', width: 1920, height: 1080 });
const { page } = h;
try {
  const { rec, plate } = await page.evaluate(() => ({ rec: window.__gaitlab.rec, plate: window.__gaitlab.plate }));
  const res = analyse(rec, plate);
  console.log(`[gallop] horse: stride ${rec.period.toFixed(3)} s at ${rec.speed} m/s, ${rec.perStride} samples per stride (0.25x), ${rec.realtime.length} at 1/60 s (1x); body length ${res.bodyLength.toFixed(3)} m`);
  console.log(`[gallop] plate: ${plate.frames.length} frames ${plate.frameSpacing.inches} in apart; stride ${res.align.stride.N.toFixed(2)} frame intervals; frame spacing at the horse ${res.align.stride.D.toFixed(0)} px`);
  console.log('');
  const info = new Set(['B1', 'B2']);
  for (const c of res.checks) {
    const tag = info.has(c.id) ? 'INFO' : c.pass ? 'PASS' : 'FAIL';
    console.log(`${tag.padEnd(4)} ${c.id.padEnd(3)} ${c.name}`);
    console.log(`          ${c.value}   [limit: ${c.limit}]`);
  }
  console.log('');
  console.log('Reference: the plate through the same checks (a check the plate fails is a wrong check; not part of the verdict)');
  for (const c of res.reference) console.log(`  ${c.pass ? 'pass' : 'FAIL'} ${c.id.padEnd(3)} ${c.value}`);

  // ------------------------------------------------------------------ the sheet
  const TW = 560, TH = 400, COLS = 4, HEAD = 150;
  const COL = { foreLead: '#e5392e', foreTrail: '#ff9a1f', hindLead: '#2fb33f', hindTrail: '#2f8cff' };
  const svgSkel = (P, dashed, contact) => {
    const ln = (a, b, c, w) => (P[a] && P[b] ? `<line x1="${P[a][0]}" y1="${P[a][1]}" x2="${P[b][0]}" y2="${P[b][1]}" stroke="${c}" stroke-width="${w}" stroke-linecap="round" ${dashed ? 'stroke-dasharray="7 5"' : ''}/>` : '');
    let s = ln('croup', 'withers', '#ffe14d', 2.5) + ln('withers', 'poll', '#ffe14d', 2.5) + ln('poll', 'muzzle', '#ffe14d', 2.5);
    for (const r of ROLES) {
      const m = r.startsWith('fore') ? 'knee' : 'hock';
      s += ln(`${r}_top`, `${r}_${m}`, COL[r], 3.5) + ln(`${r}_${m}`, `${r}_fetlock`, COL[r], 3.5) + ln(`${r}_fetlock`, `${r}_hoof`, COL[r], 3.5);
      if (contact?.[r] && P[`${r}_hoof`]) { const [x, y] = P[`${r}_hoof`]; s += `<rect x="${x - 8}" y="${y - 8}" width="16" height="16" fill="none" stroke="${COL[r]}" stroke-width="2.5"/>`; }
    }
    if (!dashed) for (const p of Object.values(P)) s += `<circle cx="${p[0]}" cy="${p[1]}" r="3.5" fill="#fff" stroke="#000"/>`;
    return s;
  };
  const label = (t, sub) => `<rect x="0" y="0" width="${TW}" height="26" fill="rgba(0,0,0,0.6)"/><text x="8" y="18" font-family="Arial" font-size="15" fill="#fff">${t}</text>${sub ? `<text x="${TW - 8}" y="18" text-anchor="end" font-family="Arial" font-size="13" fill="#ddd">${sub}</text>` : ''}`;
  // both tiles framed the same in body units: centred on the withers-croup midpoint, 3.4 x 2.43 withers-croup lengths
  const frameBox = (P) => {
    const cx = (P.withers[0] + P.croup[0]) / 2, cy = (P.withers[1] + P.croup[1]) / 2;
    const L = Math.hypot(P.withers[0] - P.croup[0], P.withers[1] - P.croup[1]);
    const w = 3.4 * L, hh = (w * TH) / TW;
    return { x: cx - 0.55 * w, y: cy - 0.3 * hh, w, h: hh };
  };
  const toTile = (P, b) => Object.fromEntries(Object.entries(P).map(([k, v]) => [k, [((v[0] - b.x) / b.w) * TW, ((v[1] - b.y) / b.h) * TH]]));
  const card = sharp('refs/muybridge/card.jpg');
  const meta = await card.metadata();
  const comps = [];
  const pairs = plate.frames.length;
  await page.evaluate(() => window.__gaitlab.capture(0, 0)); // (the first capture also switches the view)
  const rows = Math.ceil(pairs / 2);
  for (let fi = 0; fi < pairs; fi++) {
    const q = plate.frames[fi];
    const i = res.align.index[fi];
    // the plate tile: card pixels around the plate's own withers-croup
    const PP = {};
    for (const [k, v] of Object.entries(q.points)) PP[k] = v;
    for (const r of ROLES) PP[`${r}_top`] = q.points[r.startsWith('fore') ? 'elbow' : 'stifle'];
    const pb = frameBox(PP);
    const ex = { left: Math.round(pb.x), top: Math.round(pb.y), width: Math.round(pb.w), height: Math.round(pb.h) };
    const pad = { left: Math.max(0, -ex.left), top: Math.max(0, -ex.top), right: Math.max(0, ex.left + ex.width - meta.width), bottom: Math.max(0, ex.top + ex.height - meta.height) };
    const plateImg = await sharp('refs/muybridge/card.jpg')
      .extract({ left: ex.left + pad.left, top: ex.top + pad.top, width: ex.width - pad.left - pad.right, height: ex.height - pad.top - pad.bottom })
      .extend({ ...pad, background: '#000' }).resize(TW, TH, { fit: 'fill' }).toBuffer();
    const plateSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${TW}" height="${TH}">${svgSkel(toTile(PP, pb), false, q.contact)}${label(`Muybridge frame ${q.frame}`, '')}</svg>`;
    // our tile: the GPU render at the aligned sample, our joints solid, the plate's dashed on our withers-croup
    const cap = await page.evaluate(([i, fi]) => window.__gaitlab.capture(i, fi), [i, fi]);
    const ob = frameBox(cap.ours);
    const clip = { x: Math.max(0, ob.x), y: Math.max(0, ob.y), width: Math.min(cap.W, ob.x + ob.w) - Math.max(0, ob.x), height: Math.min(cap.H, ob.y + ob.h) - Math.max(0, ob.y) };
    const shot = await page.screenshot({ clip });
    const ourImg = await sharp({ create: { width: Math.round(ob.w), height: Math.round(ob.h), channels: 3, background: '#000' } })
      .composite([{ input: shot, left: Math.round(clip.x - ob.x), top: Math.round(clip.y - ob.y) }]).png().toBuffer();
    const ourTile = await sharp(ourImg).resize(TW, TH, { fit: 'fill' }).toBuffer();
    const s = rec.samples[i];
    const ourContact = Object.fromEntries(ROLES.map((r) => [r, s.j[`${{ foreLead: rec.lead + 'F', foreTrail: (rec.lead === 'L' ? 'R' : 'L') + 'F', hindLead: rec.lead + 'H', hindTrail: (rec.lead === 'L' ? 'R' : 'L') + 'H' }[r]}_hoof`][1] - rec.groundY <= 0.01]));
    const ourSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${TW}" height="${TH}">${svgSkel(toTile(cap.plate, ob), true)}${svgSkel(toTile(cap.ours, ob), false, ourContact)}${label('ours', `sample ${i}/${rec.perStride}, phase ${(i / rec.perStride).toFixed(3)}`)}</svg>`;
    const col = (fi % 2) * 2, row = Math.floor(fi / 2);
    comps.push({ input: plateImg, left: col * TW, top: HEAD + row * TH });
    comps.push({ input: Buffer.from(plateSvg), left: col * TW, top: HEAD + row * TH });
    comps.push({ input: ourTile, left: (col + 1) * TW, top: HEAD + row * TH });
    comps.push({ input: Buffer.from(ourSvg), left: (col + 1) * TW, top: HEAD + row * TH });
  }
  const fails = res.checks.filter((c) => !c.pass && !info.has(c.id));
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const summary = res.checks.filter((c) => !info.has(c.id)).map((c) => `${c.id} ${c.pass ? 'PASS' : 'FAIL'}`).join('   ');
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${COLS * TW}" height="${HEAD}"><rect width="100%" height="100%" fill="#1d1b18"/>
    <text x="16" y="40" font-family="Arial" font-size="28" fill="${fails.length ? '#ef7b6b' : '#7fc77f'}">Gallop test: ${fails.length ? `FAIL (${fails.length} checks)` : 'PASS'}</text>
    <text x="16" y="74" font-family="Arial" font-size="16" fill="#ece4d4">${esc(summary)}</text>
    <text x="16" y="102" font-family="Arial" font-size="14" fill="#a59a86">Left of each pair: Muybridge, The Horse in Motion (1878), Sallie Gardner, hand-annotated. Right: our horse at the aligned phase (solid), the plate's pose on our withers-croup (dashed).</text>
    <text x="16" y="126" font-family="Arial" font-size="14" fill="#a59a86">Red leading fore, orange trailing fore, green leading hind, blue trailing hind; squares mark planted hooves. Stride ${rec.period.toFixed(3)} s at ${rec.speed} m/s; plate stride ${res.align.stride.N.toFixed(2)} frames.</text></svg>`;
  comps.push({ input: Buffer.from(head), left: 0, top: 0 });
  await sharp({ create: { width: COLS * TW, height: HEAD + rows * TH, channels: 3, background: '#1d1b18' } }).composite(comps).png().toFile(`${OUT}/gallop-sheet.png`);
  fs.writeFileSync(`${OUT}/gallop-result.json`, JSON.stringify({ checks: res.checks, reference: res.reference, align: { offset: res.align.offset, index: res.align.index, stride: res.align.stride } }, null, 1));
  console.log('');
  console.log(`[gallop] sheet: ${OUT}/gallop-sheet.png`);
  console.log(fails.length ? `[gallop] FAIL: ${fails.map((c) => c.id).join(', ')}` : '[gallop] PASS');
  h.assertClean();
  await h.teardown(fails.length ? 1 : 0);
} catch (e) {
  await h.teardown(1, e);
}
