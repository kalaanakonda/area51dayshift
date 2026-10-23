import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

/**
 * Asset slots. Each slot prefers a local file in public/assets (drop a Blender /
 * BlendKit export there and it wins automatically) and otherwise streams a
 * freely-licensed stand-in. Local files are only requested when the asset
 * index (written by `npm run dev`) lists them, so nothing 404s.
 */
export const SLOTS = {
  // MIT — W3C Immersive Web WebXR input profiles (25-joint rigged hands).
  handLeft: { local: 'models/hands/left.glb', remote: 'https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles/generic-hand/left.glb' },
  handRight: { local: 'models/hands/right.glb', remote: 'https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles/generic-hand/right.glb' },
  // MIT — Microsoft Rocketbox (Military_Male_06, Security_Male_01, Medical_Male_03, Construction_Male_08,
  // Military_Female_01) with idle / look / talk / walk clips.
  soldier: { local: 'models/people/rb_soldier.glb', remote: null },
  security: { local: 'models/people/rb_security.glb', remote: null },
  scientist: { local: 'models/people/scientist.glb', remote: null },
  technician: { local: 'models/people/technician.glb', remote: null },
  soldierF: { local: 'models/people/rb_soldier_f.glb', remote: null },
  // MIT — Rocketbox Military_Male_06 as the first-person pilot (scripts/rocketbox_pilot.py: hands cut, head split, subdivided).
  pilot: { local: 'models/people/pilot.glb', remote: null },
  // three.js example character (Mixamo rig, Idle / Walk / Run clips) — fallback when the above are missing.
  guard: { local: 'models/people/guard.glb', remote: 'https://threejs.org/examples/models/gltf/Soldier.glb' },
  saucer: { local: 'models/ufo/saucer.glb', remote: null },
};

let index = null;
async function loadIndex() {
  if (index) return index;
  try {
    const r = await fetch('/assets/asset-index.json', { cache: 'no-cache' });
    const j = await r.json();
    index = new Set(j.files || []);
  } catch {
    index = new Set();
  }
  return index;
}

export class Assets {
  constructor(renderer) {
    this.loader = new GLTFLoader();
    const draco = new DRACOLoader().setDecoderPath('/decoders/draco/');
    const ktx2 = new KTX2Loader().setTranscoderPath('/decoders/basis/').detectSupport(renderer);
    this.loader.setDRACOLoader(draco);
    this.loader.setKTX2Loader(ktx2);
    this.loader.setMeshoptDecoder(MeshoptDecoder);
    this.cache = new Map();
    this.sources = {};
  }

  async url(slot) {
    const s = SLOTS[slot];
    if (!s) return null;
    const idx = await loadIndex();
    if (idx.has(s.local)) return { url: `/assets/${s.local}`, local: true };
    return s.remote ? { url: s.remote, local: false } : null;
  }

  /** Resolves to the parsed glTF (cached per slot) or null if unavailable. */
  async gltf(slot) {
    if (this.cache.has(slot)) return this.cache.get(slot);
    const p = (async () => {
      const u = await this.url(slot);
      if (!u) return null;
      try {
        const g = await this.loader.loadAsync(u.url);
        this.sources[slot] = u.local ? 'local' : 'stand-in';
        return g;
      } catch (e) {
        console.warn(`[assets] ${slot} failed (${u.url})`, e);
        return null;
      }
    })();
    this.cache.set(slot, p);
    return p;
  }
}
