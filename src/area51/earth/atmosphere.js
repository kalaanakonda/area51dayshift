import { BackSide, Color, Mesh, Scene, ShaderMaterial, SphereGeometry, Vector3 } from 'three';
import { GLSL_NOISE } from '../../render/shaders/glsl.js';

/**
 * Atmosphere — one single-scattering model (Rayleigh + Mie, Bruneton's
 * reference coefficients, Chapman-function sun paths) shared by:
 *
 *   • the sky dome            ground-level blue → golden hour → black space
 *   • aerial perspective      patched into every outdoor material: tiles,
 *                             hangar shell, saucer — haze thickens with range
 *   • tile relighting         satellite / photogrammetry imagery is shot near
 *                             noon; it is re-lit by the *current* sun so the
 *                             terminator, dawn and night all work
 *   • the sun light + ambient for PBR objects (JS mirror of the same maths)
 *
 * Units inside the shaders are "planet radii" with the planet radius taken
 * at the camera's latitude, so the camera sits at |ro| ≈ 1.00002.
 */

const H_R = 8000;
const H_M = 1200;
const TOP = 100e3;
const BETA_R = [5.802e-6, 13.558e-6, 33.1e-6];
const BETA_M = 3.996e-6;
const BETA_M_EXT = 4.44e-6;

export const SUN_IRRADIANCE = 4.0;

export function createAtmosphereUniforms() {
  return {
    uA51Cam: { value: new Vector3(0, 1.0002, 0) },
    uA51Sun: { value: new Vector3(0, 1, 0) },
    uA51SunI: { value: SUN_IRRADIANCE },
    uA51PlanetR: { value: 6371e3 },
    uA51BetaR: { value: new Vector3() },
    uA51BetaM: { value: 0 },
    uA51BetaMExt: { value: 0 },
    uA51HR: { value: 0 },
    uA51HM: { value: 0 },
    uA51Top: { value: 1 },
    uA51G: { value: 0.8 },
    uA51SkyGain: { value: 2.2 },
    uA51TileGain: { value: 1.25 },
    uA51Haze: { value: 1 },
  };
}

export const GLSL_ATMO = /* glsl */ `
  uniform vec3 uA51Cam;
  uniform vec3 uA51Sun;
  uniform float uA51SunI, uA51PlanetR, uA51BetaM, uA51BetaMExt, uA51HR, uA51HM, uA51Top, uA51G, uA51SkyGain, uA51TileGain, uA51Haze;
  uniform vec3 uA51BetaR;

  vec2 a51RaySphere(vec3 ro, vec3 rd, float r) {
    float b = dot(ro, rd);
    float c = dot(ro, ro) - r * r;
    float d = b * b - c;
    if (d < 0.0) return vec2(1e9, -1e9);
    d = sqrt(d);
    return vec2(-b - d, -b + d);
  }

  // Chapman function (Schüler, GPU Pro 3): column density toward the sun from
  // altitude h (scale heights) on a planet of radius X (scale heights).
  float a51Chapman(float X, float h, float mu) {
    float c = sqrt(X + h);
    if (mu >= 0.0) return c / (c * mu + 1.0) * exp(-h);
    float x0 = sqrt(1.0 - mu * mu) * (X + h);
    float c0 = sqrt(x0);
    return min(2.0 * c0 * exp(X - x0) - c / (1.0 - c * mu) * exp(-h), 1e5);
  }

  vec3 a51SunTransmittance(float h, float mu) {
    float r = uA51HR * a51Chapman(1.0 / uA51HR, h / uA51HR, mu);
    float m = uA51HM * a51Chapman(1.0 / uA51HM, h / uA51HM, mu);
    return exp(-(uA51BetaR * r + uA51BetaMExt * m));
  }

  void a51Scatter(vec3 ro, vec3 rd, float tMax, int n, out vec3 inscat, out vec3 trans) {
    inscat = vec3(0.0);
    trans = vec3(1.0);
    vec2 ta = a51RaySphere(ro, rd, uA51Top);
    float t0 = max(ta.x, 0.0);
    float t1 = min(ta.y, tMax);
    if (t1 <= t0) return;
    float ds = (t1 - t0) / float(n);
    float mu = dot(rd, uA51Sun);
    float pr = 0.0596831 * (1.0 + mu * mu);
    float g = uA51G;
    float g2 = g * g;
    float pm = 0.1193662 * (1.0 - g2) * (1.0 + mu * mu) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
    vec2 od = vec2(0.0);
    for (int i = 0; i < 16; i++) {
      if (i >= n) break;
      vec3 x = ro + rd * (t0 + (float(i) + 0.5) * ds);
      float r = length(x);
      float h = max(r - 1.0, 0.0);
      vec2 dens = exp(-vec2(h / uA51HR, h / uA51HM)) * ds;
      od += dens * 0.5;
      float muS = dot(x / r, uA51Sun);
      vec2 ts = a51RaySphere(x, uA51Sun, 1.0);
      float lit = ts.x > 0.0 ? 0.0 : 1.0;
      vec2 odSun = vec2(uA51HR * a51Chapman(1.0 / uA51HR, h / uA51HR, muS), uA51HM * a51Chapman(1.0 / uA51HM, h / uA51HM, muS));
      vec3 tau = uA51BetaR * (od.x + odSun.x) + uA51BetaMExt * (od.y + odSun.y);
      inscat += exp(-tau) * (dens.x * uA51BetaR * pr + dens.y * uA51BetaM * pm) * lit;
      od += dens * 0.5;
    }
    trans = exp(-(uA51BetaR * od.x + uA51BetaMExt * od.y));
    inscat *= uA51SunI * uA51SkyGain;
  }

  // Irradiance reaching a horizontal patch of ground with geocentric normal N,
  // as outgoing radiance of a white Lambertian surface (sun + sky, no shadows).
  vec3 a51GroundLight(vec3 N) {
    float ndl = dot(N, uA51Sun);
    vec3 tSun = a51SunTransmittance(0.0, ndl);
    float day = smoothstep(-0.035, 0.06, ndl);
    vec3 sun = tSun * max(ndl, 0.0) * day;
    // Skylight: bluish, follows the sun but survives well into twilight.
    vec3 sky = vec3(0.16, 0.2, 0.28) * smoothstep(-0.16, 0.3, ndl) * (0.35 + 0.65 * tSun.g);
    return (sun + sky) * uA51SunI * 0.3183099 + vec3(0.0006, 0.0008, 0.0014);
  }
`;

