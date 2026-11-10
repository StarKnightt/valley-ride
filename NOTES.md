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

Next: Round 2, the horse model and rig. It needs Blender open with the MCP server running and added to Claude Code.
