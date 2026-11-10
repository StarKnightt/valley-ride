/**
 * The horse's skeleton in the side view (x forward, y up, metres) and its gallop as curves over the stride phase.
 * This is the rig's forward kinematics, exactly as Blender builds it (tools/blender/horse/) and the runtime plays it:
 * every bone turns about the lateral axis only, so the side view is the whole motion.
 *
 * A pose is driven by a handful of periodic curves (trunk height, pitch, spine flexion, neck, head; per leg the knee
 * or hock flexion, the pastern, the hoof's pitch, and the toe's path) and two-link IK closes each leg: shoulder (or
 * hip) to fetlock, through the humerus (femur) and the forearm + cannon (gaskin + cannon) at the given flexion. A
 * planted toe is therefore planted exactly, and everything is smooth (C2) by construction.
 */
export type V = [number, number];
export type Role = 'foreLead' | 'foreTrail' | 'hindLead' | 'hindTrail';
export const ROLES: Role[] = ['hindTrail', 'hindLead', 'foreTrail', 'foreLead'];

export const dir = (a: number): V => [Math.cos(a), Math.sin(a)];
export const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1]];
export const mul = (a: V, s: number): V => [a[0] * s, a[1] * s];
export const rot = (a: V, t: number): V => { const c = Math.cos(t), s = Math.sin(t); return [a[0] * c - a[1] * s, a[0] * s + a[1] * c]; };
export const len = (a: V) => Math.hypot(a[0], a[1]);
export const ang = (a: V) => Math.atan2(a[1], a[0]);
export const wrap1 = (x: number) => x - Math.floor(x);
export const RAD = Math.PI / 180;

/** periodic uniform cubic B-spline (C2) through K control values */
export function bspline(c: ArrayLike<number>, o: number, K: number, phase: number) {
  const t = wrap1(phase) * K, i = Math.floor(t), f = t - i;
  const f2 = f * f, f3 = f2 * f;
  const b0 = (1 - 3 * f + 3 * f2 - f3) / 6, b1 = (3 * f3 - 6 * f2 + 4) / 6, b2 = (-3 * f3 + 3 * f2 + 3 * f + 1) / 6, b3 = f3 / 6;
  const at = (j: number) => c[o + (((i + j) % K) + K) % K];
  return at(-1) * b0 + at(0) * b1 + at(1) * b2 + at(2) * b3;
}
/** quintic smoothstep: 0 -> 1 with zero velocity and acceleration at both ends */
export const q5 = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * u * (10 - 15 * u + 6 * u * u));
const softplus = (z: number, s: number) => (z / s > 30 ? z : s * Math.log1p(Math.exp(z / s)));
const rstep = (t: number) => (t * t) / (1 + t * t);

/** skeleton: lengths (m) and joint / marker offsets in their bone's frame (x along the body forward, y up) */
export interface Skel {
  withers: V; girth: V; scapPivot: V; lScap: number; scap0: number; neckBase: V; lNeck: number; lHead: number; poll: V; muzzle: V;
  back: V; lBack: number; lLoin: number; croup: V; hip: V; buttock: V;
  lHum: number; lRad: number; lCanF: number; lPasF: number; scapFollow: number;
  lFem: number; lTib: number; lCanH: number; lPasH: number;
  /** coffin joint -> toe with the hoof flat on the ground */
  hoof: V;
  /** the elbow and stifle markers: offsets from the joint in the forearm / gaskin frame (x along the bone) */
  elbowMk: V; stifleMk: V;
}

export const K = { trunk: 8, neck: 6, flex: 12, pas: 12, hoof: 12, scap: 6, swing: 7 };

