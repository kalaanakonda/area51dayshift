import {
  BoxGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Group,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Batcher, member } from './build.js';
import { paintedSteelTextures, signTexture } from '../textures.js';
import { canvasTexture, gratingAlpha } from '../../procedural/textures.js';
import { mulberry32 } from '../../core/math.js';
import { addGrime } from './grime.js';

/**
 * Set dressing for Hangar 9 — everything a working flight-test hangar
 * accumulates: pallet racking and a forklift on the east wall, a drive module
 * on its test stand behind stanchions, a parts cage, drums, a tug, a scissor
 * lift, tool carts, a maintenance platform beside the hull, ducts and big slow
 * ceiling fans overhead, wall services (power, air, fire, eyewash), posters,
 * clocks, beacons that turn when the drive is energised, and floor detail
 * (trench drain, drip pans, stains, strut plates).
 *
 * Static parts go into the hangar's contents batch (one draw call per
 * material, and they shadow the interior keys). Moving parts live in their own
 * groups and are animated by the returned update().
 *
 * The saucer's taxi lane (|x| < 13 from the pad to the door), the boarding
 * path from the offices to the ramp and the guard's patrol loop stay clear.
 */
const Y = new Vector3(0, 1, 0);
const ONE = new Vector3(1, 1, 1);
const _q = new Quaternion();
const _e = new Euler();

/** A prop's local frame (x, z on the floor, turned by ry) that feeds the batcher. */
class Place {
  constructor(b, x, z, ry = 0, y = 0) {
    this.b = b;
    this.m = new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromAxisAngle(Y, ry), ONE);
  }

  add(geo, mat, p = [0, 0, 0], r = [0, 0, 0], uvTile = 0) {
    _q.setFromEuler(_e.set(r[0], r[1], r[2]));
    const local = new Matrix4().compose(new Vector3(p[0], p[1], p[2]), _q, ONE);
    return this.b.add(geo, mat, { matrix: local.premultiply(this.m), uvTile });
  }

  box(mat, sx, sy, sz, x, y, z, r, uv = 1) {
    return this.add(new BoxGeometry(sx, sy, sz), mat, [x, y, z], r, uv);
  }

  rbox(mat, sx, sy, sz, x, y, z, rad = 0.03, r) {
    return this.add(new RoundedBoxGeometry(sx, sy, sz, 2, rad), mat, [x, y, z], r);
  }

  cyl(mat, rt, rb, h, x, y, z, r, seg = 18) {
    return this.add(new CylinderGeometry(rt, rb, h, seg), mat, [x, y, z], r);
  }

  /** A wheel on its axle along local z. */
  wheel(mat, rad, w, x, y, z, seg = 20) {
    return this.cyl(mat, rad, rad, w, x, y, z, [Math.PI / 2, 0, 0], seg);
  }

  bar(mat, a, b, size) {
    return member(this.b, mat, this.p(a), this.p(b), size);
  }

  p(v) {
    return new Vector3(v[0], v[1], v[2]).applyMatrix4(this.m);
  }
}

