// Street sign surveys published by Transport for NSW (collected by SPOT Parking): every parking sign as a point,
// with what each arrow on it says. Used for Manly (Northern Beaches) and Chatswood (Willoughby).
// A sign's arrows tell us which way along the kerb each rule runs, so we can paint the kerb between signs.
import { mga56ToLonLat } from './shapefile.mjs';
import { fetchRoads } from './regions.mjs';
import { dist, densify, round, bbox } from './geo.mjs';

const log = (...a) => (globalThis.__log || console.log)(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, as = 'json', tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const v = as === 'json' ? await r.json() : await r.text();
      if (as === 'json' && v.error) throw new Error(`ArcGIS error ${v.error.code}: ${v.error.message}`);
      return v;
    } catch (e) {
      if (i >= tries) throw new Error(`${url}\n  ${e.message}`);
      await sleep(1500 * 2 ** i);
    }
  }
}

/* ---------- reading the sign text ---------- */
const DAY = { mon: 1, m: 1, tue: 2, tu: 2, wed: 3, w: 3, thu: 4, th: 4, fri: 5, f: 5, sat: 6, sa: 6, sun: 0, su: 0 };
const ALL = [0, 1, 2, 3, 4, 5, 6];
function parseDays(s) {
  const t = s.toLowerCase().replace(/(inc|excl?)\.?\s*public holidays?/g, '').replace(/school days only/, '')
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*-\s*([a-z]+)/g, '').trim(); // seasons: treated as all year
  if (!t) return null;
  const out = new Set();
  for (const part of t.split(/[,&\s]+(?=[a-z])/)) {
    const m = /^([a-z]+)\s*-\s*([a-z]+)$/.exec(part.trim());
    if (m && m[1] in DAY && m[2] in DAY) { for (let d = DAY[m[1]]; ; d = (d + 1) % 7) { out.add(d); if (d === DAY[m[2]]) break; } }
    else if (part.trim() in DAY) out.add(DAY[part.trim()]);
    else return undefined; // something we don't understand
  }
  return [...out].sort();
}
const clock = (h, m, ap) => { let H = +h % 12; if (ap === 'p') H += 12; return H + +m / 60; };
const TIME = /(\d{1,2}):(\d\d)\s*([ap])m?\s*-\s*(\d{1,2}):(\d\d)\s*([ap])m?/i;

// One period like "Max Dur. 2 hours 8:30a - 6:00p M-F" -> { p, from, to, days, ph, school }
function parsePeriod(s) {
  let p = null;
  s = s.replace(/max(?:imum)?\.?\s*dur(?:ation)?\.?:?\s*undefined/i, '');
  const md = /max(?:imum)?\.?\s*dur(?:ation)?\.?:?\s*(\d+)\s*(hours?|minutes?|mins?)/i.exec(s);
  if (md) p = /^h/i.test(md[2]) ? +md[1] : +md[1] / 60;
  const tm = TIME.exec(s);
  let from = 0, to = 24;
  if (tm) { from = clock(tm[1], tm[2], tm[3].toLowerCase()); to = clock(tm[4], tm[5], tm[6].toLowerCase()); if (to === 0) to = 24; }
  const rest = s.replace(md ? md[0] : '', '').replace(tm ? tm[0] : '', '').trim();
  const days = parseDays(rest);
  if (days === undefined) return null;
  const school = /school days/i.test(s);
  return { p, from, to, days: days || (school ? [1, 2, 3, 4, 5] : ALL), ph: /inc\.?\s*public holiday/i.test(s) ? 1 : 0, school };
}

const NO_PARK = {
  'no stopping': 'No stopping', 'no parking': 'No parking', clearway: 'Clearway', 'bus zone': 'Bus zone', 'bus lane': 'Bus lane',
  'loading zone': 'Loading zone', 'taxi zone': 'Taxi zone', 'mail zone': 'Mail zone', 'works zone': 'Works zone', towaway: 'Tow-away zone',
  'disabled parking': 'Mobility permit holders only', 'truck zone': 'Truck zone', 'motorbikes only': 'Motorbikes only',
};

