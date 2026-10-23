import { Raycaster, Vector3 } from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { TilesRenderer } from '3d-tiles-renderer';
import {
  GLTFExtensionsPlugin,
  GoogleCloudAuthPlugin,
  TerrariumMeshPlugin,
  TileCompressionPlugin,
  TilesFadePlugin,
  XYZTilesOverlay,
} from '3d-tiles-renderer/plugins';
import { atmospherize } from './atmosphere.js';

const GOOGLE_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';

// Free sources (no key): Esri World Imagery on AWS Terrain Tiles (Terrarium).
const ESRI_IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
export const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

const _ray = new Raycaster();
const _up = new Vector3();
const _o = new Vector3();
const _hits = [];

/**
 * Earth — the planet under the saucer.
 *
 *   google : Google Photorealistic 3D Tiles (the "Google Earth" mesh) —
 *            needs VITE_GOOGLE_MAPS_API_KEY in .env.local
 *   free   : satellite imagery draped on a 30 m–SRTM / 3DEP elevation mesh —
 *            works with no key, same frame, same atmosphere
 *
 * The tileset lives in ECEF; `frame.worldFromEcef` carries it into the game
 * world. Every tile material is patched with aerial perspective + relighting.
 */
export class Earth {
  constructor({ frame, renderer, camera, atmoUniforms, quality, source = 'auto' }) {
    this.frame = frame;
    this.renderer = renderer;
    this.camera = camera;
    this.atmoUniforms = atmoUniforms;
    this.mode = source === 'free' || !GOOGLE_KEY ? 'free' : 'google';
    this.error = null;
    this.ready = false;

    const tiles = new TilesRenderer();
    this.tiles = tiles;
    if (this.mode === 'google') {
      tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: GOOGLE_KEY, autoRefreshToken: true }));
      const draco = new DRACOLoader().setDecoderPath('/decoders/draco/');
      const ktx2 = new KTX2Loader().setTranscoderPath('/decoders/basis/').detectSupport(renderer);
      tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco, ktxLoader: ktx2 }));
      tiles.registerPlugin(new TileCompressionPlugin());
      tiles.errorTarget = { low: 28, medium: 20, high: 14 }[quality.name] ?? 20;
    } else {
      const overlay = new XYZTilesOverlay({ url: ESRI_IMAGERY, levels: 20 });
      this.terrain = new TerrariumMeshPlugin({
        url: TERRARIUM,
        maxZoom: 15,
        overlay,
        applyOverlayTexture: true,
        unlit: true,
      });
      tiles.registerPlugin(this.terrain);
      // errorTarget ≈ screen pixels per imagery texel: 1 is pin-sharp but
      // streams 4× the tiles of 2. Parsing a tile is mostly waiting on two
      // image downloads, so let many run at once.
      tiles.errorTarget = { low: 4, medium: 2.6, high: 2 }[quality.name] ?? 2.6;
      tiles.parseQueue.maxJobs = 24;
    }
    tiles.registerPlugin(new TilesFadePlugin({ fadeDuration: 400 }));
    tiles.lruCache.maxBytesSize = { low: 0.4e9, medium: 0.7e9, high: 1.1e9 }[quality.name] ?? 0.7e9;
    tiles.lruCache.minBytesSize = tiles.lruCache.maxBytesSize * 0.6;

    tiles.group.name = `earth:${this.mode}`;
    tiles.group.matrixAutoUpdate = false;
    tiles.group.matrix.copy(frame.worldFromEcef);
    tiles.group.updateMatrixWorld(true);

    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, renderer);

    tiles.addEventListener('load-model', ({ scene }) => {
      scene.traverse((o) => {
        if (!o.material) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          atmospherize(m, atmoUniforms, { relight: true });
        }
        o.castShadow = false;
        o.receiveShadow = false;
      });
    });
    tiles.addEventListener('load-root-tileset', () => {
      this.ready = true;
    });
    tiles.addEventListener('load-error', ({ error, tile }) => {
      if (!tile) this.error = error;
    });
    this._helpers = new Map();
  }

  get group() {
    return this.tiles.group;
  }

  /** Extra cameras (e.g. a top-down "site" camera that pre-loads the ground under the hangar). */
  addHelperCamera(camera, w = 512, h = 512) {
    this.tiles.setCamera(camera);
    this.tiles.setResolution(camera, w, h);
    this._helpers.set(camera, true);
  }

  removeHelperCamera(camera) {
    this.tiles.deleteCamera(camera);
    this._helpers.delete(camera);
  }

  resize() {
    this.tiles.setResolutionFromRenderer(this.camera, this.renderer);
  }

  update() {
    this.camera.updateMatrixWorld();
    this.tiles.update();
  }

  /** Coarser tiles while the world streams past too fast to see (warp): 1 = normal. */
  setDetail(mul) {
    if (this._baseError == null) this._baseError = this.tiles.errorTarget;
    this.tiles.errorTarget = this._baseError * mul;
  }

  get loading() {
    const s = this.tiles.stats;
    return s.downloading + s.parsing + s.queued;
  }

  /**
   * Ellipsoid height of the ground at a world position (null if not loaded).
   * free  : samples the elevation grid directly (exact, cheap)
   * google: raycasts the photogrammetry mesh down the local vertical
   */
  groundHeight(world, c = this.frame.cartographic(world, {})) {
    if (this.terrain) {
      const h = this.terrain.sampleCartographicElevation(c.lat, c.lon);
      return h == null ? null : h;
    }
    this.frame.enuAt(world, null, null, _up);
    _o.copy(world).addScaledVector(_up, 6000 - c.height + 2000);
    _ray.set(_o, _up.negate());
    _ray.far = 20000;
    _ray.firstHitOnly = true;
    _hits.length = 0;
    this.tiles.raycast(_ray, _hits);
    if (!_hits.length) return null;
    let best = _hits[0];
    for (const h of _hits) if (h.distance < best.distance) best = h;
    return this.frame.cartographic(best.point, {}).height;
  }

  attributions() {
    if (this.mode === 'free') {
      return 'Imagery © Esri, Maxar, Earthstar Geographics · Elevation: AWS Terrain Tiles (SRTM, USGS 3DEP, GMTED)';
    }
    const list = this.tiles.getAttributions();
    const text = list.filter((a) => a.type === 'string').map((a) => a.value).join(' · ');
    return `Google${text ? ` · ${text}` : ''}`;
  }
}

export const HAS_GOOGLE_KEY = !!GOOGLE_KEY;
