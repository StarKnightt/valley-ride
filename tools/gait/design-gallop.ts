/**
 * Designs the horse's skeleton proportions and its gallop against Muybridge's plate (refs/muybridge/keypoints.json).
 *
 *   node --import tsx tools/gait/design-gallop.ts [--iters=40] [--fresh]
 *
 * The plate gives, per frame, where the joints are in body lengths; the gallop test (src/gaitlab/gallop.ts) says what
 * a gallop must do. This fits the curves of tools/gait/horse2d.ts (and the bone lengths, within a horse's range) to
 * both by Levenberg-Marquardt, then runs the test's own analysis on the designed stride. The result,
 * tools/blender/horse/gallop.design.json, is what the Blender scripts build the armature from and key the gallop
 * with. The verdict that counts is still `pnpm test:gallop` on the exported GLB in the runtime.
 *
 * CPU on purpose: a few hundred unknowns, a few seconds; must be reproducible.
 */
import fs from 'node:fs';
import { analyse, plateNormalised, plateStride, TOL, type Plate, type Recording, type Sample, type V3 } from '../../src/gaitlab/gallop.ts';
import { K, RAD, ROLES, ang, gateJoints, len, pose, sub, wrap1, type Gait, type LegCurves, type Pose, type Role, type Skel, type V } from './horse2d.ts';

const NS = 240, LEAD = 'R' as const, SPEED = 10;
/** the plate's scale at the horse: 27 in (0.6858 m) is one frame spacing */
const arg = (k: string, d: number) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const sarg = (k: string, d: string) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const OUT = sarg('out', 'tools/blender/horse/gallop.design.json');
// experiment switches (defaults are the design's)
K.flex = K.pas = K.hoof = arg('kleg', K.flex); K.trunk = arg('ktrunk', K.trunk); K.swing = arg('kswing', K.swing);
const TRUNK_FREE = process.argv.includes('--trunkfree'), LEG_FREE = process.argv.includes('--legfree');

const plate: Plate = JSON.parse(fs.readFileSync('refs/muybridge/keypoints.json', 'utf8'));
const st = plateStride(plate);
const PXM = st.D / 0.6858;
const d2 = (a: V, b: V) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const PF = plate.frames.map((q, i) => {
  const P = plateNormalised(q) as Record<string, V>;
  const BLpx = d2(q.points.withers as V, q.points.croup as V);
  const midY = (q.points.withers[1] + q.points.croup[1]) / 2;
  return { q, phase: st.phase[i], k: Math.round(st.phase[i] * NS) % NS, P, BLpx, ground: -(q.groundY - midY) / BLpx };
});
const BLm = PF.reduce((a, f) => a + f.BLpx, 0) / PF.length / PXM;
const STRIDE0 = (st.N * st.D) / PXM;
console.log(`[plate] stride ${st.N.toFixed(2)} frames, D ${st.D.toFixed(0)} px, ${PXM.toFixed(0)} px/m, body length ${BLm.toFixed(3)} m, stride ${STRIDE0.toFixed(2)} m`);

// ------------------------------------------------------------------ contact timing (measured, as the test will see it)
/** touchdown and lift-off phases the test should measure (toe within 1 cm), chosen between the plate's frames */
const TIMING: Record<Role, [number, number]> = {
  hindTrail: [0.283, 0.536], hindLead: [0.487, 0.68], foreTrail: [0.612, 0.868], foreLead: [0.849, 1.06],
};

/** how long before / after its exact stance a toe is within the test's 1 cm (phase): measured -> designed */
const PAD = arg('pad', 0.012);