// One arrow's worth of sign: kind like "Restricted Parking", desc like "Max Dur. 2 hours 8:00a - 10:00p, Area Permit: Ocean Beach".
// Returns { rules, u } or null when it doesn't change where a car can park (angle parking, school zones) or can't be read.
export function parseSpot(kind, desc = '') {
  const k = kind.trim().toLowerCase();
  if (!k || /angle parking|school zone|undefined/.test(k)) return null;
  const attrs = desc.split(/,\s*/).map((x) => x.trim()).filter(Boolean);
  const permit = (attrs.find((a) => /^area permit:/i.test(a)) || '').replace(/^area permit:\s*/i, '');
  const pLabel = /^\d/.test(permit) ? `area ${permit}` : permit;
  const periodAttr = attrs.filter((a) => TIME.test(a) || /max\.? dur/i.test(a) || parseDays(a));
  const periods = periodAttr.flatMap((a) => a.split(/;\s*/)).map(parsePeriod);
  if (periods.some((x) => x === null)) return { bad: `${kind}: ${desc}` };
  const school = periods.some((x) => x.school);
  if (k === 'unrestricted parking') return { rules: [], u: 1 };
  const out = [];
  const push = (pr, hours, rate, noPark, note) => {
    // Split overnight periods at midnight (rules never cross midnight).
    if (pr.to <= pr.from) {
      out.push([hours, pr.days, pr.from, 24, rate, pr.ph, noPark, note]);
      out.push([hours, pr.days.map((d) => (d + 1) % 7).sort(), 0, pr.to, rate, pr.ph, noPark, note]);
    } else out.push([hours, pr.days, pr.from, pr.to, rate, pr.ph, noPark, note]);
  };
  const list = periods.length ? periods : [{ p: null, from: 0, to: 24, days: ALL, ph: 0 }];
  if (k === 'restricted parking' || k === 'metered parking') {
    const note = [permit && `Permit holders ${pLabel} excepted`, school && 'School days'].filter(Boolean).join(', ');
    for (const pr of list) {
      if (pr.p == null && k === 'restricted parking') {
        if (permit) push(pr, 0, 0, 1, `Permit holders ${pLabel} only`);
        continue;
      }
      push(pr, pr.p ?? 24, k === 'metered parking' ? -1 : 0, 0, note);
    }
    return out.length ? { rules: out, u: 0, permit: pLabel } : null;
  }
  const label = NO_PARK[k];
  if (!label) return { bad: `${kind}: ${desc}` };
  if (k === 'no parking' && /motor vehicles excepted/i.test(desc)) return null;
  const who = attrs.find((a) => /council vehicle|car share|police|authorised|taxis?$|buses/i.test(a) && !/exempt|prohibited/i.test(a));
  const note = `${label}${who && k !== 'no stopping' ? ` (${who.replace(/^authorised car share:\s*/i, '').toLowerCase()} only)` : ''}${school ? ', school days' : ''}`;
  for (const pr of list) push(pr, 0, 0, 1, note);
  return { rules: out, u: 0 };
}

// All arrows on one sign -> { L: set, R: set } for the kerb to the left and right of the sign, as you face it from the road.
function signSets(configs, src) {
  const sides = { L: { rules: [], u: 0, any: false }, R: { rules: [], u: 0, any: false } };
  const bad = [];
  let permit = '';
  for (const c of configs) {
    const r = parseSpot(c.kind, c.desc);
    if (!r) continue;
    if (r.bad) { bad.push(r.bad); continue; }
    if (r.permit) permit = r.permit;
    const to = c.dir === 'left' ? ['L'] : c.dir === 'right' ? ['R'] : ['L', 'R'];
    for (const s of to) { sides[s].rules.push(...r.rules); sides[s].u ||= r.u; sides[s].any = true; }
  }
  const mk = (x) => (x.any ? { rules: x.rules, q: 0, g: 'free', u: x.rules.length ? 0 : x.u, src } : null);
  return { L: mk(sides.L), R: mk(sides.R), permit, bad };
}

