/**
 * Everything that stands on the valley: the meadow grass (GPU), River Morning's conifers (its 15 grown variants,
 * three LODs each, its textures and tints), our pines and oaks, the rocks, ferns and dead wood, and the landmarks
 * seated on the ground: for now grey placeholder pieces (world/placeholders.ts) until the ruins kit and props are
 * built. Fireflies come out over the meadows at dusk.
 *
 * Placement reads the baked masks on the CPU, so a tree never stands in the river, on a trail, on bare rock or inside
 * a landmark, and every prop sits on the lowest ground under its footprint, sunk a share of its height.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, float, vec3, vec4, uv, mix, smoothstep, sin, hash, instanceIndex, mx_noise_float, texture, abs, pow, clamp,
  cameraPosition, mod, uniform, length, vec2, max, type N,
} from '../core/tsl';
import type { Heightfield } from './Heightfield';
import type { Colliders, HGrid } from './Colliders';
import { HALF_WORLD, MASK_RES, SITES, site, RIVER, POOL, WORLD_SIZE, PATHS, type V2 } from './layout';
import { Grass } from '../veg/Grass';
import { Vegetation, type Species } from '../veg/Vegetation';
import { parseGlb } from '../veg/rmGlb';
import { plantMaterial, rockMaterial, toFloatGeometry, type GlbVariant, type PlantLook } from '../veg/glb';
import { loadGLTF } from '../core/Assets';
import { placeholderPiece, type PieceKind } from './placeholders';
import { Rng, Noise2 } from '../core/noise';
import { sunLit } from '../core/lighting';
import { effectMRT } from '../core/fx';
import { params } from '../core/params';

// River Morning's TREE_VARIANTS (ForestLayout.ts), the fields used here
interface TreeV { id: string; kind: string; height: number; bark: 'pine' | 'fir' | 'atlas' | 'oak'; trunkR: number; needle: [number, number, number]; barkT: [number, number, number]; young?: boolean; snag?: boolean }
const TREES: TreeV[] = [
  // NEXT4 §2: the round-14 pines, built in Blender (tools/blender/pines/make_pines.py): branch tiers with sky between
  // them, needle sprig cards cut from modelled needles, crown-oriented normals; their own needle and bark atlases
  { id: 'pine_a', kind: 'lodgepole', height: 24, bark: 'atlas', trunkR: 0.25, needle: [1.0, 1.0, 0.86], barkT: [1, 1, 1] },
  { id: 'pine_b', kind: 'ponderosa', height: 28, bark: 'atlas', trunkR: 0.5, needle: [1.04, 1.0, 0.82], barkT: [1, 1, 1] },
  { id: 'pine_c', kind: 'spruce', height: 20, bark: 'atlas', trunkR: 0.3, needle: [0.96, 0.98, 0.9], barkT: [1, 1, 1] },
  { id: 'lodgepole_a', kind: 'lodgepole', height: 23.8, bark: 'pine', trunkR: 0.257, needle: [0.58, 0.76, 0.84], barkT: [1.55, 1.45, 1.42] },
  { id: 'lodgepole_b', kind: 'lodgepole', height: 27.9, bark: 'pine', trunkR: 0.26, needle: [0.58, 0.76, 0.84], barkT: [1.55, 1.45, 1.42] },
  { id: 'lodgepole_c', kind: 'lodgepole', height: 16.8, bark: 'pine', trunkR: 0.169, needle: [0.58, 0.76, 0.84], barkT: [1.55, 1.45, 1.42] },
  { id: 'ponderosa_a', kind: 'ponderosa', height: 31.2, bark: 'pine', trunkR: 0.609, needle: [0.66, 0.84, 0.86], barkT: [1.75, 1.42, 1.22] },
  { id: 'ponderosa_b', kind: 'ponderosa', height: 20.9, bark: 'pine', trunkR: 0.378, needle: [0.66, 0.84, 0.86], barkT: [1.75, 1.42, 1.22] },
  { id: 'spruce_a', kind: 'spruce', height: 25.8, bark: 'fir', trunkR: 0.365, needle: [0.6, 0.66, 1.25], barkT: [1.35, 1.3, 1.25] },
  { id: 'spruce_b', kind: 'spruce', height: 30.7, bark: 'fir', trunkR: 0.448, needle: [0.6, 0.66, 1.25], barkT: [1.35, 1.3, 1.25] },
  { id: 'spruce_c', kind: 'spruce', height: 14.8, bark: 'fir', trunkR: 0.221, needle: [0.6, 0.66, 1.25], barkT: [1.35, 1.3, 1.25] },
  { id: 'fir_a', kind: 'fir', height: 18.6, bark: 'fir', trunkR: 0.26, needle: [0.58, 0.66, 1.2], barkT: [1.5, 1.5, 1.5] },
  { id: 'fir_b', kind: 'fir', height: 12.6, bark: 'fir', trunkR: 0.18, needle: [0.58, 0.66, 1.2], barkT: [1.5, 1.5, 1.5] },
  { id: 'spruce_y', kind: 'spruce', height: 9.5, bark: 'fir', trunkR: 0.11, needle: [0.62, 0.69, 1.18], barkT: [1.35, 1.3, 1.25], young: true },
  { id: 'fir_y', kind: 'fir', height: 7.6, bark: 'fir', trunkR: 0.09, needle: [0.6, 0.7, 1.12], barkT: [1.5, 1.5, 1.5], young: true },
  { id: 'spruce_t', kind: 'spruce', height: 12.3, bark: 'fir', trunkR: 0.13, needle: [0.6, 0.66, 1.25], barkT: [1.35, 1.3, 1.25], young: true },
  { id: 'snag_a', kind: 'lodgepole', height: 16.2, bark: 'pine', trunkR: 0.2, needle: [1, 1, 1], barkT: [1.55, 1.45, 1.42], snag: true },
  // NEXT5 §2: broadleaf oaks (tools/blender/broadleaf/make_broadleaf.py): lone meadow trees, edge trees, groves
  { id: 'oak_a', kind: 'oak', height: 13.6, bark: 'oak', trunkR: 0.45, needle: [1.2, 1.18, 1.1], barkT: [1.05, 1.0, 0.95] },
  { id: 'oak_b', kind: 'oak', height: 17.5, bark: 'oak', trunkR: 0.3, needle: [1.2, 1.18, 1.1], barkT: [1.05, 1.0, 0.95] },
  { id: 'snag_b', kind: 'spruce', height: 11.3, bark: 'fir', trunkR: 0.22, needle: [1, 1, 1], barkT: [1.35, 1.3, 1.25], snag: true },
];

/** the variants in use (each costs its draw calls per LOD and pass; these nine cover the looks) */
const USE = new Set(['pine_a', 'pine_b', 'pine_c', 'snag_a', 'oak_a', 'oak_b']);

/** a landmark piece: model, local offset in its site's frame, yaw, largest dimension (m), share of height sunk */
interface Piece { m: PieceKind; at: V2; yaw: number; size: number; sink: number; collide?: 'box' | 'circle' | false }

