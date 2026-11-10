/**
 * The gallop test (GALLOP-TEST.md): the numbers. Pure math, no three.js, so the same code runs in the gait lab page
 * and in `pnpm test:gallop` (node). Input: one recorded stride of the horse's joints (Horse.gateJoints, 240 samples
 * per stride plus two past the loop seam), a real-time run (1/60 s steps), and the hand-annotated Muybridge plate
 * (refs/muybridge/keypoints.json). Output: PASS / FAIL per check.
 *
 * The tolerances below are the ones fixed in Round 1, before any animation existed. They are not loosened to make a
 * pass; if one proves wrong, that goes to the owner with the evidence.
 */

export type V3 = [number, number, number];
export type V2 = [number, number];
export type Role = 'foreLead' | 'foreTrail' | 'hindLead' | 'hindTrail';
export const ROLES: Role[] = ['hindTrail', 'hindLead', 'foreTrail', 'foreLead'];

export const TOL = {
  /** a hoof is planted when its sole is within this height of the ground (m) */
  contact: 0.01,
  /** 1: consecutive footfalls at least this far apart (fraction of the stride) to count as separate beats */
  beatGap: 0.03,
  /** 2: one airborne phase, starting at the leading fore's lift-off (within this many samples), lasting min..max */
  suspensionStartSlack: 2,
  suspension: [0.15, 0.3] as V2,
  /** 3: hoof spread along the body during suspension (body lengths, withers to croup). Owner's decision after Round 1:
   * the plate is the ground truth, so the limit is what the plate showed (0.54) plus a small margin */
  gathered: 0.6,
  /** 4: fraction of the stride each hoof is on the ground */
  duty: [0.18, 0.35] as V2,
  /** 5: how far a planted hoof may move over its stance (m) */
  slide: 0.01,
  /** 6: lowest a hoof may go below the ground (m) */
  penetration: 0.01,
  /** 7: range of the spine angle over the stride (deg) */
  spineRange: 8,
  /** 8: hysteresis for counting nods (body lengths); the poll's lowest point must fall within this many plate frame
   * intervals of the plate's lowest (owner's decision after Round 1: one nod per stride, timed to the plate) */
  nodHysteresis: 0.01,
  nodFrames: 1,
  /** 9: joint flexion limits (deg from straight; negative = hyperextension) */
  joints: {
    elbow: [10, 130], knee: [-5, 130], fetlock: [-95, 130], stifle: [10, 130], hock: [-5, 120],
  } as Record<JointKind, V2>,
  /** 10: angular acceleration limits (deg/s^2); the loop seam may be no worse than the worst other step */
  accel: { elbow: 60000, stifle: 60000, knee: 100000, hock: 100000, fetlock: 150000 } as Record<JointKind, number>,
  /** B4: limb segment angles vs the plate (deg) */
  segMean: 12, segWorst: 25,
  /** B5: keypoints vs the plate (body lengths) */
  kpMean: 0.08, kpWorst: 0.15,
};

export type JointKind = 'elbow' | 'knee' | 'fetlock' | 'stifle' | 'hock';
/** flexion sign per joint: + when flexing turns the distal segment counter-clockwise in a side view facing +x */
const FLEX: Record<JointKind, number> = { elbow: 1, knee: -1, fetlock: -1, stifle: -1, hock: 1 };

export interface Sample { t: number; phase: number; j: Record<string, V3> }
export interface Recording {
  /** two strides of 240 samples each (sample 0 just after the stride phase wraps), then 2 more: the first stride is
   * the one analysed, the second carries the loop seam and stances that cross it */
  samples: Sample[];
  perStride: number;
  /** stride period (s) and the step between samples */
  period: number;
  dt: number;
  /** horse heading and world up (unit), ground height */
  forward: V3; up: V3; groundY: number;
  lead: 'L' | 'R';
  /** 1/60 s steps over at least two strides (slide at real time) */
  realtime: Sample[];
  dtRealtime: number;
  speed: number;
}