/* ---------- fetching ---------- */
const MANLY = 'https://portal.data.nsw.gov.au/arcgis/rest/services/Hosted/TfNSW_Spot_Parking_Manly_Public/FeatureServer/0';
export async function fetchManly() {
  const signs = [];
  for (let off = 0; ; off += 1000) {
    const q = new URLSearchParams({ where: "category='PARKING_SIGN'", outFields: 'description,collectiontime', outSR: '4326', resultOffset: String(off), resultRecordCount: '1000', f: 'json' });
    const j = await get(`${MANLY}/query?${q}`);
    for (const f of j.features) {
      if (!f.geometry || !f.attributes.description) continue;
      const configs = f.attributes.description.split('\n').map((line) => /^Configuration \d+:\s*(.+?)\s*\((left|right|both|none)\)\s*(.*)$/.exec(line.trim())).filter(Boolean).map((m) => ({ kind: m[1], dir: m[2], desc: m[3] }));
      if (configs.length) signs.push({ at: [+f.geometry.x.toFixed(6), +f.geometry.y.toFixed(6)], configs });
    }
    if (!j.exceededTransferLimit && j.features.length < 1000) break;
  }
  const roads = await fetchRoads(pad(bbox(signs.map((s) => s.at))));
  log(`  manly: ${signs.length} parking signs, ${roads.length} road segments`);
  return { signs, roads, surveyed: '2020' };
}

