/**
 * Offline valley baker: turns the authored layout (src/valley/world/layout.ts) into the heightmap and material masks
 * the game streams in (the same format as Island's, so its Heightfield, terrain, river and vegetation code read it
 * unchanged). Deterministic. `npx tsx tools/gen-valley.ts` writes public/world/*.bin.gz, meta.json and a relief
 * preview to _work/valley/preview.png.
 *
 * Pipeline: rolling meadow floor tilted toward the south-east gorge -> hills (smooth max) -> the mountain ring by
 * bearing, ridged and domain-warped -> the cliff step the falls drop over -> droplet erosion on the high ground ->
 * river profile from the terrain it crosses (the water always falling, the bed lifted at the fords) -> river valley,
 * falls, plunge pool and gorge -> levelled landmark sites -> grade-limited trails -> masks.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  FALLS_DROP, FALLS_INDEX, HALF_WORLD, HEIGHT_RES, HILLS, H_MAX, H_MIN, MASK_RES, PATHS, POOL, RIVER, SITES, WORLD_SIZE,
  ringFoot, type V2,
} from '../src/valley/world/layout.ts';
import { Noise2, Rng, clamp, lerp, smax, smin, smoothstep } from '../src/valley/core/noise.ts';
import { blur, cumLen, edt, nearestOnPolyline } from './lib/bake.ts';

const N = HEIGHT_RES;
const CELL = WORLD_SIZE / N;
const outDir = process.env.VALLEY_WORLD_OUT ?? join(import.meta.dirname, '..', 'public', 'world');
const previewDir = join(import.meta.dirname, '..', '_work', 'valley');
mkdirSync(outDir, { recursive: true });
mkdirSync(previewDir, { recursive: true });

const noise = new Noise2(1337);
const noiseB = new Noise2(4242);
const noiseC = new Noise2(777);
const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const wx = (i: number) => -HALF_WORLD + (i + 0.5) * CELL;

const riverPts = RIVER.map((r) => r.p);
const riverCum = cumLen(riverPts);
const pathCums = PATHS.map(cumLen);
const riverAt = (seg: number, t: number) => {
  const a = RIVER[seg], b = RIVER[Math.min(seg + 1, RIVER.length - 1)];
  const k = t * t * (3 - 2 * t);
  return { w: lerp(a.w, b.w, k), depth: lerp(a.depth, b.depth, k) };
};

// ---------------------------------------------------------------- trail corridors (the body is calmer near them)
const trailDist = (() => {
  const m = new Uint8Array(N * N);
  for (const pts of PATHS) for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
    const len = Math.hypot(bx - ax, bz - az);
    for (let s = 0; s <= len; s += 0.5) {
      const x = lerp(ax, bx, s / len), z = lerp(az, bz, s / len);
      const i = Math.floor((x + HALF_WORLD) / CELL), j = Math.floor((z + HALF_WORLD) / CELL);
      if (i >= 0 && j >= 0 && i < N && j < N) m[j * N + i] = 1;
    }
  }
  const r = edt(m, N);
  for (let i = 0; i < N * N; i++) r.dist[i] *= CELL;
  return r.dist;
})();
log('trail corridors');

// ---------------------------------------------------------------- the cliff step at the falls
// An east-west scarp through the lip: the ground north of it stands FALLS_DROP higher, fading out along its length
// into the mountains' flanks.
const LIP = RIVER[FALLS_INDEX].p;
const STEP_PTS: V2[] = [[LIP[0] - 300, LIP[1] + 40], [LIP[0] - 120, LIP[1] + 8], [LIP[0], LIP[1]], [LIP[0] + 120, LIP[1] + 6], [LIP[0] + 300, LIP[1] + 50]];
const stepCum = cumLen(STEP_PTS);
function stepAt(x: number, z: number) {
  const e = nearestOnPolyline(STEP_PTS, x, z, stepCum);
  const total = stepCum[stepCum.length - 1];
  const along = 1 - Math.abs(e.s / total - 0.5) * 2; // 1 at the lip, 0 at the ends
  const signed = e.side > 0 ? -e.d : e.d; // positive on the north (upper) side
  const near = 1 - smoothstep(120, 260, e.d);
  const amt = FALLS_DROP * smoothstep(0, 0.55, along) * near;
  // a sharp rock face: most of the rise within ~4 m of the line
  return amt * smoothstep(-2.5, 3.5, signed + 1.2 * noise.simplex(x / 9, z / 9));
}

// ---------------------------------------------------------------- the valley body
function hillsAt(x: number, z: number, calm: number) {
  let m = 0;
  for (const h of HILLS) {
    const d = Math.hypot(x - h.p[0], z - h.p[1]) / h.r;
    if (d >= 1) continue;
    let v = h.h * Math.pow(1 - d * d, h.e);
    if (h.rocky) v *= 1 + h.rocky * 0.35 * (noiseB.ridged(x / 45, z / 45, 4) - 0.45) * calm;
    m = m === 0 ? v : smax(m, v, 8);
  }
  return m;
}

/** mountains: 0 on the valley floor, rising from the ring's foot to a ridged crest 150-230 m further out */
function mountainsAt(x: number, z: number, calm: number) {
  const qx = x + noise.fbm(x / 500, z / 500, 3) * 90, qz = z + noise.fbm(x / 500 + 5.2, z / 500 - 1.3, 3) * 90;
  const r = Math.hypot(qx, qz), th = Math.atan2(qz, qx);
  const foot = ringFoot(th);
  const t = (r - foot) / 300;
  if (t < -0.3) return 0;
  // the peaks along the crest: big ones in the north and west (behind the sunset), lower toward the east
  const crest = 250 + 130 * (0.5 + 0.5 * noiseC.fbm(Math.cos(th) * 2.2 + 3, Math.sin(th) * 2.2 - 1, 3)) + 70 * Math.max(0, -Math.cos(th + Math.PI / 2));
  const rise = smoothstep(-0.3, 1.25, t);
  let m = crest * Math.pow(rise, 1.35);
  // ridges and gullies, strongest on the high slopes
  // (softened ridges: a crest line of shoulders and cols, not a saw blade)
  const rd = noise.fbm(qx / 340, qz / 340, 4), rd2 = Math.pow(noiseC.ridged(qx / 150, qz / 150, 3), 2);
  m += m * (0.22 * rd + 0.1 * (rd2 - 0.25)) * smoothstep(0.1, 0.6, rise) * calm;
  return Math.max(0, m);
}

