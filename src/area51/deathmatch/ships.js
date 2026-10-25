import {
  BoxGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Euler,
  ExtrudeGeometry,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  RepeatWrapping,
  RingGeometry,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
  Vector4,
  Float32BufferAttribute,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hullTextures, paintedSteelTextures } from '../textures.js';

/**
 * The deathmatch fleet: six craft out of the UFO literature, each with its
 * own hull, lights and laser.
 *
 *   disc      the classic saucer (an ARV-3 cousin)        cyan beam
 *   orb       the 1561 Nuremberg globes — red, black,     red pulse train
 *             blue and white spheres
 *   tictac    the 2004 Nimitz "Tic Tac"                   violet twin beams
 *   triangle  the black triangle (Phoenix, Belgium)       amber triple beam
 *   cigar     the cylinder / "mothership" of the 1561      green heavy beam
 *             woodcut, slow and tough
 *   cross     the woodcut's crosses, ringed               magenta helix
 *
 * Every style is drawn as a handful of InstancedMeshes (hull, trim, lights,
 * accent lights) sharing one matrix buffer and one per-instance state
 * (burn, hit flash, light level, teleport materialise). Local frame: +Y up,
 * −Z is the nose; each hull is centred on its hit sphere.
 */

export const STYLES = [
  {
    id: 'disc',
    name: 'Disc',
    hp: 120,
    radius: 6.4,
    speed: 205,
    accel: 1.5,
    turn: 2.4,
    laser: { color: [0.45, 0.95, 1.6], width: 2.2, pattern: 0 },
    loadout: ['laser', 'missile', 'cannon'],
    muzzles: [[-1.8, 0.0, -5.7], [1.8, 0.0, -5.7]],
    pods: [[-3.6, -0.5, -1.5], [3.6, -0.5, -1.5]],
    light: [0.55, 0.95, 1.2],
    lightGain: 3.5,
  },
  {
    id: 'orb',
    name: 'Orb',
    hp: 80,
    radius: 3.4,
    speed: 245,
    accel: 2.1,
    turn: 3.2,
    laser: { color: [1.8, 0.22, 0.12], width: 2.0, pattern: 1 },
    loadout: ['laser', 'arc', 'plasma'],
    muzzles: [[0, 0, -3.2]],
    pods: [[-2.4, -1.4, 0], [2.4, -1.4, 0]],
    light: [1.0, 0.25, 0.15],
    lightGain: 3.2,
  },
  {
    id: 'tictac',
    name: 'Tic Tac',
    hp: 100,
    radius: 6.2,
    speed: 280,
    accel: 2.5,
    turn: 2.8,
    laser: { color: [1.1, 0.7, 1.8], width: 1.7, pattern: 0 },
    twin: true,
    loadout: ['plasma', 'laser', 'cannon'],
    muzzles: [[-1.1, 0.0, -5.9], [1.1, 0.0, -5.9]],
    pods: [[-2.0, -1.2, -1], [2.0, -1.2, -1]],
    light: [1.0, 0.9, 1.25],
    lightGain: 1.3,
  },
  {
    id: 'triangle',
    name: 'Triangle',
    hp: 150,
    radius: 11,
    speed: 190,
    accel: 1.15,
    turn: 1.7,
    laser: { color: [1.9, 0.75, 0.16], width: 2.0, pattern: 0 },
    triple: true,
    loadout: ['missile', 'cannon', 'laser'],
    muzzles: [[0, -0.5, -10.6], [-9.2, -0.5, 5.3], [9.2, -0.5, 5.3]],
    pods: [[-4.5, -0.8, 1], [4.5, -0.8, 1]],
    light: [1.0, 1.0, 0.95],
    lightGain: 4,
  },
  {
    id: 'cigar',
    name: 'Cylinder',
    hp: 230,
    radius: 16,
    speed: 150,
    accel: 0.85,
    turn: 1.1,
    laser: { color: [0.4, 1.8, 0.45], width: 3.4, pattern: 0 },
    loadout: ['missile', 'cannon', 'fire'],
    muzzles: [[0, 0, -15.8]],
    pods: [[-3.4, 0.6, -7], [3.4, 0.6, -7], [-3.4, 0.6, 5], [3.4, 0.6, 5]],
    light: [1.0, 0.68, 0.32],
    lightGain: 3.2,
  },
  {
    id: 'cross',
    name: 'Cross',
    hp: 110,
    radius: 7.4,
    speed: 230,
    accel: 1.9,
    turn: 2.5,
    laser: { color: [1.7, 0.3, 1.5], width: 2.3, pattern: 2 },
    loadout: ['arc', 'fire', 'laser'],
    muzzles: [[0, 0, -7.4]],
    pods: [[-7.4, 0, 0], [7.4, 0, 0]],
    light: [1.0, 0.25, 0.85],
    lightGain: 3.2,
  },
];

