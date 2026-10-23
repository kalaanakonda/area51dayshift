import {
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { fabricNormal, labelTexture } from '../procedural/textures.js';

/**
 * Procedural first-person arm (fallback for fp_hands_*.glb).
 *
 * Hierarchy and names are the BlendKit contract:
 *   upperarm_R → forearm_R → hand_R → {thumb,index,middle,ring,pinky}_0{1,2,3}_R
 * Every procedural bone's local −Z runs along the bone; +Y is the back of the
 * hand / nail side. The left arm is built as a true mirror (no negative scale),
 * so its world transforms stay pure rotations and can be retargeted onto a GLB.
 *
 * Look: pressure-suit gloves — off-white technical fabric, dark grip pads on
 * palm and fingertips (touchscreen-capable tips), an anodised wrist-disconnect
 * ring where glove meets sleeve.
 */

export const ARM_DIMS = {
  upperArm: 0.29,
  forearm: 0.27,
  palmCenter: new Vector3(0, -0.02, -0.056),
};

const FINGER_DEF = {
  index: { base: [-0.0285, 0.003, -0.093], lens: [0.042, 0.025, 0.021], r: [0.0102, 0.0096, 0.0091], splay: 0.07 },
  middle: { base: [-0.0093, 0.004, -0.097], lens: [0.046, 0.028, 0.022], r: [0.0105, 0.0099, 0.0093], splay: 0.0 },
  ring: { base: [0.0102, 0.003, -0.094], lens: [0.043, 0.026, 0.021], r: [0.0099, 0.0094, 0.0089], splay: -0.06 },
  pinky: { base: [0.0285, 0.0, -0.086], lens: [0.034, 0.021, 0.019], r: [0.0089, 0.0084, 0.008], splay: -0.14 },
};
const THUMB_DEF = { base: [-0.027, -0.013, -0.026], lens: [0.042, 0.031, 0.026], r: [0.0128, 0.0118, 0.011] };

let MATS = null;
function materials() {
  if (MATS) return MATS;
  const fab = fabricNormal().clone();
  fab.needsUpdate = true;
  fab.repeat.set(3, 3);
  MATS = {
    iva: {
      sleeve: new MeshStandardMaterial({ color: new Color(0.8, 0.79, 0.76), roughness: 0.86, normalMap: fab }),
      glove: new MeshStandardMaterial({ color: new Color(0.84, 0.83, 0.8), roughness: 0.8, normalMap: fab }),
      pad: new MeshStandardMaterial({ color: new Color(0.075, 0.075, 0.08), roughness: 0.62 }),
      ring: new MeshStandardMaterial({ color: new Color(0.2, 0.25, 0.32), metalness: 0.9, roughness: 0.28 }),
      accent: new MeshStandardMaterial({ color: new Color(0.11, 0.115, 0.12), roughness: 0.7 }),
    },
    eva: {
      sleeve: new MeshStandardMaterial({ color: new Color(0.86, 0.85, 0.82), roughness: 0.9, normalMap: fab }),
      glove: new MeshStandardMaterial({ color: new Color(0.88, 0.87, 0.84), roughness: 0.82, normalMap: fab }),
      pad: new MeshStandardMaterial({ color: new Color(0.05, 0.05, 0.055), roughness: 0.6 }),
      ring: new MeshStandardMaterial({ color: new Color(0.62, 0.64, 0.66), metalness: 1, roughness: 0.22 }),
      accent: new MeshStandardMaterial({ color: new Color(0.85, 0.4, 0.08), roughness: 0.6 }),
    },
  };
  for (const set of Object.values(MATS)) for (const m of Object.values(set)) m.normalScale?.set(0.5, 0.5);
  return MATS;
}

const _m = new Matrix4();
const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();

/** Quaternion whose local −Z points along `dir`, +Y toward `up`. */
export function quatFromDirUp(dir, up, out = new Quaternion()) {
  _z.copy(dir).normalize().negate();
  _x.crossVectors(up, _z);
  if (_x.lengthSq() < 1e-8) _x.set(1, 0, 0);
  _x.normalize();
  _y.crossVectors(_z, _x).normalize();
  _m.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m);
}

function seg(radius, length, material) {
  // Capsule along −Z from 0 to −length (joint at the origin).
  const g = new CapsuleGeometry(radius, Math.max(0.001, length - radius * 0.6), 6, 12);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, -length / 2);
  const m = new Mesh(g, material);
  m.castShadow = true;
  return m;
}

/**
 * Build one arm. side: 'R' | 'L'. suit: 'iva' | 'eva'. Returns
 * { root, bones, markers, setSuit(suit) }.
 */
