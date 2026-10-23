import {
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
} from 'three';
import { lerp } from '../core/math.js';
import { quatFromDirUp } from '../player/handModel.js';
import { labelTexture } from '../procedural/textures.js';

/**
 * Physical controls. Every control follows the BlendKit node contract:
 *   root ─ pivot_* (moves with `value`) ─ grip geometry ─ socket_* (hand target)
 * so a GLB with the same names can replace the procedural build 1:1
 * (see Control.fromGLB). `value` runs 0 → 1; `highlight` 0 → 1 pulses the
 * indicator/edge so a beat's target reads without any HUD arrow.
 *
 * All controls are authored facing +Z (toward the operator), +Y up.
 */
export class Control {
  constructor(name) {
    this.root = new Group();
    this.root.name = name;
    this.value = 0;
    this.highlight = 0;
    this.sockets = {};
    this._glow = [];
    this._detents = 0;
    this._lastDetent = 0;
    this.onDetent = null;
  }

  set(v) {
    this.value = Math.min(1, Math.max(0, v));
    this._apply(this.value);
    if (this._detents && this.onDetent) {
      const d = Math.floor(this.value * this._detents + 1e-4);
      if (d !== this._lastDetent) {
        this._lastDetent = d;
        this.onDetent(d);
      }
    }
  }

  _apply() {}

  update(dt, t) {
    const pulse = this.highlight * (0.55 + 0.45 * Math.sin(t * 5.5));
    for (const { mat, base, peak } of this._glow) mat.emissiveIntensity = base + (peak - base) * pulse;
  }

  socket(name) {
    return this.sockets[name];
  }

  _addSocket(name, parent, pos, fingers, back) {
    const o = new Object3D();
    o.name = name;
    o.position.copy(pos);
    o.quaternion.copy(quatFromDirUp(fingers, back));
    parent.add(o);
    this.sockets[name] = o;
    return o;
  }

  /** Replace the procedural meshes with a GLB that follows the naming contract. */
  static adoptGLB(control, gltfScene) {
    const map = {};
    gltfScene.traverse((o) => (map[o.name] = o));
    for (const name of Object.keys(control.sockets)) if (map[name]) control.sockets[name] = map[name];
    if (control.pivotName && map[control.pivotName]) control.pivot = map[control.pivotName];
    control.root.clear();
    control.root.add(gltfScene);
    return control;
  }
}

const panelMat = () => new MeshStandardMaterial({ color: 0x2c3036, metalness: 0.35, roughness: 0.55 });
const rubber = () => new MeshStandardMaterial({ color: 0x151515, roughness: 0.85 });
const metal = () => new MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.9, roughness: 0.3 });

/** T-handle lever rotating about local X. Pulling toward the operator = value ↑. */
export class Lever extends Control {
  constructor({ name = 'ctrl_lever', min = -0.6, max = 0.55, length = 0.2, label = null } = {}) {
    super(name);
    this.pivotName = 'pivot_lever';
    this.min = min;
    this.max = max;
    const base = new Mesh(new BoxGeometry(0.07, 0.03, 0.16), panelMat());
    this.root.add(base);
    const slot = new Mesh(new BoxGeometry(0.018, 0.031, 0.12), new MeshStandardMaterial({ color: 0x050505 }));
    this.root.add(slot);
    this.pivot = new Object3D();
    this.pivot.name = 'pivot_lever';
    this.pivot.position.y = 0.012;
    this.root.add(this.pivot);
    const shaft = new Mesh(new CylinderGeometry(0.008, 0.01, length, 12), metal());
    shaft.position.y = length / 2;
    this.pivot.add(shaft);
    const grip = new Mesh(new CylinderGeometry(0.017, 0.017, 0.11, 16), rubber());
    grip.rotation.z = Math.PI / 2;
    grip.position.y = length;
    this.pivot.add(grip);
    const capMat = new MeshStandardMaterial({ color: 0x7a1d12, emissive: new Color(1, 0.35, 0.1), emissiveIntensity: 0.0 });
    for (const sx of [-1, 1]) {
      const cap = new Mesh(new CylinderGeometry(0.019, 0.019, 0.012, 16), capMat);
      cap.rotation.z = Math.PI / 2;
      cap.position.set(sx * 0.058, length, 0);
      this.pivot.add(cap);
    }
    this._glow.push({ mat: capMat, base: 0.0, peak: 2.5 });
    // Overhand grip on the T-bar: fingers wrap over the bar away from the operator.
    this._addSocket('socket_grip_R', this.pivot, new Vector3(0.012, length + 0.032, 0.006), new Vector3(-0.15, -0.35, -1), new Vector3(0.05, 0.94, -0.33));
    if (label) {
      const plate = new Mesh(new PlaneGeometry(0.1, 0.022), new MeshStandardMaterial({ map: labelTexture(label, { w: 256, h: 56 }), roughness: 0.6 }));
      plate.rotation.x = -Math.PI / 2;
      plate.position.set(0, 0.016, 0.1);
      this.root.add(plate);
    }
    this.set(0);
  }

