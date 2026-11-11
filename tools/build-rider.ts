/**
 * The rider for the game: build/blender/rider/rider.raw.glb (exported by tools/blender/rider/rider_rig.py) ->
 * public/assets/rider/rider.glb (textures as UASTC KTX2, geometry meshopt-compressed).
 *
 * What is in it: her rig ("rider_rig", the clip "ride": one gallop stride, its time the stride phase), her body, hair
 * cards and stirrups on that rig; the saddle and bridle ("tack") on "tack_rig", a copy of the horse's skeleton that
 * the runtime rebinds to the horse's own bones (src/valley/ride/Rider.ts).
 *
 *   npx tsx tools/build-rider.ts
 *
 * CPU on purpose: one small file, a few seconds (the KTX2 encoder is wasm).
 */
import fs from 'node:fs';
import sharp from 'sharp';
import { NodeIO, type Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRTextureBasisu } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, resample } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { encodeToKTX2 } from 'ktx2-encoder';

const RAW = 'build/blender/rider/rider.raw.glb', OUT = 'public/assets/rider';
const BUDGET = { rider: 36000, hair: 16000, tack: 16000, influences: 4, megabytes: 3 };

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const doc: Document = await io.read(RAW);
const root = doc.getRoot();

// names without Blender's .001 suffixes (the runtime finds the parts by name)
for (const m of root.listMeshes()) m.setName(m.getName().replace(/\.\d+$/, ''));
for (const n of root.listNodes()) n.setName(n.getName().replace(/\.\d+$/, ''));

// ---- the clip
const anims = root.listAnimations();
if (anims.length !== 1) throw new Error(`rider.raw.glb has ${anims.length} clips, want the one "ride"`);
anims[0].setName('ride');
const keys = anims[0].listSamplers()[0].getInput()!.getCount();
if (keys !== 241) throw new Error(`"ride" has ${keys} keys, want 241 (240 per stride + the loop's end)`);

// ---- counts against the budget
const count: Record<string, number> = { rider: 0, hair: 0, tack: 0, leathers: 0 };
let maxInf = 0;
for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
  const n = (p.getIndices()?.getCount() ?? p.getAttribute('POSITION')!.getCount()) / 3;
  const k = mesh.getName() === 'rider_hair' ? 'hair' : mesh.getName() === 'tack' ? 'tack' : mesh.getName() === 'leathers' ? 'leathers' : 'rider';
  count[k] += n;
  const w = p.getAttribute('WEIGHTS_0');
  if (w) for (let i = 0; i < w.getCount(); i++) maxInf = Math.max(maxInf, w.getElement(i, []).filter((x) => x > 0).length);
  if (p.getAttribute('WEIGHTS_1')) maxInf = 8;
}
console.log(`[rider] triangles: body ${count.rider} / ${BUDGET.rider}, hair cards ${count.hair} / ${BUDGET.hair}, tack ${count.tack} / ${BUDGET.tack}, stirrups ${count.leathers}; influences ${maxInf}; clip "ride" ${keys} keys`);
if (count.rider > BUDGET.rider || count.hair > BUDGET.hair || count.tack > BUDGET.tack || maxInf > BUDGET.influences) throw new Error('over budget');

// ---- materials and textures -> KTX2 (colour sRGB, the rest linear)
for (const m of root.listMaterials()) if (m.getName() === 'rider_hair' || m.getName() === 'rider_lash') m.setAlphaMode('MASK').setAlphaCutoff(0.4).setDoubleSided(true);
const srgb = new Set(root.listMaterials().map((m) => m.getBaseColorTexture()).filter(Boolean));
for (const t of root.listTextures()) {
  const png: Uint8Array = t.getImage()!;
  const ktx = await encodeToKTX2(new Uint8Array(png), {
    // (her skin, where the face is, keeps the finer setting; cloth, hair and tack are busier and take more)
    isUASTC: true, generateMipmap: true, needSupercompression: true, enableRDO: true, rdoQualityLevel: t.getName() === 'rider_skin_c' ? 1.4 : 2.6,
    isSetKTX2SRGBTransferFunc: srgb.has(t), isPerceptual: srgb.has(t),
    imageDecoder: async (buf: Uint8Array) => {
      const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { data: new Uint8Array(data), width: info.width, height: info.height };
    },
  } as Parameters<typeof encodeToKTX2>[1]);
  console.log(`[rider] texture ${t.getName()}: ${(png.byteLength / 1024).toFixed(0)} KB png -> ${(ktx.length / 1024).toFixed(0)} KB ktx2${srgb.has(t) ? ' (sRGB)' : ''}`);
  t.setImage(ktx).setMimeType('image/ktx2');
}
doc.createExtension(KHRTextureBasisu).setRequired(true);

// ---- geometry: meshopt
// (the clip: keys that a straight line between their neighbours already gives are dropped - her ride is smooth)
await doc.transform(dedup(), resample({ tolerance: 1e-4 }), prune({ keepLeaves: true, keepAttributes: true }), meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }));
fs.mkdirSync(OUT, { recursive: true });
await io.write(`${OUT}/rider.glb`, doc);
const mb = fs.statSync(`${OUT}/rider.glb`).size / 1048576;
console.log(`[rider] ${OUT}/rider.glb ${mb.toFixed(2)} MB / ${BUDGET.megabytes} MB`);
if (mb > BUDGET.megabytes) throw new Error('rider.glb is over its size budget');