const DOME_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position.z = gl_Position.w; // at infinity
  }
`;

const DOME_FRAG = /* glsl */ `
  ${GLSL_ATMO}
  ${GLSL_NOISE}
  uniform float uStars;
  uniform vec3 uGround;
  varying vec3 vDir;

  vec3 starLayer(vec3 d, float cells, float thresh, float seed) {
    vec3 a = abs(d);
    vec2 uv; float face;
    if (a.x > a.y && a.x > a.z) { uv = d.yz / a.x; face = sign(d.x); }
    else if (a.y > a.z) { uv = d.xz / a.y; face = 2.0 + sign(d.y); }
    else { uv = d.xy / a.z; face = 4.0 + sign(d.z); }
    vec2 gp = uv * cells;
    vec2 id = floor(gp);
    vec2 f = fract(gp);
    float h = hash12(id + face * 131.7 + seed);
    if (h < thresh) return vec3(0.0);
    vec2 p = hash22(id + seed + face) * 0.7 + 0.15;
    float dist = length(f - p);
    float b = pow((h - thresh) / (1.0 - thresh), 3.0);
    float core = smoothstep(0.16, 0.0, dist);
    vec3 tint = mix(vec3(1.0, 0.82, 0.68), vec3(0.75, 0.85, 1.0), hash12(id * 1.7 + seed));
    return tint * core * (0.02 + b * 0.6);
  }

  void main() {
    vec3 rd = normalize(vDir);
    vec3 ro = uA51Cam;
    vec2 tg = a51RaySphere(ro, rd, 1.0);
    bool ground = tg.x > 0.0;
    float tMax = ground ? tg.x : 1e9;
    vec3 ins, tr;
    a51Scatter(ro, rd, tMax, 14, ins, tr);
    vec3 col = ins;
    float alpha = 0.0;
    if (ground) {
      // Stand-in ground for any patch of planet whose tiles are not loaded yet.
      vec3 p = ro + rd * tg.x;
      vec3 N = normalize(p);
      col += uGround * a51GroundLight(N) * tr;
      alpha = 1.0;
    } else {
      float cs = dot(rd, uA51Sun);
      float disc = smoothstep(0.999986, 0.999993, cs);
      col += tr * uA51SunI * (disc * 40.0 + pow(max(cs, 0.0), 3000.0) * 1.5);
      float skyL = dot(ins, vec3(0.2126, 0.7152, 0.0722));
      vec3 stars = starLayer(rd, 180.0, 0.985, 1.0) + starLayer(rd, 420.0, 0.992, 7.0) * 0.6;
      col += stars * tr * uStars * exp(-skyL * 60.0);
    }
    gl_FragColor = vec4(col, alpha);
  }