// ------------------------------------------------------------------ parameters
const sk0: Skel = {
  withers: [0, 0.04], girth: [0.0, -0.64], scapPivot: [0.0, -0.06], lScap: 0.42, scap0: -58 * RAD, neckBase: [0.16, -0.14], lNeck: 0.215, lHead: 0.58,
  poll: [-0.02, 0.06], muzzle: [0.58, -0.04],
  back: [-0.42, -0.06], lBack: 0.29, lLoin: 0.24, croup: [-0.18, 0.07], hip: [-0.2, -0.25], buttock: [-0.42, -0.27],
  lHum: 0.32, lRad: 0.46, lCanF: 0.3, lPasF: 0.09, scapFollow: 0.4, lFem: 0.44, lTib: 0.5, lCanH: 0.38, lPasH: 0.1,
  hoof: [0.075, -0.05], elbowMk: [0, 0], stifleMk: [0, 0],
};
let HEIGHT0: number | null = null;
type Spec = { name: string; get: () => number; set: (v: number) => void; scale: number; lo: number; hi: number; prior: number };
function build(sk: Skel, g: Gait): Spec[] {
  const S: Spec[] = [];
  const num = (name: string, o: Record<string, unknown>, key: string, scale: number, lo: number, hi: number, prior = 0) =>
    S.push({ name, get: () => o[key] as number, set: (v) => { o[key] = v; }, scale, lo, hi, prior });
  const arr = (name: string, a: number[], scale: number, lo = -Infinity, hi = Infinity, prior = 0) =>
    a.forEach((_, i) => S.push({ name: `${name}[${i}]`, get: () => a[i], set: (v) => { a[i] = v; }, scale, lo, hi, prior }));
  const vec = (name: string, o: Record<string, unknown>, key: string, r: number, prior = 3) => {
    const v = o[key] as V, c: V = [v[0], v[1]];
    arr(`${name}`, v, 0.05, -Infinity, Infinity, prior);
    S[S.length - 2].lo = c[0] - r; S[S.length - 2].hi = c[0] + r; S[S.length - 1].lo = c[1] - r; S[S.length - 1].hi = c[1] + r;
  };
  const skr = sk as unknown as Record<string, unknown>;
  // skeleton: lengths inside a horse's range (a 15 to 16 hand thoroughbred), marker and joint offsets within a few
  // centimetres of where they started. The elbow and stifle markers stay within 5 cm of the joint centre (the joint
  // itself is wider than that): they are joints, not points fitted to wherever the annotation happens to sit.
  const RANGE: Record<string, [number, number]> = {
    lScap: [0.34, 0.47], lNeck: [0.19, 0.26], lHead: [0.52, 0.64], lBack: [0.22, 0.4], lLoin: [0.2, 0.3], lHum: [0.28, 0.36], lRad: [0.42, 0.5],
    lCanF: [0.26, 0.34], lPasF: [0.07, 0.14], lFem: [0.34, 0.48], lTib: [0.44, 0.58], lCanH: [0.33, 0.4], lPasH: [0.07, 0.14],
  };
  for (const [k, [lo, hi]] of Object.entries(RANGE)) num(`sk.${k}`, skr, k, 0.05, lo, hi, 0);
  num('sk.scap0', skr, 'scap0', 0.2, -70 * RAD, -45 * RAD, 0);
  num('sk.scapFollow', skr, 'scapFollow', 0.2, 0.15, 0.7, 0);
  const sk0r = sk0 as unknown as Record<string, V>;
  for (const [k, r] of [['withers', 0.05], ['girth', 0.08], ['scapPivot', 0.04], ['neckBase', 0.12], ['poll', 0.07], ['muzzle', 0.05], ['back', 0.06], ['croup', 0.08], ['hip', 0.1], ['buttock', 0.06], ['elbowMk', 0.05], ['stifleMk', 0.05]] as [string, number][]) {
    const v = skr[k] as V, c = sk0r[k];
    arr(`sk.${k}`, v, 0.05, -Infinity, Infinity, 0);
    S[S.length - 2].lo = c[0] - r; S[S.length - 2].hi = c[0] + r; S[S.length - 1].lo = c[1] - r; S[S.length - 1].hi = c[1] + r;
  }
  num('stride', g as unknown as Record<string, unknown>, 'stride', 1, STRIDE0 * 0.8, STRIDE0 * 1.12, 0);
  // the gait's curves, each inside what a horse does: the trunk rides within a few centimetres of its mean height
  // (it is airborne for a tenth of a second: it cannot rise and fall far), surges little, pitches and flexes by degrees
  arr('height', g.height, 0.1); arr('sway', g.sway, 0.05, -(TRUNK_FREE ? 0.15 : arg('swaymax', 0.07)), TRUNK_FREE ? 0.15 : arg('swaymax', 0.07)); arr('pitch', g.pitch, 0.2);
  arr('flexion', g.flexion, 0.2, -20 * RAD, 20 * RAD);
  arr('neck', g.neck, 0.3, 20 * RAD, 70 * RAD); arr('neckBend', g.neckBend, 0.2, -10 * RAD, 10 * RAD); arr('head', g.head, 0.3, -60 * RAD, 0);
  for (const r of ROLES) {
    const L = g.legs[r];
    num(`${r}.xTD`, L as unknown as Record<string, unknown>, 'xTD', 0.3, -3, 3);
    if (LEG_FREE) { arr(`${r}.sx`, L.sx, 0.5, -6, 6); arr(`${r}.sy`, L.sy, 0.1, 0, 1.2); arr(`${r}.flex`, L.flex, 0.5, -15 * RAD, 135 * RAD); arr(`${r}.pas`, L.pas, 0.5); arr(`${r}.hoofPitch`, L.hoofPitch, 0.5); }
    else {
    arr(`${r}.sx`, L.sx, 0.5, -3, 3); arr(`${r}.sy`, L.sy, 0.1, 0, 0.7);
    arr(`${r}.flex`, L.flex, 0.5, -3 * RAD, 125 * RAD); arr(`${r}.pas`, L.pas, 0.5, -240 * RAD, 45 * RAD); arr(`${r}.hoofPitch`, L.hoofPitch, 0.5, -200 * RAD, 40 * RAD);
    }
    if (r.startsWith('fore')) arr(`${r}.scap`, L.scapOrFem, 0.2, -14 * RAD, 14 * RAD);
  }
  return S;
}

// ------------------------------------------------------------------ the first guess, read off the plate
/** periodic piecewise-linear interpolation of per-frame values at K control phases */
function fromPlate(vals: number[], Kn: number, unwrapAngle = false) {
  const pts = PF.map((f, i) => ({ ph: wrap1(f.phase), v: vals[i] })).sort((a, b) => a.ph - b.ph);
  if (unwrapAngle) for (let i = 1; i < pts.length; i++) { while (pts[i].v - pts[i - 1].v > Math.PI) pts[i].v -= 2 * Math.PI; while (pts[i].v - pts[i - 1].v < -Math.PI) pts[i].v += 2 * Math.PI; }
  return Array.from({ length: Kn }, (_, j) => {
    const ph = j / Kn;
    let b = pts.findIndex((p) => p.ph > ph);
    const hiP = b < 0 ? { ph: pts[0].ph + 1, v: pts[0].v } : pts[b];
    const loP = b <= 0 ? (b < 0 ? pts[pts.length - 1] : { ph: pts[pts.length - 1].ph - 1, v: pts[pts.length - 1].v }) : pts[b - 1];
    const t = (ph - loP.ph) / Math.max(1e-9, hiP.ph - loP.ph);
    return loP.v + (hiP.v - loP.v) * t;
  });
}
function firstGuess(): { sk: Skel; g: Gait } {
  const sk: Skel = JSON.parse(JSON.stringify(sk0));
  const pitch = PF.map((f) => ang(sub(f.P.withers, f.P.croup)));
  const height = PF.map((f) => -f.ground * BLm - 0.02);
  const legs = {} as Record<Role, LegCurves>;
  for (const r of ROLES) {
    const fore = r.startsWith('fore'), mid = fore ? 'knee' : 'hock', top = fore ? 'elbow' : 'stifle';
    const flex = PF.map((f) => {
      const a = sub(f.P[`${r}_${mid}`], f.P[top]), b = sub(f.P[`${r}_fetlock`], f.P[`${r}_${mid}`]);
      const t = Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]) * (fore ? -1 : 1);
      return Math.max(4 * RAD, Math.min(110 * RAD, t));
    });
    const seg = PF.map((f) => ang(sub(f.P[`${r}_hoof`], f.P[`${r}_fetlock`])));
    // (a hoof folds back and down, never over the top: every angle is taken in -315..45 deg)
    const pas = fromPlate(seg.map((v) => (v > Math.PI / 4 ? v - 2 * Math.PI : v)), K.pas);
    // measured stance -> designed stance: the toe is within 1 cm for a little before and after it is exactly down
    const [tdM, loM] = TIMING[r], pad = PAD;
    const td = tdM + pad, duty = loM - pad - td;
    // toe x at touchdown from the plate's planted frames (a planted hoof moves back by the stride per unit phase)
    const xs = PF.filter((f) => f.q.contact[r]).map((f) => f.P[`${r}_hoof`][0] * BLm + STRIDE0 * wrap1(f.phase - td + 0.5) - STRIDE0 * 0.5);
    // the toe's swing path: the plate's hoof, placed on a first guess of where the body is, at the spline's controls
    const xTD = xs.reduce((a, b) => a + b, 0) / xs.length - 0.56; // (the chest's origin is half a body ahead of the withers-croup midpoint)
    const hx = fromPlate(PF.map((f) => f.P[`${r}_hoof`][0] * BLm - 0.56), 48), hy = fromPlate(PF.map((f) => (f.P[`${r}_hoof`][1] - f.ground) * BLm), 48);
    const M = K.swing, sx: number[] = [], sy: number[] = [], DEAD = 0.05;
    for (let j = 0; j < M; j++) {
      const t = Math.max(0, Math.min(1, (j - 1) / (M - 3)));
      // sx is over v (the swing less its dead ends), sy over u
      const u = DEAD + t * (1 - 2 * DEAD), s = duty + u * (1 - duty), i = Math.round(wrap1(td + s) * 48) % 48;
      const q = t * t * t * (10 - 15 * t + 6 * t * t), win = (4 * t * (1 - t)) ** 3;
      sx.push(0); void hx; void i; void s; void q; void win;
      sy.push(Math.min(0.6, Math.max(0.05, hy[Math.round(wrap1(td + duty + t * (1 - duty)) * 48) % 48])));
    }
    legs[r] = {
      td: wrap1(td), duty, xTD, sx, sy, dead: DEAD, floor: 0.05, epsA: 0.08, epsB: 0.08,
      flex: fromPlate(flex, K.flex), pas, hoofPitch: pas.map((v) => Math.max(-3.4, Math.min(0.3, v + 0.55))),
      scapOrFem: new Array(K.scap).fill(0), breakover: 0.62, level: 0.2,
    };
  }
  const g: Gait = {
    stride: STRIDE0, speed: SPEED,
    height: new Array(K.trunk).fill([...height].sort((a, b) => a - b)[height.length >> 1]), sway: new Array(K.trunk).fill(0), pitch: fromPlate(pitch, K.trunk).map((v) => v * 0.5),
    flexion: Array.from({ length: K.trunk }, (_, j) => 6 * RAD * Math.cos(2 * Math.PI * (j / K.trunk - 0.15))),
    neck: new Array(K.neck).fill(42 * RAD), neckBend: new Array(K.neck).fill(-3 * RAD), head: new Array(K.neck).fill(-32 * RAD),
    legs,
  };
  return { sk, g };
}