export function buildProceduralArm(side, suit = 'iva', dims = ARM_DIMS) {
  const mir = side === 'L' ? -1 : 1;
  const M = materials();
  const bulk = suit === 'eva' ? 1.14 : 1;
  const mats = M[suit];
  const bones = {};
  const name = (n) => `${n}_${side}`;

  const root = new Object3D();
  root.name = `arm_${side}`;
  const upper = new Object3D();
  upper.name = name('upperarm');
  root.add(upper);
  bones.upperarm = upper;
  upper.add(seg(0.054 * bulk, dims.upperArm, mats.sleeve));

  const fore = new Object3D();
  fore.name = name('forearm');
  fore.position.set(0, 0, -dims.upperArm);
  upper.add(fore);
  bones.forearm = fore;
  // Tapered sleeve
  const sleeveGeo = new CylinderGeometry(0.043 * bulk, 0.051 * bulk, dims.forearm - 0.015, 18, 1);
  sleeveGeo.rotateX(Math.PI / 2);
  sleeveGeo.translate(0, 0, -(dims.forearm - 0.015) / 2);
  const sleeve = new Mesh(sleeveGeo, mats.sleeve);
  sleeve.castShadow = true;
  fore.add(sleeve);
  const elbow = new Mesh(new SphereGeometry(0.051 * bulk, 14, 10), mats.sleeve);
  fore.add(elbow);
  // Wrist disconnect ring + cuff
  const ring = new Mesh(new TorusGeometry(0.046 * bulk, 0.009 * bulk, 8, 28), mats.ring);
  ring.position.z = -dims.forearm + 0.008;
  fore.add(ring);
  const ring2 = new Mesh(new CylinderGeometry(0.047 * bulk, 0.047 * bulk, 0.016, 28, 1, true), mats.ring);
  ring2.rotation.x = Math.PI / 2;
  ring2.position.z = -dims.forearm + 0.016;
  fore.add(ring2);
  // Left forearm: wrist checklist (IVA) / wrist display (EVA)
  if (side === 'L') {
    const card = new Mesh(
      new PlaneGeometry(0.07, 0.05),
      new MeshStandardMaterial({
        map: labelTexture(suit === 'eva' ? ['SUIT 4.3 PSI', 'O2 98% · CO2 0.2'] : ['CREW 01', 'ABORT MODE 1A'], { w: 256, h: 160, bg: suit === 'eva' ? '#0c1210' : '#e4e2dc', fg: suit === 'eva' ? '#8fe0a8' : '#202020' }),
        emissive: suit === 'eva' ? new Color(0.3, 0.6, 0.4) : new Color(0, 0, 0),
        emissiveIntensity: suit === 'eva' ? 0.6 : 0,
        roughness: 0.5,
      })
    );
    card.name = suit === 'eva' ? 'screen_wrist_L' : 'wrist_checklist_L';
    card.position.set(0, 0.046 * bulk, -dims.forearm * 0.62);
    card.rotation.x = -Math.PI / 2;
    card.rotation.z = Math.PI;
    fore.add(card);
  }

  const hand = new Object3D();
  hand.name = name('hand');
  hand.position.set(0, 0, -dims.forearm);
  fore.add(hand);
  bones.hand = hand;

  // Glove cuff + palm
  const cuff = new Mesh(new CylinderGeometry(0.039 * bulk, 0.043 * bulk, 0.03, 20), mats.glove);
  cuff.rotation.x = Math.PI / 2;
  cuff.position.z = 0.002;
  hand.add(cuff);
  const palm = new Mesh(new RoundedBoxGeometry(0.084 * bulk, 0.031 * bulk, 0.1, 3, 0.012), mats.glove);
  palm.position.set(0, 0, -0.05);
  palm.castShadow = true;
  hand.add(palm);
  const pad = new Mesh(new RoundedBoxGeometry(0.07 * bulk, 0.006, 0.07, 2, 0.003), mats.pad);
  pad.position.set(0, -0.0155 * bulk, -0.055);
  hand.add(pad);
  const knucklePad = new Mesh(new RoundedBoxGeometry(0.078 * bulk, 0.008, 0.026, 2, 0.004), mats.accent);
  knucklePad.position.set(0, 0.0165 * bulk, -0.083);
  hand.add(knucklePad);
  const thenar = new Mesh(new SphereGeometry(0.021 * bulk, 14, 10), mats.glove);
  thenar.scale.set(1.0, 0.8, 1.5);
  thenar.position.set(-0.022 * mir, -0.008, -0.032);
  hand.add(thenar);

  // Markers used to compute contact offsets
  const palmMarker = new Object3D();
  palmMarker.position.copy(dims.palmCenter);
  hand.add(palmMarker);

  const markers = { palm: palmMarker };

  for (const [fname, def] of Object.entries(FINGER_DEF)) {
    let parent = hand;
    for (let i = 0; i < 3; i++) {
      const j = new Object3D();
      j.name = `${fname}_0${i + 1}_${side}`;
      if (i === 0) {
        j.position.set(def.base[0] * mir * bulk, def.base[1], def.base[2]);
        j.userData.baseQuat = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), def.splay * mir);
      } else {
        j.position.set(0, 0, -def.lens[i - 1]);
        j.userData.baseQuat = new Quaternion();
      }
      j.quaternion.copy(j.userData.baseQuat);
      j.add(seg(def.r[i] * bulk, def.lens[i] + def.r[i] * 0.4, mats.glove));
      if (i === 2) {
        const tip = new Mesh(new SphereGeometry(def.r[i] * bulk * 1.02, 10, 8), mats.pad);
        tip.scale.set(0.95, 0.7, 1.1);
        tip.position.set(0, -def.r[i] * 0.35, -def.lens[i] + def.r[i] * 0.2);
        j.add(tip);
        const tipMarker = new Object3D();
        tipMarker.position.set(0, -def.r[i] * 0.6, -def.lens[i] - def.r[i] * 0.5);
        j.add(tipMarker);
        markers[`${fname}Tip`] = tipMarker;
      }
      parent.add(j);
      bones[`${fname}_0${i + 1}`] = j;
      parent = j;
    }
  }

  // Thumb: base orientation points forward-outward-down, nail facing out.
  {
    const dir = new Vector3(-0.6 * mir, -0.3, -0.74).normalize();
    const up = new Vector3(-0.55 * mir, 0.83, 0.05);
    const baseQ = quatFromDirUp(dir, up);
    let parent = hand;
    for (let i = 0; i < 3; i++) {
      const j = new Object3D();
      j.name = `thumb_0${i + 1}_${side}`;
      if (i === 0) {
        j.position.set(THUMB_DEF.base[0] * mir * bulk, THUMB_DEF.base[1], THUMB_DEF.base[2]);
        j.userData.baseQuat = baseQ.clone();
      } else {
        j.position.set(0, 0, -THUMB_DEF.lens[i - 1]);
        j.userData.baseQuat = new Quaternion();
      }
      j.quaternion.copy(j.userData.baseQuat);
      j.add(seg(THUMB_DEF.r[i] * bulk, THUMB_DEF.lens[i] + THUMB_DEF.r[i] * 0.3, mats.glove));
      if (i === 2) {
        const tip = new Mesh(new SphereGeometry(THUMB_DEF.r[i] * bulk, 10, 8), mats.pad);
        tip.scale.set(0.95, 0.7, 1.1);
        tip.position.set(0, -THUMB_DEF.r[i] * 0.3, -THUMB_DEF.lens[i] + THUMB_DEF.r[i] * 0.2);
        j.add(tip);
        const tipMarker = new Object3D();
        tipMarker.position.set(0, -THUMB_DEF.r[i] * 0.6, -THUMB_DEF.lens[i] - THUMB_DEF.r[i] * 0.4);
        j.add(tipMarker);
        markers.thumbTip = tipMarker;
      }
      parent.add(j);
      bones[`thumb_0${i + 1}`] = j;
      parent = j;
    }
  }

  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false;
    }
  });
  return { root, bones, markers, mirror: mir };
}

