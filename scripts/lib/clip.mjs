// Record the running game's page to an MP4: the page's compositor frames (CDP screencast) piped to ffmpeg and encoded
// on the GPU (h264_nvenc; it fails rather than falling back to the CPU encoder), with a contact sheet beside each clip
// decoded on the GPU too. The ffmpeg children are killed on every exit path.
import { spawn } from 'node:child_process';

export function recorder(page) {
  const children = new Set();
  const killAll = () => { for (const c of children) try { c.kill(); } catch {} };
  process.on('exit', killAll);

  const ffmpeg = (args, input) => new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: [input ? 'pipe' : 'ignore', 'inherit', 'inherit'] });
    children.add(ff);
    ff.on('error', reject);
    ff.on('close', (code) => { children.delete(ff); code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)); });
    if (input) input(ff);
  });

  /** record `secs` of the page into `file` (call `during` once recording has started); a 4x3 sheet beside it */
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
    const sheet = file.replace(/\.mp4$/, '.jpg');
    await ffmpeg(['-hwaccel', 'cuda', '-i', file, '-vf', `fps=${12 / secs},scale=640:-1,tile=4x3`, '-frames:v', '1', '-q:v', '3', sheet]);
    console.log(`[clip] ${file}: ${frames} frames in ${secs} s, h264_nvenc; sheet ${sheet}`);
  }

  return { record, killAll };
}
