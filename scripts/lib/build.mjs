// Pure data build: raw open data in, app data out. Used by build-data.mjs (Node) and the browser check.
import { parseSignText } from './parse-rules.mjs';
import { densify, distToSeg, dist, inRings, bbox, round } from './geo.mjs';

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

  /* ---------- streets → kerb segments ---------- */
  const PIECE = 20; // metres
  const REACH = 40; // a meter governs kerb within this distance
  const kerbs = [];
  let seq = 0;
  for (const f of streets) {
    const a = f.attributes;
    if (!f.geometry || !f.geometry.paths) continue;
    const street = norm(a.STREET);
    if (!street) continue;
    for (const path of f.geometry.paths) {
      if (path.length < 2) continue;
      const dense = densify(path, PIECE);
      let cur = null;
      const flush = () => { if (cur && cur.coords.length > 1) kerbs.push(cur); cur = null; };
      for (let i = 1; i < dense.length; i++) {
        const s0 = dense[i - 1], s1 = dense[i];
        const mid = [(s0[0] + s1[0]) / 2, (s0[1] + s1[1]) / 2];
        let best = null, bd = REACH;
        for (const m of near(mid)) {
          if (m.street !== street) continue;
          const d = distToSeg(m.p, s0, s1);
          if (d < bd) { bd = d; best = m; }
        }
        const pa = permitAt(mid);
        const fq = free15At(mid, street);
        const props = {
          k: best ? best.k : -1,
          z: zoneAt(mid),
          pa: pa ? pa.label : '',
          f15: fq ? 1 : 0,
        };
        const sig = `${props.k}|${props.z}|${props.pa}|${props.f15}`;
        if (!cur || cur.sig !== sig) {
          flush();
          cur = { sig, coords: [s0], props: { id: ++seq, s: a.STREET.trim(), b: best ? best.suburb : (pa ? pa.name : ''), ...props, n: 0, m: new Set() } };
        }
        cur.coords.push(s1);
        if (best) cur.props.m.add(best);
      }
      flush();
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
    ...extraCarParks,
  ].filter((c) => c.at);
  // Merge prices kept by hand in data/carparks.json onto council car parks with the same name.
  for (const c of cps) {
    const extra = extraCarParks.find((e) => e.name === c.name && e.id !== c.id);
    if (extra) Object.assign(c, { ...extra, id: c.id, at: c.at });
  }
  const carParkList = cps.filter((c, i) => cps.findIndex((x) => x.name === c.name) === i);

  const stats = {
    builtAt: new Date().toISOString(),
    fetchedAt: meta.fetchedAt,
    meters: pts.length,
    ruleSets: ruleSets.length,
    kerbs: kerbGeo.features.length,
    metered: kerbGeo.features.filter((f) => f.properties.k >= 0).length,
    carParks: carParkList.length,
    unparsed: [...unparsed.entries()],
    sources: meta.sources,
  };
  return { kerbs: kerbGeo, rules: ruleSets, meters: meterPts, carparks: carParkList, meta: stats };
}
