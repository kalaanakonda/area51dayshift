import { BackSide, Color, Mesh, Scene, ShaderMaterial, SphereGeometry, Vector3 } from 'three';
import { GLSL_AT_INFINITY, GLSL_NOISE } from '../render/shaders/glsl.js';

/**
 * Sky domes. Each renders "at infinity" (never clipped, never occludes) and
 * writes ALPHA = 0 so the light-shaft pass knows these pixels are sky.
 * The same material is reused in a tiny scene to bake a PMREM environment, so
 * the stainless hull reflects exactly the sky you see.
 */

const DOME_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    ${GLSL_AT_INFINITY}
  }
`;

function dome(material) {
  const mesh = new Mesh(new SphereGeometry(1, 64, 32), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.onBeforeRender = (renderer, scene, camera) => {
    mesh.position.copy(camera.position);
    mesh.updateMatrixWorld();
  };
  return mesh;
}

function envSceneFor(material) {
  const s = new Scene();
  const m = new Mesh(new SphereGeometry(1, 48, 24), material);
  s.add(m);
  return s;
}

/**
 * Gulf-coast blue hour → sunrise. Physically-flavoured, hand-tuned:
 * Rayleigh gradient, warm forward-scatter glow on the solar azimuth, Earth's
 * shadow + Belt of Venus on the anti-solar horizon, a stratocumulus deck lit
 * from below, and Mars as a pale red point in the west.
 */
export function createDawnSky() {
  const uniforms = {
    uSunDir: { value: new Vector3(1, -0.04, -0.15).normalize() },
    uMarsDir: { value: new Vector3(-0.85, 0.24, 0.45).normalize() },
    uTime: { value: 0 },
    uZenith: { value: new Color(0.012, 0.026, 0.07) },
    uMid: { value: new Color(0.045, 0.08, 0.17) },
    uHorizon: { value: new Color(0.2, 0.2, 0.26) },
    uGlow: { value: new Color(1.15, 0.5, 0.2) },
    uAnti: { value: new Color(0.3, 0.16, 0.2) },
    uShadow: { value: new Color(0.035, 0.05, 0.1) },
    uCloudCover: { value: 0.46 },
    uBrightness: { value: 1 },
    uSunDisc: { value: 0 },
  };
  const material = new ShaderMaterial({
    uniforms,
    vertexShader: DOME_VERT,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir, uMarsDir, uZenith, uMid, uHorizon, uGlow, uAnti, uShadow;
      uniform float uTime, uCloudCover, uBrightness, uSunDisc;
      varying vec3 vDir;
      ${GLSL_NOISE}
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        float hp = max(h, 0.0);
        float cosSun = dot(d, uSunDir);
        vec2 dh = normalize(d.xz + 1e-5);
        vec2 sh = normalize(uSunDir.xz + 1e-5);
        float az = dot(dh, sh);

        vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.22, hp));
        col = mix(col, uZenith, smoothstep(0.18, 0.85, hp));

        float sunElev = uSunDir.y;
        float glowAmt = pow(max(az * 0.5 + 0.5, 0.0), 4.0);
        col += uGlow * glowAmt * exp(-hp * (7.0 - sunElev * 20.0)) * 0.9;
        col += uGlow * 0.6 * pow(max(cosSun, 0.0), 10.0);
        col += vec3(1.0, 0.82, 0.62) * 3.0 * pow(max(cosSun, 0.0), 220.0);

        float anti = pow(max(-az * 0.5 + 0.5, 0.0), 2.0);
        col = mix(col, uShadow, anti * (1.0 - smoothstep(0.0, 0.07, hp)) * 0.75);
        col += uAnti * anti * exp(-pow((hp - 0.11) / 0.07, 2.0)) * 0.6;

        // Sun disc (only above the horizon)
        col += vec3(1.0, 0.86, 0.66) * smoothstep(0.99955, 0.99975, cosSun) * 60.0 * uSunDisc * smoothstep(-0.01, 0.005, h);

        // Mars: a small warm point low in the west
        float md = dot(d, uMarsDir);
        col += vec3(1.0, 0.42, 0.22) * (smoothstep(0.999994, 0.999999, md) * 14.0 + pow(max(md, 0.0), 30000.0) * 0.6);

        // Cloud deck, projected on a plane; lit from below/behind on the sun side.
        if (h > -0.02) {
          vec2 cuv = d.xz / (h + 0.08) * 0.9 + vec2(uTime * 0.0012, uTime * 0.0004);
          float c = fbm2(cuv * 1.4, 6);
          float cov = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.22, c);
          float thick = smoothstep(0.5, 0.9, c);
          float lit = glowAmt * exp(-hp * 3.0) + pow(max(cosSun, 0.0), 6.0) * 0.8;
          vec3 base = mix(uMid * 0.55, uHorizon * 0.7, smoothstep(0.3, 0.0, hp));
          vec3 cloud = mix(base, uGlow * 1.25 + vec3(0.12, 0.08, 0.1), clamp(lit, 0.0, 1.0) * (1.0 - thick * 0.6));
          cloud += uGlow * 0.6 * pow(1.0 - thick, 3.0) * lit; // silver lining
          col = mix(col, cloud, cov * smoothstep(-0.02, 0.06, h) * 0.9);
        }

        // Below horizon: the dark sea/land haze (geometry normally covers this).
        col = mix(col, uHorizon * 0.35, smoothstep(0.0, -0.12, h));
        gl_FragColor = vec4(col * uBrightness, 0.0);
      }
    `,
    side: BackSide,
    depthWrite: false,
    depthTest: false,
  });
  return { mesh: dome(material), material, uniforms, envScene: envSceneFor(material) };
}

