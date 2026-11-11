/**
 * The checkpoints: a pair of wooden lantern posts either side of the trail, the lanterns hanging from short arms over
 * the edge of the way. They glow warm and soft (an emissive glass and a faint halo). After dark they light the trail
 * for real: two point lights, always in the scene (adding or removing a light changes the light set and rebuilds every
 * lit material), wait at the pair nearest the camera and come up with the night. The next one ahead burns brightest
 * and breathes a little; riding through swells it, and after that it settles to a low, cozy glow.
 */
import * as THREE from 'three/webgpu';
import { float, length, mx_noise_float, smoothstep, uniform, uv, vec3, vec4 } from '../core/tsl';
import { effectMRT } from '../core/fx';
import type { Heightfield } from '../world/Heightfield';
import type { Colliders } from '../world/Colliders';
import type { V2 } from '../world/layout';

type CpState = 'ahead' | 'next' | 'passed';

export class Checkpoints {
  readonly group = new THREE.Group();
  private glow: ReturnType<typeof uniform>[] = [];
  private state: CpState[] = [];
  private swell: number[] = [];
  private time = uniform(0);
  /** at night the lantern glass and halo are held down: under the night's exposure they burned out to white */
  private nightU = uniform(0);
  /** the lanterns' world positions, two per checkpoint */
  private lamps: THREE.Vector3[] = [];
  /** the two lights that wait at the nearest pair */
  readonly lights = [new THREE.PointLight(0xffa04a, 0, 16, 2), new THREE.PointLight(0xffa04a, 0, 16, 2)];
  /** set per frame: 0 day .. 1 night, and where the camera is */
  night = 0;
  readonly view = new THREE.Vector3();

  constructor(private hf: Heightfield, colliders: Colliders, readonly points: V2[], route: V2[]) {
    // (lit by every light, the lanterns' own too: at night the arm and the post under each lantern catch its glow)
    const wood = new THREE.MeshStandardNodeMaterial({ color: 0x3b2a1c, roughness: 0.92 });
    const iron = new THREE.MeshStandardNodeMaterial({ color: 0x1d1b19, roughness: 0.55, metalness: 0.4 });
    const postG = new THREE.CylinderGeometry(0.055, 0.07, 2.5, 7).translate(0, 1.25, 0);
    const armG = new THREE.BoxGeometry(0.05, 0.05, 0.55).translate(0, 0, 0.24);
    const capG = new THREE.ConeGeometry(0.11, 0.1, 6).translate(0, 0.17, 0);
    const baseG = new THREE.CylinderGeometry(0.09, 0.09, 0.03, 6).translate(0, -0.12, 0);
    const glassG = new THREE.CylinderGeometry(0.075, 0.075, 0.22, 6);
    const ringG = new THREE.TorusGeometry(0.03, 0.008, 4, 8).rotateY(Math.PI / 2).translate(0, 0.25, 0);
    for (let i = 0; i < points.length; i++) {
      const g = uniform(0.7);
      this.glow.push(g);
      this.state.push('ahead');
      this.swell.push(0);
      // (the flame inside flickers: two octaves of noise in time, per lantern)
      const fl = mx_noise_float(vec3(this.time.mul(2.3), float(i * 7.1), 0.5)).mul(0.12).add(mx_noise_float(vec3(this.time.mul(7.7), float(i * 3.3), 2.0)).mul(0.06)).add(0.9);
      const glass = new THREE.MeshBasicNodeMaterial();
      glass.colorNode = vec4(vec3(3.2, 1.55, 0.5).mul(g).mul(fl).mul(float(1).sub(this.nightU.mul(0.72))), 1);
      glass.fog = true;
      const halo = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      const r = length(uv().sub(0.5)).mul(2);
      halo.colorNode = vec4(vec3(1.0, 0.5, 0.16).mul(float(1).sub(smoothstep(0, 1, r)).pow(2.4)).mul(g).mul(fl).mul(0.55).mul(float(1).sub(this.nightU.mul(0.6))), 1);
      halo.mrtNode = effectMRT();
      halo.fog = true;
      // the trail's direction here: the posts stand across it
      const [x, z] = points[i];
      let k = 0, best = Infinity;
      for (let j = 0; j < route.length; j++) { const d = Math.hypot(route[j][0] - x, route[j][1] - z); if (d < best) { best = d; k = j; } }
      const a = route[Math.max(0, k - 1)], b = route[Math.min(route.length - 1, k + 1)];
      const dir = Math.atan2(b[0] - a[0], b[1] - a[1]);
      for (const side of [-1, 1]) {
        const px = x + Math.cos(dir) * 3.4 * side, pz = z - Math.sin(dir) * 3.4 * side;
        const post = new THREE.Group();
        post.position.set(px, this.hf.height(px, pz) - 0.05, pz);
        // (the arm reaches in over the trail's edge)
        post.rotation.y = dir + (side > 0 ? -Math.PI / 2 : Math.PI / 2);
        const pole = new THREE.Mesh(postG, wood);
        const arm = new THREE.Mesh(armG, wood);
        arm.position.set(0, 2.38, 0);
        const lantern = new THREE.Group();
        lantern.position.set(0, 2.02, 0.44);
        lantern.add(new THREE.Mesh(capG, iron), new THREE.Mesh(baseG, iron), new THREE.Mesh(ringG, iron), new THREE.Mesh(glassG, glass));
        const h = new THREE.Sprite(halo);
        h.scale.setScalar(1.5);
        lantern.add(h);
        post.add(pole, arm, lantern);
        post.updateMatrixWorld(true);
        this.lamps.push(lantern.getWorldPosition(new THREE.Vector3()));
        post.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        h.castShadow = false;
        this.group.add(post);
        colliders.circle(px, pz, 0.2);
      }
    }
    for (const l of this.lights) { l.castShadow = false; this.group.add(l); }
    this.reset();
  }

