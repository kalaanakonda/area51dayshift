import { DepthTexture, HalfFloatType, Vector2, Vector3, WebGLRenderTarget } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import gsap from 'gsap';
import { WorldPass } from './passes/WorldPass.js';
import { LightShaftsPass } from './passes/LightShaftsPass.js';
import { GradeShader } from './shaders/GradeShader.js';
import { GRADES } from './grades.js';

const _v = new Vector3();

/**
 * Post-processing chain (all HDR until OutputPass):
 *
 *   WorldPass (far layer + near layer, MSAA)
 *     → LightShaftsPass (sky-masked radial blur from the sun)
 *     → UnrealBloomPass (warm-tinted large mips = film halation)
 *     → OutputPass (AgX tone mapping + sRGB)
 *     → Grade (CDL, split tone, vignette, grain, letterbox, fades)
 */
export class PostFX {
  constructor(engine, grade = 'starbaseDawn') {
    this.engine = engine;
    const { renderer, quality } = engine;
    const size = renderer.getDrawingBufferSize(new Vector2());

    const rt = new WebGLRenderTarget(size.x, size.y, {
      type: HalfFloatType,
      samples: quality.msaa,
      // each layer's depth stays readable for screen-space effects (AOEffect)
      depthTexture: new DepthTexture(size.x, size.y),
    });
    rt.texture.name = 'Composer.rt';
    this.composer = new EffectComposer(renderer, rt);

    this.worldPass = new WorldPass(engine);
    this.composer.addPass(this.worldPass);

    this.shafts = new LightShaftsPass({ samples: quality.shaftSamples, scale: 0.5 });
    this.shafts.enabled = false;
    this.composer.addPass(this.shafts);

    this.bloom = new UnrealBloomPass(new Vector2(size.x * quality.bloomScale, size.y * quality.bloomScale), 0.5, 0.6, 1.0);
    // Halation: the wide mips bleed slightly red-orange like light scattering in film emulsion.
    this.bloom.bloomTintColors[2].set(1.0, 0.92, 0.84);
    this.bloom.bloomTintColors[3].set(1.0, 0.82, 0.7);
    this.bloom.bloomTintColors[4].set(1.0, 0.74, 0.6);
    this.composer.addPass(this.bloom);

    this.output = new OutputPass();
    this.composer.addPass(this.output);

    this.gradePass = new ShaderPass(GradeShader);
    this.composer.addPass(this.gradePass);
    this.grade = this.gradePass.uniforms;

    /** Tweenable proxy for the grade preset (GSAP animates these plain numbers). */
    this.look = flattenGrade(GRADES[grade]);
    this.applyLook();

    /** Sun (world direction) used for the light-shaft origin. */
    this.sun = { dir: new Vector3(1, 0.1, 0), camera: null, intensity: 0 };
  }

  setSize(width, height, pixelRatio) {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    this.grade.uResolution.value.set(width * pixelRatio, height * pixelRatio);
    this.bloom.setSize(width * pixelRatio * this.engine.quality.bloomScale, height * pixelRatio * this.engine.quality.bloomScale);
  }

  /** Crossfade to a named grade over `duration` seconds. Returns the tween. */
  toGrade(name, duration = 2, ease = 'sine.inOut') {
    const target = flattenGrade(GRADES[name]);
    if (duration <= 0) {
      Object.assign(this.look, target);
      this.applyLook();
      return null;
    }
    return gsap.to(this.look, { ...target, duration, ease, onUpdate: () => this.applyLook() });
  }

  applyLook() {
    const L = this.look;
    const g = this.grade;
    g.uLift.value.setRGB(L.liftR, L.liftG, L.liftB);
    g.uGamma.value.setRGB(L.gammaR, L.gammaG, L.gammaB);
    g.uGain.value.setRGB(L.gainR, L.gainG, L.gainB);
    g.uContrast.value = L.contrast;
    g.uSaturation.value = L.saturation;
    g.uShadowTint.value.setRGB(L.shR, L.shG, L.shB);
    g.uHighlightTint.value.setRGB(L.hiR, L.hiG, L.hiB);
    g.uSplit.value = L.split;
    g.uVignette.value = L.vignette;
    g.uGrain.value = L.grain;
    this.bloom.strength = L.bloomStrength;
    this.bloom.radius = L.bloomRadius;
    this.bloom.threshold = L.bloomThreshold;
    this.engine.renderer.toneMappingExposure = L.exposure;
  }

  render(dt, time) {
    this.grade.uTime.value = time;
    this._updateShafts();
    this.composer.render(dt);
  }

  /** Project the active sun into screen space and fade rays when it leaves the frame. */
  _updateShafts() {
    const s = this.shafts;
    const cam = this.sun.camera || this.engine.camera;
    if (!this.engine.quality.shafts || this.sun.intensity <= 0.001) {
      s.enabled = false;
      return;
    }
    _v.copy(this.sun.dir).normalize();
    const camDir = cam.getWorldDirection(new Vector3());
    const facing = camDir.dot(_v);
    _v.multiplyScalar(1000).add(cam.getWorldPosition(new Vector3())).project(cam);
    const onScreen = 1 - Math.min(1, Math.max(0, Math.max(Math.abs(_v.x), Math.abs(_v.y)) - 1.0) / 0.9);
    const visibility = Math.max(0, Math.min(1, (facing - 0.05) / 0.35)) * onScreen;
    s.sunUv.set(_v.x * 0.5 + 0.5, _v.y * 0.5 + 0.5);
    s.intensity = this.sun.intensity * visibility;
    s.enabled = s.intensity > 0.002;
  }
}

function flattenGrade(g) {
  return {
    exposure: g.exposure,
    liftR: g.lift[0],
    liftG: g.lift[1],
    liftB: g.lift[2],
    gammaR: g.gamma[0],
    gammaG: g.gamma[1],
    gammaB: g.gamma[2],
    gainR: g.gain[0],
    gainG: g.gain[1],
    gainB: g.gain[2],
    contrast: g.contrast,
    saturation: g.saturation,
    shR: g.shadowTint[0],
    shG: g.shadowTint[1],
    shB: g.shadowTint[2],
    hiR: g.highlightTint[0],
    hiG: g.highlightTint[1],
    hiB: g.highlightTint[2],
    split: g.split,
    vignette: g.vignette,
    grain: g.grain,
    bloomStrength: g.bloomStrength,
    bloomRadius: g.bloomRadius,
    bloomThreshold: g.bloomThreshold,
  };
}
