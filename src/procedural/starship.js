import {
  BoxGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  Shape,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three';
import { createHullMaterial, mat } from './materials.js';
import { gridFinAlpha, ventTexture } from './textures.js';

/**
 * Starship + Super Heavy, built to the published architecture:
 *   ship 52 m × 9 m (35 m barrel + 17 m ogive nose), 3 sea-level Raptors + 3 RVacs,
 *   2 forward + 2 aft flaps, hexagonal tile field on the windward (+Z) half;
 *   booster 71 m × 9 m, 33 Raptors (3 / 10 / 20), 4 grid fins, chines, vented
 *   hot-staging ring (+1.8 m). Full stack ≈ 124.8 m.
 *
 * Local frame for both: origin on the axis at the engine plane, +Y up, tiles/
 * windward = +Z, leeward (hatch, windows) = −Z. Node names match the manifest
 * so BlendKit replacements are drop-in.
 */

export const DIMS = {
  radius: 4.5,
  shipBarrel: 35,
  shipNose: 17,
  shipLength: 52,
  boosterLength: 71,
  hotStage: 1.8,
  hatchY: 33.25, // bottom of the crew hatch, ship-local
  hatchH: 1.8,
  hatchW: 1.0,
  // Crew-deck window band (leeward). The interior (cabin.js) cuts matching openings.
  windowY: 36.9, // glass centre, ship-local
  windowCount: 7,
  windowStep: (11.5 * Math.PI) / 180,
  windowW: 0.72,
  windowH: 0.62,
};

/** Hull radius at ship-local height y (barrel or ogive). */
export function shipRadiusAt(y) {
  return y <= DIMS.shipBarrel ? DIMS.radius : ogive(y - DIMS.shipBarrel);
}

/** Tangent-ogive radius at height y above the nose base. */
function ogive(y, L = DIMS.shipNose, R = DIMS.radius) {
  const rho = (R * R + L * L) / (2 * R);
  const x = L - y; // distance from tip
  return Math.sqrt(Math.max(0, rho * rho - (L - x) * (L - x))) + R - rho;
}

function raptorGeometry(kind) {
  // Bell profile (radius, y) from throat to exit. y = 0 at the exit plane.
  const pts = [];
  const len = kind === 'vac' ? 2.8 : 1.5;
  const rExit = kind === 'vac' ? 1.15 : 0.65;
  const rThroat = kind === 'vac' ? 0.22 : 0.2;
  const n = 16;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const r = rThroat + (rExit - rThroat) * Math.pow(t, 0.62);
    pts.push(new Vector2(r, len * (1 - t)));
  }
  return new LatheGeometry(pts, 32);
}

function makePowerhead(kind) {
  const g = new Group();
  const body = new Mesh(new CylinderGeometry(0.42, 0.3, 1.1, 16), mat('engineDark'));
  body.position.y = (kind === 'vac' ? 2.8 : 1.5) + 0.55;
  const pumpA = new Mesh(new CylinderGeometry(0.22, 0.22, 0.9, 12), mat('engineDark'));
  pumpA.position.set(0.35, body.position.y + 0.1, 0);
  const pumpB = pumpA.clone();
  pumpB.position.x = -0.35;
  g.add(body, pumpA, pumpB);
  return g;
}

/** A single Raptor for close-up use (landed ship). */
function makeRaptor(kind) {
  const g = new Group();
  const bell = new Mesh(raptorGeometry(kind), mat('engine'));
  bell.castShadow = true;
  g.add(bell, makePowerhead(kind));
  return g;
}

function flapGeometry(rootChord, tipChord, span, thickness, shear = 0) {
  // `shear` leans the root edge inward toward the top so the hinge follows a tapering nose.
  const s = new Shape();
  const r = rootChord / 2;
  const t = tipChord / 2;
  const off = (y) => -(y / rootChord) * shear;
  s.moveTo(off(-r), -r);
  s.lineTo(span - 0.4 + off(-t), -t);
  s.quadraticCurveTo(span + off(-t), -t, span + off(-t + 0.4), -t + 0.4);
  s.lineTo(span + off(t - 0.4), t - 0.4);
  s.quadraticCurveTo(span + off(t), t, span - 0.4 + off(t), t);
  s.lineTo(off(r), r);
  s.closePath();
  const g = new ExtrudeGeometry(s, { depth: thickness, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 2 });
  g.translate(0, 0, -thickness / 2);
  return g;
}

/**
 * Add a flap whose root sits on the hull at angle `theta` (radians from +Z).
 * The pivot is named per the manifest; rotate it about local Y to fold.
 */
