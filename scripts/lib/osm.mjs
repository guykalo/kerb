// Street parking mapped in OpenStreetMap (© OpenStreetMap contributors, ODbL). Volunteers record each side of a
// street with tags like parking:left:maxstay:conditional = "2 hours @ (Mo-Fr 08:00-20:00)". Used where councils
// publish nothing (Parramatta CBD is mapped in detail). Turned into Kerb's rule tuples, side by side.
import { dist, round } from './geo.mjs';

const log = (...a) => (globalThis.__log || console.log)(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

// Areas fetched from OpenStreetMap: [west, south, east, north].
export const OSM_AREAS = {
  parramatta: [150.975, -33.84, 151.045, -33.785],
  'olympic-park': [151.04, -33.865, 151.09, -33.82],
  homebush: [151.06, -33.885, 151.105, -33.855],
  airport: [151.135, -33.965, 151.215, -33.918], // Mascot, Wolli Creek, Tempe, Botany
};

export async function fetchOsmParking(areas = OSM_AREAS) {
  const ways = [], seen = new Set();
  for (const [name, [w, s, e, n]] of Object.entries(areas)) {
    const q = `[out:json][timeout:90];way[highway][~"^parking:"~"."](${s},${w},${n},${e});out tags geom;`;
    let got = null;
    for (const ep of OVERPASS) {
      for (let i = 0; i < 2 && !got; i++) {
        try {
          const r = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Kerb parking map (github.com/guykalo/kerb)' }, signal: AbortSignal.timeout(100000) });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          got = (await r.json()).elements;
        } catch (err) { log(`  osm ${name}: ${ep} ${err.message}`); await sleep(5000); }
      }
      if (got) break;
    }
    if (!got) throw new Error(`OpenStreetMap ${name} unavailable`);
    for (const x of got) if (x.geometry && !seen.has(x.id)) { seen.add(x.id); ways.push({ id: x.id, tags: x.tags, line: x.geometry.map((p) => [+p.lon.toFixed(6), +p.lat.toFixed(6)]) }); }
    log(`  osm ${name}: ${got.length} streets with parking tags`);
  }
  return { ways, fetchedAt: new Date().toISOString() };
}

/* ---------- reading the tags ---------- */
const DAY = { Su: 0, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6 };
// "Mo-Fr 08:00-18:00; Sa 08:00-20:00" -> [{ days, from, to }], or null if it uses anything we don't read.
export function parseHours(s) {
  const out = [];
  for (let part of String(s).split(';')) {
    part = part.trim();
    if (!part) continue;
    if (/^PH\s+off$/i.test(part)) continue;
    if (part === '24/7') { out.push({ days: [0, 1, 2, 3, 4, 5, 6], from: 0, to: 24 }); continue; }
    const m = /^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?,?)+)\s+(.+)$/.exec(part);
    if (!m) return null;
    const days = new Set();
    for (const d of m[1].split(',').filter(Boolean)) {
      const [a, b] = d.split('-');
      if (!b) days.add(DAY[a]);
      else for (let x = DAY[a]; ; x = (x + 1) % 7) { days.add(x); if (x === DAY[b]) break; }
    }
    for (const t of m[2].split(',')) {
      const tm = /^\s*(\d\d):(\d\d)-(\d\d):(\d\d)\s*$/.exec(t);
      if (!tm) return null;
      const from = +tm[1] + tm[2] / 60; let to = +tm[3] + tm[4] / 60;
      if (to === 0) to = 24;
      if (to <= from) return null; // past midnight: not read yet
      out.push({ days: [...days].sort(), from, to });
    }
  }
  return out;
}
// "1 hour @ (Mo-Fr 08:00-18:00); 2 hours @ (Sa 08:00-20:00)" -> [{ value, hours: [...] }]
function conditional(s) {
  const out = [];
  if (!s) return out;
  for (const m of String(s).matchAll(/([^;@()]+?)\s*@\s*\(([^)]*)\)/g)) {
    const hours = parseHours(m[2]);
    if (!hours) return null;
    out.push({ value: m[1].trim(), hours });
  }
  return out;
}
const duration = (v) => {
  const m = /^(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|h)$/i.exec(String(v).trim());
  return m ? (/^m/i.test(m[2]) ? +m[1] / 60 : +m[1]) : null;
};
const RESTRICTION = { no_stopping: 'No stopping', no_parking: 'No parking', loading_only: 'Loading Zone', no_standing: 'No stopping', charging_only: 'EV charging only' };

