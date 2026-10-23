import { AnimationMixer, Group, LoopRepeat, MathUtils, Quaternion, Vector3 } from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

/**
 * Hangar crew. Real rigged, animated people: Microsoft Rocketbox avatars
 * (MIT) — Army soldiers on the doors and on the apron, base security on
 * patrol and briefing at the ground power unit, a scientist at the flight
 * test consoles, a technician in hi-vis looking over the hull. Clips: idle,
 * look (around), talk (gesturing), walk. If a file is missing, the three.js
 * Soldier stands in.
 *
 * Each person: a looping clip or a patrol, a subtle look-at toward the player
 * when close (head bone layered on top of the clip), distance-based updates.
 */
const ROSTER = [
  { slot: 'soldier', at: [-16.5, -22.5], yaw: 2.7, clip: 'idle' },
  { slot: 'soldier', at: [17.0, -22.0], yaw: -2.5, clip: 'look' },
  { slot: 'soldier', at: [11.5, -34.0], yaw: 3.1, clip: 'idle', outside: true },
  { slot: 'security', at: [0, 0], yaw: 0, clip: 'walk', path: [[-11, 9], [11, 9], [11, -12], [-11, -12]], speed: 1.05 },
  { slot: 'security', at: [-6.2, 4.4], yaw: -2.2, clip: 'talk' },
  { slot: 'soldier', at: [-7.4, 3.5], yaw: 0.93, clip: 'idle' },
  // standing beside the chair at the 'track' console, reading the screens toward the saucer
  { slot: 'scientist', at: [-21.57, 7.84], yaw: 2.03, clip: 'idle' },
  // east side of the hull, clear of the ramp path and the boarding stairs
  { slot: 'technician', at: [7.8, -3.5], yaw: -1.38, clip: 'look' },
  // on the apron in front of the doors
  { slot: 'soldierF', at: [-14, -31], yaw: Math.PI / 2, clip: 'walk', path: [[-14, -31], [14, -31]], speed: 1.2, outside: true },
];

// Ground speed of each rig's walk clip (m/s), so feet don't skate.
const WALK_SPEED = { soldier: 1.01, security: 1.01, scientist: 1.01, technician: 1.01, soldierF: 1.21, guard: 1.25 };

const _v = new Vector3();
const _axis = new Vector3();
const _q = new Quaternion();
const _pq = new Quaternion();

export class Crew {
  constructor(assets, hangar) {
    this.assets = assets;
    this.hangar = hangar;
    this.group = new Group();
    this.group.name = 'crew';
    this.people = [];
    this.ready = false;
  }

  async load() {
    const rigs = {};
    await Promise.all(
      [...new Set(ROSTER.map((r) => r.slot))].map(async (slot) => {
        let kind = slot;
        let gltf = await this.assets.gltf(slot);
        if (!gltf) {
          kind = 'guard';
          gltf = await this.assets.gltf('guard');
        }
        if (gltf) rigs[slot] = { gltf, kind, clips: Object.fromEntries(gltf.animations.map((a) => [a.name.toLowerCase(), a])) };
      })
    );
    if (!Object.keys(rigs).length) return false;
    for (const [i, r] of ROSTER.entries()) {
      const rig = rigs[r.slot];
      if (!rig) continue;
      const model = SkeletonUtils.clone(rig.gltf.scene);
      model.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
          o.frustumCulled = false;
          if (o.material && o.material.isMeshStandardMaterial) {
            o.material = o.material.clone();
            o.material.envMapIntensity = 0.8;
            this.hangar.interior.push(o.material);
          }
        }
      });
      const root = new Group();
      root.name = `crew:${r.slot}:${r.clip}`;
      root.add(model);
      root.position.set(r.at[0], 0, r.at[1]);
      root.rotation.y = r.yaw;
      this.group.add(root);
      const mixer = new AnimationMixer(model);
      const clip = rig.clips[r.clip] || rig.clips.idle;
      const action = clip ? mixer.clipAction(clip) : null;
      if (action) {
        action.setLoop(LoopRepeat, Infinity);
        action.play();
        action.time = (i * 1.37) % clip.duration;
        action.timeScale = r.path ? 1 : 0.92 + (i % 3) * 0.06;
      }
      let head = null;
      model.traverse((o) => {
        if (o.isBone && /head$/i.test(o.name) && !head) head = o;
      });
      const walkSpeed = WALK_SPEED[rig.kind] ?? 1.1;
      this.people.push({ root, model, mixer, action, head, def: r, walkSpeed, seg: 0, segT: 0, look: 0, outside: !!r.outside });
    }
    this.ready = true;
    return true;
  }

  /** player: hangar-local position (or null when flying). */
  update(dt, player, eyeWorld) {
    if (!this.ready) return;
    for (const p of this.people) {
      const d = player ? _v.set(p.root.position.x - player.x, 0, p.root.position.z - player.z).length() : 99;
      if (d > 140 && !eyeWorld) continue;
      if (p.def.path) this._patrol(p, dt, player);
      p.mixer.update(dt);
      // Look toward the player when close: turn the head about the body's
      // vertical, expressed in the neck's frame (Biped bone axes aren't Y-up).
      if (p.head && player) {
        const want = d < 7 ? 1 : 0;
        p.look = MathUtils.damp(p.look, want, 3, dt);
        if (p.look > 0.01) {
          const local = p.root.worldToLocal(_v.set(player.x, 1.6, player.z).applyMatrix4(this.group.matrixWorld));
          const yaw = MathUtils.clamp(Math.atan2(local.x, local.z), -1.0, 1.0) * p.look;
          const parent = p.head.parent;
          parent.updateWorldMatrix(true, false);
          parent.getWorldQuaternion(_pq).invert();
          p.root.getWorldQuaternion(_q);
          _axis.set(0, 1, 0).applyQuaternion(_q).applyQuaternion(_pq).normalize();
          p.head.quaternion.premultiply(_q.setFromAxisAngle(_axis, yaw * 0.8));
        }
      }
    }
  }

  _patrol(p, dt, player) {
    const path = p.def.path;
    const a = path[p.seg % path.length];
    const b = path[(p.seg + 1) % path.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    // Pause politely if the player stands in the way.
    let speed = p.def.speed;
    if (player) {
      const dx = player.x - p.root.position.x;
      const dz = player.z - p.root.position.z;
      const ahead = dx * Math.sin(p.root.rotation.y) + dz * Math.cos(p.root.rotation.y);
      if (ahead > 0 && ahead < 2.2 && Math.hypot(dx, dz) < 2.4) speed = 0;
    }
    if (p.action) p.action.timeScale = speed / p.walkSpeed;
    p.segT += (speed * dt) / len;
    if (p.segT >= 1) {
      p.segT = 0;
      p.seg++;
    }
    const k = p.segT;
    p.root.position.set(a[0] + (b[0] - a[0]) * k, 0, a[1] + (b[1] - a[1]) * k);
    const yaw = Math.atan2(b[0] - a[0], b[1] - a[1]);
    let dy = yaw - p.root.rotation.y;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    p.root.rotation.y += dy * Math.min(1, dt * 5);
  }

  colliders() {
    return this.people.map((p) => ({ type: 'circle', x: p.root.position.x, z: p.root.position.z, r: 0.42, dynamic: true }));
  }
}