export function dressHangar(hangar, b, { W, D }) {
  const rand = mulberry32(1951);
  const hw = W / 2;
  const hd = D / 2;
  const M = hangar.mat;
  const steel = paintedSteelTextures();
  const mat = (o) => {
    const m = new MeshStandardMaterial(o);
    hangar.interior.push(m);
    return m;
  };
  const N = {
    rackBlue: mat({ name: 'rack_blue', color: 0x1d4b86, roughness: 0.42, metalness: 0.35, normalMap: steel.normalMap, roughnessMap: steel.roughnessMap }),
    rackOrange: mat({ name: 'rack_orange', color: 0xc9501a, roughness: 0.4, metalness: 0.3, normalMap: steel.normalMap }),
    cardboard: mat({ name: 'cardboard', map: cardboardTexture(), roughness: 0.92 }),
    wrap: mat({ name: 'shrink_wrap', color: 0xc9ced3, roughness: 0.22, metalness: 0.05, map: wrapTexture() }),
    drumBlue: mat({ name: 'drum_blue', color: 0x1f4fa0, roughness: 0.38, metalness: 0.45, normalMap: steel.normalMap }),
    drumRed: mat({ name: 'drum_red', color: 0x9d2219, roughness: 0.4, metalness: 0.4, normalMap: steel.normalMap }),
    drumGrey: mat({ name: 'drum_grey', color: 0x5f6468, roughness: 0.5, metalness: 0.5, normalMap: steel.normalMap }),
    galv: mat({ name: 'galvanized', color: 0xa9afb4, roughness: 0.36, metalness: 0.9, map: spiralTexture() }),
    copper: mat({ name: 'copper', color: 0xc0784e, roughness: 0.28, metalness: 1 }),
    module: mat({ name: 'module', color: 0x2b2f34, roughness: 0.3, metalness: 0.85, normalMap: steel.normalMap }),
    wire: mat({ name: 'wire_mesh', color: 0x7a8085, roughness: 0.45, metalness: 0.7, map: wireMeshTexture(), alphaTest: 0.5, side: DoubleSide }),
    grate: mat({ name: 'grate', color: 0x3a3d40, roughness: 0.6, metalness: 0.7, map: gratingAlpha(), alphaTest: 0.5 }),
    white: mat({ name: 'paint_white', color: 0xe6e6e1, roughness: 0.45, metalness: 0.05, normalMap: steel.normalMap }),
    green: mat({ name: 'paint_green', color: 0x2d5a3a, roughness: 0.5, metalness: 0.2, normalMap: steel.normalMap }),
    grey: mat({ name: 'paint_grey', color: 0x8b9095, roughness: 0.5, metalness: 0.25, normalMap: steel.normalMap }),
    blueBin: mat({ name: 'bin_blue', color: 0x2a5d9a, roughness: 0.55, metalness: 0 }),
    tank: mat({ name: 'tank_white', color: 0xd9dbd7, roughness: 0.35, metalness: 0.3 }),
    board: mat({ name: 'whiteboard', map: whiteboardTexture(), roughness: 0.18, metalness: 0 }),
    cork: mat({ name: 'notice_board', map: noticeTexture(), roughness: 0.85 }),
    vending: (() => {
      const t = vendingTexture();
      return mat({ name: 'vending', map: t, roughness: 0.3, metalness: 0.1, emissive: new Color(1, 1, 1), emissiveMap: t, emissiveIntensity: 0.35 });
    })(),
    hose: mat({ name: 'hose_yellow', color: 0xc8a01c, roughness: 0.6, metalness: 0 }),
    tread: mat({ name: 'tyre', color: 0x111213, roughness: 0.9, metalness: 0 }),
  };
  for (const [k, a] of [['rackBlue', 0.8], ['rackOrange', 0.8], ['drumBlue', 0.8], ['drumRed', 0.8], ['drumGrey', 0.8], ['grey', 0.7], ['white', 0.7], ['green', 0.7], ['galv', 0.4], ['cardboard', 0.5], ['module', 0.4], ['tread', 0.5]]) addGrime(N[k], 'prop', a);
  const glow = (r, g, bl) => new MeshBasicMaterial({ color: new Color(r, g, bl) });
  const C = hangar.colliders;
  const boxC = (x0, x1, z0, z1, maxY = 2.2) => C.push({ type: 'box', minX: Math.min(x0, x1), maxX: Math.max(x0, x1), minZ: Math.min(z0, z1), maxZ: Math.max(z0, z1), minY: 0, maxY });
  const circC = (x, z, r) => C.push({ type: 'circle', x, z, r });
  /** Separate (non-batched) meshes that still belong to the hangar contents. */
  const stain = (x, z, r, k) => {
    const m = new Mesh(new PlaneGeometry(r * 2, r * 2), stainMaterial(k));
    hangar.interior.push(m.material);
    m.rotation.set(-Math.PI / 2, 0, (x * 7.13 + z * 3.7) % 6.28);
    m.position.set(x, 0.006, z);
    m.renderOrder = 2;
    return own(m, false);
  };
  const own = (mesh, cast = true) => {
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    hangar.group.add(mesh);
    return mesh;
  };
  const anim = { fans: [], beacons: [], hands: [], t: 0 };
  // Overhead and high-wall clutter gets its own batch: real high-bays are many
  // lamps, so ducts and fan blades don't throw hard shadows on the floor.
  const ob = new Batcher();

  // ------------------------------------------------------------ pallet racking (east wall)
  const xf = hw - 2.35; // front uprights
  const xb = hw - 1.15; // back uprights (clear of the column flanges)
  const beamYs = [1.75, 3.45, 5.15];
  for (const [z0, z1] of [[-23.4, -16.6], [-15.4, -8.6], [-7.4, -0.8]]) {
    const frames = [z0, (z0 + z1) / 2, z1];
    for (const z of frames) {
      for (const x of [xf, xb]) b.box(N.rackBlue, 0.09, 5.7, 0.07, x, 2.85, z, { uvTile: 1 });
      // frame bracing: horizontals + zigzag diagonals between the two uprights
      for (let y = 0.25, k = 0; y < 5.5; y += 0.92, k++) {
        member(b, N.rackBlue, new Vector3(xf, y, z), new Vector3(xb, y, z), 0.035);
        member(b, N.rackBlue, new Vector3(k % 2 ? xf : xb, y, z), new Vector3(k % 2 ? xb : xf, y + 0.92, z), 0.03);
      }
      for (const x of [xf, xb]) b.box(M.column, 0.16, 0.012, 0.14, x, 0.006, z, { uvTile: 1 }); // base plates
    }
    // upright guard on the aisle end
    b.box(M.yellow, 0.14, 0.4, 0.25, xf - 0.12, 0.2, z0, { uvTile: 1 });
    for (let i = 0; i < 2; i++) {
      const za = frames[i] + 0.06;
      const zb = frames[i + 1] - 0.06;
      for (const y of beamYs) {
        for (const x of [xf, xb]) b.box(N.rackOrange, 0.05, 0.13, zb - za, x + (x === xf ? 0.03 : -0.03), y - 0.065, (za + zb) / 2, { uvTile: 1 });
        // bay label on the front beam
        b.box(M.yellow, 0.005, 0.06, 0.16, xf + 0.058, y - 0.06, za + 0.3, { uvTile: 1 });
      }
      // loads: floor + three levels, two pallet positions per bay
      for (const y of [0, ...beamYs]) {
        for (let p = 0; p < 2; p++) {
          const zc = za + (zb - za) * (p === 0 ? 0.27 : 0.73);
          if (rand() < 0.06) continue;
          palletLoad(b, N, M, rand, (xf + xb) / 2, y, zc, y === 0 ? 1.55 : 1.45);
        }
      }
    }
    boxC(xf - 0.1, hw, z0 - 0.05, z1 + 0.05, 6.5);
  }

  // ------------------------------------------------------------ forklift (parked by the racks)
  {
    const P = new Place(b, 21.6, -11.6, Math.PI);
    forklift(P, N, M);
    boxC(19.4, 23.0, -12.2, -11.0, 2.3);
    stain(21.4, -11.6, 1.6, 0.5);
  }

  // ------------------------------------------------------------ scissor lift (stowed)
  {
    const P = new Place(b, 17.2, -3.6, Math.PI / 2);
    scissorLift(P, N, M);
    boxC(16.6, 17.8, -4.9, -2.3, 2.5);
  }

  // ------------------------------------------------------------ drive module on its test stand (west side)
  {
    const cx = -20.5;
    const cz = -12;
    const P = new Place(b, cx, cz, 0.35);
    testStand(P, N, M, glow);
    // stanchions + sagging chain around it
    const R = 3.3;
    const posts = [];
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      if (k === 2) continue; // gap toward the instrument racks
      posts.push(new Vector3(cx + Math.sin(a) * R, 0, cz + Math.cos(a) * R));
    }
    for (const p of posts) {
      b.add(new CylinderGeometry(0.17, 0.19, 0.04, 20), M.black, { position: [p.x, 0.02, p.z] });
      b.add(new CylinderGeometry(0.025, 0.025, 0.95, 10), M.chrome, { position: [p.x, 0.5, p.z] });
      b.add(new SphereGeometry(0.035, 10, 6), M.chrome, { position: [p.x, 0.98, p.z] });
    }
    for (let i = 0; i < posts.length - 1; i++) chain(b, M, posts[i], posts[i + 1], 0.9, 0.18);
    // caution sign on a stand
    const sign = new Mesh(new PlaneGeometry(0.6, 0.42), mat({ name: 'sign_caution', map: signTexture([{ text: 'CAUTION', size: 0.2 }, { text: 'LIVE TEST ARTICLE', size: 0.12 }, { text: 'GRAVITY AMPLIFIER · UNIT 4', size: 0.075 }, { text: 'NO PERSONNEL INSIDE RING', size: 0.075 }], { w: 512, h: 360, bg: '#e8c21c', fg: '#111', size: 0.1 }), roughness: 0.5 }));
    sign.position.set(cx + 3.7, 1.15, cz + 1.2);
    sign.rotation.y = Math.PI / 2 + 0.2;
    own(sign, false);
    b.add(new CylinderGeometry(0.02, 0.02, 1.0, 8), M.column, { position: [cx + 3.72, 0.5, cz + 1.21] });
    b.add(new CylinderGeometry(0.16, 0.18, 0.03, 16), M.black, { position: [cx + 3.72, 0.015, cz + 1.21] });
    circC(cx, cz, R + 0.1);
    C.push({ type: 'box', minX: cx - R, maxX: cx + R, minZ: cz - R, maxZ: cz + R, minY: 0, maxY: 3 });
    // instrument racks on casters, cabled to the module
    for (const [rx, rz, ry] of [[-16.0, -10.6, 1.45], [-16.2, -12.0, 1.62]]) {
      const Q = new Place(b, rx, rz, ry);
      instrumentRack(Q, N, M, glow, own);
      circC(rx, rz, 0.5);
    }
    cable(b, M.black, [[-16.4, 0.1, -11.3], [-17.5, 0.02, -11.6], [-18.6, 0.02, -11.9], [-19.4, 0.35, -12.0]], 0.035);
    cable(b, N.hose, [[-16.5, 0.1, -10.4], [-17.6, 0.02, -10.2], [-18.9, 0.02, -10.6], [-19.6, 0.5, -11.2]], 0.03);
  }

  // ------------------------------------------------------------ parts cage (west wall, front)
  {
    const x0 = -hw + 0.25;
    const x1 = -26.4;
    const z0 = -23.3;
    const z1 = -16.7;
    const h = 2.6;
    for (const [x, z] of [[x1, z0], [x1, z1], [x0 + 0.3, z0], [x0 + 0.3, z1], [x1, -21.1], [x1, -18.9]]) b.box(M.column, 0.05, h, 0.05, x, h / 2, z, { uvTile: 1 });
    b.box(M.column, 0.05, 0.05, z1 - z0, x1, h, (z0 + z1) / 2, { uvTile: 1 });
    b.box(M.column, x1 - x0, 0.05, 0.05, (x0 + x1) / 2, h, z0, { uvTile: 1 });
    b.box(M.column, x1 - x0, 0.05, 0.05, (x0 + x1) / 2, h, z1, { uvTile: 1 });
    // mesh panels (the front one has the door between z −21.1 and −18.9)
    const panel = (w, x, z, ry) => b.add(new PlaneGeometry(w, h - 0.15), N.wire, { position: [x, h / 2 + 0.04, z], rotation: [0, ry, 0], uvTile: 0.25 });
    panel(2.2, x1, -22.2, Math.PI / 2);
    panel(2.2, x1, -17.8, Math.PI / 2);
    panel(2.1, x1 + 0.04, -20.0, Math.PI / 2 - 0.0); // door
    panel(x1 - x0, (x0 + x1) / 2, z0, 0);
    panel(x1 - x0, (x0 + x1) / 2, z1, 0);
    b.box(M.chrome, 0.04, 0.12, 0.08, x1 + 0.03, 1.05, -19.05, { uvTile: 1 }); // handle
    b.box(M.yellow, 0.05, 0.07, 0.05, x1 + 0.06, 1.0, -19.05, { uvTile: 1 }); // padlock
    // shelving inside along the wall, loaded with bins and boxes
    for (const zs of [-22.4, -20.2, -18.0]) {
      const sx = x0 + 0.75;
      for (const [dx, dz] of [[-0.42, -0.9], [0.42, -0.9], [-0.42, 0.9], [0.42, 0.9]]) b.box(M.column, 0.035, 2.2, 0.035, sx + dx, 1.1, zs + dz, { uvTile: 1 });
      for (const y of [0.15, 0.75, 1.35, 1.95]) {
        b.box(N.grey, 0.9, 0.025, 1.85, sx, y, zs, { uvTile: 1 });
        for (let k = 0; k < 4; k++) {
          if (rand() < 0.2) continue;
          const zz = zs - 0.68 + k * 0.45;
          if (rand() < 0.55) b.add(new BoxGeometry(0.55, 0.22, 0.38), N.blueBin, { position: [sx + 0.12, y + 0.125, zz] });
          else b.add(new BoxGeometry(0.42 + rand() * 0.2, 0.25 + rand() * 0.25, 0.36), N.cardboard, { position: [sx, y + 0.18, zz], rotation: [0, (rand() - 0.5) * 0.15, 0] });
        }
      }
    }
    // cage sign
    const s = new Mesh(new PlaneGeometry(0.9, 0.3), mat({ name: 'sign_cage', map: signTexture(['BONDED STORES · CAGE 2'], { w: 512, h: 170, bg: '#f0eee6', fg: '#1b1d1f', size: 0.3, border: 6 }), roughness: 0.5 }));
    s.position.set(x1 + 0.05, 2.3, -22.2);
    s.rotation.y = Math.PI / 2;
    own(s, false);
    boxC(x0, x1 + 0.05, z0 - 0.05, z1 + 0.05, h);
  }

  // ------------------------------------------------------------ drums on spill pallets
  for (const [x, z, n, m] of [[-28.4, -12.2, 4, N.drumBlue], [-28.4, -9.6, 4, N.drumGrey], [-26.6, -10.9, 2, N.drumRed]]) {
    b.box(M.yellow, 1.32, 0.28, 1.32, x, 0.14, z, { uvTile: 1 });
    b.add(new PlaneGeometry(1.26, 1.26), N.grate, { position: [x, 0.285, z], rotation: [-Math.PI / 2, 0, 0], uvTile: 0.4 });
    for (let k = 0; k < n; k++) drum(b, m, M, x + (k % 2 ? 0.3 : -0.3), 0.29, z + (k < 2 ? -0.3 : 0.3) * (n > 2 ? 1 : 0), rand);
    boxC(x - 0.66, x + 0.66, z - 0.66, z + 0.66, 1.3);
  }

  // ------------------------------------------------------------ aircraft tug (near the door, west)
  {
    const P = new Place(b, -22.4, -20.6, 0.08);
    tug(P, N, M, glow);
    boxC(-24.3, -20.5, -21.6, -19.6, 1.6);
    stain(-22.6, -20.5, 1.3, 0.45);
  }

  // ------------------------------------------------------------ around the craft
  {
    // strut ground plates with chevrons (pad centre at (0, -2), struts at r 3.7)
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + Math.PI / 3;
      const x = Math.sin(a) * 3.7;
      const z = -2 + Math.cos(a) * 3.7;
      b.box(M.column, 1.0, 0.025, 1.0, x, 0.0125, z, { rotation: [0, a, 0], uvTile: 1 });
      for (const [dx, dz] of [[-0.42, -0.42], [0.42, -0.42], [-0.42, 0.42], [0.42, 0.42]]) {
        const c = Math.cos(a);
        const s = Math.sin(a);
        b.add(new CylinderGeometry(0.022, 0.022, 0.018, 8), M.chrome, { position: [x + dx * c + dz * s, 0.03, z - dx * s + dz * c] });
      }
    }
    // static ground reel + lead to the aft strut
    const gx = -4.6;
    const gz = 2.3;
    b.add(new CylinderGeometry(0.22, 0.22, 0.12, 20), M.yellow, { position: [gx, 0.24, gz], rotation: [Math.PI / 2, 0, 0] });
    b.box(M.column, 0.3, 0.2, 0.2, gx, 0.1, gz, { uvTile: 1 });
    cable(b, N.green, [[gx + 0.1, 0.2, gz - 0.05], [gx + 0.5, 0.01, gz - 0.9], [-3.6, 0.01, 0.6], [-3.25, 0.25, -0.05]], 0.012);
    // maintenance platform on the east side of the hull
    platform(new Place(b, 9.3, -7.6, 0), N, M);
    boxC(8.65, 9.95, -8.95, -6.25, 3.2);
    // rolling tool cabinet + bits on top, west side
    toolCart(new Place(b, -9.5, -6.8, 0.4), N, M, rand);
    circC(-9.5, -6.8, 0.6);
    // tripod work lights
    for (const [x, z, ry] of [[-9.3, 6.9, 0.6], [5.6, -10.6, -2.4]]) {
      workLight(new Place(b, x, z, ry), M, glow);
      circC(x, z, 0.45);
    }
    // drip tray under the ground power unit, and its stain
    b.box(M.black, 1.0, 0.04, 1.6, -8.2, 0.02, 1.5, { uvTile: 1 });
    stain(-8.0, 1.2, 1.1, 0.55);
    stain(2.2, -6.5, 0.9, 0.3);
    // air hose from the west wall drop toward the craft, coiled at the end
    cable(b, N.hose, [[-hw + 0.5, 1.2, 4.2], [-hw + 0.9, 0.02, 4.6], [-24, 0.02, 4.0], [-18, 0.02, 3.2], [-14.5, 0.02, 2.3]], 0.022);
    coil(b, N.hose, -14.1, 2.1, 0.32, 3);
  }

  // ------------------------------------------------------------ back area: briefing corner + test bench
  {
    // rolling whiteboard + chairs (west of the boarding path)
    const P = new Place(b, -15.6, 14.6, 2.8);
    whiteboard(P, N, M);
    circC(-15.6, 14.6, 1.0);
    for (const [x, z] of [[-14.2, 12.6], [-15.4, 12.2], [-16.6, 12.4], [-13.4, 13.6]]) {
      foldingChair(new Place(b, x, z, Math.atan2(-15.6 - x, 14.6 - z)), M);
      circC(x, z, 0.3);
    }
    // test bench: two folding tables, a scope, laptops, a rolling chair
    const T = new Place(b, 7.8, 13.4, Math.PI);
    testBench(T, N, M, glow, own);
    boxC(6.0, 9.6, 12.95, 13.85, 1.0);
    circC(7.6, 14.25, 0.35);
  }

  // ------------------------------------------------------------ along the office facade
  {
    // lockers at the west end
    for (let i = 0; i < 5; i++) {
      const x = -25.7 + i * 0.47;
      b.box(N.grey, 0.45, 1.85, 0.48, x, 0.925 + 0.08, 18.7, { uvTile: 1 });
      b.box(M.column, 0.45, 0.08, 0.48, x, 0.04, 18.7, { uvTile: 1 });
      for (const y of [1.6, 1.68, 1.76]) b.box(M.black, 0.3, 0.012, 0.005, x, y, 18.457, { uvTile: 1 }); // vents
      b.box(M.chrome, 0.03, 0.12, 0.03, x + 0.17, 1.1, 18.45, { uvTile: 1 });
    }
    boxC(-25.95, -23.6, 18.4, 19, 2);
    // vending machine, water cooler, bins at the east end
    b.box(M.black, 0.95, 1.85, 0.8, 20.3, 0.925, 18.55, { uvTile: 1 });
    b.add(new PlaneGeometry(0.85, 1.7), N.vending, { position: [20.3, 0.97, 18.145], rotation: [0, Math.PI, 0] });
    const cooler = new LatheGeometry([new Vector2(0, 0), new Vector2(0.17, 0), new Vector2(0.17, 0.95), new Vector2(0.13, 0.98), new Vector2(0, 0.99)], 18);
    b.box(N.white, 0.32, 1.0, 0.32, 21.4, 0.5, 18.6, { uvTile: 1 });
    b.add(cooler.clone().scale(0.75, 0.42, 0.75), mat({ name: 'cooler_bottle', color: 0x5d8fb8, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.72 }), { position: [21.4, 1.0, 18.6] });
    for (const [x, m] of [[22.1, N.drumBlue], [22.6, N.green]]) {
      b.add(new CylinderGeometry(0.24, 0.21, 0.82, 18), m, { position: [x, 0.41, 18.65] });
      b.add(new CylinderGeometry(0.25, 0.25, 0.04, 18), M.black, { position: [x, 0.84, 18.65] });
    }
    boxC(19.8, 22.9, 18.1, 19, 2);
    // bench under the briefing window + fire alarm stations by the doors
    b.box(M.wood, 1.8, 0.05, 0.4, -16.5, 0.45, 18.6, { uvTile: 1 });
    for (const dx of [-0.8, 0.8]) b.box(M.column, 0.05, 0.44, 0.38, -16.5 + dx, 0.22, 18.6, { uvTile: 1 });
    for (const x of [-22.9, -10.9, 9.1]) {
      b.box(M.red, 0.12, 0.16, 0.05, x, 1.25, 18.88, { uvTile: 1 });
      b.box(N.white, 0.06, 0.03, 0.01, x, 1.27, 18.85, { uvTile: 1 });
    }
    // notice board between the lab windows
    const nb = new Mesh(new PlaneGeometry(1.3, 0.9), N.cork);
    nb.position.set(-12.68, 1.6, 18.86);
    nb.rotation.y = Math.PI;
    own(nb, false);
    b.box(M.officeTrim, 1.36, 0.96, 0.03, -12.68, 1.6, 18.885, { uvTile: 1 });
  }

  // ------------------------------------------------------------ walls: power, air, fire, eyewash, posters
  {
    // electrical distribution on the west wall (between the columns at z −8 and 0)
    const wx = -hw + 0.33;
    for (const [z, w, h, y] of [[-6.6, 0.9, 1.4, 1.75], [-5.4, 0.6, 0.9, 1.5], [-4.4, 0.6, 0.9, 1.5], [-3.2, 0.5, 0.6, 1.4], [-2.2, 0.8, 1.9, 1.15]]) {
      b.box(N.grey, 0.22, h, w, wx + 0.11, y, z, { uvTile: 1 });
      b.box(M.column, 0.01, h - 0.08, 0.01, wx + 0.225, y, z + w * 0.3, { uvTile: 1 }); // door seam
      b.box(M.chrome, 0.03, 0.1, 0.03, wx + 0.24, y, z - w * 0.35, { uvTile: 1 });
      // conduit up to the cable tray
      member(b, M.chrome, new Vector3(wx + 0.07, y + h / 2, z), new Vector3(wx + 0.07, 9.4, z), 0.045);
    }
    const hv = new Mesh(new PlaneGeometry(0.34, 0.24), mat({ name: 'sign_hv', map: signTexture([{ text: 'DANGER', size: 0.26 }, { text: 'HIGH VOLTAGE', size: 0.2 }, { text: '480 V', size: 0.14 }], { w: 256, h: 180, bg: '#f2f0e8', fg: '#b3261e', size: 0.2 }), roughness: 0.5 }));
    hv.position.set(wx + 0.226, 2.2, -6.6);
    hv.rotation.y = Math.PI / 2;
    own(hv, false);
    // compressed-air main along both side walls with drops + regulators at the columns
    for (const s of [-1, 1]) {
      const x = s * (hw - 0.55);
      const y = s > 0 ? 3.3 : 2.6; // west: under the video wall
      member(b, N.drumBlue, new Vector3(x, y, -23.5), new Vector3(x, y, 17), 0.07);
      for (const z of [-20, -4, 4.2, 12]) {
        if (s > 0 && z > -10 && z < 1) continue;
        member(b, N.drumBlue, new Vector3(x, y, z), new Vector3(x, 1.25, z), 0.04);
        b.add(new CylinderGeometry(0.05, 0.05, 0.16, 12), M.chrome, { position: [x, 1.18, z] });
        b.add(new SphereGeometry(0.035, 10, 8), M.black, { position: [x - s * 0.05, 1.3, z] });
      }
    }
    // fire hose cabinet (west), eyewash station (east)
    b.box(M.red, 0.25, 0.95, 0.8, -hw + 0.45, 1.35, -0.9, { uvTile: 1 });
    b.box(N.white, 0.005, 0.25, 0.6, -hw + 0.58, 1.62, -0.9, { uvTile: 1 });
    b.box(N.green, 0.2, 0.5, 0.45, hw - 0.42, 1.25, 12.6, { uvTile: 1 });
    b.add(new CylinderGeometry(0.13, 0.05, 0.12, 16), M.yellow, { position: [hw - 0.62, 1.55, 12.6] });
    const ew = new Mesh(new PlaneGeometry(0.45, 0.3), mat({ name: 'sign_eyewash', map: signTexture([{ text: 'EMERGENCY', size: 0.22 }, { text: 'EYE WASH', size: 0.3 }], { w: 256, h: 170, bg: '#1f7a3b', fg: '#ffffff', size: 0.25 }), roughness: 0.5 }));
    ew.position.set(hw - 0.33, 2.05, 12.6);
    ew.rotation.y = -Math.PI / 2;
    own(ew, false);
    // posters
    const posters = [
      [['F.O.D.', 'FOREIGN OBJECT DEBRIS', 'IF YOU DROP IT · PICK IT UP'], '#f0c419', '#111', -hw + 0.34, 2.3, -10.8, Math.PI / 2],
      [['OPSEC', 'WHAT YOU SEE HERE', 'STAYS HERE'], '#18222b', '#e8e4d8', -hw + 0.34, 2.3, -14.0, Math.PI / 2],
      [['HEARING', 'PROTECTION', 'REQUIRED BEYOND THIS POINT'], '#1d5fa8', '#ffffff', hw - 0.34, 2.4, 15.9, -Math.PI / 2],
      [['NO', 'SMOKING', 'WITHIN 50 FT OF CRAFT'], '#b3261e', '#ffffff', 25.2, 2.6, 18.89, Math.PI],
      [['DRIVE ENERGIZED', 'WHEN BEACONS TURN', 'STAY OUTSIDE THE RED RING'], '#e8e4d8', '#b3261e', -22.4, 2.4, -hd + 1.52, 0],
      [['PROJECT', 'GALILEO', 'SAFETY FIRST · ALWAYS'], '#24323b', '#d9a514', 22.4, 2.4, -hd + 1.52, 0],
    ];
    for (const [lines, bg, fg, x, y, z, ry] of posters) {
      const tex = signTexture([{ text: lines[0], size: 0.17 }, { text: lines[1], size: 0.13 }, { text: lines[2], size: 0.055 }], { w: 384, h: 512, bg, fg, size: 0.1 });
      const m = new Mesh(new PlaneGeometry(0.62, 0.83), mat({ name: 'poster', map: tex, roughness: 0.6 }));
      m.position.set(x, y, z);
      m.rotation.y = ry;
      own(m, false);
    }
    // CCTV domes and alarm horns high on the columns
    for (const s of [-1, 1]) {
      for (const z of [-16, 0, 16]) {
        const x = s * (hw - 0.62);
        ob.box(N.white, 0.2, 0.14, 0.14, x, 8.2, z, { uvTile: 1 });
        ob.add(new SphereGeometry(0.07, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), M.plastic, { position: [x - s * 0.04, 8.13, z], rotation: [Math.PI, 0, 0] });
        ob.add(new CylinderGeometry(0.12, 0.04, 0.25, 14, 1, true), N.grey, { position: [x - s * 0.05, 9.2, z], rotation: [0, 0, s * Math.PI / 2] });
      }
    }
    // wall exhaust fans, high up
    for (const s of [-1, 1]) {
      for (const z of [-12, 4]) {
        const x = s * (hw - 0.28);
        ob.box(N.grey, 0.3, 1.3, 1.3, x, 11.2, z, { uvTile: 1 });
        for (let k = 0; k < 6; k++) ob.box(M.column, 0.06, 0.03, 1.15, x - s * 0.16, 10.65 + k * 0.21, z, { rotation: [s * 0.5, 0, 0], uvTile: 1 });
      }
    }
  }

  // ------------------------------------------------------------ overhead: ducts, fans, beacons, clocks, flag
  {
    // spiral ducts down both sides of the bay, on hangers from the trusses, with drop diffusers
    for (const x of [-22, 22]) {
      ob.add(new CylinderGeometry(0.45, 0.45, 41, 28, 1, true), N.galv, { position: [x, 13.5, -3.5], rotation: [Math.PI / 2, 0, 0] });
      for (const z of [-24, 17]) ob.add(new CylinderGeometry(0.46, 0.46, 0.04, 28), N.galv, { position: [x, 13.5, z], rotation: [Math.PI / 2, 0, 0] });
      for (let z = -21; z <= 15; z += 6) {
        ob.add(new TorusGeometry(0.47, 0.025, 6, 28), M.column, { position: [x, 13.5, z], rotation: [0, 0, 0] });
        member(ob, M.column, new Vector3(x, 13.97, z), new Vector3(x, 14.4, z), 0.02);
      }
      for (const z of [-19, -9, 1, 16]) {
        ob.add(new CylinderGeometry(0.22, 0.22, 0.5, 18), N.galv, { position: [x, 12.9, z] });
        ob.add(new CylinderGeometry(0.4, 0.24, 0.12, 18), N.galv, { position: [x, 12.62, z] });
      }
    }
    // HVLS fans (they turn, so they're their own objects)
    const fanMat = mat({ name: 'fan_blade', color: 0x3b3f44, roughness: 0.35, metalness: 0.6 });
    const hubMat = mat({ name: 'fan_hub', color: 0xd9a514, roughness: 0.4, metalness: 0.3 });
    for (const [x, z, spd] of [[-7.5, -8, 0.55], [7.5, -8, -0.5], [0, 8, 0.6]]) {
      const g = new Group();
      g.position.set(x, 13.35, z);
      const fb = new Batcher();
      fb.add(new CylinderGeometry(0.36, 0.42, 0.3, 24), hubMat, { position: [0, 0.05, 0] });
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const blade = new BoxGeometry(3.15, 0.025, 0.26);
        blade.rotateX(0.08);
        blade.translate(1.95, 0, 0);
        fb.add(blade, fanMat, { rotation: [0, a, 0] });
        fb.add(new BoxGeometry(0.06, 0.05, 0.3), fanMat, { position: [Math.cos(a) * 3.5, 0, -Math.sin(a) * 3.5], rotation: [0, a, 0] }); // winglet
      }
      for (const m of fb.build({ name: 'fan' })) {
        m.userData.noKeyShadow = true;
        g.add(m);
      }
      hangar.group.add(g);
      // downrod + motor stay still
      ob.add(new CylinderGeometry(0.05, 0.05, 0.85, 10), M.column, { position: [x, 13.95, z] });
      ob.add(new CylinderGeometry(0.28, 0.28, 0.32, 20), M.column, { position: [x, 13.6, z] });
      anim.fans.push({ g, spd });
    }
    // rotating beacons on the door jambs (they turn while the drive is energised)
    for (const x of [-20.6, 20.6]) {
      ob.add(new CylinderGeometry(0.11, 0.13, 0.08, 16), M.column, { position: [x, 13.32, -hd + 0.75] });
      const dome = new Mesh(new SphereGeometry(0.11, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), new MeshStandardMaterial({ color: 0xffa21a, roughness: 0.15, transparent: true, opacity: 0.55, emissive: new Color(1.0, 0.5, 0.05), emissiveIntensity: 0.2, depthWrite: false }));
      dome.position.set(x, 13.36, -hd + 0.75);
      hangar.group.add(dome);
      const rot = new Group();
      rot.position.copy(dome.position);
      const lamp = new Mesh(new BoxGeometry(0.03, 0.06, 0.14), glow(6, 2.6, 0.3));
      lamp.position.set(0.04, 0.05, 0);
      rot.add(lamp);
      hangar.group.add(rot);
      anim.beacons.push({ rot, dome, lamp });
    }
    // two clocks above the video wall: local and Zulu
    for (const [z, label, offset] of [[5.2, 'LOCAL', 0], [11.8, 'ZULU', 7]]) {
      ob.add(new CylinderGeometry(0.4, 0.4, 0.07, 40), M.black, { position: [-hw + 0.36, 10.6, z], rotation: [0, 0, Math.PI / 2] });
      const face = new Mesh(new CircleGeometry(0.37, 40), mat({ name: 'clock_face', map: clockTexture(label), roughness: 0.3 }));
      face.rotation.y = Math.PI / 2;
      face.position.set(-hw + 0.402, 10.6, z);
      own(face, false);
      const hands = [];
      for (const [len, wid] of [[0.22, 0.022], [0.31, 0.014], [0.33, 0.006]]) {
        const piv = new Group();
        piv.position.set(-hw + 0.415, 10.6, z);
        const hand = new Mesh(new BoxGeometry(0.004, len, wid), wid < 0.01 ? glow(1.4, 0.15, 0.1) : M.black);
        hand.position.y = len / 2 - 0.04;
        piv.add(hand);
        hangar.group.add(piv);
        hands.push(piv);
      }
      anim.hands.push({ hands, offset });
    }
    // flag on the east wall, above the tool area
    const flag = new Mesh(new PlaneGeometry(7.6, 4.0, 24, 1), mat({ name: 'flag', map: flagTexture(), roughness: 0.85, side: DoubleSide }));
    const fp = flag.geometry.attributes.position;
    for (let i = 0; i < fp.count; i++) fp.setZ(i, Math.sin(fp.getX(i) * 2.1) * 0.05); // hangs in soft folds
    flag.geometry.computeVertexNormals();
    flag.position.set(hw - 0.66, 6.9, 9.6);
    flag.rotation.y = -Math.PI / 2;
    own(flag, false);
  }

  // ------------------------------------------------------------ floor: trench drain, tie-downs, stains
  {
    b.box(M.column, 38.4, 0.02, 0.42, 0, 0.0, -22.6, { uvTile: 1 });
    b.add(new PlaneGeometry(38, 0.34), N.grate, { position: [0, 0.012, -22.6], rotation: [-Math.PI / 2, 0, 0], uvTile: 0.3 });
    for (let x = -16; x <= 16; x += 8) {
      for (const z of [-14, 10]) {
        b.add(new TorusGeometry(0.06, 0.012, 6, 16), M.chrome, { position: [x, 0.006, z], rotation: [-Math.PI / 2, 0, 0] });
      }
    }
    for (const [x, z, r, k] of [[-4.5, -15, 0.7, 0.25], [13.5, 2, 1.2, 0.2], [-14, -3, 0.9, 0.25], [24.5, -19, 1.5, 0.3], [-25, -6, 1.0, 0.3], [27.2, 8.6, 0.8, 0.35]]) stain(x, z, r, k);
  }

  for (const m of ob.build({ name: 'overhead' })) {
    m.userData.noKeyShadow = true;
    hangar.group.add(m);
  }

  return {
    update(dt, t, live) {
      anim.t += dt;
      for (const f of anim.fans) f.g.rotation.y += f.spd * dt;
      const energised = (live?.power ?? 0) > 0.05;
      for (const bc of anim.beacons) {
        bc.rot.rotation.y += (energised ? 9 : 0) * dt;
        bc.lamp.visible = energised;
        bc.dome.material.emissiveIntensity = energised ? 1.6 : 0.15;
      }
      // clock hands from the shift clock string (HH:MM:SS, local)
      const m = /^(\d\d):(\d\d):(\d\d)/.exec(live?.clock || '');
      if (m) {
        for (const c of anim.hands) {
          const hh = (+m[1] + c.offset) % 12;
          const mm = +m[2];
          const ss = +m[3];
          const angles = [((hh + mm / 60) / 12) * Math.PI * 2, ((mm + ss / 60) / 60) * Math.PI * 2, (ss / 60) * Math.PI * 2];
          c.hands.forEach((h, i) => (h.rotation.x = -angles[i]));
        }
      }
    },
  };
}