function addFlap(parent, name, theta, yCenter, dims, material, radiusAt) {
  const pivot = new Object3D();
  pivot.name = name;
  const rC = radiusAt(yCenter) - 0.05;
  const shear = radiusAt(yCenter - dims.root / 2) - radiusAt(yCenter + dims.root / 2);
  const flipped = theta < 0;
  pivot.position.set(rC * Math.sin(theta), yCenter, rC * Math.cos(theta));
  pivot.rotation.y = theta - Math.PI / 2;
  // Mirror the left side so the tiled face always points windward (+Z).
  if (flipped) pivot.rotateX(Math.PI);
  const mesh = new Mesh(flapGeometry(dims.root, dims.tip, dims.span, dims.thick, flipped ? -shear : shear), material);
  pivot.add(mesh);
  // Hinge fairing
  const fairing = new Mesh(new BoxGeometry(0.9, dims.root * 0.95, 0.9), mat('darkSteel'));
  fairing.position.x = 0.1;
  pivot.add(fairing);
  parent.add(pivot);
  return pivot;
}

/** Curved patch on the hull (windows, hatch, plates). */
function hullPatch(width, height, radius, theta, y, material, segments = 6) {
  const ang = width / radius;
  const g = new CylinderGeometry(radius, radius, height, segments, 1, true, theta - ang / 2, ang);
  const m = new Mesh(g, material);
  m.position.y = y + height / 2;
  return m;
}

