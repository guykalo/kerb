import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '@phosphor-icons/web/regular';
import './style.css';
import {
  DAYS, DAYS_LONG, fmtTime, fmtClock, fmtDays, pLabel, money,
  stateAt, costFor, category, plainNow, dayTimeline,
  busy, busyLevel, BUSY_WORD, BANDS, band,
} from './rules.js';
import { parsePart } from '../scripts/lib/parse-rules.mjs';

const $ = (s) => document.querySelector(s);
const DATA = './data/';
const START = { center: [151.2075, -33.8722], zoom: 15.2 };
const NEAR_M = 650; // list shows kerbs within this distance of the map centre
const WALK_M_PER_MIN = 80;

/* ---------- state ---------- */
const S = { day: 1, hour: 9, stay: 2, sel: null, hidden: new Set(), open: false };
function sydneyNow() {
  const p = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date());
  const g = (t) => (p.find((x) => x.type === t) || {}).value;
  const day = DAYS.indexOf(g('weekday').slice(0, 3));
  const h = (+g('hour') % 24) + Math.floor(+g('minute') / 15) * 0.25;
  return { day: day < 0 ? new Date().getDay() : day, hour: h };
}
const today = sydneyNow();
Object.assign(S, today);
try { const st = +localStorage.getItem('kerb-stay'); if ([0.25, 1, 2, 3, 4].includes(st)) S.stay = st; } catch { /* storage unavailable */ }

/* ---------- theme colours (read from CSS so the map follows light/dark) ---------- */
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;
const C = () => ({
  free: css('--free'), paid: css('--paid'), short: css('--paid'), restricted: css('--restricted'),
  permit: css('--permit'), unknown: css('--unknown'), fg: css('--fg'), bg: css('--bg'), accent: css('--accent'),
});
const BASE = {
  light: { bg: '#e8eef1', land2: '#e1e8eb', water: '#b9d6e5', park: '#d3e5d2', building: '#d6dfe4', road: '#ffffff', roadMajor: '#ffffff', casing: '#cfdbe1', label: '#5a7383', halo: '#eef3f5' },
  dark: { bg: '#0c1821', land2: '#0f1d27', water: '#0d2b3c', park: '#0f2419', building: '#13232e', road: '#203646', roadMajor: '#2a4558', casing: '#152836', label: '#8aa3b2', halo: '#0c1821' },
};

/* ---------- data ---------- */
let KERBS = null, RULES = [], METERS = [], CARPARKS = [], META = null, BOUNDS = null;
const mids = new Map(); // kerb id -> midpoint
const byId = new Map();

async function loadData() {
  const get = (n) => fetch(DATA + n).then((r) => { if (!r.ok) throw new Error(`${n}: HTTP ${r.status}`); return r.json(); });
  [KERBS, RULES, METERS, CARPARKS, META] = await Promise.all(['kerbs.json', 'rules.json', 'meters.json', 'carparks.json', 'meta.json'].map(get));
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  for (const f of KERBS.features) {
    const c = f.geometry.coordinates;
    const a = c[0], b = c[c.length - 1];
    mids.set(f.properties.id, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    byId.set(f.properties.id, f);
    for (const [x, y] of c) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  }
  BOUNDS = [x0, y0, x1, y1];
}

function distM(a, b) {
  const k = Math.cos((a[1] * Math.PI) / 180) * 111320;
  return Math.hypot((a[0] - b[0]) * k, (a[1] - b[1]) * 110540);
}

/* ---------- map ---------- */
const map = new maplibregl.Map({
  container: 'map', style: 'https://tiles.openfreemap.org/styles/positron',
  ...START, minZoom: 11, maxZoom: 19.5, attributionControl: false, pitchWithRotate: false, dragRotate: false,
});
map.touchZoomRotate.disableRotation();
window.__kerbMap = map; // handy for debugging in the browser console
map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'Kerb data: <a href="https://data.cityofsydney.nsw.gov.au/" target="_blank" rel="noopener">City of Sydney</a>' }), 'top-right');

function restyleBase() {
  const t = BASE[dark() ? 'dark' : 'light'];
  for (const l of map.getStyle().layers) {
    const id = l.id;
    if (id.startsWith('kerb') || id.startsWith('meter')) continue;
    try {
      if (l.type === 'background') map.setPaintProperty(id, 'background-color', t.bg);
      else if (l.type === 'fill') {
        const col = /water/.test(id) ? t.water : /park|wood|grass|landcover|pitch|cemetery/.test(id) ? t.park : /building/.test(id) ? t.building : t.land2;
        map.setPaintProperty(id, 'fill-color', col);
        if (/building/.test(id)) map.setPaintProperty(id, 'fill-opacity', 0.8);
      } else if (l.type === 'line') {
        if (/water|river/.test(id)) map.setPaintProperty(id, 'line-color', t.water);
        else if (/boundary|admin/.test(id)) map.setLayoutProperty(id, 'visibility', 'none');
        else if (/casing/.test(id)) map.setPaintProperty(id, 'line-color', t.casing);
        else if (/motorway|trunk|primary|major/.test(id)) map.setPaintProperty(id, 'line-color', t.roadMajor);
        else if (/highway|road|street|minor|path|bridge|tunnel|rail/.test(id)) map.setPaintProperty(id, 'line-color', /rail|path/.test(id) ? t.casing : t.road);
      } else if (l.type === 'symbol') {
        if (l.paint && 'text-color' in (l.paint || {}) || l.layout?.['text-field']) {
          map.setPaintProperty(id, 'text-color', /water/.test(id) ? (dark() ? '#4f87a3' : '#4d7f99') : t.label);
          map.setPaintProperty(id, 'text-halo-color', t.halo);
        }
        if (/poi/.test(id)) map.setLayoutProperty(id, 'visibility', 'none');
      }
    } catch { /* some layers don't take every property */ }
  }
}

