import { BufferAttribute, BufferGeometry, CatmullRomCurve3, CylinderGeometry, DoubleSide, Group, Matrix4, Mesh, MeshStandardMaterial, Quaternion, TorusGeometry, Vector2, Vector3 } from 'three';
import { twillTextures } from '../textures.js';
import { SAUCER } from './Saucer.js';

/**
 * The pilot's own body, seen from inside the head: a Rocketbox avatar
 * (scripts/rocketbox_pilot.py — hands cut at the cuff, head split off,
 * subdivided) sat in the seat. The flight gloves (PilotHands) replace the hands.
 *
 *   seat  : spine reclined a little with the head kept upright, the eyes put
 *           exactly on the cockpit eye point, thighs along the cushion, shins
 *           down to the floor, feet flat
 *   arms  : two-bone IK every frame from the shoulder to each glove's wrist,
 *           elbows out and down
 *   head  : not drawn, but still casts its shadow across the console
 *   strap : five-point harness laid over the posed torso, rotary buckle
 *
 * Bones are aimed in the cockpit frame. Elbows and knees are hinges: each
 * segment is turned so its bind-pose bend axis lands on the bend axis of the
 * new pose, which keeps sleeves and trouser legs from twisting at the joint.
 */
const FLOOR = 1.78;
const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const FWD = new Vector3(0, 0, -1);
const BACK = new Vector3(0, 0, 1);
const _q = new Quaternion();
const _q2 = new Quaternion();
const _m0 = new Matrix4();
const _m1 = new Matrix4();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();

function ortho(v, axis) {
  return v.clone().addScaledVector(axis, -v.dot(axis)).normalize();
}

export class PilotBody {
  constructor(assets) {
    this.assets = assets;
    this.root = new Group();
    this.root.name = 'pilot-body';
    this.ready = false;
    this.materials = [];
    this._t = 0;
    this.harness = new Group(); // cockpit frame (not under the turned avatar root)
    this.harness.name = 'harness';
  }

