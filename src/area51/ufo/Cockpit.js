import {
  AdditiveBlending,
  BackSide,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PointLight,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  TubeGeometry,
  CatmullRomCurve3,
  Vector2,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { SAUCER } from './Saucer.js';
import { paintedSteelTextures } from '../textures.js';
import { cockpitPage, Screen } from '../hangar/screens.js';
import { buildCabin } from './cabin.js';

/**
 * The cockpit — the "near" layer, drawn after the world with its own depth.
 *
 * Saucer-local frame (same as Saucer.js). The pilot sits under the canopy at
 * (0, 2.1, 0.3); a horseshoe console wraps around in front with the two
 * hand pads — the only flight controls. You see out through the canopy and
 * over the brushed upper hull.
 */
export const PILOT = new Vector3(0, 0, 0.3);
export const PAD = {
  // pad centres (saucer-local) and the console top tilt toward the pilot
  left: new Vector3(-0.235, 2.6, -0.2),
  right: new Vector3(0.235, 2.6, -0.2),
  tilt: 0.16,
  toeIn: 0.12, // relaxed hands angle their fingers in toward the centreline
};

export class Cockpit {
  constructor({ saucer }) {
    this.scene = new Scene();
    this.scene.name = 'Cockpit';
    this.root = new Group();
    this.scene.add(this.root);
    this.saucer = saucer;
    const steel = paintedSteelTextures();
    this.mat = {
      shell: new MeshStandardMaterial({ name: 'cockpit_shell', color: 0x24272b, roughness: 0.55, metalness: 0.45, envMapIntensity: 0.55, normalMap: steel.normalMap, normalScale: new Vector2(0.35, 0.35) }),
      trim: new MeshStandardMaterial({ name: 'cockpit_trim', color: 0x878d93, roughness: 0.32, metalness: 1, envMapIntensity: 0.7 }),
      soft: new MeshStandardMaterial({ name: 'cockpit_soft', color: 0x15171a, roughness: 0.92, metalness: 0 }),
      // Reflection-only glass: black base, additive, so the dome shows sky and sun
      // glints on top of the world without fogging it.
      glassIn: new MeshStandardMaterial({ name: 'canopy_in', color: 0x000000, metalness: 0, roughness: 0.04, transparent: true, blending: AdditiveBlending, side: BackSide, depthWrite: false, envMapIntensity: 1.4 }),
    };

    // Upper hull seen through the canopy (same geometry as outside; its own
    // material, since the near layer has its own lights).
    this.mat.hull = saucer.mats.upper.clone();
    const hull = new Mesh(saucer.upperGeo, this.mat.hull);
    this.root.add(hull);
    const rim = new Mesh(new CylinderGeometry(6.505, 6.505, 0.07, 192, 1, true), saucer.rimMat);
    rim.position.y = 1.2;
    this.root.add(rim);
    // Canopy collar + inner glass + frame ribs.
    const collar = new Mesh(new TorusGeometry(2.82, 0.06, 12, 128), this.mat.trim);
    collar.rotation.x = Math.PI / 2;
    collar.position.y = 2.41;
    this.root.add(collar);
    const domeGeo = new SphereGeometry(SAUCER.domeRadius - 0.01, 96, 32, 0, Math.PI * 2, 0, Math.asin(2.8 / SAUCER.domeRadius));
    const glass = new Mesh(domeGeo, this.mat.glassIn);
    glass.position.y = SAUCER.domeCenterY;
    glass.renderOrder = 10;
    this.root.add(glass);
    const cap = Math.asin(2.8 / SAUCER.domeRadius);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
      const pts = [];
      for (let i = 0; i <= 16; i++) {
        const th = (i / 16) * cap;
        const r = (SAUCER.domeRadius - 0.03) * Math.sin(th);
        pts.push(new Vector3(Math.sin(a) * r, SAUCER.domeCenterY + (SAUCER.domeRadius - 0.03) * Math.cos(th), Math.cos(a) * r));
      }
      const rib = new Mesh(new TubeGeometry(new CatmullRomCurve3(pts), 24, 0.022, 6, false), this.mat.trim);
      rib.castShadow = true;
      this.root.add(rib);
    }
    const crown = new Mesh(new TorusGeometry(0.22, 0.03, 8, 32), this.mat.trim);
    crown.rotation.x = Math.PI / 2;
    crown.position.y = SAUCER.domeCenterY + SAUCER.domeRadius - 0.04;
    this.root.add(crown);

    // The cabin itself (console, panels, seat, floor, tub wall) is cabin.js, built below once the screens exist.

    // Hand pads: dark glass with an engraved handprint that glows.
    this.pads = {};
    for (const side of ['left', 'right']) {
      const tex = padTexture(side);
      const m = new MeshStandardMaterial({
        name: `pad_${side}`,
        color: 0x040506,
        roughness: 0.34,
        metalness: 0.0,
        envMapIntensity: 0.35,
        emissive: new Color(0.35, 0.85, 1.0),
        emissiveMap: tex,
        emissiveIntensity: 0.6,
      });
      const pad = new Mesh(new RoundedBoxGeometry(0.21, 0.012, 0.29, 2, 0.02), m);
      pad.position.copy(PAD[side]);
      pad.position.y -= 0.004;
      pad.rotation.set(PAD.tilt, 0, 0);
      pad.receiveShadow = true;
      this.root.add(pad);
      const bezel = new Mesh(new RoundedBoxGeometry(0.24, 0.01, 0.32, 2, 0.025), this.mat.trim);
      bezel.position.copy(PAD[side]);
      bezel.position.y -= 0.009;
      bezel.rotation.copy(pad.rotation);
      this.root.add(bezel);
      // cyan bounce onto the glove from the glass (sits under the palm, so no hotspot on the pad)
      const glow = new PointLight(new Color(0.4, 0.85, 1.0), 0.0, 0.35, 2);
      glow.position.copy(PAD[side]).add(new Vector3(0, 0.012, 0.02));
      this.root.add(glow);
      this.pads[side] = { mesh: pad, mat: m, glow, level: 0.6 };
    }

    // Displays on the console face (toward the pilot).
    this.screens = [];
    const addScreen = (w, h, res, az, y, r, draw) => {
      const s = new Screen(w, h, res, 1.6);
      s.draw = draw;
      s.fps = 12;
      s.mesh.position.set(PILOT.x + Math.sin(az) * r, y, PILOT.z + Math.cos(az) * r);
      s.mesh.lookAt(PILOT.x, y + 0.18, PILOT.z);
      this.root.add(s.mesh);
      this.screens.push(s);
      return s;
    };
    // MFDs stand in bezels on the deck (cabin.js), so their lower edge clears it.
    this.leftScreen = addScreen(0.3, 0.17, [384, 216], Math.PI + 0.72, 2.725, 0.82, cockpitPage('nav'));
    this.rightScreen = addScreen(0.3, 0.17, [384, 216], Math.PI - 0.72, 2.725, 0.82, cockpitPage('drive'));
    this.centerScreen = addScreen(0.36, 0.13, [480, 174], Math.PI, 2.715, 0.9, cockpitPage('status'));

    // Lights for the near layer: sun + sky (driven from the world), panel glow.
    // The sun's shadow covers just the console, so the canopy ribs and your
    // own hands throw crisp shadows across the glass pads.
    this.sun = new DirectionalLight(0xffffff, 3);
    this.sun.position.set(0, 10, 0);
    this.sun.target.position.set(0, 2.5, -0.15);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    {
      const sc = this.sun.shadow.camera;
      sc.left = -1.3;
      sc.right = 1.3;
      sc.top = 1.3;
      sc.bottom = -1.3;
      sc.near = 0.5;
      sc.far = 14;
    }
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.012;
    this.sun.shadow.radius = 2;
    this.scene.add(this.sun, this.sun.target);
    this.hemi = new HemisphereLight(0x9fb6c9, 0x4a443c, 0.6);
    this.scene.add(this.hemi);
    const fill = new PointLight(new Color(0.55, 0.8, 1.0), 0.35, 2.2, 2);
    fill.position.set(0, 2.75, -0.35);
    this.root.add(fill);
    this.fill = fill;

    this.cabin = buildCabin(this, { PILOT, PAD });
  }

  setEnvMap(env) {
    // re-run when materials arrive later (the pilot's body loads after the cockpit exists)
    const n = this.extraMats ? this.extraMats.length : 0;
    if (this._env === env && this._envN === n) return;
    this._env = env;
    this._envN = n;
    for (const m of Object.values(this.mat)) {
      m.envMap = env;
      m.needsUpdate = true;
    }
    for (const p of Object.values(this.pads)) {
      p.mat.envMap = env;
      p.mat.needsUpdate = true;
    }
    for (const m of this.cabin.mats) {
      m.envMap = env;
      m.needsUpdate = true;
    }
    if (this.extraMats) for (const m of this.extraMats) {
      m.envMap = env;
      m.needsUpdate = true;
    }
  }

  /**
   * Light the cabin like the world outside it.
   * sunDir: saucer-local direction TO the sun; outside: 0 in the hangar, 1 in the open.
   */
  setLighting({ sunDir, sunColor, sunIntensity, skyColor, groundColor, outside, warp = 0 }) {
    const inside = 1 - outside;
    // In the hangar the "sun" becomes the high-bay key from straight above.
    this._dir = (this._dir || new Vector3()).set(0.15, 1, 0.35).normalize().multiplyScalar(inside).addScaledVector(sunDir, outside).normalize();
    this.sun.position.copy(this.sun.target.position).addScaledVector(this._dir, 6);
    this.sun.color.copy(sunColor).lerp(_warm, inside);
    this.sun.intensity = sunIntensity * outside * Math.max(0, Math.min(1, sunDir.y * 6 + 0.3)) + 1.1 * inside;
    this.hemi.color.copy(skyColor).lerp(_hangarSky, inside);
    this.hemi.groundColor.copy(groundColor).lerp(_hangarGround, inside);
    this.hemi.intensity = 0.55 * inside + 1.0 * outside;
    // the warp tunnel floods the canopy with blue
    if (warp > 0.001) {
      this.hemi.color.lerp(_warpBlue, Math.min(1, warp * 0.8));
      this.hemi.intensity += warp * 0.9;
      this.sun.intensity *= 1 - warp * 0.7;
    }
  }

  /** pressL / pressR: 0..1 pad activity. */
  update(dt, t, { pressL = 0, pressR = 0, power = 1 }, live) {
    for (const [side, press] of [['left', pressL], ['right', pressR]]) {
      const p = this.pads[side];
      const target = (0.35 + power * 0.5 + press * 2.2) * (0.9 + 0.1 * Math.sin(t * 6 + (side === 'left' ? 0 : 1.7)));
      p.level += (target - p.level) * Math.min(1, dt * 10);
      p.mat.emissiveIntensity = p.level;
      p.glow.intensity = 0.02 + press * 0.18 * power;
    }
    for (const s of this.screens) {
      s.state.live = live;
      s.update(dt, t);
    }
    this.cabin.update(dt, t, live || {});
  }
}

