/**
 * The horse for the game: build/blender/horse/horse.raw.glb (exported by tools/blender/horse/horse_anim.py) ->
 * public/assets/horse/horse.glb (textures as UASTC KTX2, geometry meshopt-compressed) and horse.json (what the
 * runtime needs beside the mesh: the gallop's stride and period, the lead, and where the gallop test's joints sit
 * on which bones at rest). Prints triangle, bone and influence counts against the budget and fails over it.
 *
 *   npx tsx tools/build-horse.ts
 *
 * CPU on purpose: one small file, a few seconds (the KTX2 encoder is wasm).
 */
import fs from 'node:fs';
import sharp from 'sharp';
import { NodeIO, type Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRTextureBasisu } from '@gltf-transform/extensions';
import { dedup, meshopt, prune } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { encodeToKTX2 } from 'ktx2-encoder';

const RAW = 'build/blender/horse/horse.raw.glb', OUT = 'public/assets/horse';
const BUDGET = { triangles: 14000, hair: 2000, bones: 60, influences: 4, megabytes: 4 };
const design = JSON.parse(fs.readFileSync('tools/blender/horse/gallop.design.json', 'utf8'));
// the hindquarters' corrective shapes: a morph weight per gallop key (tools/blender/horse/horse_correct.py)
const correctives = JSON.parse(fs.readFileSync('tools/blender/horse/correctives.json', 'utf8')) as { n: number; weights: Record<string, number[]> };

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const doc: Document = await io.read(RAW);
const root = doc.getRoot();

// ---- counts against the budget
let tris = 0, hair = 0, maxInf = 0;
for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
  const n = (p.getIndices()?.getCount() ?? p.getAttribute('POSITION')!.getCount()) / 3;
  if (p.getMaterial()?.getName() === 'horse_hair') hair += n; else tris += n;
  const w = p.getAttribute('WEIGHTS_0');
  if (w) for (let i = 0; i < w.getCount(); i++) maxInf = Math.max(maxInf, w.getElement(i, []).filter((x) => x > 0).length);
  if (p.getAttribute('WEIGHTS_1')) maxInf = 8;
}
const bones = root.listSkins()[0].listJoints().length;
const morphs = root.listMeshes().flatMap((m) => ((m.getExtras() as { targetNames?: string[] }).targetNames ?? []));
for (const k of Object.keys(correctives.weights)) if (!morphs.includes(k)) throw new Error(`horse.raw.glb has no morph target ${k} (shape keys: ${morphs.join(', ') || 'none'})`);
console.log(`[horse] morph targets: ${morphs.join(', ')}`);
const anims = root.listAnimations().map((a) => `${a.getName()} (${a.listChannels().length} channels, ${a.listSamplers()[0].getInput()!.getCount()} keys, ${a.listSamplers()[0].getInput()!.getMax([])[0].toFixed(3)} s)`);
console.log(`[horse] triangles ${tris} / ${BUDGET.triangles}, mane and tail cards ${hair} / ${BUDGET.hair}, deform bones ${bones} / ${BUDGET.bones}, influences per vertex ${maxInf} / ${BUDGET.influences}`);
console.log(`[horse] clips: ${anims.join(', ')}`);
if (tris > BUDGET.triangles || hair > BUDGET.hair || bones > BUDGET.bones || maxInf > BUDGET.influences) throw new Error('over budget');

// ---- textures -> KTX2 (colour sRGB, the rest linear)
const srgb = new Set(root.listMaterials().map((m) => m.getBaseColorTexture()).filter(Boolean));
// the mane and tail cards: alpha-tested, seen from both sides
for (const m of root.listMaterials()) if (m.getName() === 'horse_hair') m.setAlphaMode('MASK').setAlphaCutoff(0.42).setDoubleSided(true);
// sizes: colour at 2K, the normal and occlusion-roughness maps at 1K (the forms are in the mesh; the maps carry
// tendons, joints and the smoothing of the reduced surface), the hair strands as baked
const SIZE: Record<string, number> = { horse_c: 2048, horse_n: 1024, horse_orm: 1024 };
for (const t of root.listTextures()) {
  let png: Uint8Array = t.getImage()!;
  const want = SIZE[t.getName()];
  if (want) png = new Uint8Array(await sharp(png).resize(want, want, { kernel: 'lanczos3' }).png().toBuffer());
  const ktx = await encodeToKTX2(new Uint8Array(png), {
    isUASTC: true, generateMipmap: true, needSupercompression: true, enableRDO: true, rdoQualityLevel: t.getName() === 'horse_c' ? 1.6 : 1.2,
    isSetKTX2SRGBTransferFunc: srgb.has(t), isPerceptual: srgb.has(t),
    imageDecoder: async (buf: Uint8Array) => {
      const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { data: new Uint8Array(data), width: info.width, height: info.height };
    },
  } as Parameters<typeof encodeToKTX2>[1]);
  console.log(`[horse] texture ${t.getName() || t.getURI()}: ${(png.byteLength / 1024).toFixed(0)} KB png -> ${(ktx.length / 1024).toFixed(0)} KB ktx2${srgb.has(t) ? ' (sRGB)' : ''}`);
  t.setImage(ktx).setMimeType('image/ktx2');
}
doc.createExtension(KHRTextureBasisu).setRequired(true);

// ---- geometry: meshopt. The animation is left exactly as exported (no resampling, no quantisation): the gallop
// test measures it to the centimetre.
await doc.transform(dedup(), prune({ keepLeaves: true, keepAttributes: true }), meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }));
fs.mkdirSync(OUT, { recursive: true });
await io.write(`${OUT}/horse.glb`, doc);

// ---- what the runtime needs beside the mesh
const toModel = (pos: [number, number], lat: number) => [lat, pos[1], pos[0]]; // side view (x fwd, y up) -> x left, y up, z forward
const meta = {
  note: 'generated by tools/build-horse.ts from tools/blender/horse/gallop.design.json',
  lead: design.lead, stride: design.keys.stride, period: design.keys.period, speed: design.keys.speed, keysPerStride: design.keys.n,
  triangles: tris, hairTriangles: hair, bones,
  correctives: correctives.weights,
  markers: Object.fromEntries(Object.entries(design.rest.markers as Record<string, { bone: string; pos: [number, number]; lat: number }>).map(([k, m]) => [k, { bone: m.bone, at: toModel(m.pos, m.lat).map((v) => Number(v.toFixed(5))) }])),
};
fs.writeFileSync(`${OUT}/horse.json`, JSON.stringify(meta, null, 1) + '\n');
const mb = fs.statSync(`${OUT}/horse.glb`).size / 1048576;
console.log(`[horse] ${OUT}/horse.glb ${mb.toFixed(2)} MB / ${BUDGET.megabytes} MB, horse.json`);
if (mb > BUDGET.megabytes) throw new Error('horse.glb is over its size budget');
