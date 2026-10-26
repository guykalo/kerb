// Probe round 8: Melbourne, Brisbane, Perth parking open data (schemas and samples).
import { writeFile, mkdir } from 'node:fs/promises';
await mkdir('out', { recursive: true });
const log = [];
const say = (...a) => { console.log(...a); log.push(a.join(' ')); };
const UA = { 'User-Agent': 'Kerb parking map (github.com/guykalo/kerb)' };
const get = async (u, name) => {
  try { const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(90000) }); const t = await r.text(); await writeFile(`out/${name}`, t); say('ok', name, r.status, t.length); return t; }
  catch (e) { say('failed', name, e.message); return ''; }
};
const MEL = 'https://data.melbourne.vic.gov.au/api/explore/v2.1';
const BNE = 'https://data.brisbane.qld.gov.au/api/explore/v2.1';
await get(`${MEL}/catalog/datasets?where=search(%22parking%22)&limit=60&select=dataset_id,metas.default.title,metas.default.records_count,metas.default.modified`, 'mel-catalog.json');
for (const d of ['on-street-parking-bay-sensors', 'on-street-parking-bays', 'on-street-car-park-bay-restrictions', 'sign-plates-located-in-each-parking-zone', 'parking-zones-linked-to-street-segments', 'off-street-car-parks-with-capacity-and-type', 'road-segments-with-surface-type'])
  await get(`${MEL}/catalog/datasets/${d}/records?limit=5`, `mel-${d}.json`);
await get(`${BNE}/catalog/datasets?where=search(%22parking%22)&limit=60&select=dataset_id,metas.default.title,metas.default.records_count,metas.default.modified`, 'bne-catalog.json');
for (const d of ['brisbane-parking-meters', 'parking-line-locations', 'brisbane-council-car-parks', 'disability-permit-parking-locations', 'loading-zones'])
  await get(`${BNE}/catalog/datasets/${d}/records?limit=5`, `bne-${d}.json`);
await get('https://geohub-perth.opendata.arcgis.com/api/search/v1/collections/all/items?q=parking&limit=40', 'per-hub-search.json');
await get('https://geohub-perth.opendata.arcgis.com/api/search/v1/collections/all/items?q=car%20park&limit=40', 'per-hub-search-carpark.json');
await writeFile('out/log.txt', log.join('\n'));