export interface PlateFrame {
  frame: number; panel: [number, number, number, number]; groundY: number;
  contact: Record<Role, boolean>; points: Record<string, V2>;
}
export interface Plate { frames: PlateFrame[]; frameSpacing: { inches: number; seconds: number } }

export interface Check { id: string; name: string; pass: boolean; value: string; limit: string; detail?: string }

// ---------------------------------------------------------------- small math

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const d2 = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const sub2 = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
const mid2 = (a: V2, b: V2): V2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const deg = (r: number) => (r * 180) / Math.PI;
const angle2 = (a: V2, b: V2) => deg(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]));
const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : String(x));
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** leg name per role on a lead (the leading fore is on the lead side) */
export function legOf(role: Role, lead: 'L' | 'R') {
  const other = lead === 'L' ? 'R' : 'L';
  return { foreLead: `${lead}F`, foreTrail: `${other}F`, hindLead: `${lead}H`, hindTrail: `${other}H` }[role];
}

/** cyclic runs of true in a boolean array: [start, length] */
export function runs(a: boolean[]): [number, number][] {
  const n = a.length;
  if (a.every(Boolean)) return [[0, n]];
  if (!a.some(Boolean)) return [];
  let s0 = a.findIndex((v, i) => !v && a[(i + 1) % n]);
  const out: [number, number][] = [];
  for (let k = 1; k <= n; k++) {
    const i = (s0 + k) % n;
    if (a[i] && !a[(i - 1 + n) % n]) {
      let len = 0;
      while (a[(i + len) % n] && len < n) len++;
      out.push([i, len]);
    }
  }
  return out;
}
/** linear (non-cyclic) runs that start and end inside the array */
function innerRuns(a: boolean[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 1; i < a.length; i++) {
    if (a[i] && !a[i - 1]) {
      let len = 0;
      while (i + len < a.length && a[i + len]) len++;
      if (i + len < a.length) out.push([i, len]);
      i += len;
    }
  }
  return out;
}

// ---------------------------------------------------------------- the stride as series (ours and the plate's)

/** what checks 1-4 and 8 need, from either source */
export interface Series {
  n: number;
  contact: Record<Role, boolean[]>;
  /** hoof position along the body (forward) and the poll's height, in body lengths */
  hoofX: Record<Role, number[]>;
  poll: number[];
}

/** side view of a world point: [forward, up] */
const sideOf = (rec: Recording) => (p: V3): V2 => [dot(p, rec.forward), dot(p, rec.up)];

export function bodyLength(rec: Recording) {
  const side = sideOf(rec);
  return mean(rec.samples.slice(0, rec.perStride).map((s) => d2(side(s.j.withers), side(s.j.croup))));
}

export function oursSeries(rec: Recording): Series {
  const n = rec.perStride, side = sideOf(rec), BL = bodyLength(rec);
  const S = rec.samples.slice(0, n);
  const contact = {} as Record<Role, boolean[]>, hoofX = {} as Record<Role, number[]>;
  for (const r of ROLES) {
    const leg = legOf(r, rec.lead);
    contact[r] = S.map((s) => dot(s.j[`${leg}_hoof`], rec.up) - rec.groundY <= TOL.contact);
    hoofX[r] = S.map((s) => side(s.j[`${leg}_hoof`])[0] / BL);
  }
  return { n, contact, hoofX, poll: S.map((s) => (dot(s.j.poll, rec.up) - rec.groundY) / BL) };
}

/** plate frames in side view (x forward, y up, card pixels) */
const plateSide = (p: V2): V2 => [p[0], -p[1]];

