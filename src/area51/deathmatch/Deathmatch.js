import { MathUtils, Matrix4, Quaternion, Vector3, Vector4 } from 'three';
import { mulberry32 } from '../../core/math.js';
import { atmospherize } from '../earth/atmosphere.js';
import { Saucer } from '../ufo/Saucer.js';
import { Arena, ARENA, NUREMBERG } from './arena.js';
import { DmHud } from './DmHud.js';
import { Fx } from './fx.js';
import { Intro, INTRO } from './intro.js';
import { Match } from './match.js';
import { DmSfx } from './sfx.js';
import { ARV, Fleet, patchShipMaterial, SHIP_UNIFORMS, STYLES } from './ships.js';
import { ORDER, WEAPONS } from './weapons.js';

/**
 * Deathmatch over Nuremberg — you in ARV-3 against 99 bot pilots in six
 * kinds of craft. Owns the arena, effects, fleet, match and HUD; borrows the
 * game's flight model, cockpit and cameras for your own craft.
 *
 *   loading    the camera holds the opening shot so its tiles stream in
 *   intro      the fleet teleports in (intro.js), you last
 *   countdown  3 · 2 · 1 — you can fly, nobody can shoot
 *   fight      six minutes or first to 25 kills
 *   over       results; fight again (short intro) or back to Day Shift
 *
 * Shot down, the camera stays outside on your burning wreck until it hits
 * the ground (or blows apart), then you teleport back in somewhere quiet.
 */
const COUNTS = [22, 22, 16, 14, 8, 17]; // disc, orb, tic tac, triangle, cylinder, cross → 99
const MATCH_TIME = 360;
const KILL_LIMIT = 25;
const RESPAWN = 2.5; // s after the wreck is gone

const CALLSIGNS = [
  'Roswell', 'Kecksburg', 'Rendlesham', 'Phoenix', 'Hessdalen', 'Varginha', 'Westall', 'Aurora', 'Lubbock', 'Malmstrom',
  'Nimitz', 'Socorro', 'Levelland', 'Flatwoods', 'Mantell', 'Shag Harbour', 'Falcon Lake', 'Stephenville', "O'Hare", 'Minot',
  'Valensole', 'Kaikoura', 'Colares', 'Hopkinsville', 'Foo Fighter', 'Ghost Rocket', 'Blue Book', 'Grudge', 'Majestic', 'Dulce',
  'Aztec', 'Bentwaters', 'Lakenheath', 'Calvine', 'Basel 1566', 'Glaser', 'Tehran', 'Belgian Wave', 'Cash-Landrum', 'Pascagoula',
  'Coyne', 'Ariel', 'Gimbal', 'GoFast', 'Skinwalker', 'Marfa', 'Hudson Valley', 'Washington 52', 'Battle of LA', 'Trans-en-Provence',
  'Ruwa', 'Voronezh', 'Petrozavodsk', 'Kumburgaz', 'JAL 1628', 'Yukon', 'Cosford', 'Exeter', 'Mansfield', 'Tinley Park',
];

const UP = new Vector3(0, 1, 0);
const _v = new Vector3();
const _w = new Vector3();
const _b = new Vector3();
const _e = new Vector3();
const _t = new Vector3();
const _u = new Vector3();
const _q = new Quaternion();
const _qs = new Quaternion();
const _m = new Matrix4();

