import {
  BackSide,
  ClampToEdgeWrapping,
  Color,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  UnsignedByteType,
  Vector3,
  WebGLRenderTarget,
} from 'three';
import { GLSL_NOISE } from '../render/shaders/glsl.js';
import { additive } from './vfx.js';

/**
 * Planets for the far layer: Earth (launch → orbit → departure), the Moon, and
 * Mars (approach → entry).
 *
 * Surfaces are procedural, but not evaluated per frame: at load time each
 * planet's shader is BAKED once into equirectangular maps (2048 × 1024), so at
 * runtime a planet costs two texture reads plus lighting. If BlendKit / NASA
 * maps are dropped in (manifest TEXTURES: earth_day, earth_clouds, mars_albedo)
 * they replace the bakes 1:1.
 *
 * Atmospheres are real single scattering (Rayleigh + Mie, 12 samples along the
 * view ray, Kasten–Young air mass toward the sun, planet shadow), computed in
 * planet radii so precision holds from 400 000 km down to 3 km altitude. The
 * same integral tints the ground (aerial perspective) and draws the limb, so
 * the thin blue line of Earth and Mars' butterscotch haze come out of one model.
 */

export const PLANET = {
  earth: {
    radius: 6371e3,
    atmo: 1 + 100e3 / 6371e3,
    hR: 8.0e3 / 6371e3,
    hM: 1.2e3 / 6371e3,
    // Scattering coefficients ×R (so optical depth is in planet radii).
    betaR: [5.8e-6 * 6371e3, 13.5e-6 * 6371e3, 33.1e-6 * 6371e3],
    betaM: [3e-6 * 6371e3, 3e-6 * 6371e3, 3e-6 * 6371e3],
    mieExt: 1.11,
    g: 0.76,
  },
  mars: {
    radius: 3389.5e3,
    atmo: 1 + 80e3 / 3389.5e3,
    hR: 11.1e3 / 3389.5e3,
    hM: 11.1e3 / 3389.5e3,
    // Mars: CO2 Rayleigh is weak; suspended dust (absorbs blue) does the work.
    betaR: [0.4e-6 * 3389.5e3, 0.95e-6 * 3389.5e3, 2.2e-6 * 3389.5e3],
    betaM: [26e-6 * 3389.5e3, 17e-6 * 3389.5e3, 10e-6 * 3389.5e3],
    mieExt: 1.6,
    g: 0.62,
  },
  moon: { radius: 1737.4e3 },
};

// ------------------------------------------------------------------ baking

const BAKE_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const SPHERE_FROM_UV = /* glsl */ `
  vec3 sph(vec2 uv) {
    float lon = (uv.x - 0.5) * 6.2831853;
    float lat = (uv.y - 0.5) * 3.1415927;
    return vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
  }
`;

/** Cellular craters on the unit sphere: bowl + raised rim, several per cell row. */
const GLSL_CRATERS = /* glsl */ `
  float craters(vec3 p, float scale, float density, float seed) {
    vec3 g = p * scale;
    vec3 i = floor(g);
    vec3 f = fract(g);
    float h = 0.0;
    for (int x = -1; x <= 1; x++)
    for (int y = -1; y <= 1; y++)
    for (int z = -1; z <= 1; z++) {
      vec3 o = vec3(float(x), float(y), float(z));
      vec3 cell = i + o;
      if (hash13(cell + seed) > density) continue;
      vec3 c = o + vec3(hash13(cell + 1.3), hash13(cell + 5.1), hash13(cell + 9.7)) - f;
      float r = 0.12 + 0.36 * pow(hash13(cell + 13.3), 2.0);
      float q = length(c) / r;
      float bowl = q < 1.0 ? (q * q - 1.0) * 0.9 : 0.0;
      float rim = exp(-pow((q - 1.0) / 0.22, 2.0)) * 0.32;
      float ejecta = q > 1.0 ? exp(-(q - 1.0) * 2.5) * 0.06 : 0.0;
      h += (bowl + rim + ejecta) * r;
    }
    return h;
  }
`;

