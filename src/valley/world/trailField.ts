/**
 * Distance to the nearest trail's centre line (the PATHS polylines the bake carved the trails along), in metres, on a
 * 1 m grid over the square, capped at 8 m. A distance field interpolates linearly between texels, so the shaders can
 * place features a fraction of a metre wide across a trail (wheel ruts, the grass strip between them) that the
 * baked 2 m dirt mask, flat across the trail's middle, cannot.
 */
import * as THREE from 'three/webgpu';
import { HALF_WORLD, WORLD_SIZE, PATHS } from './layout';

const RES = 2048;
const CAP = 8;

let tex: THREE.DataTexture | null = null;

export function trailTexture() {
  if (tex) return tex;
  const d = new Float32Array(RES * RES).fill(CAP);
  const cell = WORLD_SIZE / RES;
  for (const path of PATHS) for (let k = 0; k + 1 < path.length; k++) {
    const [ax, az] = path[k], [bx, bz] = path[k + 1];
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - CAP + HALF_WORLD) / cell));
    const i1 = Math.min(RES - 1, Math.ceil((Math.max(ax, bx) + CAP + HALF_WORLD) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - CAP + HALF_WORLD) / cell));
    const j1 = Math.min(RES - 1, Math.ceil((Math.max(az, bz) + CAP + HALF_WORLD) / cell));
    for (let j = j0; j <= j1; j++) {
      const z = (j + 0.5) * cell - HALF_WORLD;
      for (let i = i0; i <= i1; i++) {
        const x = (i + 0.5) * cell - HALF_WORLD;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
        const e = Math.hypot(x - ax - dx * t, z - az - dz * t);
        const o = j * RES + i;
        if (e < d[o]) d[o] = e;
      }
    }
  }
  tex = new THREE.DataTexture(d, RES, RES, THREE.RedFormat, THREE.FloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