// ============================================================== prop builders

function palletLoad(b, N, M, rand, x, y, z, maxH) {
  // pallet: deck boards on three stringers, long side along z
  b.box(M.wood, 1.0, 0.022, 1.2, x, y + 0.133, z, { uvTile: 1 });
  for (const dx of [-0.42, 0, 0.42]) b.box(M.wood, 0.1, 0.1, 1.2, x + dx, y + 0.072, z, { uvTile: 1 });
  b.box(M.wood, 1.0, 0.022, 1.2, x, y + 0.011, z, { uvTile: 1 });
  const top = y + 0.144;
  const r = rand();
  if (r < 0.38) {
    // stacked cartons
    const h = 0.32 + rand() * 0.12;
    const rows = Math.max(1, Math.floor((maxH - 0.15) / h) - (rand() < 0.35 ? 1 : 0));
    for (let k = 0; k < rows; k++) {
      for (const [dx, dz] of [[-0.24, -0.29], [0.24, -0.29], [-0.24, 0.29], [0.24, 0.29]]) {
        if (k === rows - 1 && rand() < 0.25) continue;
        b.add(new BoxGeometry(0.46, h, 0.56), N.cardboard, { position: [x + dx, top + h * (k + 0.5), z + dz], rotation: [0, (rand() - 0.5) * 0.05, 0] });
      }
    }
  } else if (r < 0.6) {
    // shrink-wrapped block
    const h = 0.85 + rand() * (maxH - 1.05);
    b.add(new RoundedBoxGeometry(0.98, h, 1.18, 2, 0.04), N.wrap, { position: [x, top + h / 2, z] });
  } else if (r < 0.78) {
    // four drums
    const m = rand() < 0.5 ? N.drumBlue : N.drumGrey;
    for (const [dx, dz] of [[-0.25, -0.3], [0.25, -0.3], [-0.25, 0.3], [0.25, 0.3]]) drum(b, m, M, x + dx, top, z + dz, rand);
  } else if (r < 0.92) {
    // a long wooden crate with stencils
    const h = 0.6 + rand() * (maxH - 0.85);
    b.box(M.crate, 0.96, h, 1.16, x, top + h / 2, z, { uvTile: 1 });
    for (const dz of [-0.5, 0, 0.5]) b.box(M.wood, 1.0, h + 0.02, 0.06, x, top + h / 2, z + dz, { uvTile: 1 });
  } else {
    // grey component container
    b.add(new RoundedBoxGeometry(0.9, 0.55, 1.1, 2, 0.05), N.drumGrey, { position: [x, top + 0.275, z] });
    for (const dz of [-0.35, 0.35]) b.box(M.chrome, 0.02, 0.04, 0.12, x - 0.46, top + 0.45, z + dz, { uvTile: 1 });
  }
}

