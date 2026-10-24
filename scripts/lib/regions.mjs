// Councils beyond the City of Sydney. Each has a fetch (raw open data) and a build (kerb features).
import { unzip, readDbf, readShp, mga56ToLonLat } from './shapefile.mjs';
import { parseWaverley, parseFee } from './parse-waverley.mjs';
import { distToSeg, dist, round, bbox } from './geo.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, as = 'json', tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const v = as === 'json' ? await r.json() : await r.arrayBuffer();
      if (as === 'json' && v.error) throw new Error(`ArcGIS error ${v.error.code}: ${v.error.message}`);
      return v;
    } catch (e) {
      if (i >= tries) throw new Error(`${url}\n  ${e.message}`);
      await sleep(1500 * 2 ** i);
    }
  }
}
const titleCase = (s) => String(s || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bMc([a-z])/g, (m, c) => 'Mc' + c.toUpperCase());
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const log = (...a) => (globalThis.__log || console.log)(...a);

async function arcgisAll(url, params) {
  const out = [];
  for (let start = 0; ; start += 2000) {
    const q = new URLSearchParams({ where: '1=1', outSR: '4326', f: 'json', resultOffset: String(start), resultRecordCount: '2000', ...params });
    const j = await get(`${url}/query?${q}`);
    out.push(...j.features);
    if (!j.exceededTransferLimit && j.features.length < 2000) break;
  }
  return out;
}

/* ---------- NSW road centrelines (Spatial Services, statewide) ---------- */
const NSW_ROADS = 'https://portal.spatial.nsw.gov.au/server/rest/services/NSW_Transport_Theme/FeatureServer/5';
export async function fetchRoads([x0, y0, x1, y1]) {
  // Ask for a grid of tiles so no single query hits the record limit.
  const feats = [];
  const step = 0.02;
  for (let x = x0; x < x1; x += step) for (let y = y0; y < y1; y += step) {
    const env = JSON.stringify({ xmin: x, ymin: y, xmax: Math.min(x + step, x1), ymax: Math.min(y + step, y1), spatialReference: { wkid: 4326 } });
    const f = await arcgisAll(NSW_ROADS, { geometry: env, geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: 'objectid,roadnamebase,roadnametype,roadnamesuffix,functionhierarchy,roadontype', where: 'roadontype=1 AND functionhierarchy>=2 AND functionhierarchy<=6', geometryPrecision: '6' });
    feats.push(...f);
  }
  const seen = new Set();
  return feats.filter((f) => !seen.has(f.attributes.objectid) && seen.add(f.attributes.objectid));
}
const roadName = (a) => titleCase([a.roadnamebase, a.roadnametype, a.roadnamesuffix].filter(Boolean).join(' '));

/* ---------- Waverley (Bondi, Bronte, Bondi Junction, Tamarama, Dover Heights) ---------- */
const WAV = 'https://opendata.transport.nsw.gov.au/data/dataset/5a6d694f-fbbf-49d9-a147-b7d7b00c8013/resource/';
const WAV_FILES = {
  bays: `${WAV}b3b2959c-ea26-4817-81d6-d2159f60bbe9/download/onstreetcarparkingspacesv2_3.zip`,
  meters: `${WAV}bc55f663-3403-4bc8-9bff-a43c1a00d6f7/download/parkingmeters_5.zip`,
  carparks: `${WAV}bab533d4-d7f2-4965-a3fc-1a8df89b37c2/download/carparks_4.zip`,
};
async function readZipShp(url) {
  const files = await unzip(await get(url, 'buf'));
  const key = (ext) => Object.keys(files).find((k) => k.toLowerCase().endsWith(ext));
  const rows = readDbf(files[key('.dbf')]);
  const geoms = readShp(files[key('.shp')]);
  return rows.map((r, i) => ({ ...r, geom: geoms[i] }));
}
const toLL = (g) => (Array.isArray(g[0]) ? g.map((line) => line.map(mga56ToLonLat)) : mga56ToLonLat(g));

export async function fetchWaverley() {
  const [bays, meters, carparks] = await Promise.all(Object.values(WAV_FILES).map(readZipShp));
  const slim = (r) => ({ ...r, geom: r.geom && toLL(r.geom) });
  const out = {
    bays: bays.filter((b) => b.ParkData !== 'no parking data' && b.geom).map(slim),
    meters: meters.filter((m) => m.geom).map(slim),
    carparks: carparks.filter((c) => c.geom).map(slim),
  };
  log(`  waverley: ${out.bays.length} kerbs with rules, ${out.meters.length} meters, ${out.carparks.length} car parks`);
  return out;
}

