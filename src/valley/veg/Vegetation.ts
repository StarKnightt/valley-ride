/**
 * Vegetation: species (several grown variants each) scattered from the baked masks, drawn as instanced meshes per
 * species / LOD / part. Every few frames the visible instances are chosen on the CPU from a 32 m grid: frustum and
 * distance culling, LOD by distance; near instances are always kept so they cast shadows into view. Wind bends trunks
 * and branches from the root and flutters leaves, in world space for every instance alike.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, attribute, cos, float, mix, normalize, positionLocal, sin, texture, uv, vec2, vec3, vec4, uniform, cameraPosition,
  positionWorld, length, smoothstep, max, dot, normalWorld, positionViewDirection, pow, clamp, hash, instanceIndex, type N,
} from '../core/tsl';
import { HALF_WORLD } from '../world/layout';
import { Rng, Noise2 } from '../core/noise';
import type { Heightfield } from '../world/Heightfield';
import { sunLit } from '../core/lighting';
import { SHARED_INSTANCES, shareInstancing } from '../core/instancing';

/**
 * A rock to scatter: its mesh (base at the ground line), a low-poly copy for the distance (else one is made), radius
 * in plan; `big` boulders also go on cliff coasts; `sink` scales how deep it is set into the ground (helper pieces
 * already carry their buried part below y = 0).
 */
/** the layer of the shadow-casting vegetation LODs (sky/SunShadow.ts enables it on the near cascades only) */
export const VEG_SHADOW_LAYER = 3;
export interface RockModel { geometry: THREE.BufferGeometry; far?: THREE.BufferGeometry; material: THREE.Material; radius: number; big: boolean; sink?: number }
import { grassClump, type PartGeo } from './geometry';
import { wetness } from '../world/weatherUniforms';
import { loadKTX2, configureTex } from '../core/Assets';
import { atmo } from '../sky/Atmosphere';
import { cloudShadow } from '../sky/Sky';
import { Q } from '../core/quality';
import type { Colliders } from '../world/Colliders';
import { glbU, loadVariants, plantMaterial, crownProxy, crownMaterial, type GlbVariant, type PlantLook } from './glb';

const CELL = 32;

export const vegU = glbU;
void uniform;

interface Lod { maxDist: number; parts: PartGeo[]; shadow: boolean }
export interface Species {
  name: string;
  lods: Lod[];
  /** x, y, z, yaw, scale, phase */
  inst: Float32Array;
  count: number;
  cells: Map<number, number[]>;
  meshes: { lod: number; mesh: THREE.InstancedMesh; data: THREE.InstancedBufferAttribute }[][];
  radius: number;
  /** how far an instance may reach out of its 32 m cell (scaled instances reach further than `radius`) */
  pad: number;
  /** lie on the slope (flat ground covers such as leaf litter) instead of standing upright */
  tilt?: boolean;
  /** draws only out to `reach` of its range while the camera is under the canopy (the green haze hides the rest) */
  shrink?: boolean;
}

// ---------------------------------------------------------------- materials
const placeholder = (c: [number, number, number, number]) => {
  const t = new THREE.DataTexture(new Uint8Array([c[0] * 255, c[1] * 255, c[2] * 255, c[3] * 255]), 1, 1);
  t.needsUpdate = true;
  return t;
};

function windOffset(height: N) {
  // per-instance data: yaw, phase
  const iData = attribute('iData', 'vec4');
  const yaw = iData.x, phase = iData.y;
  const w = attribute('wind', 'vec3');
  const t = vegU.time;
  // world wind into the instance's local frame
  const wd = wetness.windDir;
  const c = cos(yaw.negate()), s = sin(yaw.negate());
  const lw = vec2(wd.x.mul(c).add(wd.y.mul(s)), wd.x.mul(s).negate().add(wd.y.mul(c)));
  const strength = wetness.wind.mul(0.8).add(0.12);
  const gust = sin(t.mul(0.35).add(phase.mul(6.28)).add(positionWorld.x.mul(0.01))).mul(0.5).add(0.5);
  const sway = sin(t.mul(1.1).add(phase.mul(12.0)).add(w.z.mul(6.0))).mul(0.5).add(gust.mul(0.8));
  const bend = w.x.mul(strength).mul(sway).mul(height.mul(0.022));
  const flutterA = sin(t.mul(6.3).add(phase.mul(40)).add(positionLocal.x.mul(2.1)).add(positionLocal.z.mul(1.7)).add(w.z.mul(20)));
  const flutter = w.y.mul(strength).mul(flutterA).mul(0.045);
  return vec3(lw.x.mul(bend).add(flutter.mul(0.3)), flutter.mul(0.8).sub(bend.mul(0.12).mul(w.x)), lw.y.mul(bend).add(flutter.mul(0.3)));
}

