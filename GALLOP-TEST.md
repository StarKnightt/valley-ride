# The gallop test

The gate (GAME.md): the horse's gallop must hold up at quarter speed against Muybridge's "The Horse in Motion",
frame by frame. Nothing else is built until this test passes and you have checked it by eye.

```sh
pnpm test:gallop          # PASS / FAIL per check, exit code 1 on any failure, writes gate/gallop-sheet.png
pnpm dev                  # then open http://127.0.0.1:5240/gait-lab.html
```

The tolerances below were fixed in Round 1, before any animation existed. They are not loosened to make a pass. If
one proves wrong, it goes to the owner with the evidence (see "Checks the plate itself fails" at the end).
The numbers live in one place in code: `TOL` in `src/gaitlab/gallop.ts`.

## The reference

- **Plate:** Eadweard Muybridge, "The Horse in Motion" (1878), "Sallie Gardner," owned by Leland Stanford, ridden by
  G. Domm, running at a 1.40 gait over the Palo Alto track, 19th June 1878. Public domain.
- **Source:** Library of Congress, Prints & Photographs Division, LC-DIG-ppmsca-06607,
  https://www.loc.gov/item/97502309/. The master TIFF
  (https://tile.loc.gov/storage-services/master/pnp/ppmsca/06600/06607u.tif, 4352 x 2713) is stored as
  `refs/muybridge/card.jpg` at full resolution.
- **The caption, read from the card:** "The negatives of these photographs were made at intervals of twenty-seven
  inches of distance, and about the twenty-fifth part of a second of time; they illustrate consecutive positions
  assumed during a single stride of the mare. The vertical lines were twenty-seven inches apart; the horizontal
  lines represent elevations of four inches each. The negatives were each exposed during the two-thousandth part of
  a second, and are absolutely 'untouched.'" So: 27 in and about 1/25 s between frames.
- **Frames:** 1 to 11 are the stride; 12 is the mare standing and is not used.
- **Annotation:** `refs/muybridge/keypoints.json`, by hand from 3x zooms of the master, in card pixels. Per frame:
  withers, croup, poll, muzzle, elbow, stifle, and for each leg the knee (fore) or hock (hind), the fetlock and the
  hoof (the toe at the ground line), plus a ground-contact flag per hoof. Check it by eye in the gait lab.
- **Which leg is which:** a silhouette cannot tell near legs from far, so legs are named by role: leading fore,
  trailing fore, leading hind, trailing hind (the leading leg of a pair lands last). The mare faces right, so the
  photographs show her right side. The roles follow from the footfalls: trailing hind lands in frame 4, leading hind
  in 6, trailing fore in 7, leading fore between 9 and 10.
- **The plate's stride, from the plate:** a planted hoof moves back past the withers by one frame spacing D per frame
  (median over the planted pairs: 130 px at the horse). The leading fore is planted in frame 1 and again in frames
  10 and 11; the distance between the plants gives the stride N = 9.57 frame intervals, about 258 in (6.6 m) in about
  0.38 s. Frame i sits at stride phase (i - 1) / N; frame 11 is past one full stride (phase 1.045).

Sallie Gardner was a racehorse at racing speed (about 17 m/s by the caption) with a jockey; our horse gallops at
about 10 m/s. So the comparison is by stride phase, by angles and in body lengths, never by absolute speed or
silhouette.

## What runs

- The horse as the game runs it: `Horse` (`src/valley/ride/Horse.ts`), its own `update` (the gait code), in the real
  renderer, stepped deterministically with `Engine.stepOnce`. The gait lab (`gait-lab.html`, `src/gaitlab/main.ts`)
  builds a flat track with a Muybridge-style backdrop (lines 27 in and 4 in apart), gallops the horse at
  `GAIT.gallop`, measures the stride period from the gait's own stride phase, and records:
  - **0.25x:** two strides at 240 samples per stride (sample 0 is the first pose after the stride phase wraps), plus
    two samples past the second seam. The first stride is analysed; the rest carries the loop seam and stances that
    cross it. At 240 samples per stride every step is finer than quarter speed on a 60 Hz display for any stride
    shorter than a second.
  - **1x:** steps of 1/60 s over three strides.
  - Every transform of the horse per 0.25x sample, so the lab's scrub bar and playback show exactly what was measured.
- **Numbers on the CPU:** joint world positions come from `Horse.gateJoints()` (the horse's bone mapping for this
  test), read in JS. All checks are computed in node from those positions by `src/gaitlab/gallop.ts`, the same module
  the lab uses for its own readout.
- **The sheet on the GPU:** the harness (`scripts/lib/vharness.mjs`) starts Vite and Chrome, asserts a hardware
  WebGPU adapter and prints it, fails on WGSL, console and HTTP errors, and tears everything down on every exit path.
  A check in Blender is not accepted as a pass.

### The joints the horse must provide

`Horse.gateJoints()` returns world positions by name:

| Trunk | Fore legs (LF, RF) | Hind legs (LH, RH) |
|---|---|---|
| `withers`, `croup`, `poll`, `muzzle` | `shoulder` (point of shoulder) | `hip` (hip joint) |
| `buttock` (point of buttock, on the pelvis) | `elbow` | `stifle` |
| `girth` (sternum at the girth, on the ribcage) | `knee` (carpus) | `hock` (tarsus) |
| | `fetlock` | `fetlock` |
| | `hoof` (sole at the toe) | `hoof` |

`Horse.lead` names the lead (`'L'` or `'R'`): the side whose fore lands last. The placeholder marks these points
along its rigid boxes; the rigged horse (Round 2) maps them to bones.

## Definitions

- **Side view:** a point p becomes (p . forward, p . up), forward being the horse's heading and up the world up.
- **Body length (BL):** withers to croup in the side view (mean over the stride for Part A, per frame for Part B).
- **Planted:** a hoof is planted when its sole is within 1 cm of the ground. On the plate, the annotated contact flag
  says so. A stance is a run of planted samples.
- **Roles on our horse:** with lead R, the leading fore is RF, the trailing fore LF, the leading hind RH, the
  trailing hind LH (mirrored for lead L).

## Part A: gait facts (all must pass)

| # | Check | Pass when |
|---|---|---|
| 1 | Footfall order | Each hoof has exactly one stance per stride; touchdowns go trailing hind, leading hind, trailing fore, leading fore on the declared lead; consecutive touchdowns (and leading fore back to trailing hind) are at least 3% of the stride apart. |
| 2 | Suspension | Exactly one airborne phase (no hoof planted) per stride; it starts within 2 samples of the leading fore's lift-off; it lasts 15% to 30% of the stride. |
| 3 | Gathered, not stretched | At every airborne sample the spread of the four hooves along the body (max - min of their forward positions) is at most 0.45 BL. |
| 4 | Duty factor | Each hoof is planted for 18% to 35% of the stride. |
| 5 | No sliding | Over every whole stance of at least two samples, the hoof stays within 1 cm (horizontal) of where it touched down, at 0.25x and at 1x. A run with no measurable stance fails. |
| 6 | No penetration or float | No hoof ever goes below -1 cm; every hoof gets within 1 cm of the ground (a hoof that floats above 1 cm never plants). |
| 7 | Spine | The spine angle (the angle between the pelvis axis croup -> buttock and the thorax axis withers -> girth, side view) changes by at least 8 deg over the stride, and is smaller (flexed) on average during suspension than at the leading hind's push-off (its last planted sample). |
| 8 | Head and neck | The poll's height above the ground makes exactly one nod per stride (crossings of its mean with a hysteresis of 0.01 BL), and its lowest point falls while the leading fore is planted. |
| 9 | Joint limits | Every joint's flexion stays inside the table below, all stride long. |
| 10 | Slow-motion smoothness | No joint's angular acceleration (second difference of its flexion over the 240 samples) exceeds its limit below, and at the loop seam (sample 239 to 240) neither the angular step nor the acceleration is worse than at any other step. |

### Joint limits (check 9)

Flexion is the angle between the two segments in the side view, 0 deg when they are in line, positive in the
joint's natural direction of flexion, negative for hyperextension. A knee bending backward reads below -5 deg.

| Joint | Segments | Flexes | Limits (deg) |
|---|---|---|---|
| Elbow | shoulder -> elbow, elbow -> knee | forearm forward | 10 to 130 |
| Knee (carpus) | elbow -> knee, knee -> fetlock | cannon back | -5 to 130 |
| Fetlock (fore and hind) | cannon, fetlock -> hoof | pastern back; negative is the loaded fetlock sinking | -95 to 130 |
| Stifle | hip -> stifle, stifle -> hock | gaskin back | 10 to 130 |
| Hock (tarsus) | stifle -> hock, hock -> fetlock | cannon forward | -5 to 120 |

These are wide limits of what a horse's joints do at the gallop (the fetlock under load sinks far past straight;
the carpus and hock do not bend the wrong way). They are a gate against broken poses, not a model of one horse.