function drum(b, m, M, x, y, z, rand) {
  const h = 0.88;
  b.add(new CylinderGeometry(0.29, 0.29, h, 22), m, { position: [x, y + h / 2, z], rotation: [0, rand() * 6, 0] });
  for (const k of [0.3, 0.62]) b.add(new TorusGeometry(0.292, 0.012, 6, 22), m, { position: [x, y + h * k, z], rotation: [Math.PI / 2, 0, 0] });
  b.add(new TorusGeometry(0.28, 0.016, 6, 22), m, { position: [x, y + h, z], rotation: [Math.PI / 2, 0, 0] });
  b.add(new CylinderGeometry(0.03, 0.03, 0.02, 10), M.chrome, { position: [x + 0.16, y + h + 0.01, z + 0.08] });
}

/** A sagging chain between two posts (yellow/black links reduced to a striped bar). */
function chain(b, M, a, c, y, sag) {
  const n = 6;
  let prev = null;
  for (let i = 0; i <= n; i++) {
    const k = i / n;
    const p = new Vector3().lerpVectors(a, c, k);
    p.y = y - Math.sin(k * Math.PI) * sag;
    if (prev) member(b, i % 2 ? M.yellow : M.black, prev, p, 0.025);
    prev = p;
  }
}

/** A cable or hose through control points (lying on the floor where y ≈ 0). */
function cable(b, m, pts, size) {
  const v = pts.map((p) => new Vector3(p[0], p[1] + size / 2, p[2]));
  for (let i = 0; i < v.length - 1; i++) {
    const n = 4;
    for (let k = 0; k < n; k++) {
      const p0 = catmull(v, i, k / n);
      const p1 = catmull(v, i, (k + 1) / n);
      member(b, m, p0, p1, size);
    }
  }
}