/** the curves of one leg */
export interface LegCurves {
  /** touchdown phase and duty (designed: toe exactly on the ground), toe x in the root frame at touchdown */
  td: number; duty: number; xTD: number;
  /** swing: the toe's path in the root frame (clamped spline controls over the swing), how much of each end of the
   * swing blends out of / into the stance's motion, and how sharply the toe lifts and drops */
  sx: number[]; sy: number[]; dead: number; floor: number; epsA: number; epsB: number;
  flex: number[]; pas: number[]; hoofPitch: number[]; scapOrFem: number[];
  /** fraction of the stance after which the heel may leave (breakover), and the swing fraction over which the hoof levels to land */
  breakover: number; level: number;
}
export interface Gait {
  stride: number; speed: number;
  height: number[]; sway: number[]; pitch: number[]; flexion: number[]; neck: number[]; neckBend: number[]; head: number[];
  legs: Record<Role, LegCurves>;
}

export interface LegPose {
  top: V; mid1: V; mid2: V; fetlock: V; coffin: V; toe: V; marker: V; planted: boolean;
  /** absolute bone angles: scapula (fore only), humerus | femur, radius | tibia, cannon, pastern, hoof (0 = flat) */
  aScap: number; aUpper: number; aLower: number; aCannon: number; aPastern: number; aHoof: number; reach: number; short: number;
}
export interface Pose {
  chest: V; aChest: number; j1: V; j2: V; j3: V; aBack: number; aLoin: number; aPelvis: number;
  neckBase: V; aNeck: [number, number, number]; atlas: V; aHead: number;
  mk: Record<string, V>; legs: Record<Role, LegPose>;
}

/** clamped uniform cubic B-spline over u in [0, 1] through M control values (C2 inside) */
export function cspline(c: ArrayLike<number>, u: number) {
  const M = c.length, t = Math.max(0, Math.min(1, u)) * (M - 3), i = Math.min(M - 4, Math.floor(t)), f = t - i;
  const f2 = f * f, f3 = f2 * f;
  return (c[i] * (1 - 3 * f + 3 * f2 - f3) + c[i + 1] * (3 * f3 - 6 * f2 + 4) + c[i + 2] * (-3 * f3 + 3 * f2 + 3 * f + 1) + c[i + 3] * f3) / 6;
}

// 12-point Gauss-Legendre on [0, 1]
const GLX = [0.0092196828766404, 0.0479413718147626, 0.1150486629028477, 0.2063410228566913, 0.3160842505009099, 0.4373832957442655, 0.5626167042557345, 0.6839157494990901, 0.7936589771433087, 0.8849513370971523, 0.9520586281852374, 0.9907803171233596];
const GLW = [0.0235876681932559, 0.0534696629976592, 0.0800391642716731, 0.1015837133615330, 0.1167462682691774, 0.1245735229067014, 0.1245735229067014, 0.1167462682691774, 0.1015837133615330, 0.0800391642716731, 0.0534696629976592, 0.0235876681932559];
/**
 * How far a swinging toe has travelled in the world, 0 -> 1 over v in [0, 1]: the integral of a speed that is always
 * forward, zero with zero slope at both ends (so the toe leaves and meets the ground at rest, C2), and shaped by a
 * spline of its logarithm. With all controls 0 this is the quintic ease.
 */
export function progress(c: ArrayLike<number>, v: number) {
  const f = (t: number) => (t * (1 - t)) ** 2 * Math.exp(cspline(c, t));
  let a = 0, b = 0;
  for (let i = 0; i < 12; i++) { a += GLW[i] * f(v * GLX[i]); b += GLW[i] * f(v + (1 - v) * GLX[i]); }
  a *= v; b *= 1 - v;
  return a / (a + b);
}

/**
 * Toe of a leg in the root frame at a phase: position, hoof pitch, whether it is designed planted. In the stance the
 * toe is exactly on the ground and moves back at the stride per unit phase: it stands still in the world. In the
 * swing it is carried one stride forward in the world, starting and ending at rest (`progress`, shaped by `sx`). For the first and last `dead` of the swing it only rises / falls, so
 * it is clear of the ground before it moves over it and nothing slides inside the test's 1 cm of contact.
 */