const LANDMARKS: Record<string, Piece[]> = {
  statue: [
    { m: 'head', at: [0, 0], yaw: 0, size: 34, sink: 0.3, collide: 'circle' },
    { m: 'rubble', at: [17, 7], yaw: 0.6, size: 4.5, sink: 0.25 },
    { m: 'rubble', at: [-15, 11], yaw: 2.1, size: 3.6, sink: 0.25 },
    { m: 'column-fallen', at: [-12, -16], yaw: 0.9, size: 11, sink: 0.2 },
  ],
  obelisk: [
    { m: 'obelisk', at: [0, 0], yaw: 0, size: 17, sink: 0.04 },
    { m: 'rubble', at: [6, 4], yaw: 1.2, size: 3.2, sink: 0.25 },
    { m: 'rubble', at: [-5, -6], yaw: 2.6, size: 2.6, sink: 0.25 },
  ],
  ruins: [
    { m: 'floor', at: [0, 0], yaw: 0, size: 22, sink: 0.35, collide: false },
    { m: 'wall', at: [0, -24], yaw: 0, size: 18, sink: 0.08 },
    { m: 'wall', at: [-24, -4], yaw: Math.PI / 2, size: 16, sink: 0.08 },
    { m: 'wall', at: [23, -10], yaw: Math.PI / 2 + 0.06, size: 14, sink: 0.2 },
    { m: 'wall-window', at: [-13, 21], yaw: 0, size: 13, sink: 0.06 },
    { m: 'wall-window', at: [16, 19], yaw: 0.08, size: 11, sink: 0.12 },
    { m: 'arch', at: [1, 25], yaw: 0, size: 15, sink: 0.04 },
    { m: 'column', at: [-8, -14], yaw: 0, size: 10, sink: 0.04 },
    { m: 'column', at: [-8, -4], yaw: 0.7, size: 11, sink: 0.04 },
    { m: 'column', at: [-8, 6], yaw: 1.5, size: 9, sink: 0.04 },
    { m: 'column', at: [8, -14], yaw: 2.2, size: 10.5, sink: 0.04 },
    { m: 'column', at: [8, 6], yaw: 0.3, size: 8, sink: 0.04 },
    { m: 'column-fallen', at: [11, -3], yaw: 1.25, size: 11, sink: 0.22 },
    { m: 'column-fallen', at: [-17, 12], yaw: 0.35, size: 9, sink: 0.22 },
    { m: 'rubble', at: [19, 6], yaw: 0.2, size: 4.2, sink: 0.25 },
    { m: 'rubble', at: [-20, -16], yaw: 1.7, size: 3.8, sink: 0.25 },
    { m: 'rubble', at: [3, -19], yaw: 2.9, size: 3.0, sink: 0.25 },
    { m: 'urns', at: [-18, -18], yaw: 0.5, size: 1.5, sink: 0.05 },
    { m: 'urns', at: [17, 14], yaw: 2.0, size: 1.3, sink: 0.05 },
  ],
  camp: [
    { m: 'tent', at: [-9, -7], yaw: 0.7, size: 5.6, sink: 0.02 },
    { m: 'tent', at: [7, -10], yaw: -0.5, size: 5.6, sink: 0.02 },
    { m: 'tent', at: [11, 4], yaw: -1.7, size: 5.2, sink: 0.02 },
    { m: 'urns', at: [-3, -12], yaw: 0.2, size: 1.4, sink: 0.05 },
    { m: 'urns', at: [14, -4], yaw: 1.4, size: 1.2, sink: 0.05 },
  ],
  bones: [
    { m: 'column', at: [0, 0], yaw: 0.4, size: 9, sink: 0.05 },
    { m: 'column-fallen', at: [6, 4], yaw: 0.8, size: 10, sink: 0.22 },
    { m: 'boulders', at: [-7, -5], yaw: 1.9, size: 6, sink: 0.2 },
  ],
};
/**
 * A prop's plan-view height grid (Colliders' HGrid): vertical rays down through every triangle at each cell's centre;
 * a cell keeps its highest hit (the top) and its lowest downward-facing hit (the underside: an arch's soffit; none
 * means solid down to the ground).
 */
function meshGrid(root: THREE.Object3D, cell: number): HGrid | null {
  root.updateMatrixWorld(true);
  const tris: number[] = [];
  const v = new THREE.Vector3();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    const pos = m.geometry.getAttribute('position');
    const idx = m.geometry.index;
    const n = idx ? idx.count : pos.count;
    for (let t = 0; t + 2 < n; t += 3) for (let q = 0; q < 3; q++) {
      v.fromBufferAttribute(pos, idx ? idx.getX(t + q) : t + q).applyMatrix4(m.matrixWorld);
      tris.push(v.x, v.y, v.z);
    }
  });
  if (!tris.length) return null;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < tris.length; i += 3) { x0 = Math.min(x0, tris[i]); x1 = Math.max(x1, tris[i]); z0 = Math.min(z0, tris[i + 2]); z1 = Math.max(z1, tris[i + 2]); }
  const nx = Math.max(1, Math.ceil((x1 - x0) / cell)), nz = Math.max(1, Math.ceil((z1 - z0) / cell));
  const top = new Float32Array(nx * nz).fill(-Infinity), low = new Float32Array(nx * nz).fill(Infinity), hasDown = new Uint8Array(nx * nz);
  for (let t = 0; t < tris.length; t += 9) {
    const ax = tris[t], ay = tris[t + 1], az = tris[t + 2], bx = tris[t + 3], by = tris[t + 4], bz = tris[t + 5], cx = tris[t + 6], cy = tris[t + 7], cz = tris[t + 8];
    // plan-view area (signed): its sign is the face's up/down for a consistently wound mesh
    const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(den) < 1e-9) continue;
    const ny = (bx - ax) * (cz - az) - (bz - az) * (cx - ax); // y of the face normal (b-a) x (c-a)
    const down = ny > 0 ? 0 : 1;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / cell - 0.5)), i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx, cx) - x0) / cell - 0.5));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - z0) / cell - 0.5)), j1 = Math.min(nz - 1, Math.ceil((Math.max(az, bz, cz) - z0) / cell - 0.5));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const px = x0 + (i + 0.5) * cell, pz = z0 + (j + 0.5) * cell;
      const w1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / den;
      const w2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / den;
      const w3 = 1 - w1 - w2;
      if (w1 < -1e-4 || w2 < -1e-4 || w3 < -1e-4) continue;
      const y = w1 * ay + w2 * by + w3 * cy, k = j * nx + i;
      if (y > top[k]) top[k] = y;
      if (down && y < low[k]) { low[k] = y; hasDown[k] = 1; }
    }
  }
  // (no underside below a top: solid to the ground; an underside above the top is a stray face: solid too)
  for (let k = 0; k < top.length; k++) if (!hasDown[k] || low[k] > top[k]) low[k] = -Infinity;
  return { x0, z0, cell, nx, nz, top, low };
}

/** the camp fire, in the camp's frame */
const FIRE_AT: V2 = [1, 1];

/** fireflies: how many, in what tile (they repeat every TILE metres and wrap round the camera) */
const FLIES = 420, TILE = 90;

export const valleyU = {
  time: uniform(0),
  flies: uniform(0),
  fire: uniform(1),
};

export class Valley {
  readonly grass: Grass;
  readonly veg: Vegetation;
  readonly group = new THREE.Group();
  /** world positions of the landmarks (the bot tour and the audio read them) */
  readonly landmarks: { name: string; x: number; z: number; y: number; r: number }[] = [];
  /** fallen logs across the trails, to jump: centre, unit axis along the log, half length, radius, top above ground */
  readonly jumpLogs: { x: number; z: number; ax: number; az: number; half: number; r: number; top: number }[] = [];
  firePos = new THREE.Vector3();
  fireLight = new THREE.PointLight(0xff8a3a, 0, 26, 2);
  private flies?: THREE.Sprite;
  private counts: Record<string, number> = {};

  constructor(private hf: Heightfield, private colliders: Colliders, private scene: THREE.Scene) {
    this.grass = new Grass(hf);
    this.veg = new Vegetation(hf, colliders);
    scene.add(this.grass.group, this.veg.group, this.group);
  }

  // ---------------------------------------------------------------- mask lookups (CPU)
  private mi(x: number, z: number) {
    const i = Math.min(MASK_RES - 1, Math.max(0, Math.floor(((x + HALF_WORLD) / WORLD_SIZE) * MASK_RES)));
    const j = Math.min(MASK_RES - 1, Math.max(0, Math.floor(((z + HALF_WORLD) / WORLD_SIZE) * MASK_RES)));
    return (j * MASK_RES + i) * 4;
  }
  /** golden, grass, dirt, forest, rock, wet, water, snow (0..1) */
  mask(x: number, z: number) {
    const k = this.mi(x, z), a = this.hf.mask0, b = this.hf.mask1;
    return { gold: a[k] / 255, grass: a[k + 1] / 255, dirt: a[k + 2] / 255, forest: a[k + 3] / 255, rock: b[k] / 255, wet: b[k + 1] / 255, water: b[k + 2] / 255, snow: b[k + 3] / 255 };
  }
  /** the lowest ground under a footprint of radius r */
  private minGround(x: number, z: number, r: number) {
    let g = this.hf.height(x, z);
    for (let a = 0; a < 8; a++) g = Math.min(g, this.hf.height(x + Math.cos(a * 0.785) * r, z + Math.sin(a * 0.785) * r));
    return g;
  }
  private slope(x: number, z: number) {
    return 1 - this.hf.normal(x, z).y;
  }
  /** distance (m) to the nearest trail's centre line */
  trailDist(x: number, z: number) {
    let best = 1e9;
    for (const path of PATHS) for (let i = 0; i + 1 < path.length; i++) {
      const [ax, az] = path[i], [bx, bz] = path[i + 1];
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
    }
    return best;
  }
  private nearSite(x: number, z: number, pad: number) {
    for (const s of SITES) if (s.r > 0 && Math.hypot(x - s.p[0], z - s.p[1]) < s.r + pad) return true;
    return Math.hypot(x - POOL.p[0], z - POOL.p[1]) < POOL.r + pad;
  }