const BEACHES = [[151.2767, -33.8915], [151.2683, -33.9035], [151.2672, -33.9012]]; // Bondi, Bronte, Tamarama

export function buildWaverley(raw, reg, { month }) {
  const feats = [];
  const metersBySt = new Map();
  for (const m of raw.meters) {
    const k = norm(m.Street);
    if (!metersBySt.has(k)) metersBySt.set(k, []);
    metersBySt.get(k).push(m);
  }
  for (const b of raw.bays) {
    const lines = b.geom;
    const all = lines.flat();
    if (all.length < 2) continue;
    const mid = all[Math.floor(all.length / 2)];
    // A meter on the same street within 30 m means this kerb is paid; its sign text is more complete.
    let meter = null, best = 30;
    for (const m of metersBySt.get(norm(b.Street)) || []) {
      for (const line of lines) for (let i = 1; i < line.length; i++) { const d = distToSeg(m.geom, line[i - 1], line[i]); if (d < best) { best = d; meter = m; } }
    }
    let parsed;
    if (meter) {
      const text = [meter.Restr1, meter.Restr2, meter.Restr3, meter.Restr4].filter(Boolean).join(', ');
      parsed = parseWaverley(text, { month, rate: parseFee(meter.ParkFee) });
      parsed.text = text; parsed.fee = meter.ParkFee;
    } else {
      parsed = parseWaverley(b.Rules, { month });
      parsed.text = b.Rules;
    }
    if (parsed.unknown && !parsed.unrestricted) continue;
    const k = reg.add({ rules: parsed.rules, q: 0, text: parsed.text, g: 'free', u: parsed.unrestricted ? 1 : 0, src: 'Waverley Council' });
    const nearBeach = BEACHES.some((p) => dist(p, mid) < 450);
    const pa = (/area\s*(\d+)/.exec(parsed.text || '') || [])[1];
    for (const line of lines) {
      if (line.length < 2) continue;
      feats.push({
        type: 'Feature',
        properties: { s: titleCase(b.Street), b: b.Side ? `${titleCase(b.Side)} side` : '', k, z: nearBeach ? 3 : 2, pa: pa ? `Area ${pa}` : '', f15: 0, n: 0, src: 'w' },
        geometry: { type: 'LineString', coordinates: line.map((c) => round(c)) },
      });
    }
  }
  const carparks = raw.carparks.map((c, i) => ({
    id: `wav-${i}`, name: c.Name || c.NAME || c.CarPark || `Car park ${i + 1}`, address: [c.Street || c.Address, 'Waverley'].filter(Boolean).join(', '),
    entry: c.Entry || '', operator: 'Waverley Council', at: round(Array.isArray(c.geom[0]) ? c.geom[0][0] : c.geom), source: 'Waverley Council',
  }));
  return { features: feats, carparks };
}

/* ---------- Woollahra (Rose Bay, Double Bay, Paddington, Bellevue Hill, Vaucluse, Watsons Bay) ---------- */
const WOOL = 'https://services3.arcgis.com/zjbesynggtrdwb3p/arcgis/rest/services';
export async function fetchWoollahra() {
  const props = (await arcgisAll(`${WOOL}/Resident_Parking_Scheme_Areas/FeatureServer/0`, { outFields: 'res_pk,street,lat,lng', returnGeometry: 'false', orderByFields: 'OBJECTID' }))
    .map((f) => f.attributes).filter((a) => a.lat && a.lng).map((a) => [+a.lng.toFixed(6), +a.lat.toFixed(6), a.res_pk, a.street || '']);
  const carparks = (await arcgisAll(`${WOOL}/Car_Parks/FeatureServer/0`, { outFields: 'NAME,INFO_1' })).map((f) => f.attributes && f.geometry && ({ ...f.attributes, at: f.geometry.points ? f.geometry.points[0] : [f.geometry.x, f.geometry.y] })).filter(Boolean);
  const [x0, y0, x1, y1] = bbox(props.map((p) => [p[0], p[1]]));
  const roads = await fetchRoads([x0 - 0.002, y0 - 0.002, x1 + 0.002, y1 + 0.002]);
  log(`  woollahra: ${props.length} properties, ${roads.length} road segments, ${carparks.length} car parks`);
  return { props, roads, carparks };
}