function bodyAt(x: number, z: number, calmDist: number) {
  const calm = 0.3 + 0.7 * smoothstep(6, 45, calmDist);
  // the floor: rolling meadows over a tilt down toward the south-east gorge
  let m = 34 - 0.035 * (0.51 * x + 0.86 * z);
  m += 7 * noise.fbm(x / 320, z / 320, 3) + 2.4 * noiseB.fbm(x / 95, z / 95, 3) * calm + 0.5 * noiseC.fbm(x / 24, z / 24, 2) * calm;
  // swales: long low waves across the meadows (what the grass ripples over)
  m += 1.6 * Math.sin((x * 0.6 + z * 0.8) / 46 + 2.2 * noise.simplex(x / 260, z / 260));
  m = smax(m, m + hillsAt(x, z, calm), 6);
  m = smax(m, m * 0.25 + mountainsAt(x, z, calm), 18);
  m += stepAt(x, z);
  return m;
}

const H = new Float32Array(N * N);
const pathW = new Float32Array(N * N); // 1 on trails
const riverD = new Float32Array(N * N).fill(1e9); // distance to the river's edge (negative inside the channel)
log('heights...');
for (let j = 0; j < N; j++) {
  const z = wx(j);
  for (let i = 0; i < N; i++) H[j * N + i] = bodyAt(wx(i), z, trailDist[j * N + i]);
  if (j % 512 === 0) log(`  row ${j}`);
}

