import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { mat } from './materials.js';
import { gratingAlpha, hazardTexture, labelTexture } from './textures.js';

const _up = new Vector3(0, 1, 0);
const _a = new Vector3();
const _b = new Vector3();
const _d = new Vector3();
const _q = new Quaternion();
const _m = new Matrix4();
const _s = new Vector3();

/** Collects box "beams" between two points, emits one InstancedMesh per material. */
export class BeamBatch {
  constructor() {
    this.items = new Map();
  }

  add(a, b, w, material = 'towerSteel', depth = w) {
    _a.copy(a);
    _b.copy(b);
    _d.subVectors(_b, _a);
    const len = _d.length();
    if (len < 1e-4) return;
    _q.setFromUnitVectors(_up, _d.normalize());
    _m.compose(_a.add(_b).multiplyScalar(0.5), _q, _s.set(w, len, depth));
    if (!this.items.has(material)) this.items.set(material, []);
    this.items.get(material).push(_m.clone());
  }

  build(geometry = new BoxGeometry(1, 1, 1)) {
    const group = new Group();
    for (const [name, mats] of this.items) {
      const im = new InstancedMesh(geometry, typeof name === 'string' ? mat(name) : name, mats.length);
      mats.forEach((m, i) => im.setMatrixAt(i, m));
      im.castShadow = true;
      im.receiveShadow = true;
      im.computeBoundingSphere();
      group.add(im);
    }
    return group;
  }
}

const V = (x, y, z) => new Vector3(x, y, z);

/**
 * Launch & catch tower ("Mechazilla"): 12 m square lattice, 147 m + lightning
 * mast. Local origin at ground centre; the south face (toward the stack) is +Z.
 */