export function toeAt(L: LegCurves, stride: number, phase: number) {
  const s = wrap1(phase - L.td);
  let x: number, y: number, planted = false, u = 0;
  if (s <= L.duty) { x = L.xTD - stride * s; y = 0; planted = true; }
  else {
    u = (s - L.duty) / (1 - L.duty);
    const v = Math.max(0, Math.min(1, (u - L.dead) / (1 - 2 * L.dead)));
    const xw = L.xTD + stride * progress(L.sx, v);
    x = xw - stride * s;
    y = (L.floor + softplus(cspline(L.sy, u) - L.floor, 0.03)) * rstep(u / L.epsA) * rstep((1 - u) / L.epsB);
  }
  // the hoof's pitch: flat through the stance until breakover, free in the swing, level again to land
  const bo = L.breakover * L.duty;
  const wIn = q5((s - bo) / (L.duty - bo)), wOut = 1 - q5((s - (1 - L.level * (1 - L.duty))) / (L.level * (1 - L.duty)));
  const pitch = bspline(L.hoofPitch, 0, K.hoof, phase) * wIn * wOut;
  return { x, y, planted, u, pitch };
}

/**
 * Two links from a towards b, the joint on the given side. Past the links' reach the chain does not snap straight:
 * the distance it spans saturates smoothly just short of full extension (so the joint angle stays smooth), and
 * `short` says how far the end falls short of b. A finished gait has short = 0 everywhere a toe is planted.
 */
function twoLink(a: V, b: V, la: number, lb: number, side: 1 | -1): { p: V; end: V; reach: number; short: number } {
  const d = sub(b, a), dl = Math.max(1e-6, len(d)), Lmax = la + lb, m = 0.02;
  const reach = Lmax - dl;
  // spans dl while dl < Lmax - 2m, then bends over to approach Lmax - m
  const over = dl - (Lmax - 2 * m);
  const dc = over <= 0 ? dl : Lmax - 2 * m + m * (1 - Math.exp(-over / m));
  const pl = (la * la - lb * lb + dc * dc) / (2 * dc), h = Math.sqrt(Math.max(1e-12, la * la - pl * pl));
  const e: V = [d[0] / dl, d[1] / dl], n: V = side > 0 ? [-e[1], e[0]] : [e[1], -e[0]];
  return { p: [a[0] + e[0] * pl + n[0] * h, a[1] + e[1] * pl + n[1] * h], end: [a[0] + e[0] * dc, a[1] + e[1] * dc], reach, short: dl - dc };
}

