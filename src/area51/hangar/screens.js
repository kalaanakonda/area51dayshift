import { CanvasTexture, Color, LinearFilter, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from 'three';

/**
 * Screens in the hangar — canvas pages on emissive quads (MeshBasicMaterial,
 * so they work with the logarithmic depth buffer). Each redraws at ~8 fps.
 */
export class Screen {
  constructor(width, height, res = [512, 288], brightness = 2.2) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = res[0];
    this.canvas.height = res[1];
    this.g = this.canvas.getContext('2d');
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.minFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.anisotropy = 4;
    this.material = new MeshBasicMaterial({ map: this.texture, color: new Color().setScalar(brightness) });
    this.mesh = new Mesh(new PlaneGeometry(width, height), this.material);
    this.mesh.name = 'screen';
    this.draw = null;
    this.fps = 8;
    this._acc = Math.random();
    this.state = {};
  }

  update(dt, t) {
    this._acc += dt;
    if (!this.draw || this._acc < 1 / this.fps) return;
    this._acc = 0;
    const { g, canvas } = this;
    this.draw(g, canvas.width, canvas.height, t, this.state);
    this.texture.needsUpdate = true;
  }
}

const C = {
  bg: '#060a0c',
  panel: '#0c1418',
  line: 'rgba(130,190,200,0.22)',
  text: '#cfe3e6',
  dim: 'rgba(160,190,195,0.55)',
  green: '#6fe3a0',
  amber: '#ffb54a',
  red: '#ff5643',
  cyan: '#62d8ff',
};
const MONO = '"IBM Plex Mono", monospace';
const HUDF = '"Chakra Petch", "IBM Plex Mono", sans-serif';

function header(g, w, h, title, sub) {
  g.fillStyle = C.bg;
  g.fillRect(0, 0, w, h);
  const u = h / 288;
  g.fillStyle = C.panel;
  g.fillRect(0, 0, w, 24 * u);
  g.font = `600 ${13 * u}px ${HUDF}`;
  g.fillStyle = C.text;
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.fillText(title, 10 * u, 12 * u);
  g.textAlign = 'right';
  g.fillStyle = C.dim;
  g.font = `400 ${11 * u}px ${MONO}`;
  g.fillText(sub, w - 10 * u, 12 * u);
  g.textAlign = 'left';
  return u;
}

function trace(g, x, y, w, h, fn, t, color, n = 80) {
  g.strokeStyle = C.line;
  g.lineWidth = 1;
  g.strokeRect(x, y, w, h);
  g.strokeStyle = color;
  g.lineWidth = 1.6;
  g.beginPath();
  for (let i = 0; i <= n; i++) {
    const k = i / n;
    const v = fn(t - (1 - k) * 6, k);
    const px = x + k * w;
    const py = y + h * (1 - Math.max(0, Math.min(1, v)));
    if (i) g.lineTo(px, py);
    else g.moveTo(px, py);
  }
  g.stroke();
}

const fmt = (v, d = 1) => v.toFixed(d).padStart(6, ' ');

