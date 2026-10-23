import { CanvasTexture, HalfFloatType, LinearFilter, Mesh, PlaneGeometry, ShaderMaterial, SRGBColorSpace, WebGLRenderTarget } from 'three';

/**
 * MonitorFeed — a cockpit display (BlendKit node `screen_*`).
 *
 * Two layers, composited in one shader:
 *   feed : optional live camera — any scene + camera rendered to a small
 *          target (aft cam watching the tanker dock, belly cam over Mars)
 *   ui   : a 2D canvas page (telemetry, checklists, light-delay clock) drawn
 *          by a callback at ~12 fps
 *
 * The screen is emissive and opaque (alpha 1), so it never leaks into the
 * light-shaft sky mask. Close up you see a faint pixel grid; far away it's a
 * glowing rectangle — like a real LCD on film.
 */
export class MonitorFeed {
  constructor({ width = 0.34, height = 0.19, res = [640, 360], name = 'screen_main', brightness = 1.25 } = {}) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = res[0];
    this.canvas.height = res[1];
    this.g = this.canvas.getContext('2d');
    this.ui = new CanvasTexture(this.canvas);
    this.ui.colorSpace = SRGBColorSpace;
    this.ui.minFilter = LinearFilter;
    this.ui.generateMipmaps = false;
    this.uniforms = {
      uUi: { value: this.ui },
      uFeed: { value: null },
      uHasFeed: { value: 0 },
      uTime: { value: 0 },
      uBright: { value: brightness },
      uNoise: { value: 0.04 },
      uGlitch: { value: 0 },
      uRes: { value: [res[0], res[1]] },
      uPower: { value: 1 },
    };
    const material = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uUi, uFeed;
        uniform float uHasFeed, uTime, uBright, uNoise, uGlitch, uPower;
        uniform vec2 uRes;
        varying vec2 vUv;
        float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        void main() {
          vec2 uv = vUv;
          float row = floor(uv.y * uRes.y);
          uv.x += uGlitch * (h12(vec2(row, floor(uTime * 24.0))) - 0.5) * 0.04 * step(0.8, h12(vec2(floor(uTime * 9.0), row * 0.1)));
          vec3 feed = vec3(0.0);
          if (uHasFeed > 0.5) {
            feed = texture2D(uFeed, uv).rgb;
            feed = feed / (1.0 + feed);                 // the camera's own tone curve
            float l = dot(feed, vec3(0.299, 0.587, 0.114));
            feed = mix(vec3(l), feed, 0.75) * vec3(0.95, 1.0, 1.02);
            feed += (h12(uv * uRes + uTime * 61.0) - 0.5) * uNoise;
          }
          vec4 ui = texture2D(uUi, uv);
          vec3 col = mix(feed, ui.rgb, ui.a);
          // LCD pixel grid + slight edge falloff.
          vec2 px = fract(uv * uRes);
          float grid = 0.9 + 0.1 * smoothstep(0.0, 0.18, px.x) * smoothstep(0.0, 0.18, px.y);
          vec2 e = smoothstep(vec2(0.0), vec2(0.03), uv) * smoothstep(vec2(0.0), vec2(0.03), 1.0 - uv);
          col *= grid * (0.85 + 0.15 * e.x * e.y);
          gl_FragColor = vec4(col * uBright * uPower + vec3(0.004, 0.005, 0.006), 1.0);
        }
      `,
    });
    this.mesh = new Mesh(new PlaneGeometry(width, height), material);
    this.mesh.name = name;
    this.draw = null;
    this.feed = null;
    this._acc = 1;
    this.fps = 12;
    this.state = {};
  }

  /** Attach a live camera. `size` = width of the render target in px. */
  setFeed(scene, camera, size = 384, every = 1) {
    if (!this.rt || this.rt.width !== size) {
      if (this.rt) this.rt.dispose();
      this.rt = new WebGLRenderTarget(size, Math.round((size * 9) / 16), { type: HalfFloatType, samples: 0 });
    }
    this.feed = { scene, camera, every, n: 0 };
    camera.aspect = 16 / 9;
    camera.updateProjectionMatrix();
    this.uniforms.uFeed.value = this.rt.texture;
    this.uniforms.uHasFeed.value = 1;
  }

  clearFeed() {
    this.feed = null;
    this.uniforms.uHasFeed.value = 0;
  }

  /** Render the feed (if any) and redraw the UI page at `fps`. */
  update(dt, t, renderer) {
    this.uniforms.uTime.value = t;
    const f = this.feed;
    if (f && renderer && ++f.n >= f.every) {
      f.n = 0;
      const prevTarget = renderer.getRenderTarget();
      const prevShadow = renderer.shadowMap.autoUpdate;
      renderer.shadowMap.autoUpdate = false; // reuse this frame's shadow maps
      renderer.setRenderTarget(this.rt);
      renderer.setClearColor(0x000000, 1);
      renderer.clear(true, true, false);
      renderer.render(f.scene, f.camera);
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.shadowMap.autoUpdate = prevShadow;
    }
    this._acc += dt;
    if (this.draw && this._acc >= 1 / this.fps) {
      this._acc = 0;
      const { g, canvas } = this;
      g.clearRect(0, 0, canvas.width, canvas.height);
      this.draw(g, canvas.width, canvas.height, t, this.state);
      this.ui.needsUpdate = true;
    }
  }
}

// ------------------------------------------------------------------ page helpers

export const INK = {
  bg: 'rgba(6,9,12,0.92)',
  dim: 'rgba(150,170,180,0.55)',
  text: '#d9e3e6',
  accent: '#ffb35c',
  ok: '#7fe0a8',
  warn: '#ffcf5c',
  alert: '#ff5a4a',
  line: 'rgba(160,190,200,0.25)',
};

/** Standard page chrome: title bar, mission clock, page id. */
export function pageFrame(g, w, h, title, { clock = '', page = '', bg = true } = {}) {
  if (bg) {
    g.fillStyle = INK.bg;
    g.fillRect(0, 0, w, h);
  }
  const u = h / 360;
  g.fillStyle = INK.line;
  g.fillRect(0, 34 * u, w, 1.5 * u);
  g.font = `500 ${15 * u}px "IBM Plex Mono", monospace`;
  g.textBaseline = 'middle';
  g.fillStyle = INK.text;
  g.textAlign = 'left';
  g.fillText(title, 16 * u, 18 * u);
  g.textAlign = 'right';
  g.fillStyle = INK.dim;
  g.fillText(`${clock}  ${page}`, w - 16 * u, 18 * u);
  g.textAlign = 'left';
  return u;
}

export function label(g, x, y, text, { size = 13, color = INK.text, align = 'left', weight = 400, u = 1 } = {}) {
  g.font = `${weight} ${size * u}px "IBM Plex Mono", monospace`;
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillText(text, x, y);
}

export function bar(g, x, y, w, h, frac, color = INK.accent) {
  g.fillStyle = INK.line;
  g.fillRect(x, y, w, h);
  g.fillStyle = color;
  g.fillRect(x, y, w * Math.max(0, Math.min(1, frac)), h);
}

/** Line graph of samples (0..1) — e.g. propellant transferred over time. */
export function trace(g, x, y, w, h, samples, color = INK.accent) {
  g.strokeStyle = INK.line;
  g.lineWidth = 1;
  g.strokeRect(x, y, w, h);
  if (samples.length < 2) return;
  g.strokeStyle = color;
  g.lineWidth = 2;
  g.beginPath();
  samples.forEach((v, i) => {
    const px = x + (i / (samples.length - 1)) * w;
    const py = y + h - Math.max(0, Math.min(1, v)) * h;
    if (i) g.lineTo(px, py);
    else g.moveTo(px, py);
  });
  g.stroke();
}

/** Mission elapsed time formatter: T+HH:MM:SS or MET DDD/HH:MM. */
export function met(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 86400 * 2) {
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `T+${hh}:${mm}:${ss}`;
  }
  const d = String(Math.floor(s / 86400)).padStart(3, '0');
  const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  return `MET ${d}/${hh}:${mm}`;
}