interface MatSet { [k: string]: THREE.MeshStandardNodeMaterial }

function makeMaterials(): { mats: MatSet; texNodes: Record<string, N[]> } {
  const texNodes: Record<string, N[]> = {};
  const tex = (key: string, ph: THREE.Texture, uvN: N) => {
    const n = texture(ph, uvN);
    (texNodes[key] ??= []).push(n);
    return n;
  };
  const vcol = attribute('color', 'vec3');
  const mk = (name: string, opts: { alpha?: boolean; key?: string; nkey?: string; tint?: [number, number, number]; rough: number; height: number; flat?: [number, number, number]; translucent?: number }) => {
    const m = sunLit(new THREE.MeshStandardNodeMaterial());
    m.name = `veg_${name}`;
    let col: N;
    let alpha: N = float(1);
    if (opts.key) {
      const t = tex(opts.key, placeholder([0.2, 0.35, 0.1, 1]), uv());
      col = t.rgb;
      alpha = t.a;
    } else col = vec3(...(opts.flat ?? [0.3, 0.25, 0.2]));
    // per-instance tint variation
    const iData = attribute('iData', 'vec4');
    const vary = hash(iData.y.mul(1000)).sub(0.5);
    col = col.mul(vec3(float(1).add(vary.mul(0.12)), float(1).add(vary.mul(0.06)), float(1).sub(vary.mul(0.08))));
    if (opts.tint) col = col.mul(vec3(...opts.tint));
    const ao = vcol.r;
    // wet: darker, glossier
    col = col.mul(mix(float(1), float(0.7), wetness.rain));
    const cloud = cloudShadow(positionWorld);
    m.colorNode = vec4(col.mul(ao.mul(0.85).add(0.15)), alpha);
    // wet leaves turn glossy; wet bark only a little
    m.roughnessNode = mix(float(opts.rough), float(Math.min(opts.rough, opts.alpha ? 0.3 : 0.55)), wetness.rain);
    m.metalnessNode = float(0);
    if (opts.nkey) {
      const nt = tex(opts.nkey, placeholder([0.5, 0.5, 1, 1]), uv());
      m.normalNode = undefined as never;
      void nt;
    }
    if (opts.alpha) {
      m.alphaTest = 0.42;
      m.side = THREE.DoubleSide;
      m.alphaToCoverage = Q.msaa > 1;
    }
    // light through the leaves when the sun is behind them
    if (opts.translucent) {
      const sunDir = normalize(atmo.sunDir);
      const back = pow(clamp(dot(positionViewDirection.negate(), sunDir.negate()).negate(), 0, 1), 3);
      const facing = clamp(dot(normalWorld, sunDir).negate().add(0.6), 0, 1);
      m.emissiveNode = col.mul(vec3(vegU.sunColor)).mul(back.mul(facing).mul(opts.translucent * 0.07)).mul(cloud).mul(ao);
    }
    const height = float(opts.height);
    m.positionNode = Fn(() => positionLocal.add(windOffset(height)))();
    return m;
  };
  const mats: MatSet = {
    palmbark: mk('palmbark', { key: 'palm_bark', rough: 0.88, height: 12 }),
    frond: mk('frond', { alpha: true, key: 'palm_frond', rough: 0.55, height: 12, translucent: 0.35 }),
    nut: mk('nut', { flat: [0.32, 0.26, 0.12], rough: 0.5, height: 12 }),
    bark: mk('bark', { key: 'bark', rough: 0.88, height: 22, tint: [1.1, 1.05, 1.0] }),
    leaf: mk('leaf', { alpha: true, key: 'canopy', rough: 0.45, height: 22, translucent: 0.3 }),
    banana: mk('banana', { alpha: true, key: 'banana_leaf', rough: 0.5, height: 3, translucent: 0.4 }),
    grass: mk('grass', { alpha: true, key: 'grass', rough: 0.7, height: 1, translucent: 0.25 }),
    bushleaf: mk('bushleaf', { alpha: true, key: 'canopy', rough: 0.5, height: 2, translucent: 0.3 }),
  };
  void vec2; void cameraPosition; void length; void smoothstep; void max; void instanceIndex;
  return { mats, texNodes };
}

