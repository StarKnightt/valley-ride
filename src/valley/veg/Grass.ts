/**
 * Meadow grass, generated on the GPU around the camera: two grids of clumps (near: dense, fine blades; mid: fewer,
 * longer clumps) snapped to world cells, so a clump keeps its place, size and yaw as the grid slides with the camera
 * (nothing swims or pops). Each clump reads the height and the masks itself: green meadow grass, straw gold on the dry
 * drifts, none on trails, rock, water or under the pines.
 *
 * What makes it read as a field and not a carpet of spikes (RDR2-REFERENCE.md):
 * - many thin blades per clump, mixed heights and leans, cells jittered across their whole cell with an independent
 *   yaw (no rows), and clumps that thin out and thicken in drifts;
 * - low root-to-tip contrast (the volume is lit, not each card), with dry blond tips on some blades;
 * - colour in patches a few metres across (fresh green, yellow-green, straw, blue-green hollows), from `grassTone`,
 *   which the terrain shades with too, so where the blades end the ground carries on in the same colour;
 * - with distance the blades sink into the ground rather than shrink, so the far field is a soft nap, never spikes.
 * Wind: long gust waves roll across the meadows downwind and turn the bent blades' pale sides to the light.
 *
 * Round 17 (our own implementation, after studying the look of a dense instanced-grass demo, none of its code): thinner
 * and more blades per clump with rounded normals, a bend about the root so gust crests lay the field over in big
 * rolling sweeps, a three-stop root-to-tip gradient, and the ground under the blades shaded to their average colour
 * (TerrainMaterial) so no gap reads as a dark speckle.
 */
import * as THREE from 'three/webgpu';
import { transformNormalToView } from 'three/tsl';
import {
  Fn, attribute, cameraPosition, cos, float, floor, hash, instanceIndex, mix, positionLocal, sin, smoothstep,
  texture, uniform, vec2, vec3, vec4, length, type N, mx_noise_float, dot, clamp, normalize, max,
} from '../core/tsl';
import type { Heightfield } from '../world/Heightfield';
import { HALF_WORLD, WORLD_SIZE } from '../world/layout';
import { wetness } from '../world/weatherUniforms';
import { sunLit } from '../core/lighting';
import { Q } from '../core/quality';
import { atmo } from '../sky/Atmosphere';
import { glbU } from './glb';
import { trailTexture } from '../world/trailField';

export const grassU = { time: uniform(0), origin: uniform(new THREE.Vector2()), originFar: uniform(new THREE.Vector2()) };

/** round 18: the field's large colour zones (a multiplier): darker greener lush ground and lighter drier stands, tens of
 * metres across; shared with the terrain so a gap between clumps shows the same zone */
export function meadowZone(xz: N): N {
  const z = mx_noise_float(vec3(xz.mul(1 / 42), 4.2));
  const lush = smoothstep(-0.05, -0.6, z), dryZ = smoothstep(0.05, 0.6, z);
  return mix(vec3(1), vec3(0.7, 0.8, 0.66), lush.mul(0.8)).mul(mix(vec3(1), vec3(1.32, 1.18, 0.78), dryZ.mul(0.8)));
}

/** the gust wave over the meadows at xz (0..1), shared with the terrain shader */
export function meadowWave(xz: N, t: N): N {
  const wd = wetness.windDir;
  const along = dot(xz, vec2(wd.x, wd.y));
  const across = dot(xz, vec2(wd.y.negate(), wd.x));
  const warp = mx_noise_float(vec3(xz.mul(1 / 60), t.mul(0.05))).mul(9);
  const w1 = sin(along.mul(0.11).sub(t.mul(1.25)).add(warp)).mul(0.5).add(0.5);
  const w2 = sin(along.mul(0.043).add(across.mul(0.012)).sub(t.mul(0.55)).add(warp.mul(0.4))).mul(0.5).add(0.5);
  return smoothstep(0.35, 1.0, w1.mul(w2.mul(0.6).add(0.4)));
}

/**
 * The meadow's colour (linear albedo of the grass mass) at xz: patches of fresh green, yellow-green and straw a few
 * metres to tens of metres across, darker blue-green hollows, and the baked dry drifts (`gold`, 0..1). The grass blades
 * and the terrain under and beyond them both use it.
 */