// ------------------------------------------------------------------ the designed stride as the test sees it
const legName: Record<Role, string> = { foreLead: 'RF', foreTrail: 'LF', hindLead: 'RH', hindTrail: 'LH' };
function stridePoses(sk: Skel, g: Gait) { return Array.from({ length: NS }, (_, k) => pose(sk, g, k / NS)); }
function strideJoints(sk: Skel, g: Gait) { return stridePoses(sk, g).map((p) => gateJoints(p, LEAD)); }
function asPlate(j: Record<string, V>) {
  const o = [(j.withers[0] + j.croup[0]) / 2, (j.withers[1] + j.croup[1]) / 2], L = d2(j.withers, j.croup);
  const n = (p: V): V => [(p[0] - o[0]) / L, (p[1] - o[1]) / L];
  const out: Record<string, V> = { withers: n(j.withers), croup: n(j.croup), poll: n(j.poll), muzzle: n(j.muzzle) };
  out.elbow = n([(j.LF_elbow[0] + j.RF_elbow[0]) / 2, (j.LF_elbow[1] + j.RF_elbow[1]) / 2]);
  out.stifle = n([(j.LH_stifle[0] + j.RH_stifle[0]) / 2, (j.LH_stifle[1] + j.RH_stifle[1]) / 2]);
  for (const r of ROLES) {
    const fore = r.startsWith('fore'), l = legName[r];
    out[`${r}_${fore ? 'knee' : 'hock'}`] = n(j[`${l}_${fore ? 'knee' : 'hock'}`]);
    out[`${r}_fetlock`] = n(j[`${l}_fetlock`]); out[`${r}_hoof`] = n(j[`${l}_hoof`]);
    out[`${r}_top`] = n(j[`${l}_${fore ? 'elbow' : 'stifle'}`]);
  }
  return { P: out, L };
}
const KP = ['withers', 'croup', 'poll', 'muzzle', 'elbow', 'stifle', ...ROLES.flatMap((r) => [`${r}_${r.startsWith('fore') ? 'knee' : 'hock'}`, `${r}_fetlock`, `${r}_hoof`])];
const SEG = ROLES.flatMap((r) => { const m = `${r}_${r.startsWith('fore') ? 'knee' : 'hock'}`; return [[`${r}_top`, m], [m, `${r}_fetlock`], [`${r}_fetlock`, `${r}_hoof`]] as [string, string][]; });
const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const FLEXSIGN: Record<string, number> = { elbow: 1, knee: -1, fetlock: -1, stifle: -1, hock: 1 };
function flexions(j: Record<string, V>) {
  const out: { kind: string; v: number }[] = [];
  for (const leg of ['LF', 'RF', 'LH', 'RH']) {
    const fore = leg[1] === 'F';
    const chain = fore ? ['shoulder', 'elbow', 'knee', 'fetlock', 'hoof'] : ['hip', 'stifle', 'hock', 'fetlock', 'hoof'];
    const kinds = fore ? ['elbow', 'knee', 'fetlock'] : ['stifle', 'hock', 'fetlock'];
    kinds.forEach((kind, i) => {
      const a = sub(j[`${leg}_${chain[i + 1]}`], j[`${leg}_${chain[i]}`]), b = sub(j[`${leg}_${chain[i + 2]}`], j[`${leg}_${chain[i + 1]}`]);
      out.push({ kind, v: (FLEXSIGN[kind] * Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1])) / RAD });
    });
  }
  return out;
}

