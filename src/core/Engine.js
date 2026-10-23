import * as THREE from 'three';
import gsap from 'gsap';
import { PostFX } from '../render/PostFX.js';
import { detectQuality, FLAGS, QUALITY_TIERS } from '../config.js';

/**
 * Engine — renderer, camera, post chain, frame loop.
 *
 * The loop is driven by gsap.ticker so every GSAP tween (camera moves, grades,
 * hand reaches) is evaluated BEFORE the frame renders — no one-frame lag between
 * the timeline and the image.
 */
export class Engine {
  constructor(canvas, { logDepth = false, near = 0.05, far = 15000, grade = 'starbaseDawn' } = {}) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // MSAA lives on the composer's render target instead
      alpha: false,
      stencil: false,
      powerPreference: 'high-performance',
      // Planet-scale worlds (a glove 5 cm from the eye, a horizon 300 km away)
      // need a logarithmic depth buffer; the film's two-layer stage does not.
      logarithmicDepthBuffer: logDepth,
    });
    this.quality = detectQuality(this.renderer);
    const r = this.renderer;
    r.toneMapping = THREE.AgXToneMapping;
    r.toneMappingExposure = 1;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.setClearColor(0x000000, 0);
    r.info.autoReset = false;

    // Near plane 5 cm: gloves can come within a hand's width of the eye.
    this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, near, far);
    this.camera.name = 'Eyes';

    this.pmrem = new THREE.PMREMGenerator(r);
    this.post = new PostFX(this, grade);
    this.stage = null;
    this.updaters = new Set();
    this.time = 0;
    this.paused = false;
    this.fps = 60;
    /** Dynamic resolution: multiplies the pixel ratio (a game's frame-rate guard sets it). */
    this.resScale = 1;
    this.useFx = !FLAGS.noFx;

    this._tick = this._tick.bind(this);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  setQuality(name) {
    const q = QUALITY_TIERS[name];
    if (!q || q === this.quality) return;
    this.quality = q;
    this.resize();
    if (this.onQualityChange) this.onQualityChange(q);
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    let pr = Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio);
    pr = Math.min(pr, Math.sqrt(this.quality.maxPixels / (w * h))) * this.resScale;
    pr = Math.max(0.6, pr);
    this.pixelRatio = pr;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.stage && this.stage.farCamera) {
      this.stage.farCamera.aspect = w / h;
      this.stage.farCamera.updateProjectionMatrix();
    }
    this.post.setSize(w, h, pr);
    if (this.onResize) this.onResize(w, h);
  }

  /** stage = { near: Scene, far?: Scene, farCamera?: PerspectiveCamera, sync?: fn } */
  setStage(stage) {
    this.stage = stage;
    if (stage.farCamera) {
      stage.farCamera.aspect = this.camera.aspect;
      stage.farCamera.updateProjectionMatrix();
    }
    this.post.sun.camera = stage.farCamera && stage.sunInFar ? stage.farCamera : null;
  }

  addUpdater(fn) {
    this.updaters.add(fn);
    return () => this.updaters.delete(fn);
  }

  start() {
    gsap.ticker.lagSmoothing(250, 33);
    gsap.ticker.add(this._tick);
  }

  setPaused(v) {
    this.paused = v;
    if (v) gsap.globalTimeline.pause();
    else gsap.globalTimeline.resume();
  }

  _tick(_time, deltaMs) {
    if (this.paused) return;
    const dt = Math.min(deltaMs / 1000, 1 / 20);
    this.time += dt;
    this.fps = this.fps * 0.95 + (dt > 0 ? 1 / dt : 60) * 0.05;
    for (const fn of this.updaters) fn(dt, this.time);

    const stage = this.stage;
    if (stage && stage.sync) stage.sync(this.camera, dt);
    if (stage && stage.farCamera && stage.farCamera.fov !== this.camera.fov) {
      stage.farCamera.fov = this.camera.fov;
      stage.farCamera.updateProjectionMatrix();
    }

    this.renderer.info.reset();
    if (this.useFx) {
      this.post.render(dt, this.time);
    } else {
      const r = this.renderer;
      r.setRenderTarget(null);
      r.autoClear = false;
      r.clear();
      if (stage && stage.far && stage.farCamera) {
        r.render(stage.far, stage.farCamera);
        r.clearDepth();
      }
      if (stage && stage.near) r.render(stage.near, this.camera);
      r.autoClear = true;
    }
  }
}
