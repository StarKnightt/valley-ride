/**
 * Valley terrain layers: River Morning's packed Poly Haven maps (WebP, `_ch` = colour + height, `_nr` = normal XY +
 * roughness + AO, the same packing Island's KTX2 layers use) re-encoded as UASTC KTX2 with mipmaps, the albedo
 * normalised in linear space to a target mean so every layer sits in one tonal range (Island's build-assets recipe).
 * Grass, dirt and moss are Island's own layers, copied as they are.
 *
 *   npx tsx tools/build-valley-tex.ts      -> public/assets/terrain/<id>_a.ktx2, <id>_n.ktx2
 */
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeToKTX2 } from 'ktx2-encoder';

const SRC = join(import.meta.dirname, '..', 'public', 'assets', 'tex');
const OUT = join(import.meta.dirname, '..', 'public', 'assets', 'terrain');
const SIZE = 1024;

const LAYERS: { id: string; src: string; target: [number, number, number] }[] = [
  { id: 'pebbles', src: 'ganges_river_pebbles', target: [0.24, 0.215, 0.18] },
  { id: 'pebbles_wet', src: 'river_small_rocks_ch_1k', target: [0.1, 0.092, 0.078] },
  { id: 'forest', src: 'forrest_ground_03_ch_1k', target: [0.075, 0.058, 0.038] },
  { id: 'granite', src: 'rocky_terrain_02', target: [0.17, 0.16, 0.148] },
  { id: 'snow', src: 'snow_02', target: [0.72, 0.75, 0.8] },
];

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

async function rgba(path: string) {
  const { data } = await sharp(path).resize(SIZE, SIZE, { kernel: 'lanczos3' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return new Uint8Array(data);
}

async function encode(px: Uint8Array, srgb: boolean, out: string) {
  const png = await sharp(Buffer.from(px), { raw: { width: SIZE, height: SIZE, channels: 4 } }).png().toBuffer();
  const ktx = await encodeToKTX2(new Uint8Array(png), {
    isUASTC: true,
    generateMipmap: true,
    needSupercompression: true,
    enableRDO: true,
    rdoQualityLevel: 1.2,
    isSetKTX2SRGBTransferFunc: srgb,
    isPerceptual: srgb,
    imageDecoder: async (buf: Uint8Array) => {
      const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { data: new Uint8Array(data), width: info.width, height: info.height };
    },
  } as Parameters<typeof encodeToKTX2>[1]);
  writeFileSync(out, ktx);
  return ktx.length;
}

for (const L of LAYERS) {
  const k = L.src.endsWith('_1k');
  const base = k ? L.src.replace('_ch_1k', '') : L.src;
  const ch = await rgba(join(SRC, `${base}_ch${k ? '_1k' : ''}.webp`));
  const nr = await rgba(join(SRC, `${base}_nr${k ? '_1k' : ''}.webp`));
  const n = SIZE * SIZE;
  const mean = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) mean[c] += toLin(ch[i * 4 + c] / 255);
  const gain = mean.map((m, c) => L.target[c] / Math.max(m / n, 1e-4));
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) ch[i * 4 + c] = Math.round(toSrgb(Math.min(1, toLin(ch[i * 4 + c] / 255) * gain[c])) * 255);
  const a = await encode(ch, true, join(OUT, `${L.id}_a.ktx2`));
  const b = await encode(nr, false, join(OUT, `${L.id}_n.ktx2`));
  console.log(`${L.id.padEnd(12)} <- ${L.src.padEnd(26)} gain ${gain.map((g) => g.toFixed(2)).join(',')}  ${(a / 1024).toFixed(0)} + ${(b / 1024).toFixed(0)} KB`);
}
