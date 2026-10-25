import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import { Cockpit } from './Cockpit.js';
import { Flight } from './Flight.js';
import { PilotHands } from './PilotHands.js';
import { Saucer, SAUCER } from './Saucer.js';
import { Warp } from './Warp.js';

/**
 * Sitting in ARV-3: the cockpit (near layer), your hands on the pads, the
 * flight model, and the two cameras that look out of the canopy.
 *
 *   engine.camera : the eye in saucer-local space (renders the cockpit scene)
 *   worldCam      : the same eye carried into the world by the saucer's matrix
 *
 * Parked, the mouse turns your head; flying, it flies the craft — X turns,
 * Y pitches the nose, your head stays locked to the seat (hold the right
 * mouse button to look around). V cycles the cockpit, a third-person camera
 * over the craft's shoulder (looking where the nose points, so the crosshair
 * is still your aim) and a chase camera that hangs behind and above, so the
 * ground is in view on the way down. In flight the lens has a slight fisheye
 * (applied in the grade; the render widens its field to match).
 * R spools the drive, Space lifts off, C (or Ctrl) settles it back down, F
 * climbs out. Q toggles Overdrive; the warp drive (J, or Engage on the nav
 * map) jumps to a picked destination.
 */
const SENS = 0.0022;
const _m = new Matrix4();
const _q = new Quaternion();
const _qh = new Quaternion();
const _v = new Vector3();
const _p = new Vector3();
const _E = new Vector3();
const _N = new Vector3();
const _U = new Vector3();
const _Y = new Vector3(0, 1, 0);
const _X = new Vector3(1, 0, 0);
const _Z = new Vector3(0, 0, 1);
const _e = new Euler();
const _qs = new Quaternion();
const _up = new Vector3();
const BASE_FOV = 66;
const HEAD_REST = -0.12; // eyes a little down through the canopy while flying
const CHASE_FOV = 60;

export class PilotMode {
  constructor({ engine, frame, earth, hangar, saucer, assets, worldCam }) {
    this.engine = engine;
    this.frame = frame;
    this.hangar = hangar;
    this.saucer = saucer;
    this.worldCam = worldCam;
    this.cockpit = new Cockpit({ saucer });
    this.hands = new PilotHands(assets);
    this.cockpit.root.add(this.hands.group);
    this.cockpit.extraMats = this.hands.materials;
    this.flight = new Flight({ frame, earth, hangar });
    this.flight.pitch = -0.3;
    this.warp = new Warp({ frame, earth });
    this.fovKick = 0;
    this.active = false;
    this.powerOn = false;
    this.power = 0;
    this.ramp = 1;
    this.headYaw = 0;
    this.thrust = 0;
    this.leaving = false;
    this.view = 'cockpit'; // | 'third' | 'chase'
    this.chase = { yaw: 0, pitch: 0, dist: 26 };
    this.third = { dist: 22, height: 4.6, d: 22 };
    this.fisheye = 0; // grade strength this frame (the owner feeds it to the grade pass)
    this.headRest = HEAD_REST; // where the eyes settle while the mouse flies
    this.wheel = 0; // this frame's wheel steps (for an owner that wants them, e.g. weapons)
    this.wheelZoom = true; // the wheel zooms the outside cameras
    this.eye = new Vector3().copy(SAUCER.eye);
    this.headLag = new Vector3();
    this._lastVel = new Vector3();
    this.events = []; // 'power-on' | 'power-off' | 'liftoff' | 'landed' | 'ramp' | 'overdrive-on' | 'overdrive-off' — drained by the owner
  }

  async load() {
    return this.hands.load();
  }

  /** Take the seat: the flight model starts from where the saucer is parked. */
  board() {
    this.saucer.group.updateMatrixWorld(true);
    this.flight.setFromMatrix(this.saucer.group.matrixWorld);
    this.flight.pitch = -0.3;
    this.headYaw = 0;
    this.leaving = false;
    this.active = true;
    this.setView('cockpit');
    this.ramp = this.saucer.ramp ?? 1;
  }

  /** 'cockpit' (the near layer, saucer hidden from the world camera), 'third' or 'chase'. */
  setView(v) {
    this.view = v;
    if (v === 'cockpit') this.worldCam.layers.disable(Saucer.LAYER);
    else this.worldCam.layers.enable(Saucer.LAYER);
    this.chase.yaw = 0;
    this.chase.pitch = 0;
    this.chase.down = null;
  }

