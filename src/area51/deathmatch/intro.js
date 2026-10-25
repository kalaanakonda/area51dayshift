import { MathUtils, Vector3 } from 'three';

/**
 * The opening: a hundred craft teleport in over Nuremberg.
 *
 *   0 – 5.5 s    high wide shot over the old town, the title; the first
 *                streaks of light fall out of the sky
 *   5.5 – 10.8   a low orbit through the arrivals as they turn into a flood
 *   10.8 – 14    your own ARV-3 comes in last, close up
 *   then         your view, a three-second countdown, FIGHT
 *
 * Arrivals start sparse and bunch up (t ∝ i^0.55). Space skips to your own.
 */
export const INTRO = {
  shotB: 5.5,
  shotC: 10.8,
  end: 14.0,
  first: 1.6,
  last: 10.6,
  playerAt: 12.7,
};

const smooth = (u) => u * u * (3 - 2 * u);

export class Intro {
  constructor(dm) {
    this.dm = dm;
    this.t = 0;
    this.schedule = [];
    this.done = true;
    this.eye = new Vector3();
    this.look = new Vector3();
    this.playerSpawn = new Vector3();
    this.arrived = 0;
  }

  start({ short = false } = {}) {
    const M = this.dm.match;
    const A = this.dm.arena;
    const rand = M.rand;
    this.t = short ? INTRO.shotB - 0.5 : 0;
    this.done = false;
    this.arrived = 0;
    this.schedule.length = 0;
    const g0 = A.groundY(0, 0);
    this.g0 = g0;
    this.playerSpawn.set(0, A.groundY(0, 950) + 430, 950);
    const bots = M.ships.filter((s) => !s.isPlayer);
    for (let i = bots.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [bots[i], bots[j]] = [bots[j], bots[i]];
    }
    const t0 = short ? this.t + 0.3 : INTRO.first;
    const n = bots.length;
    bots.forEach((s, i) => {
      const at = t0 + (INTRO.last - t0) * Math.pow(i / Math.max(1, n - 1), 0.55);
      const dur = 1.1 + rand() * 0.7;
      // the first few land in front of the opening shot
      const spawn = new Vector3();
      if (i < 6 && !short) {
        const a = -2.2 + i * 0.35;
        const r = 420 + rand() * 500;
        spawn.set(Math.cos(a) * r, 0, Math.sin(a) * r * 0.6 - 150);
        spawn.y = A.groundY(spawn.x, spawn.z) + 300 + rand() * 300;
      } else M.pickSpawn(spawn);
      // reserve it so later picks keep their distance
      s.spawn.copy(spawn);
      s.state = 'inbound';
      this.schedule.push({ ship: s, at: Math.max(0, at - dur), dur, spawn, started: false });
    });
    // undo the reservations (beginInbound sets the real state)
    for (const e of this.schedule) {
      e.ship.state = 'out';
      e.ship.trail = null;
    }
    const me = M.player;
    this.schedule.push({ ship: me, at: INTRO.playerAt - 1.3, dur: 1.3, spawn: this.playerSpawn.clone(), started: false });
    this.total = this.schedule.length;
  }

  skip() {
    if (this.done || this.t >= INTRO.shotC) return;
    const M = this.dm.match;
    for (const e of this.schedule) {
      if (e.started || e.ship.isPlayer) continue;
      e.started = true;
      M.beginInbound(e.ship, e.spawn, 0.05);
    }
    this.t = INTRO.shotC;
  }

  update(dt) {
    if (this.done) return;
    this.t += dt;
    const M = this.dm.match;
    for (const e of this.schedule) {
      if (!e.started && this.t >= e.at) {
        e.started = true;
        M.beginInbound(e.ship, e.spawn, e.dur);
      }
    }
    this.arrived = 0;
    for (const s of M.ships) if (s.state === 'alive') this.arrived++;
    this._camera(this.t);
    if (this.t >= INTRO.end) this.done = true;
  }

  /** Cinematic camera, arena-local. Returns { eye, look, fov }. */
  _camera(t) {
    const g = this.g0;
    const E = this.eye;
    const L = this.look;
    let fov = 55;
    if (t < INTRO.shotB) {
      const u = smooth(MathUtils.clamp(t / INTRO.shotB, 0, 1));
      E.set(MathUtils.lerp(-2300, -1700, u), g + MathUtils.lerp(1350, 980, u), MathUtils.lerp(2100, 1450, u));
      L.set(0, g + 250, -150);
    } else if (t < INTRO.shotC) {
      const u = smooth((t - INTRO.shotB) / (INTRO.shotC - INTRO.shotB));
      const a = MathUtils.degToRad(MathUtils.lerp(205, 262, u));
      const r = MathUtils.lerp(1250, 1000, u);
      E.set(Math.cos(a) * r, g + MathUtils.lerp(520, 400, u), Math.sin(a) * r);
      L.set(0, g + 400, 0);
      fov = 60;
    } else {
      const u = smooth(MathUtils.clamp((t - INTRO.shotC) / (INTRO.end - INTRO.shotC), 0, 1));
      const P = this.playerSpawn;
      E.set(P.x - 34 + u * 8, P.y + 9 - u * 3, P.z - 44 + u * 12);
      L.copy(P).y += 1.5;
      fov = 50;
    }
    this.fov = fov;
    // a dip to dark at each cut
    const cut = Math.min(Math.abs(t - INTRO.shotB), Math.abs(t - INTRO.shotC));
    this.fade = 0.2 + 0.8 * MathUtils.clamp(cut / 0.22, 0, 1);
    return { eye: E, look: L, fov };
  }

  /** The loading view (what the tiles stream for): the first frame of shot A. */
  loadingPose() {
    const g = this.dm.arena.groundY(0, 0);
    this.eye.set(-2300, g + 1350, 2100);
    this.look.set(0, g + 250, -150);
    this.fov = 55;
    this.fade = 1;
    return { eye: this.eye, look: this.look, fov: 55 };
  }

  /** Title lines for the HUD at time t (or null). */
  titles() {
    const t = this.t;
    if (t < INTRO.shotB - 0.3) return { kicker: 'Nuremberg · Franconia · 49.45°N 11.08°E', title: 'Nuremberg', lede: 'At sunrise on 14 April 1561 the town saw the sky fill with globes, crosses and tubes, fighting overhead for an hour. They are back.' };
    if (t < INTRO.shotC) return { kicker: 'Deathmatch · free for all', title: '', lede: '' };
    return null;
  }
}
