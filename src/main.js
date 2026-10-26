import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '@phosphor-icons/web/regular';
import '@phosphor-icons/web/fill';
import './style.css';
import {
  DAYS, DAYS_LONG, fmtTime, fmtClock, fmtDays, pLabel, money,
  stateAt, costFor, category, plainNow, dayTimeline, BEN,
  busy, busyLevel, BUSY_WORD, BANDS, band,
} from './rules.js';
import { parsePart } from '../scripts/lib/parse-rules.mjs';
import { initSnap, snapsToKerbs, initBoard, loadBoards } from './snap.js';
import { initAnalytics } from './analytics.js';

initAnalytics();

const $ = (s) => document.querySelector(s);
// Cities Kerb covers. Sydney's data lives in data/, the others in data/<id>/. One city is loaded at a time.
const CITIES = {
  syd: { name: 'Sydney', center: [151.2075, -33.8722], zoom: 15.2, tz: 'Australia/Sydney', data: './data/', box: [149, -35.5, 153, -32], search: '150.5,-34.3,151.45,-33.4' },
  mel: { name: 'Melbourne', center: [144.9631, -37.8136], zoom: 15.4, tz: 'Australia/Melbourne', data: './data/mel/', box: [144.3, -38.6, 145.8, -37.3], search: '144.6,-38.1,145.3,-37.6', live: true },
  bne: { name: 'Brisbane', center: [153.0251, -27.4698], zoom: 15.4, tz: 'Australia/Brisbane', data: './data/bne/', box: [152.5, -28, 153.6, -26.9], search: '152.8,-27.7,153.25,-27.2' },
  per: { name: 'Perth', center: [115.8605, -31.9523], zoom: 15.6, tz: 'Australia/Perth', data: './data/per/', box: [115.4, -32.6, 116.4, -31.4], search: '115.6,-32.3,116.1,-31.7' },
};
const inBox = (c, [x0, y0, x1, y1]) => c[0] > x0 && c[0] < x1 && c[1] > y0 && c[1] < y1;
// Shared links carry #at=lat,lng (either order); the link's city wins, then ?city=, then the last city used.
const LINK = (() => {
  const m = /at=(-?\d+\.\d+),(-?\d+\.\d+)/.exec(location.hash);
  if (!m) return null;
  const a = +m[1], b = +m[2];
  return Object.values(CITIES).some((c) => inBox([b, a], c.box)) ? [b, a] : Object.values(CITIES).some((c) => inBox([a, b], c.box)) ? [a, b] : null;
})();
const CITY_ID = (() => {
  if (LINK) return Object.keys(CITIES).find((k) => inBox(LINK, CITIES[k].box));
  const q = new URLSearchParams(location.search).get('city');
  if (q && CITIES[q]) return q;
  try { const s = localStorage.getItem('kerb-city'); if (s && CITIES[s]) return s; } catch { /* storage unavailable */ }
  return 'syd';
})();
const CITY = CITIES[CITY_ID];
try { localStorage.setItem('kerb-city', CITY_ID); } catch { /* storage unavailable */ }
document.documentElement.dataset.city = CITY_ID;
document.title = `Kerb · ${CITY.name} parking`;
function goToCity(id, at) {
  try { localStorage.setItem('kerb-city', id); } catch { /* storage unavailable */ }
  location.href = `${location.pathname}?city=${id}${at ? `#at=${at[1].toFixed(5)},${at[0].toFixed(5)}` : ''}`;
}
const DATA = CITY.data;
const START = { center: CITY.center, zoom: CITY.zoom };
const NEAR_M = 650; // list shows kerbs within this distance of the map centre
const WALK_M_PER_MIN = 80;

/* ---------- state ---------- */
const S = { day: 1, hour: 9, stay: 2, night: false, sel: null, hidden: new Set(), open: false, dest: null, walk: 10 };
// Overnight: from the arrival time until 8am the next morning.
const nightStay = (h) => Math.max(1, h < 8 ? 8 - h : 32 - h);
function sydneyNow() { // "now" in the city on the map
  const p = new Intl.DateTimeFormat('en-AU', { timeZone: CITY.tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date());
  const g = (t) => (p.find((x) => x.type === t) || {}).value;
  const day = DAYS.indexOf(g('weekday').slice(0, 3));
  const h = (+g('hour') % 24) + Math.floor(+g('minute') / 15) * 0.25;
  return { day: day < 0 ? new Date().getDay() : day, hour: h };
}
const today = sydneyNow();
Object.assign(S, today);
try { const st = localStorage.getItem('kerb-stay'); if (st === 'night') { S.night = true; S.stay = nightStay(S.hour); } else if ([0.25, 1, 2, 3, 4, 8].includes(+st)) S.stay = +st; } catch { /* storage unavailable */ }
try { const w = +localStorage.getItem('kerb-walk'); if ([2, 5, 10, 15, 20].includes(w)) S.walk = w; } catch { /* storage unavailable */ }
try { BEN.mps = localStorage.getItem('kerb-mps') === '1' && CITY_ID === 'syd'; } catch { /* storage unavailable */ } // NSW concessions only
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
if (LINK) { START.center = LINK; START.zoom = 17; }

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
  // meta.json is always fetched fresh; its build time versions the other files so phones never show stale kerbs.
  const get = (n, v) => fetch(DATA + n + (v ? `?v=${encodeURIComponent(v)}` : ''), v ? {} : { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(`${n}: HTTP ${r.status}`); return r.json(); });
  META = await get('meta.json');
  [KERBS, RULES, METERS, CARPARKS] = await Promise.all(['kerbs.json', 'rules.json', 'meters.json', 'carparks.json'].map((n) => get(n, META.builtAt)));
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
const ATTRIB = {
  syd: 'Kerb data: <a href="https://data.cityofsydney.nsw.gov.au/" target="_blank" rel="noopener">City of Sydney</a>, NSW councils, Transport for NSW, © OpenStreetMap contributors',
  mel: 'Kerb data: <a href="https://data.melbourne.vic.gov.au/" target="_blank" rel="noopener">City of Melbourne</a> (CC BY), © OpenStreetMap contributors',
  bne: 'Kerb data: <a href="https://data.brisbane.qld.gov.au/" target="_blank" rel="noopener">Brisbane City Council</a>, © OpenStreetMap contributors',
  per: 'Kerb data: <a href="https://geohub-perth.opendata.arcgis.com/" target="_blank" rel="noopener">City of Perth</a> (CC BY), © OpenStreetMap contributors',
};
const map = new maplibregl.Map({
  fadeDuration: 260,
  container: 'map', style: 'https://tiles.openfreemap.org/styles/positron',
  ...START, minZoom: 11, maxZoom: 19.5, attributionControl: false, pitchWithRotate: false, dragRotate: false,
});
map.touchZoomRotate.disableRotation();
window.__kerbMap = map; // handy for debugging in the browser console
map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: ATTRIB[CITY_ID] }), 'top-right');

