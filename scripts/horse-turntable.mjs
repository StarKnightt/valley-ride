// Encodes the horse's turntable frames (build/blender/horse/turntable/, rendered by
// tools/blender/horse/horse_turntable.py) into tools/blender/horse/turntable.mp4 with NVENC, and makes the contact
// sheet tools/blender/horse/turntable.jpg (8 views). The encoder is asserted: no silent fall back to libx264.
//   node scripts/horse-turntable.mjs [--allow-software]
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';

const DIR = 'build/blender/horse/turntable', OUT = 'tools/blender/horse';
const frames = fs.readdirSync(DIR).filter((f) => /^\d{4}\.png$/.test(f)).sort();
if (!frames.length) throw new Error(`no frames in ${DIR}`);
const soft = process.argv.includes('--allow-software');
const enc = soft ? ['-c:v', 'libx264', '-crf', '18'] : ['-c:v', 'h264_nvenc', '-preset', 'p6', '-rc', 'vbr', '-cq', '21', '-b:v', '0'];
const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-stats', '-framerate', '24', '-i', `${DIR}/%04d.png`, ...enc, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${OUT}/turntable.mp4`], { stdio: 'inherit' });
if (r.status !== 0) throw new Error(soft ? 'ffmpeg failed' : 'ffmpeg with h264_nvenc failed (no NVENC?): not falling back to the CPU encoder');
console.log(`[turntable] encoder ${soft ? 'libx264 (CPU, --allow-software)' : 'h264_nvenc (GPU)'}: ${OUT}/turntable.mp4 ${(fs.statSync(`${OUT}/turntable.mp4`).size / 1024).toFixed(0)} KB, ${frames.length} frames`);
const N = 8, TW = 640, TH = 360, comps = [];
for (let i = 0; i < N; i++) comps.push({ input: await sharp(`${DIR}/${frames[Math.floor((i * frames.length) / N)]}`).resize(TW, TH).toBuffer(), left: (i % 4) * TW, top: Math.floor(i / 4) * TH });
await sharp({ create: { width: 4 * TW, height: 2 * TH, channels: 3, background: '#000' } }).composite(comps).jpeg({ quality: 86 }).toFile(`${OUT}/turntable.jpg`);
console.log(`[turntable] sheet ${OUT}/turntable.jpg`);