export function grassTone(xz: N, gold: N): N {
  const n1 = mx_noise_float(vec3(xz.mul(1 / 8.5), 3.3));
  const n2 = mx_noise_float(vec3(xz.mul(1 / 23), 7.1));
  const n3 = mx_noise_float(vec3(xz.mul(1 / 3.2), 1.7));
  // (sun-bleached range grass, not lawn: muted sage and olive greens, the RDR2 meadows' low saturation)
  const fresh = vec3(0.07, 0.13, 0.04), yellow = vec3(0.1, 0.135, 0.046), straw = vec3(0.17, 0.155, 0.08);
  const hollow = vec3(0.05, 0.078, 0.046);
  let c: N = mix(fresh, yellow, smoothstep(-0.35, 0.45, n1.add(n3.mul(0.25))));
  c = mix(c, straw, clamp(max(gold.mul(0.24), smoothstep(0.45, 0.9, n2).mul(0.2)).add(n3.mul(0.06)), 0, 1));
  c = mix(c, hollow, smoothstep(0.2, 0.7, n2.negate()).mul(0.45));
  return c;
}

/**
 * A clump of thin, curved blades (round 17, written from scratch). Each blade is a tapering strip of `segs` segments
 * that curves outward as it rises. Its normals are rounded across its width: the two edges lean apart around a
 * mostly-up axis, so each blade shades as a little ribbon and not a flat card, while the field as a whole stays lit as
 * one volume, as the ground under it is. Per vertex `bd` = (height along the blade 0..1, dryness, kind: 0 blade,
 * 1 seed head, 2 flower).
 */
