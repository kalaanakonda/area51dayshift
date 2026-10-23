import { Euler, Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import { ARM_DIMS, applyPose, buildProceduralArm, quatFromDirUp } from './handModel.js';
import { blendPose, clonePose, POSES } from './poses.js';

const _m = new Matrix4();
const _inv = new Matrix4();
const _p = new Vector3();
const _q = new Quaternion();
const _s = new Vector3();
const _d = new Vector3();
const _e = new Vector3();
const _pole = new Vector3();
const _back = new Vector3();
const _qa = new Quaternion();
const _qb = new Quaternion();

/** Which marker on the hand touches the socket for each grip type. */
const CONTACT_FOR = {
  grip: 'palm',
  rail: 'palm',
  brace: 'palm',
  flat: 'palm',
  fist: 'palm',
  phone: 'palm',
  phoneTap: 'palm',
  relaxed: 'palm',
  float: 'palm',
  point: 'indexTip',
  pinch: 'pinch',
};

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smooth = (t) => t * t * (3 - 2 * t);

/**
 * One arm: two-bone IK from a fixed shoulder (in the player's body frame) to a
 * wrist derived from whatever "socket" it is attached to.
 *
 *  • A socket is any Object3D: a lever grip, a rail point, a phone edge, or a
 *    body-space rest pose. The arm reads it every frame, so if the lever moves,
 *    the hand moves with it — the player feels the mechanism.
 *  • reach() blends from the current hand pose to the socket along a slight
 *    arc (hands never travel in straight lines), finger pose blends in late
 *    so the grip closes as contact happens.
 */
class Arm {
  constructor(hands, side) {
    this.hands = hands;
    this.side = side;
    this.s = side === 'R' ? 1 : -1;
    this.shoulder = new Vector3(0.185 * this.s, -0.24, 0.07);
    this.poleHint = new Vector3(0.85 * this.s, -1.0, 0.45).normalize();
    this.socket = null;
    this.contact = 'palm';
    this.poseName = 'relaxed';
    this.pose = clonePose(POSES.relaxed);
    this.poseFrom = clonePose(POSES.relaxed);
    this.poseTo = POSES.relaxed;
    this.poseT = 1;
    this.poseDur = 0.3;
    this.poseDelay = 0;
    this.trans = { t: 1, dur: 0.5, arc: 0, fromPos: new Vector3(), fromQuat: new Quaternion(), ease: easeInOut };
    this.cur = { pos: new Vector3(), quat: new Quaternion() };
    this.offsets = new Map();
    this.visible = true;
    this.hideWhenRested = true;
  }

  attachModel(model) {
    this.model = model;
    this.bones = model.bones;
    this.markers = model.markers;
    this.mirror = model.mirror;
    this.hands.rig.body.add(model.root);
    this._computeContactOffsets();
  }

  _computeContactOffsets() {
    const hand = this.bones.hand;
    const keep = clonePose(this.pose);
    for (const [name, pose] of Object.entries(POSES)) {
      applyPose(this.bones, pose, this.mirror);
      this.model.root.updateMatrixWorld(true);
      _inv.copy(hand.matrixWorld).invert();
      const get = (marker) => new Vector3().setFromMatrixPosition(marker.matrixWorld).applyMatrix4(_inv);
      this.offsets.set(`palm:${name}`, get(this.markers.palm));
      this.offsets.set(`indexTip:${name}`, get(this.markers.indexTip));
      this.offsets.set(`thumbTip:${name}`, get(this.markers.thumbTip));
      this.offsets.set(`pinch:${name}`, get(this.markers.indexTip).add(get(this.markers.thumbTip)).multiplyScalar(0.5));
    }
    applyPose(this.bones, keep, this.mirror);
  }

  /** Move the hand to `socket` (Object3D). opts: { dur, pose, contact, arc, poseAt, poseDur } */
  reach(socket, { dur = 0.8, pose, contact, arc = 0.05, poseAt = 0.55, poseDur } = {}) {
    if (!socket) return this;
    this.trans.fromPos.copy(this.cur.pos);
    this.trans.fromQuat.copy(this.cur.quat);
    this.trans.t = dur <= 0 ? 1 : 0;
    this.trans.dur = Math.max(0.001, dur);
    this.trans.arc = arc;
    this.socket = socket;
    const p = pose || this.poseName;
    this.contact = contact || CONTACT_FOR[p] || 'palm';
    this.setPose(p, poseDur ?? Math.max(0.15, dur * 0.45), dur * poseAt);
    this.visible = true;
    return this;
  }

  /** Snap to a socket instantly (cuts). */
  snap(socket, pose) {
    return this.reach(socket, { dur: 0, pose, poseDur: 0.001, poseAt: 0 });
  }

  setPose(name, dur = 0.3, delay = 0) {
    const target = this.hands.poseLibrary[name] || POSES[name];
    if (!target) return this;
    this.poseFrom = clonePose(this.pose);
    this.poseTo = target;
    this.poseName = name;
    this.poseT = 0;
    this.poseDur = Math.max(0.001, dur);
    this.poseDelay = delay;
    return this;
  }

  rest(dur = 0.9) {
    return this.reach(this.hands.sockets[`rest${this.side}`], { dur, pose: 'relaxed', arc: 0.02 });
  }

  ready(dur = 0.8) {
    return this.reach(this.hands.sockets[`ready${this.side}`], { dur, pose: 'relaxed', arc: 0.03 });
  }

  _target(outPos, outQuat) {
    const sock = this.socket;
    const body = this.hands.rig.body;
    sock.updateWorldMatrix(true, false);
    _inv.copy(body.matrixWorld).invert();
    _m.multiplyMatrices(_inv, sock.matrixWorld);
    _m.decompose(outPos, outQuat, _s);
    const off = this.offsets.get(`${this.contact}:${this.poseName}`) || ARM_DIMS.palmCenter;
    _p.copy(off).applyQuaternion(outQuat);
    outPos.sub(_p);
  }

  update(dt) {
    // Finger pose blend
    if (this.poseT < 1) {
      if (this.poseDelay > 0) this.poseDelay -= dt;
      else {
        this.poseT = Math.min(1, this.poseT + dt / this.poseDur);
        blendPose(this.pose, this.poseFrom, this.poseTo, smooth(this.poseT));
      }
    }
    applyPose(this.bones, this.pose, this.mirror);
    if (!this.socket) return;

    const tPos = _tp;
    const tQuat = _tq;
    this._target(tPos, tQuat);
    const tr = this.trans;
    if (tr.t < 1) {
      tr.t = Math.min(1, tr.t + dt / tr.dur);
      const k = tr.ease(tr.t);
      this.cur.pos.lerpVectors(tr.fromPos, tPos, k);
      // Arc: lift toward body-up and slightly toward the body midline.
      const lift = Math.sin(Math.PI * k) * tr.arc;
      this.cur.pos.y += lift;
      this.cur.pos.z += lift * 0.4;
      this.cur.quat.slerpQuaternions(tr.fromQuat, tQuat, k);
    } else {
      this.cur.pos.copy(tPos);
      this.cur.quat.copy(tQuat);
    }
    this._solve(this.cur.pos, this.cur.quat);
    const atRest = this.socket === this.hands.sockets[`rest${this.side}`] && tr.t >= 1;
    this.model.root.visible = this.visible && this.hands.visible && !(atRest && this.hideWhenRested);
  }

  _solve(W, qH) {
    const { upperarm, forearm, hand } = this.bones;
    const L1 = this.hands.dims.upperArm;
    const L2 = this.hands.dims.forearm;
    const S = _s.copy(this.shoulder);
    _d.subVectors(W, S);
    let dist = _d.length();
    const maxReach = L1 + L2 - 0.003;
    if (dist > maxReach) {
      // Lean: let the shoulder travel toward the target (up to 22 cm).
      const lean = Math.min(0.22, dist - maxReach);
      S.addScaledVector(_d.normalize(), lean);
      _d.subVectors(W, S);
      dist = _d.length();
    }
    dist = Math.min(Math.max(dist, 0.06), maxReach);
    _d.normalize();
    const a = (L1 * L1 - L2 * L2 + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    _pole.copy(this.poleHint).addScaledVector(_d, -this.poleHint.dot(_d));
    if (_pole.lengthSq() < 1e-6) _pole.set(0, -1, 0);
    _pole.normalize();
    _e.copy(S).addScaledVector(_d, a).addScaledVector(_pole, h);

    _back.set(0, 1, 0).applyQuaternion(qH);
    const wrist = _p.copy(S).addScaledVector(_d, dist);
    const qU = quatFromDirUp(_e.clone().sub(S), _back, _qa);
    const qF = quatFromDirUp(wrist.clone().sub(_e), _back, _qb);

    this.model.root.position.copy(S);
    this.model.root.quaternion.identity();
    upperarm.quaternion.copy(qU);
    forearm.quaternion.copy(qU).invert().multiply(qF);
    hand.quaternion.copy(qF).invert().multiply(qH);
  }
}

const _tp = new Vector3();
const _tq = new Quaternion();

/**
 * HandRig — both arms + shared sockets + pose library.
 * Exposes `hands.R`, `hands.L` and a few two-handed helpers.
 */
export class HandRig {
  constructor(ctx) {
    this.ctx = ctx;
    this.rig = ctx.rig;
    this.visible = true;
    this.dims = { ...ARM_DIMS };
    this.poseLibrary = { ...POSES };
    this.sockets = {};
    this.suit = 'iva';
  }

  async build(assets) {
    const body = this.rig.body;
    // Body-space sockets. Rest = below the frame; ready = low in frame, palms in.
    const mk = (name, pos, euler) => {
      const o = new Object3D();
      o.name = name;
      o.position.fromArray(pos);
      o.rotation.copy(new Euler(...euler, 'YXZ'));
      body.add(o);
      this.sockets[name] = o;
      return o;
    };
    mk('restR', [0.22, -0.66, -0.12], [0.2, -1.25, -0.5]);
    mk('restL', [-0.22, -0.66, -0.12], [-0.2, -1.25, 0.5]);
    mk('readyR', [0.17, -0.34, -0.38], [0.15, -0.3, -0.55]);
    mk('readyL', [-0.17, -0.34, -0.38], [-0.15, -0.3, 0.55]);
    mk('floatR', [0.2, -0.28, -0.42], [0.1, 0.05, -0.35]);
    mk('floatL', [-0.2, -0.28, -0.42], [-0.1, 0.05, 0.35]);

    this.models = {
      iva: { R: buildProceduralArm('R', 'iva', this.dims), L: buildProceduralArm('L', 'iva', this.dims) },
      eva: { R: buildProceduralArm('R', 'eva', this.dims), L: buildProceduralArm('L', 'eva', this.dims) },
    };
    this.R = new Arm(this, 'R');
    this.L = new Arm(this, 'L');
    this.R.attachModel(this.models.iva.R);
    this.L.attachModel(this.models.iva.L);
    this.models.eva.R.root.visible = false;
    this.models.eva.L.root.visible = false;
    this.R.snap(this.sockets.restR, 'relaxed');
    this.L.snap(this.sockets.restL, 'relaxed');
    this.gltf = assets ? assets.gltf('fp_hands_iva') : null;
    if (this.gltf) console.info('[hands] fp_hands_iva.glb found — retargeting enabled (procedural arms become the IK proxy).');
  }

  /** Swap glove set (Scene 5 puts the EVA suit on). Keeps current sockets/poses. */
  setSuit(suit) {
    if (suit === this.suit) return;
    for (const side of ['R', 'L']) {
      const arm = this[side];
      const old = arm.model;
      old.root.visible = false;
      arm.model = this.models[suit][side];
      arm.bones = arm.model.bones;
      arm.markers = arm.model.markers;
      if (!arm.model.root.parent) this.rig.body.add(arm.model.root);
      if (!arm.offsetsBySuit) arm.offsetsBySuit = {};
      arm._computeContactOffsets();
    }
    this.suit = suit;
  }

  /** Re-parent the body (with arms) into a new scene. */
  attachTo(scene) {
    scene.add(this.rig.body);
  }

  setVisible(v) {
    this.visible = v;
  }

  both(fn) {
    fn(this.R);
    fn(this.L);
    return this;
  }

  update(dt) {
    if (!this.R) return;
    this.R.update(dt);
    this.L.update(dt);
  }
}
