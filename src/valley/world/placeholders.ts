/**
 * PLACEHOLDER landmark pieces: grey boxes and cylinders built in code, standing in for the summit ruins kit and the
 * valley props until they are built in Blender (GAME.md, rounds 6 and 10). Each returns an object at its own unit
 * scale; Valley scales it to the piece's size, seats it on the ground and builds its collider from the mesh, so the
 * shapes keep the openings that matter (the arch can be ridden through, the floor is a step up).
 */
import * as THREE from 'three/webgpu';

export type PieceKind =
  | 'head' | 'rubble' | 'column' | 'column-fallen' | 'obelisk' | 'floor' | 'wall' | 'wall-window' | 'arch'
  | 'urns' | 'tent' | 'boulders';

const grey = new THREE.MeshStandardMaterial({ color: 0x8c8c88, roughness: 0.92, name: 'placeholder' });

function add(g: THREE.Group, geo: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0, rx = 0, rz = 0) {
  const m = new THREE.Mesh(geo, grey);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  g.add(m);
  return m;
}
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const cyl = (r: number, h: number, seg = 10) => new THREE.CylinderGeometry(r, r, h, seg);

export function placeholderPiece(kind: PieceKind): THREE.Group {
  const g = new THREE.Group();
  g.name = `placeholder-${kind}`;
  switch (kind) {
    case 'head': add(g, box(0.8, 1, 0.9), 0, 0.5, 0); break;
    case 'rubble':
      add(g, box(1, 0.4, 0.8), 0, 0.2, 0, 0.3);
      add(g, box(0.5, 0.3, 0.5), 0.3, 0.5, 0.1, 0.9);
      break;
    case 'column': add(g, cyl(0.09, 1), 0, 0.5, 0); add(g, box(0.26, 0.06, 0.26), 0, 0.03, 0); break;
    case 'column-fallen':
      for (let i = 0; i < 3; i++) add(g, cyl(0.1, 0.3), -0.36 + i * 0.34, 0.1, i * 0.03, 0, 0, Math.PI / 2);
      break;
    case 'obelisk': add(g, box(0.16, 1, 0.16), 0, 0.5, 0); break;
    case 'floor': add(g, box(1, 0.04, 1), 0, 0.02, 0); break;
    case 'wall': add(g, box(1, 0.3, 0.06), 0, 0.15, 0); break;
    case 'wall-window':
      add(g, box(0.35, 0.5, 0.06), -0.325, 0.25, 0);
      add(g, box(0.35, 0.5, 0.06), 0.325, 0.25, 0);
      add(g, box(0.3, 0.15, 0.06), 0, 0.075, 0);
      add(g, box(0.3, 0.12, 0.06), 0, 0.44, 0);
      break;
    case 'arch':
      add(g, box(0.22, 0.7, 0.2), -0.39, 0.35, 0);
      add(g, box(0.22, 0.7, 0.2), 0.39, 0.35, 0);
      add(g, box(1, 0.2, 0.2), 0, 0.8, 0);
      break;
    case 'urns': for (const [x, z] of [[0, 0], [0.35, 0.2], [-0.25, 0.3]]) add(g, cyl(0.14, 0.5, 8), x, 0.25, z); break;
    case 'tent': add(g, new THREE.ConeGeometry(0.5, 0.7, 4), 0, 0.35, 0, Math.PI / 4); break;
    case 'boulders':
      add(g, box(0.6, 0.45, 0.5), 0, 0.22, 0, 0.4);
      add(g, box(0.4, 0.3, 0.4), 0.45, 0.15, 0.2, 1.1);
      break;
  }
  return g;
}