function restyleBase() {
  const t = BASE[dark() ? 'dark' : 'light'];
  for (const l of map.getStyle().layers) {
    const id = l.id;
    if (id.startsWith('kerb') || id.startsWith('meter') || id.startsWith('cp-') || id === 'sat') continue;
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

const under = () => ['dest-mask', 'opt-kerb', 'cp-cluster'].find((id) => map.getLayer(id));
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
  // No-parking kerbs are thinner and don't glow, so the places you can park stand out (CBDs are mostly no stopping).
  const wr = (m, r) => ['interpolate', ['linear'], ['zoom'], ...[12, 1, 14, 2.2, 16, 4.5, 18, 8].flatMap((v, i) => (i % 2 ? [['case', ['==', ['get', 'c'], 'restricted'], v * r, v * m]] : [v]))];
  map.addLayer({ id: 'kerb-glow', type: 'line', source: 'kerbs', filter: ['all', known, ['!=', ['get', 'c'], 'short'], ['!=', ['get', 'c'], 'restricted']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': col, 'line-width': w(3.2), 'line-blur': w(2.4), 'line-opacity': S.sat ? 0.55 : dark() ? 0.35 : 0.18 } }, under());
  map.addLayer({ id: 'kerb-faint', type: 'line', source: 'kerbs', filter: ['all', ['in', ['get', 'c'], ['literal', ['unknown', 'permit', 'likely']]], ['!', ['in', ['get', 'c'], ['literal', [...S.hidden]]]]], layout: { 'line-cap': 'round' }, paint: { 'line-color': col, 'line-width': w(0.55), 'line-opacity': ['case', ['==', ['get', 'c'], 'permit'], 0.4, ['==', ['get', 'c'], 'likely'], 0.85, 0.5], 'line-dasharray': [1.5, 1.5] } }, under());
  map.addLayer({ id: 'kerb-line', type: 'line', source: 'kerbs', filter: ['all', known, ['!=', ['get', 'c'], 'short']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': col, 'line-width': wr(1, 0.55), 'line-opacity': ['case', ['==', ['get', 'c'], 'restricted'], 0.75, 1] } }, under());
  map.addLayer({ id: 'kerb-short', type: 'line', source: 'kerbs', filter: ['all', ['==', ['get', 'c'], 'short'], ['!', ['in', 'short', ['literal', [...S.hidden]]]]], layout: { 'line-cap': 'butt' }, paint: { 'line-color': col, 'line-width': w(0.9), 'line-dasharray': [1.2, 1] } }, under());
  map.addLayer({ id: 'kerb-sel', type: 'line', source: 'kerbs', filter: ['==', ['get', 'id'], S.sel && typeof S.sel === 'number' ? S.sel : -1], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.fg, 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 1.5, 18, 3], 'line-gap-width': w(1.4), 'line-opacity': 0.95 } }, under());
  map.addLayer({ id: 'meter-dot', type: 'circle', source: 'meters', minzoom: 16.5, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 16.5, 2, 19, 5], 'circle-color': c.bg, 'circle-stroke-color': c.fg, 'circle-stroke-width': 1.2 } }, under());
}

function recolour() {
  if (!KERBS) return;
  for (const f of KERBS.features) f.properties.c = category(f.properties, RULES, S.day, S.hour, S.stay);
  const src = map.getSource('kerbs');
  if (src) src.setData(KERBS);
}

/* ---------- satellite (NSW Spatial Services aerial imagery, CC BY 4.0) ---------- */
const SAT_URL = 'https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Imagery/MapServer/tile/{z}/{y}/{x}';
try { S.sat = localStorage.getItem('kerb-sat') === '1'; } catch { S.sat = false; }
function setSat(on) {
  S.sat = on;
  try { localStorage.setItem('kerb-sat', on ? '1' : '0'); } catch { /* private mode */ }
  if (!map.isStyleLoaded()) return;
  if (on && !map.getSource('sat')) map.addSource('sat', { type: 'raster', tiles: [SAT_URL], tileSize: 256, maxzoom: 21, attribution: 'Imagery © NSW Spatial Services' });
  const firstLabel = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  // Zoomed out, photos are dimmed and desaturated so the coloured kerbs and pills still stand out.
  if (on && !map.getLayer('sat')) map.addLayer({ id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-fade-duration': 150, 'raster-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.75, 14, 0.9, 16, 1], 'raster-brightness-max': ['interpolate', ['linear'], ['zoom'], 10, 0.4, 13, 0.55, 15.5, 0.85, 17, 1], 'raster-saturation': ['interpolate', ['linear'], ['zoom'], 10, -0.6, 14, -0.3, 16.5, 0], 'raster-contrast': ['interpolate', ['linear'], ['zoom'], 10, -0.15, 16, 0] } }, firstLabel);
  if (map.getLayer('sat')) map.setLayoutProperty('sat', 'visibility', on ? 'visible' : 'none');
  // Labels need a dark halo over photos.
  for (const l of map.getStyle().layers) {
    if (l.type !== 'symbol' || l.id.startsWith('cp-') || !l.layout?.['text-field'] || l.id.includes('shield')) continue; // road number shields keep their dark text
    try { if (on) { map.setPaintProperty(l.id, 'text-color', '#ffffff'); map.setPaintProperty(l.id, 'text-halo-color', 'rgba(0,0,0,.75)'); } } catch { /* skip */ }
  }
  if (!on) restyleBase();
  if (map.getLayer('kerb-glow')) map.setPaintProperty('kerb-glow', 'line-opacity', on ? 0.55 : dark() ? 0.35 : 0.18);
  const b = $('#satBtn');
  if (b) { b.setAttribute('aria-pressed', String(on)); b.innerHTML = on ? '<i class="ph ph-map-trifold"></i>' : '<i class="ph ph-globe-hemisphere-east"></i>'; b.setAttribute('aria-label', on ? 'Show the street map' : 'Show satellite photos'); }
}

/* ---------- car parks ---------- */
// Car parks are drawn by the map itself as price pills, like Airbnb's map: each shows its price whenever there's
// room, pills that would overlap merge into one "3 car parks · from $15" pill, and the map fades between them.
const CP_FADE = 260;
function cpInfo(cp) {
  const price = carParkPrice(cp);
  if (cp.kind === 'parkride') return { label: prPin(cp), tone: 'pr', p: 0 };
  if (price && !price.none) return { label: cp.maxRates && price.p > 0 ? `≤${money(price.p)}` : money(price.p), tone: price.p === 0 ? 'free' : 'price', p: price.p };
  const est = !price ? estimateFor(cp) : null;
  if (est) return { label: `~${money(est.mid)} est.`, tone: 'est', p: 99999, e: est.mid };
  // Open now, but you can't stay as long as you picked: say how long you can stay instead of a blank pin.
  if (price?.none && price.why === 'long') {
    const lim = Math.max(0, ...cp.rates.filter((r) => r.days?.includes(S.day) && r.maxStay).map((r) => r.maxStay));
    if (lim) return { label: `${lim} hr max`, tone: 'none', p: 99999 };
  }
  return { label: '', tone: 'none', p: 99999 };
}
function cpData() {
  return { type: 'FeatureCollection', features: CARPARKS.map((cp) => {
    const i = cpInfo(cp);
    const out = S.dest && distM(cp.at, S.dest.at) > destRadius() ? 1 : 0;
    return { type: 'Feature', properties: { id: cp.id, label: i.label, tone: i.tone, p: i.p, e: i.e ?? 99999, out, sel: S.sel === cp.id ? 1 : 0 }, geometry: { type: 'Point', coordinates: cp.at } };
  }) };
}
// Rounded pill images the map can stretch around text (drawn once at 2x for sharp edges).
function pillImage(fill, stroke, dashed) {
  const W = 56, H = 44, r = 20, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.beginPath(); g.roundRect(3, 3, W - 6, H - 6, r); g.fillStyle = fill; g.fill();
  if (dashed) g.setLineDash([5, 4]);
  g.lineWidth = 3; g.strokeStyle = stroke; g.stroke();
  return { image: g.getImageData(0, 0, W, H), opts: { pixelRatio: 2, stretchX: [[22, 34]], stretchY: [[20, 24]], content: [16, 8, 40, 36] } };
}
function cpLayers() {
  if (!CARPARKS.length) return;
  const c = C(), green = '#00704a';
  const pills = { 'pill-price': ['#fbfcfb', green], 'pill-free': ['#fbfcfb', css('--free')], 'pill-est': [dark() ? '#b4c3cd' : '#e2e9ee', dark() ? '#f4f8fa' : '#5f7684', true], 'pill-none': ['#fbfcfb', green], 'pill-pr': ['#fbfcfb', green], 'pill-sel': [c.accent, c.accent], 'pill-cluster': [c.fg, c.accent] };
  for (const [id, [f, st, d]] of Object.entries(pills)) { const { image, opts } = pillImage(f, st, d); if (map.hasImage(id)) map.removeImage(id); map.addImage(id, image, opts); }
  if (!map.getSource('cps')) map.addSource('cps', { type: 'geojson', data: cpData(), cluster: true, clusterRadius: 34, clusterMaxZoom: 15, clusterProperties: { minp: ['min', ['get', 'p']], mine: ['min', ['get', 'e']] } });
  for (const id of ['cp-cluster', 'cp-pill', 'cp-sel']) if (map.getLayer(id)) map.removeLayer(id);
  const vis = S.hidden.has('carpark') ? 'none' : 'visible';
  const common = { 'text-font': ['Noto Sans Bold'], 'icon-text-fit': 'both', 'icon-text-fit-padding': [1, 6, 1, 6], 'text-padding': 2, visibility: vis };
  map.addLayer({ id: 'cp-cluster', type: 'symbol', source: 'cps', filter: ['has', 'point_count'], layout: { ...common, 'icon-image': 'pill-cluster', 'text-size': 12,
    // "4 car parks · from $18" (never "P 4", which reads like a 4-hour parking sign).
    'text-field': ['let', 'n', ['concat', ['to-string', ['get', 'point_count']], ' car parks'], ['case',
      ['==', ['get', 'minp'], 0], ['concat', ['var', 'n'], ' · incl. free'],
      ['<', ['get', 'minp'], 99999], ['concat', ['var', 'n'], ' · from $', ['to-string', ['round', ['get', 'minp']]]],
      ['<', ['get', 'mine'], 99999], ['concat', ['var', 'n'], ' · ~$', ['to-string', ['round', ['get', 'mine']]], ' est.'],
      ['var', 'n']]],
    'icon-allow-overlap': false, 'text-allow-overlap': false }, paint: { 'text-color': c.bg } });
  map.addLayer({ id: 'cp-pill', type: 'symbol', source: 'cps', filter: ['all', ['!', ['has', 'point_count']], ['!=', ['get', 'sel'], 1]], layout: { ...common,
    'icon-image': ['concat', 'pill-', ['get', 'tone']], 'text-size': 12.5,
    'text-field': ['case', ['==', ['get', 'label'], ''], 'P', ['format', 'P  ', { 'text-color': green }, ['get', 'label'], {}]],
    'symbol-sort-key': ['get', 'p'], 'icon-allow-overlap': false, 'text-allow-overlap': false },
    paint: { 'text-color': ['match', ['get', 'tone'], 'est', '#1d3140', 'free', '#0f7a43', '#0f2230'], 'icon-opacity': ['case', ['==', ['get', 'out'], 1], 0.4, 1], 'text-opacity': ['case', ['==', ['get', 'out'], 1], 0.4, 1] } });
  map.addLayer({ id: 'cp-sel', type: 'symbol', source: 'cps', filter: ['==', ['get', 'sel'], 1], layout: { ...common, 'icon-image': 'pill-sel', 'text-size': 13,
    'text-field': ['case', ['==', ['get', 'label'], ''], 'P', ['concat', 'P  ', ['get', 'label']]], 'icon-allow-overlap': true, 'text-allow-overlap': true }, paint: { 'text-color': c.bg } });
}
let cpDataKey = '';
function drawCarParks() {
  for (const l of ['cp-cluster', 'cp-pill', 'cp-sel']) if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', S.hidden.has('carpark') ? 'none' : 'visible');
  const src = map.getSource('cps');
  if (!src) return;
  const data = cpData(), key = JSON.stringify(data.features.map((f) => [f.properties.label, f.properties.sel, f.properties.out]));
  if (key !== cpDataKey) { cpDataKey = key; src.setData(data); }
}
// Searching a place: shade everything beyond the walk, ring the walking distance, and label the best kerbs.
const destRadius = () => Math.max(250, S.walk * WALK_M_PER_MIN);
function circle(at, r, n = 72) {
  const k = Math.cos((at[1] * Math.PI) / 180) * 111320;
  return Array.from({ length: n + 1 }, (_, i) => { const a = (i / n) * 2 * Math.PI; return [at[0] + (r * Math.cos(a)) / k, at[1] + (r * Math.sin(a)) / 110540]; });
}
const EMPTY = { type: 'FeatureCollection', features: [] };
function destLayers() {
  if (!map.getSource('dest-area')) { map.addSource('dest-area', { type: 'geojson', data: EMPTY }); map.addSource('opts', { type: 'geojson', data: EMPTY }); }
  for (const id of ['dest-mask', 'dest-ring', 'opt-kerb', 'opt-badge']) if (map.getLayer(id)) map.removeLayer(id);
  const c = C(), before = map.getLayer('cp-cluster') ? 'cp-cluster' : undefined;
  map.addLayer({ id: 'dest-mask', type: 'fill', source: 'dest-area', filter: ['==', ['get', 'k'], 'mask'], paint: { 'fill-color': dark() ? '#05090d' : '#ffffff', 'fill-opacity': dark() ? 0.6 : 0.62 } }, before);
  map.addLayer({ id: 'dest-ring', type: 'line', source: 'dest-area', filter: ['==', ['get', 'k'], 'ring'], paint: { 'line-color': c.accent, 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': 0.9 } }, before);
  map.addLayer({ id: 'opt-kerb', type: 'line', source: 'kerbs', filter: ['in', ['get', 'id'], ['literal', []]], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.fg, 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 1.2, 18, 2.5], 'line-gap-width': ['interpolate', ['linear'], ['zoom'], 13, 2.5, 16, 5, 18, 9], 'line-opacity': 0.85 } }, before);
  map.addLayer({ id: 'opt-badge', type: 'symbol', source: 'opts', layout: { 'icon-image': ['concat', 'pill-', ['get', 'tone']], 'icon-text-fit': 'both', 'icon-text-fit-padding': [1, 6, 1, 6], 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-padding': 2, 'symbol-sort-key': ['get', 'r'], 'text-offset': [0, 1.2] }, paint: { 'text-color': ['match', ['get', 'tone'], 'free', '#0f7a43', '#0f2230'] } }, before);
  drawDest(lastOpts);
}
let lastOpts = null;
function drawDest(o) {
  lastOpts = o;
  const area = map.getSource('dest-area'), opts = map.getSource('opts');
  if (!area || !map.getLayer('opt-kerb')) return;
  if (!S.dest || !o) { area.setData(EMPTY); opts.setData(EMPTY); map.setFilter('opt-kerb', ['in', ['get', 'id'], ['literal', []]]); return; }
  const ring = circle(S.dest.at, destRadius());
  area.setData({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { k: 'mask' }, geometry: { type: 'Polygon', coordinates: [[[149.5, -35], [153, -35], [153, -32.5], [149.5, -32.5], [149.5, -35]], ring.slice().reverse()] } },
    { type: 'Feature', properties: { k: 'ring' }, geometry: { type: 'LineString', coordinates: ring } }] });
  const top = [...o.free.slice(0, 5), ...o.paid.filter((x) => !x.c.unknownRate).slice(0, 3), ...(o.free.length ? [] : o.likely.slice(0, 3))];
  map.setFilter('opt-kerb', ['in', ['get', 'id'], ['literal', top.map((x) => x.p.id)]]);
  opts.setData({ type: 'FeatureCollection', features: top.map((x, r) => ({ type: 'Feature', properties: { r, tone: x.c.cost > 0 ? 'price' : 'free', label: `${x.c.likely ? 'Probably free' : x.c.cost > 0 ? money(x.c.cost) : 'Free'} · ${Math.max(1, Math.round(x.d / WALK_M_PER_MIN))} min` }, geometry: { type: 'Point', coordinates: mids.get(x.p.id) } })) });
}
// Zoom out just enough to see the whole walk, clear of the search bar and the panel.
function fitDest() {
  if (!S.dest) return;
  const ring = circle(S.dest.at, destRadius(), 24), xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  const desk = isDesk(), side = desk ? Math.round(panel.getBoundingClientRect().right) + 24 : 24;
  map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: { top: 90, bottom: desk ? 40 : px('--vis') + 24, left: side, right: 24 }, duration: 900, maxZoom: 17 });
}
// Park&Ride: free with a public transport trip. occ[day][hour] is how full it usually is (% from the past week).
function occAt(cp, day, h) {
  const row = cp.occ && cp.occ[day];
  if (!row) return null;
  const H = Math.floor(h) % 24;
  for (const k of [0, -1, 1, -2, 2]) { const v = row[(H + k + 24) % 24]; if (v != null) return v; }
  return null;
}
const spacesLeft = (cp, pct) => Math.max(0, Math.round(cp.spots * (1 - pct / 100)));
function prPin(cp) {
  const v = occAt(cp, S.day, S.hour);
  if (v == null) return 'Free';
  return v >= 95 ? 'Free · usually full' : `Free · ~${spacesLeft(cp, v)} left`;
}
function prFullBy(cp, day) {
  const row = cp.occ && cp.occ[day];
  if (!row) return null;
  const h = row.findIndex((v, i) => i >= 4 && v != null && v >= 95);
  return h < 0 ? null : h;
}
function occHTML(cp) {
  const row = (cp.occ && cp.occ[S.day]) || [];
  const now = Math.floor(S.hour);
  const bars = [];
  for (let h = 5; h <= 23; h++) {
    const v = occAt(cp, S.day, h);
    const lv = v == null ? '' : v >= 95 ? 'hard' : v >= 70 ? 'moderate' : 'easy';
    bars.push(`<span class="ob ${lv}${h === now ? ' cur' : ''}" style="height:${v == null ? 4 : Math.max(4, v)}%" title="${fmtTime(h)}: ${v == null ? 'no data' : v + '% full'}"></span>`);
  }
  return `<div class="occ">${bars.join('')}</div><div class="occ-axis"><span style="grid-column:2">6am</span><span style="grid-column:8">noon</span><span style="grid-column:14">6pm</span><span style="grid-column:19">11pm</span></div>`;
}

// Car park prices come from data/carparks.json, checked by hand against each owner's own website.
// cp.rates lists every published option; the cheapest one that fits the arrival time and stay wins.
const MONTH = +new Intl.DateTimeFormat('en-AU', { timeZone: CITY.tz, month: 'numeric' }).format(new Date());
function rateQuote(r, day, h, stay) {
  if (!r.days || !r.days.includes(day)) return null;
  if (r.months && !r.months.includes(MONTH)) return null;
  if (r.maxStay && r.kind !== 'free' && stay > r.maxStay + 1e-9) return null;
  const end = h + stay;
  const inWin = (from = 0, to = 24) => h >= from - 1e-9 && h < to;
  if (r.kind === 'free') return inWin(r.from, r.to) && (!r.maxStay || stay <= r.maxStay + 1e-9) ? { k: r.maxStay ? `Free up to ${r.maxStay} hr${r.maxStay > 1 ? 's' : ''}` : 'Free', p: 0 } : null;
  if (r.kind === 'casual') {
    if (!inWin(r.from, r.to)) return null;
    const b = (r.bands || []).find((x) => x[0] >= stay - 1e-9);
    return b ? { k: 'Casual rate', p: b[1] } : null;
  }
  if (r.kind === 'hourly') {
    if (!inWin(r.from, r.to)) return null;
    const per = r.per || 1, billable = Math.max(0, stay - (r.freeFirst || 0));
    const p = Math.min(r.dailyMax ?? Infinity, Math.ceil(billable / per - 1e-9) * r.perHour * per);
    return { k: p === 0 && r.freeFirst ? `First ${r.freeFirst} hr${r.freeFirst > 1 ? 's' : ''} free` : 'Casual rate', p };
  }
  if (r.kind === 'flat') {
    const [e0, e1] = r.enter || [0, 24];
    if (h < e0 - 1e-9 || h > e1 + 1e-9) return null;
    if (r.exitAfter != null && end < r.exitAfter - 1e-9) return null;
    if (r.exitBy != null && end > (r.exitBy >= e0 ? r.exitBy : 24 + r.exitBy) + 1e-9) return null;
    return { k: r.label || 'Flat rate', p: r.price };
  }
  return null;
}
function carParkPrice(cp, day = S.day, h = S.hour, stay = S.stay) {
  if (!cp.rates || !cp.rates.length) return null;
  const qs = cp.rates.map((r) => rateQuote(r, day, h, stay)).filter(Boolean);
  if (qs.length) { const q = qs.reduce((a, x) => (x.p < a.p ? x : a)); return cp.maxRates && q.p > 0 ? { ...q, k: `${q.k}, at most` } : q; }
  // Nothing fits: is it the length of stay, or the time of day?
  const short = cp.rates.some((r) => rateQuote({ ...r, maxStay: undefined }, day, h, 0.25));
  return { none: true, why: short ? 'long' : 'time' };
}
const hm = (h) => fmtTime(h % 24);
// Kerb's own estimate for car parks whose rates we can't publish: the spread of what car parks nearby that do
// publish their rates (councils, venues) charge for the same arrival time and stay. Never shown as a real price.
const NRMA_DAY = 'about $77 to $81 a day (NRMA, 2025)';
// Street meter rates near a point: the council's own $/hr, used to tell a CBD-core car park from a fringe one.
let meterGrid = null;
function meterRateNear(pt) {
  if (!meterGrid) {
    meterGrid = new Map();
    for (const f of KERBS?.features || []) {
      const rs = RULES[f.properties.k];
      const rate = rs ? Math.max(0, ...rs.rules.map((r) => r[4] || 0)) : 0;
      if (!(rate > 0)) continue;
      const c = f.geometry.coordinates[Math.floor(f.geometry.coordinates.length / 2)];
      const key = `${Math.floor(c[0] / 0.004)}:${Math.floor(c[1] / 0.004)}`;
      if (!meterGrid.has(key)) meterGrid.set(key, []);
      meterGrid.get(key).push([c, rate]);
    }
  }
  const cx = Math.floor(pt[0] / 0.004), cy = Math.floor(pt[1] / 0.004);
  let sw = 0, sr = 0;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const [c, rate] of meterGrid.get(`${cx + i}:${cy + j}`) || []) {
    const d = distM(c, pt);
    if (d > 400) continue;
    const w = 1 / (d + 60); sw += w; sr += w * rate;
  }
  return sw ? sr / sw : null;
}
// Kerb's own estimate for a car park whose owner doesn't let us publish rates. It blends what the nearest
// car parks with published rates charge for the same stay (closer ones count more), scaled by how the
// council's street meter rates here compare with the meters around each of those car parks.
function estimateFor(cp) {
  if (cp.kind === 'parkride' || cp.rates?.length) return null;
  const near = CARPARKS.filter((c) => c.estBasis && c.rates?.length && c !== cp).map((c) => ({ c, d: distM(c.at, cp.at), q: carParkPrice(c) }))
    .filter((x) => x.d < 3000 && x.q && !x.q.none && x.q.p > 0).sort((a, b) => a.d - b.d).slice(0, 6);
  if (near.length < 2) return null;
  const here = meterRateNear(cp.at);
  let sw = 0, sp = 0;
  const vals = near.map((x) => {
    const there = here && meterRateNear(x.c.at);
    const k = here && there ? Math.min(1.5, Math.max(0.65, here / there)) : 1;
    const v = x.q.p * k, w = 1 / (x.d + 250) ** 2;
    sw += w; sp += w * v;
    return v;
  }).sort((a, b) => a - b);
  const mid = sp / sw;
  return { low: Math.floor(vals[0]), high: Math.ceil(vals[vals.length - 1]), mid: Math.round(mid), from: near.slice(0, 4).map((x) => x.c.name), meter: here };
}
function rateLines(cp) {
  const MN = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const season = (r) => (r.months ? ` (${MN[r.months[0]]}-${MN[r.months[r.months.length - 1]]})` : '');
  return cp.rates.map((r) => {
    const days = fmtDays(r.days) + season(r) + (r.maxStay && r.kind !== 'free' ? `, up to ${r.maxStay} hrs` : '');
    const win = r.from || (r.to != null && r.to < 24) ? `, arrive ${hm(r.from || 0)}-${hm(r.to ?? 24)}` : '';
    if (r.kind === 'free') return [`Free${r.maxStay ? ` up to ${r.maxStay} hr${r.maxStay > 1 ? 's' : ''}` : ''}`, days + win];
    if (r.kind === 'casual') return ['Casual', days + win, r.bands.map((b) => `<span>${b[0] < 1 ? `${b[0] * 60} min` : `${b[0]} hr${b[0] > 1 ? 's' : ''}`}</span><b>${money(b[1])}</b>`).join('')];
    if (r.kind === 'hourly') return [r.freeFirst ? `First ${r.freeFirst} hr${r.freeFirst > 1 ? 's' : ''} free, then ${money(r.perHour)}/hr` : `${money(r.perHour)} an hour`, `${days}${win}${r.dailyMax != null ? `, max ${money(r.dailyMax)} a day` : ''}`];
    return [`${r.label || 'Flat rate'} ${money(r.price)}`, `${days}, in ${hm(r.enter[0])}-${hm(r.enter[1])}${r.exitAfter != null ? `, out after ${hm(r.exitAfter)}` : ''}${r.exitBy != null ? `, out by ${hm(r.exitBy)}${r.exitBy < r.enter[0] ? ' next day' : ''}` : ''}`];
  });
}
// You picked a stay longer than this car park allows: show the longest stay you can have and what it costs.
function maxStayHTML(cp, price, stayTxt) {
  if (price.why === 'long') {
    for (let s = Math.min(S.stay, 24) - 0.25; s >= 0.25; s -= 0.25) {
      const q = carParkPrice(cp, S.day, S.hour, s);
      if (q && !q.none) return `<div class="verdict"><div><small>You picked ${stayTxt}. The longest stay here from ${fmtTime(S.hour)} is ${stayWordsFor(s)}</small>${stayWordsFor(s)} max</div><span class="big" style="color:var(--${q.p === 0 ? 'free' : 'fg'})">${money(q.p)}</span></div>`;
    }
  }
  return `<div class="verdict"><div><small>${stayTxt} from ${DAYS[S.day]} ${fmtTime(S.hour)}</small>${price.why === 'long' ? 'Not for that long' : 'No rate at this time'}</div></div>`;
}
const stayWordsFor = (h) => (h < 1 ? `${Math.round(h * 60)} min` : `${+h.toFixed(2)} hr${h === 1 ? '' : 's'}`);
function rateBoard(cp) {
  return `<div class="rateboard">${rateLines(cp).map(([t, sub, bands]) => `<div class="rl"><div class="rt">${t}</div><div class="rs">${sub}</div>${bands ? `<div class="rb">${bands}</div>` : ''}</div>`).join('')}</div>`;
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
  S.night = b.dataset.v === 'night';
  S.stay = S.night ? nightStay(S.hour) : +b.dataset.v;
  try { localStorage.setItem('kerb-stay', S.night ? 'night' : String(S.stay)); } catch { /* ignore */ }
  update();
}));
const timeIn = $('#time');
timeIn.addEventListener('input', () => { S.hour = +timeIn.value; if (S.night) S.stay = nightStay(S.hour); update(true); });
timeIn.addEventListener('change', () => update());