/** The player's ARV-3 (the full Saucer model with its cockpit). */
export const ARV = {
  id: 'arv',
  name: 'ARV-3',
  hp: 170,
  radius: 6.3,
  laser: { color: [0.55, 1.0, 1.7], width: 2.4, pattern: 0 },
  // saucer-local (belly origin): front rim, either side of the nose
  muzzles: [[-1.7, 1.15, -6.25], [1.7, 1.15, -6.25]],
  pods: [[-4.4, 0.55, -2.2], [4.4, 0.55, -2.2]],
  center: [0, 1.4, 0],
};

/** Paint and light variants per style: [paint rgb, light rgb or null]. */
const VARIANTS = {
  disc: [[[0.8, 0.82, 0.85], null], [[0.62, 0.64, 0.68], null], [[0.34, 0.36, 0.4], [0.5, 1.0, 0.75]]],
  // the 1561 globes: black, white, red, blue
  orb: [[[0.035, 0.035, 0.04], [1.0, 0.45, 0.12]], [[0.85, 0.86, 0.88], [0.7, 0.85, 1.2]], [[0.55, 0.06, 0.045], [1.0, 0.22, 0.12]], [[0.07, 0.13, 0.42], [0.35, 0.75, 1.2]]],
  tictac: [[[0.8, 0.8, 0.78], null], [[0.72, 0.73, 0.74], null]],
  triangle: [[[0.055, 0.06, 0.065], null], [[0.12, 0.125, 0.13], null]],
  cigar: [[[0.72, 0.73, 0.75], null], [[0.6, 0.5, 0.38], null], [[0.42, 0.43, 0.45], [0.6, 0.9, 1.1]]],
  cross: [[[0.55, 0.4, 0.24], null], [[0.3, 0.3, 0.32], [0.5, 0.8, 1.2]]],
};

export const SHIP_UNIFORMS = {
  uDmTime: { value: 0 },
  uDmTele: { value: new Color(0.6, 0.85, 1.0) },
};

// --------------------------------------------------------------- materials

const DM_COMMON = /* glsl */ `
  varying vec4 vDmShip;
  varying vec3 vDmObj;
  uniform float uDmTime;
  uniform vec3 uDmTele;
  float dmHash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float dmNoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(dmHash(i), dmHash(i + vec3(1.0, 0.0, 0.0)), f.x), mix(dmHash(i + vec3(0.0, 1.0, 0.0)), dmHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
               mix(mix(dmHash(i + vec3(0.0, 0.0, 1.0)), dmHash(i + vec3(1.0, 0.0, 1.0)), f.x), mix(dmHash(i + vec3(0.0, 1.0, 1.0)), dmHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
  }
`;

// teleport: the hull fills in out of a noise field behind a bright seam
const DM_DISSOLVE = /* glsl */ `
  float dmEdge = 0.0;
  if (vDmShip.w < 0.999) {
    float dn = dmNoise(vDmObj * 0.55 + 7.0) * 0.75 + dmNoise(vDmObj * 2.3) * 0.25;
    if (dn > vDmShip.w) discard;
    dmEdge = 1.0 - smoothstep(0.0, 0.09, vDmShip.w - dn);
  }
`;

/**
 * Patch a three.js material with the deathmatch ship state: burn (charring,
 * embers when fully burnt), hit flash, light level and the teleport dissolve.
 * mode 'hull' (Standard/Physical) or 'light' (Basic). instanced: read the
 * state from the per-instance `aShip` attribute; otherwise from
 * material.userData.dmShip (a { value: Vector4 } uniform). Chains whatever
 * onBeforeCompile is already there (aerial perspective, …).
 */