function kerbLayers() {
  const c = C();
  const col = ['match', ['get', 'c'], 'free', c.free, 'likely', c.free, 'paid', c.paid, 'short', c.short, 'restricted', c.restricted, 'permit', c.permit, c.unknown];
  const w = (m) => ['interpolate', ['linear'], ['zoom'], 12, 1 * m, 14, 2.2 * m, 16, 4.5 * m, 18, 8 * m];
  const known = ['all', ['!=', ['get', 'c'], 'unknown'], ['!=', ['get', 'c'], 'permit'], ['!=', ['get', 'c'], 'likely'], ['!', ['in', ['get', 'c'], ['literal', [...S.hidden]]]]];
  if (!map.getSource('kerbs')) {
    map.addSource('kerbs', { type: 'geojson', data: KERBS, promoteId: 'id', tolerance: 0.2 });
    map.addSource('meters', { type: 'geojson', data: { type: 'FeatureCollection', features: METERS.map(([x, y, k, n]) => ({ type: 'Feature', properties: { k, n }, geometry: { type: 'Point', coordinates: [x, y] } })) } });
  }
  for (const id of ['kerb-glow', 'kerb-faint', 'kerb-line', 'kerb-short', 'kerb-sel', 'meter-dot']) if (map.getLayer(id)) map.removeLayer(id);
  map.addLayer({ id: 'kerb-glow', type: 'line', source: 'kerbs', filter: ['all', known, ['!=', ['get', 'c'], 'short']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': col, 'line-width': w(3.2), 'line-blur': w(2.4), 'line-opacity': dark() ? 0.35 : 0.18 } });
  map.addLayer({ id: 'kerb-faint', type: 'line', source: 'kerbs', filter: ['all', ['in', ['get', 'c'], ['literal', ['unknown', 'permit', 'likely']]], ['!', ['in', ['get', 'c'], ['literal', [...S.hidden]]]]], layout: { 'line-cap': 'round' }, paint: { 'line-color': col, 'line-width': w(0.55), 'line-opacity': ['case', ['==', ['get', 'c'], 'permit'], 0.4, ['==', ['get', 'c'], 'likely'], 0.85, 0.5], 'line-dasharray': [1.5, 1.5] } });
  map.addLayer({ id: 'kerb-line', type: 'line', source: 'kerbs', filter: ['all', known, ['!=', ['get', 'c'], 'short']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': col, 'line-width': w(1) } });
  map.addLayer({ id: 'kerb-short', type: 'line', source: 'kerbs', filter: ['all', ['==', ['get', 'c'], 'short'], ['!', ['in', 'short', ['literal', [...S.hidden]]]]], layout: { 'line-cap': 'butt' }, paint: { 'line-color': col, 'line-width': w(0.9), 'line-dasharray': [1.2, 1] } });
  map.addLayer({ id: 'kerb-sel', type: 'line', source: 'kerbs', filter: ['==', ['get', 'id'], S.sel && typeof S.sel === 'number' ? S.sel : -1], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.fg, 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 1.5, 18, 3], 'line-gap-width': w(1.4), 'line-opacity': 0.95 } });
  map.addLayer({ id: 'meter-dot', type: 'circle', source: 'meters', minzoom: 16.5, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 16.5, 2, 19, 5], 'circle-color': c.bg, 'circle-stroke-color': c.fg, 'circle-stroke-width': 1.2 } });
}

function recolour() {
  if (!KERBS) return;
  for (const f of KERBS.features) f.properties.c = category(f.properties, RULES, S.day, S.hour, S.stay);
  const src = map.getSource('kerbs');
  if (src) src.setData(KERBS);
}

/* ---------- car parks ---------- */
const cpMarkers = [];
function drawCarParks() {
  cpMarkers.forEach((m) => m.remove()); cpMarkers.length = 0;
  if (S.hidden.has('carpark')) return;
  for (const cp of CARPARKS) {
    const el = document.createElement('button');
    el.type = 'button'; el.className = 'cp-pin' + (S.sel === cp.id ? ' sel' : '');
    el.setAttribute('aria-label', cp.name);
    const price = carParkPrice(cp);
    el.innerHTML = `<b>P</b>${price ? money(price.p) : 'Car park'}`;
    el.addEventListener('click', (e) => { e.stopPropagation(); select(cp.id, true); });
    cpMarkers.push(new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(cp.at).addTo(map));
  }
}
// Prices for car parks only exist where they've been checked by hand (data/carparks.json).
function carParkPrice(cp) {
  if (!cp.bands) return null;
  const o = [];
  const b = cp.bands.find((x) => S.stay <= x[0]) || cp.bands[cp.bands.length - 1];
  o.push({ k: 'Casual rate', p: b[1] });
  if (cp.earlyBird && S.day >= 1 && S.day <= 5 && S.hour >= cp.earlyBird.in[0] && S.hour <= cp.earlyBird.in[1] && S.hour + S.stay >= cp.earlyBird.outAfter) o.push({ k: 'Early bird', p: cp.earlyBird.price });
  if (cp.night && S.hour >= cp.night.after) o.push({ k: 'Night rate', p: cp.night.price });
  if (cp.weekend && (S.day === 0 || S.day === 6)) o.push({ k: 'Weekend rate', p: cp.weekend });
  return o.reduce((a, x) => (x.p < a.p ? x : a));
}

/* ---------- controls ---------- */
const daySeg = $('#daySeg');
[1, 2, 3, 4, 5, 6, 0].forEach((d) => {
  const b = document.createElement('button');
  b.type = 'button'; b.dataset.v = d; b.textContent = DAYS[d];
  if (d === today.day) { b.classList.add('today'); b.title = 'Today'; }
  b.onclick = () => { S.day = d; update(); };
  daySeg.appendChild(b);
});
$('#staySeg').querySelectorAll('button').forEach((b) => (b.onclick = () => {
  S.stay = +b.dataset.v; try { localStorage.setItem('kerb-stay', String(S.stay)); } catch { /* ignore */ }
  update();
}));
const timeIn = $('#time');
timeIn.addEventListener('input', () => { S.hour = +timeIn.value; update(true); });
timeIn.addEventListener('change', () => update());

function syncControls() {
  daySeg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.v === S.day)));
  $('#staySeg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.v === S.stay)));
  timeIn.value = S.hour;
  $('#timeOut').textContent = fmtClock(S.hour);
  const isNow = S.day === today.day && Math.abs(S.hour - today.hour) < 0.01;
  $('#dayOut').textContent = isNow ? 'now' : DAYS[S.day];
  const box = $('#stayBox');
  box.style.left = `${(S.hour / 24) * 100}%`;
  box.style.width = `${(Math.min(S.stay, 24 - S.hour) / 24) * 100}%`;
}

