import { CanvasTexture, Color, Group, LinearFilter, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, PlaneGeometry, PointLight, SRGBColorSpace, Vector3 } from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { quatFromDirUp } from '../player/handModel.js';

/**
 * The phone in Scene 1: a ruggedised handset held in landscape.
 * Local frame: +X right, +Y up, +Z out of the screen toward the eye.
 *
 * Its screen is a live canvas: a 28-second motion-graphics film (reusable
 * rockets → Starlink → multiplanetary), then the incoming call UI.
 */
export const PHONE = { w: 0.162, h: 0.078, d: 0.012 };

export function buildPhone() {
  const root = new Group();
  root.name = 'phone';
  const caseMat = new MeshStandardMaterial({ color: 0x17181a, roughness: 0.62, metalness: 0.1 });
  const body = new Mesh(new RoundedBoxGeometry(PHONE.w, PHONE.h, PHONE.d, 4, 0.008), caseMat);
  body.castShadow = true;
  root.add(body);
  const bumper = new Mesh(new RoundedBoxGeometry(PHONE.w + 0.004, PHONE.h + 0.004, PHONE.d * 0.6, 4, 0.01), new MeshStandardMaterial({ color: 0x2b2a27, roughness: 0.8 }));
  root.add(bumper);

  const screen = new PhoneScreen();
  const glass = new Mesh(new PlaneGeometry(PHONE.w - 0.01, PHONE.h - 0.008), new MeshBasicMaterial({ map: screen.texture, toneMapped: true }));
  glass.name = 'screen_phone';
  glass.position.z = PHONE.d / 2 + 0.0004;
  root.add(glass);
  // Glossy cover glass catching the sky
  const cover = new Mesh(
    new PlaneGeometry(PHONE.w - 0.006, PHONE.h - 0.004),
    new MeshStandardMaterial({ color: 0x000000, roughness: 0.06, metalness: 1, transparent: true, opacity: 0.18, depthWrite: false })
  );
  cover.position.z = PHONE.d / 2 + 0.0008;
  root.add(cover);

  // Screen spill on the gloves (the only warm-cold contrast in the opening frame).
  const spill = new PointLight(new Color(0.75, 0.82, 1.0), 0.35, 0.6, 2);
  spill.position.set(0, 0, 0.08);
  root.add(spill);

  // Hand sockets (see manifest: socket_* convention). Fingers wrap behind the
  // short edges, thumbs come round onto the glass.
  const mkSocket = (name, pos, fingers, back) => {
    const o = new Object3D();
    o.name = name;
    o.position.copy(pos);
    o.quaternion.copy(quatFromDirUp(fingers, back));
    root.add(o);
    return o;
  };
  const sockets = {
    gripR: mkSocket('socket_grip_R', new Vector3(0.088, -0.012, -0.012), new Vector3(-0.15, 1, -0.45), new Vector3(1, 0.05, -0.3)),
    gripL: mkSocket('socket_grip_L', new Vector3(-0.088, -0.012, -0.012), new Vector3(0.15, 1, -0.45), new Vector3(-1, 0.05, -0.3)),
    tapR: mkSocket('socket_tip_R_answer', new Vector3(0.082, -0.006, -0.006), new Vector3(-0.2, 1, -0.35), new Vector3(1, 0.05, -0.25)),
  };
  root.userData = { screen, sockets, spill };
  return root;
}

const W = 1024;
const H = 494;

