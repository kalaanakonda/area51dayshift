import { Color, Group, LatheGeometry, MathUtils, Matrix4, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, Quaternion, Vector2, Vector3 } from 'three';
import { PAD, PILOT } from './Cockpit.js';
import { leatherTextures, twillTextures } from '../textures.js';
import { PilotBody } from './PilotBody.js';
import { gloveTextures } from './gloveTexture.js';
import { fitGauntlet, gauntletMesh, sampleCover } from './gauntlet.js';

/**
 * The pilot's hands — rigged 25-joint hands (WebXR hand-tracking rig, or any
 * Blender/BlendKit export using the same joint names) resting on the pads.
 *
 *   turn / strafe LEFT   → the LEFT hand presses, rolls and slides outward
 *   turn / strafe RIGHT  → the RIGHT hand does
 *   forward / back       → both hands slide and flatten / curl
 *   climb                → fingers lift off the glass; descend presses both
 *   boost                → fingers spread and press hard
 *   warp                 → both palms flat and hard down, fingers wide, a tremor
 *
 * The rig is flat (every joint a child of the armature), so finger poses are
 * forward-kinematics computed here from the rest pose, then written straight
 * into the bones. Fingertips are kept on the glass by measuring them after FK.
 */
const FINGERS = {
  thumb: ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
  index: ['index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip'],
  middle: ['middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip'],
  ring: ['ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip'],
  pinky: ['pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip'],
};
// Relaxed "resting on glass" pose: flex per joint (rad) from the metacarpal on, and spread.
const REST = {
  thumb: { flex: [0.12, 0.18, 0.16], spread: 0.0 },
  index: { flex: [0.0, 0.16, 0.28, 0.16], spread: 0.06 },
  middle: { flex: [0.0, 0.17, 0.3, 0.17], spread: 0.0 },
  ring: { flex: [0.0, 0.19, 0.32, 0.18], spread: -0.06 },
  pinky: { flex: [0.0, 0.21, 0.34, 0.18], spread: -0.13 },
};

const HAND_SCALE = 1.12;

const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const _q = new Quaternion();
const _q2 = new Quaternion();
const _v = new Vector3();
const _m = new Matrix4();

function damp(a, b, l, dt) {
  return a + (b - a) * (1 - Math.exp(-l * dt));
}

