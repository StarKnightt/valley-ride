/** Shared pieces of the offline terrain bakers, lifted from Island's tools/gen-island.ts. */
import { clamp } from '../../src/valley/core/noise.ts';
import type { V2 } from '../../src/valley/world/layout.ts';

/** squared Euclidean distance transform (Felzenszwalb-Huttenlocher) to the pixels where feature[i] = 1 */
export function edt(feature: Uint8Array, n: number): { dist: Float32Array; nearest: Int32Array } {
  const INF = 1e20;
  const colD = new Float64Array(n * n);
  const colIdx = new Int32Array(n * n);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n), arg = new Int32Array(n);
  const pass = (len: number) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
      arg[q] = v[k];
    }
  };
  // columns
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) f[y] = feature[y * n + x] ? 0 : INF;
    pass(n);
    for (let y = 0; y < n; y++) {
      colD[y * n + x] = d[y];
      colIdx[y * n + x] = arg[y];
    }
  }
  const dist = new Float32Array(n * n);
  const nearest = new Int32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) f[x] = colD[y * n + x];
    pass(n);
    for (let x = 0; x < n; x++) {
      dist[y * n + x] = Math.sqrt(d[x]);
      const fx = arg[x];
      nearest[y * n + x] = colIdx[y * n + fx] * n + fx;
    }
  }
  return { dist, nearest };
}

/** separable box blur, in place over a few passes */
export function blur(src: Float32Array, n: number, r: number, passes: number): Float32Array {
  let a = src, b = new Float32Array(n * n);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < n; y++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += a[y * n + clamp(x, 0, n - 1)];
      for (let x = 0; x < n; x++) {
        b[y * n + x] = acc / (2 * r + 1);
        acc += a[y * n + clamp(x + r + 1, 0, n - 1)] - a[y * n + clamp(x - r, 0, n - 1)];
      }
    }
    for (let x = 0; x < n; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += b[clamp(y, 0, n - 1) * n + x];
      for (let y = 0; y < n; y++) {
        a[y * n + x] = acc / (2 * r + 1);
        acc += b[clamp(y + r + 1, 0, n - 1) * n + x] - b[clamp(y - r, 0, n - 1) * n + x];
      }
    }
  }
  return a;
}

export interface Near { d: number; s: number; seg: number; t: number; side: number }
export function nearestOnPolyline(pts: V2[], x: number, z: number, cum: number[]): Near {
  let best: Near = { d: 1e9, s: 0, seg: 0, t: 0, side: 0 };
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    const t = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
    const px = ax + dx * t, pz = az + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best.d) {
      const cross = dx * (z - az) - dz * (x - ax);
      best = { d, s: cum[i] + t * Math.sqrt(l2), seg: i, t, side: cross };
    }
  }
  return best;
}
export const cumLen = (pts: V2[]) => {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return c;
};

