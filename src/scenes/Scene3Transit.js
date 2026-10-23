import { Color, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { SceneBase } from './SceneBase.js';
import { CabinSet, CABIN } from '../procedural/cabin.js';
import { SpaceSet } from '../procedural/space.js';
import { buildShip } from '../procedural/starship.js';
import { createPlume } from '../procedural/vfx.js';
import { PLANET } from '../procedural/planets.js';
import { bar, INK, label, met, pageFrame, trace } from '../procedural/monitor.js';
import { quatFromDirUp } from '../player/handModel.js';
import { clamp, lerp, smoothstep } from '../core/math.js';

const _m = new Matrix4();
const _ship = new Matrix4();
const _deck = new Matrix4().makeTranslation(0, CABIN.deckY, 0);
const _p = new Vector3();
const _q = new Quaternion();
const _s = new Vector3();
const ONE = new Vector3(1, 1, 1);
const G = 9.81;
const R_EARTH = PLANET.earth.radius;

/** Ship attitude: window normal (ship −Z) along `win`, nose (ship +Y) toward `nose`. */
function attitude(win, nose, out = new Quaternion()) {
  const z = win.clone().normalize().negate();
  const y = nose.clone().addScaledVector(z, -nose.dot(z)).normalize();
  const x = new Vector3().crossVectors(y, z);
  return out.setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
}

/**
 * SCENE 3 — TRANSIT  (~112 s, a Nolan montage of hard cuts)
 *
 *  pad      strapped in, crew arm swings away, countdown, BRACE (hold)
 *  ascent   the tower slides down the windows, roll program swings the
 *           sunrise into the cabin, max-Q → smash cut to silence
 *  staging  hot staging jolt; the booster is already flying home
 *  orbit    SECO: zero-g, the plush indicator floats up, Earth's limb, IMAX
 *  tanker   a tanker glides past the glass; aft camera shows it dock;
 *           START PROPELLANT TRANSFER (hold); orbit sunset in time-lapse
 *  TMI      COMMIT TO MARS (press); Earth falls away
 *  coast    months: the barbecue roll sweeps sunbeams through the cabin,
 *           a ticking clock, Elon's light-delayed message
 *  storm    solar particle event → the water-walled shelter, geiger
 *  Mars     a glove on the glass, Mars filling the window, Arcadia Planitia
 *
 * The cabin is the near layer and never moves; the far layer (Starbase, then
 * space) is seen through a camera = shipPose · deck · eye.
 */
export class Scene3Transit extends SceneBase {
  constructor(ctx, starbase) {
    super(ctx, 'III · Transit');
    this.starbase = starbase;
    this.sunInFar = true;
  }

  async build(progress = () => {}) {
    const { ctx } = this;
    this.cabin = new CabinSet(ctx);
    await this.cabin.build((f, l) => progress(f * 0.45, l));
    this.near = this.cabin.scene;
    this.space = new SpaceSet(ctx);
    await this.space.build((f, l) => progress(0.45 + f * 0.5, l));

    this.launchCam = new PerspectiveCamera(50, 1, 0.3, 30000);
    this.launchCam.name = 'FarEyes_launch';
    this.feedCam = new PerspectiveCamera(64, 16 / 9, 0.4, 4e10);
    this.feedCam.name = 'cam_aft';
    this.feedCam.layers.enable(1);

    // Our own ship, visible only to onboard cameras (layer 1) in space.
    this.selfShip = buildShip({ variant: 'crew', heat: 0.05, soot: 0.15 });
    this.selfShip.traverse((o) => o.layers.set(1));
    this.selfPlumes = [];
    for (let i = 0; i < 3; i++) {
      const b = (i / 3) * Math.PI * 2 + Math.PI / 3;
      const p = createPlume({ length: 26, radius: 6, exitRadius: 1.1, ambient: 0 });
      p.position.set(Math.sin(b) * 2.85, -1.0, Math.cos(b) * 2.85);
      p.layers.set(1);
      p.userData.uniforms.uThrottle.value = 0;
      this.selfShip.add(p);
      this.selfPlumes.push(p);
    }
    this.space.scene.add(this.selfShip);

    this.pose = { pos: new Vector3(), quat: new Quaternion() };
    this.sunCabin = new Vector3(1, 0, 0);
    this.mode = 'launch';
    this.beat = 'pad';
    this.attA = new Quaternion();
    this.attB = new Quaternion();
    this.p = {};
    this.far = this.starbase.scene;
    this.farCamera = this.launchCam;
    progress(1, 'Transit');
  }

  warmTargets() {
    return [
      [this.space.scene, this.space.camera],
      [this.space.scene, this.feedCam],
    ];
  }

  _setMode(mode) {
    this.mode = mode;
    this.far = mode === 'launch' ? this.starbase.scene : this.space.scene;
    this.farCamera = mode === 'launch' ? this.launchCam : this.space.camera;
    this.ctx.engine.setStage(this.stage());
  }

  enter() {
    const { rig, hands, audio, post, engine } = this.ctx;
    const sb = this.starbase;
    const cab = this.cabin;
    this.attachPlayer();
    this._setMode('launch');
    sb.setDaylight(1);
    sb.focusSunShadow(new Vector3(0, 60, -10), 90);
    sb.closeout.root.visible = false;
    sb.ship.userData.nodes.hatch.rotation.y = 0;
    this.p = {
      lift: 0, roll: 0, pitch: 0, throttle: 0, arm: 0,
      gload: 1, vib: 0, earthAlt: 65e3, att: 0, sunPhase: 0,
      tankerX: -80, dockGap: 30, xfer: 0, tmi: 0, earthFar: 0,
      spin: 0, marsDist: 130e6, met: 0, metRate: 1, dose: 0.4, cum: 0.21,
      selfThrottle: 0, earthOut: 0,
    };
    sb.setLaunch(this.p);
    this.space.tanker.visible = false;

    cab.gravity.set(0, -G, 0);
    cab.vibration = 0;
    cab.setAlert(0);
    cab.setPlasma(0);
    cab.setPower(1);
    cab.shelterLight.intensity = 0;
    for (const c of Object.values(cab.controls)) {
      c.set(0);
      c.highlight = 0;
    }
    cab.crew.forEach((w, i) => {
      w.root.visible = true;
      w.root.position.set(CABIN.seats[i ? 3 : 1], 0, CABIN.seatZ);
      w.root.rotation.set(0, Math.PI, 0);
      w.action = 'seated';
    });
    cab.plush.pos.copy(cab.plush.anchor).add(new Vector3(0, -0.2, 0));
    cab.plush.vel.set(0, 0, 0);
    this._pages();

    post.toGrade('cabin', 0);
    post.grade.uLetterbox.value = 1;
    post.grade.uFade.value = 0;
    post.sun.intensity = 0.4;
    engine.camera.near = 0.04;
    engine.camera.updateProjectionMatrix();

    Object.assign(rig.dir, { x: CABIN.eye.x, y: CABIN.eye.y, z: CABIN.eye.z, yaw: 0, pitch: -0.06, roll: 0, fov: 52 });
    Object.assign(rig.feel, { breath: 1.25, handheld: 0.5, bob: 0, gravity: 1, float: 0 });
    Object.assign(rig.look, { weight: 0, yawLimit: 0.35, pitchLimit: 0.15 });
    rig.shake.rumble = 0;
    rig.shake.sway = 0;
    rig.onFootstep = null;

    hands.setSuit('iva');
    hands.R.snap(hands.sockets.restR, 'relaxed');
    hands.L.snap(hands.sockets.restL, 'relaxed');
    audio.silence(0.01);
    audio.setMuffle(0, 0.1);
  }

  // ------------------------------------------------------------------ timeline
  direct(s) {
    const { ctx } = this;
    const { hands, audio, rig, ui } = ctx;
    const cab = this.cabin;
    const sb = this.starbase;
    const P = this.p;
    const LD = (t, text, dur, id) => s.say(t, 'Launch Director — radio', text, dur, 'radio', id);
    const E = (t, text, dur, id) => s.say(t, 'Elon — radio', text, dur, 'radio', id);
    const applyLaunch = () => sb.setLaunch(P);

    // ================================================================ PAD
    s.fade(0.0, 1, 3.0, 'power1.inOut');
    s.bed(0.0, 'hum', 0.12, 2);
    s.bed(0.0, 'static', 0.035, 2);
    s.sfx(0.6, 'creak', { gain: 0.4, reverb: 0.4 });
    LD(0.6, 'Crew access arm retracting.', 2.6, 'vo_s3_01');
    s.call(0.8, () => (this.beat = 'pad'));
    s.tl.to(P, { arm: 1, duration: 7.5, ease: 'sine.inOut', onUpdate: applyLaunch }, 0.8);
    s.look(1.0, 1, { yaw: 0.4, pitch: 0.15 }, 2);
    E(3.8, 'This is the hard part. Strap in and let it happen.', 3.4, 'vo_s3_02');
    s.look(7.2, 0, {}, 0.6);
    s.cam(7.3, { pitch: -0.17 }, 1.6, 'sine.inOut');
    s.beat(7.8, {
      verb: 'Hold',
      label: 'Brace',
      duration: 1.0,
      auto: 5,
      onStart: () => {
        hands.R.reach(cab.sockets.railR, { dur: 0.75, pose: 'grip', arc: 0.04 });
        hands.L.reach(cab.sockets.railL, { dur: 0.85, pose: 'grip', arc: 0.04 });
      },
      onProgress: (k) => {
        if (k > 0.3 && hands.R.poseName !== 'brace') {
          hands.R.setPose('brace', 0.4);
          hands.L.setPose('brace', 0.45);
        }
      },
      onComplete: () => audio.sfx('creak', { gain: 0.3 }),
    });
    LD(8.4, 'All stations, go for launch.', 2.2, 'vo_s3_03');
    s.cam(8.6, { pitch: -0.05 }, 2.5, 'sine.inOut');

    // Countdown (subtitles + beeps; no quindar on every number)
    const T0 = 19.6;
    for (let i = 10; i >= 1; i--) {
      const t = T0 - i;
      s.call(t, () => {
        ui.say('Launch Director — radio', i === 3 ? 'Three … ignition sequence start.' : i === 10 ? 'T-minus ten' : `${i}`, 'radio');
        audio.sfx('beep', { gain: 0.08 });
      });
    }
    s.chord(T0 - 9, ['A1', 'E2', 'A2'], { gain: 0.1, attack: 9, release: 4, key: 's3pad', brightness: 700 });

    // Ignition at T−3: the plume lights the tower orange, the ship starts to shake.
    s.call(T0 - 3, () => {
      audio.bed('rumble', 0.5, 2.6);
      audio.bedParam('rumble', 'crackle', 0.35, 2);
      audio.bedParam('rumble', 'tone', 140, 0.5);
      audio.setMuffle(0.3, 1);
    });
    s.tl.to(P, { throttle: 1, duration: 2.8, ease: 'power2.in', onUpdate: applyLaunch }, T0 - 3);
    s.rumble(T0 - 3, 0.35, 2.8);
    s.to(T0 - 3, cab, { vibration: 0.25 }, 2.8);

    // ================================================================ ASCENT
    s.call(T0, () => {
      ui.say('Launch Director — radio', 'Liftoff.', 'radio');
      audio.sfx('boom', { gain: 0.9, reverb: 0.5 });
      audio.bed('rumble', 0.95, 1.2);
      audio.bedParam('rumble', 'crackle', 0.75, 1.5);
      this.beat = 'ascent';
    });
    s.call(T0 + 1.6, () => ui.clearSay());
    s.shake(T0, 0.55);
    s.rumble(T0, 0.85, 1.5);
    s.to(T0, cab, { vibration: 0.7 }, 1.5);
    s.to(T0, P, { gload: 1.45 }, 6);
    s.tl.to(P, { lift: 1700, duration: 17, ease: 'power3.in', onUpdate: applyLaunch }, T0);
    s.chord(T0, ['F2', 'C3', 'F3', 'A3', 'C4'], { gain: 0.15, attack: 5, release: 3, key: 's3lift', brightness: 1500 });
    s.stopChord(T0, 's3pad', 3);
    s.look(T0 + 0.5, 0.6, { yaw: 0.25, pitch: 0.1 }, 2);
    LD(T0 + 3.4, 'Tower cleared.', 1.8, 'vo_s3_04');
    s.tl.to(P, { roll: -1.35, duration: 6, ease: 'sine.inOut', onUpdate: applyLaunch }, T0 + 4.8);
    LD(T0 + 5.0, 'Roll program.', 1.6, 'vo_s3_05');
    s.shafts(T0 + 5.5, 1.3, 4);
    s.tl.to(P, { pitch: 0.32, duration: 9, ease: 'sine.inOut', onUpdate: applyLaunch }, T0 + 8.4);
    E(T0 + 9.4, 'Breathe. Let the ship do the work.', 2.8, 'vo_s3_06');
    LD(T0 + 13.6, 'Max-Q.', 1.2, 'vo_s3_07');
    s.shake(T0 + 13.6, 0.35);
    s.rumble(T0 + 12, 1.0, 2);

    // Smash cut to silence.
    const CUT1 = T0 + 15.4; // 35.0
    s.fade(CUT1, 0, 0);
    s.call(CUT1, () => {
      audio.silence(0.02);
      audio.setMuffle(0, 0.05);
      ui.clearSay();
      rig.shake.rumble = 0;
      cab.vibration = 0;
      this.ctx.music.s3lift?.stop(0.05);
      delete this.ctx.music.s3lift;
    });

    // ================================================================ STAGING (space, ~65 km)
    const ST = CUT1 + 1.2; // 36.2
    s.call(ST, () => {
      this._setMode('space');
      this.beat = 'staging';
      this._placeEarth(65e3);
      this.space.earth.group.visible = true;
      this.space.mars.group.visible = false;
      this.space.moon.group.visible = false;
      this.space.sky.uniforms.uStars.value = 0.15;
      this.space.setSun(new Vector3(-0.35, 0.75, -0.55));
      attitude(new Vector3(0, -0.15, -1), new Vector3(1, 0.35, 0), this.pose.quat);
      P.gload = 3.2;
      P.selfThrottle = 1;
      audio.bed('rumble', 0.7, 0.05);
      audio.bedParam('rumble', 'crackle', 0.5, 0.1);
      audio.setMuffle(0.35, 0.05);
      rig.shake.rumble = 0.6;
      cab.vibration = 0.5;
      ctx.post.sun.intensity = 0.5;
    });
    s.fade(ST, 1, 0.25);
    LD(ST + 0.2, 'MECO.', 1.0, 'vo_s3_08');
    s.call(ST + 0.3, () => {
      audio.bed('rumble', 0.08, 0.3);
      rig.shake.rumble = 0.05;
      P.gload = 0.05;
      P.selfThrottle = 0;
      cab.vibration = 0.05;
    });
    s.call(ST + 1.2, () => {
      audio.sfx('boom', { gain: 0.8, reverb: 0.4 });
      audio.sfx('jolt', { gain: 0.9 });
      audio.bed('rumble', 0.75, 0.15);
      audio.bedParam('rumble', 'tone', 230, 0.2);
      audio.bedParam('rumble', 'crackle', 0.2, 0.3);
      rig.addTrauma(0.85);
      rig.shake.rumble = 0.55;
      P.gload = 1.15;
      P.selfThrottle = 1;
      cab.vibration = 0.35;
    });
    s.flash(ST + 1.2, 0.45, 0.8, new Color(1.0, 0.55, 0.25));
    LD(ST + 1.5, 'Stage separation. Ship engines lit.', 2.4, 'vo_s3_09');
    E(ST + 3.3, 'That kick was the booster letting go. It’s already flying home.', 3.6, 'vo_s3_10');
    s.fade(ST + 7.2, 0, 0.5);

    // ================================================================ ORBIT (SECO, 210 km)
    const OR = ST + 7.8; // 44.0
    s.call(OR, () => {
      this.beat = 'orbit';
      this._placeEarth(210e3);
      this.space.sky.uniforms.uStars.value = 0.08;
      this.space.setSun(new Vector3(0.26, -0.215, -1));
      attitude(new Vector3(0, -0.26, -1), new Vector3(1, 0, 0), this.pose.quat);
      P.gload = 0;
      P.selfThrottle = 0;
      audio.bed('rumble', 0, 0.05);
      audio.setMuffle(0, 0.2);
      audio.bed('space', 0.22, 2);
      audio.bed('hum', 0.07, 2);
      rig.shake.rumble = 0;
      cab.vibration = 0;
      ctx.post.toGrade('space', 2.5);
      rig.feel.float = 0.4;
      rig.feel.breath = 0.9;
      rig.dir.y = CABIN.eye.y + 0.03;
    });
    s.fade(OR, 1, 2.6, 'power1.out');
    s.shafts(OR, 1.6, 2);
    LD(OR + 0.6, 'SECO. Nominal orbit.', 2.0, 'vo_s3_11');
    s.call(OR + 1.6, () => {
      hands.R.reach(hands.sockets.floatR, { dur: 2.6, pose: 'float', arc: 0.08 });
      hands.L.reach(hands.sockets.floatL, { dur: 2.9, pose: 'float', arc: 0.08 });
    });
    s.cam(OR + 1.2, { y: CABIN.eye.y + 0.07, pitch: 0.02 }, 7, 'sine.inOut');
    s.letterbox(OR + 2.0, 0, 6, 'sine.inOut');
    s.chord(OR + 1.5, ['C3', 'G3', 'D4', 'E4'], { gain: 0.13, attack: 5, release: 7, key: 's3orbit', brightness: 1800 });
    s.look(OR + 2.5, 1, { yaw: 0.5, pitch: 0.3 }, 2.5);
    E(OR + 3.0, 'Welcome to orbit. Take a second. Most people never get to see it.', 4.2, 'vo_s3_12');
    s.letterbox(OR + 8.4, 1, 4);
    s.look(OR + 8.4, 0.4, { yaw: 0.3, pitch: 0.15 }, 2);

    // ================================================================ TANKER
    const TK = OR + 9.0; // 53.0
    s.call(TK, () => {
      this.beat = 'tanker';
      this.space.tanker.visible = true;
    });
    s.to(TK, P, { tankerX: 75 }, 9.5, 'sine.inOut');
    LD(TK + 0.5, 'Tanker in sight. Forty meters.', 2.4, 'vo_s3_13');
    s.sfx(TK + 1.4, 'creak', { gain: 0.25, reverb: 0.3 });
    s.stopChord(TK + 2, 's3orbit', 8);
    E(TK + 4.4, 'This is the part nobody believed would work. Filling up in orbit.', 4.0, 'vo_s3_14');
    s.call(TK + 5.0, () => {
      this.beat = 'dock';
      P.dockGap = 30;
    });
    s.to(TK + 5.0, P, { dockGap: 1.2 }, 6.5, 'sine.out');
    s.look(TK + 5.0, 0, {}, 0.6);
    s.cam(TK + 5.2, { pitch: -0.5, yaw: 0.0 }, 2.0, 'sine.inOut');
    s.call(TK + 7.6, () => {
      hands.R.reach(cab.controls.xfer.socket('socket_tip_R'), { dur: 0.9, pose: 'point', arc: 0.05 });
      cab.controls.xfer.highlight = 1;
    });
    s.beat(TK + 8.6, {
      verb: 'Hold',
      label: 'Start propellant transfer',
      duration: 1.5,
      auto: 6,
      onProgress: (k) => cab.controls.xfer.set(k),
      onComplete: () => {
        cab.controls.xfer.highlight = 0;
        audio.sfx('switch', { gain: 0.5 });
        audio.sfx('guard', { gain: 0.3, delay: 0.15 });
        this.beat = 'xfer';
      },
    });
    s.sfx(TK + 9.0, 'hiss', { gain: 0.25 });
    s.call(TK + 9.2, () => hands.R.reach(hands.sockets.floatR, { dur: 1.4, pose: 'float', arc: 0.05 }));
    s.to(TK + 9.0, P, { xfer: 1 }, 7.5, 'sine.inOut');
    s.to(TK + 9.0, P, { sunPhase: 1 }, 7.5, 'sine.inOut');
    s.to(TK + 9.0, P, { metRate: 2400 }, 1.0, 'sine.in');
    s.cam(TK + 9.6, { pitch: -0.08 }, 3, 'sine.inOut');
    s.sfx(TK + 11.5, 'creak', { gain: 0.35, reverb: 0.4 });
    s.sfx(TK + 14.0, 'creak', { gain: 0.25, reverb: 0.4 });
    s.to(TK + 15.5, P, { metRate: 1 }, 1.0);
    LD(TK + 16.6, 'Transfer complete. Tanks full.', 2.2, 'vo_s3_15');

    // ================================================================ TMI
    const TM = TK + 18.6; // 71.6
    s.cam(TM - 1.0, { pitch: -0.52 }, 1.4, 'sine.inOut');
    s.call(TM - 0.6, () => {
      this.beat = 'tmiArm';
      hands.R.reach(cab.controls.commit.socket('socket_tip_R'), { dur: 0.8, pose: 'point', arc: 0.05 });
      cab.controls.commit.highlight = 1;
    });
    s.beat(TM, {
      mode: 'press',
      verb: 'Press',
      label: 'Commit to Mars',
      duration: 0.5,
      auto: 6,
      onProgress: (k) => cab.controls.commit.set(k),
      onComplete: () => {
        cab.controls.commit.highlight = 0;
        audio.sfx('confirm', { gain: 0.4 });
      },
    });
    s.call(TM + 0.8, () => {
      this.beat = 'tmi';
      audio.sfx('boom', { gain: 0.5, reverb: 0.6 });
      audio.bed('rumble', 0.5, 0.8);
      audio.bedParam('rumble', 'tone', 95, 0.5);
      audio.bedParam('rumble', 'crackle', 0.05, 0.5);
      audio.setMuffle(0.45, 0.5);
      rig.addTrauma(0.4);
      P.gload = 0.75;
      P.selfThrottle = 1;
      rig.feel.float = 0;
      hands.R.reach(cab.sockets.railR, { dur: 0.9, pose: 'brace', arc: 0.04 });
      hands.L.reach(cab.sockets.railL, { dur: 1.0, pose: 'brace', arc: 0.04 });
    });
    s.rumble(TM + 0.8, 0.3, 1);
    s.to(TM + 0.8, cab, { vibration: 0.25 }, 1);
    s.cam(TM + 1.0, { y: CABIN.eye.y, pitch: -0.04 }, 1.6, 'sine.inOut');
    s.to(TM + 1.0, P, { earthOut: 1 }, 9.5, 'power2.in');
    s.chord(TM + 1.0, ['D2', 'A2', 'D3', 'F#3', 'A3'], { gain: 0.14, attack: 4, release: 6, key: 's3tmi', brightness: 1400 });
    E(TM + 2.0, 'That’s it. Six months. Nothing left to do but get there.', 3.8, 'vo_s3_16');
    s.call(TM + 6.6, () => {
      audio.bed('rumble', 0, 1.2);
      audio.setMuffle(0, 1);
      P.gload = 0;
      P.selfThrottle = 0;
      rig.feel.float = 0.6;
    });
    s.rumble(TM + 6.6, 0, 1.2);
    s.to(TM + 6.6, cab, { vibration: 0 }, 1.2);
    s.stopChord(TM + 6.0, 's3tmi', 4);
    s.fade(TM + 7.0, 0, 1.0);

    // ================================================================ COAST (months)
    const CO = TM + 8.4; // 80.0
    s.call(CO, () => {
      this.beat = 'coast';
      this.space.tanker.visible = false;
      this.space.earth.group.visible = true;
      this.space.moon.group.visible = true;
      this.space.sky.uniforms.uStars.value = 1;
      this.space.setSun(new Vector3(0.85, 0.12, 0.5));
      P.spin = 0;
      P.met = 12 * 86400;
      P.metRate = 9 * 86400 / 10;
      cab.setPower(0.32);
      audio.bed('space', 0.3, 2);
      audio.bed('hum', 0.05, 2);
      audio.ticking(1.0, 0.22);
      ctx.post.toGrade('space', 0);
      ctx.post.sun.intensity = 1.3;
      Object.assign(rig.dir, { x: 0.32, y: 1.36, z: -2.78, yaw: 0.06, pitch: 0.02 });
      rig.cut();
      rig.feel.float = 1;
      hands.R.snap(hands.sockets.floatR, 'float');
      hands.L.snap(hands.sockets.floatL, 'float');
      const w = cab.crew[0];
      w.action = 'float';
      w.root.position.set(-1.45, 0.42, -3.0);
      w.root.rotation.set(0.1, Math.PI - 0.5, 0.15);
      cab.crew[1].root.visible = true;
    });
    s.fade(CO, 1, 2.2, 'power1.out');
    s.letterbox(CO, 0, 4.5);
    s.look(CO + 1.0, 1, { yaw: 0.55, pitch: 0.3 }, 2);
    E(CO + 2.2, 'By the time you hear this, it’s already four minutes old. That’s how far you are now.', 5.2, 'vo_s3_17');
    s.bed(CO + 2.0, 'static', 0.12, 0.5);
    s.bed(CO + 7.6, 'static', 0.03, 1);
    for (const [dt, n] of [[2.0, 'E4'], [4.6, 'B3'], [7.2, 'G#3'], [9.0, 'E3']]) s.call(CO + dt, () => audio.pluck(n, { gain: 0.08, decay: 5 }));

    // ================================================================ STORM
    const SP = CO + 9.6; // 89.6
    s.call(SP, () => {
      this.beat = 'storm';
      cab.setAlert(1);
      audio.ticking(0);
      this._alarm = audio.repeat('alarm', 1.15, { gain: 0.32 });
      P.metRate = 1;
    });
    s.letterbox(SP, 1, 1.0);
    s.look(SP, 0, {}, 0.5);
    LD(SP + 0.4, 'Solar particle event. Crew to the shelter. Shelter, shelter.', 3.0, 'vo_s3_18');
    s.cam(SP + 1.0, { yaw: Math.PI - 0.25, pitch: -0.05 }, 1.6, 'sine.inOut');
    s.shake(SP + 1.0, 0.15);
    s.fade(SP + 2.5, 0, 0.35);
    const SH = SP + 2.9; // 92.5
    s.call(SH, () => {
      this.beat = 'shelter';
      this._alarm?.stop();
      cab.setAlert(0.35);
      cab.setPower(0.1);
      cab.shelterLight.intensity = 2.4;
      Object.assign(rig.dir, { x: -0.02, y: 1.5, z: 0.16, yaw: Math.PI / 2, pitch: 0.18 });
      rig.cut();
      rig.feel.float = 0.5;
      rig.feel.breath = 1.6;
      const [a, b] = cab.crew;
      a.action = 'shelter';
      a.root.position.set(-0.5, 0.22, 0.36);
      a.root.rotation.set(0, Math.PI / 2 + 0.5, 0);
      b.action = 'shelter';
      b.root.position.set(0.18, 0.25, -0.58);
      b.root.rotation.set(0, Math.PI / 2 - 0.6, 0);
      hands.R.snap(cab.sockets.ringR, 'brace');
      hands.L.snap(cab.sockets.ringL, 'brace');
      audio.geiger(3);
      audio.bed('breath', 0.32, 0.6);
      audio.bed('space', 0.1, 1);
    });
    s.fade(SH, 1, 0.4);
    s.to(SH, P, { dose: 6.8 }, 3.5, 'sine.in');
    s.call(SH + 1.2, () => audio.geiger(16));
    LD(SH + 1.8, 'Peak flux passing. Hold position.', 2.4, 'vo_s3_19');
    s.to(SH + 4.0, P, { dose: 0.6 }, 3.0, 'sine.out');
    s.call(SH + 4.2, () => audio.geiger(4));
    s.call(SH + 6.0, () => audio.geiger(1));
    LD(SH + 6.2, 'All clear.', 1.6, 'vo_s3_20');
    s.fade(SH + 7.4, 0, 0.6);

    // ================================================================ MARS
    const MA = SH + 8.2; // 100.7
    s.call(MA, () => {
      this.beat = 'mars';
      audio.geiger(0);
      audio.bed('breath', 0, 1);
      audio.bed('space', 0.25, 2);
      cab.setAlert(0);
      cab.setPower(0.85);
      cab.shelterLight.intensity = 0;
      this.space.earth.group.visible = false;
      this.space.moon.group.visible = false;
      this.space.mars.group.visible = true;
      this.space.sky.uniforms.uStars.value = 0.25;
      this.space.setSun(new Vector3(0.72, 0.28, 0.62));
      this.pose.quat.identity();
      P.marsDist = 140e6;
      P.met = 181 * 86400;
      P.metRate = 86400 * 2;
      Object.assign(rig.dir, { x: 0.0, y: 1.42, z: -3.86, yaw: 0.02, pitch: 0.02 });
      rig.cut();
      rig.feel.float = 0.9;
      rig.feel.breath = 1.0;
      hands.R.snap(hands.sockets.floatR, 'float');
      hands.L.snap(hands.sockets.floatL, 'float');
      const [a, b] = cab.crew;
      a.action = 'float';
      a.root.position.set(-1.5, 0.4, -3.2);
      a.root.rotation.set(0, Math.PI - 0.55, 0.1);
      b.root.visible = false;
      ctx.post.sun.intensity = 0.6;
    });
    s.fade(MA, 1, 2.0, 'power1.out');
    s.letterbox(MA + 0.5, 0, 5);
    s.to(MA, P, { marsDist: 13.5e6 }, 11, 'sine.inOut');
    s.chord(MA + 0.6, ['F2', 'C3', 'A3', 'E4', 'G4'], { gain: 0.15, attack: 5, release: 8, key: 's3mars', brightness: 1700 });
    s.call(MA + 1.6, () => hands.R.reach(cab.sockets.window3, { dur: 1.8, pose: 'flat', arc: 0.06 }));
    s.look(MA + 1.0, 1, { yaw: 0.45, pitch: 0.3 }, 2);
    E(MA + 3.2, 'There it is.', 1.8, 'vo_s3_21');
    E(MA + 5.8, 'Arcadia Planitia. There’s ice just under the dust. That’s why we’re landing there.', 5.0, 'vo_s3_22');
    LD(MA + 11.4, 'Entry interface in ten minutes. Crew, take your seats.', 3.0, 'vo_s3_23');
    s.stopChord(MA + 11.0, 's3mars', 5);
    s.letterbox(MA + 11.6, 1, 2.5);
    s.fade(MA + 13.2, 0, 1.6);
    s.bed(MA + 13.2, 'space', 0, 1.5);
    s.bed(MA + 13.2, 'hum', 0, 1.5);
    s.call(MA + 15.2, () => {});
  }

  exit() {
    const { audio, rig } = this.ctx;
    this._alarm?.stop();
    audio.geiger(0);
    audio.ticking(0);
    audio.setMuffle(0, 0.2);
    rig.shake.rumble = 0;
    rig.feel.float = 0;
    this.cabin.setAlert(0);
    this.cabin.setPlasma(0);
    const sb = this.starbase;
    sb.closeout.root.visible = true;
    sb.setLaunch({ lift: 0, roll: 0, pitch: 0, throttle: 0, arm: 0 });
  }

  // ------------------------------------------------------------------ helpers
  _placeEarth(alt) {
    this.space.earth.place(new Vector3(0, -(R_EARTH + alt), 0), 0.6);
    this.p.earthAlt = alt;
  }

  /** Far-camera sync: shipPose · deck · eye. Also points the cabin's sun. */
  sync(camera) {
    const far = this.farCamera;
    if (this.mode === 'launch') {
      this.starbase.ship.updateWorldMatrix(true, false);
      _ship.copy(this.starbase.ship.matrixWorld);
    } else {
      _ship.compose(this.pose.pos, this.pose.quat, ONE);
    }
    _m.multiplyMatrices(_ship, _deck).multiply(camera.matrixWorld);
    _m.decompose(far.position, far.quaternion, _s);
    far.updateMatrixWorld(true);
    // Sun into cabin space.
    _ship.decompose(_p, _q, _s);
    const sunW = this.mode === 'launch' ? this.starbase.sky.uniforms.uSunDir.value : this.space.sunDir;
    this.sunCabin.copy(sunW).applyQuaternion(_q.invert());
    let irr;
    if (this.mode === 'launch') irr = 4.2 * smoothstep(-0.03, 0.05, sunW.y);
    else irr = 6.5 * this.space.sunlightAt(this.pose.pos);
    if (this.beat === 'shelter') irr = 0;
    this.cabin.setSun(this.sunCabin, irr);
    this.ctx.post.sun.dir.copy(sunW);
  }

  update(dt, t) {
    const P = this.p;
    const cab = this.cabin;
    const sp = this.space;
    if (this.mode === 'launch') {
      this.starbase.update(dt, t);
    } else {
      this._updateSpace(dt, t);
    }
    // Felt acceleration in the cabin frame: thrust is along ship +Y.
    cab.gravity.set(0, -G * P.gload, 0);
    if (this.mode === 'launch' && P.lift <= 0.01) cab.gravity.set(0, -G, 0);
    P.met += dt * P.metRate;
    this._updateFeed();
    cab.update(dt, t);
    if (this.mode !== 'launch') sp.update(dt, t, this.farCamera);
  }

  _updateSpace(dt, t) {
    const P = this.p;
    const sp = this.space;
    const b = this.beat;
    if (b === 'orbit' || b === 'tanker' || b === 'dock' || b === 'xfer' || b === 'tmiArm') {
      // Orbit sunset time-lapse during the transfer: the sun sinks behind the limb.
      const a = new Vector3(0.26, -0.215, -1).normalize();
      const c = new Vector3(0.3, -0.85, 0.42).normalize();
      sp.setSun(a.clone().lerp(c, smoothstep(0, 1, P.sunPhase)).normalize());
      sp.sky.uniforms.uStars.value = lerp(0.08, 0.9, smoothstep(0.55, 1, P.sunPhase));
    }
    if (b === 'tanker' || b === 'dock' || b === 'xfer' || b === 'tmiArm') {
      // Flyby across the windows, then (feed only) the aft-to-aft docking.
      const tk = sp.tanker;
      if (b === 'tanker') {
        _m.compose(new Vector3(P.tankerX, 6, -46), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.08), ONE);
      } else {
        _m.compose(new Vector3(0.0, -P.dockGap - 1.6, 0), new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI), ONE);
      }
      _ship.compose(this.pose.pos, this.pose.quat, ONE);
      tk.matrix.multiplyMatrices(_ship, _m);
      tk.matrix.decompose(tk.position, tk.quaternion, tk.scale);
      tk.updateMatrixWorld(true);
      const rcs = b === 'dock' ? (Math.sin(t * 3.1) > 0.85 ? 1 : 0) : 0;
      for (const p of sp.tankerRcs) p.userData.uniforms.uThrottle.value = rcs * 0.6;
    }
    if (b === 'tmi') {
      const k = P.earthOut;
      this._placeEarth(lerp(210e3, 26000e3, k * k));
      attitude(new Vector3(0, lerp(-0.26, 0.5, smoothstep(0, 0.8, k)), -1), new Vector3(1, 0, 0), this.pose.quat);
      sp.sky.uniforms.uStars.value = lerp(0.9, 1, k);
    }
    if (b === 'coast') {
      // Barbecue roll (time-lapse): the ship turns about its long axis, the
      // sun's beam sweeps the cabin once per turn; Earth and Moon recede.
      P.spin += dt * ((Math.PI * 2) / 11);
      this.pose.quat.setFromAxisAngle(new Vector3(0, 1, 0), P.spin);
      const d = 4.4e9;
      const dir = new Vector3(-0.2, 0.04, -1).normalize();
      sp.earth.place(dir.clone().multiplyScalar(d), 0.6);
      sp.moon.place(dir.clone().multiplyScalar(d).add(new Vector3(3.2e8, 0.4e8, 0)), 0);
    }
    if (b === 'mars' || b === 'storm' || b === 'shelter') {
      const dir = new Vector3(0.04, 0.02, -1).normalize();
      sp.mars.place(dir.multiplyScalar(P.marsDist), 2.1);
    }
    for (const p of this.selfPlumes) {
      p.userData.uniforms.uThrottle.value = P.selfThrottle;
      p.userData.uniforms.uTime.value = t;
    }
    this.selfShip.position.copy(this.pose.pos);
    this.selfShip.quaternion.copy(this.pose.quat);
    this.selfShip.updateMatrixWorld(true);
  }

  /** Aft camera: on the leeward skirt, looking back along the hull. */
  _updateFeed() {
    const main = this.cabin.monitors.main;
    const b = this.beat;
    const wantFeed = b === 'pad' || b === 'ascent' || b === 'dock' || b === 'xfer' || b === 'staging' || b === 'tmi';
    if (!wantFeed) {
      if (main.feed) main.clearFeed();
      return;
    }
    if (this.mode === 'launch') _ship.copy(this.starbase.ship.matrixWorld);
    else _ship.compose(this.pose.pos, this.pose.quat, ONE);
    _m.compose(new Vector3(0, 4.0, -5.0), quatFromDirUp(new Vector3(0, -1, -0.1), new Vector3(0, 0, -1)), ONE);
    _m.premultiply(_ship);
    _m.decompose(this.feedCam.position, this.feedCam.quaternion, _s);
    this.feedCam.updateMatrixWorld(true);
    const scene = this.mode === 'launch' ? this.starbase.scene : this.space.scene;
    if (!main.feed || main.feed.scene !== scene) main.setFeed(scene, this.feedCam, this.ctx.engine.quality.feedSize, 2);
  }

  // ------------------------------------------------------------------ monitor pages
  _pages() {
    const P = this.p;
    const main = this.cabin.monitors.main;
    const self = this;
    main.state.render = (g, w, h, t, u) => {
      const b = self.beat;
      const clock = b === 'coast' || b === 'storm' || b === 'shelter' || b === 'mars' ? met(P.met) : self._clock();
      if (b === 'pad' || b === 'ascent' || b === 'staging') return ascentPage(g, w, h, u, P, b, clock);
      if (b === 'orbit' || b === 'tanker') return orbitPage(g, w, h, u, clock, b);
      if (b === 'dock') return dockPage(g, w, h, u, P, clock);
      if (b === 'xfer' || b === 'tmiArm') return xferPage(g, w, h, u, P, clock, b);
      if (b === 'tmi') return tmiPage(g, w, h, u, P, clock);
      if (b === 'coast') return coastPage(g, w, h, u, P, clock);
      if (b === 'storm' || b === 'shelter') return spePage(g, w, h, u, clock, t);
      if (b === 'mars') return approachPage(g, w, h, u, P, clock);
      return null;
    };
    // The main page draws its own frame; disable the idle chrome for it.
    main.draw = (g, w, h, t, s) => {
      const u = h / 360;
      s.render(g, w, h, t, u);
    };
    this.cabin.monitors.dose.state = {
      get rate() {
        return P.dose;
      },
      get cum() {
        return 0.21 + Math.max(0, P.dose - 0.4) * 0.6;
      },
      get shelter() {
        return self.beat === 'shelter';
      },
      clock: '',
    };
    for (const k of ['nav', 'systems', 'comms']) {
      const m = this.cabin.monitors[k];
      Object.defineProperty(m.state, 'clock', { get: () => self._clock(), configurable: true });
    }
  }

  _clock() {
    const b = this.beat;
    const time = this.ctx.director ? this.ctx.director.time : 0;
    if (b === 'pad') return `T-00:00:${String(Math.max(0, Math.ceil(19.6 - time))).padStart(2, '0')}`;
    if (b === 'ascent') return met(time - 19.6);
    if (b === 'staging') return met(158 + (time - 36.2));
    if (b === 'orbit' || b === 'tanker') return met(512 + (time - 44));
    return met(this.p.met);
  }
}