function catmull(v, i, t) {
  const p0 = v[Math.max(0, i - 1)];
  const p1 = v[i];
  const p2 = v[i + 1];
  const p3 = v[Math.min(v.length - 1, i + 2)];
  const t2 = t * t;
  const t3 = t2 * t;
  const f = (a, b2, c, d) => 0.5 * (2 * b2 + (-a + c) * t + (2 * a - 5 * b2 + 4 * c - d) * t2 + (-a + 3 * b2 - 3 * c + d) * t3);
  return new Vector3(f(p0.x, p1.x, p2.x, p3.x), f(p0.y, p1.y, p2.y, p3.y), f(p0.z, p1.z, p2.z, p3.z));
}

function coil(b, m, x, z, r, turns) {
  for (let k = 0; k < turns; k++) b.add(new TorusGeometry(r - k * 0.05, 0.02, 6, 28), m, { position: [x, 0.02 + k * 0.035, z], rotation: [-Math.PI / 2, 0, 0] });
}

let _stainTex = null;
/** Soft dark floor stain (oil / hydraulic fluid), a decal over the epoxy. */
function stainMaterial(k) {
  if (!_stainTex) {
    _stainTex = canvasTexture(256, 256, (g, w, h) => {
      const rnd = mulberry32(77);
      g.clearRect(0, 0, w, h);
      for (let i = 0; i < 26; i++) {
        const cx = w / 2 + (rnd() - 0.5) * w * 0.5;
        const cy = h / 2 + (rnd() - 0.5) * h * 0.5;
        const rr = w * (0.08 + rnd() * 0.2);
        const gr = g.createRadialGradient(cx, cy, 0, cx, cy, rr);
        gr.addColorStop(0, 'rgba(12,10,8,0.32)');
        gr.addColorStop(1, 'rgba(12,10,8,0)');
        g.fillStyle = gr;
        g.fillRect(0, 0, w, h);
      }
    });
  }
  return new MeshStandardMaterial({ map: _stainTex, transparent: true, opacity: Math.min(1, k * 2.4), roughness: 0.2, metalness: 0, depthWrite: false });
}

function forklift(P, N, M) {
  const Y = M.yellow;
  // chassis (forks toward local +x)
  P.rbox(Y, 1.75, 0.62, 1.08, -0.1, 0.62, 0, 0.06);
  P.rbox(M.column, 0.5, 0.78, 1.12, -1.05, 0.72, 0, 0.08); // counterweight
  P.box(M.black, 1.6, 0.06, 1.12, -0.1, 0.95, 0, undefined, 1);
  for (const [x, r] of [[0.5, 0.33], [-0.75, 0.27]]) {
    for (const z of [-0.47, 0.47]) {
      P.wheel(N.tread, r, 0.24, x, r, z);
      P.wheel(M.chrome, r * 0.55, 0.25, x, r, z);
    }
  }
  // overhead guard
  for (const [x, z] of [[0.38, -0.48], [0.38, 0.48], [-0.7, -0.48], [-0.7, 0.48]]) P.bar(M.black, [x, 0.95, z], [x, 2.15, z], 0.055);
  P.box(M.black, 1.12, 0.05, 1.0, -0.16, 2.17, 0, undefined, 1);
  for (let k = -2; k <= 2; k++) P.box(M.black, 1.05, 0.04, 0.04, -0.16, 2.2, k * 0.2, undefined, 1);
  // seat, steering, controls
  P.rbox(M.black, 0.48, 0.12, 0.46, -0.42, 1.05, 0, 0.04);
  P.rbox(M.black, 0.1, 0.5, 0.44, -0.66, 1.33, 0, 0.04, [0, 0, -0.15]);
  P.add(steeringWheel(0.17), M.black, [0.12, 1.52, 0]);
  P.bar(M.black, [0.2, 1.0, 0], [0.12, 1.5, 0], 0.04);
  for (const z of [-0.12, 0, 0.12]) P.bar(M.black, [0.32, 1.0, z], [0.28, 1.28, z], 0.018);
  // LPG bottle on the back
  P.cyl(N.tank, 0.16, 0.16, 0.78, -0.98, 1.38, 0, [Math.PI / 2, 0, 0], 16);
  // mast, carriage, forks
  for (const z of [-0.34, 0.34]) P.box(M.column, 0.1, 2.35, 0.12, 0.9, 1.25, z, undefined, 1);
  P.box(M.column, 0.1, 0.1, 0.8, 0.9, 2.38, 0, undefined, 1);
  P.box(M.column, 0.1, 0.1, 0.8, 0.9, 0.3, 0, undefined, 1);
  P.cyl(M.chrome, 0.045, 0.045, 1.7, 0.86, 1.1, 0, undefined, 10);
  P.box(M.black, 0.06, 0.55, 1.0, 1.0, 0.42, 0, undefined, 1);
  for (let k = -3; k <= 3; k++) P.box(M.black, 0.03, 0.5, 0.025, 1.04, 0.52, k * 0.14, undefined, 1);
  for (const z of [-0.3, 0.3]) {
    P.box(M.column, 1.1, 0.045, 0.12, 1.6, 0.045, z, undefined, 1);
    P.box(M.column, 0.05, 0.5, 0.12, 1.04, 0.27, z, undefined, 1);
  }
  // work lights and an amber beacon on the guard
  for (const z of [-0.42, 0.42]) P.box(M.chrome, 0.08, 0.08, 0.1, 0.4, 2.25, z, undefined, 1);
  P.cyl(N.rackOrange, 0.06, 0.07, 0.1, -0.6, 2.25, 0, undefined, 12);
}