// ------------------------------------------------------------------ residuals
const W = { kp: 1 / 0.05, kpWorst: arg('wkpw', 60), seg: 1 / 8, segWorst: arg('wsegw', 0.6), limit: arg('wlim', 0.5), accel: arg('wacc', 1), spread: arg('wspread', 20), reach: arg('wreach', 40), spine: 0.6, smooth: 0.02, prior: 1, bound: 3000, nod: 40 };
const WS = arg('wsmooth', 1);
const hinge = (x: number) => (x > 0 ? x : 0);
const GROUPS: [string, number][] = [];
function residuals(sk: Skel, g: Gait, S: Spec[], x0: number[]) {
  const r: number[] = [];
  GROUPS.length = 0;
  const mark = (n: string) => GROUPS.push([n, r.length]);
  const PO = stridePoses(sk, g), J = PO.map((p) => gateJoints(p, LEAD));
  const T = g.stride / g.speed, dt = T / NS;
  // B5 / B4 at the plate's frames
  mark('plate');
  for (const f of PF) {
    const { P } = asPlate(J[f.k]);
    for (const k of KP) {
      const e: V = [P[k][0] - f.P[k][0], P[k][1] - f.P[k][1]];
      r.push(e[0] * W.kp, e[1] * W.kp, hinge(len(e) - arg('kph', 0.115)) * W.kpWorst);
    }
    for (const [a, b] of SEG) {
      const e = Math.abs(wrapPi(ang(sub(P[b], P[a])) - ang(sub(f.P[b], f.P[a])))) / RAD;
      r.push(e * W.seg, hinge(e - arg('segh', 19)) * W.segWorst);
    }
  }
  // joint limits and accelerations over the whole stride (as the test measures them, with margins)
  mark('limits+accel');
  const F = J.map(flexions);
  for (let i = 0; i < F[0].length; i++) {
    const kind = F[0][i].kind as keyof typeof TOL.joints, [lo, hi] = TOL.joints[kind], lim = TOL.accel[kind];
    const v = F.map((q) => q[i].v);
    for (let k = 1; k < NS; k++) v[k] = v[k - 1] + wrapPi((v[k] - v[k - 1]) * RAD) / RAD;
    // (one residual per sample: a root of summed squares has a kink at zero that stalls the solver)
    for (let k = 0; k < NS; k++) {
      r.push((hinge(lo + 5 - v[k]) + hinge(v[k] - (hi - 6))) * W.limit);
      const a = (v[(k + 1) % NS] - 2 * v[k] + v[(k + NS - 1) % NS]) / (dt * dt);
      r.push(hinge(Math.abs(a) / lim - 0.6) * W.accel);
    }
  }
  // gathered in suspension (every sample with no toe within 1.2 cm), spine, reach of the IK
  const BL = J.reduce((a, j) => a + d2(j.withers, j.croup), 0) / NS;
  const spR: number[] = [], reachR: number[] = [];
  const spine: number[] = [], air: boolean[] = [];
  for (let k = 0; k < NS; k++) {
    const j = J[k], hs = ROLES.map((ro) => j[`${legName[ro]}_hoof`]);
    air.push(hs.every((h) => h[1] > 0.012));
    { const xs = hs.map((h) => h[0]); spR.push(hs.every((h) => h[1] > 0.006) ? hinge((Math.max(...xs) - Math.min(...xs)) / BL - 0.555) * W.spread : 0); }
    const Pv = sub(j.buttock, j.croup), Tv = sub(j.girth, j.withers);
    spine.push(Math.abs(Math.atan2(Pv[0] * Tv[1] - Pv[1] * Tv[0], Pv[0] * Tv[0] + Pv[1] * Tv[1])) / RAD);
    const p = PO[k];
    for (const ro of ROLES) reachR.push(hinge(0.045 - p.legs[ro].reach) * W.reach, p.legs[ro].short * 20 * W.reach);
  }
  mark('spread'); r.push(...spR); mark('reach'); r.push(...reachR); mark('spine+nod');
  const susp = spine.filter((_, k) => air[k]), kPush = Math.round(wrap1(TIMING.hindLead[1]) * NS) - 2;
  const suspMean = susp.reduce((a, b) => a + b, 0) / Math.max(1, susp.length);
  r.push(hinge(11 - (Math.max(...spine) - Math.min(...spine))) * W.spine, hinge(suspMean + 4 - spine[kPush]) * W.spine);
  // the horse's size is the plate's (its withers to croup), so the bone ranges above mean what they say; and the trunk
  // rides within 7 cm of its mean height: it is airborne for a tenth of a second and cannot rise and fall far
  r.push((BL - BLm) * 400);
  { const hm = g.height.reduce((a, b) => a + b, 0) / g.height.length; for (const h of g.height) r.push(hinge(Math.abs(h - hm) - (TRUNK_FREE ? 0.25 : arg('hvar', 0.07))) * 600); }
  // (and pitches within 9 degrees of its mean attitude)
  { const pm = g.pitch.reduce((a, b) => a + b, 0) / g.pitch.length; for (const q of g.pitch) r.push(hinge(Math.abs(q - pm) - (TRUNK_FREE ? 20 : 9) * RAD) * 300); }
  // one nod, lowest near the plate's lowest: keep the poll's height (above the ground, body lengths) on the plate's
  for (const f of PF) { const j = J[f.k]; r.push(((j.poll[1] / d2(j.withers, j.croup)) - (f.P.poll[1] - f.ground)) * W.nod * 0.8); }
  // smooth curves, bones near a horse's, everything inside its bounds
  mark('smooth');
  // (second differences scaled to a derivative in phase: a third harmonic of 0.3 rad on a leg, or a second harmonic
  // of 3 cm / 3 deg on the trunk, costs about one unit)
  const curve = (c: number[], w: number) => { const n = c.length; for (let i = 0; i < n; i++) r.push((c[(i + 1) % n] - 2 * c[i] + c[(i + n - 1) % n]) * n * n * w * WS); };
  const open = (c: number[], w: number) => { const n = c.length; for (let i = 1; i + 1 < n; i++) r.push((c[i + 1] - 2 * c[i] + c[i - 1]) * n * n * w * WS); };
  curve(g.height, 0.2); curve(g.sway, 0.3); curve(g.pitch, 0.15); curve(g.flexion, 0.1); curve(g.neck, 0.1); curve(g.neckBend, 0.15); curve(g.head, 0.08);
  for (const ro of ROLES) { const L = g.legs[ro]; curve(L.flex, 0.012); curve(L.pas, 0.008); curve(L.hoofPitch, 0.006); open(L.sx, 0.004); open(L.sy, 0.03); if (ro.startsWith('fore')) curve(L.scapOrFem, 0.1); }
  mark('prior+bounds');
  S.forEach((s, i) => {
    const v = s.get();
    if (s.prior) r.push(((v - x0[i]) / s.scale) * s.prior * W.prior * 0.1);
    r.push(hinge(s.lo - v) * W.bound, hinge(v - s.hi) * W.bound);
  });
  return r;
}

