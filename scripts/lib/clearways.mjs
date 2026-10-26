// NSW clearways (Transport for NSW, CC BY 4.0, data as of 2018): the main roads where you can't stop in peak
// hours. Each record is one direction of a road with its clearway hours, e.g. "M-F 0600-1000, 1500-1900".
// Drawn on the kerb to the left of travel, only where Kerb has no other data for that kerb. Outside the
// clearway times the other signs aren't published, so those hours show as unknown, never as free.
import { unzip, readDbf, readShp } from './shapefile.mjs';
import { dist, round } from './geo.mjs';

const log = (...a) => (globalThis.__log || console.log)(...a);
const URL_ZIP = 'https://opendata.transport.nsw.gov.au/data/dataset/2c21b56b-8510-4261-8488-2b1db4f8d305/resource/d65c9a04-f7ad-4638-941d-10fba60a20f4/download/nswclearways_20181003_0.zip';

// GDA94 / NSW Lambert (EPSG:3308) to longitude/latitude: Lambert conformal conic, two standard parallels (Snyder).
const R = Math.PI / 180, A = 6378137, F = 1 / 298.257222101, E = Math.sqrt(2 * F - F * F);
const m = (p) => Math.cos(p) / Math.sqrt(1 - (E * Math.sin(p)) ** 2);
const t = (p) => Math.tan(Math.PI / 4 - p / 2) / ((1 - E * Math.sin(p)) / (1 + E * Math.sin(p))) ** (E / 2);
const P1 = -30.75 * R, P2 = -35.75 * R, P0 = -33.25 * R, L0 = 147 * R, X0 = 9300000, Y0 = 4500000;
const N = (Math.log(m(P1)) - Math.log(m(P2))) / (Math.log(t(P1)) - Math.log(t(P2)));
const FF = m(P1) / (N * t(P1) ** N), RHO0 = A * FF * t(P0) ** N;
export function lambertToLonLat([x, y]) {
  const dx = x - X0, dy = RHO0 - (y - Y0);
  const rho = Math.sign(N) * Math.hypot(dx, dy), th = Math.atan2(Math.sign(N) * dx, Math.sign(N) * dy);
  const tt = (rho / (A * FF)) ** (1 / N);
  let phi = Math.PI / 2 - 2 * Math.atan(tt);
  for (let i = 0; i < 8; i++) phi = Math.PI / 2 - 2 * Math.atan(tt * ((1 - E * Math.sin(phi)) / (1 + E * Math.sin(phi))) ** (E / 2));
  return [+(th / N / R + L0 / R).toFixed(6), +(phi / R).toFixed(6)];
}

// "M-F 0600-1000, 1500-1900; SS 0900-1800 PH" -> rules, or null if it can't be read with confidence.
const DAYSETS = [
  [/^(m-f|mon-fri|mon - fri)$/i, [1, 2, 3, 4, 5]],
  [/^(s-s|ss|sat-sun|we|sat - sun|weekends?)$/i, [0, 6]],
];
export function readClearway(text) {
  let s = String(text || '').trim();
  if (!s || /tba|varies|depending/i.test(s)) return null;
  const ph = /\bph\b|pub(lic)? hol/i.test(s) ? 1 : 0;
  if (/^24\s*(hours|hrs)/i.test(s)) return [[0, [0, 1, 2, 3, 4, 5, 6], 0, 24, 0, ph, 1, 'Clearway']];
  s = s.replace(/\b(MON|Mon)\s*-\s*(FRI|Fri)\b/g, 'M-F').replace(/\b(SAT|Sat)\s*-\s*(SUN|Sun)\b/g, 'S-S').replace(/M-F(\d)/g, 'M-F $1')
    .replace(/\b(S-S|SS)\s*(-|&)?\s*PH\b/gi, 'S-S').replace(/\bPH\b|&\s*Pub(lic)?\s*Hols?|Public Holidays?/gi, '').replace(/Sat-Sun\s*&?/gi, 'S-S ')
    .replace(/(\d{4})\s*-\s*(\d{4})/g, '$1-$2');
  const out = [];
  let days = null;
  for (const tok of s.split(/[\s,;&]+|\band\b/i).filter(Boolean)) {
    const ds = DAYSETS.find(([re]) => re.test(tok));
    if (ds) { days = ds[1]; continue; }
    const tm = /^(\d\d)(\d\d)-(\d\d)(\d\d)$/.exec(tok);
    if (tm) {
      if (!days) return null;
      const from = +tm[1] + tm[2] / 60, to = +tm[3] + tm[4] / 60;
      if (to <= from) return null;
      out.push([0, days, from, to, 0, ph && days.includes(0) ? 1 : 0, 1, 'Clearway']);
      continue;
    }
    if (/^(s|-)$/i.test(tok)) continue;
    return null; // a word we don't understand: leave the road out rather than guess
  }
  return out.length ? out : null;
}

