import {
  AdditiveBlending,
  CanvasTexture,
  CircleGeometry,
  Color,
  CylinderGeometry,
  Group,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
  RepeatWrapping,
  RingGeometry,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { hullTextures, paintedSteelTextures, signTexture } from '../textures.js';

/**
 * ARV-3 "Sport Model" — the training saucer.
 *
 * Saucer-local frame: origin at the belly centre, +Y up, −Z = nose (the side
 * the pilot faces). 13 m across, 3.85 m to the top of the canopy. The same
 * geometry/materials are reused for the hull you see from the cockpit.
 */
export const SAUCER = {
  radius: 6.5,
  halfHeight: 1.95,
  strut: 1.05, // belly height above the ground on extended struts
  eye: new Vector3(0, 2.92, 0.3),
  domeCenterY: 0.4216,
  domeRadius: 3.428,
  domeBaseY: 2.4,
  rampFoot: new Vector3(0, 0, 5.6), // where you stand to board (saucer-local, ground level)
};

const LOWER = [
  [0.0, 0.0],
  [0.9, 0.0],
  [1.0, 0.03],
  [1.6, 0.06],
  [2.2, 0.08],
  [2.6, 0.1],
  [3.6, 0.26],
  [4.6, 0.46],
  [5.4, 0.68],
  [6.0, 0.88],
  [6.35, 1.04],
  [6.5, 1.16],
];
const UPPER = [
  [6.5, 1.16],
  [6.48, 1.26],
  [6.36, 1.34],
  [6.0, 1.46],
  [5.2, 1.7],
  [4.3, 1.95],
  [3.4, 2.2],
  [2.95, 2.33],
  [2.86, 2.4],
  [2.78, 2.42],
];

const LAYER_SAUCER = 2;

function lathe(points, segments = 160) {
  const pts = points.map(([r, y]) => new Vector2(r, y));
  return new LatheGeometry(pts, segments);
}

export function hullMaterials(envMap = null) {
  const hull = hullTextures();
  const steel = paintedSteelTextures();
  const upper = new MeshStandardMaterial({
    name: 'hull_titanium',
    color: new Color(0.78, 0.8, 0.83),
    map: hull.map,
    metalness: 1,
    roughness: 1,
    roughnessMap: hull.roughnessMap,
    normalMap: hull.normalMap,
    normalScale: new Vector2(0.6, 0.6),
    envMap,
    envMapIntensity: 1,
  });
  const lower = new MeshStandardMaterial({
    name: 'hull_ceramic',
    color: new Color(0.16, 0.17, 0.18),
    metalness: 0.25,
    roughness: 0.62,
    normalMap: steel.normalMap,
    normalScale: new Vector2(0.4, 0.4),
    envMap,
  });
  const dark = new MeshStandardMaterial({ name: 'hull_dark', color: 0x1b1d20, metalness: 0.6, roughness: 0.42, envMap });
  const strut = new MeshStandardMaterial({
    name: 'strut',
    color: 0x9a9fa5,
    metalness: 1,
    roughness: 0.22,
    envMap,
  });
  return { upper, lower, dark, strut };
}

export class Saucer {
  constructor({ envMap = null } = {}) {
    this.group = new Group();
    this.group.name = 'saucer';
    this.mats = hullMaterials(envMap);
    this.power = 0;
    this.hover = 0;
    this.ramp = 1;
    this._t = 0;

    const lowerGeo = lathe(LOWER);
    const upperGeo = lathe(UPPER);
    this.upperGeo = upperGeo;
    this.lower = new Mesh(lowerGeo, this.mats.lower);
    this.upper = new Mesh(upperGeo, this.mats.upper);
    this.group.add(this.lower, this.upper);

    // Belly hub + emitter ring (glows with power).
    const hub = new Mesh(new CircleGeometry(0.95, 64), this.mats.dark);
    hub.rotation.x = Math.PI / 2;
    hub.position.y = -0.002;
    this.group.add(hub);
    this.emitterMat = new MeshBasicMaterial({ color: new Color(0.6, 0.9, 1.0), toneMapped: true });
    const emitter = new Mesh(new RingGeometry(2.22, 2.58, 160, 1), this.emitterMat);
    emitter.rotation.x = Math.PI / 2;
    emitter.position.y = 0.075;
    this.group.add(emitter);
    this.emitter = emitter;

    // Rim light band: 36 segments, slow chase when powered.
    this.rimMat = new MeshBasicMaterial({ color: 0xffffff, map: rimStripTexture() });
    const rim = new Mesh(new CylinderGeometry(6.505, 6.505, 0.07, 192, 1, true), this.rimMat);
    rim.position.y = 1.2;
    this.group.add(rim);
    this.rim = rim;

    // Canopy (exterior side). The cockpit draws its own inner face.
    const domeGeo = new SphereGeometry(SAUCER.domeRadius, 96, 32, 0, Math.PI * 2, 0, Math.asin(2.8 / SAUCER.domeRadius));
    this.domeMat = new MeshPhysicalMaterial({
      name: 'canopy_out',
      color: new Color(0.55, 0.62, 0.66),
      metalness: 0,
      roughness: 0.04,
      transparent: true,
      opacity: 0.38,
      envMap,
      envMapIntensity: 1.4,
      clearcoat: 1,
      clearcoatRoughness: 0.03,
      depthWrite: false,
    });
    const dome = new Mesh(domeGeo, this.domeMat);
    dome.position.y = SAUCER.domeCenterY;
    dome.renderOrder = 5;
    this.group.add(dome);
    this.dome = dome;
    // Something inside the canopy so it doesn't read as empty glass.
    const seatBack = new Mesh(new RoundedBoxGeometry(0.62, 0.9, 0.16, 3, 0.05), this.mats.dark);
    seatBack.position.set(0, 2.75, 0.62);
    this.group.add(seatBack);
    const consoleRing = new Mesh(new TorusGeometry(0.75, 0.12, 12, 48, Math.PI * 0.9), this.mats.dark);
    consoleRing.rotation.set(Math.PI / 2, 0, Math.PI * 0.05 + Math.PI);
    consoleRing.position.set(0, 2.55, 0.1);
    this.group.add(consoleRing);

    // Navigation lights + strobe.
    this.navLights = [];
    const nav = (color, x, z) => {
      const m = new MeshBasicMaterial({ color });
      const s = new Mesh(new SphereGeometry(0.06, 12, 8), m);
      s.position.set(x, 1.21, z);
      this.group.add(s);
      this.navLights.push(m);
      return m;
    };
    this.navRed = nav(new Color(4, 0.2, 0.15), -6.5, 0);
    this.navGreen = nav(new Color(0.2, 4, 0.5), 6.5, 0);
    this.strobe = nav(new Color(1, 1, 1), 0, 6.5);

    // Landing struts (3), retracting into fairings.
    this.struts = [];
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + Math.PI / 3;
      const leg = new Group();
      const r = 3.7;
      leg.position.set(Math.sin(a) * r, 0.34, Math.cos(a) * r);
      leg.rotation.y = a;
      const fairing = new Mesh(new RoundedBoxGeometry(0.5, 0.36, 1.0, 3, 0.08), this.mats.lower);
      fairing.position.y = 0.0;
      leg.add(fairing);
      const piston = new Group();
      const rod = new Mesh(new CylinderGeometry(0.075, 0.075, 1.4, 20), this.mats.strut);
      rod.position.y = -0.62;
      const sleeve = new Mesh(new CylinderGeometry(0.12, 0.12, 0.55, 20), this.mats.dark);
      sleeve.position.y = -0.05;
      const pad = new Mesh(new CylinderGeometry(0.34, 0.4, 0.09, 32), this.mats.dark);
      pad.position.y = -(SAUCER.strut + 0.34) + 0.045; // pad sole on the ground
      piston.add(rod, sleeve, pad);
      leg.add(piston);
      leg.userData.piston = piston;
      this.group.add(leg);
      this.struts.push(leg);
    }

    // Boarding ramp at the tail (+Z), hinged at the hull.
    const rampPivot = new Group();
    rampPivot.position.set(0, 0.42, 3.55);
    const ramp = new Mesh(new RoundedBoxGeometry(1.25, 0.08, 2.35, 2, 0.03), this.mats.lower);
    ramp.position.set(0, 0, 1.17);
    const tread = new Mesh(new RoundedBoxGeometry(1.1, 0.012, 2.2, 1, 0.004), new MeshStandardMaterial({ color: 0x222426, roughness: 0.9, metalness: 0.1, map: treadTexture() }));
    tread.position.set(0, 0.046, 1.17);
    rampPivot.add(ramp, tread);
    this.group.add(rampPivot);
    this.rampPivot = rampPivot;
    // Hatch well: the lit opening up into the cabin while the ramp is down.
    this.wellMat = new MeshStandardMaterial({ color: 0x0a0b0c, roughness: 0.9, emissive: new Color(1.0, 0.86, 0.66), emissiveMap: wellTexture(), emissiveIntensity: 0 });
    const well = new Mesh(new RoundedBoxGeometry(1.3, 0.04, 2.4, 2, 0.02), this.wellMat);
    well.position.set(0, 0.36, 4.72);
    well.rotation.x = -0.24;
    this.group.add(well);
    // cabin light spilling down the ramp
    this.hatchGlow = new PointLight(new Color(1.0, 0.84, 0.62), 0, 7, 2);
    this.hatchGlow.position.set(0, 0.05, 4.4);
    this.group.add(this.hatchGlow);
    const hatchLight = new MeshBasicMaterial({ color: new Color(1.6, 1.4, 1.0) });
    this.hatchLight = hatchLight;
    const hl = new Mesh(new RoundedBoxGeometry(1.0, 0.02, 0.08, 1, 0.01), hatchLight);
    hl.position.set(0, 0.34, 3.6);
    this.group.add(hl);

    // Stencils.
    // Stencils, laid flat on the upper hull (16.7° slope between r 5.2–6.0 m).
    const decal = (lines, w, h, opts, azimuth, r) => {
      const tex = signTexture(lines, { w: 512, h: Math.round((512 * h) / w), bg: null, fg: '#1d2024', ...opts });
      const m = new Mesh(new PlaneGeometry(w, h), new MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.5, metalness: 0.6, depthWrite: false }));
      const y = 1.46 + ((6.0 - r) / 0.8) * 0.24 + 0.008;
      m.position.set(Math.sin(azimuth) * r, y, Math.cos(azimuth) * r);
      m.rotation.set(-1.279, azimuth, 0, 'YXZ');
      this.group.add(m);
      return m;
    };
    decal(['ARV-3  ·  S-9'], 1.6, 0.22, { size: 0.7 }, 0, 5.3);
    decal(['NO STEP'], 0.8, 0.16, { size: 0.7, fg: '#8a1d17' }, Math.PI + 0.47, 5.35);
    decal(['NO STEP'], 0.8, 0.16, { size: 0.7, fg: '#8a1d17' }, Math.PI - 0.47, 5.35);

    // Under-glow on the ground / hangar floor.
    this.glow = new PointLight(new Color(0.55, 0.85, 1.0), 0, 16, 2);
    this.glow.position.set(0, -0.6, 0);
    this.group.add(this.glow);
    const pool = new Mesh(
      new CircleGeometry(5.2, 64),
      new MeshBasicMaterial({ map: poolTexture(), transparent: true, blending: AdditiveBlending, depthWrite: false, color: new Color(0.5, 0.8, 1.0), opacity: 0 })
    );
    pool.rotation.x = -Math.PI / 2;
    this.pool = pool; // added to the world by the owner (stays on the ground)

    for (const m of [this.lower, this.upper, hub, seatBack, consoleRing]) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
    this.group.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = o.material !== this.domeMat && !o.material.transparent;
        o.layers.set(LAYER_SAUCER);
      }
    });
    this.setPower(0);
    this.setStruts(1);
    this.setRamp(1);
  }

  static get LAYER() {
    return LAYER_SAUCER;
  }

  setEnvMap(env) {
    for (const m of Object.values(this.mats)) m.envMap = env;
    this.domeMat.envMap = env;
  }

  setPower(p) {
    this.power = p;
    const c = 0.15 + p * 5.5;
    this.emitterMat.color.setRGB(0.55 * c, 0.85 * c, 1.0 * c);
    this.rimMat.color.setScalar(0.25 + p * 3.5);
    this.hatchLight.color.setRGB(1.6, 1.4, 1.0).multiplyScalar(this.ramp > 0.1 ? 1 : 0.05);
  }

  /** 1 = extended (landed), 0 = retracted (flying). */
  setStruts(e) {
    this.strutExt = e;
    for (const leg of this.struts) {
      leg.userData.piston.position.y = (1 - e) * 1.05;
      leg.userData.piston.visible = e > 0.02;
    }
  }

  /** 1 = deployed (foot on the floor, 38.7° down), 0 = stowed inside the hull. */
  setRamp(open) {
    this.ramp = open;
    this.rampPivot.rotation.x = -0.197 + open * (0.675 + 0.197);
    const lit = Math.min(1, open * 1.6);
    this.wellMat.emissiveIntensity = 0.9 * lit;
    this.hatchGlow.intensity = 4.5 * lit;
  }

  update(dt, t, { thrust = 0, hover = 0 } = {}) {
    this._t += dt;
    const p = this.power;
    // rim chase
    this.rimMat.map.offset.x = (this._t * 0.06 * (0.2 + p)) % 1;
    const pulse = 0.85 + 0.15 * Math.sin(this._t * 7.0) * p;
    const e = (0.15 + p * (4.0 + thrust * 6)) * pulse;
    this.emitterMat.color.setRGB(0.5 * e, 0.82 * e, 1.0 * e);
    this.glow.intensity = p * (18 + thrust * 30) * pulse * (0.4 + hover * 0.6);
    const strobeOn = p > 0.05 && this._t % 1.6 < 0.06;
    this.strobe.color.setScalar(strobeOn ? 12 : 0.05);
    this.navRed.color.setRGB(4, 0.2, 0.15).multiplyScalar(p > 0.05 ? 1 : 0.05);
    this.navGreen.color.setRGB(0.2, 4, 0.5).multiplyScalar(p > 0.05 ? 1 : 0.05);
  }
}

