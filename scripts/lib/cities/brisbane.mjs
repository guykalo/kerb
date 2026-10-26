// Brisbane: Brisbane City Council open data. Every parking meter with its hours, time limit and rates, the
// painted kerb markings (no stopping lines, bus bays, taxi ranks, mobility and motorcycle bays) and clearways.
import { getJSON, log, daysTimes, R5, osmRoads, nearestOnLines, pieceAlong, sideName, titleCase, simplify } from './common.mjs';

const BNE = 'https://data.brisbane.qld.gov.au/api/explore/v2.1/catalog/datasets';
// Inner suburbs: where the meters are and where drivers look for parking.
const SUBURBS = ['BRISBANE CITY', 'SPRING HILL', 'FORTITUDE VALLEY', 'SOUTH BRISBANE', 'WEST END', 'KANGAROO POINT', 'MILTON', 'PADDINGTON', 'PETRIE TERRACE', 'NEW FARM',
  'WOOLLOONGABBA', 'BOWEN HILLS', 'NEWSTEAD', 'TENERIFFE', 'RED HILL', 'KELVIN GROVE', 'HERSTON', 'EAST BRISBANE', 'HIGHGATE HILL', 'TOOWONG', 'ST LUCIA', 'AUCHENFLOWER', 'ALBION', 'WINDSOR', 'ANNERLEY'];
const inSuburbs = `suburb in (${SUBURBS.map((s) => `"${s}"`).join(',')})`;

export async function fetchBrisbane() {
  const meters = await getJSON(`${BNE}/brisbane-parking-meters/exports/json`);
  const lines = await getJSON(`${BNE}/parking-line-locations/exports/json?select=${encodeURIComponent('street,suburb,pavementmarkingsubtype,parkingrestrictiontype,geo_shape')}&where=${encodeURIComponent(`${inSuburbs} and parkingrestrictiontype in ("No Stopping","Bus Bay","Taxi Rank","Accessible Parking","Motorcycle Parking")`)}`);
  const clearways = await getJSON(`${BNE}/parking-clearways/exports/json`);
  const xs = meters.map((m) => m.longitude).filter(Boolean), ys = meters.map((m) => m.latitude).filter(Boolean);
  const roads = await osmRoads([Math.min(...xs) - 0.003, Math.min(...ys) - 0.003, Math.max(...xs) + 0.003, Math.max(...ys) + 0.003]);
  // Where the two council car parks are, from OpenStreetMap (ODbL).
  let cpAt = {};
  try {
    const q = `[out:json][timeout:60];nwr[amenity=parking][name~"King George Square|Wickham Terrace",i](-27.48,153.01,-27.455,153.035);out center tags;`;
    const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Kerb parking map (github.com/guykalo/kerb)' } });
    for (const e of (await r.json()).elements) { const c = e.center || e; const k = /king george/i.test(e.tags.name) ? 'kgs' : 'wickham'; if (!cpAt[k]) cpAt[k] = [+c.lon.toFixed(5), +c.lat.toFixed(5)]; }
  } catch (e) { log(`  brisbane car parks: ${e.message}`); }
  log(`  brisbane: ${meters.length} meters, ${lines.length} kerb markings, ${clearways.length} clearways, ${roads.length} streets`);
  return { meters, lines, clearways, roads, cpAt, fetchedAt: new Date().toISOString() };
}