  _apply(v) {
    this.pivot.rotation.x = lerp(this.min, this.max, v);
  }
}

/** Rotary selector with detents. Clockwise as value rises. */
export class Dial extends Control {
  constructor({ name = 'ctrl_dial', sweep = 2.35, detents = 6, labels = null } = {}) {
    super(name);
    this.pivotName = 'pivot_dial';
    this.sweep = sweep;
    this._detents = detents;
    const ring = new Mesh(new CylinderGeometry(0.042, 0.046, 0.008, 32), panelMat());
    ring.rotation.x = Math.PI / 2;
    this.root.add(ring);
    // Engraved scale (canvas)
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#2c3036';
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = '#d8d4cc';
    g.lineWidth = 4;
    for (let i = 0; i <= detents; i++) {
      const a = -Math.PI / 2 - sweep / 2 + (i / detents) * sweep;
      g.beginPath();
      g.moveTo(128 + Math.cos(a) * 100, 128 + Math.sin(a) * 100);
      g.lineTo(128 + Math.cos(a) * 122, 128 + Math.sin(a) * 122);
      g.stroke();
    }
    if (labels) {
      g.fillStyle = '#d8d4cc';
      g.font = '500 22px "IBM Plex Mono", monospace';
      g.textAlign = 'center';
      g.fillText(labels[0], 70, 236);
      g.fillText(labels[1], 186, 236);
    }
    const tex = new CanvasTexture(c);
    tex.colorSpace = SRGBColorSpace;
    const face = new Mesh(new PlaneGeometry(0.1, 0.1), new MeshStandardMaterial({ map: tex, roughness: 0.6 }));
    face.position.z = 0.0045;
    this.root.add(face);
    this.pivot = new Object3D();
    this.pivot.name = 'pivot_dial';
    this.pivot.position.z = 0.005;
    this.root.add(this.pivot);
    const knob = new Mesh(new CylinderGeometry(0.024, 0.027, 0.026, 24), rubber());
    knob.rotation.x = Math.PI / 2;
    knob.position.z = 0.013;
    this.pivot.add(knob);
    const pointerMat = new MeshStandardMaterial({ color: 0xffffff, emissive: new Color(1, 0.6, 0.2), emissiveIntensity: 0.2 });
    const pointer = new Mesh(new BoxGeometry(0.004, 0.026, 0.003), pointerMat);
    pointer.position.set(0, 0.012, 0.027);
    this.pivot.add(pointer);
    this._glow.push({ mat: pointerMat, base: 0.2, peak: 3 });
    // Pinch: thumb + index on the knob rim, fingers pointing down-forward.
    this._addSocket('socket_pinch_R', this.pivot, new Vector3(0.003, 0.0, 0.03), new Vector3(0, 0.15, -1), new Vector3(0.0, 1, 0.12));
    this.set(0);
  }

  _apply(v) {
    this.pivot.rotation.z = this.sweep / 2 - v * this.sweep;
  }
}