  async load() {
    const t0 = performance.now();
    await Promise.all([this.loadTrees(), this.loadRocks(), this.loadLandmarks(), this.loadUnder()]);
    this.makeFire();
    this.makeFlies();
    this.veg.prime = 3;
    console.info(`[valley] world in ${((performance.now() - t0) / 1000).toFixed(1)} s`, JSON.stringify(this.counts), `colliders ${this.colliders.count}`);
  }

  // ---------------------------------------------------------------- trees
  private async loadTrees() {
    const tl = new THREE.TextureLoader();
    const tex = (n: string, srgb: boolean) => tl.loadAsync(`assets/trees/textures/${n}.webp`).then((t) => {
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
      t.flipY = false;
      return t;
    });
    const [nc, nm, bpc, bpn, bpm, bfc, bfn, bfm, pnc, pnn, pnm, pbc, pbn, pbm] = await Promise.all([
      tex('needles_c', true), tex('needles_m', false),
      tex('bark_pine_c', true), tex('bark_pine_n', false), tex('bark_pine_m', false),
      tex('bark_fir_c', true), tex('bark_fir_n', false), tex('bark_fir_m', false),
      tex('pine_needles_c', true), tex('pine_needles_n', false), tex('pine_needles_m', false),
      tex('pine_bark_c', true), tex('pine_bark_n', false), tex('pine_bark_m', false),
    ]);
    const [olc, oln, olm, obc, obn, obm] = await Promise.all([
      tex('broadleaf_leaves_c', true), tex('broadleaf_leaves_n', false), tex('broadleaf_leaves_m', false),
      tex('broadleaf_bark_c', true), tex('broadleaf_bark_n', false), tex('broadleaf_bark_m', false),
    ]);
    olc.wrapS = olc.wrapT = oln.wrapS = oln.wrapT = olm.wrapS = olm.wrapT = THREE.ClampToEdgeWrapping;
    // (leaves_m: R AO, G roughness; the bark tiles)
    const oakLeaf = new THREE.MeshStandardMaterial({ name: 'needles', map: olc, normalMap: oln, roughnessMap: olm, aoMap: olm, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 1 });
    const oakBark = new THREE.MeshStandardMaterial({ name: 'bark_oak', map: obc, normalMap: obn, roughnessMap: obm, aoMap: obm, roughness: 1 });
    pnc.wrapS = pnc.wrapT = pnn.wrapS = pnn.wrapT = pnm.wrapS = pnm.wrapT = THREE.ClampToEdgeWrapping;
    // (the atlas pines: standard glTF UVs, v down, so the maps keep flipY false as loaded here)
    const needleAtlas = new THREE.MeshStandardMaterial({ name: 'needles', map: pnc, normalMap: pnn, roughnessMap: pnm, aoMap: pnm, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 1 });
    const barkAtlas = new THREE.MeshStandardMaterial({ name: 'bark_pine', map: pbc, normalMap: pbn, roughnessMap: pbm, aoMap: pbm, roughness: 1 });
    // (as River Morning loads them: flipY false, matching rmGlb's v; the needle atlas clamps)
    nc.wrapS = nc.wrapT = nm.wrapS = nm.wrapT = THREE.ClampToEdgeWrapping;
    const needleSrc = new THREE.MeshStandardMaterial({ name: 'needles', map: nc, roughnessMap: nm, aoMap: nm, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 1 });
    const barkSrc = {
      pine: new THREE.MeshStandardMaterial({ name: 'bark_pine', map: bpc, normalMap: bpn, roughnessMap: bpm, aoMap: bpm, roughness: 1 }),
      fir: new THREE.MeshStandardMaterial({ name: 'bark_fir', map: bfc, normalMap: bfn, roughnessMap: bfm, aoMap: bfm, roughness: 1 }),
    };
    const mats = new Map<string, THREE.Material>();
    const matOf = (key: string, src: THREE.MeshStandardMaterial, look: PlantLook) => {
      let m = mats.get(key);
      if (!m) mats.set(key, (m = plantMaterial(src, look)));
      return m;
    };
    const variants = await Promise.all(TREES.filter((tv) => USE.has(tv.id)).map(async (tv) => {
      const lods = await Promise.all([0, 1, 2].map((k) => fetch(`assets/trees/${tv.id}_lod${k}.glb`).then((r) => {
        if (!r.ok) throw new Error(`tree ${tv.id} lod${k}: ${r.status}`);
        return r.arrayBuffer();
      })));
      const look: PlantLook = { sway: tv.young ? 0.03 : 0.018, height: tv.height, translucent: 0.5 };
      const v: GlbVariant = { name: tv.id, lods: [], height: tv.height, radius: 2 };
      lods.forEach((buf, k) => {
        v.lods[k] = parseGlb(buf).map((p) => {
          const g = p.geometry;
          const c = g.getAttribute('color'), w = g.getAttribute('wind');
          const n = g.getAttribute('position').count;
          // COLOR_0 for plantMaterial: AO, bend (the trunk's height weight), flutter, phase
          const col = new Float32Array(n * 4);
          for (let i = 0; i < n; i++) {
            const dead = c ? c.getW(i) : 0;
            col[i * 4] = c ? c.getX(i) : 1;
            col[i * 4 + 1] = w ? Math.max(w.getW(i), w.getX(i) * 0.6) : 0;
            col[i * 4 + 2] = w ? w.getY(i) * (1 - dead) : 0;
            col[i * 4 + 3] = w ? w.getZ(i) : 0;
          }
          g.setAttribute('color', new THREE.BufferAttribute(col, 4));
          if (!w) g.setAttribute('wind', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
          const leaf = /needle/.test(p.material);
          const src = tv.bark === 'oak' ? (leaf ? oakLeaf : oakBark) : tv.bark === 'atlas' ? (leaf ? needleAtlas : barkAtlas) : leaf ? needleSrc : barkSrc[tv.bark];
          const tint = leaf ? tv.needle : tv.snag ? [1.05, 1.02, 1.0] as [number, number, number] : tv.barkT;
          const ov = matOf(`${tv.bark === 'atlas' ? 'A' : tv.bark === 'oak' ? 'O' : ''}${leaf ? 'n' : tv.bark}:${tint.join(',')}:${look.sway}:${look.height}`, src, { ...look, tint: leaf ? tint.map((x) => x * 0.9) as [number, number, number] : tint.map((x) => x * 0.55) as [number, number, number] });
          return { geometry: g, mat: p.material, src, override: ov };
        });
      });
      return { tv, v };
    }));

    // (the oaks' dense crowns drop to their light LOD2 sooner than the pines)
    const species0 = variants.map(({ tv, v }) => ({ tv, sp: this.veg.speciesOf(v, tv.kind === 'oak' ? [42, 120, 720] : [42, 200, 720], [true, false, false], { sway: 0.02, height: tv.height }, { maxScale: 1.2 }) }));
    const species = species0;
    const lists = species.map(() => [] as number[]);
    const rng = new Rng(4242);
    const ix = (id: string) => variants.findIndex((v) => v.tv.id === id);
    const I = Object.fromEntries([...USE].map((id) => [id, ix(id)])) as Record<string, number>;
    const pick = (alt: number, edge: number, wet: boolean) => {
      // the valley floor: ponderosa and lodgepole; higher and on the hills: spruce and fir; young trees on the edges
      const r = rng.next();
      const any = (ids: string[]) => I[ids[rng.int(ids.length)]];
      if (r < 0.04) return I.snag_a;
      // broadleaf oaks: most of the lone trees out on the meadows, a share of the stands' edges, none up high
      const oakP = alt > 160 ? 0 : edge > 0.7 ? 0.75 : edge > 0.3 ? 0.3 : 0.04;
      if (rng.next() < oakP) return rng.next() < 0.6 ? I.oak_a : I.oak_b;
      if (wet) return any(['pine_c', 'pine_c', 'pine_a']);
      if (alt < 70) return any(['pine_a', 'pine_b', 'pine_b', 'pine_a']);
      if (alt < 120) return any(['pine_a', 'pine_c', 'pine_b']);
      return any(['pine_c', 'pine_c', 'pine_a']);
    };
    const CELL = 7.0;
    const nz = new Noise2(31);
    let n = 0;
    for (let x = -HALF_WORLD + CELL; x < HALF_WORLD - CELL; x += CELL) for (let z = -HALF_WORLD + CELL; z < HALF_WORLD - CELL; z += CELL) {
      const px = x + (rng.next() - 0.5) * CELL * 0.95, pz = z + (rng.next() - 0.5) * CELL * 0.95;
      const r0 = rng.next();
      const m = this.mask(px, pz);
      const forest = THREE.MathUtils.smoothstep(m.forest, 0.18, 0.65);
      // (stands in clumps and glades, not an even wall of trunks: dense groves, thinner reaches, the edge broken into
      // outliers and bays)
      const clump = THREE.MathUtils.clamp(0.5 + 0.75 * nz.simplex(px / 38, pz / 38) + 0.3 * nz.simplex(px / 11, pz / 11), 0.12, 1);
      const edgeT = forest < 0.85 ? clump * clump : clump;
      // scattered lone trees out on the meadows too
      const p = Math.max(forest * 0.95 * edgeT, 0.008 + m.grass * 0.007);
      if (r0 > p) continue;
      if (m.water > 0.05 || m.dirt > 0.3 || m.rock > 0.55 || m.snow > 0.2) continue;
      if (this.hf.shoreDist(px, pz) < 6) continue;
      if (this.nearSite(px, pz, 12)) continue;
      // (a clear lane either side of every trail: riders follow them at a gallop)
      if (this.trailDist(px, pz) < 6) continue;
      const sl = this.slope(px, pz);
      if (sl > 0.28) continue;
      const y = this.minGround(px, pz, 0.6);
      if (y > 300) continue;
      const vi = pick(y, 1 - forest, this.hf.shoreDist(px, pz) < 30);
      const tv = variants[vi].tv;
      // (the stand's edge: younger, smaller trees)
      const young = 1 - forest > 0.5 && tv.id === 'pine_c' ? 0.45 + rng.next() * 0.25 : 1;
      const s = tv.kind === 'oak' ? 0.75 + rng.next() * 0.4 : ((tv.young ? 0.8 : 0.66) + rng.next() * 0.6) * young;
      lists[vi].push(px, y + 0.15, pz, rng.next() * Math.PI * 2, s, rng.next());
      this.colliders.circle(px, pz, tv.trunkR * s + 0.35);
      n++;
    }
    // young pines in twos and threes out on the meadows and along the stands' edges: the shrub layer of the open
    // ground (RDR2's meadows are never bare lawn between the woods)
    const yc = I.pine_c;
    for (let x = -HALF_WORLD + 12; x < HALF_WORLD - 12; x += 12) for (let z = -HALF_WORLD + 12; z < HALF_WORLD - 12; z += 12) {
      const px = x + (rng.next() - 0.5) * 11, pz = z + (rng.next() - 0.5) * 11;
      const m = this.mask(px, pz);
      const edge = m.forest > 0.08 && m.forest < 0.45 ? 0.16 : 0;
      if (rng.next() > Math.max(edge, m.grass * 0.035)) continue;
      const k = 1 + rng.int(3);
      for (let j = 0; j < k; j++) {
        const qx = px + (rng.next() - 0.5) * 5, qz = pz + (rng.next() - 0.5) * 5;
        const q = this.mask(qx, qz);
        if (q.water > 0.05 || q.dirt > 0.25 || q.rock > 0.4 || q.snow > 0.1 || this.trailDist(qx, qz) < 4.5 || this.nearSite(qx, qz, 8)) continue;
        if (this.hf.shoreDist(qx, qz) < 4 || this.slope(qx, qz) > 0.3) continue;
        const sc = 0.07 + rng.next() * 0.09;
        lists[yc].push(qx, this.minGround(qx, qz, 0.3) + 0.05, qz, rng.next() * Math.PI * 2, sc, rng.next());
        n++;
      }
    }
    // oak groves of one to three a few trail-widths off the trails, unevenly spaced, so the riding lines pass varied
    // broadleaf and pine instead of an even wall of conifers
    for (const path of PATHS) for (let i = 0; i + 1 < path.length; i++) {
      const [ax, az] = path[i], [bx, bz] = path[i + 1];
      const L = Math.hypot(bx - ax, bz - az);
      for (let t = rng.next() * 30; t < L; t += 26 + rng.next() * 55) {
        if (rng.next() > 0.55) continue;
        const ux = (bx - ax) / L, uz = (bz - az) / L, side = rng.next() < 0.5 ? -1 : 1;
        const off = 10 + rng.next() * 22;
        const cx = ax + ux * t - uz * off * side, cz = az + uz * t + ux * off * side;
        const k = 1 + rng.int(3);
        for (let j = 0; j < k; j++) {
          const a = rng.next() * Math.PI * 2, d = j === 0 ? 0 : 6 + rng.next() * 9;
          const qx = cx + Math.cos(a) * d, qz = cz + Math.sin(a) * d;
          const q = this.mask(qx, qz);
          if (q.water > 0.05 || q.dirt > 0.3 || q.rock > 0.5 || q.snow > 0.1 || this.trailDist(qx, qz) < 8 || this.nearSite(qx, qz, 12)) continue;
          if (this.hf.shoreDist(qx, qz) < 6 || this.slope(qx, qz) > 0.25) continue;
          const y = this.minGround(qx, qz, 0.8);
          if (y > 160) continue;
          const vi = rng.next() < 0.6 ? I.oak_a : I.oak_b;
          const s = 0.7 + rng.next() * 0.45;
          lists[vi].push(qx, y + 0.15, qz, rng.next() * Math.PI * 2, s, rng.next());
          this.colliders.circle(qx, qz, variants[vi].tv.trunkR * s + 0.35);
          n++;
        }
      }
    }
    species.forEach((s, i) => this.veg.place(s.sp, lists[i]));
    this.counts.trees = n;
    this.counts.oaks = (lists[I.oak_a].length + lists[I.oak_b].length) / 6;
    this.placeShrubs(variants[I.pine_c].v, variants[I.oak_a].v);
  }

  // ---------------------------------------------------------------- undergrowth
  /**
   * Shrubs: juniper-like mounds from the young pine's crown (its needle clusters only, squashed into a low wide dome),
   * in clumps of two to five over the meadows and thick along the stands' edges, as the RDR2 meadows' brush.
   */
  private placeShrubs(pine: GlbVariant, oak: GlbVariant) {
    /** a crown's leaf triangles above `base` (share of height), squashed into a mound w across and h high */
    const mound = (tree: GlbVariant, base: number, w: number, h: number, lod = 1): GlbVariant => {
      const src = tree.lods[lod] ?? tree.lods[1] ?? tree.lods[0];
      const v: GlbVariant = { name: 'shrub', lods: [[]], height: 1, radius: 1 };
      const H = tree.height;
      for (const p of src.filter((p) => /needle/.test(p.mat))) {
        const g0 = p.geometry.index ? p.geometry.toNonIndexed() : p.geometry.clone();
        const pos = g0.getAttribute('position');
        const keep: number[] = [];
        for (let t = 0; t < pos.count; t += 3) {
          const cy = (pos.getY(t) + pos.getY(t + 1) + pos.getY(t + 2)) / 3;
          if (cy > H * base) keep.push(t);
        }
        const g = new THREE.BufferGeometry();
        for (const [name, a] of Object.entries(g0.attributes)) {
          const sz = a.itemSize, arr = new Float32Array(keep.length * 3 * sz);
          keep.forEach((t, j) => { for (let q = 0; q < 3; q++) for (let c = 0; c < sz; c++) arr[(j * 3 + q) * sz + c] = a.getComponent(t + q, c); });
          // (the tree's baked AO is for a crown many metres deep: a bush's leaves see far more sky)
          if (name === 'color') for (let i = 0; i < arr.length; i += sz) arr[i] = 0.72 + 0.28 * arr[i];
          g.setAttribute(name, new THREE.BufferAttribute(arr, sz));
        }
        g.computeBoundingBox();
        const bb = g.boundingBox!;
        g.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
        const ww = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z), hh = bb.max.y - bb.min.y;
        g.scale(w / ww, h / hh, w / ww);
        // (round 16: the crown's normals point out from the TREE's centre, so a squashed crown kept its underside's
        // down-facing leaves as a dark smudge: a bush gets its own dome normals, out from a point low in the mound,
        // as the crowns' own cards are bent toward the outside of their clump)
        const P = g.getAttribute('position'), Nn = g.getAttribute('normal');
        if (Nn) for (let i = 0; i < P.count; i++) {
          const nx = P.getX(i) / w, ny = (P.getY(i) - h * 0.3) / h, nz = P.getZ(i) / w;
          const L = Math.hypot(nx, ny, nz) || 1;
          // (a little of the card's own normal kept, so the dome is not one smooth gradient)
          const ox = Nn.getX(i), oy = Nn.getY(i), oz = Nn.getZ(i);
          const mx = nx / L * 0.8 + ox * 0.2, my = ny / L * 0.8 + oy * 0.2 + 0.15, mz = nz / L * 0.8 + oz * 0.2;
          const M = Math.hypot(mx, my, mz) || 1;
          Nn.setXYZ(i, mx / M, my / M, mz / M);
        }
        v.lods[0].push({ geometry: g, mat: p.mat, src: p.src, override: p.override });
      }
      return v;
    };
    // juniper mounds from the young pine's crown, and round leafy bushes from the oak's (the RDR2 meadow brush)
    // (near: from the trees' LOD1 crowns; past 30 m from their LOD2, a fraction of the triangles)
    const kinds = [[mound(pine, 0.28, 2, 1), mound(pine, 0.28, 2, 1, 2)], [mound(oak, 0.3, 2.2, 1.5), mound(oak, 0.3, 2.2, 1.5, 2)]];
    let tri = 0;
    for (const k of kinds) for (const v of k) for (const p of v.lods[0]) tri += p.geometry.getAttribute('position').count / 3;
    console.info(`[valley] shrub LOD triangles (juniper near/far, bush near/far) total ${tri}`, kinds.map((k) => k.map((v) => v.lods[0].reduce((a, p) => a + p.geometry.getAttribute('position').count / 3, 0))).flat().join('/'));
    // (shadows only near: thousands of shrubs in the far cascades cost more than they show)
    const sps = kinds.map(([n, f]) => this.veg.speciesOf({ ...n, lods: [n.lods[0], f.lods[0]] }, [30, 130], [false, false], { sway: 0.03, height: 1.5 }, { maxScale: 2 }));
    const lists: number[][] = [[], []];
    const rng = new Rng(9090);
    const nz = new Noise2(55);
    for (let x = -HALF_WORLD + 10; x < HALF_WORLD - 10; x += 10) for (let z = -HALF_WORLD + 10; z < HALF_WORLD - 10; z += 10) {
      const px = x + (rng.next() - 0.5) * 9, pz = z + (rng.next() - 0.5) * 9;
      const m = this.mask(px, pz);
      const edge = m.forest > 0.05 && m.forest < 0.5 ? 0.4 : 0;
      const open = (m.grass + m.gold) * 0.13 * (0.4 + 0.8 * Math.max(0, nz.simplex(px / 60, pz / 60)));
      // (low rocky hills get brush in the hollows too, so they read as hillside, not a bald dome)
      const hill = m.rock > 0.15 && this.hf.height(px, pz) < 260 ? 0.12 : 0;
      if (rng.next() > Math.max(edge, open, hill)) continue;
      const k = 2 + rng.int(4);
      const leafy = rng.next() < 0.6 ? 1 : 0;
      for (let j = 0; j < k; j++) {
        const qx = px + (rng.next() - 0.5) * 6, qz = pz + (rng.next() - 0.5) * 6;
        const q = this.mask(qx, qz);
        if (q.water > 0.03 || q.dirt > 0.25 || q.rock > 0.75 || q.snow > 0.1 || this.trailDist(qx, qz) < 3.5 || this.nearSite(qx, qz, 5)) continue;
        if (this.hf.shoreDist(qx, qz) < 3 || this.slope(qx, qz) > 0.42) continue;
        const kk = j === 0 ? leafy : rng.next() < 0.75 ? leafy : 1 - leafy;
        lists[kk].push(qx, this.hf.height(qx, qz) - 0.15, qz, rng.next() * Math.PI * 2, 0.55 + rng.next() * 0.95, rng.next());
      }
    }
    sps.forEach((sp, i) => this.veg.place(sp, lists[i]));
    this.counts.shrubs = lists[0].length / 6;
    this.counts.bushes = lists[1].length / 6;
  }