export function buildTower({ height = 147, half = 6, chopstickY = 104, qdY = 97 } = {}) {
  const root = new Group();
  root.name = 'launch_tower';
  const beams = new BeamBatch();
  const level = 9.2;
  const nLevels = Math.round(height / level);
  const corners = [V(-half, 0, -half), V(half, 0, -half), V(half, 0, half), V(-half, 0, half)];

  // Columns
  for (const c of corners) beams.add(V(c.x, 0, c.z), V(c.x, height, c.z), 1.15);
  // Girts + X-bracing on each face, per level
  for (let l = 0; l <= nLevels; l++) {
    const y0 = l * level;
    const y1 = Math.min(height, y0 + level);
    for (let f = 0; f < 4; f++) {
      const A = corners[f];
      const B = corners[(f + 1) % 4];
      beams.add(V(A.x, y0, A.z), V(B.x, y0, B.z), 0.55);
      if (l < nLevels) {
        beams.add(V(A.x, y0, A.z), V(B.x, y1, B.z), 0.36);
        beams.add(V(B.x, y0, B.z), V(A.x, y1, A.z), 0.36);
      }
    }
    // Floor diaphragm every other level
    if (l % 2 === 0) {
      beams.add(V(-half, y0, -half), V(half, y0, half), 0.3);
      beams.add(V(half, y0, -half), V(-half, y0, half), 0.3);
    }
  }

  // Internal elevator shaft (north half)
  for (const x of [-2.2, 0.6]) for (const z of [-5.0, -2.6]) beams.add(V(x, 0, z), V(x, height - 6, z), 0.28, 'darkSteel');

  // Propellant + service lines up the south-east corner (insulated)
  const lines = new Group();
  for (const [x, r] of [
    [4.6, 0.36],
    [3.7, 0.3],
    [2.9, 0.22],
  ]) {
    const pipe = new Mesh(new CylinderGeometry(r, r, qdY + 4, 12), mat('insulation'));
    pipe.position.set(x, (qdY + 4) / 2, half - 0.9);
    pipe.castShadow = true;
    lines.add(pipe);
  }
  root.add(lines);

  // Chopsticks: carriage + two arms angled to straddle the stack.
  const chop = new Group();
  chop.name = 'chopsticks';
  const carriage = new Mesh(new BoxGeometry(11, 7, 3.5), mat('towerSteel'));
  carriage.position.set(0, chopstickY, half + 1.6);
  chop.add(carriage);
  for (const side of [-1, 1]) {
    const pivot = new Object3D();
    pivot.name = side < 0 ? 'pivot_chopstick_L' : 'pivot_chopstick_R';
    pivot.position.set(side * 4.2, chopstickY - 1, half + 3.2);
    pivot.rotation.y = side * 0.62;
    const armBeams = new BeamBatch();
    const L = 31;
    for (const y of [-1.2, 1.2]) for (const x of [-0.8, 0.8]) armBeams.add(V(x, y, 0), V(x * 0.6, y * 0.7, L), 0.35, 'towerSteel');
    for (let z = 0; z < L; z += 3.1) {
      armBeams.add(V(-0.8, -1.2, z), V(0.8, 1.2, z + 3.1), 0.18, 'towerSteel');
      armBeams.add(V(0.8, -1.2, z), V(-0.8, 1.2, z + 3.1), 0.18, 'towerSteel');
    }
    pivot.add(armBeams.build());
    const pad = new Mesh(new BoxGeometry(1.4, 0.9, 1.6), mat('paintedWhite'));
    pad.position.set(side * -0.9, 1.2, L * 0.62);
    pivot.add(pad);
    chop.add(pivot);
  }
  root.add(chop);

  // Ship quick-disconnect arm (swung in, latched to the ship's aft skirt)
  const qd = new BeamBatch();
  const qz0 = half;
  const qz1 = half + 12.6;
  for (const y of [-0.8, 0.8]) for (const x of [-0.7, 0.7]) qd.add(V(x + 1.5, qdY + y, qz0), V(x + 1.5, qdY + y, qz1), 0.25, 'towerSteel');
  for (let z = qz0; z < qz1; z += 1.6) qd.add(V(0.8, qdY - 0.8, z), V(2.2, qdY + 0.8, z + 1.6), 0.14, 'towerSteel');
  root.add(qd.build());
  const qdPlate = new Mesh(new BoxGeometry(2.6, 2.2, 0.5), mat('darkSteel'));
  qdPlate.position.set(1.5, qdY, qz1 + 0.2);
  root.add(qdPlate);

  // Lightning mast
  const mast = new Mesh(new CylinderGeometry(0.18, 0.5, 20, 8), mat('towerSteel'));
  mast.position.set(0, height + 10, 0);
  root.add(mast);

  // Aviation obstruction lights (blink in sync, driven by the scene)
  const obMat = mat('obstruction');
  const obGeo = new SphereGeometry(0.28, 10, 8);
  for (const y of [40, 80, 120, height]) {
    for (const c of corners) {
      const l = new Mesh(obGeo, obMat);
      l.position.set(c.x * 1.06, y, c.z * 1.06);
      root.add(l);
    }
  }
  const top = new Mesh(obGeo, obMat);
  top.position.set(0, height + 20.3, 0);
  root.add(top);

  // Flood banks on the south face, pointing at the ship.
  const lampMat = mat('lampCool');
  for (const y of [30, 62, 110, 136]) {
    for (const x of [-4, 4]) {
      const bank = new Mesh(new BoxGeometry(1.4, 0.8, 0.25), lampMat);
      bank.position.set(x, y, half + 0.7);
      root.add(bank);
    }
  }

  root.add(beams.build());
  root.userData.obstructionMaterial = obMat;
  root.userData.chopsticks = chop;
  return root;
}

/**
 * Crew access arm. Local frame: origin at the tower face, floor level; the
 * walkway runs along +Z toward the ship. `length` = tower face → hull.
 */
