import { Color, HalfFloatType, ShaderMaterial, Vector2, WebGLRenderTarget } from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';

/**
 * Screen-space light shafts ("god rays").
 *
 * Every sky shader in this project writes ALPHA = 0, every solid surface writes
 * alpha = 1. That gives a free occlusion mask: only bright *sky* pixels emit rays,
 * so the launch-tower lattice, the hull and the cabin window frames cut clean
 * shafts out of the dawn / Mars sun without an extra occlusion render.
 *
 * Rays are marched at reduced resolution, then added back over the HDR frame
 * (before bloom + tone mapping), so they behave like real scattered light.
 */
export class LightShaftsPass extends Pass {
  constructor({ samples = 48, scale = 0.5 } = {}) {
    super();
    this.scale = scale;
    this.needsSwap = true;
    this.intensity = 0;
    this.sunUv = new Vector2(0.5, 0.5);
    this.tint = new Color(1, 0.86, 0.68);

    this.rt = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
    this.rt.texture.name = 'LightShafts.rt';

    this.shaftMaterial = new ShaderMaterial({
      defines: { SAMPLES: samples },
      uniforms: {
        tDiffuse: { value: null },
        uSun: { value: this.sunUv },
        uDensity: { value: 0.92 },
        uDecay: { value: 0.955 },
        uWeight: { value: 0.06 },
        uThreshold: { value: 0.6 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform vec2 uSun;
        uniform float uDensity, uDecay, uWeight, uThreshold;
        varying vec2 vUv;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        void main() {
          vec2 delta = (vUv - uSun) * uDensity / float(SAMPLES);
          vec2 uv = vUv - delta * hash(gl_FragCoord.xy);
          float illum = 1.0;
          vec3 acc = vec3(0.0);
          for (int i = 0; i < SAMPLES; i++) {
            uv -= delta;
            vec4 s = texture2D(tDiffuse, clamp(uv, 0.0, 1.0));
            float sky = 1.0 - clamp(s.a, 0.0, 1.0);
            vec3 c = max(s.rgb - uThreshold, 0.0) * sky;
            acc += min(c, vec3(8.0)) * illum * uWeight;
            illum *= uDecay;
          }
          gl_FragColor = vec4(acc, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });

    this.compositeMaterial = new ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tShafts: { value: this.rt.texture },
        uIntensity: { value: 0 },
        uTint: { value: this.tint },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse, tShafts;
        uniform float uIntensity;
        uniform vec3 uTint;
        varying vec2 vUv;
        void main() {
          vec4 base = texture2D(tDiffuse, vUv);
          vec3 shafts = texture2D(tShafts, vUv).rgb;
          gl_FragColor = vec4(base.rgb + shafts * uTint * uIntensity, base.a);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new FullScreenQuad(this.shaftMaterial);
  }

  setSize(width, height) {
    this.rt.setSize(Math.max(1, Math.floor(width * this.scale)), Math.max(1, Math.floor(height * this.scale)));
  }

  render(renderer, writeBuffer, readBuffer) {
    this.shaftMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.rt);
    this.quad.material = this.shaftMaterial;
    this.quad.render(renderer);

    this.compositeMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this.compositeMaterial.uniforms.uIntensity.value = this.intensity;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.material = this.compositeMaterial;
    this.quad.render(renderer);
  }

  dispose() {
    this.rt.dispose();
    this.shaftMaterial.dispose();
    this.compositeMaterial.dispose();
    this.quad.dispose();
  }
}
