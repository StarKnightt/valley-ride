# Valley Ride

A calm horse-riding game in the browser: one valley, one day, one ride from the meadow at sunrise to the ruins on
the summit at sunset. See [GAME.md](GAME.md) for the design and [NOTES.md](NOTES.md) for the round log.

**Status:** Round 3 of the build plan. The valley engine (sky and time of day, terrain, river, grass, trees,
ambient sound, riding) runs. The horse is our own model and rig, and its gallop passes the gate
(`pnpm test:gallop`, [GALLOP-TEST.md](GALLOP-TEST.md)); the owner's check by eye in the gait lab is still to come.
Walk, trot and canter (Round 4) do not exist yet: below gallop speed the gallop cycle plays slowly. The rider and
the landmarks are grey placeholder boxes.

## Run

```sh
pnpm install
pnpm dev        # http://127.0.0.1:5240
pnpm build      # type-check, then build to dist/
```

Needs a browser with WebGPU (current Chrome or Edge). The GPU is asked for with `powerPreference: 'high-performance'`.

### Controls

W/S speed up and slow down, A/D steer, Space jumps, mouse looks (click to capture). C switches first person and
the chase camera, P toggles photo mode, T steps the time of day.

### URL flags (dev)

`?tod=9.5` or `?tod=sunrise` start hour, `?daylen=2` minutes for a full 24 h day (default 30), `?freeze=1` stops the
clock, `?mute=1`, `?test=1` (exposes `window.__valley`), `?hud=0`, `?quality=low`.

## Layout

| Path | What |
|---|---|
| `src/gaitlab/` | the gait lab page and the gallop test's analysis (`gallop.ts`) |
| `refs/muybridge/` | the Muybridge plate and its hand annotation, the gallop test's reference |
| `src/valley/` | the game: `core` (engine, assets, lighting), `sky`, `world` (terrain, layout, colliders, placeholders), `water`, `veg`, `ride` (horse, ride control), `player` (camera, input), `audio`, `ui` |
| `public/world/` | the baked valley (heights, masks), from `tools/gen-valley.ts` |
| `public/assets/` | trees, rocks, plants, terrain textures, sounds (sources in [CREDITS.md](CREDITS.md)) |
| `tools/` | asset builders: valley bake, terrain textures, Blender tree generators |
| `scripts/` | headless checks and captures on the real GPU (`scripts/lib/vharness.mjs`) |

Script output (captures, recordings, Blender work files) goes to `build/`, the gallop test's to `gate/`; neither is
committed.

## The gallop gate

```sh
pnpm test:gallop    # PASS / FAIL per check, exit 1 on any failure; writes gate/gallop-sheet.png
```

The gait lab, `http://127.0.0.1:5240/gait-lab.html` under `pnpm dev`, shows the horse's recorded stride beside the
Muybridge plate: scrub bar, 0.25x playback, plate frames 1 to 11, overlay toggle and the check results. It is a dev
page and is not in the build. See [GALLOP-TEST.md](GALLOP-TEST.md).

## Headless checks

```sh
node scripts/valley-tour.mjs        # ride the trail loop on autopilot, captures in build/tour
node scripts/ride-test.mjs          # the horse at each gait
```

The harness starts Vite and Chrome, asserts a hardware WebGPU adapter and prints it on every run, treats WGSL errors
and HTTP failures as fatal, and closes everything on every exit path.

## Credits

See [CREDITS.md](CREDITS.md).