/* ---------- ribbon: what the kerbs in view do across 24 hours ---------- */
const canvas = $('#ribbonCanvas');
function drawRibbon() {
  const r = canvas.getBoundingClientRect();
  if (!r.width) return;
  const dpr = devicePixelRatio || 1;
  canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, r.width, r.height);
  const c = C();
  g.fillStyle = css('--surface-2'); g.fillRect(0, 0, r.width, r.height);
  if (!KERBS) return;
  const colFor = { free: c.free, limit: c.free, meter: c.paid, restricted: c.restricted };
  const W = r.width / 96;
  const selKerb = typeof S.sel === 'number' ? byId.get(S.sel) : null;
  $('#ribbonTitle').textContent = selKerb ? `${selKerb.properties.s}, ${DAYS_LONG[S.day]}` : `Streets on screen, ${DAYS_LONG[S.day]}`;
  if (selKerb) {
    for (const seg of dayTimeline(selKerb.properties, RULES, S.day)) {
      if (!colFor[seg.kind]) continue;
      g.fillStyle = colFor[seg.kind];
      g.fillRect(seg.from * 4 * W, 0, (seg.to - seg.from) * 4 * W + 0.5, r.height);
    }
    return;
  }
  const inView = visibleKerbs().filter((f) => f.properties.k >= 0);
  if (!inView.length) return;
  for (let q = 0; q < 96; q++) {
    const n = { free: 0, meter: 0, restricted: 0 };
    for (const f of inView) { const kd = stateAt(f.properties, RULES, S.day, q / 4).kind; n[kd === 'limit' ? 'free' : kd]++; }
    let y = r.height;
    for (const k of ['free', 'meter', 'restricted']) {
      const h = (n[k] / inView.length) * r.height;
      g.fillStyle = colFor[k];
      g.fillRect(q * W, y - h, W + 0.4, h);
      y -= h;
    }
  }
}
function visibleKerbs() {
  if (!KERBS) return [];
  const b = map.getBounds();
  return KERBS.features.filter((f) => { const m = mids.get(f.properties.id); return m[0] > b.getWest() && m[0] < b.getEast() && m[1] > b.getSouth() && m[1] < b.getNorth(); });
}

/* ---------- options list ---------- */
const body = $('#body');
function walkText(m) { const min = Math.max(1, Math.round(m / WALK_M_PER_MIN)); return `${min} min walk`; }

function renderList() {
  body.replaceChildren();
  if (!KERBS) { body.innerHTML = `<div class="empty"><strong>Loading the kerbs…</strong>Pulling in every meter in the City of Sydney.</div>`; return; }
  const centre = map.getCenter().toArray();
  const inCoverage = centre[0] > BOUNDS[0] - 0.01 && centre[0] < BOUNDS[2] + 0.01 && centre[1] > BOUNDS[1] - 0.01 && centre[1] < BOUNDS[3] + 0.01;
  if (!inCoverage) {
    body.innerHTML = `<div class="empty"><strong>Not covered yet</strong>Kerb covers the City of Sydney (CBD out to Newtown, Glebe, Surry Hills and Potts Point), Waverley (Bondi, Bronte, Bondi Junction) and Woollahra (Rose Bay, Double Bay, Paddington). More councils are on the way.</div>`;
    return;
  }
  // Best kerb per street near the centre of the map.
  const best = new Map();
  for (const f of KERBS.features) {
    const p = f.properties;
    if (p.k < 0 && !p.lk) continue;
    const d = distM(mids.get(p.id), centre);
    if (d > NEAR_M) continue;
    const c = p.k < 0 ? { ok: true, cost: 0, likely: true } : costFor(p, RULES, S.day, S.hour, S.stay);
    const key = `${p.s}|${p.b}|${p.sd || ''}`;
    const score = (c.ok ? 0 : 1e6) + (c.ok ? c.cost * 40 : 0) + (c.likely ? 250 : 0) + d;
    const cur = best.get(key);
    if (!cur || score < cur.score) best.set(key, { f, p, c, d, score });
  }
  const opts = [...best.values()].sort((a, b) => a.score - b.score);
  const free = opts.filter((o) => o.c.ok && o.c.cost === 0 && !o.c.likely);
  const likely = opts.filter((o) => o.c.likely);
  const paid = opts.filter((o) => o.c.ok && o.c.cost > 0);
  const no = opts.filter((o) => !o.c.ok);

  const sum = document.createElement('div');
  sum.className = 'summary';
  const stayTxt = S.stay === 0.25 ? '15 minutes' : S.stay === 1 ? 'an hour' : `${S.stay} hours`;
  if (free[0]) sum.innerHTML = `Free for ${stayTxt}: <strong>${free[0].p.s}</strong>, ${walkText(free[0].d)} from the middle of the map.${paid[0] ? ` Cheapest meter: <strong>${paid[0].p.s}</strong> at ${money(paid[0].c.cost)}.` : ''}`;
  else if (paid[0]) sum.innerHTML = `No free kerbs nearby for ${stayTxt}. Cheapest meter: <strong>${paid[0].p.s}</strong> at ${money(paid[0].c.cost)}.`;
  else if (likely[0]) sum.innerHTML = `Probably free: <strong>${likely[0].p.s}</strong>, ${walkText(likely[0].d)} away. The council doesn't publish its signs here, so check before you park.`;
  else sum.innerHTML = `No kerb data near the middle of the map. Move the map to a street with coloured kerbs.`;
  body.appendChild(sum);

  const group = (title, list, limit = 12) => {
    if (!list.length) return;
    const h = document.createElement('div'); h.className = 'group'; h.innerHTML = `<span>${title}</span><span class="num">${list.length}</span>`; body.appendChild(h);
    list.slice(0, limit).forEach((o) => body.appendChild(optRow(o)));
  };
  group('Free for your stay', free);
  group('Meters', paid);
  group('Probably free', likely, 8);
  group(`Can't stay ${stayTxt}`, no, 6);
  carParkRows();
  const foot = document.createElement('div'); foot.className = 'foot';
  const upd = META ? new Date(META.fetchedAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'Australia/Sydney' }) : '';
  foot.innerHTML = `Rules come from council open data: the City of Sydney's ${META ? META.meters.toLocaleString() : ''} parking meters, Waverley's kerb-by-kerb parking survey and Woollahra's resident permit areas, refreshed nightly${upd ? `, last on ${upd}` : ''}. Councils don't publish every sign, so always read the sign before you park.`;
  body.appendChild(foot);
}

