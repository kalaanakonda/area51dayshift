import { Color, DoubleSide, MeshStandardMaterial, Vector3, Vector4 } from 'three';
import { GLSL_HEX, GLSL_NOISE } from '../render/shaders/glsl.js';
import { grainNormal } from './textures.js';

/**
 * Starship skin — one shader for the whole vehicle family.
 *
 * Computed entirely in the fragment shader from object-space position, so it
 * holds up from 300 m away (Scene 1) to 30 cm away (walking the bridge):
 *
 *  • 30-series stainless: rolled-ring panels every 1.83 m, weld beads, vertical
 *    grain, panel-to-panel tone variation
 *  • hexagonal heat-shield tiles on the windward half — ragged hex edge where
 *    the tile field ends, per-tile tone/roughness/pillow tilt, dark gaps,
 *    occasional lighter replacement tiles
 *  • cryogenic frost bands (propellant loaded), engine soot (flight-proven
 *    booster), post-entry heat tint (straw → bronze → violet → blue oxide
 *    banding on the leeward steel) and red dust (landed on Mars)
 *
 * mode 'cylinder' : hull sections around the local +Y axis (tiles face +Z)
 * mode 'planar'   : flaps / fins — tiles on faces whose normal points along uTileDir
 */
export function createHullMaterial({
  mode = 'cylinder',
  radius = 4.5,
  tiles = true,
  tileTheta = 0,
  tileHalf = 1.62,
  tileSize = 0.36,
  frost = [0, 0, 0, 0],
  frostAmount = 0,
  heat = 0,
  soot = 0,
  dust = 0,
  baseY = 0,
  tileDir = new Vector3(0, 0, 1),
} = {}) {
  const mat = new MeshStandardMaterial({
    color: 0xffffff,
    metalness: 1,
    roughness: 0.3,
    envMapIntensity: 1.0,
  });
  const uniforms = {
    uRadius: { value: radius },
    uTilesOn: { value: tiles ? 1 : 0 },
    uTileTheta: { value: tileTheta },
    uTileHalf: { value: tileHalf },
    uTileSize: { value: tileSize },
    uFrost: { value: new Vector4(...frost) },
    uFrostAmt: { value: frostAmount },
    uHeat: { value: heat },
    uSoot: { value: soot },
    uDust: { value: dust },
    uBaseY: { value: baseY },
    uTileDir: { value: tileDir.clone() },
  };
  mat.userData.hull = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vObjPos;
         varying vec3 vObjNormal;
         varying vec3 vViewT;
         varying vec3 vViewB;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vObjPos = position;
         vObjNormal = normal;
         ${
           mode === 'cylinder'
             ? `vec3 objT = normalize(vec3(position.z, 0.0, -position.x) + vec3(1e-5, 0.0, 0.0));
                vec3 objB = vec3(0.0, 1.0, 0.0);`
             : `vec3 objT = vec3(1.0, 0.0, 0.0);
                vec3 objB = vec3(0.0, 1.0, 0.0);`
         }
         vViewT = normalize(mat3(modelViewMatrix) * objT);
         vViewB = normalize(mat3(modelViewMatrix) * objB);`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vObjPos;
         varying vec3 vObjNormal;
         varying vec3 vViewT;
         varying vec3 vViewB;
         uniform float uRadius, uTilesOn, uTileTheta, uTileHalf, uTileSize, uFrostAmt, uHeat, uSoot, uDust, uBaseY;
         uniform vec4 uFrost;
         uniform vec3 uTileDir;
         ${GLSL_NOISE}
         ${GLSL_HEX}
         vec3 hsAlbedo; float hsRough; float hsMetal; vec2 hsBump;

         void sampleHull(vec3 p) {
           ${
             mode === 'cylinder'
               ? `float theta = atan(p.x, p.z);
                  float s = theta * uRadius;
                  vec2 tuv = vec2(s, p.y) / uTileSize;
                  vec4 hc = hexCoords(tuv);
                  float cellTheta = hc.z * uTileSize / uRadius;
                  float dAng = abs(atan(sin(cellTheta - uTileTheta), cos(cellTheta - uTileTheta)));
                  float jag = (hash12(hc.zw) - 0.5) * 0.06;
                  float isTile = uTilesOn * step(dAng, uTileHalf + jag);
                  float edgeProx = 1.0 - smoothstep(0.0, 0.7, abs(dAng - uTileHalf));`
               : `float s = p.x;
                  vec2 tuv = p.xy / uTileSize;
                  vec4 hc = hexCoords(tuv);
                  float facing = dot(normalize(vObjNormal), uTileDir);
                  float isTile = uTilesOn * step(0.25, facing);
                  float edgeProx = 0.0;
                  float theta = 0.0;`
           }

           // ---- stainless steel ------------------------------------------------
           float ringH = 1.83;
           float ring = floor(p.y / ringH);
           float seg = floor((s + 100.0) / 3.1);
           float ringRand = hash12(vec2(ring, seg * 0.37));
           float streak = vnoise2(vec2(s * 5.0, p.y * 0.18)) * 0.6 + vnoise2(vec2(s * 21.0, p.y * 0.6)) * 0.4;
           vec3 steel = vec3(0.62, 0.625, 0.64) * (0.9 + ringRand * 0.12) * (0.93 + streak * 0.1);
           float rough = 0.2 + streak * 0.12 + ringRand * 0.07;
           float yr = fract(p.y / ringH);
           float dSeam = min(yr, 1.0 - yr) * ringH;
           float seam = 1.0 - smoothstep(0.0, 0.016, dSeam);
           float seamHalo = 1.0 - smoothstep(0.016, 0.09, dSeam);
           steel *= 1.0 - seam * 0.3;
           steel = mix(steel, steel * vec3(1.04, 0.98, 0.9), seamHalo * 0.6);
           rough += seam * 0.3 + seamHalo * 0.05;
           vec2 bump = vec2(0.0, (yr < 0.5 ? 1.0 : -1.0) * seam * 0.35);
           float vsPos = fract(s / 3.1);
           float vseam = 1.0 - smoothstep(0.0, 0.01, min(vsPos, 1.0 - vsPos) * 3.1);
           steel *= 1.0 - vseam * 0.2 * step(0.5, hash11(ring + 3.1));
           float metal = 1.0;

           // heat tint (oxide banding) — strongest near the tile edge, leeward side
           float hb = fbm2(vec2(s * 0.22, p.y * 0.07) + 3.0, 4);
           float heat = uHeat * smoothstep(0.25, 0.7, hb + edgeProx * 0.35);
           vec3 oxide = mix(vec3(0.95, 0.78, 0.48), vec3(0.62, 0.42, 0.5), smoothstep(0.35, 0.65, hb));
           oxide = mix(oxide, vec3(0.42, 0.5, 0.72), smoothstep(0.62, 0.85, hb));
           steel = mix(steel, steel * oxide * 1.15, heat);
           rough += heat * 0.08;

           // soot from engines / hot staging
           float sootMask = uSoot * (1.0 - smoothstep(uBaseY, uBaseY + 14.0, p.y)) * (0.55 + 0.45 * fbm2(vec2(s * 0.6, p.y * 0.25), 3));
           steel = mix(steel, vec3(0.05, 0.045, 0.04), clamp(sootMask, 0.0, 1.0));
           rough = mix(rough, 0.75, clamp(sootMask, 0.0, 1.0));
           metal = mix(metal, 0.3, clamp(sootMask, 0.0, 1.0));

           // ---- tiles ------------------------------------------------------------
           float hd = hexDist(hc.xy);
           float gap = smoothstep(0.445, 0.485, hd);
           float tr = hash12(hc.zw + 7.0);
           vec3 tileCol = vec3(0.022, 0.023, 0.025) * (0.75 + tr * 0.6);
           tileCol = mix(tileCol, vec3(0.06, 0.06, 0.064), step(0.94, tr));
           tileCol = mix(tileCol, vec3(0.42, 0.41, 0.39), step(0.997, tr) * (1.0 - uHeat));
           // post-entry: whitish deposits and scorched tiles
           tileCol = mix(tileCol, vec3(0.16, 0.15, 0.14), uHeat * smoothstep(0.55, 0.9, fbm2(hc.zw * 0.09, 3)) * 0.8);
           float tileRough = 0.5 + tr * 0.22;
           vec2 bevel = normalize(hc.xy + 1e-5) * smoothstep(0.34, 0.46, hd) * 0.7;
           vec2 tilt = (hash22(hc.zw) - 0.5) * 0.14;
           vec3 tAlb = mix(tileCol, vec3(0.008), gap);
           float tRough = mix(tileRough, 0.92, gap);

           hsAlbedo = mix(steel, tAlb, isTile);
           hsRough = mix(rough, tRough, isTile);
           hsMetal = mix(metal, 0.0, isTile);
           hsBump = mix(bump, bevel + tilt, isTile);

           // ---- frost (cryogenic propellant) --------------------------------------
           if (uFrostAmt > 0.001) {
             float b1 = smoothstep(uFrost.x - 0.6, uFrost.x + 0.6, p.y) * (1.0 - smoothstep(uFrost.y - 0.6, uFrost.y + 0.6, p.y));
             float b2 = smoothstep(uFrost.z - 0.6, uFrost.z + 0.6, p.y) * (1.0 - smoothstep(uFrost.w - 0.6, uFrost.w + 0.6, p.y));
             float band = max(b1, b2);
             float fn = fbm2(vec2(s * 0.9, p.y * 0.7), 5);
             float fr = clamp(band * uFrostAmt * smoothstep(0.32, 0.58, fn * 0.7 + band * 0.45), 0.0, 1.0);
             fr *= 1.0 - isTile * 0.75;
             vec3 frostCol = vec3(0.8, 0.84, 0.88) * (0.82 + 0.18 * vnoise2(vec2(s, p.y) * 9.0));
             hsAlbedo = mix(hsAlbedo, frostCol, fr);
             hsRough = mix(hsRough, 0.88, fr);
             hsMetal = mix(hsMetal, 0.0, fr);
             hsBump += (vec2(vnoise2(vec2(s, p.y) * 37.0), vnoise2(vec2(p.y, s) * 41.0)) - 0.5) * fr * 1.2;
           }

           // ---- Martian dust settling on the lower hull -----------------------------
           if (uDust > 0.001) {
             float dm = uDust * (1.0 - smoothstep(uBaseY, uBaseY + 9.0, p.y)) * (0.5 + 0.5 * fbm2(vec2(s * 0.8, p.y * 0.5), 3));
             dm = clamp(dm, 0.0, 1.0);
             hsAlbedo = mix(hsAlbedo, vec3(0.5, 0.31, 0.19), dm);
             hsRough = mix(hsRough, 0.95, dm);
             hsMetal = mix(hsMetal, 0.0, dm);
           }
         }`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         sampleHull(vObjPos);
         diffuseColor.rgb *= hsAlbedo;`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         roughnessFactor = clamp(hsRough, 0.04, 1.0);`
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
         metalnessFactor = hsMetal;`
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         normal = normalize(normal + (normalize(vViewT) * hsBump.x + normalize(vViewB) * hsBump.y) * 0.35);`
      );
  };
  mat.customProgramCacheKey = () => `hull-${mode}`;
  return mat;
}

