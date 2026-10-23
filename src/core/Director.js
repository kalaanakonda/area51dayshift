import gsap from 'gsap';
import { Script } from './Script.js';
import { FLAGS } from '../config.js';

/**
 * Director — owns the running order. Builds every scene up front (so no hitch
 * at a cut), then plays them back to back. Each scene authors its own GSAP
 * timeline through the Script DSL; the Director only handles hand-offs,
 * chapter jumps, the end card and the replay.
 */
export class Director {
  constructor(ctx, scenes) {
    this.ctx = ctx;
    this.scenes = scenes;
    this.index = -1;
    this.current = null;
    this.tl = null;
  }

  /** Per-frame simulation of the active scene (called from the main loop). */
  update(dt, t) {
    if (this.current) this.current.update(dt, t);
  }

  async build(onProgress) {
    const n = this.scenes.length;
    for (let i = 0; i < n; i++) {
      await this.scenes[i].build((f, label) => onProgress((i + f) / n, label));
      onProgress((i + 1) / n, this.scenes[i].label);
    }
  }

  /** Pre-compile every scene's shaders so the first frame after a cut is smooth. */
  async warmup(onProgress) {
    const { engine } = this.ctx;
    const r = engine.renderer;
    for (let i = 0; i < this.scenes.length; i++) {
      const st = this.scenes[i].stage();
      // Scenes that swap their far layer mid-timeline list the extra sets here.
      const extra = this.scenes[i].warmTargets ? this.scenes[i].warmTargets() : [];
      try {
        if (st.far && st.farCamera) await r.compileAsync(st.far, st.farCamera);
        if (st.near) await r.compileAsync(st.near, engine.camera);
        for (const [scene, camera] of extra) await r.compileAsync(scene, camera);
      } catch (err) {
        console.warn('[director] shader warmup', err);
      }
      onProgress((i + 1) / this.scenes.length);
    }
  }

  play(index, seek = 0) {
    const { ctx } = this;
    if (this.tl) {
      this.tl.kill();
      this.tl = null;
    }
    ctx.interactions.cancel();
    ctx.ui.clearSay();
    if (this.current) this.current.exit();
    gsap.killTweensOf(ctx.rig.dir);
    gsap.killTweensOf(ctx.rig.look);

    this.index = index;
    const scene = this.scenes[index];
    this.current = scene;
    ctx.engine.setStage(scene.stage());
    scene.enter();
    ctx.rig.cut();

    const tl = gsap.timeline({ paused: true, onComplete: () => this.next() });
    const script = new Script(ctx, tl);
    scene.direct(script);
    this.tl = tl;
    this.script = script;
    if (seek > 0) {
      tl.seek(seek, true);
      ctx.rig.cut();
    }
    tl.play();
    if (this.onSceneChange) this.onSceneChange(scene, index);
  }

  next() {
    if (this.index + 1 < this.scenes.length) this.play(this.index + 1);
    else if (this.onFinished) this.onFinished();
  }

  start() {
    this.play(FLAGS.scene - 1, FLAGS.seek);
  }

  get time() {
    return this.tl ? this.tl.time() : 0;
  }

  get duration() {
    return this.tl ? this.tl.duration() : 0;
  }
}
