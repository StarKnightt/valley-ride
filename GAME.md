# Valley Ride

A calm horse-riding game in the browser. One valley, one day, one goal.

## The game
You wake at sunrise beside your horse at the mouth of a valley. On the summit at the
far end stand old ruins. Ride there before the sun sets. Nothing chases you, nothing
can hurt you, and you cannot fail. A full ride takes about 10 minutes.

## The day
- Sunrise at the start, sunset at the summit. The day lasts about 11 minutes of riding.
- The sun never punishes you. If you dawdle, it holds at late golden hour until you
  start the last climb. If you race, it eases forward on the climb so you always
  arrive at sunset.

## The route (one valley, about 2 km)
1. Dawn meadow: learn to ride. Walk, trot, canter, gallop.
2. The herd: wild horses graze here. When you come near they move off up the valley.
   Following them is the way. There are no map markers.
3. The river: the herd wades across at the ford. Cross where they cross. Deep water
   turns your horse back.
4. Pine woods and the high meadow: the herd stops here to graze at golden hour.
5. The climb: alone, a switchback trail to the summit.
6. The ruins: ride through the arch at sunset. The camera pulls back, the day ends.

## Riding
- W/S speed up and slow down through four gaits. A/D steer. Space jumps logs.
- Third person by default so you can see the horse move. V switches to first person.
- Gamepad supported.

## Photo mode
P freezes the moment. Free camera, focal length, depth of field, tilt, time-of-day
nudge, hide rider, three grades, save a PNG.

## Rules
- No combat, no enemies, no health, no timer on screen, no fail state.
- Everything in the game is made by us in Blender or generated in code, or is CC0
  with a credit. Nothing AI-generated ships.

## Tech
- three.js r187, WebGPU renderer with WebGL2 fallback, Vite, TypeScript, pnpm.
- Playable from a link. No install, no account.
- Performance: 60 fps at 1080p on a desktop RTX 4060 (High). On a mid laptop with
  integrated graphics (Iris Xe / Radeon 680M class): 30 fps or better on Low, which
  renders at reduced resolution with shorter grass and shadow range.
- Download: 25 MB or less before you can ride, 60 MB or less in total.
- Frame budget on Low: 150k triangles on screen, 150 draw calls.

## The gate
The horse comes first. The gallop must hold up at quarter speed against Muybridge's
"The Horse in Motion", frame by frame. See GALLOP-TEST.md. Nothing else is built
until that test passes.