// One side's tags (keys without the side) -> { rules, unrestricted } or { skip: reason }.
export function sideRules(t) {
  const kind = t[''];
  if (!kind || kind === 'separate') return { skip: 'mapped separately' };
  const named = (t.description || '').trim();
  const zone = t.bus === 'designated' ? 'Bus Zone' : t.taxi === 'designated' ? 'Taxi Zone' : t.disabled === 'designated' ? 'Mobility Parking'
    : t.mail === 'designated' ? 'Mail Zone' : t.access === 'no' && named ? named : null;
  if (kind === 'no') return { rules: [[0, [0, 1, 2, 3, 4, 5, 6], 0, 24, 0, 0, 1, RESTRICTION[t.restriction] || named || 'No parking']] };
  if (zone) return { rules: [[0, [0, 1, 2, 3, 4, 5, 6], 0, 24, 0, 0, 1, zone]] };
  if (t.restriction && RESTRICTION[t.restriction]) return { rules: [[0, [0, 1, 2, 3, 4, 5, 6], 0, 24, 0, 0, 1, named || RESTRICTION[t.restriction]]] };
  if (t.access === 'no' || t.access === 'private') return { skip: 'not public' };

  // A week of quarter hours: what applies in each.
  const Q = 96, grid = Array.from({ length: 7 }, () => Array.from({ length: Q }, () => ({ fee: null, max: null, no: null, set: 0 })));
  const paint = (hours, fn) => { for (const h of hours) for (const d of h.days) for (let q = Math.round(h.from * 4); q < Math.round(h.to * 4); q++) fn(grid[d][q]); };
  const all = [{ days: [0, 1, 2, 3, 4, 5, 6], from: 0, to: 24 }];
  // Unconditional values first, conditional ones over the top. "15 minutes @ (...)" in a plain key counts as conditional.
  const read = (key, apply) => {
    const plain = t[key];
    if (plain && !/@/.test(plain)) paint(all, (c) => apply(c, plain));
    const cond = conditional([plain && /@/.test(plain) ? plain : '', t[`${key}:conditional`] || ''].filter(Boolean).join('; '));
    if (cond === null) return false;
    for (const c of cond) paint(c.hours, (cell) => apply(cell, c.value));
    return true;
  };
  let ok = read('fee', (c, v) => { c.fee = v === 'yes' ? 'yes' : v === 'no' ? 'no' : c.fee; if (c.fee) c.set = 1; });
  ok = read('maxstay', (c, v) => { c.max = v === 'no' ? null : duration(v) ?? c.max; if (v === 'no' || c.max) c.set = 1; }) && ok;
  ok = read('restriction', (c, v) => { if (RESTRICTION[v]) { c.no = named || RESTRICTION[v]; c.set = 1; } else if (v === 'none') c.set = 1; }) && ok;
  if (!ok) return { skip: 'hours not read' };
  if (t.fee == null && !t['fee:conditional'] && t.maxstay == null && !t['maxstay:conditional'] && !t['restriction:conditional']) {
    // Only "there is parking here" is mapped: that's not a rule, so leave it unknown rather than call it free.
    return { skip: 'no rules mapped' };
  }
  // Runs of identical cells per day -> rules; then join days that have the same run.
  const runs = new Map();
  for (let d = 0; d < 7; d++) {
    let q = 0;
    while (q < Q) {
      const c = grid[d][q], key = JSON.stringify({ ...c, set: 0 });
      let e = q + 1;
      while (e < Q && JSON.stringify({ ...grid[d][e], set: 0 }) === key) e++;
      const rule = c.no ? [0, 0, 0, 0, 0, 0, 1, c.no] : c.fee === 'yes' ? [c.max ?? 24, 0, 0, 0, -1, 0, 0, 'Ticket'] : c.max ? [c.max, 0, 0, 0, 0, 0, 0, ''] : null;
      if (rule) { const k = JSON.stringify([rule, q, e]); if (!runs.has(k)) runs.set(k, { rule, from: q / 4, to: e / 4, days: [] }); runs.get(k).days.push(d); }
      q = e;
    }
  }
  const rules = [...runs.values()].map((r) => { const x = [...r.rule]; x[1] = r.days; x[2] = r.from; x[3] = r.to; return x; });
  // Times nobody mapped (e.g. only "no stopping @ (Mo-Fr 06:00-10:00)") aren't free: they're unknown.
  const gaps = grid.some((day) => day.some((c) => !c.set));
  return { rules, unrestricted: !rules.length && !gaps, gaps };
}

// Plain sign wording for the detail panel, e.g. "1P Ticket 8am-6pm Mon-Fri; No stopping".
const hm = (h) => { const H = Math.floor(h), m = Math.round((h - H) * 60); return `${H % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''}${H < 12 || H === 24 ? 'am' : 'pm'}`; };
const dayWords = (d) => { const s = d.join(); return s === '0,1,2,3,4,5,6' ? '' : s === '1,2,3,4,5' ? ' Mon-Fri' : s === '1,2,3,4,5,6' ? ' Mon-Sat' : s === '6' ? ' Sat' : s === '0' ? ' Sun' : ` ${d.map((x) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][x]).join(',')}`; };
const ruleText = (r) => {
  const when = r[2] === 0 && r[3] === 24 ? '' : ` ${hm(r[2])}-${hm(r[3])}`;
  if (r[6]) return `${r[7]}${when}${dayWords(r[1])}`;
  const p = r[0] >= 24 ? '' : r[0] < 1 ? `${Math.round(r[0] * 60) === 15 ? 'P15' : `${Math.round(r[0] * 60)}min`} ` : `${r[0]}P `;
  return `${p}${r[4] ? 'Ticket' : 'Free'}${when}${dayWords(r[1])}`.trim();
};

