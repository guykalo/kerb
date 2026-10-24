// Where the open data lives and how to download it (works in Node and the browser).
const COS = 'https://services1.arcgis.com/cNVyNtjGVZybOQWZ/arcgis/rest/services';
const METERS = 'https://utility.arcgis.com/usrsvcs/servers/71bb12507a3240c4b12e7fbba5be58e1/rest/services/ParkingMeters/ParkingMeters/MapServer';

export const SOURCES = {
  meters: { url: `${METERS}/78`, fields: 'Meter_ID,Location_ID,Status_ID,Street,Suburb,ApproxPaySpaces,Popup' },
  metersQuarterFree: { url: `${METERS}/79`, fields: 'Meter_ID', geometry: false },
  tariffs: { url: `${COS}/Ticket_parking_rates/FeatureServer/0`, fields: '*', offset: 0.00002 },
  permits: { url: `${COS}/ParkingPermits/FeatureServer/0`, fields: 'Precinct,Label,Label_2,ResidentialEligible,VisitorEligible,BusinessEligible', offset: 0.00002 },
  free15: { url: `${COS}/Free_15_minute_parking/FeatureServer/0`, fields: 'Street,Section,Suburb', offset: 0.000005 },
  councilCarParks: { url: `${COS}/Council_car_parks/FeatureServer/0`, fields: '*' },
  streets: { url: `${COS}/Street_Codes/FeatureServer/0`, fields: 'OBJECTID,STREET,StreetCode,Class,IN_LGA', offset: 0.000005 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'kerb-parking-map/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.error) throw new Error(`ArcGIS error ${j.error.code}: ${j.error.message}`);
      return j;
    } catch (e) {
      if (i >= tries) throw new Error(`${url}\n  ${e.message}`);
      await sleep(1500 * 2 ** i);
    }
  }
}

export async function fetchLayer(name, { url, fields, geometry = true, offset }) {
  const features = [];
  const page = 1000;
  for (let start = 0; ; start += page) {
    const q = new URLSearchParams({
      where: '1=1', outFields: fields, returnGeometry: String(geometry), outSR: '4326', f: 'json',
      resultOffset: String(start), resultRecordCount: String(page), orderByFields: 'OBJECTID',
    });
    if (geometry) q.set('geometryPrecision', '6');
    if (offset) q.set('maxAllowableOffset', String(offset));
    let j;
    try { j = await getJSON(`${url}/query?${q}`); }
    catch (e) {
      // Some map services reject orderByFields or paging; fall back to one plain request.
      if (start > 0) throw e;
      q.delete('orderByFields'); q.delete('resultOffset'); q.delete('resultRecordCount');
      j = await getJSON(`${url}/query?${q}`);
      features.push(...j.features);
      break;
    }
    features.push(...j.features);
    if (!j.exceededTransferLimit && j.features.length < page) break;
  }
  (globalThis.__log||console.log)(`  ${name}: ${features.length} features`);
  return features;
}


import { fetchWaverley, fetchWoollahra } from './regions.mjs';
import { fetchParkRide } from './tfnsw.mjs';

export async function fetchAll() {
  const raw = { meta: { fetchedAt: new Date().toISOString(), sources: {} } };
  for (const [name, src] of Object.entries(SOURCES)) {
    raw[name] = await fetchLayer(name, src);
    if (!raw[name].length) throw new Error(`${name} came back empty`);
    raw.meta.sources[name] = { url: src.url, count: raw[name].length };
  }
  // Other councils: a failure here shouldn't stop the City of Sydney data from updating.
  for (const [name, fn] of [['waverley', fetchWaverley], ['woollahra', fetchWoollahra], ['parkride', fetchParkRide]]) {
    try { raw[name] = await fn(); raw.meta.sources[name] = { ok: true }; }
    catch (e) { (globalThis.__log || console.log)(`  ${name} failed: ${e.message}`); raw.meta.sources[name] = { ok: false, error: e.message }; }
  }
  return raw;
}