function syncControls() {
  daySeg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.v === S.day)));
  $('#staySeg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(S.night ? b.dataset.v === 'night' : +b.dataset.v === S.stay)));
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
  // Weighted by kerb length, so short no-stopping corners don't outweigh whole blocks of parking.
  const inView = visibleKerbs().filter((f) => f.properties.k >= 0);
  if (!inView.length) return;
  const len = new Map(inView.map((f) => { const c = f.geometry.coordinates; let m = 0; for (let i = 1; i < c.length; i++) m += distM(c[i - 1], c[i]); return [f, Math.max(1, m)]; }));
  const total = [...len.values()].reduce((a, b) => a + b, 0);
  for (let q = 0; q < 96; q++) {
    const n = { free: 0, meter: 0, restricted: 0, unknown: 0 };
    for (const f of inView) { const kd = stateAt(f.properties, RULES, S.day, q / 4).kind; n[kd === 'limit' ? 'free' : kd] += len.get(f); }
    let y = r.height;
    for (const k of ['free', 'meter', 'restricted']) {
      const h = (n[k] / total) * r.height;
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
const spanText = (t) => `${S.night ? 'Overnight' : t}, ${DAYS[S.day]} ${fmtTime(S.hour)} to ${fmtTime((S.hour + S.stay) % 24)}${S.hour + S.stay >= 24 ? ` ${DAYS[(S.day + 1) % 7]}` : ''}`;
const meterLine = (o) => (o.c.unknownRate ? `Nearest meter: <strong>${o.p.s}</strong> (the council doesn't publish its rate).` : `Cheapest meter: <strong>${o.p.s}</strong> at ${costText(o.c)}.`);
function stayWords(long) {
  if (S.night) return long ? 'the night (until 8am)' : 'Overnight to 8am';
  if (long) return S.stay === 0.25 ? '15 minutes' : S.stay === 1 ? 'an hour' : `${S.stay} hours`;
  return S.stay === 0.25 ? '15 min' : `${S.stay} hr${S.stay > 1 ? 's' : ''}`;
}
function walkText(m) { if (m > 2500) return `${(m / 1000).toFixed(m > 20000 ? 0 : 1)} km away`; const min = Math.max(1, Math.round(m / WALK_M_PER_MIN)); return `${min} min walk`; }

const FOOT = {
  mel: 'Rules come from the City of Melbourne\'s open data: its parking zones and sign plates, Pay Stay meter rates, and the in-ground bay sensors, which show live which bays are free.',
  bne: 'Rules come from Brisbane City Council\'s open data: every parking meter with its hours, time limit and rates, painted kerb markings and clearways.',
  per: 'Rules come from the City of Perth\'s open data: the restriction on every on-street parking bay, and the City of Perth Parking car parks.',
};
const COVER = {
  mel: 'In Melbourne, Kerb covers the City of Melbourne\'s on-street parking (CBD, Southbank, Docklands, Carlton, North Melbourne, East Melbourne) from the council\'s parking zones, meter rates and live bay sensors, plus streets volunteers have mapped in OpenStreetMap around St Kilda, Chapel Street, Fitzroy, Collingwood, Richmond and Brunswick.',
  bne: 'In Brisbane, Kerb covers every Brisbane City Council parking meter (CBD, Spring Hill, Fortitude Valley, South Brisbane, West End, Woolloongabba, Newstead, Milton…) plus no stopping lines, bus and taxi zones and clearways in the inner suburbs.',
  per: 'In Perth, Kerb covers every City of Perth on-street parking bay (CBD, Northbridge, East Perth, West Perth, Crawley) and the City of Perth car parks.',
};
function renderList() {
  const keepScroll = body.dataset.mode === 'list' ? body.scrollTop : 0;
  body.dataset.mode = 'list';
  requestAnimationFrame(() => { if (body.dataset.mode === 'list') body.scrollTop = Math.min(keepScroll, body.scrollHeight); });
  body.replaceChildren();
  if (!KERBS) { body.innerHTML = `<div class="empty"><strong>Loading the kerbs…</strong>Pulling in the kerbs for ${CITY.name}.</div>`; return; }
  const centre = S.dest ? S.dest.at : map.getCenter().toArray();
  const nearM = S.dest ? S.walk * WALK_M_PER_MIN : NEAR_M;
  destBar();
  sessionCard();
  const inCoverage = KERBS.features.some((f) => { const m = mids.get(f.properties.id); return Math.abs(m[0] - centre[0]) < 0.015 && Math.abs(m[1] - centre[1]) < 0.012; });
  if (!inCoverage) {
    drawDest(S.dest ? { free: [], paid: [], likely: [] } : null);
    body.insertAdjacentHTML('beforeend', CITY_ID !== 'syd' ? `<div class="empty"><strong>Not covered yet</strong>${COVER[CITY_ID]}</div>` : `<div class="empty"><strong>Not covered yet</strong>Kerb covers the City of Sydney (CBD out to Newtown, Glebe, Surry Hills and Potts Point), the Eastern Suburbs (Bondi, Bronte, Bondi Junction, Rose Bay, Double Bay, Paddington, Coogee, Randwick, Maroubra), Manly, Chatswood, and the Inner West's meters in Balmain, Rozelle and Leichhardt. More councils are on the way. Transport for NSW Park&Ride car parks show across Sydney.</div>`);
    carParkRows();
    return;
  }
  // Best kerb per street near the centre of the map.
  const best = new Map();
  for (const f of KERBS.features) {
    const p = f.properties;
    if (p.k < 0 && !p.lk && !p.pa) continue;
    const d = distM(mids.get(p.id), centre);
    if (d > nearM) continue;
    const c = p.k < 0 ? (p.lk ? { ok: true, cost: 0, likely: true } : { ok: true, cost: 0, permitOnly: true }) : costFor(p, RULES, S.day, S.hour, S.stay);
    if (c.ok === null) continue; // only partly known (a clearway road): not a parking option
    const key = `${p.s}|${p.b}|${p.sd || ''}`;
    const score = (c.ok ? 0 : 1e6) + (c.ok ? c.cost * 40 : 0) + (c.unknownRate ? 400 : 0) + (c.likely ? 250 : 0) + (c.permitOnly ? 350 : 0) + d;
    const cur = best.get(key);
    if (!cur || score < cur.score) best.set(key, { f, p, c, d, score });
  }
  const opts = [...best.values()].sort((a, b) => a.score - b.score);
  const free = opts.filter((o) => o.c.ok && o.c.cost === 0 && !o.c.likely && !o.c.unknownRate && !o.c.permitOnly);
  const permits = opts.filter((o) => o.c.permitOnly);
  const likely = opts.filter((o) => o.c.likely);
  const paid = opts.filter((o) => o.c.ok && (o.c.cost > 0 || o.c.unknownRate));
  const no = opts.filter((o) => !o.c.ok);

  const sum = document.createElement('div');
  sum.className = 'summary';
  const stayTxt = stayWords(true);
  if (free[0]) sum.innerHTML = `Free for ${stayTxt}: <strong>${free[0].p.s}</strong>, ${walkText(free[0].d)} ${S.dest ? `from ${S.dest.name}` : 'from the middle of the map'}.${paid[0] ? ` ${meterLine(paid[0])}` : ''}`;
  else if (paid[0]) sum.innerHTML = `No free kerbs nearby for ${stayTxt}. ${meterLine(paid[0])}`;
  else if (likely[0]) sum.innerHTML = `Probably free: <strong>${likely[0].p.s}</strong>, ${walkText(likely[0].d)} away. The council doesn't publish its signs here, so check before you park.`;
  else if (permits[0]) sum.innerHTML = `The council doesn't publish the signs ${S.dest ? `near ${S.dest.name}` : 'here'}. The kerbs nearby are resident permit areas, where visitors are usually limited to 1 or 2 hours, so check the sign.`;
  else sum.innerHTML = S.dest ? `No kerb data within a ${S.walk}-minute walk of ${S.dest.name}. Try a longer walk.` : `No kerb data near the middle of the map. Move the map to a street with coloured kerbs.`;
  body.appendChild(sum);
  compareLine(free, paid, centre, nearM);
  drawDest(S.dest ? { free, paid, likely } : null);

  const group = (title, list, limit = 12) => {
    if (!list.length) return;
    const h = document.createElement('div'); h.className = 'group'; h.innerHTML = `<span>${title}</span><span class="num">${list.length}</span>`; body.appendChild(h);
    list.slice(0, limit).forEach((o) => body.appendChild(optRow(o)));
  };
  savedRows(centre);
  group('Free for your stay', free);
  group('Meters', paid);
  group('Probably free', likely, 8);
  group('Permit areas: check the sign', permits, 8);
  group(`Can't stay ${stayTxt}`, no, 6);
  carParkRows();
  const foot = document.createElement('div'); foot.className = 'foot';
  const upd = META ? new Date(META.fetchedAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: CITY.tz }) : '';
  foot.innerHTML = CITY_ID !== 'syd' ? `${FOOT[CITY_ID]}${upd ? ` Refreshed nightly, last on ${upd}.` : ''} Councils don't publish every sign, so always read the sign before you park.` : `Rules come from council open data: the City of Sydney's ${META ? META.meters.toLocaleString() : ''} parking meters, Waverley's kerb-by-kerb parking survey, Woollahra's resident permit areas, Randwick's resident permit kerbs, Randwick's and Inner West's published parking maps and meter lists, and street sign surveys for Manly (2020) and Chatswood, refreshed nightly${upd ? `, last on ${upd}` : ''}. Councils don't publish every sign, so always read the sign before you park.`;
  body.appendChild(foot);
}

// What signs in this permit area usually say, from the council's decisions (never shown as the rule).
const usual = (p) => (p.pa && META?.permitPatterns ? META.permitPatterns[String(p.pa).replace(/^(permit\s*)?area\s*/i, '').trim().toUpperCase()] : null);
function usualHTML(p) {
  const u = usual(p);
  return u ? `<div class="verdict est"><div><small>Usually, in ${p.pa}</small>${u.sign}, permit holders excepted</div></div><p class="plain">${u.n} of the council's ${u.of} recent sign decisions in ${p.pa} say this, so it's the likely sign here. Kerb hasn't seen this kerb's own sign, so check before you leave the car.</p>` : '';
}
function optRow(o) {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'opt' + (o.c.ok ? '' : ' no');
  const cat = category(o.p, RULES, S.day, S.hour, S.stay);
  const s = stateAt(o.p, RULES, S.day, S.hour);
  const sub = o.c.ok
    ? (o.c.permitOnly ? (usual(o.p) ? `Permit ${o.p.pa}: usually ${usual(o.p).sign} for visitors` : `Resident permit ${o.p.pa}. Visitors usually time-limited`) : o.c.likely ? 'No permit scheme, check the sign' : s.kind === 'meter' ? `${pLabel(s.rule[0])} meter until ${fmtTime(s.rule[3])}` : s.kind === 'limit' ? `Free ${pLabel(s.rule[0])} until ${fmtTime(s.rule[3])}` : s.why === 'unrestricted' ? 'No time limit' : s.until < 24 ? `Free until ${fmtTime(s.until)}` : 'Free for the rest of the day')
    : o.c.why;
  const lv = busyLevel(busy(o.p, RULES, S.day, S.hour));
  b.innerHTML = `<span class="bar" style="background:var(--${cat === 'short' ? 'paid' : cat})"></span>
    <span style="min-width:0"><div class="name">${o.p.s}</div><div class="sub">${[o.p.sd, o.p.b].filter(Boolean).join(', ')}${o.p.sd || o.p.b ? '. ' : ''}${sub}</div></span>
    <span class="right">${o.c.permitOnly ? '<span class="price">?</span>' : o.c.ok ? `<span class="price ${o.c.cost === 0 && !o.c.unknownRate ? 'free' : ''}">${costText(o.c)}</span>` : ''}<span class="walk">${walkText(o.d)}${liveCount(o.p) ? `, <b class="livetag">${liveCount(o.p).free} free now</b>` : o.c.ok ? `, ${BUSY_WORD[lv].toLowerCase()}` : ''}</span></span>`;
  b.onclick = () => select(o.p.id, true);
  return b;
}

function carParkRows() {
  if (!CARPARKS.length || S.hidden.has('carpark')) return;
  const centre = S.dest ? S.dest.at : map.getCenter().toArray();
  const radius = S.dest ? Math.max(400, S.walk * WALK_M_PER_MIN) : 1500;
  const near = CARPARKS.map((cp) => ({ cp, d: distM(cp.at, centre) })).filter((x) => x.d < radius).sort((a, b) => a.d - b.d);
  if (!near.length) return;
  const h = document.createElement('div'); h.className = 'group'; h.innerHTML = `<span>Car parks</span><span class="num">${near.length}</span>`; body.appendChild(h);
  for (const { cp, d } of near) body.appendChild(cpRow(cp, d));
}
function cpRow(cp, d) {
  const price = carParkPrice(cp);
  const b = document.createElement('button'); b.type = 'button'; b.className = 'opt';
  const pr = cp.kind === 'parkride', v = pr ? occAt(cp, S.day, S.hour) : null;
  const est = !price && !pr ? estimateFor(cp) : null;
  const sub = pr ? `Free with an Opal trip${v == null ? '' : v >= 95 ? ', usually full now' : `, usually ~${spacesLeft(cp, v)} spaces left`}` : price?.none ? (price.why === 'long' ? 'Price for this stay not published' : 'No rate for this time') : price ? price.k : est ? `Kerb's estimate ${money(est.low)}-${money(est.high)}, not their real rates${cp.operator ? `. Run by ${cp.operator}` : ''}` : `Run by ${cp.operator}. Rates not published`;
  b.innerHTML = `<span class="bar" style="background:var(--fg)"></span><span style="min-width:0"><div class="name">${cp.name}</div><div class="sub">${sub}</div></span><span class="right">${pr ? `<span class="price free">Free</span>` : price && !price.none ? `<span class="price${price.p === 0 ? ' free' : ''}">${money(price.p)}</span>` : est ? `<span class="price est">~${money(est.mid)}</span>` : ''}<span class="walk">${est ? 'estimate · ' : ''}${walkText(d)}</span></span>`;
  b.onclick = () => select(cp.id, true);
  return b;
}

/* ---------- saved places (kept on this phone only) ---------- */
// Kerb ids change when the data is rebuilt, so a saved kerb is found again by street, side and position.
const savedKey = (id) => (typeof id === 'number' ? (() => { const p = byId.get(id).properties, m = mids.get(id); return `k|${p.s}|${p.sd || ''}|${m[0].toFixed(4)},${m[1].toFixed(4)}`; })() : `c|${id}`);
function resolveSaved(it) {
  if (it.key.startsWith('c|')) { const cp = CARPARKS.find((c) => c.id === it.key.slice(2)); return cp ? { cp } : null; }
  const [, st, sd] = it.key.split('|');
  let best = null, bd = 40;
  for (const f of KERBS.features) {
    if (f.properties.s !== st || (f.properties.sd || '') !== sd) continue;
    const d = distM(mids.get(f.properties.id), it.at);
    if (d < bd) { bd = d; best = f; }
  }
  return best ? { f: best } : null;
}
const getSaved = () => store.get('kerb-saved', []);
const isSaved = (id) => getSaved().some((x) => x.key === savedKey(id));
function toggleSaved(id) {
  const key = savedKey(id);
  let list = getSaved();
  if (list.some((x) => x.key === key)) { list = list.filter((x) => x.key !== key); toast('Removed from saved'); }
  else {
    const at = typeof id === 'number' ? mids.get(id) : CARPARKS.find((c) => c.id === id).at;
    list.unshift({ key, at }); list = list.slice(0, 30); toast('Saved. It shows at the top of the list.');
  }
  store.set('kerb-saved', list);
}
function savedRows(centre) {
  const list = getSaved().map((it) => ({ it, r: resolveSaved(it) })).filter((x) => x.r);
  if (!list.length) return;
  const h = document.createElement('div'); h.className = 'group'; h.innerHTML = `<span><i class="ph-fill ph-star" aria-hidden="true"></i> Saved</span><span class="num">${list.length}</span>`; body.appendChild(h);
  for (const { r } of list) {
    if (r.cp) { body.appendChild(cpRow(r.cp, distM(r.cp.at, centre))); continue; }
    const p = r.f.properties;
    const c = p.k < 0 ? (p.lk ? { ok: true, cost: 0, likely: true } : { ok: null }) : costFor(p, RULES, S.day, S.hour, S.stay);
    body.appendChild(optRow({ f: r.f, p, c: c.ok === null ? { ok: false, why: 'No published rules' } : c, d: distM(mids.get(p.id), centre) }));
  }
}

/* ---------- destination: rank parking from where you're going ---------- */
let destMarker = null;
function setDest(d) {
  S.dest = d;
  destMarker?.remove(); destMarker = null;
  if (d) {
    const el = document.createElement('div'); el.className = 'dest-pin'; el.innerHTML = '<svg viewBox="0 0 28 40" width="28" height="40" aria-hidden="true"><path d="M14 0C6.3 0 0 6.1 0 13.7 0 23.9 14 40 14 40s14-16.1 14-26.3C28 6.1 21.7 0 14 0z" fill="#ea4335" stroke="#b31412" stroke-width="1"/><circle cx="14" cy="13.5" r="5.2" fill="#7a0d0b"/></svg>';
    destMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(d.at).addTo(map);
    if (sheet === 'open') setSheet('peek');
    requestAnimationFrame(fitDest);
  } else q.value = '';
  update();
}
function destBar() {
  if (!S.dest) return;
  const el = document.createElement('div'); el.className = 'dest';
  el.innerHTML = `<div class="dest-top"><i class="ph-fill ph-map-pin" aria-hidden="true" style="color:#ea4335"></i><span>Near ${S.dest.name}</span><button type="button" aria-label="Clear destination"><i class="ph ph-x"></i></button></div>
    <div class="walkseg" role="group" aria-label="Longest walk">Walk up to ${[2, 5, 10, 15, 20].map((w) => `<button type="button" data-w="${w}" aria-pressed="${w === S.walk}">${w} min</button>`).join('')}</div>`;
  el.querySelector('.dest-top button').onclick = () => setDest(null);
  el.querySelectorAll('[data-w]').forEach((b) => (b.onclick = () => { S.walk = +b.dataset.w; try { localStorage.setItem('kerb-walk', String(S.walk)); } catch { /* ignore */ } renderList(); drawCarParks(); fitDest(); }));
  body.appendChild(el);
}
// Street parking against the cheapest car park nearby, for the whole stay.
function compareLine(free, paid, centre, nearM) {
  const cps = CARPARKS.map((cp) => ({ cp, d: distM(cp.at, centre), pr: carParkPrice(cp) }))
    .filter((x) => x.d < Math.max(400, nearM) && x.pr && !x.pr.none).sort((a, b) => a.pr.p - b.pr.p || a.d - b.d);
  const cp = cps[0];
  if (!cp) return;
  const kerb = free[0] ? { name: free[0].p.s, cost: 0 } : paid.find((o) => !o.c.unknownRate) ? { name: paid.find((o) => !o.c.unknownRate).p.s, cost: paid.find((o) => !o.c.unknownRate).c.cost } : null;
  const el = document.createElement('p'); el.className = 'compare';
  if (!kerb) el.innerHTML = `Cheapest car park: <strong>${cp.cp.name}</strong>, ${money(cp.pr.p)} for ${stayWords(true)}.`;
  else if (cp.pr.p > kerb.cost) el.innerHTML = `The street saves you <strong>${money(cp.pr.p - kerb.cost)}</strong> on the cheapest car park (${cp.cp.name}, ${money(cp.pr.p)}).`;
  else if (cp.pr.p < kerb.cost) el.innerHTML = `<strong>${cp.cp.name}</strong> is cheaper than the street: ${money(cp.pr.p)}, saving ${money(kerb.cost - cp.pr.p)}.`;
  else el.innerHTML = `<strong>${cp.cp.name}</strong> is also ${money(cp.pr.p)} for ${stayWords(true)}.`;
  body.appendChild(el);
}

/* ---------- I parked here: where the car is, and when to move it ---------- */
// Uses the real clock, not the time picker. How long you can legally stay is worked out from the kerb's rules.
function parkedNow(f) {
  const now = sydneyNow(), p = f.properties;
  let legal = null;
  if (p.k >= 0) {
    legal = 0;
    for (let st = 0.25; st <= 24; st += 0.25) { if (costFor(p, RULES, now.day, now.hour, st).ok) legal = st; else break; }
    if (legal === 0) { toast("You can't park here right now. Check the sign."); return; }
  }
  const hours = legal == null ? S.stay : legal;
  const sess = { at: mids.get(p.id), name: p.s, side: p.sd || '', start: Date.now(), until: Date.now() + hours * 3600e3, legal: legal != null && legal < 24, planned: legal == null };
  store.set('kerb-parked', sess);
  setSessionMarker(); toast(legal != null && legal < 24 ? `Saved. Move by ${clockAt(sess.until)}.` : 'Saved where you parked.');
  S.sel = null; update();
}
const clockAt = (ms) => new Date(ms).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', timeZone: CITY.tz }).replace(' ', '').toLowerCase();
const dayAt = (ms) => new Date(ms).toLocaleDateString('en-AU', { weekday: 'short', timeZone: CITY.tz });
let carMarker = null;
function setSessionMarker() {
  carMarker?.remove(); carMarker = null;
  const s = store.get('kerb-parked', null);
  if (!s) return;
  const el = document.createElement('div'); el.className = 'car-pin'; el.innerHTML = '<i class="ph-fill ph-car-simple"></i>'; el.title = 'Your car';
  carMarker = new maplibregl.Marker({ element: el }).setLngLat(s.at).addTo(map);
}
function icsFor(s) {
  const z = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const txt = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Kerb//Sydney parking//EN', 'BEGIN:VEVENT', `UID:kerb-${s.start}@kerb`, `DTSTAMP:${z(Date.now())}`,
    `DTSTART:${z(s.until - 10 * 60e3)}`, `DTEND:${z(s.until)}`, `SUMMARY:Move the car (${s.name})`,
    `DESCRIPTION:${s.legal ? `Parking on ${s.name} ends at ${clockAt(s.until)}.` : `Your planned stay on ${s.name} ends at ${clockAt(s.until)}. Check the sign for the real limit.`}`,
    `GEO:${s.at[1]};${s.at[0]}`, 'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Move the car', 'TRIGGER:-PT5M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  return URL.createObjectURL(new Blob([txt], { type: 'text/calendar' }));
}
function sessionCard() {
  const s = store.get('kerb-parked', null);
  if (!s) return;
  const left = s.until - Date.now();
  const mins = Math.round(left / 60e3);
  const leftTxt = left <= 0 ? 'Time is up' : mins >= 60 ? `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m left` : `${mins} min left`;
  const el = document.createElement('div'); el.className = 'session';
  const sameDay = dayAt(s.until) === dayAt(Date.now());
  el.innerHTML = `<div class="st"><span><small class="note">Your car</small><br><b>${s.name}</b>${s.side ? `<span class="note">, ${s.side.toLowerCase()}</span>` : ''}</span><span class="left${left < 15 * 60e3 ? ' urgent' : ''}">${leftTxt}</span></div>
    <div class="note">${s.legal ? `Move by ${clockAt(s.until)}${sameDay ? '' : ` ${dayAt(s.until)}`}, when the sign's limit or a restriction starts.` : s.planned ? `Your planned stay ends at ${clockAt(s.until)}. Kerb doesn't have the signs here, so check the sign.` : 'No limit for the rest of the day.'}</div>
    <div class="acts">
      <a class="cta" href="https://www.google.com/maps/dir/?api=1&destination=${s.at[1]},${s.at[0]}&travelmode=walking" target="_blank" rel="noopener"><i class="ph ph-person-simple-walk"></i>Walk back</a>
      ${s.legal || s.planned ? `<a class="cta" href="${icsFor(s)}" download="kerb-move-the-car.ics"><i class="ph ph-bell-ringing"></i>Remind me</a>` : ''}
      <button class="cta" type="button" data-act="done"><i class="ph ph-check"></i>I've left</button>
    </div>`;
  el.querySelector('[data-act=done]').onclick = () => { store.set('kerb-parked', null); setSessionMarker(); renderList(); };
  body.appendChild(el);
}
setInterval(() => { if (S.sel == null && store.get('kerb-parked', null)) renderList(); }, 60e3);

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
    : `<div class="plate"><div class="p">${pLabel(r[0])}</div>${r[4] > 0 ? '<div class="l">Ticket</div>' : r[4] < 0 ? '<div class="l">Meter</div>' : ''}<div class="l">${time}</div>${days ? `<div class="l">${days}</div>` : ''}${r[7] && !(r[4] !== 0 && r[7] === 'Ticket') ? `<div class="s">${r[7]}</div>` : ''}${r[4] > 0 ? `<div class="s">${money(r[4])}/hr</div>` : ''}</div>`;
  return `<figure class="plate-wrap${on ? '' : ' off'}">${inner}<figcaption>${on ? `In force at ${fmtTime(S.hour)}` : `Not in force at ${fmtTime(S.hour)}`}</figcaption></figure>`;
}

// Says in plain words why the stay costs what it does.
const costText = (c) => (c.unknownRate ? (c.cost > 0 ? `${money(c.cost)}+` : 'Meter') : money(c.cost));
// The prices and limits on this kerb at a glance, shown right under the answer: "$7/hr 8am-10pm Mon-Fri".
function rateStrip(set) {
  const rules = (set.rules || []).filter((r) => r[6] !== 1);
  if (!rules.length) return '';
  const seen = new Set();
  const chips = rules.map((r) => {
    const price = r[4] > 0 ? `${money(r[4])}/hr` : r[4] < 0 ? 'Meter' : 'Free';
    const lim = r[0] > 0 ? ` · ${pLabel(r[0])}` : '';
    const when = r[2] === 0 && r[3] === 24 ? 'all day' : `${fmtTime(r[2])}-${fmtTime(r[3])}`;
    return `<span class="rchip${r[4] ? ' paid' : ''}"><b>${price}</b>${lim} · ${when} ${fmtDays(r[1])}</span>`;
  }).filter((c) => !seen.has(c) && seen.add(c));
  return `<div class="ratestrip" aria-label="Rates and limits">${chips.join('')}</div>`;
}
function verdictText(p, c) {
  if (p.lk) return { head: 'Probably free', why: '' };
  if (c.ok === null) return c.partial ? { head: 'Check the sign', why: plainNow(p, RULES, S.day, S.hour) } : { head: 'No published rules', why: '' };
  if (!c.ok) return { head: "You can't stay that long", why: '' };
  if (c.quarterFree) return { head: 'Free with a ticket', why: 'The first 15 minutes are free. Grab a ticket from the meter.' };
  const end = S.hour + S.stay;
  if (c.waived > 0 && c.paidHours === 0) return { head: 'Free with your mobility permit', why: `The meter normally charges ${money(stateAt(p, RULES, S.day, S.hour).rule?.[4] || c.rate || 0)} an hour here. Mobility parking permit holders park free at council and street meters in NSW, and time limits over 30 minutes don't apply. Display the permit.` };
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
  if (c.unknownRate) return { head: c.freeHours > 0 && c.firstPaidAt > S.hour ? `Free until ${fmtTime(c.firstPaidAt)}, then pay at the meter` : 'Pay at the meter', why: `It's a metered kerb, but the council doesn't publish the rate. The meter shows it, and the Park'nPay app does too.` };
  if (c.freeHours > 0 && c.firstPaidAt > S.hour) return { head: `Free until ${fmtTime(c.firstPaidAt)}, then pay`, why: `The meter starts at ${fmtTime(c.firstPaidAt)}, so you pay for ${c.paidHours === 1 ? '1 hour' : `${c.paidHours} hours`} at ${money(c.rate)} an hour.` };
  if (c.freeHours > 0) return { head: 'Pay, then free', why: `You pay ${money(c.rate)} an hour until the meter finishes, then the rest is free.` };
  return { head: `${money(c.rate)} an hour`, why: '' };
}

function weekHTML(p) {
  const colFor = { free: 'var(--free)', limit: 'var(--limit)', meter: 'var(--paid)', restricted: 'var(--restricted)', unknown: 'var(--unknown)' };
  const rows = [1, 2, 3, 4, 5, 6, 0].map((d) => {
    const segs = dayTimeline(p, RULES, d).map((s) => `<i style="width:${((s.to - s.from) / 24) * 100}%;background:${colFor[s.kind]}" title="${DAYS[d]} ${fmtTime(s.from)}-${fmtTime(s.to)}: ${s.kind === 'meter' ? `${pLabel(s.rule[0])} meter` : s.kind === 'limit' ? `free ${pLabel(s.rule[0])}` : s.kind === 'free' ? 'free' : s.kind === 'unknown' ? 'signs not published' : 'no parking'}"></i>`).join('');
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

function estHTML(cp, e, stayTxt) {
  return `<div class="verdict est"><div><small>${spanText(stayTxt)}</small>Kerb's estimate</div><span class="big">~${money(e.mid)}</span></div>
      <p class="plain">Probably ${money(e.low)} to ${money(e.high)}. ${cp.operator ? `${cp.operator} doesn't let us publish its rates, so this` : 'This'} is an estimate from what car parks nearby charge for the same time (${e.from.join(', ')}), adjusted for how the council's street meters here compare with theirs${e.meter ? ` (about ${money(e.meter)}/hr here)` : ''}.${S.stay >= 5 || S.night ? ` For a full day, Sydney car parks average ${NRMA_DAY}.` : ''}</p>
      <p class="note">Not the real price. Busy CBD car parks often charge more, and early bird or online deals can be cheaper. The board at the entrance is what you'll pay.</p>`;
}
function prDetail(cp) {
  const v = occAt(cp, S.day, S.hour), full = prFullBy(cp, S.day);
  const now = v == null ? '' : v >= 95
    ? `Usually full at ${fmtTime(S.hour)} on ${DAYS_LONG[S.day]}s.`
    : `Usually about ${spacesLeft(cp, v)} of ${cp.spots} spaces free at ${fmtTime(S.hour)} on ${DAYS_LONG[S.day]}s.`;
  return `<div class="verdict"><div><small>Park&amp;Ride, up to 18 hours</small>Free if you catch public transport</div><span class="big">Free</span></div>
      <p class="plain">Tap on and off a train, bus, ferry or light rail trip with the same Opal or bank card, then tap out as you leave. Fees apply if you don't travel or you stay longer than 18 hours.</p>
      ${cp.occ ? `<h3 class="h3">How full it gets on ${DAYS_LONG[S.day]}s</h3>${occHTML(cp)}
      <p class="plain">${now}${full != null && (v == null || v < 95) ? ` It's usually full by ${fmtTime(full)}.` : ''}</p>
      <p class="note">From Transport for NSW's car park counters over the past week. Public holidays and school holidays will be quieter.</p>` : ''}`;
}

function renderDetail() {
  const f = typeof S.sel === 'number' ? byId.get(S.sel) : null;
  const cp = !f && CARPARKS.find((c) => c.id === S.sel);
  if (!f && !cp) { S.sel = null; renderList(); return; }
  body.replaceChildren();
  const d = document.createElement('div'); d.className = 'detail';
  const stayTxt = stayWords(false);
  if (f) {
    const p = f.properties;
    const c = p.lk ? { ok: true, cost: 0, likely: true } : costFor(p, RULES, S.day, S.hour, S.stay);
    const set = p.k >= 0 ? RULES[p.k] : null;
    const lv = busyLevel(busy(p, RULES, S.day, S.hour));
    const v = verdictText(p, c);
    d.innerHTML = `
      <button class="back" type="button"><i class="ph ph-arrow-left"></i>All options</button>
      <div><h2>${p.s}</h2><div class="where">${[p.sd, p.b, p.pa ? `Permit ${p.pa}` : '', p.n ? `about ${p.n} ${p.k >= 0 ? 'paid ' : ''}spaces` : ''].filter(Boolean).join(', ')}</div></div>
      ${liveCount(p) ? `<div class="live"><i class="ph-fill ph-broadcast" aria-hidden="true"></i><span><b>${liveText(liveCount(p))}</b><small>Live from the council's in-ground sensors, ${Math.max(1, Math.round((Date.now() - LIVE_AT) / 60000))} min ago</small></span></div>` : ''}
      <div class="verdict"><div><small>${spanText(stayTxt)}</small>${v.head}</div>
        ${p.lk ? `<span class="big" style="color:var(--free)">$0?</span>` : c.ok ? `<span class="big" style="color:var(--${c.cost === 0 && !c.unknownRate ? 'free' : 'fg'})">${costText(c)}</span>` : c.ok === false ? `<span class="no">${c.why}</span>` : ''}</div>
      ${set ? `<div class="signhero"><div class="sh-cap">The sign${set.src ? '' : 's'} here</div><div class="plates big">${set.src ? (set.u ? '<p class="plain">No signs. Unrestricted parking.</p>' : mergeOvernight(set.rules).map(rulePlate).join('')) : set.text.split(';').filter((x) => x.trim()).map(plateHTML).join('')}</div></div>` : ''}
      <p class="plain">${v.why || plainNow(p, RULES, S.day, S.hour)}${p.f15 ? ' This street is in a free 15-minute zone, so a ticket gets you the first quarter hour free.' : ''}</p>
      ${set ? `<h3 class="h3">Across the week</h3>${weekHTML(p)}
      <h3 class="h3">How hard to find a spot: ${BUSY_WORD[lv].toLowerCase()} right now</h3>${busyHTML(p)}
      <p class="note">Busyness is an estimate from the area and its time limits. It gets real once drivers start reporting.</p>
      <p class="note">Source: ${set.src ? `${set.src}${/survey|committee|map|photo|decision/i.test(set.src) ? '' : ' parking survey'}${set.text ? `. Recorded as "${set.text}"` : ''}` : `City of Sydney parking meter data`}. Councils update signs from time to time, so the sign on the street always wins.</p>
      ` : `${usualHTML(p)}<p class="note">${p.lk ? `Based on ${p.lks || 'Woollahra Council\'s resident permit areas'}: streets outside a permit scheme are usually unrestricted, but the council doesn't publish its signs.` : p.ps ? `Permit area from the ${p.ps}. The council doesn't publish the sign times, so visitors should check the sign for the time limit.` : 'Kerb only shows rules the council publishes. This side of the street has no published signs yet.'}</p>
      <button type="button" class="snapcta" id="snapHere"><i class="ph-fill ph-camera" aria-hidden="true"></i><span><b>Snap the sign here</b><small>Kerb reads it, tells you if you can park, and fills in this kerb.</small></span></button>`}
      ${streetViewHTML(p, mids.get(p.id))}
      <div class="photos" id="signPhotos" hidden></div>
      ${actionsHTML(mids.get(p.id), p.id)}`;
  } else {
    const price = carParkPrice(cp);
    d.innerHTML = `
      <button class="back" type="button"><i class="ph ph-arrow-left"></i>All options</button>
      <div><h2>${cp.name}</h2><div class="where">${[cp.address, cp.entry ? `Entry from ${cp.entry}` : '', cp.spots ? `${cp.spots} spaces` : ''].filter(Boolean).join('. ')}.</div></div>
      ${cp.kind === 'parkride' ? prDetail(cp) : price && !price.none ? `<div class="verdict"><div><small>${spanText(stayTxt)}</small>${price.k}</div><span class="big" style="color:var(--${price.p === 0 ? 'free' : 'fg'})">${money(price.p)}</span></div>`
        : price?.none ? maxStayHTML(cp, price, stayTxt)
        : estimateFor(cp) ? estHTML(cp, estimateFor(cp), stayTxt)
        : `<p class="plain">${cp.operator ? `Run by ${cp.operator}. ` : ''}The rates aren't published anywhere we can use yet, so check the board at the entrance before you go in.</p>`}
      ${cp.rates?.length ? `<h3 class="h3">Rates${cp.fromPhoto ? ` <small class="muted">from your photo, ${cp.fromPhoto}</small>` : ''}</h3>${rateBoard(cp)}` : ''}
      ${cp.kind === 'parkride' ? '' : `<button type="button" class="snapcta" data-snapboard="${cp.id}"><i class="ph-fill ph-camera" aria-hidden="true"></i><span><b>${cp.rates?.length ? 'Prices changed? Snap the board' : 'Snap the price board'}</b><small>At the entrance? Photograph the prices and Kerb fills them in.</small></span></button>`}
      ${price?.none ? `<p class="plain">${price.why === 'long' ? 'Longer stays aren\'t allowed or aren\'t published, so check the board at the entrance.' : 'It may be closed then, or the rate isn\'t published. Check the board at the entrance.'}</p>` : ''}
      ${cp.hours ? `<p class="plain">Open ${cp.hours}.</p>` : ''}
      ${cp.note ? `<p class="plain">${cp.note}</p>` : ''}
      ${cp.phone ? `<p class="plain">Phone <span class="num">${cp.phone}</span></p>` : ''}
      ${cp.url && !cp.rates?.length ? `<a class="cta" href="${cp.url}" target="_blank" rel="noopener"><i class="ph ph-arrow-square-out"></i>Rates on ${cp.operator || 'the operator'}'s website</a>` : ''}
      ${/2016/.test(cp.source || '') ? '<p class="note">From Transport for NSW\'s 2016 list of CBD car parks, so the operator or hours may have changed.</p>' : ''}
      ${cp.checked ? `<p class="note">Rates checked ${new Date(cp.checked).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}${cp.rateSource ? ` on <a href="${cp.rateSource}" target="_blank" rel="noopener">the ${cp.operator || 'owner'}'s website</a>` : ''}. Rates change, so the board at the entrance always wins.</p>` : ''}
      ${actionsHTML(cp.at, cp.id)}`;
  }
  body.appendChild(d);
  // Stay where you were when the same detail just refreshes (time or stay changed); jump to the top for a new one.
  if (body.dataset.mode !== `detail:${S.sel}`) body.scrollTop = 0;
  body.dataset.mode = `detail:${S.sel}`;
  if (f) loadSignPhotos(f, d.querySelector('#signPhotos'));
  d.querySelector('.back').onclick = () => { S.sel = null; update(); };
  const id = S.sel;
  d.querySelector('[data-act=save]').onclick = (e) => { toggleSaved(id); const on = isSaved(id); e.currentTarget.setAttribute('aria-pressed', String(on)); e.currentTarget.innerHTML = starInner(on); };
  d.querySelector('[data-act=share]').onclick = () => shareSel(f, cp);
  const pk = d.querySelector('[data-act=park]'); if (pk) pk.onclick = () => parkedNow(f);
}

const starInner = (on) => `<i class="ph${on ? '-fill' : ''} ph-star"></i>${on ? 'Saved' : 'Save'}`;
// A link out to Google Street View at this kerb, facing the kerb, so drivers can read the sign themselves.
// It's only a link (Google Maps URLs need no key and cost nothing); Kerb never copies anything from Street View.
const SIDE_BEARING = { North: 0, 'North-east': 45, East: 90, 'South-east': 135, South: 180, 'South-west': 225, West: 270, 'North-west': 315 };
function streetViewHTML(p, at) {
  if (!at) return '';
  const [lon, lat] = at.map((v) => +v.toFixed(6));
  const h = SIDE_BEARING[String(p.sd || '').replace(/ side$/i, '')];
  const url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lon}${h != null ? `&heading=${h}` : ''}`;
  return `<a class="snapcta" href="${url}" target="_blank" rel="noopener"><i class="ph-fill ph-binoculars" aria-hidden="true"></i><span><b>Check the sign in Street View</b><small>Opens Google Street View at this kerb. Photos can be a few years old, so the sign on the street wins.</small></span></a>`;
}
function actionsHTML(at, id) {
  const [lon, lat] = at.map((v) => +v.toFixed(6)), on = isSaved(id);
  return `<div class="actions">
      <button class="cta" type="button" data-act="save" aria-pressed="${on}">${starInner(on)}</button>
      <button class="cta" type="button" data-act="share"><i class="ph ph-share-network"></i>Share</button>
      ${typeof id === 'number' ? '<button class="cta" type="button" data-act="park"><i class="ph ph-car-simple"></i>I parked here</button>' : ''}
    </div>
    <div class="actions"><span class="nav-label">Drive there with</span>
      <a class="cta" href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}" target="_blank" rel="noopener"><i class="ph ph-navigation-arrow"></i>Google Maps</a>
      <a class="cta" href="https://maps.apple.com/?daddr=${lat},${lon}&dirflg=d" target="_blank" rel="noopener"><i class="ph ph-map-trifold"></i>Apple Maps</a>
      <a class="cta" href="https://waze.com/ul?ll=${lat},${lon}&navigate=yes" target="_blank" rel="noopener"><i class="ph ph-car"></i>Waze</a>
    </div>`;
}
async function shareSel(f, cp) {
  const stayTxt = stayWords(false);
  const when = `${stayTxt} from ${DAYS[S.day]} ${fmtTime(S.hour)}`;
  let at, text;
  if (f) {
    const p = f.properties; at = mids.get(p.id);
    const c = p.lk ? { ok: true, cost: 0, likely: true } : costFor(p, RULES, S.day, S.hour, S.stay);
    const v = verdictText(p, c);
    text = `${p.s}${p.sd ? ` (${p.sd.toLowerCase()})` : ''}: ${v.head}${c.ok && !c.likely ? `, ${costText(c)}` : ''} for ${when}.`;
  } else {
    at = cp.at;
    const occ = cp.kind === 'parkride' ? occAt(cp, S.day, S.hour) : null;
    text = `${cp.name}${cp.kind === 'parkride' ? `: free with an Opal trip${occ == null ? '' : occ >= 95 ? ', usually full by now' : `, usually ~${spacesLeft(cp, occ)} spaces left`}` : ''} (${when}).`;
  }
  const url = `${location.origin}${location.pathname}#at=${at[1].toFixed(5)},${at[0].toFixed(5)}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Kerb', text, url });
    else { await navigator.clipboard.writeText(`${text} ${url}`); toast('Link copied'); }
  } catch (e) { if (e.name !== 'AbortError') toast("Couldn't share. Try again."); }
}

/* ---------- street photos of nearby signs (Mapillary, CC BY-SA) ---------- */
// The client token is injected at build time from the MAPILLARY_TOKEN repository secret.
const MLY = import.meta.env.VITE_MAPILLARY_TOKEN || '';
const photoCache = new Map();
async function loadSignPhotos(f, el) {
  if (!el || !MLY) return;
  const id = f.properties.id;
  try {
    if (!photoCache.has(id)) photoCache.set(id, fetchSignPhotos(f));
    const photos = await photoCache.get(id);
    if (S.sel !== id || !photos.length) return;
    el.hidden = false;
    el.innerHTML = `<h3 class="h3">Street photos of the signs here</h3>
      <div class="photo-row">${photos.map((ph) => `<a href="https://www.mapillary.com/app/?pKey=${ph.id}&focus=photo" target="_blank" rel="noopener" class="photo"><img src="${ph.url}" alt="Street photo of a parking sign on ${f.properties.s}" loading="lazy"><span>${ph.date}</span></a>`).join('')}</div>
      <p class="note">Check what the sign actually says. Photos from Mapillary contributors, CC BY-SA.</p>`;
  } catch { /* photos are a bonus; skip quietly */ }
}
async function fetchSignPhotos(f) {
  const c = f.geometry.coordinates;
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  for (const [x, y] of c) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const pad = 0.00025;
  const h = { headers: { Authorization: `OAuth ${MLY}` } };
  const q = `https://graph.mapillary.com/map_features?fields=id,object_value,geometry,last_seen_at&bbox=${x0 - pad},${y0 - pad},${x1 + pad},${y1 + pad}&limit=200`;
  const j = await fetch(q, h).then((r) => r.json());
  const mid = mids.get(f.properties.id);
  const signs = (j.data || []).filter((x) => /traffic-sign--front|information-parking|no-parking|no-stopping/.test(x.object_value))
    .sort((a, b) => (b.last_seen_at || '').localeCompare(a.last_seen_at || '') || distM(a.geometry.coordinates, mid) - distM(b.geometry.coordinates, mid))
    .slice(0, 3);
  const out = [];
  for (const sg of signs) {
    const det = await fetch(`https://graph.mapillary.com/${sg.id}?fields=images`, h).then((r) => r.json());
    const imgId = det.images?.data?.[0]?.id;
    if (!imgId) continue;
    const im = await fetch(`https://graph.mapillary.com/${imgId}?fields=id,thumb_1024_url,captured_at`, h).then((r) => r.json());
    if (im.thumb_1024_url) out.push({ id: im.id, url: im.thumb_1024_url, date: new Date(im.captured_at).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' }) });
  }
  return out;
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
  const chip = (cls, pressed, html, title, onclick) => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.setAttribute('aria-pressed', String(pressed)); b.innerHTML = html; b.title = title; b.onclick = onclick; lg.appendChild(b); return b; };
  const cpOn = !S.hidden.has('carpark');
  chip('perm', cpOn, `<i class="ph ph-local-parking" aria-hidden="true"></i>Car parks${cpOn ? '' : ' off'}`, 'Show or hide car parks', () => { cpOn ? S.hidden.add('carpark') : S.hidden.delete('carpark'); renderLegend(); drawCarParks(); renderBody(); });
  if (CITY_ID === 'syd') chip('perm', BEN.mps, `<i class="ph ph-wheelchair" aria-hidden="true"></i>${BEN.mps ? 'Mobility permit on' : 'Mobility permit'}`, 'I have a NSW mobility parking permit', () => {
    BEN.mps = !BEN.mps;
    try { localStorage.setItem('kerb-mps', BEN.mps ? '1' : '0'); } catch { /* private mode */ }
    toast(BEN.mps ? 'Showing prices and time limits for mobility permit holders' : 'Mobility permit off');
    renderLegend(); update();
  });
  chip('keybtn', false, '<i class="ph ph-swatches" aria-hidden="true"></i>Key', 'What the colours mean', () => toggleKey());
}
// The colour key, out of the way until asked for. Each colour can still be hidden from here.
function toggleKey(force) {
  let pop = $('#keyPop');
  if (pop && force !== true) { pop.remove(); return; }
  if (!pop) { pop = document.createElement('div'); pop.id = 'keyPop'; pop.className = 'keypop'; $('#app').appendChild(pop); }
  const WHAT = { free: 'Free for your whole stay', likely: 'Probably free (no published signs)', paid: 'Meter: you pay', short: 'Time limit shorter than your stay', restricted: 'No parking or no stopping', permit: 'Resident permit area: visitors time-limited' };
  pop.innerHTML = `<div class="kp-top"><b>Map key</b><button type="button" aria-label="Close"><i class="ph ph-x"></i></button></div>${LEGEND.filter(([k]) => k !== 'carpark').map(([k]) => `<label class="kp-row"><i class="${k === 'short' ? 'dash' : k === 'likely' ? 'dash-free' : k === 'permit' ? 'dash-permit' : ''}" style="background:var(--${k === 'short' ? 'paid' : k === 'likely' ? 'free' : k})"></i><span>${WHAT[k]}</span><input type="checkbox" data-k="${k}"${S.hidden.has(k) ? '' : ' checked'} aria-label="Show ${WHAT[k]}"></label>`).join('')}<p class="kp-note">Untick a colour to hide it from the map.</p>`;
  pop.querySelector('.kp-top button').onclick = () => pop.remove();
  pop.querySelectorAll('input[data-k]').forEach((cb) => (cb.onchange = () => { const k = cb.dataset.k; cb.checked ? S.hidden.delete(k) : S.hidden.add(k); if (map.isStyleLoaded()) kerbLayers(); renderBody(); }));
}

/* ---------- sheet (phones): min (full map), peek, open ---------- */
// Drag the panel by its handle, the top of the dock, or by pulling the list down from the top.
// The panel height is fixed in pixels (not dvh) so iOS's collapsing address bar can't make it jump.
const panel = $('#panel');
const root = document.documentElement;
let sheet = 'peek', panelTouch = false, lastH = 0, lastW = 0;
const px = (v) => parseFloat(getComputedStyle(root).getPropertyValue(v)) || 0;
const isDesk = () => innerWidth >= 900;
function sizeSheet() {
  const h = Math.round(Math.min(innerHeight * 0.8, 740));
  if (Math.abs(h - lastH) > 40 || innerWidth !== lastW) { lastH = h; lastW = innerWidth; root.style.setProperty('--sheet-h', `${h}px`); }
}
function setPeek() {
  sizeSheet();
  const dock = $('#dock').getBoundingClientRect().height;
  const row = $('.dock-row').getBoundingClientRect().height;
  root.style.setProperty('--peek', `${Math.round(dock + 22 + 64)}px`);
  root.style.setProperty('--min', `${Math.round(row + 22 + 12)}px`);
  setSheet(sheet);
}
function visibleHeight(state) {
  if (isDesk()) return 0;
  return state === 'open' ? panel.offsetHeight : state === 'min' ? px('--min') : px('--peek');
}
function setSheet(state) {
  sheet = state; S.open = state === 'open';
  panel.classList.toggle('open', state === 'open');
  panel.classList.toggle('min', state === 'min');
  root.style.setProperty('--vis', `${Math.round(visibleHeight(state === 'open' ? 'peek' : state))}px`);
  const fb = $('#fullBtn');
  if (fb) { fb.setAttribute('aria-pressed', String(state === 'min')); fb.innerHTML = state === 'min' ? '<i class="ph ph-arrows-in-simple"></i>' : '<i class="ph ph-arrows-out-simple"></i>'; fb.setAttribute('aria-label', state === 'min' ? 'Show the options' : 'Full screen map'); }
}
function setOpen(v) { setSheet(v ? 'open' : 'peek'); }
(() => {
  const offFor = (state) => panel.offsetHeight - visibleHeight(state);
  let drag = null; // { y0, t0, start, last, lastT, v, moved }
  const begin = (y) => { drag = { y0: y, start: offFor(sheet), last: y, lastT: performance.now(), v: 0, moved: false }; };
  const move = (y) => {
    if (!drag) return false;
    const dy = y - drag.y0;
    if (!drag.moved && Math.abs(dy) < 6) return false;
    if (!drag.moved) { drag.moved = true; panel.classList.add('dragging'); }
    const now = performance.now();
    drag.v = 0.7 * drag.v + 0.3 * ((y - drag.last) / Math.max(1, now - drag.lastT)); drag.last = y; drag.lastT = now;
    panel.style.transform = `translateY(${Math.min(offFor('min'), Math.max(0, drag.start + dy))}px)`;
    return true;
  };
  const finish = (y, tapToggles) => {
    if (!drag) return;
    const d = drag; drag = null;
    panel.classList.remove('dragging'); panel.style.transform = '';
    if (!d.moved) { if (tapToggles) setSheet(sheet === 'open' ? 'peek' : 'open'); return; }
    const off = d.start + (y - d.y0), order = ['open', 'peek', 'min'];
    let target;
    if (Math.abs(d.v) > 0.45) { // a flick goes one step in its direction
      const i = order.indexOf(sheet), j = d.v > 0 ? Math.min(2, i + 1) : Math.max(0, i - 1);
      target = order[j];
    } else target = order.map((st) => [st, Math.abs(offFor(st) - off)]).sort((a, b) => a[1] - b[1])[0][0];
    setSheet(target);
  };
  // Handle and the non-control parts of the dock.
  const grab = [$('#handle'), $('#dock')];
  for (const el of grab) {
    el.addEventListener('pointerdown', (e) => {
      if (isDesk() || (el.id === 'dock' && e.target.closest('button, input, .stay, .ribbon'))) return;
      begin(e.clientY); el.setPointerCapture?.(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => { if (move(e.clientY)) e.preventDefault(); });
    el.addEventListener('pointerup', (e) => finish(e.clientY, el.id === 'handle'));
    el.addEventListener('pointercancel', (e) => finish(e.clientY, false));
  }
  // Pull the list down from its top to lower the sheet (like a native bottom sheet).
  const list = $('#body');
  let ty = null, pulling = false;
  list.addEventListener('touchstart', (e) => { panelTouch = true; ty = e.touches[0].clientY; pulling = false; }, { passive: true });
  list.addEventListener('touchmove', (e) => {
    if (isDesk() || ty == null) return;
    const y = e.touches[0].clientY;
    if (!pulling && list.scrollTop <= 0 && y - ty > 6 && sheet === 'open') { pulling = true; begin(ty); }
    if (pulling) { move(y); e.preventDefault(); }
  }, { passive: false });
  const tEnd = (e) => {
    panelTouch = false;
    if (pulling) finish(e.changedTouches[0].clientY, false);
    ty = null; pulling = false;
    if (pendingList) { pendingList = false; if (S.sel == null) renderList(); }
  };
  list.addEventListener('touchend', tEnd); list.addEventListener('touchcancel', tEnd);
  $('#fullBtn').addEventListener('click', () => setSheet(sheet === 'min' ? 'peek' : 'min'));
  $('#satBtn').addEventListener('click', () => setSat(!S.sat));
})();
let pendingList = false;

/* ---------- keep the page pinned on phones (iOS can scroll or zoom the whole page after the keyboard) ---------- */
function settle() {
  if (scrollX || scrollY) scrollTo(0, 0);
  if (innerWidth !== lastW || Math.abs(Math.min(innerHeight * 0.8, 740) - lastH) > 40) { map.resize(); setPeek(); }
}
visualViewport?.addEventListener('resize', () => { clearTimeout(settle.t); settle.t = setTimeout(settle, 250); });
// iOS can launch a home-screen app with a smaller viewport for a moment; if the map keeps that size, part of the
// screen stays blank and untouchable. Watch the map box itself and resize whenever the canvas doesn't match it.
const fitCanvas = () => {
  const box = $('#map').getBoundingClientRect(), cv = map.getCanvas().getBoundingClientRect();
  if (Math.abs(box.height - cv.height) > 2 || Math.abs(box.width - cv.width) > 2) map.resize();
};
try { new ResizeObserver(() => requestAnimationFrame(fitCanvas)).observe($('#map')); } catch { /* old browsers */ }
[300, 1000, 2500].forEach((t) => setTimeout(fitCanvas, t));
addEventListener('focus', fitCanvas);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { settle(); fitCanvas(); map.triggerRepaint(); } });
addEventListener('pageshow', settle);
map.on('webglcontextlost', () => toast('The map paused. It will come back in a moment.'));
map.on('webglcontextrestored', () => { restyleBase(); if (KERBS) { kerbLayers(); cpLayers(); destLayers(); recolour(); } if (S.sat) setSat(true); });

/* ---------- search ---------- */
// Suggestions start at the second letter: streets and car parks Kerb knows appear instantly,
// then places from Photon (OpenStreetMap) fill in a moment later.
const q = $('#q'), results = $('#results');
let searchTimer = null, searchCtl = null, localIdx = null;
const fold = (t) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
function buildIndex() {
  const seen = new Map();
  for (const f of KERBS?.features || []) {
    const p = f.properties;
    if (!p.s) continue;
    const area = p.b && !/side$/i.test(p.b) ? p.b : ({ w: 'Waverley', wo: 'Woollahra' })[p.src] || '';
    const key = `${p.s}|${area}`;
    if (!seen.has(key)) seen.set(key, { title: p.s, sub: area || 'Street', at: mids.get(p.id), n: 0, kind: 'street' });
    seen.get(key).n++;
  }
  const list = [...seen.values()];
  for (const cp of CARPARKS) list.push({ title: cp.name, sub: cp.address || 'Car park', at: cp.at, n: 50, kind: 'carpark', id: cp.id });
  for (const x of list) { x.key = fold(`${x.title} ${x.sub}`); x.tkey = fold(x.title); }
  localIdx = list;
}
function localMatches(text) {
  if (!localIdx) buildIndex();
  const t = fold(text), words = t.split(' ');
  const hits = [];
  for (const x of localIdx) {
    const title = x.tkey.startsWith(t) ? 0 : x.tkey.includes(` ${t}`) ? 20 : x.key.includes(` ${t}`) || x.key.startsWith(t) ? 45 : words.every((w) => x.key.includes(w)) ? 60 : -1;
    if (title < 0) continue;
    hits.push({ x, score: title - Math.min(15, x.n / 4) + (x.kind === 'carpark' ? 8 : 0) });
  }
  return hits.sort((a, b) => a.score - b.score).slice(0, 5).map((h) => h.x);
}
// Recent searches (this phone only), shown when the search bar is tapped while empty.
const RECENT_KEY = 'kerb-recent';
const recent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } };
function remember(item) {
  const r = recent().filter((x) => !(x.title === item.title && x.sub === item.sub));
  r.unshift({ title: item.title, sub: item.sub || '', at: item.at, kind: item.kind, id: item.id });
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(r.slice(0, 8))); } catch { /* ignore */ }
}
function showRecent() {
  const r = recent();
  if (!r.length) { results.hidden = true; return; }
  results.replaceChildren();
  const h = document.createElement('li'); h.className = 'rhead'; h.innerHTML = '<span>Recent</span><button type="button">Clear</button>';
  h.querySelector('button').onclick = (e) => { e.stopPropagation(); try { localStorage.removeItem(RECENT_KEY); } catch { /* ignore */ } results.hidden = true; q.focus(); };
  results.appendChild(h);
  for (const item of r) {
    const li = document.createElement('li'), b = document.createElement('button'); b.type = 'button';
    b.innerHTML = `<i class="ph ph-clock-counter-clockwise" aria-hidden="true"></i><span class="rt"><span>${item.title}</span><small>${item.sub || ''}</small></span>`;
    b.onclick = () => pick(item);
    li.appendChild(b); results.appendChild(li);
  }
  results.hidden = false;
}
function pick(item) {
  // Stop any search still on its way back, or it would reopen the list over the map.
  clearTimeout(searchTimer); searchCtl?.abort(); searchCtl = null;
  remember(item);
  results.hidden = true; q.value = item.title; q.blur(); S.sel = null;
  if (item.kind === 'carpark') { setDest(null); q.value = item.title; select(item.id, true); return; }
  q.blur(); setSheet('peek'); // keep the map in view so the options can be seen; the list is one swipe up
  { const other = !inBox(item.at, CITY.box) && Object.keys(CITIES).find((k) => inBox(item.at, CITIES[k].box)); if (other) { goToCity(other, item.at); return; } }
  setDest({ at: item.at, name: item.sub && item.kind === 'street' ? `${item.title}, ${item.sub}` : item.title });
}
function showResults(local, places, loading) {
  results.replaceChildren();
  const add = (item, icon) => {
    const li = document.createElement('li');
    const b = document.createElement('button'); b.type = 'button';
    b.innerHTML = `<i class="ph ${icon}" aria-hidden="true"></i><span class="rt"><span>${item.title}</span><small>${item.sub || ''}</small></span>`;
    b.onclick = () => pick(item);
    li.appendChild(b); results.appendChild(li);
  };
  local.forEach((x) => add(x, x.kind === 'carpark' ? 'ph-car' : 'ph-road-horizon'));
  const seen = new Set(local.map((x) => fold(x.title)));
  places.filter((x) => !seen.has(fold(x.title))).slice(0, 6 - Math.min(3, local.length)).forEach((x) => add(x, 'ph-map-pin'));
  if (loading && !results.children.length) results.innerHTML = '<li><button type="button" disabled>Searching…</button></li>';
  if (!loading && !results.children.length) results.innerHTML = '<li><button type="button" disabled>No places found. Try a street name or suburb.</button></li>';
  results.hidden = false;
}
let lastPlaces = [];
q.addEventListener('input', () => {
  const text = q.value.trim();
  clearTimeout(searchTimer);
  if (text.length < 2) { if (!text) showRecent(); else results.hidden = true; return; }
  showResults(localMatches(text), lastPlaces.filter((p) => fold(p.title).includes(fold(text).split(' ')[0])), true);
  searchTimer = setTimeout(runSearch, 160);
});
q.addEventListener('focus', () => { if (q.value.trim().length >= 2) q.dispatchEvent(new Event('input')); else if (!q.value.trim()) showRecent(); });
q.addEventListener('keydown', (e) => { if (e.key === 'Escape') { results.hidden = true; q.blur(); } });
q.addEventListener('blur', () => setTimeout(settle, 120));
$('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); const first = results.querySelector('button:not([disabled])'); if (first) first.click(); else runSearch(); });
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) results.hidden = true; });
async function runSearch() {
  const text = q.value.trim();
  if (text.length < 2) return;
  searchCtl?.abort(); searchCtl = new AbortController();
  try {
    const c = map.getCenter();
    const u = `https://photon.komoot.io/api/?q=${encodeURIComponent(text)}&lat=${c.lat.toFixed(4)}&lon=${c.lng.toFixed(4)}&limit=8&bbox=${CITY.search}&lang=en`;
    const j = await fetch(u, { signal: searchCtl.signal }).then((r) => r.json());
    if (q.value.trim() !== text) return; // the user kept typing
    lastPlaces = (j.features || []).filter((f) => f.properties.countrycode === 'AU').map((f) => {
      const p = f.properties;
      return { title: p.name || [p.housenumber, p.street].filter(Boolean).join(' '), sub: [p.street && p.name ? p.street : '', p.district || p.locality, p.city].filter(Boolean).join(', '), at: f.geometry.coordinates, kind: 'place' };
    }).filter((x) => x.title);
    if (document.activeElement === q) showResults(localMatches(text), lastPlaces, false);
  } catch (e) { if (e.name !== 'AbortError' && document.activeElement === q) showResults(localMatches(text), [], false); }
}

/* ---------- locate ---------- */
let meMarker = null;
$('#locate').onclick = () => {
  if (!navigator.geolocation) return toast("This browser can't share your location.");
  navigator.geolocation.getCurrentPosition((pos) => {
    const at = [pos.coords.longitude, pos.coords.latitude];
    { const other = !inBox(at, CITY.box) && Object.keys(CITIES).find((k) => inBox(at, CITIES[k].box)); if (other) { toast(`Opening Kerb for ${CITIES[other].name}…`); goToCity(other, at); return; } }
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

map.on('click', 'cp-cluster', (e) => {
  const f = e.features[0];
  map.getSource('cps').getClusterExpansionZoom(f.properties.cluster_id).then((z) => map.easeTo({ center: f.geometry.coordinates, zoom: z + 0.3, duration: 500 }));
});
for (const l of ['cp-pill', 'cp-sel']) map.on('click', l, (e) => select(e.features[0].properties.id, true));
for (const l of ['cp-cluster', 'cp-pill', 'cp-sel']) { map.on('mouseenter', l, () => (map.getCanvas().style.cursor = 'pointer')); map.on('mouseleave', l, () => (map.getCanvas().style.cursor = '')); }
// Snap the sign can ask for the next tap on the map to say which kerb a sign is on.
let pickMode = null;
map.on('click', (e) => {
  if (pickMode) {
    const cb = pickMode; pickMode = null;
    const hit = map.queryRenderedFeatures([[e.point.x - 12, e.point.y - 12], [e.point.x + 12, e.point.y + 12]], { layers: ['kerb-line', 'kerb-short', 'kerb-faint'].filter((l) => map.getLayer(l)) })[0];
    cb(e.lngLat.toArray(), hit ? hit.properties.id : null);
    return;
  }
  if (map.getLayer('cp-pill') && map.queryRenderedFeatures(e.point, { layers: ['cp-cluster', 'cp-pill', 'cp-sel'] }).length) return;
  const hits = map.queryRenderedFeatures([[e.point.x - 10, e.point.y - 10], [e.point.x + 10, e.point.y + 10]], { layers: ['kerb-line', 'kerb-short', 'kerb-faint'].filter((l) => map.getLayer(l)) });
  if (hits.length) select(hits[0].properties.id, false);
  else if (S.sel != null) { S.sel = null; update(); }
});
for (const l of ['kerb-line', 'kerb-short', 'kerb-faint']) {
  map.on('mouseenter', l, () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', l, () => (map.getCanvas().style.cursor = ''));
}
let moveTimer = null;
map.on('moveend', () => { clearTimeout(moveTimer); moveTimer = setTimeout(() => { drawRibbon(); if (S.sel != null) return; if (panelTouch) pendingList = true; else renderList(); }, 120); });

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { restyleBase(); if (KERBS) { kerbLayers(); cpLayers(); destLayers(); } if (S.sat) setSat(true); drawRibbon(); });
addEventListener('resize', () => { setPeek(); drawRibbon(); });

/* ---------- live bays (Melbourne's in-ground sensors) ---------- */
const LIVE_URL = 'https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets/on-street-parking-bay-sensors/exports/json?select=kerbsideid,status_description';
let LIVE = null, LIVE_AT = 0, BAYS = null;
function liveCount(p) {
  if (!LIVE || !p.kb) return null;
  let free = 0, known = 0;
  for (const id of p.kb) { const st = LIVE.get(String(id)); if (st == null) continue; known++; if (st) free++; }
  return known ? { free, known } : null;
}
const liveText = (l) => `${l.free} of ${l.known} bay${l.known > 1 ? 's' : ''} free right now`;
async function loadLive() {
  if (!CITY.live || document.hidden) return;
  try {
    if (!BAYS) BAYS = await fetch(DATA + 'bays.json?v=' + encodeURIComponent(META?.builtAt || '')).then((r) => r.json());
    const rows = await fetch(LIVE_URL).then((r) => r.json());
    LIVE = new Map(rows.map((r) => [String(r.kerbsideid), r.status_description === 'Unoccupied']));
    LIVE_AT = Date.now();
    const fc = { type: 'FeatureCollection', features: BAYS.map(([id, x, y]) => ({ type: 'Feature', properties: { st: LIVE.has(id) ? (LIVE.get(id) ? 'free' : 'taken') : 'unknown' }, geometry: { type: 'Point', coordinates: [x, y] } })) };
    if (map.getSource('bays')) map.getSource('bays').setData(fc);
    else if (map.isStyleLoaded()) {
      map.addSource('bays', { type: 'geojson', data: fc });
      map.addLayer({ id: 'bay-dot', type: 'circle', source: 'bays', minzoom: 15.5, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 15.5, 2.5, 18, 6], 'circle-color': ['match', ['get', 'st'], 'free', C().free, 'taken', C().restricted, C().unknown], 'circle-stroke-width': 1.2, 'circle-stroke-color': C().bg, 'circle-opacity': 0.95 } });
    }
    renderBody();
  } catch { /* live data is a bonus: the map works without it */ }
}
if (CITY.live) { setInterval(loadLive, 120000); document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - LIVE_AT > 60000) loadLive(); }); }