### Angular acceleration limits (check 10)

| Joint | Limit (deg/s^2) |
|---|---|
| Elbow, stifle | 60,000 |
| Knee, hock | 100,000 |
| Fetlock | 150,000 |

A real gallop's fastest joint (the fetlock) turns through about 100 deg in a tenth of a second; a pop of 10 deg in
one sample of a 0.4 s stride is over 3,000,000 deg/s^2. The limits sit between the two.

## Part B: frame by frame against Muybridge (all must pass)

1. **Phase alignment:** for each plate frame i the phase is (i - 1) / N. Every offset of our 240 samples is tried;
   the one with the smallest mean keypoint error is used, and each plate frame gets our sample at its phase.
2. **Side view, normalised:** both poses are moved so the withers-croup midpoint is the origin and scaled so
   withers to croup is 1. Our elbow and stifle are the mean of the pair (the plate shows one of each).
3. **Contact pattern:** at every plate frame, which of our hooves are planted matches the plate's flags exactly.
4. **Limb segment angles:** 12 segments per frame (per leg: elbow or stifle -> knee or hock, -> fetlock, -> hoof);
   mean error at most 12 deg, worst single segment at most 25 deg.
5. **Keypoints:** the 18 keypoints; mean error at most 0.08 BL, worst at most 0.15 BL.