const ALL = [0, 1, 2, 3, 4, 5, 6];
const zoneRules = (text, note) => daysTimes(text).map((t) => [0, t.days, t.from, t.to, 0, 0, 1, note]);
export function meterRules(m) {
  const rules = [];
  const days = /7 DAYS/i.test(m.operational_day || '') ? '' : m.operational_day || '';
  const max = parseFloat(m.max_stay_hrs);
  const limit = Number.isFinite(max) && !/-/.test(m.max_stay_hrs) ? max : -1;
  const ah = m.tar_rate_ah_we != null && m.tar_rate_ah_we !== '' ? +m.tar_rate_ah_we : null, wk = m.tar_rate_weekday != null ? +m.tar_rate_weekday : null;
  if (/M\/C|MOTORCYCLE/i.test(`${m.restrictions} ${m.category}`)) return { rules: [[0, ALL, 0, 24, 0, 0, 1, 'Motorcycles only']], q: 0 };
  for (const t of daysTimes(`${m.operational_time || ''} ${days}`)) {
    const weekend = t.days.every((d) => d === 0 || d === 6), evening = t.from >= 18.9;
    const rate = (weekend || evening) ? (ah ?? wk ?? -1) : (wk ?? ah ?? -1);
    rules.push([limit, t.days, t.from, t.to, rate, 0, 0, 'Ticket']);
  }
  const r = String(m.restrictions || '').toUpperCase().replace(/TOWAWAY/g, '');
  let partial = false;
  if (r.trim() && !/^(NONE|NIL)$/.test(r.trim())) {
    // The kinds of zone the meter's restriction names. One kind: we can draw it. Several kinds sharing one line
    // ("C/WAY 7-9AM & 4-7PM, LZ 9AM-4PM") or "all other times": we keep the times but say to check the sign.
    const KINDS = [[/CLEARWAY|C\/WAY|C\/W\b/, 'Clearway'], [/LOADING|LOAD ZONE|\bLZ\b/, 'Loading Zone'], [/BUS|\bBZ\b/, 'Bus Zone'], [/TAXI|\bTZ\b/, 'Taxi Zone'], [/NO PARKING/, 'No parking'], [/NO STOPPING|\bN\/S\b/, 'No stopping']];
    const kinds = KINDS.filter(([re]) => re.test(r)).map(([, n]) => n);
    const mixed = kinds.length !== 1 || /\bAOT\b|ALL OTHER TIMES/.test(r);
    const zr = zoneRules(r, mixed ? 'Restricted (see sign)' : kinds[0]);
    if (!zr.length) partial = true;
    if (mixed) partial = true;
    rules.push(...zr);
  }
  return { rules, q: /15 min free/i.test(m.tar_zone || '') ? 1 : 0, partial };
}

const lineCoords = (g) => (g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : []);
export function buildBrisbane(raw, reg) {
  const features = [];
  let skipped = 0;
  const src = 'Brisbane City Council open data';
  for (const m of raw.meters) {
    if (!m.longitude || !m.latitude) { skipped++; continue; }
    const p = [m.longitude, m.latitude], near = nearestOnLines(p, raw.roads, 35);
    const { rules, q, partial } = meterRules(m);
    if (!near || !rules.length) { skipped++; continue; }
    const len = Math.max(12, Math.min(70, (+m.veh_bays || 2) * 6.2));
    const text = [`${m.max_stay_hrs ? `${m.max_stay_hrs}P ` : ''}Ticket ${m.operational_day || ''} ${m.operational_time || ''}`.trim(), m.restrictions && m.restrictions !== 'NONE' ? m.restrictions : ''].filter(Boolean).join('; ');
    const k = reg.add({ rules, q, g: partial ? 'unknown' : 'edges', u: 0, src: `${src}: parking meters${m.tar_zone ? ` (${m.tar_zone}${m.max_cap_chg ? `, daily cap $${m.max_cap_chg}` : ''})` : ''}`, text });
    features.push({ type: 'Feature', properties: { s: titleCase(m.street), b: titleCase(m.suburb), sd: sideName(p, near), k, z: /BRISBANE CITY|SPRING HILL|FORTITUDE|SOUTH BRISBANE/.test(m.suburb) ? 1 : 2, pa: '', f15: q, n: +m.veh_bays || 0, src: 'bne' }, geometry: { type: 'LineString', coordinates: pieceAlong(p, near.dir, len) } });
  }
  const NOTE = { 'No Stopping': 'No stopping', 'Bus Bay': 'Bus Zone', 'Taxi Rank': 'Taxi Zone', 'Accessible Parking': 'Mobility Parking', 'Motorcycle Parking': 'Motorcycles only' };
  for (const l of raw.lines) {
    const note = NOTE[l.parkingrestrictiontype];
    if (!note) continue;
    const k = reg.add({ rules: [[0, ALL, 0, 24, 0, 0, 1, note]], q: 0, g: 'free', u: 0, src: `${src}: kerb line markings`, text: note === 'No stopping' ? 'No stopping (yellow line)' : note });
    for (const c of lineCoords(l.geo_shape?.geometry)) {
      if (c.length < 2) continue;
      features.push({ type: 'Feature', properties: { s: titleCase(l.street), b: titleCase(l.suburb), k, z: 2, pa: '', f15: 0, n: 0, src: 'bne' }, geometry: { type: 'LineString', coordinates: simplify(c.map(R5)) } });
    }
  }
  for (const c of raw.clearways) {
    const rules = zoneRules(c.operational_time || '', 'Clearway');
    if (!rules.length) continue;
    const k = reg.add({ rules, q: 0, g: 'unknown', u: 0, src: `${src}: clearways`, text: `Clearway ${c.operational_time}` });
    for (const line of lineCoords(c.geo_shape?.geometry)) if (line.length > 1) features.push({ type: 'Feature', properties: { s: nearestOnLines(line[Math.floor(line.length / 2)], raw.roads, 40)?.road.name || 'Clearway', b: 'Brisbane', k, z: 2, pa: '', f15: 0, n: 0, src: 'bne' }, geometry: { type: 'LineString', coordinates: simplify(line.map(R5), 3) } });
  }
  log(`  brisbane: ${features.length} kerb pieces, ${skipped} meters skipped; car parks at ${JSON.stringify(raw.cpAt || {})}`);
  return { features, carparks: brisbaneCarParks(raw.cpAt || {}) };
}

