# Notes

The round log for Valley Ride (plan: GAME.md and the rounds below). Each round ends with a clean `pnpm build`, its
done-check, an entry here, a commit, and nothing left running.

## Lessons carried over

From the earlier work on this valley engine, kept because they will bite again:

- **A gait is not a re-timed walk.** Driving every gait from one walk clip by shifting each leg's phase and scaling
  its swing looked plausible in stills and wrong in motion; it was rejected. Each gait gets its own authored cycle,
  checked against reference before anything else is built on it (GAME.md, "The gate").
- **Hooves slide unless the cycle is driven by distance.** The stride phase advances at ground speed / stride length,
  never by clock time; then a planted hoof stays planted at any speed.
- **Check animation in the runtime, not in Blender.** Export, quantisation and runtime blending each changed what
  looked right in the DCC.
- **Quantised vertex data must be unpacked before editing.** meshopt / int16 positions edited in place clamp to the
  old bounds; copy to a Float32 attribute first.
- **Mirrored rigs reverse quaternion turns.** Bones under a negative-scale parent turn the wrong way when a
  world-axis turn is applied by conjugating quaternions; do it with matrices (world pivot, then back to local).
- **KTX2 data maps must be linear.** The encoder flagged every texture sRGB, so normals tilted and roughness / AO
  went dark. `core/Assets.ts` forces data maps to linear at load; keep it.
- **Seat props by their real tops, not their bounding boxes.** A paved floor seated by its box stood as a wall a
  metre high. Colliders come from a plan-view height grid of the mesh, which also keeps arch openings rideable.
- **Assert the GPU and print it on every run.** A software fallback still renders, slowly and differently, and
  survives for days unnoticed. The harness fails on a software or fallback adapter, on WGSL errors and on HTTP
  errors, and tears down Vite and Chrome on every exit path.
- **Keep generated output out of the source tree.** Captures, recordings and Blender work files go to `build/`
  (ignored). The tree generators are deterministic: regenerated in Round 0, every GLB came out byte-identical apart
  from its generator name.
- **Credit as you add.** Every asset gets its row in CREDITS.md the day it lands, traced to the original file.

## Round 0: clean out and rename (2026-11-10)

Done:
- Wrote GAME.md.
- Deleted every file from the cancelled job: all third-party-generated models and their copies, derivatives,
  colliders and LODs; renders and films of them; the gameplay footage and client reference material; the music of
  unknown licence; the old round docs and backups; the old combat game (its page, sources, scripts and the physics
  dependency); the dead Island files (`Footprints.ts`, `WadeFx.ts`, `steps.ts`, `Canopy.ts`); the work folder,
  including a browser profile with saved logins (never opened).
- Renamed the package to `valley-ride`; one Vite entry; fixed old paths and names in the cinematic script and the
  Blender tree scripts (their work output now goes to `build/blender/`); regenerated the pine and oak GLBs
  (byte-identical apart from the generator name); reinstalled `node_modules`; rebuilt `dist`.
- Placeholders built in code: `ride/Horse.ts` is a grey-box horse and rider with the same interface (gait, stride
  phase, footfalls, eye / bit / rein markers); `world/placeholders.ts` builds the landmark pieces, which go through
  the existing seating and collider code. The loading screen is a plain gradient. The music module keeps its
  crossfade player with an empty track list.
- Traced the eight sounds that had no credit line: all are byte-identical copies of Island's files, each CC0 from
  freesound with author and ID in Island's credits. All 37 shipped sounds were matched to a credited source file by
  bytes; none needed deleting. Listed in CREDITS.md.
- The harness still asserts a hardware WebGPU adapter and prints it every run, but no longer requires NVIDIA.
- Wrote README.md, CREDITS.md, this file, `.gitignore`; `git init`, first commit.

Name search (run from the repo root; the pattern is split across quotes so this file does not match itself):

```sh
$ grep -rli -E 'tri''po|are''na' --exclude-dir=node_modules . ; \
  find . -path ./node_modules -prune -o \( -iname '*tri''po*' -o -iname '*are''na*' \) -print
$
```

Empty output: no file name or file content outside `node_modules` (binaries and `dist/` included) matches.

Harness tour from sunrise (`node scripts/valley-tour.mjs build/tour --tod=6.55 --daylen=15`):

```
[gpu] backend WebGPU adapter {"vendor":"nvidia","architecture":"lovelace","description":"","fallback":false}
[valley] ready in 12.8 s
[tour] 48 waypoints at 10 m/s
... 06:33 at the start, 19:35 at the end (sunrise to after sunset) ...
[tour] jumps 7 refusals 0 route complete true
[tour] done in 487 s; landmarks 6/6; fps avg 55.9 min 47.8
```

