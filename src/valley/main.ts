/**
 * Valley Ride: a first-person horse ride through an open mountain valley (NEXT3 / round 13).
 * WebGPU, three r187 TSL. The world systems (terrain, sky, atmosphere, river, vegetation, birds) come from the
 * Island and River Morning projects; the ride itself (horse, gaits, first-person camera) lives in ride/.
 */
import * as THREE from 'three/webgpu';
import { SunShadowNode, addSunOcclusion } from './sky/SunShadow';
import { VEG_SHADOW_LAYER } from './veg/Vegetation';
import { Engine, grade } from './core/Engine';
import { params, TOD_PRESETS } from './core/params';
import { Q, preset, gpuName } from './core/quality';
import { initAssets, progress as assetProgress } from './core/Assets';
import { Heightfield } from './world/Heightfield';
import { Terrain } from './world/Terrain';
import { createTerrainMaterial, terrainU } from './world/TerrainMaterial';
import { Sky, cloudShadow } from './sky/Sky';
import { TimeOfDay } from './sky/TimeOfDay';
import { aerialFogNode, atmo } from './sky/Atmosphere';
import { Loading } from './ui/Loading';
import { HALF_WORLD, WORLD_SIZE } from './world/layout';
import { wetness } from './world/weatherUniforms';
import { sprayU } from './water/spraySun';
import { setPlantSkyMaps } from './veg/glb';
import { setSunLight } from './core/lighting';
import { Colliders } from './world/Colliders';
import { Input } from './player/Input';
import { CameraRig } from './player/CameraRig';
import { River } from './water/River';
import { Birds } from './world/Birds';
import { Weather } from './sky/Weather';
import { mark } from './core/timeline';
import { FarRange } from './world/FarRange';
import { vegU } from './veg/Vegetation';
import { Valley } from './world/Valley';
import { Ride } from './ride/Ride';
import { AudioSystem } from './audio/Audio';
import { createMusic } from './audio/music';
import { RideUI } from './ui/RideUI';
import { SPAWN, SITES, PATHS, FORDS, site, CHECKPOINTS, ROUTE } from './world/layout';
import { Checkpoints } from './game/Checkpoints';
import { Game } from './game/Game';
import { GameUI } from './ui/GameUI';

const skip = new Set((new URLSearchParams(location.search).get('skip') ?? '').split(','));

