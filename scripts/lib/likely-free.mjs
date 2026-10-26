// "Probably no limit" streets: local streets in councils whose resident permit streets Kerb has in full
// (Parramatta, Strathfield, Randwick), that aren't in a permit area, near a station or town centre, or covered by
// any other kerb data. Shown as "probably free, check the sign" (like Woollahra's no-scheme streets), never as a rule.
import { fetchRoads } from './regions.mjs';
import { dist, distToSeg, round, inRings } from './geo.mjs';

const log = (...a) => (globalThis.__log || console.log)(...a);
const LGA = 'https://portal.spatial.nsw.gov.au/server/rest/services/NSW_Administrative_Boundaries_Theme/FeatureServer/8/query';

// Places where kerbs are usually time-limited even outside permit areas: centres, stations, hospitals, beaches.
// [lon, lat, radius m]
const BUSY = [
  // Parramatta
  [151.0035, -33.8155, 900], [150.9875, -33.8045, 700], [151.068, -33.845, 1900], [151.008, -33.8226, 350], [151.0122, -33.8327, 400],
  [150.9877, -33.8079, 400], [150.9718, -33.807, 350], [151.0822, -33.7727, 500], [151.081, -33.7905, 450], [151.042, -33.7939, 300],
  [151.0491, -33.7796, 450], [151.0349, -33.7998, 300], [151.0322, -33.8105, 300], [151.0177, -33.8337, 300], [151.0556, -33.8127, 250],
  [150.981, -33.776, 250], [151.0228, -33.8235, 500], [151.0745, -33.8285, 700],
  // Strathfield
  [151.0868, -33.8669, 450], [151.0941, -33.8714, 500], [151.0712, -33.8642, 400], [151.0835, -33.8935, 250],
  // Randwick
  [151.2415, -33.9165, 450], [151.2265, -33.9235, 350], [151.224, -33.909, 350], [151.2405, -33.9455, 400], [151.257, -33.921, 550],
  [151.2575, -33.9495, 450], [151.2675, -33.9135, 350], [151.231, -33.9175, 650], [151.239, -33.9195, 450], [151.231, -33.958, 250],
  [151.248, -33.963, 250], [151.2595, -33.9365, 300], [151.218, -33.903, 600],
];
export const LIKELY_FREE_COUNCILS = [
  { lga: 'PARRAMATTA', label: "City of Parramatta's permit areas street guide" },
  { lga: 'STRATHFIELD', label: "Strathfield Council's resident parking scheme maps" },
  { lga: 'RANDWICK', label: "Randwick Council's resident parking zone map" },
];

export async function fetchLikelyFree(councils = LIKELY_FREE_COUNCILS) {
  const out = [];
  for (const c of councils) {
    const q = new URLSearchParams({ where: `lganame LIKE '%${c.lga}%'`, outFields: 'lganame', outSR: '4326', f: 'json', returnGeometry: 'true', maxAllowableOffset: '0.0003', geometryPrecision: '5' });
    const r = await fetch(`${LGA}?${q}`, { signal: AbortSignal.timeout(60000) });
    const j = await r.json();
    const f = j.features?.[0];
    if (!f?.geometry?.rings) throw new Error(`no boundary for ${c.lga}`);
    const rings = f.geometry.rings;
    const xs = rings.flat().map((p) => p[0]), ys = rings.flat().map((p) => p[1]);
    const roads = (await fetchRoads([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]))
      .filter((x) => x.attributes.functionhierarchy === 6 && x.geometry?.paths);
    out.push({ ...c, name: f.attributes.lganame, rings, roads: roads.map((x) => ({ n: [x.attributes.roadnamebase, x.attributes.roadnametype, x.attributes.roadnamesuffix].filter(Boolean).join(' '), p: x.geometry.paths })) });
    log(`  likely free: ${f.attributes.lganame}, ${roads.length} local road pieces`);
  }
  return out;
}

const titleCase = (s) => String(s || '').toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase()).replace(/\bMc([a-z])/g, (m, ch) => 'Mc' + ch.toUpperCase());

export function buildLikelyFree(raw, { existing = [] } = {}) {
  const CELL = 0.0005, grid = new Map(), cell = (x, y) => `${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`;
  // Every kerb already on the map, as short segments, so a street that has anything published is left alone.
  for (const f of existing) {
    const c = f.geometry.coordinates;
    for (let i = 1; i < c.length; i++) { const m = [(c[i - 1][0] + c[i][0]) / 2, (c[i - 1][1] + c[i][1]) / 2]; const k = cell(m[0], m[1]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push([c[i - 1], c[i]]); }
  }
  const covered = (p) => { const x = Math.floor(p[0] / CELL), y = Math.floor(p[1] / CELL); for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const [a, b] of grid.get(`${x + i}:${y + j}`) || []) if (distToSeg(p, a, b) < 14) return true; return false; };
  const busy = (p) => BUSY.some(([x, y, r]) => dist([x, y], p) < r);
  const features = [];
  for (const area of raw) {
    let n = 0;
    for (const rd of area.roads) for (const path of rd.p) {
      let run = [];
      const flush = () => { if (run.length > 1 && dist(run[0], run[run.length - 1]) > 25) { features.push({ type: 'Feature', properties: { s: titleCase(rd.n), b: '', k: -1, z: 0, pa: '', lk: 1, lks: area.label, f15: 0, n: 0, src: 'lf' }, geometry: { type: 'LineString', coordinates: run.map((c) => round(c)) } }); n++; } run = []; };
      for (const p of path) { if (!inRings(p, area.rings) || busy(p) || covered(p)) flush(); else run.push(p); }
      flush();
    }
    log(`  likely free: ${area.name}, ${n} street pieces`);
  }
  return { features, carparks: [] };
}
