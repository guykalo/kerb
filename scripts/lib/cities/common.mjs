// Helpers shared by the Melbourne, Brisbane and Perth builders.
export const log = (...a) => (globalThis.__log || console.log)(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function getJSON(url, { tries = 4, timeout = 180000, init = {} } = {}) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Kerb parking map (github.com/guykalo/kerb)' }, signal: AbortSignal.timeout(timeout), ...init });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200));
      return j;
    } catch (e) {
      if (i >= tries) throw new Error(`${url.slice(0, 160)}\n  ${e.message}`);
      await sleep(2000 * 2 ** i);
    }
  }
}
// Every record of an ArcGIS feature layer, paged.
export async function arcgisAll(layer, params = {}) {
  const out = [];
  for (let start = 0; ; start += 2000) {
    const q = new URLSearchParams({ where: '1=1', outFields: '*', outSR: '4326', f: 'json', resultOffset: String(start), resultRecordCount: '2000', geometryPrecision: '6', ...params });
    const j = await getJSON(`${layer}/query?${q}`);
    out.push(...j.features);
    if (!j.exceededTransferLimit && j.features.length < 2000) break;
  }
  return out;
}
// Road centrelines from OpenStreetMap (ODbL), to line meters up with their street.
export async function osmRoads([w, s, e, n]) {
  const q = `[out:json][timeout:120];way[highway~"^(primary|secondary|tertiary|residential|unclassified|living_street|service|trunk)$"][name](${s},${w},${n},${e});out tags geom;`;
  for (const ep of ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter']) {
    for (let i = 0; i < 2; i++) {
      try {
        const r = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Kerb parking map (github.com/guykalo/kerb)' }, signal: AbortSignal.timeout(150000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()).elements.filter((x) => x.geometry).map((x) => ({ name: x.tags.name, line: x.geometry.map((p) => [+p.lon.toFixed(6), +p.lat.toFixed(6)]) }));
      } catch (err) { log(`  osm roads: ${ep} ${err.message}`); await sleep(6000); }
    }
  }
  throw new Error('OpenStreetMap roads unavailable');
}

export const R5 = (c) => [+c[0].toFixed(5), +c[1].toFixed(5)];
export const kx = (lat) => Math.cos((lat * Math.PI) / 180) * 111320;
export const KY = 110540;
export const distM = (a, b) => Math.hypot((a[0] - b[0]) * kx(a[1]), (a[1] - b[1]) * KY);
// Lines bucketed in ~200 m cells, so looking up the nearest street stays fast for thousands of points.
const IDX = new WeakMap();
function cellsFor(lines) {
  if (IDX.has(lines)) return IDX.get(lines);
  const g = new Map(), C = 0.002;
  for (const l of lines) for (let i = 1; i < l.line.length; i++) {
    const a = l.line[i - 1], b = l.line[i];
    for (let x = Math.floor(Math.min(a[0], b[0]) / C); x <= Math.floor(Math.max(a[0], b[0]) / C); x++) for (let y = Math.floor(Math.min(a[1], b[1]) / C); y <= Math.floor(Math.max(a[1], b[1]) / C); y++) {
      const k = `${x}:${y}`; if (!g.has(k)) g.set(k, []); g.get(k).push([l, i]);
    }
  }
  IDX.set(lines, g);
  return g;
}
export function nearestOnLines(p, lines, maxD = 30) {
  let best = null;
  const g = cellsFor(lines), C = 0.002, cx = Math.floor(p[0] / C), cy = Math.floor(p[1] / C), seen = new Set();
  const cand = [];
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const e of g.get(`${cx + i}:${cy + j}`) || []) { const key = e[0].line.length * 1e6 + e[1]; if (!seen.has(e)) { seen.add(e); cand.push(e); } }
  for (const [l, i] of cand) {
    const a = l.line[i - 1], b = l.line[i], k = kx(p[1]);
    const ax = (b[0] - a[0]) * k, ay = (b[1] - a[1]) * KY, px = (p[0] - a[0]) * k, py = (p[1] - a[1]) * KY;
    const L2 = ax * ax + ay * ay || 1, t = Math.max(0, Math.min(1, (px * ax + py * ay) / L2));
    const d = Math.hypot(px - t * ax, py - t * ay);
    if (d < maxD && (!best || d < best.d)) best = { d, road: l, dir: [ax / Math.sqrt(L2), ay / Math.sqrt(L2)], at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] };
  }
  return best;
}
// A straight kerb piece `len` metres long through point p, running along unit direction dir (metres east/north).
export function pieceAlong(p, dir, len) {
  const h = len / 2, k = kx(p[1]);
  return [R5([p[0] - (dir[0] * h) / k, p[1] - (dir[1] * h) / KY]), R5([p[0] + (dir[0] * h) / k, p[1] + (dir[1] * h) / KY])];
}
// Compass name of the side of the road a kerb point is on.
const SIDES = ['North', 'North-east', 'East', 'South-east', 'South', 'South-west', 'West', 'North-west'];
export function sideName(p, near) {
  if (!near) return '';
  const k = kx(p[1]), dx = (p[0] - near.at[0]) * k, dy = (p[1] - near.at[1]) * KY;
  if (Math.hypot(dx, dy) < 1.5) return '';
  const b = (Math.atan2(dx, dy) * 180) / Math.PI;
  return `${SIDES[Math.round((((b % 360) + 360) % 360) / 45) % 8]} side`;
}
export const titleCase = (s) => String(s || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bMc([a-z])/g, (m, c) => 'Mc' + c.toUpperCase())
  .replace(/\bSt\b/g, 'Street').replace(/\bRd\b/g, 'Road').replace(/\bTce\b/g, 'Terrace').replace(/\bPde\b/g, 'Parade').replace(/\bAve?\b/g, 'Avenue').replace(/\bDr\b/g, 'Drive').replace(/\bHwy\b/g, 'Highway').replace(/\bLa\b/g, 'Lane').replace(/\bPl\b/g, 'Place').replace(/\bBvd\b/g, 'Boulevard').replace(/\bCres\b/g, 'Crescent');

