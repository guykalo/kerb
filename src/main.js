import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '@phosphor-icons/web/regular';
import '@phosphor-icons/web/fill';
import './style.css';
import {
  DAYS, DAYS_LONG, fmtTime, fmtDays, pLabel, money,
  stateAt, costFor, category, plainNow, dayTimeline, BEN, permitMine,
  busy, busyLevel, BUSY_WORD, BANDS, band,
} from './rules.js';
import { parsePart } from '../scripts/lib/parse-rules.mjs';
import { initSnap, snapsToKerbs, initBoard, loadBoards, setSharedSnaps } from './snap.js';
import { initAnalytics } from './analytics.js';

initAnalytics();

const $ = (s) => document.querySelector(s);
// Cities Streety covers. Sydney's data lives in data/, the others in data/<id>/. One city is loaded at a time.
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
// Someone who used Streety before this version skips the first-open welcome (checked before kerb-city is written).
try { if (!localStorage.getItem('streety-welcomed') && ['kerb-city', 'kerb-stay', 'kerb-saved', 'kerb-parked', 'kerb-snaps', 'kerb-recent', 'kerb-car', 'streety-proofs'].some((k) => localStorage.getItem(k) != null)) localStorage.setItem('streety-welcomed', '1'); } catch { /* storage unavailable */ }
try { localStorage.setItem('kerb-city', CITY_ID); } catch { /* storage unavailable */ }
document.documentElement.dataset.city = CITY_ID;
document.title = `Streety · ${CITY.name} parking`;
function goToCity(id, at) {
  try { localStorage.setItem('kerb-city', id); } catch { /* storage unavailable */ }
  location.href = `${location.pathname}?city=${id}${at ? `#at=${at[1].toFixed(5)},${at[0].toFixed(5)}` : ''}`;
}
const DATA = CITY.data;
const START = { center: CITY.center, zoom: CITY.zoom };
const NEAR_M = 650; // list shows kerbs within this distance of the map centre
const WALK_M_PER_MIN = 80;

/* ---------- state ---------- */
// planned: false while Streety follows the clock ("Now"); true once a day or time has been picked.
const S = { day: 1, hour: 9, stay: 2, night: false, edit: false, sel: null, hidden: new Set(), open: false, dest: null, walk: 10, planned: false, filter: 'all', more: false };
// Overnight: from the arrival time until 8am the next morning.
const nightStay = (h) => Math.max(1, h < 8 ? 8 - h : 32 - h);
function sydneyNow() { // "now" in the city on the map, to the minute (a stay starting 8:58pm is checked from 8:58pm)
  const p = new Intl.DateTimeFormat('en-AU', { timeZone: CITY.tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date());
  const g = (t) => (p.find((x) => x.type === t) || {}).value;
  const day = DAYS.indexOf(g('weekday').slice(0, 3));
  const h = (+g('hour') % 24) + +g('minute') / 60;
  return { day: day < 0 ? new Date().getDay() : day, hour: h };
}
const today = sydneyNow();
Object.assign(S, today);
try { const st = localStorage.getItem('kerb-stay'); if (st === 'night') { S.night = true; S.stay = nightStay(S.hour); } else if ([0.25, 1, 2, 3, 4, 8].includes(+st)) S.stay = +st; } catch { /* storage unavailable */ }
try { const w = +localStorage.getItem('kerb-walk'); if ([2, 5, 10, 15, 20].includes(w)) S.walk = w; } catch { /* storage unavailable */ }
try { BEN.mps = localStorage.getItem('kerb-mps') === '1' && CITY_ID === 'syd'; } catch { /* storage unavailable */ } // NSW concessions only
try { const car = JSON.parse(localStorage.getItem('kerb-car') || '{}'); BEN.vehicle = car.vehicle || 'car'; BEN.permit = (car.permits || {})[CITY_ID] || ''; } catch { /* storage unavailable */ }
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
    // Older builds tagged the CBD with the council's "Not within a Parking Permit Scheme Area" polygon as a permit area.
    if (CITY_ID === 'syd' && (f.properties.pa === 'Area CBD' || /not within a parking permit/i.test(f.properties.b || ''))) { f.properties.pa = ''; if (/not within/i.test(f.properties.b || '')) f.properties.b = ''; }
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
  syd: 'Streety data: <a href="https://data.cityofsydney.nsw.gov.au/" target="_blank" rel="noopener">City of Sydney</a>, NSW councils, Transport for NSW, © OpenStreetMap contributors',
  mel: 'Streety data: <a href="https://data.melbourne.vic.gov.au/" target="_blank" rel="noopener">City of Melbourne</a> (CC BY), © OpenStreetMap contributors',
  bne: 'Streety data: <a href="https://data.brisbane.qld.gov.au/" target="_blank" rel="noopener">Brisbane City Council</a>, © OpenStreetMap contributors',
  per: 'Streety data: <a href="https://geohub-perth.opendata.arcgis.com/" target="_blank" rel="noopener">City of Perth</a> (CC BY), © OpenStreetMap contributors',
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

// Kerb line layers, all clickable.
const KERB_LAYERS = ['kerb-faint', 'kerb-no', 'kerb-short', 'kerb-likely', 'kerb-paid', 'kerb-line'];
const under = () => ['dest-mask', 'opt-kerb', 'cp-cluster'].find((id) => map.getLayer(id));
function kerbLayers() {
  const c = C();
  const col = ['match', ['get', 'c'], 'free', c.free, 'likely', c.free, 'paid', c.paid, 'short', c.short, 'restricted', c.restricted, 'permit', c.permit, c.unknown];
  const w = (m) => ['interpolate', ['linear'], ['zoom'], 12, 1 * m, 14, 2.2 * m, 16, 4.5 * m, 18, 8 * m];
  if (!map.getSource('kerbs')) {
    map.addSource('kerbs', { type: 'geojson', data: KERBS, promoteId: 'id', tolerance: 0.2 });
    map.addSource('meters', { type: 'geojson', data: { type: 'FeatureCollection', features: METERS.map(([x, y, k, n]) => ({ type: 'Feature', properties: { k, n }, geometry: { type: 'Point', coordinates: [x, y] } })) } });
  }
  for (const id of [...KERB_LAYERS, 'kerb-glow', 'kerb-paid-sym', 'kerb-sel', 'meter-dot']) if (map.getLayer(id)) map.removeLayer(id);
  // Every state has its own line pattern as well as its colour, so the map reads without colour (and the key
  // draws the same patterns): free is a thick solid line, probably free a green dash-dot, paid a long dash with "$"
  // marks, too short a thin short dash, no parking a thin dotted red line, permit areas and unknown kerbs faint dashes.
  const is = (c) => ['all', ['==', ['get', 'c'], c], ['!', ['in', c, ['literal', [...S.hidden]]]]];
  const line = (id, c, width, dash, extra = {}) => map.addLayer({ id, type: 'line', source: 'kerbs', filter: Array.isArray(c) ? c : is(c), layout: { 'line-cap': dash ? 'butt' : 'round', 'line-join': 'round' }, paint: { 'line-color': col, 'line-width': width, ...(dash ? { 'line-dasharray': dash } : {}), ...extra } }, under());
  map.addLayer({ id: 'kerb-glow', type: 'line', source: 'kerbs', filter: is('free'), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': col, 'line-width': w(3.2), 'line-blur': w(2.4), 'line-opacity': S.sat ? 0.55 : dark() ? 0.35 : 0.18 } }, under());
  line('kerb-faint', ['all', ['in', ['get', 'c'], ['literal', ['unknown', 'permit']]], ['!', ['in', ['get', 'c'], ['literal', [...S.hidden]]]]], w(0.55), [1.5, 1.5], { 'line-opacity': ['case', ['==', ['get', 'c'], 'permit'], 0.55, 0.5] });
  line('kerb-no', 'restricted', w(0.55), [0.4, 1.4], { 'line-opacity': 0.85 });
  line('kerb-short', 'short', w(0.6), [1.2, 1.2]);
  line('kerb-likely', 'likely', w(0.8), [3, 1, 0.8, 1]);
  line('kerb-paid', 'paid', w(0.95), [3.2, 1.1]);
  line('kerb-line', 'free', w(1));
  // "$" marks along paid kerbs once the streets are big enough to carry them.
  map.addLayer({ id: 'kerb-paid-sym', type: 'symbol', source: 'kerbs', minzoom: 16.2, filter: is('paid'), layout: { 'symbol-placement': 'line', 'symbol-spacing': 90, 'text-field': '$', 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-keep-upright': true, 'text-allow-overlap': false }, paint: { 'text-color': c.paid, 'text-halo-color': c.bg, 'text-halo-width': 2 } }, under());
  map.addLayer({ id: 'kerb-sel', type: 'line', source: 'kerbs', filter: ['==', ['get', 'id'], S.sel && typeof S.sel === 'number' ? S.sel : -1], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.fg, 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 1.5, 18, 3], 'line-gap-width': w(1.4), 'line-opacity': 0.95 } }, under());
  map.addLayer({ id: 'meter-dot', type: 'circle', source: 'meters', minzoom: 16.5, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 16.5, 2, 19, 5], 'circle-color': c.bg, 'circle-stroke-color': c.fg, 'circle-stroke-width': 1.2 } }, under());
}

function recolour() {
  if (!KERBS) return;
  // Free only because Streety reads the meter hours (no meter after 6pm, none on Sundays) is drawn as "probably
  // free", never like a kerb whose own sign says free.
  for (const f of KERBS.features) { let c = category(f.properties, RULES, S.day, S.hour, S.stay); if (c === 'free' && f.properties.k >= 0 && guessed(f.properties)) c = 'likely'; f.properties.c = c; }
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
      ['var', 'n']]],
    'icon-allow-overlap': false, 'text-allow-overlap': false }, paint: { 'text-color': c.bg } });
  map.addLayer({ id: 'cp-pill', type: 'symbol', source: 'cps', filter: ['all', ['!', ['has', 'point_count']], ['!=', ['get', 'sel'], 1]], layout: { ...common,
    'icon-image': ['concat', 'pill-', ['get', 'tone']], 'text-size': 12.5,
    // Streety's estimates stay a plain "P" until you zoom in, so real published prices aren't lost among guesses.
    'text-field': ['step', ['zoom'],
      ['case', ['any', ['==', ['get', 'label'], ''], ['==', ['get', 'tone'], 'est']], 'P', ['format', 'P  ', { 'text-color': green }, ['get', 'label'], {}]],
      16.5, ['case', ['==', ['get', 'label'], ''], 'P', ['format', 'P  ', { 'text-color': green }, ['get', 'label'], {}]]],
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
  const top = [...o.free.slice(0, 5), ...o.paid.filter((x) => !x.c.unknownRate).slice(0, 3), ...(o.free.length >= 3 ? [] : o.likely.slice(0, 3))];
  map.setFilter('opt-kerb', ['in', ['get', 'id'], ['literal', top.map((x) => x.p.id)]]);
  opts.setData({ type: 'FeatureCollection', features: top.map((x, r) => ({ type: 'Feature', properties: { r, tone: x.c.cost > 0 ? 'price' : 'free', label: `${x.c.likely || x.g === 'guess' ? 'Probably free' : x.c.cost > 0 ? money(x.c.cost) : 'Free'} · ${Math.max(1, Math.round(x.d / WALK_M_PER_MIN))} min` }, geometry: { type: 'Point', coordinates: mids.get(x.p.id) } })) });
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
// Streety's own estimate for car parks whose rates we can't publish: the spread of what car parks nearby that do
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
// Streety's own estimate for a car park whose owner doesn't let us publish rates. It blends what the nearest
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
// A length of time in words, to the minute: "45 min", "1 hour", "2 hours", "1 hr 7 min".
function durWords(h) {
  const m = Math.round(h * 60), H = Math.floor(m / 60), M = m % 60;
  if (!H) return `${M} min`;
  return M ? `${H} hr ${M} min` : `${H} hour${H === 1 ? '' : 's'}`;
}
const stayWordsFor = durWords;
function rateBoard(cp) {
  return `<div class="rateboard">${rateLines(cp).map(([t, sub, bands]) => `<div class="rl"><div class="rt">${t}</div><div class="rs">${sub}</div>${bands ? `<div class="rb">${bands}</div>` : ''}</div>`).join('')}</div>`;
}

/* ---------- when and how long: one pill, one short picker ---------- */
// The pill says the plan ("Now · 2 h", "Sat 7pm · 2 h"); tapping it opens day, time and stay chips. Every tap
// applies straight away, so Sat 7pm for 2 hours is three taps: the pill, Sat, 7pm (2 hours is the default).
const dayName = (d) => (d === today.day ? 'Today' : d === (today.day + 1) % 7 ? 'Tomorrow' : DAYS_LONG[d]);
const setNight = () => { if (S.night) S.stay = nightStay(S.hour); };
const TIMES = [['now', 'Now'], [8, '8am'], [9, '9am'], [12, 'Noon'], [15, '3pm'], [17, '5pm'], [18, '6pm'], [19, '7pm'], [20, '8pm']];
const STAYS = [['0.25', '15', 'min', '15 minutes'], ['1', '1', 'hour', '1 hour'], ['2', '2', 'hours', '2 hours'], ['3', '3', 'hours', '3 hours'], ['4', '4', 'hours', '4 hours'], ['8', '8', 'hours', '8 hours'], ['night', '<i class="ph ph-moon" aria-hidden="true"></i>', 'night', 'Overnight, until 8am']];
const stayShort = () => (S.night ? 'Overnight' : S.stay === 0.25 ? '15 min' : `${S.stay} h`);
const whenShort = () => (S.planned ? `${S.day === today.day ? 'Today' : S.day === (today.day + 1) % 7 ? 'Tomorrow' : DAYS[S.day]} ${fmtTime(S.hour)}` : 'Now');
const untilText = () => { const end = S.hour + S.stay; return `until ${fmtTime(end % 24)}${end >= 24 ? ` ${S.day === today.day ? 'tomorrow' : DAYS[(S.day + 1) % 7]}` : ''}`; };
function buildDays() {
  $('#dayChips').innerHTML = [0, 1, 2, 3, 4, 5, 6].map((i) => {
    const d = (today.day + i) % 7;
    return `<button type="button" data-dow="${d}" aria-label="${dayName(d)}"><b>${DAYS[d]}</b><small>${i === 0 ? 'today' : i === 1 ? 'tmrw' : new Date(Date.now() + i * 864e5).toLocaleDateString('en-AU', { day: 'numeric', timeZone: CITY.tz })}</small></button>`;
  }).join('');
}
buildDays();
$('#timeChips').innerHTML = TIMES.map(([v, t]) => `<button type="button" data-time="${v}">${t}</button>`).join('')
  + '<label class="timeother"><span id="timeOtherTxt">Other</span><input type="time" id="timeIn" step="900" aria-label="Other arrival time"></label>';
$('#staySeg').innerHTML = STAYS.map(([v, b, u, l]) => `<button type="button" data-stay="${v}" data-v="${v}" aria-label="${l}"><b>${b}</b><small>${u}</small></button>`).join('');
function goNow() {
  Object.assign(today, sydneyNow());
  S.planned = false; S.dayPicked = false; S.day = today.day; S.hour = today.hour; setNight();
}
function pickDay(d) {
  if (!S.planned) {
    if (d === today.day) return;
    S.hour = (Math.ceil(today.hour * 4) / 4) % 24; // keep the time of day, on the quarter hour
  }
  S.planned = true; S.dayPicked = true; S.day = d; setNight(); update();
}
function pickTime(v) {
  if (v === 'now') goNow();
  else {
    const h = +v;
    // Today at 9pm, "8am" means tomorrow morning (unless a day was picked first).
    if (!S.dayPicked && S.day === today.day && h < today.hour - 0.5) S.day = (today.day + 1) % 7;
    S.planned = true; S.hour = h; setNight();
  }
  update();
}
function pickStay(v) {
  S.night = v === 'night';
  S.stay = S.night ? nightStay(S.hour) : +v;
  try { localStorage.setItem('kerb-stay', S.night ? 'night' : String(S.stay)); } catch { /* ignore */ }
  update();
}
$('#setup').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.dow != null) pickDay(+b.dataset.dow);
  else if (b.dataset.time != null) pickTime(b.dataset.time);
  else if (b.dataset.stay != null) pickStay(b.dataset.stay);
  else if (b.hasAttribute('data-when-done')) setEdit(false);
});
const timeIn = $('#timeIn');
timeIn.addEventListener('change', () => { const m = /^(\d\d):(\d\d)/.exec(timeIn.value); if (m) pickTime(+m[1] + +m[2] / 60); });
// Desktop browsers don't open the clock on a click into an invisible field; ask for it.
timeIn.addEventListener('click', () => { try { timeIn.showPicker?.(); } catch { /* not allowed */ } });
// The pill opens and closes the picker. mode: 'arrive' after a search, 'stay' after "Near me".
const SETUP_TITLE = { arrive: 'When are you getting there?', stay: 'How long are you staying?' };
function setEdit(on, mode) {
  S.edit = on;
  $('#dock').classList.toggle('editing', on);
  $('#ask').setAttribute('aria-expanded', String(on));
  $('#setupTitle').textContent = SETUP_TITLE[mode] || 'When are you parking?';
  syncControls();
  setPeek();
  if (on && sheet === 'min') setSheet('peek');
  if (!on) maybeLegend();
}
$('#ask').addEventListener('click', () => setEdit(!S.edit));