// ---------------------------------------------------------------- the system
export class Vegetation {
  readonly group = new THREE.Group();
  private species: Species[] = [];
  private mats: MatSet;
  private texNodes: Record<string, N[]>;
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  private lastCam = new THREE.Vector3(1e9, 0, 0);
  private lastDir = new THREE.Vector3();
  private frame = 0;
  private tmpP = new THREE.Vector3();
  private tmpUp = new THREE.Vector3();
  private tmpAx = new THREE.Vector3();
  private tmpAz = new THREE.Vector3();
  private sphere = new THREE.Sphere();
  private box = new THREE.Box3();
  visible = 0;

  constructor(private hf: Heightfield, private colliders: Colliders) {
    const { mats, texNodes } = makeMaterials();
    this.mats = mats;
    this.texNodes = texNodes;
    this.group.name = 'vegetation';
  }

  /** stream the foliage textures and swap them in */
  async loadTextures() {
    const files: Record<string, [string, boolean]> = {
      grass: ['assets/foliage/grass.ktx2', true],
    };
    await Promise.all(Object.entries(files).map(async ([key, [url, srgb]]) => {
      const t = configureTex(await loadKTX2(url), srgb);
      t.wrapS = t.wrapT = key === 'palm_bark' || key === 'bark' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
      for (const n of this.texNodes[key] ?? []) n.value = t;
    }));
  }

  private addSpecies(name: string, lods: Lod[], radius: number, pad = radius) {
    const sp: Species = { name, lods, inst: new Float32Array(0), count: 0, cells: new Map(), meshes: [], radius, pad };
    this.species.push(sp);
    return sp;
  }

  private setInstances(sp: Species, list: number[]) {
    sp.inst = new Float32Array(list);
    sp.count = list.length / 6;
    for (let i = 0; i < sp.count; i++) {
      const x = sp.inst[i * 6], z = sp.inst[i * 6 + 2];
      const k = this.cellKey(x, z);
      let c = sp.cells.get(k);
      if (!c) sp.cells.set(k, (c = []));
      c.push(i);
    }
    // meshes: per lod, per part, one InstancedMesh sharing one matrix buffer and one data buffer
    for (let l = 0; l < sp.lods.length; l++) {
      const lod = sp.lods[l];
      // (see core/instancing.ts: a smaller instanced mesh gets a vertex shader of its own)
      const cap = Math.max(SHARED_INSTANCES, Math.min(sp.count, this.capacityFor(lod.maxDist, sp.count)));
      // (static usage: the lists are uploaded, by range, only when update() rebuilds them; a dynamic buffer is sent
      // again in full in every render pass of every frame, ~15 MB a frame across the island's instanced meshes)
      const matrix = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
      const data = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      const row: Species['meshes'][number] = [];
      for (const part of lod.parts) {
        const g = new THREE.BufferGeometry();
        for (const [k, a] of Object.entries(part.geometry.attributes)) g.setAttribute(k, a);
        g.setIndex(part.geometry.index);
        g.setAttribute('iData', data);
        const mat = part.material ?? (part.part === 'leaf' && name_isBush(sp.name) ? this.mats.bushleaf : this.mats[part.part]);
        const mesh = new THREE.InstancedMesh(g, mat, cap);
        mesh.instanceMatrix = matrix;
        shareInstancing(mesh);
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.castShadow = lod.shadow;
        // (shadow-casting LODs live within ~40 m, inside the near cascades: their own layer keeps them out of the far
        // cascade's pass, which would draw every instance again for nothing; the main camera and the near cascades see it)
        if (lod.shadow) mesh.layers.set(VEG_SHADOW_LAYER);
        mesh.receiveShadow = true;
        // every instanced mesh sits at the origin, so the renderer cannot sort them near to far: near LODs first, so
        // the far ones are mostly rejected by the depth test before they shade
        mesh.renderOrder = l - 4;
        mesh.name = `${sp.name}_l${l}_${part.part}`;
        this.group.add(mesh);
        row.push({ lod: l, mesh, data });
      }
      sp.meshes.push(row);
    }
  }

