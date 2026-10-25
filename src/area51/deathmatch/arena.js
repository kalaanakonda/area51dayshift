import { Group, Matrix4, Quaternion, Vector3 } from 'three';
import { WGS84_ELLIPSOID } from '3d-tiles-renderer';
import { DEG } from '../geo.js';

/**
 * The battlefield: the sky over Nuremberg's old town, where on the morning of
 * 14 April 1561 the townspeople reported globes, crosses and tubes fighting
 * overhead (Hans Glaser's broadsheet).
 *
 * Everything in the deathmatch lives in one local frame pinned at the
 * Hauptmarkt — +X east, +Y up, +Z south, metres — carried into the game world
 * by one matrix (so instance buffers hold small numbers and never jitter,
 * 9,000 km from Groom Lake). A height field of the streamed terrain keeps
 * bots, shells and wrecks honest about where the ground is.
 */
export const NUREMBERG = { name: 'Nuremberg', lat: 49.4538, lon: 11.0773 };

export const ARENA = {
  radius: 2600, // soft wall: bots turn back, the player gets a warning
  floor: 80, // bots keep at least this far above the ground
  ceiling: 1500,
  heightField: 2 * (2600 + 900),
};

const _v = new Vector3();
const _w = new Vector3();
const _c = {};

export class Arena {
  constructor({ frame, earth, center = NUREMBERG }) {
    this.frame = frame;
    this.earth = earth;
    this.center = center;
    // Free terrain is MSL-based, Google's is ellipsoidal (geoid ≈ +47.5 m here).
    this.h0 = earth.mode === 'free' ? 310 : 357.5;
    this.group = new Group();
    this.group.name = 'deathmatch';
    this.group.matrixAutoUpdate = false;
    const enu = WGS84_ELLIPSOID.getEastNorthUpFrame(center.lat * DEG, center.lon * DEG, this.h0, new Matrix4());
    const enuFromLocal = new Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1);
    this.group.matrix.copy(frame.worldFromEcef).multiply(enu).multiply(enuFromLocal);
    this.group.updateMatrixWorld(true);
    this.inv = this.group.matrix.clone().invert();
    this.qWorld = new Quaternion().setFromRotationMatrix(this.group.matrix);
    this.qLocal = this.qWorld.clone().invert();

    // ground height field (local y), sampled as the terrain streams in
    const N = earth.mode === 'free' ? 129 : 41;
    this.N = N;
    this.span = ARENA.heightField;
    this.step = this.span / (N - 1);
    this.h = new Float32Array(N * N).fill(NaN);
    this.known = 0;
    this.base = 0; // fallback while a cell is unknown
    this._cursor = 0;
    this._passes = 0;

    // wind (local, m/s): westerly with slow gusts and veer
    this.windBase = new Vector3(5.5, 0, -2.0);
    this.wind = this.windBase.clone();
  }

  toLocal(world, out = new Vector3()) {
    return out.copy(world).applyMatrix4(this.inv);
  }

  toWorld(local, out = new Vector3()) {
    return out.copy(local).applyMatrix4(this.group.matrix);
  }

  dirToLocal(world, out = new Vector3()) {
    return out.copy(world).applyQuaternion(this.qLocal);
  }

  dirToWorld(local, out = new Vector3()) {
    return out.copy(local).applyQuaternion(this.qWorld);
  }

  /** Local ground height (exact query of the streamed terrain), or null. */
  sampleGround(x, z) {
    this.toWorld(_v.set(x, 0, z), _w);
    const c = this.frame.cartographic(_w, _c);
    const h = this.earth.groundHeight(_w, c);
    if (h == null) return null;
    this.frame.fromCartographic(c.lat, c.lon, h, _w);
    return this.toLocal(_w, _v).y;
  }

  /** Refine a slice of the height field (call every frame). */
  update(dt, t) {
    const N = this.N;
    const total = N * N;
    const budget = this.earth.mode === 'free' ? (this._passes ? 220 : 1400) : this._passes ? 6 : 24;
    let sum = 0;
    let n = 0;
    for (let k = 0; k < budget; k++) {
      const i = this._cursor;
      this._cursor = (i + 1) % total;
      if (this._cursor === 0) this._passes++;
      const gx = i % N;
      const gz = (i / N) | 0;
      const y = this.sampleGround(gx * this.step - this.span / 2, gz * this.step - this.span / 2);
      if (y == null) continue;
      if (Number.isNaN(this.h[i])) this.known++;
      this.h[i] = y;
      sum += y;
      n++;
    }
    if (n && this.known < total * 0.5) this.base = sum / n;
    // gusts: ±35 % in strength, ±20° of veer, on slow incommensurate cycles
    const g = 1 + 0.25 * Math.sin(t * 0.31) + 0.1 * Math.sin(t * 1.13 + 1.7);
    const a = 0.35 * Math.sin(t * 0.07 + 0.4);
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    this.wind.set((this.windBase.x * ca - this.windBase.z * sa) * g, 0, (this.windBase.x * sa + this.windBase.z * ca) * g);
  }

  /** 0..1 how much of the height field is known. */
  get coverage() {
    return this.known / (this.N * this.N);
  }

  /** Bilinear local ground height under (x, z). */
  groundY(x, z) {
    const N = this.N;
    const fx = (x + this.span / 2) / this.step;
    const fz = (z + this.span / 2) / this.step;
    if (fx < 0 || fz < 0 || fx >= N - 1 || fz >= N - 1) return this.base;
    const ix = fx | 0;
    const iz = fz | 0;
    const tx = fx - ix;
    const tz = fz - iz;
    const H = this.h;
    const i = iz * N + ix;
    let a = H[i];
    let b = H[i + 1];
    let c = H[i + N];
    let d = H[i + N + 1];
    if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c) || Number.isNaN(d)) {
      const f = this.base;
      a = Number.isNaN(a) ? f : a;
      b = Number.isNaN(b) ? f : b;
      c = Number.isNaN(c) ? f : c;
      d = Number.isNaN(d) ? f : d;
    }
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  /**
   * March a ray against the ground. Returns the distance to the first hit
   * within maxDist, or -1.
   */
  rayGround(o, d, maxDist, step = 24) {
    let prevT = 0;
    let prevH = o.y - this.groundY(o.x, o.z);
    if (prevH < 0) return 0;
    for (let t = step; t <= maxDist + step; t += step) {
      const tt = Math.min(t, maxDist);
      const x = o.x + d.x * tt;
      const y = o.y + d.y * tt;
      const z = o.z + d.z * tt;
      const h = y - this.groundY(x, z);
      if (h < 0) {
        // linear refine between the last two samples
        return prevT + (tt - prevT) * (prevH / (prevH - h));
      }
      prevT = tt;
      prevH = h;
      if (tt >= maxDist) break;
      // big steps high up, small near the ground
      if (h > step * 4) t += Math.min(h * 0.5, 200) - step;
    }
    return -1;
  }
}
