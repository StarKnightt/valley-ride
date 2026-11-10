// How far the trunk moves over the designed stride: node --import tsx tools/gait/trunk-report.ts [design.json ...]
import fs from 'node:fs';
import { K, pose } from './horse2d.ts';
for (const f of process.argv.slice(2).length ? process.argv.slice(2) : ['tools/blender/horse/gallop.design.json']) {
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  K.flex = K.pas = K.hoof = d.gait.legs.foreLead.flex.length; K.swing = d.gait.legs.foreLead.sx.length; K.trunk = d.gait.height.length;
  const w: number[] = [], c: number[] = [], x: number[] = [], p: number[] = [];
  for (let k = 0; k < 240; k++) {
    const P = pose(d.skeleton, d.gait, k / 240);
    w.push(P.mk.withers[1]); c.push(P.mk.croup[1]); x.push((P.mk.withers[0] + P.mk.croup[0]) / 2);
    p.push(Math.atan2(P.mk.withers[1] - P.mk.croup[1], P.mk.withers[0] - P.mk.croup[0]) * 57.2958);
  }
  const rg = (a: number[]) => Math.max(...a) - Math.min(...a);
  const fl = d.gait.flexion.map((v: number) => v * 57.2958);
  console.log(`${f}: withers rise and fall ${(rg(w) * 100).toFixed(0)} cm, croup ${(rg(c) * 100).toFixed(0)} cm, pitch ${rg(p).toFixed(0)} deg, surge ${(rg(x) * 100).toFixed(0)} cm, spine flexion controls ${rg(fl).toFixed(0)} deg; stride ${d.gait.stride.toFixed(2)} m`);
}
