// Two clips of the horse and rider in the open meadow at sunset, from the running game: 10 s of the gallop pulled up
// to a halt, then 30 s standing still (the idle layers: src/valley/ride/HorseIdle.ts, Rider.ts). Recorded from the
// page's compositor (CDP screencast) and encoded on the GPU (h264_nvenc; no CPU fallback), a contact sheet beside each.
//
//   node scripts/idle-clips.mjs [outDir] [hour]      -> build/idle-clips/{stop,stand}.mp4 and .jpg sheets
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startValley } from './lib/vharness.mjs';
import { gallopInMeadow, holdCamera } from './lib/ridercam.mjs';

const outDir = process.argv[2] ?? 'build/idle-clips';
const hour = Number(process.argv[3] ?? 17.45);
fs.mkdirSync(outDir, { recursive: true });
const h = await startValley({ query: 'test=1&mute=1&freeze=1&hud=0&tod=12' });
const { page } = h;
const children = new Set();
process.on('exit', () => { for (const c of children) try { c.kill(); } catch {} });

/** run ffmpeg with h264_nvenc to completion; throws (no CPU fallback) if it fails */
const ffmpeg = (args, input) => new Promise((resolve, reject) => {
  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: [input ? 'pipe' : 'ignore', 'inherit', 'inherit'] });
  children.add(ff);
  ff.on('error', reject);
  ff.on('close', (code) => { children.delete(ff); code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)); });
  if (input) input(ff);
});

/** record `secs` of the page into `file` (call `during` once recording has started) */
async function record(file, secs, during) {
  const cdp = await page.context().newCDPSession(page);
  let frames = 0, feed;
  const done = ffmpeg(['-f', 'mjpeg', '-use_wallclock_as_timestamps', '1', '-i', 'pipe:0', '-r', '30', '-c:v', 'h264_nvenc', '-preset', 'p6', '-cq', '20',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], (ff) => { feed = ff; });
  cdp.on('Page.screencastFrame', async (f) => {
    frames++;
    try { feed.stdin.write(Buffer.from(f.data, 'base64')); } catch {}
    try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch {}
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  const t0 = Date.now();
  if (during) await during();
  await page.waitForTimeout(Math.max(0, secs * 1000 - (Date.now() - t0)));
  await cdp.send('Page.stopScreencast');
  await cdp.detach();
  feed.stdin.end();
  await done.catch((e) => { throw new Error(`h264_nvenc failed (${e.message}): not falling back to the CPU encoder`); });
  // a contact sheet: one frame every secs/12, decoded on the GPU
  const sheet = file.replace(/\.mp4$/, '.jpg');
  await ffmpeg(['-hwaccel', 'cuda', '-i', file, '-vf', `fps=${12 / secs},scale=640:-1,tile=4x3`, '-frames:v', '1', '-q:v', '3', sheet]);
  console.log(`[clip] ${file}: ${frames} frames in ${secs} s, h264_nvenc; sheet ${sheet}`);
}

try {
  await gallopInMeadow(page, hour);
  // (gallop out into the open first)
  await page.waitForTimeout(4300);
  await holdCamera(page, { bearing: 84, height: 1.7, dist: 9.5, fov: 32, look: 1.3 });
  await page.waitForTimeout(500);
  const sp0 = await page.evaluate(() => window.__valley.ride.horse.speed);
  console.log(`[clip] galloping at ${sp0.toFixed(1)} m/s`);
  await record(path.join(outDir, 'stop.mp4'), 10, async () => {
    await page.waitForTimeout(1200);
    await page.evaluate(() => { window.__valley.input.scripted = { t: 9999, intent: {} }; });
  });
  const sp1 = await page.evaluate(() => ({ speed: window.__valley.ride.horse.speed, still: window.__valley.ride.horse.stillness }));
  console.log(`[clip] after the halt: speed ${sp1.speed.toFixed(2)} m/s, stillness ${sp1.still.toFixed(2)}`);
  await page.waitForTimeout(1500);
  await holdCamera(page, { bearing: 62, height: 1.75, dist: 6.2, fov: 34, look: 1.45 });
  await page.waitForTimeout(300);
  await record(path.join(outDir, 'stand.mp4'), 30);
  const st = await page.evaluate(() => ({ fps: window.__valley.stats().fps, blown: window.__valley.ride.horse.idle.blown }));
  console.log(`[clip] render ${st.fps.toFixed(0)} fps; horse blown ${st.blown.toFixed(2)}`);
  h.assertClean();
  await h.teardown(0);
} catch (e) {
  for (const c of children) try { c.kill(); } catch {}
  await h.teardown(1, e);
}
