import { DataTexture, LinearFilter, LinearMipmapLinearFilter, Matrix4, RepeatWrapping, RGBAFormat, UnsignedByteType } from 'three';
import { tileableField } from '../../procedural/textures.js';

/**
 * World-space grime for the hangar's materials (onBeforeCompile), so no two
 * metres of the building look alike and nothing reads as freshly modelled:
 *
 *   floor : big soft blotches that break up the 8 m epoxy tile, dust banked
 *           against the walls, a little extra polish down the traffic lanes
 *   wall  : a scuffed dirt band climbing from the floor with a ragged top,
 *           and long vertical run-off streaks
 *   prop  : light blotching and a darker, rougher foot where things meet the floor
 *
 * Positions are hangar-local (uGrimeFrame = inverse of the hangar's world
 * matrix), so the dirt stays put when the building is re-seated on the terrain.
 */
const MODES = { floor: 0, wall: 1, prop: 2 };
const frame = { value: new Matrix4() };
let noise = null;

function noiseTexture() {
  if (noise) return noise;
  const S = 256;
  const a = tileableField(S, 3, 5, 71); // big blotches
  const b = tileableField(S, 12, 4, 72); // streak / mid detail
  const c = tileableField(S, 40, 3, 73); // fine
  const data = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    data[i * 4] = a[i] * 255;
    data[i * 4 + 1] = b[i] * 255;
    data[i * 4 + 2] = c[i] * 255;
    data[i * 4 + 3] = 255;
  }
  noise = new DataTexture(data, S, S, RGBAFormat, UnsignedByteType);
  noise.wrapS = noise.wrapT = RepeatWrapping;
  noise.generateMipmaps = true;
  noise.minFilter = LinearMipmapLinearFilter;
  noise.magFilter = LinearFilter;
  noise.needsUpdate = true;
  return noise;
}

/** Hangar world matrix → keep the grime frame in sync (call when the hangar moves). */
export function setGrimeFrame(matrixWorld) {
  frame.value.copy(matrixWorld).invert();
}

export function addGrime(material, mode = 'prop', strength = 1) {
  const tex = noiseTexture();
  const m = MODES[mode];
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    shader.uniforms.tGrime = { value: tex };
    shader.uniforms.uGrimeFrame = frame;
    shader.uniforms.uGrimeAmt = { value: strength };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform mat4 uGrimeFrame;\nvarying vec3 vGrimeP;\nvarying vec3 vGrimeN;')
      .replace(
        '#include <fog_vertex>',
        '#include <fog_vertex>\nvGrimeP = (uGrimeFrame * modelMatrix * vec4(transformed, 1.0)).xyz;\nvGrimeN = normalize(mat3(uGrimeFrame) * mat3(modelMatrix) * objectNormal);'
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D tGrime;\nuniform float uGrimeAmt;\nvarying vec3 vGrimeP;\nvarying vec3 vGrimeN;')
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${GRIME[m]}`);
  };
  material.customProgramCacheKey = () => `grime${m}`;
  material.needsUpdate = true;
  return material;
}

const GRIME = [
  // floor
  /* glsl */ `{
    vec3 gp = vGrimeP;
    float big = texture2D(tGrime, gp.xz * 0.021).r;
    float mid = texture2D(tGrime, gp.xz * 0.11 + 0.37).g;
    float edge = min(30.0 - abs(gp.x), 26.0 - abs(gp.z));
    float banked = (1.0 - smoothstep(0.2, 2.6, edge)) * (0.55 + 0.45 * mid);
    float blot = smoothstep(0.42, 0.78, big) * 0.55 + smoothstep(0.55, 0.85, mid) * 0.25;
    float g = clamp(blot + banked, 0.0, 1.0) * uGrimeAmt;
    diffuseColor.rgb *= mix(vec3(1.0), vec3(0.74, 0.72, 0.69), g);
    diffuseColor.rgb *= 0.93 + 0.14 * big;
    roughnessFactor = clamp(roughnessFactor + g * 0.22 - (1.0 - big) * 0.06, 0.04, 1.0);
  }`,
  // wall
  /* glsl */ `{
    vec3 gp = vGrimeP;
    float u = gp.x + gp.z;
    float streak = texture2D(tGrime, vec2(u * 0.23, gp.y * 0.012)).g;
    float blot = texture2D(tGrime, vec2(u, gp.y) * 0.05).r;
    float fine = texture2D(tGrime, vec2(u, gp.y) * 0.7).b;
    float top = 0.55 + 0.9 * blot + 0.25 * fine;
    float band = 1.0 - smoothstep(top * 0.4, top, gp.y);
    float runs = smoothstep(0.58, 0.9, streak) * smoothstep(1.0, 4.0, gp.y) * (1.0 - smoothstep(12.0, 16.5, gp.y));
    float g = clamp(band * 0.75 + runs * 0.5 + smoothstep(0.6, 0.9, blot) * 0.2, 0.0, 1.0) * uGrimeAmt * (1.0 - abs(vGrimeN.y));
    diffuseColor.rgb *= mix(vec3(1.0), vec3(0.62, 0.6, 0.56), g);
    roughnessFactor = clamp(roughnessFactor + g * 0.25, 0.04, 1.0);
  }`,
  // prop
  /* glsl */ `{
    vec3 gp = vGrimeP;
    float blot = texture2D(tGrime, (gp.xz + gp.y * 0.7) * 0.18).r;
    float fine = texture2D(tGrime, (gp.xz + gp.yy) * 1.3).b;
    float foot = 1.0 - smoothstep(0.0, 0.35 + 0.25 * fine, gp.y);
    float g = clamp(smoothstep(0.5, 0.85, blot) * 0.45 + foot * 0.6, 0.0, 1.0) * uGrimeAmt;
    diffuseColor.rgb *= mix(vec3(1.0), vec3(0.66, 0.64, 0.6), g);
    roughnessFactor = clamp(roughnessFactor + g * 0.2, 0.04, 1.0);
  }`,
];
