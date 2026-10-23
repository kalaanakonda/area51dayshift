import * as THREE from 'three';
import gsap from 'gsap';
import { Engine } from '../core/Engine.js';
import { DEG, GeoFrame, greatCircle, SITE, sunDirectionEcef } from './geo.js';
import { Atmosphere, atmospherize, createAtmosphereUniforms, SUN_IRRADIANCE } from './earth/atmosphere.js';
import { Earth } from './earth/Earth.js';
import { Buildings, BUILDINGS_ATTRIBUTION } from './earth/Buildings.js';
import { SiteGround } from './earth/siteGround.js';
import { Controls } from './input.js';
import { Assets } from './assets.js';
import { Hangar, HANGAR, LAYER_CASTERS } from './hangar/Hangar.js';
import { Crew } from './hangar/people.js';
import { Saucer, SAUCER } from './ufo/Saucer.js';
import { PilotMode } from './ufo/PilotMode.js';
import { Walker } from './player/Walker.js';
import { Hud, fmtDist } from './hud/Hud.js';
import { PLACES, WorldMap } from './hud/WorldMap.js';
import { WarpEffect } from './render/WarpEffect.js';
import { AOEffect } from '../render/passes/AOEffect.js';
import { HOME, Shift, WAYPOINTS } from './missions.js';
import { Soundscape } from './audio.js';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('stage');
const engine = new Engine(canvas, { logDepth: true, near: 0.02, far: 80, grade: 'a51' });
engine.camera.fov = 66;
engine.camera.updateProjectionMatrix();
engine.post.grade.uLetterbox.value = 0; // full frame: this is a game, not the film
engine.post.grade.uAberration.value = 0.0012;
const renderer = engine.renderer;
renderer.shadowMap.type = THREE.PCFShadowMap;
// Warp tunnel / Overdrive streaks on the world outside the canopy (the cockpit stays sharp).
const warpFx = new WarpEffect();
engine.post.worldPass.farEffects.push(warpFx);
// Ambient occlusion from each layer's own depth: the world (hangar, crew, craft, cities) and the cockpit.
const aoWorld = new AOEffect({ samples: engine.quality.name === 'high' ? 14 : 10 });
const aoCockpit = new AOEffect({ samples: 10 }).set({ radius: 0.08, bias: 0.03, intensity: 0.5, maxDist: 8 });
aoWorld.enabled = aoCockpit.enabled = engine.quality.name !== 'low';
engine.post.worldPass.farEffects.unshift(aoWorld);
engine.post.worldPass.nearEffects.push(aoCockpit);
let flow = 0;
engine.post.grade.uFlashColor.value.setRGB(0.86, 0.93, 1.0); // the warp's flash is blue-white

const frame = new GeoFrame();
const world = new THREE.Scene();
world.name = 'World';
const worldCam = new THREE.PerspectiveCamera(66, innerWidth / innerHeight, 0.05, 5e7);
worldCam.name = 'WorldEyes';
worldCam.layers.enable(Saucer.LAYER);

const atmoU = createAtmosphereUniforms();
const atmo = new Atmosphere(atmoU);
world.add(atmo.dome);

const earth = new Earth({ frame, renderer, camera: worldCam, atmoUniforms: atmoU, quality: engine.quality, source: params.get('earth') || 'auto' });
world.add(earth.group);
// Free Earth only: OSM buildings, streamed around the craft (and ahead of a warp) like an open-world city.
// (None on the real Groom Lake site: Hangar 9 stands there.)
const buildings = new Buildings({ frame, earth, camera: worldCam, atmoUniforms: atmoU, exclude: [{ lat: SITE.lat, lon: SITE.lon, r: 320 }] });
world.add(buildings.group);
engine.setStage({ far: world, farCamera: worldCam, near: null });
engine.onResize = () => earth.resize();
// Frame-rate guard: when the GPU falls behind (a big window, a dense city, the cockpit's own
// detail) render fewer pixels for a while instead of dropping frames; hand them back once
// there is headroom again. ?fixedres turns it off.
const autoRes = { on: !params.has('fixedres'), slow: 0, fast: 0, wait: 4 };
engine.addUpdater((dt) => {
  if (!autoRes.on) return;
  autoRes.wait -= dt;
  autoRes.slow = engine.fps < 48 ? autoRes.slow + dt : 0;
  autoRes.fast = engine.fps > 58 ? autoRes.fast + dt : 0;
  if (autoRes.wait > 0) return;
  let s = engine.resScale;
  if (autoRes.slow > 1.5 && s > 0.61) s = Math.max(0.6, s * 0.85);
  else if (autoRes.fast > 6 && s < 1) s = Math.min(1, s * 1.1);
  else return;
  engine.resScale = s;
  engine.resize();
  autoRes.wait = 4;
  autoRes.slow = autoRes.fast = 0;
});

const hud = new Hud(document.getElementById('hud'));
const sound = new Soundscape();
hud.onMute = () => {
  sound.setMuted(!sound.muted);
  hud.setMuted(sound.muted);
};
if (params.has('mute')) {
  sound.setMuted(true);
  hud.setMuted(true);
}
// M: full-screen nav map — search or click a destination, then warp there or set it as the waypoint.
const worldMap = new WorldMap(document.body, {
  onWarp: (dest) => engageWarp(dest),
  onWaypoint: (dest) => {
    shift.setCustom(dest);
    closeMap(true);
  },
  onClose: (relock) => closeMap(relock),
});
// Named places for the "where" caption under the minimap.
const NAMED = [...WAYPOINTS, ...PLACES.filter((p) => !p.home && !WAYPOINTS.some((w) => w.name === p.name))];