The page error check passed: no console errors, no WGSL errors, no HTTP 404s. The grey-box horse rides the whole
loop, jumps the logs and passes the placeholder ruins; the frame rate on the 4060 is under 60 in places (Round 11).
One warning: the autopilot skipped waypoint 15 near the falls (it recovered and carried on).
Still to do by hand: `pnpm dev` and ride it yourself.

## Round 1: the gallop test, failing (2026-11-10)

Done:
- Sourced the plate: Muybridge's Sallie Gardner card, the Library of Congress master TIFF (LC-DIG-ppmsca-06607),
  kept as `refs/muybridge/card.jpg` at full resolution with `SOURCE.md`. Read the caption off the card: 27 in and
  about 1/25 s between frames.
- Annotated frames 1 to 11 by hand (`refs/muybridge/keypoints.json`): withers, croup, poll, muzzle, elbow, stifle,
  knee or hock, fetlock and hoof per leg, contact per hoof. Legs are named by role (leading / trailing), since the
  silhouette cannot tell near from far. The plate's stride comes out of the annotation: 9.57 frame intervals
  (about 6.6 m in 0.38 s).
- Wrote GALLOP-TEST.md (definitions, every tolerance, joint and acceleration limits), `src/gaitlab/gallop.ts` (the
  analysis, shared by the lab and the test), `gait-lab.html` (dev page, not in the build), `scripts/test-gallop.mjs`
  and `pnpm test:gallop`.
- `Horse.ts` gained the test's interface: `gateJoints()` (named joint positions: the bone mapping Round 2 rewrites),
  `lead`, `resetGait()`. The harness can open another page (`page`, `global`).

`pnpm test:gallop` on the placeholder (GPU printed: nvidia lovelace, WebGPU; no page errors; exit 1):

```
FAIL A1  Footfall order        hindTrail 2 stance(s), the other three hooves never plant
FAIL A2  Suspension            2 airborne phases
FAIL A3  Gathered              widest spread 2.32 body lengths (limit 0.45)
FAIL A4  Duty factor           5.8% / 0% / 0% / 0% (limit 18..35%)
FAIL A5  No sliding            19.4 cm at 0.25x; at 1x no stance long enough to measure
FAIL A6  Penetration / float   three hooves never come within 1 cm of the ground
FAIL A7  Spine                 range 0 deg (a rigid box)
FAIL A8  Head and neck         1 nod, lowest outside the leading fore's stance
FAIL A9  Joint limits          elbows and stifles swing -37..37 deg (limits 10..130)
PASS A10 Smoothness            no spikes, seam clean (the box's swing is a smooth cosine)
FAIL B3  Contact pattern       10 mismatches over 11 frames
FAIL B4  Segment angles        mean 40.6 deg, worst 112.8 deg (limits 12 / 25)
FAIL B5  Keypoints             mean 0.388, worst 1.119 body lengths (limits 0.08 / 0.15)
```

Evidence for the owner (tolerances left as written): run through the same checks, the annotated plate passes the
footfall order, the suspension (20%) and the duty factors, but fails two checks:
- **3, gathered:** frame 2 spreads 0.54 body lengths against the 0.45 limit (frame 3 is 0.38). The legs overlap in
  that frame, so the annotation could be part of it.
- **8, head lowest as the leading fore bears weight:** the poll is lowest in frame 8, with the trailing fore planted,
  0.12 body lengths below its height in the leading fore's frames (10, 11, 1). That is well beyond the annotation's
  error.

Checked by eye: the overlays of all 11 frames (keypoints on the joints, contacts on the ground line), the gait lab at
frames 2, 4 and 8 and in 0.25x playback, and the sheet. Still for you: open the gait lab and check the annotation,
above all the overlapping legs of the suspension frames 2 and 3 and the folded legs in frames 1 and 11.

Name search: empty again. No process left running from these runs (the open Blender window and the Chrome
windows are yours).

## After Round 1: the owner's decision, and the annotation re-check (2026-11-10)

- The owner's decision on the two checks the plate failed: the plate is the ground truth. Check 3's limit is 0.60
  body lengths (what the plate showed, 0.54, plus a margin). Check 8 is now "one nod per stride, timed to the plate
  within one frame". Written into `TOL` and GALLOP-TEST.md with the reason. No other limit moved.
- Frames 1, 2, 3 and 11 re-read from 4x and 5x zooms with a pixel grid. Round 1 had several points off the
  silhouette there, and bones 40 to 80% too long where the legs overlap. Every point moved is in GALLOP-TEST.md.
