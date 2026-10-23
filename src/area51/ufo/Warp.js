import { MathUtils, Vector3 } from 'three';
import { DEG, greatCircle } from '../geo.js';

/**
 * Warp drive — point-to-point jumps anywhere on the planet.
 *
 *   spool  (2.2 s)  the field charges; you hover, both hands press the pads
 *   jump   (4–9 s)  a great-circle arc up into space and back down, eased so
 *                   the middle is the fastest part (Tokyo from Nevada ≈ 8 s)
 *   exit   (1.4 s)  you drop out of warp ~2 km above the destination, at rest
 *
 * The arrival height follows the ground under the destination as its tiles
 * stream in during the descent, so you don't arrive inside Everest.
 */
const SPOOL = 2.2;
const EXIT = 1.4;
const _n = new Vector3();
const _prev = new Vector3();

function normalAt(lat, lon, out) {
  return out.set(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
}

function slerp(a, b, omega, s, out) {
  if (omega < 1e-6) return out.copy(a);
  const so = Math.sin(omega);
  return out.copy(a).multiplyScalar(Math.sin((1 - s) * omega) / so).addScaledVector(b, Math.sin(s * omega) / so);
}

const smoother = (u) => u * u * u * (u * (u * 6 - 15) + 10);

export class Warp {
  constructor({ frame, earth }) {
    this.frame = frame;
    this.earth = earth;
    this.state = 'idle';
    this.t = 0;
    this.n0 = new Vector3();
    this.n1 = new Vector3();
    this.dest = null;
    this.fx = { tunnel: 0, fov: 0, flash: 0, shake: 0, factor: 0, remaining: 0 };
    this.events = []; // 'spool' | 'jump' | 'exit' | 'done'
  }

  get active() {
    return this.state !== 'idle';
  }

  /** 0..1 while the field charges (for the sound), else 0. */
  get charge() {
    return this.state === 'spool' ? Math.min(1, this.t / SPOOL) : 0;
  }

  /** ETA for a hop of `dist` metres (seconds, spool + jump + exit). */
  static eta(dist) {
    return SPOOL + Warp.jumpTime(dist) + EXIT;
  }

  static jumpTime(dist) {
    return 3.2 + 2.2 * Math.log10(1 + dist / 50000);
  }

  /** dest = { name, lat, lon (degrees), alt? (min arrival height, m) } */
  engage(flight, dest) {
    const c = flight.carto;
    const g = greatCircle(c.lat, c.lon, dest.lat * DEG, dest.lon * DEG);
    if (g.dist < 1500) return { ok: false, reason: 'You are already there' };
    this.dest = dest;
    this.dist = g.dist;
    this.h0 = c.height;
    normalAt(c.lat, c.lon, this.n0);
    normalAt(dest.lat * DEG, dest.lon * DEG, this.n1);
    this.omega = this.n0.angleTo(this.n1);
    // Cruise height: low hops stay in the sky, long ones go to the edge of space.
    this.cruise = MathUtils.clamp(g.dist * 0.05, 18000, 600000);
    this.arriveTarget = Math.max(dest.alt ?? 0, 6500); // refined once the ground there streams in
    this.h1 = this.arriveTarget;
    this.jumpT = Warp.jumpTime(g.dist);
    this.bearing0 = g.bearing * DEG;
    this.state = 'spool';
    this.t = 0;
    this.heading = flight.heading;
    this.events.push('spool');
    return { ok: true, eta: Warp.eta(g.dist), dist: g.dist };
  }

  cancel() {
    if (this.state === 'spool') {
      this.state = 'idle';
      this.events.push('cancel');
    }
  }

  /**
   * Drives `flight` while jumping. Returns true when it owns the craft this
   * frame (the normal flight model must not run).
   */
  update(dt, flight) {
    const fx = this.fx;
    fx.flash = Math.max(0, fx.flash - dt * 1.6);
    if (this.state === 'idle') {
      fx.tunnel = MathUtils.damp(fx.tunnel, 0, 4, dt);
      fx.fov = MathUtils.damp(fx.fov, 0, 4, dt);
      fx.shake = MathUtils.damp(fx.shake, 0, 4, dt);
      fx.factor = 0;
      return false;
    }
    this.t += dt;
    if (this.state === 'spool') {
      const k = Math.min(1, this.t / SPOOL);
      fx.tunnel = 0.12 * k * k;
      fx.fov = -5 * k;
      fx.shake = 0.35 * k;
      fx.factor = 0;
      // swing round to face the destination while the field charges (parked craft can't turn)
      if (!flight.landed) flight.headingTarget = unwrapNear(this.bearing0, flight.heading);
      if (this.t >= SPOOL) {
        this.state = 'jump';
        this.t = 0;
        fx.flash = 1;
        flight.ground = null; // the departure's ground means nothing from here on
        this.events.push('jump');
      }
      return false; // hover in place while the field charges
    }
    if (this.state === 'jump') {
      const u = Math.min(1, this.t / this.jumpT);
      const s = smoother(u);
      // Arrival height tracks the ground under the destination once it's known.
      if (u > 0.45) {
        const g = this._groundAtDest();
        if (g != null) this.arriveTarget = Math.max(this.dest.alt ?? 0, g + 2000);
      }
      this.h1 = MathUtils.damp(this.h1, this.arriveTarget, 1.5, dt);
      slerp(this.n0, this.n1, this.omega, s, _n);
      const lat = Math.asin(MathUtils.clamp(_n.z, -1, 1));
      const lon = Math.atan2(_n.y, _n.x);
      const base = this.h0 + (this.h1 - this.h0) * s;
      const bump = Math.max(0, this.cruise - Math.max(this.h0, this.h1)) * Math.pow(Math.sin(Math.PI * s), 1.2);
      _prev.copy(flight.pos);
      this.frame.fromCartographic(lat, lon, base + bump, flight.pos);
      flight.vel.subVectors(flight.pos, _prev).divideScalar(Math.max(dt, 1e-3));
      const g = greatCircle(lat, lon, this.dest.lat * DEG, this.dest.lon * DEG);
      if (g.dist > 3000) this.heading = g.bearing * DEG;
      flight.heading = flight.headingTarget = unwrapNear(this.heading, flight.heading);
      flight.landed = false;
      fx.remaining = g.dist;
      const ramp = Math.min(1, this.t / 0.6) * Math.min(1, (this.jumpT - this.t) / 0.9);
      fx.tunnel = MathUtils.clamp(ramp, 0, 1);
      fx.fov = 30 * fx.tunnel;
      fx.shake = 0.25 + 0.35 * fx.tunnel;
      const v = flight.vel.length();
      fx.factor = v > 400 ? Math.max(1, Math.log10(v / 343) * 2.2) : 0;
      if (u >= 1) {
        this.state = 'exit';
        this.t = 0;
        fx.flash = 0.8;
        flight.vel.set(0, 0, 0);
        flight.ground = null;
        this.events.push('exit');
      }
      return true;
    }
    // exit: you're back in the normal flight model, the effects die away
    const k = Math.min(1, this.t / EXIT);
    fx.tunnel = 0.35 * (1 - k);
    fx.fov = 8 * (1 - k);
    fx.shake = 0.3 * (1 - k);
    fx.factor = 0;
    if (this.t >= EXIT) {
      this.state = 'idle';
      this.events.push('done');
    }
    return false;
  }

  _groundAtDest() {
    const p = this.frame.fromCartographic(this.dest.lat * DEG, this.dest.lon * DEG, 0, _n);
    return this.earth.groundHeight(p);
  }
}

/** Pick the 2π-equivalent of `a` closest to `ref`, so heading damping never spins the long way. */
function unwrapNear(a, ref) {
  return a + Math.round((ref - a) / (Math.PI * 2)) * Math.PI * 2;
}