  private capacityFor(maxDist: number, total: number) {
    // rough upper bound of instances within the LOD's reach
    return Math.ceil(Math.min(total, total * Math.min(1, (Math.PI * maxDist * maxDist) / 1.6e6) * 3.5 + 64));
  }

  private cellKey(x: number, z: number) {
    return (Math.floor((x + HALF_WORLD) / CELL) << 8) | Math.floor((z + HALF_WORLD) / CELL);
  }

  /** the grass clumps (procedural); the plants come from the helpers' GLBs in buildGlb() */
  /** one species from a helper GLB variant: its LODs at these distances, shadows from the LODs flagged */
  private glbSpecies(v: GlbVariant, dists: number[], shadows: boolean[], look: PlantLook, opts: { maxScale?: number; tilt?: boolean } = {}) {
    const lods: Lod[] = [];
    for (let k = 0; k < dists.length && k < v.lods.length; k++) {
      lods.push({
        maxDist: dists[k],
        shadow: shadows[k] ?? false,
        parts: v.lods[k].map((p) => ({ geometry: p.geometry, part: 'leaf' as const, material: p.override ?? this.matFor(p.src, look) })),
      });
    }
    const reach = Math.max(v.height, v.radius) * (opts.maxScale ?? 1.25);
    const sp = this.addSpecies(v.name, lods, Math.max(v.height, v.radius * 2), reach);
    sp.tilt = opts.tilt;
    return sp;
  }

  private glbMats = new Map<string, THREE.Material>();
  private matFor(src: THREE.MeshStandardMaterial, look: PlantLook) {
    const key = `${src.uuid}:${look.sway}:${look.height}`;
    let m = this.glbMats.get(key);
    if (!m) this.glbMats.set(key, (m = plantMaterial(src, look)));
    return m;
  }

  /**
   * The island's plants, from the helpers' GLBs, in layers: coconut palms leaning out over every beach with young
   * palms and sea-front scrub on the berm; rainforest on the forest mask (emergent dipterocarps and kapoks over a
   * closed canopy of strangler figs and leaning broadleaves, a midstorey between their trunks, tree ferns, bananas,
   * aroids, rattan and fan palms below, ferns and herbs on the ground, leaf litter, logs and surface roots).
   */
  /** a species from a GLB variant (public: the valley scatters its own) */
  speciesOf(v: GlbVariant, dists: number[], shadows: boolean[], look: PlantLook, opts: { maxScale?: number; tilt?: boolean } = {}) {
    return this.glbSpecies(v, dists, shadows, look, opts);
  }

