// Pure data build: raw open data in, app data out. Used by build-data.mjs (Node) and the browser check.
import { parseSignText } from './parse-rules.mjs';
import { densify, distToSeg, dist, inRings, bbox, round } from './geo.mjs';
import { buildWaverley, buildWoollahra, buildRandwick, buildOffstreet, buildManual } from './regions.mjs';
import { buildParkRide } from './tfnsw.mjs';
import { buildFromSigns } from './spot.mjs';

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

export function buildData(raw) {
  const { meters, metersQuarterFree: quarter, tariffs, permits, free15, councilCarParks: carparks, streets, meta = {} } = raw;
  /* ---------- areas (polygons) ---------- */
  const polyOf = (f) => (f.geometry && f.geometry.rings) || [];
  const withBox = (rings) => ({ rings, box: bbox(rings.flat()) });
  const inBox = (p, b) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];

  const zones = tariffs
    .filter((f) => f.attributes.ID === 1 || f.attributes.ID === 2)
    .map((f) => ({ zone: f.attributes.ID, ...withBox(polyOf(f)) }));
  const zoneAt = (p) => (zones.find((z) => inBox(p, z.box) && inRings(p, z.rings)) || {}).zone || 0;

  const permitAreas = permits.map((f) => ({ label: f.attributes.Label_2, name: f.attributes.Label, ...withBox(polyOf(f)) }));
  const permitAt = (p) => permitAreas.find((a) => inBox(p, a.box) && inRings(p, a.rings)) || null;

  const free15Areas = free15.map((f) => ({ street: norm(f.attributes.Street), section: f.attributes.Section, ...withBox(polyOf(f)) }));
  const free15At = (p, street) => free15Areas.find((a) => a.street === street && inBox(p, a.box) && inRings(p, a.rings)) || null;

  /* ---------- meters → rule sets ---------- */
  const quarterIds = new Set(quarter.map((f) => f.attributes.Meter_ID));
  const ruleSets = [];
  const ruleKey = new Map();
  const unparsed = new Map();
  const pts = [];
  for (const f of meters) {
    const a = f.attributes;
    if (!f.geometry || a.Status_ID !== 1) continue;
    const { rules, bad } = parseSignText(a.Popup);
    bad.forEach((b) => unparsed.set(b, (unparsed.get(b) || 0) + 1));
    if (!rules.length) continue;
    const q = quarterIds.has(a.Meter_ID) ? 1 : 0;
    const key = JSON.stringify([rules, q]);
    if (!ruleKey.has(key)) { ruleKey.set(key, ruleSets.length); ruleSets.push({ rules: rules.map(({ p, d, f: from, t, r, ph }) => [p, d, from, t, r, ph ? 1 : 0]), q, text: a.Popup }); }
    pts.push({ p: [f.geometry.x, f.geometry.y], street: norm(a.Street), suburb: a.Suburb, k: ruleKey.get(key), n: a.ApproxPaySpaces || 0, id: a.Location_ID });
  }

  // Grid index for fast nearby-meter lookup (~110 m cells).
  const CELL = 0.001;
  const grid = new Map();
  const cellKey = (x, y) => `${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`;
  for (const m of pts) { const k = cellKey(...m.p); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(m); }
  function near(p) {
    const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL), out = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) out.push(...(grid.get(`${cx + i}:${cy + j}`) || []));
    return out;
  }

  /* ---------- streets → kerb segments, one line per side of the street ---------- */
  // A meter only governs its own side of the street, and only along the bays it serves
  // (about 6 m per space, split either side of the machine).
  const PIECE = 12; // metres
  const OFFSET = 5.5; // how far each side's line sits from the centreline, in metres
  const reachOf = (m) => Math.max(15, Math.min(45, 8 + m.n * 3.2));
  const kerbs = [];
  let seq = 0;
  const kx = (lat) => Math.cos((lat * Math.PI) / 180) * 111320, ky = 110540;
  const compass = (nx, ny) => { const ang = (Math.atan2(nx, ny) * 180) / Math.PI; const dirs = ['North', 'North-east', 'East', 'South-east', 'South', 'South-west', 'West', 'North-west']; return dirs[Math.round(((ang + 360) % 360) / 45) % 8]; };
  for (const f of streets) {
    const a = f.attributes;
    if (!f.geometry || !f.geometry.paths) continue;
    const street = norm(a.STREET);
    if (!street) continue;
    for (const path of f.geometry.paths) {
      if (path.length < 2) continue;
      const dense = densify(path, PIECE);
      const cur = { L: null, R: null, C: null };
      const flush = (key) => { const c = cur[key]; if (c && c.coords.length > 1) kerbs.push(c); cur[key] = null; };
      for (let i = 1; i < dense.length; i++) {
        const s0 = dense[i - 1], s1 = dense[i];
        const mid = [(s0[0] + s1[0]) / 2, (s0[1] + s1[1]) / 2];
        // Unit normal to the left of the direction of travel, in metres.
        const dx = (s1[0] - s0[0]) * kx(mid[1]), dy = (s1[1] - s0[1]) * ky;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        const best = { L: null, R: null }, bd = { L: Infinity, R: Infinity };
        for (const m of near(mid)) {
          if (m.street !== street) continue;
          const d = distToSeg(m.p, s0, s1);
          if (d > reachOf(m)) continue;
          const side = ((m.p[0] - mid[0]) * kx(mid[1]) * nx + (m.p[1] - mid[1]) * ky * ny) >= 0 ? 'L' : 'R';
          if (d < bd[side]) { bd[side] = d; best[side] = m; }
        }
        const pa = permitAt(mid);
        const fq = free15At(mid, street);
        const base = { z: zoneAt(mid), pa: pa ? pa.label : '', f15: fq ? 1 : 0 };
        const offsetPt = (p, sgn) => [p[0] + (sgn * nx * OFFSET) / kx(p[1]), p[1] + (sgn * ny * OFFSET) / ky];
        const emit = (key, k, m, sgn) => {
          const sig = `${k}|${base.z}|${base.pa}|${base.f15}`;
          const p0 = sgn ? offsetPt(s0, sgn) : s0, p1 = sgn ? offsetPt(s1, sgn) : s1;
          if (!cur[key] || cur[key].sig !== sig) {
            flush(key);
            const sideName = sgn ? `${compass(sgn * nx, sgn * ny)} side` : '';
            cur[key] = { sig, coords: [p0], props: { id: ++seq, s: a.STREET.trim(), b: m ? m.suburb : (pa ? pa.name : ''), sd: sideName, k, ...base, n: 0, m: new Set() } };
          }
          cur[key].coords.push(p1);
          if (m) cur[key].props.m.add(m);
        };
        if (!best.L && !best.R) { flush('L'); flush('R'); emit('C', -1, null, 0); }
        else {
          flush('C');
          emit('L', best.L ? best.L.k : -1, best.L, 1);
          emit('R', best.R ? best.R.k : -1, best.R, -1);
        }
      }
      flush('L'); flush('R'); flush('C');
    }
  }

  // Fill in suburb names for unmetered segments from the nearest metered one on the same street.
  const bySt = new Map();
  for (const k of kerbs) { if (!bySt.has(k.props.s)) bySt.set(k.props.s, []); bySt.get(k.props.s).push(k); }
  for (const list of bySt.values()) {
    const named = list.filter((k) => k.props.k >= 0 && k.props.b);
    for (const k of list) if (!k.props.b && named.length) {
      const c = k.coords[0];
      k.props.b = named.reduce((a, b) => (dist(c, b.coords[0]) < dist(c, a.coords[0]) ? b : a)).props.b;
    }
  }

  const kerbGeo = {
    type: 'FeatureCollection',
    features: kerbs.map((k) => {
      const n = [...k.props.m].reduce((s, m) => s + m.n, 0);
      const { m, ...rest } = k.props;
      // Simplify: keep endpoints and real bends only.
      const c = k.coords.map((x) => round(x));
      const slim = c.filter((p, i) => i === 0 || i === c.length - 1 || Math.abs(
        (c[i][0] - c[i - 1][0]) * (c[i + 1][1] - c[i][1]) - (c[i][1] - c[i - 1][1]) * (c[i + 1][0] - c[i][0])) > 1e-11);
      return { type: 'Feature', properties: { ...rest, n }, geometry: { type: 'LineString', coordinates: slim } };
    }),
  };

  /* ---------- meter points (shown when zoomed in) ---------- */
  const meterPts = pts.map((m) => [...round(m.p), m.k, m.n]);

  /* ---------- car parks ---------- */
  const centroid = (g) => {
    if (!g) return null;
    if (g.x != null) return [g.x, g.y];
    const ring = (g.rings || [])[0];
    if (!ring) return null;
    const s = ring.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]);
    return [s[0] / ring.length, s[1] / ring.length];
  };
  const extraCarParks = raw.extraCarParks || [];
  const cps = [
    ...carparks.map((f) => ({
      id: `cos-${f.attributes.OBJECTID}`,
      name: f.attributes.CarParkName,
      address: `${f.attributes.Street}, ${f.attributes.Suburb}`,
      entry: f.attributes.AccessPoint,
      operator: f.attributes.Operator,
      phone: f.attributes.ContactPhoneNumber,
      at: centroid(f.geometry) && round(centroid(f.geometry)),
      source: 'City of Sydney',
    })),
  ].filter((c) => c.at);
  const carParkList = cps.filter((c, i) => cps.findIndex((x) => x.name === c.name) === i);

  /* ---------- other councils ---------- */
  const setKey = (set) => JSON.stringify([set.rules, set.q || 0, set.g || '', set.u || 0]);
  const keyIdx = new Map(ruleSets.map((x, i) => [setKey(x), i]));
  const reg = { add(set) { const key = setKey(set); if (!keyIdx.has(key)) { keyIdx.set(key, ruleSets.length); ruleSets.push(set); } return keyIdx.get(key); } };
  const month = +new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', month: 'numeric' }).format(new Date());
  let nextId = Math.max(0, ...kerbGeo.features.map((x) => x.properties.id)) + 1;
  const regions = {};
  const MANLY_BEACH = [[151.2885, -33.7975], [151.2867, -33.8005], [151.2858, -33.8025]];
  const fromSigns = (opts) => (r, rg) => { const o = buildFromSigns(r, rg, opts); o.unparsed.forEach(([t, n]) => unparsed.set(t, (unparsed.get(t) || 0) + n)); return o; };
  for (const [name, fn] of [['waverley', buildWaverley], ['woollahra', buildWoollahra],
    ['manly', fromSigns({ src: 'Transport for NSW sign survey (2020)', place: 'Manly', beach: MANLY_BEACH })],
    ['willoughby', fromSigns({ src: 'Willoughby Council sign survey', place: 'Chatswood' })],
    ['randwick', buildRandwick], ['manual', buildManual]]) {
    if (!raw[name]) continue;
    const out = fn(raw[name], reg, { month });
    for (const ft of out.features) { ft.properties.id = nextId++; kerbGeo.features.push(ft); }
    carParkList.push(...out.carparks);
    regions[name] = { kerbs: out.features.length, carParks: out.carparks.length, ...(out.warnings?.length ? { warnings: out.warnings } : {}) };
  }

  if (raw.parkride) { const pr = buildParkRide(raw.parkride); carParkList.push(...pr); regions.parkride = { carParks: pr.length }; }

  // Rates kept by hand in data/carparks.json (each checked on the owner's own website) merge onto car parks by id;
  // records with a new id are car parks the open data doesn't have.
  let priced = 0;
  for (const e of extraCarParks) {
    const { source, research, ...rest } = e; // research notes stay in the repo, not in the app
    const rec = { ...rest, rateSource: source };
    if (rec.rates && rec.rates.length) priced++;
    const cur = carParkList.find((c) => c.id === e.id);
    if (cur) Object.assign(cur, { ...rec, at: rec.at ? round(rec.at) : cur.at, name: rec.name || cur.name });
    else if (rec.at) carParkList.push({ ...rec, at: round(rec.at), source: rec.operator || 'Kerb' });
  }

  if (raw.offstreet) { const cbd = buildOffstreet(raw.offstreet, carParkList); carParkList.push(...cbd); regions.offstreet = { carParks: cbd.length }; }

  // What permit-area signs usually say, from the council's own decisions: { '22': { sign: '2P 8am-10pm', n: 14, of: 17 } }.
  // Streets in a permit area with no published signs show this as "usually", never as the rule.
  const tally = {};
  for (const f of kerbGeo.features) {
    const rs = ruleSets[f.properties.k];
    if (!rs || !/traffic committee decision/i.test(rs.src || '')) continue;
    for (const part of String(rs.text || '').split(';')) {
      const m = /permit holders excepted,?\s*area\s+([A-Z0-9]+)/i.exec(part);
      if (!m) continue;
      const sign = part.replace(/,?\s*permit holders excepted.*$/i, '').replace(/\s+/g, ' ').trim();
      if (/ticket/i.test(sign) || !sign) continue;
      const a = (tally[m[1].toUpperCase()] ||= {}); a[sign] = (a[sign] || 0) + 1;
    }
  }
  const permitPatterns = {};
  for (const [area, signs] of Object.entries(tally)) {
    const all = Object.values(signs).reduce((x, y) => x + y, 0), [sign, n] = Object.entries(signs).sort((x, y) => y[1] - x[1])[0];
    if (all >= 3 && n / all >= 0.5) permitPatterns[area] = { sign, n, of: all };
  }

  const stats = {
    builtAt: new Date().toISOString(),
    permitPatterns,
    fetchedAt: meta.fetchedAt,
    meters: pts.length,
    ruleSets: ruleSets.length,
    kerbs: kerbGeo.features.length,
    metered: kerbGeo.features.filter((f) => f.properties.k >= 0).length,
    carParks: carParkList.length,
    carParksPriced: priced,
    unparsed: [...unparsed.entries()],
    regions,
    sources: meta.sources,
  };
  return { kerbs: kerbGeo, rules: ruleSets, meters: meterPts, carparks: carParkList, meta: stats };
}
