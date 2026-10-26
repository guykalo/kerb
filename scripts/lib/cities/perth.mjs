// Perth: City of Perth parking bay restrictions (CC BY 4.0). Every bay is a polygon with its sign wording,
// e.g. "MOTOR VEHICLE 3 HOUR MON-FRI 8AM-6PM" and whether a fee applies. Plus City of Perth Parking car parks.
import { arcgisAll, log, daysTimes, R5, kx, KY, osmRoads, nearestOnLines, sideName } from './common.mjs';

const ARC = 'https://services7.arcgis.com/v8XBa2naYNQGOjlG/arcgis/rest/services';
export async function fetchPerth() {
  const bays = (await arcgisAll(`${ARC}/PS_AST_PARKINGBAYSEXPLODED_PV/FeatureServer/0`, { outFields: 'RESTRICT_CODE,RESTRICT_TYPE,FEE,RESTRICT_DESC' }))
    .filter((f) => f.geometry?.rings).map((f) => ({ ...f.attributes, ring: f.geometry.rings[0] }));
  const carparks = (await arcgisAll(`${ARC}/PS_OTH_CARPARKCENTROID_PV/FeatureServer/0`)).filter((f) => f.geometry).map((f) => ({ ...f.attributes, at: [f.geometry.x, f.geometry.y] }));
  const xs = bays.flatMap((b) => b.ring.map((p) => p[0])), ys = bays.flatMap((b) => b.ring.map((p) => p[1]));
  const roads = await osmRoads([Math.min(...xs) - 0.002, Math.min(...ys) - 0.002, Math.max(...xs) + 0.002, Math.max(...ys) + 0.002]);
  log(`  perth: ${bays.length} bays, ${carparks.length} car parks, ${roads.length} streets`);
  return { bays, carparks, roads, fetchedAt: new Date().toISOString() };
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

export function buildPerth(raw, reg) {
  const features = [];
  let skipped = 0;
  for (const b of raw.bays) {
    const r = perthRules(b.RESTRICT_DESC, b.FEE);
    const line = bayLine(b.ring);
    if (!r || !r.rules.length || !line) { skipped++; continue; }
    const k = reg.add({ rules: r.rules, q: 0, g: r.g, u: 0, src: 'City of Perth parking bay restrictions (open data, CC BY)', text: String(b.RESTRICT_DESC || '').replace(/\s+/g, ' ').trim() });
    const mid = [(line[0][0] + line[1][0]) / 2, (line[0][1] + line[1][1]) / 2], near = nearestOnLines(mid, raw.roads || [], 30);
    features.push({ type: 'Feature', properties: { s: near?.road.name || 'Street parking', b: 'Perth', sd: sideName(mid, near), k, z: 1, pa: '', f15: 0, n: 1, src: 'per' }, geometry: { type: 'LineString', coordinates: line } });
  }
  const carparks = raw.carparks.map((c) => ({
    id: `per-${c.CARPARK_ID}`, name: `${String(c.CARPARK_NAME || '').toLowerCase().replace(/\b[a-z]/g, (x) => x.toUpperCase())} Car Park`, operator: 'City of Perth Parking',
    spaces: +c.CAR_BAYS || undefined, url: c.URL || '', at: R5(c.at), source: 'City of Perth', note: c.URL ? 'Rates on the City of Perth Parking website (linked).' : '',
  }));
  log(`  perth: ${features.length} bays drawn, ${skipped} skipped`);
  return { features, carparks };
}