/**
 * Mars daytime sky: butterscotch dust scattering, darker brown zenith, and the
 * real Martian quirk — a cold BLUE halo around a smaller sun (forward
 * scattering by fine dust), which also makes Martian sunsets blue.
 */
export function createMarsSky() {
  const uniforms = {
    uSunDir: { value: new Vector3(0.6, 0.32, -0.5).normalize() },
    uZenith: { value: new Color(0.24, 0.15, 0.1) },
    uHorizon: { value: new Color(0.78, 0.55, 0.36) },
    uHalo: { value: new Color(0.55, 0.66, 0.85) },
    uGround: { value: new Color(0.33, 0.2, 0.12) },
    uBrightness: { value: 1 },
    uTime: { value: 0 },
  };
  const material = new ShaderMaterial({
    uniforms,
    vertexShader: DOME_VERT,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir, uZenith, uHorizon, uHalo, uGround;
      uniform float uBrightness, uTime;
      varying vec3 vDir;
      ${GLSL_NOISE}
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        float hp = max(h, 0.0);
        float cs = dot(d, uSunDir);
        vec3 col = mix(uHorizon, uZenith, pow(smoothstep(0.0, 1.0, hp), 0.55));
        col += uHorizon * 0.35 * exp(-hp * 14.0);
        // forward-scatter: broad warm glow + tight blue-white aureole
        col += uHorizon * 0.45 * pow(max(cs, 0.0), 4.0);
        col += uHalo * 1.1 * pow(max(cs, 0.0), 48.0);
        col += vec3(1.0, 0.97, 0.92) * 2.2 * pow(max(cs, 0.0), 900.0);
        col += vec3(1.0, 0.96, 0.9) * smoothstep(0.99985, 0.99992, cs) * 40.0;
        // faint high dust streaks
        if (h > 0.0) {
          vec2 uv = d.xz / (h + 0.15);
          float n = fbm2(uv * 0.8 + uTime * 0.001, 5);
          col *= 1.0 + (n - 0.5) * 0.08 * (1.0 - hp);
        }
        col = mix(col, uGround, smoothstep(0.0, -0.08, h));
        gl_FragColor = vec4(col * uBrightness, 0.0);
      }
    `,
    side: BackSide,
    depthWrite: false,
    depthTest: false,
  });
  return { mesh: dome(material), material, uniforms, envScene: envSceneFor(material) };
}

/**
 * Deep space. Exposure-honest: when the sun or a lit planet is in frame the
 * stars sink below the threshold of the "film" (uStars → 0), like real photos.
 */
export function createSpaceSky() {
  const uniforms = {
    uSunDir: { value: new Vector3(1, 0.1, 0.2).normalize() },
    uStars: { value: 1 },
    uSun: { value: 1 },
    uSunSize: { value: 1 },
  };
  const material = new ShaderMaterial({
    uniforms,
    vertexShader: DOME_VERT,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      uniform float uStars, uSun, uSunSize;
      varying vec3 vDir;
      ${GLSL_NOISE}
      vec3 starLayer(vec3 d, float cells, float thresh, float seed) {
        vec3 a = abs(d);
        vec2 uv; float face;
        if (a.x > a.y && a.x > a.z) { uv = d.yz / a.x; face = sign(d.x); }
        else if (a.y > a.z) { uv = d.xz / a.y; face = 2.0 + sign(d.y); }
        else { uv = d.xy / a.z; face = 4.0 + sign(d.z); }
        vec2 g = uv * cells;
        vec2 id = floor(g);
        vec2 f = fract(g);
        float h = hash12(id + face * 131.7 + seed);
        if (h < thresh) return vec3(0.0);
        vec2 p = hash22(id + seed + face) * 0.7 + 0.15;
        float dist = length(f - p);
        float b = pow((h - thresh) / (1.0 - thresh), 3.0);
        float core = smoothstep(0.16, 0.0, dist);
        vec3 tint = mix(vec3(1.0, 0.82, 0.68), vec3(0.75, 0.85, 1.0), hash12(id * 1.7 + seed));
        return tint * core * (0.3 + b * 8.0);
      }
      void main() {
        vec3 d = normalize(vDir);
        vec3 col = vec3(0.0);
        col += starLayer(d, 180.0, 0.985, 1.0);
        col += starLayer(d, 420.0, 0.992, 7.0) * 0.6;
        // Milky Way: a faint band along a tilted great circle
        vec3 galN = normalize(vec3(0.2, 0.9, 0.38));
        float band = exp(-pow(dot(d, galN) / 0.17, 2.0));
        float dust = fbm3(d * 6.0, 5);
        col += vec3(0.06, 0.055, 0.05) * band * smoothstep(-0.2, 0.6, dust) * 0.5;
        col *= uStars;
        float cs = dot(d, uSunDir);
        float disc = smoothstep(0.99996 - 0.00004 * uSunSize, 0.99999 - 0.00002 * uSunSize, cs);
        col += vec3(1.0, 0.97, 0.93) * (disc * 120.0 + pow(max(cs, 0.0), 2400.0) * 6.0 + pow(max(cs, 0.0), 120.0) * 0.08) * uSun;
        gl_FragColor = vec4(col, 0.0);
      }
    `,
    side: BackSide,
    depthWrite: false,
    depthTest: false,
  });
  return { mesh: dome(material), material, uniforms, envScene: envSceneFor(material) };
}

/** Bake a sky material into a PMREM environment texture. */
export function bakeEnvironment(pmrem, envScene) {
  return pmrem.fromScene(envScene, 0, 0.1, 100).texture;
}
