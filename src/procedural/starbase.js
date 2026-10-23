import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Float32BufferAttribute,
  FogExp2,
  Group,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  PointLight,
  Quaternion,
  Scene,
  SphereGeometry,
  SpotLight,
  Vector3,
} from 'three';
import { mulberry32 } from '../core/math.js';
import { createNoise } from '../core/noise.js';
import { mat } from './materials.js';
import { buildStack, DIMS } from './starship.js';
import { buildCrewArm, buildLaunchMount, buildTower } from './tower.js';
import { bakeEnvironment, createDawnSky } from './sky.js';
import { concreteTexture, grainNormal, groundTexture, labelTexture } from './textures.js';
import { createBeam, createPlume, ParticleField } from './vfx.js';
import { Worker } from './workers.js';

/** World layout (metres). The stack's axis is the origin; north = −Z; the Gulf is +X. */
export const LAYOUT = {
  mountTop: 20,
  shipBase: 20 + DIMS.boosterLength + DIMS.hotStage, // 92.8
  towerCenter: new Vector3(0, 0, -24),
  towerFaceZ: -18,
  armY: 126.0,
  playerStart: new Vector3(-118, 1.68, 112),
  seaX: 430,
};

/**
 * StarbaseSet — the launch site at blue hour, shared by Scenes 1–3.
 * Lighting is practical-first: xenon floods on masts, flood banks on the
 * tower, a mobile light tower over the crew, van headlights. The sky only
 * supplies cold fill until the sun breaks the horizon in Scene 2.
 */
export class StarbaseSet {
  constructor(ctx) {
    this.ctx = ctx;
    this.scene = new Scene();
    this.scene.name = 'Starbase';
    this.updaters = [];
    this.workers = [];
  }