// --- time & sun -----------------------------------------------------------------
const clock = { utc: new Date() };
{
  const now = new Date();
  const local = new Date(now.getTime() + SITE.utcOffset * 3600e3);
  local.setUTCHours(8, 30, 0, 0);
  clock.utc = new Date(local.getTime() - SITE.utcOffset * 3600e3);
}
const sunWorld = new THREE.Vector3();
// Always day: the sun keeps the site's local solar time wherever you are, so it
// shifts the clock by your longitude (Mumbai gets Nevada's morning, not its night).
const sunCarto = {};
const solarUtc = new Date();
const updateSun = () => {
  const lon = frame.cartographic(worldCam.position, sunCarto).lon / DEG;
  let dLon = lon - SITE.lon;
  dLon -= Math.round(dLon / 360) * 360;
  solarUtc.setTime(clock.utc.getTime() - (dLon / 15) * 3600e3);
  frame.dirToWorld(sunDirectionEcef(solarUtc, new THREE.Vector3()), sunWorld);
};
updateSun();

const sun = new THREE.DirectionalLight(0xffffff, SUN_IRRADIANCE);
sun.castShadow = true;
{
  const sz = engine.quality.name === 'high' ? 4096 : 2048;
  sun.shadow.mapSize.set(sz, sz);
  const sc = sun.shadow.camera;
  // the hangar, its yard and poles, and their shadows on the lakebed
  sc.left = -85;
  sc.right = 85;
  sc.top = 85;
  sc.bottom = -85;
  sc.near = 20;
  sc.far = 420;
  sc.layers.enableAll();
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.05;
}
world.add(sun, sun.target);

// --- hangar, saucer, crew ----------------------------------------------------------
const assets = new Assets(renderer);
const hangar = new Hangar({ renderer, quality: engine.quality });
hangar.group.rotation.y = -SITE.doorAzimuth * DEG;
// Floor height in the world frame: the free terrain is MSL-based, Google's is ellipsoidal.
// Both get refined by snapHangar() once the ground under the site has streamed in.
hangar.group.position.y = earth.mode === 'free' ? 1346.0 - SITE.height + 0.12 : 0.12;
world.add(hangar.group);
hangar.group.updateMatrixWorld(true);
// Sun shadows, lakebed detail and tyre tracks on the satellite terrain round the site
// (Google's photogrammetry has its own baked-in detail and shadows).
const siteGround = earth.mode === 'free' ? new SiteGround({ hangar, earth, frame, atmoU, sun }) : null;

const saucer = new Saucer();
world.add(saucer.group);
world.add(saucer.pool);
saucer.group.traverse((o) => o.isMesh && o.layers.enable(LAYER_CASTERS));
for (const m of hangar.exterior) atmospherize(m, atmoU);

const pilot = new PilotMode({ engine, frame, earth, hangar, saucer, assets, worldCam });
for (const m of [saucer.mats.upper, saucer.mats.lower, saucer.mats.dark, saucer.mats.strut, saucer.domeMat]) atmospherize(m, atmoU);
const pilotLoaded = pilot.load();

const crew = new Crew(assets, hangar);
hangar.group.add(crew.group);
const crewLoaded = crew.load().then((ok) => {
  if (!ok) return;
  crew.group.traverse((o) => o.isMesh && o.layers.enable(LAYER_CASTERS));
});

// --- warm-up -----------------------------------------------------------------------------------
// Behind the start card: load the people, compile every shader (hangar, outside,
// cockpit), push every texture to the GPU and let the site's terrain, ground
// overlay and reflections settle, so nothing hitches after you clock in.
const warm = { assets: false, compiled: false, ready: false };
Promise.allSettled([pilotLoaded, crewLoaded]).then(async () => {
  warm.assets = true;
  try {
    await renderer.compileAsync(world, worldCam);
    await renderer.compileAsync(pilot.cockpit.scene, engine.camera);
  } catch (e) {
    console.warn('shader warm-up', e);
  }
  const seen = new Set();
  const upload = (o) => {
    for (const m of [].concat(o.material || [])) {
      for (const k of Object.keys(m)) {
        const tex = m[k];
        if (!tex || !tex.isTexture || seen.has(tex) || !tex.image || tex.isRenderTargetTexture || tex.isDepthTexture) continue;
        seen.add(tex);
        renderer.initTexture(tex);
      }
    }
  };
  world.traverse(upload);
  pilot.cockpit.scene.traverse(upload);
  warm.compiled = true;
});

// saucer parked on the pad (world transform follows the hangar)
const padMatrix = new THREE.Matrix4();
let saucerOnPad = true;
function parkSaucer() {
  hangar.group.updateMatrixWorld(true);
  const local = new THREE.Matrix4().makeTranslation(HANGAR.saucerPad.x, SAUCER.strut, HANGAR.saucerPad.z);
  padMatrix.multiplyMatrices(hangar.group.matrixWorld, local);
  padMatrix.decompose(saucer.group.position, saucer.group.quaternion, saucer.group.scale);
  saucer.group.updateMatrixWorld(true);
  saucer.pool.position.setFromMatrixPosition(padMatrix);
  saucer.pool.position.y -= SAUCER.strut - 0.01;
}
parkSaucer();

