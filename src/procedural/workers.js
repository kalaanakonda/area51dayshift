import {
  Bone,
  BoxGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  Euler,
  Float32BufferAttribute,
  Group,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Skeleton,
  SkinnedMesh,
  SphereGeometry,
  Uint16BufferAttribute,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { damp, fbm1, mulberry32 } from '../core/math.js';

/**
 * Starbase crew. Each worker is ONE rigidly-skinned mesh (one draw call) whose
 * skeleton uses exactly the bone names a BlendKit character must have
 * (see manifest.humanoidBones), so the procedural animation below can drive a
 * real GLB just as well. Faces are always covered: hard hat + headset +
 * balaclava/visor, as the brief requires — no facial animation anywhere.
 */

export const HUMANOID = [
  ['hips', null, [0, 0.98, 0]],
  ['spine', 'hips', [0, 0.1, 0]],
  ['chest', 'spine', [0, 0.2, 0]],
  ['neck', 'chest', [0, 0.24, 0]],
  ['head', 'neck', [0, 0.1, 0]],
  ['shoulder_L', 'chest', [0.08, 0.19, 0]],
  ['upperarm_L', 'shoulder_L', [0.11, 0, 0]],
  ['forearm_L', 'upperarm_L', [0, -0.29, 0]],
  ['hand_L', 'forearm_L', [0, -0.26, 0]],
  ['shoulder_R', 'chest', [-0.08, 0.19, 0]],
  ['upperarm_R', 'shoulder_R', [-0.11, 0, 0]],
  ['forearm_R', 'upperarm_R', [0, -0.29, 0]],
  ['hand_R', 'forearm_R', [0, -0.26, 0]],
  ['thigh_L', 'hips', [0.1, -0.05, 0]],
  ['shin_L', 'thigh_L', [0, -0.44, 0]],
  ['foot_L', 'shin_L', [0, -0.43, 0]],
  ['thigh_R', 'hips', [-0.1, -0.05, 0]],
  ['shin_R', 'thigh_R', [0, -0.44, 0]],
  ['foot_R', 'shin_R', [0, -0.43, 0]],
];

const _m = new Matrix4();
const _q = new Quaternion();
const _e = new Euler();

/** Merge parts into one SkinnedMesh; every vertex is weighted 100% to its part's bone. */
export function buildRigidSkinned(bonesSpec, parts, material) {
  const bones = {};
  const list = [];
  for (const [name, parent, pos] of bonesSpec) {
    const b = new Bone();
    b.name = name;
    b.position.fromArray(pos);
    if (parent) bones[parent].add(b);
    bones[name] = b;
    list.push(b);
  }
  const root = list[0];
  root.updateMatrixWorld(true);
  const geos = [];
  for (const p of parts) {
    const g = p.geo.clone();
    _m.compose(
      new Vector3(...(p.pos || [0, 0, 0])),
      _q.setFromEuler(_e.set(...(p.rot || [0, 0, 0]))),
      new Vector3(...(p.scale || [1, 1, 1]))
    );
    _m.premultiply(bones[p.bone].matrixWorld);
    g.applyMatrix4(_m);
    const n = g.attributes.position.count;
    const bi = list.indexOf(bones[p.bone]);
    const si = new Uint16Array(n * 4);
    const sw = new Float32Array(n * 4);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      si[i * 4] = bi;
      sw[i * 4] = 1;
      col[i * 3] = p.color[0];
      col[i * 3 + 1] = p.color[1];
      col[i * 3 + 2] = p.color[2];
    }
    g.setAttribute('skinIndex', new Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new Float32BufferAttribute(sw, 4));
    g.setAttribute('color', new Float32BufferAttribute(col, 3));
    geos.push(g.index ? g : g);
  }
  const merged = mergeGeometries(geos);
  const mesh = new SkinnedMesh(merged, material);
  mesh.add(root);
  root.updateMatrixWorld(true);
  mesh.bind(new Skeleton(list));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return { mesh, bones };
}