  async build(progress = () => {}) {
    const { engine } = this.ctx;
    const q = engine.quality;
    const S = this.scene;

    // ---------------- sky + environment
    this.sky = createDawnSky();
    S.add(this.sky.mesh);
    this.fog = new FogExp2(new Color(0.07, 0.085, 0.12), 0.00042);
    S.fog = this.fog;
    this._bakeEnv();
    progress(0.1, 'Starbase · sky');

    // ---------------- light
    this.hemi = new HemisphereLight(new Color(0.34, 0.44, 0.66), new Color(0.07, 0.06, 0.05), 0.55);
    S.add(this.hemi);
    this.skyFill = new DirectionalLight(new Color(1.0, 0.6, 0.36), 0.32);
    this.skyFill.position.set(400, 40, -60);
    S.add(this.skyFill);
    this.sun = new DirectionalLight(new Color(1.0, 0.7, 0.45), 0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 900;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    S.add(this.sun, this.sun.target);

    // ---------------- ground, sea, pad
    this._buildTerrain();
    progress(0.3, 'Starbase · terrain');

    // ---------------- hardware
    this.mount = buildLaunchMount({ top: LAYOUT.mountTop });
    S.add(this.mount);
    this.stack = buildStack({ baseY: LAYOUT.mountTop, frost: 1, soot: 0.55 });
    S.add(this.stack);
    this.ship = this.stack.userData.ship;
    this.booster = this.stack.userData.booster;
    this.tower = buildTower();
    this.tower.position.copy(LAYOUT.towerCenter);
    S.add(this.tower);
    this.arm = buildCrewArm({ length: Math.abs(LAYOUT.towerFaceZ) - DIMS.radius });
    this.arm.position.set(0, LAYOUT.armY, LAYOUT.towerFaceZ);
    S.add(this.arm);
    this._armFloor();
    progress(0.55, 'Starbase · stacking Starship');

    this._buildSite();
    this._buildLights(q);
    progress(0.75, 'Starbase · floodlights');
    this._buildVapor(q);
    this._buildWorkers(q);
    this._buildLaunchFX(q);
    progress(1, 'Starbase · crew');
  }

  _bakeEnv() {
    const { engine } = this.ctx;
    if (this.envTex) this.envTex.dispose();
    this.envTex = bakeEnvironment(engine.pmrem, this.sky.envScene);
    this.scene.environment = this.envTex;
    this.scene.environmentIntensity = 1.0;
  }

  _buildTerrain() {
    const S = this.scene;
    const N = createNoise(91);
    // Ground: 8 km, gentle undulation, flat near the pad; vertex colours add macro variation.
    const size = 8000;
    const seg = 160;
    const g = new PlaneGeometry(size, size, seg, seg);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const d = Math.hypot(x, z);
      const flat = Math.min(1, Math.max(0, (d - 260) / 400));
      let h = N.fbm2(x / 700, z / 700, 4) * 2.2 * flat;
      if (x > LAYOUT.seaX - 60) h -= (x - (LAYOUT.seaX - 60)) * 0.02; // slope to the beach
      pos.setY(i, h);
      const m = N.fbm2(x / 900 + 7, z / 900, 3) * 0.5 + 0.5;
      const wet = Math.max(0, N.fbm2(x / 400 - 3, z / 400 + 9, 3)) * 0.8;
      colors[i * 3] = 0.9 + m * 0.2 - wet * 0.45;
      colors[i * 3 + 1] = 0.9 + m * 0.15 - wet * 0.4;
      colors[i * 3 + 2] = 0.88 + m * 0.1 - wet * 0.3;
    }
    g.setAttribute('color', new Float32BufferAttribute(colors, 3));
    g.computeVertexNormals();
    const gt = groundTexture().clone();
    gt.needsUpdate = true;
    gt.repeat.set(size / 26, size / 26);
    const ground = new Mesh(g, new MeshStandardMaterial({ map: gt, vertexColors: true, roughness: 0.95, metalness: 0 }));
    ground.receiveShadow = true;
    ground.name = 'ground';
    S.add(ground);

    // The Gulf
    const waterN = grainNormal(14, 6, 1.4).clone();
    waterN.needsUpdate = true;
    waterN.repeat.set(220, 220);
    this.waterNormal = waterN;
    const sea = new Mesh(
      new PlaneGeometry(9000, 9000),
      new MeshStandardMaterial({ color: 0x0b141a, roughness: 0.07, metalness: 0.0, normalMap: waterN, envMapIntensity: 1.2 })
    );
    sea.material.normalScale.set(0.35, 0.35);
    sea.rotation.x = -Math.PI / 2;
    sea.position.set(LAYOUT.seaX + 4500, -0.6, 0);
    S.add(sea);
    const beach = new Mesh(new PlaneGeometry(120, 9000), new MeshStandardMaterial({ color: 0x8f846e, roughness: 0.9 }));
    beach.rotation.x = -Math.PI / 2;
    beach.position.set(LAYOUT.seaX - 20, -0.2, 0);
    beach.receiveShadow = true;
    S.add(beach);

    // Pad apron (concrete), flame-scorched centre
    const ct = concreteTexture().clone();
    ct.needsUpdate = true;
    ct.repeat.set(160 / 24, 160 / 24);
    const apronMat = new MeshStandardMaterial({ map: ct, roughness: 0.88, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const apron = new Mesh(new BoxGeometry(160, 0.4, 160), apronMat);
    apron.position.y = 0.0;
    apron.receiveShadow = true;
    S.add(apron);
    const scorch = new Mesh(
      new CylinderGeometry(26, 26, 0.05, 48),
      new MeshStandardMaterial({ color: 0x1b1a19, roughness: 0.95, transparent: true, opacity: 0.85, depthWrite: false })
    );
    scorch.position.y = 0.23;
    scorch.receiveShadow = true;
    S.add(scorch);

    // Roads to the west and north
    const road = new MeshStandardMaterial({ color: 0x232426, roughness: 0.82, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const r1 = new Mesh(new BoxGeometry(2400, 0.3, 10), road);
    r1.position.set(-1280, 0.05, 30);
    const r2 = new Mesh(new BoxGeometry(12, 0.3, 240), road);
    r2.position.set(-120, 0.05, -40);
    const r3 = new Mesh(new BoxGeometry(12, 0.3, 160), road);
    r3.position.set(-118, 0.05, 110);
    r3.rotation.y = 0.9;
    for (const r of [r1, r2, r3]) {
      r.receiveShadow = true;
      S.add(r);
    }
  }

  _armFloor() {
    // Tower platform at the crew-arm level (where Scene 2 begins).
    const S = this.scene;
    const plat = new Mesh(new BoxGeometry(12, 0.2, 12), mat('darkSteel'));
    plat.position.set(LAYOUT.towerCenter.x, LAYOUT.armY - 0.1, LAYOUT.towerCenter.z);
    plat.receiveShadow = true;
    S.add(plat);
  }

  _buildSite() {
    const S = this.scene;
    const rand = mulberry32(17);
    const steel = mat('paintedWhite');

    // Tank farm (north-west): vertical + horizontal propellant tanks, pipe racks.
    const farm = new Group();
    farm.name = 'tank_farm';
    for (let i = 0; i < 6; i++) {
      const t = new Mesh(new CylinderGeometry(4, 4, 24, 32), new MeshStandardMaterial({ color: 0xc8c8c4, metalness: 0.65, roughness: 0.35 }));
      t.position.set(-62 - (i % 3) * 11, 12, -86 - Math.floor(i / 3) * 11);
      const cap = new Mesh(new SphereGeometry(4, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), t.material);
      cap.position.y = 12;
      t.add(cap);
      farm.add(t);
    }
    for (let i = 0; i < 4; i++) {
      const t = new Mesh(new CylinderGeometry(2.6, 2.6, 26, 24), steel);
      t.rotation.z = Math.PI / 2;
      t.position.set(-60, 3.2, -48 - i * 7);
      farm.add(t);
    }
    for (let k = 0; k < 3; k++) {
      const pipe = new Mesh(new CylinderGeometry(0.35, 0.35, 70, 8), mat('insulation'));
      pipe.rotation.z = Math.PI / 2;
      pipe.position.set(-40, 2 + k * 0.9, -40);
      pipe.rotation.y = -0.6;
      farm.add(pipe);
    }
    farm.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    S.add(farm);

    // Distant production site: high bays with lit doors (silhouettes on the horizon).
    const bayMat = new MeshStandardMaterial({ color: 0x9a9ea3, metalness: 0.3, roughness: 0.6 });
    const lit = new MeshStandardMaterial({ color: 0x111111, emissive: new Color(1.0, 0.86, 0.66), emissiveIntensity: 4 });
    for (const [x, z, w, h, d] of [
      [-2300, 380, 70, 82, 50],
      [-2200, 520, 90, 56, 60],
      [-2450, 250, 46, 38, 120],
      [-1900, 640, 30, 20, 60],
    ]) {
      const b = new Mesh(new BoxGeometry(w, h, d), bayMat);
      b.position.set(x, h / 2, z);
      S.add(b);
      const door = new Mesh(new PlaneGeometry(w * 0.5, h * 0.7), lit);
      door.position.set(x + w / 2 + 0.2, h * 0.35, z);
      door.rotation.y = Math.PI / 2;
      S.add(door);
    }
    // A second, distant suborbital tower silhouette
    const t2 = buildTower({ height: 92, half: 5 });
    t2.position.set(-420, 0, -640);
    S.add(t2);

    // Bunker + sheds near the pad
    for (const [x, z, w, h, d] of [
      [-48, 30, 14, 4, 10],
      [52, -40, 10, 6, 18],
      [-90, -10, 18, 7, 12],
    ]) {
      const b = new Mesh(new BoxGeometry(w, h, d), mat('concreteDark'));
      b.position.set(x, h / 2, z);
      b.castShadow = b.receiveShadow = true;
      S.add(b);
    }

    // Jersey barriers + cones along the staging area
    const barrierGeo = new BoxGeometry(3, 0.8, 0.6);
    const barriers = new InstancedMesh(barrierGeo, new MeshStandardMaterial({ color: 0x8b8984, roughness: 0.9 }), 24);
    const m4 = new Matrix4();
    for (let i = 0; i < 24; i++) {
      const t = i / 24;
      const x = -96 + t * 70 + (rand() - 0.5) * 0.4;
      const z = 84 - t * 66;
      m4.compose(new Vector3(x, 0.4, z), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.76), new Vector3(1, 1, 1));
      barriers.setMatrixAt(i, m4);
    }
    barriers.castShadow = barriers.receiveShadow = true;
    S.add(barriers);
    const coneGeo = new CylinderGeometry(0.03, 0.18, 0.7, 10);
    const cones = new InstancedMesh(coneGeo, new MeshStandardMaterial({ color: 0xff4a0a, roughness: 0.6 }), 10);
    for (let i = 0; i < 10; i++) {
      m4.makeTranslation(-104 + i * 1.8, 0.35, 96 - i * 1.6);
      cones.setMatrixAt(i, m4);
    }
    S.add(cones);

    // Vehicles near the player: crew van (headlights on), pickup.
    this.van = this._vehicle({ w: 2.1, h: 2.3, l: 5.6, color: 0xdedcd8, x: -112.5, z: 108.8, yaw: -2.3, lights: true });
    this.pickup = this._vehicle({ w: 2.0, h: 1.8, l: 5.4, color: 0x2a2c2f, x: -126, z: 97, yaw: -0.4, lights: false });

    // Sign at the staging area
    const sign = new Mesh(
      new PlaneGeometry(2.6, 0.9),
      new MeshStandardMaterial({ map: labelTexture(['CREW STAGING', 'ORBITAL LAUNCH SITE A'], { w: 768, h: 256, bg: '#1b1d20', fg: '#e8e6e1' }), roughness: 0.7 })
    );
    sign.position.set(-121.5, 2.1, 103.5);
    sign.rotation.y = -0.75;
    const signPost = new Mesh(new BoxGeometry(0.1, 2.0, 0.1), mat('paintedGrey'));
    signPost.position.set(-121.5, 1.0, 103.45);
    S.add(sign, signPost);
  }

  _vehicle({ w, h, l, color, x, z, yaw, lights }) {
    const g = new Group();
    const body = new MeshStandardMaterial({ color, metalness: 0.4, roughness: 0.35 });
    const lower = new Mesh(new BoxGeometry(w, h * 0.55, l), body);
    lower.position.y = 0.45 + (h * 0.55) / 2;
    const cabin = new Mesh(new BoxGeometry(w * 0.98, h * 0.42, l * (lights ? 0.86 : 0.42)), body);
    cabin.position.set(0, 0.45 + h * 0.55 + (h * 0.42) / 2, lights ? -l * 0.05 : l * 0.12);
    const glass = new Mesh(new BoxGeometry(w * 1.0, h * 0.3, l * (lights ? 0.8 : 0.38)), mat('glassDark'));
    glass.position.copy(cabin.position);
    glass.position.y += 0.02;
    g.add(lower, cabin, glass);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const wheel = new Mesh(new CylinderGeometry(0.42, 0.42, 0.3, 16), mat('rubber'));
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set((sx * w) / 2, 0.42, (sz * l) / 2.9);
        g.add(wheel);
      }
    }
    const head = new MeshStandardMaterial({ color: 0x222222, emissive: new Color(1, 0.95, 0.85), emissiveIntensity: lights ? 9 : 0 });
    const tail = new MeshStandardMaterial({ color: 0x220000, emissive: new Color(1, 0.05, 0.02), emissiveIntensity: lights ? 4 : 0 });
    for (const sx of [-1, 1]) {
      const hl = new Mesh(new BoxGeometry(0.3, 0.14, 0.05), head);
      hl.position.set(sx * w * 0.36, 0.95, l / 2 + 0.01);
      const tl = new Mesh(new BoxGeometry(0.2, 0.25, 0.05), tail);
      tl.position.set(sx * w * 0.42, 1.0, -l / 2 - 0.01);
      g.add(hl, tl);
    }
    if (lights) {
      const spot = new SpotLight(new Color(1, 0.94, 0.84), 260, 60, 0.42, 0.7, 2);
      spot.position.set(0, 0.95, l / 2 + 0.2);
      const tgt = new Object3D();
      tgt.position.set(0, 0, l / 2 + 14);
      g.add(spot, tgt);
      spot.target = tgt;
    }
    g.position.set(x, 0, z);
    g.rotation.y = yaw;
    g.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.scene.add(g);
    return g;
  }

  _buildLights(q) {
    const S = this.scene;
    const target = new Object3D();
    target.position.set(0, 74, 0);
    S.add(target);
    this.floods = [];
    this.beams = [];
    const masts = [
      [-62, 58, true],
      [64, 52, q.name !== 'low'],
      [78, -18, false],
      [-74, -6, false],
      [-26, -78, false],
      [40, -80, false],
    ];
    for (const [x, z, shadow] of masts) {
      const pole = new Mesh(new CylinderGeometry(0.25, 0.4, 30, 8), mat('paintedGrey'));
      pole.position.set(x, 15, z);
      pole.castShadow = true;
      S.add(pole);
      const head = new Mesh(new BoxGeometry(3.2, 1.6, 0.4), mat('lampCool'));
      head.position.set(x, 30.5, z);
      head.lookAt(0, 70, 0);
      S.add(head);
      const spot = new SpotLight(new Color(0.88, 0.93, 1.0), 52000, 0, 0.2, 0.75, 2);
      spot.position.set(x, 30.5, z);
      spot.target = target;
      if (shadow) {
        spot.castShadow = true;
        spot.shadow.mapSize.set(q.shadowMapSize / 2, q.shadowMapSize / 2);
        spot.shadow.camera.near = 20;
        spot.shadow.camera.far = 260;
        spot.shadow.bias = -0.0002;
        spot.shadow.normalBias = 0.05;
        spot.shadow.radius = 2;
      }
      S.add(spot);
      this.floods.push(spot);
      const beam = createBeam({ length: 140, radius: 16, intensity: 0.022 });
      beam.position.set(x, 30.5, z);
      beam.lookAt(0, 75, 0);
      S.add(beam);
      this.beams.push(beam);
    }

    // Mobile light tower over the crew staging area: the practical key on the workers.
    const lt = new Group();
    const trailer = new Mesh(new BoxGeometry(1.6, 1.1, 3.0), new MeshStandardMaterial({ color: 0xd9a514, roughness: 0.6 }));
    trailer.position.y = 0.9;
    const ltMast = new Mesh(new CylinderGeometry(0.08, 0.12, 7.5, 8), mat('paintedGrey'));
    ltMast.position.y = 4.6;
    const bar = new Mesh(new BoxGeometry(2.2, 0.12, 0.12), mat('paintedGrey'));
    bar.position.y = 8.3;
    lt.add(trailer, ltMast, bar);
    for (const dx of [-0.8, -0.27, 0.27, 0.8]) {
      const lamp = new Mesh(new BoxGeometry(0.5, 0.4, 0.15), mat('lampWarm'));
      lamp.position.set(dx, 8.3, 0.12);
      lamp.rotation.x = 0.5;
      lt.add(lamp);
    }
    lt.position.set(-106.5, 0, 101.5);
    lt.rotation.y = -2.2;
    lt.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    S.add(lt);
    const ltSpot = new SpotLight(new Color(1.0, 0.86, 0.68), 1500, 0, 0.75, 0.8, 2);
    ltSpot.position.set(-106.5, 8.3, 101.5);
    const ltTarget = new Object3D();
    ltTarget.position.set(-114, 0, 104);
    S.add(ltTarget);
    ltSpot.target = ltTarget;
    ltSpot.castShadow = q.name !== 'low';
    ltSpot.shadow.mapSize.set(1024, 1024);
    ltSpot.shadow.camera.near = 2;
    ltSpot.shadow.camera.far = 40;
    ltSpot.shadow.bias = -0.0005;
    ltSpot.shadow.radius = 3;
    S.add(ltSpot);
    this.workLight = ltSpot;
  }

  _buildVapor(q) {
    const S = this.scene;
    const rand = mulberry32(5);
    const scale = q.particleScale;
    const vents = [
      // [x, y, z, count, size0, size1, life, spreadUp]
      [0, LAYOUT.mountTop + 2, 0, 90, 2.5, 14, 9, 0.3], // booster aft / LOX bleed
      [0, LAYOUT.shipBase - 1, 0, 60, 1.8, 9, 8, 0.6], // hot-stage ring
      [0, LAYOUT.shipBase + 30, 0, 40, 1.2, 7, 7, 0.8], // ship header vent
      [0, 1.0, 0, 70, 4, 18, 12, 0.1], // deluge mist at the mount base
    ];
    this.vapor = [];
    for (const [x, y, z, n, s0, s1, life, up] of vents) {
      const field = new ParticleField({
        count: Math.round(n * scale),
        seed: Math.floor(rand() * 1000),
        spawn: (r) => {
          const a = r() * Math.PI * 2;
          const rr = DIMS.radius + 0.3;
          return {
            p: [x + Math.sin(a) * rr, y + (r() - 0.5) * 3, z + Math.cos(a) * rr],
            v: [Math.sin(a) * (1 + r()), up * (1 + r() * 2), Math.cos(a) * (1 + r())],
            life: life * (0.7 + r() * 0.6),
            size0: s0 * (0.7 + r() * 0.6),
            size1: s1 * (0.7 + r() * 0.6),
          };
        },
        color: new Color(0.82, 0.85, 0.9),
        opacity: 0.28,
        wind: new Vector3(1.6, 0.25, -0.4),
        drag: 0.8,
        turbulence: 1.8,
        lit: 0.6,
      });
      field.uniforms.uAmbient.value.set(0.22, 0.26, 0.34);
      field.uniforms.uLightColor.value.set(0.7, 0.72, 0.78);
      field.uniforms.uLightDir.value.set(-0.4, 0.3, 0.8).normalize();
      S.add(field.mesh);
      this.vapor.push(field);
    }
  }

  _buildWorkers(q) {
    const S = this.scene;
    const specs = [
      { seed: 3, vest: 'orange', hat: 'hard-white', action: 'talk', position: [-114.2, 0, 104.4], yaw: 0.9 },
      { seed: 4, vest: 'lime', hat: 'hard-yellow', action: 'radio', position: [-116.4, 0, 103.1], yaw: 0.3, prop: 'radio' },
      { seed: 5, vest: 'orange', hat: 'hard-white', action: 'tablet', position: [-110.6, 0, 100.2], yaw: -2.6, prop: 'tablet' },
      { seed: 6, vest: 'orange', hat: 'hard-white', action: 'point', position: [-108.8, 0, 104.6], yaw: -2.3, suit: 'charcoal' },
      { seed: 7, vest: 'lime', hat: 'hard-white', action: 'walk', path: [[-101, 93], [-70, 66], [-44, 44], [-70, 66]] },
      { seed: 8, vest: 'orange', hat: 'hard-yellow', action: 'work', position: [-30, 0.2, 31], yaw: -2.4 },
      { seed: 9, vest: 'orange', hat: 'hard-white', action: 'point', position: [-26, 0.2, 34], yaw: -2.6 },
      { seed: 10, vest: 'lime', hat: 'hard-white', action: 'idle', position: [-127.5, 0, 101.5], yaw: 1.2, suit: 'khaki' },
      { seed: 11, vest: 'orange', hat: 'hard-white', action: 'walk', path: [[12, 46], [40, 30], [12, 46], [-18, 52]] },
      { seed: 12, vest: 'orange', hat: 'hard-white', action: 'carry', position: [-36, 0.2, 26], yaw: 0.6 },
    ];
    const n = Math.max(5, Math.round(specs.length * (q.name === 'low' ? 0.6 : 1)));
    for (const spec of specs.slice(0, n)) {
      const w = new Worker(spec);
      if (spec.path) w.setPath(spec.path, { speed: 1.1 + (spec.seed % 3) * 0.1 });
      S.add(w.root);
      this.workers.push(w);
    }
    // Scene 2: close-out crew in the white room, tower tech at the arm root.
    this.closeout = new Worker({ seed: 21, suit: 'white', vest: 'none', hat: 'helmet', action: 'idle', position: [0.55, LAYOUT.armY, -6.9], yaw: Math.PI + 0.25 });
    this.towerTech = new Worker({ seed: 22, suit: 'charcoal', vest: 'orange', hat: 'hard-white', action: 'radio', position: [-2.6, LAYOUT.armY, -20.5], yaw: 0.4 });
    S.add(this.closeout.root, this.towerTech.root);
    this.workers.push(this.closeout, this.towerTech);
  }

  /**
   * Liftoff hardware (Scene 3, seen from inside the cabin): the 33-engine
   * plume, the plume's orange light on the tower, the deluge/steam cloud
   * boiling out of the mount, and the crew arm swinging clear.
   */
  _buildLaunchFX(q) {
    const S = this.scene;
    const booster = this.booster;
    this.plume = createPlume({ length: 80, radius: 11, exitRadius: 4.3, ambient: 1 });
    this.plume.position.y = -2.2;
    this.plume.visible = false;
    booster.add(this.plume);
    this.plumeLight = new PointLight(new Color(1.0, 0.6, 0.3), 0, 0, 2);
    this.plumeLight.position.set(0, -10, 0);
    booster.add(this.plumeLight);
    const scale = q.particleScale;
    this.cloud = new ParticleField({
      count: Math.round(180 * scale),
      seed: 77,
      spawn: (r) => {
        const a = r() * Math.PI * 2;
        const sp = 14 + r() * 26;
        return {
          p: [Math.sin(a) * 6, 1 + r() * 10, Math.cos(a) * 6],
          v: [Math.sin(a) * sp, 2 + r() * 9, Math.cos(a) * sp],
          life: 6 + r() * 5,
          size0: 9 + r() * 8,
          size1: 38 + r() * 30,
        };
      },
      color: new Color(0.86, 0.84, 0.82),
      opacity: 0.6,
      wind: new Vector3(3, 1.2, -1),
      drag: 0.45,
      turbulence: 6,
      lit: 0.7,
    });
    this.cloud.uniforms.uLightColor.value.set(1.6, 0.9, 0.5);
    this.cloud.uniforms.uLightDir.value.set(0, -1, 0);
    this.cloud.uniforms.uAmbient.value.set(0.25, 0.27, 0.32);
    this.cloud.uniforms.uIntensity.value = 0;
    this.cloud.mesh.visible = false;
    S.add(this.cloud.mesh);
    this.launch = { lift: 0, roll: 0, pitch: 0, throttle: 0, arm: 0 };
    this._qa = new Quaternion();
    this._qb = new Quaternion();
  }

  /** Drive liftoff: lift (m), roll/pitch (rad), throttle 0..1, arm swing 0..1. */
  setLaunch(p) {
    Object.assign(this.launch, p);
    const L = this.launch;
    const base = new Vector3(0, LAYOUT.mountTop, 0);
    // Rotate the stack about its engine plane, then lift it.
    this._qa.setFromAxisAngle(new Vector3(0, 0, 1), -L.pitch);
    this._qb.setFromAxisAngle(new Vector3(0, 1, 0), L.roll);
    this.stack.quaternion.multiplyQuaternions(this._qa, this._qb);
    this.stack.position.copy(base).applyQuaternion(this.stack.quaternion).negate().add(base);
    this.stack.position.y += L.lift;
    this.stack.updateMatrixWorld(true);
    this.arm.rotation.y = -L.arm * 1.15;
    const th = L.throttle;
    this.plume.visible = th > 0.01;
    this.plume.userData.uniforms.uThrottle.value = th;
    this.plumeLight.intensity = th * 26000;
    this.cloud.mesh.visible = th > 0.01 || this.cloud.uniforms.uIntensity.value > 0.01;
    this.cloud.uniforms.uIntensity.value = Math.min(1, th * 1.4) * Math.max(0, 1 - L.lift / 900);
  }

  /** 0 = blue hour (Scene 1), 1 = first sun on the hull (Scene 2). */
  setDaylight(k) {
    const u = this.sky.uniforms;
    const elev = -0.045 + k * 0.075; // radians-ish (≈ −2.6° → +1.7°)
    u.uSunDir.value.set(1, elev, -0.18).normalize();
    u.uSunDisc.value = k;
    u.uGlow.value.setRGB(1.15 + k * 0.4, 0.5 + k * 0.18, 0.2 + k * 0.05);
    u.uZenith.value.setRGB(0.012 + k * 0.03, 0.026 + k * 0.05, 0.07 + k * 0.1);
    u.uMid.value.setRGB(0.045 + k * 0.08, 0.08 + k * 0.1, 0.17 + k * 0.12);
    u.uHorizon.value.setRGB(0.2 + k * 0.22, 0.2 + k * 0.16, 0.26 + k * 0.08);
    this.hemi.intensity = 0.55 + k * 0.35;
    this.skyFill.intensity = 0.32 * (1 - k);
    this.sun.intensity = k * 3.4;
    this.sun.position.copy(u.uSunDir.value).multiplyScalar(500).add(new Vector3(0, LAYOUT.armY, -10));
    this.sun.target.position.set(0, LAYOUT.armY, -10);
    this.fog.color.setRGB(0.07 + k * 0.1, 0.085 + k * 0.08, 0.12 + k * 0.05);
    for (const f of this.floods) f.intensity = 52000 * (1 - k * 0.55);
    for (const b of this.beams) b.userData.uniforms.uIntensity.value = 0.022 * (1 - k * 0.7);
    this._bakeEnv();
  }

  /** Fit the sun's shadow frustum around a focus point (the bridge in Scene 2). */
  focusSunShadow(center, halfSize = 40) {
    const c = this.sun.shadow.camera;
    c.left = -halfSize;
    c.right = halfSize;
    c.top = halfSize;
    c.bottom = -halfSize;
    c.updateProjectionMatrix();
    this.sun.target.position.copy(center);
    this.sun.position.copy(this.sky.uniforms.uSunDir.value).multiplyScalar(400).add(center);
  }

  update(dt, t) {
    this.sky.uniforms.uTime.value = t;
    if (this.plume.visible) this.plume.userData.uniforms.uTime.value = t;
    if (this.cloud.mesh.visible) this.cloud.update(t);
    if (this.waterNormal) this.waterNormal.offset.set(t * 0.004, t * 0.0025);
    for (const v of this.vapor) v.update(t);
    for (const b of this.beams) b.userData.uniforms.uTime.value = t;
    for (const w of this.workers) w.update(dt, t);
    const blink = Math.sin(t * Math.PI * 1.2) > 0.2 ? 6 : 0.15;
    const ob = this.tower.userData.obstructionMaterial;
    if (ob) ob.emissiveIntensity = blink;
  }
}