// ---------------------------------------------------------------- hydraulic erosion on the high ground (2 m grid)
log('erosion...');
{
  const E = 1024, S = N / E;
  const e = new Float32Array(E * E);
  for (let j = 0; j < E; j++) for (let i = 0; i < E; i++) {
    let acc = 0;
    for (let b = 0; b < S; b++) for (let a = 0; a < S; a++) acc += H[(j * S + b) * N + i * S + a];
    e[j * E + i] = acc / (S * S);
  }
  const orig = e.slice();
  const rng = new Rng(99);
  const radius = 4;
  const brush: { di: number; dj: number; w: number }[] = [];
  let wsum = 0;
  for (let dj = -radius; dj <= radius; dj++) for (let di = -radius; di <= radius; di++) {
    const d = Math.hypot(di, dj);
    if (d <= radius) {
      const w = 1 - d / radius;
      brush.push({ di, dj, w });
      wsum += w;
    }
  }
  for (const b of brush) b.w /= wsum;
  const hg = (x: number, z: number) => {
    const i = Math.floor(x), j = Math.floor(z), u = x - i, v = z - j;
    const k = j * E + i;
    const a = e[k], b = e[k + 1], c = e[k + E], d = e[k + E + 1];
    return { h: a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v, gx: (b - a) * (1 - v) + (d - c) * v, gz: (c - a) * (1 - u) + (d - b) * u };
  };
  const DROPS = 360000, LIFE = 70;
  const inertia = 0.1, capF = 1.8, minCap = 0.01, depS = 0.25, eroS = 0.2, evap = 0.015, grav = 4;
  let spawned = 0;
  for (let n = 0; n < DROPS; n++) {
    const x0 = 4 + rng.next() * (E - 8), z0 = 4 + rng.next() * (E - 8);
    // rain falls everywhere, but only the slopes above the floor are worth eroding
    if (e[Math.floor(z0) * E + Math.floor(x0)] < 85) continue;
    let x = x0, z = z0;
    spawned++;
    let dx = 0, dz = 0, speed = 1, water = 1, sed = 0;
    for (let life = 0; life < LIFE; life++) {
      const i = Math.floor(x), j = Math.floor(z), u = x - i, v = z - j;
      const p = hg(x, z);
      dx = dx * inertia - p.gx * (1 - inertia);
      dz = dz * inertia - p.gz * (1 - inertia);
      const l = Math.hypot(dx, dz);
      if (l < 1e-6) break;
      dx /= l;
      dz /= l;
      x += dx;
      z += dz;
      if (x < 4 || z < 4 || x > E - 5 || z > E - 5) break;
      const nh = hg(x, z).h;
      const dh = nh - p.h;
      const cap = Math.max(-dh * speed * water * capF, minCap);
      const k = j * E + i;
      if (sed > cap || dh > 0) {
        const dep = dh > 0 ? Math.min(dh, sed) : (sed - cap) * depS;
        sed -= dep;
        e[k] += dep * (1 - u) * (1 - v);
        e[k + 1] += dep * u * (1 - v);
        e[k + E] += dep * (1 - u) * v;
        e[k + E + 1] += dep * u * v;
      } else {
        const ero = Math.min((cap - sed) * eroS, -dh);
        for (const b of brush) {
          const ii = i + b.di, jj = j + b.dj;
          if (ii < 0 || jj < 0 || ii >= E || jj >= E) continue;
          const kk = jj * E + ii;
          const w = ero * b.w;
          const take = e[kk] < w ? e[kk] : w;
          e[kk] -= take;
          sed += take;
        }
      }
      speed = Math.sqrt(Math.max(0, speed * speed + dh * grav));
      water *= 1 - evap;
    }
  }
  const delta = new Float32Array(E * E);
  for (let k = 0; k < E * E; k++) delta[k] = e[k] - orig[k];
  blur(delta, E, 1, 2);
  let maxCut = 0, maxFill = 0;
  for (let k = 0; k < E * E; k++) { maxCut = Math.min(maxCut, delta[k]); maxFill = Math.max(maxFill, delta[k]); }
  for (let j = 0; j < N; j++) {
    const fz = (j + 0.5) / S - 0.5, z = wx(j);
    for (let i = 0; i < N; i++) {
      const idx = j * N + i;
      const fx = (i + 0.5) / S - 0.5, x = wx(i);
      const i0 = clamp(Math.floor(fx), 0, E - 2), j0 = clamp(Math.floor(fz), 0, E - 2);
      const u = clamp(fx - i0, 0, 1), v = clamp(fz - j0, 0, 1);
      const d = lerp(lerp(delta[j0 * E + i0], delta[j0 * E + i0 + 1], u), lerp(delta[(j0 + 1) * E + i0], delta[(j0 + 1) * E + i0 + 1], u), v);
      let keep = smoothstep(4, 30, trailDist[idx]);
      for (const s of SITES) keep *= smoothstep(s.r + 10, s.r + 50, Math.hypot(x - s.p[0], z - s.p[1]));
      // (the falls' scarp keeps its sharp face)
      keep *= smoothstep(30, 90, Math.hypot(x - LIP[0], z - LIP[1]));
      H[idx] += d * keep;
    }
  }
  console.log(`  ${spawned} droplets, change ${maxCut.toFixed(1)} .. +${maxFill.toFixed(1)} m`);
}