/** Gravitic drive telemetry — pages cycle per desk. */
export function telemetryPage(kind) {
  return (g, w, h, t, s) => {
    const live = s.live || {};
    const clock = s.clock || '';
    if (kind === 'drive') {
      const u = header(g, w, h, 'GRAVITIC AMPLIFIER · ARV-3', clock);
      const power = live.power ?? 0;
      const amps = [0.31, 0.29, 0.33].map((b, i) => b + power * 0.55 + Math.sin(t * (1.3 + i * 0.4)) * 0.02);
      amps.forEach((a, i) => {
        const x = (14 + i * 66) * u;
        g.fillStyle = C.line;
        g.fillRect(x, 40 * u, 46 * u, 150 * u);
        g.fillStyle = a > 0.8 ? C.amber : C.green;
        g.fillRect(x, (40 + 150 * (1 - a)) * u, 46 * u, 150 * a * u);
        g.fillStyle = C.text;
        g.font = `500 ${11 * u}px ${MONO}`;
        g.fillText(`AMP ${i + 1}`, x, 204 * u);
        g.fillStyle = C.dim;
        g.fillText(`${(a * 100).toFixed(0)}%`, x, 220 * u);
      });
      trace(g, 220 * u, 40 * u, 280 * u, 70 * u, (tt) => 0.5 + 0.18 * Math.sin(tt * 2.1) + 0.08 * Math.sin(tt * 7.3) * (0.3 + power), t, C.cyan);
      trace(g, 220 * u, 120 * u, 280 * u, 70 * u, (tt) => 0.3 + power * 0.4 + 0.05 * Math.sin(tt * 3.7), t, C.amber);
      g.fillStyle = C.dim;
      g.font = `400 ${10 * u}px ${MONO}`;
      g.fillText('FIELD PHASE (rad)', 224 * u, 50 * u);
      g.fillText('REACTOR OUTPUT (MW)', 224 * u, 130 * u);
      g.fillStyle = power > 0.05 ? C.green : C.amber;
      g.font = `600 ${14 * u}px ${HUDF}`;
      g.fillText(power > 0.05 ? 'DRIVE ONLINE' : 'DRIVE STANDBY', 220 * u, 222 * u);
      g.fillStyle = C.dim;
      g.font = `400 ${10 * u}px ${MONO}`;
      g.fillText(`ELEMENT 115 CORE  ${fmt(223.4 + Math.sin(t * 0.2) * 0.3)} g`, 220 * u, 244 * u);
      g.fillText(`HULL TEMP         ${fmt(18.2 + power * 6)} °C`, 220 * u, 260 * u);
    } else if (kind === 'track') {
      const u = header(g, w, h, 'RANGE CONTROL · R-4808N', clock);
      // radar scope
      const cx = 140 * u;
      const cy = 156 * u;
      const R = 118 * u;
      g.strokeStyle = C.line;
      for (let k = 1; k <= 4; k++) {
        g.beginPath();
        g.arc(cx, cy, (R * k) / 4, 0, Math.PI * 2);
        g.stroke();
      }
      const sweep = (t * 1.1) % (Math.PI * 2);
      const grad = g.createConicGradient ? g.createConicGradient(sweep - 0.6, cx, cy) : null;
      if (grad) {
        grad.addColorStop(0, 'rgba(111,227,160,0)');
        grad.addColorStop(0.09, 'rgba(111,227,160,0.35)');
        grad.addColorStop(0.1, 'rgba(111,227,160,0)');
        g.fillStyle = grad;
        g.beginPath();
        g.arc(cx, cy, R, 0, Math.PI * 2);
        g.fill();
      }
      const blips = [
        [0.3, 1.2, 'J-21'],
        [0.62, 3.9, 'TACO 2'],
        [0.8, 5.1, 'AR-03'],
      ];
      for (const [r, a, id] of blips) {
        const x = cx + Math.cos(a + t * 0.01) * R * r;
        const y = cy + Math.sin(a + t * 0.01) * R * r;
        g.fillStyle = id === 'AR-03' ? C.cyan : C.green;
        g.fillRect(x - 3, y - 3, 6, 6);
        g.font = `400 ${10 * u}px ${MONO}`;
        g.fillText(id, x + 6, y - 6);
      }
      g.fillStyle = C.text;
      g.font = `500 ${12 * u}px ${MONO}`;
      const lines = ['AIRSPACE  R-4808N  HOT', 'WX  CAVU  WIND 140/06', 'ALT SETTING 30.04', 'SORTIE 0417 · ARV-3', 'PILOT  · TRAINEE 2', 'STATUS  ' + (live.power > 0.05 ? 'ENGAGED' : 'PRE-FLIGHT')];
      lines.forEach((l, i) => g.fillText(l, 290 * u, (54 + i * 22) * u));
      g.fillStyle = (t % 1.2) < 0.6 ? C.amber : C.dim;
      g.fillText('▲ KEEP OUT OF CIVIL AIRWAYS', 290 * u, 200 * u);
    } else {
      const u = header(g, w, h, 'HANGAR 9 · SYSTEMS', clock);
      const rows = [
        ['GROUND POWER', '400 Hz  115 V', C.green],
        ['HANGAR DOOR', live.door ?? 'OPEN', C.green],
        ['FIRE SUPPRESSION', 'ARMED', C.green],
        ['PERIMETER', 'SECURE', C.green],
        ['BADGE READER N-2', 'FAULT', C.amber],
        ['SKYLIGHT SHUTTERS', 'CLOSED', C.green],
        ['COMMS', 'LINK OK · NELLIS', C.green],
      ];
      rows.forEach(([a, b, c], i) => {
        const y = (48 + i * 30) * u;
        g.fillStyle = C.line;
        g.fillRect(12 * u, y + 10 * u, w - 24 * u, 1);
        g.fillStyle = C.text;
        g.font = `500 ${12 * u}px ${MONO}`;
        g.fillText(a, 16 * u, y);
        g.fillStyle = c;
        g.textAlign = 'right';
        g.fillText(b, w - 16 * u, y);
        g.textAlign = 'left';
      });
    }
  };
}

