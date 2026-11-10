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

Next: Round 1, the gallop test (needs nothing new). Round 2 needs Blender open with the MCP server running and
added to Claude Code.
