import { Color, DirectionalLight, HemisphereLight, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, SphereGeometry, Vector3, BackSide } from 'three';
import { createSpaceSky, bakeEnvironment } from './sky.js';
import { Planet } from './planets.js';
import { buildShip } from './starship.js';
import { createPlume } from './vfx.js';

/**
 * SPACE — the far layer for orbit, the coast to Mars, and entry from space.
 *
 * The ship is always at (or near) the origin of this world; planets are placed
 * around it in metres. That keeps every camera near the origin, so float
 * precision is spent where the eye is. Montage beats just re-place the bodies
 * (Earth 210 km below; Earth and Moon as a pair of points; Mars filling the
 * window) rather than flying 225 million km.
 */
export class SpaceSet {
  constructor(ctx) {
    this.ctx = ctx;
    this.scene = new Scene();
    this.scene.name = 'Space';
    this.camera = new PerspectiveCamera(50, 1, 0.5, 4e10);
    this.camera.name = 'FarEyes';
    this.sunDir = new Vector3(0.62, 0.3, -0.72).normalize();
  }

  async build(progress = () => {}) {
    const { engine, assets } = this.ctx;
    const S = this.scene;
    this.sky = createSpaceSky();
    S.add(this.sky.mesh);
    progress(0.1, 'Space · stars');
    this.earth = new Planet('earth', { renderer: engine.renderer, assets });
    progress(0.45, 'Space · Earth');
    this.moon = new Planet('moon', { renderer: engine.renderer, assets, segments: 96 });
    this.mars = new Planet('mars', { renderer: engine.renderer, assets });
    progress(0.8, 'Space · Mars');
    S.add(this.earth.group, this.moon.group, this.mars.group);

    // Tanker for the refuelling rendezvous. Lit by the sun and by Earthshine.
    this.tanker = buildShip({ variant: 'tanker', heat: 0.35, soot: 0.25 });
    this.tanker.visible = false;
    S.add(this.tanker);
    this.tankerRcs = [];
    for (const [x, y, z] of [[2.6, 47.5, -3.2], [-2.6, 47.5, -3.2]]) {
      const p = createPlume({ length: 2.2, radius: 0.5, exitRadius: 0.06, ambient: 0 });
      p.position.set(x, y, z);
      p.rotation.z = x > 0 ? Math.PI / 2 : -Math.PI / 2;
      p.userData.uniforms.uThrottle.value = 0;
      this.tanker.add(p);
      this.tankerRcs.push(p);
    }
    this.sun = new DirectionalLight(new Color(1, 0.97, 0.92), 3.6);
    this.sun.position.copy(this.sunDir).multiplyScalar(500);
    S.add(this.sun, this.sun.target);
    this.earthshine = new HemisphereLight(new Color(0.02, 0.025, 0.03), new Color(0.32, 0.45, 0.7), 0.6);
    S.add(this.earthshine);

    // Steel reflects the planet below, not just black sky: bake an env with a
    // bright blue-white "Earth" filling the lower hemisphere.
    const envScene = this.sky.envScene.clone();
    const glow = new Mesh(new SphereGeometry(0.5, 32, 16, 0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.45), new MeshBasicMaterial({ color: new Color(0.35, 0.5, 0.75), side: BackSide }));
    glow.renderOrder = 1; // after the sky dome, which ignores depth
    envScene.add(glow);
    this.envTex = bakeEnvironment(engine.pmrem, envScene);
    S.environment = this.envTex;
    S.environmentIntensity = 0.8;
    this.setSun(this.sunDir);
    progress(1, 'Space');
  }

  setSun(dir, intensity = 4.0) {
    this.sunDir.copy(dir).normalize();
    this.sky.uniforms.uSunDir.value.copy(this.sunDir);
    for (const p of [this.earth, this.moon, this.mars]) p.setSun(this.sunDir, intensity);
    this.sun.position.copy(this.sunDir).multiplyScalar(500);
    this.sun.target.position.set(0, 0, 0);
  }

  /** Is the point (world) in a planet's shadow? Returns 0..1 sunlight. */
  sunlightAt(point) {
    let lit = 1;
    for (const p of [this.earth, this.mars]) {
      if (!p.group.visible) continue;
      const c = p.group.position;
      const oc = point.clone().sub(c);
      const b = oc.dot(this.sunDir);
      const cc = oc.lengthSq() - p.radius * p.radius;
      const disc = b * b - cc;
      if (disc > 0 && -b - Math.sqrt(disc) > 0) {
        // Penumbra: soften by how deep the ray goes.
        const miss = Math.sqrt(Math.max(0, oc.lengthSq() - b * b)) - p.radius;
        lit = Math.min(lit, Math.max(0, Math.min(1, 0.5 + miss / 60e3)));
      }
    }
    return lit;
  }

  update(dt, t, camera) {
    const cam = camera || this.camera;
    for (const p of [this.earth, this.moon, this.mars]) if (p.group.visible) p.update(cam, t);
    for (const p of this.tankerRcs) p.userData.uniforms.uTime.value = t;
  }
}
