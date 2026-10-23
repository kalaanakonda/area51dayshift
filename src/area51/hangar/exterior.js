import { BoxGeometry, CanvasTexture, Color, CylinderGeometry, Euler, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, Quaternion, RepeatWrapping, SphereGeometry, SRGBColorSpace, TorusGeometry, Vector3 } from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Batcher, member } from './build.js';
import { apronTextures, paintedSteelTextures, signTexture } from '../textures.js';
import { addGrime } from './grime.js';
import { mulberry32 } from '../../core/math.js';

/**
 * Hangar 9 from the outside — what a real flight-test hangar has on its skin
 * and around its feet, so it stops reading as a box on a plain:
 *
 *   building : concrete foundation curb, corner flashing, eave gutters and
 *              downspouts with splash blocks, LED wall packs, personnel doors
 *              (frame, vision panel, kick plate, badge reader, canopy, stoop)
 *   roof     : coping, exhaust fans, packaged rooftop units, a caged ladder,
 *              an antenna mast with a red obstruction light
 *   yard     : (east side) condensing units with their line sets, a pad-mount
 *              transformer, a standby generator with its exhaust stack,
 *              disconnects and conduit on the wall, bollards
 *   apron    : black-bordered lead-in line, hold-short bars (worn paint),
 *              blue edge lights, two flood-light poles
 *
 * Hangar-local frame (see Hangar.js): door in the −Z wall, cladding faces at
 * x = ±30.39, z = ±26.39, roof edge at y ≈ 17.35. Everything batches into one
 * draw call per material; lamps glow with `live.night`.
 */
const Y = new Vector3(0, 1, 0);
const ONE = new Vector3(1, 1, 1);
const _q = new Quaternion();
const _e = new Euler();

const XF = 30.39; // side cladding face
const ZF = 26.39; // front / back cladding face
const ROOF = 17.35; // top of the roof slab
const APRON_TOP = -0.01; // see Hangar._floor

/** Slabs on the ground, hangar-local XZ rectangles [x0, x1, z0, z1]: building + walk, apron, yard. */
export const SLABS = [
  [-31.8, 31.8, -26.6, 27.8],
  [-35, 35, -71.6, -25.6],
  [30.55, 41.15, -10, 14],
];

/** A frame on the ground or on a wall face: local +Z points out of the wall, +X along it. */
class Frame {
  constructor(b, x, z, ry = 0, y = 0) {
    this.b = b;
    this.m = new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromAxisAngle(Y, ry), ONE);
  }

  add(geo, mat, p = [0, 0, 0], r = null, uvTile = 0) {
    _q.setFromEuler(r ? _e.set(r[0], r[1], r[2]) : _e.set(0, 0, 0));
    const local = new Matrix4().compose(new Vector3(p[0], p[1], p[2]), _q, ONE);
    return this.b.add(geo, mat, { matrix: local.premultiply(this.m), uvTile });
  }

  box(mat, sx, sy, sz, x, y, z, r, uv = 1) {
    return this.add(new BoxGeometry(sx, sy, sz), mat, [x, y, z], r, uv);
  }

  rbox(mat, sx, sy, sz, x, y, z, rad = 0.02, r) {
    return this.add(new RoundedBoxGeometry(sx, sy, sz, 2, rad), mat, [x, y, z], r);
  }

  cyl(mat, rt, rb, h, x, y, z, r, seg = 16) {
    return this.add(new CylinderGeometry(rt, rb, h, seg), mat, [x, y, z], r);
  }

  bar(mat, a, b, size) {
    return member(this.b, mat, this.p(a), this.p(b), size);
  }

  p(v) {
    return new Vector3(v[0], v[1], v[2]).applyMatrix4(this.m);
  }
}

/** The four cladding faces: origin on the face at floor level, local +Z outward. */
const WALLS = {
  front: [0, -ZF, Math.PI],
  back: [0, ZF, 0],
  east: [XF, 0, Math.PI / 2], // +X side; local +X runs toward −Z
  west: [-XF, 0, -Math.PI / 2], // −X side; local +X runs toward +Z
};