// ==================================================================== pages

function ascentPage(g, w, h, u, P, beat, clock) {
  // Transparent over the aft camera feed.
  pageFrame(g, w, h, beat === 'pad' ? 'PRELAUNCH · CAM 4 AFT' : 'ASCENT · CAM 4 AFT', { clock, bg: false });
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.fillRect(0, 0, w, 34 * u);
  const altKm = beat === 'staging' ? 67.4 : P.lift / 1000;
  const vel = beat === 'staging' ? 5600 : Math.sqrt(2 * 5.2 * Math.max(0, P.lift)) * 3.6;
  g.fillStyle = 'rgba(0,0,0,0.45)';
  g.fillRect(0, h - 70 * u, w, 70 * u);
  label(g, 16 * u, h - 50 * u, `ALT ${altKm.toFixed(1)} km`, { size: 15, u });
  label(g, 16 * u, h - 24 * u, `VEL ${Math.round(vel).toLocaleString('en-US')} km/h`, { size: 15, u });
  // Engine status: Super Heavy's 33 (3 / 10 / 20), then the ship's 6.
  const cx = w - 70 * u;
  const cy = h - 110 * u;
  const dot = (x, y, on) => {
    g.beginPath();
    g.arc(x, y, 4.2 * u, 0, Math.PI * 2);
    g.fillStyle = on ? INK.ok : 'rgba(120,130,135,0.5)';
    g.fill();
  };
  const lit = P.throttle > 0.5;
  if (beat !== 'staging') {
    for (const [n, r] of [[3, 7], [10, 22], [20, 40]]) {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + 0.2;
        dot(cx + Math.cos(a) * r * u, cy + Math.sin(a) * r * u, lit);
      }
    }
    label(g, cx, cy + 56 * u, 'BOOSTER  33', { size: 11, u, align: 'center', color: INK.dim });
  } else {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      dot(cx + Math.cos(a) * (i % 2 ? 26 : 12) * u, cy + Math.sin(a) * (i % 2 ? 26 : 12) * u, true);
    }
    label(g, cx, cy + 56 * u, 'SHIP  3 SL · 3 VAC', { size: 11, u, align: 'center', color: INK.dim });
  }
}

