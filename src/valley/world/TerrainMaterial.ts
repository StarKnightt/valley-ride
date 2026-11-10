/**
 * Valley terrain shading (from Island's terrain material, the coast taken out): eight layers from the baked masks
 * (river pebbles, wet river stones, pine-needle forest floor, meadow grass, trail soil, granite, moss, snow),
 * height-blended, with per-pixel normals from the 1 m heightmap plus each layer's detail normal, triplanar granite on
 * steep faces, wet banks, caustics in the shallows and cloud shadows. The meadow grass turns to dry straw gold where
 * mask0.r says so. Flat colours stand in until the KTX2 arrays stream in, swapped without recompiling.
 */
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import {
  abs, float, max, mix, mx_noise_float, mx_fractal_noise_float, normalize, positionWorld, pow, smoothstep, texture,
  transformNormalToView, uniform, vec2, vec3, vec4, exp, int, Fn, dFdx, dFdy, cross, dot, sign, length, cameraPosition, sin,
  type N,
} from '../core/tsl';
import { HALF_WORLD, WORLD_SIZE } from './layout';
import type { Heightfield } from './Heightfield';
import { heightLookup } from './Terrain';
import { cloudShadow } from '../sky/Sky';
import { atmo } from '../sky/Atmosphere';
import { wetness } from './weatherUniforms';
import { grassTone, meadowZone } from '../veg/Grass';
import { trailTexture } from './trailField';
import { loadKTX2, placeholderArray, toArray } from '../core/Assets';

/** layer order in the arrays (tools/build-valley-tex.ts + Island's grass, dirt and moss) */
const LAYERS = ['pebbles', 'pebbles_wet', 'forest', 'grass', 'dirt', 'granite', 'moss', 'snow'];
/** linear target albedos, for the stand-in colours */
const TARGET = [[0.24, 0.215, 0.18], [0.1, 0.092, 0.078], [0.075, 0.058, 0.038], [0.085, 0.13, 0.035], [0.2, 0.11, 0.06], [0.17, 0.16, 0.148], [0.075, 0.085, 0.05], [0.72, 0.75, 0.8]];
/** world metres per texture repeat */
const SCALE = [2.6, 2.2, 3.4, 2.2, 3.8, 6.0, 3.4, 5.0];
const ROUGH = [0.85, 0.5, 0.92, 0.95, 0.9, 0.82, 0.85, 0.6];

const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

export const terrainU = {
  time: uniform(0),
};

