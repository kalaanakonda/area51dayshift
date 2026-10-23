import { Euler, MathUtils, Quaternion, Vector3 } from 'three';

/**
 * On-foot first-person controller (hangar-local XZ plane).
 *
 * Walk 1.9 m/s, run 4.6 m/s (Shift), mouse look. Collision is 2D against the
 * hangar's boxes and circles (only obstacles between ankle and head height).
 * Head bob and footsteps come from the distance walked, so they stay in step
 * at any speed.
 */
export class Walker {
  constructor({ colliders = [], start = new Vector3(), yaw = 0 } = {}) {
    this.colliders = colliders;
    this.pos = start.clone();
    this.vel = new Vector3();
    this.yaw = yaw;
    this.pitch = -0.04;
    this.radius = 0.32;
    this.eyeHeight = 1.68;
    this.stride = 0;
    this.bob = 0;
    this.sway = 0;
    this.speed = 0;
    this.onFootstep = null;
    this.bounds = 320;
    this._q = new Quaternion();
    this._e = new Euler(0, 0, 0, 'YXZ');
    this._lastStep = 0;
    this.enabled = true;
  }

  look(dx, dy, sens = 0.0022) {
    this.yaw -= dx * sens;
    this.pitch = MathUtils.clamp(this.pitch - dy * sens, -1.45, 1.4);
  }

  update(dt, controls, dynamic = []) {
    const fwd = controls.axis('KeyS', 'KeyW');
    const strafe = controls.axis('KeyA', 'KeyD');
    const run = controls.down('ShiftLeft', 'ShiftRight');
    const max = run ? 4.6 : 1.9;
    let ix = 0;
    let iz = 0;
    if (this.enabled && (fwd || strafe)) {
      const len = Math.hypot(fwd, strafe);
      const f = fwd / len;
      const s = strafe / len;
      // yaw = 0 looks down −Z
      ix = (-Math.sin(this.yaw) * f + Math.cos(this.yaw) * s) * max;
      iz = (-Math.cos(this.yaw) * f - Math.sin(this.yaw) * s) * max;
    }
    const k = 1 - Math.exp(-(ix || iz ? 9 : 12) * dt);
    this.vel.x += (ix - this.vel.x) * k;
    this.vel.z += (iz - this.vel.z) * k;
    const step = Math.hypot(this.vel.x, this.vel.z) * dt;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    for (let it = 0; it < 3; it++) this._collide(this.colliders.concat(dynamic));
    const r = Math.hypot(this.pos.x, this.pos.z);
    if (r > this.bounds) {
      this.pos.x *= this.bounds / r;
      this.pos.z *= this.bounds / r;
    }
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    // gait
    this.stride += step;
    const phase = (this.stride / 1.45) * Math.PI * 2; // one step every 0.72 m
    const amp = MathUtils.clamp(this.speed / 4.6, 0, 1);
    this.bob = Math.abs(Math.sin(phase)) * (0.018 + amp * 0.035) - 0.012 * amp;
    this.sway = Math.sin(phase * 0.5) * 0.012 * (0.4 + amp);
    const stepIndex = Math.floor(this.stride / 0.725);
    if (stepIndex !== this._lastStep) {
      this._lastStep = stepIndex;
      if (this.onFootstep && this.speed > 0.3) this.onFootstep(amp, stepIndex % 2);
    }
  }

  _collide(list) {
    const p = this.pos;
    const r = this.radius;
    for (const c of list) {
      if (c.minY !== undefined && (c.minY > 1.8 || c.maxY < 0.25)) continue;
      if (c.type === 'circle') {
        const dx = p.x - c.x;
        const dz = p.z - c.z;
        const d = Math.hypot(dx, dz);
        const min = c.r + r;
        if (d < min && d > 1e-6) {
          p.x = c.x + (dx / d) * min;
          p.z = c.z + (dz / d) * min;
        }
      } else {
        const cx = MathUtils.clamp(p.x, c.minX, c.maxX);
        const cz = MathUtils.clamp(p.z, c.minZ, c.maxZ);
        const dx = p.x - cx;
        const dz = p.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 < r * r) {
          if (d2 > 1e-10) {
            const d = Math.sqrt(d2);
            p.x = cx + (dx / d) * r;
            p.z = cz + (dz / d) * r;
          } else {
            // inside the box: leave by the nearest face
            const opts = [
              [c.minX - r - p.x, 0],
              [c.maxX + r - p.x, 0],
              [0, c.minZ - r - p.z],
              [0, c.maxZ + r - p.z],
            ];
            opts.sort((a, b) => Math.abs(a[0] + a[1]) - Math.abs(b[0] + b[1]));
            p.x += opts[0][0];
            p.z += opts[0][1];
          }
        }
      }
    }
  }

  /** Eye position + orientation in hangar-local space. */
  eye(outPos, outQuat) {
    outPos.set(this.pos.x + Math.cos(this.yaw) * this.sway, this.eyeHeight + this.bob, this.pos.z - Math.sin(this.yaw) * this.sway);
    this._e.set(this.pitch, this.yaw, this.sway * 0.6);
    outQuat.setFromEuler(this._e);
    return outPos;
  }
}