// ---------------------------------------------------------------- simple palette

const _matCache = new Map();

/** Shared standard materials so the whole film uses a small number of programs. */
export function mat(name) {
  if (_matCache.has(name)) return _matCache.get(name);
  const m = MATS[name] ? MATS[name]() : new MeshStandardMaterial({ color: 0xff00ff });
  m.name = name;
  _matCache.set(name, m);
  return m;
}

const MATS = {
  towerSteel: () => new MeshStandardMaterial({ color: 0x3b3f44, metalness: 0.55, roughness: 0.62, normalMap: grainNormal(4, 30, 1.2) }),
  darkSteel: () => new MeshStandardMaterial({ color: 0x24272b, metalness: 0.7, roughness: 0.48 }),
  paintedGrey: () => new MeshStandardMaterial({ color: 0x8c9096, metalness: 0.15, roughness: 0.55 }),
  paintedWhite: () => new MeshStandardMaterial({ color: 0xdedcd6, metalness: 0.05, roughness: 0.5 }),
  insulation: () => new MeshStandardMaterial({ color: 0xc9c6bf, metalness: 0.0, roughness: 0.85 }),
  rubber: () => new MeshStandardMaterial({ color: 0x141414, metalness: 0.0, roughness: 0.9 }),
  concreteDark: () => new MeshStandardMaterial({ color: 0x55534f, metalness: 0, roughness: 0.92 }),
  engine: () =>
    new MeshStandardMaterial({ color: 0x5a4a3e, metalness: 0.92, roughness: 0.42, side: DoubleSide, envMapIntensity: 0.8 }),
  engineDark: () => new MeshStandardMaterial({ color: 0x2c2a28, metalness: 0.85, roughness: 0.5 }),
  glassDark: () => new MeshStandardMaterial({ color: 0x0b0d10, metalness: 0.2, roughness: 0.05, envMapIntensity: 1.4 }),
  hazard: () => new MeshStandardMaterial({ color: 0xd9a514, metalness: 0.1, roughness: 0.6 }),
  obstruction: () =>
    new MeshStandardMaterial({ color: 0x220000, emissive: new Color(1, 0.05, 0.02), emissiveIntensity: 6, toneMapped: true }),
  lampWarm: () => new MeshStandardMaterial({ color: 0x222222, emissive: new Color(1.0, 0.86, 0.66), emissiveIntensity: 12 }),
  lampCool: () => new MeshStandardMaterial({ color: 0x222222, emissive: new Color(0.86, 0.92, 1.0), emissiveIntensity: 14 }),
  windowWarm: () => new MeshStandardMaterial({ color: 0x111111, emissive: new Color(1.0, 0.78, 0.5), emissiveIntensity: 2.2, roughness: 0.2 }),
};