// --- environment maps -----------------------------------------------------------------
const cubeRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
const cubeCam = new THREE.CubeCamera(0.1, 3000, cubeRT);
cubeCam.layers.enable(Saucer.LAYER);
world.add(cubeCam);
let interiorEnv = null;
function bakeInterior() {
  const p = new THREE.Vector3(0, 6, 8);
  hangar.group.localToWorld(p);
  cubeCam.position.copy(p);
  const vis = saucer.group.visible;
  saucer.group.visible = false;
  cubeCam.update(renderer, world);
  saucer.group.visible = vis;
  if (interiorEnv) interiorEnv.dispose();
  interiorEnv = engine.pmrem.fromCubemap(cubeRT.texture);
  for (const m of hangar.interior) {
    m.envMap = interiorEnv.texture;
    m.needsUpdate = true;
  }
  saucerEnv = null; // re-pick next frame
}
let saucerEnv = null;

// --- ground under the site --------------------------------------------------------------
// Sample the streamed ground under the footprint and seat the floor on it.
let siteCam = null;
if (earth.mode === 'google') {
  // A helper camera looking straight down keeps the tiles under the hangar sharp for the raycast.
  siteCam = new THREE.PerspectiveCamera(70, 1, 1, 6000);
  siteCam.position.set(hangar.group.position.x, 320, hangar.group.position.z);
  siteCam.up.set(0, 0, -1);
  siteCam.lookAt(hangar.group.position.x, 0, hangar.group.position.z);
  siteCam.updateMatrixWorld();
  earth.addHelperCamera(siteCam, 640, 640);
}
const snap = { at: [2.5, 5, 8, 13, 21, 34], i: 0, stable: 0 };
function snapHangar() {
  // the footprint, the apron's far corners and the yard: nothing may poke through a slab
  const pts = [[0, 0], [-27, -23], [27, -23], [-27, 23], [27, 23], [0, -45], [-25, -60], [25, -60], [-34, -71], [34, -71], [0, -71], [40, -9], [40, 13]];
  const hs = [];
  const p = new THREE.Vector3();
  for (const [x, z] of pts) {
    hangar.group.localToWorld(p.set(x, 0, z));
    const h = earth.groundHeight(p);
    if (h == null) return false;
    hs.push(h);
  }
  hs.sort((a, b) => a - b);
  // DEM: sit on the highest sample (nothing pokes through the floor). Photogrammetry: median (ignore bushes).
  const ground = earth.mode === 'free' ? hs[hs.length - 1] : hs[hs.length >> 1];
  const floor = frame.cartographic(hangar.group.getWorldPosition(p), {}).height;
  const delta = ground + 0.12 - floor;
  if (Math.abs(delta) < 0.03) return true;
  if (Math.abs(delta) > 400) return false; // tile not refined yet
  hangar.group.position.y += delta;
  hangar.group.updateMatrixWorld(true);
  if (saucerOnPad && state.mode !== 'pilot') parkSaucer();
  if (interiorEnv) bakeInterior();
  return false;
}

// --- player -------------------------------------------------------------------------------
const controls = new Controls(canvas);
const walker = new Walker({ colliders: hangar.colliders, start: HANGAR.start, yaw: HANGAR.startYaw });
const saucerCollider = { type: 'circle', x: HANGAR.saucerPad.x, z: HANGAR.saucerPad.z, r: 5.5 };
walker.colliders.push(saucerCollider);
walker.onFootstep = (amp, side) => sound.footstep(amp, side);

const shift = new Shift();
const state = { mode: params.has('fly') ? 'fly' : 'walk', t: 0, started: false };
const fly = { pos: new THREE.Vector3(0, 30, 0), heading: SITE.doorAzimuth, pitch: -5 };

const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const E = new THREE.Vector3();
const N = new THREE.Vector3();
const U = new THREE.Vector3();
const surf = new THREE.Vector3();

/** Ramp foot in hangar-local space (where you stand to board). */
function rampFootLocal(out) {
  out.copy(SAUCER.rampFoot).setY(-SAUCER.strut);
  saucer.group.localToWorld(out);
  return hangar.group.worldToLocal(out);
}

function updateWalk(dt) {
  const m = controls.takeMouse();
  walker.look(m.dx, m.dy);
  walker.enabled = !hud.overlayOpen;
  walker.update(dt, controls, crew.colliders());
  walker.eye(tmpV, tmpQ);
  hangar.group.localToWorld(worldCam.position.copy(tmpV));
  worldCam.quaternion.copy(hangar.group.quaternion).multiply(tmpQ);
  worldCam.near = 0.04;
  worldCam.far = 6e5;
  worldCam.updateProjectionMatrix();
  worldCam.updateMatrixWorld();
}