const EARTH_SURFACE_BAKE = /* glsl */ `
  void main() {
    vec3 p = sph(vUv);
    vec3 w = vec3(fbm3(p * 1.3 + 1.7, 3), fbm3(p * 1.3 + 9.2, 3), fbm3(p * 1.3 + 4.4, 3));
    float c = fbm3(p * 1.45 + w * 0.5 + 3.0, 7) + 0.16 * fbm3(p * 7.0 + 3.0, 4);
    float land = smoothstep(0.07, 0.085, c);
    float elev = clamp((c - 0.08) * 2.6, 0.0, 1.0);
    float lat = abs(p.y);
    // Moisture: wet equator, dry Hadley belts near 27°, wetter mid-latitudes.
    float moist = fbm3(p * 2.4 + 40.0, 5) * 0.65 + 0.5;
    moist += 0.25 * (1.0 - smoothstep(0.0, 0.22, lat)) - 0.3 * exp(-pow((lat - 0.45) / 0.12, 2.0)) + 0.08 * smoothstep(0.55, 0.75, lat);
    moist -= elev * 0.2;

    vec3 desert = vec3(0.64, 0.5, 0.33);
    vec3 steppe = vec3(0.42, 0.39, 0.24);
    vec3 forest = vec3(0.1, 0.165, 0.07);
    vec3 jungle = vec3(0.055, 0.12, 0.045);
    vec3 tundra = vec3(0.36, 0.34, 0.29);
    vec3 col = mix(desert, steppe, smoothstep(0.3, 0.48, moist));
    col = mix(col, forest, smoothstep(0.48, 0.66, moist));
    col = mix(col, jungle, smoothstep(0.62, 0.82, moist) * (1.0 - smoothstep(0.1, 0.35, lat)));
    col = mix(col, tundra, smoothstep(0.62, 0.74, lat));
    col = mix(col, vec3(0.44, 0.41, 0.37), smoothstep(0.45, 0.75, elev) * 0.65);
    col *= 0.86 + 0.28 * (fbm3(p * 38.0, 4) * 0.5 + 0.5);
    float ice = smoothstep(0.8, 0.86, lat + fbm3(p * 9.0, 3) * 0.05) + smoothstep(0.78, 0.82, elev + lat * 0.4) * 0.7;
    col = mix(col, vec3(0.86, 0.9, 0.95), clamp(ice, 0.0, 1.0));

    vec3 deep = vec3(0.004, 0.017, 0.048);
    vec3 shelf = vec3(0.012, 0.07, 0.11);
    vec3 ocean = mix(deep, shelf, smoothstep(-0.04, 0.075, c));
    ocean = mix(ocean, vec3(0.82, 0.87, 0.93), smoothstep(0.86, 0.92, lat + fbm3(p * 7.0, 3) * 0.04));

    vec3 albedo = mix(ocean, col, land);
    gl_FragColor = vec4(sqrt(albedo), land * (1.0 - clamp(ice, 0.0, 1.0)));
  }
`;

const EARTH_CLOUD_BAKE = /* glsl */ `
  void main() {
    vec3 p = sph(vUv);
    float lat = abs(p.y);
    vec3 q = p + 0.16 * vec3(fbm3(p * 2.2 + 2.0, 4), fbm3(p * 2.2 + 5.0, 4), fbm3(p * 2.2 + 8.0, 4));
    float cl = fbm3(q * 3.1 + 20.0, 7) * 0.5 + 0.5;
    cl += 0.09 * cos(lat * 9.42) + 0.1 * (1.0 - smoothstep(0.0, 0.1, lat)); // ITCZ + storm tracks
    float cloud = smoothstep(0.5, 0.74, cl);
    cloud = max(cloud, smoothstep(0.66, 0.92, fbm3(q * 11.0, 4) * 0.5 + 0.5) * 0.55);
    // City lights: clustered on temperate coasts and plains (green channel).
    float c = fbm3(p * 1.45 + vec3(fbm3(p * 1.3 + 1.7, 3), fbm3(p * 1.3 + 9.2, 3), fbm3(p * 1.3 + 4.4, 3)) * 0.5 + 3.0, 5);
    float land = smoothstep(0.075, 0.09, c);
    float pop = smoothstep(0.55, 0.85, fbm3(p * 7.0 + 61.0, 4) * 0.5 + 0.5) * land * (1.0 - smoothstep(0.62, 0.72, lat));
    float spark = step(0.93, hash13(floor(p * 520.0))) * 0.7 + step(0.985, hash13(floor(p * 1500.0)));
    float lights = clamp(pop * (0.35 + spark), 0.0, 1.0);
    gl_FragColor = vec4(cloud, lights, 0.0, 1.0);
  }
`;