export async function fetchClearways() {
  const r = await fetch(URL_ZIP, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const files = await unzip(await r.arrayBuffer());
  const key = (ext) => Object.keys(files).find((k) => k.toLowerCase().endsWith(ext));
  const rows = readDbf(files[key('.dbf')]), geoms = readShp(files[key('.shp')]);
  const out = [];
  let unread = 0;
  for (let i = 0; i < rows.length; i++) {
    const rw = rows[i], g = geoms[i];
    if (!rw.CLEARWAY_H || !g) continue;
    if (!readClearway(rw.CLEARWAY_H)) { unread++; continue; }
    const lines = (Array.isArray(g[0][0]) ? g : [g]).map((line) => line.map(lambertToLonLat));
    out.push({ street: rw.STREET_NAM, suburb: rw.SUBURB, dir: rw.DIRECTION, hours: rw.CLEARWAY_H, lines });
  }
  log(`  clearways: ${out.length} road pieces with clearway hours (${unread} with hours we can't read)`);
  return out;
}

const titleCase = (s) => String(s || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bRd\b/, 'Road').replace(/\bSt\b/, 'Street').replace(/\bHwy\b/, 'Highway').replace(/\bAve?\b/, 'Avenue').replace(/\bPde\b/, 'Parade').replace(/\bDr\b/, 'Drive');
// Kerb on the left of travel: northbound traffic has its kerb on the west side, and so on.
const LEFT = { N: [[-1, 0]], S: [[1, 0]], E: [[0, 1]], W: [[0, -1]], 'N-S': [[-1, 0], [1, 0]], 'E-W': [[0, 1], [0, -1]] };
const SIDE_NAME = { '-1,0': 'West side', '1,0': 'East side', '0,1': 'North side', '0,-1': 'South side' };

// Drop points that sit within `tol` metres of the line between their neighbours (Douglas-Peucker).
function simplify(pts, tol = 3) {
  if (pts.length < 3) return pts;
  const kx = Math.cos((pts[0][1] * Math.PI) / 180) * 111320, ky = 110540;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[a][0] * kx, ay = pts[a][1] * ky, bx = pts[b][0] * kx, by = pts[b][1] * ky, L = Math.hypot(bx - ax, by - ay) || 1;
    let best = 0, bi = -1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((bx - ax) * (ay - pts[i][1] * ky) - (ax - pts[i][0] * kx) * (by - ay)) / L; if (d > best) { best = d; bi = i; } }
    if (best > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// `existing` is every kerb already on the map: clearway lines are only drawn where none of those is within 15 m.
export function buildClearways(raw, reg, { existing = [] } = {}) {
  const CELL = 0.0005, grid = new Map(), cell = (c) => `${Math.floor(c[0] / CELL)}:${Math.floor(c[1] / CELL)}`;
  for (const f of existing) for (const c of f.geometry.coordinates) { const k = cell(c); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(c); }
  const near = (c) => { const x = Math.floor(c[0] / CELL), y = Math.floor(c[1] / CELL); for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const q of grid.get(`${x + i}:${y + j}`) || []) if (dist(q, c) < 15) return true; return false; };
  const features = [];
  for (const cw of raw) {
    const rules = readClearway(cw.hours);
    if (!rules) continue;
    const text = `Clearway ${cw.hours.replace(/\s+/g, ' ')}`;
    const k = reg.add({ rules, q: 0, g: 'unknown', u: 0, src: 'Transport for NSW clearways (2018 data, CC BY)', text });
    for (const [vx, vy] of LEFT[cw.dir] || []) for (const line of cw.lines) {
      // Shift ~6 m towards the kerb, then keep only the runs Kerb has nothing else for.
      const pts = line.map(([lon, lat]) => round([lon + (vx * 6) / (Math.cos((lat * Math.PI) / 180) * 111320), lat + (vy * 6) / 110540]));
      let run = [];
      const flush = () => {
        if (run.length > 1 && dist(run[0], run[run.length - 1]) > 20) {
          // Pieces of at most ~400 m, so walking distances and taps point at the right stretch, not a 5 km road.
          let piece = [run[0]], len = 0;
          const emit = () => { if (piece.length > 1) features.push({ type: 'Feature', properties: { s: titleCase(cw.street), b: titleCase(cw.suburb), sd: SIDE_NAME[`${vx},${vy}`], k, z: 2, pa: '', f15: 0, n: 0, src: 'cw' }, geometry: { type: 'LineString', coordinates: simplify(piece) } }); };
          for (let i = 1; i < run.length; i++) { piece.push(run[i]); len += dist(run[i - 1], run[i]); if (len > 400 && i < run.length - 1) { emit(); piece = [run[i]]; len = 0; } }
          emit();
        }
        run = [];
      };
      for (const p of pts) { if (near(p)) flush(); else run.push(p); }
      flush();
    }
  }
  log(`  clearways: ${features.length} kerb pieces drawn`);
  return { features, carparks: [] };
}
