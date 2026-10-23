import { Euler, Object3D, Quaternion, Vector3 } from 'three';
import { clamp, damp, DEG, fbm1, vnoise } from '../core/math.js';

const _euler = new Euler(0, 0, 0, 'YXZ');
const _q = new Quaternion();
const _offset = new Vector3();

/**
 * FirstPersonRig — the player's eyes.
 *
 * The final head pose is a stack of layers, each with a clear owner:
 *
 *   directed   (dir.*)    the Director's GSAP timeline: where the shot looks
 *   look       (look.*)   optional mouse glance, bounded and weighted 0..1
 *   gait       (auto)     head bob/sway derived from how far `dir` moved —
 *                         walking is never animated by hand, only position is
 *   breath     (feel.*)   slow inhale/exhale, always on, scaled per scene
 *   handheld   (feel.*)   sub-degree drift so a still frame is never dead
 *   zero-g     (feel.*)   slow tumble when floating
 *   shake      (shake.*)  trauma impulses (jolts) + sustained engine rumble
 *
 * `body` carries the directed pose WITHOUT the glance/noise layers. Hands and
 * held props hang off `body`, so a mouse glance moves the eyes, not the arms —
 * the phone stays where your hands are while you look past it.
 */
export class FirstPersonRig {
  constructor(camera, input) {
    this.camera = camera;
    this.input = input;

    this.dir = { x: 0, y: 1.68, z: 0, yaw: 0, pitch: 0, roll: 0, fov: 50 };
    this.look = { weight: 0, yawLimit: 0.5, pitchLimit: 0.3, yaw: 0, pitch: 0, response: 3.2 };
    this.feel = { breath: 1, handheld: 1, bob: 1, gravity: 1, float: 0, strideLength: 0.78 };
    this.shake = { trauma: 0, decay: 0.9, rumble: 0, rumbleFreq: 19, sway: 0 };

    this.body = new Object3D();
    this.body.name = 'PlayerBody';

    this.walk = { phase: 0, speed: 0, moving: 0 };
    this.onFootstep = null;
    this.time = 0;
    this._last = new Vector3(this.dir.x, this.dir.y, this.dir.z);
    this._lastFov = -1;
    this.offsets = { yaw: 0, pitch: 0, roll: 0 };
  }

  /** Snap the gait tracker after a cut so a teleport is not read as a sprint. */
  cut() {
    this._last.set(this.dir.x, this.dir.y, this.dir.z);
    this.walk.speed = 0;
    this.walk.moving = 0;
  }

  /** Add an impulse (0..1). Shake grows with trauma², so small hits stay subtle. */
  addTrauma(amount) {
    this.shake.trauma = clamp(this.shake.trauma + amount, 0, 1);
  }