function steeringWheel(r) {
  const g = new TorusGeometry(r, 0.018, 8, 24);
  g.rotateY(Math.PI / 2);
  g.rotateZ(0.55);
  return g;
}

function scissorLift(P, N, M) {
  const O = N.rackOrange;
  P.rbox(O, 2.3, 0.32, 1.12, 0, 0.28, 0, 0.04);
  P.box(M.black, 2.0, 0.05, 0.9, 0, 0.12, 0, undefined, 1);
  for (const x of [-0.82, 0.82]) for (const z of [-0.5, 0.5]) P.wheel(N.tread, 0.16, 0.14, x, 0.16, z, 16);
  // folded scissor stack
  for (const z of [-0.5, 0.5]) {
    for (let k = 0; k < 3; k++) {
      const y0 = 0.48 + k * 0.17;
      P.bar(M.column, [-1.0, y0, z], [1.0, y0 + 0.17, z], 0.06);
      P.bar(M.column, [-1.0, y0 + 0.17, z], [1.0, y0, z], 0.06);
    }
  }
  P.box(O, 2.45, 0.1, 1.15, 0, 1.06, 0, undefined, 1);
  P.box(M.black, 2.4, 0.012, 1.1, 0, 1.115, 0, undefined, 1);
  // guardrails (folded down for stowage, so low)
  for (const [x, z] of [[-1.2, -0.55], [1.2, -0.55], [-1.2, 0.55], [1.2, 0.55], [0, -0.55], [0, 0.55]]) P.bar(O, [x, 1.1, z], [x, 2.05, z], 0.04);
  for (const z of [-0.55, 0.55]) {
    P.bar(O, [-1.2, 2.05, z], [1.2, 2.05, z], 0.045);
    P.bar(O, [-1.2, 1.6, z], [1.2, 1.6, z], 0.035);
  }
  for (const x of [-1.2, 1.2]) P.bar(O, [x, 2.05, -0.55], [x, 2.05, 0.55], 0.045);
  P.box(M.black, 0.25, 0.3, 0.12, 0.9, 1.85, 0.62, undefined, 1); // control box
  P.box(M.red, 0.04, 0.04, 0.02, 0.9, 1.95, 0.69, undefined, 1);
}

function testStand(P, N, M, glow) {
  // fixture: heavy plate on a yellow cradle
  P.box(M.yellow, 2.6, 0.18, 2.6, 0, 0.55, 0, undefined, 1);
  for (const x of [-1.15, 1.15]) for (const z of [-1.15, 1.15]) {
    P.box(M.yellow, 0.16, 0.46, 0.16, x, 0.23, z, undefined, 1);
    P.box(M.column, 0.3, 0.03, 0.3, x, 0.015, z, undefined, 1);
  }
  for (const x of [-1.15, 1.15]) P.bar(M.yellow, [x, 0.25, -1.15], [x, 0.25, 1.15], 0.1);
  P.box(M.column, 2.3, 0.06, 2.3, 0, 0.67, 0, undefined, 1);
  // the article: base drum, copper-wound core, three wave guides
  P.cyl(N.module, 0.95, 1.0, 0.5, 0, 0.95, 0, undefined, 40);
  for (let k = 0; k < 5; k++) P.cyl(N.copper, 0.66, 0.66, 0.06, 0, 1.25 + k * 0.1, 0, undefined, 36);
  P.cyl(N.module, 0.6, 0.6, 0.55, 0, 1.47, 0, undefined, 36);
  P.add(new SphereGeometry(0.6, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), N.copper, [0, 1.74, 0]);
  P.cyl(M.chrome, 0.08, 0.08, 0.35, 0, 2.45, 0, undefined, 14);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    const dx = Math.sin(a);
    const dz = Math.cos(a);
    P.add(new CylinderGeometry(0.13, 0.13, 0.9, 18), N.module, [dx * 1.2, 1.05, dz * 1.2], [Math.PI / 2, a, 0]);
    P.add(new CylinderGeometry(0.17, 0.17, 0.08, 18), N.copper, [dx * 1.62, 1.05, dz * 1.62], [Math.PI / 2, a, 0]);
    P.add(new CylinderGeometry(0.1, 0.1, 0.02, 18), glow(0.5, 1.4, 2.2), [dx * 1.665, 1.05, dz * 1.665], [Math.PI / 2, a, 0]);
  }
  // sensor bundle + bolted flanges
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    P.cyl(M.chrome, 0.025, 0.025, 0.04, Math.sin(a) * 0.9, 1.21, Math.cos(a) * 0.9, undefined, 8);
  }
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + 0.4;
    P.box(M.black, 0.12, 0.08, 0.06, Math.sin(a) * 0.62, 1.6, Math.cos(a) * 0.62, [0, a, 0], 1);
  }
}

function instrumentRack(P, N, M, glow, own) {
  P.box(M.plastic, 0.62, 1.55, 0.7, 0, 0.88, 0, undefined, 1);
  for (const x of [-0.24, 0.24]) for (const z of [-0.27, 0.27]) {
    P.cyl(M.black, 0.045, 0.045, 0.04, x, 0.05, z, [Math.PI / 2, 0, 0], 10);
    P.box(M.column, 0.06, 0.06, 0.06, x, 0.1, z, undefined, 1);
  }
  // rack units: faceplates, knobs, LED strips
  for (let k = 0; k < 6; k++) {
    const y = 0.35 + k * 0.22;
    P.box(k % 2 ? N.grey : M.column, 0.58, 0.19, 0.02, 0, y, 0.355, undefined, 1);
    for (let j = 0; j < 4; j++) P.cyl(M.chrome, 0.012, 0.012, 0.02, -0.2 + j * 0.06, y, 0.37, [Math.PI / 2, 0, 0], 8);
    P.box(glow(k % 3 ? 0.2 : 2.2, k % 3 ? 2.0 : 0.6, 0.3), 0.12, 0.012, 0.005, 0.18, y + 0.05, 0.368, undefined, 1);
  }
  // scope screen
  const scr = new Mesh(new PlaneGeometry(0.34, 0.2), new MeshBasicMaterial({ map: scopeTexture(), color: new Color(1.6, 1.6, 1.6) }));
  const p = P.p([0, 1.42, 0.366]);
  scr.position.copy(p);
  scr.quaternion.setFromRotationMatrix(P.m);
  own(scr, false);
}

function tug(P, N, M, glow) {
  const Y = M.yellow;
  P.rbox(Y, 3.0, 0.62, 1.7, 0, 0.62, 0, 0.08);
  P.rbox(M.column, 0.7, 0.4, 1.72, 1.3, 0.62, 0, 0.06); // front bumper/weight
  for (const x of [-0.95, 0.95]) for (const z of [-0.78, 0.78]) {
    P.wheel(N.tread, 0.36, 0.3, x, 0.36, z, 22);
    P.wheel(M.chrome, 0.2, 0.31, x, 0.36, z, 16);
  }
  P.rbox(M.black, 0.5, 0.12, 0.5, -0.6, 1.0, 0.35, 0.04);
  P.rbox(M.black, 0.1, 0.5, 0.5, -0.85, 1.28, 0.35, 0.04);
  P.add(steeringWheel(0.18), M.black, [-0.15, 1.3, 0.35]);
  P.bar(M.black, [-0.05, 0.93, 0.35], [-0.15, 1.28, 0.35], 0.04);
  P.box(M.black, 0.3, 0.05, 0.2, -1.55, 0.45, 0, undefined, 1); // pintle hitch
  P.cyl(M.chrome, 0.04, 0.04, 0.15, -1.62, 0.52, 0, undefined, 10);
  P.bar(M.black, [-1.2, 0.93, -0.7], [-1.2, 1.9, -0.7], 0.04);
  P.cyl(N.rackOrange, 0.07, 0.08, 0.12, -1.2, 1.96, -0.7, undefined, 12);
  P.box(M.black, 0.6, 0.1, 0.02, 1.66, 0.64, 0, undefined, 1); // grille
  for (const z of [-0.6, 0.6]) P.box(glow(2.2, 2.1, 1.8), 0.02, 0.08, 0.14, 1.66, 0.75, z, undefined, 1);
}