function updateFly(dt) {
  const m = controls.takeMouse();
  fly.heading += m.dx * 0.12;
  fly.pitch = Math.max(-89, Math.min(89, fly.pitch - m.dy * 0.12));
  const c = frame.enuAt(fly.pos, E, N, U);
  const h = fly.heading * DEG;
  const p = fly.pitch * DEG;
  const fwd = new THREE.Vector3().copy(E).multiplyScalar(Math.sin(h) * Math.cos(p)).addScaledVector(N, Math.cos(h) * Math.cos(p)).addScaledVector(U, Math.sin(p));
  const right = new THREE.Vector3().crossVectors(fwd, U).normalize();
  const camUp = new THREE.Vector3().crossVectors(right, fwd);
  const ground = earth.groundHeight(fly.pos, c);
  const agl = Math.max(1, c.height - (ground ?? SITE.height));
  const speed = (controls.down('ShiftLeft', 'ShiftRight') ? 8 : 1) * (6 + agl * 0.9);
  const mv = new THREE.Vector3().addScaledVector(fwd, controls.axis('KeyS', 'KeyW')).addScaledVector(right, controls.axis('KeyA', 'KeyD')).addScaledVector(U, controls.axis(['KeyC', 'ControlLeft'], 'Space'));
  fly.pos.addScaledVector(mv, speed * dt);
  worldCam.position.copy(fly.pos);
  worldCam.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, camUp, fwd.clone().negate()));
  worldCam.near = Math.max(0.05, Math.min(30, agl * 0.01));
  worldCam.far = Math.max(2e5, Math.sqrt(2 * 6371e3 * agl + agl * agl) * 3 + 4e5);
  worldCam.updateProjectionMatrix();
  worldCam.updateMatrixWorld();
}

// Hangar floor / apron / roof as "ground" for the flight model (overrides the terrain there).
const _fl = new THREE.Vector3();
function floorAt(p, c) {
  const l = hangar.group.worldToLocal(_fl.copy(p));
  const hw = HANGAR.W / 2 + 0.6;
  const hd = HANGAR.D / 2 + 0.6;
  if (Math.abs(l.x) < 35 && l.z > -72 && l.z < hd) {
    if (Math.abs(l.x) < hw && Math.abs(l.z) < hd && l.y > HANGAR.H + 0.2) return c.height - (l.y - (HANGAR.H + 0.4));
    return c.height - l.y;
  }
  return null;
}

// --- transitions ------------------------------------------------------------------------------
let transition = null;
function fadeThrough(fn, dur = 0.45) {
  if (transition) return;
  const u = engine.post.grade.uFade;
  transition = gsap
    .timeline({ onComplete: () => (transition = null) })
    .to(u, { value: 0, duration: dur, ease: 'sine.in' })
    .add(fn)
    .to(u, { value: 1, duration: dur * 1.4, ease: 'sine.out' });
}

function board() {
  sound.play('latch', { gain: 0.6 });
  fadeThrough(() => {
    pilot.board();
    state.mode = 'pilot';
    saucerOnPad = false;
    engine.setStage({ far: world, farCamera: worldCam, near: pilot.cockpit.scene });
    hud.toast('Seated · ARV-3', 'good');
  });
}

function climbOut() {
  fadeThrough(() => {
    pilot.unboard();
    pilot.leaving = false;
    state.mode = 'walk';
    engine.setStage({ far: world, farCamera: worldCam, near: null });
    // walked down the ramp and out from under the rim, turned round to look at her
    const foot = rampFootLocal(new THREE.Vector3());
    const c = hangar.group.worldToLocal(saucer.group.getWorldPosition(new THREE.Vector3()));
    const dx = foot.x - c.x;
    const dz = foot.z - c.z;
    const d = Math.hypot(dx, dz) || 1;
    walker.pos.set(foot.x + (dx / d) * 2.4, 0, foot.z + (dz / d) * 2.4);
    walker.vel.set(0, 0, 0);
    walker.yaw = Math.atan2(-dx, -dz) + Math.PI;
    walker.pitch = -0.05;
    saucerCollider.x = c.x;
    saucerCollider.z = c.z;
    pilot.flight.inside = true;
  });
}

function start() {
  hud.hideOverlay();
  controls.lock();
  sound.start();
  if (!state.started) {
    state.started = true;
    hud.toast(`Clocked in · ${live.clock.slice(0, 5)} PDT`, 'good');
  }
}

function openMap() {
  if (worldMap.isOpen || hud.overlayOpen || transition) return;
  worldMap.open(mapContext());
  controls.enabled = false;
  controls.lockWanted = false;
  controls.keys.clear();
  controls.takeMouse();
  controls.unlock();
  sound.play('beep', { gain: 0.22, rate: 1.25, verb: 0 });
}

/** relock: take the mouse back (needs a click or key press — Esc doesn't count). */
function closeMap(relock) {
  if (!worldMap.isOpen) return;
  worldMap.close();
  controls.enabled = true;
  controls.lockWanted = true;
  controls.takeMouse();
  if (relock && state.started) controls.lock();
  else if (state.started) hud.toast('Click to take the controls');
}

function mapContext() {
  const F = pilot.flight;
  const c = state.mode === 'pilot' ? F.carto : frame.cartographic(worldCam.position, {});
  return { lat: c.lat / DEG, lon: c.lon / DEG, heading: ui.heading, canWarp: pilot.canWarp(), wp: shift.waypoint };
}

function engageWarp(dest) {
  const r = pilot.engageWarp(dest);
  if (r.ok) {
    closeMap(true);
    hud.toast(`Warp · ${dest.name} · ${Math.round(r.eta)} s`, 'good');
  }
  return r;
}

controls.onLockChange = (locked) => {
  if (!locked && state.started && !hud.overlayOpen && !worldMap.isOpen) {
    hud.showOverlay({ title: 'Paused', lede: 'The shift clock is still running. Take your time.', button: 'Resume', onGo: start });
  }
};