  /** V: cockpit → third person → chase → cockpit. */
  toggleView() {
    const order = ['cockpit', 'third', 'chase'];
    this.setView(order[(order.indexOf(this.view) + 1) % order.length]);
    return this.view;
  }

  /** Back on foot. */
  unboard() {
    this.active = false;
    this.view = 'cockpit';
    this.flight.overdrive = false;
    this.worldCam.layers.enable(Saucer.LAYER);
    this.fisheye = 0;
    const cam = this.engine.camera;
    cam.fov = BASE_FOV;
    cam.updateProjectionMatrix();
  }

  get landed() {
    return this.flight.landed;
  }

  /** Can climb out here? (only at Hangar 9: inside, or on the apron) */
  canDisembark() {
    if (!this.flight.landed) return false;
    const l = this.hangarLocal(_p);
    return Math.abs(l.x) < 34 && l.z > -70 && l.z < 25 && l.y < 3;
  }

  hangarLocal(out) {
    return this.hangar.group.worldToLocal(out.copy(this.flight.pos));
  }

  togglePower() {
    if (!this.flight.landed) return;
    this.powerOn = !this.powerOn;
    this.events.push(this.powerOn ? 'power-on' : 'power-off');
  }

  /** Q: hypersonic, inertia-free flight ("Tic Tac" style). Airborne and outside the hangar only. */
  toggleOverdrive() {
    const F = this.flight;
    if (!F.overdrive) {
      if (this.warp.active) return { ok: false, reason: 'Warp in progress' };
      if (F.landed) return { ok: false, reason: 'Lift off first' };
      if (F.inside) return { ok: false, reason: 'Clear the hangar first' };
      if (this.power < 1) return { ok: false, reason: 'Drive not fully spooled' };
    }
    F.overdrive = !F.overdrive;
    this.events.push(F.overdrive ? 'overdrive-on' : 'overdrive-off');
    return { ok: true };
  }

  /** Can the warp drive fire right now? { ok, reason } */
  canWarp() {
    const F = this.flight;
    if (!this.active) return { ok: false, reason: 'Board ARV-3 first — the drive is in the craft' };
    if (this.warp.active) return { ok: false, reason: 'Warp in progress' };
    if (this.leaving) return { ok: false, reason: 'Ramp open' };
    if (this.power < 1) return { ok: false, reason: this.powerOn ? 'Drive still spooling…' : 'Spool the drive first · R' };
    if (F.inside) return { ok: false, reason: 'Clear the hangar first — fly out the door' };
    return { ok: true, reason: '' };
  }

  /** dest = { name, lat, lon (deg), alt? } → { ok, reason?, eta?, dist? } */
  engageWarp(dest) {
    const can = this.canWarp();
    if (!can.ok) return can;
    const r = this.warp.engage(this.flight, dest);
    if (r.ok && this.flight.overdrive) {
      this.flight.overdrive = false;
      this.events.push('overdrive-off');
    }
    return r;
  }