## Output and your check

- `pnpm test:gallop` prints PASS or FAIL per check with its value and limit, a reference block (below), writes
  `gate/gallop-sheet.png` and `gate/gallop-result.json`, and exits 1 on any failure. `gate/` is regenerated output and
  is not committed.
- **The sheet:** every Muybridge frame beside our frame at its aligned phase, both framed the same in body lengths;
  annotation overlaid on the plate, our joints (solid) and the plate's pose on our withers-croup (dashed) on ours;
  squares mark planted hooves.
- **The gait lab** (`gait-lab.html`, dev only, not in the build): side view, scrub bar over the 240 samples,
  playback at 0.25x or 1x (Space plays, arrow keys step), buttons for plate frames 1 to 11 that jump to the aligned
  phase, the plate frame alongside, an overlay toggle, and the check results. This is where you verify by eye.

## Checks the plate itself fails

The test also runs the checks that can be read off the annotated plate (1, 2, 3, 4, 8; at the plate's 10 frames per
stride) and prints them as a reference, outside the verdict. A check that Sallie Gardner fails is a wrong check.
Round 1 result:

| Check | The plate | Note |
|---|---|---|
| 1 Footfall order | pass | trailing hind, leading hind, trailing fore, leading fore |
| 2 Suspension | pass | 20%, starting at the leading fore's lift-off (frames 2 and 3) |
| 3 Gathered | **fail** | frame 2 spreads 0.54 BL, frame 3 0.38 BL; the limit is 0.45 |
| 4 Duty factor | pass | 20% to 30% per hoof |
| 8 Head and neck | **fail** | the poll is lowest in frame 8 (trailing fore planted), not while the leading fore is planted (frames 10, 11, 1). Poll height in body lengths: frame 8 1.46, frames 10, 11, 1 about 1.58 |

Both are left as written, as the plan requires, and are for the owner to decide: the annotation may be off in frame
2 (the legs overlap in the suspension), but the head's low point in frame 8 is 0.12 BL clear of the leading fore's
frames, well beyond the annotation's error.