function platform(P, N, M) {
  const Y = M.yellow;
  // two-level rolling work stand: deck at 2.0 m with handrails, stairs on the aft end
  for (const [x, z] of [[-0.6, -1.3], [0.6, -1.3], [-0.6, 0.0], [0.6, 0.0]]) {
    P.box(Y, 0.08, 2.0, 0.08, x, 1.0, z, undefined, 1);
    P.wheel(N.tread, 0.08, 0.06, x, 0.08, z, 12);
  }
  P.box(Y, 1.3, 0.06, 1.4, 0, 2.0, -0.65, undefined, 1);
  P.add(new PlaneGeometry(1.25, 1.35), N.grate, [0, 2.035, -0.65], [-Math.PI / 2, 0, 0], 0.35);
  for (const y of [0.6, 1.3]) {
    P.bar(Y, [-0.6, y, -1.3], [0.6, y, -1.3], 0.05);
    P.bar(Y, [-0.6, y, -1.3], [-0.6, y, 0], 0.05);
    P.bar(Y, [0.6, y, -1.3], [0.6, y, 0], 0.05);
  }
  // rails on three sides (open toward the hull, −x)
  for (const [x, z] of [[0.62, -1.32], [0.62, 0.02], [-0.62, -1.32], [-0.62, 0.02]]) P.bar(Y, [x, 2.03, z], [x, 3.1, z], 0.045);
  P.bar(Y, [0.62, 3.1, -1.32], [0.62, 3.1, 0.02], 0.05);
  P.bar(Y, [0.62, 2.6, -1.32], [0.62, 2.6, 0.02], 0.04);
  P.bar(Y, [-0.62, 3.1, -1.32], [0.62, 3.1, -1.32], 0.05);
  // stairs down to +z
  for (let i = 0; i < 8; i++) {
    const y = 0.25 + i * 0.235;
    const z = 1.35 - i * 0.17;
    P.box(M.column, 1.0, 0.04, 0.24, 0, y, z, undefined, 1);
  }
  for (const x of [-0.52, 0.52]) {
    P.bar(Y, [x, 0.1, 1.45], [x, 2.0, 0.0], 0.06);
    P.bar(Y, [x, 1.0, 1.45], [x, 3.0, 0.02], 0.04);
  }
}

function toolCart(P, N, M, rand) {
  P.rbox(M.red, 0.62, 0.86, 1.02, 0, 0.55, 0, 0.02);
  for (let k = 0; k < 5; k++) P.box(M.chrome, 0.01, 0.015, 0.8, 0.315, 0.3 + k * 0.15, 0, undefined, 1);
  for (const x of [-0.24, 0.24]) for (const z of [-0.42, 0.42]) P.wheel(M.black, 0.055, 0.04, x, 0.06, z, 12);
  P.bar(M.chrome, [0.0, 1.05, -0.58], [0.0, 1.05, 0.58], 0.025);
  P.box(M.black, 0.6, 0.02, 1.0, 0, 0.99, 0, undefined, 1); // mat
  // tools on top: wrenches, a driver, a torque wrench, a cordless drill, a mug
  for (let k = 0; k < 6; k++) P.box(M.chrome, 0.03, 0.012, 0.18 + k * 0.03, -0.18 + k * 0.05, 1.01, -0.2 + (rand() - 0.5) * 0.1, [0, (rand() - 0.5) * 0.3, 0], 1);
  P.box(M.chrome, 0.025, 0.02, 0.5, 0.15, 1.01, 0.22, [0, 0.4, 0], 1);
  P.rbox(M.yellow, 0.07, 0.18, 0.22, 0.1, 1.09, -0.32, 0.02);
  P.rbox(M.black, 0.06, 0.08, 0.08, 0.1, 1.05, -0.2, 0.02);
  P.add(new CylinderGeometry(0.04, 0.035, 0.1, 14), M.office, [-0.2, 1.05, 0.33]);
}

function workLight(P, M, glow) {
  // tripod with a twin LED head
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    P.bar(M.yellow, [0, 0.75, 0], [Math.sin(a) * 0.45, 0, Math.cos(a) * 0.45], 0.025);
  }
  P.bar(M.yellow, [0, 0.7, 0], [0, 1.85, 0], 0.035);
  P.bar(M.black, [-0.28, 1.85, 0], [0.28, 1.85, 0], 0.03);
  for (const x of [-0.22, 0.22]) {
    P.box(M.yellow, 0.26, 0.2, 0.08, x, 1.95, 0.04, [0.35, 0, 0], 1);
    P.box(glow(5, 4.8, 4.4), 0.22, 0.16, 0.005, x, 1.95, 0.083, [0.35, 0, 0], 1);
  }
}

function whiteboard(P, N, M) {
  P.add(new PlaneGeometry(1.8, 1.1), N.board, [0, 1.45, 0.026], [0, 0, 0]);
  P.box(M.chrome, 1.86, 1.16, 0.04, 0, 1.45, 0, undefined, 1);
  P.box(M.chrome, 1.4, 0.03, 0.08, 0, 0.87, 0.05, undefined, 1); // marker tray
  for (const x of [-0.95, 0.95]) {
    P.bar(M.chrome, [x, 0.08, 0], [x, 2.05, 0], 0.035);
    P.bar(M.chrome, [x, 0.08, -0.35], [x, 0.08, 0.35], 0.035);
    for (const z of [-0.33, 0.33]) P.wheel(M.black, 0.04, 0.03, x, 0.04, z, 10);
  }
  for (const [x, c] of [[-0.3, M.red], [-0.15, M.black], [0.0, N.drumBlue]]) P.cyl(c, 0.008, 0.008, 0.12, x, 0.9, 0.07, [0, 0, Math.PI / 2], 6);
}

function foldingChair(P, M) {
  P.box(M.column, 0.42, 0.03, 0.4, 0, 0.45, 0, undefined, 1);
  P.box(M.column, 0.42, 0.28, 0.025, 0, 0.78, -0.2, [-0.1, 0, 0], 1);
  for (const x of [-0.2, 0.2]) {
    P.bar(M.chrome, [x, 0.0, 0.18], [x, 0.9, -0.22], 0.02);
    P.bar(M.chrome, [x, 0.0, -0.2], [x, 0.45, 0.12], 0.02);
  }
}

function testBench(P, N, M, glow, own) {
  for (const x of [-0.9, 0.9]) {
    P.box(N.white, 1.75, 0.04, 0.78, x, 0.74, 0, undefined, 1);
    for (const [dx, dz] of [[-0.8, -0.34], [0.8, -0.34], [-0.8, 0.34], [0.8, 0.34]]) P.bar(M.column, [x + dx, 0, dz], [x + dx, 0.72, dz], 0.03);
  }
  // oscilloscope, a power supply, two laptops, a coil of cable, cups
  P.rbox(N.grey, 0.36, 0.2, 0.3, -1.2, 0.86, 0.12, 0.02);
  P.rbox(M.plastic, 0.3, 0.14, 0.26, -0.6, 0.83, 0.15, 0.015);
  for (let k = 0; k < 3; k++) P.cyl(k ? M.black : M.red, 0.012, 0.012, 0.02, -0.68 + k * 0.08, 0.84, 0.02, [Math.PI / 2, 0, 0], 8);
  const lid = [];
  for (const [x, a] of [[0.35, 0.15], [1.15, -0.2]]) {
    P.box(M.plastic, 0.34, 0.015, 0.24, x, 0.768, 0.05, [0, a, 0], 1);
    const lx = x + Math.sin(a) * 0.12;
    const lz = 0.05 + Math.cos(a) * 0.12;
    P.box(M.plastic, 0.34, 0.22, 0.012, lx, 0.88, lz, [0.25, a, 0], 1);
    lid.push([lx - Math.sin(a) * 0.008, 0.882, lz - Math.cos(a) * 0.008, 0.3, 0.18, 0.25, a]);
  }
  const scrMat = new MeshBasicMaterial({ map: scopeTexture(), color: new Color(1.4, 1.4, 1.4) });
  for (const [x, y, z, w, h, rx, ry] of [[-1.2, 0.87, -0.032, 0.22, 0.12, 0, 0], ...lid]) {
    const s = new Mesh(new PlaneGeometry(w, h), scrMat);
    const p = P.p([x, y, z]);
    s.position.copy(p);
    s.quaternion.setFromRotationMatrix(P.m).multiply(new Quaternion().setFromEuler(new Euler(rx, ry + Math.PI, 0)));
    own(s, false);
  }
  P.add(new TorusGeometry(0.1, 0.012, 6, 20), M.black, [-0.2, 0.775, -0.15], [-Math.PI / 2, 0, 0]);
  P.add(new CylinderGeometry(0.04, 0.035, 0.1, 14), M.office, [0.8, 0.81, 0.25]);
  // rolling task chair
  P.cyl(M.chrome, 0.025, 0.025, 0.38, 0.2, 0.26, -0.85, undefined, 10);
  P.rbox(M.black, 0.48, 0.08, 0.46, 0.2, 0.48, -0.85, 0.03);
  P.rbox(M.black, 0.44, 0.5, 0.07, 0.2, 0.82, -1.06, 0.03);
}

// ============================================================== textures

function cardboardTexture() {
  return canvasTexture(256, 256, (g, w, h) => {
    const rnd = mulberry32(31);
    g.fillStyle = '#a8814f';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i++) {
      g.fillStyle = `rgba(${rnd() < 0.5 ? '70,48,24' : '210,180,130'},${0.05 + rnd() * 0.07})`;
      g.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 3, 1);
    }
    g.fillStyle = 'rgba(190,160,110,0.85)'; // tape
    g.fillRect(0, h * 0.44, w, h * 0.12);
    g.fillStyle = '#efeee8'; // label
    g.fillRect(w * 0.12, h * 0.66, w * 0.42, h * 0.2);
    g.fillStyle = '#222';
    g.font = '600 16px "IBM Plex Mono", monospace';
    g.fillText('NSN 5340-01', w * 0.14, h * 0.74);
    g.font = '400 12px "IBM Plex Mono", monospace';
    g.fillText('QTY 24  LOT 0417', w * 0.14, h * 0.82);
    g.fillStyle = 'rgba(40,30,20,0.8)';
    g.font = '700 22px "Chakra Petch", sans-serif';
    g.fillText('THIS SIDE UP ↑', w * 0.1, h * 0.25);
  });
}