function optRow(o) {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'opt' + (o.c.ok ? '' : ' no');
  const cat = category(o.p, RULES, S.day, S.hour, S.stay);
  const s = stateAt(o.p, RULES, S.day, S.hour);
  const sub = o.c.ok
    ? (o.c.likely ? 'No permit scheme, check the sign' : s.kind === 'meter' ? `${pLabel(s.rule[0])} meter until ${fmtTime(s.rule[3])}` : s.kind === 'limit' ? `Free ${pLabel(s.rule[0])} until ${fmtTime(s.rule[3])}` : s.why === 'unrestricted' ? 'No time limit' : s.until < 24 ? `Free until ${fmtTime(s.until)}` : 'Free for the rest of the day')
    : o.c.why;
  const lv = busyLevel(busy(o.p, RULES, S.day, S.hour));
  b.innerHTML = `<span class="bar" style="background:var(--${cat === 'short' ? 'paid' : cat})"></span>
    <span style="min-width:0"><div class="name">${o.p.s}</div><div class="sub">${[o.p.sd, o.p.b].filter(Boolean).join(', ')}${o.p.sd || o.p.b ? '. ' : ''}${sub}</div></span>
    <span class="right">${o.c.ok ? `<span class="price ${o.c.cost === 0 ? 'free' : ''}">${money(o.c.cost)}</span>` : ''}<span class="walk">${walkText(o.d)}${o.c.ok ? `, ${BUSY_WORD[lv].toLowerCase()}` : ''}</span></span>`;
  b.onclick = () => select(o.p.id, true);
  return b;
}

function carParkRows() {
  if (!CARPARKS.length || S.hidden.has('carpark')) return;
  const centre = map.getCenter().toArray();
  const near = CARPARKS.map((cp) => ({ cp, d: distM(cp.at, centre) })).filter((x) => x.d < 1500).sort((a, b) => a.d - b.d);
  if (!near.length) return;
  const h = document.createElement('div'); h.className = 'group'; h.innerHTML = `<span>Car parks</span><span class="num">${near.length}</span>`; body.appendChild(h);
  for (const { cp, d } of near) {
    const price = carParkPrice(cp);
    const b = document.createElement('button'); b.type = 'button'; b.className = 'opt';
    b.innerHTML = `<span class="bar" style="background:var(--fg)"></span><span style="min-width:0"><div class="name">${cp.name}</div><div class="sub">${price ? price.k : `Run by ${cp.operator}`}</div></span><span class="right">${price ? `<span class="price">${money(price.p)}</span>` : ''}<span class="walk">${walkText(d)}</span></span>`;
    b.onclick = () => select(cp.id, true);
    body.appendChild(b);
  }
}

/* ---------- detail ---------- */
// Plates come straight from the meter's own sign text, so they read like the real sign.
function plateHTML(part) {
  const m = /^(\d+(?:\/\d+)?)P\s+(\S+)\s*-\s*(\S+)\s+(.+?),\s*\$(\d+(?:\.\d+)?)/i.exec(part.trim());
  if (!m) return `<div class="plate"><div class="l">${part}</div></div>`;
  const p = { '1/4': '¼', '1/2': '½' }[m[1]] || m[1];
  const allDay = m[2] === '12AM' && m[3] === '12AM';
  const ph = /PUBLIC HOLIDAYS/i.test(m[4]);
  const days = m[4].replace(/&?\s*PUBLIC HOLIDAYS/i, '').trim();
  const on = (parsePart(part) || []).some((r) => r.d.includes(S.day) && S.hour >= r.f && S.hour < r.t);
  return `<figure class="plate-wrap${on ? '' : ' off'}">
    <div class="plate" role="img" aria-label="${p}P ticket parking ${allDay ? 'at all times' : `${m[2]} to ${m[3]}`}, ${days}${ph ? ' and public holidays' : ''}, $${m[5]} an hour">
    <div class="p">${p}P</div><div class="l">Ticket</div>
    <div class="l">${allDay ? 'All times' : `${m[2]}-${m[3]}`}</div>
    <div class="l">${days}</div>
    ${ph ? '<div class="s">&amp; public hols</div>' : ''}
    <div class="s">$${m[5]}/hr</div></div>
    <figcaption>${on ? `In force at ${fmtTime(S.hour)}` : `Not in force at ${fmtTime(S.hour)}`}</figcaption></figure>`;
}

