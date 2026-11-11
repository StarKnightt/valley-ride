# Prompts

How Valley Ride was built in two days with Claude Code: Claude Opus 5.5 for most of it, Claude Fable 5.2 for the rider. Blender ran through the Blender MCP, and the three.js, WebGPU and Blender skills sat in `.claude/skills`.

These are the prompts in order. The first one is a short version of the brief the game started from (the full design is in `GAME.md`). The rest are the prompts as I sent them, lightly trimmed.

## 1. The brief

```
build valley ride: a calm horse riding game in the browser. you own this

one valley, one day. you start at sunrise at the mouth of the valley and ride to the summit before sunset. nothing chases you, no enemies, no health, no fail state. third person so you can see the horse move

three.js with the webgpu renderer (webgl2 fallback), vite, typescript, pnpm. model the horse in blender through the mcp, never use ai generated assets

the horse comes first. before building anything else, make a gallop test: the gallop has to hold up frame by frame against muybridge's 1878 "the horse in motion" photos. nothing else gets built until it passes

it has to run at 60 fps at 1080p on an rtx 4060 and be playable from a link
```

## 2. The rider (Fable 5.2)

```
you're taking over the rider. you own this. opus got her seated and rigged without clipping, keep that, but she doesn't look good yet

the goal: she looks like a real adult woman riding a galloping horse in a beautiful modern open world game, as good as the horse. right now she reads like a toy

fix all of this, biggest gap first:

1. face: real adult proportions, defined eyes, brows, nose and lips, natural skin tone. right now it's a doll face
2. body: adult woman, natural proportions, athletic rider's build. arms and legs with real shape, not tubes. hands that actually grip the reins
3. hair: blonde, made from hair cards like the horse's mane. darker roots, lighter tips, a few loose strands around the face. ponytail on springs that bounces and streams with the gallop
4. skin and clothes: real skin, a fitted top and shorts with fabric folds and texture, riding boots. no smooth plastic
5. saddle and tack: a real forward-cut saddle with lower pommel and cantle, shaped flaps, visible stirrup irons under her feet, reins from the bit to her hands
6. riding pose: forward gallop seat, about 30 degrees forward fold from the hips, head up, heels down under the ball of the foot, calf on the horse's side, hands following the horse's neck. she moves with the stride, never stiff

show, don't guess: before changing anything, look at refs/rider and find good references for the face, hair and clothes too. save them in refs/rider. match those

how to work:
- judge only what the game renders, close up and side view, in the meadow and at sunset. not the blender view
- start a fresh gauntlet loop: each round a blind judge sees our render next to a real reference and picks which is real. if it picks ours, it names the single biggest gap, and you fix only that next round
- if two rounds barely improve, start a fresh loop from where you are
- if something i asked for is impossible in the browser, tell me instead of faking it

done means proof: show me in-game renders of her face close up, side view at full gallop, and from behind, plus the last gauntlet result, and pnpm test:gallop still passes. then tell me it's done

don't touch the horse. no extra steps, checks or process i didn't ask for
```

## 3. Bringing her to life

```
last rider pass, then she's done. you own this

1. seat: sit her properly in the saddle for a gallop. forward fold from the hips, back straight, head up, looking ahead. calf and thigh pressed flat against the horse, heels down, stirrup leather taut. no hanging legs
2. hands: closed around the reins, and the reins run in one continuous line from the bit to her hands. her hands follow the horse's head and neck as it moves, so the reins never go slack or stretch
3. alive while riding: she breathes, blinks every few seconds at random, small natural expressions (a slight smile, squinting into the sun), turns her head now and then to look at the valley. never frozen
4. eyebrows: softer and thinner, fine hairs that follow the brow shape, not drawn on
5. neck: slimmer and natural, with a clear line where it meets the jaw and shoulders, not a thick tube

skip the close-up hair. keep rider.glb under 3 MB and pnpm test:gallop passing

done means: show me in-game renders of the side at full gallop, the three-quarter view and her face at sunset, plus a 5 second clip of her riding. then commit everything
```

## 4. Alive when standing still (Opus 5.5)

```
make valley ride feel alive when you stand still. use the animation and rigging skills in .claude/skills

horse idle, layered and never in sync:
- slow breathing in the barrel
- tail swishes now and then, ears flick and turn on their own
- head lowers and lifts, a snort or a shake every so often
- shifts weight from one hind leg to the other after a while

rider idle:
- breathes, blinks, looks around at the valley, glances down at the horse
- now and then pats its neck or adjusts the reins
- ponytail settles and moves with the wind

from gallop to stop: slow the gallop cycle down smoothly and blend into the standing idle. no snapping between poses

done means: a 30 second clip standing still in the meadow at sunset and a 10 second clip of gallop to stop. if anything repeats in a way you'd notice, or snaps, fix it before showing me. pnpm test:gallop still passes. don't change how the horse or rider look. then commit
```

## 5. Making it a game

```
turn valley ride into a real little game. you own this. use threejs-gameplay-systems and threejs-game-ui-designer from .claude/skills

1. start: a short title card "valley ride" over the valley, then a simple controls hint (move, gallop, jump) that fades out after a few seconds or on first input. clean, minimal, no menus
2. checkpoints: 4 along the route to the summit, each a soft glowing marker that fits the world (lanterns or banners, not neon rings). riding through one gives a gentle chime and a small "checkpoint 2/4" that fades
3. ending: at the summit, a campfire burning near the edge with the valley below at sunset. reaching it slows the horse to a stop and shows "valley crossed" with the ride time, then a quiet option to ride again
4. sounds made in code, matching the calm mood

keep it calm and beautiful, like a cozy game, not arcade. no score popups, no clutter. don't change how the horse, rider or world look
```

## 6. Time of day

```
time of day needs work. you own this. use threejs-lighting, threejs-performance and webgpu-threejs-tsl from .claude/skills

1. add night: moon, stars, cool blue moonlight, the lanterns and the campfire glowing for real at night, fireflies in the meadow. it should look as beautiful as the sunset, not just darker
2. time control: simple buttons for morning, noon, sunset and night, plus a key to cycle them. small and clean in a corner
3. changing the time sometimes glitches. find out exactly what breaks, fix the cause, and blend smoothly over a second or two instead of snapping
4. the summit ending still happens at sunset when you climb, unless the player picked a time themselves

check it: switch through all four times ten times in a row and ride at night to the first checkpoint, no glitches. keep it 50+ fps. then commit and redeploy
```

## 7. The cinematic

```
make a cinematic trailer for valley ride. you own this. use threejs-postprocessing, threejs-lighting and camera skills from .claude/skills

about 25 seconds, 1920x1080, 60 fps, rendered frame by frame with a fixed time step in a headless browser, then encoded with ffmpeg so it's perfectly smooth

shot order matters:
1. open close on her and the horse at full gallop, low side tracking shot, mane, tail and ponytail streaming, golden light. this first second has to stop the scroll
2. pull out and rise to show the valley around them
3. a backlit shot riding down the forest path into the sun
4. passing a pair of glowing lanterns at a checkpoint
5. the climb at sunset, then reaching the summit campfire, the horse slows and stops, she looks out over the valley as the camera slowly drifts back

no hud, no title, no text, no menus. render the game's own sounds (hooves, wind, fire) into the audio
```