`;

/**
 * Sky dome + environment bake + the JS mirror of the sun transmittance.
 */
export class Atmosphere {
  constructor(uniforms = createAtmosphereUniforms()) {
    this.uniforms = uniforms;
    this.setPlanetRadius(6371e3);
    /** Albedo of the stand-in ground in the dome — and so of the bounce light in the environment bake. */
    this.groundAlbedo = new Vector3(0.22, 0.2, 0.17);
    const material = new ShaderMaterial({
      uniforms: { ...uniforms, uStars: { value: 1 }, uGround: { value: this.groundAlbedo } },
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      side: BackSide,
      depthWrite: false,
      depthTest: false,
    });
    this.material = material;
    const dome = new Mesh(new SphereGeometry(1, 96, 48), material);
    dome.name = 'sky';
    dome.frustumCulled = false;
    dome.renderOrder = -1000;
    dome.onBeforeRender = (renderer, scene, camera) => {
      dome.position.setFromMatrixPosition(camera.matrixWorld);
      dome.scale.setScalar(camera.far * 0.5);
      dome.updateMatrixWorld();
    };
    this.dome = dome;

    // Environment for PBR objects outdoors: the same sky on a unit sphere.
    this.envScene = new Scene();
    this.envScene.add(new Mesh(new SphereGeometry(1, 48, 24), material));
    this.sunColor = new Color(1, 1, 1);
    this.skyColor = new Color(0.3, 0.4, 0.6);
    this.groundColor = new Color(0.3, 0.27, 0.22);
    this._lastBake = { dir: new Vector3(), h: -1, ground: new Vector3() };
    this.envTexture = null;
  }

  setPlanetRadius(R) {
    const u = this.uniforms;
    u.uA51PlanetR.value = R;
    u.uA51BetaR.value.set(BETA_R[0] * R, BETA_R[1] * R, BETA_R[2] * R);
    u.uA51BetaM.value = BETA_M * R;
    u.uA51BetaMExt.value = BETA_M_EXT * R;
    u.uA51HR.value = H_R / R;
    u.uA51HM.value = H_M / R;
    u.uA51Top.value = 1 + TOP / R;
  }

  /**
   * camWorld: eye position (world). earthCenter: Earth centre (world).
   * groundRadius: geocentric radius of the surface below the eye (m).
   */
  update(camWorld, earthCenter, groundRadius, sunDir) {
    const u = this.uniforms;
    if (Math.abs(groundRadius - u.uA51PlanetR.value) > 50) this.setPlanetRadius(groundRadius);
    const R = u.uA51PlanetR.value;
    u.uA51Cam.value.copy(camWorld).sub(earthCenter).divideScalar(R);
    u.uA51Sun.value.copy(sunDir).normalize();
    const up = u.uA51Cam.value.clone().normalize();
    const h = Math.max(0, (u.uA51Cam.value.length() - 1) * R);
    this.altitude = h;
    const mu = up.dot(u.uA51Sun.value);
    this.sunMu = mu;
    // Sunlight at the eye, including the planet's shadow.
    const t = this.sunTransmittance(h, mu);
    const shadowed = this._planetShadow(u.uA51Cam.value, u.uA51Sun.value);
    this.sunColor.setRGB(t[0], t[1], t[2]).multiplyScalar(1 - shadowed);
    // Ambient sky / ground for the hemisphere fallback.
    const day = smooth(-0.16, 0.3, mu);
    this.skyColor.setRGB(0.16, 0.2, 0.28).multiplyScalar(day * (0.35 + 0.65 * t[1]) * 1.6 + 0.004);
    this.groundColor.setRGB(0.24, 0.21, 0.17).multiplyScalar(Math.max(0, mu) * t[1] + 0.25 * day + 0.01);
  }

  _planetShadow(ro, sun) {
    const b = ro.dot(sun);
    const c = ro.lengthSq() - 1;
    const d = b * b - c;
    if (d < 0) return 0;
    const t0 = -b - Math.sqrt(d);
    if (t0 <= 0) return 0;
    // soft edge from the grazing distance
    const miss = Math.sqrt(Math.max(0, ro.lengthSq() - b * b));
    return 1 - smooth(0.9985, 1.0, miss);
  }

  /** JS mirror of a51SunTransmittance. Returns [r, g, b]. */
  sunTransmittance(h, mu) {
    const u = this.uniforms;
    const HR = u.uA51HR.value;
    const HM = u.uA51HM.value;
    const hr = HR * chapman(1 / HR, h / u.uA51PlanetR.value / HR, mu);
    const hm = HM * chapman(1 / HM, h / u.uA51PlanetR.value / HM, mu);
    const b = u.uA51BetaR.value;
    const m = u.uA51BetaMExt.value;
    return [Math.exp(-(b.x * hr + m * hm)), Math.exp(-(b.y * hr + m * hm)), Math.exp(-(b.z * hr + m * hm))];
  }

  /** Re-bake the PMREM environment when the sun or altitude moved enough. */
  maybeBake(pmrem, force = false) {
    const L = this._lastBake;
    const dir = this.uniforms.uA51Sun.value;
    const h = this.altitude || 0;
    const moved = L.dir.angleTo(dir) > 0.004 || Math.abs(Math.log((h + 50) / (L.h + 50))) > 0.25 || L.ground.distanceTo(this.groundAlbedo) > 0.02;
    if (!force && this.envTexture && !moved) return false;
    L.dir.copy(dir);
    L.h = h;
    L.ground.copy(this.groundAlbedo);
    const rt = pmrem.fromScene(this.envScene, 0, 0.1, 10);
    if (this.envRT) this.envRT.dispose();
    this.envRT = rt;
    this.envTexture = rt.texture;
    return true;
  }
}

function chapman(X, h, mu) {
  const c = Math.sqrt(X + h);
  if (mu >= 0) return (c / (c * mu + 1)) * Math.exp(-h);
  const x0 = Math.sqrt(1 - mu * mu) * (X + h);
  const c0 = Math.sqrt(x0);
  return Math.min(2 * c0 * Math.exp(X - x0) - (c / (1 - c * mu)) * Math.exp(-h), 1e5);
}

function smooth(a, b, v) {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Patch a built-in three.js material (Basic / Lambert / Standard / Physical)
 * with aerial perspective, and optionally re-light it as satellite imagery.
 * Chains any onBeforeCompile already present (terrain displacement, tile fades).
 */
export function atmospherize(material, uniforms, { relight = false } = {}) {
  if (material.userData.a51) return material;
  material.userData.a51 = true;
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey ? material.customProgramCacheKey.call(material) : '';
  material.onBeforeCompile = function (shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vA51View;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvA51View = mvPosition.xyz;');
    let frag = shader.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec3 vA51View;\n${GLSL_ATMO}`);
    if (relight) {
      frag = frag.replace(
        '#include <map_fragment>',
        /* glsl */ `#include <map_fragment>
        {
          float tmR = length(vA51View);
          vec3 rdR = normalize((vec4(vA51View, 0.0) * viewMatrix).xyz);
          vec3 N = normalize(uA51Cam + rdR * (tmR / uA51PlanetR));
          diffuseColor.rgb *= a51GroundLight(N) * uA51TileGain;
        }`
      );
    }
    frag = frag.replace(
      '#include <fog_fragment>',
      /* glsl */ `#include <fog_fragment>
      {
        float tm = length(vA51View);
        if (tm > 40.0) {
          vec3 rd = normalize((vec4(vA51View, 0.0) * viewMatrix).xyz);
          vec3 ins, tr;
          a51Scatter(uA51Cam, rd, tm / uA51PlanetR, 6, ins, tr);
          tr = mix(vec3(1.0), tr, uA51Haze);
          gl_FragColor.rgb = gl_FragColor.rgb * tr + ins * uA51Haze;
        }
      }`
    );
    shader.fragmentShader = frag;
  };
  material.customProgramCacheKey = () => `a51${relight ? 'R' : ''}|${prevKey}`;
  material.needsUpdate = true;
  return material;
}