  reset() {
    for (let i = 0; i < this.state.length; i++) { this.state[i] = i === 0 ? 'next' : 'ahead'; this.swell[i] = 0; }
  }

  pass(i: number) {
    this.state[i] = 'passed';
    this.swell[i] = 1;
    if (i + 1 < this.state.length && this.state[i + 1] === 'ahead') this.state[i + 1] = 'next';
  }

  update(dt: number, t: number) {
    this.time.value = t;
    this.nightU.value = this.night;
    // the lights: at the pair nearest the camera, up with the night, the glow and its flicker; faded out far off
    let k = 0, best = Infinity;
    for (let i = 0; i < this.points.length; i++) {
      const d = Math.hypot(this.points[i][0] - this.view.x, this.points[i][1] - this.view.z);
      if (d < best) { best = d; k = i; }
    }
    const far = 1 - THREE.MathUtils.smoothstep(best, 90, 140);
    const g = this.glow[k].value as number;
    for (let j = 0; j < 2; j++) {
      const l = this.lights[j];
      l.position.copy(this.lamps[k * 2 + j]).y -= 0.05;
      const fl = 0.9 + 0.07 * Math.sin(t * 9.3 + j * 2.1) + 0.04 * Math.sin(t * 23.1 + j);
      l.intensity = 26 * this.night * g * fl * far;
    }
    for (let i = 0; i < this.glow.length; i++) {
      const s = this.state[i];
      // (the next one breathes slowly, so the eye finds it down the trail)
      const base = s === 'next' ? 1.0 + 0.15 * Math.sin(t * 1.6) : s === 'passed' ? 0.4 : 0.6;
      this.swell[i] *= Math.exp(-dt / 1.4);
      const g = this.glow[i];
      const want = base + 1.4 * this.swell[i];
      g.value = (g.value as number) + (want - (g.value as number)) * (1 - Math.exp(-dt * 3));
    }
  }
}