export function buildWoollahra(raw) {
  const CELL = 0.001, grid = new Map();
  for (const p of raw.props) { const k = `${Math.floor(p[0] / CELL)}:${Math.floor(p[1] / CELL)}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(p); }
  const near = (pt) => { const out = []; const cx = Math.floor(pt[0] / CELL), cy = Math.floor(pt[1] / CELL); for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) out.push(...(grid.get(`${cx + i}:${cy + j}`) || [])); return out; };
  const feats = [];
  for (const r of raw.roads) {
    const a = r.attributes, name = roadName(a);
    if (!name || !r.geometry?.paths) continue;
    for (const path of r.geometry.paths) {
      if (path.length < 2) continue;
      // Properties within 45 m of this stretch of road decide whether it's in a resident permit scheme.
      const tally = new Map(); let total = 0;
      const mid = path[Math.floor(path.length / 2)];
      for (const p of near(mid)) {
        let d = Infinity;
        for (let i = 1; i < path.length; i++) d = Math.min(d, distToSeg([p[0], p[1]], path[i - 1], path[i]));
        if (d > 45) continue;
        const sameStreet = norm(p[3]) === norm(name);
        const w = sameStreet ? 3 : 1;
        tally.set(p[2], (tally.get(p[2]) || 0) + w); total += w;
      }
      if (!total) continue; // not a Woollahra street
      const top = [...tally.entries()].sort((x, y) => y[1] - x[1])[0][0];
      const noScheme = top === 'No Scheme';
      feats.push({
        type: 'Feature',
        properties: { s: name, b: '', k: -1, z: 0, pa: noScheme ? '' : top === 'Not Eligible' ? 'Resident scheme' : top, lk: noScheme ? 1 : 0, f15: 0, n: 0, src: 'wo', fh: a.functionhierarchy },
        geometry: { type: 'LineString', coordinates: path.map((c) => round(c)) },
      });
    }
  }
  const carparks = raw.carparks.map((c, i) => ({ id: `wool-${i}`, name: c.NAME, address: c.INFO_1 || '', entry: '', operator: 'Woollahra Council', at: round(c.at), source: 'Woollahra Council' }));
  return { features: feats, carparks };
}

/* ---------- Randwick (Coogee, Randwick, Kensington, Kingsford, Maroubra) ---------- */
// Every kerb in a resident parking scheme, drawn kerb by kerb, with its zone and number of spaces.
// The council doesn't publish the sign times, so these show as permit areas: visitors are usually time-limited.
const RANDWICK = 'https://mapservices.randwick.nsw.gov.au/arcgis/rest/services/extTransport/ResidentParkingZone/MapServer/0';
// The council's server refuses connections from GitHub's build machines, so when the live fetch fails we use
// data/snapshots/randwick.json, a copy saved from the same service (compact: coordinates as 1e-5 degree deltas).
export async function fetchRandwick() {
  try {
    const zones = (await arcgisAll(RANDWICK, { outFields: 'streetName,suburb,residentParkingSchemeZone,availableSpace,fromHouseNumber,toHouseNumber', orderByFields: 'OBJECTID', geometryPrecision: '6' }))
      .filter((f) => f.geometry?.paths).map((f) => ({ ...f.attributes, paths: f.geometry.paths }));
    log(`  randwick: ${zones.length} resident permit kerbs (live)`);
    return { zones, snapshot: false };
  } catch (e) {
    const { readFile } = await import('node:fs/promises');
    const rows = JSON.parse(await readFile(new URL('../../data/snapshots/randwick.json', import.meta.url), 'utf8'));
    const zones = rows.map(([streetName, suburb, residentParkingSchemeZone, availableSpace, fromHouseNumber, toHouseNumber, paths]) => ({
      streetName, suburb, residentParkingSchemeZone, availableSpace, fromHouseNumber, toHouseNumber,
      paths: paths.map((d) => { const out = []; let x = 0, y = 0; for (let i = 0; i < d.length; i += 2) { x += d[i]; y += d[i + 1]; out.push([x / 1e5, y / 1e5]); } return out; }),
    }));
    log(`  randwick: live fetch failed (${e.message.split('\n').pop().trim()}), using the saved copy: ${zones.length} kerbs`);
    return { zones, snapshot: true };
  }
}
function ruleFor(z, reg) {
  if (!reg) return -1;
  const st = norm(z.streetName), zone = String(z.residentParkingSchemeZone || '').trim().toUpperCase();
  const r = RANDWICK_RULES.find(([zn, streets]) => zn === zone && streets.includes(st));
  if (!r) return -1;
  const [zn, , hours, days, from, to, srcDoc] = r;
  return reg.add({ rules: [[hours, days, from, to, 0, 0, 0, `Permit holders Area ${zn} excepted`]], q: 0, g: 'free', u: 0, src: `Randwick Council ${srcDoc}`, text: `${hours}P ${from === 8.5 ? '8:30am' : `${from}am`}-${to - 12}pm ${days.length === 7 ? 'every day' : 'Mon-Fri'}, permit holders excepted, Area ${zn}` });
}
const houses = (a = '', b = '') => {
  [a, b] = [String(a).trim(), String(b).trim()];
  if (!a && !b) return '';
  const span = b && b !== a ? `${a || b} to ${b}` : a || b;
  return /^\d/.test(a || b) ? `Outside ${span}` : span;
};
// Sign wording from Randwick Traffic Committee resolutions, applied only to the named streets in the named zone.
// [zone, streets, hours, days, from, to, source]
const MF = [1, 2, 3, 4, 5], ALL7 = [0, 1, 2, 3, 4, 5, 6];
const RANDWICK_RULES = [
  ['RA6', ['avoca street', 'cowper street', 'fraser street', 'hodgson street', 'market street', 'mclennan avenue', 'monmouth street', 'randwick street', 'stanley street'], 2, MF, 8, 18, 'Traffic Committee TC168/20 (Nov 2020)'],
  ['RA11', ['canberra street', 'dudley street', 'ethel street', 'henry street', 'frederick street'], 2, MF, 8, 20, 'Traffic Committee TC6/24 (Feb 2024)'],
  ['KN1', ['roma avenue'], 1, ALL7, 8, 20, 'Traffic Committee TC2/24 (Feb 2024)'],
  ['KN1', ['doncaster avenue'], 1, MF, 8, 18, 'Traffic Committee TC2/24 (Feb 2024)'],
  ['CO1', ['bream street'], 2, ALL7, 8, 20, 'Traffic Committee TC80/22 (Jun 2022)'],
  ['SP1', ['cuthill street'], 1, ALL7, 8.5, 22, 'Traffic Committee TC122/22 (Sep 2022)'],
];
export function buildRandwick(raw, reg) {
  const features = [];
  for (const z of raw.zones) for (const path of z.paths) {
    if (path.length < 2) continue;
    features.push({
      type: 'Feature',
      properties: { s: titleCase(z.streetName), b: titleCase(z.suburb), sd: houses(z.fromHouseNumber, z.toHouseNumber), k: ruleFor(z, reg), z: 0, pa: z.residentParkingSchemeZone ? `Area ${z.residentParkingSchemeZone}` : 'Resident scheme', lk: 0, f15: 0, n: +z.availableSpace || 0, src: 'rw' },
      geometry: { type: 'LineString', coordinates: path.map((c) => round(c)) },
    });
  }
  return { features, carparks: [] };
}

/* ---------- Sydney CBD car parks (Transport for NSW off-street parking list, 2016) ---------- */
// Locations, owners, sizes and height limits. No prices: each links to its own website for rates.
const OFFSTREET = 'https://opendata.transport.nsw.gov.au/data/dataset/ba82882b-e145-4594-bc2a-f312397a9225/resource/5796550d-fc7d-43ef-900b-74de13eb23b5/download/offstreetparkingdata_2.geojson';
export async function fetchOffstreet() {
  const g = await get(OFFSTREET);
  log(`  cbd car parks: ${g.features.length}`);
  return g.features.filter((f) => f.geometry?.coordinates).map((f) => ({ ...f.properties, at: f.geometry.coordinates }));
}
const hhmm = (n) => { n = +n || 0; if (n === 0 || n === 2400) return 'midnight'; const h = Math.floor(n / 100), m = n % 100; return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''}${h < 12 || h === 24 ? 'am' : 'pm'}`; };
export function buildOffstreet(raw, existing) {
  const out = [];
  for (const c of raw) {
    const at = round(c.at);
    if (existing.some((e) => dist(e.at, at) < 60)) continue; // already on the map with better data
    const name = String(c.Building_name_location || '').trim() || `${c.Owner} car park`;
    out.push({
      id: `cbd-${c.FRD_ID}`, name: /car ?park/i.test(name) ? name : `${name} car park`,
      address: [[c.Street_Number_GPS, c.Street_Name_GPS].filter(Boolean).join(' '), c.Suburb_GPS].filter(Boolean).join(', '),
      entry: c.Between ? `${c.Street_Name_GPS}, between ${c.Between}` : '', operator: c.Owner || '',
      spaces: +c.Total_number_of_bays || undefined, phone: c.Phone || '', url: /^https?:/.test(c.URL || '') ? c.URL : '',
      hours: c.Open || c.Close ? `${hhmm(c.Open)} to ${hhmm(c.Close)}` : '',
      note: c.Height_Res ? `Height limit ${c.Height_Res}m.` : '',
      at, source: 'Transport for NSW car park list (2016)',
    });
  }
  return out;
}

/* ---------- rules read by hand from council PDFs (data/manual-rules.json) ---------- */
export async function fetchManual() {
  const { readFile } = await import('node:fs/promises');
  const spec = JSON.parse(await readFile(new URL('../../data/manual-rules.json', import.meta.url), 'utf8'));
  const pts = spec.streets.map((e) => e.near);
  const pad = 0.006;
  const [x0, y0, x1, y1] = bbox(pts);
  const roads = await fetchRoads([x0 - pad, y0 - pad, x1 + pad, y1 + pad]);
  log(`  manual rules: ${spec.streets.length} street stretches, ${roads.length} road segments`);
  return { spec, roads };
}
const DIRS = { north: [0, 1], south: [0, -1], east: [1, 0], west: [-1, 0] };
export function buildManual(raw, reg) {
  const kx = (lat) => Math.cos((lat * Math.PI) / 180) * 111320, ky = 110540;
  const features = [];
  for (const e of raw.spec.streets) {
    const set = { rules: e.rules, q: 0, g: 'free', u: 0, src: raw.spec.sources[e.src] ? raw.spec.sources[e.src].split(':')[0] : e.src };
    const k = reg.add(set);
    const sides = e.side.includes('both') ? [1, -1] : null;
    for (const r of raw.roads) {
      if (norm(roadName(r.attributes)) !== norm(e.street) || !r.geometry?.paths) continue;
      for (const path of r.geometry.paths) {
        const pts = densifyPath(path, 12);
        const cur = { 1: null, '-1': null };
        const flush = (sd) => { if (cur[sd] && cur[sd].coords.length > 1) features.push(cur[sd]); cur[sd] = null; };
        for (let i = 1; i < pts.length; i++) {
          const s0 = pts[i - 1], s1 = pts[i], mid = [(s0[0] + s1[0]) / 2, (s0[1] + s1[1]) / 2];
          if (dist(mid, e.near) > e.radius) { flush(1); flush(-1); continue; }
          const dx = (s1[0] - s0[0]) * kx(mid[1]), dy = (s1[1] - s0[1]) * ky, len = Math.hypot(dx, dy) || 1;
          const nx = -dy / len, ny = dx / len;
          for (const sd of [1, -1]) {
            const ok = sides ? true : e.side.some((d) => DIRS[d] && (sd * nx * DIRS[d][0] + sd * ny * DIRS[d][1]) > 0.35);
            if (!ok) { flush(sd); continue; }
            const off = (q) => [q[0] + (sd * nx * 5.5) / kx(q[1]), q[1] + (sd * ny * 5.5) / ky];
            if (!cur[sd]) {
              const ang = (Math.atan2(sd * nx, sd * ny) * 180) / Math.PI;
              const sdName = ['North', 'North-east', 'East', 'South-east', 'South', 'South-west', 'West', 'North-west'][Math.round(((ang + 360) % 360) / 45) % 8] + ' side';
              cur[sd] = { type: 'Feature', properties: { s: e.street, b: e.suburb, sd: sdName, k, z: 3, pa: '', f15: 0, n: 0, src: 'man' }, geometry: { type: 'LineString', coordinates: [round(off(s0))] }, coords: null };
              cur[sd].coords = cur[sd].geometry.coordinates;
            }
            cur[sd].coords.push(round(off(s1)));
          }
        }
        flush(1); flush(-1);
      }
    }
  }
  for (const f of features) delete f.coords;
  return { features, carparks: [] };
}
function densifyPath(path, maxLen) {
  const out = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], n = Math.max(1, Math.ceil(dist(a, b) / maxLen));
    for (let j = 1; j <= n; j++) out.push([a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n]);
  }
  return out;
}