const C = {
  navy: [0.06, 0.075, 0.11],
  charcoal: [0.09, 0.09, 0.1],
  khaki: [0.24, 0.22, 0.17],
  white: [0.78, 0.78, 0.76],
  orange: [1.35, 0.32, 0.04], // fluorescent: albedo > 1 on purpose, hi-vis reads as "glowing"
  lime: [0.75, 1.1, 0.05],
  silver: [0.86, 0.88, 0.9],
  hatWhite: [0.86, 0.86, 0.84],
  hatYellow: [0.95, 0.72, 0.05],
  black: [0.02, 0.02, 0.022],
  boot: [0.06, 0.045, 0.035],
  glove: [0.04, 0.04, 0.045],
  visor: [0.01, 0.012, 0.016],
  tablet: [0.03, 0.03, 0.035],
};

let sharedMaterial = null;
function workerMaterial() {
  if (!sharedMaterial) sharedMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.0 });
  return sharedMaterial;
}

const cap = (r, l) => new CapsuleGeometry(r, l, 4, 10);

export class Worker {
  /**
   * opts: { seed, suit, vest, hat, prop, scale, action, position, yaw }
   *   suit: navy | charcoal | khaki | white
   *   vest: orange | lime | none
   *   hat:  hard-white | hard-yellow | helmet
   *   prop: tablet | radio | null
   */
  constructor(opts = {}) {
    this.opts = opts;
    const rand = mulberry32(opts.seed || 1);
    this.rand = rand;
    const suit = C[opts.suit || 'navy'];
    const vest = opts.vest === 'none' ? null : C[opts.vest || 'orange'];
    const parts = [
      { bone: 'hips', geo: new BoxGeometry(0.34, 0.2, 0.22), pos: [0, -0.02, 0], color: suit },
      { bone: 'spine', geo: cap(0.14, 0.12), pos: [0, 0.08, 0], scale: [1.12, 1, 0.8], color: suit },
      { bone: 'chest', geo: cap(0.16, 0.2), pos: [0, 0.11, 0], scale: [1.15, 1, 0.76], color: suit },
      { bone: 'neck', geo: new CylinderGeometry(0.05, 0.055, 0.12, 10), pos: [0, 0.04, 0], color: C.black },
      { bone: 'head', geo: new SphereGeometry(0.105, 16, 12), pos: [0, 0.08, 0.005], color: C.black },
      { bone: 'upperarm_L', geo: cap(0.055, 0.18), pos: [0, -0.14, 0], color: suit },
      { bone: 'forearm_L', geo: cap(0.047, 0.17), pos: [0, -0.13, 0], color: suit },
      { bone: 'hand_L', geo: new BoxGeometry(0.07, 0.1, 0.035), pos: [0, -0.06, 0], color: C.glove },
      { bone: 'upperarm_R', geo: cap(0.055, 0.18), pos: [0, -0.14, 0], color: suit },
      { bone: 'forearm_R', geo: cap(0.047, 0.17), pos: [0, -0.13, 0], color: suit },
      { bone: 'hand_R', geo: new BoxGeometry(0.07, 0.1, 0.035), pos: [0, -0.06, 0], color: C.glove },
      { bone: 'thigh_L', geo: cap(0.078, 0.28), pos: [0, -0.22, 0], color: suit },
      { bone: 'shin_L', geo: cap(0.062, 0.3), pos: [0, -0.22, 0], color: suit },
      { bone: 'foot_L', geo: new BoxGeometry(0.115, 0.1, 0.28), pos: [0, -0.03, 0.06], color: C.boot },
      { bone: 'thigh_R', geo: cap(0.078, 0.28), pos: [0, -0.22, 0], color: suit },
      { bone: 'shin_R', geo: cap(0.062, 0.3), pos: [0, -0.22, 0], color: suit },
      { bone: 'foot_R', geo: new BoxGeometry(0.115, 0.1, 0.28), pos: [0, -0.03, 0.06], color: C.boot },
    ];
    if (vest) {
      parts.push(
        { bone: 'chest', geo: cap(0.168, 0.17), pos: [0, 0.1, 0], scale: [1.17, 0.95, 0.8], color: vest },
        { bone: 'chest', geo: new BoxGeometry(0.41, 0.035, 0.3), pos: [0, 0.02, 0], color: C.silver },
        { bone: 'chest', geo: new BoxGeometry(0.41, 0.035, 0.3), pos: [0, 0.14, 0], color: C.silver },
        { bone: 'chest', geo: new BoxGeometry(0.04, 0.3, 0.31), pos: [0.09, 0.12, 0], color: C.silver },
        { bone: 'chest', geo: new BoxGeometry(0.04, 0.3, 0.31), pos: [-0.09, 0.12, 0], color: C.silver }
      );
    }
    const hat = opts.hat || 'hard-white';
    if (hat === 'helmet') {
      parts.push(
        { bone: 'head', geo: new SphereGeometry(0.135, 18, 14), pos: [0, 0.09, 0], color: C.white },
        { bone: 'head', geo: new SphereGeometry(0.128, 18, 10, -0.9, 1.8, 0.9, 1.0), pos: [0, 0.09, 0.012], color: C.visor }
      );
    } else {
      const hc = hat === 'hard-yellow' ? C.hatYellow : C.hatWhite;
      parts.push(
        { bone: 'head', geo: new SphereGeometry(0.128, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), pos: [0, 0.115, 0], color: hc },
        { bone: 'head', geo: new CylinderGeometry(0.152, 0.152, 0.014, 20), pos: [0, 0.118, 0.012], color: hc },
        { bone: 'head', geo: new BoxGeometry(0.17, 0.045, 0.05), pos: [0, 0.075, 0.09], color: C.visor },
        { bone: 'head', geo: new CylinderGeometry(0.045, 0.045, 0.05, 12), pos: [0.108, 0.07, 0], rot: [0, 0, Math.PI / 2], color: C.black },
        { bone: 'head', geo: new CylinderGeometry(0.045, 0.045, 0.05, 12), pos: [-0.108, 0.07, 0], rot: [0, 0, Math.PI / 2], color: C.black }
      );
    }
    if (opts.prop === 'tablet') parts.push({ bone: 'hand_R', geo: new BoxGeometry(0.2, 0.012, 0.14), pos: [0, -0.1, 0.05], color: C.tablet });
    if (opts.prop === 'radio') parts.push({ bone: 'hand_L', geo: new BoxGeometry(0.05, 0.12, 0.03), pos: [0, -0.08, 0.02], color: C.black });

    const { mesh, bones } = buildRigidSkinned(HUMANOID, parts, workerMaterial());
    this.mesh = mesh;
    this.bones = bones;
    this.root = new Group();
    this.root.add(mesh);
    const s = opts.scale || 0.96 + rand() * 0.08;
    this.root.scale.setScalar(s);
    if (opts.position) this.root.position.fromArray(opts.position);
    this.root.rotation.y = opts.yaw || 0;
    this.action = opts.action || 'idle';
    this.phase = rand() * 100;
    this.walk = { phase: 0, speed: 1.25, path: null, i: 0, loop: true };
    this.lookYaw = 0;
    this.target = null;
  }

