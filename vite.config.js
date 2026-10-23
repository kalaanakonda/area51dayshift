import { defineConfig } from 'vite';

// Plain Vite, two pages: the Area 51 flight (index) and the earlier Starship film.
export default defineConfig({
  server: { port: 5173, host: true },
  // Pre-bundle everything up front so a late discovery never re-optimizes
  // mid-session (that is how two copies of three.js end up on the page).
  optimizeDeps: {
    include: [
      'three',
      'gsap',
      '3d-tiles-renderer',
      '3d-tiles-renderer/plugins',
      'three/addons/loaders/GLTFLoader.js',
      'three/addons/loaders/DRACOLoader.js',
      'three/addons/loaders/KTX2Loader.js',
      'three/addons/utils/SkeletonUtils.js',
      'three/addons/utils/BufferGeometryUtils.js',
      'three/addons/postprocessing/EffectComposer.js',
      'three/addons/postprocessing/UnrealBloomPass.js',
      'three/addons/postprocessing/OutputPass.js',
      'three/addons/postprocessing/ShaderPass.js',
      'three/addons/postprocessing/Pass.js',
      'three/addons/geometries/RoundedBoxGeometry.js',
      'three/addons/environments/RoomEnvironment.js',
      'three/addons/lights/RectAreaLightUniformsLib.js',
      // the buildings worker (decoders come with 3d-tiles-renderer)
      'pbf',
      '@mapbox/vector-tile',
      'three/src/extras/Earcut.js',
    ],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
    // public/assets holds Blender/BlendKit drops; keep Vite's hashed bundle out of it.
    assetsDir: 'bundle',
    rollupOptions: {
      input: { main: 'index.html', starship: 'starship.html' },
    },
  },
});
