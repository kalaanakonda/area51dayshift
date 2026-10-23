import { SceneBase } from './SceneBase.js';

/** Temporary stub — replaced by the full scene. */
export class Scene4Landing extends SceneBase {
  constructor(ctx) {
    super(ctx, 'IV · Landing');
  }

  direct(s) {
    s.fade(0, 0, 0);
    s.call(1.5, () => {});
  }
}
