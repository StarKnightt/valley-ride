/**
 * Gait lab (dev page, gait-lab.html): the horse's gallop in a side view beside Muybridge's Sallie Gardner plate.
 *
 * One stride is recorded through the real runtime: the horse's own update (the gait code), stepped deterministically
 * with Engine.stepOnce at 240 samples per stride, every transform of the horse snapshotted per sample. Playback and
 * the scrub bar replay those snapshots (0.25x by default), so what you scrub is exactly what the test measured.
 * The same analysis module (gallop.ts) gives the lab and `pnpm test:gallop` their numbers.
 */
import * as THREE from 'three/webgpu';
import { Engine } from '../valley/core/Engine';
import { initAssets } from '../valley/core/Assets';
import { GAIT, Horse, STRESS_POSES } from '../valley/ride/Horse';
import {
  analyse, legOf, normalise, oursAsPlate, plateNormalised, ROLES,
  type Plate, type Recording, type Role, type Sample, type V3,
} from './gallop';

const PER_STRIDE = 240;
const COL: Record<Role, string> = { foreLead: '#e5392e', foreTrail: '#ff9a1f', hindLead: '#2fb33f', hindTrail: '#2f8cff' };
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (t: string) => { $('status').textContent = t; };

type LabWindow = Window & { __gaitlab?: Record<string, unknown> };
const w = window as LabWindow;

/** the Muybridge backdrop: lines 27 in apart, and 4 in apart near the ground, as on the card */
function backdrop() {
  const len = 60, hgt = 3, pxm = 120;
  const c = document.createElement('canvas');
  c.width = len * pxm; c.height = hgt * pxm;
  const g = c.getContext('2d')!;
  g.fillStyle = '#d8ccb2'; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = '#5a4a36'; g.lineWidth = 3;
  for (let x = 0; x < len; x += 0.6858) { g.beginPath(); g.moveTo(x * pxm, 0); g.lineTo(x * pxm, c.height); g.stroke(); }
  g.lineWidth = 2;
  for (let y = 0; y <= 0.41; y += 0.1016) { const py = c.height - y * pxm; g.beginPath(); g.moveTo(0, py); g.lineTo(c.width, py); g.stroke(); }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(len, hgt), new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }));
  // on the horse's far (left, +x) side, facing the camera on its right
  m.rotation.y = -Math.PI / 2;
  m.position.set(3, hgt / 2, len / 2 - 10);
  m.receiveShadow = true;
  return m;
}

