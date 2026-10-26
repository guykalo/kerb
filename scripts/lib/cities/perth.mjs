// Perth: City of Perth parking bay restrictions (CC BY 4.0). Every bay is a polygon with its sign wording,
// e.g. "MOTOR VEHICLE 3 HOUR MON-FRI 8AM-6PM" and whether a fee applies. Plus City of Perth Parking car parks.
import { arcgisAll, log, daysTimes, R5, kx, KY, osmRoads, nearestOnLines, sideName } from './common.mjs';

const ARC = 'https://services7.arcgis.com/v8XBa2naYNQGOjlG/arcgis/rest/services';
export async function fetchPerth() {
  const bays = (await arcgisAll(`${ARC}/PS_AST_PARKINGBAYSEXPLODED_PV/FeatureServer/0`, { outFields: 'RESTRICT_CODE,RESTRICT_TYPE,FEE,RESTRICT_DESC' }))
    .filter((f) => f.geometry?.rings).map((f) => ({ ...f.attributes, ring: f.geometry.rings[0] }));
  const carparks = (await arcgisAll(`${ARC}/PS_OTH_CARPARKCENTROID_PV/FeatureServer/0`)).filter((f) => f.geometry).map((f) => ({ ...f.attributes, at: [f.geometry.x, f.geometry.y] }));
  // The City's neighbourhoods: kerbside fee areas carry the same names (Perth City, Northbridge, West Perth...).
  let hoods = [];
  try { hoods = (await arcgisAll(`${ARC}/PLN_BND_NEIGHBOURHOODS_PVi/FeatureServer/0`, { outFields: 'NEIGHBOURHOOD', geometryPrecision: '5' })).filter((f) => f.geometry?.rings).map((f) => ({ name: f.attributes.NEIGHBOURHOOD, rings: f.geometry.rings })); } catch (e) { log(`  perth neighbourhoods: ${e.message}`); }
  const xs = bays.flatMap((b) => b.ring.map((p) => p[0])), ys = bays.flatMap((b) => b.ring.map((p) => p[1]));
  const roads = await osmRoads([Math.min(...xs) - 0.002, Math.min(...ys) - 0.002, Math.max(...xs) + 0.002, Math.max(...ys) + 0.002]);
  log(`  perth: ${bays.length} bays, ${carparks.length} car parks, ${roads.length} streets, ${hoods.length} neighbourhoods`);
  return { bays, carparks, roads, hoods, fetchedAt: new Date().toISOString() };
}

const ALL = [0, 1, 2, 3, 4, 5, 6];
// One bay's wording -> Kerb rules, and whether outside those times it's free (g) or unknown.
export function perthRules(desc, fee) {
  const d = String(desc || '').replace(/\s+/g, ' ').trim().toUpperCase();
  const rule = (h, t, rate, nopark, note) => [h, t.days, t.from, t.to, rate, 0, nopark, note];
  const times = daysTimes(d.replace(/^[^0-9]*?(?=\b(MON|TUE|WED|THU|FRI|SAT|SUN|AT ALL|\d{1,2}(?:[.:]\d\d)?\s*(AM|PM)?\s*-))/, ''));
  const all = times.length ? times : [{ days: ALL, from: 0, to: 24, seg: d }];
  const zone = (note) => ({ rules: all.map((t) => rule(0, t, 0, 1, note)), g: 'unknown' });
  if (/^CLEARWAY/.test(d)) return zone('Clearway');
  if (/^NO STANDING|^NO STOPPING/.test(d)) return zone(/PERMIT/.test(d) ? 'No standing (permit holders excepted)' : 'No stopping');
  if (/^NO PARKING/.test(d)) return zone('No parking');
  if (/^BUS ZONE|BLUE CAT/.test(d)) return zone('Bus Zone');
  if (/^LOADING ZONE/.test(d)) return zone('Loading Zone');
  if (/^TAXI/.test(d)) return zone('Taxi Zone');
  if (/^PICK ?UP|SET DOWN/.test(d)) return zone('Pick-up and drop-off only');
  if (/^CHARTER|^AUTHORI[SZ]ED|^INCIDENT|^POLICE|^COUNCIL|^CONSUL|^MAIL|^EMERGENCY/.test(d)) return zone('Authorised vehicles only');
  if (/^MOTOR ?CY/.test(d)) return zone('Motorcycles only');
  if (/^ELECTRIC/.test(d)) return zone('EV charging only');
  if (/^ACROD/.test(d)) return zone('Mobility Parking');
  if (!/^MOTOR VEHICLE/.test(d)) return null;
  const hm = /(\d+(?:\.\d+)?)\s*(HOUR|HR|MIN)/.exec(d);
  const limit = /NO TIME LIMIT/.test(d) ? 24 : hm ? (/MIN/.test(hm[2]) ? +hm[1] / 60 : +hm[1]) : null;
  if (limit == null) return null;
  const rules = all.map((t) => {
    // "(FEE)" / "NO FEE" on this piece of the sign wins over the bay's overall fee flag.
    const paid = /NO FEE/.test(t.seg) ? false : /\bFEE\b/.test(t.seg) ? true : fee === 'Y' || /FEE PAYABLE|\(FEE\)/.test(d);
    return rule(limit, t, paid ? -1 : 0, 0, paid ? 'Ticket' : '');
  });
  return { rules, g: 'free' };
}

