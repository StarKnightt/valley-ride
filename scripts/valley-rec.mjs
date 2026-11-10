// Quality-gate recordings: a ride on autopilot along a trail, recorded from the page's compositor (CDP screencast)
// and encoded on the GPU (h264_nvenc), then one frame every few seconds extracted for review.
//   node scripts/valley-rec.mjs <name> --gait=walk|trot|gallop --secs=60 --tod=9.5 [--from=0] [--view=first|cinematic]
// --from: index into the trail loop's waypoints to start at (the ford crossing is near 2..4).
import { startValley } from './lib/vharness.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const name = process.argv[2] ?? 'ride';
const dir = `build/rec/${name}`;
fs.mkdirSync(dir, { recursive: true });
const secs = Number(arg('secs', 60));
const gait = arg('gait', 'walk');
const speed = { walk: 1.75, trot: 3.9, gallop: 10 }[gait] ?? Number(gait);
const h = await startValley({ query: `test=1&mute=1&tod=${arg('tod', '9.5')}&daylen=${arg('daylen', 240)}` });
const { page } = h;
let ff;
const killFF = () => { try { ff?.stdin.end(); } catch {} };
process.on('exit', () => { try { ff?.kill(); } catch {} });
try {
  await page.evaluate(({ speed, from, view }) => {
    const v = window.__valley, T = v.THREE;
    const SPOT = { camp: [112, -52], obelisk: [-372, -452], ruins: [-400, 220], bones: [70, 400], statue: [360, -160] };
    const pts = [];
    for (const path of v.PATHS) for (const [x, z] of path) {
      let p = [x, z];
      for (const s of v.SITES) if (s.r > 0 && Math.hypot(x - s.p[0], z - s.p[1]) < 4 && SPOT[s.name]) p = SPOT[s.name];
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(last.x - p[0], last.y - p[1]) > 3) pts.push(new T.Vector2(p[0], p[1]));
    }
    const a = pts[from], b = pts[from + 1];
    v.ride.place(a.x, a.y, Math.atan2(b.x - a.x, b.y - a.y));
    v.ride.auto = { pts, i: from + 1, speed, done: false };
    v.ride.setView(view);
  }, { speed, from: Number(arg('from', 0)), view: arg('view', 'first') });
  await page.waitForTimeout(2500);
  ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'mjpeg', '-use_wallclock_as_timestamps', '1', '-i', 'pipe:0',
    '-r', '30', '-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', '22', '-pix_fmt', 'yuv420p', `${dir}/${name}.mp4`], { stdio: ['pipe', 'inherit', 'inherit'] });
  const cdp = await page.context().newCDPSession(page);
  let frames = 0;
  cdp.on('Page.screencastFrame', async (f) => {
    frames++;
    try { ff.stdin.write(Buffer.from(f.data, 'base64')); } catch {}
    try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch {}
  });
  await page.evaluate(() => window.__valley.engine.resetPacing?.());
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  const t0 = Date.now();
  const log = [];
  while (Date.now() - t0 < secs * 1000) {
    await page.waitForTimeout(1000);
    log.push(await page.evaluate(() => { const r = window.__valley.ride; return { t: performance.now(), x: r.pos.x, y: r.pos.y, z: r.pos.z, sp: r.horse.speed, g: r.horse.gait, d: r.depth, fps: window.__valley.stats().fps }; }));
  }
  await cdp.send('Page.stopScreencast');
  killFF();
  await new Promise((r) => ff.on('close', r));
  const fps = log.map((l) => l.fps);
  console.log(`[rec] ${name}: ${frames} frames in ${secs} s (${(frames / secs).toFixed(1)}/s captured), render fps avg ${(fps.reduce((a, b) => a + b, 0) / fps.length).toFixed(1)}, max depth ${Math.max(...log.map((l) => l.d)).toFixed(2)}, speed avg ${(log.reduce((a, l) => a + l.sp, 0) / log.length).toFixed(1)}`);
  fs.writeFileSync(`${dir}/log.json`, JSON.stringify(log));
  // review frames: one every 5 s, and a contact sheet
  await new Promise((r) => spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-hwaccel', 'cuda', '-i', `${dir}/${name}.mp4`, '-vf', 'fps=1/5,scale=640:-1', `${dir}/f%02d.png`], { stdio: 'inherit' }).on('close', r));
  await new Promise((r) => spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-hwaccel', 'cuda', '-i', `${dir}/${name}.mp4`, '-vf', 'fps=1/5,scale=480:-1,tile=4x3', '-frames:v', '1', `${dir}/sheet.png`], { stdio: 'inherit' }).on('close', r));
  h.assertClean();
  await h.teardown(0);
} catch (e) {
  killFF();
  await h.teardown(1, e);
}