/* ---------- days and times in "MON-FRI 7.30AM-9AM, 4.15PM-6PM" style (days first or last) ---------- */
const DAYN = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const ALL = [0, 1, 2, 3, 4, 5, 6];
function dayRange(a, b) { const out = []; for (let d = DAYN[a]; ; d = (d + 1) % 7) { out.push(d); if (d === DAYN[b]) break; } return out; }
function readDays(s) {
  const t = s.toUpperCase().replace(/\s*-\s*/g, '-');
  if (/\b7 DAYS|DAILY|ALL DAYS|AT ALL TIMES|ANY ?TIME/.test(t)) return ALL;
  const out = new Set();
  let found = false;
  for (const m of t.matchAll(/\b(SUN|MON|TUE|WED|THU|FRI|SAT)[A-Z]*(?:-(SUN|MON|TUE|WED|THU|FRI|SAT)[A-Z]*)?\b/g)) {
    found = true;
    for (const d of m[2] ? dayRange(m[1], m[2]) : [DAYN[m[1]]]) out.add(d);
  }
  if (/\bSCHOOL DAYS\b/.test(t)) { found = true; [1, 2, 3, 4, 5].forEach((d) => out.add(d)); }
  if (/\bWEEKDAYS\b/.test(t)) { found = true; [1, 2, 3, 4, 5].forEach((d) => out.add(d)); }
  if (/\bWEEKENDS?\b|\bSAT-SUN\b/.test(t)) { found = true; out.add(0); out.add(6); }
  return found ? [...out].sort() : null;
}
const clock = (h, m, ap) => { let H = +h % 12; if (/P/i.test(ap)) H += 12; return H + (+m || 0) / 60; };
function readTimes(s) {
  const out = [];
  const t = s.toUpperCase().replace(/NOON|MIDDAY/g, '12PM').replace(/MIDNIGHT/g, '12AM').replace(/(\d)\s+(AM|PM)/g, '$1$2');
  for (const m of t.matchAll(/(\d{1,2})(?:[.:](\d\d))?\s*(AM|PM)?\s*-\s*(\d{1,2})(?:[.:](\d\d))?\s*(AM|PM)/g)) {
    let to = clock(m[4], m[5], m[6]);
    if (to === 0) to = 24;
    // "12-6PM" is noon to 6pm, "8-6PM" is 8am to 6pm: with no am/pm on the start, take the shorter positive span.
    const opts = (m[3] ? [m[3]] : ['AM', 'PM']).map((ap) => clock(m[1], m[2], ap)).filter((f) => f < to).sort((x, y) => y - x);
    if (!opts.length) { const f = clock(m[1], m[2], m[3] || 'PM'); if (f > to) { out.push([f, 24]); out.push([0, to]); } continue; }
    out.push([opts[0], to]);
  }
  return out;
}
// -> [{ days, from, to, seg }] where seg is the comma piece it came from (for per-piece words like "(NO FEE)").
export function daysTimes(text) {
  let s = String(text || '').toUpperCase();
  if (/AT ALL TIMES|ANY ?TIME|24 ?HOURS|ALL TIMES/.test(s) && !/\d(AM|PM)/.test(s)) return [{ days: ALL, from: 0, to: 24, seg: s }];
  // "7AM-7PM,7PM-10PM(MON-FRI),7AM-7PM(SAT,SUN)": move bracketed days next to their times.
  s = s.replace(/\(([A-Z ,-]+)\)/g, (m, d) => (readDays(d) ? ` ${d.replace(/,/g, ' ')} ` : m));
  const segs = s.split(/[,;]|\bAND\b/).map((x) => x.trim()).filter(Boolean);
  const parts = segs.map((seg) => ({ seg, days: readDays(seg), times: readTimes(seg) }));
  // A piece with times but no days takes the next piece's days ("6AM-9AM, 4PM-7PM MON-FRI"), else the previous one's.
  for (let i = 0; i < parts.length; i++) if (!parts[i].days && parts[i].times.length) {
    const next = parts.slice(i + 1).find((p) => p.days), prev = parts.slice(0, i).reverse().find((p) => p.days);
    parts[i].days = (next && (!prev || /\d(AM|PM)?\s*$/.test(parts[i].seg)) ? next.days : prev?.days) || null;
  }
  // Days with no times of their own ("MON-FRI 8AM-6PM, SAT"): skip, as we can't tell the hours.
  const out = [];
  for (const p of parts) for (const [from, to] of p.times) out.push({ days: p.days || ALL, from, to, seg: p.seg });
  return out;
}

// Rules that differ only by day are joined into one: [2,[1],9,16,..] + [2,[2],9,16,..] -> [2,[1,2],9,16,..].
export function joinDays(rules) {
  const m = new Map();
  for (const r of rules) { const k = JSON.stringify([r[0], r[2], r[3], r[4], r[5], r[6], r[7], r[8]]); if (!m.has(k)) m.set(k, [r[0], [], ...r.slice(2)]); m.get(k)[1].push(...r[1]); }
  return [...m.values()].map((r) => { r[1] = [...new Set(r[1])].sort(); return r; });
}