  /** Mouse + keys → flight input, then the whole rig for this frame. */
  update(dt, t, controls, floorAt) {
    const F = this.flight;
    const I = F.input;
    const W = this.warp;
    const warping = W.state === 'spool' || W.state === 'jump';
    const m = controls.takeMouse();
    this.wheel = m.wheel;
    const chase = this.view === 'chase';
    const third = this.view === 'third';
    const outside = chase || third;
    const freeLook = controls.rightDown || warping || (F.landed && !outside);
    const C = this.chase;
    if (freeLook && outside) {
      // orbit the outside camera round the craft
      C.yaw = MathUtils.clamp(C.yaw - m.dx * SENS, -Math.PI, Math.PI);
      C.pitch = MathUtils.clamp(C.pitch - m.dy * SENS, -0.9, 1.0);
    } else if (freeLook) {
      this.headYaw = MathUtils.clamp(this.headYaw - m.dx * SENS, -2.3, 2.3);
      F.look(-m.dy * SENS);
    } else {
      // flying: the mouse flies the craft, the head rides along with it
      F.yaw(m.dx * SENS);
      if (!F.landed) F.steer(-m.dy * SENS);
      this.headYaw = MathUtils.damp(this.headYaw, 0, 4, dt);
      F.pitch = MathUtils.damp(F.pitch, this.headRest, 4, dt);
      C.yaw = MathUtils.damp(C.yaw, 0, 2, dt);
      C.pitch = MathUtils.damp(C.pitch, 0, 2, dt);
    }
    if (!F.landed) F.steer(controls.axis('ArrowDown', 'ArrowUp') * dt * 0.9);
    if (m.wheel && this.wheelZoom) {
      if (chase) C.dist = MathUtils.clamp(C.dist * (1 + m.wheel * 0.1), 14, 120);
      else if (third) this.third.dist = MathUtils.clamp(this.third.dist * (1 + m.wheel * 0.1), 12, 80);
    }

    const locked = this.leaving || warping;
    I.forward = locked ? 0 : controls.axis('KeyS', 'KeyW');
    I.strafe = locked ? 0 : controls.axis('KeyA', 'KeyD');
    I.vertical = locked ? 0 : controls.axis(['KeyC', 'ControlLeft', 'ControlRight'], 'Space');
    I.yaw = locked ? 0 : controls.axis('ArrowLeft', 'ArrowRight');
    I.boost = controls.down('ShiftLeft', 'ShiftRight') ? 1 : 0;

    // Drive spool: slow S-curve up, quicker down.
    const target = this.powerOn ? 1 : 0;
    const rate = this.powerOn ? 0.24 : 0.45;
    this.power = MathUtils.clamp(this.power + Math.sign(target - this.power) * rate * dt, 0, 1);
    if (Math.abs(target - this.power) < rate * dt) this.power = target;
    F.power = this.power * this.power * (3 - 2 * this.power);

    // The ramp closes as the drive spools, opens to climb out.
    const rampTarget = this.leaving ? 1 : this.powerOn || !F.landed ? 0 : this.ramp;
    const prevRamp = this.ramp;
    this.ramp = MathUtils.clamp(this.ramp + Math.sign(rampTarget - this.ramp) * 0.55 * dt, 0, 1);
    if ((prevRamp === 1 && this.ramp < 1) || (prevRamp === 0 && this.ramp > 0)) this.events.push('ramp');

    const wasLanded = F.landed;
    if (W.update(dt, F)) F.syncExternal(dt);
    else F.update(dt, floorAt);
    if (wasLanded && !F.landed && !W.active) this.events.push('liftoff');
    if (F.justLanded) this.events.push('landed');
    // Overdrive drops out when you land or nose back into the hangar.
    if (F.overdrive && (F.landed || F.inside)) {
      F.overdrive = false;
      this.events.push('overdrive-off');
    }

    // Saucer follows the flight model.
    const S = this.saucer;
    S.group.position.copy(F.pos);
    S.group.quaternion.copy(F.quat);
    S.group.updateMatrixWorld(true);
    S.setPower(this.power);
    S.setStruts(F.strut);
    S.setRamp(this.ramp);
    const thrustTarget = warping ? 1 : Math.min(1, F.speed / Math.max(1, F.maxSpeed)) + Math.abs(I.vertical) * 0.3;
    this.thrust = MathUtils.damp(this.thrust, thrustTarget, 3, dt);
    S.update(dt, t, { thrust: this.thrust, hover: F.landed ? 0.3 : 1 });
    this._pool(F);

    // Head: seat vibration, a little lag under acceleration.
    _v.subVectors(F.vel, this._lastVel).divideScalar(Math.max(dt, 1e-3));
    this._lastVel.copy(F.vel);
    _q.copy(F.quat).invert();
    _v.applyQuaternion(_q).multiplyScalar(-0.0016);
    _v.clampLength(0, 0.035);
    this.headLag.x = MathUtils.damp(this.headLag.x, _v.x, 6, dt);
    this.headLag.y = MathUtils.damp(this.headLag.y, _v.y, 6, dt);
    this.headLag.z = MathUtils.damp(this.headLag.z, _v.z, 6, dt);
    const buzz = F.power * (0.00045 + this.thrust * 0.0008);
    this.eye.copy(SAUCER.eye).add(this.headLag);
    this.eye.x += Math.sin(t * 43.1) * buzz;
    this.eye.y += Math.sin(t * 37.7 + 1.3) * buzz;

    // Near camera (saucer-local). Overdrive widens the view with speed, the
    // warp tunnel stretches it; both shake it a little.
    const cam = this.engine.camera;
    const od = F.overdrive && !F.inside;
    this.fovKick = MathUtils.damp(this.fovKick, od ? MathUtils.clamp(Math.log10(1 + F.speed / 340) * 7, 0, 14) : 0, 2.5, dt);
    // Fisheye: a touch on the ground, more in flight and with speed. The grade magnifies
    // the middle by (1 + k·rc²), so the render's field widens by as much to keep its scale.
    this.fisheye = MathUtils.damp(this.fisheye, F.landed ? 0.05 : 0.13 + MathUtils.clamp(F.speed / 400, 0, 1) * 0.05, 2, dt);
    const rc2 = 0.25 * (cam.aspect * cam.aspect + 1);
    const fov0 = (chase ? CHASE_FOV : BASE_FOV) + this.fovKick + W.fx.fov;
    const fov = MathUtils.radToDeg(2 * Math.atan(Math.tan(MathUtils.degToRad(fov0) / 2) * (1 + this.fisheye * rc2)));
    if (Math.abs(cam.fov - fov) > 1e-3) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    const shake = (W.fx.shake + (od ? MathUtils.clamp((F.mach - 1) / 25, 0, 0.3) : 0)) * 0.0045;
    _qh.setFromAxisAngle(_Y, this.headYaw).multiply(_q.setFromAxisAngle(_X, F.pitch));
    if (shake > 1e-5) {
      _e.set(Math.sin(t * 61.3) * shake + Math.sin(t * 23.7) * shake * 0.6, Math.sin(t * 47.9 + 2.1) * shake, Math.sin(t * 31.1 + 0.7) * shake * 0.4);
      _qh.multiply(_qs.setFromEuler(_e));
    }
    cam.position.copy(this.eye);
    cam.quaternion.copy(_qh);
    cam.updateMatrixWorld();

    // World camera = saucer × eye, or the chase rig.
    const wc = this.worldCam;
    if (chase) this._chaseCam(dt, F, shake);
    else if (third) this._thirdCam(dt, F, shake);
    else {
      wc.position.copy(this.eye).applyMatrix4(S.group.matrixWorld);
      wc.quaternion.copy(F.quat).multiply(_qh);
    }
    wc.fov = cam.fov;
    const agl = Math.max(1, F.agl);
    wc.near = outside ? MathUtils.clamp(agl * 0.004, 0.3, 4) : MathUtils.clamp(agl * 0.004, 0.4, 40);
    wc.far = Math.max(2e5, Math.sqrt(2 * 6371e3 * agl + agl * agl) * 3 + 4e5);
    wc.updateProjectionMatrix();
    wc.updateMatrixWorld();

    // Hands follow the controls.
    const H = this.hands.input;
    H.lateral = MathUtils.clamp(I.strafe * 0.8 + F.yawRate * 0.9 + I.yaw * 0.4, -1, 1);
    H.forward = I.forward;
    H.vertical = I.vertical;
    H.boost = I.boost * (I.forward || I.strafe || I.vertical ? 1 : 0);
    H.power = this.power;
    H.warp = warping ? 1 : 0; // both palms down hard, fingers spread
    this.hands.update(dt);
  }