class Hand {
  constructor(side, gltf, gloveMat) {
    this.side = side;
    this.s = side === 'left' ? -1 : 1; // −1 left, +1 right (cockpit X)
    this.root = new Group(); // pad frame + steering offsets
    this.root.name = `hand_${side}`;
    this.model = gltf.scene;
    this.root.add(this.model);
    this.bones = {};
    this.rest = {};
    this.model.traverse((o) => {
      if (o.isBone || o.type === 'Bone' || /finger|thumb|wrist/.test(o.name)) {
        this.bones[o.name] = o;
        this.rest[o.name] = { p: o.position.clone(), q: o.quaternion.clone() };
      }
      if (o.isSkinnedMesh) {
        o.frustumCulled = false;
        o.castShadow = true;
        o.receiveShadow = true;
        o.material = gloveMat;
        this.mesh = o;
      }
    });
    // Model space: fingers −Y, palm normal +X (left) / −X (right), thumb −Z.
    const basis = side === 'left' ? [new Vector3(0, -1, 0), new Vector3(0, 0, 1), new Vector3(-1, 0, 0)] : [new Vector3(0, 1, 0), new Vector3(0, 0, 1), new Vector3(1, 0, 0)];
    this.base = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(...basis));
    // Palm centre between wrist and knuckles (model space).
    const w = this.rest.wrist?.p || new Vector3();
    const k = new Vector3();
    for (const f of ['index', 'middle', 'ring', 'pinky']) k.add(this.rest[FINGERS[f][1]].p);
    k.multiplyScalar(0.25);
    this.palm = new Vector3().lerpVectors(w, k, 0.62);
    // The tracking rig is a bare 17 cm hand; a flight glove on an adult reads ~12% bigger.
    this.scale = HAND_SCALE;
    this.model.scale.setScalar(this.scale);
    this.model.position.copy(this.palm).multiplyScalar(-this.scale).applyQuaternion(this.base);
    this.model.quaternion.copy(this.base);
    // live state
    this.st = { press: 0, lift: 0, slide: 0, push: 0, roll: 0, yaw: 0, spread: 0, h: 0.03, tap: 0, tapFinger: 'index' };
    this.posed = {};
    this.tipNames = ['thumb-tip', 'index-finger-tip', 'middle-finger-tip', 'ring-finger-tip', 'pinky-finger-tip'];
    this.wristLocal = new Vector3();
  }

  /** FK for every finger from rest + flex/spread, written to the bones. */
  pose(extraFlex, spreadMul, lift, tap) {
    const R = this.rest;
    for (const [name, chain] of Object.entries(FINGERS)) {
      const def = REST[name];
      let pQ = R[chain[0]].q.clone();
      let pP = R[chain[0]].p.clone();
      const flexes = def.flex;
      // metacarpal (thumb CMC) may flex too
      const f0 = (flexes[0] + (name === 'thumb' ? extraFlex * 0.4 : 0)) ;
      if (f0) pQ.multiply(_q.setFromAxisAngle(X, -f0));
      this._write(chain[0], pP, pQ);
      for (let i = 1; i < chain.length; i++) {
        const prev = R[chain[i - 1]];
        const cur = R[chain[i]];
        const invPrev = _q2.copy(prev.q).invert();
        const off = _v.copy(cur.p).sub(prev.p).applyQuaternion(invPrev);
        const rel = invPrev.clone().multiply(cur.q);
        const P = pP.clone().add(off.applyQuaternion(pQ));
        const Q = pQ.clone().multiply(rel);
        if (i < chain.length - 1) {
          let f = flexes[i] ?? 0;
          if (name !== 'thumb' || i > 0) f += extraFlex * (i === 1 ? 0.9 : i === 2 ? 0.7 : 0.45);
          if (i === 1 && name !== 'thumb') {
            f -= lift * 0.2; // fingers lift off the glass at the knuckles
            if (tap.finger === name) f -= tap.amount * 0.5;
            Q.multiply(_q.setFromAxisAngle(Y, def.spread * spreadMul * -this.s));
          }
          Q.multiply(_q.setFromAxisAngle(X, -f));
        }
        this._write(chain[i], P, Q);
        pP = P;
        pQ = Q;
      }
    }
  }

  _write(name, p, q) {
    const b = this.bones[name];
    if (!b) return;
    b.position.copy(p);
    b.quaternion.copy(q);
    (this.posed[name] ||= { p: new Vector3() }).p.copy(p);
  }

  /** Lowest fingertip height (model → root frame, along root +Y). */
  lowestTip() {
    let min = Infinity;
    const qm = this.model.quaternion;
    for (const n of this.tipNames) {
      const p = this.posed[n];
      if (!p) continue;
      _v.copy(p.p).multiplyScalar(this.scale).applyQuaternion(qm).add(this.model.position);
      if (_v.y < min) min = _v.y;
    }
    return min;
  }
}

