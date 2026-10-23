import {
  AddEquation,
  Color,
  ConeGeometry,
  CylinderGeometry,
  CustomBlending,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix4,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
  ZeroFactor,
} from 'three';
import { mulberry32 } from '../core/math.js';
import { GLSL_NOISE } from '../render/shaders/glsl.js';
import { puffTexture } from './textures.js';

/** Additive blending that leaves destination alpha untouched (keeps the sky mask intact). */
export function additive(material) {
  material.blending = CustomBlending;
  material.blendEquation = AddEquation;
  material.blendSrc = OneFactor;
  material.blendDst = OneFactor;
  material.blendSrcAlpha = ZeroFactor;
  material.blendDstAlpha = OneFactor;
  material.transparent = true;
  material.depthWrite = false;
  return material;
}

/** Premultiplied "over" blending: colour composites normally, alpha accumulates occlusion. */
export function over(material) {
  material.blending = CustomBlending;
  material.blendEquation = AddEquation;
  material.blendSrc = OneFactor;
  material.blendDst = OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = OneFactor;
  material.blendDstAlpha = OneMinusSrcAlphaFactor;
  material.transparent = true;
  material.depthWrite = false;
  return material;
}

/**
 * GPU particle field — instanced camera-facing quads, simulated entirely in
 * the vertex shader from (spawn, velocity, life, phase). Zero CPU cost per
 * frame beyond one uniform. Two modes:
 *   loop  : continuous emission (vents, dust motes, plume smoke)
 *   burst : everything spawns at `burst()` time (footstep puff, touchdown)
 */
export class ParticleField {
  constructor({
    count = 200,
    seed = 1,
    spawn, // (rand, i) => { p:[x,y,z], v:[x,y,z], life, size0, size1, delay? }
    color = new Color(1, 1, 1),
    opacity = 0.5,
    wind = new Vector3(),
    drag = 0.6,
    gravity = 0,
    turbulence = 0.4,
    loop = true,
    lit = 0.5,
    additiveBlend = false,
    fadeIn = 0.08,
    fadeOut = 0.45,
    worldSpace = true,
  }) {
    const rand = mulberry32(seed);
    const quad = new PlaneGeometry(1, 1);
    const geo = new InstancedBufferGeometry();
    geo.index = quad.index;
    geo.attributes.position = quad.attributes.position;
    geo.attributes.uv = quad.attributes.uv;
    const P = new Float32Array(count * 3);
    const Vv = new Float32Array(count * 3);
    const A = new Float32Array(count * 4);
    const S = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const s = spawn(rand, i, count);
      P.set(s.p, i * 3);
      Vv.set(s.v, i * 3);
      A[i * 4] = s.life;
      A[i * 4 + 1] = s.delay != null ? s.delay : rand();
      A[i * 4 + 2] = s.size0;
      A[i * 4 + 3] = s.size1;
      S[i] = rand();
    }
    geo.setAttribute('aPos', new InstancedBufferAttribute(P, 3));
    geo.setAttribute('aVel', new InstancedBufferAttribute(Vv, 3));
    geo.setAttribute('aParams', new InstancedBufferAttribute(A, 4));
    geo.setAttribute('aSeed', new InstancedBufferAttribute(S, 1));
    geo.instanceCount = count;

