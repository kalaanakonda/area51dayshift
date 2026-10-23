import { BoxGeometry, BufferAttribute, Euler, ExtrudeGeometry, Matrix4, Mesh, Quaternion, Shape, Vector3 } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Geometry helpers for the hangar: a static batcher (one draw call per
 * material), box-projected UVs in metres (textures keep a constant texel
 * density on every wall), steel sections and trusses.
 */

const _m = new Matrix4();
const _q = new Quaternion();
const _e = new Euler();
const _s = new Vector3(1, 1, 1);
const _p = new Vector3();

/** Re-project UVs from local positions: each face uses its two in-plane axes, in metres / tile. */
export function boxProjectUV(geometry, tile = 1, offset = [0, 0]) {
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ax = Math.abs(nor.getX(i));
    const ay = Math.abs(nor.getY(i));
    const az = Math.abs(nor.getZ(i));
    let u;
    let v;
    if (ax >= ay && ax >= az) {
      u = z * Math.sign(nor.getX(i) || 1) * -1;
      v = y;
    } else if (ay >= az) {
      u = x;
      v = z * -Math.sign(nor.getY(i) || 1);
    } else {
      u = x * Math.sign(nor.getZ(i) || 1);
      v = y;
    }
    uv[i * 2] = u / tile + offset[0];
    uv[i * 2 + 1] = v / tile + offset[1];
  }
  geometry.setAttribute('uv', new BufferAttribute(uv, 2));
  return geometry;
}

/** Collects transformed geometries per material and merges them. */
export class Batcher {
  constructor() {
    this.bins = new Map();
  }

  add(geometry, material, { position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1], matrix = null, uvTile = 0 } = {}) {
    let g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    if (uvTile) boxProjectUV(g, uvTile);
    if (!g.attributes.uv) g.setAttribute('uv', new BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    if (matrix) g.applyMatrix4(matrix);
    else {
      _e.set(rotation[0], rotation[1], rotation[2]);
      _q.setFromEuler(_e);
      _m.compose(_p.set(position[0], position[1], position[2]), _q, _s.set(scale[0], scale[1], scale[2]));
      g.applyMatrix4(_m);
    }
    g.clearGroups();
    if (!this.bins.has(material)) this.bins.set(material, []);
    this.bins.get(material).push(g);
    return g;
  }

  /** Box by size + centre, with metre UVs. */
  box(material, sx, sy, sz, x, y, z, { rotation = [0, 0, 0], uvTile = 1 } = {}) {
    const g = new BoxGeometry(sx, sy, sz);
    boxProjectUV(g, uvTile);
    return this.add(g, material, { position: [x, y, z], rotation });
  }

  build({ castShadow = true, receiveShadow = true, name = 'batch' } = {}) {
    const meshes = [];
    for (const [material, list] of this.bins) {
      const merged = mergeGeometries(list, false);
      merged.computeBoundingSphere();
      const mesh = new Mesh(merged, material);
      mesh.name = `${name}:${material.name || 'mat'}`;
      mesh.castShadow = castShadow && !material.transparent;
      mesh.receiveShadow = receiveShadow;
      meshes.push(mesh);
      for (const g of list) g.dispose();
    }
    this.bins.clear();
    return meshes;
  }
}

/** Wide-flange I section (flange width b, depth d), extruded along +Y by `length`. */
export function iBeam(b = 0.3, d = 0.45, tf = 0.025, tw = 0.016, length = 10) {
  const s = new Shape();
  const hb = b / 2;
  const hd = d / 2;
  const hw = tw / 2;
  s.moveTo(-hb, -hd);
  s.lineTo(hb, -hd);
  s.lineTo(hb, -hd + tf);
  s.lineTo(hw, -hd + tf);
  s.lineTo(hw, hd - tf);
  s.lineTo(hb, hd - tf);
  s.lineTo(hb, hd);
  s.lineTo(-hb, hd);
  s.lineTo(-hb, hd - tf);
  s.lineTo(-hw, hd - tf);
  s.lineTo(-hw, -hd + tf);
  s.lineTo(-hb, -hd + tf);
  s.closePath();
  const g = new ExtrudeGeometry(s, { depth: length, bevelEnabled: false, steps: 1 });
  // extrude runs along +Z; stand it up along +Y
  g.rotateX(-Math.PI / 2);
  boxProjectUV(g, 1);
  return g;
}

/** A member between two points (square tube / angle stand-in), for trusses and rails. */
export function member(batcher, material, a, b, size = 0.12) {
  const dir = new Vector3().subVectors(b, a);
  const len = dir.length();
  const g = new BoxGeometry(size, len, size);
  boxProjectUV(g, 1);
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.clone().normalize());
  const m = new Matrix4().compose(new Vector3().addVectors(a, b).multiplyScalar(0.5), q, new Vector3(1, 1, 1));
  return batcher.add(g, material, { matrix: m });
}

/** Pratt roof truss spanning X at depth z (bottom chord yb, top chord yt). */
export function truss(batcher, material, z, span, yb, yt, panel = 2.5) {
  const half = span / 2;
  const A = (x, y) => new Vector3(x, y, z);
  member(batcher, material, A(-half, yb), A(half, yb), 0.22);
  member(batcher, material, A(-half, yt), A(half, yt), 0.24);
  const n = Math.round(span / panel);
  for (let i = 0; i <= n; i++) {
    const x = -half + (i / n) * span;
    member(batcher, material, A(x, yb), A(x, yt), 0.12);
    if (i < n) {
      const x2 = -half + ((i + 1) / n) * span;
      // diagonals slope toward the centre (Pratt)
      if (x < 0) member(batcher, material, A(x, yt), A(x2, yb), 0.1);
      else member(batcher, material, A(x, yb), A(x2, yt), 0.1);
    }
  }
}

/** Simple tube rail (handrails) as a chain of members. */
export function rail(batcher, material, points, size = 0.045) {
  for (let i = 0; i < points.length - 1; i++) member(batcher, material, points[i], points[i + 1], size);
}