// Joins rules the parser split at midnight back into one sign, e.g. 6pm-8am.
function mergeOvernight(rules) {
  const out = [];
  for (const r of rules) {
    if (r[2] === 0 && r[3] < 24 && rules.some((x) => x !== r && x[3] === 24 && x[2] > 0 && x[0] === r[0] && x[4] === r[4] && x[6] === r[6])) continue;
    if (r[3] === 24 && r[2] > 0) {
      const tail = rules.find((x) => x !== r && x[2] === 0 && x[3] < 24 && x[0] === r[0] && x[4] === r[4] && x[6] === r[6]);
      if (tail) { out.push([r[0], r[1], r[2], tail[3], ...r.slice(4)]); continue; }
    }
    out.push(r);
  }
  return out;
}
const hhmm = (h) => fmtTime(h).replace('midnight', '12am').replace('noon', '12pm');
function ruleOn(r) {
  const h = S.hour;
  if (r[3] > r[2] || (r[2] === 0 && r[3] === 24)) return r[1].includes(S.day) && h >= r[2] && h < r[3];
  return (r[1].includes(S.day) && h >= r[2]) || (r[1].includes((S.day + 6) % 7) && h < r[3]);
}
// Draws a sign plate from a parsed rule (used for councils that publish rules rather than meter text).
function rulePlate(r) {
  const on = ruleOn(r);
  const time = r[2] === 0 && r[3] === 24 ? 'All times' : `${hhmm(r[2])}-${hhmm(r[3])}`;
  const days = fmtDays(r[1]).replace('Every day', '');
  const inner = r[6] === 1
    ? `<div class="plate red"><div class="l big2">${(r[7] || 'No parking').toUpperCase()}</div><div class="l">${time}</div>${days ? `<div class="l">${days}</div>` : ''}</div>`
    : `<div class="plate"><div class="p">${pLabel(r[0])}</div>${r[4] > 0 ? '<div class="l">Ticket</div>' : ''}<div class="l">${time}</div>${days ? `<div class="l">${days}</div>` : ''}${r[7] ? `<div class="s">${r[7]}</div>` : ''}${r[4] > 0 ? `<div class="s">$${r[4]}/hr</div>` : ''}</div>`;
  return `<figure class="plate-wrap${on ? '' : ' off'}">${inner}<figcaption>${on ? `In force at ${fmtTime(S.hour)}` : `Not in force at ${fmtTime(S.hour)}`}</figcaption></figure>`;
}

// Says in plain words why the stay costs what it does.
function verdictText(p, c) {
  if (p.lk) return { head: 'Probably free', why: '' };
  if (c.ok === null) return { head: 'No published rules', why: '' };
  if (!c.ok) return { head: "You can't stay that long", why: '' };
  if (c.quarterFree) return { head: 'Free with a ticket', why: 'The first 15 minutes are free. Grab a ticket from the meter.' };
  const end = S.hour + S.stay;
  if (c.paidHours === 0) {
    const s = stateAt(p, RULES, S.day, S.hour);
    if (s.kind === 'limit') return { head: 'Free, within the time limit', why: `It's a free ${pLabel(s.rule[0])} zone ${s.rule[2] === 0 && s.rule[3] === 24 ? 'at all times' : `from ${fmtTime(s.rule[2])} to ${fmtTime(s.rule[3])}`}, so your ${S.stay === 0.25 ? '15 minutes fit' : `${S.stay} hour${S.stay > 1 ? 's fit' : ' fits'}`}.${s.rule[7] ? ` ${s.rule[7]}.` : ''}` };
    if (s.why === 'unrestricted') return { head: 'Free, no time limit', why: 'Unrestricted parking. No sign limits this kerb.' };
    if (s.why === 'outside-sign') return { head: 'Free the whole time', why: plainNow(p, RULES, S.day, S.hour) };
    const why = s.why === 'before-hours' || s.why === 'night'
      ? `The meters don't start until ${fmtTime(s.until)}, and you're gone by ${fmtTime(end)}.`
      : s.why === 'after-hours' ? `The meters have finished for ${DAYS_LONG[S.day]}.`
        : `There are no meter hours on ${DAYS_LONG[S.day]}s.`;
    return { head: 'Free the whole time', why };
  }
  if (c.freeHours > 0 && c.firstPaidAt > S.hour) return { head: `Free until ${fmtTime(c.firstPaidAt)}, then pay`, why: `The meter starts at ${fmtTime(c.firstPaidAt)}, so you pay for ${c.paidHours === 1 ? '1 hour' : `${c.paidHours} hours`} at ${money(c.rate)} an hour.` };
  if (c.freeHours > 0) return { head: 'Pay, then free', why: `You pay ${money(c.rate)} an hour until the meter finishes, then the rest is free.` };
  return { head: `${money(c.rate)} an hour`, why: '' };
}

