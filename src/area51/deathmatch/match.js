import { Color, Matrix4, Quaternion, Vector3 } from 'three';
import { ARENA } from './arena.js';
import { Brain } from './bot.js';
import { GLOW, PATTERN, SMOKE, rndDir } from './fx.js';
import { WEAPONS } from './weapons.js';

/**
 * The deathmatch simulation, in the arena frame: ships, weapons fire,
 * projectiles, damage, wrecks and respawns. Bots fly themselves here; the
 * player's ship is written in by the owner each frame from the real flight
 * model (and handed back to the match only while it falls as a wreck).
 *
 *   inbound  a streak of light falling out of the sky toward its spawn point
 *   alive    flying and fighting (the hull materialises in the first 0.8 s,
 *            untouchable until it has)
 *   down     shot down: charred black, burning, trailing smoke, tumbling
 *   dead     crashed; waiting to teleport back in
 */
const UP = new Vector3(0, 1, 0);
const FWD = new Vector3(0, 0, -1);
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _d = new Vector3();
const _e = new Vector3();
const _f = new Vector3();
const _m0 = new Vector3();
const _mk = new Vector3();
const _end = new Vector3();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _mat = new Matrix4();
const CHAR = new Color(0.05, 0.045, 0.04);

let SHIP_ID = 0;

export class Ship {
  constructor({ name, style, styleIdx = -1, slot = -1, isPlayer = false, muzzles, pods }) {
    this.id = SHIP_ID++;
    this.name = name;
    this.style = style;
    this.styleIdx = styleIdx;
    this.slot = slot;
    this.isPlayer = isPlayer;
    this.muzzles = muzzles || style.muzzles;
    this.pods = pods || style.pods;
    this.radius = style.radius;
    this.maxHp = style.hp;
    this.hp = style.hp;
    this.state = 'out';
    this.pos = new Vector3();
    this.vel = new Vector3();
    this.quat = new Quaternion();
    this.fwd = new Vector3(0, 0, -1);
    this.face = new Vector3(0, 0, -1);
    this.intent = new Vector3();
    this.aim = new Vector3(0, 0, -1);
    this.aimPoint = null;
    this.fxScale = 1; // the owner's view of its own shots (thin from the cockpit)
    this.trigger = false;
    this.weapon = style.loadout ? style.loadout[0] : 'laser';
    this.lockTarget = null;
    this.cd = { laser: 0, plasma: 0, missile: 0, fire: 0, arc: 0, cannon: 0 };
    this.heat = 0;
    this.overheated = 0;
    this.fuel = 1;
    this.fuelDry = false;
    this.firing = false;
    this.mat = 0;
    this.burn = 0;
    this.flash = 0;
    this.glow = 1;
    this.scale = 1;
    this.spin = 0;
    this.burnDot = 0;
    this.burnBy = null;
    this.stun = 0;
    this.kills = 0;
    this.deaths = 0;
    this.lastHitBy = null;
    this.lastHitT = -99;
    this.lastHitWeapon = '';
    this.regenT = 0;
    this.respawnT = 0;
    this.targeters = 0;
    this.spawn = new Vector3();
    this.from = new Vector3();
    this.inboundT = 0;
    this.inboundDur = 1.2;
    this.down = null;
    this.smokeT = 0;
    this.muzzleIdx = 0;
    this.podIdx = 0;
    this.paint = new Color(0.8, 0.8, 0.8);
    this.light = [1, 1, 1];
    this.brain = null;
    this.flameSndT = 0;
  }

  get alive() {
    return this.state === 'alive';
  }

  /** Can it be hit / shot at right now? */
  get targetable() {
    return this.state === 'alive' && this.mat >= 1;
  }
}

class Projectile {
  constructor() {
    this.alive = false;
    this.kind = '';
    this.owner = null;
    this.target = null;
    this.pos = new Vector3();
    this.prev = new Vector3();
    this.vel = new Vector3();
    this.quat = new Quaternion();
    this.age = 0;
    this.life = 1;
    this.dmg = 0;
    this.seek = 0;
    this.smokeT = 0;
  }
}

export class Match {
  constructor({ arena, fx, sfx = null, rand = Math.random }) {
    this.arena = arena;
    this.fx = fx;
    this.sfx = sfx;
    this.rand = rand;
    this.ships = [];
    this.player = null;
    this.t = 0;
    this.hot = false; // weapons free
    this.hold = false; // bots hover where they arrived (intro, countdown)
    this.respawns = false;
    this.events = [];
    this.pool = [];
    this.active = [];
    for (let i = 0; i < 1800; i++) this.pool.push(new Projectile());
    this.cells = new Map();
    this.cellSize = 100;
    this.maxOnPlayer = 3;
    this.playerBias = 0.85;
    this.botVsPlayer = 0.55; // bots hit the player a little softer
    this.regen = 6; // hp/s, after 5 s without damage
  }

  add(opts) {
    const s = new Ship(opts);
    if (!s.isPlayer) s.brain = new Brain(s, this.rand);
    else this.player = s;
    this.ships.push(s);
    return s;
  }

  // ----------------------------------------------------------- spatial grid

  _rebuildGrid() {
    for (const list of this.cells.values()) list.length = 0;
    const cs = this.cellSize;
    for (const s of this.ships) {
      if (s.state !== 'alive' && s.state !== 'down') continue;
      const key = (Math.floor(s.pos.x / cs) + 512) * 1024 + (Math.floor(s.pos.z / cs) + 512);
      let list = this.cells.get(key);
      if (!list) this.cells.set(key, (list = []));
      list.push(s);
    }
  }