controls.onKey((code) => {
  if (worldMap.isOpen) {
    // (only reaches here when focus left the map element)
    if (code === 'KeyM' || code === 'Escape') closeMap(code === 'KeyM');
    else if (code === 'Enter') worldMap.engage();
    return;
  }
  if (hud.overlayOpen || transition) return;
  if (code === 'Backquote' && state.mode !== 'pilot') state.mode = state.mode === 'fly' ? 'walk' : 'fly';
  if (code === 'KeyN') shift.cycleWaypoint(1);
  if (code === 'KeyM') openMap();
  if (code === 'KeyJ' && state.mode !== 'pilot') hud.toast('Board ARV-3 first — the drive is in the craft', 'warn');
  if (state.mode === 'walk' && code === 'KeyE' && ui.canBoard) board();
  if (state.mode === 'pilot') {
    const gearKey = /^Digit(\d)$/.exec(code);
    if (gearKey || code === 'Equal' || code === 'Minus' || code === 'NumpadAdd' || code === 'NumpadSubtract') {
      const F = pilot.flight;
      const i = gearKey ? (Number(gearKey[1]) + 9) % 10 : F.gear + (code === 'Equal' || code === 'NumpadAdd' ? 1 : -1);
      const g = F.setGear(i);
      hud.toast(`Speed gear ${F.gear + 1} · Overdrive Mach ${g.mach} · cruise ×${g.cruise}`, 'info');
    }
    if (code === 'KeyV') {
      const v = pilot.toggleView();
      engine.setStage({ far: world, farCamera: worldCam, near: v === 'chase' ? null : pilot.cockpit.scene });
      hud.toast(v === 'chase' ? 'Chase camera · V for the cockpit · wheel to zoom' : 'Cockpit view', 'info');
    }
    if (code === 'KeyQ') {
      const r = pilot.toggleOverdrive();
      if (!r.ok) hud.toast(r.reason, 'warn');
    }
    if (code === 'KeyJ') {
      if (pilot.warp.state === 'spool') pilot.warp.cancel();
      else if (!worldMap.sel) hud.toast('Pick a destination first · M', 'warn');
      else {
        const r = engageWarp(worldMap.sel);
        if (!r.ok) hud.toast(r.reason, 'warn');
      }
    }
    if (code === 'KeyR') {
      if (!pilot.landed) hud.toast('Set down before shutting the drive', 'warn');
      else {
        pilot.togglePower();
        sound.play('switch', { gain: 0.8, verb: 0.1 });
      }
    }
    if (code === 'KeyF') {
      if (!pilot.canDisembark()) hud.toast(pilot.landed ? 'Climb out at Hangar 9 only' : 'Land first', 'warn');
      else if (pilot.powerOn || pilot.power > 0.02) hud.toast('Shut down the drive first · R', 'warn');
      else {
        pilot.leaving = true;
        sound.play('hiss', { gain: 0.5 });
      }
    }
  }
});

// --- frame loop -------------------------------------------------------------------------------
const hangarCenter = new THREE.Vector3();
const DESERT_ALBEDO = new THREE.Vector3(0.22, 0.2, 0.17);
const PLAYA_ALBEDO = new THREE.Vector3(0.44, 0.41, 0.36);
const live = { power: 0, lat: SITE.lat, lon: SITE.lon, alt: 1346, speed: 0, status: 'PRE-FLIGHT', clock: '' };
const ui = { canBoard: false, heading: 0 };
let odLines = 0;
let lensOD = 0;
let machArmed = true;
const cockpitLive = {};
let baked = 0;
let attribT = 0;
let poweredUp = false;
const local = new THREE.Vector3();
const footL = new THREE.Vector3();

hud.setEarth(
  earth.mode === 'google'
    ? 'Earth · Google Photorealistic 3D Tiles'
    : 'Earth · Esri World Imagery on AWS terrain. Add VITE_GOOGLE_MAPS_API_KEY to .env.local for Google’s photorealistic 3D cities.',
  earth.mode === 'google'
);
hud.showOverlay({ title: 'Day Shift', button: 'Clock in', onGo: () => warm.ready && start() });
hud.setGo('Preparing the shift · 0%', false, 0);