export class PilotHands {
  constructor(assets) {
    this.assets = assets;
    this.group = new Group();
    this.group.name = 'pilot-hands';
    this.hands = {};
    this.ready = false;
    this._t = 0;
    const leather = leatherTextures();
    leather.normalMap.repeat.set(5, 5);
    leather.roughnessMap.repeat.set(5, 5);
    this.glove = new MeshPhysicalMaterial({
      name: 'flight_glove',
      color: new Color(0.045, 0.043, 0.042),
      roughness: 0.62,
      roughnessMap: leather.roughnessMap,
      normalMap: leather.normalMap,
      normalScale: new Vector2(0.55, 0.55),
      metalness: 0,
      sheen: 0.35,
      sheenRoughness: 0.6,
      sheenColor: new Color(0.25, 0.24, 0.22),
      clearcoat: 0.08,
      clearcoatRoughness: 0.5,
    });
    const twill = twillTextures();
    twill.normalMap.repeat.set(3, 6);
    this.sleeveMat = new MeshStandardMaterial({
      name: 'flight_suit',
      color: new Color(0.15, 0.18, 0.13),
      roughness: 0.86,
      normalMap: twill.normalMap,
      normalScale: new Vector2(0.7, 0.7),
      metalness: 0,
    });
    // Nomex gauntlet, same sage as the glove backs
    this.cuffMat = new MeshStandardMaterial({ name: 'glove_cuff', color: 0x5c5f4c, roughness: 0.9, metalness: 0, normalMap: twill.normalMap, normalScale: new Vector2(0.8, 0.8) });
    this.input = { lateral: 0, forward: 0, vertical: 0, boost: 0, power: 0, warp: 0 };
    // the rest of you: a seated Rocketbox body whose arms reach for the gloves
    this.body = new PilotBody(assets);
    this.group.add(this.body.root, this.body.harness);
    this.nextTap = 2.5;
    this.materials = [this.glove, this.sleeveMat, this.cuffMat];
  }

  async load() {
    const [L, R, body] = await Promise.all([this.assets.gltf('handLeft'), this.assets.gltf('handRight'), this.body.load().catch((e) => (console.warn('[pilot] body', e), false))]);
    if (!L || !R) return false;
    if (body) this.materials.push(...this.body.materials);
    for (const [side, g] of [['left', L], ['right', R]]) {
      const h = new Hand(side, g, this.glove);
      // painted into the hand's own UV layout: seams, stitching, knuckle pads, creases, worn tips
      const t = gloveTextures(h.mesh, side === 'left' ? 1 : -1);
      h.mesh.material = new MeshStandardMaterial({
        name: `flight_glove_${side}`,
        map: t.map,
        normalMap: t.normalMap,
        normalScale: new Vector2(0.9, 0.9),
        roughnessMap: t.roughnessMap,
        roughness: 1,
        metalness: 0,
        envMapIntensity: 0.55,
      });
      this.materials.push(h.mesh.material);
      this.group.add(h.root);
      h.arm = this._buildArm(side);
      this.hands[side] = h;
    }
    this.ready = true;
    this.update(0.016);
    return true;
  }

  _buildArm(side) {
    // Forearm sleeve: lathe along +Y from wrist (y=0) to elbow (y=1), scaled per frame.
    const forearmPts = [];
    for (let i = 0; i <= 18; i++) {
      const k = i / 18;
      const r = MathUtils.lerp(0.04, 0.055, k) + Math.sin(k * 23 + (side === 'left' ? 0 : 1)) * 0.0022 * Math.sin(k * Math.PI);
      forearmPts.push(new Vector2(r, k));
    }
    const forearm = new Mesh(new LatheGeometry(forearmPts, 28), this.sleeveMat);
    const upperPts = [];
    for (let i = 0; i <= 12; i++) {
      const k = i / 12;
      upperPts.push(new Vector2(MathUtils.lerp(0.056, 0.068, k) + Math.sin(k * 17) * 0.002, k));
    }
    const upper = new Mesh(new LatheGeometry(upperPts, 24), this.sleeveMat);
    // Glove gauntlet over the wrist, flaring over the sleeve end (which tucks under it).
    const cuffPts = [new Vector2(0.033, -0.04), new Vector2(0.038, -0.015), new Vector2(0.044, 0.02), new Vector2(0.05, 0.062), new Vector2(0.052, 0.078), new Vector2(0.047, 0.084)];
    const cuff = new Mesh(new LatheGeometry(cuffPts, 28), this.cuffMat);
    for (const m of [forearm, upper, cuff]) {
      m.frustumCulled = false;
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
    }
    return { forearm, upper, cuff, elbow: new Vector3() };
  }