- **Open, for the owner:** with the hind cannons at their real length, the plate's own suspension spreads 0.72
  body lengths (frame 2), so the annotated plate fails check 3 at 0.60 again. The limit was left at 0.60 and our
  horse meets it (0.58), a little more gathered than the plate. Either the limit should follow the plate, or my
  re-reading of the hind hooves in frames 2 and 3 is wrong: look at those two frames in the gait lab.

## Rounds 2 and 3: the horse, its rig, and the gallop (2026-11-10)

Done:
- **The skeleton and the gallop are designed together against the plate** (`tools/gait/`): a side-view model of the
  rig (every bone turns about the lateral axis), driven by periodic curves, with two-link IK closing each leg so a
  planted toe is planted exactly. A Levenberg-Marquardt fit puts the curves and the bone lengths (inside a
  thoroughbred's ranges, the horse's size pinned to the plate's) on the plate's keypoints and on the test's checks,
  using the test's own `gallop.ts`. Result: `tools/blender/horse/gallop.design.json`.
- **The model** (`tools/blender/horse/`, through the Blender MCP): closed shells lofted round that skeleton, fused
  by a voxel remesh, smoothed, decimated to 13,748 triangles, unwrapped; 36 deform bones, at most 4 weights per
  vertex; colour, normal and occlusion-roughness maps baked at 2K with Cycles on the RTX 4060 (OptiX, asserted).
  `tools/build-horse.ts` writes `public/assets/horse/horse.glb` (meshopt, KTX2, 6.4 MB) and `horse.json`.
- **The gallop**: keyed in Blender from the design at 240 keys per stride (one per test sample), exported, played
  by `Horse.ts` with the clip's time as the stride phase (phase advances by ground speed / stride).
- `Horse.ts` rewritten for our rig: bone-mounted markers for the test's joints, footfalls from the toes, stress
  poses for the rig check. The gait lab gained a rig mode (a pose on a turntable); `pnpm test:rig` writes
  `gate/rig-check.png`.
- A turntable of the finished model: `tools/blender/horse/turntable.mp4` (EEVEE on the 4060, encoded with NVENC)
  and `turntable.jpg`.

Round 2's check (`pnpm test:rig`, GPU printed: nvidia lovelace, WebGPU): triangles 13,748 / 14,000, bones 36 / 60,
rest and six stress poses (legs folded, legs extended, neck down, neck turned, rear, spine flexed) from five
angles each. Looked at: no tearing or collapse; the quarters crease when the pelvis tucks hard.

Round 3's gate, `pnpm test:gallop` on the exported GLB in the runtime (no page errors, exit 0):

```
PASS A1  order trailing hind > leading hind > trailing fore > leading fore; gaps 20.0% 12.9% 23.8% 43.3%
PASS A2  suspension 22.1%, starting at the leading fore's lift-off          (15..30%)
PASS A3  widest spread in suspension 0.58 body lengths                      (<= 0.60)
PASS A4  duty 26.3% / 20.0% / 26.3% / 21.3%                                 (18..35%)
PASS A5  slide 0.0 cm at 0.25x (7 stances) and at 1x (11 stances)           (<= 1 cm)
PASS A6  lowest hoof 0.0 cm, every hoof plants                              (>= -1 cm)
PASS A7  spine range 39.8 deg; 41.8 in suspension vs 73.5 at hind push-off  (>= 8 deg, flexed in suspension)
PASS A8  1 nod, poll lowest 0.65 plate frames from the plate's lowest       (<= 1 frame)
PASS A9  all joints inside their limits
PASS A10 no acceleration spikes, seam clean
PASS B3  contact pattern matches in all 11 frames
PASS B4  segment angles mean 11.0 deg, worst 23.4 (frame 10, trailing hind gaskin)        (<= 12 / 25)
PASS B5  keypoints mean 0.073, worst 0.142 body lengths (frame 4, trailing hind fetlock)  (<= 0.08 / 0.15)
```

What a pass does not say (for the owner's check by eye, which is still the gate):
- **The trunk moves more than a real horse's.** To sit on the plate's keypoints the fit lets the withers rise and
  fall 20 cm, the croup 28 cm, the body pitch through 19 degrees and surge 14 cm fore and aft, with the spine
  flexing through 40 degrees. A real gallop is about half of each. A fit held to calmer trunk motion reached
  keypoints of 0.076 mean / 0.158 worst: just outside B5. I did not find a version that both passes and is calm.
- **The margins are thin**: B5 worst 0.142 of 0.15, B4 mean 11.0 of 12, A3 0.58 of 0.60.
- **The stride is 5.66 m** (5.1 body lengths, as the plate's keypoints ask), so at the game's 10 m/s a stride takes
  0.57 s. Sallie Gardner did her stride at about 17 m/s. It reads as a long, slow gallop.
- Below gallop speed the same cycle plays slowly (hooves still planted). Walk, trot and canter are Round 4.
- The model is plain: lumpy quarters, a solid mane and tail, hocks too bent at rest, no LODs yet, 6.4 MB of
  textures.

Lessons:
- **Check the solver before blaming the problem.** A stop rule that quit on the first small step, and residuals
  that were roots of summed squares (kinked at zero), each stalled the fit for many runs that looked like "the
  constraints are too tight".
- **Pin the scale.** With the horse's size free, bone "ranges" meant nothing and the fit grew a giant.
- **A fit that passes the numbers is not yet a motion.** The first passing fit bobbed the body 48 cm. Bound what
  a body can physically do before trusting the verdict.
- **Hide construction geometry from a bake.** The shells the surface was remeshed from sat just inside it and
  shadowed the occlusion bake to black.
- The Blender MCP addon in the open session is behind the server (protocol 13 vs 15); everything used here worked.

Name search: empty. No process left running from these runs (the open Blender window is the owner's).

Next (superseded by the model quality pass below): the owner scrubs the gait lab at 0.25x beside Muybridge. Nothing after it
starts until then.

## Model quality pass before Round 4 (2026-11-10): stopped at the reviewer limit, serious issues left

Asked for after Round 3 passed the numbers but not the eye. The gallop test still passes on the result
(`pnpm test:gallop`, exit 0; no tolerance touched), but three rounds of independent review did not clear the model.

What changed:
- **Skeleton anatomy.** The fitted skeleton had the hips about 30 cm too far back and the hip joint too high in
  the pelvis (the cause of the long back, the low croup and the squatting hind leg). The trunk is now a
  thoroughbred's (about 0.85 m withers to lumbosacral joint, hip joint 0.4 m below the croup), and the gallop was
  refitted on it. The standing pose is level, hind cannon upright.
- **Trunk motion, calmer.** Tightening the trunk's limits a step at a time, each step started from the last passing
  fit, got much further than asking for the calm version outright (which never passed):

  | | withers rise and fall | croup | pitch | surge | spine flexion |
  |---|---|---|---|---|---|
  | Round 3 | 20 cm | 28 cm | 19 deg | 14 cm | 40 deg |
  | now (shipped) | 12 cm | 15 cm | 13 deg | 9 cm | 32 deg |
  | calmest tried | 10 cm | 13 cm | 11 deg | 8 cm | 30 deg |

  The calmest passes the design check but fails B5 in the runtime by a hair (worst keypoint 0.153 against 0.15):
  kept as `build/gait/u8.json`, not shipped. `tools/gait/trunk-report.ts` prints these numbers for any design.
- **Surface.** Rebuilt for a thoroughbred's forms: withers ridge, deep girth, tucked flank, sloping croup, arched
  neck, cheek and brow on the head, forearm and gaskin muscle, flat knees, cannon with the tendon standing off it,
  fetlock, hock point, hooves with a coronet. The two chest bulges are gone.
- **Mane, forelock and tail** are card strips (1,400 triangles, their own alpha-tested strand texture), on five
  mane bones and four tail bones that carry a travelling wave through the stride.
- **Deformation.** Half-way bones over the hips and shoulders (each turns half as far as the thigh or upper arm),
  buttock and hamstring weighted to the pelvis so only the stifle travels, weights smoothed over the trunk.
  45 bones. `horse_rig.py` prints the body's volume over the gallop: it stays between 89% and 98% of rest.
- **Textures.** Bay coat with a dark topline, lighter flank and elbow, black points fading up through the knees and
  hocks, occlusion-shaded muscle; colour 2K, normal and occlusion-roughness 1K. `horse.glb` is 2.70 MB (budget 4).
- The gait lab's light had no shadow bias: the horse's own shadow banded across its barrel. Fixed.
- `scripts/gallop-strip.mjs` writes `gate/gallop-strip.png`: 12 moments of the stride with no overlays.

Review, three rounds (the limit), each by a fresh reviewer given six public-domain thoroughbred photographs
(Wikimedia Commons; sources in `build/review/refs/sources.json`) and that round's turntable stills, gallop strip
and gallop sheet (`build/review/r1..r3/`):
- Round 1: 11 serious (hind leg construction, hyena topline, ball quarters, tube forelegs, egg chest, cone neck,
  no muscle, slab mane, rigid tail, rump crumpling gathered, thigh thinning extended).
- Round 2: 6 serious (neck, withers, shoulder and chest, a shell left lying on the hip, hindquarter volume in the
  gallop, legs).
- Round 3: 9 serious. What the last reviewer still calls serious:
  1. the thigh is one smooth sack dropping to a low stifle, then a thin gaskin;
  2. the hind leg stands under itself, the hock too low (level with the knee);
  3. knees and hocks read as balls, not flat blocks and wedges;
  4. the neck is too short, upright and thin, and does not blend into shoulder or jaw;
  5. the front view is a narrow slab with no pectorals, and the eyes bulge;
  6. muscle reads as inflated lumps: no plane changes or grooves between muscles;
  7. the rump thins to a lobe when the hind legs trail back (phases 0.67 to 0.83);
  8. the hindquarter creases and humps when gathered (phases 0.08 to 0.25);
  9. the head and neck are frozen through the stride.
  Borderline: withers still weak, the mane a rigid fin in the gallop, the coat flat.

Where that leaves it, plainly: the horse is much closer than Round 3's (proportion, stance, hair, calmer gallop,
half the file size), and it is not yet a horse a horseman would accept. Two of the nine come from the skeleton
the plate fit produces (short lower hind leg from the plate's low fetlocks, so a low hock; the neck's length and
carriage, and its stillness, follow the plate's poll and muzzle). The rest are surface and skinning, and I do not
think lofted shells and a voxel union will get them: muscle planes, flat joints and a thigh that holds its shape
want a hand-sculpted surface with real edge flow at the joints, and corrective shapes on the quarters.

Lessons:
- **Tighten in steps from a solution that passes.** The calm gallop was unreachable in one jump and reachable in
  four small ones.
- **Design margin is not runtime margin.** A 0.148 in the design was 0.153 in the runtime (the samples fall a
  fraction of a sample apart). Leave 0.007 or do not ship it.
- **Small landmark shells read as warts.** A point of hip or a pectoral added as its own ellipsoid stands on the
  surface like a welt unless nearly all of it is buried.
- **Volume as a number flagged the right place** (thigh and shoulder, about 5% each) but not the fix: moving the
  thigh's mass onto the pelvis kept the number and made the rump a featureless ball.

Name search: empty. No process left running from these runs (the open Blender window is the owner's).

## Game-distance polish (2026-11-10): coat, hindquarters, hair

Kept the horse and its gallop; polished what shows from the saddle camera. `pnpm test:gallop` passes with the same
margins as before (A3 0.59, B4 mean 11.0 / worst 21.9, B5 mean 0.072 / worst 0.143), no tolerance touched.

- **Coat.** Was an orange-tan (sRGB about 120, 77, 48) with a sheen along the back (roughness 0.58). Now a deep
  red-brown bay (about 97, 52, 29), black from the knees and hocks down, dark hooves, roughness 0.84 (points 0.78,
  hooves 0.6, hair cards 0.8). A first try at (115, 57, 31) read as a chestnut in the valley's sun.
  `horse_mesh.paint()` repaints the high mesh on its own.
- **Hindquarters.** With the thigh flexed under the body, skinning swelled the back of the thigh into a ball. Two
  corrective shape keys (`gatherL`, `gatherR`, `tools/blender/horse/horse_correct.py`) pull the skin behind the line
  from the point of buttock to the back of the hock most of the way back to it, smoothed over the surface. The volume
  taken off goes back into the thigh's outer face, so body volume is unchanged (89.3% of rest at the most gathered
  frame, same as without). Weights per gallop key are in `correctives.json` -> `horse.json`, set from the stride
  phase in `Horse.ts`. The clip and its joints are untouched.
- **Mane and tail.** Spring dynamics on the hair bones in `Horse.ts` (HAIR): the gallop's bounce swings them a beat
  late, speed streams them back, turns swing them out.
- Checked by riding: `scripts/ride-look.mjs` (forest shade, meadow noon, sunset; three-quarter back and side, at a
  walk) and `scripts/ride-look-pair.mjs` (before/after crops). `build/ride-look/compare.png`.

Lessons:
- **A new shape key comes in at value 1 in this Blender.** Left on, the next bake baked the corrected shape in the
  rest pose against the uncorrected high mesh: black patches on the thighs. The bake now mutes shape keys.
- **Hair springs must sit well above the stride frequency** (about 11 rad/s at the gallop). At 8 rad/s the tail
  resonated and whipped 76 degrees off the clip; at 20 rad/s it still flicked forward. Now about 30 rad/s, damped 0.6.
- **Delta-mush (Corrective Smooth) does not fix a skinning bulge.** It restores local detail; the ball is the shape.