engine.addUpdater((dt, t) => {
  state.t += dt;
  const paused = hud.overlayOpen || worldMap.isOpen;
  if (paused) controls.keys.clear();
  // real time, or ±30 min per second while [ / ] are held
  const scrub = controls.axis('BracketLeft', 'BracketRight');
  clock.utc = new Date(clock.utc.getTime() + dt * (scrub ? scrub * 1800e3 : 1000));
  updateSun();

  if (state.mode === 'fly') updateFly(dt);
  else if (state.mode === 'pilot') {
    if (paused) controls.takeMouse();
    pilot.update(dt, t, controls, floorAt);
    if (pilot.leaving && pilot.ramp >= 0.999) climbOut();
  } else updateWalk(dt);

  const c = frame.cartographic(worldCam.position, {});
  frame.ellipsoid.getCartographicToPosition(c.lat, c.lon, 0, surf);
  atmo.update(worldCam.position, frame.earthCenter, surf.length(), sunWorld);
  // bounce light: the white playa round the site, ordinary desert beyond
  atmo.groundAlbedo.copy(DESERT_ALBEDO).lerp(PLAYA_ALBEDO, 1 - THREE.MathUtils.smoothstep(worldCam.position.distanceTo(hangarCenter), 2500, 9000));
  if (atmo.maybeBake(engine.pmrem)) {
    for (const m of hangar.exterior) m.envMap = atmo.envTexture;
    saucerEnv = null;
  }

  // sun light + shadow frustum around the hangar (only while you're near it)
  hangar.group.getWorldPosition(hangarCenter);
  const nearSite = worldCam.position.distanceTo(hangarCenter) < 4000;
  sun.color.copy(atmo.sunColor);
  sun.intensity = SUN_IRRADIANCE;
  sun.castShadow = nearSite && atmo.sunColor.g > 0.02;
  sun.position.copy(hangarCenter).addScaledVector(sunWorld, 250);
  sun.target.position.copy(hangarCenter);
  sun.target.updateMatrixWorld();
  if (siteGround && (snap.stable > 0 || snap.i >= snap.at.length)) siteGround.update(dt, t, { sunWorld, near: nearSite });

  // interior vs open air, for the camera and for the craft
  hangar.group.worldToLocal(local.copy(worldCam.position));
  const insideCam = hangar.insideness(local);
  for (const k of hangar.keys) k.visible = insideCam > 0.05;
  const inside01 = THREE.MathUtils.clamp((insideCam - 0.1) / 0.5, 0, 1);
  const saucerLocal = hangar.group.worldToLocal(tmpV.copy(saucer.group.position));
  const saucerIn = THREE.MathUtils.clamp((hangar.insideness(saucerLocal) - 0.1) / 0.5, 0, 1);
  const wantEnv = saucerIn > 0.5 && interiorEnv ? interiorEnv.texture : atmo.envTexture;
  if (wantEnv && wantEnv !== saucerEnv) {
    saucerEnv = wantEnv;
    saucer.setEnvMap(wantEnv);
  }
  if (state.mode === 'pilot') pilot.light({ sunWorld, atmo, outside: 1 - inside01, env: wantEnv, sunIntensity: SUN_IRRADIANCE });

  earth.update();
  crew.update(dt, state.mode === 'walk' ? walker.pos : null);
  if (state.mode !== 'pilot') saucer.update(dt, t);

  // where are we (the craft when seated, else your eyes)
  const F = pilot.flight;
  const seated = state.mode === 'pilot';
  const here = seated ? F.carto : c;
  const lat = here.lat / DEG;
  const lon = here.lon / DEG;
  const fwd = worldCam.getWorldDirection(tmpV);
  frame.enuAt(worldCam.position, E, N, U);
  const heading = seated ? ((F.heading / DEG) % 360 + 360) % 360 : ((Math.atan2(fwd.dot(E), fwd.dot(N)) / DEG) + 360) % 360;
  let agl = walker.eyeHeight;
  if (seated) agl = F.agl;
  else if (state.mode === 'fly') agl = c.height - (earth.groundHeight(worldCam.position, c) ?? c.height);
  const home = greatCircle(here.lat, here.lon, HOME.lat * DEG, HOME.lon * DEG);

  // the shift
  const sl = hangar.group.worldToLocal(footL.copy(F.pos));
  const objective = shift.update({
    mode: state.mode,
    power: pilot.power,
    landed: F.landed,
    outsideHangar: seated && (Math.abs(sl.x) > HANGAR.W / 2 + 4 || Math.abs(sl.z) > HANGAR.D / 2 + 4 || sl.y > HANGAR.H + 2),
    insideHangar: seated && Math.abs(sl.x) < HANGAR.W / 2 - 4 && Math.abs(sl.z) < HANGAR.D / 2 - 4 && sl.y < 4,
    lat,
    lon,
    agl,
  });
  for (const e of shift.events.splice(0)) {
    hud.toast(e.text, e.type === 'step' || e.type === 'waypoint' ? 'info' : 'good');
    sound.play(e.type === 'complete' ? 'chime' : e.type === 'waypoint' ? 'beep' : 'confirm', { gain: 0.45, verb: 0.15 });
  }
  for (const e of pilot.events.splice(0)) {
    if (e === 'power-on') hud.toast('Drive spooling', 'info');
    if (e === 'power-off') {
      hud.toast('Drive shutting down', 'info');
      poweredUp = false;
    }
    if (e === 'liftoff') sound.play('thud', { gain: 0.25, rate: 1.4, verb: 0.3 });
    if (e === 'landed') {
      sound.play('thud', { gain: 0.6, verb: 0.4 });
      hud.toast('Weight on struts', 'info');
    }
    if (e === 'ramp') sound.play('clunk', { gain: 0.5, verb: 0.5 });
    if (e === 'overdrive-on') {
      hud.toast('Overdrive · inertia off', 'warn');
      sound.play('jolt', { gain: 0.5, rate: 0.8, verb: 0.2 });
    }
    if (e === 'overdrive-off') {
      hud.toast('Overdrive off', 'info');
      sound.play('switch', { gain: 0.6, verb: 0.1 });
    }
  }
  const W = pilot.warp;
  for (const e of W.events.splice(0)) {
    if (e === 'spool') sound.play('rcs', { gain: 0.35, rate: 0.7, verb: 0.2 });
    if (e === 'jump') {
      sound.play('boom', { gain: 0.95, rate: 0.72, verb: 0.25 });
      earth.setDetail(4); // nothing to see at these speeds: stream coarse tiles
    }
    if (e === 'exit') {
      sound.play('boom', { gain: 0.6, rate: 1.3, verb: 0.2 });
      earth.setDetail(1);
      hud.toast(`Arrived · ${W.dest.name}`, 'good');
    }
    if (e === 'cancel') hud.toast('Warp aborted', 'warn');
  }
  // sonic boom when you go through Mach 1 in the air (not in the warp tunnel)
  if (seated && !W.active) {
    if (F.mach < 0.9) machArmed = true;
    else if (machArmed && F.mach >= 1 && F.carto.height < 30000) {
      machArmed = false;
      sound.play('boom', { gain: 0.85, rate: 1.05, verb: 0.3 });
      hud.toast('Mach 1', 'info');
    }
  }
  const overdrive = seated && F.overdrive && !F.inside;
  odLines = THREE.MathUtils.damp(odLines, overdrive ? THREE.MathUtils.clamp((F.mach - 1.2) / 8, 0, 0.75) : 0, 3, dt);
  warpFx.set({ tunnel: seated ? W.fx.tunnel : 0, lines: odLines, time: t });
  // speed on the lens: liquid edges + fringing grow with airspeed, more in Overdrive and the warp
  const flowTarget = seated && !F.landed ? THREE.MathUtils.smoothstep(F.speed, 6, 60) * 0.3 + THREE.MathUtils.clamp(Math.log10(1 + F.speed / 120) / 2.2, 0, 1) * 0.45 + (overdrive ? 0.2 : 0) + W.fx.tunnel * 0.4 : 0;
  flow = THREE.MathUtils.damp(flow, Math.min(1, flowTarget), 2.5, dt);
  engine.post.grade.uFlow.value = flow < 0.002 ? 0 : flow;
  // Overdrive glass on the sides of the frame: fbm warp, barrel, fringing — grows with Mach
  lensOD = THREE.MathUtils.damp(lensOD, overdrive ? 0.6 + THREE.MathUtils.clamp(Math.log10(1 + F.mach) / 2, 0, 0.4) : 0, 3, dt);
  engine.post.grade.uLens.value = lensOD < 0.002 ? 0 : lensOD;
  // AO: a room-scale radius indoors; outside it widens with distance so streets and courtyards read too
  aoWorld.set(inside01 > 0.5 ? { radius: 1.6, grow: 0, intensity: 1.8, maxDist: 120 } : { radius: 1.4, grow: 0.012, intensity: 0.55, maxDist: 6000 });
  buildings.update(dt, { lat, lon, agl: Math.max(0, agl), speed: seated ? F.speed : 0, busy: seated && W.active, dest: seated && W.active ? W.dest : null });
  engine.post.grade.uFlash.value = W.fx.flash * 0.85;
  if (seated && pilot.power >= 1 && !poweredUp) {
    poweredUp = true;
    hud.toast('Drive online', 'good');
    sound.play('confirm', { gain: 0.4, verb: 0.1 });
  }

  // prompts
  let prompt = null;
  ui.canBoard = false;
  if (state.mode === 'walk' && !transition) {
    rampFootLocal(footL);
    const d = Math.hypot(walker.pos.x - footL.x, walker.pos.z - footL.z);
    ui.canBoard = d < 2.0 && saucer.ramp > 0.95;
    if (ui.canBoard) prompt = { key: 'E', text: 'Board ARV-3' };
  } else if (seated && !pilot.leaving && !transition) {
    if (W.active) prompt = W.state === 'spool' ? { key: 'J', text: 'Abort warp' } : null;
    else if (F.landed) {
      const atHome = pilot.canDisembark();
      if (!pilot.powerOn && pilot.power <= 0.001) prompt = { key: 'R', text: atHome ? 'Spool the drive  ·  F to climb out' : 'Spool the drive' };
      else if (!pilot.powerOn) prompt = { key: 'R', text: 'Spinning down…' };
      else if (pilot.power < 1) prompt = { key: 'R', text: `Spooling · ${Math.round(pilot.power * 100)}%` };
      else prompt = atHome && shift.current.id !== 'liftoff' && shift.step > 2 ? { key: 'R', text: 'Shut down the drive' } : { key: 'Space', text: 'Lift off' };
    } else if (F.agl < 6 && F.speed < 5) prompt = { key: 'C', text: 'Hold to set down' };
  }

  // nearest named place, for the map caption
  let where = '';
  if (home.dist < 1200) where = 'Hangar 9 · Groom Lake';
  else if (home.dist < 25000) where = 'Groom Lake';
  else {
    let best = null;
    for (const w of shift.custom ? [shift.custom, ...NAMED] : NAMED) {
      const g = greatCircle(here.lat, here.lon, w.lat * DEG, w.lon * DEG);
      if (!best || g.dist < best.d) best = { d: g.dist, w };
    }
    where = best && best.d < 30000 ? `Near ${best.w.name}` : `${fmtDist(home.dist)} from home`;
  }

  const lt = new Date(clock.utc.getTime() + SITE.utcOffset * 3600e3);
  live.clock = `${String(lt.getUTCHours()).padStart(2, '0')}:${String(lt.getUTCMinutes()).padStart(2, '0')}:${String(lt.getUTCSeconds()).padStart(2, '0')} PDT`;
  live.power = pilot.power;
  live.night = THREE.MathUtils.clamp((0.06 - atmo.sunMu) / 0.16, 0, 1); // lamps on from late dusk
  if (seated || !saucerOnPad) {
    live.lat = F.carto.lat / DEG;
    live.lon = F.carto.lon / DEG;
    live.alt = F.carto.height;
    live.speed = F.speed * 3.6;
    live.status = F.landed ? (pilot.power > 0.05 ? 'ENGAGED' : 'PARKED') : 'AIRBORNE';
  }
  hangar.update(dt, t, live);

  if (seated) {
    Object.assign(cockpitLive, {
      power: pilot.power,
      heading,
      pitch: (F.tilt.z + F.attitude) / DEG, // + nose up
      bank: -F.tilt.x / DEG, // + right wing down
      speed: F.speed,
      agl: F.agl,
      alt: F.carto.height,
      vs: F.vs,
      thrust: pilot.thrust,
      strut: F.strut,
      ramp: pilot.ramp,
      landed: F.landed,
      clock: live.clock,
      objective: objective.title,
      wpName: objective.wp.name,
      wpDist: objective.wp.dist,
      wpBrg: objective.wp.brg,
      homeDist: home.dist,
      homeBrg: home.bearing,
      lat,
      lon,
      warn: F.agl < 25 && F.vs < -6 ? 'SINK RATE' : '',
      overdrive,
      warp: W.state,
    });
    pilot.updateCockpit(dt, t, cockpitLive);
  }

  hud.update(dt, {
    mode: state.mode,
    clock: live.clock,
    lat,
    lon,
    heading,
    alt: here.height,
    agl: Math.max(0, agl),
    speed: seated ? F.speed : state.mode === 'walk' ? walker.speed : 0,
    vs: seated ? F.vs : 0,
    power: pilot.power,
    mach: seated ? F.mach : 0,
    drive: !seated || (F.landed && !W.active) ? 'PARKED' : W.active ? 'WARP' : overdrive ? 'OVERDRIVE' : 'CRUISE',
    warp: seated && W.active ? { state: W.state, name: W.dest.name, factor: W.fx.factor, remaining: W.state === 'jump' ? W.fx.remaining : W.state === 'spool' ? W.dist : 0, progress: W.state === 'spool' ? 0 : W.state === 'jump' ? 1 - W.fx.remaining / W.dist : 1 } : null,
    objective,
    prompt,
    home: HOME,
    homeBrg: home.bearing,
    where,
  });
  ui.heading = heading;
  if (worldMap.isOpen) worldMap.update({ lat, lon, heading, canWarp: pilot.canWarp(), wp: objective.wp });
  attribT -= dt;
  if (attribT <= 0) {
    attribT = 2;
    hud.setAttribution(`${earth.attributions()}${buildings.active ? ` · ${BUILDINGS_ATTRIBUTION}` : ''} · Map © Esri`);
    const n = earth.loading;
    hud.setLoading(n > 0 ? `Streaming terrain · ${n} tiles in flight` : 'Terrain streamed');
  }

  const dCraft = worldCam.position.distanceTo(saucer.group.position);
  sound.update(dt, { inside: inside01, seated, power: pilot.power, thrust: pilot.thrust, speed: F.speed, dist: dCraft, alt: here.height, warpCharge: W.charge, warpTunnel: W.state === 'jump' ? W.fx.tunnel : 0, overdrive });

  engine.post.sun.dir.copy(sunWorld);
  engine.post.sun.camera = worldCam;
  engine.post.sun.intensity = 0.2 * Math.max(0, Math.min(1, atmo.sunMu * 5 + 0.5));

  // seat the hangar on the streamed ground, then bake the interior reflections
  if (snap.i < snap.at.length && state.t > snap.at[snap.i]) {
    snap.i++;
    if (snapHangar()) snap.stable++;
    if ((snap.stable >= 2 || snap.i >= snap.at.length) && siteCam) {
      earth.removeHelperCamera(siteCam);
      siteCam = null;
    }
  }
  if (baked === 0 && state.t > 1.5) {
    bakeInterior();
    baked = 1;
  } else if (baked === 1 && (state.t > 12 || (state.t > 4 && earth.loading < 12 && snap.stable > 0))) {
    bakeInterior();
    baked = 2;
  }
  if (!warm.ready && !state.started) {
    const steps = [
      [warm.assets, 0.2],
      [warm.compiled, 0.25],
      [snap.stable > 0 || snap.i >= snap.at.length, 0.15],
      [!siteGround || siteGround.passes > 0, 0.1],
      [baked >= 2, 0.1],
      [Math.max(0, 1 - earth.loading / 150), 0.2],
    ];
    let p = 0;
    for (const [v, w] of steps) p += (v === true ? 1 : v === false ? 0 : v) * w;
    if (p > 0.985 || (state.t > 45 && warm.compiled)) {
      warm.ready = true;
      hud.setGo('Clock in', true);
    } else hud.setGo(`Preparing the shift · ${Math.floor(p * 100)}%`, false, p);
  }
  controls.endFrame();
});

// ?seat — start in the cockpit (handy while working on the flight side)
if (params.has('seat')) {
  pilot.board();
  state.mode = 'pilot';
  saucerOnPad = false;
  engine.setStage({ far: world, farCamera: worldCam, near: pilot.cockpit.scene });
}

window.__a51 = { engine, autoRes, siteGround, warm, snap, aoWorld, aoCockpit, earth, atmo, frame, clock, worldCam, world, hangar, saucer, crew, walker, state, fly, sun, pilot, shift, hud, sound, worldMap, warpFx, buildings, openMap, closeMap, engageWarp, bakeInterior, board, climbOut, snapHangar };
engine.start();