const _warm = new Color(1.0, 0.95, 0.88);
const _hangarSky = new Color(0.78, 0.83, 0.89);
const _hangarGround = new Color(0.42, 0.4, 0.36);
const _warpBlue = new Color(0.45, 0.66, 1.0);

/** Engraved handprint + hex lattice for the pad emissive map. */
function padTexture(side) {
  const W = 256;
  const H = 346;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  // hex lattice
  g.strokeStyle = 'rgba(70,160,190,0.35)';
  g.lineWidth = 1;
  const s = 12;
  for (let y = 0; y < H + s; y += s * 1.5) {
    for (let x = 0; x < W + s; x += s * Math.sqrt(3)) {
      const ox = (Math.round(y / (s * 1.5)) % 2) * ((s * Math.sqrt(3)) / 2);
      g.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
        const px = x + ox + Math.cos(a) * s * 0.55;
        const py = y + Math.sin(a) * s * 0.55;
        if (k) g.lineTo(px, py);
        else g.moveTo(px, py);
      }
      g.closePath();
      g.stroke();
    }
  }
  // handprint outline (mirrored for the right hand). Fingers point to the top of the
  // texture; the palm sits on the pad centre, toed in like the resting hands.
  const mir = side === 'right' ? -1 : 1;
  g.save();
  g.translate(W / 2, H * 0.5 - 14);
  g.scale(mir * 0.93, 0.93);
  g.rotate(PAD.toeIn);
  g.strokeStyle = 'rgba(160,240,255,1)';
  g.lineWidth = 4;
  g.shadowColor = 'rgba(120,220,255,1)';
  g.shadowBlur = 10;
  const finger = (x, y, len, w, ang) => {
    g.save();
    g.translate(x, y);
    g.rotate(ang);
    g.beginPath();
    g.moveTo(-w / 2, 0);
    g.lineTo(-w / 2, -len + w / 2);
    g.arc(0, -len + w / 2, w / 2, Math.PI, 0);
    g.lineTo(w / 2, 0);
    g.stroke();
    g.restore();
  };
  // palm
  g.beginPath();
  g.ellipse(4, 8, 60, 58, 0, 0, Math.PI * 2);
  g.stroke();
  finger(-44, -36, 82, 26, -0.16); // pinky side (left hand: −x)
  finger(-16, -46, 110, 28, -0.05);
  finger(14, -48, 118, 28, 0.03);
  finger(40, -40, 104, 27, 0.12);
  finger(66, 18, 76, 30, 0.85); // thumb
  g.restore();
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}
