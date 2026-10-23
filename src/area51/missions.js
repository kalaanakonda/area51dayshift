import { DEG, greatCircle, SITE } from './geo.js';

/**
 * The day shift: a short checklist, then a training run to a landmark of your
 * choosing (N cycles them, or pick anywhere on the nav map), then bring the
 * craft home. Nothing flies itself — the waypoint is just a bug on the compass
 * and a marker on the map (the warp drive only goes where you send it).
 */
export const HOME = { name: 'Hangar 9', lat: SITE.lat, lon: SITE.lon };

export const WAYPOINTS = [
  { name: 'Las Vegas Strip', lat: 36.1147, lon: -115.1728 },
  { name: 'Hoover Dam', lat: 36.016, lon: -114.7377 },
  { name: 'Grand Canyon', lat: 36.0617, lon: -112.1077 },
  { name: 'Death Valley · Badwater', lat: 36.2303, lon: -116.767 },
  { name: 'Golden Gate Bridge', lat: 37.8199, lon: -122.4783 },
  { name: 'Manhattan', lat: 40.7484, lon: -73.9857 },
  { name: 'Pyramids of Giza', lat: 29.9792, lon: 31.1342 },
  { name: 'Mount Everest', lat: 27.9881, lon: 86.925 },
  { name: 'Tokyo Tower', lat: 35.6586, lon: 139.7454 },
];

const STEPS = [
  { id: 'board', title: 'Report to ARV-3', detail: 'Walk to the boarding ramp at the tail' },
  { id: 'spool', title: 'Spool the gravitic drive', detail: 'Hands on the pads · press R' },
  { id: 'liftoff', title: 'Lift off and clear the hangar', detail: 'Space to climb · fly out the door' },
  { id: 'sortie', title: 'Training run', detail: '' },
  { id: 'return', title: 'Bring her home', detail: 'Land inside Hangar 9' },
  { id: 'done', title: 'Shift complete', detail: 'Free flight · the planet is yours' },
];

export class Shift {
  constructor() {
    this.step = 0;
    this.wp = 1; // Hoover Dam: close, unmistakable from the air
    this.events = [];
  }

  get current() {
    return STEPS[this.step];
  }

  get waypoint() {
    return this.custom || WAYPOINTS[this.wp];
  }

  cycleWaypoint(dir = 1) {
    if (this.custom) this.custom = null; // back to the list where you left it
    else this.wp = (this.wp + dir + WAYPOINTS.length) % WAYPOINTS.length;
    this.events.push({ type: 'waypoint', text: `Waypoint · ${this.waypoint.name}` });
  }

  /** A place picked on the nav map becomes the waypoint (N returns to the list). */
  setCustom(dest) {
    this.custom = { name: dest.name, lat: dest.lat, lon: dest.lon };
    this.events.push({ type: 'waypoint', text: `Waypoint · ${dest.name}` });
  }

  /** s = { mode, power, landed, outsideHangar, insideHangar, lat, lon (deg), agl } */
  update(s) {
    const id = this.current.id;
    const wp = this.waypoint;
    const toWp = greatCircle(s.lat * DEG, s.lon * DEG, wp.lat * DEG, wp.lon * DEG);
    let done = false;
    if (id === 'board') done = s.mode === 'pilot';
    else if (id === 'spool') done = s.power > 0.99;
    else if (id === 'liftoff') done = !s.landed && s.outsideHangar;
    else if (id === 'sortie') done = toWp.dist < 3000 && s.agl < 8000;
    else if (id === 'return') done = s.landed && s.insideHangar;
    if (done) {
      if (id === 'sortie') this.events.push({ type: 'reached', text: `Overflew ${wp.name}` });
      this.step = Math.min(STEPS.length - 1, this.step + 1);
      if (this.current.id === 'done') this.events.push({ type: 'complete', text: 'Shift complete · nice flying' });
      else this.events.push({ type: 'step', text: this.current.title });
    }
    // Free flight after the shift still tracks the chosen waypoint.
    const key = `${wp.name}@${wp.lat},${wp.lon}`;
    if (id === 'done' && toWp.dist < 3000 && this._lastReached !== key) {
      this._lastReached = key;
      this.events.push({ type: 'reached', text: `Overflew ${wp.name}` });
    }
    if (toWp.dist > 6000 && this._lastReached === key) this._lastReached = null;
    const cur = this.current;
    const detail = cur.id === 'sortie' ? `Overfly ${wp.name} · M map · N next` : cur.detail;
    return { title: cur.title, detail, step: this.step, total: STEPS.length - 1, wp: { ...wp, dist: toWp.dist, brg: toWp.bearing } };
  }
}