  /**
   * Chase camera: behind and above the craft on its heading, looking a little
   * more steeply down the faster it sinks, never below the ground.
   */
  _chaseCam(dt, F, shake) {
    const C = this.chase;
    const wc = this.worldCam;
    this.frame.enuAt(F.pos, _E, _N, _U);
    const h = F.heading + C.yaw;
    const fwd = _v.copy(_E).multiplyScalar(Math.sin(h)).addScaledVector(_N, Math.cos(h));
    const sink = MathUtils.clamp(-F.vs / 25, 0, 0.45);
    const down = MathUtils.clamp(0.3 + sink - F.attitude * 0.35 + C.pitch, 0.05, 1.45);
    C.down = C.down == null ? down : MathUtils.damp(C.down, down, 3, dt);
    // look direction: along the heading, pitched down
    const dir = _p.copy(fwd).multiplyScalar(Math.cos(C.down)).addScaledVector(_U, -Math.sin(C.down));
    const target = _qs.set(0, 0, 0, 1);
    wc.position.copy(F.pos).addScaledVector(_U, 2.2).addScaledVector(dir, -C.dist);
    // keep the camera above the ground (and out of the hangar roof)
    const camAgl = F.agl + 2.2 + Math.sin(C.down) * C.dist;
    if (camAgl < 2.5) wc.position.addScaledVector(_U, 2.5 - camAgl);
    _m.lookAt(wc.position, _v.copy(F.pos).addScaledVector(_U, 2.2 - C.dist * 0.04), _U);
    wc.quaternion.setFromRotationMatrix(_m);
    if (shake > 1e-5) wc.quaternion.multiply(target.setFromEuler(_e.set(Math.sin(performance.now() * 0.061) * shake, Math.sin(performance.now() * 0.048) * shake, 0)));
  }