export function pose(sk: Skel, g: Gait, phase: number): Pose {
  const aChest = bspline(g.pitch, 0, K.trunk, phase), beta = bspline(g.flexion, 0, K.trunk, phase);
  // (the trunk surges a little fore and aft of the steady root: the body is not at one speed through a stride)
  const chest: V = [bspline(g.sway, 0, K.trunk, phase), bspline(g.height, 0, K.trunk, phase)];
  const at = (o: V, a: number, p: V) => add(o, rot(p, a));
  const aBack = aChest + 0.15 * beta, aLoin = aChest + 0.45 * beta, aPelvis = aChest + beta;
  const j1 = at(chest, aChest, sk.back), j2 = at(j1, aBack, [-sk.lBack, 0]), j3 = at(j2, aLoin, [-sk.lLoin, 0]);
  const mk: Record<string, V> = {
    withers: at(chest, aChest, sk.withers), girth: at(chest, aChest, sk.girth),
    croup: at(j3, aPelvis, sk.croup), buttock: at(j3, aPelvis, sk.buttock),
  };
  const neckBase = at(chest, aChest, sk.neckBase);
  const n0 = bspline(g.neck, 0, K.neck, phase), nb = bspline(g.neckBend, 0, K.neck, phase);
  const aNeck: [number, number, number] = [n0, n0 + nb, n0 + 2 * nb];
  let atlas = neckBase;
  for (const a of aNeck) atlas = add(atlas, mul(dir(a), sk.lNeck));
  const aHead = bspline(g.head, 0, K.neck, phase);
  mk.poll = at(atlas, aHead, sk.poll);
  mk.muzzle = at(atlas, aHead, sk.muzzle);
  const legs = {} as Record<Role, LegPose>;
  for (const r of ROLES) {
    const L = g.legs[r], fore = r.startsWith('fore');
    const t = toeAt(L, g.stride, phase);
    const toe0: V = [t.x, t.y];
    const aHoof = t.pitch;
    const coffin0 = sub(toe0, rot(sk.hoof, aHoof));
    const aPastern = bspline(L.pas, 0, K.pas, phase);
    const fetlock0 = sub(coffin0, mul(dir(aPastern), fore ? sk.lPasF : sk.lPasH));
    const fl = bspline(L.flex, 0, K.flex, phase);
    let top: V, aScap = 0;
    if (fore) {
      // the scapula swings with the limb (it is not jointed to the ribcage): a share of the limb's angle from the
      // scapula's top to the fetlock, plus the leg's own curve
      const piv = at(chest, aChest, sk.scapPivot);
      const limb = ang(sub(fetlock0, piv)) - aChest + Math.PI / 2;
      aScap = aChest + sk.scap0 + sk.scapFollow * Math.atan(limb) + bspline(L.scapOrFem, 0, K.scap, phase);
      top = add(piv, mul(dir(aScap), sk.lScap));
    } else top = at(j3, aPelvis, sk.hip);
    const l1 = fore ? sk.lRad : sk.lTib, l2 = fore ? sk.lCanF : sk.lCanH, lu = fore ? sk.lHum : sk.lFem;
    const lc = Math.sqrt(l1 * l1 + l2 * l2 + 2 * l1 * l2 * Math.cos(fl));
    // elbow behind the shoulder-fetlock line, stifle ahead of the hip-fetlock line
    const ik = twoLink(top, fetlock0, lu, lc, fore ? -1 : 1);
    const mid1 = ik.p, fetlock = ik.end;
    // (where the leg cannot reach, the whole foot falls short with it)
    const off = sub(fetlock, fetlock0), coffin = add(coffin0, off), toe = add(toe0, off);
    const gam = Math.asin(Math.max(-1, Math.min(1, (l2 * Math.sin(fl)) / lc)));
    // the knee stands ahead of the elbow-fetlock line when flexed, the hock behind the stifle-fetlock line
    const aLower = ang(sub(fetlock, mid1)) + (fore ? gam : -gam);
    const mid2 = add(mid1, mul(dir(aLower), l1));
    const aCannon = ang(sub(fetlock, mid2));
    const marker = add(mid1, rot(fore ? sk.elbowMk : sk.stifleMk, aLower));
    legs[r] = { top, mid1, mid2, fetlock, coffin, toe, marker, planted: t.planted, aScap, aUpper: ang(sub(mid1, top)), aLower, aCannon, aPastern, aHoof, reach: ik.reach, short: ik.short };
  }
  return { chest, aChest, j1, j2, j3, aBack, aLoin, aPelvis, neckBase, aNeck, atlas, aHead, mk, legs };
}

/** the gallop test's joints (Horse.gateJoints) of a pose, side view, keyed by leg name on a lead */
export function gateJoints(p: Pose, lead: 'L' | 'R'): Record<string, V> {
  const other = lead === 'L' ? 'R' : 'L';
  const legName: Record<Role, string> = { foreLead: `${lead}F`, foreTrail: `${other}F`, hindLead: `${lead}H`, hindTrail: `${other}H` };
  const out: Record<string, V> = { ...p.mk };
  for (const r of ROLES) {
    const l = p.legs[r], n = legName[r], fore = r.startsWith('fore');
    out[`${n}_${fore ? 'shoulder' : 'hip'}`] = l.top;
    out[`${n}_${fore ? 'elbow' : 'stifle'}`] = l.marker;
    out[`${n}_${fore ? 'knee' : 'hock'}`] = l.mid2;
    out[`${n}_fetlock`] = l.fetlock;
    out[`${n}_hoof`] = l.toe;
  }
  return out;
}
