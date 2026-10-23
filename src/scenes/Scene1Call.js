import { Matrix4, Vector3 } from 'three';
import { SceneBase } from './SceneBase.js';
import { buildPhone } from '../procedural/phone.js';
import { LAYOUT } from '../procedural/starbase.js';
import { pitchTo, yawTo } from '../core/math.js';

/**
 * SCENE 1 — THE CALL  (~80 s)
 *
 * Blue hour at the crew staging area, ~165 m from the pad. We open tight and
 * letterboxed on a phone in the player's gloved hands: a short film about
 * reusable rockets and Starlink. The call comes. On "Look up." the phone
 * drops out of frame, the bars retract to full height (the IMAX moment) and the
 * frame tilts up the floodlit, frosted, venting stack — 124 m of steel.
 */
export class Scene1Call extends SceneBase {
  constructor(ctx, starbase) {
    super(ctx, 'I · The Call');
    this.starbase = starbase;
  }

  async build() {
    this.near = this.starbase.scene;
    this.phone = buildPhone();
    this.screen = this.phone.userData.screen;
    this.phoneHome = new Vector3(0, -0.058, -0.37);
  }

  enter() {
    const { rig, hands, audio, post, engine } = this.ctx;
    const sb = this.starbase;
    this.attachPlayer();
    sb.setDaylight(0);
    sb.setLaunch({ lift: 0, roll: 0, pitch: 0, throttle: 0, arm: 0 });
    sb.closeout.root.visible = true;
    post.toGrade('starbaseDawn', 0);
    post.sun.intensity = 0;
    post.grade.uLetterbox.value = 1;
    post.grade.uFade.value = 0;
    engine.camera.near = 0.05;
    engine.camera.updateProjectionMatrix();

    // Body-held phone, angled to the eye.
    rig.body.add(this.phone);
    this.phone.position.copy(this.phoneHome);
    this._aimPhone();
    this.phone.visible = true;
    this.phoneDrop = 0;
    this.screen.set('video');
    this.screen.callT = 0;
    this.ringing = null;

    const p = LAYOUT.playerStart;
    const stack = new Vector3(0, 60, 0);
    Object.assign(rig.dir, { x: p.x, y: p.y, z: p.z, yaw: yawTo(p, stack) + 0.05, pitch: -0.26, roll: 0, fov: 50 });
    Object.assign(rig.feel, { breath: 1, handheld: 1, bob: 1, gravity: 1, float: 0 });
    Object.assign(rig.look, { weight: 0, yawLimit: 0.12, pitchLimit: 0.08 });
    rig.shake.rumble = 0;
    rig.onFootstep = (side, m) => audio.sfx('foot_concrete', { gain: 0.35 * m, pan: side === 'left' ? -0.15 : 0.15 });

    hands.setSuit('iva');
    hands.R.snap(this.phone.userData.sockets.gripR, 'phone');
    hands.L.snap(this.phone.userData.sockets.gripL, 'phone');
    for (const w of sb.workers) if (w.opts.seed === 6) w.action = 'point';

    audio.silence(0.01);
    audio.setMuffle(0, 0.1);
  }

  _aimPhone() {
    // +Z of the phone toward the eye (body origin), slight roll toward the right hand.
    const m = new Matrix4().lookAt(new Vector3(0, 0.0, 0.02), this.phone.position, new Vector3(0, 1, 0));
    this.phone.quaternion.setFromRotationMatrix(m);
  }