// ---------------------------------------------------------------- river profile from the terrain it crosses
const sampleH = (x: number, z: number) => {
  const fx = (x + HALF_WORLD) / CELL - 0.5, fz = (z + HALF_WORLD) / CELL - 0.5;
  const i = clamp(Math.floor(fx), 0, N - 2), j = clamp(Math.floor(fz), 0, N - 2);
  const tx = clamp(fx - i, 0, 1), tz = clamp(fz - j, 0, 1);
  const a = H[j * N + i], b = H[j * N + i + 1], c = H[(j + 1) * N + i], d = H[(j + 1) * N + i + 1];
  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
};
const riverTotal = riverCum[riverCum.length - 1];
const RS = Math.ceil(riverTotal) + 1;
const riverBedS = new Float32Array(RS);
const riverWaterS = new Float32Array(RS);
const riverDepthS = new Float32Array(RS);
const sFalls = riverCum[FALLS_INDEX] + 1.5;
const sPool = riverCum[FALLS_INDEX + 1];
let poolLevel = 0, lipWater = 0;
const segAt = (s: number): [number, number, number, number] => {
  let seg = 0;
  while (seg < RIVER.length - 2 && riverCum[seg + 1] < s) seg++;
  const t = clamp((s - riverCum[seg]) / (riverCum[seg + 1] - riverCum[seg]), 0, 1);
  return [lerp(riverPts[seg][0], riverPts[seg + 1][0], t), lerp(riverPts[seg][1], riverPts[seg + 1][1], t), seg, t];
};
{
  const T = new Float32Array(RS);
  for (let s = 0; s < RS; s++) {
    const [x, z, seg, t] = segAt(s);
    const a = riverPts[seg], b = riverPts[seg + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
    const nx = -dz / l, nz = dx / l;
    let lo = 1e9;
    for (const o of [-5, -2.5, 0, 2.5, 5]) lo = Math.min(lo, sampleH(x + nx * o, z + nz * o));
    T[s] = lo;
    riverDepthS[s] = riverAt(seg, t).depth;
  }
  const sm = new Float32Array(RS);
  for (let s = 0; s < RS; s++) {
    let acc = 0, c = 0;
    for (let k = -12; k <= 12; k++) {
      const q = clamp(s + k, 0, RS - 1);
      if ((s < sFalls) !== (q < sFalls)) continue;
      acc += T[q];
      c++;
    }
    sm[s] = acc / c;
  }
  // the water surface always falls: 0.9 m under the smoothed ground above the falls, then from the pool down
  let w = sm[0] - 0.9;
  for (let s = 0; s < Math.floor(sFalls); s++) {
    w = Math.min(sm[s] - 0.9, s === 0 ? w : w - 0.01);
    riverWaterS[s] = w;
  }
  lipWater = riverWaterS[Math.floor(sFalls) - 1];
  const [ppx, ppz] = POOL.p;
  let around = 0, ringMin = 1e9;
  for (let a = 0; a < 16; a++) around += sampleH(ppx + Math.cos(a) * (POOL.r + 6), ppz + Math.sin(a) * (POOL.r + 6));
  around /= 16;
  for (let a = 0; a < 72; a++) for (const dr of [1, 3, 5, 7]) {
    const ang = (a / 72) * Math.PI * 2;
    ringMin = Math.min(ringMin, sampleH(ppx + Math.cos(ang) * (POOL.r + dr), ppz + Math.sin(ang) * (POOL.r + dr)));
  }
  poolLevel = Math.min(around - 1.6, lipWater - FALLS_DROP * 0.8, ringMin - 0.4);
  w = poolLevel;
  for (let s = Math.floor(sFalls); s < RS; s++) {
    const inPool = s < sPool + POOL.r * 0.6;
    w = inPool ? poolLevel : Math.min(sm[s] - 0.75, w - 0.0045);
    riverWaterS[s] = w;
  }
  for (let s = 0; s < RS; s++) riverBedS[s] = riverWaterS[s] - (s >= Math.floor(sFalls) && s < sPool + POOL.r * 0.6 ? POOL.depth : riverDepthS[s]);
  console.log(`river: ${riverTotal.toFixed(0)} m, lip water ${lipWater.toFixed(2)}, pool level ${poolLevel.toFixed(2)} (ground around ${around.toFixed(1)}, lowest bank ${ringMin.toFixed(1)}), falls ${(lipWater - poolLevel).toFixed(1)} m, end ${riverWaterS[RS - 1].toFixed(1)}`);
}
const bedAtS = (s: number) => riverBedS[clamp(Math.round(s), 0, RS - 1)];

// ---------------------------------------------------------------- river valley, falls, pool, gorge
log('river...');
{
  const pad = 170;
  const minX = Math.min(...riverPts.map((p) => p[0])) - pad, maxX = Math.max(...riverPts.map((p) => p[0])) + pad;
  const minZ = Math.min(...riverPts.map((p) => p[1])) - pad, maxZ = Math.max(...riverPts.map((p) => p[1])) + pad;
  const sGorge = riverCum[21];
  for (let j = 0; j < N; j++) {
    const z = wx(j);
    if (z < minZ || z > maxZ) continue;
    for (let i = 0; i < N; i++) {
      const x = wx(i);
      if (x < minX || x > maxX) continue;
      const idx = j * N + i;
      const r = nearestOnPolyline(riverPts, x, z, riverCum);
      if (r.d > pad) continue;
      const bed = r.s > sFalls - 2 && r.s < sFalls + 1.5 ? lerp(bedAtS(sFalls - 2), bedAtS(sFalls + 1.5), smoothstep(sFalls - 1, sFalls + 0.8, r.s)) : bedAtS(r.s);
      const { w, depth } = riverAt(r.seg, r.t);
      const half = w / 2;
      riverD[idx] = r.d - half;
      // walls: a gorge at the falls (cut into the scarp) and down the south-east exit; open grassy banks between
      const dFall = Math.hypot(x - LIP[0], z - LIP[1]);
      const gorge = Math.max(1 - smoothstep(20, 110, dFall), smoothstep(sGorge - 60, sGorge + 40, r.s));
      const k1 = lerp(0.2, 1.7, gorge), k2 = lerp(0.002, 0.012, gorge);
      const out = Math.max(0, r.d - half);
      const bank = depth + 0.45;
      // (a ford's banks shelve gently into it, so the crossing reads from afar and the horse walks straight in)
      const ford = 1 - smoothstep(0.35, 0.7, depth);
      const kk = lerp(k1, 0.08, ford * (1 - gorge));
      const channel = r.d < half ? bank * smoothstep(0, half, r.d) ** 2 : bank + out * kk + out * out * k2;
      const valley = bed + channel + 0.2 * noise.simplex(x / 6, z / 6) * smoothstep(0, 3, out);
      H[idx] = smin(H[idx], valley, 2.0);
    }
  }
  const [px, pz] = POOL.p;
  const bottom = poolLevel - POOL.depth;
  for (let j = 0; j < N; j++) {
    const z = wx(j);
    if (Math.abs(z - pz) > POOL.r * 3) continue;
    for (let i = 0; i < N; i++) {
      const x = wx(i);
      if (Math.abs(x - px) > POOL.r * 3) continue;
      const d = Math.hypot(x - px, z - pz);
      const idx = j * N + i;
      const toFalls = ((x - px) * (LIP[0] - px) + (z - pz) * (LIP[1] - pz)) / (Math.max(d, 1e-3) * Math.hypot(LIP[0] - px, LIP[1] - pz));
      const wall = lerp(0.35, 4.5, smoothstep(-0.1, 0.6, toFalls));
      const bowl = bottom + POOL.depth * 1.25 * smoothstep(POOL.r * 0.15, POOL.r * 1.05, d) ** 1.4 + Math.max(0, d - POOL.r) * wall;
      H[idx] = smin(H[idx], bowl, 1.5);
      if (d < POOL.r) riverD[idx] = Math.min(riverD[idx], d - POOL.r);
    }
  }
}

// ---------------------------------------------------------------- landmark sites
log('sites...');
for (const s of SITES) {
  if (!s.flatten) continue;
  let acc = 0, c = 0;
  for (let a = 0; a < 24; a++) for (const rr of [0, s.r * 0.5, s.r]) {
    acc += sampleH(s.p[0] + Math.cos(a) * rr, s.p[1] + Math.sin(a) * rr);
    c++;
  }
  const target = acc / c;
  for (let j = 0; j < N; j++) {
    const z = wx(j);
    if (Math.abs(z - s.p[1]) > s.r * 2.2) continue;
    for (let i = 0; i < N; i++) {
      const x = wx(i);
      if (Math.abs(x - s.p[0]) > s.r * 2.2) continue;
      const idx = j * N + i;
      if (riverD[idx] < 3) continue;
      const d = Math.hypot(x - s.p[0], z - s.p[1]);
      const w = 1 - smoothstep(s.r * 0.8, s.r * 2.0, d);
      H[idx] = lerp(H[idx], target + 0.12 * noise.simplex(x / 7, z / 7), w);
    }
  }
  console.log(`  ${s.name}: levelled at ${target.toFixed(1)}`);
}

// ---------------------------------------------------------------- trails
log('trails...');
PATHS.forEach((pts, pi) => {
  const cum = pathCums[pi];
  const total = cum[cum.length - 1];
  const n = Math.ceil(total) + 1;
  const prof = new Float32Array(n);
  let seg = 0;
  const inWater = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    while (seg < pts.length - 2 && cum[seg + 1] < s) seg++;
    const t = clamp((s - cum[seg]) / (cum[seg + 1] - cum[seg]), 0, 1);
    const x = lerp(pts[seg][0], pts[seg + 1][0], t), z = lerp(pts[seg][1], pts[seg + 1][1], t);
    prof[s] = sampleH(x, z);
    const ci = clamp(Math.floor((x + HALF_WORLD) / CELL), 0, N - 1), cj = clamp(Math.floor((z + HALF_WORLD) / CELL), 0, N - 1);
    inWater[s] = riverD[cj * N + ci] < 4 ? 1 : 0;
  }
  const sm = new Float32Array(n);
  const R = 10;
  for (let s = 0; s < n; s++) {
    let acc = 0, c = 0;
    for (let k = -R; k <= R; k++) { acc += prof[clamp(s + k, 0, n - 1)]; c++; }
    sm[s] = acc / c;
  }
  // a riding trail: no stretch steeper than ~23 degrees (the climbs to the obelisk and the statue need about 20)
  const g = Math.tan((23 * Math.PI) / 180);
  for (let it = 0; it < 12; it++) {
    for (let s = 1; s < n; s++) sm[s] = clamp(sm[s], sm[s - 1] - g, sm[s - 1] + g);
    for (let s = n - 2; s >= 0; s--) sm[s] = clamp(sm[s], sm[s + 1] - g, sm[s + 1] + g);
  }
  let maxCut = 0, at = 0;
  for (let s = 0; s < n; s++) if (!inWater[s] && Math.abs(sm[s] - prof[s]) > maxCut) { maxCut = Math.abs(sm[s] - prof[s]); at = s; }
  console.log(`  trail ${pi}: ${total.toFixed(0)} m, max cut/fill ${maxCut.toFixed(1)} m at s=${at}`);
  const minX = Math.min(...pts.map((p) => p[0])) - 14, maxX = Math.max(...pts.map((p) => p[0])) + 14;
  const minZ = Math.min(...pts.map((p) => p[1])) - 14, maxZ = Math.max(...pts.map((p) => p[1])) + 14;
  for (let j = 0; j < N; j++) {
    const z = wx(j);
    if (z < minZ || z > maxZ) continue;
    for (let i = 0; i < N; i++) {
      const x = wx(i);
      if (x < minX || x > maxX) continue;
      const r = nearestOnPolyline(pts, x, z, cum);
      if (r.d > 11) continue;
      const idx = j * N + i;
      // trails do not fill the river: they ride through the fords on the river's own bed
      if (riverD[idx] < 2.5) continue;
      const target = sm[clamp(Math.round(r.s), 0, n - 1)] - 0.1 * (1 - smoothstep(0, 1.8, r.d));
      const w = (1 - smoothstep(2.0, 9.5, r.d)) * smoothstep(2.5, 8, riverD[idx]);
      H[idx] = lerp(H[idx], target, w);
      pathW[idx] = Math.max(pathW[idx], 1 - smoothstep(1.1, 2.6, r.d + 0.6 * noise.simplex(x / 3, z / 3)));
    }
  }
});