export function buildOsmParking(raw, reg, { areaNotes = [] } = {}) {
  const kx = (lat) => Math.cos((lat * Math.PI) / 180) * 111320, ky = 110540;
  const features = [], skipped = {};
  const SIDES = { left: 1, right: -1 };
  for (const w of raw.ways) {
    const t = w.tags || {};
    for (const [side, sd] of Object.entries(SIDES)) {
      // Tags for this side: parking:left:x, falling back to parking:both:x (and the old parking:lane / parking:condition scheme).
      const st = {};
      for (const [k, v] of Object.entries(t)) {
        const m = /^parking:(left|right|both)(?::(.+))?$/.exec(k);
        if (m && (m[1] === side || (m[1] === 'both' && st[m[2] || ''] === undefined))) st[m[2] || ''] = v;
      }
      for (const [k, v] of Object.entries(t)) { // a side-specific tag beats "both"
        const m = /^parking:(left|right)(?::(.+))?$/.exec(k);
        if (m && m[1] === side) st[m[2] || ''] = v;
      }
      if (st[''] === undefined) {
        const lane = t[`parking:lane:${side}`] || t['parking:lane:both'];
        const cond = t[`parking:condition:${side}`] || t['parking:condition:both'];
        if (lane) st[''] = lane === 'no' || lane === 'no_stopping' || lane === 'no_parking' ? 'no' : 'lane';
        if (lane === 'no_stopping') st.restriction = 'no_stopping';
        if (lane === 'no_parking') st.restriction = 'no_parking';
        if (cond === 'free') { st.fee = 'no'; st.maxstay = t[`parking:condition:${side}:maxstay`] || t['parking:condition:both:maxstay'] || 'no'; }
        if (cond === 'ticket') st.fee = 'yes';
      }
      if (st[''] === undefined) continue;
      const out = sideRules(st);
      if (out.skip) { skipped[out.skip] = (skipped[out.skip] || 0) + 1; continue; }
      const text = out.unrestricted ? 'Unrestricted' : out.rules.map(ruleText).join('; ');
      const line = w.line;
      const coords = [];
      for (let i = 0; i < line.length; i++) {
        const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
        const dx = (b[0] - a[0]) * kx(line[i][1]), dy = (b[1] - a[1]) * ky, len = Math.hypot(dx, dy) || 1;
        const nx = (-dy / len) * sd, ny = (dx / len) * sd; // left of the way's direction for sd = 1
        coords.push(round([line[i][0] + (nx * 5.5) / kx(line[i][1]), line[i][1] + (ny * 5.5) / ky]));
      }
      if (coords.length < 2 || dist(coords[0], coords[coords.length - 1]) < 3) continue;
      const mid = Math.max(1, Math.floor(line.length / 2)), a = line[mid - 1], b = line[mid];
      const ex = (b[0] - a[0]) * kx(a[1]), ny0 = (b[1] - a[1]) * ky; // direction of the way, metres east/north
      const bearing = (Math.atan2(-ny0 * sd, ex * sd) * 180) / Math.PI; // compass bearing of the side's outward normal
      const sdName = ['North', 'North-east', 'East', 'South-east', 'South', 'South-west', 'West', 'North-west'][Math.round((((bearing % 360) + 360) % 360) / 45) % 8] + ' side';
      const extra = (areaNotes.find((n) => line[mid][0] >= n.box[0] && line[mid][0] <= n.box[2] && line[mid][1] >= n.box[1] && line[mid][1] <= n.box[3]) || {}).text || '';
      const k = reg.add({ rules: out.rules, q: 0, g: out.gaps ? 'unknown' : 'free', u: out.unrestricted ? 1 : 0, src: `OpenStreetMap contributors (ODbL), street parking mapped by volunteers${extra && out.rules.some((r) => r[4] < 0) ? `. ${extra}` : ''}`, text });
      features.push({ type: 'Feature', properties: { s: t.name || 'Unnamed street', b: '', sd: sdName, k, z: 2, pa: '', f15: 0, n: 0, src: 'osm', osm: w.id }, geometry: { type: 'LineString', coordinates: coords } });
    }
  }
  log(`  osm street parking: ${features.length} kerb sides from ${raw.ways.length} streets, skipped ${JSON.stringify(skipped)}`);
  return { features, carparks: [], skipped };
}
