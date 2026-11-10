/**
 * The sun's shadow term for every receiver: the cascaded shadow map (near detail), times the shadows of the
 * clouds overhead (at any distance, also beyond the last cascade), times the terrain's own shadow at a low sun
 * (the heightfield marched toward the sun, so ridges throw long shadows across the island at sunrise and sunset).
 * Only direct sunlight is shadowed; sky light and bounce are untouched.
 */
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { positionWorld, float, vec3, mix, type N } from '../core/tsl';
import { VEG_SHADOW_LAYER } from '../veg/Vegetation';

type Factor = (p: N) => N;
const factors: Factor[] = [];

/** register an extra occlusion of direct sunlight (cloud shadow, terrain shadow) */
export function addSunOcclusion(f: Factor) {
  factors.push(f);
}

export class SunShadowNode extends CSMShadowNode {
  /** shadow-map size per cascade (near to far); the outer cascades cover far more ground where texels can be coarser,
   * and their fill (alpha-tested leaf cards, many times over) is most of the shadow cost. Unset: the light's size. */
  mapSizes: number[] = [];

  setup(builder: unknown) {
    let s = (super.setup as (b: unknown) => N)(builder);
    // (the cascade lights exist from the first setup on; each render resizes its map to its shadow's mapSize)
    const lights = (this as unknown as { lights: { shadow: { mapSize: { set: (w: number, h: number) => void }; camera: { layers: { enable: (n: number) => void } } } }[] }).lights;
    lights.forEach((l, i) => {
      const m = this.mapSizes[i];
      if (m) l.shadow.mapSize.set(m, m);
      // near-tree shadows: every cascade but the last
      if (i < lights.length - 1 || lights.length === 1) l.shadow.camera.layers.enable(VEG_SHADOW_LAYER);
    });
    let k: N = float(1);
    for (const f of factors) k = k.mul(f(positionWorld));
    s = s.mul(k);
    // (NEXT5 §4: never a pure black cutout. The fully shadowed ground keeps a trace of the direct light, cooled toward
    // the blue of the open sky that fills real shade, so the shadow's core is a soft cool dark, not a hole)
    return mix(vec3(0.05, 0.065, 0.09), vec3(1), vec3(s));
  }
}
