// A camera held rigidly on the galloping horse, for looking at the rider in the running game (the game's own chase
// camera trails the horse at the gallop). Shared by scripts/rider-shots.mjs and scripts/rider-gauntlet.mjs.
//
// A view: { bearing, height, dist, fov, at }
//   bearing  degrees round the horse from its nose (0 = dead ahead, -90 = its left side, 180 = behind)
//   at       'rider' (the horse's root + look metres, 1.85 unless given: her trunk) or 'head' (her head bone)
//   height   camera height above the ground under the horse ('rider') or above her head bone ('head')
//   dist     metres from the point looked at, on the ground plane
//   fov      vertical field of view, degrees (a long lens for the close views, like the reference photographs)

/** the open meadow at the gallop: places the ride on the flattest tree-free heading from (60, 120), sprinting */
export async function gallopInMeadow(page, hour = 12.3) {
  await page.evaluate((hour) => {
    const v = window.__valley;
    v.tod.setHour(hour);
    v.ride.auto = null;
    const hf = v.hf;
    let best = null;
    for (let k = 0; k < 72; k++) {
      const yaw = (k / 72) * Math.PI * 2;
      let worst = 0, climb = 0;
      for (let d = 0; d <= 260; d += 6) {
        const x = 60 + Math.sin(yaw) * d, z = 120 + Math.cos(yaw) * d;
        worst = Math.max(worst, hf.forest(x, z));
        climb = Math.max(climb, Math.abs(hf.height(x + Math.sin(yaw) * 3, z + Math.cos(yaw) * 3) - hf.height(x, z)) / 3);
      }
      const score = worst + climb * 2;
      if (!best || score < best.score) best = { score, yaw };
    }
    v.ride.place(60, 120, best.yaw);
    v.ride.setView('cinematic');
    v.input.scripted = { t: 120, intent: { moveY: 1, sprint: true } };
  }, hour);
}

/** hold the camera at `view` from now on (call again to change the view) */
export async function holdCamera(page, view) {
  await page.evaluate((view) => {
    const v = window.__valley, THREE = v.THREE, ride = v.ride, horse = ride.horse;
    ride.camOff = true;
    window.__riderCam = view;
    if (window.__riderCamHooked) return;
    window.__riderCamHooked = true;
    const at = new THREE.Vector3();
    let head = null;
    v.engine.addUpdater(() => {
      const c = window.__riderCam, p = horse.root.position;
      // the horse's forward is +z in its own frame: heading hd turns it to (sin hd, cos hd)
      const a = horse.heading + THREE.MathUtils.degToRad(c.bearing);
      if (c.at === 'head') {
        if (!head) horse.person.model.traverse((o) => { if (o.name === 'head' && o.isBone) head = o; });
        horse.root.updateMatrixWorld(true);
        head.getWorldPosition(at);
        at.y += 0.09;
        v.camera.position.set(at.x + Math.sin(a) * c.dist, at.y + c.height, at.z + Math.cos(a) * c.dist);
      } else {
        at.set(p.x, p.y + (c.look ?? 1.85), p.z);
        v.camera.position.set(p.x + Math.sin(a) * c.dist, p.y + c.height, p.z + Math.cos(a) * c.dist);
      }
      v.camera.lookAt(at);
      if (c.fov && Math.abs(v.camera.fov - c.fov) > 0.01) { v.camera.fov = c.fov; v.camera.updateProjectionMatrix(); }
    });
  }, view);
}