export function patchShipMaterial(material, mode = 'hull', { instanced = true, lightGlow = true } = {}) {
  if (material.userData.dmPatched) return material;
  material.userData.dmPatched = true;
  if (!instanced && !material.userData.dmShip) material.userData.dmShip = { value: new Vector4(0, 0, 1, 1) };
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey ? material.customProgramCacheKey.call(material) : '';
  material.onBeforeCompile = function (shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    shader.uniforms.uDmTime = SHIP_UNIFORMS.uDmTime;
    shader.uniforms.uDmTele = SHIP_UNIFORMS.uDmTele;
    if (!instanced) shader.uniforms.uDmShip = material.userData.dmShip;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${instanced ? 'attribute vec4 aShip;' : 'uniform vec4 uDmShip;'}\nvarying vec4 vDmShip;\nvarying vec3 vDmObj;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvDmShip = ${instanced ? 'aShip' : 'uDmShip'};\nvDmObj = position;`);
    let f = shader.fragmentShader.replace('#include <common>', `#include <common>\n${DM_COMMON}`);
    if (mode === 'hull') {
      f = f
        .replace(
          '#include <map_fragment>',
          /* glsl */ `#include <map_fragment>
          ${DM_DISSOLVE}
          float dmN = dmNoise(vDmObj * 0.8) * 0.65 + dmNoise(vDmObj * 2.7 + 11.0) * 0.35;
          float dmBurn = clamp(vDmShip.x * (0.7 + 0.6 * dmN), 0.0, 1.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03, 0.026, 0.022) * (0.45 + dmN), dmBurn);`
        )
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.9, dmBurn);')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.08, dmBurn);')
        .replace(
          '#include <emissivemap_fragment>',
          /* glsl */ `#include <emissivemap_fragment>
          totalEmissiveRadiance += vec3(1.0, 0.95, 0.9) * vDmShip.y * 2.5;
          float dmEmber = smoothstep(0.6, 0.95, dmN + 0.18 * sin(uDmTime * 6.0 + vDmObj.x * 1.7 + vDmObj.z)) * smoothstep(0.85, 1.0, vDmShip.x);
          totalEmissiveRadiance += vec3(4.0, 1.1, 0.22) * dmEmber;
          totalEmissiveRadiance += uDmTele * dmEdge * 8.0;`
        );
    } else {
      f = f.replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        ${DM_DISSOLVE}
        diffuseColor.rgb *= ${lightGlow ? 'vDmShip.z' : '1.0'} * (1.0 - smoothstep(0.3, 0.8, vDmShip.x));
        diffuseColor.rgb += vec3(1.0) * vDmShip.y * 0.6 + uDmTele * dmEdge * 6.0;`
      );
    }
    shader.fragmentShader = f;
  };
  material.customProgramCacheKey = () => `dm${mode}${instanced ? 'I' : 'U'}${lightGlow ? 'g' : ''}|${prevKey}`;
  material.needsUpdate = true;
  return material;
}

function styleMaterials(id) {
  const hull = hullTextures();
  const steel = paintedSteelTextures();
  const tiled = (tex, r) => {
    const t = tex.clone();
    t.wrapS = t.wrapT = RepeatWrapping;
    t.repeat.set(r, r);
    t.needsUpdate = true;
    return t;
  };
  const std = (o) => new MeshStandardMaterial({ color: 0xffffff, ...o });
  let hullMat;
  let trimMat;
  switch (id) {
    case 'disc':
      hullMat = std({ metalness: 1, roughness: 1, map: hull.map, roughnessMap: hull.roughnessMap, normalMap: hull.normalMap, normalScale: new Vector2(0.6, 0.6) });
      trimMat = std({ color: 0x0b0d10, metalness: 0.3, roughness: 0.07 });
      break;
    case 'orb':
      hullMat = std({ metalness: 0.75, roughness: 0.16, normalMap: steel.normalMap, normalScale: new Vector2(0.15, 0.15) });
      trimMat = std({ color: 0x1a1c1f, metalness: 0.9, roughness: 0.3 });
      break;
    case 'tictac':
      hullMat = std({ metalness: 0.05, roughness: 0.3 });
      trimMat = std({ color: 0xd8d8d6, metalness: 0.1, roughness: 0.4 });
      break;
    case 'triangle':
      hullMat = std({ metalness: 0.6, roughness: 0.42, normalMap: tiled(steel.normalMap, 0.12), roughnessMap: tiled(steel.roughnessMap, 0.12), normalScale: new Vector2(0.5, 0.5) });
      trimMat = std({ color: 0x050607, metalness: 0.4, roughness: 0.12 });
      break;
    case 'cigar':
      hullMat = std({ metalness: 1, roughness: 1, map: hull.map, roughnessMap: hull.roughnessMap, normalMap: hull.normalMap, normalScale: new Vector2(0.5, 0.5) });
      trimMat = std({ color: 0x2a2c30, metalness: 0.85, roughness: 0.35 });
      break;
    default:
      hullMat = std({ metalness: 1, roughness: 0.3, normalMap: tiled(steel.normalMap, 2), normalScale: new Vector2(0.4, 0.4) });
      trimMat = std({ color: 0x3a2a1a, metalness: 1, roughness: 0.28 });
  }
  hullMat.name = `dm_${id}_hull`;
  trimMat.name = `dm_${id}_trim`;
  const lightMat = new MeshBasicMaterial({ color: 0xffffff, name: `dm_${id}_lights` });
  const accentMat = new MeshBasicMaterial({ color: new Color(4, 0.32, 0.22), name: `dm_${id}_accent` });
  patchShipMaterial(hullMat, 'hull');
  patchShipMaterial(trimMat, 'hull');
  patchShipMaterial(lightMat, 'light');
  patchShipMaterial(accentMat, 'light');
  return { hull: hullMat, trim: trimMat, lights: lightMat, accent: accentMat };
}

// --------------------------------------------------------------- geometry

const _e = new Euler();
const _q = new Quaternion();
const _v = new Vector3();
const _s = new Vector3();

function M(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  return new Matrix4().compose(_v.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
}

/** Non-indexed position/normal/uv only, so any parts can be merged. */
function prep(g, m) {
  if (m) g.applyMatrix4(m);
  let q = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(q.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') q.deleteAttribute(k);
  if (!q.attributes.uv) q.setAttribute('uv', new Float32BufferAttribute(new Float32Array(q.attributes.position.count * 2), 2));
  if (!q.attributes.normal) q.computeVertexNormals();
  return q;
}

function merge(parts) {
  if (!parts.length) return null;
  return mergeGeometries(parts.map(([g, m]) => prep(g, m)), false);
}

const lathe = (pts, seg) => new LatheGeometry(pts.map(([r, y]) => new Vector2(r, y)), seg);

const DISC_LOWER = [[0, 0], [0.9, 0], [1.6, 0.06], [2.6, 0.1], [3.6, 0.26], [4.6, 0.46], [5.4, 0.68], [6.0, 0.88], [6.35, 1.04], [6.5, 1.16]];
const DISC_UPPER = [[6.5, 1.16], [6.48, 1.26], [6.36, 1.34], [6.0, 1.46], [5.2, 1.7], [4.3, 1.95], [3.4, 2.2], [2.95, 2.33], [2.86, 2.4], [2.78, 2.42]];

function buildGeometry(id) {
  const hull = [];
  const trim = [];
  const lights = [];
  const accent = [];
  switch (id) {
    case 'disc': {
      const k = 0.92;
      const c = M(0, -1.15 * k, 0, 0, 0, 0, k);
      hull.push([lathe(DISC_LOWER, 48), c], [lathe(DISC_UPPER, 48), c]);
      const dome = new SphereGeometry(3.428, 32, 10, 0, Math.PI * 2, 0, Math.asin(2.8 / 3.428));
      trim.push([dome, M(0, (0.4216 - 1.15) * k, 0, 0, 0, 0, k)]);
      trim.push([new CylinderGeometry(0.95, 0.95, 0.06, 24), M(0, -1.15 * k, 0, 0, 0, 0, k)]);
      lights.push([new CylinderGeometry(6.505, 6.505, 0.08, 64, 1, true), M(0, (1.2 - 1.15) * k, 0, 0, 0, 0, k)]);
      lights.push([new RingGeometry(2.22, 2.58, 48, 1), M(0, (0.075 - 1.15) * k - 0.01, 0, Math.PI / 2, 0, 0, k)]);
      accent.push([new SphereGeometry(0.09, 8, 6), M(-6.5 * k, 0.06, 0)], [new SphereGeometry(0.09, 8, 6), M(6.5 * k, 0.06, 0)]);
      break;
    }
    case 'orb': {
      hull.push([new SphereGeometry(3, 36, 22)]);
      trim.push([new TorusGeometry(3.0, 0.24, 10, 56), M(0, 0, 0, Math.PI / 2)]);
      trim.push([new TorusGeometry(1.1, 0.12, 8, 24), M(0, 2.78, 0, Math.PI / 2)]);
      lights.push([new TorusGeometry(3.25, 0.065, 6, 72), M(0, 0, 0, Math.PI / 2)]);
      lights.push([new SphereGeometry(0.55, 16, 12), M(0, 0, -2.78)]);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        lights.push([new SphereGeometry(0.22, 10, 8), M(Math.sin(a) * 2.6, -1.45, Math.cos(a) * 2.6)]);
      }
      break;
    }
    case 'tictac': {
      hull.push([new CapsuleGeometry(2.4, 7.2, 10, 28), M(0, 0, 0, Math.PI / 2)]);
      // the two stubby appendages the Nimitz pilots described
      trim.push([new CapsuleGeometry(0.32, 1.0, 4, 10), M(0, -2.55, -1.6)], [new CapsuleGeometry(0.32, 1.0, 4, 10), M(0, -2.55, 1.6)]);
      lights.push([new BoxGeometry(0.16, 0.05, 6.6), M(0, -2.42, 0)]);
      break;
    }
    case 'triangle': {
      const s = new Shape();
      s.moveTo(0, 12.2);
      s.lineTo(-10.6, -6.1);
      s.lineTo(10.6, -6.1);
      s.closePath();
      const slab = new ExtrudeGeometry(s, { depth: 0.8, bevelEnabled: true, bevelThickness: 0.45, bevelSize: 0.75, bevelSegments: 2, curveSegments: 2 });
      hull.push([slab, new Matrix4().makeTranslation(0, -0.4, 0).multiply(M(0, 0, 0, -Math.PI / 2))]);
      trim.push([new SphereGeometry(3.4, 28, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), M(0, -0.85, 0.6, 0, 0, 0, 1, 0.38, 1)]);
      trim.push([new SphereGeometry(2.2, 24, 6, 0, Math.PI * 2, 0, Math.PI / 2), M(0, 0.85, 1.6, 0, 0, 0, 1, 0.34, 1)]);
      for (const [x, z] of [[0, -10.4], [-9.0, 5.2], [9.0, 5.2]]) lights.push([new SphereGeometry(0.72, 14, 10), M(x, -0.75, z)]);
      accent.push([new SphereGeometry(0.85, 14, 10), M(0, -2.0, 0.6)]);
      break;
    }
    case 'cigar': {
      hull.push([new CapsuleGeometry(3.2, 25, 10, 32), M(0, 0, 0, Math.PI / 2)]);
      for (const z of [-10, -5, 0, 5, 10]) trim.push([new TorusGeometry(3.24, 0.16, 8, 48), M(0, 0, z)]);
      trim.push([new BoxGeometry(1.4, 1.5, 5), M(0, 3.5, 2)]);
      trim.push([new BoxGeometry(0.25, 3.0, 3.6), M(0, 2.4, 13.2)], [new BoxGeometry(9.0, 0.22, 2.8), M(0, 0, 13.6)]);
      for (let z = -11; z <= 11.01; z += 2.2) {
        lights.push([new BoxGeometry(0.12, 0.32, 0.55), M(-3.18, 0.5, z)], [new BoxGeometry(0.12, 0.32, 0.55), M(3.18, 0.5, z)]);
      }
      lights.push([new TorusGeometry(2.0, 0.3, 8, 36), M(0, 0, 15.3)]);
      break;
    }
    default: {
      // cross: a sphere, four tapered arms, a ring through them, glowing tips
      hull.push([new SphereGeometry(2.3, 28, 18)]);
      for (let k = 0; k < 4; k++) {
        const arm = new CylinderGeometry(0.55, 1.0, 5.2, 14);
        hull.push([arm, M(0, 0, 0, 0, (k * Math.PI) / 2).multiply(M(0, 0, 4.6, Math.PI / 2))]);
        lights.push([new SphereGeometry(0.85, 16, 12), M(0, 0, 0, 0, (k * Math.PI) / 2).multiply(M(0, 0, 7.4))]);
      }
      trim.push([new TorusGeometry(4.6, 0.28, 8, 72), M(0, 0, 0, Math.PI / 2)]);
      lights.push([new TorusGeometry(2.33, 0.09, 6, 56), M(0, 0, 0, Math.PI / 2)]);
    }
  }
  return { hull: merge(hull), trim: merge(trim), lights: merge(lights), accent: merge(accent) };
}

const _m = new Matrix4();
const _zero = new Matrix4().makeScale(0, 0, 0);
const _c = new Color();

/**
 * Fleet — the instanced bodies for every bot, slot by slot.
 * counts[i] = how many of STYLES[i].
 */
export class Fleet {
  constructor(counts) {
    this.group = new Group();
    this.group.name = 'dm:fleet';
    this.kinds = STYLES.map((st, i) => (counts[i] ? this._build(st, counts[i]) : null));
  }

  _build(st, count) {
    const geo = buildGeometry(st.id);
    const mats = styleMaterials(st.id);
    const matrix = new InstancedBufferAttribute(new Float32Array(count * 16), 16);
    matrix.setUsage(DynamicDrawUsage);
    const state = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
    state.setUsage(DynamicDrawUsage);
    const paint = new InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3);
    const glow = new InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3);
    const meshes = [];
    for (const part of ['hull', 'trim', 'lights', 'accent']) {
      const g = geo[part];
      if (!g) continue;
      g.setAttribute('aShip', state);
      const mesh = new InstancedMesh(g, mats[part], count);
      mesh.instanceMatrix = matrix;
      if (part === 'hull') mesh.instanceColor = paint;
      if (part === 'lights') mesh.instanceColor = glow;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.name = `dm:${st.id}:${part}`;
      this.group.add(mesh);
      meshes.push(mesh);
    }
    for (let i = 0; i < count; i++) matrix.array.set(_zero.elements, i * 16);
    return { st, count, matrix, state, paint, glow, meshes, mats };
  }

  get materials() {
    const out = [];
    for (const k of this.kinds) if (k) out.push(...Object.values(k.mats));
    return out;
  }

  /** Pick a paint/light variant for a slot (seeded). */
  paint(styleIdx, slot, rand) {
    const k = this.kinds[styleIdx];
    const st = k.st;
    const vs = VARIANTS[st.id];
    const [p, l] = vs[Math.floor(rand() * vs.length)];
    const j = 0.94 + rand() * 0.1;
    k.paint.setXYZ(slot, p[0] * j, p[1] * j, p[2] * j);
    const lc = l || st.light;
    const g = st.lightGain;
    k.glow.setXYZ(slot, lc[0] * g, lc[1] * g, lc[2] * g);
    k.paint.needsUpdate = true;
    k.glow.needsUpdate = true;
    return { paint: _c.setRGB(p[0] * j, p[1] * j, p[2] * j).clone(), light: lc };
  }

  set(styleIdx, slot, pos, quat, scale, burn, flash, glow, mat) {
    const k = this.kinds[styleIdx];
    _m.compose(pos, quat, _s.setScalar(scale));
    k.matrix.array.set(_m.elements, slot * 16);
    const a = k.state.array;
    const j = slot * 4;
    a[j] = burn;
    a[j + 1] = flash;
    a[j + 2] = glow;
    a[j + 3] = mat;
  }

  hide(styleIdx, slot) {
    this.kinds[styleIdx].matrix.array.set(_zero.elements, slot * 16);
  }

  commit() {
    for (const k of this.kinds) {
      if (!k) continue;
      k.matrix.needsUpdate = true;
      k.state.needsUpdate = true;
    }
  }

  setEnvMap(env) {
    for (const m of this.materials) {
      if (m.isMeshStandardMaterial && m.envMap !== env) {
        m.envMap = env;
        m.needsUpdate = true;
      }
    }
  }
}
