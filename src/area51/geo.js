import { Matrix4, Vector3 } from 'three';
import { WGS84_ELLIPSOID } from '3d-tiles-renderer';

export const DEG = Math.PI / 180;

/**
 * The hangar: open playa on the west side of Groom Lake, ~1 km north of the
 * main base, picked from satellite imagery so no real building is in the way.
 * The door looks toward the main base; morning sun comes in at an angle.
 */
export const SITE = {
  name: 'Groom Lake · Hangar 9',
  lat: 37.2549,
  lon: -115.8171,
  // Ellipsoid height guess (DEM 1346 m MSL, geoid ≈ −23.5 m). The hangar snaps
  // to whatever ground the Earth source actually loads.
  height: 1322.5,
  // The door looks SSE at the real base, 2.3 km away; the morning sun (≈112°)
  // rakes in from the side instead of glaring straight through the opening.
  doorAzimuth: 165,
  utcOffset: -7, // PDT
};

const _v = new Vector3();
const _e = new Vector3();
const _n = new Vector3();
const _u = new Vector3();

/**
 * GeoFrame — the game world is a local frame pinned at the site:
 *   +X east, +Y up, +Z south (so three.js "forward" −Z is north).
 * The globe (ECEF) is carried into it by one matrix. Everything is double
 * precision on the CPU; three.js builds modelView matrices in doubles, so the
 * GPU only ever sees camera-relative values — no jitter at Tokyo either.
 */
export class GeoFrame {
  constructor(lat = SITE.lat, lon = SITE.lon, height = SITE.height) {
    this.ellipsoid = WGS84_ELLIPSOID;
    const enu = WGS84_ELLIPSOID.getEastNorthUpFrame(lat * DEG, lon * DEG, height, new Matrix4());
    const enuToWorld = new Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
    this.worldFromEcef = enuToWorld.multiply(enu.invert());
    this.ecefFromWorld = this.worldFromEcef.clone().invert();
    this.earthCenter = new Vector3().applyMatrix4(this.worldFromEcef);
  }

  toWorld(ecef, out = new Vector3()) {
    return out.copy(ecef).applyMatrix4(this.worldFromEcef);
  }

  toEcef(world, out = new Vector3()) {
    return out.copy(world).applyMatrix4(this.ecefFromWorld);
  }

  /** World position → { lat, lon (radians), height (m above ellipsoid) }. */
  cartographic(world, out = {}) {
    return WGS84_ELLIPSOID.getPositionToCartographic(this.toEcef(world, _v), out);
  }

  fromCartographic(lat, lon, height, out = new Vector3()) {
    WGS84_ELLIPSOID.getCartographicToPosition(lat, lon, height, out);
    return out.applyMatrix4(this.worldFromEcef);
  }

  /** East / north / up unit vectors (world frame) at a world position. */
  enuAt(world, east, north, up) {
    const c = this.cartographic(world, _c);
    WGS84_ELLIPSOID.getEastNorthUpAxes(c.lat, c.lon, _e, _n, _u);
    if (east) east.copy(_e).transformDirection(this.worldFromEcef);
    if (north) north.copy(_n).transformDirection(this.worldFromEcef);
    if (up) up.copy(_u).transformDirection(this.worldFromEcef);
    return c;
  }

  /** ECEF direction → world direction. */
  dirToWorld(dir, out = new Vector3()) {
    return out.copy(dir).transformDirection(this.worldFromEcef);
  }
}
const _c = {};

/**
 * Sun direction in ECEF for a UTC time (low-precision NOAA/Astronomical
 * Almanac formula, good to ~0.01°). Because it is a global direction, flying
 * from a Nevada morning to Tokyo puts you in Tokyo's night.
 */
export function sunDirectionEcef(date, out = new Vector3()) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const d = jd - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * DEG;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const e = (23.439 - 0.00000036 * d) * DEG;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24) * 15 * DEG;
  const lon = ra - gmst; // sub-solar longitude (east positive)
  return out.set(Math.cos(dec) * Math.cos(lon), Math.cos(dec) * Math.sin(lon), Math.sin(dec));
}

/** Great-circle distance (m) and initial bearing (deg) between lat/lon radians. */
export function greatCircle(lat1, lon1, lat2, lon2) {
  const R = 6371008.8;
  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const dist = 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const bearing = ((Math.atan2(y, x) / DEG) + 360) % 360;
  return { dist, bearing };
}

export function formatLatLon(latRad, lonRad) {
  const f = (v, p, n) => `${Math.abs(v / DEG).toFixed(4)}°${v >= 0 ? p : n}`;
  return `${f(latRad, 'N', 'S')} ${f(lonRad, 'E', 'W')}`;
}