  /** input: { lateral, forward, vertical, boost, power, warp } in −1..1 (boost, warp 0..1). */
  update(dt) {
    if (!this.ready) return;
    this._t += dt;
    const I = this.input;
    // occasional idle finger tap
    this.nextTap -= dt;
    for (const side of ['left', 'right']) {
      const h = this.hands[side];
      const st = h.st;
      const mine = side === 'left' ? Math.max(0, -I.lateral) : Math.max(0, I.lateral);
      const other = side === 'left' ? Math.max(0, I.lateral) : Math.max(0, -I.lateral);
      const down = Math.max(0, -I.vertical);
      const up = Math.max(0, I.vertical);
      const wp = I.warp || 0;
      st.press = damp(st.press, Math.min(1, mine * 1.0 + down * 0.7 + I.boost * 0.5 + wp), 9, dt);
      st.lift = damp(st.lift, Math.min(1, up * 1.0 + other * 0.15) * (1 - wp), 7, dt);
      st.slide = damp(st.slide, mine * 0.022 * h.s - other * 0.004 * h.s, 8, dt);
      st.push = damp(st.push, -I.forward * 0.024 - wp * 0.012, 6, dt);
      st.roll = damp(st.roll, mine * 0.2 * -h.s, 8, dt);
      st.yaw = damp(st.yaw, (I.lateral * 0.1 + mine * 0.06 * -h.s) * -1, 6, dt);
      st.spread = damp(st.spread, 1 + I.boost * 1.8 + up * 0.3 + wp * 1.6, 6, dt);
      // tap
      if (this.nextTap <= 0 && I.power > 0.5 && Math.abs(I.lateral) + Math.abs(I.forward) + Math.abs(I.vertical) < 0.05) {
        this.nextTap = 3 + Math.random() * 5;
        const hs = Math.random() < 0.5 ? 'left' : 'right';
        this.hands[hs].st.tapT = 0;
        this.hands[hs].st.tapFinger = ['index', 'middle', 'ring'][Math.floor(Math.random() * 3)];
      }
      if (st.tapT !== undefined) {
        st.tapT += dt;
        st.tap = Math.sin(Math.min(1, st.tapT / 0.38) * Math.PI) * (st.tapT < 0.38 ? 1 : 0);
        if (st.tapT > 0.4) st.tapT = undefined;
      } else st.tap = 0;

      const flex = st.press * 0.22 - Math.min(0, I.forward) * 0.1 + Math.max(0, I.forward) * -0.04;
      h.pose(flex, st.spread, st.lift, { finger: st.tapFinger, amount: st.tap });

      // Pad frame: pad centre, tilted with the console.
      const pad = PAD[side];
      const breathe = Math.sin(this._t * 1.25 + (side === 'left' ? 0 : 0.6)) * 0.0012 + (I.warp || 0) * Math.sin(this._t * 29 + (side === 'left' ? 0 : 2)) * 0.0005;
      h.root.position.set(pad.x + st.slide, pad.y, pad.z + st.push);
      h.root.quaternion.setFromAxisAngle(X, PAD.tilt);
      h.root.quaternion.multiply(_q.setFromAxisAngle(Y, st.yaw + PAD.toeIn * h.s));
      h.root.quaternion.multiply(_q.setFromAxisAngle(new Vector3(0, 0, 1), st.roll));
      h.root.quaternion.multiply(_q.setFromAxisAngle(X, -st.lift * 0.06 + st.press * 0.03));
      // keep the fingertips on the glass (then lift)
      const low = h.lowestTip();
      const contact = 0.0075 - low;
      st.h = damp(st.h, contact + st.lift * 0.012 - st.press * 0.0035 + breathe, 18, dt);
      _v.set(0, st.h, 0).applyQuaternion(h.root.quaternion);
      h.root.position.add(_v);
      h.root.updateMatrixWorld(true);
    }
    const wrists = {};
    for (const side of ['left', 'right']) wrists[side] = this.group.worldToLocal(this.hands[side].bones.wrist.getWorldPosition(new Vector3()));
    const elbows = this.body.ready ? this.body.update(dt, wrists) : null;
    if (elbows && !this._fitted) this._fitGauntlets(wrists, elbows);
    for (const side of ['left', 'right']) this._arm(this.hands[side], side, wrists[side], elbows && elbows[side]);
  }