function clumpGeometry(blades: number, segs: number, seed: number, radius: number, width: [number, number], height: [number, number], under = 0) {
  const pos: number[] = [], bd: number[] = [], nrm: number[] = [], idx: number[] = [];
  const quad = (x: number, y: number, z: number, ux: number, uz: number, w: number, h: number, dry: number, kind: number, flat = 0) => {
    // a small card at a blade's tip: a seed head (upright, narrow) or a flower (tipped toward the sky)
    const base = pos.length / 3;
    const hx = ux * w, hz = uz * w;
    const tx = -uz * h * flat, tz = ux * h * flat, ty = h * (1 - flat);
    pos.push(x - hx, y, z - hz, x + hx, y, z + hz, x - hx + tx, y + ty, z - hz + tz, x + hx + tx, y + ty, z + hz + tz);
    for (const f of [0.9, 0.9, 1, 1]) bd.push(f, dry, kind);
    for (let q = 0; q < 4; q++) nrm.push(0, 1, 0);
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  };
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const blade = (bx: number, bz: number, a: number, h: number, w: number, lean: number, dry: number, n: number, tipF: number) => {
    const yaw = a + (rnd() - 0.5) * 2.4;
    const cx = Math.cos(yaw), cz = Math.sin(yaw);
    const lx = Math.cos(a) * lean, lz = Math.sin(a) * lean;
    const base = pos.length / 3;
    for (let k = 0; k <= n; k++) {
      const f = k / n;
      // (a slightly convex taper: full for the lower half, then narrowing to a fine point)
      const ww = w * (1 - Math.pow(f, 1.6) * (1 - tipF));
      // a quadratic curve outward: the tip leans further than the middle
      const ox = bx + lx * f * f, oz = bz + lz * f * f, y = h * f * (1 - 0.18 * f * f);
      pos.push(ox - cx * ww, y, oz - cz * ww, ox + cx * ww, y, oz + cz * ww);
      bd.push(f, dry, 0, f, dry, 0);
      // rounded across the width: each edge's normal leans out to its own side
      for (const side of [-1, 1]) {
        const nx = cx * side * 0.42 + lx / Math.max(h, 0.01) * 0.25, ny = 0.88, nz = cz * side * 0.42 + lz / Math.max(h, 0.01) * 0.25;
        const L = Math.hypot(nx, ny, nz);
        nrm.push(nx / L, ny / L, nz / L);
      }
    }
    for (let k = 0; k < n; k++) {
      const i0 = base + k * 2;
      idx.push(i0, i0 + 1, i0 + 2, i0 + 1, i0 + 3, i0 + 2);
    }
    return { tx: bx + lx, tz: bz + lz, cx, cz };
  };
  for (let b = 0; b < blades; b++) {
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * radius;
    const bx = Math.cos(a) * r, bz = Math.sin(a) * r;
    // mixed heights: most mid-length, a few tall seed stalks
    const tall = rnd();
    const h = height[0] + (height[1] - height[0]) * (tall < 0.85 ? rnd() * 0.75 : 0.75 + rnd() * 0.25);
    const w = width[0] + rnd() * (width[1] - width[0]);
    // leaning outward from the clump's centre, more for the long ones
    const lean = (0.12 + rnd() * 0.32) * h;
    const dry = rnd();
    const t = blade(bx, bz, a, h, w, lean, dry, segs, 0.08);
    // the tall stalks carry seed heads; a few blades end in a flower (shown only in the flower patches, see material)
    if (tall > 0.9) quad(t.tx, h * 0.85, t.tz, t.cx, t.cz, 0.007, 0.065, dry, 1);
    else if (tall < 0.06) quad(t.tx, h * 0.85, t.tz, t.cx, t.cz, 0.016, 0.03, dry, 2, 0.7);
  }
  // the short sward underneath: low blades spread past the clump's own radius, so the ground between clumps is grass
  for (let b = 0; b < under; b++) {
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * radius * 1.9;
    const h = 0.06 + rnd() * 0.1, w = 0.008 + rnd() * 0.007;
    blade(Math.cos(a) * r, Math.sin(a) * r, a, h, w, (0.2 + rnd() * 0.4) * h, rnd() * 0.7, 1, 0.15);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('bd', new THREE.Float32BufferAttribute(bd, 3));
  g.setIndex(idx);
  return g;
}

interface GridSpec { G: number; SP: number; under?: number; blades: number; segs: number; radius: number; width: [number, number]; height: [number, number]; r0: number; r1: number; fadeIn: number; fadeOut: number }

export class Grass {
  readonly group = new THREE.Group();
  private grids: { G: number; SP: number; mesh: THREE.Mesh; uni: THREE.Vector2 }[] = [];

  constructor(private hf: Heightfield) {
    const D = Math.sqrt(Q.density);
    // near: a dense sward of fine blades to ~26 m; mid: longer clumps to ~70 m, sinking into the ground beyond
    const nearR = 26 * Math.min(1, 0.6 + 0.4 * D);
    const near: GridSpec = { SP: 0.33, G: 0, under: 3, blades: 27, segs: 3, radius: 0.24, width: [0.006, 0.012], height: [0.2, 0.66], r0: 0, r1: nearR, fadeIn: 0, fadeOut: 9 };
    near.G = Math.ceil((2 * (nearR + 2)) / near.SP);
    const midR = Math.max(42, Q.grassFar + 10);
    const mid: GridSpec = { SP: 0.72, G: 0, blades: 15, segs: 2, radius: 0.44, width: [0.013, 0.024], height: [0.26, 0.7], r0: nearR - 9, r1: midR, fadeIn: 8, fadeOut: 34 };
    mid.G = Math.ceil((2 * (midR + 2)) / mid.SP);
    for (const [k, c] of [near, mid].entries()) {
      const geo = clumpGeometry(c.blades, c.segs, 911 + k * 77, c.radius, c.width, c.height, c.under ?? 0);
      geo.instanceCount = c.G * c.G;
      const uni = k === 0 ? grassU.origin : grassU.originFar;
      const mesh = new THREE.Mesh(geo, this.material(c, uni, k));
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.name = k === 0 ? 'grass-near' : 'grass-far';
      mesh.renderOrder = -6 + k;
      this.group.add(mesh);
      this.grids.push({ G: c.G, SP: c.SP, mesh, uni: uni.value as THREE.Vector2 });
    }
  }

  private material(c: GridSpec, origin: N, k: number) {
    const hf = this.hf;
    const G = c.G, SP = c.SP;
    // (round 18: physical, for its specular intensity: the sky's Fresnel sheen on millions of near-up normals turned the
    // field whitish and hazy)
    const m = sunLit(new THREE.MeshPhysicalNodeMaterial());
    m.name = 'grass';
    m.side = THREE.DoubleSide;
    const bd = attribute('bd', 'vec3');
    const bend = bd.x, dry = bd.y, kind = bd.z;
    const i = float(instanceIndex);
    const gx = i.mod(G), gz = floor(i.div(G));
    const cell = vec2(origin.x.add(gx).sub(G / 2), origin.y.add(gz).sub(G / 2));
    const salt = k * 101.7;
    // (a nested hash: a hash of a linear mix of the cell's coordinates repeats along lines across the grid, and the
    // field showed rows)
    // (and on positive cell numbers: the hash converts to u32, which clamps a negative value to 0, so south and west of
    // the origin every row had the same offset and the rows came back)
    const pc = cell.add(8192);
    const key = pc.x.add(hash(pc.y.add(salt + 17.3)).mul(4093.0)).add(pc.y.mul(0.618));
    const r1 = hash(key.add(4000.5));
    const r2 = hash(key.mul(1.37).add(8711.3));
    const r3 = hash(key.mul(0.71).add(1234.7));
    const r4 = hash(key.mul(1.93).add(377.1));
    // (jittered over the whole cell plus a little beyond, so neither rows nor a lattice show)
    const xz = cell.add(vec2(r1, r2).mul(1.2).sub(0.1)).mul(SP);
    const uvW = xz.add(HALF_WORLD).div(WORLD_SIZE);
    const ground = texture(hf.heightTex, uvW).level(0).r;
    const m0 = texture(hf.mask0Tex, uvW).level(0);
    const m1 = texture(hf.mask1Tex, uvW).level(0);
    const shore = texture(hf.shoreTex, uvW).level(0).r;
    const cover = m0.y.mul(float(1).sub(m0.w.mul(0.9))).mul(float(1).sub(smoothstep(0.25, 0.6, m0.z))).mul(float(1).sub(smoothstep(0.2, 0.5, m1.x)))
      .mul(float(1).sub(m1.w)).mul(smoothstep(1.2, 3.5, shore))
      // the grassy crown between a trail's two ruts
      .max(smoothstep(0.3, 0.12, texture(trailTexture(), uvW).level(0).r).mul(0.55).mul(float(1).sub(m0.w)));
    const d = length(xz.sub(cameraPosition.xz));
    // (the near grid starts at the camera; the mid grid grows up out of the ground where the near one sinks into it)
    const grow = (c.r0 > 0 ? smoothstep(c.r0, c.r0 + c.fadeIn, d) : float(1)).mul(float(1).sub(smoothstep(c.r1 - c.fadeOut, c.r1, d)).pow(0.7));
    // patchy: drifts of thick sward and thin, bare-ish spots
    const patch = mx_noise_float(vec3(xz.mul(1 / 7), 2.1)).mul(0.5).add(0.5);
    const alive = smoothstep(r3.mul(0.8), r3.mul(0.8).add(0.15), cover.mul(patch.mul(0.5).add(0.62)));
    const gold = m0.x;
    // (tall and short stands in drifts across the field, 0.5-1.5x)
    // (round 18) height in patches, pushed apart so there are short-cropped patches and tall stands, not one even
    // carpet; tufts: each clump's own height scatter (one noise: every call here runs per vertex)
    const tallN = smoothstep(0.2, 0.8, mx_noise_float(vec3(xz.mul(1 / 14), 8.8)).mul(0.5).add(0.5));
    const size = mix(float(0.35), float(1.6), tallN).mul(alive).mul(smoothstep(0.05, 0.75, cover).mul(0.75).add(0.25)).mul(r3.mul(0.8).add(0.55)).mul(mix(float(0.9), float(1.08), gold)).mul(mix(float(0.45), float(1.15), smoothstep(0.1, 0.9, patch)));
    // wildflowers in drifts (a meadow's flowers grow together), their cards collapsed elsewhere
    const fl = mx_noise_float(vec3(xz.mul(1 / 13), 5.3));
    const isFlower = smoothstep(1.5, 2.5, kind);
    const flowerOn = smoothstep(0.25, 0.5, fl).mul(float(1).sub(gold.mul(0.6)));
    const sizeK = size.mul(mix(float(1), flowerOn, isFlower));
    const yaw = r4.mul(6.2832);
    const cs = cos(yaw), sn = sin(yaw);
    const lp = positionLocal;
    // sinking: the height goes with distance, the width and the roots stay
    const rot = vec3(lp.x.mul(cs).sub(lp.z.mul(sn)).mul(sizeK), lp.y.mul(sizeK).mul(grow), lp.x.mul(sn).add(lp.z.mul(cs)).mul(sizeK));
    // wind: the rolling gust wave plus a little flutter of its own
    const t = grassU.time;
    const wave = meadowWave(xz, t);
    const wd = vec3(wetness.windDir.x, 0, wetness.windDir.y);
    const strength = wetness.wind.mul(0.7).add(0.3);
    const flutter = sin(t.mul(3.1).add(r2.mul(40)).add(dry.mul(17)).add(xz.x.mul(0.7))).mul(0.07);
    // (round 17: the blade bends about its root by an angle that grows along it, so its length is kept and a gust
    // crest lays the field over in a visible sweep instead of sliding the tips sideways)
    const theta = strength.mul(wave.mul(0.72).add(0.06).add(flutter)).min(0.9);
    const phi = theta.mul(bend);
    const hgt = rot.y;
    const bent = vec3(rot.x, hgt.mul(cos(phi)), rot.z).add(wd.mul(hgt.mul(sin(phi))));
    m.positionNode = Fn(() => vec3(xz.x, ground.sub(0.04), xz.y).add(bent))();
    // colour: the meadow's tone at this clump, its own small shift, a shaded base, dry blond tips on some blades
    const tone = grassTone(xz, gold);
    const clumpShift = vec3(r3.sub(0.5).mul(0.1).add(1), r2.sub(0.5).mul(0.07).add(1), float(1));
    let col: N = tone.mul(clumpShift);
    // (round 18) large colour zones across the field: darker and lighter, greener and drier, tens of metres across
    // (one noise for both: the drier zones are the lighter ones, the lush ones darker and greener, as in a real field)
    col = col.mul(meadowZone(xz));
    // (round 17) a root-to-tip gradient in three stops: a deeper, cooler green at the root (the sward's own shade, never
    // black), the meadow's tone through the middle, a lighter, warmer tip where the blade thins and the light comes
    // through; dry blond tips on some blades, more of them on the gold drifts
    // (round 18: deeper self-shadow at the root, brighter tips; still a green at the root, never black)
    const rootC = col.mul(vec3(0.5, 0.58, 0.5));
    const tipC = col.mul(vec3(1.42, 1.36, 1.08)).add(vec3(0.014, 0.012, 0.003));
    col = mix(mix(rootC, col, smoothstep(0.0, 0.45, bend)), tipC, smoothstep(0.45, 1.0, bend));
    const dryTip = vec3(0.36, 0.3, 0.16).mul(mix(float(0.8), float(1.1), r1));
    const dryness = smoothstep(0.8, 1.0, dry.add(gold.mul(0.16)).add(patch.mul(0.05)));
    col = mix(col, dryTip, smoothstep(0.5, 1.0, bend).mul(dryness));
    // seed heads pale straw; flowers white, yellow or a dusty violet by drift
    const isSeed = smoothstep(0.5, 1.5, kind).mul(float(1).sub(isFlower));
    col = mix(col, vec3(0.2, 0.18, 0.1).mul(mix(float(0.75), float(1.1), r2)), isSeed.mul(0.6));
    const fc = hash(floor(xz.mul(1 / 9)).add(8192).dot(vec2(1.0, 517.0)));
    const flowerCol = mix(mix(vec3(0.55, 0.52, 0.45), vec3(0.6, 0.45, 0.06), smoothstep(0.33, 0.34, fc)), vec3(0.28, 0.18, 0.38), smoothstep(0.7, 0.71, fc));
    col = mix(col, flowerCol, isFlower);
    const sheen = wave.mul(smoothstep(0.1, 0.8, bend)).mul(strength).mul(0.5);
    col = mix(col, col.mul(1.32), sheen);
    // backlight: thin blades glow against a low sun
    const sunDir = normalize(atmo.sunDir);
    const viewDir = normalize(vec3(xz.x, ground, xz.y).sub(cameraPosition));
    const back = clamp(dot(viewDir, sunDir), 0, 1).pow(4).mul(bend).mul(smoothstep(-0.05, 0.2, sunDir.y));
    m.colorNode = vec4(col, 1);
    // (round 16: both faces of a blade lit alike. DoubleSide flips the normal on the back face, and a blade's normal
    // is nearly straight up, so every back face was lit as if it faced the ground: black. The unflipped normal, always.)
    // (round 17: the rounded normals turned with the clump, and leaned downwind with the bend)
    const n0 = attribute('normal', 'vec3');
    const nr = vec3(n0.x.mul(cs).sub(n0.z.mul(sn)), n0.y, n0.x.mul(sn).add(n0.z.mul(cs))).add(wd.mul(sin(phi).mul(0.5)));
    m.normalNode = transformNormalToView(normalize(nr));
    // (and a broad forward-scatter halo, not only straight at the sun: the whole backlit field glows gold)
    const halo = clamp(dot(viewDir, sunDir), 0, 1).pow(1.5).mul(0.35).mul(bend).mul(smoothstep(-0.05, 0.2, sunDir.y));
    // (round 18: light through a blade is warm and saturated, a yellow-green, not the grey-white of the blade's own
    // colour scaled up)
    const lumC = col.dot(vec3(0.3, 0.55, 0.15));
    const transC = mix(vec3(lumC), col, 1.8).max(0).mul(vec3(1.25, 1.15, 0.45));
    m.emissiveNode = transC.mul(back.add(halo)).mul(vec3(glbU.sunColor)).mul(0.075);
    m.roughnessNode = float(0.92);
    m.specularIntensityNode = float(0.22);
    m.metalnessNode = float(0);
    return m;
  }

  update(camera: THREE.Camera, t: number) {
    grassU.time.value = t;
    for (const g of this.grids) g.uni.set(Math.floor(camera.position.x / g.SP), Math.floor(camera.position.z / g.SP));
  }
}