  // ---------------------------------------------------------------- undergrowth
  /**
   * Ferns (Poly Haven fern_02 a..d) over the forest floor in drifts and along the stands' edges, so the pines stand in
   * undergrowth, not on a lawn; a few out at the meadows' wooded margins.
   */
  private async loadUnder() {
    const vs = await Promise.all(['a', 'b', 'c', 'd'].map(async (k) => {
      const parts = await this.loadModel(`assets/plants/fern_02_${k}.glb`);
      const box = new THREE.Box3();
      for (const p of parts) { p.geometry.computeBoundingBox(); box.union(p.geometry.boundingBox!); }
      const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
      const H = box.max.y - box.min.y;
      const v: GlbVariant = { name: `fern_${k}`, lods: [[]], height: 1, radius: 1 };
      for (const p of parts) {
        const g = p.geometry;
        g.translate(-cx, -box.min.y, -cz);
        g.scale(1 / H, 1 / H, 1 / H);
        const pos = g.getAttribute('position'), n = pos.count;
        const col = new Float32Array(n * 4);
        let rad = 0;
        for (let i = 0; i < n; i++) {
          const y = pos.getY(i), r = Math.hypot(pos.getX(i), pos.getZ(i));
          rad = Math.max(rad, r);
          // AO darker at the heart, bend with height and reach, fronds flutter
          col[i * 4] = 0.55 + 0.45 * Math.min(1, y * 1.4 + r * 0.6);
          col[i * 4 + 1] = Math.min(1, y + r * 0.5);
          col[i * 4 + 2] = Math.min(1, r * 1.2);
          col[i * 4 + 3] = (r * 7.3) % 1;
        }
        g.setAttribute('color', new THREE.BufferAttribute(col, 4));
        g.setAttribute('wind', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
        v.radius = Math.max(v.radius, rad);
        v.lods[0].push({ geometry: g, mat: p.src.name, src: p.src });
      }
      return v;
    }));
    const look: PlantLook = { sway: 0.08, height: 0.8, translucent: 0.6, tint: [0.62, 0.72, 0.5] };
    const sps = vs.map((v) => this.veg.speciesOf(v, [40], [false], look, { maxScale: 1.3 }));
    const lists = sps.map(() => [] as number[]);
    const rng = new Rng(5150);
    const nz = new Noise2(77);
    const G = 2.4;
    let n = 0;
    for (let x = -HALF_WORLD + 4; x < HALF_WORLD - 4; x += G) for (let z = -HALF_WORLD + 4; z < HALF_WORLD - 4; z += G) {
      const px = x + (rng.next() - 0.5) * G, pz = z + (rng.next() - 0.5) * G;
      const r = rng.next();
      if (r > 0.6) continue;
      const m = this.mask(px, pz);
      // (under the trees only: out on the open ground these broad fronds read as tropical)
      if (m.forest < 0.3) continue;
      const drift = 0.5 + 0.6 * nz.simplex(px / 14, pz / 14);
      const edge = 0.32;
      if (r > edge * drift) continue;
      if (m.water > 0.02 || m.dirt > 0.3 || m.rock > 0.4 || m.snow > 0.05 || this.trailDist(px, pz) < 2.5 || this.nearSite(px, pz, 3)) continue;
      if (this.hf.shoreDist(px, pz) < 2 || this.slope(px, pz) > 0.4) continue;
      const k = rng.int(sps.length);
      lists[k].push(px, this.hf.height(px, pz) - 0.05, pz, rng.next() * Math.PI * 2, 0.35 + rng.next() * 0.4, rng.next());
      n++;
    }
    sps.forEach((sp, i) => this.veg.place(sp, lists[i]));
    this.counts.ferns = n;
  }

  // ---------------------------------------------------------------- rocks, ferns, dead wood
  private async loadModel(url: string) {
    const gltf = await loadGLTF(url);
    gltf.scene.updateMatrixWorld(true);
    const parts: { geometry: THREE.BufferGeometry; src: THREE.MeshStandardMaterial }[] = [];
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const g = toFloatGeometry(mesh.geometry);
      g.applyMatrix4(mesh.matrixWorld);
      parts.push({ geometry: g, src: mesh.material as THREE.MeshStandardMaterial });
    });
    return parts;
  }

  /** one instanced rock-like species: base at y = 0, normalised to a largest dimension of 1 m */
  private async solidSpecies(url: string, maxDist: number, shadowDist: number) {
    const parts = await this.loadModel(url);
    const p = parts[0];
    const g = p.geometry;
    g.computeBoundingBox();
    const b = g.boundingBox!;
    const dim = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
    g.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
    g.scale(1 / dim, 1 / dim, 1 / dim);
    const h = (b.max.y - b.min.y) / dim, r = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / dim / 2;
    const longX = b.max.x - b.min.x >= b.max.z - b.min.z;
    const mat = rockMaterial(p.src);
    const sp = this.veg.rawSpecies(url, [
      { maxDist: shadowDist, geometry: g, material: mat, shadow: true },
      { maxDist, geometry: g, material: mat, shadow: false },
    ], 1, 6);
    return { sp, h, r, longX };
  }

  private async loadRocks() {
    const R = 'assets/rocks/';
    const bigNames = ['boulder_01', 'namaqualand_boulder_05', 'rock_07', 'rock_09'];
    const mossNames = ['rock_moss_01_r01', 'rock_moss_01_r05', 'rock_moss_02_r09', 'rock_moss_02_r13'];
    const [big, moss, stone, logs, stump] = await Promise.all([
      Promise.all(bigNames.map((n) => this.solidSpecies(`${R}${n}.glb`, 800, 110))),
      Promise.all(mossNames.map((n) => this.solidSpecies(`${R}${n}.glb`, 380, 60))),
      this.solidSpecies(`${R}stone_01.glb`, 160, 40),
      Promise.all(['dead_tree_trunk', 'dead_tree_trunk_02'].map((n) => this.solidSpecies(`assets/plants/${n}.glb`, 260, 70))),
      this.solidSpecies('assets/plants/tree_stump_01.glb', 200, 50),
    ]);
    const rng = new Rng(777);
    let jl = 0;
    const L = new Map<Species, number[]>();
    const put = (s: { sp: Species; h: number; r: number }, x: number, z: number, size: number, sink: number, collide: boolean, yaw = rng.next() * Math.PI * 2) => {
      const y = this.minGround(x, z, s.r * size * 0.7) - sink * s.h * size;
      (L.get(s.sp) ?? L.set(s.sp, []).get(s.sp)!).push(x, y, z, yaw, size, rng.next());
      if (collide && size * s.r > 0.5) this.colliders.circle(x, z, s.r * size * 0.85);
      this.counts.rocks = (this.counts.rocks ?? 0) + 1;
    };
    // boulders on the rocky hills and the slopes under the mountains; mossy rocks in the forest; rare erratics on
    // the meadows
    for (let x = -HALF_WORLD + 10; x < HALF_WORLD - 10; x += 14) for (let z = -HALF_WORLD + 10; z < HALF_WORLD - 10; z += 14) {
      const px = x + (rng.next() - 0.5) * 13, pz = z + (rng.next() - 0.5) * 13;
      const m = this.mask(px, pz);
      if (m.water > 0.05 || m.dirt > 0.35 || this.nearSite(px, pz, 4) || this.trailDist(px, pz) < 5.5) continue;
      const shore = this.hf.shoreDist(px, pz);
      if (shore < 2) continue;
      const r = rng.next();
      if (m.rock > 0.35 && r < 0.16 * m.rock) put(big[rng.int(big.length)], px, pz, 2.5 + rng.next() * 5, 0.3, true);
      else if (m.forest > 0.5 && r < 0.05) put(moss[rng.int(moss.length)], px, pz, 1.2 + rng.next() * 2.2, 0.22, true);
      else if (m.forest > 0.5 && r < 0.075) put(logs[rng.int(2)], px, pz, 5 + rng.next() * 4, 0.12, false);
      else if (m.forest > 0.4 && r < 0.09) put(stump, px, pz, 0.9 + rng.next() * 0.5, 0.05, false);
      else if (m.grass + m.gold > 0.6 && r < 0.006) put(big[rng.int(big.length)], px, pz, 2 + rng.next() * 3, 0.35, true);
    }
    // the river banks: stones and mossy rocks along the water's edge (not on the fords, where the horse crosses)
    const riv = this.hf.river;
    for (let i = 0; i < riv.length; i++) {
      const a = riv[i], b = riv[Math.min(riv.length - 1, i + 1)];
      const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
      for (const side of [-1, 1]) {
        if (rng.next() > 0.55) continue;
        const off = a.w / 2 + 0.5 + rng.next() * 3;
        const px = a.x + (-dz / l) * off * side, pz = a.z + (dx / l) * off * side;
        if (this.nearSite(px, pz, 2) || this.nearFord(px, pz, 18)) continue;
        if (this.hf.shoreDist(px, pz) < 0.3) continue;
        if (rng.next() < 0.55) put(stone, px, pz, 0.5 + rng.next() * 0.8, 0.25, false);
        else put(moss[rng.int(moss.length)], px, pz, 0.9 + rng.next() * 1.6, 0.3, true);
      }
    }
    // boulders round the falls pool
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * Math.PI * 2 + rng.next() * 0.3, r = POOL.r + 2 + rng.next() * 6;
      put(big[rng.int(big.length)], POOL.p[0] + Math.cos(a) * r, POOL.p[1] + Math.sin(a) * r, 2.5 + rng.next() * 3, 0.35, true);
    }
    // the camp's fire ring: stones round the fire
    const camp = site('camp');
    const fx = camp.p[0] + FIRE_AT[0], fz = camp.p[1] + FIRE_AT[1];
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * Math.PI * 2;
      put(stone, fx + Math.cos(a) * 0.95, fz + Math.sin(a) * 0.95, 0.42 + rng.next() * 0.1, 0.3, false);
    }
    this.colliders.circle(fx, fz, 1.6);
    // seats: two logs by the fire
    for (const [a, len] of [[0.4, 3.2], [2.6, 2.8]] as const) {
      const lx = fx + Math.cos(a) * 3.0, lz = fz + Math.sin(a) * 3.0;
      put(logs[0], lx, lz, len, 0.1, true);
    }
    // NEXT4 §6: fallen logs across the trails to jump, on the straight, gentle, open stretches (none at a site, a ford,
    // a bend or under the trees, where a rider could not see one coming)
    const step = 9;
    let since = 60;
    for (const path of PATHS) for (let i = 0; i + 1 < path.length; i++) {
      const [x0, z0] = path[i], [x1, z1] = path[i + 1];
      const len = Math.hypot(x1 - x0, z1 - z0), tx = (x1 - x0) / len, tz = (z1 - z0) / len;
      for (let d = 20; d < len - 20; d += step) {
        since += step;
        if (since < 150) continue;
        const px = x0 + tx * d, pz = z0 + tz * d;
        const m = this.mask(px, pz);
        if (this.nearSite(px, pz, 25) || this.nearFord(px, pz, 40) || m.water > 0.01 || m.forest > 0.4 || m.rock > 0.3) continue;
        const g0 = this.hf.height(px - tx * 8, pz - tz * 8), g1 = this.hf.height(px + tx * 8, pz + tz * 8);
        if (Math.abs(g1 - g0) / 16 > 0.09 || this.slope(px, pz) > 0.12) continue;
        // across the trail: the log's long axis along (-tz, tx), a little off square
        const sk = (rng.next() - 0.5) * 0.35, ax = -tz * Math.cos(sk) - tx * Math.sin(sk), az = tx * Math.cos(sk) - tz * Math.sin(sk);
        const r = 0.24 + rng.next() * 0.06, half = 3.2 + rng.next() * 1.2;
        this.jumpLogs.push({ x: px, z: pz, ax, az, half, r, top: r * 1.85 });
        jl++;
        since = 0;
      }
    }
    console.info(`[valley] ${this.jumpLogs.length} jump logs across the trails`);
    void jl;
    await this.buildLogs();
    for (const [sp, list] of L) this.veg.place(sp, list);
  }

  /** the jump logs: barked trunks lying across the trails, tapered, a broken stub or two, sunk a little into the dirt */
  private async buildLogs() {
    const tl = new THREE.TextureLoader();
    const ld = (n: string, srgb: boolean) => tl.loadAsync(`assets/trees/textures/${n}.webp`).then((t) => {
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
      return t;
    });
    const [c, n] = await Promise.all([ld('bark_pine_c', true), ld('bark_pine_n', false)]);
    const mat = sunLit(new THREE.MeshStandardNodeMaterial({ map: c, normalMap: n, roughness: 0.92, color: new THREE.Color(0.62, 0.56, 0.5) }));
    const capMat = sunLit(new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(0.32, 0.24, 0.16), roughness: 0.95 }));
    const rng = new Rng(99);
    for (const L of this.jumpLogs) {
      const len = L.half * 2;
      // a cylinder along x: the trunk end thicker; the bark's u around it, v along it (~1 m a repeat)
      const g = new THREE.CylinderGeometry(L.r * 0.82, L.r, len, 18, 6, false);
      const uvA = g.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uvA.count; i++) uvA.setXY(i, uvA.getX(i) * 2 * Math.PI * L.r, uvA.getY(i) * len);
      // a little irregular: bulges and a slight bow
      const P = g.getAttribute('position') as THREE.BufferAttribute;
      const ph = rng.next() * 10;
      for (let i = 0; i < P.count; i++) {
        const y = P.getY(i), x = P.getX(i), z = P.getZ(i);
        const k = 1 + 0.06 * Math.sin(y * 2.3 + ph) + 0.04 * Math.sin(Math.atan2(z, x) * 3 + y);
        P.setXYZ(i, x * k, y, z * k + 0.05 * Math.sin((y / len) * Math.PI));
      }
      g.computeVertexNormals();
      g.rotateZ(Math.PI / 2);
      const m = new THREE.Mesh(g, [mat, capMat, capMat]);
      // lying along its axis, following the ground under both ends, sunk ~15% of its girth
      const e0 = this.hf.height(L.x - L.ax * L.half, L.z - L.az * L.half), e1 = this.hf.height(L.x + L.ax * L.half, L.z + L.az * L.half);
      const yc = Math.max((e0 + e1) / 2, this.hf.height(L.x, L.z)) + L.r * 0.72;
      m.position.set(L.x, yc, L.z);
      m.rotation.set(0, Math.atan2(-L.az, L.ax), Math.atan2(e1 - e0, len), 'YZX');
      m.castShadow = m.receiveShadow = true;
      this.group.add(m);
      L.top = yc + L.r - this.hf.height(L.x, L.z);
    }
  }

  private nearFord(x: number, z: number, r: number) {
    for (const f of [[-74, -420], [38, -20], [196, 318]]) if (Math.hypot(x - f[0], z - f[1]) < r) return true;
    void RIVER;
    return false;
  }

  // ---------------------------------------------------------------- landmarks
  private async loadLandmarks() {
    const names = new Set<PieceKind>();
    for (const list of Object.values(LANDMARKS)) for (const p of list) names.add(p.m);
    const models = new Map<PieceKind, THREE.Object3D>();
    for (const n of names) {
      const scene = placeholderPiece(n);
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = mesh.receiveShadow = true;
        const m = mesh.material as THREE.MeshStandardMaterial;
        for (const t of [m.map, m.normalMap, m.roughnessMap]) if (t) t.anisotropy = 8;
        mesh.material = weathered(m);
      });
      models.set(n, scene);
    }
    for (const [sname, list] of Object.entries(LANDMARKS)) {
      const s = site(sname);
      const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
      let top = 0;
      for (const p of list) {
        const src = models.get(p.m)!;
        const obj = src.clone(true);
        const box0 = new THREE.Box3().setFromObject(src);
        const dim = box0.getSize(new THREE.Vector3());
        const k = p.size / Math.max(dim.x, dim.y, dim.z);
        obj.scale.setScalar(k);
        const yaw = s.yaw + p.yaw;
        obj.rotation.y = yaw;
        // site frame -> world (the site's yaw turns the whole layout)
        const wx = s.p[0] + p.at[0] * c + p.at[1] * sn, wz = s.p[1] - p.at[0] * sn + p.at[1] * c;
        obj.position.set(wx, 0, wz);
        obj.updateMatrixWorld(true);
        // seat by the real bounding box on the lowest ground under the footprint
        const wb = new THREE.Box3().setFromObject(obj);
        const foot = Math.max(wb.max.x - wb.min.x, wb.max.z - wb.min.z) / 2;
        const h = wb.max.y - wb.min.y;
        let g = this.hf.height(wx, wz);
        for (let a = 0; a < 8; a++) for (const f of [0.45, 0.9]) g = Math.min(g, this.hf.height(wx + Math.cos(a * 0.785) * foot * f, wz + Math.sin(a * 0.785) * foot * f));
        obj.position.y = g - p.sink * h - wb.min.y;
        obj.updateMatrixWorld(true);
        this.group.add(obj);
        top = Math.max(top, h);
        // (round 16) colliders from the mesh itself, not its bounding box: walkable where its top is a step up (the
        // floor slabs, the low rubble, the fallen columns' backs), solid where it stands taller, open under the arches
        let grid = meshGrid(obj, 0.3);
        // (the ruins' paved floor stood as a platform 0.9-1.3 m proud of the ground, a wall to a horse: seated so its
        // slabs sit a step up, a floor to ride across)
        if (grid && p.m === 'floor') {
          const tops: number[] = [];
          for (let j = 0; j < grid.nz; j++) for (let i = 0; i < grid.nx; i++) {
            const t = grid.top[j * grid.nx + i];
            if (t > -1e9) tops.push(t - this.hf.height(grid.x0 + (i + 0.5) * grid.cell, grid.z0 + (j + 0.5) * grid.cell));
          }
          tops.sort((a, b) => a - b);
          obj.position.y -= tops[Math.floor(tops.length * 0.9)] - 0.45;
          obj.updateMatrixWorld(true);
          grid = meshGrid(obj, 0.3);
        }
        if (grid) this.colliders.heightGrid(grid, 'stone');
        if (grid && params.test) {
          // (test runs: how high each piece's top stands over the terrain, to check its seating)
          const tops: number[] = [];
          for (let j = 0; j < grid.nz; j++) for (let i = 0; i < grid.nx; i++) {
            const t = grid.top[j * grid.nx + i];
            if (t > -1e9) tops.push(t - this.hf.height(grid.x0 + (i + 0.5) * grid.cell, grid.z0 + (j + 0.5) * grid.cell));
          }
          tops.sort((a, b) => a - b);
          const q = (f: number) => tops[Math.floor(f * (tops.length - 1))]?.toFixed(2);
          console.info(`[collide] ${sname}/${p.m}: ${grid.nx}x${grid.nz} cells, top over terrain p10 ${q(0.1)} p50 ${q(0.5)} p90 ${q(0.9)} m`);
        }
        this.counts.props = (this.counts.props ?? 0) + 1;
      }
      this.landmarks.push({ name: sname, x: s.p[0], z: s.p[1], y: this.hf.height(s.p[0], s.p[1]), r: s.r });
    }
    const falls = site('falls');
    this.landmarks.push({ name: 'falls', x: falls.p[0], z: falls.p[1], y: this.hf.height(falls.p[0], falls.p[1]), r: 10 });
  }

  // ---------------------------------------------------------------- campfire
  private makeFire() {
    const camp = site('camp');
    const fx = camp.p[0] + FIRE_AT[0], fz = camp.p[1] + FIRE_AT[1];
    const fy = this.hf.height(fx, fz);
    this.firePos.set(fx, fy, fz);
    const t = valleyU.time;
    // flames: three crossed cards, noise scrolled upward through a tapered flame shape
    const fm = new THREE.MeshBasicNodeMaterial();
    fm.transparent = true;
    fm.depthWrite = false;
    fm.blending = THREE.AdditiveBlending;
    fm.side = THREE.DoubleSide;
    fm.fog = true;
    const u = uv();
    const n1 = mx_noise_float(vec3(u.x.mul(3.2), u.y.mul(2.4).sub(t.mul(2.6)), 1.7));
    const n2 = mx_noise_float(vec3(u.x.mul(7.0), u.y.mul(5.0).sub(t.mul(4.1)), 5.3));
    const wob = n1.mul(0.16).add(n2.mul(0.06));
    const xw = abs(u.x.sub(0.5).add(wob.mul(u.y))).mul(2);
    const width = float(1).sub(u.y).pow(0.7).mul(0.85).add(0.05);
    const body = float(1).sub(smoothstep(width.mul(0.35), width, xw)).mul(smoothstep(0.0, 0.08, u.y));
    const tongue = smoothstep(0.15, 0.7, n1.mul(0.5).add(0.5).add(float(0.55).sub(u.y)));
    const a = clamp(body.mul(tongue), 0, 1);
    const hot = vec3(4.0, 2.4, 0.9), cool = vec3(2.2, 0.55, 0.08);
    const col = mix(cool, hot, smoothstep(0.35, 0.9, a).mul(float(1).sub(u.y.mul(0.6))));
    fm.colorNode = vec4(col.mul(a).mul(valleyU.fire), 1);
    // (effects write the world's up to the AO normal target, or every card would show as a box: core/fx.ts)
    fm.mrtNode = effectMRT();
    const flame = new THREE.Group();
    const pg = new THREE.PlaneGeometry(1.1, 1.7);
    pg.translate(0, 0.85, 0);
    for (let k = 0; k < 3; k++) {
      const m = new THREE.Mesh(pg, fm);
      m.rotation.y = (k / 3) * Math.PI;
      m.renderOrder = 10;
      flame.add(m);
    }
    flame.position.set(fx, fy + 0.15, fz);
    this.group.add(flame);
    // the firewood: a few charred logs leaned together
    const wood = new THREE.MeshStandardNodeMaterial({ color: 0x1a120c, roughness: 0.95 });
    wood.emissiveNode = vec3(0.9, 0.22, 0.03).mul(float(1).sub(smoothstep(0.0, 0.35, uv().y.sub(0.5).abs())).mul(mx_noise_float(vec3(uv().mul(9), t.mul(0.6))).mul(0.5).add(0.5))).mul(valleyU.fire).mul(0.6);
    const lg = new THREE.CylinderGeometry(0.07, 0.09, 1.3, 7);
    for (let k = 0; k < 5; k++) {
      const m = new THREE.Mesh(lg, wood);
      const a2 = (k / 5) * Math.PI * 2;
      m.position.set(fx + Math.cos(a2) * 0.3, fy + 0.3, fz + Math.sin(a2) * 0.3);
      m.lookAt(fx, fy + 1.1, fz);
      m.rotateX(Math.PI / 2);
      m.castShadow = true;
      this.group.add(m);
    }
    // embers: sprites rising from the fire and fading
    const em = new THREE.SpriteNodeMaterial();
    em.transparent = true;
    em.depthWrite = false;
    em.blending = THREE.AdditiveBlending;
    const i = float(instanceIndex);
    const life = mod(t.mul(0.35).add(hash(i.mul(1.31))), 1);
    const ang = hash(i.mul(7.7)).mul(6.283);
    const rise = life.mul(life.mul(1.2).add(2.4));
    const drift = vec3(sin(ang).mul(0.25).add(sin(t.mul(1.7).add(i)).mul(0.15).mul(life)), rise, sin(ang.add(1.57)).mul(0.25).add(sin(t.mul(1.3).add(i.mul(2.1))).mul(0.15).mul(life)));
    em.positionNode = drift;
    em.scaleNode = float(0.045).mul(float(1).sub(life.mul(0.6)));
    const ed = length(uv().sub(0.5)).mul(2);
    const eGlow = float(1).sub(smoothstep(0.2, 1, ed)).mul(float(1).sub(life)).mul(pow(sin(t.mul(9).add(i.mul(3.3))).mul(0.5).add(0.5), 2).mul(0.6).add(0.4));
    em.colorNode = vec4(vec3(3.5, 1.1, 0.2).mul(eGlow).mul(valleyU.fire), 1);
    em.mrtNode = effectMRT();
    const embers = new THREE.Sprite(em);
    embers.count = 48;
    embers.position.set(fx, fy + 0.5, fz);
    embers.frustumCulled = false;
    this.group.add(embers);
    // the light: flickers, brighter as the day goes
    this.fireLight.position.set(fx, fy + 1.2, fz);
    this.fireLight.castShadow = false;
    this.scene.add(this.fireLight);
  }

  // ---------------------------------------------------------------- fireflies
  private makeFlies() {
    const m = new THREE.SpriteNodeMaterial();
    m.transparent = true;
    m.depthWrite = false;
    m.blending = THREE.AdditiveBlending;
    m.mrtNode = effectMRT();
    const t = valleyU.time;
    const i = float(instanceIndex);
    const hx = hash(i.mul(1.7).add(3.1)), hz = hash(i.mul(2.9).add(11.3)), hy = hash(i.mul(5.3).add(7.7));
    // a fixed home per fly in a TILE-metre tile repeated over the world, wrapped to the tile round the camera: they
    // stay put in the world as the rider moves and only ever appear or leave at the faded rim
    const home = vec2(hx, hz).mul(TILE);
    const rel = mod(home.sub(cameraPosition.xz).add(TILE / 2), TILE).sub(TILE / 2);
    const wander = vec2(sin(t.mul(0.31).add(i.mul(1.9))), sin(t.mul(0.27).add(i.mul(3.7)))).mul(1.6);
    const xz = cameraPosition.xz.add(rel).add(wander);
    const uvW = xz.add(HALF_WORLD).div(WORLD_SIZE);
    const ground = texture(this.hf.heightTex, uvW).level(0).r;
    const m0 = texture(this.hf.mask0Tex, uvW).level(0);
    const shore = texture(this.hf.shoreTex, uvW).level(0).r;
    const y = ground.add(hy.mul(2.4).add(0.5)).add(sin(t.mul(0.7).add(i)).mul(0.35));
    m.positionNode = Fn(() => vec3(xz.x, y, xz.y))();
    m.scaleNode = float(0.09);
    // where: the meadows and forest edges, thicker near the water; fading at the tile's rim
    const where = m0.y.add(m0.x.mul(0.6)).mul(float(1).sub(m0.z)).mul(smoothstep(1.0, 3.0, shore)).mul(mix(float(1.6), float(0.7), smoothstep(10, 60, shore)));
    const rim = float(1).sub(smoothstep(TILE / 2 - 10, TILE / 2, length(rel)));
    const blink = pow(sin(t.mul(hash(i.mul(9.1)).mul(1.4).add(0.6)).add(i.mul(17))).mul(0.5).add(0.5), 6);
    const d = length(uv().sub(0.5)).mul(2);
    const glow = float(1).sub(smoothstep(0, 1, d)).pow(2.2);
    m.colorNode = vec4(vec3(2.6, 3.2, 0.7).mul(glow).mul(blink).mul(where.clamp(0, 1)).mul(rim).mul(valleyU.flies), 1);
    const s = new THREE.Sprite(m);
    s.count = FLIES;
    s.frustumCulled = false;
    s.visible = false;
    this.flies = s;
    this.group.add(s);
  }

  update(camera: THREE.PerspectiveCamera, dt: number, t: number, night: number, hour = 12) {
    valleyU.time.value = t;
    this.grass.update(camera, t);
    this.veg.update(camera, 60);
    // fireflies: from the last light of dusk through the night's first hours, again a little before dawn
    const dusk = THREE.MathUtils.smoothstep(hour, 18.7, 19.6) * (1 - THREE.MathUtils.smoothstep(hour, 22.5, 23.5));
    const dawn = THREE.MathUtils.smoothstep(hour, 4.0, 4.5) * (1 - THREE.MathUtils.smoothstep(hour, 5.4, 5.9)) * 0.5;
    const ff = Math.max(dusk, dawn);
    valleyU.flies.value = ff;
    if (this.flies) this.flies.visible = ff > 0.01;
    // the fire: always burning; its light flickers and only matters once the sun is low
    const fl = 0.82 + 0.1 * Math.sin(t * 13.1) + 0.06 * Math.sin(t * 7.3 + 1) + 0.04 * Math.sin(t * 23.7);
    // (faded out far off, never hidden: toggling a light changes the light set, and every material lit by all lights
    // (terrain, sky, horse) rebuilds its pipelines; with async compiles those draws drop out for a frame or two and
    // the ground flashed the clear colour. NEXT4 §8, the "blue flash")
    const far = 1 - THREE.MathUtils.smoothstep(camera.position.distanceTo(this.firePos), 180, 230);
    this.fireLight.intensity = (25 + 150 * night) * fl * far;
    void dt;
  }
}

/**
 * Weathered stone for the landmark pieces, so they sit in the valley's light rather than glow against it: the
 * albedo desaturated by a third and cooled a touch toward the granite, never metal, and rough (at least 0.86).
 */
function weathered(m: THREE.MeshStandardMaterial) {
  const nm = new THREE.MeshStandardNodeMaterial({ name: `${m.name}-weathered` });
  nm.map = m.map; nm.normalMap = m.normalMap; nm.normalScale.copy(m.normalScale); nm.aoMap = m.aoMap; nm.side = m.side;
  const base: N = m.map ? texture(m.map).rgb.mul(vec3(m.color.r, m.color.g, m.color.b)) : vec3(m.color.r, m.color.g, m.color.b);
  const l = base.dot(vec3(0.3, 0.59, 0.11));
  nm.colorNode = vec4(mix(vec3(l), base, 0.62).mul(vec3(0.94, 0.97, 1.03)).mul(0.92), 1);
  nm.roughnessNode = m.roughnessMap ? max(texture(m.roughnessMap).g.mul(m.roughness), 0.86) : max(float(m.roughness), 0.9);
  nm.metalnessNode = float(0);
  return sunLit(nm);
}

export type { N };