  /** Walk a polyline of [x, z] points (world space, on ground y of the first point). */
  setPath(points, { speed = 1.25, loop = true, y = 0 } = {}) {
    this.walk.path = points.map(([x, z]) => new Vector3(x, y, z));
    this.walk.i = 0;
    this.walk.speed = speed;
    this.walk.loop = loop;
    this.root.position.copy(this.walk.path[0]);
    this.action = 'walk';
  }

  update(dt, time) {
    const t = time + this.phase;
    const b = this.bones;
    // Reset to rest
    for (const k in b) b[k].rotation.set(0, 0, 0);
    // Arms hang slightly away from the body.
    b.upperarm_L.rotation.z = 0.12;
    b.upperarm_R.rotation.z = -0.12;
    b.forearm_L.rotation.x = -0.15;
    b.forearm_R.rotation.x = -0.15;

    const breath = Math.sin(t * 1.4) * 0.025;
    b.spine.rotation.x = breath;
    b.neck.rotation.x = -breath * 0.5;
    this.lookYaw = damp(this.lookYaw, fbm1(t * 0.12, 2) * 0.9, 2, dt);

    const act = this.action;
    if (act === 'walk' && this.walk.path) {
      this._advance(dt);
      const ph = this.walk.phase;
      b.thigh_L.rotation.x = -Math.sin(ph) * 0.42;
      b.thigh_R.rotation.x = Math.sin(ph) * 0.42;
      b.shin_L.rotation.x = Math.max(0, Math.sin(ph + 1.2)) * 0.75;
      b.shin_R.rotation.x = Math.max(0, -Math.sin(ph + 1.2)) * 0.75;
      b.foot_L.rotation.x = Math.sin(ph) * 0.15;
      b.foot_R.rotation.x = -Math.sin(ph) * 0.15;
      b.upperarm_L.rotation.x = Math.sin(ph) * 0.32;
      b.upperarm_R.rotation.x = -Math.sin(ph) * 0.32;
      b.forearm_L.rotation.x = -0.3 - Math.max(0, -Math.sin(ph)) * 0.25;
      b.forearm_R.rotation.x = -0.3 - Math.max(0, Math.sin(ph)) * 0.25;
      b.hips.position.y = 0.98 - Math.abs(Math.cos(ph)) * 0.025;
      b.hips.rotation.y = Math.sin(ph) * 0.07;
      b.chest.rotation.y = -Math.sin(ph) * 0.09;
      b.head.rotation.y = this.lookYaw * 0.3;
    } else {
      b.hips.position.y = 0.98;
      b.hips.rotation.z = Math.sin(t * 0.35) * 0.025;
      b.chest.rotation.z = -Math.sin(t * 0.35) * 0.02;
      b.thigh_L.rotation.z = Math.sin(t * 0.35) * 0.02;
      b.thigh_R.rotation.z = Math.sin(t * 0.35) * 0.02;
      b.head.rotation.y = this.lookYaw;
      b.head.rotation.x = fbm1(t * 0.2 + 5, 2) * 0.15;
      if (act === 'work') {
        b.spine.rotation.x = 0.18 + breath;
        b.upperarm_L.rotation.x = -0.75;
        b.upperarm_R.rotation.x = -0.7;
        b.upperarm_L.rotation.z = 0.25;
        b.upperarm_R.rotation.z = -0.25;
        b.forearm_L.rotation.x = -0.9 + Math.sin(t * 2.1) * 0.12;
        b.forearm_R.rotation.x = -0.95 + Math.sin(t * 2.7 + 1) * 0.15;
        b.forearm_R.rotation.y = Math.sin(t * 1.3) * 0.3;
        b.head.rotation.x = 0.35;
        b.head.rotation.y = this.lookYaw * 0.2;
      } else if (act === 'radio') {
        b.upperarm_L.rotation.x = -0.5;
        b.upperarm_L.rotation.z = 0.9;
        b.forearm_L.rotation.x = -2.25;
        b.head.rotation.z = 0.12;
        b.head.rotation.x = 0.1 + Math.sin(t * 2.0) * 0.05;
      } else if (act === 'point') {
        b.upperarm_R.rotation.x = -1.35;
        b.upperarm_R.rotation.z = -0.25;
        b.forearm_R.rotation.x = -0.1;
        b.head.rotation.y = -0.25;
        b.head.rotation.x = -0.2;
      } else if (act === 'wave') {
        b.upperarm_R.rotation.z = -2.5;
        b.forearm_R.rotation.z = Math.sin(t * 6) * 0.45;
        b.head.rotation.y = 0;
      } else if (act === 'gestureIn') {
        // Close-out crew: "this way" — an open arm sweep toward the hatch.
        const s = (Math.sin(t * 1.2) * 0.5 + 0.5) ** 2;
        b.upperarm_L.rotation.x = -0.6 - s * 0.4;
        b.upperarm_L.rotation.z = 0.6 + s * 0.5;
        b.forearm_L.rotation.x = -0.4;
        b.head.rotation.y = 0.35;
      } else if (act === 'talk') {
        b.forearm_L.rotation.x = -0.9 + Math.sin(t * 3.1) * 0.25;
        b.forearm_R.rotation.x = -0.5 + Math.sin(t * 2.3 + 2) * 0.2;
        b.upperarm_L.rotation.x = -0.25;
        b.head.rotation.x = Math.sin(t * 2.6) * 0.08;
      } else if (act === 'tablet') {
        b.upperarm_R.rotation.x = -0.45;
        b.forearm_R.rotation.x = -1.35;
        b.forearm_R.rotation.y = 0.3;
        b.upperarm_L.rotation.x = -0.35;
        b.forearm_L.rotation.x = -1.2 + Math.sin(t * 1.7) * 0.08;
        b.head.rotation.x = 0.45;
        b.head.rotation.y = -0.15;
      } else if (act === 'carry') {
        b.upperarm_L.rotation.x = -0.4;
        b.upperarm_R.rotation.x = -0.4;
        b.forearm_L.rotation.x = -1.3;
        b.forearm_R.rotation.x = -1.3;
      } else if (act === 'seated' || act === 'seatedBrace') {
        // Reclined crew couch (root = seat footprint on the floor). The whole
        // torso leans back with the hips; thighs and forearms are counter-rotated
        // so they stay level along the seat pan and the armrests.
        const brace = act === 'seatedBrace' ? 1 : 0;
        const recline = 0.38;
        b.hips.position.set(0, 0.5, -0.06);
        b.hips.rotation.set(-recline, 0, 0);
        b.spine.rotation.x = breath * 0.5;
        b.thigh_L.rotation.set(-Math.PI / 2 + recline - 0.14, 0, 0.05);
        b.thigh_R.rotation.set(-Math.PI / 2 + recline - 0.14, 0, -0.05);
        b.shin_L.rotation.x = Math.PI / 2 - 0.05;
        b.shin_R.rotation.x = Math.PI / 2 - 0.05;
        b.foot_L.rotation.x = -0.25;
        b.foot_R.rotation.x = -0.25;
        b.upperarm_L.rotation.set(-0.25, 0, 0.22);
        b.upperarm_R.rotation.set(-0.25, 0, -0.22);
        b.forearm_L.rotation.x = -0.94 - brace * 0.15;
        b.forearm_R.rotation.x = -0.94 - brace * 0.15;
        b.hand_L.rotation.x = brace * 0.4;
        b.hand_R.rotation.x = brace * 0.4;
        b.head.rotation.x = 0.12 - brace * 0.2 + fbm1(t * 0.15 + 3, 2) * 0.08 * (1 - brace);
        b.head.rotation.y = this.lookYaw * 0.35 * (1 - brace);
      } else if (act === 'float' || act === 'shelter') {
        // Zero-g neutral body posture: hips and knees softly flexed, arms adrift
        // (or, in the storm shelter, both hands up on the overhead strap).
        const d = fbm1(t * 0.18 + 9, 2);
        b.hips.position.y = 0.98;
        b.hips.rotation.set(0.12 + d * 0.06, d * 0.1, fbm1(t * 0.11 + 4, 2) * 0.08);
        b.spine.rotation.x = 0.1;
        b.thigh_L.rotation.x = -0.55 + d * 0.1;
        b.thigh_R.rotation.x = -0.48 - d * 0.1;
        b.shin_L.rotation.x = 0.95;
        b.shin_R.rotation.x = 0.85;
        b.foot_L.rotation.x = 0.35;
        b.foot_R.rotation.x = 0.35;
        if (act === 'shelter') {
          b.upperarm_L.rotation.set(-2.5, 0, 0.25);
          b.upperarm_R.rotation.set(-2.45, 0, -0.25);
          b.forearm_L.rotation.x = -0.35;
          b.forearm_R.rotation.x = -0.4;
          b.head.rotation.x = 0.35;
        } else {
          b.upperarm_L.rotation.set(-0.75 + d * 0.15, 0, 0.5);
          b.upperarm_R.rotation.set(-0.7 - d * 0.15, 0, -0.5);
          b.forearm_L.rotation.x = -0.85;
          b.forearm_R.rotation.x = -0.8;
          b.head.rotation.x = 0.18;
        }
      }
    }
  }

  _advance(dt) {
    const w = this.walk;
    const path = w.path;
    const pos = this.root.position;
    let remaining = w.speed * dt;
    while (remaining > 0 && path.length > 1) {
      const next = path[(w.i + 1) % path.length];
      const dx = next.x - pos.x;
      const dz = next.z - pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 1e-3) {
        w.i = (w.i + 1) % path.length;
        if (!w.loop && w.i === path.length - 1) {
          this.action = 'idle';
          return;
        }
        continue;
      }
      const step = Math.min(d, remaining);
      pos.x += (dx / d) * step;
      pos.z += (dz / d) * step;
      remaining -= step;
      const yaw = Math.atan2(dx, dz);
      let dy = yaw - this.root.rotation.y;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      this.root.rotation.y += dy * Math.min(1, dt * 6);
      w.phase += (step / 0.72) * Math.PI;
    }
  }
}

export { Color };
