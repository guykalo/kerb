// Melbourne: City of Melbourne open data (CC BY). Every on-street parking bay (29,000 points), the in-ground
// sensor in 6,300 of them with its parking zone, the sign plates of each zone, and the Pay Stay (meter) zones
// with their real hourly rates by day and time. Sensors report live, so the app can show free bays right now.
import { getJSON, log, R5, kx, KY, titleCase, joinDays } from './common.mjs';
import { fetchOsmParking, buildOsmParking } from '../osm.mjs';

// Going-out suburbs outside the City of Melbourne: street parking mapped in OpenStreetMap (ODbL) by volunteers.
export const MEL_OSM = {
  'st-kilda': [144.965, -37.875, 145.0, -37.85],
  'chapel-st': [144.98, -37.865, 145.005, -37.83],
  'fitzroy-collingwood': [144.97, -37.81, 145.0, -37.79],
  brunswick: [144.95, -37.78, 144.975, -37.755],
  richmond: [144.99, -37.83, 145.01, -37.81],
  carlton: [144.96, -37.805, 144.975, -37.79],
};

const MEL = 'https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets';
export const MEL_SENSORS = `${MEL}/on-street-parking-bay-sensors/exports/json?select=kerbsideid,status_description,status_timestamp`;
const all = (d, select) => getJSON(`${MEL}/${d}/exports/json${select ? `?select=${encodeURIComponent(select)}` : ''}`);

export async function fetchMelbourne() {
  const bays = (await all('on-street-parking-bays', 'roadsegmentid,kerbsideid,roadsegmentdescription,latitude,longitude')).filter((b) => b.latitude && b.longitude)
    .map((b) => [b.roadsegmentid, b.kerbsideid, b.roadsegmentdescription, +b.longitude.toFixed(6), +b.latitude.toFixed(6)]);
  const sensors = (await all('on-street-parking-bay-sensors', 'kerbsideid,zone_number,location')).filter((s) => s.location)
    .map((s) => [s.kerbsideid, s.zone_number, +s.location.lon.toFixed(6), +s.location.lat.toFixed(6)]);
  const plates = await all('sign-plates-located-in-each-parking-zone');
  const zoneSegs = await all('parking-zones-linked-to-street-segments');
  const pay = await all('pay-stay-parking-restrictions');
  const paySegs = await all('pay-stay-zones-linked-to-street-segments');
  let osm = { ways: [] };
  try { osm = await fetchOsmParking(MEL_OSM); } catch (e) { log(`  melbourne osm: ${e.message}`); }
  log(`  melbourne: ${bays.length} bays, ${sensors.length} sensors, ${plates.length} sign plates, ${pay.length} pay stay rates`);
  return { bays, sensors, plates, zoneSegs, pay, paySegs, osm, fetchedAt: new Date().toISOString() };
}

const DAYS = { 'Mon-Fri': [1, 2, 3, 4, 5], 'Sat-Sun': [0, 6], Sat: [6], Sun: [0], 'Mon-Sat': [1, 2, 3, 4, 5, 6], 'Mon-Sun': [0, 1, 2, 3, 4, 5, 6], 'Mon-Thu': [1, 2, 3, 4], Fri: [5], MF: [1, 2, 3, 4, 5], SS: [0, 6] };
const hrs = (t) => { const m = /^(\d{1,2}):(\d\d)/.exec(String(t || '')); if (!m) return null; const h = +m[1] + m[2] / 60; return h === 0 ? 0 : h; };