export function dressExterior(hangar, { W, D, doorW }) {
  const b = new Batcher();
  const steel = paintedSteelTextures();
  const ap = apronTextures();
  const ext = (o) => {
    const m = new MeshStandardMaterial(o);
    hangar.exterior.push(m);
    return m;
  };
  const M = {
    concrete: ext({ name: 'ext_concrete', color: 0xb8b1a4, roughness: 0.92, metalness: 0 }),
    trim: ext({ name: 'ext_trim', color: 0x6f6759, roughness: 0.5, metalness: 0.45, normalMap: steel.normalMap }),
    gutter: ext({ name: 'ext_gutter', color: 0xa69d8a, roughness: 0.45, metalness: 0.4 }),
    bronze: ext({ name: 'ext_bronze', color: 0x2e2923, roughness: 0.5, metalness: 0.55 }),
    door: ext({ name: 'ext_door', color: 0x7b7366, roughness: 0.55, metalness: 0.3, normalMap: steel.normalMap }),
    frame: ext({ name: 'ext_door_frame', color: 0x3d4043, roughness: 0.5, metalness: 0.5 }),
    galv: ext({ name: 'ext_galv', color: 0xb5babd, roughness: 0.36, metalness: 0.85 }),
    hvac: ext({ name: 'ext_hvac', color: 0xd0d2cd, map: louvreTexture(), roughness: 0.5, metalness: 0.35 }),
    green: ext({ name: 'ext_transformer', color: 0x3c5a3e, roughness: 0.55, metalness: 0.3, normalMap: steel.normalMap }),
    genset: ext({ name: 'ext_genset', color: 0xc6bea8, map: gensetTexture(), roughness: 0.55, metalness: 0.3 }),
    dark: ext({ name: 'ext_dark', color: 0x1b1c1d, roughness: 0.7, metalness: 0.2 }),
    yellow: ext({ name: 'ext_yellow', color: 0xd6a312, roughness: 0.5, metalness: 0.1 }),
    glass: ext({ name: 'ext_glass', color: 0x161b20, roughness: 0.08, metalness: 0.6 }),
    grey: ext({ name: 'ext_grey', color: 0x80868a, roughness: 0.45, metalness: 0.6 }),
    walk: ext({ name: 'ext_walk', map: ap.map, roughnessMap: ap.roughnessMap, normalMap: ap.normalMap, roughness: 1, metalness: 0 }),
    paintBlack: ext({ name: 'ext_line_black', color: 0x18191a, map: paintWear(5), alphaTest: 0.5, roughness: 0.8, metalness: 0 }),
    paintYellow: ext({ name: 'ext_line_yellow', color: 0xc89b1a, map: paintWear(6), alphaTest: 0.5, roughness: 0.62, metalness: 0 }),
  };
  for (const [k, a] of [['concrete', 0.9], ['trim', 0.5], ['gutter', 0.6], ['door', 0.7], ['hvac', 0.6], ['green', 0.6], ['genset', 0.7], ['yellow', 0.8], ['galv', 0.4]]) addGrime(M[k], 'prop', a);
  // lamps: unlit, their brightness follows the night (see update)
  const glow = (r, g, bl) => {
    const m = new MeshBasicMaterial({ color: new Color(r, g, bl) });
    m.userData.base = new Color(r, g, bl);
    return m;
  };
  const L = {
    warm: glow(1.0, 0.8, 0.56),
    blue: glow(0.12, 0.3, 1.0),
    red: glow(1.0, 0.06, 0.03),
    badge: glow(1.0, 0.08, 0.04),
    flood: glow(0.95, 0.97, 1.0),
  };
  const meshes = [];
  const sign = (tex, w, h, x, y, z, ry) => {
    const m = new Mesh(new PlaneGeometry(w, h), ext({ name: 'ext_sign', map: tex, roughness: 0.5, metalness: 0.1 }));
    m.position.set(x, y, z);
    m.rotation.y = ry;
    m.receiveShadow = true;
    m.userData.noKeyShadow = true;
    hangar.group.add(m);
    meshes.push(m);
    return m;
  };

  // ---------------------------------------------------------------- foundation, flashing
  const hd = D / 2;
  const curbT = 0.16;
  b.box(M.concrete, curbT, 0.9, D + 1.1, XF + curbT / 2, -0.15, 0);
  b.box(M.concrete, curbT, 0.9, D + 1.1, -XF - curbT / 2, -0.15, 0);
  b.box(M.concrete, W + 1.1, 0.9, curbT, 0, -0.15, ZF + curbT / 2);
  const frontLen = XF + curbT - doorW / 2;
  for (const s of [-1, 1]) b.box(M.concrete, frontLen, 0.9, curbT, s * (doorW / 2 + frontLen / 2), -0.15, -ZF - curbT / 2);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(M.trim, 0.3, ROOF, 0.3, sx * (XF - 0.13), ROOF / 2, sz * (ZF - 0.13));
  // perimeter walk along the sides and back (1.5 m bays), poured deep like the other slabs
  const walkW = 1.2;
  const walkTop = -0.04;
  for (const s of [-1, 1]) b.box(M.walk, walkW, 0.8, D + 1.1 + walkW, s * (XF + curbT + walkW / 2), walkTop - 0.4, walkW / 2, { uvTile: 6.1 });
  b.box(M.walk, W + 1.1 + walkW * 2, 0.8, walkW, 0, walkTop - 0.4, ZF + curbT + walkW / 2, { uvTile: 6.1 });
  // coping on the front and back parapets
  for (const s of [-1, 1]) b.box(M.trim, W + 0.95, 0.07, 0.42, 0, 18.19, s * (hd + 0.25));
  // door-opening jamb flashing on the facade
  for (const s of [-1, 1]) b.box(M.trim, 0.36, 13.2, 0.08, s * (doorW / 2 + 0.16), 6.6, -ZF - 0.04);
  b.box(M.trim, doorW + 0.68, 0.36, 0.08, 0, 13.18, -ZF - 0.04);

  // ---------------------------------------------------------------- gutters, downspouts
  for (const s of [-1, 1]) {
    b.box(M.gutter, 0.22, 0.18, D + 0.9, s * (XF + 0.12), 16.95, 0);
    for (const z of [-19, -1, 17]) {
      const x = s * (XF + 0.09);
      b.box(M.gutter, 0.11, 16.45, 0.11, x, 0.45 + 16.45 / 2, z);
      b.box(M.gutter, 0.36, 0.11, 0.11, x + s * 0.13, 0.44, z); // shoe
      for (let y = 2; y < 16; y += 3) b.box(M.gutter, 0.13, 0.03, 0.15, x, y, z);
      b.box(M.concrete, 0.34, 0.07, 0.62, x + s * 0.5, walkTop + 0.035, z); // splash block
    }
  }

  // ---------------------------------------------------------------- wall packs
  const wallPack = (F, a, y) => {
    F.rbox(M.bronze, 0.42, 0.32, 0.22, a, y, 0.12, 0.02);
    F.box(L.warm, 0.32, 0.015, 0.15, a, y - 0.165, 0.13);
    F.box(M.dark, 0.36, 0.04, 0.03, a, y + 0.12, 0.235); // brow
  };
  const frames = {};
  for (const [k, [x, z, ry]] of Object.entries(WALLS)) frames[k] = new Frame(b, x, z, ry);
  for (const a of [-24.5, 24.5]) wallPack(frames.front, a, 7.2);
  for (const a of [-19, -5, 9, 23]) {
    wallPack(frames.east, a, 7.2);
    wallPack(frames.west, a, 7.2);
  }
  for (const a of [-22, -7, 8, 23]) wallPack(frames.back, a, 7.2);

  // ---------------------------------------------------------------- personnel doors
  const doorSigns = [
    signTexture([{ text: 'AUTHORIZED', size: 0.24 }, { text: 'PERSONNEL ONLY', size: 0.2 }], { w: 512, h: 256, bg: '#b8271e', fg: '#ffffff' }),
    signTexture([{ text: 'BADGE REQUIRED', size: 0.2 }, { text: 'TWO-PERSON RULE', size: 0.13 }], { w: 512, h: 256, bg: '#f1ede2', fg: '#1d2a44' }),
    signTexture([{ text: 'FIRE EXIT', size: 0.3 }, { text: 'KEEP CLEAR', size: 0.14 }], { w: 512, h: 256, bg: '#1d6b33', fg: '#ffffff' }),
  ];
  const personnelDoor = (wall, a, label, signIdx) => {
    const F = frames[wall];
    F.box(M.frame, 0.09, 2.32, 0.11, a - 0.555, 1.16, 0.05);
    F.box(M.frame, 0.09, 2.32, 0.11, a + 0.555, 1.16, 0.05);
    F.box(M.frame, 1.2, 0.09, 0.11, a, 2.27, 0.05);
    F.box(M.door, 1.02, 2.2, 0.05, a, 1.1, 0.03);
    F.box(M.glass, 0.17, 0.55, 0.012, a + 0.26, 1.56, 0.058);
    F.box(M.galv, 0.92, 0.26, 0.006, a, 0.14, 0.058);
    F.cyl(M.galv, 0.03, 0.03, 0.03, a - 0.4, 1.02, 0.07, [Math.PI / 2, 0, 0], 12);
    F.box(M.galv, 0.13, 0.024, 0.03, a - 0.34, 1.02, 0.09);
    F.rbox(M.dark, 0.08, 0.13, 0.035, a - 0.8, 1.16, 0.02, 0.008);
    F.box(L.badge, 0.012, 0.012, 0.01, a - 0.8, 1.2, 0.04);
    // canopy on two brackets, a light underneath, a stoop
    F.box(M.trim, 1.75, 0.06, 0.95, a, 2.64, 0.47);
    for (const s of [-1, 1]) F.bar(M.trim, [a + s * 0.72, 2.2, 0.03], [a + s * 0.72, 2.6, 0.85], 0.04);
    F.cyl(L.warm, 0.09, 0.09, 0.018, a, 2.6, 0.42, null, 14);
    F.box(M.walk, 1.9, 0.8, 1.45, a, 0.02 - 0.4, 0.72, null, 24.4);
    // door number stencilled above the canopy, sign on the leaf
    const plate = sign(signTexture([label], { w: 256, h: 128, bg: '#2b2e31', fg: '#e8e6df', size: 0.6 }), 0.36, 0.18, 0, 0, 0, 0);
    plate.position.copy(F.p([a, 3.0, 0.03]));
    plate.rotation.y = WALLS[wall][2];
    if (signIdx >= 0) {
      const s = sign(doorSigns[signIdx], 0.5, 0.25, 0, 0, 0, 0);
      s.position.copy(F.p([a, 1.62, 0.059]));
      s.rotation.y = WALLS[wall][2];
    }
  };
  personnelDoor('east', 12, 'E-1', 0); // the east wall's local +X runs toward −Z
  personnelDoor('east', -15, 'E-2', 2);
  personnelDoor('west', -12, 'W-1', 1);
  personnelDoor('west', 15, 'W-2', 2);
  personnelDoor('back', -10, 'B-1', 0);
  personnelDoor('back', 16, 'B-2', 2);

  // ---------------------------------------------------------------- equipment yard (east side)
  const yard = new Frame(b, 0, 0, 0);
  // pad poured deep, so the lakebed never shows a gap under its edge
  yard.box(M.walk, 10.6, 1.2, 24, XF + 0.16 + 5.3, 0.045 - 0.6, 2, null, 12.2);
  const unit = (x, z) => {
    yard.box(M.dark, 1.3, 0.1, 1.3, x, 0.1, z);
    yard.box(M.hvac, 1.24, 1.12, 1.24, x, 0.72, z, null, 0);
    yard.cyl(M.dark, 0.5, 0.5, 0.02, x, 1.29, z, null, 24);
    yard.add(new TorusGeometry(0.5, 0.025, 6, 28), M.galv, [x, 1.31, z], [Math.PI / 2, 0, 0]);
    for (let k = 0; k < 3; k++) yard.box(M.galv, 1.0, 0.018, 0.018, x, 1.32, z, [0, (k * Math.PI) / 3, 0]);
    yard.cyl(M.dark, 0.09, 0.09, 0.08, x, 1.33, z, null, 12);
    // line set to the wall and up it
    for (const dz of [-0.12, 0.12]) {
      yard.bar(M.dark, [x - 0.62, 0.55, z + dz], [XF + 0.08, 0.55, z + dz], 0.05);
      yard.bar(M.dark, [XF + 0.08, 0.55, z + dz], [XF + 0.08, 2.8, z + dz], 0.05);
    }
  };
  for (const z of [-6.6, -4.3, -2.0]) unit(XF + 3.6, z);
  // pad-mount transformer
  yard.box(M.green, 1.9, 1.55, 1.7, XF + 6.4, 0.8, 8.2);
  for (let k = 0; k < 6; k++) yard.box(M.green, 0.03, 1.1, 0.42, XF + 7.38, 0.7, 7.55 + k * 0.26);
  yard.box(M.green, 1.95, 0.05, 1.75, XF + 6.4, 1.6, 8.2);
  sign(signTexture([{ text: 'DANGER', size: 0.3 }, { text: 'HIGH VOLTAGE', size: 0.2 }, { text: 'KEEP OUT', size: 0.14 }], { w: 512, h: 384, bg: '#f4f1e8', fg: '#b3201a' }), 0.5, 0.37, XF + 5.44, 1.05, 8.2, -Math.PI / 2);
  // standby generator on its base tank, exhaust stack with a rain cap
  const gx = XF + 7.3;
  yard.box(M.grey, 2.45, 0.6, 6.4, gx, 0.35, -4.4);
  yard.box(M.genset, 2.3, 2.3, 6.2, gx, 1.8, -4.4, null, 0);
  yard.box(M.genset, 2.36, 0.06, 6.26, gx, 2.98, -4.4);
  yard.cyl(M.dark, 0.13, 0.13, 1.8, gx + 0.5, 3.9, -6.6, null, 14);
  yard.cyl(M.galv, 0.32, 0.32, 1.3, gx + 0.5, 3.4, -5.6, [Math.PI / 2, 0, 0], 16);
  yard.cyl(M.dark, 0.2, 0.14, 0.05, gx + 0.5, 4.82, -6.6, [0.5, 0, 0], 14);
  for (const z of [-6.8, -4.4, -2.0]) yard.box(M.dark, 0.02, 1.1, 0.5, gx - 1.16, 1.6, z); // door seams
  // disconnects and conduit on the wall
  for (let k = 0; k < 3; k++) {
    const z = 2.4 + k * 1.1;
    yard.box(M.grey, 0.2, 0.62, 0.45, XF + 0.1, 1.7, z);
    yard.bar(M.galv, [XF + 0.06, 2.01, z], [XF + 0.06, 4.6, z], 0.045);
    yard.bar(M.galv, [XF + 0.06, 1.39, z], [XF + 0.06, -0.1, z], 0.045);
  }
  yard.box(M.grey, 0.22, 1.2, 0.9, XF + 0.11, 1.9, 6.4); // main panel
  // bollards round the transformer and the generator corners
  for (const [x, z] of [[XF + 5.0, 6.8], [XF + 5.0, 9.6], [XF + 7.8, 6.8], [XF + 7.8, 9.6], [gx - 1.6, -7.9], [gx - 1.6, -0.9], [XF + 1.8, -8.0], [XF + 1.8, 0.3]]) {
    yard.cyl(M.yellow, 0.1, 0.1, 1.1, x, 0.55, z, null, 14);
    yard.cyl(M.yellow, 0.1, 0.07, 0.06, x, 1.13, z, null, 14);
  }

  // ---------------------------------------------------------------- roof
  const roof = new Frame(b, 0, 0, 0, ROOF);
  for (const x of [-18, -6, 6, 18]) {
    roof.box(M.galv, 1.0, 0.32, 1.0, x, 0.16, 6);
    roof.cyl(M.galv, 0.52, 0.58, 0.42, x, 0.53, 6, null, 20);
    roof.cyl(M.galv, 0.66, 0.52, 0.12, x, 0.8, 6, null, 20);
  }
  for (const [x, z, w, d] of [[-12, -8, 3.2, 2.0], [14, 12, 2.8, 1.8]]) {
    roof.box(M.trim, w + 0.3, 0.25, d + 0.3, x, 0.12, z);
    roof.box(M.hvac, w, 1.4, d, x, 0.95, z, null, 0);
    roof.cyl(M.dark, 0.38, 0.38, 0.03, x - w * 0.22, 1.66, z, null, 20);
    roof.cyl(M.dark, 0.38, 0.38, 0.03, x + w * 0.22, 1.66, z, null, 20);
    roof.bar(M.dark, [x + w / 2, 0.5, z], [x + w / 2 + 0.6, 0.5, z], 0.12);
  }
  // antenna mast on the back corner, red obstruction light on top
  roof.cyl(M.grey, 0.04, 0.06, 6, 27.5, 3, 23.5, null, 10);
  for (const y of [2.5, 4.2]) roof.bar(M.grey, [26.8, y, 23.5], [28.2, y, 23.5], 0.03);
  roof.box(M.dark, 0.06, 0.6, 0.12, 26.8, 2.8, 23.5);
  roof.add(new SphereGeometry(0.09, 12, 8), L.red, [27.5, 6.08, 23.5]);
  // caged ladder up the back wall
  const lad = frames.back;
  const la = 27.4;
  for (const s of [-1, 1]) {
    lad.bar(M.galv, [la + s * 0.22, 0.25, 0.22], [la + s * 0.22, ROOF + 1.1, 0.22], 0.05);
    for (let y = 1.5; y < ROOF; y += 2.5) lad.bar(M.galv, [la + s * 0.22, y, 0.0], [la + s * 0.22, y, 0.22], 0.04);
  }
  for (let y = 0.5; y < ROOF + 0.9; y += 0.3) lad.bar(M.galv, [la - 0.22, y, 0.22], [la + 0.22, y, 0.22], 0.025);
  for (let y = 2.4; y < ROOF + 1.0; y += 1.0) lad.add(new TorusGeometry(0.38, 0.016, 4, 14, Math.PI), M.galv, [la, y, 0.5], [Math.PI / 2, 0, 0]);
  for (const ang of [0.35, 0.95, 1.57, 2.19, 2.79]) lad.bar(M.galv, [la + Math.cos(ang) * 0.38, 2.4, 0.5 + Math.sin(ang) * 0.38 - 0.0], [la + Math.cos(ang) * 0.38, ROOF + 0.9, 0.5 + Math.sin(ang) * 0.38], 0.02);

  // ---------------------------------------------------------------- apron markings and edge lights
  const az0 = -hd - 0.4; // the apron's door edge
  const apron = new Frame(b, 0, 0, 0, APRON_TOP);
  const paint = (mat, w, l, x, z, y = 0.003) => apron.add(new PlaneGeometry(w, l), mat, [x, y, z], [-Math.PI / 2, 0, 0], 2);
  paint(M.paintBlack, 0.52, 44, 0, az0 - 22.4, 0.002);
  // hold-short bars across the lead-in: two solid, two dashed
  for (const [z, dashed] of [[-63.0, false], [-63.3, false], [-63.6, true], [-63.9, true]]) {
    if (!dashed) paint(M.paintYellow, 16, 0.15, 0, z);
    else for (let x = -7.55; x < 8; x += 1.8) paint(M.paintYellow, 0.9, 0.15, x, z);
  }
  const edgeLight = (x, z) => {
    apron.cyl(M.yellow, 0.045, 0.06, 0.24, x, 0.12, z, null, 10);
    apron.add(new SphereGeometry(0.065, 12, 8), L.blue, [x, 0.28, z]);
  };
  for (let z = -30; z >= -70; z -= 10) {
    edgeLight(-34.6, z);
    edgeLight(34.6, z);
  }
  for (const x of [-30, -20, -10, 10, 20, 30]) edgeLight(x, -71.2);
  // flood-light poles at the far corners, three LED heads each aimed back at the door
  for (const s of [-1, 1]) {
    const px = s * 33.4;
    const pz = -69.6;
    const P = new Frame(b, px, pz, Math.atan2(-px, -45 - pz), APRON_TOP);
    P.cyl(M.concrete, 0.36, 0.36, 0.7, 0, 0.25, 0, null, 18);
    P.box(M.grey, 0.5, 0.04, 0.5, 0, 0.62, 0);
    for (const [bx, bz] of [[-0.19, -0.19], [0.19, -0.19], [-0.19, 0.19], [0.19, 0.19]]) P.cyl(M.galv, 0.018, 0.018, 0.09, bx, 0.66, bz, null, 8);
    P.cyl(M.grey, 0.085, 0.16, 13.4, 0, 0.64 + 6.7, 0, null, 16);
    P.rbox(M.grey, 0.16, 0.3, 0.12, 0, 1.4, 0.16, 0.01); // hand hole
    P.box(M.grey, 2.4, 0.12, 0.12, 0, 14.0, 0.1);
    const tilt = -(Math.PI / 2 - 0.33);
    for (const hx of [-0.85, 0, 0.85]) {
      P.rbox(M.dark, 0.5, 0.11, 0.4, hx, 13.86, 0.32, 0.015, [tilt, 0, 0]);
      P.box(L.flood, 0.42, 0.012, 0.32, hx, 13.86 - 0.058 * Math.cos(tilt), 0.32 - 0.058 * Math.sin(tilt), [tilt, 0, 0]);
      P.box(M.dark, 0.05, 0.16, 0.05, hx, 13.97, 0.12);
    }
  }

  // ---------------------------------------------------------------- build
  for (const m of b.build({ name: 'exterior' })) {
    // outside the shell: never in the interior keys' shadow maps (roof gear would shadow the floor)
    m.userData.noKeyShadow = true;
    if (m.material.isMeshBasicMaterial || m.material === M.paintBlack || m.material === M.paintYellow) m.castShadow = false;
    hangar.group.add(m);
    meshes.push(m);
  }

  return {
    meshes,
    update(dt, t, live = {}) {
      const night = live.night ?? 0;
      L.warm.color.copy(L.warm.userData.base).multiplyScalar(0.08 + 3.2 * night);
      L.blue.color.copy(L.blue.userData.base).multiplyScalar(0.5 + 3.5 * night);
      L.red.color.copy(L.red.userData.base).multiplyScalar((Math.sin(t * Math.PI * 1.1) > 0 ? 1 : 0.08) * (1.2 + 4 * night));
      L.badge.color.copy(L.badge.userData.base).multiplyScalar(1.6);
      L.flood.color.copy(L.flood.userData.base).multiplyScalar(0.06 + 4.5 * night);
    },
  };
}