// ---------------------------------------------------------------- outputs
log('encoding heights...');
let hMin = 1e9, hMax = -1e9;
const h16 = new Uint16Array(N * N);
for (let i = 0; i < N * N; i++) {
  hMin = Math.min(hMin, H[i]);
  hMax = Math.max(hMax, H[i]);
  h16[i] = Math.round(clamp((H[i] - H_MIN) / (H_MAX - H_MIN), 0, 1) * 65535);
}
console.log(`height range ${hMin.toFixed(1)} .. ${hMax.toFixed(1)}`);
{
  const delta = new Uint16Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    const prev = i > 0 ? h16[k - 1] : j > 0 ? h16[k - N] : 0;
    delta[k] = (h16[k] - prev) & 0xffff;
  }
  const planes = Buffer.alloc(N * N * 2);
  for (let k = 0; k < N * N; k++) {
    planes[k] = delta[k] & 0xff;
    planes[N * N + k] = delta[k] >> 8;
  }
  writeFileSync(join(outDir, 'height.bin.gz'), gzipSync(planes, { level: 9 }));
}

log('masks...');
const M = MASK_RES;
const R = N / M;
const mask0 = new Uint8Array(M * M * 4); // golden (dry grass), grass, dirt/path, forest
const mask1 = new Uint8Array(M * M * 4); // rock, wet, water (river/pool), snow
const shore = new Uint16Array(M * M); // signed distance to the river's water (positive on land), (d + 1024) * 32
const hM = new Float32Array(M * M);
const rdM = new Float32Array(M * M);
for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
  let acc = 0, rd = 1e9;
  for (let b = 0; b < R; b++) for (let a = 0; a < R; a++) {
    const k = (j * R + b) * N + i * R + a;
    acc += H[k];
    rd = Math.min(rd, riverD[k]);
  }
  hM[j * M + i] = acc / (R * R);
  rdM[j * M + i] = rd;
}
{
  const wetM = new Uint8Array(M * M), dryM = new Uint8Array(M * M);
  for (let i = 0; i < M * M; i++) { wetM[i] = rdM[i] < 0 ? 1 : 0; dryM[i] = 1 - wetM[i]; }
  const a = edt(wetM, M), b = edt(dryM, M);
  for (let i = 0; i < M * M; i++) {
    const d = (dryM[i] ? a.dist[i] - 0.5 : -(b.dist[i] - 0.5)) * (WORLD_SIZE / M);
    shore[i] = Math.round(clamp((d + 1024) * 32, 0, 65535));
  }
}
const cellM = WORLD_SIZE / M;
for (let j = 0; j < M; j++) {
  const z = -HALF_WORLD + (j + 0.5) * cellM;
  for (let i = 0; i < M; i++) {
    const x = -HALF_WORLD + (i + 0.5) * cellM;
    const o = (j * M + i) * 4;
    const ci = (j * R + R / 2) * N + i * R + R / 2;
    const h = hM[j * M + i];
    const hx = hM[j * M + Math.min(i + 1, M - 1)] - hM[j * M + Math.max(i - 1, 0)];
    const hz = hM[Math.min(j + 1, M - 1) * M + i] - hM[Math.max(j - 1, 0) * M + i];
    const slope = Math.atan(Math.hypot(hx, hz) / (2 * cellM)) * 57.2958;
    const n1 = noise.fbm(x / 40, z / 40, 3), n2 = noiseB.fbm(x / 13, z / 13, 3), n3 = noiseC.fbm(x / 210, z / 210, 3);
    const rd = riverD[ci];
    const path = pathW[ci];
    let siteD = 1e9;
    for (const s of SITES) if (s.r > 0) siteD = Math.min(siteD, Math.hypot(x - s.p[0], z - s.p[1]) - s.r);
    const rr = Math.hypot(x, z), th = Math.atan2(z, x);
    const mountain = smoothstep(-40, 120, rr - ringFoot(th));
    // rocky hills' own outcrops
    let rockyHill = 0;
    for (const hl of HILLS) if (hl.rocky) rockyHill = Math.max(rockyHill, hl.rocky * (1 - smoothstep(0.35, 0.85, Math.hypot(x - hl.p[0], z - hl.p[1]) / hl.r)));
    // rock: steep faces, the high mountains above the treeline, the rocky knolls' crowns, the falls' scarp
    let rock = smoothstep(31, 42, slope + 7 * n2);
    rock = Math.max(rock, smoothstep(250, 300, h + 25 * n1) * 0.9);
    rock = Math.max(rock, rockyHill * smoothstep(-0.05, 0.35, n2 + 0.25 * n1) * smoothstep(14, 24, slope + 6 * n1));
    const dFall = Math.hypot(x - LIP[0], z - LIP[1]);
    rock = Math.max(rock, (1 - smoothstep(20, 45, dFall)) * smoothstep(18, 32, slope));
    rock = clamp(rock * (1 - path), 0, 1);
    // snow on the high summits, thinner on the steep faces and the sunny (south) slopes
    const southSlope = clamp(-hz / (2 * cellM) * 2, -1, 1);
    const snow = smoothstep(395, 440, h + 30 * n1 - 25 * southSlope) * (1 - smoothstep(40, 55, slope) * 0.85);
    // forest: conifers on the mountain flanks to the treeline, stands on the slopes and in patches over the floor
    let forest = smoothstep(-0.2, 0.25, n3 + 0.1 * n1) * 0.85;
    forest = Math.max(forest, mountain * smoothstep(-0.45, -0.05, n3 + 0.2 * n1));
    forest *= 1 - smoothstep(265, 305, h + 20 * n1);
    forest *= 1 - smoothstep(38, 48, slope);
    forest *= smoothstep(9, 26, trailDist[ci] + 6 * n1);
    forest *= smoothstep(10, 40, siteD);
    forest *= smoothstep(1.5, 9, rd);
    forest *= 1 - rock * 0.85;
    // the falls' pool stays open: a clearing with the cliff behind
    forest *= smoothstep(30, 70, Math.hypot(x - POOL.p[0], z - POOL.p[1]));
    forest = clamp(forest, 0, 1);
    // dirt: trails, the camp and ruin floors
    let dirt = path;
    dirt = Math.max(dirt, (1 - smoothstep(-6, 4, siteD)) * (0.55 + 0.45 * smoothstep(-0.2, 0.3, n2)));
    // golden meadow: dry grass in broad drifts across the open floor (more on the warm south-facing swells)
    const gold = smoothstep(-0.12, 0.28, noiseB.fbm(x / 170 + 9, z / 170 - 4, 3) + 0.18 * southSlope + 0.1 * n1) * (1 - mountain * 0.7) * smoothstep(4, 16, rd);
    // grass everywhere else that is open ground
    const grass = clamp(1 - rock - snow - dirt * 0.9, 0, 1);
    const wet = (1 - smoothstep(0, 5 + 2 * n1, rd)) * (rd > -30 ? 1 : 0);
    const water = 1 - smoothstep(-0.8, 0.4, rd);
    mask0[o] = Math.round(clamp(gold, 0, 1) * 255);
    mask0[o + 1] = Math.round(grass * 255);
    mask0[o + 2] = Math.round(clamp(dirt, 0, 1) * 255);
    mask0[o + 3] = Math.round(forest * 255);
    mask1[o] = Math.round(rock * 255);
    mask1[o + 1] = Math.round(clamp(wet, 0, 1) * 255);
    mask1[o + 2] = Math.round(clamp(water, 0, 1) * 255);
    mask1[o + 3] = Math.round(clamp(snow, 0, 1) * 255);
  }
}
writeFileSync(join(outDir, 'mask0.bin.gz'), gzipSync(Buffer.from(mask0.buffer), { level: 9 }));
writeFileSync(join(outDir, 'mask1.bin.gz'), gzipSync(Buffer.from(mask1.buffer), { level: 9 }));
writeFileSync(join(outDir, 'shore.bin.gz'), gzipSync(Buffer.from(shore.buffer), { level: 9 }));
const riverOut: number[][] = [];
for (let s = 0; s <= riverTotal; s += 2) {
  const [x, z, seg, t] = segAt(s);
  riverOut.push([+x.toFixed(2), +z.toFixed(2), +bedAtS(s).toFixed(2), +riverWaterS[clamp(Math.round(s), 0, RS - 1)].toFixed(2), +riverAt(seg, t).w.toFixed(2), +s.toFixed(1)]);
}
const below = RIVER[FALLS_INDEX + 1].p;
const siteY = Object.fromEntries(SITES.map((s) => [s.name, +sampleH(s.p[0], s.p[1]).toFixed(2)]));
writeFileSync(join(outDir, 'meta.json'), JSON.stringify({
  N, M, H_MIN, H_MAX, worldSize: WORLD_SIZE, hMin, hMax,
  river: riverOut,
  falls: { lip: LIP, toward: below, s: sFalls, top: lipWater, bottom: poolLevel, width: RIVER[FALLS_INDEX].w },
  pool: { p: POOL.p, r: POOL.r, level: poolLevel },
  sites: siteY,
  at: new Date().toISOString(),
}));

