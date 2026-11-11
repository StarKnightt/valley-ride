# Skills: use them by default

This is a 3D browser game (three.js on WebGPU, models built in Blender through the Blender MCP). Before any 3D, graphics, animation, model or game work, read the matching skills in `.claude/skills/` and follow them. Read the SKILL.md itself, don't guess what it says.

Three.js and the game:
- `threejs-aaa-graphics-builder`: premium visuals and art direction. Use on any visual work.
- `webgpu-threejs-tsl`: WebGPU renderer, TSL shaders and compute. The game runs on WebGPU, so use it for any shader or material code.
- `threejs-fundamentals`, `threejs-geometry`, `threejs-materials`, `threejs-textures`, `threejs-lighting`, `threejs-shaders`, `threejs-postprocessing`
- `threejs-animation`, `threejs-loaders`, `threejs-asset-pipeline`, `threejs-interaction`
- `threejs-gameplay-systems`: checkpoints, goals, the game loop
- `threejs-game-ui-designer`: HUD, menus, end screens
- `threejs-performance` and `threejs-debug-profiler`: keep it smooth on an RTX 4060 and on weaker machines that open the link
- `threejs-qa-release`: before any deploy

Blender (through the MCP):
- `character-artist`, `hair-groom`, `rigging`, `animation`, `retopology`, `uv-workflow`
- `materials`, `texture-workflow`, `lookdev`, `realistic-style`
- `asset-optimization` and `export-pipeline`: every GLB export

How to work:
- Use only the skills that fit the task. Don't add steps, checks or process that weren't asked for.
- Use pnpm, never npm or npx.
- Never push or deploy unless asked.
- `refs/` holds reference photos. Never commit or push them.