const MARS_BAKE = /* glsl */ `
  void main() {
    vec3 p = sph(vUv);
    float lat = p.y;
    // Albedo provinces: bright dusty plains vs dark basaltic highlands.
    float prov = fbm3(p * 1.7 + 3.0, 6) + 0.25 * fbm3(p * 5.0 + 7.0, 4);
    vec3 bright = vec3(0.6, 0.35, 0.2);
    vec3 dark = vec3(0.27, 0.155, 0.095);
    vec3 col = mix(bright, dark, smoothstep(0.08, 0.38, prov));
    col *= 0.86 + 0.26 * (fbm3(p * 14.0, 4) * 0.5 + 0.5);
    // Relief: three crater populations (southern highlands more cratered).
    float hl = smoothstep(0.25, -0.35, lat + fbm3(p * 2.0, 3) * 0.3);
    float h = craters(p, 7.0, 0.22 + hl * 0.25, 1.0) * 1.6
            + craters(p, 19.0, 0.3 + hl * 0.35, 4.0) * 0.8
            + craters(p, 55.0, 0.35 + hl * 0.4, 9.0) * 0.4;
    h += fbm3(p * 6.0 + 2.0, 5) * 0.15;
    // A Valles-Marineris-like canyon system along the equator.
    float lon = atan(p.x, p.z);
    float canyon = exp(-pow((lat + 0.12 + 0.05 * sin(lon * 3.0)) / 0.018, 2.0)) * smoothstep(-0.4, -0.1, lon) * smoothstep(1.1, 0.6, lon);
    h -= canyon * 0.6;
    col = mix(col, dark * 0.8, canyon * 0.7);
    // Polar caps (north larger) with dusty margins.
    float capN = smoothstep(0.9, 0.925, lat + fbm3(p * 10.0, 3) * 0.025);
    float capS = smoothstep(0.93, 0.955, -lat + fbm3(p * 10.0 + 5.0, 3) * 0.02);
    col = mix(col, vec3(0.9, 0.87, 0.84), max(capN, capS));
    // Wind streaks and albedo detail from the crater field.
    col *= 1.0 + h * 0.18;
    gl_FragColor = vec4(sqrt(clamp(col, 0.0, 1.0)), clamp(h * 0.25 + 0.5, 0.0, 1.0));
  }
`;

const MOON_BAKE = /* glsl */ `
  void main() {
    vec3 p = sph(vUv);
    float maria = smoothstep(0.05, 0.3, fbm3(p * 1.6 + 11.0, 5)) * smoothstep(-0.2, 0.4, p.z);
    vec3 col = mix(vec3(0.42, 0.41, 0.4), vec3(0.2, 0.2, 0.205), maria);
    float h = craters(p, 9.0, 0.45, 2.0) + craters(p, 26.0, 0.5, 6.0) * 0.5 + craters(p, 70.0, 0.5, 8.0) * 0.25;
    col *= 0.85 + 0.3 * (fbm3(p * 20.0, 4) * 0.5 + 0.5) + h * 0.2;
    gl_FragColor = vec4(sqrt(clamp(col, 0.0, 1.0)), clamp(h * 0.25 + 0.5, 0.0, 1.0));
  }
`;

