# Credits

Everything that ships with Valley Ride, where it came from and under what licence. The game's own code, the
procedural sky, terrain, river, grass and the pine and oak trees are our own work. Nothing in the game is
AI-generated (GAME.md, Rules).

The horse, the rider, the ruins and the props are grey placeholders built in code until they are modelled in
Blender. There is no music yet.

All Poly Haven assets are CC0 1.0 (https://polyhaven.com/license), credited anyway. All freesound.org recordings
listed here are CC0 1.0.

## Our own work

| What | Made by | Files |
|---|---|---|
| Pine trees (pine_a, pine_b, pine_c): geometry, needle and bark atlases | `tools/blender/pines/make_pines.py` | `public/assets/trees/pine_*`, `textures/pine_*`, `textures/needles_*` |
| Oak trees (oak_a, oak_b): geometry, leaf and bark atlases | `tools/blender/broadleaf/make_broadleaf.py` | `public/assets/trees/oak_*`, `textures/broadleaf_*` |
| The valley: heightfield, material masks, shore distance | `tools/gen-valley.ts` | `public/world/*` |
| Grass blade atlas | our earlier project Island (own work) | `public/assets/foliage/grass.ktx2` |

## Trees from River Morning (our earlier project)

The conifers `fir_*`, `lodgepole_*`, `ponderosa_*`, `spruce_*` and `snag_*`, and the bark and needle textures
`bark_fir_*`, `bark_pine_*`. Full notice in `public/assets/trees/CREDITS.md`.

- Branch skeletons grown with ez-tree by Daniel Greenheck (https://github.com/dgreenheck/ez-tree), MIT licence.
- Textures derived from Poly Haven "Fir Tree 01" and "Pine Tree 01" by Rob Tuytel and Rico Cilliers, CC0 1.0.

## Models (Poly Haven, CC0 1.0)

| Asset | Author | Source | Files |
|---|---|---|---|
| Boulder 01 | Rico Cilliers | https://polyhaven.com/a/boulder_01 | `rocks/boulder_01.glb` |
| Namaqualand Boulder 05 | Jenelle van Heerden, Dario Barresi | https://polyhaven.com/a/namaqualand_boulder_05 | `rocks/namaqualand_boulder_05.glb` |
| Rock Moss Set 01 | Kless Gyzen | https://polyhaven.com/a/rock_moss_set_01 | `rocks/rock_moss_01_r01..r06.glb` |
| Rock Moss Set 02 | Kless Gyzen | https://polyhaven.com/a/rock_moss_set_02 | `rocks/rock_moss_02_r07..r13.glb` |
| Rock 07 | Jenelle van Heerden | https://polyhaven.com/a/rock_07 | `rocks/rock_07.glb` |
| Rock 09 | Jenelle van Heerden | https://polyhaven.com/a/rock_09 | `rocks/rock_09.glb` |
| Stone 01 | Dario Barresi, Rico Cilliers | https://polyhaven.com/a/stone_01 | `rocks/stone_01.glb` |
| Dead Tree Trunk | Rob Tuytel | https://polyhaven.com/a/dead_tree_trunk | `plants/dead_tree_trunk.glb` |
| Dead Tree Trunk 02 | Jenelle van Heerden, Rico Cilliers | https://polyhaven.com/a/dead_tree_trunk_02 | `plants/dead_tree_trunk_02.glb` |
| Tree Stump 01 | Rob Tuytel | https://polyhaven.com/a/tree_stump_01 | `plants/tree_stump_01.glb` |
| Fern 02 (a-d) | Rob Tuytel, Rico Cilliers | https://polyhaven.com/a/fern_02 | `plants/fern_02_*.glb` |

Prepared for the web in River Morning.

## Terrain textures (Poly Haven, CC0 1.0)

| Asset | Author | Source | Layer |
|---|---|---|---|
| Ganges River Pebbles | Amal Kumar | https://polyhaven.com/a/ganges_river_pebbles | `pebbles` |
| River Small Rocks | Rob Tuytel, Rico Cilliers | https://polyhaven.com/a/river_small_rocks | `pebbles_wet` |
| Forest Ground 03 | Rob Tuytel | https://polyhaven.com/a/forrest_ground_03 | `forest` |
| Rocky Terrain 02 | Amal Kumar | https://polyhaven.com/a/rocky_terrain_02 | `granite` |
| Snow 02 | Rob Tuytel | https://polyhaven.com/a/snow_02 | `snow` |
| Brown Mud Rocks 01 | Rob Tuytel | https://polyhaven.com/a/brown_mud_rocks_01 | source map in `tex/` |
| Lichen Rock | Rico Cilliers | https://polyhaven.com/a/lichen_rock | source map in `tex/` |
| Leafy Grass | Charlotte Baglioni | https://polyhaven.com/a/leafy_grass | `grass` (from Island) |
| Dirt Floor | eye-candy.xyz | https://polyhaven.com/a/dirt_floor | `dirt` (from Island) |
| Mossy Rock | Rob Tuytel | https://polyhaven.com/a/mossy_rock | `moss` (from Island) |
| Dark Rock 02 | Amal Kumar | https://polyhaven.com/a/dark_rock_02 | `rock` (from Island) |

## Sound (freesound.org and archive.org, CC0 1.0)

Traced in Round 0: each file below is a byte-identical copy of the file in River Morning or Island, whose credits
name the recording. Cut, looped and loudness-matched in those projects.

| Recording | Author | Source | Files |
|---|---|---|---|
| WoodThrushinMorningShawneeForestMay272012.wav | kvgarlic | https://freesound.org/people/kvgarlic/sounds/156826 | `amb_forest_birds_morning` |
| Jungle, Tropical birds and insects | myrinvp | https://freesound.org/people/myrinvp/sounds/423711 | `amb_birds` (via Island) |
| Strong Wind | florianreichelt | https://freesound.org/people/florianreichelt/sounds/459981 | `amb_wind` (via Island) |
| 130914 Wind in pine trees | TRP | https://freesound.org/people/TRP/sounds/715696 | `amb_wind_pines` |
| Lake at night 1.aif | i_luv_soundz | https://freesound.org/people/i_luv_soundz/sounds/412942 | `amb_night` (via Island) |
| G16-07-Crickets Near and Far | USC Cinema / Sunset Editorial | https://archive.org/details/GOLD_TAPE_16_17_18_Ambience | `amb_night_crickets` |
| Small Rocks in a Creek | Hitrison | https://freesound.org/people/Hitrison/sounds/191360 | `amb_river_calm`, `amb_stream` (via Island) |
| Strong mountain stream | frnk_cnt | https://freesound.org/people/frnk_cnt/sounds/572463 | `amb_river_riffle` |
| Waterfall | nsmusic | https://freesound.org/people/nsmusic/sounds/321886 | `amb_waterfall` (via Island) |
| Campfire 01 | HECKFRICKER | https://freesound.org/people/HECKFRICKER/sounds/729395 | `amb_campfire` |
| R30-40-Western Meadow Lark Calls | USC Cinema / Sunset Editorial | https://archive.org/details/Red_Library_Animals_Birds | `sfx_bird_meadowlark_01`, `_02` |
| R01-27-Great Horned Owl Hoot | USC Cinema / Sunset Editorial | https://archive.org/details/Red_Library_Animals_Birds | `sfx_owl_hoot_01`, `_02` |
| Big rock into water at Spfd Lake.wav | williew705 | https://freesound.org/people/williew705/sounds/98451 | `splash_big` |
| Rock In Water Splash-Plop 3.aif | jc144940 | https://freesound.org/people/jc144940/sounds/178732 | `splash_small` |
| FOOTSTEPS GRASS WALK1 (F).wav | sillygrizzlies | https://freesound.org/people/sillygrizzlies/sounds/635056 | `step_grass_1..4` |
| footsteps - gravel 02.wav | Anthousai | https://freesound.org/people/Anthousai/sounds/398777 | `step_gravel_1..4` |
| Footsteps Dirt Gravel | PotatokingXII | https://freesound.org/people/PotatokingXII/sounds/352870 | `step_leaves_1..4` (via Island) |
| Stone Steps | Phil25 | https://freesound.org/people/Phil25/sounds/208103 | `step_stone_1..4` (via Island) |
| Foot_Step_grit_Sand.wav + Swimming.wav | savataivanov, 13FPanska_Marval_Lukas | https://freesound.org/people/savataivanov/sounds/384082, https://freesound.org/people/13FPanska_Marval_Lukas/sounds/379334 | `step_water_1..4` (a mix, via Island) |

The full River Morning credits are kept in `public/assets/CREDITS-river-morning.md` for reference.

## Code and libraries

- three.js r187, MIT licence, (c) 2010-2025 three.js authors. https://github.com/mrdoob/three.js
- Basis Universal transcoder (`public/basis/`), Apache 2.0, Binomial LLC. https://github.com/BinomialLLC/basis_universal
- meshoptimizer decoder (bundled with three.js), MIT licence, (c) Arseny Kapoulkine.

Build and test tools (not shipped): Vite, TypeScript, glTF Transform, Playwright, sharp, ktx2-encoder, tsx, Blender.
