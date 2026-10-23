import { Scene } from 'three';

/**
 * Base class for the five chapters.
 *
 *   build()    construct (or load) the set — runs during the loading screen
 *   stage()    { near, far?, farCamera?, sync?, sunInFar? } for the WorldPass
 *   enter()    put the player in the set, reset state, choose the grade/beds
 *   direct(s)  author the timeline through the Script DSL
 *   update()   per-frame simulation (VFX, workers, screens)
 *   exit()     release the player rig and stop anything looping
 */
export class SceneBase {
  constructor(ctx, label) {
    this.ctx = ctx;
    this.label = label;
    this.near = new Scene();
    this.near.name = label;
    this.far = null;
    this.farCamera = null;
  }

  async build() {}

  stage() {
    return { near: this.near, far: this.far, farCamera: this.farCamera, sync: this.sync?.bind(this), sunInFar: !!this.sunInFar };
  }

  enter() {}

  direct() {}

  update() {}

  exit() {}

  /** Re-parent the shared player body (hands, held props) into this set. */
  attachPlayer() {
    const { rig } = this.ctx;
    this.near.add(rig.body);
  }
}

/** Let the browser breathe between heavy procedural steps (keeps the loader animating). */
export const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