// ------------------------------------------------------------------ Levenberg-Marquardt, numerical Jacobian
function solve(A: Float64Array, b: Float64Array, n: number) {
  // Cholesky; returns null when not positive definite
  const Lm = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = A[i * n + j];
    for (let k = 0; k < j; k++) s -= Lm[i * n + k] * Lm[j * n + k];
    if (i === j) { if (s <= 1e-14) return null; Lm[i * n + i] = Math.sqrt(s); } else Lm[i * n + j] = s / Lm[j * n + j];
  }
  const y = new Float64Array(n), x = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= Lm[i * n + k] * y[k]; y[i] = s / Lm[i * n + i]; }
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= Lm[k * n + i] * x[k]; x[i] = s / Lm[i * n + i]; }
  return x;
}
function fit(sk: Skel, g: Gait, iters: number) {
  const S = build(sk, g), n = S.length;
  const x0 = S.map((s) => s.get());
  const setAll = (x: ArrayLike<number>) => S.forEach((s, i) => s.set(x[i]));
  const cost = (r: number[]) => r.reduce((a, b) => a + b * b, 0);
  let x = Float64Array.from(x0), r = residuals(sk, g, S, x0), c = cost(r), lambda = 1e-2;
  let small = 0;
  console.log(`[fit] ${n} unknowns, ${r.length} residuals, cost ${c.toFixed(1)}`);
  // the Jacobian by finite differences every BROY-th iteration, Broyden rank-one updates in between
  const BROY = arg('broyden', 1);
  let Jm = new Float64Array(0), fresh = 0;
  for (let it = 0; it < iters; it++) {
    const m = r.length;
    if (fresh <= 0 || Jm.length !== m * n) {
      Jm = new Float64Array(m * n);
      for (let j = 0; j < n; j++) {
        const h = 1e-5 * S[j].scale, keep = x[j];
        S[j].set(keep + h);
        const rj = residuals(sk, g, S, x0);
        S[j].set(keep);
        for (let i = 0; i < m; i++) Jm[i * n + j] = (rj[i] - r[i]) / h;
      }
      fresh = BROY;
    }
    fresh--;
    const A = new Float64Array(n * n), gr = new Float64Array(n);
    for (let i = 0; i < m; i++) {
      const o = i * n, ri = r[i];
      for (let a = 0; a < n; a++) { const ja = Jm[o + a]; if (ja === 0) continue; gr[a] -= ja * ri; for (let b = 0; b <= a; b++) A[a * n + b] += ja * Jm[o + b]; }
    }
    for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) A[b * n + a] = A[a * n + b];
    let ok = false;
    for (let tries = 0; tries < 18 && !ok; tries++) {
      const B = Float64Array.from(A);
      for (let a = 0; a < n; a++) B[a * n + a] += lambda * (A[a * n + a] + 1e-3 / (S[a].scale * S[a].scale));
      const dx = solve(B, gr, n);
      if (dx) {
        const xn = x.map((v, i) => v + dx[i]);
        setAll(xn);
        const rn = residuals(sk, g, S, x0), cn = cost(rn);
        if (Number.isFinite(cn) && cn < c) {
          if (fresh > 0) { // Broyden: J += (dr - J dx) dx^T / (dx . dx)
            let dd = 0; for (let a = 0; a < n; a++) dd += dx[a] * dx[a];
            for (let i = 0; i < m; i++) { const o = i * n; let jd = 0; for (let a = 0; a < n; a++) jd += Jm[o + a] * dx[a]; const u = (rn[i] - r[i] - jd) / dd; if (u !== 0) for (let a = 0; a < n; a++) Jm[o + a] += u * dx[a]; }
          }
          x = xn; r = rn; ok = true; lambda = Math.max(1e-7, lambda / 3); small = (c - cn) / c < 1e-6 ? small + 1 : 0; if (small >= 12) it = iters; c = cn; continue; }
      }
      setAll(x);
      lambda *= 4;
    }
    if (it % 5 === 0 || !ok) console.log(`[fit] iter ${it} cost ${c.toFixed(2)} lambda ${lambda.toExponential(1)}`);
    if (!ok) { if (BROY > 1 && fresh < BROY - 1) { fresh = 0; lambda = 1e-2; continue; } break; }
  }
  setAll(x);
  const rf = residuals(sk, g, S, x0);
  console.log('[fit] cost by group: ' + GROUPS.map(([n, a], i) => `${n} ${rf.slice(a, GROUPS[i + 1]?.[1] ?? rf.length).reduce((q, v) => q + v * v, 0).toFixed(1)}`).join(', '));
  return { S, x0 };
}

// ------------------------------------------------------------------ the test's own verdict on the design
function recording(sk: Skel, g: Gait, shift = 0): Recording {
  const T = g.stride / g.speed, dt = T / NS;
  const at = (t: number): Sample => {
    const ph = wrap1(t / T + shift), z0 = g.speed * t, j: Record<string, V3> = {};
    for (const [k, v] of Object.entries(gateJoints(pose(sk, g, ph), LEAD))) j[k] = [k[0] === 'L' && k[2] === '_' ? 0.15 : k[0] === 'R' && k[2] === '_' ? -0.15 : 0, v[1], v[0] + z0];
    return { t, phase: ph, j };
  };
  const samples = Array.from({ length: 2 * NS + 2 }, (_, k) => at(k * dt));
  const realtime = Array.from({ length: Math.ceil((3 * T) / (1 / 60)) }, (_, k) => at((2 * NS + 2) * dt + k / 60));
  return { samples, perStride: NS, period: T, dt, forward: [0, 0, 1], up: [0, 1, 0], groundY: 0, lead: LEAD, realtime, dtRealtime: 1 / 60, speed: g.speed };
}