function wrapTexture() {
  return canvasTexture(256, 256, (g, w, h) => {
    const rnd = mulberry32(33);
    g.fillStyle = '#b9bfc4';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) {
      g.strokeStyle = `rgba(255,255,255,${0.1 + rnd() * 0.25})`;
      g.lineWidth = 1 + rnd() * 3;
      g.beginPath();
      const y = rnd() * h;
      g.moveTo(0, y);
      g.bezierCurveTo(w * 0.3, y + (rnd() - 0.5) * 30, w * 0.7, y + (rnd() - 0.5) * 30, w, y + (rnd() - 0.5) * 10);
      g.stroke();
    }
    g.fillStyle = 'rgba(90,70,40,0.35)'; // cartons ghosting through the film
    for (let i = 0; i < 4; i++) g.fillRect((i % 2) * w * 0.5 + 6, Math.floor(i / 2) * h * 0.5 + 6, w * 0.5 - 12, h * 0.5 - 12);
  }, { repeat: true });
}

function spiralTexture() {
  return canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#c2c7cb';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(70,75,80,0.6)';
    g.lineWidth = 3;
    for (let k = -2; k < 6; k++) {
      g.beginPath();
      g.moveTo(0, k * 64);
      g.lineTo(w, k * 64 + 64);
      g.stroke();
    }
    const rnd = mulberry32(5);
    for (let i = 0; i < 400; i++) {
      g.fillStyle = `rgba(${rnd() < 0.5 ? '255,255,255' : '60,60,60'},0.08)`;
      g.fillRect(rnd() * w, rnd() * h, 8 + rnd() * 20, 2);
    }
  }, { repeat: true });
}

function wireMeshTexture() {
  const t = canvasTexture(128, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.strokeStyle = '#fff';
    g.lineWidth = 6;
    for (let i = 0; i <= 4; i++) {
      g.beginPath();
      g.moveTo((i * w) / 4, 0);
      g.lineTo((i * w) / 4, h);
      g.moveTo(0, (i * h) / 4);
      g.lineTo(w, (i * h) / 4);
      g.stroke();
    }
  }, { repeat: true });
  return t;
}

function whiteboardTexture() {
  return canvasTexture(1024, 640, (g, w, h) => {
    g.fillStyle = '#f4f5f2';
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(120,130,140,0.12)'; // ghosts of old notes
    g.font = '400 40px "Comic Sans MS", "Marker Felt", cursive';
    g.fillText('T+04 ABORT CRITERIA', 420, 120);
    g.fillText('???', 820, 520);
    g.strokeStyle = '#1d3f8c';
    g.fillStyle = '#1d3f8c';
    g.lineWidth = 5;
    g.font = '400 44px "Marker Felt", "Comic Sans MS", cursive';
    g.fillText('TEST CARD 14 — HOVER / TRANSLATE', 40, 70);
    g.font = '400 32px "Marker Felt", "Comic Sans MS", cursive';
    ['1. Spool to 100% — hold 30 s', '2. Lift 3 m, hold', '3. Translate out the door', '4. Climb to 1500 AGL', '5. RTB · land on PAD 1'].forEach((l, i) => g.fillText(l, 50, 140 + i * 52));
    // saucer sketch with dimension line
    g.beginPath();
    g.ellipse(760, 380, 190, 38, 0, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.ellipse(760, 352, 62, 40, 0, Math.PI, 0);
    g.stroke();
    g.strokeStyle = '#b3261e';
    g.fillStyle = '#b3261e';
    g.beginPath();
    g.moveTo(570, 470);
    g.lineTo(950, 470);
    g.stroke();
    g.fillText('13.0 m', 715, 510);
    g.fillText('NO MACH 10 BELOW FL180!!', 50, 450);
    g.strokeStyle = '#1b1b1b';
    g.fillStyle = '#1b1b1b';
    g.fillText('— Ops: coffee is NOT a test article', 50, 590);
  });
}

function noticeTexture() {
  return canvasTexture(512, 360, (g, w, h) => {
    const rnd = mulberry32(12);
    g.fillStyle = '#a77e52';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 2000; i++) {
      g.fillStyle = `rgba(${rnd() < 0.5 ? '60,40,20' : '200,170,120'},0.15)`;
      g.fillRect(rnd() * w, rnd() * h, 2, 2);
    }
    const notes = [['SHIFT ROSTER', '#f4f4ee'], ['BADGE AUDIT 10/24', '#f6e98a'], ['LOST: 7/16 SOCKET', '#f4f4ee'], ['BBQ FRIDAY', '#f2b8c6'], ['SECURITY REMINDER', '#cfe6f6']];
    notes.forEach(([t, c], i) => {
      const x = 20 + (i % 3) * 165 + rnd() * 10;
      const y = 20 + Math.floor(i / 3) * 170 + rnd() * 10;
      g.save();
      g.translate(x + 70, y + 70);
      g.rotate((rnd() - 0.5) * 0.12);
      g.fillStyle = c;
      g.fillRect(-70, -70, 140, 140);
      g.fillStyle = '#333';
      g.font = '600 14px "IBM Plex Mono", monospace';
      g.fillText(t, -62, -48);
      for (let k = 0; k < 6; k++) g.fillRect(-62, -30 + k * 14, 80 + rnd() * 40, 2);
      g.fillStyle = '#c0392b';
      g.beginPath();
      g.arc(0, -64, 5, 0, Math.PI * 2);
      g.fill();
      g.restore();
    });
  });
}

function vendingTexture() {
  return canvasTexture(256, 512, (g, w, h) => {
    g.fillStyle = '#141a20';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#0d5aa8';
    g.fillRect(0, 0, w, 60);
    g.fillStyle = '#fff';
    g.font = '700 30px "Chakra Petch", sans-serif';
    g.fillText('REFRESH', 16, 42);
    const cols = ['#c0392b', '#e67e22', '#27ae60', '#2980b9', '#f1c40f', '#8e44ad'];
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 4; c++) {
        g.fillStyle = cols[(r * 4 + c) % cols.length];
        g.fillRect(14 + c * 44, 80 + r * 56, 34, 40);
        g.fillStyle = 'rgba(255,255,255,0.5)';
        g.fillRect(14 + c * 44, 124 + r * 56, 34, 3);
      }
    }
    g.fillStyle = '#05080a';
    g.fillRect(14, 430, 170, 60);
    g.fillStyle = '#2a3036';
    g.fillRect(200, 80, 44, 120);
  });
}

function scopeTexture() {
  return canvasTexture(256, 150, (g, w, h) => {
    g.fillStyle = '#020806';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(80,140,110,0.35)';
    g.lineWidth = 1;
    for (let x = 0; x <= w; x += w / 10) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, h);
      g.stroke();
    }
    for (let y = 0; y <= h; y += h / 6) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
    }
    g.strokeStyle = '#ffd34d';
    g.lineWidth = 2;
    g.beginPath();
    for (let x = 0; x <= w; x++) g.lineTo(x, h * 0.35 + Math.sin(x * 0.11) * 18 * Math.exp(-x / 300));
    g.stroke();
    g.strokeStyle = '#4de3ff';
    g.beginPath();
    for (let x = 0; x <= w; x++) g.lineTo(x, h * 0.72 + (Math.sin(x * 0.41) > 0 ? -10 : 10));
    g.stroke();
  });
}

function clockTexture(label) {
  return canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#f3f2ec';
    g.beginPath();
    g.arc(w / 2, h / 2, w / 2, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#111';
    for (let k = 0; k < 60; k++) {
      const a = (k / 60) * Math.PI * 2;
      const r0 = k % 5 ? 112 : 100;
      g.save();
      g.translate(w / 2, h / 2);
      g.rotate(a);
      g.fillRect(-(k % 5 ? 1 : 3), -122, k % 5 ? 2 : 6, 122 - r0);
      g.restore();
    }
    g.font = '700 22px "Chakra Petch", sans-serif';
    g.textAlign = 'center';
    g.fillText(label, w / 2, h * 0.68);
  });
}

function flagTexture() {
  return canvasTexture(1024, 540, (g, w, h) => {
    const sh = h / 13;
    for (let i = 0; i < 13; i++) {
      g.fillStyle = i % 2 ? '#f3f1ea' : '#a8222c';
      g.fillRect(0, i * sh, w, sh + 1);
    }
    g.fillStyle = '#1f2b57';
    g.fillRect(0, 0, w * 0.4, sh * 7);
    g.fillStyle = '#f3f1ea';
    for (let r = 0; r < 9; r++) {
      const n = r % 2 ? 5 : 6;
      for (let c = 0; c < n; c++) {
        const x = (w * 0.4 * (c + (r % 2 ? 1 : 0.5))) / 6;
        const y = (sh * 7 * (r + 0.5)) / 9;
        star(g, x, y, 11);
      }
    }
    // cloth shading in vertical folds
    for (let x = 0; x < w; x++) {
      const s = Math.sin(x * 0.0205) * 0.5 + 0.5;
      g.fillStyle = `rgba(0,0,0,${s * 0.16})`;
      g.fillRect(x, 0, 1, h);
    }
  });
}

function star(g, x, y, r) {
  g.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2 - Math.PI / 2;
    const rr = k % 2 ? r * 0.42 : r;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
  g.fill();
}