    this.uniforms = {
      uTime: { value: 0 },
      uBurst: { value: -1000 },
      uLoop: { value: loop ? 1 : 0 },
      uWind: { value: wind.clone() },
      uDrag: { value: drag },
      uGravity: { value: gravity },
      uTurb: { value: turbulence },
      uColor: { value: color.clone() },
      uOpacity: { value: opacity },
      uMap: { value: puffTexture() },
      uLit: { value: lit },
      uLightDir: { value: new Vector3(0.3, 1, 0.2).normalize() },
      uLightColor: { value: new Color(1, 1, 1) },
      uAmbient: { value: new Color(0.5, 0.5, 0.5) },
      uFadeIn: { value: fadeIn },
      uFadeOut: { value: fadeOut },
      uIntensity: { value: 1 },
    };
    const material = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        attribute vec3 aPos;
        attribute vec3 aVel;
        attribute vec4 aParams;
        attribute float aSeed;
        uniform float uTime, uBurst, uLoop, uDrag, uGravity, uTurb, uFadeIn, uFadeOut;
        uniform vec3 uWind;
        varying vec2 vUv;
        varying float vAlpha;
        varying float vSeed;
        varying float vAge;
        void main() {
          float life = aParams.x;
          float age = uLoop > 0.5 ? mod(uTime + aParams.y * life, life) : uTime - uBurst - aParams.y;
          float t = age / life;
          vAge = t;
          vSeed = aSeed;
          if (age < 0.0 || t > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          float k = (1.0 - exp(-uDrag * age)) / max(uDrag, 1e-3);
          vec3 p = aPos + aVel * k + uWind * age + vec3(0.0, -0.5 * uGravity * age * age, 0.0);
          p += vec3(sin(age * 0.9 + aSeed * 31.0), sin(age * 0.7 + aSeed * 17.0) * 0.5, cos(age * 0.8 + aSeed * 23.0)) * uTurb * t;
          float size = mix(aParams.z, aParams.w, sqrt(t));
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float ang = aSeed * 6.2831 + age * (aSeed - 0.5) * 0.4;
          vec2 c = position.xy;
          c = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * c;
          mv.xy += c * size;
          gl_Position = projectionMatrix * mv;
          vUv = uv;
          vAlpha = smoothstep(0.0, uFadeIn, t) * (1.0 - smoothstep(1.0 - uFadeOut, 1.0, t));
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform vec3 uColor, uLightColor, uAmbient, uLightDir;
        uniform float uOpacity, uLit, uIntensity;
        varying vec2 vUv;
        varying float vAlpha;
        varying float vSeed;
        varying float vAge;
        void main() {
          vec4 tex = texture2D(uMap, vUv);
          float a = tex.a * vAlpha * uOpacity;
          if (a < 0.003) discard;
          // Cheap volumetric shading: brighter on the side facing the key light.
          float shade = 0.5 + 0.5 * dot(normalize(vec3(vUv - 0.5, 0.35)), normalize(uLightDir));
          vec3 col = uColor * (uAmbient + uLightColor * mix(1.0, shade, uLit)) * uIntensity;
          gl_FragColor = vec4(col * a, a);
        }
      `,
    });
    if (additiveBlend) additive(material);
    else over(material);
    this.material = material;
    this.mesh = new Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.worldSpace = worldSpace;
  }

  update(time) {
    this.uniforms.uTime.value = time;
  }

  /** Fire a one-shot burst now (uses uTime as the clock). */
  burst() {
    this.uniforms.uBurst.value = this.uniforms.uTime.value;
  }
}

/**
 * Volumetric light cone (practical floodlight beams in morning haze).
 * Brightest along the axis, fades with distance and toward the cone edge,
 * with slow drifting dust. Additive, alpha-neutral.
 */
export function createBeam({ length = 120, radius = 22, color = new Color(0.8, 0.86, 1), intensity = 0.06 } = {}) {
  const geo = new ConeGeometry(radius, length, 32, 1, true);
  geo.translate(0, -length / 2, 0); // apex at origin, opening along -Y
  geo.applyMatrix4(new Matrix4().makeRotationX(-Math.PI / 2)); // apex at origin, opening along +Z (aim with lookAt)
  const uniforms = {
    uColor: { value: color.clone() },
    uIntensity: { value: intensity },
    uLength: { value: length },
    uTime: { value: 0 },
  };
  const material = additive(
    new ShaderMaterial({
      uniforms,
      vertexShader: /* glsl */ `
        varying vec3 vLocal;
        varying vec3 vNormalV;
        varying vec3 vViewPos;
        void main() {
          vLocal = position;
          vNormalV = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vViewPos = mv.xyz;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uIntensity, uLength, uTime;
        varying vec3 vLocal;
        varying vec3 vNormalV;
        varying vec3 vViewPos;
        ${GLSL_NOISE}
        void main() {
          float along = clamp(vLocal.z / uLength, 0.0, 1.0);
          float fall = pow(1.0 - along, 1.7) * smoothstep(0.0, 0.04, along);
          float facing = abs(dot(normalize(vNormalV), normalize(-vViewPos)));
          float core = pow(facing, 2.2);
          float dust = 0.7 + 0.3 * vnoise2(vLocal.xy * 0.12 + vec2(uTime * 0.05, vLocal.z * 0.02));
          float dist = length(vViewPos);
          float nearFade = smoothstep(2.0, 18.0, dist);
          gl_FragColor = vec4(uColor * uIntensity * fall * core * dust * nearFade, 1.0);
        }
      `,
      side: DoubleSide,
    })
  );
  const mesh = new Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  mesh.userData.uniforms = uniforms;
  return mesh;
}

/**
 * Raptor exhaust plume. Methalox burns a clean blue-violet core with shock
 * diamonds near the nozzle; at sea level it entrains air and blooms orange.
 * `ambient` 1 = dense atmosphere (launch), ~0.15 = Mars, 0 = vacuum.
 */
export function createPlume({ length = 22, radius = 2.2, exitRadius = 0.6, ambient = 1 } = {}) {
  // Exit plane at y = 0, plume grows downward along -Y.
  const geo = new CylinderGeometry(exitRadius, radius, length, 24, 12, true);
  geo.translate(0, -length / 2, 0);
  const uniforms = {
    uTime: { value: 0 },
    uLength: { value: length },
    uAmbient: { value: ambient },
    uThrottle: { value: 1 },
  };
  const material = additive(
    new ShaderMaterial({
      uniforms,
      vertexShader: /* glsl */ `
        varying vec3 vLocal;
        varying vec3 vNormalV;
        varying vec3 vViewPos;
        uniform float uLength, uAmbient, uTime;
        void main() {
          vec3 p = position;
          float t = clamp(-p.y / uLength, 0.0, 1.0);
          // Under-expanded at Mars / vacuum: plume balloons outward.
          float bloom = 1.0 + (1.0 - uAmbient) * t * 1.6;
          p.xz *= bloom * (0.92 + 0.08 * sin(uTime * 40.0 + t * 20.0));
          vLocal = p;
          vNormalV = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vViewPos = mv.xyz;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime, uLength, uAmbient, uThrottle;
        varying vec3 vLocal;
        varying vec3 vNormalV;
        varying vec3 vViewPos;
        ${GLSL_NOISE}
        void main() {
          float t = clamp(-vLocal.y / uLength, 0.0, 1.0);
          float facing = pow(abs(dot(normalize(vNormalV), normalize(-vViewPos))), 1.4);
          float diamonds = 0.65 + 0.35 * pow(0.5 + 0.5 * cos(t * 38.0), 6.0) * (1.0 - t);
          float flicker = 0.8 + 0.2 * vnoise2(vec2(t * 8.0 - uTime * 30.0, atan(vLocal.x, vLocal.z) * 2.0));
          vec3 core = vec3(0.45, 0.55, 1.6) * (1.0 - smoothstep(0.0, 0.35, t));
          vec3 hot = vec3(2.6, 1.5, 0.75) * uAmbient * smoothstep(0.08, 0.4, t) * (1.0 - smoothstep(0.5, 1.0, t));
          vec3 col = (core * 2.4 + hot) * diamonds * flicker;
          float fade = (1.0 - smoothstep(0.55, 1.0, t)) * smoothstep(0.0, 0.03, t);
          gl_FragColor = vec4(col * facing * fade * uThrottle, 1.0);
        }
      `,
      side: DoubleSide,
    })
  );
  const mesh = new Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.userData.uniforms = uniforms;
  return mesh;
}
