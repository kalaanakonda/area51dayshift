import { MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import { SAUCER } from './Saucer.js';

/**
 * Flight model for the saucer — no autopilot, no rails: you fly it.
 *
 *   mouse X / ← →     yaw (the craft turns; your hands show it)
 *   mouse Y           look up / down (head only)
 *   W S               thrust along where you look (dive at a city, climb at the sky)
 *   A D               strafe
 *   Space / C (Ctrl)  climb / descend
 *   Shift             boost ×3
 *   Q (PilotMode)     Overdrive: hypersonic, inertia-free "Tic Tac" flight
 *
 * It's inertial and anti-gravitic: let go and it slows to a hover. Top speed
 * scales with height above the ground (slow and precise in the hangar,
 * suborbital when you climb), so the whole planet is a few minutes away.
 * Everything is in the world frame; "up" is the local ellipsoid normal.
 */
const _E = new Vector3();
const _N = new Vector3();
const _U = new Vector3();
const _f = new Vector3();
const _r = new Vector3();
const _look = new Vector3();
const _want = new Vector3();
const _m = new Matrix4();
const _q = new Quaternion();
const _v = new Vector3();
const _loc = new Vector3();

/**
 * Speed gears (1–0 on the keyboard, − / = to step). Cruise: a multiplier on the
 * altitude-scaled cruise speed. Overdrive: a flat Mach limit at any height.
 */
export const GEARS = [
  { cruise: 0.2, mach: 1 },
  { cruise: 0.35, mach: 3 },
  { cruise: 0.5, mach: 5 },
  { cruise: 0.75, mach: 10 },
  { cruise: 1, mach: 20 },
  { cruise: 1.5, mach: 35 },
  { cruise: 2, mach: 50 },
  { cruise: 3, mach: 75 },
  { cruise: 4, mach: 100 },
  { cruise: 6, mach: 150 },
];

export class Flight {
  constructor({ frame, earth, hangar }) {
    this.frame = frame;
    this.earth = earth;
    this.hangar = hangar;
    this.pos = new Vector3();
    this.vel = new Vector3();
    this.heading = 0; // rad, clockwise from north
    this.headingTarget = 0;
    this.pitch = -0.2; // head pitch (look), relative to the craft
    this.attitude = 0; // craft pitch (+ nose up): the mouse flies it, W goes where the nose points
    this.headYaw = 0; // free look (right mouse)
    this.yawRate = 0;
    this.quat = new Quaternion();
    this.tilt = new Vector3(); // bank (x), pitch (z) visual
    this.landed = true;
    this.power = 0;
    this.strut = 1;
    this.agl = SAUCER.strut;
    this.ground = null;
    this.groundT = 0;
    this.speed = 0;
    this.vs = 0;
    this.carto = { lat: 0, lon: 0, height: 0 };
    this.input = { forward: 0, strafe: 0, vertical: 0, yaw: 0, boost: 0 };
    this.inside = true;
    this.maxSpeed = 0;
    this.limitInside = 9;
    this.ceiling = 2.0e6; // m above the ellipsoid: high enough to see the planet curve
    this.justLanded = false;
    this.overdrive = false;
    this.gear = 4; // index into GEARS
  }

  setGear(i) {
    this.gear = MathUtils.clamp(i, 0, GEARS.length - 1);
    return GEARS[this.gear];
  }

  /** Mach number (sea-level speed of sound; good enough for a HUD). */
  get mach() {
    return this.speed / 340;
  }

  /** Start from a world matrix (parked on the pad). */
  setFromMatrix(m) {
    m.decompose(this.pos, this.quat, _v);
    const c = this.frame.enuAt(this.pos, _E, _N, _U);
    this.carto = c;
    const fwd = _f.set(0, 0, -1).applyQuaternion(this.quat);
    this.heading = Math.atan2(fwd.dot(_E), fwd.dot(_N));
    this.headingTarget = this.heading;
    this.vel.set(0, 0, 0);
    this.landed = true;
  }

  /** Turn by mouse (radians). */
  yaw(d) {
    this.headingTarget += d;
  }

  /** Pitch the craft (radians). Kept gentle inside the hangar. */
  steer(d) {
    const lim = this.inside ? 0.25 : 1.15;
    this.attitude = MathUtils.clamp(this.attitude + d, -lim, lim);
  }

  look(dPitch, dYaw = 0) {
    this.pitch = MathUtils.clamp(this.pitch + dPitch, -1.2, 1.25);
    this.headYaw = MathUtils.clamp(this.headYaw + dYaw, -2.4, 2.4);
  }

  update(dt, floorAt) {
    const I = this.input;
    const c = this.frame.enuAt(this.pos, _E, _N, _U);
    this.carto = c;
    this.justLanded = false;
    // Heading follows the mouse with a little inertia (the hands show the turn).
    // Parked, the craft can't turn: mouse X turns your head instead (PilotMode).
    if (this.landed) {
      this.headingTarget = this.heading;
      this.attitude = MathUtils.damp(this.attitude, 0, 3, dt);
    }
    else this.headingTarget += I.yaw * 1.1 * dt;
    const prev = this.heading;
    this.heading = MathUtils.damp(this.heading, this.headingTarget, 7, dt);
    this.yawRate = (this.heading - prev) / Math.max(dt, 1e-4);

    // Ground below (terrain, hangar floor or apron); sampled every frame in Overdrive.
    const od = this.overdrive && !this.inside;
    this.groundT -= dt;
    if (this.groundT <= 0 || this.ground == null) {
      this.groundT = this.earth.mode === 'google' ? (od ? 0.04 : 0.12) : od ? 0 : 0.03;
      const g = this.earth.groundHeight(this.pos, c);
      if (g != null) this.ground = g;
    }
    let groundH = this.ground ?? c.height - 50;
    const floor = floorAt(this.pos, c);
    if (floor != null) groundH = Math.max(groundH, floor);
    this.agl = c.height - groundH;

    const fwdFlat = _f.copy(_E).multiplyScalar(Math.sin(this.heading)).addScaledVector(_N, Math.cos(this.heading));
    const right = _r.crossVectors(fwdFlat, _U).normalize();
    // W flies where the nose points.
    const pe = this.attitude;
    const lookDir = _look.copy(fwdFlat).multiplyScalar(Math.cos(pe)).addScaledVector(_U, Math.sin(pe));

    // Thrust. Cruise speed grows with height (jet-like at 1 km, Mach 7 at
    // 10 km, orbital above ~30 km), but the climb rate grows ten times slower,
    // so going up stays a choice rather than a runaway: ~25 s to space boosted.
    // Overdrive drops the pretence of aerodynamics: Mach 2 at rooftop height,
    // Mach 10 at 1 km, tens of km/s up high, and it stops and turns on a dime.
    const boost = 1 + I.boost * 2;
    const h = Math.max(0, this.agl);
    const G = GEARS[this.gear];
    let vmax = od ? G.mach * 340 * boost : Math.min(15 + h * 0.25, h < 120e3 ? 7800 : 7800 + (h - 120e3) * 0.12) * G.cruise * boost;
    let vmaxV = od ? Math.min(250 + h * 1.2, G.mach * 340 * 0.5) * boost : (10 + h * 0.1) * Math.max(1, G.cruise) * boost;
    if (this.inside) {
      vmax = Math.min(vmax, this.limitInside);
      vmaxV = Math.min(vmaxV, this.limitInside);
    }
    this.maxSpeed = vmax;
    _want.set(0, 0, 0);
    if (this.power > 0.6) {
      _want.addScaledVector(lookDir, I.forward).addScaledVector(right, I.strafe).addScaledVector(_U, I.vertical);
      const l = _want.length();
      if (l > 1) _want.divideScalar(l);
    }
    if (this.landed) {
      // Lift-off needs a climb input; anything else just spools up.
      if (this.power > 0.9 && I.vertical > 0.2) this.landed = false;
      else {
        this.vel.set(0, 0, 0);
        this.speed = 0;
        this.vs = 0;
        this.strut = 1;
        this._orient(dt, fwdFlat, right, 0, 0);
        return;
      }
    }
    _want.multiplyScalar(vmax);
    const wv = _want.dot(_U);
    if (Math.abs(wv) > vmaxV) _want.addScaledVector(_U, Math.sign(wv) * vmaxV - wv);
    const speeding = _want.lengthSq() > this.vel.lengthSq();
    const accel = od ? (speeding ? 4.5 : 9) : speeding ? 1.25 : 1.9;
    this.vel.lerp(_want, 1 - Math.exp(-accel * dt));
    // gentle vertical bob at hover
    const hover = Math.sin(performance.now() * 0.0011) * 0.06 * (this.agl < 40 ? 1 : 0);
    this.pos.addScaledVector(this.vel, dt).addScaledVector(_U, hover * dt);

    // Hover on a soft cushion above the struts, hard stop at contact; land
    // when settling slowly onto extended struts. In Overdrive the cushion
    // grows with speed (up to 60 m), so a skim at Mach 3 rides the terrain.
    const agl = c.height + this.vel.dot(_U) * dt - groundH;
    const contact = SAUCER.strut * this.strut;
    const cushion = Math.max(contact + 0.15, od ? Math.min(60, this.speed * 0.04) : 0);
    if (agl < cushion) {
      const into = this.vel.dot(_U);
      if (into < 0) this.vel.addScaledVector(_U, -into);
      let push = (cushion - agl) * Math.min(1, dt * 6);
      if (agl + push < contact) push = contact - agl;
      this.pos.addScaledVector(_U, push);
      if (I.vertical < -0.2 && this.vel.length() < 2.5 && this.strut > 0.95) {
        this.pos.addScaledVector(_U, SAUCER.strut - (agl + push));
        this.vel.set(0, 0, 0);
        this.landed = true;
        this.justLanded = true;
      }
    }
    if (c.height > this.ceiling) {
      this.pos.addScaledVector(_U, this.ceiling - c.height);
      const up = this.vel.dot(_U);
      if (up > 0) this.vel.addScaledVector(_U, -up);
    }
    this._collideHangar();

    this.speed = this.vel.length();
    this.vs = this.vel.dot(_U);
    // struts: deploy near the ground when slow
    const wantStrut = this.agl < 9 && this.speed < 12 ? 1 : 0;
    this.strut = MathUtils.damp(this.strut, wantStrut, 1.6, dt);

    // Visual bank / pitch into the acceleration.
    const lat = this.vel.dot(right) / Math.max(vmax, 1);
    const lon = this.vel.dot(fwdFlat) / Math.max(vmax, 1);
    // (Overdrive flies flat — no banking, no nose-down: it just goes.)
    const bank = od ? 0 : MathUtils.clamp(-lat * 0.22 - this.yawRate * 0.05, -0.3, 0.3);
    const nose = od ? 0 : MathUtils.clamp(-lon * 0.1 - I.forward * 0.04, -0.2, 0.2);
    this._orient(dt, fwdFlat, right, bank, nose);
  }

  /**
   * The warp drive moved the craft this frame (Warp.update): refresh what the
   * HUD and the cabin read from the flight model, flying level, struts up.
   */
  syncExternal(dt) {
    const c = this.frame.enuAt(this.pos, _E, _N, _U);
    this.carto = c;
    this.justLanded = false;
    this.landed = false;
    this.inside = false;
    this.yawRate = 0;
    this.agl = c.height - (this.ground ?? 0);
    this.speed = this.vel.length();
    this.vs = this.vel.dot(_U);
    this.maxSpeed = Math.max(1, this.speed);
    this.strut = MathUtils.damp(this.strut, 0, 3, dt);
    const fwdFlat = _f.copy(_E).multiplyScalar(Math.sin(this.heading)).addScaledVector(_N, Math.cos(this.heading));
    const right = _r.crossVectors(fwdFlat, _U).normalize();
    this._orient(dt, fwdFlat, right, 0, 0);
  }

  _orient(dt, fwdFlat, right, bank, nose) {
    this.tilt.x = MathUtils.damp(this.tilt.x, bank, 3, dt);
    this.tilt.z = MathUtils.damp(this.tilt.z, nose, 3, dt);
    _m.makeBasis(right, _U, _v.copy(fwdFlat).negate());
    this.quat.setFromRotationMatrix(_m);
    this.quat.multiply(_q.setFromAxisAngle(_v.set(0, 0, 1), this.tilt.x));
    this.quat.multiply(_q.setFromAxisAngle(_v.set(1, 0, 0), this.tilt.z + this.attitude));
  }

  /** Cylinder (r 6.5 m, 3.9 m tall) against the hangar's boxes, in hangar space. */
  _collideHangar() {
    const H = this.hangar;
    const g = H.group;
    _loc.copy(this.pos);
    g.worldToLocal(_loc);
    const r = SAUCER.radius + 0.25;
    const y0 = _loc.y;
    const y1 = _loc.y + 3.9;
    const near = Math.abs(_loc.x) < 80 && Math.abs(_loc.z) < 80 && y0 < 40;
    this.inside = Math.abs(_loc.x) < 30 && Math.abs(_loc.z) < 26 && y1 < 17.5;
    if (!near) return;
    let moved = false;
    for (const c of H.colliders) {
      const minY = c.minY ?? 0;
      const maxY = c.maxY ?? 2;
      if (y0 > maxY || y1 < minY) continue;
      if (c.roof) {
        // under the roof: clamp the top
        if (Math.abs(_loc.x) < 30 && Math.abs(_loc.z) < 26 && y0 < minY && y1 > minY) {
          _loc.y = minY - 3.9 - 0.05;
          moved = true;
        }
        continue;
      }
      if (c.type === 'circle') continue;
      const cx = MathUtils.clamp(_loc.x, c.minX, c.maxX);
      const cz = MathUtils.clamp(_loc.z, c.minZ, c.maxZ);
      const dx = _loc.x - cx;
      const dz = _loc.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 < r * r && d2 > 1e-8) {
        const d = Math.sqrt(d2);
        _loc.x = cx + (dx / d) * r;
        _loc.z = cz + (dz / d) * r;
        moved = true;
      }
    }
    if (moved) {
      g.localToWorld(_loc);
      const delta = _v.subVectors(_loc, this.pos);
      this.pos.copy(_loc);
      // kill the velocity into the obstacle
      const n = delta.clone().normalize();
      const into = this.vel.dot(n);
      if (into < 0) this.vel.addScaledVector(n, -into * 1.2);
    }
  }

  /** World matrix of the saucer (belly origin). */
  matrix(out) {
    return out.compose(this.pos, this.quat, _v.set(1, 1, 1));
  }
}