function sheet(sk: Skel, g: Gait, file: string) {
  const TW = 420, TH = 300, sc = 105, COL: Record<Role, string> = { foreLead: '#e5392e', foreTrail: '#ff9a1f', hindLead: '#2fb33f', hindTrail: '#2f8cff' };
  let s = '';
  PF.forEach((f, i) => {
    const ox = (i % 4) * TW + TW * 0.5, oy = Math.floor(i / 4) * TH + TH * 0.38;
    const { P } = asPlate(gateJoints(pose(sk, g, f.k / NS), LEAD));
    const pt = (p: V) => `${(ox + p[0] * sc).toFixed(1)},${(oy - p[1] * sc).toFixed(1)}`;
    const draw = (Q: Record<string, V>, dash: boolean) => {
      const ln = (a: string, b: string, c: string) => `<polyline points="${pt(Q[a])} ${pt(Q[b])}" stroke="${c}" stroke-width="${dash ? 1.5 : 2.5}" fill="none" ${dash ? 'stroke-dasharray="5 3"' : ''}/>`;
      let o = ln('croup', 'withers', dash ? '#888' : '#111') + ln('withers', 'poll', dash ? '#888' : '#111') + ln('poll', 'muzzle', dash ? '#888' : '#111');
      for (const r of ROLES) { const m = `${r}_${r.startsWith('fore') ? 'knee' : 'hock'}`; o += ln(`${r}_top`, m, COL[r]) + ln(m, `${r}_fetlock`, COL[r]) + ln(`${r}_fetlock`, `${r}_hoof`, COL[r]); }
      return o;
    };
    s += `<line x1="${ox - TW / 2}" x2="${ox + TW / 2}" y1="${oy - f.ground * sc}" y2="${oy - f.ground * sc}" stroke="#999"/>`;
    s += draw(f.P, true) + draw(P, false) + `<text x="${ox - TW / 2 + 6}" y="${oy - TH * 0.38 + 16}" font-family="Arial" font-size="13">frame ${f.q.frame} (sample ${f.k})</text>`;
  });
  fs.writeFileSync(file, `<svg xmlns="http://www.w3.org/2000/svg" width="${4 * TW}" height="${3 * TH}"><rect width="100%" height="100%" fill="#f4efe4"/>${s}</svg>`);
}