function rimStripTexture() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 8;
  const g = c.getContext('2d');
  g.fillStyle = '#05080a';
  g.fillRect(0, 0, 1024, 8);
  for (let i = 0; i < 36; i++) {
    const x = (i / 36) * 1024;
    const grad = g.createLinearGradient(x, 0, x + 1024 / 36, 0);
    grad.addColorStop(0, 'rgba(140,220,255,0.0)');
    grad.addColorStop(0.2, 'rgba(170,235,255,1)');
    grad.addColorStop(0.75, 'rgba(170,235,255,1)');
    grad.addColorStop(1, 'rgba(140,220,255,0.0)');
    g.fillStyle = grad;
    g.fillRect(x + 3, 1, 1024 / 36 - 6, 6);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = RepeatWrapping;
  return t;
}

/** Cabin interior seen up the hatch: brighter toward the cabin, panel seams, two lamps. */
function wellTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#d8cbb6');
  grad.addColorStop(0.45, '#6d655a');
  grad.addColorStop(1, '#141210');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 256);
  g.fillStyle = 'rgba(0,0,0,0.45)';
  for (let y = 28; y < 256; y += 36) g.fillRect(0, y, 128, 3);
  g.fillRect(10, 0, 3, 256);
  g.fillRect(115, 0, 3, 256);
  g.fillStyle = '#fff6e6';
  g.fillRect(30, 8, 68, 7);
  g.fillRect(30, 74, 68, 5);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.flipY = false; // canvas top = the hinge end, toward the cabin
  return t;
}

function treadTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#2a2c2e';
  g.fillRect(0, 0, 128, 256);
  g.fillStyle = '#3c3f42';
  for (let y = 6; y < 256; y += 14) g.fillRect(6, y, 116, 5);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

function poolTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.22)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  return new CanvasTexture(c);
}

