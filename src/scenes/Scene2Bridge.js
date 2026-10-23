import { Object3D, Vector3 } from 'three';
import { SceneBase } from './SceneBase.js';
import { LAYOUT } from '../procedural/starbase.js';
import { Dial, Lever } from '../interaction/controls.js';
import { quatFromDirUp } from '../player/handModel.js';

/**
 * SCENE 2 — THE BRIDGE  (~60 s)
 *
 * 126 m up the tower, the sun just off the Gulf. The crew access arm is a
 * 13.5 m grated walkway to a 9 m wall of stainless steel. Scale is sold only
 * through head movement: a slow turn into the sunrise (god rays through the
 * lattice), a look straight down the drop, a long tilt up the hull to the
 * forward flap. The right hand slides along the rail, then works the latch
 * lever and the equalisation dial. The close-out crew opens the hatch.
 */
export class Scene2Bridge extends SceneBase {
  constructor(ctx, starbase) {
    super(ctx, 'II · The Bridge');
    this.starbase = starbase;
  }

  async build() {
    this.near = this.starbase.scene;
    const arm = this.starbase.arm;
    const { roomStart } = arm.userData;
    // Controls on the latch panel (panel faces the walkway from the right side).
    const panel = arm.userData.panel;
    panel.position.x = -(arm.userData.width / 2 - 0.35);
    panel.rotation.y = Math.PI / 2;
    this.lever = new Lever({ label: 'ARM LATCH' });
    this.lever.root.position.set(-0.11, 1.03, 0.1);
    this.lever.root.rotation.x = Math.PI / 2 - 0.25; // base mounted on the panel face, lever pulls toward the walkway
    panel.add(this.lever.root);
    // A short 80° sweep: a pinching wrist can follow it without contorting.
    this.dial = new Dial({ sweep: 1.4, detents: 4, labels: ['SEAL', 'EQ'] });
    this.dial.root.position.set(0.13, 1.16, 0.092);
    panel.add(this.dial.root);

    // Moving rail socket for the right hand (rail on the player's right = −X).
    this.railSocket = new Object3D();
    this.railSocket.name = 'socket_grip_R_rail';
    this.starbase.scene.add(this.railSocket);
    this.railX = -(arm.userData.width / 2) + 0.06;
    this.railY = LAYOUT.armY + 1.08 + 0.045;
    this.railSocket.quaternion.copy(quatFromDirUp(new Vector3(-0.55, -0.75, 0.25), new Vector3(0.75, 0.6, 0.1)));

    // Palms flat on the front faces of the white-room seal bars (x = ±0.64),
    // fingers up and splayed outward — bracing to duck through the hatch.
    const zSeal = LAYOUT.towerFaceZ + arm.userData.length - 0.28;
    this.frameR = new Object3D();
    this.frameR.position.set(-0.64, LAYOUT.armY + 1.32, zSeal - 0.01);
    this.frameR.quaternion.copy(quatFromDirUp(new Vector3(-0.25, 1, 0), new Vector3(0, 0, -1)));
    this.frameL = new Object3D();
    this.frameL.position.set(0.64, LAYOUT.armY + 1.32, zSeal - 0.01);
    this.frameL.quaternion.copy(quatFromDirUp(new Vector3(0.25, 1, 0), new Vector3(0, 0, -1)));
    this.starbase.scene.add(this.frameR, this.frameL);
    this.zSeal = zSeal;
    this.roomStart = roomStart;
  }

  enter() {
    const { rig, hands, audio, post, engine } = this.ctx;
    const sb = this.starbase;
    this.attachPlayer();
    sb.setDaylight(1);
    sb.setLaunch({ lift: 0, roll: 0, pitch: 0, throttle: 0, arm: 0 });
    sb.closeout.root.visible = true;
    sb.focusSunShadow(new Vector3(0, LAYOUT.armY, -11), 34);
    post.toGrade('gantrySunrise', 0);
    post.grade.uLetterbox.value = 1;
    post.grade.uFade.value = 0;
    post.sun.dir.copy(sb.sky.uniforms.uSunDir.value);
    post.sun.intensity = 0.0;
    engine.camera.near = 0.05;
    engine.camera.updateProjectionMatrix();

    this.lever.set(0);
    this.dial.set(0);
    this.lever.highlight = 0;
    this.dial.highlight = 0;
    this.hatchOpen = 0;
    this.railFollow = true;
    sb.ship.userData.nodes.hatch.rotation.y = 0;
    sb.closeout.action = 'idle';

    Object.assign(rig.dir, { x: -0.55, y: LAYOUT.armY + 1.68, z: LAYOUT.towerFaceZ - 0.6, yaw: Math.PI + 0.04, pitch: -0.04, roll: 0, fov: 50 });
    Object.assign(rig.feel, { breath: 1.1, handheld: 1.2, bob: 1, gravity: 1, float: 0 });
    Object.assign(rig.look, { weight: 0, yawLimit: 0.3, pitchLimit: 0.25 });
    rig.shake.rumble = 0;
    rig.shake.sway = 0.08;
    rig.onFootstep = (side, m) => audio.sfx('foot_metal', { gain: 0.4 * m, pan: side === 'left' ? -0.2 : 0.2, reverb: 0.15 });

    hands.setSuit('iva');
    hands.R.snap(hands.sockets.restR, 'relaxed');
    hands.L.snap(hands.sockets.restL, 'relaxed');
    audio.silence(0.01);
  }