function orbitPage(g, w, h, u, clock, beat) {
  pageFrame(g, w, h, 'ORBIT', { clock, page: 'P2' });
  label(g, 16 * u, 64 * u, '212 × 208 km   INC 26.4°', { size: 16, u, weight: 500 });
  label(g, 16 * u, 92 * u, 'V 7.79 km/s   PERIOD 88.6 min', { size: 13, u, color: INK.dim });
  // Ground track
  g.strokeStyle = INK.line;
  g.strokeRect(16 * u, 112 * u, w - 32 * u, 170 * u);
  g.strokeStyle = INK.accent;
  g.lineWidth = 2;
  g.beginPath();
  for (let i = 0; i <= 100; i++) {
    const x = 16 * u + (i / 100) * (w - 32 * u);
    const y = 197 * u - Math.sin((i / 100) * Math.PI * 2 + 0.6) * 60 * u;
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  }
  g.stroke();
  label(g, 16 * u, 310 * u, beat === 'tanker' ? 'TANKER  T-7   RANGE 41 m   ↓ 0.2 m/s' : 'NEXT  TANKER RENDEZVOUS', { size: 13, u, color: beat === 'tanker' ? INK.warn : INK.dim });
}

function dockPage(g, w, h, u, P, clock) {
  pageFrame(g, w, h, 'DOCKING · CAM 4 AFT', { clock, bg: false });
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.fillRect(0, 0, w, 34 * u);
  g.strokeStyle = 'rgba(255,200,120,0.7)';
  g.lineWidth = 1.5 * u;
  const cx = w / 2;
  const cy = h / 2 + 10 * u;
  g.beginPath();
  g.moveTo(cx - 30 * u, cy);
  g.lineTo(cx - 8 * u, cy);
  g.moveTo(cx + 8 * u, cy);
  g.lineTo(cx + 30 * u, cy);
  g.moveTo(cx, cy - 30 * u);
  g.lineTo(cx, cy - 8 * u);
  g.moveTo(cx, cy + 8 * u);
  g.lineTo(cx, cy + 30 * u);
  g.stroke();
  g.fillStyle = 'rgba(0,0,0,0.45)';
  g.fillRect(0, h - 44 * u, w, 44 * u);
  label(g, 16 * u, h - 22 * u, `RANGE ${P.dockGap.toFixed(1)} m   RATE −${(0.04 + P.dockGap * 0.012).toFixed(2)} m/s`, { size: 14, u, color: INK.warn });
}

