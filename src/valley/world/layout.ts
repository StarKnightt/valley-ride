/**
 * The authored layout of the valley, shared by the offline terrain baker (tools/gen-valley.ts) and the game.
 *
 * Coordinates are metres: +x east, +z south, +y up. The baked square is 2048 m on a side, centred on the origin; the
 * valley floor (about 1.8 km across) is ringed by mountains whose crest stands inside the square, so the square's
 * edge is never seen from the floor. Far ranges beyond it are drawn separately (world/FarRange.ts).
 * The sun rises in the east (+x) and sets in the west.
 */
export const WORLD_SIZE = 2048;
export const HALF_WORLD = WORLD_SIZE / 2;
/** heightmap texels per side (1 m per texel) */
export const HEIGHT_RES = 2048;
/** mask texels per side (2 m per texel) */
export const MASK_RES = 1024;
/** heights are stored as uint16 between these bounds */
export const H_MIN = -20;
export const H_MAX = 620;

export type V2 = [number, number];

/** broad elevation blobs of the valley floor (smooth-max combined over the rolling base) */
export interface Hill { p: V2; r: number; h: number; e: number; rocky?: number }
export const HILLS: Hill[] = [
  // the statue's hill, east of the camp: a rounded crown over the meadows
  { p: [390, -190], r: 190, h: 52, e: 1.5 },
  // the obelisk ridge in the north-west, a long whaleback toward the mountains
  { p: [-400, -430], r: 230, h: 78, e: 1.3, rocky: 0.4 },
  { p: [-520, -560], r: 200, h: 96, e: 1.3, rocky: 0.6 },
  // the ruins' terrace in the south-west (levelled in the bake)
  { p: [-430, 190], r: 210, h: 34, e: 1.8 },
  // rocky knolls on the floor
  { p: [250, 255], r: 120, h: 40, e: 1.2, rocky: 0.9 },
  { p: [-250, -130], r: 115, h: 30, e: 1.3, rocky: 0.7 },
  { p: [560, 140], r: 170, h: 66, e: 1.4, rocky: 0.5 },
  { p: [-640, -40], r: 190, h: 70, e: 1.3, rocky: 0.5 },
  { p: [-120, 520], r: 200, h: 40, e: 1.6 },
  { p: [420, 560], r: 170, h: 58, e: 1.4, rocky: 0.6 },
];

/**
 * The inner foot of the mountain ring by bearing (radius from the centre, m). Mountains rise from here to their crest
 * ~170 m further out. The north side comes closest: the falls drop off its foot.
 */
export function ringFoot(theta: number) {
  // theta = atan2(z, x); north is theta = -pi/2
  const n = Math.cos(theta + Math.PI / 2); // 1 toward north
  return 820 - 70 * Math.max(0, n) ** 2 + 30 * Math.sin(theta * 3 + 0.7) + 18 * Math.sin(theta * 7 - 1.3);
}

/** river: from a cleft in the northern range, over the falls into its pool, across the valley to the south-east gorge */
export interface RiverPoint { p: V2; w: number; depth: number }
export const RIVER: RiverPoint[] = [
  { p: [-372, -812], w: 4.0, depth: 0.6 },
  { p: [-300, -800], w: 4.5, depth: 0.6 },
  { p: [-236, -774], w: 5.0, depth: 0.6 },
  { p: [-198, -726], w: 5.5, depth: 0.6 },
  // the lip of the falls
  { p: [-182, -680], w: 6.0, depth: 0.5 },
  // the plunge pool below
  { p: [-176, -652], w: 14, depth: 2.4 },
  { p: [-166, -620], w: 8, depth: 1.2 },
  // ford below the pool: a riffle where the falls trail crosses back to the west bank
  { p: [-150, -560], w: 15, depth: 0.32 },
  { p: [-112, -486], w: 9, depth: 1.3 },
  // ford north: a pebble riffle where the falls trail crosses
  { p: [-74, -420], w: 15, depth: 0.32 },
  { p: [-50, -350], w: 9, depth: 1.3 },
  { p: [-68, -262], w: 9.5, depth: 1.35 },
  { p: [-66, -170], w: 10, depth: 1.4 },
  { p: [-22, -84], w: 10, depth: 1.35 },
  // ford at the camp
  { p: [38, -20], w: 17, depth: 0.3 },
  { p: [110, 44], w: 10, depth: 1.4 },
  { p: [160, 128], w: 10.5, depth: 1.45 },
  { p: [156, 220], w: 11, depth: 1.45 },
  // ford south, below the rocky knoll
  { p: [196, 318], w: 17, depth: 0.32 },
  { p: [282, 384], w: 11, depth: 1.5 },
  { p: [380, 430], w: 11.5, depth: 1.6 },
  { p: [470, 492], w: 12, depth: 1.8 },
  // into the gorge: deep, fast and walled in (the valley's south-east edge)
  { p: [548, 574], w: 12, depth: 2.4 },
  { p: [610, 662], w: 11, depth: 2.8 },
  { p: [680, 744], w: 10, depth: 3.0 },
  { p: [780, 800], w: 10, depth: 3.0 },
  { p: [900, 836], w: 10, depth: 3.0 },
  { p: [1040, 860], w: 10, depth: 3.0 },
];
/** index in RIVER of the point at the lip of the falls; the next point is in the pool */
export const FALLS_INDEX = 4;
/** the plunge pool: a round basin at the foot of the falls */
export const POOL = { p: [-174, -650] as V2, r: 15, depth: 3.2 };
/** the cliff step the river falls over (m) */
export const FALLS_DROP = 22;
/** fords (shallow crossings), for the game: centre and the bearing of the crossing */
export const FORDS: V2[] = [[-74, -420], [-150, -560], [38, -20], [196, 318]];