/** Guarded toggle: value 0..0.5 lifts the guard, 0.5..1 throws the switch. */
export class GuardedToggle extends Control {
  constructor({ name = 'ctrl_toggle', guard = true, color = 0xb3261e, label = null } = {}) {
    super(name);
    const base = new Mesh(new BoxGeometry(0.04, 0.05, 0.012), panelMat());
    this.root.add(base);
    this.toggle = new Object3D();
    this.toggle.name = 'pivot_toggle';
    this.toggle.position.z = 0.006;
    this.root.add(this.toggle);
    const bat = new Mesh(new CylinderGeometry(0.0035, 0.0045, 0.026, 10), metal());
    bat.rotation.x = Math.PI / 2;
    bat.position.z = 0.013;
    this.toggle.add(bat);
    this.hasGuard = guard;
    if (guard) {
      this.guardPivot = new Object3D();
      this.guardPivot.name = 'pivot_guard';
      this.guardPivot.position.set(0, 0.022, 0.006);
      this.root.add(this.guardPivot);
      const gm = new MeshStandardMaterial({ color, roughness: 0.4, transparent: true, opacity: 0.85, emissive: new Color(color), emissiveIntensity: 0.1 });
      const cover = new Mesh(new BoxGeometry(0.03, 0.044, 0.026), gm);
      cover.position.set(0, -0.022, 0.014);
      this.guardPivot.add(cover);
      this._glow.push({ mat: gm, base: 0.1, peak: 1.6 });
    }
    this.lamp = new MeshStandardMaterial({ color: 0x220000, emissive: new Color(1, 0.12, 0.05), emissiveIntensity: 2.5 });
    const led = new Mesh(new CylinderGeometry(0.004, 0.004, 0.004, 10), this.lamp);
    led.rotation.x = Math.PI / 2;
    led.position.set(0, -0.034, 0.008);
    this.root.add(led);
    if (label) {
      const plate = new Mesh(new PlaneGeometry(0.05, 0.012), new MeshStandardMaterial({ map: labelTexture(label, { w: 256, h: 60 }), roughness: 0.6 }));
      plate.position.set(0, 0.04, 0.007);
      this.root.add(plate);
    }
    // Index fingertip on the bat (or the guard lip), fingers pointing up-in.
    this._addSocket('socket_tip_R', this.root, new Vector3(0, -0.004, 0.03), new Vector3(0, 0.35, -1), new Vector3(0, 1, 0.3));
    this.set(0);
  }

  _apply(v) {
    const g = this.hasGuard ? Math.min(1, v / 0.45) : 1;
    const s = this.hasGuard ? Math.max(0, (v - 0.55) / 0.45) : v;
    if (this.guardPivot) this.guardPivot.rotation.x = -g * 1.75;
    this.toggle.rotation.x = lerp(0.45, -0.45, s);
    // The fingertip follows the moving part (guard lip, then the bat tip).
    const sock = this.sockets.socket_tip_R;
    if (sock) {
      if (this.hasGuard && v < 0.5) sock.position.set(0, -0.004 + g * 0.02, 0.03 + g * 0.012);
      else sock.position.set(0, -0.004 + s * 0.012, 0.03);
    }
    this.lamp.emissive.setRGB(s > 0.95 ? 0.1 : 1, s > 0.95 ? 1 : 0.12, s > 0.95 ? 0.3 : 0.05);
  }
}

