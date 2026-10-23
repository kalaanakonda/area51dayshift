#!/usr/bin/env node
/**
 * Scans public/assets and writes public/assets/asset-index.json.
 * The runtime only requests files listed here, so missing BlendKit assets never 404 —
 * they silently fall back to the procedural versions.
 *
 * Also copies the Draco + Basis (KTX2) decoders out of three.js into
 * public/decoders so compressed GLBs load offline.
 *
 * Run automatically by `npm run dev` / `npm run build`, or manually:
 *   npm run assets:index
 */
import { readdir, stat, writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const assetsDir = join(root, 'public', 'assets');
const ALLOWED = /\.(glb|gltf|bin|ktx2|jpg|jpeg|png|webp|hdr|exr|mp3|ogg|m4a|wav)$/i;

async function walk(dir) {
  const out = [];
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    const s = await stat(full);
    if (s.isDirectory()) out.push(...(await walk(full)));
    else if (ALLOWED.test(name)) out.push(relative(assetsDir, full).split(sep).join('/'));
  }
  return out;
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDecoders() {
  const pairs = [
    ['examples/jsm/libs/draco', 'draco', ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js']],
    ['examples/jsm/libs/basis', 'basis', ['basis_transcoder.js', 'basis_transcoder.wasm']],
  ];
  for (const [src, dst, files] of pairs) {
    const outDir = join(root, 'public', 'decoders', dst);
    await mkdir(outDir, { recursive: true });
    for (const f of files) {
      const from = join(root, 'node_modules', 'three', src, f);
      const to = join(outDir, f);
      if ((await exists(from)) && !(await exists(to))) await copyFile(from, to);
    }
  }
}

const files = (await walk(assetsDir)).sort();
await mkdir(assetsDir, { recursive: true });
await writeFile(join(assetsDir, 'asset-index.json'), JSON.stringify({ generated: new Date().toISOString(), files }, null, 2));
await copyDecoders();

const models = files.filter((f) => f.startsWith('models/'));
console.log(
  `[assets] indexed ${files.length} file(s)` +
    (models.length ? ` — models: ${models.map((m) => m.replace('models/', '')).join(', ')}` : ' — all scenes use procedural fallbacks')
);