function weekHTML(p) {
  const colFor = { free: 'var(--free)', limit: 'var(--limit)', meter: 'var(--paid)', restricted: 'var(--restricted)', unknown: 'var(--unknown)' };
  const rows = [1, 2, 3, 4, 5, 6, 0].map((d) => {
    const segs = dayTimeline(p, RULES, d).map((s) => `<i style="width:${((s.to - s.from) / 24) * 100}%;background:${colFor[s.kind]}" title="${DAYS[d]} ${fmtTime(s.from)}-${fmtTime(s.to)}: ${s.kind === 'meter' ? `${pLabel(s.rule[0])} meter` : s.kind === 'limit' ? `free ${pLabel(s.rule[0])}` : s.kind === 'free' ? 'free' : 'no parking'}"></i>`).join('');
    const now = d === S.day ? `<span class="now" style="left:calc(${(S.hour / 24) * 100}% - 1px)"></span>` : '';
    return `<span class="d ${d === S.day ? 'cur' : ''}">${DAYS[d]}</span><div class="track">${segs}${now}</div>`;
  }).join('');
  return `<div class="week">${rows}<div class="scale"><span>12am</span><span>6am</span><span>noon</span><span>6pm</span><span>12am</span></div></div>
    <div class="keyrow"><span><i style="background:var(--free)"></i>Free</span><span><i style="background:var(--limit)"></i>Free, time limit</span><span><i style="background:var(--paid)"></i>Meter</span><span><i style="background:var(--restricted)"></i>No parking</span></div>`;
}

function busyHTML(p) {
  const head = `<span></span>${BANDS.map(([n]) => `<span class="h">${n}</span>`).join('')}`;
  const rows = [1, 2, 3, 4, 5, 6, 0].map((d) => `<span class="d">${DAYS[d]}</span>${BANDS.map(([n, bi]) => {
    const h = [3, 8, 13, 17, 21][bi];
    const lv = busyLevel(busy(p, RULES, d, h));
    return `<span class="c ${lv}${d === S.day && bi === band(S.hour) ? ' cur' : ''}" title="${DAYS[d]} ${n}: ${BUSY_WORD[lv]}"></span>`;
  }).join('')}`).join('');
  return `<div class="busy">${head}${rows}</div>`;
}

