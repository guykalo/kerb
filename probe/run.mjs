// Probe round 4: where are these streets? (NSW road centrelines, Spatial Services)
import { writeFile, mkdir } from 'node:fs/promises';
await mkdir('out', { recursive: true });
const NSW = 'https://portal.spatial.nsw.gov.au/server/rest/services/NSW_Transport_Theme/FeatureServer/5/query';
const names = { FRANKLIN: 'STREET', MEEHAN: 'STREET', BURNETT: 'STREET', NAPIER: 'LANE', BROUGHTON: 'STREET', TENNYSON: 'STREET', "O'REILLY": 'STREET', BALMORAL: 'ROAD', HAINSWORTH: 'STREET', DUKE: 'LANE', PILGRIM: 'AVENUE', MARGARET: 'STREET', BRUNSWICK: 'AVENUE', FLEET: 'STREET', BANKS: 'STREET', ELVA: 'STREET', PEMBERTON: 'LANE', STEELE: 'STREET', ANDERSON: 'AVENUE' };
const out = [];
for (const [b, t] of Object.entries(names)) {
  const q = new URLSearchParams({ where: `roadnamebase='${b.replace("'", "''")}'`, geometry: JSON.stringify({ xmin: 150.95, ymin: -33.9, xmax: 151.11, ymax: -33.76, spatialReference: { wkid: 4326 } }), geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: 'roadnamebase,roadnametype,functionhierarchy,roadontype', outSR: '4326', geometryPrecision: '5', f: 'json' });
  try {
    const j = await (await fetch(`${NSW}?${q}`)).json();
    for (const f of j.features || []) { const p = f.geometry?.paths?.[0]; if (!p) continue; const m = p[Math.floor(p.length / 2)]; out.push(`${b} ${f.attributes.roadnametype} fh=${f.attributes.functionhierarchy} on=${f.attributes.roadontype} ${m[0]},${m[1]}`); }
  } catch (e) { out.push(`${b} failed ${e.message}`); }
}
await writeFile('out/log.txt', out.join('\n'));
