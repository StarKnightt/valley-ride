// A short clip of her riding at the full gallop in the open meadow, from a camera held on the horse's front
// quarter: recorded from the page's compositor (CDP screencast) and encoded on the GPU (h264_nvenc; no CPU fallback).
//
//   node scripts/rider-clip.mjs [out.mp4] [seconds] [hour]     -> build/rider-clip/rider.mp4, 5 s, 12.3 h
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startValley } from './lib/vharness.mjs';
import { gallopInMeadow, holdCamera } from './lib/ridercam.mjs';

const out = process.argv[2] ?? 'build/rider-clip/rider.mp4';
const secs = Number(process.argv[3] ?? 5), hour = Number(process.argv[4] ?? 12.3);
fs.mkdirSync(path.dirname(out), { recursive: true });
const h = await startValley({ query: 'test=1&mute=1&freeze=1&hud=0&tod=12' });
const { page } = h;
let ff;
const killFF = () => { try { ff?.stdin.end(); } catch {} };
process.on('exit', () => { try { ff?.kill(); } catch {} });
try {
  await gallopInMeadow(page, hour);
  await holdCamera(page, { bearing: -42, height: 1.95, dist: 3.9, fov: 30, at: 'rider' });
  await page.waitForTimeout(5000);
  ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'mjpeg', '-use_wallclock_as_timestamps', '1', '-i', 'pipe:0',
    '-r', '30', '-c:v', 'h264_nvenc', '-preset', 'p6', '-cq', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  let failed = null;
  ff.on('error', (e) => { failed = e; });
  const cdp = await page.context().newCDPSession(page);
  let frames = 0;
  cdp.on('Page.screencastFrame', async (f) => {
    frames++;
    try { ff.stdin.write(Buffer.from(f.data, 'base64')); } catch {}
    try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch {}
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  await page.waitForTimeout(secs * 1000);
  await cdp.send('Page.stopScreencast');
  killFF();
  const code = await new Promise((r) => ff.on('close', r));
  if (failed || code !== 0) throw new Error(`ffmpeg with h264_nvenc failed (${failed?.message ?? `exit ${code}`}): not falling back to the CPU encoder`);
  const st = await page.evaluate(() => ({ speed: window.__valley.ride.horse.speed, fps: window.__valley.stats().fps }));
  console.log(`[clip] ${out}: ${frames} frames in ${secs} s, encoder h264_nvenc (GPU); speed ${st.speed.toFixed(1)} m/s, render fps ${st.fps.toFixed(0)}; ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
  h.assertClean();
  await h.teardown(0);
} catch (e) {
  killFF();
  await h.teardown(1, e);
}