  direct(s) {
    const { ctx } = this;
    const { hands, audio, ui } = ctx;
    const sb = this.starbase;
    const sock = this.phone.userData.sockets;
    const p = LAYOUT.playerStart;
    const stackTop = new Vector3(0, 128, 0);

    // ------------------------------------------------ 0:00  open on the phone
    s.fade(0, 1, 3.5, 'power1.inOut');
    s.bed(0.1, 'wind', 0.32, 3);
    s.bed(0.1, 'chatter', 0.22, 4);
    s.bed(0.1, 'hum', 0.07, 4);
    s.look(2, 1, { yaw: 0.14, pitch: 0.08 }, 3);
    s.chord(1.5, ['A1', 'E2'], { gain: 0.08, attack: 8, release: 6, key: 's1drone', brightness: 900 });

    // ------------------------------------------------ 0:28  the call
    s.call(28.4, () => {
      this.screen.set('ring');
      this.ringing = audio.repeat('ring', 1.55, { gain: 0.32 });
    });
    s.look(28.4, 0, {}, 1.2);
    s.beat(30.2, {
      mode: 'press',
      verb: 'Press',
      label: 'Answer',
      duration: 0.55,
      auto: 6,
      onStart: () => hands.R.reach(sock.tapR, { dur: 0.45, pose: 'phone', arc: 0.004 }),
      onProgress: (k) => {
        if (k > 0.05 && hands.R.poseName !== 'phoneTap') hands.R.setPose('phoneTap', 0.22);
      },
      onComplete: () => {
        this.ringing?.stop();
        audio.sfx('answer', { gain: 0.4 });
        this.screen.set('call');
        hands.R.setPose('phone', 0.3, 0.15);
        hands.R.reach(sock.gripR, { dur: 0.5, pose: 'phone', arc: 0.004 });
      },
    });

    // ------------------------------------------------ the monologue (phone)
    const E = (t, text, dur, id) => s.say(t, 'Elon — call', text, dur, 'phone', id);
    E(31.0, 'Hey. You watched the whole thing? Good.', 3.0, 'vo_s1_01');
    E(34.4, 'For sixty years every rocket flew once. Imagine throwing away a 747 after every flight.', 5.2, 'vo_s1_02');
    E(40.0, 'So we made them land. Then we made them fly again. That’s the only reason any of this is possible.', 5.6, 'vo_s1_03');
    E(46.0, 'Starlink was the same idea. Make space ordinary — useful, and cheap enough to matter.', 5.2, 'vo_s1_04');
    s.look(41, 1, { yaw: 0.22, pitch: 0.12 }, 3);

    // ------------------------------------------------ 0:51  "Look up."  — the IMAX reveal
    E(51.6, 'Look up.', 1.8, 'vo_s1_05');
    s.look(51.4, 0, {}, 0.8);
    s.to(52.0, this, { phoneDrop: 1 }, 2.6, 'power2.inOut');
    s.call(53.6, () => {
      hands.R.rest(1.2);
      hands.L.rest(1.3);
    });
    s.cam(52.2, { pitch: pitchTo(p, stackTop) * 0.82, yaw: yawTo(p, stackTop) - 0.02, fov: 48 }, 7.5, 'sine.inOut');
    s.letterbox(52.4, 0, 5.5, 'sine.inOut');
    s.chord(52.4, ['A2', 'E3', 'A3', 'C4', 'E4'], { gain: 0.16, attack: 4.5, release: 9, key: 's1reveal' });
    s.stopChord(52.4, 's1drone', 4);
    s.look(58, 1, { yaw: 0.55, pitch: 0.3 }, 3);

    E(59.0, 'A hundred and twenty-four meters. Every piece of it is meant to come back and fly again.', 5.0, 'vo_s1_06');
    E(64.6, 'Life on one planet is fragile. Life on two… that’s a future worth getting up for.', 5.4, 'vo_s1_07');
    E(70.6, 'You’re the first one through the door. No pressure.', 3.4, 'vo_s1_08');
    E(74.6, 'They’re ready for you. I’ll be on the radio.', 3.2, 'vo_s1_09');
    s.call(78.0, () => audio.sfx('hangup', { gain: 0.25 }));
    s.stopChord(76, 's1reveal', 7);

    // ------------------------------------------------ 1:18  walk toward the pad, cut
    s.look(77.5, 0.4, { yaw: 0.3, pitch: 0.15 }, 1.5);
    s.call(77.8, () => {
      for (const w of sb.workers) if (w.opts.seed === 6) w.action = 'wave';
    });
    const walkTo = new Vector3(-104.5, LAYOUT.playerStart.y, 99);
    s.cam(78.0, { yaw: yawTo(p, new Vector3(0, 0, -24)) + 0.12, pitch: 0.05 }, 3.4, 'sine.inOut');
    s.cam(78.6, { x: walkTo.x, z: walkTo.z }, 5.5, 'power1.inOut');
    s.letterbox(80.5, 1, 2.5);
    s.fade(82.6, 0, 1.6, 'power2.in');
    s.bed(82.6, 'wind', 0, 1.5);
    s.bed(82.6, 'chatter', 0, 1.2);
    s.bed(82.6, 'hum', 0, 1.2);
    s.sfx(84.0, 'elevator', { gain: 0.5 });
    s.call(84.2, () => ui.clearSay());
    s.call(86.0, () => {});
  }

  update(dt, t) {
    this.starbase.update(dt, t);
    const talking = this.ctx.ui.subLine.classList.contains('is-on');
    this.screen.update(dt, talking);
    // Phone: lowered on "Look up.", buzzing while it rings.
    const d = this.phoneDrop || 0;
    this.phone.position.set(this.phoneHome.x + d * 0.03, this.phoneHome.y - d * 0.36, this.phoneHome.z + d * 0.1);
    if (this.screen.state === 'ring') {
      const buzz = Math.sin(t * 45) * (Math.sin(t * 6.5) > 0 ? 0.0012 : 0);
      this.phone.position.x += buzz;
    }
    this._aimPhone();
    this.phone.rotateX(d * 0.9);
    this.phone.visible = d < 0.98;
  }

  exit() {
    this.ringing?.stop();
    this.phone.removeFromParent();
    this.ctx.rig.onFootstep = null;
  }
}