export function createTerrainMaterial(hf: Heightfield) {
  const m = new THREE.MeshPhysicalNodeMaterial();
  m.name = 'terrain';
  const heightAt = heightLookup(hf);
  const maskUV = (p: N) => p.add(HALF_WORLD).div(WORLD_SIZE);

  const albedoPh = placeholderArray(TARGET.map((c) => [...c.map(toSrgb), 0.5]), true);
  const normalPh = placeholderArray(ROUGH.map((r) => [0.5, 0.5, r, 1]), false);
  const albedoNodes: N[] = [];
  const normalNodes: N[] = [];
  const sampleA = (layer: number, uvL: N, bias?: N) => {
    const t0 = texture(albedoPh, uvL).depth(int(layer));
    const t = bias ? t0.bias(bias) : t0;
    albedoNodes.push(t);
    return t;
  };
  const sampleN = (layer: number, uvL: N, bias?: N) => {
    const t0 = texture(normalPh, uvL).depth(int(layer));
    const t = bias ? t0.bias(bias) : t0;
    normalNodes.push(t);
    return t;
  };

  const nrm = Fn(([xz, e]: N[]) => {
    const hl = heightAt(xz.sub(vec2(e, 0))), hr = heightAt(xz.add(vec2(e, 0)));
    const hd = heightAt(xz.sub(vec2(0, e))), hu = heightAt(xz.add(vec2(0, e)));
    // (plus the diagonals: the derivative of a bilinear height kinks at every 1 m texel, and the axis taps alone left
    // a fine grid of lines over every far face)
    const d = e.mul(0.7071);
    const a1 = heightAt(xz.add(vec2(d, d))), a2 = heightAt(xz.sub(vec2(d, d)));
    const b1 = heightAt(xz.add(vec2(d, d.negate()))), b2 = heightAt(xz.sub(vec2(d, d.negate())));
    // diagonal gradients: (a1 - a2) along (1,1), (b1 - b2) along (1,-1), each over 2e
    const gxD = a1.sub(a2).add(b1.sub(b2)).mul(0.5), gzD = a1.sub(a2).sub(b1.sub(b2)).mul(0.5);
    const gx = hr.sub(hl).add(gxD.mul(1.4142)).mul(0.5), gz = hu.sub(hd).add(gzD.mul(1.4142)).mul(0.5);
    return normalize(vec3(gx.negate(), e.mul(2), gz.negate()));
  });

  const p = positionWorld;
  const xz = p.xz;
  // (the baked mountain faces carry the raster's own cliff bands, and a 1 m difference turned them into slope steps
  // tens of metres across every high face, the "stair-stepped" cliffs: the step widens with the height and with
  // distance, where a pixel covers metres anyway)
  const nE = max(float(1), max(positionWorld.y.div(90), length(cameraPosition.sub(positionWorld)).div(45))).min(14);
  const n = nrm(xz, nE);
  const m0 = texture(hf.mask0Tex, maskUV(xz));
  const m1 = texture(hf.mask1Tex, maskUV(xz));
  const h = p.y;
  const slope = float(1).sub(n.y);
  const macro = mx_fractal_noise_float(vec3(xz.mul(1 / 70), 0.5), 3, 2, 0.5);
  const micro = mx_noise_float(vec3(xz.mul(1 / 6), 2.5));
  // signed distance to the river's water (m, + on land)
  const shoreS = texture(hf.shoreTex, maskUV(xz)).level(0).r;

  // ---- layer weights from the masks
  const gold = m0.x;
  // snow only where it lasts: the high faces turned from the sun (the sun stands north here, so the south-facing (+z)
  // slopes), never on the steepest walls, with a ragged edge
  const shadeFace = smoothstep(-0.25, 0.3, n.z.add(micro.mul(0.15)));
  const snow = m1.w.mul(shadeFace).mul(float(1).sub(smoothstep(0.5, 0.72, slope).mul(0.75)));
  const rock0 = max(m1.x, smoothstep(0.42, 0.6, slope.add(micro.mul(0.05)))).mul(float(1).sub(snow.mul(0.6)));
  // (NEXT5 §1: the low, gentle rock (the bald grey domes by the camp) is grassy hillside with outcrops breaking through
  // where it steepens, not a smeared grey plaster; the mountains above keep their rock)
  const outcrop = smoothstep(0.1, 0.55, mx_noise_float(vec3(xz.mul(1 / 26), 7.3)).add(micro.mul(0.2)));
  const lowGentle = float(1).sub(smoothstep(0.3, 0.46, slope)).mul(float(1).sub(smoothstep(230, 300, h)));
  const rock = rock0.mul(float(1).sub(lowGentle.mul(float(1).sub(outcrop.mul(0.35)))));
  const hillGrass = rock0.sub(rock).clamp(0, 1);
  // trails: a ragged edge (grass growing in from the sides in tufts), not a clean ribbon
  const edgeN = mx_noise_float(vec3(xz.mul(1 / 1.7), 9.1)).mul(0.5).add(mx_noise_float(vec3(xz.mul(1 / 5.5), 4.4)).mul(0.5));
  const grass = m0.y, forest = m0.w;
  const dirt0 = smoothstep(0.12, 0.62, m0.z.add(edgeN.mul(0.32)));
  // a two-track trail: wheel/hoof ruts either side of a grassy crown (from the trails' distance field), wobbling a
  // little along the way
  const tdw = texture(trailTexture(), maskUV(xz)).level(0).r.add(mx_noise_float(vec3(xz.mul(1 / 5), 2.9)).mul(0.14));
  const crown = smoothstep(0.34, 0.14, tdw).mul(smoothstep(-0.3, 0.4, mx_noise_float(vec3(xz.mul(1 / 3.3), 6.1)).add(0.25)));
  const rut = smoothstep(0.2, 0.06, abs(tdw.sub(0.66))).mul(dirt0);
  const dirt = dirt0.mul(float(1).sub(crown.mul(0.8)));
  // scree: the talus under the cliffs, loose stone on the moderate slopes of the high ground
  const scree = smoothstep(0.2, 0.36, slope).mul(smoothstep(0.5, 0.36, slope)).mul(smoothstep(150, 210, h)).mul(float(1).sub(m0.w)).mul(0.55);
  // gravel and stones pressed into the trail in patches
  const trailGravel = dirt.mul(smoothstep(0.15, 0.55, mx_noise_float(vec3(xz.mul(1 / 3.1), 6.6)))).mul(0.6);
  const water = m1.z;
  // the river's banks: a strip of dry cobbles above the water, wet stones at and under it
  const bankDry = smoothstep(4.5 + 1.5, 0.5, shoreS.add(micro.mul(1.6))).mul(smoothstep(-1.0, 0.6, shoreS));
  // (a wide, ragged wet margin: the dry cobbles darken over a metre or two down to the water, not at one line)
  const bankWet = smoothstep(2.2, -0.9, shoreS.add(micro.mul(1.4)).add(mx_noise_float(vec3(xz.mul(1 / 1.3), 8.2)).mul(0.5)));
  const notRock = float(1).sub(rock);
  const notBank = float(1).sub(max(bankDry, bankWet));
  const wBase = float(1).sub(max(max(rock, snow), max(max(grass, dirt), forest))).clamp(0, 1);
  const ws = [
    bankDry.mul(notRock.mul(0.7).add(0.3)).add(scree.mul(0.9)).add(trailGravel),
    bankWet,
    forest.mul(notRock).mul(notBank).add(wBase.mul(0.4)),
    grass.mul(notRock).mul(float(1).sub(forest.mul(0.85))).mul(notBank).mul(float(1).sub(snow)).add(wBase.mul(0.6)).add(dirt0.mul(crown).mul(0.8)).add(hillGrass),
    dirt.mul(float(1).sub(rock.mul(0.7))).mul(notBank),
    rock.mul(float(1).sub(forest.mul(0.4))),
    // moss, scrub and turf in drifts over the gentler rock (alpine meadow between the outcrops), less up high
    rock.mul(forest.mul(0.7).add(0.05)).mul(smoothstep(220, 140, h))
      .add(rock.mul(smoothstep(0.55, 0.35, slope)).mul(smoothstep(0.0, 0.45, mx_noise_float(vec3(xz.mul(1 / 21), 5.5)))).mul(smoothstep(420, 300, h)).mul(0.9)),
    snow,
  ];

  let albedo: N = vec3(0), rough: N = float(0), dn: N = vec2(0), aoAcc: N = float(0), total: N = float(0.0001);
  const tw = pow(abs(n), vec3(4));
  const twn = tw.div(tw.x.add(tw.y).add(tw.z));
  const steepW = smoothstep(0.32, 0.62, slope);
  let rockBig: N = vec4(0.5), wRock: N = float(0);
  for (let i = 0; i < LAYERS.length; i++) {
    const uvL = xz.div(SCALE[i]).add(i * 0.37);
    const bias = i === 4 ? forest.mul(2.0) : i === 2 ? float(0.8) : undefined;
    let tA = sampleA(i, uvL, bias);
    let tN = sampleN(i, uvL, bias);
    if (i === 5 || i === 6 || i === 7) {
      const sx = p.zy.div(SCALE[i]), sz = p.xy.div(SCALE[i]);
      tA = tA.mul(twn.y).add(sampleA(i, sx).mul(twn.x)).add(sampleA(i, sz).mul(twn.z));
      tN = tN.mul(twn.y).add(sampleN(i, sx).mul(twn.x)).add(sampleN(i, sz).mul(twn.z));
    }
    if (i === 5) {
      // the same granite at ~28 m: lighter and darker reaches over whole faces, so a mountainside is not one tile;
      // dark runoff streaks down the steep faces
      const sB = SCALE[i] * 4.6;
      rockBig = sampleA(i, xz.div(sB).add(0.71)).mul(twn.y).add(sampleA(i, p.yz.div(sB).add(0.23)).mul(twn.x)).add(sampleA(i, p.yx.div(sB).add(0.57)).mul(twn.z));
      const mean = vec3(...TARGET[5]);
      const patch = mix(vec3(1), rockBig.rgb.div(mean), 0.6);
      const tintN = mx_noise_float(p.mul(1 / 46));
      const along = p.x.add(p.z);
      const streak = smoothstep(0.15, 0.65, mx_noise_float(vec3(along.mul(0.11), h.mul(0.022).add(tintN.mul(2.5)), 2.2)).mul(0.5).add(0.5));
      const wall = mix(vec3(1), mix(vec3(0.86, 0.85, 0.84), vec3(1), float(1).sub(streak)), steepW);
      // (NEXT5 §1: no strata. The sine beds of warped height drew the terrain's own contour lines across every face,
      // wood grain from afar.) Instead: patches of warmer and cooler stone in 3D noise, and fractured faces: blocky
      // light/dark facets a few metres across where the stone breaks, cracks between them, fading out with distance
      const sd0 = length(cameraPosition.sub(p));
      const fineK = smoothstep(380, 120, sd0);
      const warmCool = mix(vec3(1), mix(vec3(0.92, 0.95, 1.0), vec3(1.08, 1.0, 0.88), smoothstep(-0.35, 0.35, tintN)), steepW.mul(0.8).add(0.2));
      const fac = mx_noise_float(p.mul(1 / 3.4).add(vec3(1.7, 0.3, 4.1)));
      const facet = mix(float(1), mix(float(0.84), float(1.1), smoothstep(-0.3, 0.3, fac)), steepW.mul(fineK));
      const crack = smoothstep(0.9, 0.985, float(1).sub(abs(fac))).mul(0.35).mul(steepW).mul(smoothstep(160, 50, sd0));
      const seam = crack;
      // gullies: dark runnels straight down the fall line (noise stretched along the slope's own direction), the
      // erosion that gives a mountainside its grain from afar
      // (NEXT5 §1: the old runnels projected noise on each pixel's own fall-line direction: as that direction turned
      // across a face the ridged lines whorled into wood grain. Now plain 3D noise stretched up the slope, soft-edged,
      // so the streaks run down the faces and simply blur out with distance)
      const gully = smoothstep(0.55, 0.95, float(1).sub(abs(mx_noise_float(vec3(p.x.div(9), p.y.div(60), p.z.div(9)).add(4.2)))));
      const gully2 = smoothstep(0.5, 0.95, float(1).sub(abs(mx_noise_float(vec3(p.x.div(30), p.y.div(150), p.z.div(30)).add(1.7)))));
      const runnel = float(1).sub(gully.mul(0.22).mul(fineK).add(gully2.mul(0.18)).mul(smoothstep(0.3, 0.55, slope)));
      // the scan's cool lilac cast taken out: weathered granite is a warm neutral grey
      const rl = tA.rgb.dot(vec3(0.3, 0.55, 0.15));
      const rockRgb = mix(vec3(rl).mul(vec3(1.07, 1.0, 0.88)), tA.rgb, 0.12);
      tA = vec4(rockRgb.mul(patch).mul(wall).mul(warmCool).mul(facet).mul(runnel).mul(float(0.92).sub(seam)), mix(tA.a, rockBig.a, 0.5));
    }
    if (i === 2) {
      // pine litter in drifts, over darker soil and paler dry-needle patches a few metres across
      const cr = Math.cos(1.1), sr = Math.sin(1.1);
      const uvB = vec2(xz.x.mul(cr).sub(xz.y.mul(sr)), xz.x.mul(sr).add(xz.y.mul(cr))).div(SCALE[i] * 1.43).add(0.53);
      const fl: N = TSL.varying(vec3(mx_noise_float(vec3(xz.mul(1 / 7.5), 7.7)), mx_noise_float(vec3(xz.mul(1 / 4.2), 11.3)), mx_noise_float(vec3(xz.mul(1 / 12), 3.9))));
      const drift = smoothstep(-0.22, 0.22, fl.x);
      tA = mix(tA, sampleA(i, uvB), drift);
      tN = mix(tN, sampleN(i, uvB), drift);
      const tint = mix(vec3(1), vec3(0.62, 0.58, 0.52), smoothstep(0.15, 0.55, fl.y)).mul(mix(vec3(1), vec3(1.15, 1.06, 0.92), smoothstep(-0.3, -0.7, fl.y)));
      tA = vec4(tA.rgb.mul(tint), tA.a);
    }
    if (i === 3) {
      // meadow grass ground: green to straw gold with the dry drifts, warmer on the gold
      const straw = vec3(0.27, 0.2, 0.075);
      const lum = tA.rgb.dot(vec3(0.3, 0.55, 0.15));
      const g = smoothstep(0.15, 0.85, gold.add(micro.mul(0.15)));
      tA = vec4(mix(tA.rgb, straw.mul(lum.div(0.11)).mul(0.8).add(straw.mul(0.25)), g.mul(0.85)), tA.a);
      // the sward's own colour (veg/Grass.ts): the shaded base between the blades near by, the whole field (blades
      // sunk into it) farther out, so where the grass ends the meadow carries on in the same tones
      const dG = length(cameraPosition.sub(p));
      // (round 17: matched to the blades' average over their root-to-tip gradient, not their dark root: a gap between
      // clumps is then the same colour as the grass round it, never a dark speckle)
      // (round 18: and the blades' large colour zones, so a gap shows the same zone's colour)
      const sward = grassTone(xz, gold).mul(meadowZone(xz)).mul(mix(float(0.8), float(0.76), smoothstep(12, 70, dG)));
      const texLum = lum.div(0.11).clamp(0.6, 1.4);
      // and beyond the blades a nap: tufts and hollows a metre or few across, darker seed-head drifts, so the far
      // field has the grain of grass and not of felt
      const nap = mx_noise_float(vec3(xz.mul(1 / 1.6), 3.1)).mul(0.6).add(mx_noise_float(vec3(xz.mul(1 / 5.2), 9.4)).mul(0.4));
      const napK = mix(float(1), mix(float(0.8), float(1.14), nap.mul(0.5).add(0.5)), smoothstep(15, 45, dG));
      tA = vec4(mix(tA.rgb, sward.mul(mix(texLum, float(1), 0.6)).mul(napK), mix(float(0.85), float(1), smoothstep(8, 60, dG))), tA.a);
      // (NEXT5 §3: no lime "golf course" far out: the far sward is taken toward a muted sage, as a real field's mixed
      // blades, seed heads and shadow average out at range)
      const swL = tA.rgb.dot(vec3(0.3, 0.55, 0.15));
      tA = vec4(mix(tA.rgb, vec3(swL).mul(vec3(1.02, 1.04, 0.84)), smoothstep(35, 150, dG).mul(0.32)), tA.a);
      // a sward is a matte volume of blades, not a glossy sheet: at grazing view the texture's roughness let the sky's
      // Fresnel reflection whiten whole sunlit slopes
      tN = vec4(tN.xy, float(0.96), tN.w);
    }
    if (i === 4) {
      // a worn riding trail is packed earth, its pebbles pressed in (a little darker under the trees)
      // (dusty and pale, not an orange carpet: the scan's hue mostly taken out; the ruts darker and smoother)
      const lumD = tA.rgb.dot(vec3(0.3, 0.55, 0.15));
      const dusty = mix(vec3(lumD).mul(vec3(1.08, 1.0, 0.86)), tA.rgb, 0.3);
      tA = vec4(mix(vec3(0.2, 0.17, 0.13), dusty, 0.6).mul(mix(float(1), float(0.82), forest)).mul(mix(float(1), float(0.72), rut)), tA.a);
      tN = vec4(mix(vec2(0.5), tN.xy, 0.55), tN.z, tN.w);
    }
    const w = max(ws[i], 0).mul(tA.a.mul(1.4).add(0.3)).pow(2.2);
    if (i === 5) wRock = w;
    albedo = albedo.add(tA.rgb.mul(w));
    rough = rough.add(tN.z.mul(w));
    dn = dn.add(tN.xy.mul(2).sub(1).mul(w));
    aoAcc = aoAcc.add(tN.w.mul(w));
    total = total.add(w);
  }
  albedo = albedo.div(total);
  // (rock from afar: the granite scan's mips average to a cool violet that the blue sky light in the shade turned into
  // purple speckle; the far faces are taken toward a neutral warm grey)
  const dFar = smoothstep(80, 320, length(cameraPosition.sub(p)));
  const rockShare = wRock.div(total).clamp(0, 1);
  const lumR = albedo.dot(vec3(0.3, 0.55, 0.15));
  albedo = mix(albedo, vec3(lumR).mul(vec3(1.06, 1.0, 0.9)), rockShare.mul(mix(float(0.35), float(0.8), dFar)));
  rough = rough.div(total);
  dn = dn.div(total);
  const ao = aoAcc.div(total);
  albedo = albedo.mul(macro.mul(0.16).add(1)).mul(vec3(1.0, mix(1.0, 1.05, macro.mul(0.5).add(0.5)), 1.0));
  // from afar, the ground under the pines reads as the shade of the stand, open grass a deeper green
  const camFar = smoothstep(60, 260, length(cameraPosition.sub(p)));
  albedo = mix(albedo, vec3(0.02, 0.03, 0.017), forest.mul(notRock).mul(camFar).mul(0.8));

  // ---- wetness: river banks, the falls' spray, rain
  const pl = hf.meta.pool;
  const dPool = length(xz.sub(vec2(pl.p[0], pl.p[1])));
  const sprayWet = smoothstep(pl.r + 30, pl.r + 3, dPool).mul(smoothstep(pl.level + 28, pl.level + 1, h));
  const rainWet = wetness.rain.mul(smoothstep(0.3, 0.9, n.y));
  const wet = max(max(m1.y.mul(0.55), rainWet), max(bankWet, sprayWet.mul(0.8))).clamp(0, 1);
  albedo = albedo.mul(mix(float(1), float(0.6), wet));
  rough = mix(rough, float(0.38), wet.mul(0.8));
  albedo = albedo.mul(mix(vec3(1), vec3(0.6, 0.66, 0.56), sprayWet));

  // ---- normal: heightmap normal + layer detail, plus a bump from the big granite height on rock faces
  // (the layers' detail normals fade with distance: past a couple of hundred metres they only alias into stripes)
  const dnK = smoothstep(260, 70, length(cameraPosition.sub(p))).mul(0.9);
  const detailN = normalize(vec3(n.x.add(dn.x.mul(dnK)), n.y, n.z.sub(dn.y.mul(dnK))));
  const dpx = dFdx(p), dpy = dFdy(p);
  const stoneTexel = (SCALE[5] * 4.6) / 1024;
  const stoneW = smoothstep(1.0, 2.0, max(length(dpx), length(dpy)).div(stoneTexel));
  const reliefH = rockBig.a.mul(1.8).mul(stoneW);
  const r1 = cross(dpy, detailN), r2 = cross(detailN, dpx);
  const det = dot(dpx, r1);
  const grad = sign(det).mul(r1.mul(dFdx(reliefH)).add(r2.mul(dFdy(reliefH))));
  const bumped = normalize(abs(det).mul(detailN).sub(grad).add(detailN.mul(1e-6)));
  const camDist = length(cameraPosition.sub(p));
  const bumpW = wRock.div(total).mul(smoothstep(160, 40, camDist)).clamp(0, 1);
  const finalN = normalize(mix(detailN, bumped, bumpW));

  // ---- caustics on the river bed in the shallows
  const depthW = water.mul(smoothstep(0.0, -1.5, shoreS));
  const ct = terrainU.time.mul(0.7);
  const c1 = mx_noise_float(vec3(xz.mul(1.4), ct));
  const c2 = mx_noise_float(vec3(xz.mul(1.4).add(13.1), ct.mul(1.13).add(4)));
  const sunVis = pow(float(1).sub(atmo.overcast), 2).mul(smoothstep(0.02, 0.25, atmo.sunDir.y));
  const caustic = pow(max(float(1).sub(abs(c1.sub(c2))), 0), 14).mul(water).mul(exp(depthW.mul(-0.4))).mul(0.9).mul(sunVis);
  const cloud = cloudShadow(p);

  m.colorNode = vec4(albedo.mul(float(1).add(caustic.mul(cloud))), 1);
  m.roughnessNode = rough;
  m.metalnessNode = float(0);
  m.specularIntensityNode = float(1).sub(forest.mul(0.7)).mul(float(1).sub(ws[3].clamp(0, 1).mul(0.75))).mul(float(1).sub(rockShare.mul(0.55)));
  m.normalNode = transformNormalToView(finalN);
  m.aoNode = mix(float(1), ao, 0.7).mul(float(1).sub(forest.mul(0.4)));

  const loadLayers = async () => {
    const [albedos, normals] = await Promise.all([
      Promise.all(LAYERS.map((l) => loadKTX2(`assets/terrain/${l}_a.ktx2`))),
      Promise.all(LAYERS.map((l) => loadKTX2(`assets/terrain/${l}_n.ktx2`))),
    ]);
    const A = toArray(albedos, true), Nn = toArray(normals, false);
    for (const t of albedoNodes) t.value = A;
    for (const t of normalNodes) t.value = Nn;
  };
  return { material: m, loadLayers };
}