/** Render a fullscreen bake shader into an equirect RGBA8 target (mipmapped). */
function bake(renderer, body, width, height) {
  const rt = new WebGLRenderTarget(width, height, {
    format: RGBAFormat,
    type: UnsignedByteType,
    depthBuffer: false,
    generateMipmaps: true,
    minFilter: LinearMipmapLinearFilter,
    magFilter: LinearFilter,
    wrapS: RepeatWrapping,
    wrapT: ClampToEdgeWrapping,
    anisotropy: 4,
  });
  const material = new ShaderMaterial({
    vertexShader: BAKE_VERT,
    fragmentShader: `varying vec2 vUv;\n${GLSL_NOISE}\n${SPHERE_FROM_UV}\n${GLSL_CRATERS}\n${body}`,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new Mesh(new PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const scene = new Scene();
  scene.add(quad);
  const cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prev);
  material.dispose();
  quad.geometry.dispose();
  return rt;
}

// ------------------------------------------------------------------ runtime shaders

const GLSL_ATMOSPHERE = /* glsl */ `
  uniform vec3 uCamR;       // camera position relative to the planet centre, in radii
  uniform vec3 uSunDir;
  uniform float uSunI;
  uniform float uAtmo, uHR, uHM, uG, uAtmoOn;
  uniform vec3 uBetaR, uBetaM, uBetaMExt;

  vec2 raySphere(vec3 ro, vec3 rd, float r) {
    float b = dot(ro, rd);
    float c = dot(ro, ro) - r * r;
    float d = b * b - c;
    if (d < 0.0) return vec2(1e9, -1e9);
    d = sqrt(d);
    return vec2(-b - d, -b + d);
  }

  // Chapman function (Schüler, GPU Pro 3): column density toward the sun from
  // altitude h, in scale heights, for planet radius X (scale heights). Valid
  // below the horizon too, as long as the ray clears the ground (shadow test).
  float chapman(float X, float h, float mu) {
    float c = sqrt(X + h);
    if (mu >= 0.0) return c / (c * mu + 1.0) * exp(-h);
    float x0 = sqrt(1.0 - mu * mu) * (X + h);
    float c0 = sqrt(x0);
    return 2.0 * c0 * exp(X - x0) - c / (1.0 - c * mu) * exp(-h);
  }

  void scatter(vec3 ro, vec3 rd, float tMax, out vec3 inscat, out vec3 trans) {
    inscat = vec3(0.0);
    trans = vec3(1.0);
    if (uAtmoOn < 0.5) return;
    vec2 ta = raySphere(ro, rd, uAtmo);
    float t0 = max(ta.x, 0.0);
    float t1 = min(ta.y, tMax);
    if (t1 <= t0) return;
    const int N = 12;
    float ds = (t1 - t0) / float(N);
    float mu = dot(rd, uSunDir);
    float pr = 0.0596831 * (1.0 + mu * mu);
    float g2 = uG * uG;
    float pm = 0.0795775 * (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * uG * mu, 1e-4), 1.5);
    vec2 od = vec2(0.0);
    for (int i = 0; i < N; i++) {
      vec3 x = ro + rd * (t0 + (float(i) + 0.5) * ds);
      float r = length(x);
      float h = max(r - 1.0, 0.0);
      vec2 dens = exp(-vec2(h / uHR, h / uHM)) * ds;
      od += dens * 0.5;
      float muS = dot(x / r, uSunDir);
      vec2 ts = raySphere(x, uSunDir, 1.0);
      float lit = (ts.x > 0.0 && ts.y > 0.0) ? 0.0 : 1.0;
      vec2 odSun = vec2(uHR * chapman(1.0 / uHR, h / uHR, muS), uHM * chapman(1.0 / uHM, h / uHM, muS));
      vec3 tau = uBetaR * (od.x + odSun.x) + uBetaMExt * (od.y + odSun.y);
      inscat += exp(-tau) * (dens.x * uBetaR * pr + dens.y * uBetaM * pm) * lit;
      od += dens * 0.5;
    }
    trans = exp(-(uBetaR * od.x + uBetaMExt * od.y));
    inscat *= uSunI;
  }
`;

const SURFACE_VERT = /* glsl */ `
  varying vec3 vObj;
  varying vec3 vWorldN;
  varying vec3 vWorldPos;
  void main() {
    vObj = position;
    vWorldN = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const SURFACE_FRAG = /* glsl */ `
  uniform sampler2D uAlbedo;
  uniform sampler2D uClouds;
  uniform float uKind;        // 0 earth, 1 mars, 2 moon
  uniform float uDecode;      // 1 = baked (sqrt-encoded) albedo, 0 = sRGB texture
  uniform float uHasClouds;
  uniform float uCloudShift;
  uniform float uRadius;
  uniform float uDetail;
  uniform vec3 uNightTint;
  varying vec3 vObj;
  varying vec3 vWorldN;
  varying vec3 vWorldPos;
  ${GLSL_NOISE}
  ${'__ATMO__'}

  vec2 equirect(vec3 p) {
    return vec2(atan(p.x, p.z) / 6.2831853 + 0.5, asin(clamp(p.y, -1.0, 1.0)) / 3.1415927 + 0.5);
  }
  // Seam-safe sampling: use derivatives of a longitude that wraps elsewhere.
  vec4 sampleEq(sampler2D t, vec3 p, float shift) {
    vec2 uv = equirect(p);
    uv.x += shift;
    vec2 uv2 = vec2(fract(uv.x + 0.5) - 0.5, uv.y);
    vec2 dx = dFdx(uv), dy = dFdy(uv);
    vec2 dx2 = dFdx(uv2), dy2 = dFdy(uv2);
    if (dot(dx2, dx2) + dot(dy2, dy2) < dot(dx, dx) + dot(dy, dy)) { dx = dx2; dy = dy2; }
    return textureGrad(t, uv, dx, dy);
  }

  void main() {
    vec3 p = normalize(vObj);
    vec3 N = normalize(vWorldN);
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec4 a = sampleEq(uAlbedo, p, 0.0);
    vec3 albedo = uDecode > 0.5 ? a.rgb * a.rgb : a.rgb;

    // Relief (Mars / Moon): finite-difference normal from the height channel.
    if (uKind > 0.5 && uDecode > 0.5) {
      float e = 0.0007;
      vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), p) + 1e-5);
      vec3 north = cross(p, east);
      float h0 = a.a;
      float hx = sampleEq(uAlbedo, normalize(p + east * e), 0.0).a;
      float hy = sampleEq(uAlbedo, normalize(p + north * e), 0.0).a;
      vec3 bump = (east * (h0 - hx) + north * (h0 - hy)) * (uKind > 1.5 ? 22.0 : 14.0);
      N = normalize(N + mat3(modelMatrix) * bump);
    }
    // Close-range detail so low passes never look like a blurry photo.
    float det = fbm3(p * 900.0, 3) * 0.5 + 0.5;
    albedo *= mix(1.0, 0.82 + det * 0.36, uDetail);

    float ndl = dot(N, uSunDir);
    float lambert = max(ndl, 0.0);
    // Dusty / rough worlds are flatter than Lambert near the terminator (Oren–Nayar-ish).
    if (uKind > 0.5) lambert = mix(lambert, sqrt(max(ndl, 0.0)) * 0.9, 0.35);
    // uSunI is irradiance; a Lambert surface returns albedo·E/π.
    vec3 col = albedo * lambert * uSunI * 0.3183;

    float cloud = 0.0;
    if (uKind < 0.5) {
      float land = uDecode > 0.5 ? a.a : step(0.08, albedo.g - albedo.b * 0.7);
      vec4 cl = uHasClouds > 0.5 ? sampleEq(uClouds, p, uCloudShift) : vec4(0.0);
      cloud = cl.r;
      vec3 H = normalize(uSunDir + V);
      float glint = pow(max(dot(N, H), 0.0), 220.0) * 9.0 + pow(max(dot(N, H), 0.0), 18.0) * 0.08;
      col += vec3(1.0, 0.9, 0.75) * glint * (1.0 - land) * (1.0 - cloud) * step(0.0, ndl) * uSunI * 0.3183;
      vec3 cloudCol = vec3(0.98, 0.98, 1.0) * (max(ndl, 0.0) * 0.92 + 0.012) * uSunI * 0.3183;
      col = mix(col, cloudCol, cloud * 0.95);
      float night = 1.0 - smoothstep(-0.12, 0.06, ndl);
      col += uNightTint * cl.g * night * (1.0 - cloud * 0.85) * 0.9;
    }

    vec3 ro = uCamR;
    vec3 rd = -V;
    float tMax = length(vWorldPos - cameraPosition) / uRadius;
    vec3 ins, tr;
    scatter(ro, rd, tMax, ins, tr);
    col = col * tr + ins;
    gl_FragColor = vec4(col, 1.0);
  }