  /**
   * Third person: over the craft's shoulder — behind it and a little above, on
   * the line the nose points along, looking the same way, so the crosshair is
   * still where the shots go. Right drag swings it round; it trails a little
   * further back with speed and never goes below the ground.
   */
  _thirdCam(dt, F, shake) {
    const C = this.chase;
    const T = this.third;
    const wc = this.worldCam;
    this.frame.enuAt(F.pos, _E, _N, _U);
    const h = F.heading + this.headYaw + C.yaw;
    const pitch = MathUtils.clamp(F.attitude + F.pitch - this.headRest + C.pitch, -1.3, 1.3);
    const fwd = _v.copy(_E).multiplyScalar(Math.sin(h)).addScaledVector(_N, Math.cos(h));
    const dir = _p.copy(fwd).multiplyScalar(Math.cos(pitch)).addScaledVector(_U, Math.sin(pitch));
    const up = _up.copy(fwd).multiplyScalar(-Math.sin(pitch)).addScaledVector(_U, Math.cos(pitch));
    // (a short boom under the hangar roof, or it ends up in the back wall)
    T.d = MathUtils.damp(T.d, F.inside ? Math.min(T.dist, 11) : T.dist + Math.min(8, F.speed * 0.015), 3, dt);
    wc.position.copy(F.pos).addScaledVector(_U, SAUCER.halfHeight).addScaledVector(dir, -T.d).addScaledVector(up, T.height);
    const camAgl = F.agl + SAUCER.halfHeight - dir.dot(_U) * T.d + up.dot(_U) * T.height;
    if (camAgl < 2.5) wc.position.addScaledVector(_U, 2.5 - camAgl);
    _m.lookAt(wc.position, _v.copy(wc.position).add(dir), _U);
    wc.quaternion.setFromRotationMatrix(_m);
    if (shake > 1e-5) wc.quaternion.multiply(_qs.setFromEuler(_e.set(Math.sin(performance.now() * 0.061) * shake, Math.sin(performance.now() * 0.048) * shake, 0)));
  }

  /** Light pool on the ground under the belly. */
  _pool(F) {
    const pool = this.saucer.pool;
    this.frame.enuAt(F.pos, _E, _N, _U);
    pool.position.copy(F.pos).addScaledVector(_U, -Math.max(0, F.agl) + 0.03);
    pool.quaternion.setFromUnitVectors(_Z, _U);
    pool.material.opacity = this.power * MathUtils.clamp(1 - F.agl / 30, 0, 1) * 0.85;
    pool.visible = pool.material.opacity > 0.005;
  }

  /** Cabin lighting from the world sun + sky. */
  light({ sunWorld, atmo, outside, env, sunIntensity }) {
    _q.copy(this.flight.quat).invert();
    _v.copy(sunWorld).applyQuaternion(_q);
    this.cockpit.setLighting({ sunDir: _v, sunColor: atmo.sunColor, sunIntensity, skyColor: atmo.skyColor, groundColor: atmo.groundColor, outside, warp: this.warp.fx.tunnel });
    if (env) this.cockpit.setEnvMap(env);
  }

  updateCockpit(dt, t, live) {
    const L = this.hands.hands.left;
    const R = this.hands.hands.right;
    this.cockpit.update(dt, t, { pressL: L ? L.st.press : 0, pressR: R ? R.st.press : 0, power: this.power }, live);
  }
}
