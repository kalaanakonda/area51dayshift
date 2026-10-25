import { Vector3 } from 'three';
import { ARENA } from './arena.js';
import { rndDir } from './fx.js';
import { WEAPONS } from './weapons.js';

/**
 * A bot pilot. Each frame it picks (or keeps) a target, chooses a weapon for
 * the range, and writes the ship's intent: a desired velocity, where to face,
 * where to aim, and whether the trigger is down. The match does the flying.
 *
 * Behaviour, in priority order: don't hit the ground, stay inside the arena,
 * don't ram anyone, run when badly hurt, jink when shot at, otherwise circle
 * the target at the chosen weapon's best range and fire in bursts. Skill
 * sets aim error; aggression sets throttle and burst length.
 */
const UP = new Vector3(0, 1, 0);
const _to = new Vector3();
const _tan = new Vector3();
const _des = new Vector3();
const _aimP = new Vector3();
const _away = new Vector3();

export class Brain {
  constructor(ship, rand) {
    this.rand = rand;
    this.skill = 0.3 + rand() * 0.65;
    this.aggro = 0.35 + rand() * 0.65;
    this.target = null;
    this.retarget = rand() * 1.2;
    this.strafe = rand() < 0.5 ? 1 : -1;
    this.strafeT = 2 + rand() * 4;
    this.weave = rand() * 10;
    this.burst = 0;
    this.pause = rand() * 1.5;
    this.evade = 0;
    this.jink = new Vector3();
    this.jinkT = 0;
    this.altOff = (rand() - 0.5) * 180;
    this.err = new Vector3();
    this.errGoal = new Vector3();
    this.errT = 0;
    this.hpWas = ship.hp;
    this.hurt = 0;
    this.lockT = 0;
    this.flee = 0;
    this.wanderT = 0;
    this.wander = new Vector3();
  }

  setTarget(t) {
    if (this.target === t) return;
    if (this.target) this.target.targeters = Math.max(0, this.target.targeters - 1);
    this.target = t;
    if (t) t.targeters++;
    this.lockT = 0;
  }

  reset(ship) {
    this.setTarget(null);
    this.hpWas = ship.hp;
    this.hurt = 0;
    this.evade = 0;
    this.flee = 0;
    this.retarget = 0.3 + this.rand() * 0.8;
  }

  _choose(s, M) {
    let best = null;
    let bestScore = Infinity;
    for (const o of M.ships) {
      if (o === s || o.state !== 'alive' || o.mat < 1) continue;
      const d = o.pos.distanceTo(s.pos);
      if (d > 2800) continue;
      let score = d * (0.75 + this.rand() * 0.5);
      if (o === s.lastHitBy && M.t - s.lastHitT < 6) score *= 0.35; // whoever is shooting me
      if (o === this.target) score *= 0.8; // keep at it
      if (o.isPlayer) score *= o.targeters >= M.maxOnPlayer && this.target !== o ? 5 : M.playerBias;
      score *= 0.7 + 0.6 * (o.hp / o.maxHp); // finish off the wounded
      if (score < bestScore) {
        bestScore = score;
        best = o;
      }
    }
    this.setTarget(best);
  }

  _weapon(s, dist) {
    let best = s.weapon;
    let bestScore = -Infinity;
    for (const id of s.style.loadout) {
      const [mn, opt, mx] = WEAPONS[id].bot;
      if (dist < mn * 0.7 || dist > mx * 1.15) continue;
      let sc = 1 - Math.abs(dist - opt) / mx;
      if (id === 'laser' && s.overheated > 0) sc -= 2;
      if (id === 'fire' && s.fuel < 0.25) sc -= 2;
      if ((id === 'missile' || id === 'plasma' || id === 'arc') && s.cd[id] > 0.4) sc -= 0.35;
      if (id === s.weapon) sc += 0.15;
      if (sc > bestScore) {
        bestScore = sc;
        best = id;
      }
    }
    if (bestScore === -Infinity) {
      // nothing reaches: the longest arm in the loadout
      let reach = 0;
      for (const id of s.style.loadout) if (WEAPONS[id].bot[2] > reach) (reach = WEAPONS[id].bot[2]), (best = id);
    }
    return best;
  }

