import { SceneBase } from './SceneBase.js';

/** Temporary stub — replaced by the full scene. */
export class Scene5FirstStep extends SceneBase {
  constructor(ctx) {
    super(ctx, 'V · First Step');
  }

  direct(s) {
    s.fade(0, 0, 0);
    s.call(1.5, () => {});
  }
}