function syncControls() {
  $('#dayChips').querySelectorAll('[data-dow]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.dow === S.day)));
  let match = false;
  $('#timeChips').querySelectorAll('[data-time]').forEach((b) => {
    const on = b.dataset.time === 'now' ? !S.planned : S.planned && Math.abs(+b.dataset.time - S.hour) < 0.01;
    match ||= on; b.setAttribute('aria-pressed', String(on));
  });
  const other = $('.timeother');
  other.classList.toggle('on', !match);
  $('#timeOtherTxt').textContent = match ? 'Other' : fmtTime(S.hour);
  const H = Math.floor(S.hour), M = Math.round((S.hour - H) * 60);
  timeIn.value = `${String(H % 24).padStart(2, '0')}:${String(M % 60).padStart(2, '0')}`;
  $('#staySeg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(S.night ? b.dataset.v === 'night' : +b.dataset.v === S.stay)));
  const ask = $('#ask');
  ask.innerHTML = `<i class="ph ph-clock" aria-hidden="true"></i><span class="plan-txt"><b>${whenShort()}</b><span aria-hidden="true"> · </span>${stayShort()}</span><i class="ph ph-caret-${S.edit ? 'up' : 'down'} caret" aria-hidden="true"></i>`;
  ask.setAttribute('aria-label', `Parking ${S.night ? 'overnight' : stayWords(true)}, ${S.planned ? `from ${dayName(S.day)} ${fmtTime(S.hour)}` : 'from now'}, ${untilText()}. Change`);
  $('#planUntil').textContent = untilText();
}

// "Now" moves with the clock: every minute, and when the app comes back from the background. The map is
// recoloured when the quarter hour changes; the list and the card follow the minute.
function refreshNow() {
  const n = sydneyNow(), newDay = n.day !== today.day;
  Object.assign(today, n);
  if (newDay) buildDays();
  if (S.planned) { syncControls(); return; }
  const q0 = Math.floor(S.hour * 4), d0 = S.day;
  S.day = n.day; S.hour = n.hour; setNight();
  if (q0 !== Math.floor(S.hour * 4) || d0 !== S.day) update();
  else { syncControls(); if (!panelTouch && !body.contains(document.activeElement)) renderBody(); }
}
setInterval(() => { if (!document.hidden) refreshNow(); }, 60e3);

/* ---------- options list ---------- */
const body = $('#body');
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
  mel: 'In Melbourne, Streety covers the City of Melbourne\'s on-street parking (CBD, Southbank, Docklands, Carlton, North Melbourne, East Melbourne) from the council\'s parking zones, meter rates and live bay sensors, plus streets volunteers have mapped in OpenStreetMap around St Kilda, Chapel Street, Fitzroy, Collingwood, Richmond and Brunswick.',
  bne: 'In Brisbane, Streety covers every Brisbane City Council parking meter (CBD, Spring Hill, Fortitude Valley, South Brisbane, West End, Woolloongabba, Newstead, Milton…) plus no stopping lines, bus and taxi zones and clearways in the inner suburbs.',
  per: 'In Perth, Streety covers every City of Perth on-street parking bay (CBD, Northbridge, East Perth, West Perth, Crawley) and the City of Perth car parks.',
};
// Busyness is an estimate from the area and the day, so it's worded as "usually".
const BUSY_PLAIN = { easy: 'Usually spots free', moderate: 'Spots come and go', hard: 'Busy: hard to find a spot' };
let listScroll = null, listSheet = null; // where the list was when a card opened, to come back to it
let listAt = null; // the list's centre while a card is open (flying to a street mustn't reshuffle the list)
let loadError = '';
const FILTERS = [['all', 'All'], ['free', 'Free'], ['meters', 'Meters'], ['carparks', 'Car parks']];
// Sort key: price for the stay (to the dollar), then how sure Streety is, then the walk.
const byRank = (a, b) => Math.round(a.cost) - Math.round(b.cost) || a.cert - b.cert || a.d - b.d;
function kerbRow(o) {
  const c = o.c;
  if (!c.ok) return { ...o, kind: 'kerb', g: 'no', cost: Infinity, cert: 0 };
  if (c.permitOnly) return { ...o, kind: 'kerb', g: 'check', cost: 500, cert: 2 };
  if (c.likely || (c.cost === 0 && !c.unknownRate && guessed(o.p))) return { ...o, kind: 'kerb', g: 'guess', cost: 0, cert: 1 };
  if (c.unknownRate) return { ...o, kind: 'kerb', g: 'paid', cost: c.cost || 4, cert: 1 };
  return { ...o, kind: 'kerb', g: c.cost === 0 ? 'free' : 'paid', cost: c.cost, cert: 0 };
}
function cpRank(cp, d) {
  const price = carParkPrice(cp), pr = cp.kind === 'parkride';
  if (pr) return { kind: 'cp', cp, d, cost: 0, cert: 1 };
  if (price && !price.none) return { kind: 'cp', cp, d, cost: price.p, cert: 0 };
  const est = !price ? estimateFor(cp) : null;
  if (est) return { kind: 'cp', cp, d, cost: est.mid, cert: 1 };
  return { kind: 'cp', cp, d, cost: 1000, cert: 2 };
}
function renderList() {
  const keepScroll = body.dataset.mode === 'list' ? body.scrollTop : (listScroll ?? 0);
  listScroll = null;
  body.dataset.mode = 'list';
  requestAnimationFrame(() => { if (body.dataset.mode === 'list') body.scrollTop = Math.min(keepScroll, body.scrollHeight); });
  body.replaceChildren();
  if (!KERBS) {
    body.innerHTML = loadError ? `<div class="empty" role="alert"><strong>The parking rules didn't load</strong>Check your connection, then try again.<button type="button" class="cta retry" data-act="retry"><i class="ph ph-arrow-clockwise" aria-hidden="true"></i>Try again</button><small class="note">${loadError}</small></div>`
      : `<div class="empty"><strong>Loading the parking rules…</strong>Getting ${CITY.name}'s streets and car parks ready.</div>`;
    body.querySelector('[data-act=retry]')?.addEventListener('click', () => location.reload());
    return;
  }
  welcomeCard();
  const centre = S.dest ? S.dest.at : listAt || map.getCenter().toArray();
  const nearM = S.dest ? S.walk * WALK_M_PER_MIN : NEAR_M;
  destBar();
  sessionCard();
  const cpRadius = S.dest ? Math.max(400, nearM) : 1000;
  const cps = CARPARKS.length && !S.hidden.has('carpark') ? CARPARKS.map((cp) => ({ cp, d: distM(cp.at, centre) })).filter((x) => x.d < cpRadius).map((x) => cpRank(x.cp, x.d)) : [];
  const inCoverage = KERBS.features.some((f) => { const m = mids.get(f.properties.id); return Math.abs(m[0] - centre[0]) < 0.015 && Math.abs(m[1] - centre[1]) < 0.012; });
  if (!inCoverage) {
    drawDest(S.dest ? { free: [], paid: [], likely: [] } : null);
    body.insertAdjacentHTML('beforeend', CITY_ID !== 'syd' ? `<div class="empty"><strong>Not covered yet</strong>${COVER[CITY_ID]}</div>` : `<div class="empty"><strong>Not covered yet</strong>Streety covers the City of Sydney (CBD out to Newtown, Glebe, Surry Hills and Potts Point), the Eastern Suburbs (Bondi, Bronte, Bondi Junction, Rose Bay, Double Bay, Paddington, Coogee, Randwick, Maroubra), Manly, Chatswood, and the Inner West's meters in Balmain, Rozelle and Leichhardt. More councils are on the way. Transport for NSW Park&Ride car parks show across Sydney.</div>`);
    cps.sort(byRank).forEach((r) => body.appendChild(cpRow(r.cp, r.d)));
    return;
  }
  // Best kerb per street and side near the centre of the map (or the destination).
  const best = new Map();
  for (const f of KERBS.features) {
    const p = f.properties;
    if (p.k < 0 && !p.lk && !p.pa) continue;
    const d = distM(mids.get(p.id), centre);
    if (d > nearM) continue;
    const c = kerbCost(p);
    if (c.ok === null) continue; // only partly known (a clearway road): not a parking option
    const key = `${p.s}|${p.b}|${p.sd || ''}`;
    const score = (c.ok ? 0 : 1e6) + (c.ok ? c.cost * 40 : 0) + (c.unknownRate ? 400 : 0) + (c.likely ? 250 : 0) + (c.permitOnly ? 350 : 0) + d;
    const cur = best.get(key);
    if (!cur || score < cur.score) best.set(key, { f, p, c, d, score });
  }
  const kerbs = [...best.values()].map(kerbRow);
  const free = kerbs.filter((o) => o.g === 'free').sort(byRank), paid = kerbs.filter((o) => o.g === 'paid').sort(byRank), likely = kerbs.filter((o) => o.g === 'guess').sort(byRank);
  const no = kerbs.filter((o) => o.g === 'no').sort((a, b) => a.d - b.d);
  const ranked = [...kerbs.filter((o) => o.g !== 'no'), ...cps].sort(byRank);
  // The summary names the list's first row, whatever it is, in words that match how sure Streety is.
  const top = ranked[0];
  const sure = top && (top.g === 'guess' || top.cert > 0) ? ranked.find((r) => r.cert === 0 && (r.kind === 'cp' || r.g === 'free' || r.g === 'paid')) : null;
  const priceOf = (r) => (r.kind === 'cp' ? (r.cert ? `about ${money(r.cost)} (estimate)` : r.cp.kind === 'parkride' ? 'free with an Opal trip' : money(r.cost)) : r.g === 'free' ? 'free' : costText(r.c));
  const nameOf = (r) => (r.kind === 'cp' ? r.cp.name : r.p.s);

  const sum = document.createElement('p');
  sum.className = 'summary';
  const stayTxt = stayWords(true), from = S.dest ? ` from ${S.dest.name}` : '';
  if (!top) sum.innerHTML = S.dest ? `Nothing within a ${S.walk}-minute walk of ${S.dest.name} fits ${stayTxt}. Try a longer walk.` : 'No parking rules near the middle of the map. Move the map to a street with coloured lines.';
  else if (top.kind === 'kerb' && top.g === 'check') sum.innerHTML = `The council doesn't publish the signs ${S.dest ? `near ${S.dest.name}` : 'here'}. The streets nearby are resident permit areas, where visitors usually get 1 or 2 hours. Check the sign.`;
  else if (top.kind === 'kerb' && top.g === 'guess') sum.innerHTML = `<strong>${top.p.s}</strong> is probably free for ${stayTxt}, ${walkText(top.d)}${from}. Check the sign when you get there.`;
  else sum.innerHTML = `${top.cost < 0.005 ? 'Best' : 'Cheapest'} for ${stayTxt}: <strong>${nameOf(top)}</strong>${top.kind === 'cp' ? ' (car park)' : ''}, ${priceOf(top)}, ${walkText(top.d)}${from}.`;
  if (sure && sure !== top) sum.insertAdjacentHTML('beforeend', ` For a sure answer: <strong>${nameOf(sure)}</strong>, ${priceOf(sure)}, ${walkText(sure.d)}.`);
  body.appendChild(sum);
  compareLine(free, paid, centre, nearM);
  drawDest(S.dest ? { free, paid, likely } : null);

  // Filter chips: one list, narrowed when you want.
  if (S.filter === 'carparks' && !cps.length) S.filter = 'all';
  const fl = document.createElement('div'); fl.className = 'filters'; fl.setAttribute('role', 'group'); fl.setAttribute('aria-label', 'Show');
  const count = { all: ranked.length, free: free.length + likely.length, meters: paid.length, carparks: cps.length };
  fl.innerHTML = FILTERS.filter(([k]) => k !== 'carparks' || cps.length).map(([k, t]) => `<button type="button" data-filter="${k}" aria-pressed="${S.filter === k}">${t}<span class="num">${count[k]}</span></button>`).join('');
  fl.querySelectorAll('[data-filter]').forEach((b) => (b.onclick = () => { S.filter = b.dataset.filter; S.more = false; body.dataset.mode = ''; renderList(); }));
  body.appendChild(fl);

  if (S.filter === 'all') savedRows(centre);
  const shown = ranked.filter((r) => S.filter === 'all' || (S.filter === 'carparks' ? r.kind === 'cp' : r.kind === 'kerb' && (S.filter === 'free' ? r.g === 'free' || r.g === 'guess' : r.g === 'paid')));
  const LIMIT = 20, list = S.more ? shown : shown.slice(0, LIMIT);
  if (!list.length) body.insertAdjacentHTML('beforeend', `<p class="empty-row">Nothing ${S.filter === 'carparks' ? 'in car parks' : S.filter === 'free' ? 'free' : 'with a meter'} here for ${stayTxt}.</p>`);
  const ul = document.createElement('div'); ul.className = 'rows';
  for (const r of list) ul.appendChild(r.kind === 'cp' ? cpRow(r.cp, r.d) : optRow(r));
  body.appendChild(ul);
  if (shown.length > list.length) {
    const more = document.createElement('button'); more.type = 'button'; more.className = 'morebtn';
    more.textContent = `Show ${shown.length - list.length} more`;
    more.onclick = () => { S.more = true; renderList(); };
    body.appendChild(more);
  }
  if (no.length && S.filter !== 'carparks') {
    const h = document.createElement('h3'); h.className = 'group'; h.innerHTML = `<span>Can't park here for ${stayTxt}</span><span class="num">${no.length}</span>`; body.appendChild(h);
    const nl = document.createElement('div'); nl.className = 'rows';
    no.slice(0, 6).forEach((o) => nl.appendChild(optRow(o)));
    body.appendChild(nl);
  }
  const foot = document.createElement('div'); foot.className = 'foot';
  const upd = dataDate();
  foot.innerHTML = CITY_ID !== 'syd' ? `${FOOT[CITY_ID]}${upd ? ` Refreshed nightly, last on ${upd}.` : ''} Councils don't publish every sign, so the sign on the street always wins.` : `Rules come from council open data: the City of Sydney's ${META ? META.meters.toLocaleString() : ''} parking meters, Waverley's kerb-by-kerb parking survey, Woollahra's resident permit areas, Randwick's resident permit kerbs, Randwick's and Inner West's published parking maps and meter lists, and street sign surveys for Manly (2020) and Chatswood, refreshed nightly${upd ? `, last on ${upd}` : ''}. Councils don't publish every sign, so the sign on the street always wins.`;
  foot.insertAdjacentHTML('beforeend', ' <a href="./parking/">Parking by area</a> · <a href="./terms.html">Terms</a> · <a href="./privacy.html">Privacy</a> · <a href="https://www.instagram.com/getstreety/" target="_blank" rel="noopener">Instagram</a>');
  body.appendChild(foot);
}
const dataDate = () => (META ? new Date(META.fetchedAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: CITY.tz }) : '');