`;

const SHELL_VERT = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const SHELL_FRAG = /* glsl */ `
  varying vec3 vWorldPos;
  ${'__ATMO__'}
  void main() {
    vec3 rd = normalize(vWorldPos - cameraPosition);
    vec2 tp = raySphere(uCamR, rd, 1.0);
    float tMax = (tp.x > 0.0) ? tp.x : 1e9;
    vec3 ins, tr;
    scatter(uCamR, rd, tMax, ins, tr);
    gl_FragColor = vec4(ins, 1.0);
  }
`;

const _v = new Vector3();

export class Planet {
  /**
   * kind: 'earth' | 'mars' | 'moon'
   * opts: { renderer, assets, segments }
   */
  constructor(kind, { renderer, assets = null, segments = 256 } = {}) {
    this.kind = kind;
    const P = PLANET[kind];
    this.radius = P.radius;
    this.group = new Group();
    this.group.name = `planet_${kind}`;

    // Surface maps: BlendKit / NASA textures win; otherwise bake procedurally.
    let albedo = null;
    let clouds = null;
    let decode = 1;
    const tex = assets ? assets.texture(kind === 'earth' ? 'earth_day' : kind === 'mars' ? 'mars_albedo' : 'moon_albedo') : null;
    if (tex) {
      albedo = tex;
      decode = 0;
    } else {
      const src = kind === 'earth' ? EARTH_SURFACE_BAKE : kind === 'mars' ? MARS_BAKE : MOON_BAKE;
      this._rtA = bake(renderer, src, kind === 'moon' ? 1024 : 2048, kind === 'moon' ? 512 : 1024);
      albedo = this._rtA.texture;
    }
    if (kind === 'earth') {
      const ct = assets ? assets.texture('earth_clouds') : null;
      if (ct) clouds = ct;
      else {
        this._rtB = bake(renderer, EARTH_CLOUD_BAKE, 2048, 1024);
        clouds = this._rtB.texture;
      }
    }

    const atmoOn = kind !== 'moon';
    const uniforms = {
      uAlbedo: { value: albedo },
      uClouds: { value: clouds },
      uKind: { value: kind === 'earth' ? 0 : kind === 'mars' ? 1 : 2 },
      uDecode: { value: decode },
      uHasClouds: { value: clouds ? 1 : 0 },
      uCloudShift: { value: 0 },
      uRadius: { value: P.radius },
      uDetail: { value: 0 },
      uNightTint: { value: new Color(1.0, 0.62, 0.3) },
      uCamR: { value: new Vector3(0, 2, 0) },
      uSunDir: { value: new Vector3(1, 0, 0) },
      uSunI: { value: 4.0 },
      uAtmo: { value: P.atmo || 1.01 },
      uHR: { value: P.hR || 0.001 },
      uHM: { value: P.hM || 0.001 },
      uG: { value: P.g || 0.7 },
      uAtmoOn: { value: atmoOn ? 1 : 0 },
      uBetaR: { value: new Vector3(...(P.betaR || [0, 0, 0])) },
      uBetaM: { value: new Vector3(...(P.betaM || [0, 0, 0])) },
      uBetaMExt: { value: new Vector3(...(P.betaM || [0, 0, 0])).multiplyScalar(P.mieExt || 1) },
    };
    this.uniforms = uniforms;

    const surface = new Mesh(
      new SphereGeometry(P.radius, segments, segments / 2),
      new ShaderMaterial({
        uniforms,
        vertexShader: SURFACE_VERT,
        fragmentShader: SURFACE_FRAG.replace(`${'__ATMO__'}`, GLSL_ATMOSPHERE),
      })
    );
    surface.name = `${kind}_surface`;
    surface.frustumCulled = false;
    this.surface = surface;
    this.group.add(surface);

    if (atmoOn) {
      const shell = new Mesh(
        new SphereGeometry(P.radius * P.atmo, 128, 64),
        additive(
          new ShaderMaterial({
            uniforms,
            vertexShader: SHELL_VERT,
            fragmentShader: SHELL_FRAG.replace(`${'__ATMO__'}`, GLSL_ATMOSPHERE),
            side: BackSide,
          })
        )
      );
      shell.name = `${kind}_atmosphere`;
      shell.frustumCulled = false;
      shell.renderOrder = 2;
      this.shell = shell;
      this.group.add(shell);
    }
  }

  /** Planet centre in the far scene (metres) and its spin (radians about +Y). */
  place(center, spin = 0) {
    this.group.position.copy(center);
    this.group.rotation.set(0, spin, 0);
    this.group.updateMatrixWorld(true);
  }

  setSun(dirWorld, intensity = 4.0) {
    this.uniforms.uSunDir.value.copy(dirWorld).normalize();
    this.uniforms.uSunI.value = intensity;
  }

  /** Call each frame with the camera that renders the planet (precision lives here). */
  update(camera, t = 0) {
    camera.getWorldPosition(_v);
    _v.sub(this.group.position).divideScalar(this.radius);
    this.uniforms.uCamR.value.copy(_v);
    const alt = (_v.length() - 1) * this.radius;
    // Detail noise only matters below ~400 km.
    this.uniforms.uDetail.value = Math.max(0, Math.min(1, 1 - alt / 400e3));
    if (this.kind === 'earth') this.uniforms.uCloudShift.value = t * 0.00002;
  }

  /** Altitude of `camera` above the surface (metres). */
  altitude(camera) {
    camera.getWorldPosition(_v);
    return _v.distanceTo(this.group.position) - this.radius;
  }
}