// Brisbane City Council's two car parks, casual rates from the council's car park pages (checked 26 Oct 2026).
const WKD = [1, 2, 3, 4, 5], WKE = [0, 6];
const LADDER = [[0.25, 0], [1 / 3, 8], [0.5, 15], [1, 24], [1.5, 30], [2, 34], [2.5, 38], [3, 42], [3.5, 46], [4, 49]];
function brisbaneCarParks(at) {
  const src = 'https://www.brisbane.qld.gov.au/traffic-transport/parking-brisbane/car-parks/king-george-square-car-park';
  const out = [];
  if (at.kgs) out.push({
    id: 'bne-kgs', name: 'King George Square Car Park', address: '100 Adelaide Street, Brisbane City (also 87 Roma Street)', at: at.kgs, operator: 'Brisbane City Council', source: src,
    rates: [
      { kind: 'casual', days: WKD, from: 0, to: 24, bands: [...LADDER, [24, 64]] },
      { kind: 'flat', label: 'Day max', days: WKD, enter: [0, 18], exitBy: 18, price: 49 },
      { kind: 'flat', label: 'Early bird', days: WKD, enter: [5.5, 7], exitAfter: 13, exitBy: 18, price: 28 },
      { kind: 'casual', days: WKD, from: 16, to: 24, bands: [[4, 10], [24, 15]] },
      { kind: 'casual', days: WKE, from: 0, to: 24, bands: [[3, 10], [8, 15], [24, 20]] },
    ],
    note: 'Council car park. First 15 minutes free on weekdays. Daily max $49 out before 6pm, $64 out before 5:30am. Early bird $28 (in 5:30-7am, out 1-6pm). Weekday evenings from 4pm $10 up to 4 hrs, $15 over. Weekends $10/$15/$20. Public holidays $10.',
  });
  if (at.wickham) out.push({
    id: 'bne-wickham', name: 'Wickham Terrace Car Park', address: '136 Wickham Terrace, Spring Hill', at: at.wickham, operator: 'Brisbane City Council', source: 'https://www.brisbane.qld.gov.au/traffic-transport/parking-brisbane/car-parks/wickham-terrace-car-park',
    rates: [
      { kind: 'casual', days: WKD, from: 0, to: 24, bands: [...LADDER, [24, 55]] },
      { kind: 'flat', label: 'Day max', days: WKD, enter: [0, 18], exitBy: 18, price: 49 },
      { kind: 'flat', label: 'Early bird', days: WKD, enter: [5.5, 9], exitAfter: 13, exitBy: 19, price: 26 },
      { kind: 'flat', label: 'Evening', days: WKD, enter: [16, 24], exitBy: 5.5, price: 6 },
      { kind: 'casual', days: WKE, from: 0, to: 24, bands: [[24, 6]] },
    ],
    note: 'Council car park, open 24/7. First 15 minutes free on weekdays. Daily max $49 out before 6pm, $55 out before 5:30am. Early bird $26 (in 5:30-9am, out 1-7pm). Evenings $6 (in after 4pm, out before 5:30am). Weekends $6 flat. Public holidays $10.',
  });
  return out;
}