/* ---------- first open: one short welcome in the sheet, no sign-up ---------- */
const flag = (k) => { try { return localStorage.getItem(k) === '1'; } catch { return true; } };
const setFlag = (k) => { try { localStorage.setItem(k, '1'); } catch { /* private mode */ } };
function welcomeCard() {
  if (flag('streety-welcomed') || S.dest || LINK) return;
  const el = document.createElement('section'); el.className = 'welcome'; el.setAttribute('aria-labelledby', 'wTitle');
  el.innerHTML = `<h2 id="wTitle">Where are you driving to?</h2>
    <p>Streety shows where you can park for your stay, what it costs, and what the sign should say when you get there.</p>
    <button type="button" class="wsearch" data-welcome-search><i class="ph ph-magnifying-glass" aria-hidden="true"></i>Search a street or place</button>
    <div class="wrow"><button type="button" class="cta" data-welcome-near><i class="ph ph-crosshair" aria-hidden="true"></i>Near me</button><button type="button" class="cta quiet" data-welcome-skip>Just the map</button></div>
    <p class="note">No sign-up. Anything you save stays on this phone.</p>`;
  el.querySelector('[data-welcome-search]').onclick = () => { endWelcome(); q.focus(); };
  el.querySelector('[data-welcome-near]').onclick = () => { endWelcome(); locateMe(() => setEdit(true, 'stay')); };
  el.querySelector('[data-welcome-skip]').onclick = () => { endWelcome(); maybeLegend(); };
  body.appendChild(el);
}
function endWelcome() {
  if (flag('streety-welcomed')) return;
  setFlag('streety-welcomed');
  body.dataset.mode = '';
  renderList(); setPeek();
}
// The map key, once, after the first question is answered (never over a picker, a search or a dialog).
function maybeLegend() {
  if (flag('streety-legend') || !flag('streety-welcomed') || S.edit || DRIVE || document.querySelector('.snap') || document.activeElement === q) return;
  setFlag('streety-legend');
  toggleKey(true, true);
}

// What signs in this permit area usually say, from the council's decisions (never shown as the rule).
const usual = (p) => (p.pa && META?.permitPatterns ? META.permitPatterns[String(p.pa).replace(/^(permit\s*)?area\s*/i, '').trim().toUpperCase()] : null);
function usualHTML(p) {
  const u = usual(p);
  return u ? `<p class="plain"><b>Usually in ${p.pa}: ${u.sign}, permit holders excepted.</b> ${u.n} of the council's ${u.of} recent sign decisions in ${p.pa} say this, so it's the likely sign here. Streety hasn't seen this kerb's own sign, so check it before you leave the car.</p>` : '';
}
const TONE = { free: 'free', guess: 'likely', paid: 'paid', check: 'permit', no: 'restricted' };
function optRow(o) {
  const r = o.g ? o : kerbRow(o);
  const b = document.createElement('button'); b.type = 'button'; b.className = `opt g-${r.g}`;
  const cat = category(o.p, RULES, S.day, S.hour, S.stay);
  const s = stateAt(o.p, RULES, S.day, S.hour);
  const c = o.c;
  const sub = c.ok
    ? (c.yourPermit ? `Your permit area (${o.p.pa}): no time limit` : c.permitOnly ? (usual(o.p) ? `Permit ${o.p.pa}: usually ${usual(o.p).sign} for visitors` : `Resident permit ${o.p.pa}: visitors usually time-limited`) : c.likely ? 'No published sign. Check it when you park' : r.g === 'guess' ? `Probably free: ${s.why === 'before-hours' || s.why === 'night' ? `meters start at ${fmtTime(s.until)}` : s.why === 'no-meter-day' ? `no meters on ${DAYS_LONG[S.day]}s` : s.why === 'after-hours' ? 'the meters have finished' : 'no published rule for this time'}` : s.kind === 'meter' ? `${pLabel(s.rule[0])} meter until ${fmtTime(s.rule[3])}` : s.kind === 'limit' ? (s.rule[0] >= 24 || s.rule[0] < 0 ? `${s.rule[7] || 'Free'} until ${fmtTime(s.rule[3])}` : `Free ${pLabel(s.rule[0])} until ${fmtTime(s.rule[3])}`) : s.why === 'unrestricted' ? 'No time limit' : s.until < 24 ? `Free until ${fmtTime(s.until)}` : 'Free for the rest of the day')
    : c.why;
  const lv = busyLevel(busy(o.p, RULES, S.day, S.hour));
  const tone = r.g === 'no' ? (cat === 'short' ? 'short' : 'restricted') : TONE[r.g];
  const price = r.g === 'no' ? '<span class="price no">No</span>' : r.g === 'check' ? '<span class="price">Check</span>' : r.g === 'guess' ? '<span class="price guess">Free?</span>' : `<span class="price ${r.g === 'free' ? 'free' : ''}">${costText(c)}</span>`;
  const live = liveCount(o.p);
  b.innerHTML = `<span class="bar t-${tone}" aria-hidden="true"></span>
    <span class="mid"><span class="name">${o.p.s}</span><span class="sub">${[o.p.sd, o.p.b].filter(Boolean).join(', ')}${o.p.sd || o.p.b ? '. ' : ''}${sub}</span>${live ? `<span class="busyline livetag">${live.free} free now</span>` : c.ok && lv === 'hard' ? `<span class="busyline"><i class="ph ph-users-three" aria-hidden="true"></i>${BUSY_PLAIN.hard}</span>` : ''}</span>
    <span class="right">${price}<span class="walk">${walkText(o.d)}</span></span>`;
  b.onclick = () => select(o.p.id, true);
  return b;
}

function cpRow(cp, d) {
  const price = carParkPrice(cp);
  const b = document.createElement('button'); b.type = 'button'; b.className = 'opt g-cp';
  const pr = cp.kind === 'parkride', v = pr ? occAt(cp, S.day, S.hour) : null;
  const est = !price && !pr ? estimateFor(cp) : null;
  const sub = pr ? `Free with an Opal trip${v == null ? '' : v >= 95 ? ', usually full now' : `, usually ~${spacesLeft(cp, v)} spaces left`}` : price?.none ? (price.why === 'long' ? 'Price for this stay not published' : 'No rate for this time') : price ? price.k : est ? `Streety's estimate ${money(est.low)}-${money(est.high)}, not their real rates` : `Run by ${cp.operator || 'a private operator'}. Rates not published`;
  b.innerHTML = `<span class="bar t-cp" aria-hidden="true"><b>P</b></span><span class="mid"><span class="name">${cp.name}</span><span class="sub">Car park. ${sub}</span></span><span class="right">${pr ? '<span class="price free">Free</span>' : price && !price.none ? `<span class="price${price.p === 0 ? ' free' : ''}">${money(price.p)}</span>` : est ? `<span class="price est">~${money(est.mid)}</span>` : '<span class="price">Check</span>'}<span class="walk">${est ? 'estimate · ' : ''}${walkText(d)}</span></span>`;
  b.onclick = () => select(cp.id, true);
  return b;
}

/* ---------- saved places (kept on this phone only) ---------- */
// Streety ids change when the data is rebuilt, so a saved kerb is found again by street, side and position.
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
    const c = p.k < 0 && !p.lk && !permitMine(p.pa) ? { ok: null } : kerbCost(p);
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
// Closing a card goes back to the list where you left it. The destination stays until you clear it.
function closeCard() {
  S.sel = null;
  if (!isDesk()) setSheet(listSheet || 'peek');
  listSheet = null;
  update();
}
function destBar() {
  if (!S.dest) return;
  const el = document.createElement('div'); el.className = 'dest';
  el.innerHTML = `<div class="dest-top"><i class="ph-fill ph-map-pin" aria-hidden="true"></i><span>Near <b>${S.dest.name}</b></span><button type="button" class="iconx" data-act="cleardest" aria-label="Clear destination"><i class="ph ph-x"></i></button></div>
    <div class="walkseg" role="group" aria-label="Longest walk"><span>Walk up to</span>${[2, 5, 10, 15, 20].map((w) => `<button type="button" data-w="${w}" aria-pressed="${w === S.walk}">${w} min</button>`).join('')}</div>`;
  el.querySelector('[data-act=cleardest]').onclick = () => setDest(null);
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
  if (!kerb) el.innerHTML = `Cheapest published car park: <strong>${cp.cp.name}</strong>, ${money(cp.pr.p)} for ${stayWords(true)}.`;
  else if (cp.pr.p > kerb.cost) el.innerHTML = `The street saves you <strong>${money(cp.pr.p - kerb.cost)}</strong> on the cheapest car park (${cp.cp.name}, ${money(cp.pr.p)}).`;
  else if (cp.pr.p < kerb.cost) el.innerHTML = `<strong>${cp.cp.name}</strong> is cheaper than the street: ${money(cp.pr.p)}, saving ${money(kerb.cost - cp.pr.p)}.`;
  else el.innerHTML = `<strong>${cp.cp.name}</strong> is also ${money(cp.pr.p)} for ${stayWords(true)}.`;
  body.appendChild(el);
}

// How sure Streety is: the kerb's own sign (council data or a sign survey), a driver's sign photo, or Streety's
// reading of what the published signs leave out (meters finished for the night, no meter on Sundays).
// Data that lists every sign plate on the kerb (Melbourne's parking zones) is signed fact outside its times too;
// a council decision or a meter list only covers part of the sign, so outside it is a guess.
const INFER = new Set(['after-hours', 'before-hours', 'night', 'no-meter-day']);
const isPhoto = (set) => /sign photo|driver's reading/i.test(set?.src || '');
const allPlates = (set) => /parking zones/i.test(set?.src || '');
const isOsm = (set) => /openstreetmap/i.test(set?.src || '');
function guessed(p, day = S.day, h = S.hour, stay = S.stay) {
  const set = p.k >= 0 ? RULES[p.k] : null;
  if (!set || isPhoto(set)) return false;
  for (let t = h; t < h + stay - 1e-9; t = Math.floor(t * 4 + 1e-6) / 4 + 0.25) {
    const s = stateAt(p, RULES, (day + Math.floor(t / 24)) % 7, t % 24);
    if (s.kind === 'free' && (INFER.has(s.why) || (s.why === 'outside-sign' && set.g === 'edges' && !allPlates(set)))) return true;
  }
  return false;
}

// What a kerb costs for the chosen stay, including kerbs Streety only knows as a permit area or "probably free".
function kerbCost(p) {
  if (p.k >= 0) return costFor(p, RULES, S.day, S.hour, S.stay);
  if (p.lk) return { ok: true, cost: 0, likely: true };
  if (p.pa && permitMine(p.pa)) return { ok: true, cost: 0, yourPermit: true };
  return p.pa ? { ok: true, cost: 0, permitOnly: true } : { ok: null };
}

