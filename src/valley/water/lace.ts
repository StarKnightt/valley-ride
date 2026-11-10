// Foam lace pattern, from F:/island src/water/surf.ts (the coastal surf model itself is not used in the valley).
import * as THREE from 'three/webgpu';
import { float, hash, mix, smoothstep, texture, vec2, type N } from '../core/tsl';

/** the village cove: sheltered by its headlands and the skerry, so its moorings stay calm */
const COVE: [number, number] = [-455, 425];

// ---------------------------------------------------------------- the lace pattern
/** wrapped box blur of radius r along one axis (running sum) */
function boxWrap(src: Float32Array, n: number, r: number, horizontal: boolean): Float32Array {
  const out = new Float32Array(n * n);
  const w = 2 * r + 1;
  for (let line = 0; line < n; line++) {
    const at = (i: number) => (horizontal ? src[line * n + (((i % n) + n) % n)] : src[(((i % n) + n) % n) * n + line]);
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += at(i);
    for (let i = 0; i < n; i++) {
      if (horizontal) out[line * n + i] = sum / w;
      else out[i * n + line] = sum / w;
      sum += at(i + r + 1) - at(i - r);
    }
  }
  return out;
}
/** three box passes per axis: a Gaussian of about this sigma (texels), tileable */
function gaussWrap(src: Float32Array, n: number, sigma: number) {
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  let a = src;
  for (let k = 0; k < 3; k++) a = boxWrap(boxWrap(a, n, r, true), n, r, false);
  return a;
}
/** band-passed white noise (difference of two Gaussians), unit RMS, tileable */
function bandpass(seed: number, n: number, s1: number, s2: number) {
  let st = seed >>> 0;
  const white = new Float32Array(n * n);
  for (let i = 0; i < white.length; i++) {
    st = (Math.imul(st, 1664525) + 1013904223) >>> 0;
    white[i] = st / 4294967296 - 0.5;
  }
  const a = gaussWrap(white, n, s1), b = gaussWrap(white, n, s2);
  const out = new Float32Array(n * n);
  let sq = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] = a[i] - b[i];
    sq += out[i] * out[i];
  }
  const k = 1 / Math.sqrt(sq / out.length);
  for (let i = 0; i < out.length; i++) out[i] *= k;
  return out;
}

/**
 * RGBA, tileable, 256 texels per repeat: R the lace (a bubble-raft web of meandering lines where foam collects,
 * times clumps), G fine bubbles, B coarse clumps (patchiness of the cover), A a second, coarser web.
 * Approach after the foam pattern of the threejs-spectral-ocean skill's coastal breaker example (MIT, CREDITS.md).
 */
function lacePattern() {
  const n = 256;
  const web = bandpass(777, n, 2, 6), mid = bandpass(778, n, 3, 9), fine = bandpass(779, n, 1, 2.5);
  const bub = bandpass(780, n, 0.7, 1.8), clump = bandpass(781, n, 10, 28), web2 = bandpass(782, n, 3.5, 10);
  const data = new Uint8Array(n * n * 4);
  const u8 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  for (let i = 0; i < n * n; i++) {
    const w = Math.max(0, 1 - 1.25 * Math.abs(web[i]));
    data[i * 4] = u8(0.55 * w * w + 0.22 + 0.1 * mid[i] + 0.06 * fine[i]);
    data[i * 4 + 1] = u8(0.5 + 0.3 * bub[i]);
    data[i * 4 + 2] = u8(0.5 + 0.28 * clump[i]);
    data[i * 4 + 3] = u8(Math.max(0, 1 - 1.25 * Math.abs(web2[i])));
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}
export const laceTex = lacePattern();
/** metres per repeat of the lace pattern */
const LACE_M = 11;

export function laceMask(amount: N, xz: N, n: N, nrm: N, drift: N, stretch: N = float(0)) {
  const off = vec2(hash(n.add(9100)), hash(n.add(9300))).mul(LACE_M * 7);
  const p = xz.sub(nrm.mul(drift)).add(off);
  // stretched across the shore by the backwash
  const across = nrm.mul(p.dot(nrm));
  const q = p.sub(across.mul(stretch.mul(0.6)));
  const t1 = texture(laceTex, q.div(LACE_M));
  const t2 = texture(laceTex, q.div(LACE_M * 2.7).add(0.37));
  const pat = t1.r.mul(0.62).add(t2.a.mul(0.38));
  const cover = amount.mul(mix(float(0.7), float(1.25), t2.b));
  return smoothstep(0, 0.16, pat.sub(float(1.04).sub(cover.mul(1.12))));
}

/** fine bubbly foam (the swash lip, stranded lines): a granular threshold */
export function bubbleMask(amount: N, xz: N) {
  const t = texture(laceTex, xz.div(LACE_M * 0.45).add(0.11));
  return smoothstep(0, 0.2, t.g.sub(float(1.0).sub(amount.mul(1.05)))).mul(smoothstep(0.0, 0.1, amount));
}