async function boot() {
  mark('boot');
  const loading = new Loading();
  loading.gpu(gpuName ? `${gpuName} · ${preset}` : preset);
  loading.status('Starting the renderer');
  const engine = await Engine.create(document.getElementById('app')!);
  const { scene, camera, renderer } = engine;
  camera.layers.enable(VEG_SHADOW_LAYER);
  const refreshMeasured = engine.measureRefresh();
  const adapter = `${gpuName || engine.adapterInfo.description || engine.adapterInfo.vendor || ''}`;
  loading.gpu(`${adapter} · ${engine.backendName} · ${preset}`);
  console.info(`[valley] adapter ${JSON.stringify(engine.adapterInfo)} backend ${engine.backendName} preset ${preset}`);
  initAssets(renderer);
  assetProgress.onChange = () => {
    if (assetProgress.pending > 0) loading.progress(0.28 + 0.47 * (assetProgress.done / assetProgress.pending));
  };

  loading.status('Shaping the valley');
  const hf = new Heightfield();
  let got = 0;
  await hf.load('./world/', (n) => {
    got += n;
    loading.progress(0.03 + 0.25 * Math.min(1, got / Heightfield.BYTES));
  });
  const colliders = new Colliders();
  mark('heightfield');

  // ---- light and sky
  loading.status('Lighting the sky');
  const sunLight = new THREE.DirectionalLight(0xffffff, 10);
  sunLight.castShadow = !new URLSearchParams(location.search).has('noshadow');
  sunLight.shadow.mapSize.set(Q.shadowMap, Q.shadowMap);
  sunLight.shadow.camera.near = 1;
  sunLight.shadow.camera.far = 1400;
  sunLight.shadow.bias = -0.0003;
  sunLight.shadow.normalBias = 0.5;
  // (NEXT5 §4: soft edges. r187's WebGPU renderer dropped PCFSoftShadowMap; its PCF filter takes a Vogel-disk radius
  // in texels instead, cloned into every cascade, so the far cascades' coarser texels soften the more)
  sunLight.shadow.radius = 3;
  addSunOcclusion((p) => cloudShadow(p));
  const csm = new SunShadowNode(sunLight, { cascades: Q.cascades, maxFar: Q.shadowFar, mode: 'practical', lightMargin: 500 });
  csm.fade = true;
  csm.mapSizes = [Q.shadowMap, ...Array.from({ length: Math.max(0, Q.cascades - 2) }, () => Q.shadowMid), Q.shadowFarMap].slice(0, Q.cascades);
  sunLight.shadow.shadowNode = csm;
  scene.add(sunLight, sunLight.target);
  setSunLight(sunLight);

  const tod = new TimeOfDay(sunLight);
  // a slow day: 40 minutes from sunrise round to sunrise (T jumps between the looks)
  tod.dayMinutes = new URLSearchParams(location.search).has('daylen') ? params.dayMinutes : 40;
  tod.frozen = params.freeze;
  tod.setHour(params.tod ?? TOD_PRESETS.sunrise);
  const sky = new Sky(renderer, scene);
  scene.fogNode = aerialFogNode();

  // ---- terrain, far ranges, river
  loading.status('Raising the mountains');
  const terrainM = createTerrainMaterial(hf);
  const terrain = new Terrain(hf, terrainM.material);
  if (!skip.has('terrain')) scene.add(terrain.mesh);
  const far = new FarRange(hf);
  if (!skip.has('far')) scene.add(far.mesh);
  const river = new River(hf);
  if (!skip.has('river')) scene.add(river.group);
  const birds = new Birds();
  if (!skip.has('birds')) scene.add(birds.mesh);
  const weather = new Weather(hf);
  weather.set('clear', true);

  // ---- vegetation and landmarks
  loading.status('Growing the meadows');
  setPlantSkyMaps(hf.mask0Tex, hf.heightTex, HALF_WORLD, WORLD_SIZE);
  const valley = new Valley(hf, colliders, scene);
  const valleyReady = valley.load().catch((e: unknown) => console.error('[valley] world', e));

  // ---- the horse, the ride, sound
  loading.status('Saddling the horse');
  const audio = new AudioSystem(hf);
  audio.muted = params.mute;
  const falls = site('falls');
  audio.fallsPos.set(falls.p[0], hf.height(falls.p[0], falls.p[1]), falls.p[1]);
  audio.fords = FORDS.map(([x, z]) => new THREE.Vector3(x, hf.height(x, z), z));
  const music = createMusic();
  const ride = new Ride(hf, colliders, scene, audio, valley);
  const rideReady = ride.load({ x: SPAWN.player[0], z: SPAWN.player[1], yaw: SPAWN.yaw + Math.PI });
  const input = new Input(renderer.domElement);
  const cps = new Checkpoints(hf, colliders, CHECKPOINTS, ROUTE);
  scene.add(cps.group);
  const gameUI = new GameUI();
  gameUI.visible = false;
  let game: Game | null = null;
  const ui = new RideUI((st) => {
    ride.bob = st.bob;
    music.volume(0.55 * st.volume, st.volume);
    audio.mute(params.mute || st.volume === 0);
  }, preset);
  // sound starts with the first gesture (the browser's rule)
  const startAudio = () => {
    if (audio.ctx) return;
    audio.start();
    if (audio.ctx) { music.attach(audio.ctx); music.volume(0.55 * ui.settings.volume, ui.settings.volume); }
  };
  window.addEventListener('pointerdown', startAudio);
  window.addEventListener('keydown', startAudio);
  const rig = new CameraRig(camera, {
    groundAt: (x, z) => hf.height(x, z),
    raycast: (f, d, m) => colliders.raycast(f, d, m),
  });
  let posed = false;
  if (params.cam) {
    const parts = params.cam.split(',').map(Number);
    if (parts.length === 6 && parts.every(Number.isFinite)) { rig.set({ pos: parts.slice(0, 3), target: parts.slice(3) }); posed = true; }
  }
  void SITES; void PATHS;

  engine.setupPost();
  const fwd = new THREE.Vector3();
  let rideOn = false, prevView: 'first' | 'cinematic' = 'cinematic';
  let glareK = 0;
  engine.addUpdater((dt, t) => {
    const intent0 = input.read(dt);
    const intent = game && rideOn ? game.update(dt, intent0, t) : intent0;
    if (input.hit('KeyT')) tod.setHour(nextTod(tod.hour));
    if (input.hit('KeyC') && ride.view !== 'photo') ride.setView(ride.view === 'first' ? 'cinematic' : 'first');
    if (input.hit('KeyP')) {
      if (ride.view === 'photo') { ride.setView(prevView); posed = false; } else { prevView = ride.view; ride.setView('photo'); rig.set('free'); }
    }
    weather.update(dt);
    tod.overcast = weather.cover * 0.9;
    tod.update(dt);
    if (rideOn) {
      ride.camOff = ride.view === 'photo' || posed;
      if (ride.camOff) rig.update(dt, intent, camera.position, 0, rig.yaw);
      ride.update(dt, ride.view === 'photo' || posed ? { ...intent, lookX: 0, lookY: 0, moveX: 0, moveY: 0, sprint: false } : intent, t, camera);
    } else rig.update(dt, intent, camera.position, 0, rig.yaw);
    // (test harness only: a scripted camera after the ride's, for the rider's clipping checks from fixed angles)
    const camHook = params.test ? (window as unknown as { __camHook?: (c: THREE.PerspectiveCamera) => void }).__camHook : undefined;
    if (camHook) camHook(camera);
    ui.update(input.locked, ride.view === 'photo', params.test || params.capture || !params.hud || game?.state === 'finish');
    gameUI.visible = !!game && params.hud && ride.view !== 'photo' && !gameUI.hidden;
    audio.update(dt, camera, { night: tod.night, hour: tod.hour, wind: (wetness.wind.value as number), speed: ride.horse.speed, gallop: Math.max(0, ride.horse.gait - 1) });
    atmo.camHeight.value = Math.max(1, camera.position.y);
    atmo.time.value = t;
    terrainU.time.value = t;
    wetness.time.value = t;
    camera.getWorldDirection(fwd);
    const sd = atmo.sunDir.value as THREE.Vector3;
    const facing = (fwd.x * sd.x + fwd.z * sd.z) / ((Math.hypot(fwd.x, fwd.z) || 1) * (Math.hypot(sd.x, sd.z) || 1));
    const glare = THREE.MathUtils.smoothstep(facing, 0.2, 0.92) * (1 - THREE.MathUtils.smoothstep(sd.y, 0.12, 0.45)) * (sd.y > -0.04 ? 1 : 0);
    glareK += (glare - glareK) * (1 - Math.exp(-dt * 2.0));
    // (Island's meter keys noon bright for white sand and surf; a green valley under the same key washes out to pale
    // straw, so the day is keyed about half a stop lower: RDR2's meadows sit mid-tone and saturated. The night keeps
    // its own key.)
    const dayKey = THREE.MathUtils.lerp(0.8, 1, tod.night);
    // (NEXT4 loop 2: the glare stop-down left every into-the-sun golden-hour frame near black; the eye and RDR2's
    // camera keep the foreground readable against a low sun, so only a little of it remains, and a low sun is keyed
    // up half a stop)
    const lowKey = 1 + 0.45 * (1 - THREE.MathUtils.smoothstep(tod.sunElevation, 0.06, 0.42)) * (1 - tod.night);
    grade.exposure.value = tod.exposure * dayKey * lowKey * (1 - 0.2 * glareK);
    // (the sky's light into the shade: a shadow on open ground under a clear sky is blue-grey, never black)
    scene.environmentIntensity = THREE.MathUtils.lerp(2.0, 1, tod.night);
    // NEXT4 §3: the valley's aerial perspective (RDR2-REFERENCE.md): each range behind the next a step paler and bluer
    // (visibility ~12 km by day), and at a low sun the air thickens into the golden backlit haze of the clips
    const lowSun = (1 - THREE.MathUtils.smoothstep(tod.sunElevation, 0.04, 0.42)) * (1 - tod.night);
    // (the valley's ranges stand only 0.5-1.5 km off, against RDR2's tens of km: the air is thickened so they step back as
    // the big ranges in the references do)
    atmo.haze.value = 4.8e-4 * (1 + 1.0 * lowSun);
    camera.updateMatrixWorld();
    terrain.update(camera, Q.shadowFar);
    valley.update(camera, dt, t, tod.night, tod.hour);
    audio.campPos.copy(valley.firePos);
    vegU.time.value = t;
    vegU.viewPos.value.setFromMatrixPosition(camera.matrixWorld);
    vegU.sunColor.value.copy(sunLight.color).multiplyScalar(sunLight.intensity);
    river.update(t);
    birds.update(t, tod.night, camera.position);
    const wdir = wetness.windDir.value as THREE.Vector2;
    sky.setDrift(wdir.x, wdir.y, t, tod.hour);
    sky.update(dt, scene);
    (sprayU.sun.value as THREE.Color).copy(sunLight.color).multiplyScalar(sunLight.intensity);
  });

  const layersReady = terrainM.loadLayers().catch((e) => console.warn('terrain layers', e));
  sky.update(0, scene, true);
  if (sky.envRT) river.setEnvironment(sky.envRT.texture);
  terrain.update(camera, Q.shadowFar);
  engine.asyncPipelines = true;
  engine.start();
  const frame = async () => {
    const f = engine.frame;
    while (engine.frame <= f) await new Promise((r) => setTimeout(r, 4));
  };
  await Promise.all([layersReady, valleyReady, rideReady]);
  rideOn = true;
  ride.place(SPAWN.player[0], SPAWN.player[1], SPAWN.yaw + Math.PI);
  // (third person by default, so the horse and rider are in the picture; C switches to her eyes)
  ride.setView('cinematic');
  loading.status('Settling');
  const t0 = performance.now();
  while (engine.pipelinesPending > 0 && performance.now() - t0 < 120000) await frame();
  await refreshMeasured;
  loading.progress(1);
  await loading.done();
  engine.resetPacing();
  game = new Game({ ride, audio, tod, ui: gameUI, cps, driveTime: params.tod == null, spawn: { x: SPAWN.player[0], z: SPAWN.player[1], yaw: SPAWN.yaw + Math.PI }, fire: valley.firePos });
  const w = window as unknown as Record<string, unknown>;
  w.__valley = { ready: true, engine, tod, rig, hf, valley, camera, THREE, scene, ride, audio, music, input, colliders, PATHS, SITES, ROUTE, game, cps, gameUI, setPosed: (v: boolean) => { posed = v; }, stats: () => engine.stats() };
  console.info('[valley] ready');
}

/** T steps round this ring from the entry nearest the current hour: sunrise, then straight to golden hour and on
 * through the sunset in short steps (the recording's hours), dusk, night, and noon before sunrise again */
const CYCLE = [TOD_PRESETS.sunrise, 16.6, 17.0, TOD_PRESETS.sunset, TOD_PRESETS.dusk, 21.5, TOD_PRESETS.noon];
function nextTod(h: number) {
  const d = (a: number) => Math.abs(((a - h + 36) % 24) - 12);
  let k = 0;
  for (let i = 1; i < CYCLE.length; i++) if (d(CYCLE[i]) < d(CYCLE[k])) k = i;
  return CYCLE[(k + 1) % CYCLE.length];
}

boot().catch((e) => {
  console.error(e);
  const el = document.getElementById('load-status');
  if (el) el.textContent = `Error: ${e?.message ?? e}`;
  (window as unknown as { __valley?: { error?: string } }).__valley = { error: String(e?.stack ?? e) };
});