function renderDetail() {
  const f = typeof S.sel === 'number' ? byId.get(S.sel) : null;
  const cp = !f && CARPARKS.find((c) => c.id === S.sel);
  if (!f && !cp) { S.sel = null; renderList(); return; }
  body.replaceChildren();
  const d = document.createElement('div'); d.className = 'detail';
  const stayTxt = S.stay === 0.25 ? '15 min' : `${S.stay} hr${S.stay > 1 ? 's' : ''}`;
  if (f) {
    const p = f.properties;
    const c = p.lk ? { ok: true, cost: 0, likely: true } : costFor(p, RULES, S.day, S.hour, S.stay);
    const set = p.k >= 0 ? RULES[p.k] : null;
    const lv = busyLevel(busy(p, RULES, S.day, S.hour));
    const v = verdictText(p, c);
    d.innerHTML = `
      <button class="back" type="button"><i class="ph ph-arrow-left"></i>All options</button>
      <div><h2>${p.s}</h2><div class="where">${[p.sd, p.b, p.pa ? `Permit ${p.pa}` : '', p.n ? `about ${p.n} paid spaces` : ''].filter(Boolean).join(', ')}</div></div>
      <div class="verdict"><div><small>${stayTxt}, ${DAYS[S.day]} ${fmtTime(S.hour)} to ${fmtTime((S.hour + S.stay) % 24)}</small>${v.head}</div>
        ${p.lk ? `<span class="big" style="color:var(--free)">$0?</span>` : c.ok ? `<span class="big" style="color:var(--${c.cost === 0 ? 'free' : 'fg'})">${money(c.cost)}</span>` : c.ok === false ? `<span class="no">${c.why}</span>` : ''}</div>
      <p class="plain">${v.why || plainNow(p, RULES, S.day, S.hour)}${p.f15 ? ' This street is in a free 15-minute zone, so a ticket gets you the first quarter hour free.' : ''}</p>
      ${set ? `<h3 class="h3">What the signs say</h3><div class="plates">${set.src ? (set.u ? '<p class="plain">No signs. Unrestricted parking.</p>' : mergeOvernight(set.rules).map(rulePlate).join('')) : set.text.split(';').filter((x) => x.trim()).map(plateHTML).join('')}</div>
      <h3 class="h3">Across the week</h3>${weekHTML(p)}
      <h3 class="h3">How hard to find a spot: ${BUSY_WORD[lv].toLowerCase()} right now</h3>${busyHTML(p)}
      <p class="note">Busyness is an estimate from the area and its time limits. It gets real once drivers start reporting.</p>
      <p class="note">Source: ${set.src ? `${set.src} parking survey${set.text && set.src ? `. Recorded as "${set.text}"` : ''}` : `City of Sydney parking meter data`}. Councils update signs from time to time, so the sign on the street always wins.</p>
      ` : `<p class="note">${p.lk ? 'Based on Woollahra Council\'s resident permit areas: streets outside a permit scheme are usually unrestricted, but the council doesn\'t publish its signs.' : 'Kerb only shows rules the council publishes. This side of the street has no published signs yet.'}</p>`}
      <a class="cta" href="https://www.google.com/maps/dir/?api=1&destination=${mids.get(p.id)[1]},${mids.get(p.id)[0]}" target="_blank" rel="noopener"><i class="ph ph-navigation-arrow"></i>Directions</a>`;
  } else {
    const price = carParkPrice(cp);
    d.innerHTML = `
      <button class="back" type="button"><i class="ph ph-arrow-left"></i>All options</button>
      <div><h2>${cp.name}</h2><div class="where">${cp.address}. Entry from ${cp.entry}.</div></div>
      ${price ? `<div class="verdict"><div><small>${stayTxt} from ${DAYS[S.day]} ${fmtTime(S.hour)}</small>${price.k}</div><span class="big">${money(price.p)}</span></div>`
        : `<p class="plain">A City of Sydney car park run by ${cp.operator}. Rates aren't published as open data, so check with ${cp.operator} before you go.</p>`}
      ${cp.phone ? `<p class="plain">Phone <span class="num">${cp.phone}</span></p>` : ''}
      ${cp.checked ? `<p class="note">Prices checked ${cp.checked} on the operator's website.</p>` : ''}
      <a class="cta" href="https://www.google.com/maps/dir/?api=1&destination=${cp.at[1]},${cp.at[0]}" target="_blank" rel="noopener"><i class="ph ph-navigation-arrow"></i>Directions</a>`;
  }
  body.appendChild(d);
  body.scrollTop = 0;
  d.querySelector('.back').onclick = () => { S.sel = null; update(); };
}

function select(id, fly) {
  S.sel = id;
  if (id != null) setOpen(true);
  if (fly && id != null) {
    const at = typeof id === 'number' ? mids.get(id) : CARPARKS.find((c) => c.id === id)?.at;
    if (at) {
      const desk = innerWidth >= 900;
      map.easeTo({ center: at, zoom: Math.max(map.getZoom(), 16.5), padding: desk ? { left: 430, top: 0, right: 0, bottom: 0 } : { bottom: innerHeight * 0.55, top: 60, left: 0, right: 0 }, duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 600 });
    }
  }
  update();
}

/* ---------- legend ---------- */
const LEGEND = [['free', 'Free'], ['likely', 'Probably free'], ['paid', 'Meter'], ['short', 'Too short'], ['restricted', 'No parking'], ['permit', 'Permit area'], ['carpark', 'Car parks']];
function renderLegend() {
  const lg = $('#legend'); lg.replaceChildren();
  for (const [k, n] of LEGEND) {
    const b = document.createElement('button'); b.type = 'button';
    b.setAttribute('aria-pressed', String(!S.hidden.has(k)));
    b.innerHTML = (k === 'carpark' ? '<i style="background:var(--fg);height:10px;width:10px;border-radius:50%"></i>' : `<i class="${k === 'short' ? 'dash' : k === 'likely' ? 'dash-free' : ''}" style="background:var(--${k === 'short' ? 'paid' : k === 'likely' ? 'free' : k})"></i>`) + n;
    b.title = k === 'short' ? 'Meter parking, but the time limit is shorter than your stay' : k === 'permit' ? "Resident permit areas where the council hasn't published the signs" : '';
    b.onclick = () => { S.hidden.has(k) ? S.hidden.delete(k) : S.hidden.add(k); renderLegend(); if (map.isStyleLoaded()) kerbLayers(); drawCarParks(); renderBody(); };
    lg.appendChild(b);
  }
}

/* ---------- sheet (phones): min (full map), peek, open ---------- */
const panel = $('#panel');
const root = document.documentElement;
let sheet = 'peek';
const px = (v) => parseFloat(getComputedStyle(root).getPropertyValue(v)) || 0;
function setPeek() {
  const dock = $('#dock').getBoundingClientRect().height;
  const row = $('.dock-row').getBoundingClientRect().height;
  root.style.setProperty('--peek', `${Math.round(dock + 22 + 64)}px`);
  root.style.setProperty('--min', `${Math.round(row + 22 + 12)}px`);
  setSheet(sheet, true);
}
function visibleHeight(state) {
  if (innerWidth >= 900) return 0;
  return state === 'open' ? panel.offsetHeight : state === 'min' ? px('--min') : px('--peek');
}
function setSheet(state, quiet) {
  sheet = state; S.open = state === 'open';
  panel.classList.toggle('open', state === 'open');
  panel.classList.toggle('min', state === 'min');
  root.style.setProperty('--vis', `${Math.round(visibleHeight(state === 'open' ? 'peek' : state))}px`);
  const fb = $('#fullBtn');
  if (fb) { fb.setAttribute('aria-pressed', String(state === 'min')); fb.innerHTML = state === 'min' ? '<i class="ph ph-arrows-in-simple"></i>' : '<i class="ph ph-arrows-out-simple"></i>'; fb.setAttribute('aria-label', state === 'min' ? 'Show the options' : 'Full screen map'); }
  if (!quiet) setTimeout(() => map.resize(), 340);
}
function setOpen(v) { setSheet(v ? 'open' : 'peek'); }
(() => {
  const h = $('#handle');
  let y0 = null, moved = false, startOff = 0;
  const offFor = (state) => panel.offsetHeight - visibleHeight(state);
  h.addEventListener('pointerdown', (e) => { y0 = e.clientY; moved = false; startOff = offFor(sheet); h.setPointerCapture(e.pointerId); panel.classList.add('dragging'); });
  h.addEventListener('pointermove', (e) => {
    if (y0 == null) return;
    const dy = e.clientY - y0; if (Math.abs(dy) > 4) moved = true;
    const off = Math.min(offFor('min'), Math.max(0, startOff + dy));
    panel.style.transform = `translateY(${off}px)`;
  });
  const end = (e) => {
    if (y0 == null) return;
    const dy = e.clientY - y0; y0 = null; panel.classList.remove('dragging'); panel.style.transform = '';
    if (!moved) { setSheet(sheet === 'min' ? 'peek' : sheet === 'peek' ? 'open' : 'peek'); return; }
    const off = startOff + dy;
    const options = ['open', 'peek', 'min'].map((s) => [s, Math.abs(offFor(s) - off)]);
    setSheet(options.sort((x, y) => x[1] - y[1])[0][0]);
  };
  h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
  $('#dock').addEventListener('click', (e) => { if (innerWidth < 900 && sheet !== 'open' && e.target.closest('button,input') === null) setSheet(sheet === 'min' ? 'peek' : 'open'); });
  $('#fullBtn').addEventListener('click', () => setSheet(sheet === 'min' ? 'peek' : 'min'));
})();

/* ---------- keep the page pinned on phones (iOS can scroll or zoom the whole page after the keyboard) ---------- */
function settle() { if (scrollX || scrollY) scrollTo(0, 0); map.resize(); setPeek(); }
visualViewport?.addEventListener('resize', () => { clearTimeout(settle.t); settle.t = setTimeout(settle, 150); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { settle(); map.triggerRepaint(); } });
addEventListener('pageshow', settle);
map.on('webglcontextlost', () => toast('The map paused. It will come back in a moment.'));
map.on('webglcontextrestored', () => { restyleBase(); if (KERBS) { kerbLayers(); recolour(); } });

/* ---------- search ---------- */
const q = $('#q'), results = $('#results');
let searchTimer = null, searchCtl = null;
q.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 250); });
q.addEventListener('keydown', (e) => { if (e.key === 'Escape') { results.hidden = true; q.blur(); } });
q.addEventListener('blur', () => setTimeout(settle, 120));
$('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); const first = results.querySelector('button'); if (first) first.click(); else runSearch(); });
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) results.hidden = true; });
async function runSearch() {
  const text = q.value.trim();
  if (text.length < 3) { results.hidden = true; return; }
  searchCtl?.abort(); searchCtl = new AbortController();
  try {
    const u = `https://photon.komoot.io/api/?q=${encodeURIComponent(text)}&lat=-33.873&lon=151.207&limit=6&bbox=150.6,-34.2,151.4,-33.5&lang=en`;
    const j = await fetch(u, { signal: searchCtl.signal }).then((r) => r.json());
    results.replaceChildren();
    const feats = (j.features || []).filter((f) => f.properties.countrycode === 'AU');
    if (!feats.length) { results.innerHTML = `<li><button type="button" disabled>No places found. Try a street name and suburb.</button></li>`; results.hidden = false; return; }
    for (const f of feats) {
      const p = f.properties;
      const li = document.createElement('li');
      const b = document.createElement('button'); b.type = 'button';
      const title = p.name || [p.housenumber, p.street].filter(Boolean).join(' ');
      b.innerHTML = `<span>${title}</span><small>${[p.street && p.name ? p.street : '', p.district || p.locality, p.city].filter(Boolean).join(', ')}</small>`;
      b.onclick = () => { results.hidden = true; q.value = title; q.blur(); S.sel = null; map.flyTo({ center: f.geometry.coordinates, zoom: 16.4, duration: 900 }); setOpen(true); };
      li.appendChild(b); results.appendChild(li);
    }
    results.hidden = false;
  } catch (e) { if (e.name !== 'AbortError') toast("Search isn't responding. Try again in a moment."); }
}