  /** a species from plain geometry + material per LOD (rocks, props) */
  rawSpecies(name: string, lods: { maxDist: number; geometry: THREE.BufferGeometry; material: THREE.Material; shadow: boolean }[], radius: number, pad = radius) {
    const withAttrs = (g: THREE.BufferGeometry) => {
      const n = g.getAttribute('position').count;
      if (!g.getAttribute('wind')) g.setAttribute('wind', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      if (!g.getAttribute('color')) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 4).fill(1), 4));
      return g;
    };
    return this.addSpecies(name, lods.map((l) => ({ maxDist: l.maxDist, shadow: l.shadow, parts: [{ geometry: withAttrs(l.geometry), part: 'rock' as const, material: l.material }] })), radius, pad);
  }

  /** x, y, z, yaw, scale, phase per instance */
  place(sp: Species, list: number[]) {
    this.setInstances(sp, list);
  }

  /** palm trunk colliders etc. are added at scatter time; this returns counts for the harness */
  counts() {
    return Object.fromEntries(this.species.map((s) => [s.name, s.count]));
  }

  /** 0..1: the share of their range that `shrink` species draw (main.ts, from how deep under the canopy the camera is) */
  reach = 1;
  private lastReach = 1;

  update(camera: THREE.PerspectiveCamera, shadowNear: number, force = false) {
    this.frame++;
    const priming = this.prime > 0;
    if (priming) this.prime--;
    const cam = camera.position;
    const dir = this.tmpP;
    camera.getWorldDirection(dir);
    // culled against a frustum 6 degrees wider than the view, so the camera can turn ~3 degrees (or walk 1.2 m)
    // before the lists need rebuilding: fewer instance-buffer uploads while the camera swings
    const moved = cam.distanceTo(this.lastCam) > 1.2 || dir.angleTo(this.lastDir) > 0.05 || this.reach !== this.lastReach;
    this.lastReach = this.reach;
    // the frame after priming re-culls so the collapsed instances go away
    // (nothing in the lists depends on anything but the camera: a periodic re-cull of a still camera only re-uploaded
    // megabytes of identical instances, a 40-80 ms stall every 20th frame whenever the GPU queue was full)
    if (!force && !priming && !moved && !this.unprime) return;
    this.unprime = priming;
    this.lastCam.copy(cam);
    this.lastDir.copy(dir);
    const cc = this.cullCam;
    const camX = camera as unknown as { coordinateSystem: number; _reversedDepth: boolean };
    const ccX = cc as unknown as { coordinateSystem: number; _reversedDepth: boolean };
    if (cc.fov !== camera.fov + 6 || cc.aspect !== camera.aspect || cc.far !== camera.far || ccX.coordinateSystem !== camX.coordinateSystem) {
      cc.fov = camera.fov + 6;
      cc.aspect = camera.aspect;
      cc.near = camera.near;
      cc.far = camera.far;
      ccX.coordinateSystem = camX.coordinateSystem;
      ccX._reversedDepth = camX._reversedDepth;
      cc.updateProjectionMatrix();
    }
    this.pv.multiplyMatrices(cc.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv, THREE.WebGPUCoordinateSystem);
    let vis = 0;
    const counts: number[] = [];
    const cx = cam.x, cy = cam.y, cz = cam.z;
    for (const sp of this.species) {
      // (still loading: a species exists before its instances are placed)
      if (!sp.meshes.length) continue;
      const nL = sp.lods.length;
      const maxD = sp.lods[nL - 1].maxDist * (sp.shrink ? this.reach : 1);
      const maxD2 = maxD * maxD;
      counts.length = nL;
      counts.fill(0);
      const caps = sp.meshes.map((row) => row[0].data.count);
      const mats = sp.meshes.map((row) => row[0].mesh.instanceMatrix.array as Float32Array);
      const datas = sp.meshes.map((row) => row[0].data.array as Float32Array);
      const lim2 = sp.lods.map((l) => l.maxDist * l.maxDist);
      const small = sp.radius < 1.5;
      const ci0 = Math.floor((cx - maxD + HALF_WORLD) / CELL), ci1 = Math.floor((cx + maxD + HALF_WORLD) / CELL);
      const cj0 = Math.floor((cz - maxD + HALF_WORLD) / CELL), cj1 = Math.floor((cz + maxD + HALF_WORLD) / CELL);
      for (let ci = Math.max(0, ci0); ci <= Math.min(63, ci1); ci++) for (let cj = Math.max(0, cj0); cj <= Math.min(63, cj1); cj++) {
        const cell = sp.cells.get((ci << 8) | cj);
        if (!cell) continue;
        const x0 = ci * CELL - HALF_WORLD, z0 = cj * CELL - HALF_WORLD;
        const dx = Math.max(x0 - cx, 0, cx - (x0 + CELL)), dz = Math.max(z0 - cz, 0, cz - (z0 + CELL));
        const cd = Math.hypot(dx, dz);
        if (cd > maxD) continue;
        const nearCell = cd < shadowNear;
        if (!nearCell) {
          this.box.min.set(x0 - sp.pad, -10, z0 - sp.pad);
          this.box.max.set(x0 + CELL + sp.pad, 760, z0 + CELL + sp.pad);
          if (!this.frustum.intersectsBox(this.box)) continue;
        }
        const inst = sp.inst;
        for (let n = 0; n < cell.length; n++) {
          const o = cell[n] * 6;
          const x = inst[o], y = inst[o + 1], z = inst[o + 2];
          const ddx = x - cx, ddy = y - cy, ddz = z - cz;
          const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
          if (d2 > maxD2) continue;
          let l = 0;
          while (l < nL - 1 && d2 > lim2[l]) l++;
          if (!small && (!nearCell || l > 0)) {
            this.sphere.center.set(x, y + sp.radius * 0.5 * inst[o + 4], z);
            this.sphere.radius = sp.radius * inst[o + 4] * 0.9 + 2;
            if (!this.frustum.intersectsSphere(this.sphere)) continue;
          }
          const k = counts[l];
          if (k >= caps[l]) continue;
          counts[l] = k + 1;
          const s = inst[o + 4], yaw = inst[o + 3];
          const c = Math.cos(yaw) * s, sn = Math.sin(yaw) * s;
          const m = mats[l], b = k * 16;
          if (sp.tilt) {
            // the yawed frame tilted onto the ground's slope: y along the terrain normal
            const nrm = this.hf.normal(x, z);
            const up = this.tmpUp.set(nrm.x, nrm.y, nrm.z);
            const ax = this.tmpAx.set(Math.cos(yaw), 0, -Math.sin(yaw));
            const az = this.tmpAz.crossVectors(ax, up).normalize();
            ax.crossVectors(up, az);
            m[b] = ax.x * s; m[b + 1] = ax.y * s; m[b + 2] = ax.z * s; m[b + 3] = 0;
            m[b + 4] = up.x * s; m[b + 5] = up.y * s; m[b + 6] = up.z * s; m[b + 7] = 0;
            m[b + 8] = az.x * s; m[b + 9] = az.y * s; m[b + 10] = az.z * s; m[b + 11] = 0;
          } else {
            m[b] = c; m[b + 1] = 0; m[b + 2] = -sn; m[b + 3] = 0;
            m[b + 4] = 0; m[b + 5] = s; m[b + 6] = 0; m[b + 7] = 0;
            m[b + 8] = sn; m[b + 9] = 0; m[b + 10] = c; m[b + 11] = 0;
          }
          m[b + 12] = x; m[b + 13] = y; m[b + 14] = z; m[b + 15] = 1;
          const da = datas[l], q = k * 4;
          da[q] = yaw;
          da[q + 1] = inst[o + 5];
          da[q + 2] = s;
          da[q + 3] = d2;
        }
      }
      for (let l = 0; l < nL; l++) {
        const row = sp.meshes[l];
        if (!row.length) continue;
        let n = counts[l];
        if (priming && n === 0 && sp.count > 0) {
          // one collapsed instance, so this mesh's pipelines compile now (behind the loading screen) and not with a
          // hitch the first time the species or LOD comes into view
          mats[l].fill(0, 0, 16);
          n = 1;
        }
        const im = row[0].mesh.instanceMatrix;
        im.needsUpdate = true;
        im.clearUpdateRanges();
        im.addUpdateRange(0, n * 16);
        row[0].data.needsUpdate = true;
        row[0].data.clearUpdateRanges();
        row[0].data.addUpdateRange(0, n * 4);
        for (const e of row) {
          e.mesh.count = n;
          e.mesh.visible = n > 0;
        }
        vis += counts[l];
      }
    }
    this.visible = vis;
  }

  /** frames left in which every mesh is drawn (collapsed if empty) so all pipelines compile up front */
  prime = 0;
  private unprime = false;
  private cullCam = new THREE.PerspectiveCamera();
}