  update(dt, s, M) {
    const A = M.arena;
    const R = this.rand;
    const t = M.t;
    // pain → jink, and usually turn on whoever did it
    if (s.hp < this.hpWas - 0.5) this.hurt += this.hpWas - s.hp;
    this.hpWas = s.hp;
    this.hurt = Math.max(0, this.hurt - dt * 12);
    if (this.hurt > 26 && this.evade <= 0) {
      this.evade = 1.0 + R() * 1.6;
      this.jinkT = 0;
      const a = s.lastHitBy;
      if (a && a !== s && a.state === 'alive' && R() < 0.7) this.setTarget(a);
    }
    this.evade -= dt;
    this.flee -= dt;
    if (s.hp < s.maxHp * 0.28 && this.flee <= -4 && R() < 0.01) this.flee = 2.5 + R() * 2.5;

    this.retarget -= dt;
    if (!this.target || this.target.state !== 'alive' || this.retarget <= 0) {
      this.retarget = 0.9 + R() * 1.3;
      this._choose(s, M);
    }
    const T = this.target;
    const des = _des.set(0, 0, 0);
    let throttle = 0.55;
    let engaged = false;
    let dist = 1e9;
    if (T) {
      const to = _to.subVectors(T.pos, s.pos);
      dist = Math.max(1, to.length());
      to.divideScalar(dist);
      s.weapon = this._weapon(s, dist);
      const W = WEAPONS[s.weapon];
      const pref = Math.max(W.bot[1], s.radius + T.radius + 35);
      this.strafeT -= dt;
      if (this.strafeT <= 0) {
        this.strafeT = 2.5 + R() * 5;
        if (R() < 0.5) this.strafe = -this.strafe;
      }
      const tan = _tan.crossVectors(UP, to);
      if (tan.lengthSq() < 1e-4) tan.set(1, 0, 0);
      tan.normalize().multiplyScalar(this.strafe);
      const rangeErr = Math.max(-1, Math.min(1, (dist - pref) / Math.max(90, pref * 0.5)));
      des.addScaledVector(to, rangeErr * 1.25).addScaledVector(tan, 0.6 + 0.25 * Math.sin(t * 0.8 + this.weave));
      des.y += Math.max(-0.7, Math.min(0.7, (T.pos.y + this.altOff - s.pos.y) / 180)) + 0.25 * Math.sin(t * 0.5 + this.weave * 2);
      throttle = 0.5 + 0.45 * this.aggro + (dist > pref * 1.6 ? 0.3 : 0);
      engaged = true;
    } else {
      this.wanderT -= dt;
      if (this.wanderT <= 0) {
        this.wanderT = 5 + R() * 4;
        const a = R() * Math.PI * 2;
        const r = R() * ARENA.radius * 0.6;
        this.wander.set(Math.cos(a) * r, A.groundY(0, 0) + 300 + R() * 400, Math.sin(a) * r);
      }
      des.subVectors(this.wander, s.pos).normalize();
    }
    if (this.evade > 0) {
      this.jinkT -= dt;
      if (this.jinkT <= 0) {
        this.jinkT = 0.35 + R() * 0.4;
        rndDir(this.jink);
        if (s.lastHitBy) {
          // mostly across the line of fire
          _away.subVectors(s.pos, s.lastHitBy.pos).normalize();
          this.jink.addScaledVector(_away, -this.jink.dot(_away)).normalize();
        }
      }
      des.multiplyScalar(0.4).addScaledVector(this.jink, 1.4);
      throttle = 1;
    }
    if (this.flee > 0 && s.lastHitBy) {
      _away.subVectors(s.pos, s.lastHitBy.pos).normalize();
      des.copy(_away).addScaledVector(UP, 0.4);
      throttle = 1;
      engaged = false;
    }

    // keep clear of the others
    M.query(s.pos.x, s.pos.z, 70 + s.radius, (o) => {
      if (o === s || (o.state !== 'alive' && o.state !== 'down')) return;
      const dx = s.pos.x - o.pos.x;
      const dy = s.pos.y - o.pos.y;
      const dz = s.pos.z - o.pos.z;
      const d = Math.hypot(dx, dy, dz);
      const min = s.radius + o.radius + 28;
      if (d < min && d > 1e-3) {
        const k = ((min - d) / min) * 2.6;
        des.x += (dx / d) * k;
        des.y += (dy / d) * k;
        des.z += (dz / d) * k;
      }
    });
    // ground (now and 1.6 s ahead), ceiling
    const gy = A.groundY(s.pos.x, s.pos.z);
    const agl = s.pos.y - gy;
    const ax = s.pos.x + s.vel.x * 1.6;
    const az = s.pos.z + s.vel.z * 1.6;
    const aagl = s.pos.y + s.vel.y * 1.6 - A.groundY(ax, az);
    const floor = ARENA.floor + s.radius;
    const lo = Math.min(agl, aagl);
    if (lo < floor + 70) des.y += (floor + 70 - lo) / 28;
    if (agl > ARENA.ceiling) des.y -= (agl - ARENA.ceiling) / 120;
    // arena wall
    const r = Math.hypot(s.pos.x, s.pos.z);
    const R0 = ARENA.radius * 0.8;
    if (r > R0) {
      const k = ((r - R0) / 200) * 2;
      des.x -= (s.pos.x / r) * k;
      des.z -= (s.pos.z / r) * k;
    }
    if (s.stun > 0) {
      throttle = 0.25;
      des.x += (R() - 0.5) * 2;
      des.y += (R() - 0.5) * 2;
      des.z += (R() - 0.5) * 2;
    }
    const len = des.length();
    if (len > 1e-4) s.intent.copy(des).multiplyScalar((s.style.speed * Math.min(1, throttle)) / len);
    else s.intent.set(0, 0, 0);

    // aim (lead the target for projectiles), face, fire in bursts
    s.trigger = false;
    s.aimPoint = null;
    if (!T || !engaged) {
      if (s.vel.lengthSq() > 25) s.face.copy(s.vel).normalize();
      return;
    }
    const W = WEAPONS[s.weapon];
    const aimP = _aimP.copy(T.pos);
    const spd = W.speed || 0;
    if (spd) {
      let tt = dist / spd;
      for (let k = 0; k < 2; k++) {
        aimP.copy(T.pos).addScaledVector(T.vel, tt);
        tt = aimP.distanceTo(s.pos) / spd;
      }
      if (s.weapon === 'cannon') aimP.y += 0.5 * 9.81 * tt * tt;
    }
    this.errT -= dt;
    if (this.errT <= 0) {
      this.errT = 0.3 + R() * 0.4;
      rndDir(this.errGoal).multiplyScalar((1 - this.skill) * 0.075 + 0.005);
    }
    this.err.lerp(this.errGoal, 1 - Math.exp(-6 * dt));
    s.aim.subVectors(aimP, s.pos).normalize().add(this.err).normalize();
    s.face.copy(dist < W.range * 1.4 ? s.aim : _to);
    if (!M.hot || s.stun > 0) return;
    const facing = s.fwd.dot(s.aim);
    const inRange = dist < W.range + T.radius;
    if (s.weapon === 'missile') {
      this.lockT = inRange && facing > Math.cos(W.lockCone * 2.5) ? this.lockT + dt : 0;
      s.lockTarget = this.lockT > 0.6 ? T : null;
    }
    if (this.pause > 0) {
      this.pause -= dt;
      if (this.pause <= 0) this.burst = 0.5 + R() * 1.2 * this.aggro + (s.weapon === 'cannon' || s.weapon === 'fire' || s.weapon === 'laser' ? 0.5 : 0);
      return;
    }
    this.burst -= dt;
    s.trigger = inRange && facing > Math.cos(W.cone) && (s.weapon !== 'missile' || !!s.lockTarget);
    if (this.burst <= 0) this.pause = 0.4 + R() * 1.6 * (1.25 - this.aggro);
  }
}