// A bay polygon -> a short line along its long side, on the kerb.
function bayLine(ring) {
  const pts = ring.slice(0, -1);
  if (pts.length < 3) return null;
  const c = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], k = kx(a[1]);
    const L = Math.hypot((b[0] - a[0]) * k, (b[1] - a[1]) * KY);
    if (!best || L > best.L) best = { a, b, L };
  }
  if (!best || best.L < 2 || best.L > 80) return null;
  const k = kx(c[1]), ux = ((best.b[0] - best.a[0]) * k) / best.L, uy = ((best.b[1] - best.a[1]) * KY) / best.L, h = best.L / 2;
  return [R5([c[0] - (ux * h) / k, c[1] - (uy * h) / KY]), R5([c[0] + (ux * h) / k, c[1] + (uy * h) / KY])];
}

// City of Perth Parking kerbside fees from 30 March 2026 (cityofperthparking.com.au/parking-fees and the 2025-26 fee
// schedule): $ an hour by fee area, Mon-Sat 8am-6pm unless the sign says otherwise (Crawley/Nedlands Mon-Fri).
const FEE_SRC = 'City of Perth Parking kerbside fees from 30 March 2026';
const AREA_RATE = { 'CENTRAL PERTH': 7, NORTHBRIDGE: 6, 'WEST PERTH': 5.4, 'EAST PERTH': 5.4, CLAISEBROOK: 5.4, 'CRAWLEY - NEDLANDS': 3 };
const inRing = ([x, y], ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
const hoodAt = (p, hoods) => (hoods || []).find((h) => h.rings.filter((r) => inRing(p, r)).length % 2 === 1)?.name || null;

// City of Perth Parking car parks, 2025-26 fee schedule (from 30 March 2026), cars:
// [match, $/hr, Mon-Fri day max, Sat/Sun/PH day max, day starts (hour), extra]
const ALLD = [0, 1, 2, 3, 4, 5, 6], WK = [1, 2, 3, 4, 5], WE = [0, 6];
const CP_FEES = [
  [/ABERDEEN/, 5.5, 15, 8, 4], [/CITIPLACE|CITI PLACE/, 7, 24, 11, 6], [/CONVENTION/, 8, 27, 11, 6], [/COOLGARDIE/, 5, 15, 8, 4],
  [/COUNCIL HOUSE/, 7, null, 11, 6, { maxRates: 1, note: 'No weekday daily maximum is published, and the City advertises free first hours at some times.' }],
  [/CULTURAL/, 6, 20, 11, 6, { maxRates: 1, note: 'The City advertises 2 hours free at some times; check its website.' }],
  [/ELDER/, 7, 21, 11, 6], [/FIRE STATION/, 5, null, 8, 4, { maxRates: 1, note: 'The weekday daily maximum isn\'t clear in the fee schedule.' }],
  [/GODERICH/, 6, 19, null, 5.5, { weFlat: 11 }], [/HAY ST.*EAST|HAY STREET EAST/, 5, 15, 8, 4],
  [/HIS MAJESTY/, 6.5, 25, 11, 6, { maxRates: 1, note: 'The City advertises 2 hours free at some times; check its website.' }],
  [/JAMES/, 5.5, 15, 8, 4], [/OLDHAM/, 5.5, 15, 8, 4], [/MAYFAIR/, 5.5, 18, 11, 6], [/MOUNTS BAY/, 5.5, 15, 8, 4], [/NEWCASTLE/, 5, 15, 8, 4],
  [/PIER/, 6, 20, 11, 6, { maxRates: 1, note: 'The City advertises 2 hours free at some times; check its website.' }],
  [/PLAIN/, 5.5, 15, 8, 4], [/POINT FRASER/, 4, 15, 8, 4, { maxRates: 1, note: 'First hour free in designated bays.' }],
  [/QUEENS? GARDENS/, 5.5, 15, 8, 4], [/REGAL/, 5.5, 17, 11, 6], [/ROE/, 6.5, 20, 11, 6], [/ROYAL/, 5, 15, 8, 4], [/SAUNDERS/, 5, 15, 8, 4],
  [/STATE LIBRARY/, 6, 20, 11, 6], [/TERRACE R/, 6, 20, 11, 6], [/WELLINGTON/, 5, 15, 8, 4],
];
function perthCarParkRates(name) {
  const n = String(name || '').toUpperCase();
  if (/HEIRISSON/.test(n)) return { rates: [{ kind: 'free', days: ALLD, from: 0, to: 24, maxStay: 3 }], note: 'No fee, 3-hour limit at all times.' };
  if (/ABRAHAMS/.test(n)) return { rates: [{ kind: 'hourly', days: WK, from: 8, to: 17, perHour: 3, dailyMax: 15 }, { kind: 'free', days: WE, from: 0, to: 24 }], note: 'Fees Mon-Fri 8am-5pm only.' };
  if (/MARDALUP/.test(n)) return { rates: [{ kind: 'hourly', days: WK, from: 8, to: 18, perHour: 4.5, dailyMax: 15 }, { kind: 'free', days: WE, from: 9, to: 21, maxStay: 3 }], note: 'Fees Mon-Fri 8am-6pm; weekends free, 3-hour limit 9am-9pm.' };
  if (/VICTORIA GARDENS/.test(n)) return { rates: [{ kind: 'hourly', days: ALLD, from: 4, to: 18, perHour: 5, maxStay: 2 }], note: '2-hour limit at all times.' };
  const row = CP_FEES.find(([re]) => re.test(n));
  if (!row) return null;
  const [, per, wkMax, weMax, start, x = {}] = row;
  const rates = [{ kind: 'hourly', days: WK, from: start, to: 18, perHour: per, ...(wkMax != null ? { dailyMax: wkMax } : {}) }];
  if (x.weFlat) rates.push({ kind: 'casual', days: WE, from: start, to: 17.5, bands: [[24, x.weFlat]] });
  else rates.push({ kind: 'hourly', days: WE, from: start, to: 18, perHour: per, dailyMax: weMax });
  rates.push({ kind: 'flat', label: 'Night', days: ALLD, enter: [18, 24], exitBy: start, price: 5 }, { kind: 'flat', label: 'Night', days: ALLD, enter: [0, start - 0.25], exitBy: start, price: 5 });
  return { rates, maxRates: x.maxRates ? 1 : 0, note: [`Night rate $5 (6pm to ${start === 5.5 ? '5:29am' : start === 4 ? '3:59am' : '5:59am'}).`, x.note || ''].filter(Boolean).join(' ') };
}

export function buildPerth(raw, reg) {
  const features = [];
  let skipped = 0;
  // Each restriction on a bay is its own polygon ("explode"): the same bay can have a Mon-Sat polygon and a
  // Sunday one. Put the polygons of one bay back together by where they sit.
  const bays = new Map();
  for (const b of raw.bays) {
    const r = perthRules(b.RESTRICT_DESC, b.FEE);
    const line = bayLine(b.ring);
    if (!r || !r.rules.length || !line) { skipped++; continue; }
    const mid = [(line[0][0] + line[1][0]) / 2, (line[0][1] + line[1][1]) / 2];
    const key = `${Math.round(mid[0] * 40000)}:${Math.round(mid[1] * 40000)}`; // ~2.5 m cells
    if (!bays.has(key)) bays.set(key, { line, mid, parts: [] });
    bays.get(key).parts.push({ r, text: String(b.RESTRICT_DESC || '').replace(/\s+/g, ' ').trim() });
  }
  const stats = { priced: 0, unpriced: 0 };
  for (const { line, mid, parts } of bays.values()) {
    const uniq = [...new Map(parts.map((p) => [p.text, p])).values()];
    const rules = uniq.flatMap((p) => p.r.rules.map((r) => [...r]));
    const g = uniq.some((p) => p.r.g === 'free') ? 'free' : 'unknown';
    const near = nearestOnLines(mid, raw.roads || [], 30);
    // Paid bays get the fee area's hourly rate (Brown St in Claisebrook has its own).
    let src = 'City of Perth parking bay restrictions (open data, CC BY)';
    if (rules.some((r) => r[4] < 0)) {
      const hood = hoodAt(mid, raw.hoods);
      const brown = hood === 'CLAISEBROOK' && /^Brown St/i.test(near?.road.name || '');
      const rate = brown ? 4.5 : AREA_RATE[hood];
      if (rate) {
        for (const r of rules) if (r[4] < 0) r[4] = rate;
        src += `; ${FEE_SRC}: $${rate.toFixed(2)} an hour in ${brown ? 'Brown Street, Claisebrook' : hood.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace('Central Perth', 'Perth City')}`;
        stats.priced++;
      } else stats.unpriced++;
    }
    const k = reg.add({ rules, q: 0, g, u: 0, src, text: uniq.map((p) => p.text).join('; ') });
    features.push({ type: 'Feature', properties: { s: near?.road.name || 'Street parking', b: 'Perth', sd: sideName(mid, near), k, z: 1, pa: '', f15: 0, n: 1, src: 'per' }, geometry: { type: 'LineString', coordinates: line } });
  }
  const unmatched = [];
  const carparks = raw.carparks.map((c) => {
    const fees = perthCarParkRates(c.CARPARK_NAME);
    if (!fees) unmatched.push(c.CARPARK_NAME);
    return {
      id: `per-${c.CARPARK_ID}`, name: `${String(c.CARPARK_NAME || '').toLowerCase().replace(/\b[a-z]/g, (x) => x.toUpperCase())} Car Park`, operator: 'City of Perth Parking',
      spaces: +c.CAR_BAYS || undefined, url: c.URL || '', at: R5(c.at),
      ...(fees ? { rates: fees.rates, ...(fees.maxRates ? { maxRates: true } : {}), source: 'https://cityofperthparking.com.au/parking-fees', note: `City of Perth Parking fee schedule 2025-26 (from 30 March 2026). ${fees.note}`.trim() }
        : { source: 'City of Perth', note: c.URL ? 'Rates on the City of Perth Parking website (linked).' : '' }),
    };
  });
  log(`  perth: ${features.length} bays drawn, ${skipped} skipped; paid bays priced by fee area ${stats.priced}, not priced ${stats.unpriced}; car parks without rates: ${unmatched.join(', ') || 'none'}`);
  return { features, carparks };
}