export function buildMelbourne(raw, reg) {
  // Pay Stay rates by street segment: segment -> [{ d, from, to, max, cost }]
  const payByZone = new Map();
  for (const p of raw.pay) {
    // The day numbers run 1 = Sunday to 7 = Saturday (the dataset's day names are one day off: weekday clearway
    // gaps show up under "Saturday", and the all-day pattern under "Sunday").
    const d = (+p.day_of_week - 1 + 7) % 7, from = hrs(p.start_time), to = hrs(p.end_time);
    if (from == null || to == null || to <= from) continue;
    if (!payByZone.has(p.pay_stay_zone)) payByZone.set(p.pay_stay_zone, []);
    payByZone.get(p.pay_stay_zone).push({ d, from, to: to === 0 ? 24 : to, max: (+p.maximum_stay || 0) / 60, cost: (+p.cost_per_hour || 0) / 100 });
  }
  const payZonesBySeg = new Map();
  for (const s of raw.paySegs) { if (!payZonesBySeg.has(s.street_segment_id)) payZonesBySeg.set(s.street_segment_id, new Set()); payZonesBySeg.get(s.street_segment_id).add(s.pay_stay_zone); }
  const zonesBySeg = new Map();
  for (const s of raw.zoneSegs) { if (!zonesBySeg.has(s.segment_id)) zonesBySeg.set(s.segment_id, new Set()); zonesBySeg.get(s.segment_id).add(s.parkingzone); }
  const platesByZone = new Map();
  for (const p of raw.plates) { if (!platesByZone.has(p.parkingzone)) platesByZone.set(p.parkingzone, []); platesByZone.get(p.parkingzone).push(p); }
  // The meter rate on this segment for a day and time, if every Pay Stay zone on it agrees.
  const rateFor = (seg, d, from, to) => {
    const costs = new Set();
    for (const z of payZonesBySeg.get(seg) || []) for (const r of payByZone.get(z) || []) if (r.d === d && r.from < to && r.to > from) costs.add(r.cost);
    return costs.size === 1 ? [...costs][0] : -1;
  };
  const zoneRules = (zone, seg) => {
    const out = [];
    for (const p of platesByZone.get(zone) || []) {
      const days = DAYS[p.restriction_days], from = hrs(p.time_restrictions_start); let to = hrs(p.time_restrictions_finish);
      if (!days || from == null || to == null) continue;
      if (to === 0) to = 24;
      if (to <= from) continue;
      const c = String(p.restriction_display || '').toUpperCase();
      let m;
      if ((m = /^MP(\d+)P$/.exec(c))) for (const d of days) out.push([+m[1], [d], from, to, rateFor(seg, d, from, to), 0, 0, 'Ticket']);
      else if ((m = /^F?P?(\d+)P$/.exec(c))) out.push([+m[1], days, from, to, 0, 0, 0, '']);
      else if ((m = /^FP(\d+)$/.exec(c))) out.push([+m[1] / 60, days, from, to, 0, 0, 0, '']);
      else if (/^LZ/.test(c)) out.push([0, days, from, to, 0, 0, 1, 'Loading Zone']);
      else if (/^DP/.test(c)) out.push([0, days, from, to, 0, 0, 1, 'Mobility Parking']);
      else if (c === 'PP') out.push([0, days, from, to, 0, 0, 1, 'Permit holders only']);
      else return null; // a code we don't read: leave the kerb unknown
    }
    return out.length ? joinDays(out) : null;
  };
  const payRules = (zone) => {
    const out = [];
    for (const r of payByZone.get(zone) || []) out.push(r.cost > 0 ? [r.max || -1, [r.d], r.from, r.to, r.cost, 0, 0, 'Ticket'] : [r.max || 24, [r.d], r.from, r.to, 0, 0, 0, '']);
    // Join days that share the same times, limit and rate.
    const joined = new Map();
    for (const x of out) { const k = JSON.stringify([x[0], x[2], x[3], x[4], x[7]]); if (!joined.has(k)) joined.set(k, [...x.slice(0, 1), [], ...x.slice(2)]); joined.get(k)[1].push(...x[1]); }
    return [...joined.values()].map((x) => { x[1] = [...new Set(x[1])].sort(); return x; });
  };
  const zoneOf = new Map(raw.sensors.map((s) => [String(s[0]), s[1]]));
  // Bays by street segment, split into the two sides of the street, then into runs.
  const bySeg = new Map();
  for (const b of raw.bays) { if (!bySeg.has(b[0])) bySeg.set(b[0], []); bySeg.get(b[0]).push(b); }
  const features = [];
  const stats = { sensorZone: 0, sideZone: 0, payStay: 0, oneZone: 0, unknown: 0 };
  for (const [seg, pts] of bySeg) {
    const name = titleCase(String(pts[0][2] || '').split(/ between /i)[0]);
    const cx = pts.reduce((a, p) => a + p[3], 0) / pts.length, cy = pts.reduce((a, p) => a + p[4], 0) / pts.length, k = kx(cy);
    // Principal axis of the bays (the street's direction).
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of pts) { const x = (p[3] - cx) * k, y = (p[4] - cy) * KY; sxx += x * x; syy += y * y; sxy += x * y; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(ang), uy = Math.sin(ang);
    const sides = new Map();
    for (const p of pts) {
      const x = (p[3] - cx) * k, y = (p[4] - cy) * KY, along = x * ux + y * uy, off = -x * uy + y * ux;
      const sd = off >= 0 ? 1 : -1;
      if (!sides.has(sd)) sides.set(sd, []);
      sides.get(sd).push({ p, along, off, zone: zoneOf.get(String(p[1])) ?? null, sensor: zoneOf.has(String(p[1])) ? String(p[1]) : null });
    }
    for (const [sd, list] of sides) {
      list.sort((a, b) => a.along - b.along);
      // Bays without a sensor take the zone of the nearest bay that has one, within 30 m.
      for (const q of list) if (q.zone == null) { let best = null; for (const o of list) if (o.zone != null && Math.abs(o.along - q.along) < 30 && (!best || Math.abs(o.along - q.along) < Math.abs(best.along - q.along))) best = o; if (best) q.zone = best.zone; }
      // Still no zone: if every sensor bay on this side of the block is in one zone, and the council links that
      // zone to this block, the bays between them are in it too.
      const sideZones = new Set(list.filter((q) => q.sensor).map((q) => q.zone));
      if (sideZones.size === 1) { const z = [...sideZones][0]; if (zonesBySeg.get(seg)?.has(z)) for (const q of list) if (q.zone == null) { q.zone = z; q.side = 1; } }
      const runs = [];
      for (const q of list) { const last = runs[runs.length - 1]; if (last && q.along - last[last.length - 1].along < 25 && q.zone === last[0].zone) last.push(q); else runs.push([q]); }
      for (const run of runs) {
        let rules = null, how = '';
        if (run[0].zone != null) { rules = zoneRules(run[0].zone, seg); how = run.some((q) => q.side) ? 'sideZone' : 'sensorZone'; }
        if (!rules && payZonesBySeg.get(seg)?.size) {
          // Several Pay Stay zones on one segment (usually the two sides): fine if they all say the same thing.
          const opts = [...new Set([...payZonesBySeg.get(seg)].map((z) => JSON.stringify(payRules(z))))];
          if (opts.length === 1) { rules = JSON.parse(opts[0]); how = 'payStay'; }
        }
        if (!rules && zonesBySeg.get(seg)?.size) {
          // Every zone the council links to this block says the same thing: that's the rule, whichever side.
          const opts = [...new Set([...zonesBySeg.get(seg)].map((z) => JSON.stringify(zoneRules(z, seg))))];
          if (opts.length === 1 && opts[0] !== 'null') { rules = JSON.parse(opts[0]); how = 'oneZone'; }
        }
        if (!rules || !rules.length) { stats.unknown += run.length; continue; }
        stats[how] += run.length;
        const text = run[0].zone != null ? (platesByZone.get(run[0].zone) || []).map((p) => `${p.restriction_display} ${p.restriction_days} ${String(p.time_restrictions_start).slice(0, 5)}-${String(p.time_restrictions_finish).slice(0, 5)}`).join('; ') : '';
        const key = reg.add({ rules, q: 0, g: 'edges', u: 0, src: `City of Melbourne parking zones${rules.some((r) => r[4] > 0) ? ' and Pay Stay rates' : ''} (open data, CC BY)`, text });
        // A line through the run's bays, a car length past each end.
        const a = run[0].along - 3, b = run[run.length - 1].along + 3, off = run.reduce((s, q) => s + q.off, 0) / run.length;
        const at = (t) => R5([cx + (t * ux - off * uy) / k, cy + (t * uy + off * ux) / KY]);
        const bear = (Math.atan2(-uy * sd, ux * sd) * 180) / Math.PI; // outward normal of this side, as a compass bearing
        const sdName = ['North', 'North-east', 'East', 'South-east', 'South', 'South-west', 'West', 'North-west'][Math.round((((bear % 360) + 360) % 360) / 45) % 8];
        const kb = run.map((q) => q.sensor).filter((x) => x != null);
        features.push({ type: 'Feature', properties: { s: name || 'Street parking', b: 'Melbourne', sd: Math.abs(off) > 2 ? `${sdName} side` : '', k: key, z: 1, pa: '', f15: 0, n: run.length, src: 'mel', ...(kb.length ? { kb } : {}) }, geometry: { type: 'LineString', coordinates: [at(a), at(b)] } });
      }
    }
  }
  // OpenStreetMap kerbs in the suburbs, except where the council's own bays already cover the street.
  if (raw.osm?.ways?.length) {
    const near = new Set();
    for (const f of features) for (const c of f.geometry.coordinates) near.add(`${Math.round(c[0] * 2000)}:${Math.round(c[1] * 2000)}`);
    const o = buildOsmParking(raw.osm, reg);
    let added = 0;
    for (const f of o.features) {
      const c = f.geometry.coordinates[Math.floor(f.geometry.coordinates.length / 2)];
      if (near.has(`${Math.round(c[0] * 2000)}:${Math.round(c[1] * 2000)}`)) continue;
      f.properties.b = 'Melbourne';
      features.push(f); added++;
    }
    log(`  melbourne osm: ${added} kerb sides from OpenStreetMap`);
  }
  const bays = raw.sensors.map((s) => [String(s[0]), s[2], s[3]]);
  log(`  melbourne: ${features.length} kerb runs; bays placed by sensor zone ${stats.sensorZone}, by the side's zone ${stats.sideZone}, by Pay Stay ${stats.payStay}, by single zone ${stats.oneZone}, unknown ${stats.unknown}`);
  return { features, carparks: STONNINGTON, bays };
}