/** Big illuminated push button (TMI commit, elevator). value 0→1 = pressed travel. */
export class PushButton extends Control {
  constructor({ name = 'ctrl_button', color = new Color(1, 0.45, 0.12), label = null, radius = 0.022 } = {}) {
    super(name);
    const collar = new Mesh(new CylinderGeometry(radius * 1.45, radius * 1.55, 0.012, 28), panelMat());
    collar.rotation.x = Math.PI / 2;
    this.root.add(collar);
    this.pivot = new Object3D();
    this.pivot.name = 'pivot_button';
    this.root.add(this.pivot);
    this.capMat = new MeshStandardMaterial({ color: 0x111111, emissive: color.clone(), emissiveIntensity: 0.6, roughness: 0.35 });
    const cap = new Mesh(new CylinderGeometry(radius, radius, 0.014, 28), this.capMat);
    cap.rotation.x = Math.PI / 2;
    cap.position.z = 0.01;
    this.pivot.add(cap);
    this._glow.push({ mat: this.capMat, base: 0.6, peak: 4.5 });
    if (label) {
      const plate = new Mesh(new PlaneGeometry(radius * 3.4, radius * 0.8), new MeshStandardMaterial({ map: labelTexture(label, { w: 256, h: 60 }), roughness: 0.6 }));
      plate.position.set(0, -radius * 2.1, 0.0065);
      this.root.add(plate);
    }
    this._addSocket('socket_tip_R', this.pivot, new Vector3(0, -0.002, 0.019), new Vector3(0, 0.6, -1), new Vector3(0, 1, 0.5));
    this.set(0);
  }

  _apply(v) {
    const press = v < 0.5 ? v * 2 : (1 - v) * 2; // in and back out
    this.pivot.position.z = -press * 0.006;
  }
}

/** Two-hand rotating hatch handle on a hinged door (Scene 5). */
export class HatchHandle extends Control {
  constructor({ name = 'ctrl_hatch_handle', radius = 0.55 } = {}) {
    super(name);
    this.door = new Object3D();
    this.door.name = 'pivot_hatch_door';
    this.door.position.x = -radius; // hinge on the left edge
    this.root.add(this.door);
    const doorMat = new MeshStandardMaterial({ color: 0xb9bbbd, metalness: 0.9, roughness: 0.34 });
    const panel = new Mesh(new CylinderGeometry(radius, radius, 0.09, 48), doorMat);
    panel.rotation.x = Math.PI / 2;
    panel.position.x = radius;
    this.door.add(panel);
    const seal = new Mesh(new TorusGeometry(radius, 0.025, 10, 64), rubber());
    seal.position.set(radius, 0, 0.03);
    this.door.add(seal);
    this.pivot = new Object3D();
    this.pivot.name = 'pivot_hatch_handle';
    this.pivot.position.set(radius, 0, 0.07);
    this.door.add(this.pivot);
    const hub = new Mesh(new CylinderGeometry(0.06, 0.06, 0.05, 24), metal());
    hub.rotation.x = Math.PI / 2;
    this.pivot.add(hub);
    const bar = new Mesh(new BoxGeometry(0.62, 0.05, 0.035), metal());
    bar.position.z = 0.03;
    this.pivot.add(bar);
    const gripMat = new MeshStandardMaterial({ color: 0x1d1d1d, roughness: 0.8, emissive: new Color(1, 0.5, 0.2), emissiveIntensity: 0 });
    for (const sx of [-1, 1]) {
      const grip = new Mesh(new CylinderGeometry(0.02, 0.02, 0.12, 16), gripMat);
      grip.rotation.x = Math.PI / 2;
      grip.position.set(sx * 0.27, 0, 0.09);
      this.pivot.add(grip);
    }
    this._glow.push({ mat: gripMat, base: 0, peak: 1.2 });
    // Grips stand off the bar toward the operator; hands come in from the sides.
    this._addSocket('socket_grip_R', this.pivot, new Vector3(0.27, 0.0, 0.11), new Vector3(-0.2, 0.0, -1), new Vector3(0.95, 0.0, 0.2));
    this._addSocket('socket_grip_L', this.pivot, new Vector3(-0.27, 0.0, 0.11), new Vector3(0.2, 0.0, -1), new Vector3(-0.95, 0.0, 0.2));
    this.doorOpen = 0;
    this.set(0);
  }

  _apply(v) {
    this.pivot.rotation.z = -v * (Math.PI / 2);
  }

  setOpen(o) {
    this.doorOpen = o;
    this.door.rotation.y = -o * 1.8;
  }
}