export class PhoneScreen {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.g = this.canvas.getContext('2d');
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.minFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    this.state = 'off';
    this.t = 0;
    this.callT = 0;
    this.voice = 0;
    this._acc = 0;
    this._sats = Array.from({ length: 220 }, (_, i) => ({
      inc: ((i % 5) - 2) * 0.35 + 0.9,
      phase: (i * 2.399) % (Math.PI * 2),
      speed: 0.25 + (i % 7) * 0.012,
      shell: 1.08 + (i % 3) * 0.035,
    }));
    this.draw();
  }

  set(state) {
    this.state = state;
    this.t = 0;
    this._acc = 1;
  }

  update(dt, talking = false) {
    this.t += dt;
    if (this.state === 'call') this.callT += dt;
    this.voice += ((talking ? 1 : 0) - this.voice) * Math.min(1, dt * 8);
    this._acc += dt;
    if (this._acc >= 1 / 30) {
      this._acc = 0;
      this.draw();
      this.texture.needsUpdate = true;
    }
  }

  draw() {
    const g = this.g;
    g.save();
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    if (this.state === 'video') this._video(g, this.t);
    else if (this.state === 'ring') this._ring(g, this.t);
    else if (this.state === 'call') this._call(g, this.t);
    else if (this.state === 'ended') this._ended(g, this.t);
    if (this.state !== 'off') this._statusBar(g);
    g.restore();
  }

  _statusBar(g) {
    g.fillStyle = 'rgba(235,232,225,0.85)';
    g.font = '500 20px "IBM Plex Mono", monospace';
    g.textBaseline = 'top';
    g.textAlign = 'left';
    g.fillText('05:41', 26, 14);
    g.textAlign = 'right';
    g.fillText('STARLINK  ▮▮▮▯   82%', W - 26, 14);
  }

  _text(g, str, x, y, { size = 30, weight = 300, color = '#ebe6dc', align = 'left', spacing = 0, alpha = 1, font = 'Jost' } = {}) {
    g.globalAlpha = Math.max(0, Math.min(1, alpha));
    g.fillStyle = color;
    g.textAlign = align;
    g.textBaseline = 'alphabetic';
    g.font = `${weight} ${size}px "${font}", "Futura", sans-serif`;
    if ('letterSpacing' in g) g.letterSpacing = `${spacing}px`;
    g.fillText(str, x, y);
    if ('letterSpacing' in g) g.letterSpacing = '0px';
    g.globalAlpha = 1;
  }

  /** The 28-second film. Each chapter fades in/out on its own clock. */
  _video(g, t) {
    const fade = (a, b, f = 0.6) => Math.min(1, Math.max(0, (t - a) / f)) * Math.min(1, Math.max(0, (b - t) / f));
    // Thin progress line + "documentary" frame
    g.fillStyle = 'rgba(235,230,220,0.25)';
    g.fillRect(40, H - 34, W - 80, 2);
    g.fillStyle = '#d98a3a';
    g.fillRect(40, H - 34, (W - 80) * Math.min(1, t / 28), 2);

    // I — booster landing
    if (t < 7.4) {
      const a = fade(0, 7.4);
      const land = Math.min(1, t / 5.2);
      const ease = 1 - Math.pow(1 - land, 3);
      const x = W * 0.68;
      const y = 60 + ease * 300;
      g.globalAlpha = a;
      g.strokeStyle = '#ebe6dc';
      g.lineWidth = 3;
      g.strokeRect(x - 11, y - 120, 22, 120);
      g.beginPath();
      g.moveTo(x - 11, y - 120);
      g.lineTo(x, y - 136);
      g.lineTo(x + 11, y - 120);
      g.stroke();
      // grid fins
      g.strokeRect(x - 20, y - 112, 8, 6);
      g.strokeRect(x + 12, y - 112, 8, 6);
      // legs deploy late
      const legs = Math.max(0, Math.min(1, (t - 3.8) / 0.8));
      g.beginPath();
      g.moveTo(x - 10, y - 12);
      g.lineTo(x - 10 - legs * 20, y + legs * 4);
      g.moveTo(x + 10, y - 12);
      g.lineTo(x + 10 + legs * 20, y + legs * 4);
      g.stroke();
      if (land < 1) {
        const fl = 20 + Math.random() * 18;
        const grad = g.createLinearGradient(0, y, 0, y + fl);
        grad.addColorStop(0, 'rgba(255,214,150,1)');
        grad.addColorStop(1, 'rgba(255,120,40,0)');
        g.fillStyle = grad;
        g.beginPath();
        g.moveTo(x - 7, y);
        g.lineTo(x, y + fl);
        g.lineTo(x + 7, y);
        g.fill();
      }
      // pad
      g.strokeStyle = 'rgba(235,230,220,0.6)';
      g.beginPath();
      g.ellipse(x, 364, 70, 9, 0, 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha = 1;
      this._text(g, 'For sixty years, rockets were thrown away.', 70, 190, { size: 34, alpha: fade(0.4, 3.7) });
      this._text(g, 'Then they started coming back.', 70, 190, { size: 34, alpha: fade(4.0, 7.2) });
      this._text(g, 'I · REUSE', 70, 120, { size: 18, font: 'IBM Plex Mono', weight: 400, color: '#d98a3a', spacing: 4, alpha: a });
    }

    // II — again and again
    if (t > 7 && t < 12.4) {
      const a = fade(7, 12.4);
      const n = Math.floor(Math.min(1, (t - 7.3) / 4) ** 1.6 * 420);
      g.fillStyle = `rgba(235,230,220,${0.85 * a})`;
      for (let i = 0; i < n; i++) {
        const cx = 70 + (i % 42) * 21;
        const cy = 170 + Math.floor(i / 42) * 21;
        g.fillRect(cx, cy, 3, 10);
      }
      this._text(g, 'II · AND AGAIN', 70, 120, { size: 18, font: 'IBM Plex Mono', weight: 400, color: '#d98a3a', spacing: 4, alpha: a });
      this._text(g, 'Again. And again. And again.', 70, 420, { size: 34, alpha: fade(7.6, 12.2) });
    }

    // III — Starlink
    if (t > 12 && t < 19.4) {
      const a = fade(12, 19.4);
      const cx = W * 0.7;
      const cy = H * 0.52;
      const R = 150;
      const rot = (t - 12) * 0.22;
      g.globalAlpha = a;
      g.strokeStyle = 'rgba(235,230,220,0.35)';
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(cx, cy, R, 0, Math.PI * 2);
      g.stroke();
      for (let k = 0; k < 8; k++) {
        const lon = rot + (k / 8) * Math.PI;
        g.beginPath();
        g.ellipse(cx, cy, Math.abs(Math.cos(lon)) * R, R, 0, 0, Math.PI * 2);
        g.stroke();
      }
      for (let k = 1; k < 6; k++) {
        const lat = (k / 6) * Math.PI - Math.PI / 2;
        g.beginPath();
        g.ellipse(cx, cy + Math.sin(lat) * R, Math.cos(lat) * R, Math.cos(lat) * R * 0.12, 0, 0, Math.PI * 2);
        g.stroke();
      }
      const shown = Math.floor(Math.min(1, (t - 12.4) / 3) * this._sats.length);
      for (let i = 0; i < shown; i++) {
        const s = this._sats[i];
        const ang = s.phase + (t - 12) * s.speed;
        const x3 = Math.cos(ang);
        const y3 = Math.sin(ang) * Math.sin(s.inc);
        const z3 = Math.sin(ang) * Math.cos(s.inc);
        if (z3 < -0.2 && Math.hypot(x3, y3) < 1) continue;
        const px = cx + x3 * R * s.shell;
        const py = cy + y3 * R * s.shell;
        g.fillStyle = '#ebe6dc';
        g.fillRect(px - 1.5, py - 1.5, 3, 3);
        if (i % 9 === 0 && z3 > 0) {
          g.strokeStyle = 'rgba(217,138,58,0.55)';
          g.beginPath();
          g.moveTo(px, py);
          g.lineTo(cx + x3 * R * 0.97, cy + y3 * R * 0.97);
          g.stroke();
        }
      }
      g.globalAlpha = 1;
      this._text(g, 'III · STARLINK', 70, 120, { size: 18, font: 'IBM Plex Mono', weight: 400, color: '#d98a3a', spacing: 4, alpha: a });
      this._text(g, 'Then the sky filled up — with signal.', 70, 210, { size: 32, alpha: fade(12.5, 15.8) });
      this._text(g, 'Places the map forgot, online.', 70, 210, { size: 32, alpha: fade(16, 19.2) });
    }

    // IV — the next step
    if (t > 19 && t < 28.5) {
      const a = fade(19, 28.5, 0.9);
      const ex = 200;
      const mx = 820;
      const yy = 270;
      const k = Math.min(1, (t - 19.8) / 4.5);
      g.globalAlpha = a;
      g.fillStyle = '#4f86b8';
      g.beginPath();
      g.arc(ex, yy, 18, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#c1673a';
      g.beginPath();
      g.arc(mx, yy, 12, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(235,230,220,0.85)';
      g.setLineDash([8, 9]);
      g.lineWidth = 2;
      g.beginPath();
      const steps = Math.floor(k * 60);
      for (let i = 0; i <= steps; i++) {
        const u = i / 60;
        const px = ex + (mx - ex) * u;
        const py = yy - Math.sin(u * Math.PI) * 150;
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.stroke();
      g.setLineDash([]);
      if (k > 0 && k < 1) {
        const px = ex + (mx - ex) * k;
        const py = yy - Math.sin(k * Math.PI) * 150;
        g.fillStyle = '#d98a3a';
        g.fillRect(px - 3, py - 3, 6, 6);
      }
      g.globalAlpha = 1;
      this._text(g, 'IV · THE NEXT STEP', 70, 120, { size: 18, font: 'IBM Plex Mono', weight: 400, color: '#d98a3a', spacing: 4, alpha: a });
      this._text(g, 'Landing was never the point.', W / 2, 410, { size: 32, align: 'center', alpha: fade(20.2, 23.6) });
      this._text(g, 'It was the way there.', W / 2, 410, { size: 32, align: 'center', alpha: fade(23.8, 26.4) });
      this._text(g, 'MULTIPLANETARY', W / 2, 410, { size: 30, align: 'center', spacing: 14, alpha: fade(26.4, 28.6, 0.5) });
    }
  }

  _ring(g, t) {
    const pulse = (Math.sin(t * 5) * 0.5 + 0.5) * 0.4 + 0.6;
    g.fillStyle = '#0b0c0e';
    g.fillRect(0, 0, W, H);
    this._text(g, 'INCOMING CALL', 70, 150, { size: 18, font: 'IBM Plex Mono', weight: 400, color: '#a7a299', spacing: 5 });
    this._text(g, 'Elon', 70, 236, { size: 74, weight: 300 });
    this._text(g, 'Starbase · secure', 70, 286, { size: 22, font: 'IBM Plex Mono', weight: 400, color: '#7f8890' });
    // Decline / accept — accept sits under the right thumb.
    g.fillStyle = '#5a1d18';
    g.beginPath();
    g.arc(W - 300, 330, 52, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = pulse;
    g.fillStyle = '#2f7d4a';
    g.beginPath();
    g.arc(W - 130, 330, 52 + (1 - pulse) * 22, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
    g.fillStyle = '#3fa362';
    g.beginPath();
    g.arc(W - 130, 330, 52, 0, Math.PI * 2);
    g.fill();
    this._text(g, 'ACCEPT', W - 130, 420, { size: 16, font: 'IBM Plex Mono', weight: 500, align: 'center', spacing: 3, color: '#cfe8d6' });
    this._text(g, 'DECLINE', W - 300, 420, { size: 16, font: 'IBM Plex Mono', weight: 500, align: 'center', spacing: 3, color: '#a7a299' });
  }

  _call(g) {
    g.fillStyle = '#0b0c0e';
    g.fillRect(0, 0, W, H);
    const s = Math.floor(this.callT);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    this._text(g, `CONNECTED · ${mm}:${ss}`, 70, 150, { size: 18, font: 'IBM Plex Mono', weight: 400, color: '#7fbf93', spacing: 4 });
    this._text(g, 'Elon', 70, 236, { size: 74, weight: 300 });
    this._text(g, 'Audio only · low-bandwidth link', 70, 286, { size: 22, font: 'IBM Plex Mono', weight: 400, color: '#7f8890' });
    // Voice waveform: lives when he talks.
    const bars = 46;
    for (let i = 0; i < bars; i++) {
      const n = Math.sin(this.callT * 13 + i * 0.7) * Math.sin(this.callT * 5.3 + i * 1.9) * 0.5 + 0.5;
      const h = 6 + n * 70 * this.voice + 4 * Math.random() * this.voice;
      g.fillStyle = i % 2 ? 'rgba(235,230,220,0.85)' : 'rgba(217,138,58,0.9)';
      g.fillRect(70 + i * 14, 380 - h / 2, 6, h);
    }
  }

  _ended(g, t) {
    g.fillStyle = '#0b0c0e';
    g.fillRect(0, 0, W, H);
    this._text(g, 'CALL ENDED', 70, 150, { size: 18, font: 'IBM Plex Mono', weight: 400, color: '#a7a299', spacing: 5, alpha: Math.max(0, 1 - t / 4) });
    this._text(g, 'Elon', 70, 236, { size: 74, weight: 300, alpha: Math.max(0, 1 - t / 4) });
  }
}