// City of Stonnington's car parks around Chapel Street (rates from the council's car parks page, checked 26 Oct 2026;
// locations from OpenStreetMap). Only the ones Kerb could place for certain.
const ALLD = [0, 1, 2, 3, 4, 5, 6];
const STN_SRC = 'https://www.stonnington.vic.gov.au/Services/Parking/Car-parks-in-Stonnington';
// $4 an hour for 2 hours, then $6 an hour, paid 9am-6pm: arrive later in the day and only the hours to 6pm are paid.
const openAirCost = (hrs) => (hrs <= 2 ? hrs * 4 : 8 + (hrs - 2) * 6);
const OPEN_AIR = [...Array.from({ length: 9 }, (_, i) => {
  const H = 9 + i, paid = 18 - H;
  return { kind: 'casual', days: ALLD, from: H, to: H + 1, bands: [...Array.from({ length: paid - 1 }, (_, k) => [k + 1, openAirCost(k + 1)]), [24, openAirCost(paid)]] };
}), { kind: 'free', days: ALLD, from: 18, to: 24 }];
const openAir = (id, name, address, at) => ({ id: `stn-${id}`, name, address, at, operator: 'City of Stonnington', rates: OPEN_AIR, source: STN_SRC, note: 'Council open-air car park. Pay 9am-6pm, 7 days: $4 an hour for the first 2 hours, then $6 an hour.' });
const STONNINGTON = [
  { id: 'stn-elizabeth', name: 'Elizabeth Street Car Park', address: '9 Elizabeth Street, South Yarra', at: [144.99283, -37.84537], operator: 'City of Stonnington', source: STN_SRC,
    rates: [{ kind: 'casual', days: ALLD, from: 0, to: 24, bands: [[0.5, 4], [1, 6], [2, 10], [3, 12.5], [4, 15], [5, 20], [6, 22], [24, 24]] }],
    note: 'Council car park, open 24/7. Early bird $18 on Mondays and Wednesdays.' },
  openAir('darling', 'Darling Street Car Park', '3-7 Darling Street, South Yarra', [144.99113, -37.83822]),
  openAir('murphy', 'Murphy Street Car Park', '13-17 Murphy Street, South Yarra', [144.98999, -37.83814]),
  openAir('caroline', 'Caroline Street South Car Park', '36-38 Caroline Street South, South Yarra', [144.98818, -37.83905]),
  openAir('powell', 'Powell Street Car Park', '55 Powell Street, South Yarra', [144.98945, -37.83919]),
];