function name_isBush(n: string) {
  return n.startsWith('bush');
}

/** a crude low-poly copy for distant draws: vertices merged on a `cell`-metre grid, collapsed triangles dropped */
function clusterSimplify(src: THREE.BufferGeometry, cell: number) {
  const pos = src.getAttribute('position'), uvA = src.getAttribute('uv');
  const ids = new Map<string, number>();
  const sum: number[] = [], cnt: number[] = [], uvs: number[] = [];
  const remap = new Int32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const key = `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = cnt.length;
      ids.set(key, id);
      cnt.push(0);
      sum.push(0, 0, 0);
      uvs.push(uvA ? uvA.getX(i) : 0, uvA ? uvA.getY(i) : 0);
    }
    sum[id * 3] += x;
    sum[id * 3 + 1] += y;
    sum[id * 3 + 2] += z;
    cnt[id]++;
    remap[i] = id;
  }
  const P = new Float32Array(cnt.length * 3);
  for (let k = 0; k < cnt.length; k++) for (let c = 0; c < 3; c++) P[k * 3 + c] = sum[k * 3 + c] / cnt[k];
  const tris: number[] = [];
  const index = src.index;
  const nT = index ? index.count : pos.count;
  for (let t = 0; t + 2 < nT; t += 3) {
    const a = remap[index ? index.getX(t) : t], b = remap[index ? index.getX(t + 1) : t + 1], c = remap[index ? index.getX(t + 2) : t + 2];
    if (a !== b && b !== c && a !== c) tris.push(a, b, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  g.setIndex(tris);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}