function xferPage(g, w, h, u, P, clock, beat) {
  pageFrame(g, w, h, 'PROPELLANT TRANSFER', { clock, page: 'P4' });
  const k = P.xfer;
  label(g, 16 * u, 66 * u, 'LOX', { size: 14, u });
  bar(g, 80 * u, 58 * u, w - 200 * u, 16 * u, 0.12 + k * 0.88, INK.accent);
  label(g, w - 16 * u, 66 * u, `${Math.round((0.12 + k * 0.88) * 100)}%`, { size: 14, u, align: 'right' });
  label(g, 16 * u, 100 * u, 'CH4', { size: 14, u });
  bar(g, 80 * u, 92 * u, w - 200 * u, 16 * u, 0.1 + k * 0.9, 'rgba(150,200,255,0.9)');
  label(g, w - 16 * u, 100 * u, `${Math.round((0.1 + k * 0.9) * 100)}%`, { size: 14, u, align: 'right' });
  const samples = [];
  for (let i = 0; i <= 40; i++) {
    const x = i / 40;
    samples.push(x <= k ? 0.75 + 0.1 * Math.sin(x * 30) - (x > 0.85 ? (x - 0.85) * 4 : 0) : 0);
  }
  trace(g, 16 * u, 130 * u, w - 32 * u, 140 * u, samples);
  label(g, 16 * u, 300 * u, 'SETTLING THRUST 0.0003 g   SUBCOOLED', { size: 12, u, color: INK.dim });
  label(g, 16 * u, 326 * u, beat === 'tmiArm' ? 'TMI  ARMED · CONFIRM COMMIT' : k >= 1 ? 'COMPLETE' : 'FLOWING', { size: 13, u, color: beat === 'tmiArm' ? INK.warn : k >= 1 ? INK.ok : INK.text });
}