/** n distinct callsigns (a second round gets II, III…). */
function callsigns(n, rand) {
  const list = [...CALLSIGNS];
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  const roman = ['', ' II', ' III', ' IV'];
  const out = [];
  for (let i = 0; i < n; i++) out.push(`${list[i % list.length]}${roman[Math.floor(i / list.length)] ?? ` ${i}`}`);
  return out;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export class Deathmatch {
  constructor({ engine, world, worldCam, frame, earth, pilot, saucer, hud, sound, controls, atmo, atmoU, floorAt, onLeave }) {
    Object.assign(this, { engine, world, worldCam, frame, earth, pilot, saucer, hud, sound, controls, atmo, floorAt, onLeave });
    this.rand = mulberry32((Date.now() / 1000) & 0xffffff);
    this.arena = new Arena({ frame, earth });
    world.add(this.arena.group);
    this.fx = new Fx({ quality: engine.quality.name });
    this.fleet = new Fleet(COUNTS);
    this.arena.group.add(this.fleet.group, this.fx.group);
    for (const m of [...this.fleet.materials, this.fx.debris.material, this.fx.missiles.material]) atmospherize(m, atmoU);
    this._env = null;
    this.sfx = new DmSfx(sound);
    this.match = new Match({ arena: this.arena, fx: this.fx, sfx: this.sfx, rand: this.rand });

    // you: the hit sphere's centre sits 1.4 m above the belly
    const c = ARV.center;
    const rel = (list) => list.map(([x, y, z]) => [x - c[0], y - c[1], z - c[2]]);
    this.me = this.match.add({ name: 'ARV-3', style: ARV, isPlayer: true, muzzles: rel(ARV.muzzles), pods: rel(ARV.pods) });
    this.hullMuzzles = this.me.muzzles;
    this.sillMuzzles = [[0, 0, 0], [0, 0, 0]];
    this.me.paint.setRGB(0.78, 0.8, 0.83);
    // everyone else
    const names = callsigns(COUNTS.reduce((a, b) => a + b, 0), this.rand);
    let n = 0;
    STYLES.forEach((st, si) => {
      for (let k = 0; k < COUNTS[si]; k++) {
        const s = this.match.add({ name: names[n++], style: st, styleIdx: si, slot: k });
        s.paint.copy(this.fleet.paint(si, k, this.rand).paint);
        s.scale = 0.94 + this.rand() * 0.12;
      }
    });
    // ARV-3 chars, flashes and teleports like the rest (one uniform for all its parts)
    this.saucerU = { value: new Vector4(0, 0, 1, 1) };
    saucer.group.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of [].concat(o.material)) {
        if (m.userData.dmPatched) continue;
        m.userData.dmShip = this.saucerU;
        patchShipMaterial(m, m.isMeshBasicMaterial ? 'light' : 'hull', { instanced: false, lightGlow: false });
      }
    });
    // Out of the fight the saucer waits on its pad at Groom Lake, far out of sight. (It is never
    // hidden: its lights would drop out of the scene and every lit shader would recompile.)
    this.parked = saucer.group.position.clone();
    this.parkedQ = saucer.group.quaternion.clone();
    saucer.pool.visible = false;

    this.ui = new DmHud(hud.root, { onAgain: () => this.restart(), onLeave: () => this.leave() });
    this.intro = new Intro(this);
    this.phase = 'loading';
    this.loadT = 0;
    this.view = 'cockpit';
    this.timer = MATCH_TIME;
    this.countT = 0;
    this._lastCount = 4;
    this.respawnIn = 0;
    this.outside = 0;
    this.lock = { ship: null, t: 0, locked: false, beep: 0 };
    this.camPos = new Vector3();
    this.camDir = new Vector3(0, 0, -1);
    this.camRight = new Vector3(1, 0, 0);
    this.aimPoint = new Vector3();
    this.target = null;
    this.deathCam = { a: 0, t: 0, at: new Vector3() };
    this.flying = false;
    this.streak = 0;
    this.streakT = 0;
    this.msgT = 0;
    this.alarmT = 0;
    this.standings = [];
    this.standT = 0;
    this._boardOn = false;
    this._killedBy = '';
    this.prompt = null;
    this._project = this._project.bind(this);

    // your flight model, tuned for a dogfight over a city; the wheel picks weapons
    pilot.flight.arcade = { vmax: 175, vmaxV: 110, boost: 1.9, accel: 2.4, machCap: 3 };
    pilot.wheelZoom = false;
    // eyes level in a fight: the crosshair clears the console instead of sitting on its edge
    pilot.headRest = 0.03;
  }

  // ------------------------------------------------------------ lifecycle

  /** Loading progress 0..1: the height field, the opening shot's tiles, a minimum settle time. */
  progress() {
    const settled = this.loadT > 1.5 ? Math.max(0, 1 - this.earth.loading / 100) : 0;
    return Math.min(1, this.arena.coverage / 0.9) * 0.3 + settled * 0.45 + Math.min(1, this.loadT / 6) * 0.25;
  }

  launch() {
    if (this.phase !== 'loading') return;
    this.ui.show(true);
    this.ui.cinematic(true);
    this.phase = 'intro';
    this.match.hold = true;
    this._stage();
    this.intro.start();
  }

  restart() {
    this.fx.clear();
    this.match.reset();
    this.match.hot = false;
    this.match.hold = true;
    this.match.respawns = false;
    this.timer = MATCH_TIME;
    this.flying = false;
    this.streak = 0;
    this.lock.ship = null;
    this.outside = 0;
    this._parkSaucer();
    this.ui.results(null);
    this.ui.message('');
    this.ui.cinematic(true);
    this._stage();
    this.phase = 'intro';
    this.intro.start({ short: true });
    this.controls.lock();
  }

  /** Back to Day Shift (the owner reloads without ?dm). */
  leave() {
    if (this.onLeave) this.onLeave();
  }

  /** The pause card shouldn't cover the loading view or the results. */
  get pausable() {
    return this.phase !== 'over' && this.phase !== 'loading';
  }

  // ------------------------------------------------------------ input

  onKey(code) {
    if (this.phase === 'intro' && (code === 'Space' || code === 'Enter')) {
      this.intro.skip();
      return;
    }
    if (code === 'Space' && !this.flying && this.me.state === 'dead' && this.phase === 'fight') {
      this.respawnIn = 0; // don't wait
      return;
    }
    if (!this.flying) return;
    const m = /^(?:Digit|Numpad)([1-6])$/.exec(code);
    if (m) this._select(ORDER[Number(m[1]) - 1]);
    if (code === 'KeyV') {
      this.view = this.pilot.toggleView();
      this._stage();
      this.hud.toast(this.view === 'cockpit' ? 'Cockpit view' : this.view === 'third' ? 'Third person · right drag to look around' : 'Chase camera · see the ground below', 'info');
    }
    if (code === 'KeyQ') {
      const r = this.pilot.toggleOverdrive();
      if (!r.ok) this.hud.toast(r.reason, 'warn');
    }
    if (code === 'KeyM' || code === 'KeyJ' || code === 'KeyF' || code === 'KeyR') this.hud.toast('Not in a deathmatch', 'warn');
  }

  _select(id) {
    if (!id || this.me.weapon === id) return;
    this.me.weapon = id;
    this.lock.ship = null;
    this.lock.t = 0;
    this.sfx.ui('beep', 0.12, 1.6);
  }

  // ------------------------------------------------------------ frame

  update(dt, t, paused) {
    this.arena.update(dt, t);
    if (this.phase === 'loading') {
      this.loadT += dt;
      this._cine(this.intro.loadingPose());
      this._frame(0);
      return;
    }
    if (paused) {
      this.controls.takeMouse();
      return;
    }
    if (this.phase === 'intro') this._intro(dt);
    else this._play(dt, t);
    this._frame(dt);
  }

  _intro(dt) {
    const I = this.intro;
    this.controls.takeMouse();
    I.update(dt);
    this._cine(I);
    this.engine.post.grade.uFade.value = I.fade;
    const ti = I.titles();
    this.ui.banner(ti ? { ...ti, count: I.t > 2 ? `Contacts inbound · ${I.arrived} / ${I.total}` : '' } : null);
    this.prompt = I.t < INTRO.shotC ? { key: 'Space', text: 'Skip to your arrival' } : null;
    if (I.done) this._countdown();
  }

  _countdown() {
    this.engine.post.grade.uFade.value = 1;
    this.ui.banner(null);
    this.ui.cinematic(false);
    this.prompt = null;
    this.phase = 'countdown';
    this.countT = 3.2;
    this._lastCount = 4;
    const me = this.me;
    if (me.state === 'inbound') this.match._arrive(me);
    this._board(me.pos, Math.atan2(me.fwd.x, -me.fwd.z));
  }

  _fight() {
    this.phase = 'fight';
    this.match.hold = false;
    this.match.hot = true;
    this.match.respawns = true;
    this.ui.countdown('FIGHT');
    this.sfx.ui('dm_go', 0.55);
  }

  _end(reason) {
    this.phase = 'over';
    this.match.hot = false;
    this.match.respawns = false;
    this.me.trigger = false;
    const st = this.match.standings();
    const rank = st.indexOf(this.me) + 1;
    this.ui.results({ reason, rank, kills: this.me.kills, deaths: this.me.deaths, winner: st[0] === this.me ? 'you' : st[0].name, rows: this._rows(st, 10) });
    this.ui.message('');
    this.sfx.ui('chime', 0.4);
    this.controls.unlock();
  }

  _play(dt, t) {
    const me = this.me;
    if (this.phase === 'countdown') {
      this.countT -= dt;
      const c = Math.ceil(this.countT);
      if (c < this._lastCount && c > 0) {
        this._lastCount = c;
        this.ui.countdown(String(c));
        this.sfx.ui('beep', 0.3, 1);
      }
      if (this.countT <= 0) this._fight();
    } else if (this.phase === 'fight') {
      this.timer -= dt;
      const lead = this._leader();
      if (this.timer <= 0) this._end('time');
      else if (lead && lead.kills >= KILL_LIMIT) this._end(`${lead === me ? 'you' : lead.name} reached ${KILL_LIMIT}`);
    }
    if (this.flying) {
      this.pilot.update(dt, t, this.controls, this.floorAt);
      this._syncMe();
      this._weapons(dt);
      this._bounds(dt);
    } else this._spectate(dt);
    if (this.msgT > 0 && (this.msgT -= dt) <= 0) this.ui.message('');
  }

  _leader() {
    let best = null;
    for (const s of this.match.ships) if (!best || s.kills > best.kills) best = s;
    return best;
  }

  /** Effects, fleet and HUD — every frame (dt 0 while loading). */
  _frame(dt) {
    const fx = this.fx;
    const cam = this.engine.camera;
    this._envMaps();
    fx.setView({ fovDeg: cam.fov, heightPx: this.engine.renderer.domElement.height, wind: this.arena.wind, sunColor: this.atmo.sunColor, skyColor: this.atmo.skyColor });
    fx.update(dt);
    this._camLocal();
    this.sfx.frame(this.camPos, this.camRight);
    if (dt > 0) {
      this.match.update(dt);
      fx.debris.update(dt, this.arena, fx, fx.time);
    }
    this.match.draw();
    this._drawFleet();
    this._drawSaucer(dt);
    fx.commit();
    SHIP_UNIFORMS.uDmTime.value = fx.time;
    this._events();
    this._hud(dt);
  }

  /** The sky's reflections on every hull, shard and missile (the atmosphere re-bakes them as you climb). */
  _envMaps() {
    const env = this.atmo.envTexture;
    if (!env || env === this._env) return;
    this._env = env;
    this.fleet.setEnvMap(env);
    for (const m of [this.fx.debris.material, this.fx.missiles.material]) {
      m.envMap = env;
      m.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------ your craft

  /** Into the seat at an arena-local hit-sphere centre, facing `heading` (rad from north). */
  _board(center, heading) {
    const P = this.pilot;
    const F = P.flight;
    _v.set(center.x, center.y - ARV.center[1], center.z);
    this.arena.toWorld(_v, F.pos);
    F.vel.set(0, 0, 0);
    F.heading = F.headingTarget = heading;
    F.attitude = 0;
    F.pitch = P.headRest;
    F.headYaw = 0;
    F.tilt.set(0, 0, 0);
    F.landed = false;
    F.overdrive = false;
    F.inside = false;
    F.strut = 0;
    F.ground = null;
    F.groundT = 0;
    P.active = true;
    P.powerOn = true;
    P.power = 1;
    P.ramp = 0;
    P.leaving = false;
    P.headYaw = 0;
    this.saucer.setStruts(0);
    this.saucer.setRamp(0);
    this.saucer.setPower(1);
    P.setView(this.view);
    this.flying = true;
    this._stage();
    this.lock.ship = null;
    this.outside = 0;
    this.ui.message('');
    this.controls.takeMouse();
  }

  /** Cockpit layer on or off, and whether the world camera sees your own hull. */
  _stage() {
    const cockpit = this.flying && this.pilot.view === 'cockpit';
    if (cockpit) this.worldCam.layers.disable(Saucer.LAYER);
    else this.worldCam.layers.enable(Saucer.LAYER);
    this.engine.setStage({ far: this.world, farCamera: this.worldCam, near: cockpit ? this.pilot.cockpit.scene : null });
  }

  /** Your ship in the match follows the flight model. */
  _syncMe() {
    const F = this.pilot.flight;
    const me = this.me;
    _v.set(0, ARV.center[1], 0).applyMatrix4(this.saucer.group.matrixWorld);
    this.arena.toLocal(_v, me.pos);
    this.arena.dirToLocal(F.vel, me.vel);
    me.quat.copy(this.arena.qLocal).multiply(F.quat);
    me.fwd.set(0, 0, -1).applyQuaternion(me.quat);
  }

  _weapons(dt) {
    const me = this.me;
    const P = this.pilot;
    if (P.wheel) {
      const i = ORDER.indexOf(me.weapon);
      this._select(ORDER[(i + (P.wheel > 0 ? 1 : -1) + ORDER.length) % ORDER.length]);
    }
    // aim: whatever is under the crosshair (a little generous), else the ground, else 1.4 km out
    this._camLocal();
    const hit = this.match.raycastShips(this.camPos, this.camDir, 2600, me, 1.3);
    let dist = hit ? hit.t : 1400;
    const g = this.arena.rayGround(this.camPos, this.camDir, dist);
    this.target = hit && g < 0 ? hit.ship : null;
    if (g >= 0) dist = g;
    this.aimPoint.copy(this.camPos).addScaledVector(this.camDir, Math.max(dist, 40));
    me.aimPoint = this.aimPoint;
    me.aim.copy(this.camDir);
    // From the cockpit your guns sit below the sill, out of sight: your shots
    // leave from the lower corners of the canopy instead, so you see them go.
    if (this.view === 'cockpit') {
      _u.crossVectors(this.camRight, this.camDir);
      _q.copy(me.quat).invert();
      this.sillMuzzles.forEach((m, k) => {
        _v.copy(this.camPos)
          .addScaledVector(this.camDir, 5)
          .addScaledVector(this.camRight, k ? 1.95 : -1.95)
          .addScaledVector(_u, -0.25)
          .sub(me.pos)
          .applyQuaternion(_q)
          .divideScalar(me.scale);
        m[0] = _v.x;
        m[1] = _v.y;
        m[2] = _v.z;
      });
      me.muzzles = this.sillMuzzles;
      me.fxScale = 0.3;
    } else {
      me.muzzles = this.hullMuzzles;
      me.fxScale = 1;
    }
    if (me.weapon === 'missile') this._lockOn(dt);
    else {
      this.lock.ship = null;
      me.lockTarget = null;
    }
    me.trigger = this.phase === 'fight' && me.state === 'alive' && this.controls.leftDown && !this.hud.overlayOpen;
  }

  /** Seekers: hold a craft inside the lock circle for lockTime to lock it (beeps, then a tone). */
  _lockOn(dt) {
    const W = WEAPONS.missile;
    const L = this.lock;
    const me = this.me;
    let best = null;
    let bestA = W.lockCone;
    for (const s of this.match.ships) {
      if (s === me || !s.targetable) continue;
      _b.subVectors(s.pos, this.camPos);
      const d = _b.length();
      if (d > W.range || d < 30) continue;
      const a = Math.acos(MathUtils.clamp(_b.dot(this.camDir) / d, -1, 1));
      if (a < bestA) {
        bestA = a;
        best = s;
      }
    }
    if (best !== L.ship) {
      L.ship = best;
      L.t = 0;
      L.locked = false;
      L.beep = 0;
    } else if (best) {
      L.t += dt;
      if (!L.locked && L.t >= W.lockTime) {
        L.locked = true;
        this.sfx.ui('dm_locked', 0.3);
      } else if (!L.locked && (L.beep -= dt) <= 0) {
        L.beep = 0.14;
        this.sfx.ui('dm_lock', 0.22);
      }
    }
    me.lockTarget = L.locked ? L.ship : null;
  }

  /** Too far out or too high: a warning, then the hull starts to fail. */
  _bounds(dt) {
    const me = this.me;
    const r = Math.hypot(me.pos.x, me.pos.z);
    const agl = me.pos.y - this.arena.groundY(me.pos.x, me.pos.z);
    if (me.state === 'alive' && this.phase === 'fight' && (r > ARENA.radius || agl > 2300)) {
      this.outside += dt;
      this.ui.message(`<span class="warn">Return to the battle · ${Math.max(0, 5 - this.outside).toFixed(0)}</span>`);
      this.msgT = 0.3;
      if (this.outside > 5) this.match.damage(me, 14 * dt, null, 'crash', null, null, true);
    } else this.outside = 0;
  }

  /** Outside cameras while you're down, dead or teleporting back in (the mouse swings them round). */
  _spectate(dt) {
    const me = this.me;
    const D = this.deathCam;
    const m = this.controls.takeMouse();
    D.t += dt;
    D.a += dt * 0.25 + m.dx * 0.004;
    let dist;
    if (me.state === 'down') {
      _t.copy(me.pos);
      dist = 40 + me.radius * 2;
      D.at.copy(me.pos);
    } else if (me.state === 'dead') {
      _t.copy(D.at).y += 14;
      dist = 70 + Math.min(50, D.t * 8);
      if (this.phase === 'fight') {
        this.respawnIn -= dt;
        this.ui.message(`<span class="big">Shot down</span>${this._killedBy}<br/>Teleporting back in ${Math.max(0, Math.ceil(this.respawnIn))} · Space to go now`);
        if (this.respawnIn <= 0) {
          this.match.respawn(me, this.match.pickSpawn(_v));
          D.t = 0;
        }
      }
    } else if (me.state === 'inbound') {
      _t.copy(me.spawn);
      dist = 70;
      if (D.t < dt * 1.5) D.a = Math.atan2(-me.spawn.z, -me.spawn.x) + Math.PI + 0.6; // first frame: from the outside, looking in
      this.ui.message('');
    } else if (me.state === 'alive') {
      // arrived: back in the seat
      this._board(me.pos, Math.atan2(me.fwd.x, -me.fwd.z));
      return;
    } else return;
    _e.set(_t.x + Math.cos(D.a) * dist, _t.y + dist * 0.38, _t.z + Math.sin(D.a) * dist);
    const floor = this.arena.groundY(_e.x, _e.z) + 15;
    if (_e.y < floor) _e.y = floor;
    this._cine({ eye: _e, look: _t, fov: 58 });
  }

  /** Out of sight: back on its pad 9,000 km away. */
  _parkSaucer() {
    const S = this.saucer;
    S.group.position.copy(this.parked);
    S.group.quaternion.copy(this.parkedQ);
    S.group.updateMatrixWorld(true);
    S.pool.visible = false;
  }

  /** ARV-3 outside the seat: arriving in the intro, or going down in flames. */
  _drawSaucer(dt) {
    const me = this.me;
    const S = this.saucer;
    if (this.flying) {
      this.saucerU.value.set(me.burn, me.flash, 1, me.mat);
      return;
    }
    if (me.state !== 'alive' && me.state !== 'down') {
      this._parkSaucer();
      return;
    }
    S.pool.visible = false;
    _v.set(0, -ARV.center[1], 0).applyQuaternion(me.quat).add(me.pos);
    this.arena.toWorld(_v, S.group.position);
    S.group.quaternion.copy(this.arena.qWorld).multiply(me.quat);
    S.group.updateMatrixWorld(true);
    const down = me.state === 'down';
    S.setStruts(0);
    S.setRamp(0);
    S.setPower(down ? me.glow : 1);
    S.update(dt, this.fx.time, { thrust: down ? 0 : 0.25, hover: 1 });
    this.saucerU.value.set(me.burn, me.flash, 1, me.mat);
  }

  _drawFleet() {
    const F = this.fleet;
    for (const s of this.match.ships) {
      if (s.isPlayer) continue;
      if (s.state === 'alive' || s.state === 'down') {
        _q.copy(s.quat);
        if (s.spin) _q.multiply(_qs.setFromAxisAngle(UP, s.spin));
        F.set(s.styleIdx, s.slot, s.pos, _q, s.scale, s.burn, s.flash, s.glow, s.mat);
      } else F.hide(s.styleIdx, s.slot);
    }
    F.commit();
  }

  /** Put the world camera at an arena-local eye looking at `look`. */
  _cine({ eye, look, fov }) {
    const wc = this.worldCam;
    const A = this.arena;
    A.toWorld(eye, wc.position);
    A.toWorld(look, _w);
    A.dirToWorld(UP, _u);
    _m.lookAt(wc.position, _w, _u);
    wc.quaternion.setFromRotationMatrix(_m);
    const cam = this.engine.camera;
    if (Math.abs(cam.fov - fov) > 1e-3) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    wc.fov = fov;
    const h = Math.max(10, eye.y - A.groundY(eye.x, eye.z));
    wc.near = MathUtils.clamp(h * 0.004, 0.5, 6);
    wc.far = Math.max(2e5, Math.sqrt(2 * 6371e3 * h + h * h) * 3 + 4e5);
    wc.updateProjectionMatrix();
    wc.updateMatrixWorld();
  }

  /** The world camera in the arena frame (aim ray, ears). */
  _camLocal() {
    const wc = this.worldCam;
    this.arena.toLocal(wc.position, this.camPos);
    wc.getWorldDirection(_w);
    this.arena.dirToLocal(_w, this.camDir);
    this.camRight.crossVectors(this.camDir, UP);
    if (this.camRight.lengthSq() < 1e-8) this.camRight.set(1, 0, 0);
    this.camRight.normalize();
  }

  // ------------------------------------------------------------ events & HUD

  _events() {
    const me = this.me;
    for (const e of this.match.events.splice(0)) {
      if (e.type === 'kill') {
        this.ui.kill(e, me);
        if (e.victim === me) this._died(e);
        else if (e.killer === me) {
          this.streak = this.streakT > 0 ? this.streak + 1 : 1;
          this.streakT = 4;
          const tag = ['', '', 'Double kill', 'Triple kill', 'Overkill', 'Killing spree', 'Rampage'][Math.min(6, this.streak)];
          this.ui.message(`<span class="good">${tag ? `${tag} · ` : ''}${esc(e.victim.name)} down</span>`);
          this.msgT = 2.2;
          this.sfx.ui('confirm', 0.35, 1.1);
        }
      } else if (e.type === 'hit') {
        this.ui.hitMarker(e.kill);
        if (e.amount >= 4) this.sfx.ui('tick', 0.25, 1.4);
      } else if (e.type === 'hurt') {
        // which way it came from, in the camera's frame (0 = ahead, clockwise)
        const from = e.from && e.from !== me ? e.from.pos : e.point;
        if (from) {
          _v.subVectors(from, me.pos);
          this.arena.dirToWorld(_v, _w).applyQuaternion(_q.copy(this.worldCam.quaternion).invert());
          this.ui.hurt(Math.atan2(_w.x, -_w.z), e.amount);
        } else this.ui.hurt(Math.PI, e.amount);
        if (me.hp < me.maxHp * 0.3 && this.alarmT <= 0) {
          this.alarmT = 1.6;
          this.sfx.ui('dm_alarm', 0.25);
        }
      } else if (e.type === 'crash' && e.ship === me) {
        this.deathCam.at.copy(e.at);
        this.deathCam.t = 0;
        this.respawnIn = RESPAWN;
      } else if (e.type === 'overheat') {
        this.ui.message('<span class="warn">Laser overheated</span>');
        this.msgT = 1.4;
      }
    }
  }

  _died(e) {
    this.flying = false;
    this.pilot.flight.overdrive = false;
    this.me.trigger = false;
    this.lock.ship = null;
    this._stage();
    this.streak = 0;
    this.deathCam.a = Math.atan2(this.camPos.z - this.me.pos.z, this.camPos.x - this.me.pos.x);
    this.deathCam.t = 0;
    const k = e.killer;
    const how = WEAPONS[e.weapon] ? WEAPONS[e.weapon].name : e.weapon === 'burn' ? 'Fire' : 'Collision';
    this._killedBy = k ? `by ${esc(k.name)} · ${esc(k.style.name)} · ${how}` : this.outside > 5 ? 'too far from the battle' : 'you went down';
    this.ui.message(`<span class="big">Shot down</span>${this._killedBy}`);
    this.msgT = 0;
  }

  _rows(st, top) {
    const me = this.me;
    const rows = st.slice(0, top).map((s, i) => ({ rank: i + 1, name: s === me ? 'YOU · ARV-3' : s.name, style: s.style.name, kills: s.kills, deaths: s.deaths, me: s === me }));
    const r = st.indexOf(me);
    if (r >= top) rows.push({ gap: true }, { rank: r + 1, name: 'YOU · ARV-3', style: 'ARV-3', kills: me.kills, deaths: me.deaths, me: true });
    return rows;
  }

  _hud(dt) {
    const me = this.me;
    this.streakT -= dt;
    this.alarmT -= dt;
    this.standT -= dt;
    if (this.standT <= 0) {
      this.standT = 0.25;
      this.standings = this.match.standings();
    }
    const st = this.standings;
    const rank = st.indexOf(me) + 1;
    const lead = st[0];
    const F = this.pilot.flight;
    const W = WEAPONS;
    const status = {
      laser: me.overheated > 0 ? 1 - me.overheated / W.laser.overheat : 1 - me.heat,
      plasma: 1 - me.cd.plasma * W.plasma.rate,
      missile: 1 - me.cd.missile * W.missile.rate,
      fire: me.fuel,
      arc: 1 - me.cd.arc * W.arc.rate,
      cannon: 1,
    };
    const hot = { laser: me.overheated > 0 || me.heat > 0.8, fire: me.fuelDry };
    let sub = '';
    if (this.flying) {
      const agl = Math.max(0, me.pos.y - this.arena.groundY(me.pos.x, me.pos.z));
      sub = `${Math.round(F.speed * 3.6)} km/h · M ${F.mach.toFixed(2)} · ${Math.round(agl)} m${F.overdrive ? ' · OVERDRIVE' : ''}${me.burnDot > 0 ? ' · ON FIRE' : ''}${me.stun > 0 ? ' · STUNNED' : ''}`;
    }
    this.ui.update(dt, {
      timer: this.phase === 'fight' || this.phase === 'over' ? this.timer : MATCH_TIME,
      kills: me.kills,
      rank: rank || '–',
      total: st.length,
      leader: lead && lead.kills > 0 ? `${lead === me ? 'YOU' : lead.name} · ${lead.kills}` : '',
      hp: me.hp,
      maxHp: me.maxHp,
      sub,
      weapon: me.weapon,
      status,
      hot,
    });
    const showBoard = this.phase !== 'loading' && this.phase !== 'over' && this.controls.down('Tab');
    if (showBoard) this.ui.board(this._rows(st, 12), true);
    else if (this._boardOn) this.ui.board(null, false);
    this._boardOn = showBoard;
    if (this.phase === 'loading') {
      this.ui.draw(dt, null);
      return;
    }
    // px per radian at the centre (the fisheye magnifies the middle of the wider render)
    const cam = this.engine.camera;
    const h = this.engine.renderer.domElement.clientHeight || innerHeight;
    const k = this.engine.post.grade.uFisheye.value;
    const fovPx = (h / 2 / Math.tan(MathUtils.degToRad(cam.fov) / 2)) * (1 + k * 0.25 * (cam.aspect * cam.aspect + 1));
    const play = this.phase !== 'intro';
    this.ui.draw(dt, {
      project: this._project,
      ships: this.match.ships,
      me,
      target: this.flying ? this.target : null,
      lock: this.flying && me.weapon === 'missile' ? { ship: this.lock.ship, p: Math.min(1, this.lock.t / W.missile.lockTime), locked: this.lock.locked } : null,
      weapon: me.weapon,
      heat: me.heat,
      fovPx,
      heading: Math.atan2(this.camDir.x, -this.camDir.z),
      showBrackets: play,
      crosshair: this.flying && this.phase !== 'over',
      radar: play,
      time: this.match.t,
    });
  }

  /** Arena-local point → screen 0..1 (through the grade's fisheye), distance in z. */
  _project(p, out) {
    this.arena.toWorld(p, _v);
    out.z = _v.distanceTo(this.worldCam.position);
    _v.project(this.worldCam);
    if (_v.z > 1 || _v.z < -1) {
      out.on = false;
      return true;
    }
    const aspect = this.worldCam.aspect;
    let u = _v.x * 0.5 * aspect;
    let w = _v.y * 0.5;
    const k = this.engine.post.grade.uFisheye.value;
    if (k > 1e-4) {
      // invert uv = p·(1 + k|p|²)/(1 + k·rc²) for |p| by fixed-point iteration
      const rin = Math.hypot(u, w);
      if (rin > 1e-6) {
        const rc2 = 0.25 * (aspect * aspect + 1);
        let r = rin;
        for (let i = 0; i < 6; i++) r = (rin * (1 + k * rc2)) / (1 + k * r * r);
        u *= r / rin;
        w *= r / rin;
      }
    }
    out.x = 0.5 + u / aspect;
    out.y = 0.5 - w;
    out.on = out.x > -0.02 && out.x < 1.02 && out.y > -0.02 && out.y < 1.02;
    return true;
  }

  // ------------------------------------------------------------ for main.js

  /** The objective card / cockpit screens: kills, and the craft in your sights. */
  objective() {
    const me = this.me;
    const T = this.target || this.lock.ship;
    const brg = (x, z) => ((MathUtils.radToDeg(Math.atan2(x - me.pos.x, me.pos.z - z)) % 360) + 360) % 360;
    const wp = T ? { name: T.name, dist: T.pos.distanceTo(me.pos), brg: brg(T.pos.x, T.pos.z) } : { name: NUREMBERG.name, dist: Math.hypot(me.pos.x, me.pos.z), brg: brg(0, 0) };
    return { title: `Deathmatch · ${me.kills} kills`, detail: '', step: 0, total: 1, wp };
  }
}