/* ---------- locate ---------- */
let meMarker = null;
$('#locate').onclick = () => {
  if (!navigator.geolocation) return toast("This browser can't share your location.");
  navigator.geolocation.getCurrentPosition((pos) => {
    const at = [pos.coords.longitude, pos.coords.latitude];
    if (!meMarker) { const el = document.createElement('div'); el.style.cssText = `width:16px;height:16px;border-radius:50%;background:${C().accent};border:3px solid #fff;box-shadow:0 0 0 6px color-mix(in srgb, ${C().accent} 25%, transparent)`; meMarker = new maplibregl.Marker({ element: el }); }
    meMarker.setLngLat(at).addTo(map);
    map.flyTo({ center: at, zoom: 16.2, duration: 900 });
  }, () => toast('Location is off. Allow location for this site to use it.'), { enableHighAccuracy: true, timeout: 10000 });
};

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3500); }

/* ---------- update loop ---------- */
let raf = 0;
function renderBody() { S.sel != null ? renderDetail() : renderList(); }
function update(light) {
  syncControls();
  if (raf) cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    raf = 0;
    recolour();
    if (map.getLayer('kerb-sel')) map.setFilter('kerb-sel', ['==', ['get', 'id'], typeof S.sel === 'number' ? S.sel : -1]);
    drawRibbon();
    if (!light) { drawCarParks(); renderBody(); }
    else if (S.sel == null) renderBody();
    else renderDetail();
  });
}

map.on('click', (e) => {
  const hits = map.queryRenderedFeatures([[e.point.x - 10, e.point.y - 10], [e.point.x + 10, e.point.y + 10]], { layers: ['kerb-line', 'kerb-short', 'kerb-faint'].filter((l) => map.getLayer(l)) });
  if (hits.length) select(hits[0].properties.id, false);
  else if (S.sel != null) { S.sel = null; update(); }
});
for (const l of ['kerb-line', 'kerb-short', 'kerb-faint']) {
  map.on('mouseenter', l, () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', l, () => (map.getCanvas().style.cursor = ''));
}
let moveTimer = null;
map.on('moveend', () => { clearTimeout(moveTimer); moveTimer = setTimeout(() => { drawRibbon(); if (S.sel == null) renderList(); }, 120); });

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { restyleBase(); if (KERBS) kerbLayers(); drawRibbon(); });
addEventListener('resize', () => { setPeek(); drawRibbon(); map.resize(); });

/* ---------- boot ---------- */
renderLegend();
syncControls();
setPeek();
renderList();
const dataReady = loadData().catch((e) => { body.innerHTML = `<div class="empty"><strong>The parking data didn't load</strong>Check your connection and reload the page. (${e.message})</div>`; throw e; });
dataReady.then(() => update(), () => {});
map.on('style.load', async () => {
  restyleBase();
  document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  try { await dataReady; } catch { return; }
  recolour();
  kerbLayers();
  update();
});