/* ---------- city switcher ---------- */
const CITY_NOTE = { syd: 'CBD to the beaches, Parramatta', mel: 'Live free bays', bne: 'Every meter, with rates', per: 'Every bay in the CBD' };
$('#cityName').textContent = CITY.name;
$('#cityMenu').innerHTML = Object.entries(CITIES).map(([id, c]) => `<button type="button" role="menuitem" data-city="${id}"${id === CITY_ID ? ' aria-current="true"' : ''}>${c.name}<small>${CITY_NOTE[id]}</small></button>`).join('');
$('#cityBtn').addEventListener('click', (e) => { e.stopPropagation(); const m = $('#cityMenu'); m.hidden = !m.hidden; $('#cityBtn').setAttribute('aria-expanded', String(!m.hidden)); });
$('#cityMenu').addEventListener('click', (e) => { const b = e.target.closest('[data-city]'); if (!b) return; if (b.dataset.city === CITY_ID) { $('#cityMenu').hidden = true; map.flyTo({ center: CITY.center, zoom: CITY.zoom }); } else goToCity(b.dataset.city); });
document.addEventListener('click', (e) => { if (!e.target.closest('#cityMenu, #cityBtn')) { $('#cityMenu').hidden = true; $('#cityBtn').setAttribute('aria-expanded', 'false'); } });

