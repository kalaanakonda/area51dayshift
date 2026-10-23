import { Pass } from 'three/addons/postprocessing/Pass.js';

/**
 * WorldPass — renders a two-layer "stage".
 *
 *   far  : planets, sky, the Starbase pad seen from orbit-bound windows, Mars
 *          from altitude. Rendered with its own camera (km-scale clip planes).
 *   near : the set the player physically occupies — cabin, hands, tanker ship.
 *
 * Depth is cleared between the two, so a 5 cm glove and a 6,371 km planet both
 * get full depth precision. Exterior scenes simply leave `far` empty.
 */
export class WorldPass extends Pass {
  constructor(engine) {
    super();
    this.engine = engine;
    this.needsSwap = false;
    this.clear = true;
    /** Screen effects on the far layer only ({ enabled, render(renderer, target, camera) }), drawn before the near layer. */
    this.farEffects = [];
    /** The same, for the near layer (run after it is drawn, with the near camera). */
    this.nearEffects = [];
  }

  render(renderer, writeBuffer, readBuffer) {
    const stage = this.engine.stage;
    const target = this.renderToScreen ? null : readBuffer;
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(target);
    // Alpha 0 everywhere we do not draw = "sky" for the light-shaft mask.
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);

    if (stage) {
      if (stage.far && stage.farCamera) {
        renderer.render(stage.far, stage.farCamera);
        if (target) for (const fx of this.farEffects) if (fx.enabled) fx.render(renderer, target, stage.farCamera);
        renderer.clearDepth();
      }
      if (stage.near) {
        renderer.render(stage.near, this.engine.camera);
        if (target) for (const fx of this.nearEffects) if (fx.enabled) fx.render(renderer, target, this.engine.camera);
      }
    }
    renderer.autoClear = prevAutoClear;
  }
}
