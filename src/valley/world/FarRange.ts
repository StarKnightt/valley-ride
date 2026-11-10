/**
 * The far ranges: a ring of mountains beyond the baked square, from 1.2 km out to 9 km, so every horizon is
 * mountains (big snowy massifs to the north and west, lower blue ridges east). Near its inner edge the ring stays
 * low, under the square's own mountain ring, whose crest hides the seam from anywhere on the valley floor.
 * One mesh, built once on the CPU (a polar grid, finer near the valley), lit by the sun and fogged by the aerial
 * perspective like everything else.
 */
import * as THREE from 'three/webgpu';
import { attribute, float, mix, normalWorld, smoothstep, vec3, vec4, positionWorld, mx_noise_float } from '../core/tsl';
import { Noise2, smoothstep as ss } from '../core/noise';
import type { Heightfield } from './Heightfield';
import { sunLit } from '../core/lighting';

const R0 = 1150, R1 = 9000;

export class FarRange {
  readonly mesh: THREE.Mesh;

  constructor(_hf: Heightfield) {
    const n = new Noise2(2718), n2 = new Noise2(99);
    const A = 720, Rn = 96;
    const pos = new Float32Array((A + 1) * Rn * 3);
    const idx: number[] = [];
    const height = (x: number, z: number, r: number) => {
      const th = Math.atan2(z, x);
      // massifs: bigger to the north (-z) and west (-x)
      const north = Math.max(0, -Math.sin(th)), west = Math.max(0, -Math.cos(th));
      const big = 650 + 600 * north + 350 * west;
      const rise = ss(R0 + 150, 2600, r) * (1 - ss(6500, 9000, r) * 0.7);
      const qx = x + 260 * n.fbm(x / 2200, z / 2200, 3), qz = z + 260 * n.fbm(x / 2200 + 7, z / 2200 - 3, 3);
      // (softened ridges and broad shoulders: massifs, not a saw blade of single-triangle spikes)
      const ridge = Math.pow(n.ridged(qx / 1800, qz / 1800, 5), 1.6);
      const body = 0.5 + 0.5 * n2.fbm(qx / 2600, qz / 2600, 3);
      const detail = n2.fbm(qx / 520, qz / 520, 3);
      return 120 + rise * big * (0.32 + 0.3 * ridge + 0.55 * body + 0.05 * detail);
    };
    for (let j = 0; j < Rn; j++) {
      const f = j / (Rn - 1);
      const r = R0 + (R1 - R0) * f * f;
      for (let i = 0; i <= A; i++) {
        const th = (i / A) * Math.PI * 2;
        const x = Math.cos(th) * r, z = Math.sin(th) * r;
        const o = (j * (A + 1) + i) * 3;
        pos[o] = x;
        pos[o + 1] = height(x, z, r);
        pos[o + 2] = z;
      }
    }
    for (let j = 0; j < Rn - 1; j++) for (let i = 0; i < A; i++) {
      const a = j * (A + 1) + i, b = a + 1, c = a + A + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();

    const m = sunLit(new THREE.MeshStandardNodeMaterial());
    m.name = 'far-range';
    const y = positionWorld.y;
    const up = normalWorld.y;
    const nz = mx_noise_float(vec3(positionWorld.xz.mul(1 / 260), 1.3));
    // forest dark on the lower slopes, grey-brown rock above, snow on the high massifs (held on the gentler faces)
    const forest = vec3(0.025, 0.04, 0.022);
    const rock = vec3(0.13, 0.12, 0.11);
    const snow = vec3(0.75, 0.78, 0.83);
    let col = mix(forest, rock, smoothstep(380, 620, y.add(nz.mul(120))));
    col = mix(col, rock.mul(0.75), float(1).sub(smoothstep(0.5, 0.75, up)).mul(0.6));
    const snowW = smoothstep(980, 1150, y.add(nz.mul(160))).mul(smoothstep(0.45, 0.75, up));
    col = mix(col, snow, snowW);
    void attribute;
    m.colorNode = vec4(col, 1);
    m.roughnessNode = mix(float(0.9), float(0.55), snowW);
    m.metalnessNode = float(0);
    const mesh = new THREE.Mesh(g, m);
    mesh.name = 'far-range';
    mesh.receiveShadow = false;
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    this.mesh = mesh;
  }
}