/** The big video wall: world map with the sortie track and a big clock. */
export function videoWallPage() {
  return (g, w, h, t, s) => {
    const live = s.live || {};
    g.fillStyle = '#04080a';
    g.fillRect(0, 0, w, h);
    const u = h / 512;
    // graticule
    g.strokeStyle = 'rgba(98,216,255,0.12)';
    g.lineWidth = 1;
    for (let lon = -180; lon <= 180; lon += 30) {
      const x = ((lon + 180) / 360) * w;
      g.beginPath();
      g.moveTo(x, 40 * u);
      g.lineTo(x, h - 30 * u);
      g.stroke();
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const y = 40 * u + ((90 - lat) / 180) * (h - 70 * u);
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
    }
    // continents (very coarse outlines, enough to read as a world map)
    g.fillStyle = 'rgba(98,216,255,0.16)';
    for (const poly of CONTINENTS) {
      g.beginPath();
      poly.forEach(([lon, lat], i) => {
        const x = ((lon + 180) / 360) * w;
        const y = 40 * u + ((90 - lat) / 180) * (h - 70 * u);
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      });
      g.closePath();
      g.fill();
    }
    // craft position
    const lat = live.lat ?? 37.25;
    const lon = live.lon ?? -115.82;
    const x = ((lon + 180) / 360) * w;
    const y = 40 * u + ((90 - lat) / 180) * (h - 70 * u);
    const pulse = 6 + 4 * Math.sin(t * 4);
    g.strokeStyle = '#62d8ff';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(x, y, pulse * u * 2, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = '#62d8ff';
    g.beginPath();
    g.arc(x, y, 4 * u, 0, Math.PI * 2);
    g.fill();
    g.font = `600 ${18 * u}px ${HUDF}`;
    g.fillText('ARV-3', x + 14 * u, y - 10 * u);
    // title bar
    g.fillStyle = '#0b1418';
    g.fillRect(0, 0, w, 36 * u);
    g.fillStyle = '#cfe3e6';
    g.font = `700 ${20 * u}px ${HUDF}`;
    g.textBaseline = 'middle';
    g.fillText('S-4 FLIGHT TEST · TRAINING SORTIE 0417', 16 * u, 18 * u);
    g.textAlign = 'right';
    g.font = `500 ${18 * u}px ${MONO}`;
    g.fillText(s.clock || '', w - 16 * u, 18 * u);
    g.textAlign = 'left';
    g.fillStyle = 'rgba(207,227,230,0.6)';
    g.font = `400 ${14 * u}px ${MONO}`;
    g.fillText(`ALT ${Math.round(live.alt ?? 1346)} m   SPD ${Math.round(live.speed ?? 0)} km/h   ${live.status ?? 'PRE-FLIGHT'}`, 16 * u, h - 14 * u);
  };
}

/**
 * Cockpit displays (console face, toward the pilot).
 *   nav    : attitude ball + heading + air data
 *   drive  : field power ring, amplifiers, struts / ramp
 *   status : current objective, waypoint, home, position
 */
export function cockpitPage(kind) {
  return (g, w, h, t, s) => {
    const L = s.live || {};
    const power = L.power ?? 0;
    if (kind === 'nav') {
      const u = header(g, w, h, 'NAV · ATTITUDE', `HDG ${String(Math.round(L.heading ?? 0) % 360).padStart(3, '0')}°`);
      // attitude ball
      const cx = 92 * u;
      const cy = 160 * u;
      const R = 92 * u;
      g.save();
      g.beginPath();
      g.arc(cx, cy, R, 0, Math.PI * 2);
      g.clip();
      g.translate(cx, cy);
      g.rotate(-(L.bank ?? 0) * (Math.PI / 180));
      const off = (L.pitch ?? 0) * 2.2 * u;
      g.fillStyle = '#1b3a4a';
      g.fillRect(-R * 2, -R * 2 + off, R * 4, R * 2);
      g.fillStyle = '#3a2c1c';
      g.fillRect(-R * 2, off, R * 4, R * 2);
      g.strokeStyle = C.text;
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(-R * 2, off);
      g.lineTo(R * 2, off);
      g.stroke();
      g.lineWidth = 1;
      g.font = `400 ${10 * u}px ${MONO}`;
      g.fillStyle = C.dim;
      for (let p = -30; p <= 30; p += 10) {
        if (!p) continue;
        const y = off - p * 2.2 * u;
        const hw = (p % 20 === 0 ? 26 : 16) * u;
        g.beginPath();
        g.moveTo(-hw, y);
        g.lineTo(hw, y);
        g.stroke();
        g.fillText(String(Math.abs(p)), hw + 4 * u, y + 3 * u);
      }
      g.restore();
      g.strokeStyle = C.amber;
      g.lineWidth = 3 * u;
      g.beginPath();
      g.moveTo(cx - 44 * u, cy);
      g.lineTo(cx - 14 * u, cy);
      g.lineTo(cx - 8 * u, cy + 7 * u);
      g.moveTo(cx + 44 * u, cy);
      g.lineTo(cx + 14 * u, cy);
      g.lineTo(cx + 8 * u, cy + 7 * u);
      g.stroke();
      g.strokeStyle = C.line;
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(cx, cy, R, 0, Math.PI * 2);
      g.stroke();
      // air data
      const rows = [
        ['GS', `${Math.round((L.speed ?? 0) * 3.6)}`, 'km/h'],
        ['AGL', fmtDist(L.agl ?? 0), ''],
        ['ALT', fmtDist(L.alt ?? 0), 'MSL'],
        ['V/S', `${(L.vs ?? 0) >= 0 ? '+' : '−'}${Math.abs(L.vs ?? 0).toFixed(1)}`, 'm/s'],
      ];
      rows.forEach(([a, b, c], i) => {
        const y = (66 + i * 50) * u;
        g.fillStyle = C.dim;
        g.font = `500 ${12 * u}px ${HUDF}`;
        g.fillText(a, 210 * u, y);
        g.fillStyle = C.text;
        g.font = `500 ${26 * u}px ${MONO}`;
        g.fillText(b, 260 * u, y + 2 * u);
        g.fillStyle = C.dim;
        g.font = `400 ${11 * u}px ${MONO}`;
        g.fillText(c, 260 * u, y + 22 * u);
      });
    } else if (kind === 'drive') {
      const status = L.landed ? (power > 0.95 ? 'READY' : power > 0.02 ? 'SPOOLING' : 'COLD') : 'FLIGHT';
      const u = header(g, w, h, 'GRAVITIC DRIVE', status);
      const cx = 98 * u;
      const cy = 156 * u;
      const R = 74 * u;
      g.lineWidth = 12 * u;
      g.strokeStyle = 'rgba(130,190,200,0.12)';
      g.beginPath();
      g.arc(cx, cy, R, Math.PI * 0.75, Math.PI * 2.25);
      g.stroke();
      g.strokeStyle = power > 0.95 ? C.green : C.amber;
      g.beginPath();
      g.arc(cx, cy, R, Math.PI * 0.75, Math.PI * (0.75 + 1.5 * power));
      g.stroke();
      g.fillStyle = C.text;
      g.textAlign = 'center';
      g.font = `500 ${34 * u}px ${MONO}`;
      g.fillText(`${Math.round(power * 100)}`, cx, cy + 2 * u);
      g.fillStyle = C.dim;
      g.font = `400 ${11 * u}px ${MONO}`;
      g.fillText('FIELD %', cx, cy + 30 * u);
      g.textAlign = 'left';
      const thrust = L.thrust ?? 0;
      for (let i = 0; i < 3; i++) {
        const a = Math.min(1, power * (0.42 + thrust * 0.5) + Math.sin(t * (2.1 + i * 0.7)) * 0.02 * power);
        const x = (206 + i * 46) * u;
        g.fillStyle = 'rgba(130,190,200,0.12)';
        g.fillRect(x, 52 * u, 30 * u, 128 * u);
        g.fillStyle = a > 0.85 ? C.amber : C.cyan;
        g.fillRect(x, (52 + 128 * (1 - a)) * u, 30 * u, 128 * a * u);
        g.fillStyle = C.dim;
        g.font = `400 ${10 * u}px ${MONO}`;
        g.fillText(`A${i + 1}`, x + 6 * u, 196 * u);
      }
      const st = [
        ['STRUTS', (L.strut ?? 1) > 0.5 ? 'DOWN' : 'UP', (L.strut ?? 1) > 0.5 ? C.green : C.cyan],
        ['RAMP', (L.ramp ?? 0) > 0.05 ? 'OPEN' : 'SHUT', (L.ramp ?? 0) > 0.05 ? C.amber : C.green],
      ];
      st.forEach(([a, b, c], i) => {
        const y = (226 + i * 26) * u;
        g.fillStyle = C.dim;
        g.font = `500 ${12 * u}px ${HUDF}`;
        g.fillText(a, 206 * u, y);
        g.fillStyle = c;
        g.font = `500 ${13 * u}px ${MONO}`;
        g.fillText(b, 290 * u, y);
      });
    } else {
      const u = header(g, w, h, 'SORTIE', L.clock ?? '');
      g.fillStyle = C.green;
      g.font = `600 ${22 * u}px ${HUDF}`;
      g.fillText(L.objective ?? '', 14 * u, 64 * u);
      g.fillStyle = C.text;
      g.font = `500 ${17 * u}px ${MONO}`;
      if (L.wpName) g.fillText(`${L.wpName}  ${fmtDist(L.wpDist ?? 0)}  ${String(Math.round(L.wpBrg ?? 0)).padStart(3, '0')}°`, 14 * u, 112 * u);
      g.fillStyle = C.dim;
      g.font = `400 ${15 * u}px ${MONO}`;
      g.fillText(`HOME ${fmtDist(L.homeDist ?? 0)} ${String(Math.round(L.homeBrg ?? 0)).padStart(3, '0')}°`, 14 * u, 150 * u);
      g.fillText(`${(L.lat ?? 0).toFixed(4)}  ${(L.lon ?? 0).toFixed(4)}`, 14 * u, 186 * u);
      g.textAlign = 'right';
      g.fillStyle = (t % 1.4) < 0.7 && L.warn ? C.amber : C.dim;
      g.fillText(L.warn ?? '', w - 14 * u, 186 * u);
      g.textAlign = 'left';
    }
  };
}

function fmtDist(m) {
  const a = Math.abs(m);
  if (a < 1000) return `${Math.round(m)} m`;
  if (a < 100000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}

// Coarse continent outlines (lon, lat) — a few dozen points each.
const CONTINENTS = [
  [[-168, 66], [-140, 70], [-95, 72], [-80, 63], [-62, 58], [-55, 50], [-66, 44], [-76, 35], [-81, 25], [-97, 26], [-105, 20], [-95, 16], [-83, 9], [-79, 8], [-92, 15], [-106, 23], [-117, 32], [-124, 40], [-124, 48], [-135, 58], [-152, 60], [-165, 62]],
  [[-80, 10], [-62, 11], [-50, 0], [-35, -6], [-39, -14], [-48, -26], [-58, -38], [-65, -46], [-70, -54], [-74, -48], [-72, -30], [-71, -18], [-80, -5], [-78, 2]],
  [[-10, 36], [-9, 43], [-2, 48], [-5, 54], [5, 58], [10, 64], [20, 70], [30, 71], [42, 67], [60, 70], [80, 73], [105, 77], [140, 72], [160, 70], [180, 66], [178, 62], [160, 60], [142, 54], [135, 44], [128, 38], [122, 30], [120, 23], [110, 20], [106, 10], [100, 14], [98, 8], [92, 21], [80, 15], [77, 8], [72, 20], [66, 25], [57, 26], [50, 30], [48, 28], [56, 24], [58, 21], [52, 16], [43, 13], [35, 28], [34, 31], [28, 36], [26, 40], [20, 40], [14, 45], [12, 41], [16, 38], [8, 44], [3, 43], [-5, 36]],
  [[-17, 21], [-16, 13], [-8, 5], [5, 5], [9, 3], [13, -6], [12, -18], [17, -29], [20, -35], [28, -33], [35, -24], [40, -15], [41, -2], [51, 11], [43, 12], [35, 23], [32, 31], [20, 32], [10, 37], [-1, 36], [-10, 30]],
  [[114, -22], [122, -18], [130, -12], [137, -12], [142, -11], [146, -19], [153, -26], [151, -34], [145, -39], [138, -35], [130, -32], [117, -35], [114, -29]],
];