async function boot() {
  const engine = await Engine.create($('app'));
  engine.setupPost();
  const { scene, camera } = engine;
  // the adapter, printed every run (the engine's own copy can come back empty)
  const info = (await (navigator as Navigator & { gpu?: GPU }).gpu?.requestAdapter({ powerPreference: 'high-performance' }))?.info;
  const gpu = info ? `${info.vendor} ${info.architecture}${info.description ? ` (${info.description})` : ''}${info.isFallbackAdapter ? ' FALLBACK' : ''}` : 'no WebGPU adapter';
  status(`${gpu} · ${engine.backendName}`);
  console.info(`[gaitlab] adapter ${gpu} backend ${engine.backendName}`);
  scene.background = new THREE.Color(0xcfc3a9);
  scene.add(new THREE.HemisphereLight(0xfff4e0, 0x6b5a44, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 0.5, far: 40 });
  scene.add(sun, sun.target);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 20), new THREE.MeshStandardMaterial({ color: 0xbfae8c, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.z = 50;
  ground.receiveShadow = true;
  scene.add(ground, backdrop());

  initAssets(engine.renderer);
  const horse = new Horse();
  await horse.load();
  scene.add(horse.root);
  horse.rider.visible = false; // (the plate is compared with the horse; the placeholder rider would only hide its back)
  const plate: Plate = await (await fetch('refs/muybridge/keypoints.json')).json();
  const card = new Image();
  card.src = 'refs/muybridge/card.jpg';
  await card.decode();

  // the side view: a long lens from the horse's right side (the side the plate shows), the horse in the left half
  camera.fov = 14;
  const D = 16.5, eyeY = 1.15;
  let centred = false;
  const frameView = () => {
    const W = innerWidth, H = innerHeight;
    camera.aspect = W / H;
    if (centred) camera.setViewOffset(W, H, 0, 0, W, H);
    else camera.setViewOffset(W, H, W > 900 ? W * 0.24 : 0, W > 900 ? 0 : H * 0.2, W, H);
    camera.updateProjectionMatrix();
  };
  frameView();
  addEventListener('resize', frameView);
  /** rig check: a stress pose held on a turntable (the camera circles the horse) */
  let stress = '', turn = -Math.PI / 2, turning = true;
  const follow = () => {
    const p = horse.root.position;
    if (stress) camera.position.set(p.x + Math.cos(turn) * D, eyeY + 0.5, p.z + Math.sin(turn) * D);
    else camera.position.set(p.x - D, eyeY, p.z);
    camera.lookAt(p.x, eyeY, p.z);
    sun.position.set(p.x - 6, 12, p.z - 4);
    sun.target.position.copy(p);
  };

  // ---------------------------------------------------------------- the recording (the real gait code)
  let mode: 'sim' | 'replay' = 'sim';
  engine.addUpdater((dt) => {
    if (mode === 'sim' && dt > 0) {
      horse.update(dt, 0, 0);
      horse.root.position.z += horse.speed * dt;
    }
    follow();
  });
  const objs: THREE.Object3D[] = [];
  horse.root.traverse((o) => objs.push(o));
  const snap = () => {
    const a = new Float32Array(objs.length * 10);
    objs.forEach((o, i) => { o.position.toArray(a, i * 10); o.quaternion.toArray(a, i * 10 + 3); o.scale.toArray(a, i * 10 + 7); });
    return a;
  };
  const restore = (a: Float32Array) => {
    objs.forEach((o, i) => { o.position.fromArray(a, i * 10); o.quaternion.fromArray(a, i * 10 + 3); o.scale.fromArray(a, i * 10 + 7); });
    horse.root.updateMatrixWorld(true);
  };
  const joints = () => {
    const j: Record<string, V3> = {};
    for (const [k, v] of Object.entries(horse.gateJoints())) j[k] = [v.x, v.y, v.z];
    return j;
  };

  status('Recording one stride through the gait code...');
  engine.manual = true;
  horse.resetGait();
  horse.root.position.set(0, 0, 0);
  horse.heading = 0;
  horse.speed = GAIT.gallop;
  // settle at the gallop and measure the stride period from the gait's own phase
  let unwrapped = 0, prev = horse.stridePhase, tWarm = 0;
  const warmDt = 1 / 240;
  for (let i = 0; i < 480; i++) {
    engine.stepOnce(warmDt);
    tWarm += warmDt;
    let d = horse.stridePhase - prev;
    if (d < -0.5) d += 1;
    unwrapped += d;
    prev = horse.stridePhase;
  }
  const period = tWarm / unwrapped;
  const dt = period / PER_STRIDE;
  // run to the next wrap of the stride phase: sample 0 is the first pose of a stride
  for (let i = 0; i < 4 * PER_STRIDE; i++) {
    const p = horse.stridePhase;
    engine.stepOnce(dt);
    if (horse.stridePhase < p) break;
  }
  const samples: Sample[] = [];
  const snaps: Float32Array[] = [];
  let t = 0;
  for (let k = 0; k < 2 * PER_STRIDE + 2; k++) {
    if (k > 0) { engine.stepOnce(dt); t += dt; }
    samples.push({ t, phase: horse.stridePhase, j: joints() });
    snaps.push(snap());
  }
  // and at real time: 1/60 s steps over three strides
  const realtime: Sample[] = [];
  const dtRealtime = 1 / 60;
  for (let k = 0, tr = 0; k < Math.ceil((3 * period) / dtRealtime); k++, tr += dtRealtime) {
    engine.stepOnce(dtRealtime);
    realtime.push({ t: tr, phase: horse.stridePhase, j: joints() });
  }
  mode = 'replay';
  const rec: Recording = {
    samples, perStride: PER_STRIDE, period, dt, forward: [0, 0, 1], up: [0, 1, 0], groundY: 0,
    lead: horse.lead, realtime, dtRealtime, speed: horse.speed,
  };
  const result = analyse(rec, plate);
  console.info(`[gaitlab] stride ${period.toFixed(3)} s at ${horse.speed} m/s, ${PER_STRIDE} samples; plate stride ${result.align.stride.N.toFixed(2)} frames, offset ${result.align.offset}`);

  // ---------------------------------------------------------------- display
  const svg = $('ov') as unknown as SVGSVGElement;
  const pc = $('pc') as HTMLCanvasElement;
  const pg = pc.getContext('2d')!;
  let k = 0, kf = 0, playing = false, frameShown = 0;
  const scrub = $('scrub') as HTMLInputElement;
  const overlay = $('overlay') as HTMLInputElement;
  const toScreen = (x: number, y: number, z: number) => {
    const v = new THREE.Vector3(x, y, z).project(camera);
    return [((v.x + 1) / 2) * innerWidth, ((1 - v.y) / 2) * innerHeight] as [number, number];
  };
  /** joints of sample i on screen, keyed like the plate (roles) */
  const projected = (i: number) => {
    const P: Record<string, [number, number]> = {};
    const s = samples[i];
    const x = horse.root.position.x;
    for (const [name, v] of Object.entries(oursAsPlate(rec, s))) P[name] = toScreen(x, v[1], v[0]);
    return P;
  };
  /** the plate's pose for frame fi, scaled onto our withers-croup at sample i, on screen */
  const plateOnOurs = (fi: number, i: number) => {
    const O = oursAsPlate(rec, samples[i]);
    const o: [number, number] = [(O.withers[0] + O.croup[0]) / 2, (O.withers[1] + O.croup[1]) / 2];
    const L = Math.hypot(O.withers[0] - O.croup[0], O.withers[1] - O.croup[1]);
    const P: Record<string, [number, number]> = {};
    for (const [name, v] of Object.entries(plateNormalised(plate.frames[fi]))) P[name] = toScreen(horse.root.position.x, o[1] + v[1] * L, o[0] + v[0] * L);
    return P;
  };
  const skeleton = (P: Record<string, [number, number]>, dashed: boolean) => {
    const line = (a: string, b: string, c: string, wdt: number) =>
      P[a] && P[b] ? `<line x1="${P[a][0]}" y1="${P[a][1]}" x2="${P[b][0]}" y2="${P[b][1]}" stroke="${c}" stroke-width="${wdt}" ${dashed ? 'stroke-dasharray="6 4"' : ''} stroke-linecap="round"/>` : '';
    let s = line('croup', 'withers', '#ffe14d', 2) + line('withers', 'poll', '#ffe14d', 2) + line('poll', 'muzzle', '#ffe14d', 2);
    for (const r of ROLES) {
      const m = r.startsWith('fore') ? 'knee' : 'hock';
      s += line(`${r}_top`, `${r}_${m}`, COL[r], 3) + line(`${r}_${m}`, `${r}_fetlock`, COL[r], 3) + line(`${r}_fetlock`, `${r}_hoof`, COL[r], 3);
    }
    if (!dashed) for (const [, p] of Object.entries(P)) s += `<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="#fff" stroke="#000" stroke-width="1"/>`;
    return s;
  };
  const drawPlate = (fi: number) => {
    const q = plate.frames[fi];
    const [x0, y0, x1, y1] = q.panel;
    const sw = x1 - x0, sh = y1 - y0, sc = Math.min(pc.width / sw, pc.height / sh);
    pg.fillStyle = '#000'; pg.fillRect(0, 0, pc.width, pc.height);
    const ox = (pc.width - sw * sc) / 2, oy = (pc.height - sh * sc) / 2;
    pg.drawImage(card, x0, y0, sw, sh, ox, oy, sw * sc, sh * sc);
    if (!overlay.checked) return;
    const at = (n: string): [number, number] => { const v = q.points[n]; return [ox + (v[0] - x0) * sc, oy + (v[1] - y0) * sc]; };
    const seg = (a: string, b: string, c: string, wdt = 3) => { const A = at(a), B = at(b); pg.strokeStyle = c; pg.lineWidth = wdt; pg.beginPath(); pg.moveTo(A[0], A[1]); pg.lineTo(B[0], B[1]); pg.stroke(); };
    seg('croup', 'withers', '#ffe14d', 2); seg('withers', 'poll', '#ffe14d', 2); seg('poll', 'muzzle', '#ffe14d', 2);
    for (const r of ROLES) {
      const top = r.startsWith('fore') ? 'elbow' : 'stifle', m = r.startsWith('fore') ? 'knee' : 'hock';
      seg(top, `${r}_${m}`, COL[r]); seg(`${r}_${m}`, `${r}_fetlock`, COL[r]); seg(`${r}_fetlock`, `${r}_hoof`, COL[r]);
      if (q.contact[r]) { const h = at(`${r}_hoof`); pg.strokeStyle = COL[r]; pg.lineWidth = 2; pg.strokeRect(h[0] - 7, h[1] - 7, 14, 14); }
    }
    for (const n of Object.keys(q.points)) { const p = at(n); pg.fillStyle = '#fff'; pg.beginPath(); pg.arc(p[0], p[1], 3, 0, 7); pg.fill(); pg.strokeStyle = '#000'; pg.lineWidth = 1; pg.stroke(); }
  };
  /** the plate frame whose aligned sample is nearest sample i (cyclic) */
  const nearestFrame = (i: number) => {
    let best = 0, bd = Infinity;
    result.align.index.forEach((s, fi) => { const d = Math.min(Math.abs(s - i), PER_STRIDE - Math.abs(s - i)); if (d < bd) { bd = d; best = fi; } });
    return best;
  };
  const show = (i: number) => {
    k = ((i % PER_STRIDE) + PER_STRIDE) % PER_STRIDE;
    restore(snaps[k]);
    follow();
    camera.updateMatrixWorld(true);
    const fi = nearestFrame(k);
    if (fi !== frameShown || !playing) { frameShown = fi; drawPlate(fi); }
    svg.innerHTML = overlay.checked ? skeleton(projected(k), false) + skeleton(plateOnOurs(frameShown, k), true) : '';
    scrub.value = String(k);
    const s = samples[k];
    const down = ROLES.filter((r) => s.j[`${legOf(r, rec.lead)}_hoof`][1] <= 0.01).map((r) => r.replace(/([A-Z])/, ' $1').toLowerCase());
    $('read').textContent = `sample ${k}/${PER_STRIDE}  phase ${(k / PER_STRIDE).toFixed(3)}  plate frame ${plate.frames[frameShown].frame}  down: ${down.join(', ') || 'none'}`;
  };

  // controls
  const fr = $('frames');
  plate.frames.forEach((q, fi) => {
    const b = document.createElement('button');
    b.textContent = String(q.frame);
    b.title = `Muybridge frame ${q.frame}: jump to its aligned phase`;
    b.onclick = () => { playing = false; $('play').textContent = 'Play'; frameShown = fi; drawPlate(fi); show(result.align.index[fi]); };
    fr.appendChild(b);
  });
  $('play').onclick = () => { playing = !playing; $('play').textContent = playing ? 'Pause' : 'Play'; kf = k; };
  scrub.oninput = () => { playing = false; $('play').textContent = 'Play'; show(Number(scrub.value)); };
  overlay.onchange = () => { drawPlate(frameShown); show(k); };
  addEventListener('keydown', (e) => {
    if (e.key === ' ') { $('play').click(); e.preventDefault(); }
    if (e.key === 'ArrowRight') { playing = false; show(k + 1); }
    if (e.key === 'ArrowLeft') { playing = false; show(k - 1); }
  });
  const stressSel = $('stress') as HTMLSelectElement;
  for (const [id, p] of Object.entries(STRESS_POSES)) { const o = document.createElement('option'); o.value = id; o.textContent = p.label; stressSel.appendChild(o); }
  const setStress = (id: string) => {
    stress = id;
    playing = false; $('play').textContent = 'Play';
    document.body.classList.toggle('rig', !!id);
    if (id) { horse.setStressPose(id); svg.innerHTML = ''; turn = -Math.PI / 2; } else { horse.setStressPose(null); show(k); }
  };
  stressSel.onchange = () => setStress(stressSel.value);
  engine.addUpdater((wallDt) => { if (stress && turning) turn += wallDt * 0.7; });
  engine.addUpdater((wallDt) => {
    if (!playing || stress) return;
    kf += (wallDt * Number(($('rate') as HTMLSelectElement).value)) / dt;
    show(Math.floor(kf));
  });

  // results
  const st = result.align.stride;
  $('plateinfo').innerHTML = `Plate: ${plate.frames.length} frames 27 in apart; one stride = ${st.N.toFixed(2)} frame intervals (from the leading fore's two plants). Ours: stride ${period.toFixed(3)} s at ${rec.speed} m/s, ${PER_STRIDE} samples. Best fit offset ${result.align.offset}.`;
  const rows = result.checks.map((c) => `<tr><td class="id">${c.id}</td><td class="${c.id === 'B1' || c.id === 'B2' ? 'INFO' : c.pass ? 'PASS' : 'FAIL'}">${c.id === 'B1' || c.id === 'B2' ? 'info' : c.pass ? 'PASS' : 'FAIL'}</td><td>${c.name}<br><span class="sub">${c.value} (limit: ${c.limit})</span></td></tr>`);
  const refRows = result.reference.map((c) => `<tr><td class="id">ref ${c.id}</td><td class="INFO">${c.pass ? 'pass' : 'fail'}</td><td>The plate itself: ${c.name}<br><span class="sub">${c.value}</span></td></tr>`);
  $('checks').innerHTML = rows.join('') + refRows.join('');

  frameShown = 0;
  drawPlate(0);
  engine.manual = false;
  engine.start();
  show(result.align.index[0]);
  status(`${gpu} · ${engine.backendName} · ${horse.meta.triangles} triangles, ${horse.meta.bones} bones`);

  w.__gaitlab = {
    ready: true, engine, horse, rec, result, plate,
    /** the harness (rig check): hold a stress pose seen from an angle (radians round the horse, -PI/2 = its right side) */
    async rig(id: string, angle: number) {
      document.body.classList.add('capture');
      centred = true;
      frameView();
      engine.manual = true;
      turning = false;
      setStress(id);
      turn = angle;
      engine.stepOnce(0);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return { poses: Object.keys(STRESS_POSES), triangles: horse.meta.triangles, bones: horse.meta.bones };
    },
    /** the harness: hold the loop, show sample i, return the screen joints (ours and the plate's on ours) */
    async capture(i: number, fi: number) {
      document.body.classList.add('capture');
      centred = true;
      frameView();
      playing = false;
      engine.manual = true;
      show(i);
      engine.stepOnce(0);
      // let the frame reach the screen before the harness takes it
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return { ours: projected(k), plate: plateOnOurs(fi, k), W: innerWidth, H: innerHeight };
    },
  };
}

boot().catch((e) => {
  console.error(e);
  status('Failed: ' + String(e?.message ?? e));
  w.__gaitlab = { error: String(e?.stack ?? e) };
});