// ------------------------------------------------------------------ main
const saved = !process.argv.includes('--fresh') && fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
const { sk, g } = saved ? { sk: saved.skeleton as Skel, g: saved.gait as Gait } : firstGuess();
if (saved) g.sway ??= new Array(K.trunk).fill(0);
if (saved) for (const r of ROLES) { const [tdM, loM] = TIMING[r], L = g.legs[r]; L.td = wrap1(tdM + PAD); L.duty = loM - PAD - (tdM + PAD); L.dead = 0.05; L.floor = 0.05; L.epsA = L.epsB = 0.08; }
const iters = arg('iters', 40);
if (iters > 0) fit(sk, g, iters);
// where the clip loops: the test wants the loop seam no worse than any other step, so the stride's phase origin goes
// where no joint is at its fastest (the first quiet origin in steps of 1/48 of the stride)
let SHIFT = 0, rec = recording(sk, g), res = analyse(rec, plate);
for (let j = 1; j < 48 && /seam worse/.test(res.checks.find((c) => c.id === 'A10')!.value); j++) { SHIFT = j / 48; rec = recording(sk, g, SHIFT); res = analyse(rec, plate); }
console.log(`[design] phase origin of the clip: ${SHIFT.toFixed(4)} of a stride after plate frame 1`);
for (const c of res.checks) console.log(`${c.id === 'B1' || c.id === 'B2' ? 'INFO' : c.pass ? 'PASS' : 'FAIL'} ${c.id.padEnd(3)} ${c.value}   [${c.limit}]`);
for (const c of res.reference) console.log(`  plate ${c.pass ? 'pass' : 'FAIL'} ${c.id} ${c.value}`);
// measured contacts, for tuning TIMING
const J = strideJoints(sk, g);
for (const r of ROLES) {
  const c = J.map((j) => j[`${legName[r]}_hoof`][1] <= 0.01);
  const tdK = c.findIndex((v, k) => v && !c[(k + NS - 1) % NS]), loK = c.findIndex((v, k) => !v && c[(k + NS - 1) % NS]);
  console.log(`  ${r.padEnd(9)} measured td ${(tdK / NS).toFixed(3)} lo ${(loK / NS).toFixed(3)} (wanted ${TIMING[r].map((v) => wrap1(v).toFixed(3)).join(' ')}) duty ${(c.filter(Boolean).length / NS * 100).toFixed(1)}%`);
}
console.log('  skeleton', JSON.stringify(sk, (_, v) => (typeof v === 'number' ? Number(v.toFixed(4)) : v)));
console.log(`  stride ${g.stride.toFixed(3)} m, period ${(g.stride / g.speed).toFixed(3)} s; offset chosen by the test ${res.align.offset}`);
// ------------------------------------------------------------------ the rig and the keys, for Blender
/** bones head -> tail in the side view (x forward, y up, ground at 0) with the lateral offset of each end (left side) */
function rigOf(p: Pose, skel: Skel) {
  const at = (o: V, a: number, q: V): V => [o[0] + q[0] * Math.cos(a) - q[1] * Math.sin(a), o[1] + q[0] * Math.sin(a) + q[1] * Math.cos(a)];
  const c0 = at(p.chest, p.aChest, [-0.2, -0.32]);
  const B: { name: string; parent: string | null; head: V; tail: V; lat: [number, number] }[] = [];
  const bone = (name: string, parent: string | null, head: V, tail: V, lat: [number, number] = [0, 0]) => B.push({ name, parent, head, tail, lat });
  bone('chest', null, c0, at(c0, p.aChest, [0.3, 0]));
  bone('back', 'chest', p.j1, p.j2); bone('loin', 'back', p.j2, p.j3); bone('pelvis', 'loin', p.j3, at(p.j3, p.aPelvis, [-0.34, -0.08]));
  let h = p.neckBase;
  p.aNeck.forEach((a, i) => { const t: V = [h[0] + skel.lNeck * Math.cos(a), h[1] + skel.lNeck * Math.sin(a)]; bone(`neck${i + 1}`, i ? `neck${i}` : 'chest', h, t); h = t; });
  bone('head', 'neck3', p.atlas, at(p.atlas, p.aHead, [skel.lHead, 0]));
  const side = (r: Role) => (legName[r][0] === 'L' ? 'L' : 'R');
  for (const r of ROLES) {
    const l = p.legs[r], sd = side(r);
    if (r.startsWith('fore')) {
      bone(`scapula.${sd}`, 'chest', at(p.chest, p.aChest, skel.scapPivot), l.top, [0.09, 0.17]);
      bone(`humerus.${sd}`, `scapula.${sd}`, l.top, l.mid1, [0.17, 0.165]);
      bone(`radius.${sd}`, `humerus.${sd}`, l.mid1, l.mid2, [0.165, 0.135]);
      bone(`cannonF.${sd}`, `radius.${sd}`, l.mid2, l.fetlock, [0.135, 0.13]);
      bone(`pasternF.${sd}`, `cannonF.${sd}`, l.fetlock, l.coffin, [0.13, 0.13]);
      bone(`hoofF.${sd}`, `pasternF.${sd}`, l.coffin, l.toe, [0.13, 0.13]);
    } else {
      bone(`femur.${sd}`, 'pelvis', l.top, l.mid1, [0.13, 0.2]);
      bone(`tibia.${sd}`, `femur.${sd}`, l.mid1, l.mid2, [0.2, 0.165]);
      bone(`cannonH.${sd}`, `tibia.${sd}`, l.mid2, l.fetlock, [0.165, 0.15]);
      bone(`pasternH.${sd}`, `cannonH.${sd}`, l.fetlock, l.coffin, [0.15, 0.15]);
      bone(`hoofH.${sd}`, `pasternH.${sd}`, l.coffin, l.toe, [0.15, 0.15]);
    }
  }
  // the gallop test's joints: the bone each rides on, where it is at rest, and its lateral offset
  const M: Record<string, { bone: string; pos: V; lat: number }> = {
    withers: { bone: 'chest', pos: p.mk.withers, lat: 0 }, girth: { bone: 'chest', pos: p.mk.girth, lat: 0 },
    croup: { bone: 'pelvis', pos: p.mk.croup, lat: 0 }, buttock: { bone: 'pelvis', pos: p.mk.buttock, lat: 0 },
    poll: { bone: 'head', pos: p.mk.poll, lat: 0 }, muzzle: { bone: 'head', pos: p.mk.muzzle, lat: 0 },
  };
  for (const r of ROLES) {
    const l = p.legs[r], sd = side(r), n = legName[r], sg = sd === 'L' ? 1 : -1;
    if (r.startsWith('fore')) {
      M[`${n}_shoulder`] = { bone: `scapula.${sd}`, pos: l.top, lat: 0.17 * sg }; M[`${n}_elbow`] = { bone: `radius.${sd}`, pos: l.marker, lat: 0.165 * sg };
      M[`${n}_knee`] = { bone: `cannonF.${sd}`, pos: l.mid2, lat: 0.135 * sg }; M[`${n}_fetlock`] = { bone: `pasternF.${sd}`, pos: l.fetlock, lat: 0.13 * sg };
      M[`${n}_hoof`] = { bone: `hoofF.${sd}`, pos: l.toe, lat: 0.13 * sg };
    } else {
      M[`${n}_hip`] = { bone: 'pelvis', pos: l.top, lat: 0.13 * sg }; M[`${n}_stifle`] = { bone: `tibia.${sd}`, pos: l.marker, lat: 0.2 * sg };
      M[`${n}_hock`] = { bone: `cannonH.${sd}`, pos: l.mid2, lat: 0.165 * sg }; M[`${n}_fetlock`] = { bone: `pasternH.${sd}`, pos: l.fetlock, lat: 0.15 * sg };
      M[`${n}_hoof`] = { bone: `hoofH.${sd}`, pos: l.toe, lat: 0.15 * sg };
    }
  }
  return { bones: B, markers: M };
}
/** the horse standing square: the rest pose the armature is built in */
function standing(skel: Skel): Pose {
  const leg = (fore: boolean, x: number, flex: number): LegCurves => ({
    td: 0, duty: 0.9, xTD: x, sx: new Array(7).fill(0), sy: new Array(7).fill(0.1), dead: 0.05, floor: 0.05, epsA: 0.08, epsB: 0.08,
    flex: new Array(K.flex).fill(flex), pas: new Array(K.pas).fill((fore ? -57 : -55) * RAD), hoofPitch: new Array(K.hoof).fill(0),
    scapOrFem: new Array(K.scap).fill(0), breakover: 0.6, level: 0.2,
  });
  const mk = (H: number, hock: number, fx: number, hx: number): Gait => ({
    stride: 0, speed: 0, height: new Array(K.trunk).fill(H), sway: new Array(K.trunk).fill(0), pitch: new Array(K.trunk).fill(0), flexion: new Array(K.trunk).fill(0),
    neck: new Array(K.neck).fill(50 * RAD), neckBend: new Array(K.neck).fill(-7 * RAD), head: new Array(K.neck).fill(-42 * RAD),
    legs: { foreLead: leg(true, fx, 3 * RAD), foreTrail: leg(true, fx, 3 * RAD), hindLead: leg(false, hx, hock), hindTrail: leg(false, hx, hock) },
  });
  // toes under the shoulder and just behind the hip; the height that leaves the elbow its standing bend; the hock
  // flexion that then fits the hind leg
  const probe = pose(skel, mk(1.45, 0.5, 0, -1), 0.1);
  const fx = probe.legs.foreLead.top[0] - 0.03, hx = probe.legs.hindLead.top[0] - 0.1;
  let lo = 1.2, hi = 1.8;
  const elbow = (H: number) => { const l = pose(skel, mk(H, 0.5, fx, hx), 0.1).legs.foreLead; return wrapPi(l.aLower - l.aUpper); };
  for (let i = 0; i < 50; i++) { const H = (lo + hi) / 2; if (elbow(H) > 50 * RAD) lo = H; else hi = H; }
  const H = (lo + hi) / 2;
  // the hind leg: the cannon upright under the hock, the stifle with its standing bend (a search over where the toe
  // stands and how far the hock is flexed)
  let best = { e: Infinity, hock: 0.5, x: hx };
  for (let x = hx - 0.3; x <= hx + 0.15; x += 0.01) for (let hk = 0.1; hk <= 1.0; hk += 0.01) {
    const l = pose(skel, mk(H, hk, fx, x), 0.1).legs.hindLead;
    const e = wrapPi(l.aCannon + Math.PI / 2 - 0.06) ** 2 + ((l.reach - 0.07) / 0.1) ** 2;
    if (e < best.e) best = { e, hock: hk, x };
  }
  return pose(skel, mk(H, best.hock, fx, best.x), 0.1);
}
function exportRig(skel: Skel, gait: Gait, shift: number) {
  const rest = standing(skel), R = rigOf(rest, skel);
  const x0 = -(rest.mk.withers[0] + rest.mk.croup[0]) / 2;
  const sh = (v: V): V => [v[0] + x0, v[1]];
  const restAng = Object.fromEntries(R.bones.map((b) => [b.name, ang(sub(b.tail, b.head))]));
  const rot: Record<string, number[]> = Object.fromEntries(R.bones.map((b) => [b.name, []]));
  const chest: V[] = [];
  let meanX = 0;
  const poses = Array.from({ length: NS }, (_, k) => pose(skel, gait, k / NS + shift));
  for (const p of poses) meanX += (p.mk.withers[0] + p.mk.croup[0]) / 2 / NS;
  poses.forEach((p) => {
    const Rk = rigOf(p, skel);
    for (const b of Rk.bones) {
      let d = wrapPi(ang(sub(b.tail, b.head)) - restAng[b.name]);
      const prev = rot[b.name][rot[b.name].length - 1];
      if (prev !== undefined) d = prev + wrapPi(d - prev);
      rot[b.name].push(d);
    }
    const c = Rk.bones[0].head;
    chest.push([c[0] - meanX, c[1]]);
  });
  return {
    rest: { bones: R.bones.map((b) => ({ ...b, head: sh(b.head), tail: sh(b.tail) })), markers: Object.fromEntries(Object.entries(R.markers).map(([k, m]) => [k, { ...m, pos: sh(m.pos) }])) },
    keys: { n: NS, period: gait.stride / gait.speed, stride: gait.stride, speed: gait.speed, chest, rot },
  };
}
fs.mkdirSync('tools/blender/horse', { recursive: true });
fs.mkdirSync('build/gait', { recursive: true });
if (!process.argv.includes('--nosave')) fs.writeFileSync(OUT, JSON.stringify({ note: 'generated by tools/gait/design-gallop.ts; do not edit by hand', lead: LEAD, samplesPerStride: NS, skeleton: sk, gait: g, phaseOrigin: SHIFT, ...exportRig(sk, g, SHIFT) }, (_, v) => (typeof v === 'number' ? Number(v.toFixed(6)) : v)) + '\n');
sheet(sk, g, sarg('sheet', 'build/gait/design.svg'));
const fails = res.checks.filter((c) => !c.pass);
console.log(fails.length ? `[design] FAIL ${fails.map((c) => c.id).join(' ')}` : '[design] PASS');

