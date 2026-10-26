// Bayside Council (Mascot, Botany, Wolli Creek, Arncliffe... around Sydney Airport): the council's resident parking
// scheme map is a public ArcGIS layer of kerb-side polygons, one per stretch, labelled with the permit area.
// Only one area (B1) has its sign wording in the data; the rest show as permit areas with no sign times.
import { fetchRoads } from './regions.mjs';
import { dist, distToSeg, round } from './geo.mjs';
import { daysTimes } from './cities/common.mjs';

const log = (...a) => (globalThis.__log || console.log)(...a);
const SCHEME = 'https://services7.arcgis.com/L1i6OQHVUek3lIg4/arcgis/rest/services/Parking_Scheme/FeatureServer/0/query';
export const BAYSIDE_SRC = "Bayside Council's resident parking scheme map";

export async function fetchBayside() {
  const q = new URLSearchParams({ where: '1=1', outFields: 'SCHEME,Comment,Area_Code,Updated_Date', outSR: '4326', f: 'json', geometryPrecision: '6' });
  const r = await fetch(`${SCHEME}?${q}`, { signal: AbortSignal.timeout(60000) });
  const j = await r.json();
  const polys = (j.features || []).filter((f) => f.geometry?.rings).map((f) => ({ ...f.attributes, rings: f.geometry.rings }));
  if (!polys.length) throw new Error('no Bayside parking scheme polygons');
  const xs = polys.flatMap((p) => p.rings.flat().map((c) => c[0])), ys = polys.flatMap((p) => p.rings.flat().map((c) => c[1]));
  const roads = (await fetchRoads([Math.min(...xs) - 0.002, Math.min(...ys) - 0.002, Math.max(...xs) + 0.002, Math.max(...ys) + 0.002]))
    .filter((x) => x.geometry?.paths).map((x) => ({ n: [x.attributes.roadnamebase, x.attributes.roadnametype, x.attributes.roadnamesuffix].filter(Boolean).join(' '), p: x.geometry.paths }));
  log(`  bayside: ${polys.length} permit scheme stretches, ${roads.length} road pieces`);
  return { polys, roads, fetchedAt: new Date().toISOString() };
}

const titleCase = (s) => String(s || '').toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase()).replace(/\bMc([a-z])/g, (m, ch) => 'Mc' + ch.toUpperCase());
// Which suburb each area code is in (from where the council's polygons sit).
const SUBURB = { A: 'Mascot', B: 'Mascot', C: 'Mascot', D: 'Mascot', E: 'Mascot', F: 'Mascot', G: 'Mascot', B1: 'Botany', 'B1 B2': 'Botany', DCY: 'Daceyville', W1: 'Wolli Creek', ARN: 'Arncliffe', ARN2: 'Arncliffe', BKS1: 'Banksia', RCD: 'Rockdale', KGR: 'Kogarah', DPT: 'Dolls Point' };

// A kerb-side strip polygon -> a line along its long axis.
function stripLine(ring) {
  const pts = ring.slice(0, -1);
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const kx = Math.cos((cy * Math.PI) / 180) * 111320, ky = 110540;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) { const x = (p[0] - cx) * kx, y = (p[1] - cy) * ky; sxx += x * x; syy += y * y; sxy += x * y; }
  const a = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(a), uy = Math.sin(a);
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) { const t = (p[0] - cx) * kx * ux + (p[1] - cy) * ky * uy; lo = Math.min(lo, t); hi = Math.max(hi, t); }
  if (hi - lo < 8) return null;
  return [round([cx + (lo * ux) / kx, cy + (lo * uy) / ky]), round([cx + (hi * ux) / kx, cy + (hi * uy) / ky])];
}

export function buildBayside(raw, reg) {
  const features = [];
  let skipped = 0;
  for (const p of raw.polys) {
    const code = String(p.Area_Code || '').replace(/^Area\s*/i, '').trim();
    for (const ring of p.rings) {
      const line = stripLine(ring);
      if (!line) { skipped++; continue; }
      const mid = [(line[0][0] + line[1][0]) / 2, (line[0][1] + line[1][1]) / 2];
      let best = null;
      for (const r of raw.roads) for (const path of r.p) for (let i = 1; i < path.length; i++) { const d = distToSeg(mid, path[i - 1], path[i]); if (d < 40 && (!best || d < best.d)) best = { d, n: r.n }; }
      // Area B1's polygon carries its sign: "3P; 8am-6pm, Mon-Fri;8am-12pm,Sat; Permit Holders Excepted".
      const sign = String(p.Comment || '').trim();
      let k = -1;
      if (sign) {
        const hm = /(\d+)\s*P\b/i.exec(sign);
        const times = daysTimes(sign.replace(/;/g, ','));
        if (hm && times.length) k = reg.add({ rules: times.map((t) => [+hm[1], t.days, t.from, t.to, 0, 0, 0, `Permit holders Area ${code} excepted`]), q: 0, g: 'edges', u: 0, src: BAYSIDE_SRC, text: sign });
      }
      features.push({ type: 'Feature', properties: { s: best ? titleCase(best.n) : 'Permit street', b: SUBURB[code] || '', sd: '', k, z: 2, pa: `Bayside Area ${code}`, f15: 0, n: 0, src: 'bay', ...(k < 0 ? { ps: BAYSIDE_SRC } : {}) }, geometry: { type: 'LineString', coordinates: line } });
    }
  }
  log(`  bayside: ${features.length} permit kerbs (${skipped} too small)`);
  return { features, carparks: [] };
}