export function buildShip({ variant = 'crew', frost = 0, heat = 0, dust = 0, legs = false, soot = 0 } = {}) {
  const root = new Group();
  root.name = variant === 'tanker' ? 'starship_tanker' : 'starship_ship';
  const R = DIMS.radius;

  const hull = createHullMaterial({
    mode: 'cylinder',
    tiles: true,
    tileHalf: 1.66,
    frost: [1.5, 15.5, 17, 28],
    frostAmount: frost,
    heat,
    dust,
    soot,
    baseY: -1,
  });
  const flapMat = createHullMaterial({ mode: 'planar', tiles: true, heat, dust: dust * 0.4 });

  // Barrel
  const barrel = new Mesh(new CylinderGeometry(R, R, DIMS.shipBarrel + 1, 128, 1, true), hull);
  barrel.position.y = (DIMS.shipBarrel + 1) / 2 - 1;
  barrel.castShadow = barrel.receiveShadow = true;
  barrel.name = 'hull_barrel';
  root.add(barrel);

  // Nose (tangent ogive, slightly blunted tip)
  const pts = [];
  const N = 40;
  for (let i = 0; i <= N; i++) {
    const y = (i / N) * (DIMS.shipNose - 0.25);
    pts.push(new Vector2(Math.max(0.001, ogive(y)), DIMS.shipBarrel + y));
  }
  pts.push(new Vector2(0.001, DIMS.shipBarrel + DIMS.shipNose));
  const nose = new Mesh(new LatheGeometry(pts, 128), hull);
  nose.castShadow = nose.receiveShadow = true;
  nose.name = 'hull_nose';
  root.add(nose);

  // Aft closure + engines
  const aft = new Mesh(new CircleGeometry(R, 64), mat('darkSteel'));
  aft.rotation.x = Math.PI / 2;
  aft.position.y = 0.6;
  root.add(aft);
  const engines = new Group();
  engines.name = 'engines';
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const sl = makeRaptor('sl');
    sl.position.set(Math.sin(a) * 1.05, -1.0, Math.cos(a) * 1.05);
    engines.add(sl);
    if (variant !== 'stackedHidden') {
      const vac = makeRaptor('vac');
      const b = a + Math.PI / 3;
      vac.position.set(Math.sin(b) * 2.85, -1.0, Math.cos(b) * 2.85);
      engines.add(vac);
    }
  }
  root.add(engines);

  // Flaps — forward pair slightly leeward (V2+ layout), aft pair on the sides.
  const radiusAt = (y) => (y <= DIMS.shipBarrel ? R : ogive(y - DIMS.shipBarrel));
  const fwd = { root: 7.4, tip: 4.4, span: 3.5, thick: 0.42 };
  const aftDims = { root: 10.2, tip: 7.0, span: 4.1, thick: 0.6 };
  addFlap(root, 'pivot_flap_fwd_R', (100 * Math.PI) / 180, 41.2, fwd, flapMat, radiusAt);
  addFlap(root, 'pivot_flap_fwd_L', (-100 * Math.PI) / 180, 41.2, fwd, flapMat, radiusAt);
  addFlap(root, 'pivot_flap_aft_R', Math.PI / 2, 6.6, aftDims, flapMat, radiusAt);
  addFlap(root, 'pivot_flap_aft_L', -Math.PI / 2, 6.6, aftDims, flapMat, radiusAt);

  const nodes = {};
  if (variant === 'crew') {
    // Window band (warm, lived-in) above the hatch, leeward side.
    const winMat = mat('windowWarm');
    const frameMat = mat('darkSteel');
    const wr = ogive(DIMS.windowY - DIMS.shipBarrel) + 0.012;
    const half = (DIMS.windowCount - 1) / 2;
    for (let k = -half; k <= half; k++) {
      const theta = Math.PI + k * DIMS.windowStep;
      const fw = DIMS.windowW + 0.12;
      const fh = DIMS.windowH + 0.12;
      const frame = hullPatch(fw, fh, wr, theta, DIMS.windowY - fh / 2, frameMat, 6);
      const glass = hullPatch(DIMS.windowW, DIMS.windowH, wr + 0.01, theta, DIMS.windowY - DIMS.windowH / 2, winMat, 6);
      root.add(frame, glass);
    }
    // Crew hatch: dark seam frame, a lit interior plate behind, and the door on a hinge pivot.
    const hatchTheta = Math.PI;
    const interior = hullPatch(DIMS.hatchW, DIMS.hatchH, R + 0.006, hatchTheta, DIMS.hatchY, new MeshStandardMaterial({ color: 0x050403, emissive: new Color(1.0, 0.82, 0.6), emissiveIntensity: 3.2 }), 6);
    interior.name = 'hatch_interior';
    root.add(interior);
    const seam = hullPatch(DIMS.hatchW + 0.14, DIMS.hatchH + 0.14, R + 0.004, hatchTheta, DIMS.hatchY - 0.07, mat('rubber'), 6);
    root.add(seam);
    const hinge = new Object3D();
    hinge.name = 'pivot_hatch_door';
    const halfAng = DIMS.hatchW / 2 / R;
    hinge.position.set(R * Math.sin(hatchTheta + halfAng), DIMS.hatchY, R * Math.cos(hatchTheta + halfAng));
    const door = hullPatch(DIMS.hatchW, DIMS.hatchH, R + 0.02, hatchTheta, 0, new MeshStandardMaterial({ color: 0xb4b6b9, metalness: 1, roughness: 0.32 }), 6);
    door.position.x -= hinge.position.x;
    door.position.z -= hinge.position.z;
    const handle = new Mesh(new TorusGeometry(0.11, 0.022, 8, 24), mat('darkSteel'));
    // Handle on the side opposite the hinge, just proud of the door skin.
    handle.position.set(0.3 - hinge.position.x, DIMS.hatchH * 0.52, -R - 0.06 - hinge.position.z);
    door.add(handle);
    hinge.add(door);
    root.add(hinge);
    nodes.hatch = hinge;
    const anchor = new Object3D();
    anchor.name = 'anchor_hatch';
    anchor.position.set(0, DIMS.hatchY, -R);
    root.add(anchor);
    nodes.anchorHatch = anchor;
  } else {
    // Tanker: docking ring + QD plate on the leeward aft skirt.
    const dock = new Mesh(new TorusGeometry(0.9, 0.12, 12, 32), mat('darkSteel'));
    dock.position.set(0, 3.2, -R - 0.08);
    root.add(dock);
  }

  // RCS thruster pods near the nose (small dark plates)
  for (const th of [Math.PI * 0.5, -Math.PI * 0.5]) {
    const pod = hullPatch(0.5, 0.35, ogive(46 - DIMS.shipBarrel) + 0.02, th + 0.3, 46, mat('darkSteel'), 3);
    root.add(pod);
  }

  if (legs) {
    // Six landing legs around the aft skirt (Mars variant).
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      const leg = new Group();
      const strut = new Mesh(new BoxGeometry(0.45, 3.4, 0.45), mat('darkSteel'));
      strut.position.set(0, 0.2, 0);
      strut.rotation.x = -0.32;
      const pad = new Mesh(new CylinderGeometry(0.75, 0.9, 0.25, 16), mat('darkSteel'));
      pad.position.set(0, -1.45, 0.55);
      strut.castShadow = pad.castShadow = true;
      leg.add(strut, pad);
      leg.position.set(Math.sin(a) * (R - 0.25), -0.4, Math.cos(a) * (R - 0.25));
      leg.rotation.y = a;
      root.add(leg);
    }
  }

  root.userData = { hull, flapMat, nodes };
  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return root;
}