  async load() {
    const g = await this.assets.gltf('pilot');
    if (!g) return false;
    const model = g.scene;
    this.root.add(model);
    this.root.rotation.y = Math.PI; // the avatar faces +Z, the pilot −Z
    this.root.updateMatrixWorld(true);
    const B = (n) => model.getObjectByName(n);
    const b = (this.b = {
      spine: B('Bip01_Spine'),
      spine2: B('Bip01_Spine2'),
      neck: B('Bip01_Neck'),
      head: B('Bip01_Head'),
      eyeL: B('Bip01_LEye'),
      eyeR: B('Bip01_REye'),
    });
    for (const k of ['L', 'R']) {
      b[`clav${k}`] = B(`Bip01_${k}_Clavicle`);
      b[`up${k}`] = B(`Bip01_${k}_UpperArm`);
      b[`fore${k}`] = B(`Bip01_${k}_Forearm`);
      b[`hand${k}`] = B(`Bip01_${k}_Hand`);
      b[`thigh${k}`] = B(`Bip01_${k}_Thigh`);
      b[`calf${k}`] = B(`Bip01_${k}_Calf`);
      b[`foot${k}`] = B(`Bip01_${k}_Foot`);
      b[`toe${k}`] = B(`Bip01_${k}_Toe0`);
    }
    if (Object.values(b).some((o) => !o)) {
      console.warn('[pilot] body rig is missing bones');
      return false;
    }
    // bind pose, cockpit frame: world rotation, segment direction, bend axis
    this.bind = new Map();
    const seg = (bone, child, hinge) => {
      const p0 = bone.getWorldPosition(new Vector3());
      const d0 = child.getWorldPosition(new Vector3()).sub(p0);
      const len = d0.length();
      d0.normalize();
      this.bind.set(bone, { q0: bone.getWorldQuaternion(new Quaternion()), d0, h0: ortho(new Vector3().crossVectors(d0, hinge), d0), len });
    };
    for (const k of ['L', 'R']) {
      seg(b[`up${k}`], b[`fore${k}`], FWD);
      seg(b[`fore${k}`], b[`hand${k}`], FWD);
      seg(b[`thigh${k}`], b[`calf${k}`], BACK);
      seg(b[`calf${k}`], b[`foot${k}`], BACK);
      seg(b[`foot${k}`], b[`toe${k}`], BACK);
    }
    // one bend axis per joint: the elbow's for upper arm + forearm, the knee's for thigh, calf and foot
    for (const k of ['L', 'R']) {
      this.bind.get(b[`fore${k}`]).h0 = ortho(this.bind.get(b[`up${k}`]).h0, this.bind.get(b[`fore${k}`]).d0);
      const h0 = this.bind.get(b[`thigh${k}`]).h0;
      this.bind.get(b[`calf${k}`]).h0 = ortho(h0, this.bind.get(b[`calf${k}`]).d0);
      this.bind.get(b[`foot${k}`]).h0 = ortho(h0, this.bind.get(b[`foot${k}`]).d0);
    }
    model.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      o.frustumCulled = false;
      o.castShadow = true;
      o.receiveShadow = true;
      if (o.name === 'pilot_head') {
        // shadow caster only: the camera sits inside it
        o.material = o.material.clone();
        o.material.colorWrite = false;
        o.material.depthWrite = false;
      } else {
        o.material.envMapIntensity = 0.6;
        this.materials.push(o.material);
      }
    });
    this.rest = [b.spine, b.spine2, b.neck, b.clavL, b.clavR].map((o) => [o, o.quaternion.clone()]);
    this._seat();
    this._buildHarness();
    this._h = { L: null, R: null };
    this.ready = true;
    return true;
  }

  /** Shoulder straps from the headbox over the trapezius and down the chest, lap belts, crotch strap, buckle. */
  _buildHarness() {
    const b = this.b;
    const hip = this.hip.clone();
    const neck = b.neck.getWorldPosition(new Vector3());
    const up = new Vector3().subVectors(neck, hip).normalize();
    const fwd = ortho(FWD.clone(), up);
    const chest = b.spine2.getWorldPosition(new Vector3());
    const twill = twillTextures();
    const mat = new MeshStandardMaterial({ name: 'harness_webbing', color: 0x4a4b36, roughness: 0.88, metalness: 0, normalMap: twill.normalMap, normalScale: new Vector2(0.9, 0.9), side: DoubleSide });
    const metal = new MeshStandardMaterial({ name: 'harness_metal', color: 0xa4a8ac, roughness: 0.28, metalness: 1 });
    const black = new MeshStandardMaterial({ name: 'harness_black', color: 0x151617, roughness: 0.45, metalness: 0.2 });
    this.materials.push(mat, metal, black);
    // outward from the spine axis = the body surface normal, near enough for straps
    const axisPt = (p) => {
      const t = Math.max(0, Math.min(1, _a.subVectors(p, hip).dot(up) / neck.distanceTo(hip)));
      return hip.clone().addScaledVector(up, t * neck.distanceTo(hip));
    };
    const normalAt = (p) => _b.subVectors(p, axisPt(p)).normalize();
    const buckle = hip.clone().addScaledVector(up, 0.17).addScaledVector(fwd, 0.16);
    const add = (pts, w) => {
      const m = new Mesh(ribbon(pts, w, 0.004, normalAt), mat);
      m.castShadow = m.receiveShadow = true;
      this.harness.add(m);
    };
    for (const [k, s] of [['L', -1], ['R', 1]]) {
      const S = b[`up${k}`].getWorldPosition(new Vector3());
      const side = new Vector3(s, 0, 0);
      add([
        new Vector3(s * 0.085, 2.95, 0.64),
        S.clone().addScaledVector(up, 0.085).addScaledVector(side, -0.07).addScaledVector(fwd, -0.06),
        S.clone().addScaledVector(up, 0.07).addScaledVector(side, -0.075).addScaledVector(fwd, 0.04),
        chest.clone().addScaledVector(fwd, 0.15).addScaledVector(side, 0.085).addScaledVector(up, 0.05),
        chest.clone().addScaledVector(fwd, 0.16).addScaledVector(side, 0.06).addScaledVector(up, -0.12),
        buckle.clone().addScaledVector(side, 0.03).addScaledVector(up, 0.02),
      ], 0.046);
      add([
        new Vector3(s * 0.25, 2.0, 0.47),
        hip.clone().addScaledVector(side, 0.17).addScaledVector(fwd, 0.02).addScaledVector(up, 0.05),
        hip.clone().addScaledVector(side, 0.12).addScaledVector(fwd, 0.13).addScaledVector(up, 0.12),
        buckle.clone().addScaledVector(side, 0.035).addScaledVector(up, -0.02),
      ], 0.05);
      // adjuster buckles on the shoulder straps
      const adj = new Mesh(new TorusGeometry(0.02, 0.004, 6, 4), metal);
      adj.position.copy(chest).addScaledVector(fwd, 0.162).addScaledVector(side, 0.08).addScaledVector(up, 0.0);
      adj.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), fwd);
      adj.rotation.z += Math.PI / 4;
      this.harness.add(adj);
    }
    add([new Vector3(0, 2.02, 0.08), hip.clone().addScaledVector(fwd, 0.17).addScaledVector(up, 0.02), buckle.clone().addScaledVector(up, -0.03)], 0.045);
    // rotary quick-release buckle
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), fwd);
    for (const [geo, m, o] of [
      [new CylinderGeometry(0.044, 0.046, 0.014, 32), metal, 0],
      [new CylinderGeometry(0.03, 0.032, 0.008, 32), black, 0.01],
      [new CylinderGeometry(0.009, 0.009, 0.006, 16), metal, 0.016],
    ]) {
      const c = new Mesh(geo, m);
      c.quaternion.copy(q);
      c.position.copy(buckle).addScaledVector(fwd, o);
      c.castShadow = true;
      this.harness.add(c);
    }
  }

  /** Rotate a bone about a cockpit-frame axis (children follow). */
  _turn(bone, axis, angle) {
    bone.parent.getWorldQuaternion(_q2);
    bone.getWorldQuaternion(_q);
    _q.premultiply(new Quaternion().setFromAxisAngle(axis, angle));
    bone.quaternion.copy(_q2.invert().multiply(_q));
    bone.updateMatrixWorld(true);
  }

  /** Point a hinged segment along d with its bend axis on h (both cockpit frame, unit). */
  _aim(bone, d, h) {
    const { q0, d0, h0 } = this.bind.get(bone);
    const hh = ortho(h, d);
    _m0.makeBasis(d0, h0, _a.crossVectors(d0, h0));
    _m1.makeBasis(d, hh, _b.crossVectors(d, hh));
    _q.setFromRotationMatrix(_m1.multiply(_m0.transpose())).multiply(q0);
    bone.parent.getWorldQuaternion(_q2);
    bone.quaternion.copy(_q2.invert().multiply(_q));
    bone.updateMatrixWorld(true);
  }

  _eye(out) {
    const l = this.b.eyeL.getWorldPosition(_a);
    const r = this.b.eyeR.getWorldPosition(_b);
    return out.addVectors(l, r).multiplyScalar(0.5);
  }

  /** The static part of the pose: spine, root offset, legs. */
  _seat(breath = 0) {
    const b = this.b;
    for (const [o, q] of this.rest) o.quaternion.copy(q);
    this.root.updateMatrixWorld(true);
    // leaning in a little toward the pads, head level
    this._turn(b.spine, X, -0.09);
    this._turn(b.spine2, X, 0.02 + breath);
    this._turn(b.neck, X, 0.07 - breath);
    for (const [k, s] of [['L', -1], ['R', 1]]) this._turn(b[`clav${k}`], Y, s * 0.16);
    // eyes on the cockpit eye point
    this.root.position.add(_c.subVectors(SAUCER.eye, this._eye(new Vector3())));
    this.root.updateMatrixWorld(true);
    for (const [k, s] of [['L', -1], ['R', 1]]) {
      const thigh = b[`thigh${k}`];
      const hip = thigh.getWorldPosition(new Vector3());
      const t = new Vector3(s * 0.13, 0.05, -1).normalize();
      const knee = hip.clone().addScaledVector(t, this.bind.get(thigh).len);
      const Ls = this.bind.get(b[`calf${k}`]).len;
      const drop = Math.min(0.97, (knee.y - (FLOOR + 0.1)) / Ls);
      const c = new Vector3(s * 0.04, -drop, 0).setZ(-Math.sqrt(Math.max(0, 1 - drop * drop - 0.0016))).normalize();
      const h = new Vector3().crossVectors(t, c).normalize();
      this._aim(thigh, t, h);
      this._aim(b[`calf${k}`], c, h);
      this._aim(b[`foot${k}`], new Vector3(s * 0.12, -0.42, -0.9).normalize(), h);
    }
    this.hip = b.thighL.getWorldPosition(new Vector3()).add(b.thighR.getWorldPosition(new Vector3())).multiplyScalar(0.5);
  }

  /** Arms to the glove wrists (cockpit frame). Returns the elbows. */
  update(dt, wrists) {
    if (!this.ready) return null;
    this._t += dt;
    this._seat(Math.sin(this._t * 1.3) * 0.006);
    const out = {};
    for (const [side, k, s] of [['left', 'L', -1], ['right', 'R', 1]]) {
      const W = wrists[side];
      if (!W) continue;
      const up = this.b[`up${k}`];
      const fore = this.b[`fore${k}`];
      const a = this.bind.get(up).len;
      const bl = this.bind.get(fore).len;
      const S = up.getWorldPosition(new Vector3());
      const d = new Vector3().subVectors(W, S);
      const L = Math.min(d.length(), a + bl - 0.003);
      const dir = d.normalize();
      const pole = new Vector3(0.75 * s, -0.65, 0.12).normalize();
      const perp = ortho(pole, dir);
      const cosA = Math.max(-1, Math.min(1, (a * a + L * L - bl * bl) / (2 * a * L)));
      const elbow = S.clone().addScaledVector(dir, a * cosA).addScaledVector(perp, a * Math.sqrt(1 - cosA * cosA));
      const u = new Vector3().subVectors(elbow, S).normalize();
      const f = new Vector3().subVectors(W, elbow).normalize();
      let h = new Vector3().crossVectors(u, f);
      if (h.lengthSq() < 1e-6) h = this._h[k] || this.bind.get(up).h0.clone();
      h.normalize();
      this._h[k] = h;
      this._aim(up, u, h);
      this._aim(fore, f, h);
      out[side] = elbow;
    }
    return out;
  }
}

