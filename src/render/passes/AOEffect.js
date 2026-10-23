import { AddEquation, CustomBlending, HalfFloatType, OneFactor, ShaderMaterial, SrcColorFactor, Vector2, WebGLRenderTarget, ZeroFactor } from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * Screen-space ambient occlusion for a logarithmic depth buffer.
 *
 * three's SSAO / GTAO passes assume a projective depth buffer. This stage
 * writes log2(1 + w) / log2(far + 1) instead (logdepthbuf_fragment), which
 * inverts exactly to view depth, so AO needs no extra geometry pass: it reads
 * the depth the layer has just written (the composer target's depthTexture).
 *
 *   1. half-res SAO (McGuire et al. 2012): spiral taps inside a world-space
 *      radius, normals rebuilt from depth, rotated per pixel by gradient noise
 *   2. separable depth-aware blur (removes the noise, keeps silhouettes)
 *   3. multiplied onto the layer's colour (alpha is the light-shaft sky mask)
 *
 * WorldPass runs one instance on the far layer (hangar, world) before the
 * cockpit is drawn, and another on the near layer with the cockpit camera.
 */
const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`;

const aoShader = /* glsl */ `
  uniform sampler2D tDepth;
  uniform float uLogFar;
  uniform vec2 uProj, uTexel, uAoTexel;
  uniform float uRadius, uGrow, uBias, uIntensity, uMaxDist, uPxScale, uMaxPx;
  varying vec2 vUv;

  // Positions are rebuilt at depth-texel centres: pairing a depth with an
  // off-centre uv bends every reconstructed normal on grazing floors (banding).
  vec2 snap(vec2 uv) { return (floor(uv / uTexel) + 0.5) * uTexel; }
  float viewW(vec2 uv) { return exp2(texture2D(tDepth, uv).x * uLogFar) - 1.0; }
  vec3 viewPos(vec2 uv, float w) { return vec3((uv * 2.0 - 1.0) * uProj * w, -w); }
  vec3 at(vec2 uv) { uv = snap(uv); return viewPos(uv, viewW(uv)); }

  void main() {
    vec2 c = snap(vUv);
    float d = texture2D(tDepth, c).x;
    if (d >= 0.999999) { gl_FragColor = vec4(1.0, 6e4, 0.0, 1.0); return; }
    float w = exp2(d * uLogFar) - 1.0;
    vec3 P = viewPos(c, w);
    // normal from whichever neighbour on each axis lies on the same surface
    vec3 pr = at(c + vec2(uTexel.x, 0.0)) - P;
    vec3 pl = P - at(c - vec2(uTexel.x, 0.0));
    vec3 pt = at(c + vec2(0.0, uTexel.y)) - P;
    vec3 pb = P - at(c - vec2(0.0, uTexel.y));
    vec3 N = normalize(cross(abs(pr.z) < abs(pl.z) ? pr : pl, abs(pt.z) < abs(pb.z) ? pt : pb));

    float R = uRadius * (1.0 + w * uGrow);
    float rPx = R * uPxScale / w;
    float fade = 1.0 - smoothstep(uMaxDist * 0.6, uMaxDist, w);
    if (rPx < 1.0 || fade <= 0.0) { gl_FragColor = vec4(1.0, w, 0.0, 1.0); return; }
    rPx = min(rPx, uMaxPx);
    float rot = 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float sum = 0.0;
    for (int i = 0; i < SAMPLES; i++) {
      float a = (float(i) + 0.5) / float(SAMPLES);
      float ang = a * 6.2831853 * 7.0 + rot;
      vec2 suv = c + vec2(cos(ang), sin(ang)) * (a * rPx) * uAoTexel;
      // radius-normalised, so the same settings work for a hangar and a cockpit
      vec3 v = (at(suv) - P) / R;
      float vv = dot(v, v);
      float f = max(1.0 - vv, 0.0);
      sum += f * f * f * max((dot(v, N) - uBias) / (vv + 0.01), 0.0);
    }
    float ao = max(0.0, 1.0 - sum * uIntensity * 5.0 / float(SAMPLES));
    gl_FragColor = vec4(mix(1.0, ao, fade), w, 0.0, 1.0);
  }`;

const blurShader = /* glsl */ `
  uniform sampler2D tAO;
  uniform vec2 uStep;
  varying vec2 vUv;
  void main() {
    vec2 c = texture2D(tAO, vUv).xy;
    // depth slope along the blur line, so a floor seen edge-on still blurs along itself
    float zl = texture2D(tAO, vUv - uStep).y;
    float zr = texture2D(tAO, vUv + uStep).y;
    float slope = abs(zr - c.y) < abs(c.y - zl) ? zr - c.y : c.y - zl;
    float sum = c.x;
    float wsum = 1.0;
    for (int i = -4; i <= 4; i++) {
      if (i == 0) continue;
      vec2 s = texture2D(tAO, vUv + uStep * float(i)).xy;
      float dz = abs(s.y - c.y - slope * float(i)) / max(c.y, 1e-3);
      float wt = exp(-float(i * i) / 12.0) * max(0.0, 1.0 - dz * 40.0);
      sum += s.x * wt;
      wsum += wt;
    }
    gl_FragColor = vec4(sum / wsum, c.y, 0.0, 1.0);
  }`;

const compositeShader = /* glsl */ `
  uniform sampler2D tAO;
  uniform float uStrength;
  varying vec2 vUv;
  void main() {
    float ao = texture2D(tAO, vUv).x;
    gl_FragColor = vec4(vec3(mix(1.0, ao, uStrength)), 1.0);
  }`;

export class AOEffect {
  /** samples: taps per pixel; scale: AO resolution relative to the target. */
  constructor({ samples = 12, scale = 0.5 } = {}) {
    this.enabled = true;
    this.scale = scale;
    /** radius (m), grow (radius gain per metre of depth), bias, intensity, maxDist (m), strength (0..1 mix). */
    this.params = { radius: 1, grow: 0, bias: 0.04, intensity: 0.6, maxDist: 400, strength: 1 };
    const rt = () => {
      const t = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
      t.texture.name = 'AO.rt';
      return t;
    };
    this.rtA = rt();
    this.rtB = rt();
    this.aoMat = new ShaderMaterial({
      name: 'AO',
      defines: { SAMPLES: samples },
      uniforms: {
        tDepth: { value: null },
        uLogFar: { value: 1 },
        uProj: { value: new Vector2(1, 1) },
        uTexel: { value: new Vector2(1, 1) },
        uAoTexel: { value: new Vector2(1, 1) },
        uRadius: { value: 1 },
        uGrow: { value: 0 },
        uBias: { value: 0.04 },
        uIntensity: { value: 0.6 },
        uMaxDist: { value: 400 },
        uPxScale: { value: 1 },
        uMaxPx: { value: 80 },
      },
      vertexShader,
      fragmentShader: aoShader,
      depthTest: false,
      depthWrite: false,
    });
    this.blurMat = new ShaderMaterial({
      name: 'AO.blur',
      uniforms: { tAO: { value: null }, uStep: { value: new Vector2() } },
      vertexShader,
      fragmentShader: blurShader,
      depthTest: false,
      depthWrite: false,
    });
    this.compositeMat = new ShaderMaterial({
      name: 'AO.composite',
      uniforms: { tAO: { value: null }, uStrength: { value: 1 } },
      vertexShader,
      fragmentShader: compositeShader,
      depthTest: false,
      depthWrite: false,
      // dst.rgb *= ao, dst.a untouched
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: ZeroFactor,
      blendDst: SrcColorFactor,
      blendEquationAlpha: AddEquation,
      blendSrcAlpha: ZeroFactor,
      blendDstAlpha: OneFactor,
    });
    this.quad = new FullScreenQuad(this.aoMat);
  }

  set(params) {
    Object.assign(this.params, params);
    return this;
  }

  /** `target` holds the layer just drawn by `camera` (colour + resolved depthTexture); AO is multiplied into it. */
  render(renderer, target, camera) {
    const P = this.params;
    if (!target.depthTexture || !camera || P.strength <= 0.001) return;
    const w = Math.max(1, Math.round(target.width * this.scale));
    const h = Math.max(1, Math.round(target.height * this.scale));
    if (this.rtA.width !== w || this.rtA.height !== h) {
      this.rtA.setSize(w, h);
      this.rtB.setSize(w, h);
    }
    const e = camera.projectionMatrix.elements;
    const u = this.aoMat.uniforms;
    u.tDepth.value = target.depthTexture;
    u.uLogFar.value = Math.log2(camera.far + 1);
    u.uProj.value.set(1 / e[0], 1 / e[5]);
    u.uTexel.value.set(1 / target.width, 1 / target.height);
    u.uAoTexel.value.set(1 / w, 1 / h);
    u.uPxScale.value = e[5] * 0.5 * h;
    u.uMaxPx.value = 0.09 * h;
    u.uRadius.value = P.radius;
    u.uGrow.value = P.grow;
    u.uBias.value = P.bias;
    u.uIntensity.value = P.intensity;
    u.uMaxDist.value = P.maxDist;

    this.quad.material = this.aoMat;
    renderer.setRenderTarget(this.rtA);
    this.quad.render(renderer);

    const b = this.blurMat.uniforms;
    this.quad.material = this.blurMat;
    b.tAO.value = this.rtA.texture;
    b.uStep.value.set(1 / w, 0);
    renderer.setRenderTarget(this.rtB);
    this.quad.render(renderer);
    b.tAO.value = this.rtB.texture;
    b.uStep.value.set(0, 1 / h);
    renderer.setRenderTarget(this.rtA);
    this.quad.render(renderer);

    this.compositeMat.uniforms.tAO.value = this.rtA.texture;
    this.compositeMat.uniforms.uStrength.value = P.strength;
    this.quad.material = this.compositeMat;
    renderer.setRenderTarget(target);
    this.quad.render(renderer);
  }

  dispose() {
    this.rtA.dispose();
    this.rtB.dispose();
    this.aoMat.dispose();
    this.blurMat.dispose();
    this.compositeMat.dispose();
    this.quad.dispose();
  }
}