/** Worn line paint: alpha holes and thin patches where tyres and boots have taken it off (2 m tile). */
function paintWear(seed) {
  const rand = mulberry32(seed);
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 256, 256);
  const img = g.getImageData(0, 0, 256, 256);
  const d = img.data;
  const pits = [];
  for (let k = 0; k < 26; k++) pits.push([rand() * 256, rand() * 256, 2 + rand() ** 2 * 14]);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const i = (y * 256 + x) * 4;
      let a = 1;
      for (const [px, py, r] of pits) {
        let dx = Math.abs(x - px);
        let dy = Math.abs(y - py);
        dx = Math.min(dx, 256 - dx);
        dy = Math.min(dy, 256 - dy);
        const q = Math.hypot(dx, dy * 1.6) / r;
        if (q < 1.25) a = Math.min(a, q - 0.25 + (rand() - 0.5) * 0.5);
      }
      const v = 0.86 + rand() * 0.14;
      d[i] = d[i + 1] = d[i + 2] = v * 255;
      d[i + 3] = Math.max(0, Math.min(1, a + (rand() < 0.012 ? -1 : 0))) * 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/** Condensing-unit / rooftop-unit skin: horizontal coil fins with a darker band, panel seams. */
function louvreTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#cfd1cc';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#8b8f8d';
  g.fillRect(14, 30, 228, 196);
  for (let y = 30; y < 226; y += 4) {
    g.fillStyle = 'rgba(40,44,46,0.65)';
    g.fillRect(14, y, 228, 2);
  }
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.fillRect(126, 0, 3, 256);
  g.fillStyle = '#4d5154';
  g.fillRect(170, 236, 50, 10); // nameplate
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Generator enclosure: louvred intake / exhaust panels, door outlines, a data plate. */
function gensetTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#c9c1ab';
  g.fillRect(0, 0, 256, 256);
  for (const [x, w] of [[16, 70], [170, 70]]) {
    g.fillStyle = '#8c8573';
    g.fillRect(x, 60, w, 150);
    for (let y = 64; y < 206; y += 7) {
      g.fillStyle = 'rgba(30,28,22,0.6)';
      g.fillRect(x + 3, y, w - 6, 3);
    }
  }
  g.strokeStyle = 'rgba(60,56,46,0.6)';
  g.lineWidth = 2;
  g.strokeRect(96, 40, 66, 190);
  g.fillStyle = '#2a2a28';
  g.fillRect(150, 130, 6, 22); // handle
  g.fillStyle = '#e8e4d6';
  g.fillRect(104, 52, 40, 16); // data plate
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