/** Flat strap along a curve, its face turned to normalAt(p) (UVs: across × metres along). */
function ribbon(points, width, lift, normalAt) {
  const curve = new CatmullRomCurve3(points, false, 'centripetal');
  const N = 48;
  const L = curve.getLength();
  const pos = new Float32Array((N + 1) * 6);
  const nor = new Float32Array((N + 1) * 6);
  const uv = new Float32Array((N + 1) * 4);
  const idx = [];
  const n = new Vector3();
  const w = new Vector3();
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const p = curve.getPointAt(t);
    const T = curve.getTangentAt(t);
    n.copy(normalAt(p));
    n.addScaledVector(T, -n.dot(T)).normalize();
    w.crossVectors(T, n).normalize();
    for (let k = 0; k < 2; k++) {
      const sgn = k ? 1 : -1;
      const j = i * 2 + k;
      pos[j * 3] = p.x + w.x * sgn * width * 0.5 + n.x * lift;
      pos[j * 3 + 1] = p.y + w.y * sgn * width * 0.5 + n.y * lift;
      pos[j * 3 + 2] = p.z + w.z * sgn * width * 0.5 + n.z * lift;
      nor[j * 3] = n.x;
      nor[j * 3 + 1] = n.y;
      nor[j * 3 + 2] = n.z;
      uv[j * 2] = k;
      uv[j * 2 + 1] = (t * L) / 0.08;
    }
    if (i < N) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nor, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