export function buildCrewArm({ length = 13.5, width = 2.4 } = {}) {
  const root = new Group();
  root.name = 'crew_access_arm';
  const hw = width / 2;
  const beams = new BeamBatch();
  const roomStart = length - 2.9;

  // Side trusses (top + bottom chords, verticals, diagonals)
  for (const x of [-hw, hw]) {
    beams.add(V(x, -0.08, 0), V(x, -0.08, length - 0.2), 0.22, 'paintedGrey', 0.3);
    beams.add(V(x, -1.6, 0), V(x, -1.6, length - 0.6), 0.2, 'paintedGrey', 0.25);
    for (let z = 0; z < length - 0.6; z += 1.7) {
      beams.add(V(x, -1.6, z), V(x, -0.08, z), 0.14, 'paintedGrey');
      beams.add(V(x, -1.6, z), V(x, -0.08, z + 1.7), 0.12, 'paintedGrey');
    }
  }
  for (let z = 0; z < length - 0.4; z += 1.7) beams.add(V(-hw, -0.12, z), V(hw, -0.12, z), 0.14, 'paintedGrey');

  // Railings up to the white room
  const railMat = 'paintedGrey';
  for (const x of [-hw + 0.06, hw - 0.06]) {
    beams.add(V(x, 1.08, 0), V(x, 1.08, roomStart), 0.05, railMat);
    beams.add(V(x, 0.56, 0), V(x, 0.56, roomStart), 0.035, railMat);
    for (let z = 0; z <= roomStart + 0.01; z += 1.6) beams.add(V(x, 0, z), V(x, 1.1, z), 0.05, railMat);
  }
  root.add(beams.build(new BoxGeometry(1, 1, 1)));

  // Kick plates with hazard edge
  const hz = hazardTexture().clone();
  hz.needsUpdate = true;
  hz.repeat.set(roomStart / 2, 1);
  const kickMat = new MeshStandardMaterial({ map: hz, metalness: 0.1, roughness: 0.6 });
  for (const x of [-hw + 0.06, hw - 0.06]) {
    const kick = new Mesh(new PlaneGeometry(roomStart, 0.12), kickMat);
    kick.position.set(x, 0.06, roomStart / 2);
    kick.rotation.y = x > 0 ? -Math.PI / 2 : Math.PI / 2;
    root.add(kick);
  }

  // Grating floor (alpha-tested so the 126 m drop shows through)
  const grating = gratingAlpha();
  const floorMat = new MeshStandardMaterial({ color: 0x6b6f74, metalness: 0.6, roughness: 0.5, alphaTest: 0.5, side: DoubleSide });
  floorMat.alphaMap = grating.clone();
  floorMat.alphaMap.needsUpdate = true;
  floorMat.alphaMap.repeat.set(width / 0.6, length / 0.6);
  const floor = new Mesh(new PlaneGeometry(width, length), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, length / 2);
  floor.receiveShadow = true;
  floor.castShadow = true;
  root.add(floor);

  // White room — conforming end at the hull
  const room = new Group();
  room.name = 'white_room';
  const wallMat = new MeshStandardMaterial({ color: 0xe9e7e2, metalness: 0.0, roughness: 0.62 });
  const rl = length - roomStart;
  for (const x of [-hw - 0.05, hw + 0.05]) {
    const wall = new Mesh(new BoxGeometry(0.08, 2.5, rl - 0.25), wallMat);
    wall.position.set(x, 1.25, roomStart + (rl - 0.25) / 2);
    room.add(wall);
  }
  const roof = new Mesh(new BoxGeometry(width + 0.2, 0.1, rl - 0.2), wallMat);
  roof.position.set(0, 2.52, roomStart + (rl - 0.2) / 2);
  room.add(roof);
  const lintel = new Mesh(new BoxGeometry(width + 0.2, 0.35, 0.12), wallMat);
  lintel.position.set(0, 2.33, roomStart);
  room.add(lintel);
  const roomFloor = new Mesh(new BoxGeometry(width, 0.05, rl), mat('darkSteel'));
  roomFloor.position.set(0, -0.02, roomStart + rl / 2);
  room.add(roomFloor);
  const light = new Mesh(new BoxGeometry(1.2, 0.04, 0.3), mat('lampWarm'));
  light.position.set(0, 2.45, roomStart + rl * 0.5);
  room.add(light);
  // Seal frame around the hatch
  // Seal frame: four bars around the 1.0 × 1.8 m hatch opening.
  for (const [w, h, x, y] of [
    [1.5, 0.22, 0, 2.05],
    [1.5, 0.12, 0, 0.0],
    [0.22, 2.1, -0.64, 1.02],
    [0.22, 2.1, 0.64, 1.02],
  ]) {
    const bar = new Mesh(new BoxGeometry(w, h, 0.22), mat('rubber'));
    bar.position.set(x, y, length - 0.16);
    room.add(bar);
  }
  const sign = new Mesh(new PlaneGeometry(0.9, 0.22), new MeshStandardMaterial({ map: labelTexture(['CREW ACCESS', 'LVL 126 · SHIP HATCH']), roughness: 0.6 }));
  sign.position.set(-hw - 0.0, 1.85, roomStart + 0.6);
  sign.rotation.y = Math.PI / 2;
  room.add(sign);
  room.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  root.add(room);

  // Latch panel on a post, right-hand side, just before the white room.
  const panel = new Group();
  panel.name = 'anchor_panel';
  const post = new Mesh(new BoxGeometry(0.08, 0.95, 0.08), mat('paintedGrey'));
  post.position.y = 0.475;
  const box = new Mesh(new BoxGeometry(0.5, 0.42, 0.18), new MeshStandardMaterial({ color: 0x3c4148, metalness: 0.3, roughness: 0.55 }));
  box.position.y = 1.12;
  const plaque = new Mesh(
    new PlaneGeometry(0.46, 0.08),
    new MeshStandardMaterial({ map: labelTexture(['ARM LATCH · HATCH EQ'], { w: 512, h: 96, bg: '#c9c7c0' }), roughness: 0.6 })
  );
  plaque.position.set(0, 1.3, 0.092);
  panel.add(post, box, plaque);
  // Panel faces the walkway (−X) from the right rail.
  panel.position.set(hw - 0.35, 0, roomStart - 1.0);
  panel.rotation.y = -Math.PI / 2;
  root.add(panel);

  root.userData = { panel, roomStart, length, width };
  return root;
}