  /**
   * Once, with the body seated and the gloves on the pads: tailor a gauntlet
   * to each wrist (glove + sleeve end) and hang it on the forearm bone.
   */
  _fitGauntlets(wrists, elbows) {
    this._fitted = true;
    let sleeves = null;
    this.body.root.traverse((o) => {
      if (o.isSkinnedMesh && o.name !== 'pilot_head') sleeves = o;
    });
    if (!sleeves) return;
    this.group.updateMatrixWorld(true);
    const toGroup = this.group.getWorldQuaternion(new Quaternion()).invert();
    for (const side of ['left', 'right']) {
      const h = this.hands[side];
      const W = wrists[side];
      const y = new Vector3().subVectors(elbows[side], W).normalize();
      const z = new Vector3(0, 1, 0).addScaledVector(y, -y.y).normalize(); // back of the wrist: up
      const x = new Vector3().crossVectors(y, z);
      const R = fitGauntlet(sampleCover([{ mesh: h.mesh, glove: true }, { mesh: sleeves, glove: false }], { origin: W, x, y, z }, this.group));
      if (!R) continue;
      const g = gauntletMesh(R, h.s);
      this.group.add(g);
      const fore = this.body.b[side === 'left' ? 'foreL' : 'foreR'];
      const qf = fore.getWorldQuaternion(new Quaternion()).premultiply(toGroup);
      h.gauntlet = g;
      h.gauntletOff = qf.invert().multiply(new Quaternion().setFromRotationMatrix(_m.makeBasis(x, y, z)));
      if (!this.materials.includes(g.material)) this.materials.push(g.material);
    }
  }

  _arm(h, side, W, bodyElbow) {
    const A = h.arm;
    if (bodyElbow) {
      // the body's own sleeves: only the gauntlet is ours
      A.forearm.visible = A.upper.visible = false;
      A.elbow.copy(bodyElbow);
      if (h.gauntlet) {
        A.cuff.visible = false;
        const fore = this.body.b[side === 'left' ? 'foreL' : 'foreR'];
        h.gauntlet.position.copy(W);
        h.gauntlet.quaternion.copy(fore.getWorldQuaternion(_q)).premultiply(this.group.getWorldQuaternion(_q2).invert()).multiply(h.gauntletOff);
        return;
      }
      A.cuff.position.copy(W);
      A.cuff.quaternion.setFromUnitVectors(Y, new Vector3().subVectors(bodyElbow, W).normalize());
      return;
    }
    // back along the hand toward the elbow a little (the joint is at the carpal bones)
    const shoulder = new Vector3(PILOT.x + 0.185 * h.s, 2.66, PILOT.z + 0.08);
    const d = new Vector3().subVectors(W, shoulder);
    const len = d.length();
    const a = 0.29;
    const b = 0.27;
    const L = Math.min(len, a + b - 0.002);
    const dir = d.clone().normalize();
    // elbow out to the side and down
    const pole = new Vector3(0.75 * h.s, -0.65, 0.15).normalize();
    const perp = pole.clone().sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
    const cosA = (a * a + L * L - b * b) / (2 * a * L);
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    const elbow = shoulder.clone().addScaledVector(dir, a * cosA).addScaledVector(perp, a * sinA);
    A.elbow.copy(elbow);
    // the sleeve starts under the gauntlet's flare
    const tuck = _v.subVectors(elbow, W).normalize().multiplyScalar(0.064).add(W);
    place(A.forearm, tuck, elbow);
    place(A.upper, elbow, shoulder);
    // cuff sits on the wrist, oriented along the forearm
    A.cuff.position.copy(W);
    A.cuff.quaternion.setFromUnitVectors(Y, new Vector3().subVectors(elbow, W).normalize());
  }
}

function place(mesh, from, to) {
  const d = new Vector3().subVectors(to, from);
  const len = d.length();
  mesh.position.copy(from);
  mesh.quaternion.setFromUnitVectors(Y, d.normalize());
  mesh.scale.set(1, len, 1);
}