export function buildBooster({ frost = 0, soot = 0.6 } = {}) {
  const root = new Group();
  root.name = 'super_heavy';
  const R = DIMS.radius;
  const L = DIMS.boosterLength;
  const hull = createHullMaterial({ mode: 'cylinder', tiles: false, frost: [2.5, 43, 45.5, 66], frostAmount: frost, soot, baseY: 0 });

  const barrel = new Mesh(new CylinderGeometry(R, R, L, 128, 1, true), hull);
  barrel.position.y = L / 2;
  root.add(barrel);

  // Hot-staging ring (vented) + dark forward dome glimpsed through the slots
  const ventTex = ventTexture().clone();
  ventTex.needsUpdate = true;
  ventTex.repeat.set(1, 1);
  const ring = new Mesh(
    new CylinderGeometry(R, R, DIMS.hotStage, 96, 1, true),
    new MeshStandardMaterial({ map: ventTex, metalness: 0.85, roughness: 0.4, color: 0xffffff })
  );
  ring.position.y = L + DIMS.hotStage / 2;
  const core = new Mesh(new CylinderGeometry(R - 0.35, R - 0.35, DIMS.hotStage, 48), mat('darkSteel'));
  core.position.y = ring.position.y;
  root.add(ring, core);

  // Aft: engine bay plate + 33 Raptors (inner 3, middle 10, outer 20) as instances.
  const plate = new Mesh(new CircleGeometry(R, 64), mat('engineDark'));
  plate.rotation.x = Math.PI / 2;
  plate.position.y = 0.8;
  root.add(plate);
  const rings = [
    [3, 0.95],
    [10, 2.45],
    [20, 3.85],
  ];
  const count = 33;
  const bells = new InstancedMesh(raptorGeometry('sl'), mat('engine'), count);
  const heads = new InstancedMesh(new CylinderGeometry(0.42, 0.3, 1.1, 12), mat('engineDark'), count);
  const m4 = new Matrix4();
  let i = 0;
  for (const [n, rr] of rings) {
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + (n === 10 ? 0.15 : 0);
      const x = Math.sin(a) * rr;
      const z = Math.cos(a) * rr;
      m4.makeTranslation(x, -0.4, z);
      bells.setMatrixAt(i, m4);
      m4.makeTranslation(x, 1.65, z);
      heads.setMatrixAt(i, m4);
      i++;
    }
  }
  bells.castShadow = true;
  root.add(bells, heads);

  // Chines along the sides
  for (const th of [Math.PI / 2, -Math.PI / 2]) {
    const chine = new Mesh(new BoxGeometry(0.32, 56, 0.42), hull);
    chine.position.set(Math.sin(th) * (R + 0.18), 35, Math.cos(th) * (R + 0.18));
    chine.rotation.y = th;
    root.add(chine);
  }

  // Grid fins: waffle paddles sticking out near the top, lattice faces up/down.
  const finTex = gridFinAlpha();
  const finMat = new MeshStandardMaterial({ color: 0x2b2d30, metalness: 0.75, roughness: 0.45, alphaMap: finTex, alphaTest: 0.5, side: DoubleSide });
  for (let k = 0; k < 4; k++) {
    const th = Math.PI / 4 + (k * Math.PI) / 2;
    const fin = new Group();
    fin.name = `grid_fin_${k + 1}`;
    const lattice = new Mesh(new PlaneGeometry(3.0, 4.2), finMat);
    lattice.rotation.x = -Math.PI / 2;
    lattice.position.set(0, 0, 2.1);
    const frameA = new Mesh(new BoxGeometry(3.1, 0.55, 0.12), mat('darkSteel'));
    frameA.position.set(0, 0, 4.2);
    const sideA = new Mesh(new BoxGeometry(0.12, 0.55, 4.2), mat('darkSteel'));
    sideA.position.set(1.5, 0, 2.1);
    const sideB = sideA.clone();
    sideB.position.x = -1.5;
    const mount = new Mesh(new BoxGeometry(1.4, 1.2, 0.8), mat('darkSteel'));
    mount.position.set(0, 0, 0.2);
    fin.add(lattice, frameA, sideA, sideB, mount);
    fin.position.set(Math.sin(th) * R, L - 4.5, Math.cos(th) * R);
    fin.rotation.y = th;
    root.add(fin);
  }

  // Vent / QD plates
  const qd = new Mesh(new BoxGeometry(2.2, 1.6, 0.4), mat('darkSteel'));
  qd.position.set(0, 2.2, -R - 0.15);
  root.add(qd);

  root.userData = { hull };
  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return root;
}

/** Stack helper: booster at y = baseY, ship on top of the hot-stage ring. */
export function buildStack({ baseY = 20, frost = 1, soot = 0.55 } = {}) {
  const stack = new Group();
  stack.name = 'stack';
  const booster = buildBooster({ frost, soot });
  booster.position.y = baseY;
  const ship = buildShip({ variant: 'crew', frost: frost * 0.8 });
  ship.position.y = baseY + DIMS.boosterLength + DIMS.hotStage;
  stack.add(booster, ship);
  stack.userData = { booster, ship, shipBaseY: ship.position.y };
  return stack;
}

export const _tmp = { Quaternion, Vector3 };