/** Orbital launch mount: ring table on six legs, hold-downs, deluge plate. */
export function buildLaunchMount({ top = 20 } = {}) {
  const root = new Group();
  root.name = 'launch_mount';
  const ringH = 3;
  const segs = 24;
  const beams = new BeamBatch();
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    for (const r of [5.4, 10.6]) {
      beams.add(V(Math.sin(a0) * r, top - ringH / 2, Math.cos(a0) * r), V(Math.sin(a1) * r, top - ringH / 2, Math.cos(a1) * r), 1.2, 'darkSteel', ringH);
    }
    beams.add(V(Math.sin(a0) * 5.4, top - 0.4, Math.cos(a0) * 5.4), V(Math.sin(a0) * 10.6, top - 0.4, Math.cos(a0) * 10.6), 0.8, 'darkSteel', 0.8);
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    beams.add(V(Math.sin(a) * 8.2, 0, Math.cos(a) * 8.2), V(Math.sin(a) * 8.2, top - ringH, Math.cos(a) * 8.2), 2.4, 'concreteDark');
  }
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    beams.add(V(Math.sin(a) * 4.9, top - 0.2, Math.cos(a) * 4.9), V(Math.sin(a) * 4.9, top + 0.9, Math.cos(a) * 4.9), 0.5, 'darkSteel', 0.7);
  }
  root.add(beams.build());
  const plate = new Mesh(new CylinderGeometry(12, 12, 0.6, 48), new MeshStandardMaterial({ color: 0x2a2826, metalness: 0.6, roughness: 0.55 }));
  plate.position.y = 0.3;
  plate.receiveShadow = true;
  root.add(plate);
  return root;
}

export { Color };
