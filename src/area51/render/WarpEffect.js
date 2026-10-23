import { HalfFloatType, ShaderMaterial, Vector2, WebGLRenderTarget } from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * Warp / Overdrive streaks on the world outside the canopy. WorldPass runs it
 * between the far layer (Earth, sky) and the near layer (cockpit, hands), so
 * the planet smears past while the cabin stays sharp:
 *   - radial zoom blur toward the centre
 *   - stars streaking outward along radial lines, ~1.5 px wide at any radius
 *   - a blue shift and a glow down the throat while the tunnel is up
 * uTunnel 0..1 drives the warp tunnel, uLines 0..1 the faint Overdrive lines.
 * (The white flash on entry / exit is the grade's uFlash: it lights the cabin too.)
 */
const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`;

const fragmentShader = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform float uTunnel, uLines, uTime;
  uniform vec2 uRes;
  varying vec2 vUv;

  float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
  }

  // One layer of radial star streaks. r, ang: polar coords in screen-height units.
  float streaks(float r, float ang, float N, float seed, float pace, float stretch) {
    float a = (ang / 6.2831853 + 0.5) * N;
    float id = floor(a);
    float f = fract(a) - 0.5;
    float rnd = hash11(id * 7.31 + seed);
    float rnd2 = hash11(id * 3.17 + seed * 1.7 + 5.0);
    if (rnd2 < 0.4) return 0.0;
    float pos = fract(rnd + uTime * pace * (0.5 + rnd2));
    float head = pos * pos * 1.35;                       // perspective: slow at the centre, fast at the edge
    float len = stretch * head + 0.004;
    float along = smoothstep(head - len, head, r) * (1.0 - smoothstep(head, head + 0.006, r));
    float sectorPx = max(r * 6.2831853 / N * uRes.y, 1e-3);
    float halfW = clamp(0.8 / sectorPx, 0.015, 0.5);
    float across = 1.0 - smoothstep(halfW * 0.4, halfW, abs(f));
    return along * across * (0.4 + 0.6 * rnd);
  }

  void main() {
    vec2 c = vec2(0.5);
    vec2 d = vUv - c;
    vec2 da = vec2(d.x * uRes.x / uRes.y, d.y);
    float r = length(da);
    float ang = atan(da.y, da.x);
    vec4 base = texture2D(tDiffuse, vUv);

    // radial zoom blur (edges smear most)
    float amt = uTunnel * 0.24 + uLines * 0.035;
    vec3 col = vec3(0.0);
    float wsum = 0.0;
    for (int i = 0; i < 12; i++) {
      float k = float(i) / 11.0;
      float sc = 1.0 - amt * k * smoothstep(0.04, 0.75, r);
      float w = 1.0 - 0.55 * k;
      col += texture2D(tDiffuse, c + d * sc).rgb * w;
      wsum += w;
    }
    col /= wsum;

    float pace = 0.35 + uTunnel * 1.1 + uLines * 0.5;
    float stretch = 0.06 + uTunnel * 0.5 + uLines * 0.12;
    float s = streaks(r, ang, 340.0, 1.0, pace, stretch) + 0.7 * streaks(r, ang + 0.37, 190.0, 9.0, pace * 0.7, stretch * 0.8);
    s *= smoothstep(0.03, 0.22, r);
    col += vec3(0.62, 0.84, 1.0) * s * (uTunnel * 5.0 + uLines * 1.4);

    // tunnel: blue shift, glow down the throat, darker rim
    col = mix(col, col * vec3(0.72, 0.88, 1.25), uTunnel * 0.65);
    col += vec3(0.35, 0.6, 1.0) * uTunnel * 0.5 * exp(-r * 7.0);
    col *= 1.0 - uTunnel * 0.35 * smoothstep(0.35, 0.95, r);
    // streaks count as solid for the light-shaft sky mask
    gl_FragColor = vec4(col, max(base.a, clamp(s * 3.0, 0.0, 1.0)));
  }`;

export class WarpEffect {
  constructor() {
    this.enabled = false;
    this.rt = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
    this.rt.texture.name = 'Warp.rt';
    this.material = new ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uTunnel: { value: 0 },
        uLines: { value: 0 },
        uTime: { value: 0 },
        uRes: { value: new Vector2(1, 1) },
      },
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.uniforms = this.material.uniforms;
    this.copy = new ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        varying vec2 vUv;
        void main() { gl_FragColor = texture2D(tDiffuse, vUv); }`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  set({ tunnel = 0, lines = 0, time = 0 }) {
    const u = this.uniforms;
    u.uTunnel.value = tunnel;
    u.uLines.value = lines;
    u.uTime.value = time;
    this.enabled = tunnel > 0.002 || lines > 0.002;
  }

  /** `target` holds the far layer (resolved into target.texture); the result goes back into it. */
  render(renderer, target) {
    if (this.rt.width !== target.width || this.rt.height !== target.height) this.rt.setSize(target.width, target.height);
    this.uniforms.tDiffuse.value = target.texture;
    this.uniforms.uRes.value.set(target.width, target.height);
    renderer.setRenderTarget(this.rt);
    this.quad.material = this.material;
    this.quad.render(renderer);
    this.copy.uniforms.tDiffuse.value = this.rt.texture;
    renderer.setRenderTarget(target);
    this.quad.material = this.copy;
    this.quad.render(renderer);
  }
}