/* ---------- boot ---------- */
renderLegend();
syncControls();
setPeek();
renderList();
const dataReady = loadData().catch((e) => { body.innerHTML = `<div class="empty"><strong>The parking data didn't load</strong>Check your connection and reload the page. (${e.message})</div>`; throw e; });
// Sign photos saved on this phone become kerbs on its map.
let snapMade = new Map();
function applySnaps() {
  if (!KERBS) return;
  snapMade = snapsToKerbs(KERBS, RULES, byId, mids);
  localIdx = null;
  recolour();
  update();
}
document.addEventListener('click', (e) => { if (e.target.closest('#snapHere')) $('#snapBtn').click(); });
initSnap({
  map, S, mids, byId, distM, toast,
  kerbs: () => KERBS,
  select: (id, fly) => select(id, fly),
  stayWords: () => stayWords(true),
  when: () => `Checked for ${DAYS_LONG[S.day]} at ${fmtTime(S.hour)}`,
  pickKerb: (cb) => { pickMode = cb; },
  selected: () => (typeof S.sel === 'number' ? S.sel : null),
  applySnaps,
  snapKerbId: (sid) => snapMade.get(sid),
});
// Price boards photographed on this phone become that car park's rates (marked as from your photo).
function applyBoards() {
  const boards = loadBoards();
  for (const cp of CARPARKS) {
    const b = boards[cp.id];
    if (!b) continue;
    if (!cp.ownRates) cp.ownRates = { rates: cp.rates, rateSource: cp.rateSource, checked: cp.checked };
    Object.assign(cp, { rates: b.rates, fromPhoto: b.date, checked: b.date, rateSource: null });
  }
  drawCarParks(); update();
}
initBoard({ carPark: (id) => CARPARKS.find((c) => c.id === id), applyBoards, toast });
dataReady.then(() => {
  applySnaps();
  applyBoards();
  setSessionMarker();
  if (LINK && KERBS) {
    let best = null, bd = 30;
    for (const f of KERBS.features) { const d = distM(mids.get(f.properties.id), LINK); if (d < bd) { bd = d; best = f.properties.id; } }
    for (const cp of CARPARKS) { const d = distM(cp.at, LINK); if (d < bd) { bd = d; best = cp.id; } }
    if (best != null) { S.sel = best; setOpen(true); }
  }
  update();
}, () => {});
map.on('style.load', async () => {
  restyleBase();
  document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  try { await dataReady; } catch { return; }
  recolour();
  kerbLayers();
  cpLayers();
  destLayers();
  if (S.sat) setSat(true);
  update();
  if (CITY.live) loadLive();
});