// ---------------------------------------------------------------- relief preview
log('preview...');
{
  const img = Buffer.alloc(M * M * 3);
  for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
    const h = hM[j * M + i];
    const hx = (hM[j * M + Math.min(i + 1, M - 1)] - hM[j * M + Math.max(i - 1, 0)]) / (2 * cellM);
    const hz = (hM[Math.min(j + 1, M - 1) * M + i] - hM[Math.max(j - 1, 0) * M + i]) / (2 * cellM);
    const nx = -hx, ny = 1, nz = -hz, nl = Math.hypot(nx, ny, nz);
    const lx = -0.5, ly = 0.75, lz = -0.45, ll = Math.hypot(lx, ly, lz);
    const shade = clamp((nx * lx + ny * ly + nz * lz) / (nl * ll), 0, 1);
    const o = (j * M + i) * 4;
    const gold = mask0[o] / 255, grass = mask0[o + 1] / 255, dirt = mask0[o + 2] / 255, forest = mask0[o + 3] / 255;
    const rock = mask1[o] / 255, water = mask1[o + 2] / 255, snow = mask1[o + 3] / 255;
    let r = 95, g = 120, b = 60;
    const mixc = (c: number[], w: number) => { r = lerp(r, c[0], w); g = lerp(g, c[1], w); b = lerp(b, c[2], w); };
    mixc([120, 150, 70], grass);
    mixc([190, 165, 90], gold * grass);
    mixc([30, 62, 34], forest);
    mixc([135, 100, 70], dirt);
    mixc([125, 120, 115], rock);
    mixc([240, 242, 248], snow);
    mixc([60, 120, 160], water);
    const s = 0.45 + 0.75 * shade;
    r *= s; g *= s; b *= s;
    if (Math.abs((h % 20) - 10) > 9.6) { r *= 0.82; g *= 0.82; b *= 0.82; }
    img[(j * M + i) * 3] = clamp(r, 0, 255);
    img[(j * M + i) * 3 + 1] = clamp(g, 0, 255);
    img[(j * M + i) * 3 + 2] = clamp(b, 0, 255);
  }
  await sharp(img, { raw: { width: M, height: M, channels: 3 } }).png().toFile(join(previewDir, 'preview.png'));
}
for (const s of SITES) console.log(`  ${s.name}: h ${sampleH(s.p[0], s.p[1]).toFixed(2)}`);
log('done');