function tmiPage(g, w, h, u, P, clock) {
  pageFrame(g, w, h, 'TRANS-MARS INJECTION', { clock, bg: false });
  g.fillStyle = 'rgba(0,0,0,0.45)';
  g.fillRect(0, h - 70 * u, w, 70 * u);
  const dv = Math.min(3.61, P.earthOut * 3.61 * 1.4);
  label(g, 16 * u, h - 50 * u, `Δv ${dv.toFixed(2)} / 3.61 km/s`, { size: 15, u });
  bar(g, 16 * u, h - 30 * u, w - 32 * u, 10 * u, dv / 3.61, INK.accent);
}

function coastPage(g, w, h, u, P, clock) {
  pageFrame(g, w, h, 'CRUISE', { clock, page: 'P6' });
  const day = P.met / 86400;
  const earthDist = 1.2 + day * 0.42; // M km, illustrative
  const lt = (earthDist * 1e9) / 299792458;
  label(g, 16 * u, 64 * u, `EARTH ${earthDist.toFixed(1)} M km`, { size: 15, u });
  label(g, 16 * u, 90 * u, `LIGHT TIME ${Math.floor(lt / 60)} min ${String(Math.floor(lt % 60)).padStart(2, '0')} s`, { size: 15, u, color: INK.accent });
  // Transfer orbit sketch: Sun, Earth orbit, Mars orbit, the ship.
  const cx = w * 0.62;
  const cy = h * 0.62;
  g.strokeStyle = INK.line;
  g.lineWidth = 1.5;
  g.beginPath();
  g.arc(cx, cy, 70 * u, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.arc(cx, cy, 108 * u, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = INK.warn;
  g.beginPath();
  g.arc(cx, cy, 5 * u, 0, Math.PI * 2);
  g.fill();
  const f = clamp(day / 180, 0, 1);
  const a = Math.PI * f;
  const r = (70 + 38 * f) * u;
  g.strokeStyle = INK.accent;
  g.setLineDash([4, 4]);
  g.beginPath();
  g.arc(cx, cy, 89 * u, Math.PI, Math.PI * 2);
  g.stroke();
  g.setLineDash([]);
  g.fillStyle = INK.text;
  g.beginPath();
  g.arc(cx + Math.cos(Math.PI + a) * r, cy + Math.sin(Math.PI + a) * r, 4 * u, 0, Math.PI * 2);
  g.fill();
}

function spePage(g, w, h, u, clock, t) {
  pageFrame(g, w, h, 'SPE WARNING', { clock });
  const on = Math.sin(t * 7.5) > 0;
  g.fillStyle = on ? 'rgba(255,60,40,0.25)' : 'rgba(255,60,40,0.08)';
  g.fillRect(0, 36 * u, w, h - 36 * u);
  label(g, w / 2, 130 * u, 'SOLAR PARTICLE EVENT', { size: 24, u, align: 'center', color: INK.alert, weight: 500 });
  label(g, w / 2, 176 * u, 'PROTON FLUX >10 MeV  ↑↑', { size: 15, u, align: 'center' });
  label(g, w / 2, 220 * u, 'ALL CREW · STORM SHELTER', { size: 15, u, align: 'center', color: INK.warn });
}

function approachPage(g, w, h, u, P, clock) {
  pageFrame(g, w, h, 'MARS APPROACH', { clock, page: 'P7' });
  const alt = (P.marsDist - PLANET.mars.radius) / 1000;
  label(g, 16 * u, 66 * u, `MARS ${Math.round(alt).toLocaleString('en-US')} km`, { size: 16, u, weight: 500 });
  label(g, 16 * u, 94 * u, 'V∞ 3.2 km/s   ENTRY ≈ 7.5 km/s', { size: 13, u, color: INK.dim });
  label(g, 16 * u, 130 * u, 'TARGET  ARCADIA PLANITIA  ~40°N', { size: 14, u, color: INK.accent });
  label(g, 16 * u, 160 * u, 'MODE   AEROCAPTURE · DIRECT ENTRY', { size: 13, u, color: INK.dim });
}