const WILLOUGHBY = 'https://opendata.transport.nsw.gov.au/data/dataset/7e150818-58c2-43ac-89cb-529cd244b073/resource/6524a6bf-fe7e-4478-b6fa-74a52137ae8a/download/willoughby_council_street_parking_signs_data.csv';
function csvRows(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
export async function fetchWilloughby() {
  const rows = csvRows(await get(WILLOUGHBY, 'text'));
  const head = rows[0].map((h) => h.trim());
  const col = (n) => head.indexOf(n);
  const signs = [];
  for (const r of rows.slice(1)) {
    const x = +r[col('Eastin')], y = +r[col('Northing')];
    if (!x || !y) continue;
    const configs = [];
    for (let i = 1; i <= 4; i++) {
      const kind = r[col(`sign${i}_category`)], dir = r[col(`sign${i}_direction`)];
      if (kind) configs.push({ kind, dir: (dir || 'both').toLowerCase(), desc: r[col(`sign${i}_description`)] || '' });
    }
    if (configs.length) signs.push({ at: mga56ToLonLat([x, y]).map((v) => +v.toFixed(6)), configs });
  }
  const roads = await fetchRoads(pad(bbox(signs.map((s) => s.at))));
  log(`  willoughby: ${signs.length} parking signs, ${roads.length} road segments`);
  return { signs, roads, surveyed: '2026' };
}
const pad = ([x0, y0, x1, y1]) => [x0 - 0.002, y0 - 0.002, x1 + 0.002, y1 + 0.002];

/* ---------- signs -> kerbs ---------- */
const titleCase = (s) => String(s || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bMc([a-z])/g, (m, c) => 'Mc' + c.toUpperCase());
const roadName = (a) => titleCase([a.roadnamebase, a.roadnametype, a.roadnamesuffix].filter(Boolean).join(' '));
const kx = (lat) => Math.cos((lat * Math.PI) / 180) * 111320, ky = 110540;

export function buildFromSigns(raw, reg, { src, place, beach = [], reach = 150 }) {
  const unparsed = new Map();
  // 1. Every sign, read into left/right rule sets.
  const signs = raw.signs.map((s) => {
    const r = signSets(s.configs, src);
    r.bad.forEach((b) => unparsed.set(b, (unparsed.get(b) || 0) + 1));
    return { at: s.at, L: r.L, R: r.R, permit: r.permit };
  }).filter((s) => s.L || s.R);

  // 2. Road segments, indexed on a grid so each sign finds its nearest piece of road.
  const paths = [];
  for (const f of raw.roads) {
    const name = roadName(f.attributes);
    if (!name || !f.geometry?.paths) continue;
    for (const p of f.geometry.paths) if (p.length >= 2) paths.push({ name, pts: densify(p, 12) });
  }
  const CELL = 0.0005, grid = new Map();
  paths.forEach((p, pi) => {
    let along = 0;
    p.along = [0];
    for (let i = 1; i < p.pts.length; i++) { along += dist(p.pts[i - 1], p.pts[i]); p.along.push(along); }
    for (let i = 1; i < p.pts.length; i++) {
      const [a, b] = [p.pts[i - 1], p.pts[i]];
      for (let cx = Math.floor(Math.min(a[0], b[0]) / CELL); cx <= Math.floor(Math.max(a[0], b[0]) / CELL); cx++)
        for (let cy = Math.floor(Math.min(a[1], b[1]) / CELL); cy <= Math.floor(Math.max(a[1], b[1]) / CELL); cy++) {
          const k = `${cx}:${cy}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push([pi, i]);
        }
    }
    p.signs = { 1: [], '-1': [] };
  });
  for (const s of signs) {
    const cx = Math.floor(s.at[0] / CELL), cy = Math.floor(s.at[1] / CELL);
    let best = null;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const [pi, si] of grid.get(`${cx + i}:${cy + j}`) || []) {
      const p = paths[pi], a = p.pts[si - 1], b = p.pts[si];
      const ax = (s.at[0] - a[0]) * kx(a[1]), ay = (s.at[1] - a[1]) * ky, dx = (b[0] - a[0]) * kx(a[1]), dy = (b[1] - a[1]) * ky;
      const L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, (ax * dx + ay * dy) / L2));
      const d = Math.hypot(ax - t * dx, ay - t * dy);
      if (d < 25 && (!best || d < best.d)) best = { d, pi, along: p.along[si - 1] + t * Math.sqrt(L2), side: dx * ay - dy * ax >= 0 ? 1 : -1 };
    }
    if (best) paths[best.pi].signs[best.side].push({ ...s, along: best.along });
  }

  // 3. Walk each side of each road. Left of travel (side 1): the viewer's right arrow points along the road; right side: against it.
  const feats = [];
  const keyOf = (set) => (set ? reg.add(set) : -1);
  for (const p of paths) {
    for (const side of [1, -1]) p.signs[side].sort((a, b) => a.along - b.along);
    if (!p.signs[1].length && !p.signs[-1].length) continue;
    const cur = {};
    const flush = (side) => { const c = cur[side]; if (c && c.coords.length > 1) feats.push(c); cur[side] = null; };
    for (let i = 1; i < p.pts.length; i++) {
      const s0 = p.pts[i - 1], s1 = p.pts[i];
      const mid = [(s0[0] + s1[0]) / 2, (s0[1] + s1[1]) / 2], at = (p.along[i - 1] + p.along[i]) / 2;
      const dx = (s1[0] - s0[0]) * kx(mid[1]), dy = (s1[1] - s0[1]) * ky, len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      for (const side of [1, -1]) {
        const list = p.signs[side];
        let prev = null, next = null;
        for (const s of list) { if (s.along <= at) prev = s; else { next = s; break; } }
        const fwd = side === 1 ? 'R' : 'L', back = side === 1 ? 'L' : 'R';
        const a = prev && at - prev.along <= reach && prev[fwd] ? { set: prev[fwd], d: at - prev.along, s: prev } : null;
        const b = next && next.along - at <= reach && next[back] ? { set: next[back], d: next.along - at, s: next } : null;
        const pick = a && b ? (a.d <= b.d ? a : b) : a || b;
        const k = pick ? keyOf(pick.set) : -1;
        const permit = pick?.s.permit || '';
        const sig = `${k}|${permit}`;
        const off = (q) => [q[0] + (side * nx * 5.5) / kx(q[1]), q[1] + (side * ny * 5.5) / ky];
        if (k < 0) { flush(side); continue; }
        if (!cur[side] || cur[side].sig !== sig) {
          flush(side);
          const ang = (Math.atan2(side * nx, side * ny) * 180) / Math.PI;
          const sd = ['North', 'North-east', 'East', 'South-east', 'South', 'South-west', 'West', 'North-west'][Math.round(((ang + 360) % 360) / 45) % 8] + ' side';
          cur[side] = { sig, coords: [off(s0)], props: { s: p.name, b: place, sd, k, z: beach.some((c) => dist(c, mid) < 600) ? 3 : 2, pa: permit, f15: 0, n: 0, src: 'sp' } };
        }
        cur[side].coords.push(off(s1));
      }
    }
    flush(1); flush(-1);
  }
  const features = feats.map((c) => ({ type: 'Feature', properties: c.props, geometry: { type: 'LineString', coordinates: c.coords.map((x) => round(x)) } }));
  return { features, carparks: [], unparsed: [...unparsed.entries()], signs: signs.length };
}
