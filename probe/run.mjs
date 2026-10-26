// Probe round 9: full Melbourne / Brisbane / Perth parking datasets for analysis.
import { writeFile, mkdir } from 'node:fs/promises';
await mkdir('out', { recursive: true });
const log = [];
const say = (...a) => { console.log(...a); log.push(a.join(' ')); };
const UA = { 'User-Agent': 'Kerb parking map (github.com/guykalo/kerb)' };
const get = async (u, name) => {
  try { const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(300000) }); const t = await r.text(); await writeFile(`out/${name}`, t); say('ok', name, r.status, t.length); return t; }
  catch (e) { say('failed', name, e.message); return ''; }
};
const MEL = 'https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets';
const BNE = 'https://data.brisbane.qld.gov.au/api/explore/v2.1/catalog/datasets';
await get(`${MEL}?where=search(%22parking%22)&limit=60`, 'mel-catalog.json');
for (const d of ['on-street-parking-bay-sensors', 'on-street-parking-bays', 'sign-plates-located-in-each-parking-zone', 'parking-zones-linked-to-street-segments', 'on-street-car-park-bay-restrictions'])
  await get(`${MEL}/${d}/exports/json`, `mel-${d}.json`);
await get(`${BNE}?where=search(%22parking%22)&limit=60`, 'bne-catalog.json');
await get(`${BNE}/brisbane-parking-meters/exports/json`, 'bne-meters.json');
await get(`${BNE}/parking-line-locations/exports/json?select=suburb,street,pavementmarkingsubtype,parkingrestrictiontype,pavementlinelength`, 'bne-lines-attrs.json');
const ARC = 'https://services7.arcgis.com/v8XBa2naYNQGOjlG/arcgis/rest/services';
await get(`${ARC}/PS_AST_PARKINGBAYSEXPLODED_PV/FeatureServer/0?f=json`, 'per-bays-layer.json');
await get(`${ARC}/PS_AST_PARKINGBAYSEXPLODED_PV/FeatureServer/0/query?where=1%3D1&outFields=*&returnGeometry=false&resultRecordCount=2000&f=json`, 'per-bays-attrs.json');
await get(`${ARC}/PS_AST_PARKINGBAYSEXPLODED_PV/FeatureServer/0/query?where=1%3D1&returnCountOnly=true&f=json`, 'per-bays-count.json');
await get(`${ARC}/PS_OTH_CARPARKCENTROID_PV/FeatureServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=json`, 'per-carparks.json');
await writeFile('out/log.txt', log.join('\n'));