  update(dt) {
    this.time += dt;
    const t = this.time;
    const d = this.dir;
    const f = this.feel;

    // ---- Gait: derive walking from directed horizontal motion ---------------------
    const dx = d.x - this._last.x;
    const dz = d.z - this._last.z;
    const dist = Math.hypot(dx, dz);
    this._last.set(d.x, d.y, d.z);
    const instSpeed = dt > 0 ? dist / dt : 0;
    this.walk.speed = damp(this.walk.speed, Math.min(instSpeed, 4), 5, dt);
    this.walk.moving = clamp(this.walk.speed / 1.1, 0, 1) * (f.float > 0.5 ? 0 : 1);
    const lowG = f.gravity < 0.6;
    const stride = f.strideLength * (lowG ? 1.25 : 1);
    const prevPhase = this.walk.phase;
    if (this.walk.moving > 0.02) this.walk.phase += (dist / stride) * Math.PI;
    if (this.onFootstep && Math.floor(prevPhase / Math.PI) !== Math.floor(this.walk.phase / Math.PI)) {
      this.onFootstep(Math.floor(this.walk.phase / Math.PI) % 2 === 0 ? 'left' : 'right', this.walk.moving);
    }
    const ph = this.walk.phase;
    const m = this.walk.moving * f.bob;
    const bobAmp = (lowG ? 0.055 : 0.032) * m;
    // Lowest at heel strike (phase = kπ), highest at mid-stance.
    const bobY = (Math.abs(Math.sin(ph)) - 0.62) * bobAmp;
    const sway = Math.sin(ph) * 0.016 * m;
    const bobRoll = Math.sin(ph) * 0.45 * DEG * m;
    const bobPitch = -Math.cos(ph * 2) * 0.35 * DEG * m;

    // ---- Breath + handheld + zero-g ----------------------------------------------
    const br = Math.sin(t * Math.PI * 2 * 0.21);
    const breathY = br * 0.0045 * f.breath;
    const breathPitch = br * 0.18 * DEG * f.breath;
    const hh = f.handheld;
    const hYaw = fbm1(t * 0.32, 3) * 0.32 * DEG * hh;
    const hPitch = fbm1(t * 0.27 + 40, 3) * 0.26 * DEG * hh;
    const hRoll = fbm1(t * 0.21 + 80, 2) * 0.22 * DEG * hh;
    const fl = f.float;
    const fYaw = fbm1(t * 0.07 + 5, 2) * 2.2 * DEG * fl;
    const fPitch = fbm1(t * 0.06 + 9, 2) * 1.6 * DEG * fl;
    const fRoll = fbm1(t * 0.05 + 13, 2) * 4.5 * DEG * fl;
    const fx = fbm1(t * 0.09 + 21, 2) * 0.05 * fl;
    const fy = fbm1(t * 0.08 + 27, 2) * 0.05 * fl;
    const fz = fbm1(t * 0.07 + 31, 2) * 0.04 * fl;

    // ---- Shake --------------------------------------------------------------------
    const sh = this.shake;
    sh.trauma = Math.max(0, sh.trauma - sh.decay * dt);
    const tr = sh.trauma * sh.trauma;
    const fr = 22;
    let sYaw = vnoise(t * fr + 100) * 1.6 * DEG * tr;
    let sPitch = vnoise(t * fr + 200) * 1.8 * DEG * tr;
    let sRoll = vnoise(t * fr + 300) * 2.4 * DEG * tr;
    let sx = vnoise(t * fr + 400) * 0.025 * tr;
    let sy = vnoise(t * fr + 500) * 0.03 * tr;
    const r = sh.rumble;
    if (r > 0) {
      const rf = sh.rumbleFreq;
      sYaw += vnoise(t * rf + 600) * 0.22 * DEG * r + vnoise(t * 2.1 + 610) * 0.35 * DEG * r * r;
      sPitch += vnoise(t * rf + 700) * 0.3 * DEG * r + vnoise(t * 1.7 + 710) * 0.4 * DEG * r * r;
      sRoll += vnoise(t * rf * 0.8 + 800) * 0.2 * DEG * r;
      sx += vnoise(t * rf + 900) * 0.003 * r;
      sy += vnoise(t * rf * 1.3 + 1000) * 0.004 * r;
    }
    if (sh.sway > 0) {
      sRoll += vnoise(t * 0.5 + 1100) * 2.5 * DEG * sh.sway;
      sPitch += vnoise(t * 0.4 + 1200) * 1.2 * DEG * sh.sway;
    }

    // ---- Mouse glance ------------------------------------------------------------
    const L = this.look;
    let tYaw = 0;
    let tPitch = 0;
    if (this.input && this.input.hasMoved && L.weight > 0) {
      tYaw = -shapeAxis(this.input.ndc.x) * L.yawLimit;
      tPitch = shapeAxis(this.input.ndc.y) * L.pitchLimit;
    }
    L.yaw = damp(L.yaw, tYaw * L.weight, L.response, dt);
    L.pitch = damp(L.pitch, tPitch * L.weight, L.response, dt);

    // ---- Compose -----------------------------------------------------------------
    const yaw = d.yaw + this.offsets.yaw;
    const pitch = d.pitch + this.offsets.pitch;
    const roll = d.roll + this.offsets.roll;

    // Body: directed pose + gait/breath (hands ride the body), half the shake.
    _offset.set(sway + fx, bobY + breathY + fy, fz);
    _q.setFromEuler(_euler.set(0, yaw, 0));
    _offset.applyQuaternion(_q);
    this.body.position.set(d.x + _offset.x + sx * 0.5, d.y + _offset.y + sy * 0.5, d.z + _offset.z);
    this.body.quaternion.setFromEuler(
      _euler.set(pitch + bobPitch * 0.5 + breathPitch * 0.5 + sPitch * 0.5, yaw + sYaw * 0.5, roll + bobRoll * 0.6 + sRoll * 0.5)
    );
    this.body.updateMatrixWorld(true);

    // Eyes: everything.
    this.camera.position.set(d.x + _offset.x + sx, d.y + _offset.y + sy, d.z + _offset.z);
    this.camera.quaternion.setFromEuler(
      _euler.set(
        pitch + L.pitch + bobPitch + breathPitch + hPitch + fPitch + sPitch,
        yaw + L.yaw + hYaw + fYaw + sYaw,
        roll + bobRoll + hRoll + fRoll + sRoll
      )
    );
    if (Math.abs(d.fov - this._lastFov) > 1e-4) {
      this.camera.fov = d.fov;
      this.camera.updateProjectionMatrix();
      this._lastFov = d.fov;
    }
    this.camera.updateMatrixWorld(true);
  }
}

/** Dead-zone + gentle curve so small cursor drift doesn't wobble the frame. */
function shapeAxis(v) {
  const dz = 0.06;
  const a = Math.max(0, Math.abs(v) - dz) / (1 - dz);
  return Math.sign(v) * Math.pow(Math.min(1, a), 1.35);
}
