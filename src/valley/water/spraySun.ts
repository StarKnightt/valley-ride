// The sun (or moon) radiance on the waterfall's spray and mist sheets, set from the key light each frame (main.ts).
// In F:/island this lived on the sea-spray system (water/Spray.ts), which the valley does not have.
import * as THREE from 'three/webgpu';
import { uniform } from '../core/tsl';
export const sprayU = { sun: uniform(new THREE.Color(1, 1, 1)) };