  direct(s) {
    const { ctx } = this;
    const { hands, audio, rig } = ctx;
    const sb = this.starbase;
    const zPanel = LAYOUT.towerFaceZ + this.starbase.arm.userData.panel.position.z;

    const E = (t, text, dur, id) => s.say(t, 'Elon — radio', text, dur, 'radio', id);

    // ------------------------------------------------ 0:00 doors open on the drop
    s.sfx(0.0, 'clunk', { gain: 0.5, reverb: 0.3 });
    s.fade(0.2, 1, 1.4, 'power2.out');
    s.bed(0.0, 'wind', 0.75, 1.2);
    s.bedParam(0.0, 'wind', 'intensity', 1.0, 2);
    s.bed(0.0, 'static', 0.06, 2);
    s.bed(0.0, 'chatter', 0.08, 3);
    s.shafts(0.5, 0.9, 6);
    s.look(1.5, 1, { yaw: 0.3, pitch: 0.2 }, 3);
    E(1.2, 'Take your time up there. The ship’s not going anywhere without you.', 4.2, 'vo_s2_01');

    // Walk (right hand finds the rail)
    s.call(2.2, () => hands.R.reach(this.railSocket, { dur: 1.1, pose: 'rail', arc: 0.08 }));
    s.cam(2.4, { z: LAYOUT.towerFaceZ + 3.6 }, 6.5, 'power1.inOut');

    // ------------------------------------------------ 0:06 into the sunrise
    s.look(5.6, 0, {}, 1);
    s.cam(5.8, { yaw: Math.PI + 1.05, pitch: 0.04 }, 5.5, 'sine.inOut');
    s.shafts(6.0, 1.6, 4);
    s.chord(6.5, ['F2', 'C3', 'A3', 'E4'], { gain: 0.11, attack: 6, release: 8, key: 's2a', brightness: 1600 });
    E(7.0, 'Stainless steel. People laughed. It’s strong when it’s cold, strong when it’s hot. It’s just the right answer.', 6.0, 'vo_s2_02');
    s.look(9, 1, { yaw: 0.35, pitch: 0.2 }, 2);

    // ------------------------------------------------ 0:14 the drop
    s.look(13.6, 0, {}, 1);
    s.cam(14.0, { yaw: Math.PI + 0.42, pitch: -1.02, fov: 44 }, 4.5, 'sine.inOut');
    s.shake(15.2, 0.32);
    s.bed(15.2, 'wind', 1.0, 0.6);
    s.sway(15.2, 0.25, 1);
    s.sway(18.5, 0.08, 2);
    s.bed(18.0, 'wind', 0.75, 2);
    E(16.0, 'Okay — you can look down. It’s a good view.', 3.2, 'vo_s2_03');
    s.look(17.5, 0.8, { yaw: 0.3, pitch: 0.2 }, 1.5);

    // ------------------------------------------------ 0:21 up the hull — IMAX
    s.look(20.5, 0, {}, 1);
    s.cam(21.0, { yaw: Math.PI - 0.32, pitch: 1.05, fov: 50 }, 6.5, 'sine.inOut');
    s.letterbox(21.2, 0, 5);
    s.chord(21.5, ['F2', 'C3', 'F3', 'A3', 'C4', 'G4'], { gain: 0.15, attack: 5, release: 9, key: 's2b' });
    s.stopChord(21.5, 's2a', 5);
    E(23.0, 'Eighteen thousand tiles on the belly. Every one of them is a reason the ship gets there in one piece.', 5.8, 'vo_s2_04');
    s.look(27.5, 1, { yaw: 0.4, pitch: 0.25 }, 2);

    // ------------------------------------------------ 0:31 to the latch panel
    s.look(31.0, 0, {}, 1);
    s.cam(31.2, { yaw: Math.PI + 0.02, pitch: -0.08 }, 2.6, 'sine.inOut');
    s.cam(31.6, { z: zPanel + 0.05, x: -0.32 }, 4.8, 'power1.inOut');
    s.letterbox(32.0, 1, 4);
    s.call(35.4, () => {
      this.railFollow = false;
      hands.R.ready(0.6);
    });
    s.cam(35.8, { yaw: Math.PI / 2 + 0.06, pitch: -0.68 }, 1.8, 'sine.inOut');
    s.call(36.6, () => {
      hands.R.reach(this.lever.socket('socket_grip_R'), { dur: 0.9, pose: 'grip', arc: 0.06 });
      this.lever.highlight = 1;
    });

    s.beat(37.8, {
      verb: 'Hold',
      label: 'Pull the arm latch',
      duration: 1.6,
      auto: 7,
      onProgress: (p) => {
        this.lever.set(p);
        rig.shake.rumble = p * 0.05;
      },
      onComplete: () => {
        this.lever.highlight = 0;
        rig.shake.rumble = 0;
        rig.addTrauma(0.3);
        audio.sfx('latch', { gain: 0.7, reverb: 0.4 });
        audio.sfx('lever', { gain: 0.35 });
      },
    });
    s.say(38.2, 'Pad lead — radio', 'Arm’s latched. Equalize the hatch.', 2.8, 'radio', 'vo_s2_05');
    s.call(38.4, () => {
      hands.R.reach(this.dial.socket('socket_pinch_R'), { dur: 0.8, pose: 'pinch', arc: 0.04 });
      this.dial.highlight = 1;
      this.dial.onDetent = () => audio.sfx('dial', { gain: 0.35 });
    });
    s.beat(39.6, {
      verb: 'Hold',
      label: 'Turn to equalize',
      duration: 2.0,
      auto: 7,
      onStart: () => audio.sfx('hiss', { gain: 0.25 }),
      onProgress: (p) => this.dial.set(p),
      onComplete: () => {
        this.dial.highlight = 0;
        audio.sfx('confirm', { gain: 0.3 });
      },
    });

    // ------------------------------------------------ 0:42 hatch opens
    s.call(40.0, () => hands.R.rest(1.0));
    s.cam(40.2, { yaw: Math.PI + 0.02, pitch: -0.02 }, 2.2, 'sine.inOut');
    s.call(40.6, () => (sb.closeout.action = 'work'));
    s.sfx(41.4, 'clunk', { gain: 0.6, reverb: 0.4 });
    s.to(41.6, this, { hatchOpen: 1 }, 3.2, 'power2.inOut');
    s.sfx(41.8, 'hiss', { gain: 0.3 });
    s.call(43.5, () => (sb.closeout.action = 'gestureIn'));
    s.stopChord(42, 's2b', 6);
    E(43.6, 'This is the part I’d want to remember. Go on in.', 3.6, 'vo_s2_06');

    // ------------------------------------------------ 0:46 through the door
    // Walk to arm's length of the seal, brace on it, pull through into the light.
    s.cam(46.0, { z: this.zSeal - 0.52, x: 0.0 }, 3.6, 'power1.inOut');
    s.cam(46.0, { pitch: 0.0 }, 3, 'sine.inOut');
    s.call(48.9, () => {
      hands.R.reach(this.frameR, { dur: 0.8, pose: 'flat', arc: 0.05 });
      hands.L.reach(this.frameL, { dur: 0.9, pose: 'flat', arc: 0.05 });
    });
    s.cam(50.2, { z: this.zSeal + 0.16, pitch: -0.1 }, 2.0, 'power2.in');
    s.fade(51.2, 0, 1.0, 'power2.in');
    s.sfx(52.3, 'thud', { gain: 0.7, reverb: 0.5 });
    s.bed(51.6, 'wind', 0, 0.5);
    s.bed(51.6, 'static', 0, 0.5);
    s.bed(51.6, 'chatter', 0, 0.5);
    s.shafts(51, 0, 1);
    s.call(54.0, () => {});
  }

  update(dt, t) {
    this.starbase.update(dt, t);
    this.lever.update(dt, t);
    this.dial.update(dt, t);
    const { rig } = this.ctx;
    if (this.railFollow) {
      // Rail point just ahead of the shoulder: the glove slides as we walk.
      const z = Math.min(rig.dir.z + 0.32, LAYOUT.towerFaceZ + this.roomStart - 0.2);
      this.railSocket.position.set(this.railX, this.railY, z);
    }
    const hinge = this.starbase.ship.userData.nodes.hatch;
    // 1.62 rad: the door ends just inside the seal bar, clear of the right glove.
    if (hinge) hinge.rotation.y = (this.hatchOpen || 0) * 1.62;
    this.ctx.post.sun.dir.copy(this.starbase.sky.uniforms.uSunDir.value);
  }

  exit() {
    this.ctx.rig.onFootstep = null;
    this.ctx.rig.shake.sway = 0;
  }
}