/* ---------- I parked here: where the car is, and when to move it ---------- */
// Uses the real clock, not the time picker. How long you can legally stay is worked out from the kerb's rules.
function parkedNow(f) {
  const now = sydneyNow(), p = f.properties;
  const legal = p.k >= 0 ? legalStay(p, now.day, now.hour) : null;
  if (legal === 0) { toast("You can't park here right now. Check the sign."); return; }
  const hours = legal == null ? S.stay : legal;
  // From the exact minute you parked: parked 7:16 on a 2P meter from 8am, move by 10am.
  const t0 = Math.floor(Date.now() / 60e3) * 60e3;
  const sess = { at: mids.get(p.id), name: p.s, side: p.sd || '', start: Date.now(), until: t0 + Math.round(hours * 60) * 60e3, legal: legal != null && legal < 24, planned: legal == null, ...proofFrom(p, now) };
  store.set('kerb-parked', sess);
  setSessionMarker(); parkedPill(); toast(legal != null && legal < 24 ? `Saved. Move by ${clockAt(sess.until)}.` : 'Saved where you parked.');
  try { if (sess.legal && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch { /* not supported */ }
  S.sel = null; update();
}
// The longest legal stay from this exact minute, to the minute (24 means no limit today). Signs change on quarter
// hours, so it steps to each quarter-hour end, then finds the minute a time limit runs out between two of them.
function legalStay(p, day, h) {
  let legal = 0;
  for (let end = Math.floor(h * 4 + 1e-6) / 4 + 0.25; end - h <= 24 + 1e-9; end += 0.25) {
    if (costFor(p, RULES, day, h, end - h).ok) legal = end - h; else break;
  }
  if (legal >= 24 - 1e-9) return 24;
  let best = legal;
  for (let m = 1; m < 15; m++) { const st = legal + m / 60; if (costFor(p, RULES, day, h, st).ok) best = st; else break; }
  return Math.round(best * 60) / 60;
}
const clockAt = (ms) => { const p = new Intl.DateTimeFormat('en-AU', { timeZone: CITY.tz, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date(ms)); const g = (t) => +(p.find((x) => x.type === t) || {}).value || 0; return fmtTime((g('hour') % 24) + g('minute') / 60); };
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
  const txt = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Streety//Sydney parking//EN', 'BEGIN:VEVENT', `UID:kerb-${s.start}@kerb`, `DTSTAMP:${z(Date.now())}`,
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
    <div class="note">${s.legal ? `Move by ${clockAt(s.until)}${sameDay ? '' : ` ${dayAt(s.until)}`}, when the sign's limit or a restriction starts.` : s.planned ? `Your planned stay ends at ${clockAt(s.until)}. Streety doesn't have the signs here, so check the sign.` : 'No limit for the rest of the day.'}</div>
    <div class="acts">
      <a class="cta" href="https://www.google.com/maps/dir/?api=1&destination=${s.at[1]},${s.at[0]}&travelmode=walking" target="_blank" rel="noopener"><i class="ph ph-person-simple-walk"></i>Walk back</a>
      ${s.legal || s.planned ? `<a class="cta" href="${icsFor(s)}" download="kerb-move-the-car.ics"><i class="ph ph-bell-ringing"></i>Remind me</a>` : ''}
      <button class="cta" type="button" data-act="proof"><i class="ph ph-shield-check"></i>${s.photo ? 'Proof' : 'Add proof'}</button>
      <button class="cta" type="button" data-act="done"><i class="ph ph-check"></i>I've left</button>
    </div>`;
  el.querySelector('[data-act=proof]').onclick = () => openProof(s, true);
  el.querySelector('[data-act=done]').onclick = () => { keepProof({ ...store.get('kerb-parked', s), left: Date.now() }); store.set('kerb-parked', null); setSessionMarker(); parkedPill(); renderList(); };
  body.appendChild(el);
}
// A small countdown on the map while you're parked, and a heads-up 10 minutes before you have to move.
function parkedPill() {
  const s = store.get('kerb-parked', null);
  let pill = $('#parkedPill');
  if (!s) { pill?.remove(); return; }
  if (!pill) {
    pill = document.createElement('button'); pill.type = 'button'; pill.id = 'parkedPill'; pill.className = 'parkedpill';
    pill.onclick = () => { S.sel = null; update(); setSheet('peek'); if (s.at) map.easeTo({ center: s.at, zoom: Math.max(map.getZoom(), 16) }); };
    $('#app').appendChild(pill);
  }
  const left = s.until - Date.now(), mins = Math.round(left / 60e3);
  const txt = !(s.legal || s.planned) ? 'Parked' : left <= 0 ? 'Time is up' : mins >= 60 ? `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m left` : `${mins} min left`;
  pill.classList.toggle('urgent', (s.legal || s.planned) && left < 15 * 60e3);
  pill.innerHTML = `<i class="ph-fill ph-car-simple" aria-hidden="true"></i><span><b>${txt}</b> · ${s.name}</span>`;
  if ((s.legal || s.planned) && left > 0 && left < 10 * 60e3 && !s.warned) {
    s.warned = true; store.set('kerb-parked', s);
    const msg = `Move the car: ${mins} min left on ${s.name}.`;
    toast(msg);
    try { navigator.vibrate?.([200, 100, 200]); } catch { /* not supported */ }
    try { if ('Notification' in window && Notification.permission === 'granted') new Notification('Streety', { body: msg, tag: 'kerb-move', icon: './icon-192.png' }); } catch { /* not allowed */ }
  }
}
setInterval(() => { parkedPill(); if (S.sel == null && store.get('kerb-parked', null)) renderList(); }, 30e3);
setTimeout(parkedPill, 1500);

/* ---------- Proof of parking: a record of where, when and what the sign said, in case a fine looks wrong ---------- */
// Kept on the phone only. Photos are the real evidence; Streety's map is a guide, so the record says so.
const PROOFS = 'streety-proofs';
const REVIEW_URL = 'https://www.nsw.gov.au/money-and-taxes/fines-and-fees/fines/request-a-review';
const plainText = (h) => String(h || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
function proofFrom(p, now) {
  const set = p.k >= 0 ? RULES[p.k] : null;
  return {
    sign: set ? plainText(set.text || '') : '',
    src: set ? (set.src || 'City of Sydney parking meter data') : '',
    said: plainText(p.k >= 0 || p.ps || p.pa ? plainNow(p, RULES, now.day, now.hour) : ''),
    city: CITY_ID,
  };
}
const whenText = (ms) => new Date(ms).toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: CITY.tz });
function keepProof(s) {
  if (!s?.start) return;
  // Newest first; keep 20 records, and photos only on the 8 newest so the phone's storage doesn't fill up.
  const list = [s, ...store.get(PROOFS, []).filter((x) => x.start !== s.start)].slice(0, 20).map((x, i) => (i < 8 ? x : { ...x, photo: undefined }));
  try { localStorage.setItem(PROOFS, JSON.stringify(list)); } catch { try { localStorage.setItem(PROOFS, JSON.stringify(list.map((x, i) => (i ? { ...x, photo: undefined } : x)))); } catch { /* storage full */ } }
}
function proofText(s) {
  return [
    `Parking record from Streety`,
    `Where: ${s.name}${s.side ? `, ${s.side.toLowerCase()}` : ''} (${s.at[1].toFixed(5)}, ${s.at[0].toFixed(5)})`,
    `Parked: ${whenText(s.start)}`,
    s.left ? `Left: ${whenText(s.left)}` : '',
    s.sign ? `Published sign: ${s.sign}${s.src ? ` (${s.src})` : ''}` : '',
    s.said ? `Streety said: ${s.said}` : '',
    s.photo ? 'A photo of the sign was taken at the time.' : '',
    `Map: https://www.google.com/maps/search/?api=1&query=${s.at[1]},${s.at[0]}`,
  ].filter(Boolean).join('\n');
}
function openProof(s, live) {
  const nsw = (s.city || 'syd') === 'syd';
  const el = document.createElement('div'); el.className = 'snap'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Proof of parking');
  el.innerHTML = `<div class="snap-card"><div class="snap-top"><b>Proof of parking</b><button type="button" class="snap-x" aria-label="Close"><i class="ph ph-x"></i></button></div>
    <div class="snap-body">
      <p class="snap-status"><b>${s.name}</b>${s.side ? `, ${s.side.toLowerCase()}` : ''}</p>
      <div class="proof-rows">
        <div><span>Parked</span><b>${whenText(s.start)}</b></div>
        ${s.left ? `<div><span>Left</span><b>${whenText(s.left)}</b></div>` : ''}
        ${s.sign ? `<div><span>Published sign</span><b>${s.sign}</b></div>` : ''}
        ${s.said ? `<div><span>Streety said</span><b>${s.said}</b></div>` : ''}
        <div><span>Spot</span><b class="num">${s.at[1].toFixed(5)}, ${s.at[0].toFixed(5)}</b></div>
      </div>
      <label class="rep-photo"><i class="ph ph-camera" aria-hidden="true"></i><span>${s.photo ? 'Photo saved. Tap to replace it' : 'Photograph the sign with your car in the shot'}</span><input type="file" accept="image/*" capture="environment" hidden></label>
      <img class="rep-preview" alt="Your photo of the sign" ${s.photo ? `src="${s.photo}"` : 'hidden'}>
      <p class="note">Got a fine you think is wrong? ${nsw ? 'You can ask Revenue NSW for a review.' : 'You can ask the council that issued it for a review.'} Your own photos, taken at the time, are the strongest evidence. Streety's map is a guide, not proof of what the sign said.${nsw ? ' Since July 2025 rangers in NSW must usually leave the fine on your car.' : ''}</p>
      ${nsw ? `<a class="cta" href="${REVIEW_URL}" target="_blank" rel="noopener"><i class="ph ph-scales"></i>How to ask for a review</a>` : ''}
    </div>
    <div class="snap-actions"><button type="button" class="snap-save">Share this record</button></div></div>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  el.querySelector('.snap-x').onclick = close;
  el.onclick = (e) => { if (e.target === el) close(); };
  const fi = el.querySelector('input[type=file]'), pv = el.querySelector('.rep-preview');
  fi.onchange = async () => {
    const f = fi.files?.[0]; if (!f) return;
    const photo = await shrinkPhoto(f); if (!photo) return;
    s.photo = photo; pv.src = photo; pv.hidden = false;
    el.querySelector('.rep-photo span').textContent = 'Photo saved. Tap to replace it';
    if (live && store.get('kerb-parked', null)?.start === s.start) {
      try { localStorage.setItem('kerb-parked', JSON.stringify(s)); } catch { toast("Your phone's storage is full, so the photo wasn't kept. It's still in your camera roll."); }
    } else keepProof(s);
  };
  el.querySelector('.snap-save').onclick = async () => {
    const text = proofText(s);
    try {
      const files = s.photo ? [new File([await (await fetch(s.photo)).blob()], 'parking-sign.jpg', { type: 'image/jpeg' })] : [];
      if (navigator.canShare?.({ text, files }) && files.length) await navigator.share({ title: 'Parking record', text, files });
      else if (navigator.share) await navigator.share({ title: 'Parking record', text });
      else { await navigator.clipboard.writeText(text); toast('Copied. Paste it into an email or your notes.'); }
    } catch (e) { if (e?.name !== 'AbortError') { try { await navigator.clipboard.writeText(text); toast('Copied. Paste it into an email or your notes.'); } catch { /* nothing more to try */ } } }
  };
}
function openProofList() {
  const list = store.get(PROOFS, []);
  const el = document.createElement('div'); el.className = 'snap'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Your parking records');
  el.innerHTML = `<div class="snap-card"><div class="snap-top"><b>Your parking records</b><button type="button" class="snap-x" aria-label="Close"><i class="ph ph-x"></i></button></div>
    <div class="snap-body">
      ${list.length ? `<div class="proof-list">${list.map((x, i) => `<button type="button" data-i="${i}"><span><b>${x.name}</b><small>${whenText(x.start)}</small></span>${x.photo ? '<i class="ph-fill ph-camera" aria-label="Has a photo"></i>' : ''}<i class="ph ph-caret-right" aria-hidden="true"></i></button>`).join('')}</div>`
        : '<p class="plain">No records yet. Tap "I parked here" on a street and Streety keeps where, when and what the sign said, so you have it if a fine turns up.</p>'}
      <p class="note">Records stay on this phone only. Streety keeps your last 20.</p>
      <a class="cta" href="${REVIEW_URL}" target="_blank" rel="noopener"><i class="ph ph-scales"></i>How to ask Revenue NSW for a review</a>
    </div></div>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  el.querySelector('.snap-x').onclick = close;
  el.onclick = (e) => { if (e.target === el) close(); };
  el.querySelectorAll('[data-i]').forEach((b) => (b.onclick = () => { close(); openProof(list[+b.dataset.i], false); }));
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
  if (c.yourPermit) return { head: 'Free for you: your permit area', why: `${p.pa} is your resident permit area, so the time limits for visitors don't apply to you. Display your permit. Meters, no parking and no stopping times on the sign still apply.` };
  if (c.ok === null) return c.partial ? { head: 'Check the sign', why: plainNow(p, RULES, S.day, S.hour) } : { head: 'No published rules', why: '' };
  // A resident permit street whose sign times aren't published: no meters, but visitors usually get a limit.
  if (c.permitOnly) return { head: 'No meters, check the sign for a time limit', why: `${p.pa} is a resident permit area. Visitors usually get a time limit here (often 1P or 2P), so check the sign.` };
  if (!c.ok) return { head: "You can't stay that long", why: '' };
  if (c.quarterFree) return { head: 'Free with a ticket', why: 'The first 15 minutes are free. Grab a ticket from the meter.' };
  const end = S.hour + S.stay;
  const EPS = 1e-6, partGuess = c.ok && c.freeHours > EPS && guessed(p);
  if (c.waived > EPS && c.paidHours < EPS) return { head: 'Free with your mobility permit', why: `The meter normally charges ${money(stateAt(p, RULES, S.day, S.hour).rule?.[4] || c.rate || 0)} an hour here. Mobility parking permit holders park free at council and street meters in NSW, and time limits over 30 minutes don't apply. Display the permit.` };
  if (c.paidHours < EPS) {
    const s = stateAt(p, RULES, S.day, S.hour);
    if (s.kind === 'limit' && (s.rule[0] >= 24 || s.rule[0] < 0)) return { head: `Free for you: ${(s.rule[7] || 'your bay').toLowerCase()}`, why: `${s.rule[7] || 'This bay'} ${s.rule[2] === 0 && s.rule[3] === 24 ? 'at all times' : `from ${fmtTime(s.rule[2])} to ${fmtTime(s.rule[3])}`}.${s.rule[0] < 0 ? ' Check the sign for any time limit.' : ''}` };
    if (s.kind === 'limit') return { head: 'Free, within the time limit', why: `It's a free ${pLabel(s.rule[0])} zone ${s.rule[2] === 0 && s.rule[3] === 24 ? 'at all times' : `from ${fmtTime(s.rule[2])} to ${fmtTime(s.rule[3])}`}, so your ${S.night ? 'night fits' : `${durWords(S.stay)} fit${S.stay > 1 + EPS ? '' : 's'}`}.${s.rule[7] ? ` ${s.rule[7]}.` : ''}` };
    if (s.why === 'unrestricted') return { head: 'Free, no time limit', why: 'Unrestricted parking. No sign limits this kerb.' };
    if (s.why === 'permit') return { head: 'Free for you: your permit area', why: `The sign's time limit has "permit holders excepted" for ${BEN.permit}, your resident permit area. Display your permit.` };
    if (s.why === 'outside-sign') return { head: 'Free the whole time', why: plainNow(p, RULES, S.day, S.hour) };
    const why = s.why === 'before-hours' || s.why === 'night'
      ? `The meters don't start until ${fmtTime(s.until)}, and you're gone by ${fmtTime(end)}.`
      : s.why === 'after-hours' ? `The meters have finished for ${DAYS_LONG[S.day]}.`
        : `There are no meter hours on ${DAYS_LONG[S.day]}s.`;
    return { head: 'Free the whole time', why };
  }
  if (c.unknownRate) return { head: c.freeHours > EPS && c.firstPaidAt > S.hour + EPS ? `Free until ${fmtTime(c.firstPaidAt)}, then pay at the meter` : 'Pay at the meter', why: `It's a metered kerb, but the council doesn't publish the rate. The meter shows it, and the Park'nPay app does too.` };
  // Part paid, part free: when the free part is only Streety's reading of the meter hours, say so.
  if (c.freeHours > EPS && c.firstPaidAt > S.hour + EPS) return { head: `${partGuess ? 'Probably free' : 'Free'} until ${fmtTime(c.firstPaidAt)}, then pay`, why: `The meter starts at ${fmtTime(c.firstPaidAt)}, so you pay for ${durWords(c.paidHours)} at ${money(c.rate)} an hour.${partGuess ? ' Before then is Streety\'s reading of the meter hours, not a sign, so check it.' : ''}` };
  if (c.freeHours > EPS) return { head: partGuess ? 'Pay, then probably free' : 'Pay, then free', why: `You pay ${money(c.rate)} an hour for ${durWords(c.paidHours)}, until the meter finishes.${partGuess ? ' After that it\'s probably free: the council doesn\'t publish later rules here, so check the sign.' : ' The rest is free.'}` };
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

function prDetail(cp) {
  const v = occAt(cp, S.day, S.hour), full = prFullBy(cp, S.day);
  const now = v == null ? '' : v >= 95
    ? `Usually full at ${fmtTime(S.hour)} on ${DAYS_LONG[S.day]}s.`
    : `Usually about ${spacesLeft(cp, v)} of ${cp.spots} spaces free at ${fmtTime(S.hour)} on ${DAYS_LONG[S.day]}s.`;
  return `<section class="sect"><h3 class="h3">How full it gets on ${DAYS_LONG[S.day]}s</h3>${occHTML(cp)}
      <p class="plain">${now}${full != null && (v == null || v < 95) ? ` It's usually full by ${fmtTime(full)}.` : ''}</p>
      <p class="note">From Transport for NSW's car park counters over the past week. Public holidays and school holidays will be quieter.</p></section>`;
}

/* ---------- report a wrong sign or price: sent from inside the app, no email ---------- */
// Reports go to Streety's server when it's switched on (VITE_REPORT_URL). Until then they wait on the phone and
// send themselves the next time the app opens with reporting on.
const REPORT_URL = import.meta.env.VITE_REPORT_URL || '';
const REPORT_Q = 'streety-reports';
async function flushReports() {
  if (!REPORT_URL) return 0;
  let q = store.get(REPORT_Q, []), sent = 0;
  for (const r of [...q]) {
    try { const ok = (await fetch(REPORT_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(r) })).ok; if (!ok) break; q = q.filter((x) => x !== r); sent++; } catch { break; }
  }
  store.set(REPORT_Q, q);
  return sent;
}
setTimeout(flushReports, 4000);
const shrinkPhoto = (file) => new Promise((ok) => {
  const img = new Image();
  img.onload = () => { const k = Math.min(1, 1280 / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(img.src); ok(c.toDataURL('image/jpeg', 0.8)); };
  img.onerror = () => ok(null);
  img.src = URL.createObjectURL(file);
});
function openReport(t) {
  const kinds = t.carpark
    ? [['price', 'The prices are wrong'], ['closed', "It's closed or gone"], ['place', "It's in the wrong place"], ['other', 'Something else']]
    : [['sign', 'The sign says something else'], ['nopark', "You can't park here"], ['price', 'The price is wrong'], ['name', 'Wrong street name'], ['other', 'Something else']];
  const el = document.createElement('div'); el.className = 'snap'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Report a problem');
  el.innerHTML = `<div class="snap-card"><div class="snap-top"><b>${t.carpark ? 'Report a problem' : 'Report a wrong sign'}</b><button type="button" class="snap-x" aria-label="Close"><i class="ph ph-x"></i></button></div>
    <div class="snap-body">
      <p class="snap-status">${t.title}. What's wrong?</p>
      <div class="rep-kinds" role="radiogroup">${kinds.map(([k, n], i) => `<button type="button" role="radio" data-k="${k}" aria-checked="${i === 0}">${n}</button>`).join('')}</div>
      <label class="rep-field"><span>What does the ${t.carpark ? 'board' : 'sign'} say? (optional)</span><textarea rows="3" maxlength="1000" placeholder="${t.carpark ? 'e.g. 1 hour $12, all day $35' : 'e.g. 2P 8am-6pm Mon-Fri, permit holders excepted'}"></textarea></label>
      <label class="rep-photo"><i class="ph ph-camera" aria-hidden="true"></i><span>Add a photo of the ${t.carpark ? 'price board' : 'sign'} (optional)</span><input type="file" accept="image/*" capture="environment" hidden></label>
      <img class="rep-preview" alt="" hidden>
      <p class="note">We use reports to fix the map for everyone. No name or account needed.</p>
    </div>
    <div class="snap-actions"><button type="button" class="snap-save">Send</button></div></div>`;
  document.body.appendChild(el);
  let kind = kinds[0][0], photo = null;
  const close = () => el.remove();
  el.querySelector('.snap-x').onclick = close;
  el.onclick = (e) => { if (e.target === el) close(); };
  el.querySelectorAll('[data-k]').forEach((b) => (b.onclick = () => { kind = b.dataset.k; el.querySelectorAll('[data-k]').forEach((x) => x.setAttribute('aria-checked', String(x === b))); }));
  const fi = el.querySelector('input[type=file]'), pv = el.querySelector('.rep-preview');
  fi.onchange = async () => { const f = fi.files?.[0]; if (!f) return; photo = await shrinkPhoto(f); if (photo) { pv.src = photo; pv.hidden = false; el.querySelector('.rep-photo span').textContent = 'Photo added. Tap to change it'; } };
  el.querySelector('.snap-save').onclick = async () => {
    const r = { kind, note: el.querySelector('textarea').value.trim(), photo, city: CITY_ID, target: t.carpark ? 'carpark' : 'kerb', id: t.id, title: t.title, at: t.at, published: t.published || '', app: 'streety-web', time: new Date().toISOString() };
    store.set(REPORT_Q, [...store.get(REPORT_Q, []), r]);
    const sent = await flushReports();
    close();
    toast(sent ? 'Thanks! Your report was sent.' : "Thanks! Saved on your phone. It'll send by itself once reports are switched on.");
  };
}

/* ---------- fines (NSW): what a mistake here costs, and how hard this council's rangers enforce ---------- */
let FINES = null, finesLoading = null;
function loadFines() {
  if (CITY_ID !== 'syd' || FINES || finesLoading) return;
  finesLoading = fetch(DATA + 'fines.json' + (META?.builtAt ? `?v=${encodeURIComponent(META.builtAt)}` : '')).then((r) => (r.ok ? r.json() : null)).then((j) => { FINES = j; if (j && typeof S.sel === 'number') renderDetail(); }).catch(() => {});
}
const FINE_FOR = [[/school/i, 83596], [/clearway/i, 82682], [/bus (zone|lane)/i, 82817], [/no stopping|yellow/i, 83595], [/no parking/i, 82740], [/loading/i, 82890], [/taxi/i, 83518], [/mobility|disab/i, 83517], [/motor ?(bike|cycle)/i, 83535], [/mail/i, 83631], [/truck/i, 83638]];
const fineAmt = (codes) => { const os = codes.map((c) => FINES?.offences?.[c]).filter(Boolean); if (!os.length) return null; const lo = Math.min(...os.map((o) => o.amounts[0])), hi = Math.max(...os.map((o) => o.amounts[1])); return lo === hi ? money(lo) : `${money(lo)}–${money(hi)}`; };
const inPoly = ([x, y], rings) => { let c = false; for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
function councilAt(pt) { return pt && FINES?.councils?.find((c) => inPoly(pt, c.rings)); }
function fineHTML(p, set, c) {
  if (CITY_ID !== 'syd') return '';
  if (!FINES) { loadFines(); return ''; }
  const rows = [];
  const seen = new Set();
  const add = (label, codes, now) => { const a = fineAmt(codes); if (a && !seen.has(label)) { seen.add(label); rows.push({ label, a, now }); } };
  const nowNote = c && c.ok === false ? String(c.why || '') : '';
  for (const r of mergeOvernight(set?.rules || [])) {
    if (r[6]) { const note = r[7] || 'No parking'; const hit = FINE_FOR.find(([re]) => re.test(note)); if (hit) add(`${note.replace(/\s*\(.*$/, '')}, ${r[2] === 0 && r[3] === 24 ? 'all day' : `${fmtTime(r[2])}-${fmtTime(r[3])}`} ${fmtDays(r[1]).replace(/^Every day$/, 'every day')}`, [hit[1]], nowNote.startsWith(note)); }
  }
  if (set?.rules.some((r) => r[0] > 0 && r[0] < 24)) add('Staying longer than the sign allows', [92362, 92363, 92352, 92353], /limit/i.test(nowNote));
  if (set?.rules.some((r) => r[4] !== 0)) add('Not paying the meter', [97244, 97245]);
  const cn = councilAt(mids.get(p.id));
  if (!rows.length && !cn) return '';
  const lv = cn ? { 'very high': 'restricted', high: 'paid', medium: 'limit', low: 'free' }[cn.level] : '';
  return `<div class="fines"><h3 class="h3">Fines here</h3>
    ${rows.length ? `<div class="fine-rows">${rows.slice(0, 5).map((x) => `<div class="fine-row${x.now ? ' now' : ''}"><span>${x.label}${x.now ? ' <b>(right now)</b>' : ''}</span><b>${x.a}</b></div>`).join('')}</div>` : ''}
    ${cn ? `<p class="plain"><span class="lvl" style="border-color:var(--${lv});background:color-mix(in srgb, var(--${lv}) 16%, transparent)">${cn.level[0].toUpperCase() + cn.level.slice(1)} ranger activity</span> ${cn.name} wrote ${cn.n.toLocaleString('en-AU')} parking fines in ${FINES.councilYear.replace('-20', '-')}, about ${cn.perKm2.toLocaleString('en-AU')} per square km (${cn.rank === 1 ? 'the most' : `number ${cn.rank}`} of ${FINES.of} Sydney councils).</p>` : ''}
    ${set?.rules.some((r) => r[4] !== 0) ? `<p class="plain"><i class="ph ph-device-mobile" aria-hidden="true"></i> Paying by app? Some council apps add a service fee on top of the price on the sign. Paying at the meter, or with the NSW Government's Park'nPay app where the council takes it (it says it adds no fees), costs just the sign's price.</p>` : ''}
    <button type="button" class="linkbtn" data-act="proofs"><i class="ph ph-shield-check" aria-hidden="true"></i>Got a fine? Your parking records and how to ask for a review</button>
    <p class="note">Fine amounts from Revenue NSW's ${FINES.fineYear.replace('-20', '-')} penalty data (they usually go up a little each July). Two amounts mean it depends on the area. Fines by council from Revenue NSW open data.</p></div>`;
}

// The first screenful of a card answers "can I park here, what does it cost, why, how sure is Streety, how do I
// get there", in that order. The sign to look for, fines, the week and busyness follow below.
const VICON = { est: 'ph ph-question', free: 'ph-fill ph-check-circle', guess: 'ph ph-question', paid: 'ph ph-currency-dollar', check: 'ph ph-warning', no: 'ph-fill ph-prohibit' };
const spanShort = () => `${S.planned ? `${S.day === today.day ? 'today' : S.day === (today.day + 1) % 7 ? 'tomorrow' : DAYS[S.day]} ` : ''}${fmtTime(S.hour)} to ${fmtTime((S.hour + S.stay) % 24)}${S.hour + S.stay >= 24 ? ` ${DAYS[(S.day + 1) % 7]}` : ''}`;
const forStay = () => `For ${S.night ? 'the night' : stayWords(true)}, ${spanShort()}`;
function verdictHTML({ g, word, big, sub }) {
  return `<div class="verdict v-${g}" role="group" aria-label="${plainText(`${word}${big && big !== word ? ` ${big}` : ''}. ${sub}`)}">
    <span class="vicon" aria-hidden="true"><i class="${VICON[g]}"></i></span>
    <span class="vtext"><span class="vword">${big || word}</span><span class="vsub">${big && big !== word ? `${word}. ` : ''}${sub}</span></span></div>`;
}
const SRC_NAME = { syd: 'City of Sydney meter data', mel: 'City of Melbourne data', bne: 'Brisbane City Council data', per: 'City of Perth data' };
const isoDate = (iso) => { const d = iso && new Date(`${iso}T12:00:00`); return d && !isNaN(d) ? d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : ''; };
function trustHTML(kind, text) {
  const ic = { signed: 'ph-seal-check', photo: 'ph-camera', guess: 'ph-question' }[kind];
  return `<p class="trust t-${kind}"><i class="ph ${ic}" aria-hidden="true"></i><span>${text}</span></p>`;
}
// The source in plain words, with a date only when it's the data's own (a decision's date, a photo's date, or a
// live council feed Streety reads every night). A survey from 2020 never looks freshly checked.
function kerbTrust(p, g) {
  const set = p.k >= 0 ? RULES[p.k] : null;
  if (set && isPhoto(set)) return trustHTML('photo', `From a driver's sign photo, ${isoDate(/(\d{4}-\d\d-\d\d)/.exec(set.src)?.[1]) || 'recently'}. Check it matches.`);
  if (p.lk) return trustHTML('guess', "Streety's guess: no permit scheme here, and the council doesn't publish its signs. Check the sign.");
  if (!set) return trustHTML('guess', "The council doesn't publish this sign. Check it before you leave the car.");
  const src = (set.src || SRC_NAME[CITY_ID]).replace(/\s*\((open data|open data, CC BY)\)/i, '');
  const live = /open data/i.test(set.src || SRC_NAME[CITY_ID]) && !/survey|\d{4}/i.test(set.src || '') ? dataDate() : '';
  if (isOsm(set)) return trustHTML('guess', 'From OpenStreetMap volunteer mapping, not the council. Check the sign.');
  if (g === 'guess') return trustHTML('guess', `Streety's guess from ${src}. Check the sign.`);
  if (g === 'check') return trustHTML('guess', `${src} doesn't cover this time. Check the sign.`);
  if (g === 'paid' && guessed(p)) return trustHTML('guess', `Meter from ${src}. The free part is Streety's guess, so check the sign.`);
  return trustHTML('signed', `From ${src}${live ? `, checked ${live}` : ''}`);
}
function kerbVerdict(p, c, g, v) {
  const sub = forStay();
  if (g === 'no') {
    const word = /limit/i.test(c.why || '') ? `Can't stay ${S.night ? 'overnight' : stayWords(true).replace('an hour', '1 hour')}` : String(c.why || 'No parking').replace(/\s+(\d|midnight|noon).*$/, '').replace(/^\w/, (x) => x.toUpperCase());
    return { g, word, sub: `${c.why}. ${sub}` };
  }
  if (g === 'check') return { g, word: 'Check the sign', sub: c.permitOnly ? `Resident permit area: visitors usually get 1 or 2 hours. ${sub}` : sub };
  if (g === 'guess') return { g, word: 'Probably free', sub };
  if (g === 'free') return { g, word: c.quarterFree ? 'Free with a ticket' : c.waived > 1e-6 && c.paidHours < 1e-6 ? 'Free with your permit' : c.yourPermit ? 'Free in your permit area' : 'Free', sub };
  return { g: 'paid', word: v.head, big: c.unknownRate && !(c.cost > 0) ? '' : costText(c), sub };
}
// Why Streety thinks a kerb is free when no sign says so, in hedged words (never as fact).
function guessWhy(p) {
  const set = RULES[p.k];
  for (let t = S.hour; t < S.hour + S.stay - 1e-9; t = Math.floor(t * 4 + 1e-6) / 4 + 0.25) {
    const d = (S.day + Math.floor(t / 24)) % 7, s = stateAt(p, RULES, d, t % 24);
    if (s.kind !== 'free') continue;
    if (s.why === 'after-hours') return `The meters finish before you get there, and the council doesn't publish any night rules here, so it's probably free.`;
    if (s.why === 'before-hours' || s.why === 'night') return `The meters don't start until ${fmtTime(s.until)}, and the council doesn't publish what applies before then, so it's probably free.`;
    if (s.why === 'no-meter-day') return `There are no meters here on ${DAYS_LONG[d]}s, and the council doesn't publish other ${DAYS_LONG[d]} rules, so it's probably free.`;
    if (s.why === 'outside-sign' && set.g === 'edges' && !allPlates(set)) return `The published sign doesn't cover this time${s.until < 24 ? ` (it starts again at ${fmtTime(s.until)})` : ''}, so there's probably no limit.`;
  }
  return '';
}
function whyLine(p, c, g, v) {
  const end = fmtTime((S.hour + S.stay) % 24);
  if (g === 'guess' && !p.lk && p.k >= 0) { const t = guessWhy(p); if (t) return `${t} You leave at ${end}.`; }
  if (g === 'no') { const t = plainNow(p, RULES, S.day, S.hour); return /can't park/i.test(t) ? t : `${t} You'd be there until ${end}.`; }
  let t = v.why || plainNow(p, RULES, S.day, S.hour);
  if (c.ok && !/gone by|you leave/i.test(t)) t += ` You leave at ${end}.`;
  return t + (p.f15 ? ' Free 15-minute zone: a ticket gets you the first quarter hour free.' : '');
}
// Car parks: the price for your stay, Streety's estimate, or "check the board".
function cpVerdict(cp, price) {
  const sub = forStay();
  if (cp.kind === 'parkride') return { v: { g: 'free', word: 'Free', sub: 'With a public transport trip, up to 18 hours' }, trust: trustHTML('signed', 'Transport for NSW Park&Ride') };
  const checked = cp.checked ? new Date(cp.checked).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const trust = cp.fromPhoto ? trustHTML('photo', `From your photo of the price board, ${isoDate(cp.fromPhoto) || cp.fromPhoto}`)
    : checked ? trustHTML('signed', `Rates checked ${checked}${cp.rateSource ? ` on <a href="${cp.rateSource}" target="_blank" rel="noopener">the ${cp.operator || 'owner'}'s website</a>` : ''}. The board at the entrance wins.`)
      : trustHTML('signed', 'Published rates. The board at the entrance wins.');
  if (price && !price.none) return { v: { g: price.p === 0 ? 'free' : 'paid', word: price.k, big: money(price.p), sub }, trust };
  if (price?.none) {
    if (price.why === 'long') for (let s = Math.min(S.stay, 24) - 0.25; s >= 0.25; s -= 0.25) {
      const q = carParkPrice(cp, S.day, S.hour, s);
      if (q && !q.none) return { v: { g: 'check', word: `${stayWordsFor(s)} at most`, big: money(q.p), sub: `You picked ${stayWords(true)}. The longest stay from ${fmtTime(S.hour)} is ${stayWordsFor(s)}.` }, trust };
    }
    return { v: { g: 'check', word: price.why === 'long' ? 'Not for that long' : 'No rate at this time', sub }, trust };
  }
  const e = estimateFor(cp);
  if (e) return { v: { g: 'est', word: "Streety's estimate", big: `~${money(e.mid)}`, sub: `Probably ${money(e.low)} to ${money(e.high)}. ${sub}` }, trust: trustHTML('guess', `Not their real price: ${cp.operator ? `${cp.operator} doesn't let us publish its rates` : 'the rates aren\'t published'}. The board at the entrance wins.`) };
  return { v: { g: 'check', word: 'Check the board', sub: `${cp.operator ? `Run by ${cp.operator}. ` : ''}The rates aren't published anywhere we can use yet.` }, trust: trustHTML('guess', 'Rates not published') };
}

function renderDetail() {
  const f = typeof S.sel === 'number' ? byId.get(S.sel) : null;
  const cp = !f && CARPARKS.find((c) => c.id === S.sel);
  if (!f && !cp) { S.sel = null; renderList(); return; }
  body.replaceChildren();
  const d = document.createElement('div'); d.className = 'detail';
  const head = `<div class="dhead"><button class="back" type="button"><i class="ph ph-arrow-left" aria-hidden="true"></i>All options</button><button class="dclose" type="button" aria-label="Close this card"><i class="ph ph-x"></i></button></div>`;
  if (f) {
    const p = f.properties;
    const c = kerbCost(p);
    const set = p.k >= 0 ? RULES[p.k] : null;
    const lv = busyLevel(busy(p, RULES, S.day, S.hour));
    const v = verdictText(p, c);
    const g = c.ok === null ? 'check' : kerbRow({ p, c, d: 0 }).g;
    const suburb = p.b && !/side$/i.test(p.b) ? p.b : '';
    const extra = [p.pa ? `Permit ${p.pa}` : '', p.n ? `about ${p.n} ${p.k >= 0 ? 'paid ' : ''}space${p.n === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
    d.innerHTML = `${head}
      <div class="dtitle"><h2>${p.s}</h2><div class="where">${[p.sd, suburb].filter(Boolean).join(' · ') || 'This side of the street'}</div></div>
      ${liveCount(p) ? `<div class="live"><i class="ph-fill ph-broadcast" aria-hidden="true"></i><span><b>${liveText(liveCount(p))}</b><small>Live from the council's in-ground sensors, ${Math.max(1, Math.round((Date.now() - LIVE_AT) / 60000))} min ago</small></span></div>` : ''}
      ${verdictHTML(kerbVerdict(p, c, g, v))}
      <p class="why">${whyLine(p, c, g, v)}</p>
      ${kerbTrust(p, g)}
      ${actionsHTML(kerbMid(f), p.id)}
      <section class="arrive" aria-labelledby="arriveH">
        <h3 class="h3" id="arriveH">${set ? 'When you arrive, check the sign says' : 'When you arrive, check the sign'}</h3>
        ${set ? `<div class="plates big">${set.src ? (set.u ? '<p class="plain">No signs. Unrestricted parking.</p>' : mergeOvernight(set.rules).map(rulePlate).join('')) : set.text.split(';').filter((x) => x.trim()).map(plateHTML).join('')}</div>`
          : `${usualHTML(p)}<p class="plain">${p.lk ? `Based on ${p.lks || 'Woollahra Council\'s resident permit areas'}: streets outside a permit scheme are usually unrestricted, but the council doesn't publish its signs.` : p.ps ? `Permit area from the ${p.ps}. The council doesn't publish the sign times, so visitors should check the sign for the time limit.` : 'Streety only shows rules the council publishes. This side of the street has no published signs yet.'}</p>
        <button type="button" class="snapcta" id="snapHere"><i class="ph-fill ph-camera" aria-hidden="true"></i><span><b>Snap the sign here</b><small>Streety reads it, tells you if you can park, and fills in this kerb.</small></span></button>`}
        <p class="note">The sign on the street always wins.${extra ? ` ${extra.replace(/^\w/, (x) => x.toUpperCase())}.` : ''}</p>
        ${set ? '<button type="button" class="linkbtn" id="snapHere" data-act="snap"><i class="ph ph-camera" aria-hidden="true"></i>Sign looks different? Snap it</button>' : ''}
      </section>
      ${fineHTML(p, set, c)}
      ${set ? `<section class="sect"><h3 class="h3">Across the week</h3>${weekHTML(p)}</section>
      <section class="sect"><h3 class="h3">Finding a spot ${S.planned ? `${DAYS[S.day]} ${fmtTime(S.hour)}` : 'now'}: ${BUSY_PLAIN[lv].replace(/^Busy: /, '').toLowerCase()}</h3>${busyHTML(p)}
      <p class="note">An estimate from the area, the day and the time limits, not live counts.</p></section>
      <p class="note">Source: ${set.src ? `${set.src}${/survey|committee|map|photo|decision|reading/i.test(set.src) ? '' : ' parking survey'}${set.text ? `. Recorded as "${set.text}"` : ''}` : SRC_NAME[CITY_ID]}. Councils update signs from time to time, so the sign on the street always wins.</p>` : ''}
      ${streetViewHTML(p, mids.get(p.id))}
      <div class="photos" id="signPhotos" hidden></div>
      <button type="button" class="reportcta" id="reportBtn"><i class="ph ph-flag" aria-hidden="true"></i>Report a wrong sign</button>`;
  } else {
    const price = carParkPrice(cp);
    const { v, trust } = cpVerdict(cp, price);
    const e = !price && cp.kind !== 'parkride' ? estimateFor(cp) : null;
    d.innerHTML = `${head}
      <div class="dtitle"><h2>${cp.name}</h2><div class="where">${[cp.address, cp.entry ? `Entry from ${cp.entry}` : ''].filter(Boolean).join(' · ') || 'Car park'}</div></div>
      ${verdictHTML(v)}
      ${cp.kind === 'parkride' ? '<p class="why">Tap on and off a train, bus, ferry or light rail trip with the same Opal or bank card, then tap out as you leave. Fees apply if you don\'t travel or stay longer than 18 hours.</p>' : price?.none ? `<p class="why">${price.why === 'long' ? 'Longer stays aren\'t allowed or aren\'t published, so check the board at the entrance.' : 'It may be closed then, or the rate isn\'t published. Check the board at the entrance.'}</p>` : ''}
      ${trust}
      ${actionsHTML(cp.at, cp.id)}
      ${cp.kind === 'parkride' && cp.occ ? prDetail(cp) : ''}
      ${e ? `<p class="plain">This estimate comes from what car parks nearby charge for the same time (${e.from.join(', ')}), adjusted for how the council's street meters here compare with theirs${e.meter ? ` (about ${money(e.meter)}/hr here)` : ''}.${S.stay >= 5 || S.night ? ` For a full day, Sydney car parks average ${NRMA_DAY}.` : ''}</p><p class="note">Busy CBD car parks often charge more, and early bird or online deals can be cheaper.</p>` : ''}
      ${cp.rates?.length ? `<section class="sect"><h3 class="h3">Rates${cp.fromPhoto ? ' from your photo' : ''}</h3>${rateBoard(cp)}</section>` : ''}
      ${cp.kind === 'parkride' ? '' : `<button type="button" class="snapcta" data-snapboard="${cp.id}"><i class="ph-fill ph-camera" aria-hidden="true"></i><span><b>${cp.rates?.length ? 'Prices changed? Snap the board' : 'Snap the price board'}</b><small>At the entrance? Photograph the prices and Streety fills them in.</small></span></button>`}
      ${cp.spots ? `<p class="plain">${cp.spots} spaces.</p>` : ''}
      ${cp.hours ? `<p class="plain">Open ${cp.hours}.</p>` : ''}
      ${cp.note ? `<p class="plain">${cp.note}</p>` : ''}
      ${cp.hospital ? `<div class="concession"><i class="ph ph-first-aid-kit" aria-hidden="true"></i><span><b>Here often for treatment, or caring for a patient?</b> NSW public hospitals have concession parking for patients and carers who come often or for a long stay, and for people in financial hardship. Before you leave, take your ticket, photo ID and any concession card to the hospital's parking office and ask for the concession rate. <a href="https://www.service.nsw.gov.au/referral/claim-concession-car-parking-at-nsw-health-public-hospitals" target="_blank" rel="noopener">How it works</a></span></div>` : ''}
      ${cp.phone ? `<p class="plain">Phone <a class="num" href="tel:${String(cp.phone).replace(/[^\d+]/g, '')}">${cp.phone}</a></p>` : ''}
      ${cp.url && !cp.rates?.length ? `<a class="cta" href="${cp.url}" target="_blank" rel="noopener"><i class="ph ph-arrow-square-out" aria-hidden="true"></i>Rates on ${cp.operator || 'the operator'}'s website</a>` : ''}
      ${/2016/.test(cp.source || '') ? '<p class="note">From Transport for NSW\'s 2016 list of CBD car parks, so the operator or hours may have changed.</p>' : ''}
      <button type="button" class="reportcta" id="reportBtn"><i class="ph ph-flag" aria-hidden="true"></i>Report a problem with this car park</button>`;
  }
  body.appendChild(d);
  // Stay where you were when the same card just refreshes (time or stay changed); jump to the top for a new one.
  if (body.dataset.mode !== `detail:${S.sel}`) body.scrollTop = 0;
  body.dataset.mode = `detail:${S.sel}`;
  if (f) loadSignPhotos(f, d.querySelector('#signPhotos'));
  d.querySelector('.back').onclick = closeCard;
  d.querySelector('.dclose').onclick = closeCard;
  const id = S.sel;
  const title = f ? `${f.properties.s}${f.properties.sd ? `, ${f.properties.sd.toLowerCase()}` : ''}` : cp.name;
  d.querySelector('[data-act=directions]').onclick = (e) => { if (e.currentTarget.tagName !== 'A') directions(f ? kerbMid(f) : cp.at, title); };
  d.querySelector('[data-act=save]').onclick = (e) => { toggleSaved(id); const on = isSaved(id); e.currentTarget.setAttribute('aria-pressed', String(on)); e.currentTarget.innerHTML = starInner(on); };
  d.querySelector('[data-act=share]').onclick = () => shareSel(f, cp);
  const pk = d.querySelector('[data-act=park]'); if (pk) pk.onclick = () => parkedNow(f);
  const pb = d.querySelector('[data-act=proofs]'); if (pb) pb.onclick = openProofList;
  const rb = d.querySelector('#reportBtn');
  if (rb) rb.onclick = () => (f
    ? openReport({ id: f.properties.id, title, at: mids.get(f.properties.id), published: f.properties.k >= 0 ? RULES[f.properties.k]?.text || '' : '' })
    : openReport({ carpark: true, id: cp.id, title: cp.name, at: cp.at }));
}

const starInner = (on) => `<i class="ph${on ? '-fill' : ''} ph-star" aria-hidden="true"></i>${on ? 'Saved' : 'Save'}`;
// A link out to Google Street View at this kerb, facing the kerb, so drivers can read the sign themselves.
// It's only a link (Google Maps URLs need no key and cost nothing); Streety never copies anything from Street View.
const SIDE_BEARING = { North: 0, 'North-east': 45, East: 90, 'South-east': 135, South: 180, 'South-west': 225, West: 270, 'North-west': 315 };
function streetViewHTML(p, at) {
  if (!at) return '';
  const [lon, lat] = at.map((v) => +v.toFixed(6));
  const h = SIDE_BEARING[String(p.sd || '').replace(/ side$/i, '')];
  const url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lon}${h != null ? `&heading=${h}` : ''}`;
  return `<a class="snapcta" href="${url}" target="_blank" rel="noopener"><i class="ph-fill ph-binoculars" aria-hidden="true"></i><span><b>Check the sign in Street View</b><small>Opens Google Street View at this kerb. Photos can be a few years old, so the sign on the street wins.</small></span></a>`;
}
// One Directions button. The first tap asks which app (Google Maps, Apple Maps or Waze) and remembers it; My car
// changes it. It always navigates to the middle of the kerb itself, never to the street name or suburb.
const NAV = {
  google: { name: 'Google Maps', url: ([lon, lat]) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving` },
  apple: { name: 'Apple Maps', url: ([lon, lat]) => `https://maps.apple.com/?daddr=${lat},${lon}&dirflg=d` },
  waze: { name: 'Waze', url: ([lon, lat]) => `https://waze.com/ul?ll=${lat},${lon}&navigate=yes` },
};
const navApp = () => { try { const v = localStorage.getItem('streety-nav'); return NAV[v] ? v : ''; } catch { return ''; } };
const setNavApp = (v) => { try { if (v) localStorage.setItem('streety-nav', v); else localStorage.removeItem('streety-nav'); } catch { /* private mode */ } };
const appleFirst = () => /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
// The point halfway along the kerb's line (the average of its ends can sit off a curved kerb).
function kerbMid(f) {
  const c = f.geometry.coordinates;
  let total = 0; const seg = [];
  for (let i = 1; i < c.length; i++) { const l = distM(c[i - 1], c[i]); seg.push(l); total += l; }
  let half = total / 2;
  for (let i = 0; i < seg.length; i++) {
    if (half <= seg[i] && seg[i] > 0) { const k = half / seg[i]; return [c[i][0] + (c[i + 1][0] - c[i][0]) * k, c[i][1] + (c[i + 1][1] - c[i][1]) * k].map((v) => +v.toFixed(6)); }
    half -= seg[i];
  }
  return mids.get(f.properties.id);
}
function directions(at, title) {
  const app = navApp();
  if (app) { window.open(NAV[app].url(at), '_blank', 'noopener'); return; }
  const keys = appleFirst() ? ['apple', 'google', 'waze'] : ['google', 'apple', 'waze'];
  const el = document.createElement('div'); el.className = 'snap'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'navT');
  el.innerHTML = `<div class="snap-card navpick"><div class="snap-top"><b id="navT">Open directions in</b><button type="button" class="snap-x" aria-label="Close"><i class="ph ph-x"></i></button></div>
    <div class="snap-body"><p class="snap-status">To <b>${title}</b>. Streety remembers your choice. You can change it in My car.</p>
      <div class="navlist">${keys.map((k) => `<a class="navopt" data-nav="${k}" href="${NAV[k].url(at)}" target="_blank" rel="noopener"><span>${NAV[k].name}</span><i class="ph ph-arrow-square-out" aria-hidden="true"></i></a>`).join('')}</div>
    </div></div>`;
  document.body.appendChild(el);
  const back = document.activeElement;
  const close = () => { el.remove(); removeEventListener('keydown', esc); back?.focus?.(); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  addEventListener('keydown', esc);
  el.querySelector('.snap-x').onclick = close;
  el.onclick = (e) => { if (e.target === el) close(); };
  el.querySelectorAll('[data-nav]').forEach((a) => (a.onclick = () => { setNavApp(a.dataset.nav); setTimeout(() => { close(); renderBody(); }, 50); }));
  el.querySelector('.navopt').focus();
}
function actionsHTML(at, id) {
  const on = isSaved(id), app = navApp(), kerb = typeof id === 'number';
  at = at.map((v) => +v.toFixed(6));
  return `<div class="actions">
      ${app ? `<a class="primary" data-act="directions" href="${NAV[app].url(at)}" target="_blank" rel="noopener"><i class="ph-fill ph-navigation-arrow" aria-hidden="true"></i><span>Directions</span><small>${NAV[app].name}</small></a>`
    : '<button type="button" class="primary" data-act="directions"><i class="ph-fill ph-navigation-arrow" aria-hidden="true"></i><span>Directions</span></button>'}
      <div class="acts2${kerb ? ' three' : ''}">
        ${kerb ? '<button class="cta" type="button" data-act="park"><i class="ph ph-car-simple" aria-hidden="true"></i>I parked here</button>' : ''}
        <button class="cta" type="button" data-act="save" aria-pressed="${on}">${starInner(on)}</button>
        <button class="cta" type="button" data-act="share"><i class="ph ph-share-network" aria-hidden="true"></i>Share</button>
      </div>
    </div>`;
}
async function shareSel(f, cp) {
  const stayTxt = stayWords(false);
  const when = `${stayTxt} from ${DAYS[S.day]} ${fmtTime(S.hour)}`;
  let at, text;
  if (f) {
    const p = f.properties; at = mids.get(p.id);
    const c = kerbCost(p);
    const v = verdictText(p, c);
    const g = c.ok === null ? 'check' : kerbRow({ p, c, d: 0 }).g;
    text = `${p.s}${p.sd ? ` (${p.sd.toLowerCase()})` : ''}: ${g === 'guess' ? 'probably free, check the sign' : g === 'free' ? 'free' : v.head}${g === 'paid' ? `, ${costText(c)}` : ''} for ${when}.`;
  } else {
    at = cp.at;
    const occ = cp.kind === 'parkride' ? occAt(cp, S.day, S.hour) : null;
    text = `${cp.name}${cp.kind === 'parkride' ? `: free with an Opal trip${occ == null ? '' : occ >= 95 ? ', usually full by now' : `, usually ~${spacesLeft(cp, occ)} spaces left`}` : ''} (${when}).`;
  }
  const url = `${location.origin}${location.pathname}#at=${at[1].toFixed(5)},${at[0].toFixed(5)}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Streety', text, url });
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

let pendingFit = null;
// Show the selected kerb (or car park) in the map left above the card and below the top bar, clear of the chips.
// Runs once the card's height is known. A kerb you tapped on the map only moves if it ended up hidden.
function fitSel(force) {
  const id = S.sel;
  if (id == null || !map.isStyleLoaded()) return;
  const coords = typeof id === 'number' ? byId.get(id)?.geometry.coordinates : [CARPARKS.find((c) => c.id === id)?.at].filter(Boolean);
  if (!coords?.length) return;
  const desk = isDesk(), H = map.getCanvas().clientHeight, W = map.getCanvas().clientWidth;
  const pad = desk ? { top: 90, bottom: 60, left: Math.round(panel.getBoundingClientRect().right) + 40, right: 70 } : { top: 76, bottom: Math.min(px('--vis') + (root.classList.contains('sheet-tall') ? 16 : 64), H - 76 - 70), left: 36, right: 64 };
  if (!force && coords.every((c) => { const q = map.project(c); return q.x > pad.left - 20 && q.x < W - pad.right + 20 && q.y > pad.top && q.y < H - pad.bottom; })) return;
  const xs = coords.map((c) => c[0]), ys = coords.map((c) => c[1]);
  map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: pad, maxZoom: Math.max(Math.min(map.getZoom(), 17.5), 16.5), duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 600 });
}
function select(id, fly) {
  // Remember where the list was, so Back returns to the same row.
  if (S.sel == null && body.dataset.mode === 'list') { listScroll = body.scrollTop; listSheet = sheet; listAt = listAt || map.getCenter().toArray(); }
  S.sel = id;
  // Like Google Maps: a tapped street opens as a card at the bottom, tall enough to show its answer and Directions,
  // with the map still in view above it. Swipe up for the rest.
  if (id != null && !isDesk()) { if (S.edit) setEdit(false); setSheet('peek'); }
  if (id != null) pendingFit = { force: !!fly };
  update();
}

/* ---------- legend ---------- */
function renderLegend() {
  const lg = $('#legend'); lg.replaceChildren();
  const chip = (cls, pressed, html, title, onclick) => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.setAttribute('aria-pressed', String(pressed)); b.innerHTML = html; b.title = title; b.onclick = onclick; lg.appendChild(b); return b; };
  const cpOn = !S.hidden.has('carpark');
  chip('perm', cpOn, `Car parks${cpOn ? '' : ' off'}`, 'Show or hide car parks', () => { cpOn ? S.hidden.add('carpark') : S.hidden.delete('carpark'); renderLegend(); drawCarParks(); renderBody(); });
  const carBits = [BEN.vehicle === 'moto' ? 'Motorbike' : BEN.vehicle === 'ev' ? 'Electric' : '', BEN.permit ? `Permit ${BEN.permit.replace(/^.*Area\s*/i, '')}` : '', BEN.mps ? 'Mobility' : ''].filter(Boolean);
  chip('perm', carBits.length > 0, `${carBits.length ? carBits.join(' · ') : 'My car'}`, 'My car: vehicle, resident permit, mobility permit', () => toggleCar());
  chip('perm', !!DRIVE, `${DRIVE ? 'Driving' : 'Drive'}`, 'Drive mode: Streety follows you and says where to park', () => (DRIVE ? stopDrive() : startDrive()));
  chip('keybtn', false, 'Key', 'Map key: what the lines mean', () => toggleKey());
}
// My car: the answers change to fit the driver (motorbike bays, EV bays, their own permit area, mobility permit).
function saveCar() {
  try { const car = JSON.parse(localStorage.getItem('kerb-car') || '{}'); car.vehicle = BEN.vehicle; car.permits = { ...(car.permits || {}), [CITY_ID]: BEN.permit }; localStorage.setItem('kerb-car', JSON.stringify(car)); } catch { /* private mode */ }
}
function toggleCar(force) {
  let pop = $('#carPop');
  if (pop && force !== true) { pop.remove(); return; }
  $('#keyPop')?.remove();
  if (!pop) { pop = document.createElement('div'); pop.id = 'carPop'; pop.className = 'keypop carpop'; $('#app').appendChild(pop); }
  const areas = [...new Set(KERBS.features.map((f) => f.properties.pa).filter((a) => a && !/^area cbd$/i.test(a)))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const veh = [['car', 'Car', 'car-profile'], ['moto', 'Motorbike', 'motorcycle'], ['ev', 'Electric car', 'lightning']];
  pop.innerHTML = `<div class="kp-top"><b>My car</b><button type="button" aria-label="Close"><i class="ph ph-x"></i></button></div>
    <div class="seg" role="radiogroup" aria-label="Vehicle">${veh.map(([k, n, ic]) => `<button type="button" role="radio" data-veh="${k}" aria-checked="${BEN.vehicle === k}"><i class="ph ph-${ic}"></i>${n}</button>`).join('')}</div>
    ${areas.length ? `<label class="kp-field"><span>Resident parking permit</span><select id="permitSel"><option value="">None</option>${areas.map((a) => `<option${a === BEN.permit ? ' selected' : ''}>${a}</option>`).join('')}</select></label>` : ''}
    ${CITY_ID === 'syd' ? `<label class="kp-row"><i class="ph ph-wheelchair" style="background:none;width:auto;height:auto;font-size:18px"></i><span>NSW mobility parking permit</span><input type="checkbox" id="mpsBox"${BEN.mps ? ' checked' : ''}></label>` : ''}
    <label class="kp-field"><span>Directions open in</span><select id="navSel"><option value="">Ask me each time</option>${Object.entries(NAV).map(([k, n]) => `<option value="${k}"${navApp() === k ? ' selected' : ''}>${n.name}</option>`).join('')}</select></label>
    <p class="kp-note">Streety then shows motorbike or EV bays as yours, your permit area without visitor time limits, and mobility permit concessions. Saved on this phone only.</p>`;
  pop.querySelector('#navSel').onchange = (e) => { setNavApp(e.target.value); if (S.sel != null) renderDetail(); };
  pop.querySelector('.kp-top button').onclick = () => pop.remove();
  pop.querySelectorAll('[data-veh]').forEach((b) => (b.onclick = () => { BEN.vehicle = b.dataset.veh; saveCar(); pop.querySelectorAll('[data-veh]').forEach((x) => x.setAttribute('aria-checked', String(x === b))); renderLegend(); update(); }));
  const sel = pop.querySelector('#permitSel'); if (sel) sel.onchange = () => { BEN.permit = sel.value; saveCar(); renderLegend(); update(); };
  const mb = pop.querySelector('#mpsBox'); if (mb) mb.onchange = () => { BEN.mps = mb.checked; try { localStorage.setItem('kerb-mps', BEN.mps ? '1' : '0'); } catch { /* private mode */ } renderLegend(); update(); };
}
// The map key, out of the way until asked for (and shown once on first open). Each line is drawn with the same
// pattern as on the map, so it works without colour. Each state can still be hidden from here.
const KEY_LINE = {
  free: ['--free', 5, '', 'round'], likely: ['--free', 4, '10 3 3 3', 'butt'], paid: ['--paid', 4.5, '12 4', 'butt'],
  short: ['--paid', 3, '4 4', 'butt'], restricted: ['--restricted', 3, '0.1 5', 'round'], permit: ['--permit', 3, '6 6', 'butt'],
};
const keySwatch = (k) => { const [c, w, d, cap] = KEY_LINE[k]; return `<svg class="ksw" viewBox="0 0 44 12" aria-hidden="true"><line x1="4" y1="6" x2="40" y2="6" style="stroke:var(${c});stroke-width:${w};stroke-linecap:${cap}${d ? `;stroke-dasharray:${d}` : ''}"/></svg>`; };
function toggleKey(force, intro) {
  let pop = $('#keyPop');
  if (pop && force !== true) { pop.remove(); return; }
  $('#carPop')?.remove();
  if (!pop) { pop = document.createElement('div'); pop.id = 'keyPop'; pop.className = 'keypop'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-labelledby', 'kpT'); $('#app').appendChild(pop); }
  const WHAT = { free: 'Free for your whole stay', likely: 'Probably free: check the sign', paid: 'Meter: you pay ($ marks up close)', short: 'Time limit shorter than your stay', restricted: 'No parking or no stopping', permit: 'Resident permit area: visitors time-limited' };
  pop.innerHTML = `<div class="kp-top"><b id="kpT">${intro ? 'What the lines mean' : 'Map key'}</b><button type="button" class="iconx" aria-label="Close"><i class="ph ph-x"></i></button></div>${Object.keys(KEY_LINE).map((k) => `<label class="kp-row">${keySwatch(k)}<span>${WHAT[k]}</span>${intro ? '' : `<input type="checkbox" data-k="${k}"${S.hidden.has(k) ? '' : ' checked'} aria-label="Show ${WHAT[k]}">`}</label>`).join('')}
    <p class="kp-note">${intro ? 'Lines change with your day, time and stay. The sign on the street always wins.' : 'Untick a line to hide it from the map.'}</p>${intro ? '<button type="button" class="snap-save" data-act="keydone">Got it</button>' : ''}`;
  pop.querySelector('.kp-top button').onclick = () => pop.remove();
  pop.querySelector('[data-act=keydone]')?.addEventListener('click', () => pop.remove());
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
  // A card shows its whole first screenful: the answer, why, how sure, and the Directions row. The list shows its
  // one-line answer and the best option (or the welcome, the first time).
  const card = body.dataset.mode?.startsWith('detail');
  const target = card ? body.querySelector(innerHeight < 740 ? '.detail .actions .primary' : '.detail .actions') : body.querySelector('.welcome') || body.querySelector('.rows .opt') || body.querySelector('.summary, .empty');
  const avail = px('--sheet-h') - dock - 22;
  let extra = 64;
  if (target) extra = Math.round(target.getBoundingClientRect().bottom - body.getBoundingClientRect().top + body.scrollTop + (card ? 16 : 6));
  extra = Math.max(64, Math.min(extra, card || body.querySelector('.welcome') ? avail : Math.min(avail, innerHeight * 0.42)));
  root.style.setProperty('--peek', `${Math.round(dock + 22 + extra)}px`);
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
  const vis = Math.round(visibleHeight(state === 'open' ? 'peek' : state));
  root.style.setProperty('--vis', `${vis}px`);
  // A tall sheet (the picker, a long card) leaves no room for the camera and satellite buttons above it.
  root.classList.toggle('sheet-tall', !isDesk() && vis > innerHeight - 330);
  // A popup that floats above the sheet (the map key) would hang in the air once the sheet covers the map.
  if (state === 'open') document.querySelector('.keypop')?.remove();
  const fb = $('#fullBtn');
  if (fb) { fb.setAttribute('aria-pressed', String(state === 'min')); fb.innerHTML = state === 'min' ? '<i class="ph ph-arrows-in-simple"></i>' : '<i class="ph ph-arrows-out-simple"></i>'; fb.setAttribute('aria-label', state === 'min' ? 'Show the options' : 'Full screen map'); }
}
(() => {
  // One drag model for the handle, the dock and the list: the panel follows the finger, the map buttons ride
  // on its top edge (never left floating), and on release it settles on the nearest of open / peek / min
  // (or one step in the direction of a flick).
  const offFor = (state) => panel.offsetHeight - visibleHeight(state);
  let drag = null, justDragged = false;
  const begin = (y) => {
    drag = { y0: y, start: offFor(sheet), last: y, lastT: performance.now(), v: 0, moved: false };
    document.querySelector('.keypop')?.remove();
  };
  const move = (y) => {
    if (!drag) return false;
    const dy = y - drag.y0;
    if (!drag.moved && Math.abs(dy) < 6) return false;
    if (!drag.moved) { drag.moved = true; panel.classList.add('dragging'); root.classList.add('sheet-drag'); }
    const now = performance.now();
    drag.v = 0.7 * drag.v + 0.3 * ((y - drag.last) / Math.max(1, now - drag.lastT)); drag.last = y; drag.lastT = now;
    const off = Math.min(offFor('min'), Math.max(0, drag.start + dy));
    panel.style.transform = `translateY(${off}px)`;
    // Map buttons follow the sheet's top edge, but never higher than where they sit when the sheet peeks.
    root.style.setProperty('--vis', `${Math.round(Math.min(panel.offsetHeight - off, visibleHeight('peek')))}px`);
    return true;
  };
  const finish = (y, tapToggles) => {
    if (!drag) return;
    const d = drag; drag = null;
    panel.classList.remove('dragging'); root.classList.remove('sheet-drag'); panel.style.transform = '';
    if (!d.moved) { if (tapToggles) setSheet(sheet === 'open' ? 'peek' : 'open'); else setSheet(sheet); return; }
    justDragged = true; setTimeout(() => { justDragged = false; }, 350);
    const off = d.start + ((y ?? d.last) - d.y0), order = ['open', 'peek', 'min'];
    let target;
    if (Math.abs(d.v) > 0.45) { // a flick goes one step in its direction
      const i = order.indexOf(sheet), j = d.v > 0 ? Math.min(2, i + 1) : Math.max(0, i - 1);
      target = order[j];
    } else target = order.map((st) => [st, Math.abs(offFor(st) - off)]).sort((a, b) => a[1] - b[1])[0][0];
    setSheet(target);
  };
  // A drag that started on a button (like the "Parking 2 hours" row) must not also count as a tap on it.
  panel.addEventListener('click', (e) => { if (justDragged) { e.stopPropagation(); e.preventDefault(); justDragged = false; } }, true);
  // Handle and the dock: anything but the controls you type or slide on.
  const grab = [$('#handle'), $('#dock')];
  for (const el of grab) {
    el.addEventListener('pointerdown', (e) => {
      if (isDesk() || e.button > 0 || (el.id === 'dock' && e.target.closest('input, select, textarea, button, a, label, .setup'))) return;
      begin(e.clientY);
      try { el.setPointerCapture(e.pointerId); } catch { /* not supported */ }
    });
    el.addEventListener('pointermove', (e) => { if (move(e.clientY)) e.preventDefault(); });
    el.addEventListener('pointerup', (e) => finish(e.clientY, el.id === 'handle'));
    // The browser took the gesture over (or the finger left): settle from the last place we saw it.
    el.addEventListener('pointercancel', () => finish(null, false));
    el.addEventListener('lostpointercapture', () => { if (drag) finish(null, false); });
  }
  // The list: when the sheet is lowered, dragging it moves the sheet (like a native bottom sheet); when it's
  // open, pulling down from the top of the list lowers it, and anything else scrolls the list.
  const list = $('#body');
  let ty = null, tx = 0, mode = null; // mode: null (undecided), 'sheet', 'scroll'
  list.addEventListener('touchstart', (e) => { panelTouch = true; ty = e.touches[0].clientY; tx = e.touches[0].clientX; mode = null; }, { passive: true });
  list.addEventListener('touchmove', (e) => {
    if (isDesk() || ty == null) return;
    const y = e.touches[0].clientY, dy = y - ty, dx = e.touches[0].clientX - tx;
    if (!mode) {
      if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return;
      if (Math.abs(dx) > Math.abs(dy)) mode = 'scroll'; // sideways: a chip row or carousel
      else if (sheet !== 'open') mode = 'sheet';
      else mode = list.scrollTop <= 0 && dy > 0 ? 'sheet' : 'scroll';
      if (mode === 'sheet') begin(ty);
    }
    if (mode === 'sheet') { move(y); e.preventDefault(); }
  }, { passive: false });
  const tEnd = (e) => {
    panelTouch = false;
    if (mode === 'sheet') finish(e.changedTouches[0]?.clientY ?? null, false);
    ty = null; mode = null;
    if (pendingList) { pendingList = false; if (S.sel == null) renderList(); }
  };
  list.addEventListener('touchend', tEnd); list.addEventListener('touchcancel', tEnd);
  $('#fullBtn').addEventListener('click', () => setSheet(sheet === 'min' ? 'peek' : 'min'));
  $('#satBtn').addEventListener('click', () => setSat(!S.sat));
})();
let pendingList = false;

/* ---------- keep the page pinned on phones (iOS can scroll or zoom the whole page after the keyboard) ---------- */
// The app box must never scroll: when a tapped card got focus, browsers scrolled it to show the card, which
// lifted the sheet off its place, left the map buttons hanging and made the handle stop responding.
{ const app = $('#app'); app.addEventListener('scroll', () => { if (app.scrollTop || app.scrollLeft) { app.scrollTop = 0; app.scrollLeft = 0; } }); }
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
document.addEventListener('visibilitychange', () => { if (!document.hidden) { settle(); fitCanvas(); map.triggerRepaint(); refreshNow(); } });
addEventListener('pageshow', () => { settle(); refreshNow(); });
map.on('webglcontextlost', () => toast('The map paused. It will come back in a moment.'));
map.on('webglcontextrestored', () => { restyleBase(); if (KERBS) { kerbLayers(); cpLayers(); destLayers(); recolour(); } if (S.sat) setSat(true); });

/* ---------- search ---------- */
// Suggestions start at the second letter: streets and car parks Streety knows appear instantly,
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
  if (!flag('streety-welcomed')) setFlag('streety-welcomed');
  setDest({ at: item.at, name: item.sub && item.kind === 'street' ? `${item.title}, ${item.sub}` : item.title });
  // Then ask when, right there in the sheet (one tap on Now, or a day and a time).
  setEdit(true, 'arrive');
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
// Location is only asked for when you tap the locate button or "Near me".
function locateMe(then) {
  if (!navigator.geolocation) return toast("This browser can't share your location.");
  navigator.geolocation.getCurrentPosition((pos) => {
    const at = [pos.coords.longitude, pos.coords.latitude];
    { const other = !inBox(at, CITY.box) && Object.keys(CITIES).find((k) => inBox(at, CITIES[k].box)); if (other) { toast(`Opening Streety for ${CITIES[other].name}…`); goToCity(other, at); return; } }
    if (!meMarker) { const el = document.createElement('div'); el.className = 'me-dot'; meMarker = new maplibregl.Marker({ element: el }); }
    meMarker.setLngLat(at).addTo(map);
    map.flyTo({ center: at, zoom: 16.2, duration: 900 });
    then?.();
  }, () => { toast('Location is off. Allow location for this site to use it.'); maybeLegend(); }, { enableHighAccuracy: true, timeout: 10000 });
}
$('#locate').onclick = () => locateMe();

/* ---------- drive mode: the map follows you and a voice says where you can park ahead ---------- */
// Uses the real clock. Looks for kerbs within ~350 m, ahead of you (from your heading), that fit your stay:
// free first, then the cheapest meter. Speaks when the best one changes, at most every 25 seconds.
let DRIVE = null;
const bearingOf = (a, b) => { const k = Math.cos((a[1] * Math.PI) / 180); return (Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) * 180) / Math.PI; };
function say(text) {
  try { if (!('speechSynthesis' in window)) return; speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = 'en-AU'; u.rate = 1.02; speechSynthesis.speak(u); } catch { /* no voice */ }
}
function startDrive() {
  if (!navigator.geolocation) return toast("This browser can't share your location.");
  DRIVE = { at: null, heading: null, best: null, saidAt: 0, saidKey: '', lock: null, hud: document.createElement('div') };
  DRIVE.hud.className = 'drivehud'; DRIVE.hud.innerHTML = '<div class="dh-row"><div class="dh-main"><b>Finding your location…</b><small>Drive mode</small></div><button type="button" class="dh-stop" aria-label="Stop drive mode"><i class="ph ph-x"></i></button></div>';
  DRIVE.hud.querySelector('.dh-stop').onclick = stopDrive;
  // Once: the law on phones while driving. Learner and P-plate drivers can't touch a phone at all.
  if (!flag('streety-drive-note')) {
    const law = CITY_ID === 'syd'
      ? 'In NSW, learner and P-plate drivers can\'t touch a phone at all while driving, even in a cradle. Full licence holders can only use one in a fixed cradle, for navigation.'
      : 'Learner and P-plate drivers usually can\'t touch a phone at all while driving. Full licence holders can only use one in a fixed cradle, for navigation.';
    DRIVE.hud.insertAdjacentHTML('beforeend', `<div class="dh-note" role="note"><p><b>Set up your trip before you drive.</b> ${law} Streety speaks, so you don't need to look.</p><button type="button" class="dh-ok">Got it</button></div>`);
    DRIVE.hud.querySelector('.dh-ok').onclick = (e) => { setFlag('streety-drive-note'); e.currentTarget.parentElement.remove(); };
  }
  $('#app').appendChild(DRIVE.hud);
  $('#app').classList.add('driving');
  setSheet('min');
  try { navigator.wakeLock?.request('screen').then((l) => { if (DRIVE) DRIVE.lock = l; else l.release(); }).catch(() => {}); } catch { /* not supported */ }
  say("Drive mode on. I'll tell you where you can park near you.");
  DRIVE.watch = navigator.geolocation.watchPosition(onDrivePos, (e) => {
    // Only a refusal ends drive mode; a slow or lost GPS fix (tunnels, car parks) just waits for the next one.
    if (e.code === 1) { toast('Location is off. Allow location for this site to use drive mode.'); stopDrive(); return; }
    if (DRIVE) DRIVE.hud.querySelector('.dh-main').innerHTML = '<b>Waiting for GPS…</b><small>Drive mode</small>';
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
  renderLegend();
}
function stopDrive() {
  if (!DRIVE) return;
  try { navigator.geolocation.clearWatch(DRIVE.watch); } catch { /* ignore */ }
  try { DRIVE.lock?.release(); } catch { /* ignore */ }
  try { speechSynthesis.cancel(); } catch { /* ignore */ }
  DRIVE.hud.remove(); $('#app').classList.remove('driving');
  DRIVE = null; setSheet('peek'); renderLegend();
}
function onDrivePos(pos) {
  if (!DRIVE) return;
  const at = [pos.coords.longitude, pos.coords.latitude];
  if (DRIVE.at && distM(DRIVE.at, at) > 8) DRIVE.heading = Number.isFinite(pos.coords.heading) && pos.coords.speed > 1 ? pos.coords.heading : bearingOf(DRIVE.at, at);
  if (!DRIVE.at || distM(DRIVE.at, at) > 8) DRIVE.at = at;
  if (!meMarker) { const el = document.createElement('div'); el.className = 'me-dot'; meMarker = new maplibregl.Marker({ element: el }); }
  meMarker.setLngLat(at).addTo(map);
  map.easeTo({ center: at, zoom: Math.max(map.getZoom(), 16.4), duration: 800 });
  // What's around, for a stay starting now.
  const now = sydneyNow();
  const opts = [];
  for (const f of KERBS.features) {
    const p = f.properties, m = mids.get(p.id);
    if (!m || Math.abs(m[1] - at[1]) > 0.004 || Math.abs(m[0] - at[0]) > 0.005) continue;
    const d = distM(at, m);
    if (d > 350 || d < 15) continue;
    let ahead = 0;
    if (DRIVE.heading != null) { const diff = Math.abs(((bearingOf(at, m) - DRIVE.heading + 540) % 360) - 180); if (diff > 70) continue; ahead = diff; }
    const c = p.k >= 0 ? costFor(p, RULES, now.day, now.hour, S.stay) : p.pa && permitMine(p.pa) ? { ok: true, cost: 0 } : null;
    if (!c || !c.ok || c.unknownRate) continue;
    // Which side: Australians drive on the left, so a kerb on the left is the easy one.
    let side = '';
    if (DRIVE.heading != null) { const rel = ((bearingOf(at, m) - DRIVE.heading + 540) % 360) - 180; side = rel < -10 ? 'left' : rel > 10 ? 'right' : ''; }
    opts.push({ p, d, c, side, score: d + ahead * 2 + (c.cost > 0 ? 400 + c.cost * 30 : 0) + (side === 'right' ? 60 : 0) });
  }
  opts.sort((a, b) => a.score - b.score);
  const best = opts[0];
  const main = DRIVE.hud.querySelector('.dh-main');
  if (!best) { main.innerHTML = `<b>Nothing that fits ${stayWords(true)} right here</b><small>Keep driving: Streety is watching ${DRIVE.heading == null ? 'around you' : 'the streets ahead'}.</small>`; return; }
  const guess = best.c.cost === 0 && guessed(best.p, now.day, now.hour);
  const what = best.c.cost === 0 ? (guess ? 'Probably free' : 'Free') : `${money(best.c.cost)}`;
  const m100 = Math.max(20, Math.round(best.d / 10) * 10);
  main.innerHTML = `<b>${what} · ${best.p.s}</b><small>${m100} m ahead${best.side ? ` on your ${best.side}` : ''} · ${stayWords(true)}</small>`;
  const key = `${best.p.s}|${best.p.sd || ''}|${what}`;
  if (key !== DRIVE.saidKey && Date.now() - DRIVE.saidAt > 25000) {
    DRIVE.saidKey = key; DRIVE.saidAt = Date.now();
    say(`${best.c.cost === 0 ? (guess ? 'Probably free parking' : 'Free parking') : `Parking for ${money(best.c.cost).replace('$', '')} dollars`} on ${best.p.s}, about ${m100} metres ahead${best.side ? ` on your ${best.side}` : ''}.`);
  }
}

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3500); }

/* ---------- update loop ---------- */
let raf = 0;
let lastMode = '';
function renderBody() {
  try { S.sel != null ? renderDetail() : renderList(); } finally {
    const m = `${body.dataset.mode || ''}|${!!body.querySelector('.welcome')}|${!!body.querySelector('.rows .opt')}|${!!body.querySelector('.dest')}|${navApp()}`;
    if (m !== lastMode) { lastMode = m; if (!isDesk()) setPeek(); }
    if (pendingFit && S.sel != null) { const f = pendingFit; pendingFit = null; requestAnimationFrame(() => fitSel(f.force)); }
  }
}
function update(light) {
  syncControls();
  if (raf) cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    raf = 0;
    recolour();
    if (map.getLayer('kerb-sel')) map.setFilter('kerb-sel', ['==', ['get', 'id'], typeof S.sel === 'number' ? S.sel : -1]);
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
    const hit = map.queryRenderedFeatures([[e.point.x - 16, e.point.y - 16], [e.point.x + 16, e.point.y + 16]], { layers: KERB_LAYERS.filter((l) => map.getLayer(l)) })[0];
    cb(e.lngLat.toArray(), hit ? hit.properties.id : null);
    return;
  }
  if (map.getLayer('cp-pill') && map.queryRenderedFeatures(e.point, { layers: ['cp-cluster', 'cp-pill', 'cp-sel'] }).length) return;
  // A 32 px box around the finger, nearest kerb first (a fingertip covers more than a thin line).
  const hits = map.queryRenderedFeatures([[e.point.x - 16, e.point.y - 16], [e.point.x + 16, e.point.y + 16]], { layers: KERB_LAYERS.filter((l) => map.getLayer(l)) });
  if (hits.length) {
    // The kerb whose line passes closest to the finger (not the one whose middle is closest).
    const toLine = (id) => {
      const c = byId.get(id)?.geometry.coordinates || [];
      let best = Infinity;
      for (let i = 1; i < c.length; i++) {
        const a = map.project(c[i - 1]), b = map.project(c[i]), dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, ((e.point.x - a.x) * dx + (e.point.y - a.y) * dy) / l2)) : 0;
        best = Math.min(best, Math.hypot(a.x + t * dx - e.point.x, a.y + t * dy - e.point.y));
      }
      return best;
    };
    hits.sort((a, b) => toLine(a.properties.id) - toLine(b.properties.id));
    select(hits[0].properties.id, false);
  } else if (S.sel != null) closeCard();
});
for (const l of KERB_LAYERS) {
  map.on('mouseenter', l, () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', l, () => (map.getCanvas().style.cursor = ''));
}
// Touching the map means you want the map: lower a raised sheet and fold the questions away.
map.on('dragstart', () => {
  listAt = null; // you moved the map yourself: the list follows it again
  if (isDesk()) return;
  if (S.edit) setEdit(false);
  if (sheet === 'open') setSheet('peek');
});
let moveTimer = null;
map.on('zoomstart', (e) => { if (e.originalEvent) listAt = null; });
map.on('moveend', () => { clearTimeout(moveTimer); moveTimer = setTimeout(() => { if (S.sel != null) return; if (panelTouch) pendingList = true; else renderList(); }, 120); });

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { restyleBase(); if (KERBS) { kerbLayers(); cpLayers(); destLayers(); } if (S.sat) setSat(true); });
addEventListener('resize', () => setPeek());

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
const dataReady = loadData().catch((e) => { loadError = e.message; renderList(); setPeek(); throw e; });
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
  city: CITY_ID,
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
  // Sign readings other drivers shared, straight onto the streets (no photos), when the server is on.
  { const u = (import.meta.env.VITE_SNAP_SHARE_URL || '').replace(/\/snap$/, '/snaps');
    if (u) fetch(u).then((r) => (r.ok ? r.json() : [])).then((list) => { setSharedSnaps(list.filter((x) => Array.isArray(x.at) && inBox(x.at, CITY.box))); applySnaps(); }).catch(() => {}); }
  applyBoards();
  setSessionMarker();
  if (LINK && KERBS) {
    let best = null, bd = 30;
    for (const f of KERBS.features) { const d = distM(mids.get(f.properties.id), LINK); if (d < bd) { bd = d; best = f.properties.id; } }
    for (const cp of CARPARKS) { const d = distM(cp.at, LINK); if (d < bd) { bd = d; best = cp.id; } }
    if (best != null) { S.sel = best; setSheet('peek'); pendingFit = { force: false }; }
  }
  update();
  requestAnimationFrame(() => requestAnimationFrame(() => { setPeek(); root.dataset.ready = '1'; }));
  document.fonts?.ready.then(() => setPeek());
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