if (process.argv.includes('--diag')) {
  // where the design misses the plate: the largest keypoint errors, and the trunk's curves
  const rows: [number, string][] = [];
  for (const f of PF) {
    const { P } = asPlate(J[Math.round(wrap1(f.phase - SHIFT + SHIFT) * NS) % NS]);
    for (const k of KP) rows.push([d2(P[k], f.P[k]), `f${f.q.frame} ${k.padEnd(18)} ours (${P[k].map((v) => v.toFixed(2))}) plate (${f.P[k].map((v) => v.toFixed(2))})`]);
  }
  rows.sort((a, b) => b[0] - a[0]);
  for (const [e, t] of rows.slice(0, 24)) console.log(e.toFixed(3), t);
  const byKp: Record<string, number> = {};
  for (const [e, t] of rows) { const k = t.split(' ')[1].replace(/^(fore|hind)(Lead|Trail)_/, '$1_'); byKp[k] = (byKp[k] ?? 0) + e / (rows.length / 18); }
  console.log(Object.entries(byKp).map(([k, v]) => `${k} ${v.toFixed(3)}`).join('  '));
  const fx = (a: number[], m = 1) => a.map((v) => (v * m).toFixed(m === 1 ? 3 : 0)).join(' ');
  console.log('height', fx(g.height), '| sway', fx(g.sway), '| pitch', fx(g.pitch, 57.3), '| flexion', fx(g.flexion, 57.3));
  console.log('neck', fx(g.neck, 57.3), '| bend', fx(g.neckBend, 57.3), '| head', fx(g.head, 57.3));
  for (const r of ROLES) { const L = g.legs[r]; console.log(r, 'xTD', L.xTD.toFixed(2), 'sx', fx(L.sx), 'sy', fx(L.sy), '\n   flex', fx(L.flex, 57.3), '| pas', fx(L.pas, 57.3), '| hoof', fx(L.hoofPitch, 57.3), '| scap', fx(L.scapOrFem, 57.3)); }
}

if (process.argv.includes('--frames')) {
  // per plate frame: the mean offset of our pose from the plate's (body lengths), the scale that would fit best, and
  // the error left once that offset and scale are taken out: how much of the misfit is the frame's own origin and unit
  for (const f of PF) {
    const { P } = asPlate(J[f.k]);
    const ks = KP.filter((k) => k !== 'withers' && k !== 'croup');
    const m = ks.reduce((a, k) => [a[0] + (P[k][0] - f.P[k][0]) / ks.length, a[1] + (P[k][1] - f.P[k][1]) / ks.length], [0, 0]);
    let num = 0, den = 0;
    for (const k of ks) { num += P[k][0] * f.P[k][0] + P[k][1] * f.P[k][1]; den += f.P[k][0] ** 2 + f.P[k][1] ** 2; }
    const sc = num / den;
    const raw = KP.reduce((a, k) => a + d2(P[k], f.P[k]) / KP.length, 0);
    const mo = ks.reduce((a, k) => [a[0] + (P[k][0] - sc * f.P[k][0]) / ks.length, a[1] + (P[k][1] - sc * f.P[k][1]) / ks.length], [0, 0]);
    const left = ks.reduce((a, k) => a + Math.hypot(P[k][0] - sc * f.P[k][0] - mo[0], P[k][1] - sc * f.P[k][1] - mo[1]) / ks.length, 0);
    console.log(`f${String(f.q.frame).padEnd(2)} BL ${f.BLpx.toFixed(0)} px  mean error ${raw.toFixed(3)}  offset (${m[0].toFixed(3)}, ${m[1].toFixed(3)})  best scale ${sc.toFixed(3)}  left after offset+scale ${left.toFixed(3)}`);
  }
}
