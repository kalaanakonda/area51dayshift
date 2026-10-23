import { Color, Vector2 } from 'three';

/**
 * GradeShader — the "print" of the film. Runs AFTER tone mapping, in display space.
 *
 *  0. Speed (uFlow 0..1): the frame edge wobbles like heat haze, flowing outward,
 *     smears radially, and the fringing grows (0 = off; the film never sets it)
 *     uLens (0..1): Overdrive glass — on the sides only, a flowing fbm warp, barrel
 *     distortion and strong colour fringing; the middle of the frame stays clean
 *  1. Subtle radial chromatic aberration (old anamorphic glass, very restrained)
 *  2. Lift / gamma / gain (ASC-CDL style), then contrast around a mid-grey pivot
 *  3. Saturation (the look is deliberately desaturated)
 *  4. Split toning: cool shadows, warm or neutral highlights per location
 *  5. Vignette (oval, follows the visible frame, not the letterbox)
 *  6. Flash + fade (hot-staging flash, eye adaptation at the hatch, cuts to black)
 *  7. Luma-weighted film grain (strongest in the mids, a little chroma, like real stock)
 *  8. Letterbox: 2.39:1 bars that retract to full-frame for "IMAX" moments
 */
export const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new Vector2(1, 1) },
    uTime: { value: 0 },
    uLift: { value: new Color(0, 0, 0) },
    uGamma: { value: new Color(1, 1, 1) },
    uGain: { value: new Color(1, 1, 1) },
    uContrast: { value: 1.1 },
    uPivot: { value: 0.42 },
    uSaturation: { value: 0.85 },
    uShadowTint: { value: new Color(0.42, 0.5, 0.58) },
    uHighlightTint: { value: new Color(0.55, 0.5, 0.45) },
    uSplit: { value: 0.12 },
    uVignette: { value: 0.35 },
    uAberration: { value: 0.0025 },
    uFlow: { value: 0 },
    uLens: { value: 0 },
    uGrain: { value: 0.045 },
    uFlashColor: { value: new Color(1, 0.92, 0.82) },
    uFlash: { value: 0 },
    uFade: { value: 1 },
    uLetterbox: { value: 1 },
    uTargetAspect: { value: 2.39 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uTime;
    uniform vec3 uLift, uGamma, uGain;
    uniform float uContrast, uPivot, uSaturation;
    uniform vec3 uShadowTint, uHighlightTint;
    uniform float uSplit, uVignette, uAberration, uFlow, uLens, uGrain;
    uniform vec3 uFlashColor;
    uniform float uFlash, uFade, uLetterbox, uTargetAspect;
    varying vec2 vUv;

    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    float vnoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }
    float fbm(vec2 p) {
      float a = 0.5;
      float s = 0.0;
      for (int i = 0; i < 5; i++) {
        s += a * vnoise(p);
        p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.3;
        a *= 0.5;
      }
      return s;
    }
    // smoother 3-octave field for the liquid surface (its gradient would turn the fine octaves into grit)
    float fbm3(vec2 p) {
      float a = 0.5;
      float s = 0.0;
      for (int i = 0; i < 3; i++) {
        s += a * vnoise(p);
        p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.3;
        a *= 0.5;
      }
      return s;
    }

    void main() {
      vec2 uv = vUv;
      float aspect = uResolution.x / uResolution.y;
      vec2 lensDisp = vec2(0.0);
      if (uLens > 0.0005) {
        // Overdrive glass, sides only: the frame looks through a sheet of liquid
        // streaming off the left and right edges; the middle stays clear.
        vec2 c = (uv - 0.5) * vec2(aspect, 1.0);
        float side = smoothstep(0.16, 0.5, abs(uv.x - 0.5)) * (0.75 + 0.25 * smoothstep(0.05, 0.5, abs(uv.y - 0.5)));
        side *= uLens;
        if (side > 0.001) {
        // barrel: a fish-eye only where the glass is
        float r2c = dot(c, c);
        vec2 barrel = c * r2c * 0.2 * side;
        // liquid surface: domain-warped fbm, flowing outward and slowly churning
        vec2 rdir = normalize(c + 1e-4);
        vec2 q0 = c * 2.6 - rdir * uTime * 0.9;
        float ch = uTime * 0.35;
        vec2 warpA = vec2(fbm(q0 + vec2(0.0, ch)), fbm(q0 + vec2(5.2, 1.3 - ch)));
        vec2 base = q0 + 3.0 * warpA + vec2(1.7, 9.2) + ch * 0.6;
        // height gradient → refraction (finite differences of the warped field)
        const float e = 0.06;
        base *= 0.8;
        float h0 = fbm3(base);
        float hx = fbm3(base + vec2(e, 0.0));
        float hy = fbm3(base + vec2(0.0, e));
        vec2 refr = vec2(hx - h0, hy - h0) / e;
        uv -= (barrel + refr * 0.034 * side) / vec2(aspect, 1.0);
        // dispersion grows with how hard the liquid bends the light, plus lateral CA toward the rim
        lensDisp = (refr * 0.011 + rdir * r2c * 0.018) * side / vec2(aspect, 1.0);
        }
      }

      // 1. Chromatic aberration (radial, grows toward the frame edge)
      vec2 d = uv - 0.5;
      vec2 da = d * vec2(aspect, 1.0);
      float r2 = dot(da, da);
      vec2 off = d * r2 * (uAberration + uFlow * 0.011);
      vec3 col;
      if (dot(lensDisp, lensDisp) > 1e-10) {
        // spectral dispersion: twelve wavelengths, red bent least, violet most,
        // each weighted by a smooth spectral response, so fringes blend like real glass
        vec3 sum = vec3(0.0);
        vec3 wsum = vec3(0.0);
        vec2 disp = lensDisp + off * 1.5;
        float jit = hash(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5;
        for (int i = 0; i < 12; i++) {
          float t = (float(i) + 0.5 + jit * 0.6) / 12.0;
          vec3 w = vec3(
            exp(-pow((t - 0.12) / 0.2, 2.0)) + 0.22 * exp(-pow((t - 0.97) / 0.07, 2.0)),
            exp(-pow((t - 0.47) / 0.17, 2.0)),
            exp(-pow((t - 0.8) / 0.19, 2.0)));
          sum += texture2D(tDiffuse, uv + disp * (t - 0.4) * 2.0).rgb * w;
          wsum += w;
        }
        col = sum / wsum;
      } else if (uFlow > 0.0005) {
        // 0. Speed: liquid edge wobble (domain-warped sines drifting outward),
        //    a radial smear and stronger fringing, all fading to nothing mid-frame
        float r = sqrt(r2);
        float edge = smoothstep(0.38, 1.0, r / length(vec2(aspect, 1.0) * 0.5));
        edge *= edge * uFlow;
        vec2 dir = da / max(r, 1e-4);
        vec2 p = (da - dir * uTime * 0.32) * 7.0;
        float t = uTime * 1.6;
        vec2 wv = vec2(sin(p.y * 1.3 + t + 1.2 * sin(p.x * 2.1 - t * 0.7)), sin(p.x * 1.1 - t * 1.2 + 1.2 * sin(p.y * 1.7 + t * 0.9)));
        wv += 0.5 * vec2(sin(p.y * 3.1 - t * 2.3 + wv.y), sin(p.x * 2.9 + t * 2.1 + wv.x));
        uv += (wv * 0.0042 - dir * 0.007) * edge / vec2(aspect, 1.0);
        vec2 smear = -dir * edge * 0.014 / vec2(aspect, 1.0);
        col = vec3(0.0);
        for (int i = 0; i < 3; i++) {
          vec2 s = uv + smear * (float(i) * 0.5);
          col.r += texture2D(tDiffuse, s + off).r;
          col.g += texture2D(tDiffuse, s).g;
          col.b += texture2D(tDiffuse, s - off).b;
        }
        col /= 3.0;
      } else {
        col.r = texture2D(tDiffuse, uv + off).r;
        col.g = texture2D(tDiffuse, uv).g;
        col.b = texture2D(tDiffuse, uv - off).b;
      }

      // 2. Lift / gamma / gain + contrast
      col = col * uGain + uLift * (1.0 - col);
      col = pow(max(col, 0.0), 1.0 / max(uGamma, vec3(0.01)));
      col = (col - uPivot) * uContrast + uPivot;

      // 3. Saturation
      float l = dot(max(col, 0.0), vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSaturation);

      // 4. Split toning (weighting keeps pure black and pure white clean)
      float sw = (1.0 - smoothstep(0.0, 0.55, l)) * smoothstep(0.0, 0.08, l);
      float hw = smoothstep(0.35, 1.0, l);
      col += (uShadowTint - 0.5) * uSplit * sw;
      col += (uHighlightTint - 0.5) * uSplit * hw;

      // 5. Vignette (computed on the visible frame)
      float bar = max(0.0, (1.0 - aspect / uTargetAspect) * 0.5) * uLetterbox;
      vec2 fv = vec2(vUv.x, (vUv.y - bar) / max(1.0 - 2.0 * bar, 0.001)) - 0.5;
      float v = 1.0 - dot(fv * vec2(1.0, 0.82), fv * vec2(1.0, 0.82)) * 1.9;
      col *= mix(1.0, clamp(v, 0.0, 1.0), uVignette);

      // 6. Flash and fade
      col = mix(col, uFlashColor, clamp(uFlash, 0.0, 1.0));
      col *= uFade;

      // 7. Film grain — two hashes approximate a gaussian, weighted toward mids
      vec2 gp = floor(vUv * uResolution / 1.6);
      float t = floor(uTime * 24.0);
      float g = (hash(gp + t * 13.7) + hash(gp * 1.37 + t * 7.1)) - 1.0;
      vec3 gc = vec3(hash(gp * 0.71 + t * 3.1 + 11.0), hash(gp * 1.93 + t * 5.3), hash(gp * 1.13 + t * 2.7 + 5.0)) - 0.5;
      float gw = 0.35 + 0.65 * (1.0 - abs(l * 2.0 - 0.9));
      col += (g + gc * 0.45) * uGrain * gw;

      // 8. Letterbox
      if (vUv.y < bar || vUv.y > 1.0 - bar) col = vec3(0.0);

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `,
};