/** the landmarks along the trails */
export interface Site { name: string; p: V2; r: number; flatten: boolean; yaw: number }
export const SITES: Site[] = [
  { name: 'camp', p: [128, -70], r: 26, flatten: true, yaw: 0.4 },
  { name: 'statue', p: [392, -196], r: 18, flatten: false, yaw: -2.2 },
  { name: 'obelisk', p: [-396, -436], r: 14, flatten: true, yaw: 0.9 },
  { name: 'ruins', p: [-432, 186], r: 46, flatten: true, yaw: 0.25 },
  { name: 'bones', p: [44, 412], r: 14, flatten: false, yaw: 1.1 },
  { name: 'falls', p: [-150, -628], r: 0, flatten: false, yaw: 0 },
];
export const site = (n: string) => SITES.find((s) => s.name === n)!;

/** dirt trails (horse-friendly grades are kept by the baker's cut and fill) */
export const PATHS: V2[][] = [
  // camp to the ford and north along the west bank to the falls pool
  [[128, -70], [96, -44], [62, -26], [38, -20], [8, -26], [-30, -56], [-104, -110], [-128, -200], [-118, -290], [-104, -360], [-74, -420],
    [-62, -470], [-92, -540], [-124, -600], [-142, -628]],
  // the falls trail west, up onto the obelisk ridge
  [[-142, -628], [-134, -596], [-150, -562], [-196, -566], [-250, -556], [-300, -540], [-350, -490], [-396, -436]],
  // the obelisk ridge south to the ruins, across the western meadows
  [[-396, -436], [-430, -360], [-440, -260], [-400, -160], [-372, -60], [-394, 40], [-420, 120], [-432, 186]],
  // the ruins east across the southern meadows to the bones
  [[-432, 186], [-360, 250], [-270, 300], [-170, 350], [-60, 390], [44, 412]],
  // the bones to the south ford and up past the rocky knoll
  [[44, 412], [120, 380], [170, 340], [196, 318], [236, 262], [300, 196], [340, 110]],
  // up to the statue's hill and back down to the camp
  [[340, 110], [372, 30], [400, -60], [400, -140], [392, -196], [340, -170], [270, -130], [200, -96], [128, -70]],
];

/** named places: where the player stands, the facing (yaw, 0 = toward -z), for spawning and the harness */
export interface Spot { name: string; player: [number, number]; yaw: number }
export const SPOTS: Spot[] = [
  { name: 'camp', player: [112, -52], yaw: -2.3 },
  { name: 'ford', player: [62, -26], yaw: -2.0 },
  { name: 'falls', player: [-136, -612], yaw: -0.4 },
  { name: 'obelisk', player: [-372, -452], yaw: -1.2 },
  { name: 'ruins', player: [-400, 220], yaw: -0.9 },
  { name: 'bones', player: [70, 400], yaw: -1.4 },
  { name: 'statue', player: [360, -160], yaw: -0.9 },
  // NEXT5 §5: the recording start. On the southern meadow trail, facing west along it toward the low sun and the
  // hills it sets behind (the r8 look): one T from sunrise is golden hour, two more the sunset itself
  { name: 'sunset', player: [-60, 390], yaw: Math.atan2(-110, -40) - Math.PI },
];
export const SPAWN = SPOTS.find((s) => s.name === 'sunset')!;