/** the plate's stride: frame spacing D (pixels per frame interval at the horse) and stride length N (intervals) */
export function plateStride(plate: Plate) {
  const fr = plate.frames;
  const rel = (q: PlateFrame, r: Role) => q.points[`${r}_hoof`][0] - q.points.withers[0];
  // a planted hoof moves back past the body by one frame spacing per frame
  const ds: number[] = [];
  for (let i = 0; i + 1 < fr.length; i++) for (const r of ROLES) {
    if (fr[i].contact[r] && fr[i + 1].contact[r] && fr[i + 1].frame === fr[i].frame + 1) ds.push(rel(fr[i], r) - rel(fr[i + 1], r));
  }
  const D = median(ds);
  // a hoof planted in two separate stances: the second plant is one stride further on
  const Ns: number[] = [];
  for (const r of ROLES) {
    const idx = fr.map((q, i) => (q.contact[r] ? i : -1)).filter((i) => i >= 0);
    const groups: number[][] = [];
    for (const i of idx) { const g = groups[groups.length - 1]; if (g && i === g[g.length - 1] + 1) g.push(i); else groups.push([i]); }
    if (groups.length < 2) continue;
    for (const a of groups[0]) for (const b of groups[groups.length - 1]) {
      Ns.push(fr[b].frame - fr[a].frame + (rel(fr[b], r) - rel(fr[a], r)) / D);
    }
  }
  const N = mean(Ns);
  return { D, N, displacements: ds, strideEstimates: Ns, phase: fr.map((q) => (q.frame - fr[0].frame) / N) };
}

export function plateSeries(plate: Plate): Series {
  const { phase } = plateStride(plate);
  const fr = plate.frames.filter((_, i) => phase[i] < 1);
  const BL = mean(fr.map((q) => d2(plateSide(q.points.withers), plateSide(q.points.croup))));
  const contact = {} as Record<Role, boolean[]>, hoofX = {} as Record<Role, number[]>;
  for (const r of ROLES) {
    contact[r] = fr.map((q) => q.contact[r]);
    hoofX[r] = fr.map((q) => (q.points[`${r}_hoof`][0] - q.points.withers[0]) / BL);
  }
  return { n: fr.length, contact, hoofX, poll: fr.map((q) => (q.groundY - q.points.poll[1]) / BL) };
}

// ---------------------------------------------------------------- Part A checks on a series

function checkFootfalls(s: Series): Check {
  const name = 'Footfall order: four beats, trailing hind, leading hind, trailing fore, leading fore';
  const R = Object.fromEntries(ROLES.map((r) => [r, runs(s.contact[r])])) as Record<Role, [number, number][]>;
  const bad = ROLES.filter((r) => R[r].length !== 1);
  if (bad.length) return { id: 'A1', name, pass: false, value: ROLES.map((r) => `${r} ${R[r].length} stance(s)`).join(', '), limit: 'one stance per hoof per stride' };
  const td = Object.fromEntries(ROLES.map((r) => [r, R[r][0][0]])) as Record<Role, number>;
  const at = (r: Role) => (td[r] - td.hindTrail + s.n) % s.n;
  const seq = [0, at('hindLead'), at('foreTrail'), at('foreLead'), s.n];
  const gaps = seq.slice(1).map((v, i) => (v - seq[i]) / s.n);
  const pass = gaps.every((g) => g >= TOL.beatGap);
  const order = [...ROLES].sort((a, b) => at(a) - at(b));
  return { id: 'A1', name, pass, value: `order ${order.join(' > ')}; gaps ${gaps.map(pct).join(' ')}`, limit: `that order, beats >= ${pct(TOL.beatGap)} apart` };
}

function suspensionRuns(s: Series) {
  const air = Array.from({ length: s.n }, (_, i) => ROLES.every((r) => !s.contact[r][i]));
  return runs(air);
}