  /** Call fn(ship) for ships whose cell is within r of (x, z). */
  query(x, z, r, fn) {
    const cs = this.cellSize;
    const x0 = Math.floor((x - r) / cs);
    const x1 = Math.floor((x + r) / cs);
    const z0 = Math.floor((z - r) / cs);
    const z1 = Math.floor((z + r) / cs);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const list = this.cells.get((ix + 512) * 1024 + (iz + 512));
        if (list) for (let k = 0; k < list.length; k++) fn(list[k]);
      }
    }
  }

  /** Nearest targetable ship along a ray (sphere test), or null. */
  raycastShips(o, d, maxDist, ignore, inflate = 1) {
    let best = null;
    let bestT = maxDist;
    for (const s of this.ships) {
      if (s === ignore || !s.targetable) continue;
      const r = s.radius * inflate;
      const ox = s.pos.x - o.x;
      const oy = s.pos.y - o.y;
      const oz = s.pos.z - o.z;
      const tca = ox * d.x + oy * d.y + oz * d.z;
      if (tca < -r) continue;
      const d2 = ox * ox + oy * oy + oz * oz - tca * tca;
      if (d2 > r * r) continue;
      const thc = Math.sqrt(r * r - d2);
      let t0 = tca - thc;
      if (t0 < 0) t0 = 0;
      if (t0 < bestT) {
        bestT = t0;
        best = s;
      }
    }
    return best ? { ship: best, t: bestT } : null;
  }

  /** First ship a segment a→b passes through (radius padded by pad). */
  segmentHit(a, b, ignore, pad = 0) {
    const mx = (a.x + b.x) / 2;
    const mz = (a.z + b.z) / 2;
    const half = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / 2;
    let best = null;
    let bestT = 2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const L2 = dx * dx + dy * dy + dz * dz || 1e-9;
    this.query(mx, mz, half + 20 + pad, (s) => {
      if (s === ignore || !s.targetable) return;
      // closest point on the segment to the centre
      let t = ((s.pos.x - a.x) * dx + (s.pos.y - a.y) * dy + (s.pos.z - a.z) * dz) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = a.x + dx * t - s.pos.x;
      const cy = a.y + dy * t - s.pos.y;
      const cz = a.z + dz * t - s.pos.z;
      const r = s.radius + pad;
      if (cx * cx + cy * cy + cz * cz < r * r && t < bestT) {
        bestT = t;
        best = s;
      }
    });
    if (!best) return null;
    return { ship: best, point: _end.set(a.x + dx * bestT, a.y + dy * bestT, a.z + dz * bestT) };
  }

  // ----------------------------------------------------------- frame

  update(dt) {
    this.t += dt;
    this._rebuildGrid();
    for (const s of this.ships) this._ship(s, dt);
    this._projectiles(dt);
    this._collide();
  }

  _ship(s, dt) {
    for (const k in s.cd) s.cd[k] = Math.max(k === 'cannon' ? -0.05 : 0, s.cd[k] - dt);
    s.flash = Math.max(0, s.flash - dt * 5);
    s.heat = Math.max(0, s.heat - WEAPONS.laser.cool * dt);
    if (s.overheated > 0) s.overheated -= dt;
    if (!s.firing) {
      s.fuel = Math.min(1, s.fuel + WEAPONS.fire.regen * dt);
      if (s.fuel > 0.3) s.fuelDry = false;
    }
    s.firing = false;
    s.stun = Math.max(0, s.stun - dt);
    switch (s.state) {
      case 'inbound':
        this._inbound(s, dt);
        break;
      case 'alive':
        this._alive(s, dt);
        break;
      case 'down':
        this._down(s, dt);
        break;
      case 'dead':
        s.respawnT -= dt;
        if (!s.isPlayer && this.respawns && s.respawnT <= 0) this.respawn(s);
        break;
    }
  }

  _alive(s, dt) {
    if (s.mat < 1) s.mat = Math.min(1, s.mat + dt * 1.25);
    if (s.brain) {
      if (this.hold) {
        s.intent.set(0, Math.sin(this.t * 0.9 + s.id) * 1.5, 0);
        s.trigger = false;
      } else s.brain.update(dt, s, this);
      // fly: chase the intent, face where the brain wants, bank into turns
      const st = s.style;
      const k = 1 - Math.exp(-st.accel * dt);
      _a.subVectors(s.intent, s.vel); // acceleration wish (for the bank)
      s.vel.addScaledVector(_a, k);
      s.pos.addScaledVector(s.vel, dt);
      const floor = this.arena.groundY(s.pos.x, s.pos.z) + s.radius + 4;
      if (s.pos.y < floor) {
        s.pos.y = floor;
        if (s.vel.y < 0) s.vel.y = 0;
      }
      _b.copy(s.face);
      if (s.style.id !== 'orb') _b.y = Math.max(-0.75, Math.min(0.75, _b.y));
      if (_b.lengthSq() < 1e-6) _b.copy(s.fwd);
      _b.normalize();
      _c.crossVectors(_b, UP);
      if (_c.lengthSq() < 1e-6) _c.set(1, 0, 0);
      _c.normalize();
      const bank = Math.max(-0.6, Math.min(0.6, _a.dot(_c) / 60));
      _d.copy(UP).multiplyScalar(Math.cos(bank)).addScaledVector(_c, Math.sin(bank));
      _mat.lookAt(_e.set(0, 0, 0), _b, _d);
      _q.setFromRotationMatrix(_mat);
      s.quat.slerp(_q, 1 - Math.exp(-st.turn * dt));
    }
    s.fwd.copy(FWD).applyQuaternion(s.quat);
    if (s.style.id === 'orb') s.spin += dt * 0.7;
    // recover hull after 5 s out of the fight
    s.regenT -= dt;
    if (s.regenT <= 0 && s.hp < s.maxHp) s.hp = Math.min(s.maxHp, s.hp + this.regen * dt);
    // on fire
    if (s.burnDot > 0) {
      s.burnDot -= dt;
      this.damage(s, WEAPONS.fire.burnDps * dt, s.burnBy, 'burn', null, null, true);
      if (this.rand() < dt * 18) this._flame(s, 0.6);
    }
    // hurt craft smoke, badly hurt ones burn
    const hp = s.hp / s.maxHp;
    s.burn = Math.min(0.35, (1 - hp) * 0.4);
    if (hp < 0.6) {
      s.smokeT -= dt;
      if (s.smokeT <= 0) {
        s.smokeT = hp < 0.3 ? 0.035 : 0.08;
        const dark = hp < 0.3;
        const r = s.radius;
        rndDir(_a).multiplyScalar(r * 0.4);
        const sz = r * (dark ? 0.55 : 0.4);
        const c = dark ? 0.06 : 0.32;
        this.fx.smoke.emit(s.pos.x + _a.x, s.pos.y + _a.y, s.pos.z + _a.z, s.vel.x * 0.2, s.vel.y * 0.2 + 1, s.vel.z * 0.2, 2.5 + this.rand() * 1.5, sz, sz * 4.5, 1.1, 1.2, c, c * 0.95, c * 0.9, SMOKE.SMOKE, this.fx.time, dark ? 0.85 : 0.5);
        if (hp < 0.3 && this.rand() < 0.4) this._flame(s, 0.5);
      }
    }
    if (s.trigger && this.hot && s.stun <= 0 && s.mat >= 1) this.fire(s, s.weapon, dt);
  }

  _flame(s, size, at = s.pos, t0 = this.fx.time) {
    rndDir(_a).multiplyScalar(s.radius * 0.45);
    const sz = s.radius * 0.35 * size;
    this.fx.glow.emit(at.x + _a.x, at.y + _a.y, at.z + _a.z, s.vel.x * 0.4, s.vel.y * 0.4 + 2, s.vel.z * 0.4, 0.45 + this.rand() * 0.3, sz, sz * 2.6, 2.2, 4, 1, 1, 1, GLOW.FIRE, t0);
  }

  // ----------------------------------------------------------- weapons

  muzzle(s, i, out) {
    const m = s.muzzles[((i % s.muzzles.length) + s.muzzles.length) % s.muzzles.length];
    return out.set(m[0], m[1], m[2]).multiplyScalar(s.scale).applyQuaternion(s.quat).add(s.pos);
  }

  pod(s, i, out) {
    const m = s.pods[i % s.pods.length];
    return out.set(m[0], m[1], m[2]).multiplyScalar(s.scale).applyQuaternion(s.quat).add(s.pos);
  }

  /** Firing direction from a muzzle: at the aim point (player), else along the aim. */
  _dir(s, from, out) {
    if (s.aimPoint) {
      out.subVectors(s.aimPoint, from);
      const l = out.length();
      if (l > 4) return out.divideScalar(l);
    }
    return out.copy(s.aim);
  }

  fire(s, w, dt) {
    const W = WEAPONS[w];
    switch (w) {
      case 'laser':
        if (s.cd.laser > 0 || s.overheated > 0) return;
        s.cd.laser = 1 / W.rate;
        s.heat += W.heatPer;
        if (s.heat >= 1) {
          s.overheated = W.overheat;
          s.heat = 1;
          if (s.isPlayer) this.events.push({ type: 'overheat' });
        }
        this._laser(s);
        break;
      case 'plasma':
        if (s.cd.plasma > 0) return;
        s.cd.plasma = 1 / W.rate;
        this._plasma(s);
        break;
      case 'missile':
        if (s.cd.missile > 0) return;
        s.cd.missile = 1 / W.rate;
        this._missiles(s);
        break;
      case 'fire':
        if (s.fuelDry || s.fuel <= 0.01) {
          s.fuelDry = true;
          return;
        }
        s.firing = true;
        s.fuel = Math.max(0, s.fuel - W.drain * dt);
        this._spray(s, dt);
        break;
      case 'arc':
        if (s.cd.arc > 0) return;
        s.cd.arc = 1 / W.rate;
        this._arc(s);
        break;
      case 'cannon': {
        let n = 0;
        while (s.cd.cannon <= 0 && n < 4) {
          s.cd.cannon += 1 / W.rate;
          this._shell(s, n);
          n++;
        }
        break;
      }
    }
  }

  _laser(s) {
    const W = WEAPONS.laser;
    const L = s.style.laser;
    const n = s.style.triple ? 3 : s.style.twin ? 2 : 1;
    const m0 = this.muzzle(s, n > 1 ? 0 : s.muzzleIdx++, _m0);
    const d = this._dir(s, m0, _d);
    const hit = this.raycastShips(m0, d, W.range, s, s.isPlayer ? 1.1 : 1);
    let end = hit ? hit.t : W.range;
    const g = this.arena.rayGround(m0, d, end);
    const ground = g >= 0;
    if (ground) end = g;
    _end.copy(m0).addScaledVector(d, end);
    const t = this.fx.time;
    const q = s.fxScale;
    for (let k = 0; k < n; k++) {
      const mk = n > 1 ? this.muzzle(s, k, _mk) : m0;
      this.fx.beam(mk, _end, L.width * q, L.pattern, L.color, 1, W.life);
      this.fx.glow.emit(mk.x, mk.y, mk.z, 0, 0, 0, 0.07, 1.4 * q, 3.4 * q, 0, 0, L.color[0], L.color[1], L.color[2], GLOW.FLASH, t);
    }
    if (hit && !ground) {
      this.damage(hit.ship, W.dmg, s, 'laser', _end, d);
      this.fx.hit(_end, d, L.color, 6);
    } else if (ground) this.fx.groundHit(_end, 0.8);
    this.sound('dm_laser', m0, 0.5, 0.9 + this.rand() * 0.25);
  }

  _plasma(s) {
    const W = WEAPONS.plasma;
    const m0 = this.muzzle(s, s.muzzleIdx++, _m0);
    const d = this._dir(s, m0, _d);
    const speed = W.speed + Math.max(0, s.vel.dot(d));
    for (let i = 0; i < W.pellets; i++) {
      jitter(d, W.spread, _a);
      const p = this._spawn('bolt', s, m0);
      if (!p) break;
      p.vel.copy(_a).multiplyScalar(speed * (0.92 + this.rand() * 0.16));
      p.life = (W.range / W.speed) * (0.85 + this.rand() * 0.3);
      p.dmg = W.dmg;
    }
    const c = W.color;
    const t = this.fx.time;
    const q = s.fxScale;
    this.fx.glow.emit(m0.x, m0.y, m0.z, 0, 0, 0, 0.12, 3 * q, 9 * q, 0, 0, c[0] * 1.4, c[1] * 1.4, c[2] * 1.4, GLOW.FLASH, t);
    this.fx.glow.emit(m0.x, m0.y, m0.z, d.x * 30, d.y * 30, d.z * 30, 0.25, 2 * q, 8 * q, 3, 0, c[0], c[1], c[2], GLOW.GLOW, t, 0.7);
    this.sound('dm_plasma', m0, 0.75, 0.9 + this.rand() * 0.2);
  }

  _missiles(s) {
    const W = WEAPONS.missile;
    const target = s.lockTarget && s.lockTarget.targetable ? s.lockTarget : null;
    for (let i = 0; i < W.salvo; i++) {
      const pi = s.podIdx++;
      const at = this.pod(s, pi, _m0);
      const p = this._spawn('missile', s, at);
      if (!p) break;
      const side = s.pods[pi % s.pods.length][0] < 0 ? -1 : 1;
      _c.set(side, 0, 0).applyQuaternion(s.quat);
      p.vel.copy(s.vel).addScaledVector(s.fwd, 45).addScaledVector(_c, 14).addScaledVector(UP, -4);
      p.target = target;
      p.seek = target ? W.seek : 0;
      p.life = W.life;
      p.dmg = W.dmg;
      p.smokeT = 0;
      p.aimDir = this._dir(s, at, new Vector3());
      orient(p.quat, p.vel);
    }
    this.sound('dm_missile', _m0, 0.7, 0.95 + this.rand() * 0.1);
  }

  _spray(s, dt) {
    const W = WEAPONS.fire;
    const m0 = this.muzzle(s, s.muzzleIdx, _m0);
    const d = this._dir(s, m0, _d);
    const t = this.fx.time;
    // the stream
    const rate = 80 * this.fx.scale;
    let n = rate * dt + this.rand();
    while (n >= 1) {
      n -= 1;
      jitter(d, 0.12, _a);
      const sp = 85 + this.rand() * 25;
      const lag = this.rand() * dt;
      this.fx.glow.emit(m0.x + s.vel.x * lag, m0.y + s.vel.y * lag, m0.z + s.vel.z * lag, s.vel.x * 0.85 + _a.x * sp, s.vel.y * 0.85 + _a.y * sp, s.vel.z * 0.85 + _a.z * sp, 0.75 + this.rand() * 0.3, 1.0, 8 + this.rand() * 4, 1.7, 3, 1, 1, 1, GLOW.FIRE, t - lag);
    }
    // dark smoke where the flame dies (closed-form position after ~0.7 s)
    if (this.rand() < dt * 14) {
      jitter(d, 0.12, _a);
      const k = 1.7;
      const tt = 0.7;
      const e = (1 - Math.exp(-k * tt)) / k;
      const w = this.arena.wind;
      _b.set(s.vel.x * 0.85 + _a.x * 95, s.vel.y * 0.85 + _a.y * 95, s.vel.z * 0.85 + _a.z * 95);
      _c.copy(m0).addScaledVector(w, tt).addScaledVector(_b.sub(w), e);
      this.fx.smoke.emit(_c.x, _c.y + 0.5 * 3 * tt * tt, _c.z, w.x, 2, w.z, 2.5 + this.rand(), 5, 16, 0.9, 1.2, 0.08, 0.075, 0.07, SMOKE.SMOKE, t, 0.6);
    }
    // anything in the cone takes damage and catches fire
    this.query(m0.x, m0.z, W.range + 20, (o) => {
      if (o === s || !o.targetable) return;
      _b.subVectors(o.pos, m0);
      const dist = _b.length();
      if (dist > W.range + o.radius || dist < 1e-3) return;
      const ang = Math.acos(Math.max(-1, Math.min(1, _b.dot(d) / dist)));
      if (ang > W.cone + Math.atan(o.radius / dist)) return;
      _c.copy(o.pos).addScaledVector(_b, -o.radius / dist);
      this.damage(o, W.dps * dt * (1 - (0.5 * dist) / W.range), s, 'fire', _c, d, true);
      o.burnDot = W.burnTime;
      o.burnBy = s;
    });
    s.flameSndT -= dt;
    if (s.flameSndT <= 0) {
      s.flameSndT = 0.32;
      this.sound('dm_flame', m0, 0.7, 0.95 + this.rand() * 0.1);
    }
  }

  _arc(s) {
    const W = WEAPONS.arc;
    const m0 = this.muzzle(s, s.muzzleIdx++, _m0);
    const d = this._dir(s, m0, _d);
    // first target: closest to the aim line inside the cone
    let first = null;
    let bestA = Infinity;
    this.query(m0.x, m0.z, W.range + 20, (o) => {
      if (o === s || !o.targetable) return;
      _b.subVectors(o.pos, m0);
      const dist = _b.length();
      if (dist > W.range + o.radius) return;
      const ang = Math.acos(Math.max(-1, Math.min(1, _b.dot(d) / dist))) - Math.atan(o.radius / dist);
      if (ang < W.cone && ang < bestA) {
        bestA = ang;
        first = o;
      }
    });
    const pts = [m0.clone()];
    const t = this.fx.time;
    if (!first) {
      // a dry strike at the aim (or the ground)
      let end = W.range;
      const g = this.arena.rayGround(m0, d, end);
      if (g >= 0) end = g;
      pts.push(m0.clone().addScaledVector(d, end));
      if (g >= 0) this.fx.groundHit(pts[1], 1.2);
    } else {
      const hit = new Set([s, first]);
      let cur = first;
      let dmg = W.dmg;
      for (let k = 0; k <= W.chain && cur; k++) {
        pts.push(cur.pos.clone());
        this.damage(cur, dmg, s, 'arc', cur.pos, d);
        cur.stun = Math.max(cur.stun, W.stun);
        const c = W.color;
        this.fx.glow.emit(cur.pos.x, cur.pos.y, cur.pos.z, 0, 0, 0, 0.3, cur.radius * 1.2, cur.radius * 3, 0, 0, c[0] * 1.6, c[1] * 1.6, c[2] * 1.6, GLOW.FLASH, t);
        this.fx.hit(cur.pos, null, c, 8, 1.2);
        dmg *= W.falloff;
        // next hop: the nearest unhit craft in reach
        let next = null;
        let nd = W.hop;
        const from = cur;
        this.query(from.pos.x, from.pos.z, W.hop, (o) => {
          if (hit.has(o) || !o.targetable) return;
          const dd = o.pos.distanceTo(from.pos);
          if (dd < nd) {
            nd = dd;
            next = o;
          }
        });
        if (next) hit.add(next);
        cur = next;
      }
    }
    this.fx.arc(pts, 0.24, s.fxScale);
    this.fx.glow.emit(m0.x, m0.y, m0.z, 0, 0, 0, 0.12, 2.5, 7, 0, 0, 1, 1.4, 2.6, GLOW.FLASH, t);
    this.sound('dm_arc', m0, 0.8, 0.9 + this.rand() * 0.2);
  }

  _shell(s, n) {
    const W = WEAPONS.cannon;
    const m0 = this.muzzle(s, s.muzzleIdx++, _m0);
    const d = this._dir(s, m0, _d);
    jitter(d, W.spread, _a);
    const p = this._spawn('shell', s, m0);
    if (!p) return;
    const speed = W.speed + Math.max(0, s.vel.dot(_a));
    p.vel.copy(_a).multiplyScalar(speed);
    // stagger rounds fired in the same frame along their path
    p.pos.addScaledVector(p.vel, n * 0.01);
    p.life = W.life * (0.9 + this.rand() * 0.2);
    p.dmg = W.dmg;
    if (s.muzzleIdx % 2 === 0) {
      const c = W.color;
      this.fx.glow.emit(m0.x, m0.y, m0.z, 0, 0, 0, 0.05, 0.9, 2.2, 0, 0, c[0], c[1], c[2], GLOW.FLASH, this.fx.time);
      this.sound('dm_cannon', m0, 0.4, 0.9 + this.rand() * 0.25);
    }
  }

  _spawn(kind, owner, at) {
    const p = this.pool.pop();
    if (!p) return null;
    p.alive = true;
    p.kind = kind;
    p.owner = owner;
    p.target = null;
    p.age = 0;
    p.seek = 0;
    p.pos.copy(at);
    p.prev.copy(at);
    p.vel.set(0, 0, 0);
    this.active.push(p);
    return p;
  }

  _release(i) {
    const p = this.active[i];
    p.alive = false;
    p.owner = null;
    p.target = null;
    this.active[i] = this.active[this.active.length - 1];
    this.active.pop();
    this.pool.push(p);
  }

  _projectiles(dt) {
    const A = this.active;
    const wind = this.arena.wind;
    for (let i = A.length - 1; i >= 0; i--) {
      const p = A[i];
      p.age += dt;
      p.prev.copy(p.pos);
      if (p.kind === 'shell') {
        const e = Math.exp(-WEAPONS.cannon.drag * dt);
        p.vel.x = wind.x + (p.vel.x - wind.x) * e;
        p.vel.z = wind.z + (p.vel.z - wind.z) * e;
        p.vel.y = p.vel.y * e - 9.81 * dt;
        p.pos.addScaledVector(p.vel, dt);
      } else if (p.kind === 'bolt') {
        p.pos.addScaledVector(p.vel, dt);
      } else if (this._missile(p, dt)) {
        this._explode(p.pos, p.owner, p.target, WEAPONS.missile);
        this._release(i);
        continue;
      }
      const hit = this.segmentHit(p.prev, p.pos, p.owner, p.kind === 'missile' ? 2 : 0);
      if (hit) {
        this._impact(p, hit.ship, hit.point);
        this._release(i);
        continue;
      }
      const gy = this.arena.groundY(p.pos.x, p.pos.z);
      if (p.pos.y < gy) {
        p.pos.y = gy;
        if (p.kind === 'missile') this._explode(p.pos, p.owner, null, WEAPONS.missile);
        else if (p.kind === 'bolt') {
          this.fx.groundHit(p.pos, 1.1);
          const c = WEAPONS.plasma.color;
          this.fx.glow.emit(p.pos.x, p.pos.y + 1, p.pos.z, 0, 0, 0, 0.18, 2, 6, 0, 0, c[0], c[1], c[2], GLOW.FLASH, this.fx.time);
        } else this.fx.groundHit(p.pos, 0.6);
        this._release(i);
        continue;
      }
      if (p.age >= p.life) {
        if (p.kind === 'missile') this._explode(p.pos, p.owner, null, WEAPONS.missile, 0.7);
        else if (p.kind === 'bolt') {
          const c = WEAPONS.plasma.color;
          this.fx.glow.emit(p.pos.x, p.pos.y, p.pos.z, p.vel.x * 0.2, p.vel.y * 0.2, p.vel.z * 0.2, 0.2, 1.5, 3.5, 2, 0, c[0] * 0.6, c[1] * 0.6, c[2] * 0.6, GLOW.GLOW, this.fx.time);
        }
        this._release(i);
      }
    }
  }

  /** Steer, boost and trail a missile. Returns true when its fuse fires. */
  _missile(p, dt) {
    const W = WEAPONS.missile;
    const T = p.target;
    const speed = p.vel.length();
    const want = Math.min(W.speed, speed + 600 * dt);
    _a.copy(p.vel).divideScalar(Math.max(speed, 1e-3));
    if (T && T.targetable && p.age < p.seek) {
      // lead pursuit, with a limited turn rate
      const tt = Math.min(2, p.pos.distanceTo(T.pos) / Math.max(want, 1));
      _b.copy(T.pos).addScaledVector(T.vel, tt).sub(p.pos).normalize();
      turnToward(_a, _b, W.turn * dt);
      p.vel.copy(_a).multiplyScalar(want);
      if (p.pos.distanceTo(T.pos) < T.radius + 6) return true;
    } else if (p.age < 0.9 && p.aimDir) {
      turnToward(_a, p.aimDir, W.turn * 0.8 * dt);
      p.vel.copy(_a).multiplyScalar(want);
    } else {
      // motor out after the seek window: it falls
      p.vel.y -= 9.81 * dt;
      if (p.age < p.seek + 1.5) p.vel.addScaledVector(_a, 60 * dt);
    }
    p.pos.addScaledVector(p.vel, dt);
    orient(p.quat, p.vel);
    // smoke trail, evenly spaced between last frame and this
    const t = this.fx.time;
    const burning = p.age < p.seek + 1.5 || p.age < 2;
    if (burning) {
      p.smokeT -= dt;
      while (p.smokeT <= 0) {
        p.smokeT += 0.02 / this.fx.scale;
        const f = this.rand();
        _c.lerpVectors(p.prev, p.pos, f);
        this.fx.smoke.emit(_c.x, _c.y, _c.z, p.vel.x * 0.04, p.vel.y * 0.04 + 0.5, p.vel.z * 0.04, 2.2 + this.rand() * 1.2, 0.9, 5 + this.rand() * 2, 0.7, 0.5, 0.82, 0.82, 0.82, SMOKE.SMOKE, t - (1 - f) * dt, 0.42);
      }
    }
    return false;
  }

  _impact(p, ship, point) {
    _d.copy(p.vel).normalize();
    if (p.kind === 'shell') {
      this.damage(ship, p.dmg, p.owner, 'cannon', point, _d);
      this.fx.hit(point, _d, WEAPONS.cannon.color, 3, 0.6);
    } else if (p.kind === 'bolt') {
      this.damage(ship, p.dmg, p.owner, 'plasma', point, _d);
      const c = WEAPONS.plasma.color;
      this.fx.hit(point, _d, c, 6, 1.4);
    } else {
      this._explode(point, p.owner, ship, WEAPONS.missile);
    }
  }

  _explode(at, owner, direct, W, scale = 1) {
    const p = _f.copy(at);
    this.fx.explosion(p, 1.1 * scale);
    if (direct && direct.targetable) this.damage(direct, W.dmg, owner, 'missile', p, null);
    this.query(p.x, p.z, W.splash + 20, (o) => {
      if (o === direct || !o.targetable) return;
      const d = o.pos.distanceTo(p) - o.radius;
      if (d > W.splash) return;
      this.damage(o, W.dmg * 0.6 * Math.pow(1 - Math.max(0, d) / W.splash, 0.7), owner, 'missile', p, null);
    });
    this.sound('dm_boom_s', p, 1.0, 0.9 + this.rand() * 0.2);
  }

  // ----------------------------------------------------------- damage

  damage(s, amount, by, weapon, point, dir, quiet = false) {
    if (!s.targetable || amount <= 0) return;
    if (by === s && weapon !== 'burn') return; // no self-damage
    if (by && !by.isPlayer && s.isPlayer) amount *= this.botVsPlayer;
    s.hp -= amount;
    s.regenT = 5;
    if (by && by !== s) {
      s.lastHitBy = by;
      s.lastHitT = this.t;
      s.lastHitWeapon = weapon;
    }
    if (!quiet) s.flash = Math.min(1, s.flash + amount / 22);
    if (by && by.isPlayer && by !== s) this.events.push({ type: 'hit', target: s, amount, weapon, kill: s.hp <= 0 });
    if (s.isPlayer) this.events.push({ type: 'hurt', from: by, amount, weapon, point: point ? point.clone() : null });
    // shards off the hull
    if (point && !quiet) {
      const n = amount >= 20 ? 3 + Math.floor(this.rand() * 3) : this.rand() < amount / 14 ? 1 : 0;
      for (let i = 0; i < n; i++) {
        rndDir(_e).multiplyScalar(12 + this.rand() * 25);
        if (dir) _e.addScaledVector(dir, 10);
        _e.add(s.vel);
        this.fx.debris.spawn(point, _e, this.rand() < 0.5 ? s.paint : CHAR, 0.3 + this.rand() * 0.5 + s.radius * 0.03, this.rand() < 0.35 ? 3 + this.rand() * 3 : 0);
      }
      if (amount >= 6) this.sound('dm_hit', point, Math.min(1, amount / 20) * 0.6, 0.85 + this.rand() * 0.3);
    }
    if (s.hp <= 0) this.kill(s, by, weapon);
  }

  kill(s, by, weapon) {
    s.hp = 0;
    s.state = 'down';
    s.deaths++;
    s.trigger = false;
    s.burnDot = 0;
    const killer = by && by !== s ? by : s.lastHitBy && this.t - s.lastHitT < 8 ? s.lastHitBy : null;
    if (killer) killer.kills++;
    if (s.brain) s.brain.reset(s);
    rndDir(_a);
    s.down = {
      t: 0,
      axis: new Vector3(_a.x, _a.y * 0.4, _a.z).normalize(),
      rate: (1.2 + this.rand() * 2.4) * (8 / Math.max(6, s.radius)),
      boomT: 0.3 + this.rand() * 0.4,
      debrisT: 0.15,
      smokeT: 0,
      fireT: 0,
    };
    s.vel.multiplyScalar(0.65).addScaledVector(UP, 4);
    this.fx.explosion(s.pos, 0.6 + s.radius / 14, { smoke: false });
    for (let i = 0; i < 10 + s.radius; i++) {
      rndDir(_e).multiplyScalar(18 + this.rand() * 40);
      _e.add(s.vel);
      this.fx.debris.spawn(s.pos, _e, this.rand() < 0.5 ? s.paint : CHAR, 0.4 + this.rand() * 0.9 + s.radius * 0.04, this.rand() < 0.5 ? 4 + this.rand() * 4 : 0);
    }
    this.events.push({ type: 'kill', killer, victim: s, weapon });
    this.sound('boom', s.pos, 0.8, 1.15 + this.rand() * 0.2);
  }

  _down(s, dt) {
    const D = s.down;
    D.t += dt;
    const t = this.fx.time;
    s.burn = Math.min(1, s.burn + dt * 1.6);
    s.glow = Math.max(0, s.glow - dt * 2.5);
    s.flash = 0;
    const drag = Math.exp(-0.12 * dt);
    s.vel.multiplyScalar(drag);
    s.vel.y -= 9.81 * (s.isPlayer ? 2 : 1.25) * dt; // (yours drops faster: you're waiting on it)
    _m0.copy(s.pos);
    s.pos.addScaledVector(s.vel, dt);
    _q.setFromAxisAngle(D.axis, D.rate * dt);
    s.quat.premultiply(_q);
    s.fwd.copy(FWD).applyQuaternion(s.quat);
    const r = s.radius;
    // a thick black plume, fire licking the hull (spread along this frame's path, so it never beads)
    D.smokeT -= dt;
    while (D.smokeT <= 0) {
      D.smokeT += 0.028 / this.fx.scale;
      const f = this.rand();
      _c.lerpVectors(_m0, s.pos, f);
      rndDir(_a).multiplyScalar(r * 0.35);
      const sz = r * 0.5 + 1.5;
      this.fx.smoke.emit(_c.x + _a.x, _c.y + _a.y, _c.z + _a.z, s.vel.x * 0.12, s.vel.y * 0.12 + 1.5, s.vel.z * 0.12, 4 + this.rand() * 2.5, sz, sz * 4.2, 1.15, 1.8, 0.04, 0.036, 0.032, SMOKE.SMOKE, t - (1 - f) * dt, 0.95);
    }
    D.fireT -= dt;
    while (D.fireT <= 0) {
      D.fireT += 0.045 / this.fx.scale;
      const f = this.rand();
      this._flame(s, 1.1, _c.lerpVectors(_m0, s.pos, f), t - (1 - f) * dt);
    }
    D.boomT -= dt;
    if (D.boomT <= 0) {
      D.boomT = 0.45 + this.rand() * 0.6;
      rndDir(_a).multiplyScalar(r * 0.5);
      this.fx.explosion(_c.copy(s.pos).add(_a), 0.35 + r / 30, { ring: false, smoke: false });
      this.sound('dm_boom_s', _c, 0.5, 1.2 + this.rand() * 0.3);
    }
    D.debrisT -= dt;
    if (D.debrisT <= 0) {
      D.debrisT = 0.18 + this.rand() * 0.15;
      rndDir(_e).multiplyScalar(10 + this.rand() * 18);
      _e.add(s.vel);
      this.fx.debris.spawn(s.pos, _e, CHAR, 0.4 + this.rand() * 0.7, 2 + this.rand() * 3);
    }
    const gy = this.arena.groundY(s.pos.x, s.pos.z);
    if (s.pos.y - r * 0.35 < gy) this._crash(s, gy);
    else if (D.t > (s.isPlayer ? 4.5 : 16)) this._breakup(s);
  }

  /** A wreck that burns out before it reaches the ground blows apart in the air. */
  _breakup(s) {
    const r = s.radius;
    this.fx.explosion(s.pos, 1.6 + r / 8);
    for (let i = 0; i < 3; i++) {
      rndDir(_b).multiplyScalar(r * 0.7);
      this.fx.explosion(_c.copy(s.pos).add(_b), 0.8 + r / 14, { ring: false });
    }
    for (let i = 0; i < 12 + r; i++) {
      rndDir(_e).multiplyScalar(20 + this.rand() * 45);
      _e.add(s.vel);
      this.fx.debris.spawn(s.pos, _e, this.rand() < 0.3 ? s.paint : CHAR, 0.5 + this.rand() * 1.1, this.rand() < 0.6 ? 4 + this.rand() * 5 : 0);
    }
    s.state = 'dead';
    s.vel.set(0, 0, 0);
    s.respawnT = 3 + this.rand() * 3;
    s.down = null;
    this.events.push({ type: 'crash', ship: s, at: s.pos.clone() });
    this.sound('boom', s.pos, 1, 0.85 + this.rand() * 0.2);
  }

  _crash(s, gy) {
    const r = s.radius;
    _a.set(s.pos.x, Math.max(gy, Math.min(s.pos.y, gy + 2)), s.pos.z);
    this.fx.explosion(_a, 2.2 + r / 7);
    for (let i = 0; i < 4; i++) {
      rndDir(_b).multiplyScalar(r * 0.8);
      _b.y = Math.abs(_b.y);
      this.fx.explosion(_c.copy(_a).add(_b), 1 + r / 12, { ring: false, sparks: false });
    }
    this.fx.smokeColumn(_a, 16 + this.rand() * 10, 0.7 + r / 14);
    this.fx.smoke.emit(_a.x, _a.y + 1, _a.z, 0, 2, 0, 3, 8, 40 + r * 2, 1, 0.4, 0.45, 0.4, 0.33, SMOKE.DUST, this.fx.time, 0.7);
    for (let i = 0; i < 8 + r; i++) {
      rndDir(_e).multiplyScalar(15 + this.rand() * 30);
      _e.y = Math.abs(_e.y) + 8;
      this.fx.debris.spawn(_a, _e, CHAR, 0.5 + this.rand() * 1.2, this.rand() < 0.6 ? 5 + this.rand() * 6 : 0);
    }
    s.state = 'dead';
    s.vel.set(0, 0, 0);
    s.respawnT = 3.5 + this.rand() * 3;
    s.down = null;
    this.events.push({ type: 'crash', ship: s, at: _a.clone() });
    this.sound('boom', _a, 1, 0.75 + this.rand() * 0.2);
  }

  // ----------------------------------------------------------- spawning

  /** A free spot in the sky: not too close to anyone (or to the player). */
  pickSpawn(out, { avoid = null, minPlayer = 0 } = {}) {
    let best = null;
    let bestScore = -Infinity;
    for (let k = 0; k < 14; k++) {
      const a = this.rand() * Math.PI * 2;
      const r = 250 + Math.sqrt(this.rand()) * 1750;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = this.arena.groundY(x, z) + 230 + this.rand() * 520;
      _b.set(x, y, z);
      let near = 1e9;
      for (const s of this.ships) {
        if (s.state !== 'alive' && s.state !== 'inbound') continue;
        near = Math.min(near, (s.state === 'inbound' ? s.spawn : s.pos).distanceTo(_b));
      }
      let score = Math.min(near, 400);
      if (avoid && avoid.state === 'alive' && avoid.pos.distanceTo(_b) < minPlayer) score -= 1000;
      if (score > bestScore) {
        bestScore = score;
        best = _c.copy(_b);
      }
    }
    return out.copy(best);
  }

  /** Begin a teleport arrival: a streak from the sky to `at`, `dur` seconds. */
  beginInbound(s, at, dur = 1.2) {
    s.state = 'inbound';
    s.spawn.copy(at);
    // from high up, mostly overhead, out of a random quarter
    rndDir(_a);
    _a.y = 0.55 + Math.abs(_a.y) * 0.45;
    _a.normalize();
    s.from.copy(at).addScaledVector(_a, 2600 + this.rand() * 1400);
    s.inboundT = 0;
    s.inboundDur = dur;
    s.pos.copy(s.from);
    s.vel.set(0, 0, 0);
    s.mat = 0;
  }

  respawn(s, at = null) {
    s.hp = s.maxHp;
    s.burn = 0;
    s.glow = 1;
    s.flash = 0;
    s.burnDot = 0;
    s.stun = 0;
    s.heat = 0;
    s.overheated = 0;
    s.fuel = 1;
    s.fuelDry = false;
    s.lastHitBy = null;
    for (const k in s.cd) s.cd[k] = 0;
    if (s.brain) s.brain.reset(s);
    this.beginInbound(s, at || this.pickSpawn(_d, { avoid: this.player, minPlayer: 350 }), 0.9 + this.rand() * 0.5);
  }

  _inbound(s, dt) {
    s.inboundT += dt;
    const u = Math.min(1, s.inboundT / s.inboundDur);
    const e = 1 - (1 - u) * (1 - u) * (1 - u);
    _a.lerpVectors(s.from, s.spawn, e);
    const speed = (3 * (1 - u) * (1 - u) * s.from.distanceTo(s.spawn)) / s.inboundDur;
    _b.subVectors(s.spawn, s.from).normalize();
    s.pos.copy(_a);
    const c = s.style.laser.color;
    s.trail = { head: _a.clone(), dir: _b.clone(), len: Math.min(900, 40 + speed * 0.18), c };
    if (u >= 1) this._arrive(s);
  }

  _arrive(s) {
    s.state = 'alive';
    s.trail = null;
    s.pos.copy(s.spawn);
    s.vel.set(0, 0, 0);
    s.mat = 0;
    // face the middle of the arena
    _b.set(-s.pos.x, 0, -s.pos.z);
    if (_b.lengthSq() < 1) _b.set(0, 0, -1);
    _b.normalize();
    _mat.lookAt(_e.set(0, 0, 0), _b, UP);
    s.quat.setFromRotationMatrix(_mat);
    s.fwd.copy(FWD).applyQuaternion(s.quat);
    s.face.copy(s.fwd);
    const c = s.style.laser.color;
    this.fx.arrival(s.pos, [c[0] * 0.7 + 0.4, c[1] * 0.7 + 0.4, c[2] * 0.7 + 0.5], 0.6 + s.radius / 14);
    this.events.push({ type: 'arrive', ship: s });
    this.sound('dm_tele', s.pos, 0.9, 0.9 + this.rand() * 0.2);
  }

  // ----------------------------------------------------------- collisions

  _collide() {
    for (const s of this.ships) {
      if (s.state !== 'alive') continue;
      this.query(s.pos.x, s.pos.z, s.radius + 20, (o) => {
        if (o.id <= s.id || o.state !== 'alive') return;
        _a.subVectors(o.pos, s.pos);
        const d = _a.length();
        const min = s.radius + o.radius;
        if (d >= min || d < 1e-3) return;
        _a.divideScalar(d);
        const push = min - d;
        // bots give way; the player's craft is moved by its own flight model
        if (s.isPlayer) o.pos.addScaledVector(_a, push);
        else if (o.isPlayer) s.pos.addScaledVector(_a, -push);
        else {
          s.pos.addScaledVector(_a, -push / 2);
          o.pos.addScaledVector(_a, push / 2);
        }
        const closing = _b.subVectors(s.vel, o.vel).dot(_a);
        if (closing > 50) {
          const dmg = (closing - 50) * 0.35;
          _c.copy(s.pos).addScaledVector(_a, s.radius);
          this.fx.hit(_c, _a, [3, 2, 1], 14, 1.6);
          this.damage(s, dmg, o, 'crash', _c, _a);
          this.damage(o, dmg, s, 'crash', _c, _a);
          if (!s.isPlayer) s.vel.addScaledVector(_a, -closing * 0.6);
          if (!o.isPlayer) o.vel.addScaledVector(_a, closing * 0.6);
        }
      });
    }
  }

  // ----------------------------------------------------------- drawing

  /** Push this frame's projectile streaks, missile bodies and inbound trails into the fx. */
  draw() {
    const fx = this.fx;
    const cannon = WEAPONS.cannon.color;
    const plasma = WEAPONS.plasma.color;
    for (const p of this.active) {
      // your own rounds start thin from the cockpit and swell as they leave
      const q = p.owner ? p.owner.fxScale : 1;
      const k = q < 1 ? q + (1 - q) * Math.min(1, p.age / 0.3) : 1;
      if (p.kind === 'shell') {
        const sp = p.vel.length();
        _a.copy(p.pos).addScaledVector(p.vel, -Math.min(22, sp * 0.035) / Math.max(sp, 1));
        fx.streak(_a, p.pos, 0.55 * k, PATTERN.TRACER, cannon, 1);
      } else if (p.kind === 'bolt') {
        const sp = p.vel.length();
        _a.copy(p.pos).addScaledVector(p.vel, -12 / Math.max(sp, 1));
        fx.streak(_a, p.pos, 2.6 * k, PATTERN.BOLT, plasma, 1.3);
      } else {
        fx.missiles.push(p.pos, p.quat);
        const motor = p.age < p.seek + 1.5 || p.age < 2;
        if (motor) {
          _b.set(0, 0, 1).applyQuaternion(p.quat); // tail direction
          _c.copy(p.pos).addScaledVector(_b, 1.15);
          _a.copy(_c).addScaledVector(_b, 3.5 + this.rand() * 1.5);
          fx.streak(_a, _c, 1.3, PATTERN.FLAME, [2.6, 1.5, 0.6], 1.4);
        }
      }
    }
    for (const s of this.ships) {
      if (s.state !== 'inbound' || !s.trail) continue;
      const T = s.trail;
      _a.copy(T.head).addScaledVector(T.dir, -T.len);
      const c = T.c;
      fx.streak(_a, T.head, 3 + s.radius * 0.25, PATTERN.BOLT, [c[0] * 0.6 + 0.6, c[1] * 0.6 + 0.6, c[2] * 0.6 + 0.7], 1.6);
      fx.glow.emit(T.head.x, T.head.y, T.head.z, 0, 0, 0, 0.06, 7 + s.radius, 9 + s.radius, 0, 0, 1.4, 1.6, 2.2, GLOW.GLOW, fx.time);
    }
  }

  sound(name, pos, gain = 1, rate = 1) {
    if (this.sfx) this.sfx.at(name, pos, gain, rate);
  }

  /** Standings, best first. */
  standings() {
    return [...this.ships].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.id - b.id);
  }

  reset() {
    for (const p of [...this.active]) {
      p.alive = false;
      this.pool.push(p);
    }
    this.active.length = 0;
    this.t = 0;
    this.events.length = 0;
    for (const s of this.ships) {
      s.kills = 0;
      s.deaths = 0;
      s.state = 'out';
      s.hp = s.maxHp;
      s.burn = 0;
      s.glow = 1;
      s.flash = 0;
      s.mat = 0;
      s.burnDot = 0;
      s.stun = 0;
      s.heat = 0;
      s.overheated = 0;
      s.fuel = 1;
      s.fuelDry = false;
      s.trigger = false;
      s.lockTarget = null;
      s.lastHitBy = null;
      s.lastHitT = -99;
      s.down = null;
      s.trail = null;
      for (const k in s.cd) s.cd[k] = 0;
      if (s.brain) s.brain.reset(s);
      s.targeters = 0;
    }
  }
}

/** Unit vector within `spread` radians of d (out may not alias d). */
function jitter(d, spread, out) {
  rndDir(out).multiplyScalar(spread * Math.sqrt(Math.random()));
  return out.add(d).normalize();
}

/** Rotate unit vector v toward unit vector w by at most `max` radians. */
function turnToward(v, w, max) {
  const dot = Math.max(-1, Math.min(1, v.dot(w)));
  const ang = Math.acos(dot);
  if (ang <= max || ang < 1e-5) return v.copy(w);
  const axis = _f.crossVectors(v, w);
  if (axis.lengthSq() < 1e-10) return v;
  axis.normalize();
  return v.applyAxisAngle(axis, max);
}

/** Quaternion with −Z along v. */
function orient(q, v) {
  const l = v.length();
  if (l < 1e-4) return q;
  _q2.setFromUnitVectors(FWD, _b.copy(v).divideScalar(l));
  return q.copy(_q2);
}
