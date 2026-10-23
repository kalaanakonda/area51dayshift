import {
  BoxGeometry,
  BufferGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  BackSide,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  PMREMGenerator,
  PointLight,
  Quaternion,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { DIMS, shipRadiusAt } from './starship.js';
import { mat } from './materials.js';
import { cabinPanelTextures, deckFloorTextures, labelTexture, quiltTextures } from './textures.js';
import { additive } from './vfx.js';
import { INK, label, MonitorFeed, pageFrame } from './monitor.js';
import { Worker } from './workers.js';
import { quatFromDirUp } from '../player/handModel.js';
import { Dial, GuardedToggle, PushButton } from '../interaction/controls.js';
import { GLSL_NOISE } from '../render/shaders/glsl.js';
import { mulberry32 } from '../core/math.js';

/**
 * CREW DECK (Scenes 3–4). BlendKit asset: cabin_flightdeck.glb.
 *
 * Local frame = the ship's frame shifted up to the deck floor: origin on the
 * ship axis at floor level, +Y toward the nose, −Z leeward (the window band),
 * +Z windward (behind the heat shield). So a far-layer camera is simply
 *   shipMatrix · translate(0, CABIN.deckY, 0) · eyeMatrix.
 *
 * Layout (top view):
 *            +Z  communal table · ladder to the gallery
 *     quarters ◜   ( storm shelter core )   ◝ quarters
 *            4 crew couches facing the dash
 *            −Z  7 windows (matching the hull's window band)
 */
export const CABIN = {
  deckY: DIMS.windowY - 1.32,
  height: 2.6,
  skin: 0.18,
  seats: [-1.95, -0.65, 0.65, 1.95],
  seatZ: -1.62,
  playerSeat: 2,
  eye: new Vector3(0.65, 1.2, -1.5),
  coreR: 0.95,
  dashZ: -1.93,
  dashY: 0.92,
  dashTilt: -0.54,
  railY: 1.1,
  railZ: -2.02,
};

const rIn = (y) => shipRadiusAt(CABIN.deckY + y) - CABIN.skin;
const WIN_Y = DIMS.windowY - CABIN.deckY; // window centre height above the floor (1.32)
const OPEN_LO = WIN_Y - DIMS.windowH / 2 - 0.05;
const OPEN_HI = WIN_Y + DIMS.windowH / 2 + 0.05;

/** Angle of window k (0..count-1); θ measured from +Z like CylinderGeometry. */
export function windowTheta(k) {
  return Math.PI + (k - (DIMS.windowCount - 1) / 2) * DIMS.windowStep;
}

/** Cylinder-wall piece with UVs in metres (u along the arc, v up) so panels never stretch. */
function wallPiece(y0, y1, th0, th1, segs = 48) {
  const h = y1 - y0;
  const rb = rIn(y0);
  const rt = rIn(y1);
  const g = new CylinderGeometry(rt, rb, h, segs, 1, true, th0, th1 - th0);
  g.translate(0, y0 + h / 2, 0);
  const uv = g.attributes.uv;
  const pos = g.attributes.position;
  const rm = (rb + rt) / 2;
  for (let i = 0; i < uv.count; i++) {
    const th = th0 + uv.getX(i) * (th1 - th0);
    uv.setXY(i, (th * rm) / 2, pos.getY(i) / 2);
  }
  return g;
}

const _v = new Vector3();
const _q = new Quaternion();

export class CabinSet {
  constructor(ctx) {
    this.ctx = ctx;
    this.scene = new Scene();
    this.scene.name = 'CrewDeck';
    this.sockets = {};
    this.controls = {};
    this.monitors = {};
    this.gravity = new Vector3(0, -9.81, 0); // cabin-frame acceleration felt by loose objects
    this.vibration = 0;
    this.state = { alert: 0, plasma: 0, power: 1, sun: 0 };
  }

  async build(progress = () => {}) {
    const { engine } = this.ctx;
    const q = engine.quality;
    this._buildShell();
    progress(0.25, 'Crew deck · hull');
    this._buildDash();
    this._buildSeats();
    progress(0.5, 'Crew deck · console');
    this._buildCore();
    this._buildCommons();
    progress(0.75, 'Crew deck · quarters');
    this._buildLights(q);
    this._buildCrew();
    this._buildPlush();
    // Soft interior reflections (visors, glass, metal trim).
    const pmrem = new PMREMGenerator(engine.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.32;
    pmrem.dispose();
    this.scene.traverse((o) => {
      if (o.isMesh && !o.userData.noShadow) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    progress(1, 'Crew deck');
  }

  // ---------------------------------------------------------------- hull + windows
  _buildShell() {
    const S = this.scene;
    const { map, normal } = cabinPanelTextures();
    const wallMat = new MeshStandardMaterial({ map, normalMap: normal, roughness: 0.72, metalness: 0.02, side: BackSide });
    wallMat.normalScale.set(0.6, 0.6);
    const H = CABIN.height;
    const shell = new Group();
    shell.name = 'shell';
    shell.add(new Mesh(wallPiece(0, OPEN_LO, 0, Math.PI * 2, 128), wallMat));
    shell.add(new Mesh(wallPiece(OPEN_HI, H, 0, Math.PI * 2, 128), wallMat));

    // Window band: pieces between openings.
    const n = DIMS.windowCount;
    const half = (DIMS.windowW / 2 + 0.05) / rIn(WIN_Y);
    this.windows = [];
    for (let k = 0; k < n; k++) this.windows.push(windowTheta(k));
    for (let k = 0; k < n - 1; k++) {
      shell.add(new Mesh(wallPiece(OPEN_LO, OPEN_HI, this.windows[k] + half, this.windows[k + 1] - half, 4), wallMat));
    }
    shell.add(new Mesh(wallPiece(OPEN_LO, OPEN_HI, this.windows[n - 1] + half, this.windows[0] - half + Math.PI * 2, 96), wallMat));
    S.add(shell);

    // Kick strip + handrail ring + LED cove.
    const kick = new Mesh(wallPiece(0, 0.12, 0, Math.PI * 2, 96), new MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.6, side: BackSide }));
    kick.scale.setScalar(0.995);
    S.add(kick);
    const cove = new Mesh(wallPiece(H - 0.08, H - 0.04, 0, Math.PI * 2, 96), new MeshStandardMaterial({ color: 0x111111, emissive: new Color(0.9, 0.95, 1.0), emissiveIntensity: 2.2, side: BackSide }));
    cove.scale.setScalar(0.985);
    cove.userData.noShadow = true;
    this.coveMat = cove.material;
    S.add(cove);

    // Reveals (window tunnels), glass, plasma sheets.
    const revealMat = new MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.55, metalness: 0.25, side: DoubleSide });
    const gLo = WIN_Y - DIMS.windowH / 2;
    const gHi = WIN_Y + DIMS.windowH / 2;
    const Rg = shipRadiusAt(DIMS.windowY) + 0.005;
    const aG = DIMS.windowW / 2 / Rg;
    this.glassUniforms = {
      uTime: { value: 0 },
      uReflect: { value: 1 },
      uFrost: { value: 0 },
      uInterior: { value: new Color(0.8, 0.86, 0.95) },
    };
    this.plasmaUniforms = { uTime: { value: 0 }, uPlasma: { value: 0 }, uFlow: { value: [1.0, -0.35] } };
    const glassMat = additive(
      new ShaderMaterial({
        uniforms: this.glassUniforms,
        vertexShader: /* glsl */ `
          varying vec3 vWorldPos; varying vec3 vN; varying vec2 vUv;
          void main() {
            vUv = uv;
            vN = normalize(mat3(modelMatrix) * normal);
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vWorldPos = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uTime, uReflect, uFrost;
          uniform vec3 uInterior;
          varying vec3 vWorldPos; varying vec3 vN; varying vec2 vUv;
          ${GLSL_NOISE}
          void main() {
            vec3 V = normalize(cameraPosition - vWorldPos);
            float fres = pow(1.0 - abs(dot(normalize(vN), V)), 5.0);
            float smudge = smoothstep(0.55, 0.85, fbm2(vUv * vec2(7.0, 5.0) + 3.0, 4));
            vec2 c = abs(vUv - 0.5) * 2.0;
            float edge = smoothstep(0.55, 1.0, max(c.x, c.y));
            vec3 col = uInterior * (0.012 + fres * 0.22) * uReflect;
            col += vec3(0.85, 0.9, 1.0) * (smudge * 0.01 + edge * uFrost * 0.14 * (0.6 + 0.4 * fbm2(vUv * 24.0, 3)));
            gl_FragColor = vec4(col, 1.0);
          }
        `,
        side: DoubleSide,
      })
    );
    const plasmaMat = additive(
      new ShaderMaterial({
        uniforms: this.plasmaUniforms,
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
        `,
        fragmentShader: /* glsl */ `
          uniform float uTime, uPlasma;
          uniform vec2 uFlow;
          varying vec2 vUv;
          ${GLSL_NOISE}
          void main() {
            if (uPlasma < 0.001) discard;
            vec2 p = vUv * vec2(2.4, 3.0);
            vec2 q = p - uFlow * uTime * 2.2;
            float warp = fbm2(q * 1.7 + uTime * 0.3, 3);
            float n = fbm2(q * vec2(0.9, 3.4) + warp * 1.4, 5);
            float streak = pow(clamp(n, 0.0, 1.0), 2.4) * 3.2;
            float flick = 0.7 + 0.3 * sin(uTime * 41.0 + n * 11.0);
            vec3 hot = mix(vec3(1.0, 0.32, 0.1), vec3(1.0, 0.62, 0.86), smoothstep(0.4, 0.8, n));
            vec3 col = hot * streak * flick * uPlasma * 7.0 + vec3(1.0, 0.45, 0.2) * uPlasma * 0.6;
            gl_FragColor = vec4(col, 1.0);
          }
        `,
        side: DoubleSide,
      })
    );
    this.plasmaSheets = [];
    this.glassPanes = [];
    for (let k = 0; k < n; k++) {
      const th = this.windows[k];
      const reveal = this._reveal(th, half, OPEN_LO, OPEN_HI, aG, Rg, gLo, gHi);
      S.add(new Mesh(reveal, revealMat));
      const glass = new Mesh(new CylinderGeometry(Rg - 0.01, Rg - 0.01, DIMS.windowH, 8, 1, true, th - aG, aG * 2), glassMat);
      glass.position.y = WIN_Y;
      glass.userData.noShadow = true;
      glass.castShadow = false;
      glass.renderOrder = 4;
      S.add(glass);
      this.glassPanes.push(glass);
      const aP = (DIMS.windowW / 2 + 0.25) / (Rg + 0.08);
      const sheet = new Mesh(new CylinderGeometry(Rg + 0.08, Rg + 0.08, DIMS.windowH + 0.5, 8, 1, true, th - aP, aP * 2), plasmaMat);
      sheet.position.y = WIN_Y;
      sheet.userData.noShadow = true;
      sheet.renderOrder = 3;
      sheet.visible = false;
      S.add(sheet);
      this.plasmaSheets.push(sheet);
      // Hand-on-glass socket: palm on the pane, fingers up, back toward the cabin.
      const sock = new Object3D();
      sock.name = `socket_flat_R_window_${k}`;
      const r = Rg - 0.03;
      // Slightly right of the pane's centre: it's the right hand that reaches out.
      sock.position.set(Math.sin(th - 0.035) * r, WIN_Y + 0.08, Math.cos(th - 0.035) * r);
      sock.quaternion.copy(quatFromDirUp(new Vector3(0, 1, 0), new Vector3(-Math.sin(th), 0, -Math.cos(th))));
      S.add(sock);
      this.sockets[`window${k}`] = sock;
    }

    // Floor + ceiling
    const floor = deckFloorTextures();
    const fm = floor.map.clone();
    fm.needsUpdate = true;
    fm.repeat.set(rIn(0) * 2, rIn(0) * 2);
    const fn = floor.normal.clone();
    fn.needsUpdate = true;
    fn.repeat.copy(fm.repeat);
    const floorMesh = new Mesh(new CircleGeometry(rIn(0), 96), new MeshStandardMaterial({ map: fm, normalMap: fn, roughness: 0.8, metalness: 0.15 }));
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.name = 'deck_floor';
    S.add(floorMesh);
    const ceil = new Mesh(new CircleGeometry(rIn(H), 96), new MeshStandardMaterial({ color: 0x8e9196, roughness: 0.7, metalness: 0.1 }));
    ceil.rotation.x = Math.PI / 2;
    ceil.position.y = H;
    S.add(ceil);
    // Ceiling light panels (radial)
    this.panelMat = new MeshStandardMaterial({ color: 0x111111, emissive: new Color(0.92, 0.96, 1.0), emissiveIntensity: 3.2 });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const p = new Mesh(new BoxGeometry(0.22, 0.02, 1.1), this.panelMat);
      p.position.set(Math.sin(a) * 2.45, H - 0.012, Math.cos(a) * 2.45);
      p.rotation.y = a;
      p.userData.noShadow = true;
      S.add(p);
    }
  }

  /** Four-sided window tunnel from the inner opening out to the glass. */
  _reveal(th, aIn, y0, y1, aG, Rg, g0, g1) {
    const P = [];
    const pt = (r, a, y) => [Math.sin(a) * r, y, Math.cos(a) * r];
    const quad = (A, B, C, D) => P.push(...A, ...B, ...C, ...A, ...C, ...D);
    const seg = 6;
    for (let i = 0; i < seg; i++) {
      const t0 = i / seg;
      const t1 = (i + 1) / seg;
      const ai0 = th - aIn + 2 * aIn * t0;
      const ai1 = th - aIn + 2 * aIn * t1;
      const ao0 = th - aG + 2 * aG * t0;
      const ao1 = th - aG + 2 * aG * t1;
      quad(pt(rIn(y1), ai0, y1), pt(rIn(y1), ai1, y1), pt(Rg, ao1, g1), pt(Rg, ao0, g1)); // top
      quad(pt(rIn(y0), ai1, y0), pt(rIn(y0), ai0, y0), pt(Rg, ao0, g0), pt(Rg, ao1, g0)); // bottom
    }
    quad(pt(rIn(y0), th - aIn, y0), pt(rIn(y1), th - aIn, y1), pt(Rg, th - aG, g1), pt(Rg, th - aG, g0)); // left
    quad(pt(rIn(y1), th + aIn, y1), pt(rIn(y0), th + aIn, y0), pt(Rg, th + aG, g0), pt(Rg, th + aG, g1)); // right
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(P, 3));
    g.computeVertexNormals();
    return g;
  }

  // ---------------------------------------------------------------- dash + controls
  _buildDash() {
    const S = this.scene;
    const consoleMat = new MeshStandardMaterial({ color: 0x2b2f35, roughness: 0.5, metalness: 0.35 });
    const trimMat = new MeshStandardMaterial({ color: 0xbfc3c8, roughness: 0.35, metalness: 0.85 });
    const dash = new Group();
    dash.name = 'dash';
    dash.position.set(0, CABIN.dashY, CABIN.dashZ);
    dash.rotation.x = CABIN.dashTilt;
    S.add(dash);
    this.dash = dash;
    const body = new Mesh(new RoundedBoxGeometry(4.4, 0.34, 0.06, 2, 0.012), consoleMat);
    dash.add(body);
    // Pedestal + undershelf (legs go under the dash)
    const ped = new Mesh(new BoxGeometry(4.2, 0.08, 0.32), consoleMat);
    ped.position.set(0, CABIN.dashY - 0.22, CABIN.dashZ - 0.16);
    S.add(ped);
    for (const x of [-2.05, -1.3, 0, 1.3, 2.05]) {
      const leg = new Mesh(new BoxGeometry(0.05, CABIN.dashY - 0.22, 0.05), mat('darkSteel'));
      leg.position.set(x, (CABIN.dashY - 0.22) / 2, CABIN.dashZ - 0.25);
      S.add(leg);
    }

    // Displays — one per seat. The player's is the live-feed screen.
    const pages = ['nav', 'systems', 'main', 'comms'];
    CABIN.seats.forEach((x, i) => {
      const bezel = new Mesh(new RoundedBoxGeometry(0.38, 0.23, 0.014, 2, 0.006), new MeshStandardMaterial({ color: 0x15171a, roughness: 0.4, metalness: 0.3 }));
      bezel.position.set(x, 0.058, 0.033);
      dash.add(bezel);
      const m = new MonitorFeed({ width: 0.34, height: 0.19, res: [640, 360], name: i === CABIN.playerSeat ? 'screen_feed' : `screen_${pages[i]}`, brightness: 1.15 });
      m.mesh.position.set(x, 0.058, 0.0412);
      m.mesh.userData.noShadow = true;
      dash.add(m.mesh);
      this.monitors[pages[i]] = m;
      m.draw = idlePage(pages[i]);
    });
    this.monitors.main.fps = 15;

    // Player's control strip (dash-local, x relative to the player's seat).
    const px = CABIN.seats[CABIN.playerSeat];
    const strip = new Mesh(new BoxGeometry(0.66, 0.1, 0.008), new MeshStandardMaterial({ color: 0x23262b, roughness: 0.65, metalness: 0.2 }));
    strip.position.set(px, -0.105, 0.032);
    dash.add(strip);
    const mount = (control, x, y) => {
      control.root.position.set(px + x, y, 0.037);
      dash.add(control.root);
      return control;
    };
    this.controls.xfer = mount(new GuardedToggle({ name: 'ctrl_toggle_xfer', label: 'PROP XFER', color: 0xd09a1e }), -0.13, -0.1);
    this.controls.safeA = mount(new GuardedToggle({ name: 'ctrl_toggle_safeA', label: 'ENG SAFE A' }), -0.035, -0.1);
    this.controls.safeB = mount(new GuardedToggle({ name: 'ctrl_toggle_safeB', label: 'ENG SAFE B' }), 0.035, -0.1);
    this.controls.commit = mount(new PushButton({ name: 'ctrl_button_commit', label: 'TMI COMMIT', radius: 0.024 }), 0.17, -0.1);
    this.controls.dial = mount(new Dial({ name: 'ctrl_dial_cabin', sweep: 1.6, detents: 4, labels: ['DAY', 'NIGHT'] }), -0.26, -0.1);
    this.controls.dial.root.scale.setScalar(0.8);
    const plate = new Mesh(new PlaneGeometry(0.2, 0.026), new MeshStandardMaterial({ map: labelTexture(['DECK 3 · CREW STATION 3'], { w: 512, h: 64, bg: '#23262b', fg: '#c9ccd0' }), roughness: 0.6 }));
    plate.position.set(px, -0.155, 0.0365);
    dash.add(plate);

    // Grab rail along the top of the dash — what you brace on at launch.
    const rail = new Mesh(new CylinderGeometry(0.017, 0.017, 4.2, 16), trimMat);
    rail.rotation.z = Math.PI / 2;
    rail.position.set(0, CABIN.railY, CABIN.railZ);
    S.add(rail);
    for (const x of [-2.0, -1.3, 0, 1.3, 2.0]) {
      const so = new Mesh(new BoxGeometry(0.03, 0.06, 0.03), trimMat);
      so.position.set(x, CABIN.railY - 0.04, CABIN.railZ + 0.01);
      S.add(so);
    }
    const mk = (name, x, fingers, back) => {
      const o = new Object3D();
      o.name = name;
      o.position.set(x, CABIN.railY + 0.012, CABIN.railZ + 0.012);
      o.quaternion.copy(quatFromDirUp(fingers, back));
      S.add(o);
      this.sockets[name] = o;
      return o;
    };
    // Overhand: fingers roll forward-down over the bar, back of hand up-forward.
    mk('railR', px + 0.19, new Vector3(-0.12, -0.42, -0.9), new Vector3(0.1, 0.9, -0.42));
    mk('railL', px - 0.19, new Vector3(0.12, -0.42, -0.9), new Vector3(-0.1, 0.9, -0.42));
  }

  // ---------------------------------------------------------------- couches
  _buildSeats() {
    const S = this.scene;
    const cushion = new MeshStandardMaterial({ color: 0x2a2b2e, roughness: 0.92 });
    const shellM = new MeshStandardMaterial({ color: 0xe4e2dd, roughness: 0.45, metalness: 0.05 });
    const strap = new MeshStandardMaterial({ color: 0x8b8f94, roughness: 0.8 });
    this.seatGroups = [];
    CABIN.seats.forEach((x, i) => {
      const g = new Group();
      g.name = i === CABIN.playerSeat ? 'anchor_seat_player' : `seat_${i}`;
      g.position.set(x, 0, CABIN.seatZ);
      // Seat pan + shell
      const pan = new Mesh(new RoundedBoxGeometry(0.52, 0.1, 0.5, 3, 0.04), cushion);
      pan.position.set(0, 0.48, -0.02);
      pan.rotation.x = 0.1;
      const panShell = new Mesh(new RoundedBoxGeometry(0.58, 0.06, 0.54, 2, 0.02), shellM);
      panShell.position.set(0, 0.41, -0.02);
      panShell.rotation.x = 0.1;
      // Backrest reclined toward +Z
      const back = new Group();
      back.position.set(0, 0.5, 0.22);
      back.rotation.x = -0.36;
      const bc = new Mesh(new RoundedBoxGeometry(0.5, 0.82, 0.1, 3, 0.04), cushion);
      bc.position.y = 0.42;
      const bs = new Mesh(new RoundedBoxGeometry(0.58, 0.9, 0.06, 2, 0.02), shellM);
      bs.position.set(0, 0.42, 0.07);
      const head = new Mesh(new RoundedBoxGeometry(0.34, 0.26, 0.13, 3, 0.04), cushion);
      head.position.set(0, 0.98, -0.01);
      back.add(bc, bs, head);
      for (const sx of [-1, 1]) {
        const wing = new Mesh(new RoundedBoxGeometry(0.06, 0.24, 0.16, 2, 0.02), shellM);
        wing.position.set(sx * 0.2, 0.98, -0.03);
        const belt = new Mesh(new BoxGeometry(0.05, 0.6, 0.008), strap);
        belt.position.set(sx * 0.12, 0.55, -0.056);
        if (i !== CABIN.playerSeat) back.add(belt);
        back.add(wing);
      }
      // Armrests
      for (const sx of [-1, 1]) {
        const arm = new Mesh(new RoundedBoxGeometry(0.07, 0.06, 0.42, 2, 0.02), shellM);
        arm.position.set(sx * 0.31, 0.7, -0.05);
        const post = new Mesh(new BoxGeometry(0.04, 0.24, 0.04), mat('darkSteel'));
        post.position.set(sx * 0.31, 0.56, 0.06);
        g.add(arm, post);
      }
      // Base frame
      const base = new Mesh(new BoxGeometry(0.44, 0.36, 0.4), mat('darkSteel'));
      base.position.set(0, 0.18, 0.04);
      g.add(pan, panShell, back, base);
      S.add(g);
      this.seatGroups.push(g);
    });
  }

  // ---------------------------------------------------------------- storm shelter core
  _buildCore() {
    const S = this.scene;
    const R = CABIN.coreR;
    const H = CABIN.height;
    const { map, normal } = cabinPanelTextures();
    const coreMat = new MeshStandardMaterial({ map, normalMap: normal, color: 0xcfd2d6, roughness: 0.6, metalness: 0.05 });
    const outer = new Mesh(new CylinderGeometry(R, R, H, 64, 1, true), coreMat);
    outer.position.y = H / 2;
    outer.name = 'storm_shelter_core';
    S.add(outer);
    // Door on the +Z side (faces the commons).
    const door = new Mesh(new RoundedBoxGeometry(0.62, 1.7, 0.04, 2, 0.02), new MeshStandardMaterial({ color: 0x9aa1a8, roughness: 0.45, metalness: 0.4 }));
    door.position.set(0, 0.95, R + 0.015);
    S.add(door);
    const sign = new Mesh(
      new PlaneGeometry(0.5, 0.16),
      new MeshStandardMaterial({ map: labelTexture(['STORM SHELTER', 'WATER-WALLED · 6 CREW'], { w: 512, h: 160, bg: '#e2b420', fg: '#111' }), roughness: 0.6 })
    );
    sign.position.set(0, 1.92, R + 0.04);
    S.add(sign);
    const sign2 = sign.clone();
    sign2.position.set(0, 1.92, -R - 0.005);
    sign2.rotation.y = Math.PI;
    S.add(sign2);

    // Interior: quilted water bags, red work light, dose display, overhead ring.
    const quilt = quiltTextures();
    const qm = quilt.map.clone();
    qm.needsUpdate = true;
    qm.repeat.set((2 * Math.PI * (R - 0.08)) / 0.6, H / 0.6);
    const qn = quilt.normal.clone();
    qn.needsUpdate = true;
    qn.repeat.copy(qm.repeat);
    const inner = new Mesh(new CylinderGeometry(R - 0.08, R - 0.08, H - 0.04, 48, 1, true), new MeshStandardMaterial({ map: qm, normalMap: qn, roughness: 0.85, side: BackSide }));
    inner.position.y = H / 2;
    inner.name = 'shelter_interior';
    S.add(inner);
    const capMat = new MeshStandardMaterial({ map: qm, normalMap: qn, roughness: 0.85 });
    const top = new Mesh(new CircleGeometry(R - 0.08, 48), capMat);
    top.rotation.x = Math.PI / 2;
    top.position.y = H - 0.03;
    const bottom = new Mesh(new CircleGeometry(R - 0.08, 48), capMat);
    bottom.rotation.x = -Math.PI / 2;
    bottom.position.y = 0.03;
    S.add(top, bottom);
    const ring = new Mesh(new TorusGeometry(0.38, 0.018, 10, 48), mat('darkSteel'));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 1.8;
    S.add(ring);
    this.shelterLight = new PointLight(new Color(1, 0.16, 0.08), 0, 3, 2);
    this.shelterLight.position.set(0, 2.3, 0);
    S.add(this.shelterLight);
    const dose = new MonitorFeed({ width: 0.22, height: 0.124, res: [480, 270], name: 'screen_dose', brightness: 1.1 });
    dose.mesh.position.set(-(R - 0.1), 1.45, 0);
    dose.mesh.rotation.y = Math.PI / 2;
    dose.mesh.userData.noShadow = true;
    S.add(dose.mesh);
    dose.draw = dosePage;
    this.monitors.dose = dose;
    // Shelter hand sockets: both hands up on the overhead ring, facing −X (the
    // dose display). Pull-up grip: fingers up and over, backs of the hands
    // toward the player's face.
    const ringSock = (name, a) => {
      const o = new Object3D();
      o.name = name;
      o.position.set(Math.cos(a) * 0.38, 1.78, Math.sin(a) * 0.38);
      o.quaternion.copy(quatFromDirUp(new Vector3(-0.3, 0.95, 0), new Vector3(0.95, 0.3, 0)));
      S.add(o);
      this.sockets[name] = o;
    };
    ringSock('ringR', Math.PI + 0.55);
    ringSock('ringL', Math.PI - 0.55);
  }

  // ---------------------------------------------------------------- commons, quarters, ladder
  _buildCommons() {
    const S = this.scene;
    const rand = mulberry32(8);
    // Communal table
    const top = new Mesh(new CylinderGeometry(0.55, 0.55, 0.04, 40), new MeshStandardMaterial({ color: 0xd8d5ce, roughness: 0.5 }));
    top.position.set(0, 0.95, 2.55);
    const ped = new Mesh(new CylinderGeometry(0.07, 0.12, 0.93, 16), mat('darkSteel'));
    ped.position.set(0, 0.465, 2.55);
    const footbar = new Mesh(new TorusGeometry(0.62, 0.015, 8, 48), mat('darkSteel'));
    footbar.rotation.x = Math.PI / 2;
    footbar.position.set(0, 0.12, 2.55);
    S.add(top, ped, footbar);
    // A few velcroed things on the table
    for (let i = 0; i < 4; i++) {
      const pouch = new Mesh(new RoundedBoxGeometry(0.09, 0.03, 0.13, 2, 0.01), new MeshStandardMaterial({ color: [0x9a8f7a, 0x5e6e7c, 0xb3402f, 0xd7d7d2][i], roughness: 0.8 }));
      const a = rand() * Math.PI * 2;
      pouch.position.set(Math.sin(a) * 0.3, 0.985, 2.55 + Math.cos(a) * 0.3);
      pouch.rotation.y = rand() * 3;
      S.add(pouch);
    }
    // Crew quarters doors (private cabins) + lockers
    const doorMat = new MeshStandardMaterial({ color: 0xb8bcc1, roughness: 0.45, metalness: 0.3 });
    const frameMat = new MeshStandardMaterial({ color: 0x3a3e44, roughness: 0.6, metalness: 0.3 });
    let q = 1;
    for (const a of [0.7, 1.25, 1.8, -0.7, -1.25, -1.8]) {
      const r = rIn(1.0) - 0.02;
      const g = new Group();
      g.position.set(Math.sin(a) * r, 0, Math.cos(a) * r);
      g.rotation.y = a + Math.PI;
      const frame = new Mesh(new BoxGeometry(0.84, 2.05, 0.04), frameMat);
      frame.position.y = 1.03;
      const d = new Mesh(new RoundedBoxGeometry(0.72, 1.92, 0.05, 2, 0.015), doorMat);
      d.position.set(0, 1.0, 0.03);
      const plate = new Mesh(new PlaneGeometry(0.22, 0.07), new MeshStandardMaterial({ map: labelTexture([`QTR ${q}`], { w: 256, h: 80, bg: '#2a2d31', fg: '#e8e6e1' }), roughness: 0.6 }));
      plate.position.set(0, 1.62, 0.058);
      const handle = new Mesh(new BoxGeometry(0.03, 0.22, 0.03), mat('darkSteel'));
      handle.position.set(0.28, 1.05, 0.07);
      g.add(frame, d, plate, handle);
      S.add(g);
      q++;
    }
    // Lockers between the doors (both sides)
    const lockerMat = new MeshStandardMaterial({ color: 0xc9ccd0, roughness: 0.5, metalness: 0.15 });
    for (const a of [0.975, 1.525, -0.975, -1.525, 2.15, -2.15]) {
      const r = rIn(1.0) - 0.06;
      for (let row = 0; row < 4; row++) {
        const l = new Mesh(new RoundedBoxGeometry(0.42, 0.42, 0.08, 2, 0.012), lockerMat);
        l.position.set(Math.sin(a) * r, 0.35 + row * 0.47, Math.cos(a) * r);
        l.rotation.y = a + Math.PI;
        S.add(l);
      }
    }
    // Ladder + hatch to the upper deck (gallery), on the +Z wall.
    const lz = rIn(1.3) - 0.25;
    for (const x of [-0.22, 0.22]) {
      const rail = new Mesh(new CylinderGeometry(0.018, 0.018, CABIN.height, 10), mat('darkSteel'));
      rail.position.set(x, CABIN.height / 2, lz);
      S.add(rail);
    }
    for (let y = 0.3; y < CABIN.height; y += 0.3) {
      const rung = new Mesh(new CylinderGeometry(0.014, 0.014, 0.44, 8), mat('darkSteel'));
      rung.rotation.z = Math.PI / 2;
      rung.position.set(0, y, lz);
      S.add(rung);
    }
    const hatch = new Mesh(new CircleGeometry(0.42, 32), new MeshStandardMaterial({ color: 0x4a4e54, roughness: 0.5, metalness: 0.4 }));
    hatch.rotation.x = Math.PI / 2;
    hatch.position.set(0, CABIN.height - 0.005, lz);
    S.add(hatch);
    const gal = new Mesh(new PlaneGeometry(0.46, 0.12), new MeshStandardMaterial({ map: labelTexture(['↑ DECK 4 · GALLERY'], { w: 512, h: 128, bg: '#2a2d31', fg: '#e8e6e1' }), roughness: 0.6 }));
    gal.position.set(0, 2.25, lz + 0.18);
    gal.rotation.y = Math.PI;
    S.add(gal);
    // Handrail along the window band
    const hr = new Mesh(new TorusGeometry(rIn(0.9) - 0.09, 0.016, 8, 64, DIMS.windowStep * 7.4), mat('paintedGrey'));
    hr.rotation.x = Math.PI / 2;
    hr.rotation.z = -Math.PI / 2 - DIMS.windowStep * 3.7;
    hr.position.y = 0.88;
    S.add(hr);
    const warn = new Mesh(new PlaneGeometry(0.62, 0.07), new MeshStandardMaterial({ map: labelTexture(['VIEWING WINDOWS · DO NOT LEAN ON GLASS'], { w: 1024, h: 112, bg: '#2a2d31', fg: '#d9d6cf' }), roughness: 0.6 }));
    const wr = rIn(0.75) - 0.01;
    warn.position.set(Math.sin(windowTheta(3)) * wr, 0.76, Math.cos(windowTheta(3)) * wr);
    warn.rotation.y = 0;
    S.add(warn);
  }

  // ---------------------------------------------------------------- light
  _buildLights(q) {
    const S = this.scene;
    this.practicals = [];
    for (const p of [[-1.6, 2.45, -1.0], [1.6, 2.45, -1.0], [0, 2.45, 2.0], [-2.2, 2.45, 1.2], [2.2, 2.45, 1.2]]) {
      const l = new PointLight(new Color(0.9, 0.95, 1.0), 4.5, 0, 2);
      l.position.set(...p);
      S.add(l);
      this.practicals.push(l);
    }
    this.dashLight = new PointLight(new Color(0.62, 0.78, 1.0), 0.6, 2.5, 2);
    this.dashLight.position.set(CABIN.seats[CABIN.playerSeat], 1.05, CABIN.dashZ + 0.15);
    S.add(this.dashLight);
    this.fill = new HemisphereLight(new Color(0.62, 0.7, 0.8), new Color(0.12, 0.12, 0.13), 0.22);
    S.add(this.fill);
    this.alertLights = [];
    for (const x of [-1.8, 1.8]) {
      const a = new PointLight(new Color(1, 0.08, 0.04), 0, 0, 2);
      a.position.set(x, 2.35, -0.6);
      S.add(a);
      this.alertLights.push(a);
    }
    this.plasmaLight = new PointLight(new Color(1, 0.5, 0.22), 0, 0, 2);
    this.plasmaLight.position.set(0, WIN_Y, -3.4);
    S.add(this.plasmaLight);
    // The sun through the windows: the only shadowed light in the cabin.
    this.sun = new DirectionalLight(new Color(1, 0.96, 0.9), 0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
    const c = this.sun.shadow.camera;
    c.left = -4.8;
    c.right = 4.8;
    c.top = 4.8;
    c.bottom = -4.8;
    c.near = 0.5;
    c.far = 30;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.radius = 2;
    this.sun.target.position.set(0, 1.2, 0);
    S.add(this.sun, this.sun.target);
  }

  // ---------------------------------------------------------------- crew + zero-g indicator
  _buildCrew() {
    this.crew = [
      new Worker({ seed: 31, suit: 'white', vest: 'none', hat: 'helmet', action: 'seated', position: [CABIN.seats[1], 0, CABIN.seatZ], yaw: Math.PI }),
      new Worker({ seed: 33, suit: 'white', vest: 'none', hat: 'helmet', action: 'seated', position: [CABIN.seats[3], 0, CABIN.seatZ], yaw: Math.PI }),
    ];
    for (const w of this.crew) this.scene.add(w.root);
  }

  _buildPlush() {
    // A small plush astronaut on a tether: the traditional zero-g indicator.
    const g = new Group();
    g.name = 'zero_g_indicator';
    const fur = new MeshStandardMaterial({ color: 0xe9e4da, roughness: 1 });
    const suit = new MeshStandardMaterial({ color: 0xd9531e, roughness: 0.9 });
    const dark = new MeshStandardMaterial({ color: 0x151515, roughness: 0.4 });
    const body = new Mesh(new SphereGeometry(0.038, 16, 12), suit);
    body.scale.set(1, 1.2, 0.9);
    const head = new Mesh(new SphereGeometry(0.032, 16, 12), fur);
    head.position.y = 0.06;
    const visor = new Mesh(new SphereGeometry(0.02, 12, 8), dark);
    visor.position.set(0, 0.062, 0.022);
    visor.scale.set(1, 0.7, 0.5);
    g.add(body, head, visor);
    for (const sx of [-1, 1]) {
      const ear = new Mesh(new SphereGeometry(0.012, 8, 6), fur);
      ear.position.set(sx * 0.024, 0.088, 0);
      const arm = new Mesh(new SphereGeometry(0.014, 8, 6), suit);
      arm.position.set(sx * 0.04, 0.012, 0);
      arm.scale.set(1, 1.6, 1);
      const leg = new Mesh(new SphereGeometry(0.015, 8, 6), suit);
      leg.position.set(sx * 0.018, -0.045, 0);
      leg.scale.set(1, 1.4, 1);
      g.add(ear, arm, leg);
    }
    this.scene.add(g);
    const tether = new Mesh(new CylinderGeometry(0.0018, 0.0018, 1, 4), new MeshStandardMaterial({ color: 0x222222 }));
    tether.userData.noShadow = true;
    this.scene.add(tether);
    const anchor = new Vector3(CABIN.seats[CABIN.playerSeat] - 0.42, CABIN.railY - 0.01, CABIN.railZ);
    this.plush = { mesh: g, tether, anchor, len: 0.2, pos: anchor.clone().add(new Vector3(0, -0.2, 0)), vel: new Vector3(), spin: new Vector3() };
  }

  // ---------------------------------------------------------------- state
  /** Sun direction in CABIN space (unit), irradiance, colour. */
  setSun(dir, intensity, color) {
    this.sun.position.copy(dir).multiplyScalar(14).add(this.sun.target.position);
    this.sun.intensity = intensity;
    if (color) this.sun.color.copy(color);
    this.state.sun = intensity;
  }

  setAlert(k) {
    this.state.alert = k;
  }

  setPlasma(k) {
    this.state.plasma = k;
    this.plasmaUniforms.uPlasma.value = k;
    for (const s of this.plasmaSheets) s.visible = k > 0.001;
  }

  /** 1 = normal cabin lighting, 0 = night cycle / blackout. */
  setPower(k) {
    this.state.power = k;
  }

  update(dt, t) {
    const st = this.state;
    this.glassUniforms.uTime.value = t;
    this.plasmaUniforms.uTime.value = t;
    // Lights: practicals dim with the night cycle and in an alert (red takes over).
    const pw = st.power * (1 - st.alert * 0.75);
    for (const l of this.practicals) l.intensity = 4.5 * pw;
    this.panelMat.emissiveIntensity = 3.2 * pw;
    this.coveMat.emissiveIntensity = 2.2 * pw;
    const beacon = st.alert > 0 ? (0.55 + 0.45 * Math.sin(t * 7.5)) * st.alert : 0;
    this.alertLights.forEach((a, i) => (a.intensity = 9 * beacon * (i ? 1 : 0.8)));
    this.plasmaLight.intensity = st.plasma * (16 + Math.sin(t * 31) * 3 + Math.sin(t * 13.7) * 4);
    this.glassUniforms.uReflect.value = 0.3 + pw * 0.7;
    for (const m of Object.values(this.monitors)) m.update(dt, t, this.ctx.engine.renderer);
    for (const c of Object.values(this.controls)) c.update(dt, t);
    for (const w of this.crew) w.update(dt, t);
    this._updatePlush(dt, t);
  }

  _updatePlush(dt, t) {
    const p = this.plush;
    const zeroG = this.gravity.lengthSq() < 0.01;
    _v.copy(this.gravity);
    if (this.vibration > 0) _v.add(new Vector3(Math.sin(t * 53) * 6, Math.sin(t * 47 + 1) * 8, Math.cos(t * 59) * 6).multiplyScalar(this.vibration));
    if (zeroG) _v.set(Math.sin(t * 0.31) * 0.012, Math.sin(t * 0.23 + 2) * 0.01 + 0.004, Math.cos(t * 0.27) * 0.008);
    p.vel.addScaledVector(_v, dt);
    p.vel.multiplyScalar(Math.exp(-(zeroG ? 0.15 : 1.2) * dt));
    p.pos.addScaledVector(p.vel, dt);
    const d = _v.subVectors(p.pos, p.anchor);
    const len = d.length();
    if (len > p.len) {
      d.multiplyScalar(1 / len);
      p.pos.copy(p.anchor).addScaledVector(d, p.len);
      const out = p.vel.dot(d);
      if (out > 0) p.vel.addScaledVector(d, -out * 1.3);
    }
    p.mesh.position.copy(p.pos);
    if (zeroG) {
      p.mesh.rotation.x += dt * 0.21;
      p.mesh.rotation.z += dt * 0.13;
    } else {
      _q.setFromUnitVectors(new Vector3(0, 1, 0), d.lengthSq() > 0 ? _v.subVectors(p.anchor, p.pos).normalize() : new Vector3(0, 1, 0));
      p.mesh.quaternion.slerp(_q, Math.min(1, dt * 8));
    }
    // Tether: a thin rod from the anchor to the plush's head (slack reads as a bend we skip).
    const head = _v.set(0, 0.09, 0).applyQuaternion(p.mesh.quaternion).add(p.pos);
    const mid = head.clone().add(p.anchor).multiplyScalar(0.5);
    const dir = head.clone().sub(p.anchor);
    p.tether.position.copy(mid);
    p.tether.scale.set(1, Math.max(0.001, dir.length()), 1);
    p.tether.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize());
  }
}

// ------------------------------------------------------------------ idle pages

function idlePage(kind) {
  return (g, w, h, t, s) => {
    const titles = { nav: 'NAV · ATTITUDE', systems: 'SYS · POWER / ECLSS', main: 'STATION 3', comms: 'COMMS · DSN' };
    const u = pageFrame(g, w, h, titles[kind] || kind.toUpperCase(), { clock: s.clock || '', page: kind === 'main' ? 'P1' : '' });
    if (s.render) {
      s.render(g, w, h, t, u);
      return;
    }
    // Ambient telemetry so the dash is alive when nothing is scripted.
    label(g, 16 * u, 60 * u, kind === 'nav' ? 'ATT HOLD · LVLH' : kind === 'comms' ? 'LINK  KA-BAND' : 'BUS A 28.1V   BUS B 28.0V', { size: 13, u, color: INK.dim });
    for (let i = 0; i < 6; i++) {
      const v = 0.5 + 0.35 * Math.sin(t * 0.3 + i * 1.7 + kind.length);
      g.fillStyle = INK.line;
      g.fillRect(16 * u, (90 + i * 36) * u, w - 32 * u, 14 * u);
      g.fillStyle = i === 2 ? INK.accent : 'rgba(150,200,210,0.6)';
      g.fillRect(16 * u, (90 + i * 36) * u, (w - 32 * u) * v, 14 * u);
    }
  };
}

function dosePage(g, w, h, t, s) {
  const u = pageFrame(g, w, h, 'SPE · DOSE', { clock: s.clock || '' });
  const rate = s.rate ?? 0.4;
  label(g, 16 * u, 80 * u, 'RATE', { size: 14, u, color: INK.dim });
  label(g, 16 * u, 130 * u, `${rate.toFixed(1)} mGy/h`, { size: 40, u, color: rate > 5 ? INK.alert : INK.text, weight: 500 });
  label(g, 16 * u, 190 * u, `SHELTER  ${s.shelter ? 'OCCUPIED' : '—'}`, { size: 14, u, color: s.shelter ? INK.warn : INK.dim });
  label(g, 16 * u, 230 * u, `CUM ${(s.cum ?? 0.21).toFixed(2)} mGy`, { size: 14, u, color: INK.dim });
}