function checkSuspension(s: Series): Check {
  const name = 'Suspension: one airborne phase per stride, after the leading fore lifts';
  const A = suspensionRuns(s);
  const limit = `exactly one, ${pct(TOL.suspension[0])}..${pct(TOL.suspension[1])} of the stride`;
  if (A.length !== 1) return { id: 'A2', name, pass: false, value: `${A.length} airborne phases`, limit };
  const lf = runs(s.contact.foreLead);
  const lift = lf.length === 1 ? (lf[0][0] + lf[0][1]) % s.n : -1;
  const off = lift < 0 ? Infinity : Math.min((A[0][0] - lift + s.n) % s.n, (lift - A[0][0] + s.n) % s.n);
  const frac = A[0][1] / s.n;
  const pass = off <= TOL.suspensionStartSlack && frac >= TOL.suspension[0] && frac <= TOL.suspension[1];
  return { id: 'A2', name, pass, value: `${pct(frac)}, starts ${off === Infinity ? 'with no single leading-fore stance' : `${off} sample(s) from the leading fore's lift-off`}`, limit };
}

function checkGathered(s: Series): Check {
  const name = 'Gathered in suspension: hooves folded under the body';
  const A = suspensionRuns(s);
  if (!A.length) return { id: 'A3', name, pass: false, value: 'no suspension', limit: `spread <= ${TOL.gathered} body lengths` };
  let worst = 0;
  for (const [a, len] of A) for (let k = 0; k < len; k++) {
    const i = (a + k) % s.n, xs = ROLES.map((r) => s.hoofX[r][i]);
    worst = Math.max(worst, Math.max(...xs) - Math.min(...xs));
  }
  return { id: 'A3', name, pass: worst <= TOL.gathered, value: `widest spread ${f(worst)} body lengths`, limit: `<= ${TOL.gathered}` };
}

function checkDuty(s: Series): Check {
  const name = 'Duty factor: each hoof on the ground';
  const d = ROLES.map((r) => s.contact[r].filter(Boolean).length / s.n);
  const pass = d.every((x) => x >= TOL.duty[0] && x <= TOL.duty[1]);
  return { id: 'A4', name, pass, value: ROLES.map((r, i) => `${r} ${pct(d[i])}`).join(', '), limit: `${pct(TOL.duty[0])}..${pct(TOL.duty[1])}` };
}

/** lowest sample of a cyclic series, refined to a fraction of a sample by a parabola through its neighbours */
function lowest(v: number[]) {
  const n = v.length, i = v.indexOf(Math.min(...v));
  const a = v[(i - 1 + n) % n], b = v[i], c = v[(i + 1) % n], den = a - 2 * b + c;
  return i + (den > 1e-12 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0);
}

/**
 * Check 8. `plateLow` is where the plate's poll is lowest, as a sample index of this series (the plate frame's
 * aligned sample), and `frame` one plate frame interval in samples. For the plate itself the timing is its own.
 */
function checkNod(s: Series, plateLow?: { at: number; frame: number; label: string }): Check {
  const name = 'Head and neck: one nod per stride, timed to the plate';
  const n = s.n, m = mean(s.poll), h = TOL.nodHysteresis;
  // count down-crossings of the mean with hysteresis, round the loop
  let armed = false, nods = 0;
  for (let k = 0; k < 2 * n; k++) {
    const v = s.poll[k % n];
    if (v > m + h) armed = true;
    if (armed && v < m - h) { armed = false; if (k >= n) nods++; }
  }
  // (counted over the second lap only, so the starting state does not matter)
  const lo = lowest(s.poll);
  const amp = Math.max(...s.poll) - Math.min(...s.poll);
  const limit = `exactly one nod, poll lowest within ${TOL.nodFrames} plate frame of the plate's lowest`;
  if (!plateLow) return { id: 'A8', name, pass: nods === 1, value: `${nods} nod(s), poll range ${f(amp, 3)} body lengths, lowest at sample ${f(lo, 1)}/${n}`, limit };
  const d = Math.abs(lo - plateLow.at), off = Math.min(d, n - d) / plateLow.frame;
  return {
    id: 'A8', name, pass: nods === 1 && off <= TOL.nodFrames,
    value: `${nods} nod(s), poll range ${f(amp, 3)} body lengths, lowest ${f(off, 2)} plate frame(s) from the plate's lowest (${plateLow.label})`,
    limit,
  };
}

// ---------------------------------------------------------------- Part A checks that need the 3D recording

function checkSlide(rec: Recording): Check {
  const name = 'No sliding: a planted hoof stays put over its stance';
  const horiz = (p: V3): V3 => { const u = dot(p, rec.up); return [p[0] - u * rec.up[0], p[1] - u * rec.up[1], p[2] - u * rec.up[2]]; };
  // every whole stance inside the recording (two strides at 0.25x, several at 1x); a stance caught in a single
  // sample cannot show a slide, so only stances of two samples or more count as measured
  const one = (S: Sample[]) => {
    let worst = 0, stances = 0;
    for (const r of ROLES) {
      const leg = legOf(r, rec.lead);
      const c = S.map((s) => dot(s.j[`${leg}_hoof`], rec.up) - rec.groundY <= TOL.contact);
      for (const [a, len] of innerRuns(c)) {
        if (len < 2) continue;
        stances++;
        const p0 = horiz(S[a].j[`${leg}_hoof`]);
        for (let k = 0; k < len; k++) {
          const p = horiz(S[a + k].j[`${leg}_hoof`]);
          worst = Math.max(worst, Math.hypot(p[0] - p0[0], p[1] - p0[1], p[2] - p0[2]));
        }
      }
    }
    return { worst, stances };
  };
  const slow = one(rec.samples), rt = one(rec.realtime);
  const pass = slow.stances > 0 && rt.stances > 0 && slow.worst <= TOL.slide && rt.worst <= TOL.slide;
  return {
    id: 'A5', name, pass,
    value: `0.25x: ${slow.stances ? `${f(slow.worst * 100, 1)} cm over ${slow.stances} stances` : 'no stance long enough to measure'}; 1x: ${rt.stances ? `${f(rt.worst * 100, 1)} cm over ${rt.stances} stances` : 'no stance long enough to measure'}`,
    limit: `<= ${TOL.slide * 100} cm at both`,
  };
}

function checkGround(rec: Recording): Check {
  const name = 'No ground penetration or float: planted hooves within 1 cm of the ground';
  let low = Infinity;
  const touched: string[] = [];
  for (const r of ROLES) {
    const leg = legOf(r, rec.lead);
    const h = [...rec.samples, ...rec.realtime].map((s) => dot(s.j[`${leg}_hoof`], rec.up) - rec.groundY);
    low = Math.min(low, ...h);
    if (Math.min(...h) <= TOL.contact) touched.push(r);
  }
  const float = ROLES.filter((r) => !touched.includes(r));
  const pass = low >= -TOL.penetration && float.length === 0;
  return {
    id: 'A6', name, pass,
    value: `lowest hoof ${f(low * 100, 1)} cm${float.length ? `; never within 1 cm: ${float.join(', ')}` : ''}`,
    limit: `>= -${TOL.penetration * 100} cm, every hoof reaches the ground`,
  };
}

function spineSeries(rec: Recording) {
  const side = sideOf(rec);
  return rec.samples.slice(0, rec.perStride).map((s) => {
    const P = sub2(side(s.j.buttock), side(s.j.croup)), T = sub2(side(s.j.girth), side(s.j.withers));
    return Math.abs(angle2(P, T));
  });
}

function checkSpine(rec: Recording, s: Series): Check {
  const name = 'Spine: flexes and extends once per stride, flexed in suspension, extended at hind push-off';
  const E = spineSeries(rec);
  const range = Math.max(...E) - Math.min(...E);
  const A = suspensionRuns(s);
  const hl = runs(s.contact.hindLead);
  let order = 'no suspension or no single hind stance to compare';
  let ok = false;
  if (A.length === 1 && hl.length === 1) {
    const susp = mean(Array.from({ length: A[0][1] }, (_, k) => E[(A[0][0] + k) % s.n]));
    const push = E[(hl[0][0] + hl[0][1] - 1) % s.n];
    ok = susp < push;
    order = `angle in suspension ${f(susp, 1)} deg vs at hind push-off ${f(push, 1)} deg`;
  }
  return { id: 'A7', name, pass: range >= TOL.spineRange && ok, value: `range ${f(range, 1)} deg; ${order}`, limit: `range >= ${TOL.spineRange} deg, smaller (flexed) in suspension` };
}

/** signed flexion series per joint and leg (deg) over all recorded samples */
export function jointSeries(rec: Recording, samples = rec.samples) {
  const side = sideOf(rec);
  const out: { leg: string; kind: JointKind; v: number[] }[] = [];
  for (const leg of ['LF', 'RF', 'LH', 'RH']) {
    const fore = leg[1] === 'F';
    const chain = fore ? ['shoulder', 'elbow', 'knee', 'fetlock', 'hoof'] : ['hip', 'stifle', 'hock', 'fetlock', 'hoof'];
    const kinds: JointKind[] = fore ? ['elbow', 'knee', 'fetlock'] : ['stifle', 'hock', 'fetlock'];
    kinds.forEach((kind, i) => {
      const v = samples.map((s) => {
        const a = side(s.j[`${leg}_${chain[i]}`]), b = side(s.j[`${leg}_${chain[i + 1]}`]), c = side(s.j[`${leg}_${chain[i + 2]}`]);
        return FLEX[kind] * angle2(sub2(b, a), sub2(c, b));
      });
      for (let k = 1; k < v.length; k++) v[k] = v[k - 1] + wrap180(v[k] - v[k - 1]);
      out.push({ leg, kind, v });
    });
  }
  return out;
}

function checkJointLimits(rec: Recording): Check {
  const name = 'Joint limits: knee, hock, fetlock, elbow, stifle inside anatomical ranges';
  const bad: string[] = [];
  const all = jointSeries(rec, rec.samples.slice(0, rec.perStride));
  for (const { leg, kind, v } of all) {
    const [lo, hi] = TOL.joints[kind], mn = Math.min(...v), mx = Math.max(...v);
    if (mn < lo || mx > hi) bad.push(`${leg} ${kind} ${f(mn, 0)}..${f(mx, 0)}`);
  }
  return {
    id: 'A9', name, pass: bad.length === 0, value: bad.length ? `outside: ${bad.join('; ')}` : 'all inside',
    limit: Object.entries(TOL.joints).map(([k, [a, b]]) => `${k} ${a}..${b}`).join(', '),
  };
}

function checkSmooth(rec: Recording): Check {
  const name = 'Slow-motion smoothness: no angular-acceleration spike, loop seam no worse than any other step';
  const n = rec.perStride, dt = rec.dt;
  const spikes: string[] = [], seams: string[] = [];
  for (const { leg, kind, v } of jointSeries(rec, rec.samples.slice(0, n + 2))) {
    // v has n + 2 samples: 0..n-1 the stride, n and n+1 past the seam
    const vel = v.slice(1).map((x, k) => x - v[k]);
    const acc = Array.from({ length: v.length - 2 }, (_, k) => (v[k + 2] - 2 * v[k + 1] + v[k]) / (dt * dt));
    const worst = Math.max(...acc.map(Math.abs));
    if (worst > TOL.accel[kind]) spikes.push(`${leg} ${kind} ${f(worst / 1000, 0)}k`);
    // the seam step: sample n-1 -> n; its accelerations: centred at n-1 and n (acc indices n-2, n-1)
    const otherVel = Math.max(...vel.filter((_, k) => k !== n - 1).map(Math.abs));
    const otherAcc = Math.max(...acc.filter((_, k) => k !== n - 2 && k !== n - 1).map(Math.abs));
    const seamVel = Math.abs(vel[n - 1]), seamAcc = Math.max(Math.abs(acc[n - 2]), Math.abs(acc[n - 1]));
    if (seamVel > otherVel + 0.01 || seamAcc > otherAcc + 1) seams.push(`${leg} ${kind}`);
  }
  return {
    id: 'A10', name, pass: !spikes.length && !seams.length,
    value: `${spikes.length ? `spikes: ${spikes.join(', ')}` : 'no spikes'}; ${seams.length ? `seam worse in ${seams.join(', ')}` : 'seam clean'}`,
    limit: Object.entries(TOL.accel).map(([k, a]) => `${k} ${a / 1000}k`).join(', ') + ' deg/s^2',
  };
}

// ---------------------------------------------------------------- Part B: against the plate

const KP = ['withers', 'croup', 'poll', 'muzzle', 'elbow', 'stifle'];
const LEGPTS: Record<Role, string[]> = {
  foreLead: ['knee', 'fetlock', 'hoof'], foreTrail: ['knee', 'fetlock', 'hoof'],
  hindLead: ['hock', 'fetlock', 'hoof'], hindTrail: ['hock', 'fetlock', 'hoof'],
};
export const PLATE_POINTS = [...KP, ...ROLES.flatMap((r) => LEGPTS[r].map((j) => `${r}_${j}`))];

/** our side-view pose at a sample, keyed like the plate (roles; elbow and stifle as the mean of the pair) */
export function oursAsPlate(rec: Recording, s: Sample): Record<string, V2> {
  const side = sideOf(rec), out: Record<string, V2> = {};
  for (const k of ['withers', 'croup', 'poll', 'muzzle']) out[k] = side(s.j[k]);
  out.elbow = mid2(side(s.j.LF_elbow), side(s.j.RF_elbow));
  out.stifle = mid2(side(s.j.LH_stifle), side(s.j.RH_stifle));
  for (const r of ROLES) {
    const leg = legOf(r, rec.lead);
    for (const j of LEGPTS[r]) out[`${r}_${j}`] = side(s.j[`${leg}_${j}`]);
    out[`${r}_top`] = side(s.j[`${leg}_${r.startsWith('fore') ? 'elbow' : 'stifle'}`]);
  }
  return out;
}

/** a pose with the withers-croup midpoint at the origin and withers-croup length 1 */
export function normalise(P: Record<string, V2>) {
  const o = mid2(P.withers, P.croup), L = d2(P.withers, P.croup), out: Record<string, V2> = {};
  for (const [k, v] of Object.entries(P)) out[k] = [(v[0] - o[0]) / L, (v[1] - o[1]) / L];
  return out;
}

export function plateNormalised(q: PlateFrame) {
  const P: Record<string, V2> = {};
  for (const [k, v] of Object.entries(q.points)) P[k] = plateSide(v);
  for (const r of ROLES) P[`${r}_top`] = P[r.startsWith('fore') ? 'elbow' : 'stifle'];
  return normalise(P);
}

function segments(r: Role): [string, string][] {
  const [mid, fet, hoof] = LEGPTS[r];
  return [[`${r}_top`, `${r}_${mid}`], [`${r}_${mid}`, `${r}_${fet}`], [`${r}_${fet}`, `${r}_${hoof}`]];
}

export function align(rec: Recording, plate: Plate) {
  const n = rec.perStride, st = plateStride(plate);
  const ours = rec.samples.slice(0, n).map((s) => normalise(oursAsPlate(rec, s)));
  const plates = plate.frames.map(plateNormalised);
  const err = (o: number) => {
    let sum = 0, cnt = 0;
    plate.frames.forEach((_, i) => {
      const s = (o + Math.round(st.phase[i] * n)) % n;
      for (const k of PLATE_POINTS) { sum += d2(ours[s][k], plates[i][k]); cnt++; }
    });
    return sum / cnt;
  };
  let best = 0, bestE = Infinity;
  for (let o = 0; o < n; o++) { const e = err(o); if (e < bestE) { bestE = e; best = o; } }
  const index = plate.frames.map((_, i) => (best + Math.round(st.phase[i] * n)) % n);
  return { offset: best, index, stride: st, ours, plates };
}

function partB(rec: Recording, plate: Plate, al: ReturnType<typeof align>): Check[] {
  const n = rec.perStride;
  const out: Check[] = [];
  out.push({
    id: 'B1', name: 'Phase alignment to the plate', pass: true,
    value: `plate stride ${f(al.stride.N)} frame intervals (${f(al.stride.N * plate.frameSpacing.inches, 0)} in at ${plate.frameSpacing.inches} in per frame); best offset sample ${al.offset}/${n}`,
    limit: 'best mean keypoint fit over all offsets',
  });
  out.push({ id: 'B2', name: 'Side view, normalised by withers-to-croup', pass: true, value: `${PLATE_POINTS.length} keypoints x ${plate.frames.length} frames`, limit: '-' });
  // B3 contact pattern
  const mism: string[] = [];
  plate.frames.forEach((q, i) => {
    const s = rec.samples[al.index[i]];
    for (const r of ROLES) {
      const ourC = dot(s.j[`${legOf(r, rec.lead)}_hoof`], rec.up) - rec.groundY <= TOL.contact;
      if (ourC !== q.contact[r]) mism.push(`f${q.frame} ${r} ${ourC ? 'down' : 'up'} vs ${q.contact[r] ? 'down' : 'up'}`);
    }
  });
  out.push({ id: 'B3', name: 'Contact pattern matches the plate in every frame', pass: !mism.length, value: mism.length ? `${mism.length} mismatches: ${mism.slice(0, 6).join('; ')}${mism.length > 6 ? '; ...' : ''}` : 'all match', limit: 'every hoof, every frame' });
  // B4 segment angles
  const segErr: number[] = [];
  let segWorstAt = '';
  plate.frames.forEach((q, i) => {
    const O = al.ours[al.index[i]], P = al.plates[i];
    for (const r of ROLES) for (const [a, b] of segments(r)) {
      const e = Math.abs(wrap180(angle2(sub2(O[b], O[a]), sub2(P[b], P[a]))));
      if (e > Math.max(0, ...segErr)) segWorstAt = `f${q.frame} ${a.replace('_top', '_' + (r.startsWith('fore') ? 'elbow' : 'stifle'))}-${b.split('_')[1]}`;
      segErr.push(e);
    }
  });
  const sm = mean(segErr), sw = Math.max(...segErr);
  out.push({ id: 'B4', name: 'Limb segment angles', pass: sm <= TOL.segMean && sw <= TOL.segWorst, value: `mean ${f(sm, 1)} deg, worst ${f(sw, 1)} deg (${segWorstAt})`, limit: `mean <= ${TOL.segMean}, worst <= ${TOL.segWorst} deg` });
  // B5 keypoints
  const kpErr: number[] = [];
  let kpWorstAt = '';
  plate.frames.forEach((q, i) => {
    const O = al.ours[al.index[i]], P = al.plates[i];
    for (const k of PLATE_POINTS) { const e = d2(O[k], P[k]); if (e > Math.max(0, ...kpErr)) kpWorstAt = `f${q.frame} ${k}`; kpErr.push(e); }
  });
  const km = mean(kpErr), kw = Math.max(...kpErr);
  out.push({ id: 'B5', name: 'Keypoints', pass: km <= TOL.kpMean && kw <= TOL.kpWorst, value: `mean ${f(km, 3)}, worst ${f(kw, 3)} body lengths (${kpWorstAt})`, limit: `mean <= ${TOL.kpMean}, worst <= ${TOL.kpWorst}` });
  return out;
}

// ---------------------------------------------------------------- everything

export function analyse(rec: Recording, plate: Plate) {
  const s = oursSeries(rec);
  const al = align(rec, plate);
  // the plate itself through the checks that can be read off it: a check the plate fails is a wrong check
  const ps = plateSeries(plate);
  // check 8's timing: the plate frame where the poll is lowest, at its aligned sample of our stride
  const pl = lowest(ps.poll), perFrame = rec.perStride / al.stride.N;
  const plateLow = { at: (al.offset + pl * perFrame) % rec.perStride, frame: perFrame, label: `frame ${f(plate.frames[0].frame + pl, 1)}` };
  const partA = [
    checkFootfalls(s), checkSuspension(s), checkGathered(s), checkDuty(s), checkSlide(rec), checkGround(rec),
    checkSpine(rec, s), checkNod(s, plateLow), checkJointLimits(rec), checkSmooth(rec),
  ];
  const B = partB(rec, plate, al);
  const reference = [checkFootfalls(ps), checkSuspension(ps), checkGathered(ps), checkDuty(ps), checkNod(ps)];
  return { checks: [...partA, ...B], align: al, reference, bodyLength: bodyLength(rec), plateSamples: ps.n };
}