const _qa = new Quaternion();
const _qb = new Quaternion();
const AX = new Vector3(1, 0, 0);
const AY = new Vector3(0, 1, 0);

/**
 * Apply finger curls to a procedural (or retarget-proxy) arm.
 * Curls rotate about local X (toward the palm); spread about local Y.
 * Mirrored hands negate the Y rotations (reflection across the YZ plane).
 */
export function applyPose(bones, pose, mirror = 1) {
  for (const f of ['index', 'middle', 'ring', 'pinky']) {
    const p = pose[f];
    for (let i = 0; i < 3; i++) {
      const j = bones[`${f}_0${i + 1}`];
      if (!j) continue;
      _qa.setFromAxisAngle(AX, -p[i]);
      j.quaternion.copy(j.userData.baseQuat);
      if (i === 0) {
        _qb.setFromAxisAngle(AY, p[3] * mirror);
        j.quaternion.multiply(_qb);
      }
      j.quaternion.multiply(_qa);
    }
  }
  const t = pose.thumb;
  const t1 = bones.thumb_01;
  if (t1) {
    t1.quaternion.copy(t1.userData.baseQuat);
    _qb.setFromAxisAngle(AY, t[1] * mirror * 0.9);
    t1.quaternion.multiply(_qb);
    _qa.setFromAxisAngle(AX, -t[0]);
    t1.quaternion.multiply(_qa);
    bones.thumb_02.quaternion.copy(bones.thumb_02.userData.baseQuat).multiply(_qa.setFromAxisAngle(AX, -t[2]));
    bones.thumb_03.quaternion.copy(bones.thumb_03.userData.baseQuat).multiply(_qa.setFromAxisAngle(AX, -t[3]));
  }
}
