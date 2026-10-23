import {
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RectAreaLight,
  SRGBColorSpace,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { Batcher, boxProjectUV, iBeam, member, rail, truss } from './build.js';
import { apronTextures, floorTextures, paintedSteelTextures, signTexture, wallPanelTextures } from '../textures.js';
import { Screen, telemetryPage, videoWallPage } from './screens.js';
import { dressHangar } from './dressing.js';
import { dressExterior } from './exterior.js';
import { addGrime, setGrimeFrame } from './grime.js';
import { mulberry32 } from '../../core/math.js';

/**
 * Hangar 9 — the S-4 flight-test hangar on the Groom Lake playa.
 *
 * Hangar-local frame: origin at the centre of the floor, +Y up, the door in
 * the −Z wall. 60 × 52 m, 17 m to the roof deck, 40 × 13 m door opening.
 * The saucer parks on the painted circle at (0, 0, −2) facing the door.
 *
 * Also exports 2D colliders (XZ, hangar-local) for walking and flying.
 */
export const HANGAR = {
  W: 60,
  D: 52,
  H: 17,
  doorW: 40,
  doorH: 13,
  trussBottom: 14.4,
  saucerPad: new Vector3(0, 0, -2),
  start: new Vector3(-5.5, 0, 16.5),
  startYaw: 0.22, // radians, + turns left (toward −X)
};

const rand = mulberry32(51);

/** Objects on this layer cast shadows from the interior key light (the shell doesn't). */
export const LAYER_CASTERS = 4;

export class Hangar {
  constructor({ renderer, quality = null }) {
    RectAreaLightUniformsLib.init();
    this.renderer = renderer;
    this.quality = quality;
    this.group = new Group();
    this.group.name = 'hangar';
    this.colliders = [];
    this.screens = [];
    this.interior = []; // materials that should use the interior environment
    this.exterior = []; // materials that should use the sky environment
    this.blinkers = [];
    this._t = 0;
    this._makeMaterials();
    // The building shell and its contents are batched separately: the shell is
    // the only thing the interior key light must NOT see when casting shadows.
    const shell = new Batcher();
    const contents = new Batcher();
    this._shell(shell);
    this._structure(shell);
    this._floor();
    this._offices(shell);
    this._props(contents);
    this.dressing = dressHangar(this, contents, HANGAR);
    this._signage();
    this.outside = dressExterior(this, HANGAR);
    this._lights();
    for (const m of shell.build({ name: 'shell' })) {
      m.userData.shell = true;
      this.group.add(m);
    }
    for (const m of contents.build({ name: 'contents' })) this.group.add(m);
    this.group.traverse((o) => {
      if (o.isMesh && !o.userData.shell && o !== this.floor) o.layers.enable(LAYER_CASTERS);
    });
    // three picks shadow casters by the *viewing* camera's layers, for every light at
    // once, so the shell (which must still shadow the sun) is dropped from the
    // interior lights' maps here, or the roof deck would black out the whole floor.
    this.group.traverse((o) => {
      if (o.isMesh && o.castShadow && (o.userData.noKeyShadow || !o.layers.isEnabled(LAYER_CASTERS))) this.noKeyShadow(o);
    });
  }

  /** Keep `mesh` out of the interior key lights' shadow maps (it still shadows the sun). */
  noKeyShadow(mesh) {
    const cams = this._keyCams;
    mesh.onBeforeShadow = (r, o, cam, shadowCam, geo) => {
      if (cams.has(shadowCam)) geo.drawRange.count = 0;
    };
    mesh.onAfterShadow = (r, o, cam, shadowCam, geo) => {
      if (cams.has(shadowCam)) geo.drawRange.count = Infinity;
    };
  }

  // ------------------------------------------------------------------ materials
  _makeMaterials() {
    const wall = wallPanelTextures();
    const steel = paintedSteelTextures();
    const M = (o) => {
      const m = new MeshStandardMaterial(o);
      this.interior.push(m);
      return m;
    };
    const wallMap = wall.map.clone();
    wallMap.needsUpdate = true;
    this.mat = {
      wallInt: M({ name: 'wall_int', color: 0xdfe2e3, map: wall.map, normalMap: wall.normalMap, roughness: 0.52, metalness: 0.2, normalScale: new Vector2(0.9, 0.9) }),
      wallLow: M({ name: 'wall_low', color: 0x4b5258, roughness: 0.82, metalness: 0.0, normalMap: steel.normalMap, normalScale: new Vector2(0.5, 0.5) }),
      roof: M({ name: 'roof_deck', color: 0xe4e7e9, map: wall.map, normalMap: wall.normalMap, roughness: 0.6, metalness: 0.1 }),
      steel: M({ name: 'steel_white', color: 0xc9cdd0, roughness: 0.48, metalness: 0.25, normalMap: steel.normalMap, roughnessMap: steel.roughnessMap }),
      column: M({ name: 'steel_column', color: 0x5f676e, roughness: 0.5, metalness: 0.3, normalMap: steel.normalMap, roughnessMap: steel.roughnessMap }),
      yellow: M({ name: 'paint_yellow', color: 0xd9a514, roughness: 0.5, metalness: 0.1, normalMap: steel.normalMap }),
      red: M({ name: 'paint_red', color: 0x9e1b16, roughness: 0.32, metalness: 0.35, normalMap: steel.normalMap }),
      black: M({ name: 'rubber', color: 0x141516, roughness: 0.88, metalness: 0.0 }),
      chrome: M({ name: 'chrome', color: 0xd8dadc, roughness: 0.18, metalness: 1 }),
      office: M({ name: 'office_wall', color: 0xd3cfc6, roughness: 0.86, metalness: 0 }),
      officeTrim: M({ name: 'office_trim', color: 0x30353a, roughness: 0.6, metalness: 0.4 }),
      desk: M({ name: 'desk', color: 0x2a2d30, roughness: 0.55, metalness: 0.2 }),
      deskTop: M({ name: 'desk_top', color: 0x8c8a84, roughness: 0.4, metalness: 0.05 }),
      plastic: M({ name: 'plastic', color: 0x1e2125, roughness: 0.42, metalness: 0.0 }),
      crate: M({ name: 'crate', color: 0x5d5a3a, roughness: 0.8, metalness: 0.0, normalMap: steel.normalMap }),
      wood: M({ name: 'pallet', color: 0x8a6a45, roughness: 0.85, metalness: 0 }),
      cyl: M({ name: 'cylinder_green', color: 0x23502f, roughness: 0.35, metalness: 0.4 }),
      cylGrey: M({ name: 'cylinder_grey', color: 0x7f868c, roughness: 0.35, metalness: 0.5 }),
    };
    const m = this.mat;
    for (const k of ['wallInt', 'wallLow']) addGrime(m[k], 'wall', 1);
    addGrime(m.office, 'wall', 0.6);
    for (const [k, a] of [['column', 0.8], ['steel', 0.5], ['yellow', 1], ['red', 0.7], ['officeTrim', 0.5], ['desk', 0.4], ['crate', 1], ['wood', 1], ['cyl', 0.6], ['cylGrey', 0.6]]) addGrime(m[k], 'prop', a);
    this.mat.wallExt = addGrime(new MeshStandardMaterial({ name: 'wall_ext', color: 0xbcb19b, map: wallMap, normalMap: wall.normalMap, roughness: 0.66, metalness: 0.15 }), 'wall', 0.8);
    // standing-seam roof: the cladding's ribs, run front to back, weathered in blotches
    this.mat.roofExt = addGrime(new MeshStandardMaterial({ name: 'roof_ext', color: 0x9d9a92, map: wallMap, normalMap: wall.normalMap, roughness: 0.7, metalness: 0.3 }), 'prop', 0.7);
    this.exterior.push(this.mat.wallExt, this.mat.roofExt);
    this.mat.glass = new MeshPhysicalMaterial({ name: 'glass', color: 0x9fb3ba, metalness: 0, roughness: 0.04, transparent: true, opacity: 0.16, depthWrite: false, envMapIntensity: 1.2 });
    this.interior.push(this.mat.glass);
    this.mat.lens = new MeshBasicMaterial({ name: 'lens', color: new Color(1.0, 0.98, 0.94).multiplyScalar(9) });
    this.mat.lensDim = new MeshBasicMaterial({ name: 'lens_dim', color: new Color(1.0, 0.95, 0.85).multiplyScalar(3) });
  }

  // ------------------------------------------------------------------ shell
  _shell(b) {
    const { W, D, H, doorW, doorH } = HANGAR;
    const t = 0.35;
    const hw = W / 2;
    const hd = D / 2;
    const mat = this.mat;
    // Walls as boxes, interior faces panelled, exterior faces clad.
    const walls = [];
    // back wall (+Z), side walls (±X), front wall pieces
    walls.push({ s: [W + t * 2, H, t], p: [0, H / 2, hd + t / 2], n: [0, 0, -1] });
    walls.push({ s: [t, H, D], p: [hw + t / 2, H / 2, 0], n: [-1, 0, 0] });
    walls.push({ s: [t, H, D], p: [-hw - t / 2, H / 2, 0], n: [1, 0, 0] });
    const sideW = (W - doorW) / 2;
    walls.push({ s: [sideW, H, t], p: [hw - sideW / 2, H / 2, -hd - t / 2], n: [0, 0, 1] });
    walls.push({ s: [sideW, H, t], p: [-hw + sideW / 2, H / 2, -hd - t / 2], n: [0, 0, 1] });
    walls.push({ s: [doorW, H - doorH, t], p: [0, doorH + (H - doorH) / 2, -hd - t / 2], n: [0, 0, 1] });
    for (const w of walls) {
      // interior skin (upper panels) and lower painted block band
      const [sx, sy, sz] = w.s;
      const [x, y, z] = w.p;
      const thinX = sx < 1;
      const inset = 0.02;
      const ix = x + w.n[0] * (t / 2 + inset);
      const iz = z + w.n[2] * (t / 2 + inset);
      const panelY0 = w.p[1] - sy / 2;
      const low = Math.max(0, Math.min(2.4, panelY0 + sy) - panelY0);
      if (panelY0 < 2.4) {
        b.box(mat.wallLow, thinX ? 0.06 : sx, low, thinX ? sz : 0.06, ix, panelY0 + low / 2, iz, { uvTile: 2 });
      }
      b.box(mat.wallInt, thinX ? 0.04 : sx, sy - (panelY0 < 2.4 ? low : 0), thinX ? sz : 0.04, ix, panelY0 + (panelY0 < 2.4 ? low : 0) + (sy - (panelY0 < 2.4 ? low : 0)) / 2, iz, { uvTile: 4 });
      // exterior cladding
      const ex = x - w.n[0] * (t / 2 + inset);
      const ez = z - w.n[2] * (t / 2 + inset);
      b.box(mat.wallExt, thinX ? 0.04 : sx, sy, thinX ? sz : 0.04, ex, y, ez, { uvTile: 4 });
      // structural core (dark, gives thickness at the door edges)
      b.box(mat.column, thinX ? t : sx, sy, thinX ? sz : t, x, y, z, { uvTile: 2 });
      // colliders
      this.colliders.push({ type: 'box', minX: x - sx / 2 - 0.05, maxX: x + sx / 2 + 0.05, minZ: z - sz / 2 - 0.05, maxZ: z + sz / 2 + 0.05, minY: y - sy / 2, maxY: y + sy / 2 });
    }
    // Roof deck + exterior roof with a shallow parapet.
    b.box(mat.roof, W, 0.06, D, 0, H - 0.03, 0, { uvTile: 4 });
    b.box(mat.roofExt, W + 0.8, 0.3, D + 0.8, 0, H + 0.2, 0, { uvTile: 6 });
    b.box(mat.roofExt, W + 0.8, 0.9, 0.3, 0, H + 0.7, -hd - 0.25, { uvTile: 6 });
    b.box(mat.roofExt, W + 0.8, 0.9, 0.3, 0, H + 0.7, hd + 0.25, { uvTile: 6 });
    this.colliders.push({ type: 'box', minX: -hw - 1, maxX: hw + 1, minZ: -hd - 1, maxZ: hd + 1, minY: H - 0.1, maxY: H + 1.2, roof: true });

    // Door jambs + header beam (heavy steel), and the six sliding leaves
    // stacked open behind the side walls.
    b.box(mat.column, 0.8, doorH + 1.2, 0.9, doorW / 2 + 0.4, (doorH + 1.2) / 2, -hd + 0.2, { uvTile: 2 });
    b.box(mat.column, 0.8, doorH + 1.2, 0.9, -doorW / 2 - 0.4, (doorH + 1.2) / 2, -hd + 0.2, { uvTile: 2 });
    b.box(mat.column, doorW + 1.6, 1.2, 0.9, 0, doorH + 0.6, -hd + 0.2, { uvTile: 2 });
    for (let s = -1; s <= 1; s += 2) {
      for (let k = 0; k < 3; k++) {
        const x = s * (doorW / 2 + 3.6 + k * 0.6);
        const z = -hd + 0.75 + k * 0.32;
        b.box(mat.wallExt, 6.8, doorH + 0.2, 0.22, x, (doorH + 0.2) / 2, z, { uvTile: 4 });
        b.box(mat.column, 6.8, 0.25, 0.3, x, doorH + 0.3, z, { uvTile: 2 });
        this.colliders.push({ type: 'box', minX: x - 3.4, maxX: x + 3.4, minZ: z - 0.2, maxZ: z + 0.2, minY: 0, maxY: doorH });
      }
    }
    // door track rail on the floor
    b.box(mat.chrome, W - 1, 0.03, 0.12, 0, 0.015, -hd + 0.3, { uvTile: 1 });
  }

  // ------------------------------------------------------------------ structure
  _structure(b) {
    const { W, D, H, trussBottom } = HANGAR;
    const hw = W / 2;
    const mat = this.mat;
    const colGeo = iBeam(0.36, 0.5, 0.028, 0.018, H);
    for (const s of [-1, 1]) {
      for (let z = -24; z <= 24; z += 8) {
        b.add(colGeo, mat.column, { position: [s * (hw - 0.27), 0, z], rotation: [0, Math.PI / 2, 0] });
        // base plate + anchor bolts
        b.box(mat.column, 0.7, 0.04, 0.7, s * (hw - 0.3), 0.02, z, { uvTile: 1 });
        this.colliders.push({ type: 'box', minX: s * (hw - 0.27) - 0.3, maxX: s * (hw - 0.27) + 0.3, minZ: z - 0.25, maxZ: z + 0.25, minY: 0, maxY: H });
      }
    }
    for (let z = -24; z <= 24; z += 8) truss(b, mat.steel, z, W - 0.6, trussBottom, H - 0.25, 2.5);
    // purlins
    for (let x = -27; x <= 27; x += 3) member(b, mat.steel, new Vector3(x, H - 0.35, -25.8), new Vector3(x, H - 0.35, 25.8), 0.14);
    // bottom-chord bracing strut lines
    for (const x of [-15, 0, 15]) member(b, mat.steel, new Vector3(x, trussBottom, -24), new Vector3(x, trussBottom, 24), 0.1);
    // Bridge crane: runway beams on brackets along both walls + one bridge.
    const craneY = 12;
    for (const s of [-1, 1]) {
      member(b, mat.yellow, new Vector3(s * (hw - 1.0), craneY, -25), new Vector3(s * (hw - 1.0), craneY, 25), 0.42);
      for (let z = -24; z <= 24; z += 8) member(b, mat.column, new Vector3(s * (hw - 0.4), craneY - 0.3, z), new Vector3(s * (hw - 1.0), craneY - 0.3, z), 0.25);
    }
    const bz = 12;
    member(b, mat.yellow, new Vector3(-hw + 1.0, craneY + 0.45, bz), new Vector3(hw - 1.0, craneY + 0.45, bz), 0.7);
    b.box(mat.yellow, 1.4, 0.9, 1.6, -6, craneY - 0.25, bz, { uvTile: 1 });
    member(b, mat.chrome, new Vector3(-6, craneY - 0.7, bz), new Vector3(-6, 6.2, bz), 0.03);
    member(b, mat.chrome, new Vector3(-5.85, craneY - 0.7, bz), new Vector3(-5.85, 6.2, bz), 0.03);
    b.box(mat.yellow, 0.5, 0.6, 0.35, -5.93, 5.95, bz, { uvTile: 1 });
    const hook = new TorusGeometry(0.16, 0.05, 10, 20, Math.PI * 1.4);
    b.add(hook, mat.chrome, { position: [-5.93, 5.48, bz], rotation: [0, 0, Math.PI * 0.8] });
    // cable trays along the walls + conduit drops
    for (const s of [-1, 1]) member(b, mat.chrome, new Vector3(s * (hw - 0.6), 9.5, -25), new Vector3(s * (hw - 0.6), 9.5, 25), 0.3);
    // sprinkler mains
    for (const x of [-21, -7, 7, 21]) member(b, mat.red, new Vector3(x, 15.9, -25.5), new Vector3(x, 15.9, 25.5), 0.11);
  }

  // ------------------------------------------------------------------ floor
  _floor() {
    const { W, D } = HANGAR;
    const f = floorTextures();
    for (const t of [f.map, f.roughnessMap, f.normalMap]) t.repeat.set(W / 8, D / 8);
    const floorMat = addGrime(new MeshStandardMaterial({ name: 'floor', map: f.map, roughnessMap: f.roughnessMap, normalMap: f.normalMap, roughness: 0.95, metalness: 0.0, normalScale: new Vector2(0.6, 0.6), envMapIntensity: 0.8 }), 'floor', 1);
    this.interior.push(floorMat);
    const floor = new Mesh(new PlaneGeometry(W + 0.7, D + 0.7), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.name = 'floor';
    this.group.add(floor);
    this.floor = floor;

    const marks = new Mesh(new PlaneGeometry(W, D), new MeshStandardMaterial({ name: 'markings', map: markingsTexture(), transparent: true, roughness: 0.55, metalness: 0, depthWrite: false }));
    this.interior.push(marks.material);
    marks.rotation.x = -Math.PI / 2;
    marks.position.y = 0.004;
    marks.receiveShadow = true;
    marks.renderOrder = 1;
    this.group.add(marks);

    // Concrete apron outside the door: 6.1 m slabs, a joint on the door line and
    // the lead-in down the middle of a slab. Top 1 cm under the floor; poured deep
    // so a lakebed lower than the floor never shows daylight under its edge.
    const ap = apronTextures();
    const apronMat = new MeshStandardMaterial({ name: 'apron', map: ap.map, roughnessMap: ap.roughnessMap, normalMap: ap.normalMap, roughness: 1, metalness: 0, normalScale: new Vector2(0.8, 0.8) });
    this.exterior.push(apronMat);
    const apron = new Mesh(new BoxGeometry(70, 1.4, 46), apronMat);
    boxProjectUV(apron.geometry, 24.4, [0.625, 23 / 24.4]);
    apron.position.set(0, -0.01 - 0.7, -HANGAR.D / 2 - 23 + 0.4);
    apron.receiveShadow = true;
    apron.name = 'apron';
    this.group.add(apron);
    // apron centreline (taxi line), on its black border (exterior.js)
    const lineMat = new MeshStandardMaterial({ name: 'apron_line', color: 0xc89b1a, roughness: 0.6 });
    this.exterior.push(lineMat);
    const line = new Mesh(new PlaneGeometry(0.22, 44), lineMat);
    line.rotation.x = -Math.PI / 2;
    line.position.set(0, -0.005, -HANGAR.D / 2 - 22);
    line.receiveShadow = true;
    this.group.add(line);
  }

  // ------------------------------------------------------------------ offices
  _offices(b) {
    const mat = this.mat;
    const z0 = 19; // facade line
    const z1 = HANGAR.D / 2;
    const x0 = -26;
    const x1 = 26;
    const floorH = 3.6;
    // block volume (side walls + slab)
    b.box(mat.office, 0.25, floorH * 2, z1 - z0, x0, floorH, (z0 + z1) / 2, { uvTile: 3 });
    b.box(mat.office, 0.25, floorH * 2, z1 - z0, x1, floorH, (z0 + z1) / 2, { uvTile: 3 });
    b.box(mat.officeTrim, x1 - x0 + 0.6, 0.35, z1 - z0 + 0.4, 0, floorH * 2 + 0.17, (z0 + z1) / 2, { uvTile: 3 });
    b.box(mat.officeTrim, x1 - x0, 0.3, 1.6, 0, floorH, z0 - 0.55, { uvTile: 3 }); // balcony slab
    this.colliders.push({ type: 'box', minX: x0 - 0.2, maxX: x1 + 0.2, minZ: z0 - 0.1, maxZ: z1, minY: 0, maxY: floorH * 2 });
    // ground floor facade: wall pieces with windows + doors
    const bays = [
      { x: -22, w: 3.2, kind: 'door', sign: 'LOCKER ROOM' },
      { x: -16.5, w: 5.5, kind: 'window', room: 'briefing' },
      { x: -10, w: 3.2, kind: 'door', sign: 'BRIEFING 2' },
      { x: -4, w: 6.5, kind: 'window', room: 'lab' },
      { x: 3.5, w: 6.5, kind: 'window', room: 'lab' },
      { x: 10, w: 3.2, kind: 'door', sign: 'LAB 4 · E-115' },
      { x: 16.5, w: 5.5, kind: 'window', room: 'store' },
    ];
    let cursor = x0;
    const facadeZ = z0;
    for (const bay of bays) {
      const l = bay.x - bay.w / 2;
      if (l > cursor) b.box(mat.office, l - cursor, floorH, 0.2, (cursor + l) / 2, floorH / 2, facadeZ, { uvTile: 3 });
      if (bay.kind === 'window') {
        b.box(mat.office, bay.w, 1.0, 0.2, bay.x, 0.5, facadeZ, { uvTile: 3 });
        b.box(mat.office, bay.w, 0.6, 0.2, bay.x, floorH - 0.3, facadeZ, { uvTile: 3 });
        this._window(b, bay.x, 1.0, floorH - 0.6, bay.w, facadeZ, bay.room);
      } else {
        b.box(mat.office, bay.w, floorH - 2.4, 0.2, bay.x, 2.4 + (floorH - 2.4) / 2, facadeZ, { uvTile: 3 });
        // wall either side of the 1.1 m door, up to the header
        const side = (bay.w - 1.1) / 2;
        for (const s of [-1, 1]) b.box(mat.office, side, 2.4, 0.2, bay.x + s * (0.55 + side / 2), 1.2, facadeZ, { uvTile: 3 });
        this._door(b, bay.x, facadeZ, bay.sign);
      }
      cursor = bay.x + bay.w / 2;
    }
    if (cursor < x1) b.box(mat.office, x1 - cursor, floorH, 0.2, (cursor + x1) / 2, floorH / 2, facadeZ, { uvTile: 3 });
    // upper floor: control room window band with mullions
    const uz = facadeZ + 0.9;
    b.box(mat.office, x1 - x0, 1.0, 0.2, 0, floorH + 0.5, uz, { uvTile: 3 });
    b.box(mat.office, x1 - x0, 0.5, 0.2, 0, floorH * 2 - 0.25, uz, { uvTile: 3 });
    this._window(b, 0, floorH + 1.0, floorH * 2 - 0.5, x1 - x0 - 1, uz, 'control', 2.0);
    // balcony railing
    const ry = floorH + 0.15;
    rail(b, mat.yellow, [new Vector3(x0, ry + 1.05, z0 - 1.3), new Vector3(x1 - 4, ry + 1.05, z0 - 1.3)], 0.05);
    rail(b, mat.yellow, [new Vector3(x0, ry + 0.55, z0 - 1.3), new Vector3(x1 - 4, ry + 0.55, z0 - 1.3)], 0.035);
    for (let x = x0; x <= x1 - 4; x += 1.5) member(b, mat.yellow, new Vector3(x, ry, z0 - 1.3), new Vector3(x, ry + 1.05, z0 - 1.3), 0.045);
    // stairs up to the balcony (east end)
    const sx = 23.6;
    const steps = 20;
    for (let i = 0; i < steps; i++) {
      const y = (i + 1) * (floorH / steps);
      const z = z0 - 1.6 - (steps - i) * 0.28;
      b.box(mat.column, 1.4, 0.05, 0.3, sx, y, z, { uvTile: 1 });
    }
    member(b, mat.column, new Vector3(sx - 0.72, 0, z0 - 1.6 - steps * 0.28), new Vector3(sx - 0.72, floorH, z0 - 1.6), 0.08);
    member(b, mat.column, new Vector3(sx + 0.72, 0, z0 - 1.6 - steps * 0.28), new Vector3(sx + 0.72, floorH, z0 - 1.6), 0.08);
    rail(b, mat.yellow, [new Vector3(sx - 0.75, 1.0, z0 - 1.6 - steps * 0.28), new Vector3(sx - 0.75, floorH + 1.0, z0 - 1.6)], 0.045);
    rail(b, mat.yellow, [new Vector3(sx + 0.75, 1.0, z0 - 1.6 - steps * 0.28), new Vector3(sx + 0.75, floorH + 1.0, z0 - 1.6)], 0.045);
    this.colliders.push({ type: 'box', minX: sx - 0.8, maxX: sx + 0.8, minZ: z0 - 1.6 - steps * 0.28, maxZ: z0, minY: 0, maxY: floorH });
    // "S-4 FLIGHT TEST" lettering above the offices
    const title = new Mesh(new PlaneGeometry(22, 2.2), new MeshStandardMaterial({ map: signTexture(['S-4  FLIGHT TEST  DIRECTORATE'], { w: 2048, h: 205, bg: null, fg: '#d9dcdd', size: 0.62, font: '700' }), transparent: true, roughness: 0.6, metalness: 0.1, depthWrite: false }));
    this.interior.push(title.material);
    title.position.set(0, 10.4, HANGAR.D / 2 - 0.05);
    title.rotation.y = Math.PI;
    this.group.add(title);
  }

  _window(b, x, y0, y1, w, z, room, mullion = 0) {
    const mat = this.mat;
    const h = y1 - y0;
    const glass = new Mesh(new PlaneGeometry(w, h), mat.glass);
    glass.position.set(x, (y0 + y1) / 2, z - 0.02);
    glass.rotation.y = Math.PI;
    glass.renderOrder = 4;
    this.group.add(glass);
    // frame
    b.box(mat.officeTrim, w + 0.1, 0.08, 0.14, x, y0, z - 0.06, { uvTile: 1 });
    b.box(mat.officeTrim, w + 0.1, 0.08, 0.14, x, y1, z - 0.06, { uvTile: 1 });
    b.box(mat.officeTrim, 0.08, h, 0.14, x - w / 2, (y0 + y1) / 2, z - 0.06, { uvTile: 1 });
    b.box(mat.officeTrim, 0.08, h, 0.14, x + w / 2, (y0 + y1) / 2, z - 0.06, { uvTile: 1 });
    if (mullion) for (let mx = x - w / 2 + mullion; mx < x + w / 2 - 0.1; mx += mullion) b.box(mat.officeTrim, 0.06, h, 0.12, mx, (y0 + y1) / 2, z - 0.06, { uvTile: 1 });
    // room behind: back wall, ceiling light, a few silhouettes of furniture + glowing screens
    const depth = room === 'control' ? 5.2 : 4.2;
    const back = z + depth;
    b.box(mat.office, w, h + 1.2, 0.1, x, (y0 + y1) / 2, back, { uvTile: 3 });
    b.box(mat.office, w, 0.08, depth, x, y1 + 0.3, z + depth / 2, { uvTile: 3 });
    b.box(mat.desk, w, 0.06, depth, x, y0 - 0.95, z + depth / 2, { uvTile: 3 });
    const panel = new Mesh(new PlaneGeometry(w * 0.8, 0.6), mat.lensDim);
    panel.rotation.x = Math.PI / 2;
    panel.position.set(x, y1 + 0.25, z + depth / 2);
    this.group.add(panel);
    const screenMat = new MeshBasicMaterial({ color: new Color(0.35, 0.7, 0.85).multiplyScalar(2.2) });
    const n = Math.max(1, Math.floor(w / 2.4));
    for (let i = 0; i < n; i++) {
      const cx = x - w / 2 + ((i + 0.5) / n) * w;
      b.box(mat.desk, 1.6, 0.75, 0.7, cx, y0 - 0.95 + 0.38, z + depth - 1.0, { uvTile: 1 });
      const s = new Mesh(new PlaneGeometry(0.55, 0.32), screenMat);
      s.position.set(cx + (rand() - 0.5) * 0.4, y0 - 0.95 + 0.95, z + depth - 1.2);
      s.rotation.y = Math.PI;
      this.group.add(s);
    }
  }

  _door(b, x, z, sign) {
    const mat = this.mat;
    b.box(mat.officeTrim, 1.1, 2.25, 0.08, x, 1.125, z - 0.09, { uvTile: 1 });
    b.box(mat.chrome, 0.04, 0.3, 0.06, x + 0.4, 1.05, z - 0.15, { uvTile: 1 });
    const s = new Mesh(new PlaneGeometry(1.0, 0.28), new MeshStandardMaterial({ map: signTexture([sign], { w: 512, h: 144, bg: '#e8e6df', fg: '#1b1d1f', size: 0.42 }), roughness: 0.5 }));
    this.interior.push(s.material);
    s.position.set(x, 2.55, z - 0.11);
    s.rotation.y = Math.PI;
    this.group.add(s);
    // badge reader with a blinking LED
    b.box(mat.plastic, 0.1, 0.16, 0.04, x + 0.75, 1.3, z - 0.12, { uvTile: 1 });
    const led = new MeshBasicMaterial({ color: new Color(0.2, 3, 0.4) });
    const l = new Mesh(new PlaneGeometry(0.02, 0.02), led);
    l.position.set(x + 0.75, 1.36, z - 0.145);
    l.rotation.y = Math.PI;
    this.group.add(l);
    this.blinkers.push({ m: led, on: new Color(0.2, 3, 0.4), off: new Color(0.02, 0.1, 0.03), period: 2 + rand() * 2, phase: rand() });
  }

  // ------------------------------------------------------------------ props
  _props(b) {
    const mat = this.mat;
    const hw = HANGAR.W / 2;
    const box = (m, sx, sy, sz, x, y, z, collide = true) => {
      b.box(m, sx, sy, sz, x, y, z, { uvTile: 1 });
      if (collide) this.colliders.push({ type: 'box', minX: x - sx / 2, maxX: x + sx / 2, minZ: z - sz / 2, maxZ: z + sz / 2, minY: y - sy / 2, maxY: y + sy / 2 });
    };
    const rbox = (m, sx, sy, sz, x, y, z, r = 0.03, rotY = 0) => {
      b.add(new RoundedBoxGeometry(sx, sy, sz, 2, r), m, { position: [x, y, z], rotation: [0, rotY, 0] });
    };

    // --- flight test consoles (west side), facing the saucer
    // Operators face the saucer; the video wall is behind them.
    const deskSpots = [
      [-19.5, 4.5],
      [-20.5, 8.2],
      [-20.0, 12.0],
    ].map(([x, z]) => [x, z, Math.atan2(HANGAR.saucerPad.x - x, HANGAR.saucerPad.z - z)]);
    this.deskSeats = [];
    const kinds = ['drive', 'track', 'systems'];
    deskSpots.forEach(([x, z, rot], i) => {
      const g = new Group();
      g.position.set(x, 0, z);
      g.rotation.y = rot;
      this.group.add(g);
      this.deskSeats.push({ x: x - Math.sin(rot) * 0.75, z: z - Math.cos(rot) * 0.75, yaw: rot });
      const d = new Batcher();
      d.add(new RoundedBoxGeometry(2.4, 0.05, 0.95, 2, 0.02), mat.deskTop, { position: [0, 0.76, 0] });
      d.add(new BoxGeometry(0.06, 0.74, 0.85), mat.desk, { position: [-1.15, 0.37, 0] });
      d.add(new BoxGeometry(0.06, 0.74, 0.85), mat.desk, { position: [1.15, 0.37, 0] });
      d.add(new BoxGeometry(2.3, 0.5, 0.04), mat.desk, { position: [0, 0.5, 0.42] });
      // monitor arms + bezels
      for (const mx of [-0.55, 0.55]) {
        d.add(new CylinderGeometry(0.02, 0.02, 0.32, 10), mat.plastic, { position: [mx, 0.95, 0.3] });
        d.add(new RoundedBoxGeometry(0.98, 0.58, 0.05, 2, 0.01), mat.plastic, { position: [mx, 1.2, 0.29], rotation: [0.06, mx < 0 ? 0.18 : -0.18, 0] });
      }
      d.add(new RoundedBoxGeometry(0.46, 0.02, 0.16, 1, 0.006), mat.plastic, { position: [0, 0.79, -0.15] });
      d.add(new RoundedBoxGeometry(0.07, 0.03, 0.11, 1, 0.01), mat.plastic, { position: [0.36, 0.79, -0.12] });
      // chair
      d.add(new CylinderGeometry(0.03, 0.03, 0.42, 10), mat.chrome, { position: [0, 0.27, -0.75] });
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2;
        d.add(new BoxGeometry(0.05, 0.035, 0.34), mat.plastic, { position: [Math.sin(a) * 0.17, 0.06, -0.75 + Math.cos(a) * 0.17], rotation: [0, a, 0] });
      }
      d.add(new RoundedBoxGeometry(0.5, 0.08, 0.48, 2, 0.03), mat.black, { position: [0, 0.5, -0.75] });
      d.add(new RoundedBoxGeometry(0.46, 0.6, 0.07, 2, 0.03), mat.black, { position: [0, 0.86, -0.98], rotation: [-0.12, 0, 0] });
      for (const m of d.build({ name: 'desk' })) g.add(m);
      // live screens
      for (const [k, mx] of [[0, -0.55], [1, 0.55]].map(([a, bb]) => [a, bb])) {
        const scr = new Screen(0.92, 0.52, [512, 288], 1.7);
        scr.draw = telemetryPage(k === 0 ? kinds[i] : kinds[(i + 1) % 3]);
        scr.mesh.position.set(mx, 1.2, 0.26);
        scr.mesh.rotation.set(0.06, Math.PI + (mx < 0 ? 0.18 : -0.18), 0);
        g.add(scr.mesh);
        this.screens.push(scr);
      }
      // collider in hangar space (rotated desk ≈ circle)
      this.colliders.push({ type: 'circle', x, z, r: 1.35 });
    });

    // --- video wall on the west wall
    const wall = new Screen(10.2, 5.74, [1024, 576], 1.25);
    wall.draw = videoWallPage();
    wall.mesh.position.set(-hw + 0.45, 5.6, 8.5);
    wall.mesh.rotation.y = Math.PI / 2;
    this.group.add(wall.mesh);
    this.screens.push(wall);
    this.videoWall = wall;
    box(mat.plastic, 0.2, 6.1, 10.6, -hw + 0.33, 5.6, 8.5, false);

    // --- server racks behind the consoles
    for (let i = 0; i < 4; i++) {
      const z = 1.0 + i * 0.66;
      const x = -hw + 0.85;
      box(mat.plastic, 1.05, 2.1, 0.62, x, 1.05, z);
      const ledMat = new MeshBasicMaterial({ color: new Color(0.3, 2.5, 0.8) });
      for (let k = 0; k < 6; k++) {
        const led = new Mesh(new PlaneGeometry(0.02, 0.02), ledMat);
        led.position.set(x + 0.53, 0.5 + k * 0.25, z - 0.18 + (k % 3) * 0.1);
        led.rotation.y = Math.PI / 2;
        this.group.add(led);
      }
      this.blinkers.push({ m: ledMat, on: new Color(0.3, 2.5, 0.8), off: new Color(0.05, 0.4, 0.12), period: 0.3 + rand() * 0.5, phase: rand() });
    }

    // --- tool area (east side)
    for (let i = 0; i < 3; i++) {
      const z = 2.5 + i * 1.6;
      const x = hw - 1.6;
      rbox(mat.red, 0.75, 1.05, 1.45, x, 0.62, z, 0.02);
      for (let k = 0; k < 6; k++) b.box(mat.chrome, 0.012, 0.02, 1.2, x - 0.38, 0.25 + k * 0.16, z, { uvTile: 1 });
      for (const zz of [-0.6, 0.6]) b.add(new CylinderGeometry(0.06, 0.06, 0.05, 14), mat.black, { position: [x - 0.25, 0.06, z + zz], rotation: [Math.PI / 2, 0, 0] });
      rbox(mat.red, 0.7, 0.42, 1.4, x, 1.38, z, 0.02);
      this.colliders.push({ type: 'box', minX: x - 0.4, maxX: x + 0.4, minZ: z - 0.75, maxZ: z + 0.75 });
    }
    // workbench + pegboard
    box(mat.deskTop, 0.9, 0.06, 4.2, hw - 1.1, 0.92, 9.6);
    for (const zz of [-1.95, 1.95]) b.box(mat.column, 0.06, 0.9, 0.06, hw - 1.4, 0.45, 9.6 + zz, { uvTile: 1 });
    b.box(mat.wood, 0.03, 1.4, 4.2, hw - 0.62, 1.95, 9.6, { uvTile: 1 });
    for (let k = 0; k < 14; k++) {
      const zz = 9.6 - 1.9 + k * 0.29;
      const len = 0.18 + rand() * 0.3;
      b.box(k % 3 ? mat.chrome : mat.red, 0.03, len, 0.04 + rand() * 0.03, hw - 0.66, 1.9 + rand() * 0.4, zz, { uvTile: 1 });
    }
    rbox(mat.cylGrey, 0.35, 0.22, 0.24, hw - 1.1, 1.06, 8.3, 0.03);
    // gas cylinders in a rack
    const cylProfile = [];
    for (let i = 0; i <= 10; i++) {
      const a = (i / 10) * Math.PI * 0.5;
      cylProfile.push(new Vector2(0.115 * Math.cos(a) + 0.0, 1.35 + 0.115 * Math.sin(a)));
    }
    const cyl = new LatheGeometry([new Vector2(0, 0), new Vector2(0.115, 0.0), new Vector2(0.115, 1.35), ...cylProfile.slice(1), new Vector2(0.03, 1.48), new Vector2(0.03, 1.55)], 20);
    for (let i = 0; i < 5; i++) b.add(cyl, i % 2 ? mat.cyl : mat.cylGrey, { position: [hw - 0.8, 0, 14.0 + i * 0.3] });
    member(b, mat.yellow, new Vector3(hw - 0.55, 1.1, 13.7), new Vector3(hw - 0.55, 1.1, 15.4), 0.05);
    this.colliders.push({ type: 'box', minX: hw - 1.0, maxX: hw, minZ: 13.7, maxZ: 15.4 });

    // --- ground power unit + umbilical to the saucer
    const gx = -8.2;
    const gz = 1.5;
    rbox(mat.yellow, 1.2, 1.15, 2.1, gx, 0.75, gz, 0.06);
    b.box(mat.black, 0.9, 0.3, 0.02, gx + 0.61, 0.95, gz, { uvTile: 1 });
    for (const zz of [-0.75, 0.75]) for (const xx of [-0.52, 0.52]) b.add(new CylinderGeometry(0.2, 0.2, 0.15, 18), mat.black, { position: [gx + xx, 0.2, gz + zz], rotation: [0, 0, Math.PI / 2] });
    b.add(new CylinderGeometry(0.03, 0.03, 1.6, 8), mat.column, { position: [gx, 0.32, gz - 1.6], rotation: [Math.PI / 2, 0, 0] });
    this.colliders.push({ type: 'box', minX: gx - 0.7, maxX: gx + 0.7, minZ: gz - 1.1, maxZ: gz + 1.1 });
    // cable: catenary from the GPU to the saucer belly port
    const pts = [];
    const a0 = new Vector3(gx + 0.6, 0.9, gz - 0.4);
    const a1 = new Vector3(-3.3, 1.28, -0.9);
    for (let i = 0; i <= 16; i++) {
      const k = i / 16;
      const p = new Vector3().lerpVectors(a0, a1, k);
      p.y = Math.max(0.05, p.y - Math.sin(k * Math.PI) * 1.3);
      pts.push(p);
    }
    for (let i = 0; i < pts.length - 1; i++) member(b, mat.black, pts[i], pts[i + 1], 0.07);

    // --- mobile boarding stairs (yellow) next to the saucer, stowed
    const st = new Group();
    st.position.set(9.5, 0, 6.5);
    st.rotation.y = -0.5;
    this.group.add(st);
    const sb = new Batcher();
    for (let i = 0; i < 9; i++) sb.add(new BoxGeometry(1.0, 0.04, 0.32), mat.column, { position: [0, 0.3 + i * 0.25, -i * 0.3] });
    for (const sx of [-0.55, 0.55]) {
      member(sb, mat.yellow, new Vector3(sx, 0.2, 0.2), new Vector3(sx, 2.5, -2.6), 0.08);
      member(sb, mat.yellow, new Vector3(sx, 0.9, 0.2), new Vector3(sx, 3.4, -2.6), 0.045);
      member(sb, mat.yellow, new Vector3(sx, 0.15, 0.3), new Vector3(sx, 0.15, -2.8), 0.1);
    }
    sb.add(new BoxGeometry(1.3, 0.06, 1.0), mat.column, { position: [0, 2.5, -3.0] });
    for (const [sx, sz] of [[-0.5, 0.25], [0.5, 0.25], [-0.5, -2.7], [0.5, -2.7]]) sb.add(new CylinderGeometry(0.08, 0.08, 0.08, 12), mat.black, { position: [sx, 0.06, sz], rotation: [0, 0, Math.PI / 2] });
    for (const m of sb.build({ name: 'stairs' })) st.add(m);
    this.colliders.push({ type: 'circle', x: 9.5 - 0.7, z: 6.5 - 1.2, r: 1.6 });

    // --- crates & pallets (north-west corner)
    const crateTex = signTexture(['PROPERTY OF U.S. GOVT', 'HANDLE WITH CARE'], { w: 512, h: 256, bg: '#5d5a3a', fg: '#e9e4cf', size: 0.18 });
    const crateMat = new MeshStandardMaterial({ map: crateTex, roughness: 0.82 });
    this.interior.push(crateMat);
    const crates = [
      [-26.5, 15.6, 1.4, 1.1, 1.2, 0.1],
      [-24.8, 15.8, 1.4, 1.1, 1.2, -0.05],
      [-26.3, 15.7, 1.2, 0.9, 1.0, 0.2, 1.1],
      [-27.3, 12.8, 1.8, 1.4, 1.6, 0.0],
      [-22.6, 16.2, 1.0, 0.8, 1.0, 0.4],
    ];
    for (const [x, z, sx, sy, sz, r, y = 0] of crates) {
      const m = new Mesh(new BoxGeometry(sx, sy, sz), crateMat);
      m.position.set(x, y + sy / 2 + 0.14, z);
      m.rotation.y = r;
      m.castShadow = m.receiveShadow = true;
      this.group.add(m);
      b.box(mat.wood, sx * 1.05, 0.14, sz * 1.05, x, y + 0.07, z, { uvTile: 1 });
      if (!y) this.colliders.push({ type: 'circle', x, z, r: Math.max(sx, sz) * 0.62 });
    }

    // --- safety: bollards, fire extinguishers on columns, cones
    for (const s of [-1, 1]) {
      for (let z = -16; z <= 16; z += 16) {
        const x = s * (hw - 0.75);
        const ext = new LatheGeometry([new Vector2(0, 0), new Vector2(0.08, 0), new Vector2(0.08, 0.45), new Vector2(0.06, 0.52), new Vector2(0.02, 0.56), new Vector2(0.0, 0.57)], 16);
        b.add(ext, mat.red, { position: [x, 0.9, z + 0.42] });
        b.box(mat.red, 0.3, 0.42, 0.02, x, 1.9, z + 0.42, { uvTile: 1 });
      }
    }
    const cone = new LatheGeometry([new Vector2(0, 0.71), new Vector2(0.03, 0.7), new Vector2(0.16, 0.06), new Vector2(0.2, 0.05), new Vector2(0.2, 0.0), new Vector2(0, 0)], 16);
    const coneMat = new MeshStandardMaterial({ color: 0xd9541c, roughness: 0.5 });
    this.interior.push(coneMat);
    for (const [x, z] of [[-3, -24], [3, -24], [-9, -24], [9, -24]]) b.add(cone, coneMat, { position: [x, 0, z] });
  }

  // ------------------------------------------------------------------ signage
  _signage() {
    const hd = HANGAR.D / 2;
    const add = (tex, w, h, x, y, z, ry, mat = null) => {
      const m = new Mesh(new PlaneGeometry(w, h), mat || new MeshStandardMaterial({ map: tex, roughness: 0.55, metalness: 0.05 }));
      if (!mat) this.interior.push(m.material);
      m.position.set(x, y, z);
      m.rotation.y = ry;
      this.group.add(m);
      return m;
    };
    // Inside, over the door header
    add(signTexture(['HANGAR 9'], { w: 1024, h: 256, bg: null, fg: '#e9ece9', size: 0.8 }), 10, 2.5, 0, 15.2, -hd + 0.2, 0).material.transparent = true;
    // The famous perimeter warning, both sides of the opening
    const warn = signTexture(
      [
        { text: 'WARNING', size: 0.2 },
        { text: 'RESTRICTED AREA', size: 0.13 },
        { text: 'It is unlawful to enter this area without', size: 0.06 },
        { text: 'permission of the Installation Commander', size: 0.06 },
        { text: 'USE OF DEADLY FORCE AUTHORIZED', size: 0.08 },
      ],
      { w: 512, h: 640, bg: '#f2efe6', fg: '#a3231b', size: 0.1 }
    );
    add(warn, 1.2, 1.5, -21.6, 2.1, -hd - 0.41, Math.PI);
    add(warn, 1.2, 1.5, 21.6, 2.1, -hd - 0.41, Math.PI);
    add(signTexture(['AUTHORIZED PERSONNEL ONLY'], { w: 1024, h: 160, bg: '#b8271e', fg: '#ffffff', size: 0.5 }), 3.2, 0.5, -HANGAR.W / 2 + 0.42, 3.0, -19.5, Math.PI / 2);
    const safety = signTexture([{ text: 'SAFETY IS NO ACCIDENT', size: 0.16 }, { text: '417', size: 0.4 }, { text: 'DAYS WITHOUT A LOST-TIME INCIDENT', size: 0.08 }], { w: 512, h: 512, bg: '#1d4a2b', fg: '#f0f0e8' });
    add(safety, 1.6, 1.6, HANGAR.W / 2 - 0.42, 2.6, 5.0, -Math.PI / 2);
    // exit signs (green, emissive)
    const exitMat = new MeshBasicMaterial({ map: signTexture(['EXIT'], { w: 256, h: 96, bg: '#0d5b2a', fg: '#e6ffe9', size: 0.62 }), color: new Color(2.4, 2.4, 2.4) });
    add(null, 0.5, 0.19, -22, 3.0, 18.85, Math.PI, exitMat);
    add(null, 0.5, 0.19, 10, 3.0, 18.85, Math.PI, exitMat);
    // wall number outside, above the door
    const nine = new Mesh(new PlaneGeometry(4, 3.4), new MeshStandardMaterial({ map: signTexture(['9'], { w: 256, h: 220, bg: null, fg: '#2c2f33', size: 0.95 }), transparent: true, roughness: 0.7 }));
    this.exterior.push(nine.material);
    nine.position.set(0, 15.0, -hd - 0.42);
    nine.rotation.y = Math.PI;
    this.group.add(nine);
  }

  // ------------------------------------------------------------------ lights
  _lights() {
    const { trussBottom } = HANGAR;
    // High-bay fixtures (visual): instanced body + emissive lens.
    const spots = [];
    for (const x of [-15, 0, 15]) for (const z of [-20, -12, -4, 4, 12]) spots.push([x, z]);
    const body = new InstancedMesh(new CylinderGeometry(0.32, 0.4, 0.22, 24), this.mat.column, spots.length);
    const lens = new InstancedMesh(new CylinderGeometry(0.34, 0.34, 0.01, 24), this.mat.lens, spots.length);
    const m = new Matrix4();
    spots.forEach(([x, z], i) => {
      m.makeTranslation(x, trussBottom - 0.45, z);
      body.setMatrixAt(i, m);
      m.makeTranslation(x, trussBottom - 0.565, z);
      lens.setMatrixAt(i, m);
    });
    this.group.add(body, lens);
    // Lighting. Two shadowed overhead keys carry most of the high-bays' output, so
    // everything on the floor sits in a soft double shadow like under rows of
    // fixtures; the area lights keep their long reflections in the epoxy and
    // the hull, and the sky-ish hemisphere is only a little lift in the blacks.
    // (Directional keys, not spots: a perspective shadow map is incompatible
    // with the logarithmic depth buffer the planet needs.)
    this.areaLights = [];
    for (const x of [-15, 0, 15]) {
      const l = new RectAreaLight(0xfff6ec, 0.95, 3.0, 36);
      l.position.set(x, trussBottom - 0.6, -4);
      l.lookAt(x, 0, -4);
      this.group.add(l);
      this.areaLights.push(l);
    }
    const hi = (this.quality?.name ?? 'high') === 'high';
    const keyLight = (color, intensity, pos, size, radius) => {
      const k = new DirectionalLight(color, intensity);
      k.position.set(...pos);
      k.target.position.set(0, 0, -2);
      k.castShadow = true;
      k.shadow.mapSize.set(size, size);
      const sc = k.shadow.camera;
      sc.left = -31;
      sc.right = 31;
      sc.top = 30;
      sc.bottom = -30;
      sc.near = 10;
      sc.far = 70;
      k.shadow.bias = -0.0002;
      k.shadow.normalBias = 0.03;
      k.shadow.radius = radius;
      this.group.add(k, k.target);
      return k;
    };
    this.key = keyLight(0xfff4e8, 2.7, [3, 42, 9], hi ? 4096 : 2048, 5);
    this.key2 = keyLight(0xf4f2ee, 1.1, [-11, 40, -13], 2048, 9);
    this.keys = [this.key, this.key2];
    this._keyCams = new Set(this.keys.map((k) => k.shadow.camera));
    this.hemi = new HemisphereLight(0xc6d4e2, 0x6b655c, 0.2);
    this.group.add(this.hemi);
  }

  /** Is a hangar-local point inside the building (for interior/exterior blending)? */
  insideness(p) {
    const hw = HANGAR.W / 2;
    const hd = HANGAR.D / 2;
    const dx = Math.max(0, Math.abs(p.x) - hw);
    const dzBack = Math.max(0, p.z - hd);
    const dzFront = Math.max(0, -hd - p.z);
    const d = Math.hypot(dx, dzBack, dzFront);
    // fade from the door plane outward over 14 m, and from 10 m inside the door
    const inner = Math.min(1, Math.max(0, (p.z + hd) / 12));
    return d > 0 ? Math.max(0, 0.35 - d / 40) : 0.35 + 0.65 * inner;
  }

  update(dt, t, live) {
    this._t += dt;
    setGrimeFrame(this.group.matrixWorld);
    this.dressing.update(dt, t, live);
    this.outside.update(dt, t, live);
    for (const s of this.screens) {
      s.state.live = live;
      s.state.clock = live.clock;
      s.update(dt, t);
    }
    for (const bl of this.blinkers) {
      const on = (this._t / bl.period + bl.phase) % 1 < 0.5;
      bl.m.color.copy(on ? bl.on : bl.off);
    }
  }
}

/** Floor paint: parking circle, stand-clear ring, centreline, walkways, hatching, the big "9". */
function markingsTexture() {
  const S = 2048;
  const W = HANGAR.W;
  const D = HANGAR.D;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  g.save();
  // Draw in metres (hangar-local x/z), canvas top = the door wall.
  g.scale(S / W, S / D);
  g.translate(W / 2, D / 2);
  const yellow = 'rgba(222,170,30,0.92)';
  const white = 'rgba(236,236,228,0.9)';
  const red = 'rgba(190,40,30,0.9)';
  // parking circle
  g.strokeStyle = yellow;
  g.lineWidth = 0.16;
  g.beginPath();
  g.arc(0, -2, 8.2, 0, Math.PI * 2);
  g.stroke();
  g.setLineDash([0.9, 0.6]);
  g.strokeStyle = red;
  g.lineWidth = 0.12;
  g.beginPath();
  g.arc(0, -2, 7.4, 0, Math.PI * 2);
  g.stroke();
  g.setLineDash([]);
  // cross hair at pad centre
  g.strokeStyle = yellow;
  g.lineWidth = 0.1;
  for (const [a, b2, c2, d2] of [[-1.2, -2, 1.2, -2], [0, -3.2, 0, -0.8]]) {
    g.beginPath();
    g.moveTo(a, b2);
    g.lineTo(c2, d2);
    g.stroke();
  }
  // centreline to the door (dashed)
  g.setLineDash([1.5, 1.0]);
  g.lineWidth = 0.15;
  g.beginPath();
  g.moveTo(0, -10.4);
  g.lineTo(0, -D / 2);
  g.stroke();
  g.setLineDash([]);
  // pedestrian walkways
  g.strokeStyle = yellow;
  g.lineWidth = 0.1;
  for (const x of [-13, -11.8, 12.6, 13.8]) {
    g.beginPath();
    g.moveTo(x, -24);
    g.lineTo(x, 17.6);
    g.stroke();
  }
  // walkway along the offices
  for (const z of [17.0, 18.2]) {
    g.beginPath();
    g.moveTo(-26, z);
    g.lineTo(26, z);
    g.stroke();
  }
  // hatched no-go zones in front of the tool chests and the server racks
  const hatch = (x0, z0, w, h) => {
    g.save();
    g.beginPath();
    g.rect(x0, z0, w, h);
    g.clip();
    g.strokeStyle = yellow;
    g.lineWidth = 0.18;
    for (let k = -h; k < w + h; k += 0.6) {
      g.beginPath();
      g.moveTo(x0 + k, z0);
      g.lineTo(x0 + k - h, z0 + h);
      g.stroke();
    }
    g.restore();
    g.strokeRect(x0, z0, w, h);
  };
  hatch(W / 2 - 3.2, 1.4, 1.2, 5.2);
  hatch(-W / 2 + 1.6, 0.6, 1.0, 2.9);
  // stand-clear text around the ring
  g.fillStyle = red;
  g.font = '700 0.55px Chakra Petch, Arial Narrow, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const msg = 'STAND CLEAR WHEN DRIVE IS ENERGIZED  ·  ';
  const text = msg + msg;
  const R = 6.85;
  for (let i = 0; i < text.length; i++) {
    const a = (i / text.length) * Math.PI * 2;
    g.save();
    g.translate(Math.sin(a) * R, -2 - Math.cos(a) * R);
    g.rotate(a);
    g.fillText(text[i], 0, 0);
    g.restore();
  }
  // the big 9 by the door and the pad label
  g.fillStyle = white;
  g.font = '700 7px Chakra Petch, Arial Narrow, sans-serif';
  g.fillText('9', 0, -18.5);
  g.font = '700 0.8px Chakra Petch, Arial Narrow, sans-serif';
  g.fillStyle = yellow;
  g.fillText('ARV PAD 1', 0, 7.2);
  g.restore();
  // Wear: knock out paint with noise.
  const img = g.getImageData(0, 0, S, S);
  const d = img.data;
  const rnd = mulberry32(9);
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = rnd();
    if (r < 0.06) d[i + 3] *= 0.15;
    else if (r < 0.2) d[i + 3] *= 0.7;
  }
  g.putImageData(img, 0, 0);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

